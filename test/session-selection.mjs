import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { restorePrintSource } from '../dist/tools/print-session.js';
import { CommandId as C } from '../dist/grpc/commands.js';
import {
  captureSessionSelection, restoreSessionSelection, withSessionState, withTimelineRange,
} from '../dist/tools/mixer-state.js';

async function fixture(t, modern, selection = ['Vocals']) {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'pt-selection-test-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const source = path.join(directory, 'Source.ptx');
  const copy = path.join(directory, 'Copy.ptx');
  await Promise.all([writeFile(source, ''), writeFile(copy, '')]);

  const originalTimeline = {
    in_time: '150', out_time: '450', play_start_marker_time: '90',
    pre_roll_start_time: '60', post_roll_stop_time: '600',
    pre_roll_enabled: true, post_roll_enabled: false,
  };
  let timeline = { ...originalTimeline };
  let selected = [...selection];
  let session = source;
  let counter = 'TimeCode';
  const writes = [];
  const completed = (response_body) => ({ header: { status: 'Completed' }, response_body });
  const client = {
    async hasMessageField(message, field) {
      assert.match(message, /^(Get|Set)TimelineSelectionRequestBody$/);
      assert.equal(field, 'location_type');
      return modern;
    },
    isPermissionGroupAllowed() { return true; },
    async sendRequest(command, body) {
      switch (command) {
        case C.GetSessionPath: return completed({ session_path: { path: session } });
        case C.GetTrackList:
          return completed({
            track_list: ['Vocals', 'Piano', 'Implicit'].map(name => ({
              name,
              track_attributes: {
                is_selected: name === 'Implicit' ? (modern ? 'TAState_SetImplicitly' : 'SetImplicitly') :
                  selected.includes(name) ? (modern ? 'TAState_SetExplicitly' : 'SetExplicitly') :
                    (modern ? 'TAState_None' : 'None'),
              },
            })),
          });
        case C.GetTimelineSelection:
          assert.deepEqual(body, modern ? { location_type: 'TLType_Samples' } : { time_scale: 'Samples' });
          return completed({ ...timeline });
        case C.GetMainCounterFormat:
          return completed({ current_setting: counter });
        case C.SetMainCounterFormat:
          assert.equal(modern, false);
          assert.ok(['Samples', 'TimeCode'].includes(body.time_scale));
          counter = body.time_scale;
          break;
        case C.SetTimelineSelection: {
          const { location_type, pre_roll_enabled, post_roll_enabled, ...values } = body;
          if (modern) assert.equal(location_type, 'TLType_Samples');
          else {
            assert.equal(location_type, undefined);
            assert.equal(counter, 'Samples');
          }
          timeline = { ...timeline, ...values };
          if (pre_roll_enabled) timeline.pre_roll_enabled = pre_roll_enabled === 'TB_True';
          if (post_roll_enabled) timeline.post_roll_enabled = post_roll_enabled === 'TB_True';
          break;
        }
        case C.SelectTracksByName:
          if (body.selection_mode === (modern ? 'SMode_Replace' : 'SM_Replace')) {
            selected = [...body.track_names];
          } else {
            assert.equal(body.selection_mode, modern ? 'SMode_Subtract' : 'SM_Subtract');
            selected = selected.filter(name => !body.track_names.includes(name));
          }
          break;
        default: throw new Error('Unexpected command ' + command);
      }
      writes.push(command);
      return completed();
    },
  };
  return {
    client, source, originalTimeline, writes,
    openCopy() { session = copy; },
    reopenSource() {
      session = source;
      selected = ['Piano'];
      timeline = { in_time: '0', out_time: '10' };
    },
    state() { return { timeline, selected, counter }; },
  };
}

for (const modern of [false, true]) {
  test(`restores and verifies source selections using the ${modern ? 'location_type' : 'time_scale'} ABI`, async (t) => {
    const f = await fixture(t, modern, modern ? ['Vocals'] : []);
    const before = f.state();
    const snapshot = await captureSessionSelection(f.client);
    assert.equal(snapshot.sessionPath, f.source);
    assert.deepEqual(snapshot.selectedTracks, before.selected);
    f.openCopy();
    await assert.rejects(restoreSessionSelection(f.client, snapshot), /Active Pro Tools session differs/);
    assert.deepEqual(f.writes, []);
    f.reopenSource();
    await restoreSessionSelection(f.client, snapshot);
    assert.deepEqual(f.state(), before);
    if (modern) assert.ok(!f.writes.includes(C.SetMainCounterFormat));
    else assert.equal(f.writes.filter(command => command === C.SetMainCounterFormat).length, 2);
  });

  test(`restores a temporary range after a failed bounce using the ${modern ? 'modern' : 'legacy'} ABI`, async (t) => {
    const f = await fixture(t, modern);
    const before = f.state();
    await assert.rejects(withSessionState(f.client, () =>
      withTimelineRange(f.client, '800', '1200', async () => {
        assert.equal(f.state().timeline.in_time, '800');
        assert.equal(f.state().timeline.out_time, '1200');
        throw new Error('Injected bounce failure');
      })
    ), /Injected bounce failure/);
    assert.deepEqual(f.state(), before);
  });
}

test('recovery accepts a nested print copy and reopens the source after a lost close reply', async t => {
  const fx = await fixture(t, true);
  const capture = await captureSessionSelection(fx.client);
  const directory = path.dirname(fx.source);
  const nested = await mkdtemp(path.join(directory, 'work-'));
  const copy = path.join(nested, 'Print.ptx');
  await writeFile(copy, '');
  let active = copy;
  const client = {
    ...fx.client,
    async sendRequest(command, body) {
      if (command === C.GetSessionPath) return { header: { status: 'Completed' }, response_body: { session_path: { path: active } } };
      if (command === C.CloseSession) {
        assert.equal(active, copy);
        active = '';
        throw new Error('lost reply');
      }
      if (command === C.OpenSession) {
        assert.equal(body.session_path, fx.source);
        active = fx.source;
        fx.reopenSource();
        return { header: { status: 'Completed' } };
      }
      return fx.client.sendRequest(command, body);
    },
  };
  await restorePrintSource(client, capture, directory, 'Print');
  assert.equal(active, fx.source);
  assert.deepEqual(fx.state().selected, ['Vocals']);
  active = path.join(directory, 'Copy.ptx');
  await assert.rejects(restorePrintSource(client, capture, directory, 'Print'), /unrelated session/);
  assert.equal(active, path.join(directory, 'Copy.ptx'));
});
