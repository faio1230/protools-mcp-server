import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { CommandId } from '../dist/grpc/commands.js';
import { handleToolCall } from '../dist/tools/index.js';

function wav(frames, channels = 2) {
  const alignment = channels * 3;
  const dataLength = frames * alignment;
  const buffer = Buffer.alloc(44 + dataLength);
  buffer.write('RIFF');
  buffer.writeUInt32LE(buffer.length - 8, 4);
  buffer.write('WAVEfmt ', 8);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(48000, 24);
  buffer.writeUInt32LE(48000 * alignment, 28);
  buffer.writeUInt16LE(alignment, 32);
  buffer.writeUInt16LE(24, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataLength, 40);
  return buffer;
}

async function fixture(t, { wrongLength = false, includeDry = false, dryCurrent = false, explicitBounds = false } = {}) {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'legacy-wet-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const session = path.join(directory, 'Mix.ptx');
  await writeFile(session, 'source');
  const preset = path.join(directory, 'Dry import.ptpreset');
  if (dryCurrent) {
    await writeFile(preset, 'preset');
    const previous = process.env.PTSL_STEM_DRY_IMPORT_PRESET;
    process.env.PTSL_STEM_DRY_IMPORT_PRESET = preset;
    t.after(() => {
      if (previous === undefined) delete process.env.PTSL_STEM_DRY_IMPORT_PRESET;
      else process.env.PTSL_STEM_DRY_IMPORT_PRESET = previous;
    });
  }
  const original = {
    in_time: '32', out_time: '56', play_start_marker_time: '30',
    pre_roll_enabled: true, pre_roll_start_time: '22',
  };
  let active = session;
  let selected = [];
  let renamed;
  let inactive = false;
  let imported = false;
  let selection = { ...original };
  let counter = 'TimeCode';
  const calls = [];
  const client = {
    isPermissionGroupAllowed: group => group === 'export' || group === 'print' || includeDry && group === 'session',
    hasCommand: async () => false,
    hasMessageField: async (message, field) => explicitBounds && message === 'ExportMixRequestBody' &&
      (field === 'start_time' || field === 'end_time'),
    async sendRequest(command, body) {
      calls.push([command, body]);
      let result;
      switch (command) {
        case CommandId.GetSessionPath:
          result = active ? { session_path: { path: active } } : {};
          break;
        case CommandId.GetTrackList:
          result = { track_list: [
            { id: 'vocal-original', name: active !== session && renamed ? renamed : 'Vocal', type: 'TT_Audio', format: 'TF_Mono',
              track_attributes: {
                contains_clips: true,
                is_selected: selected.includes('Vocal') ? 'SetExplicitly' : 'None',
                is_inactive: active !== session && inactive ? 'SetExplicitly' : 'None',
              } },
            { id: 'room', name: 'Room', type: 'TT_Aux', format: 'TF_Stereo', track_attributes: { is_selected: 'None' } },
            ...(active !== session && imported ? [
              { id: 'vocal-import', name: 'Vocal', type: 'TT_Audio', format: 'TF_Mono',
                track_attributes: { contains_clips: true, is_selected: 'None', is_inactive: 'None' } },
            ] : []),
          ] };
          break;
        case CommandId.GetSessionSampleRate:
          result = { sample_rate: 'SR_48000' };
          break;
        case CommandId.GetTimelineSelection:
          assert.deepEqual(body, { time_scale: 'Samples' });
          result = { ...selection };
          break;
        case CommandId.GetMainCounterFormat:
          result = { current_setting: counter };
          break;
        case CommandId.SetMainCounterFormat:
          counter = body.time_scale;
          break;
        case CommandId.SetTimelineSelection:
          assert.equal(counter, 'Samples');
          assert.equal(body.location_type, undefined);
          selection = { ...selection, ...body };
          if (body.pre_roll_enabled !== undefined) selection.pre_roll_enabled = body.pre_roll_enabled === 'TB_True';
          break;
        case CommandId.ExportMix: {
          const [{ name: bus }] = body.mix_source_list;
          if (bus === 'Vocal Main Out') {
            assert.notEqual(active, session);
            assert.ok(inactive && imported);
          } else {
            assert.equal(active, session);
          }
          if (explicitBounds) {
            assert.deepEqual(body.start_time, { time_type: 'TLType_Samples', location: '100' });
            assert.deepEqual(body.end_time, { time_type: 'TLType_Samples', location: '148' });
          } else {
            assert.equal(body.start_time, undefined);
            assert.equal(body.end_time, undefined);
          }
          assert.equal(counter, 'TimeCode');
          assert.deepEqual([selection.in_time, selection.out_time], ['100', '148']);
          assert.equal(body.file_type, 'EM_WAV');
          assert.equal(body.audio_info.sample_rate, 'SR_48000');
          assert.equal(body.audio_info.bit_depth, 'Bit24');
          assert.equal(body.location_info.import_after_bounce, 'TB_False');
          await writeFile(path.join(body.location_info.directory, 'Stem.wav'), wav(wrongLength ? 47 : 48));
          break;
        }
        case CommandId.RenameTargetTrack:
          assert.notEqual(active, session);
          assert.equal(body.current_name, 'Vocal');
          renamed = body.new_name;
          break;
        case CommandId.SetTrackInactiveState:
          assert.notEqual(active, session);
          assert.deepEqual(body.track_names, [renamed]);
          assert.equal(body.enabled, true);
          inactive = true;
          break;
        case CommandId.Import:
          assert.notEqual(active, session);
          assert.ok(inactive);
          assert.equal(body.session_path, session);
          assert.equal(body.session_data.track_data_to_import.track_data_preset_path, preset);
          imported = true;
          break;
        case CommandId.SaveSession:
          assert.equal(active, session);
          assert.deepEqual(selection, original);
          break;
        case CommandId.SaveSessionAs:
          assert.equal(active, session);
          active = path.join(body.session_location, body.session_name + '.ptx');
          await writeFile(active, 'work copy');
          break;
        case CommandId.GetEditModeOptions:
          result = { edit_mode_options: { link_timeline_and_edit_selection: false } };
          break;
        case CommandId.SetEditModeOptions:
        case CommandId.ConsolidateClip:
          assert.notEqual(active, session);
          break;
        case CommandId.SelectTracksByName:
          assert.notEqual(active, session);
          selected = body.track_names;
          result = { track_list: selected.map(name => ({ name })) };
          break;
        case CommandId.ExportClipsAsFiles:
          assert.notEqual(active, session);
          assert.deepEqual([selection.in_time, selection.out_time], ['100', '148']);
          await writeFile(path.join(body.file_path, 'Vocal.wav'), wav(48, 1));
          break;
        case CommandId.CloseSession:
          assert.notEqual(active, session);
          assert.equal(body.save_on_close, false);
          active = undefined;
          break;
        case CommandId.OpenSession:
          assert.equal(body.session_path, session);
          active = session;
          selected = [];
          break;
        default: assert.fail('Unexpected PTSL command ' + command);
      }
      return { header: { status: 'Completed' }, response_body: result };
    },
  };
  const args = {
    mode: 'wet', fader: 'current', start_sample: 100, end_sample: 148,
    tracks: [{ name: 'Vocal', wet_bus: { unity: 'Vocal Unity', current: 'Vocal Post' } }],
    fx_returns: [{ name: 'Room', wet_bus: { unity: 'Room Unity', current: 'Room Post' } }],
  };
  return {
    directory, calls, args,
    run: () => handleToolCall('export_stems', args, client),
    assertRestored: () => {
      assert.equal(active, session);
      assert.equal(counter, 'TimeCode');
      assert.deepEqual(selection, original);
    },
  };
}

test('legacy wet exports each requested bus at the common sample bounds and restores selection', async t => {
  const f = await fixture(t);
  const result = JSON.parse((await f.run()).content[0].text);
  const exports = f.calls.filter(([command]) => command === CommandId.ExportMix);
  assert.deepEqual(exports.map(([, body]) => body.mix_source_list), [
    [{ source_type: 'Bus', name: 'Vocal Post' }],
    [{ source_type: 'Bus', name: 'Room Post' }],
  ]);
  assert.deepEqual(result.files.map(({ name, channels, frames, fxReturn }) => [name, channels, frames, fxReturn]), [
    ['Vocal', 1, 48, false], ['Room', 2, 48, true],
  ]);
  assert.equal((await readFile(result.files[0].file)).readUInt16LE(22), 1);
  f.assertRestored();
});

test('legacy wet restores selection and discards all files when WAV verification fails', async t => {
  const f = await fixture(t, { wrongLength: true });
  f.args.fader = 'unity';
  await assert.rejects(f.run, /Unexpected WAV length/);
  const bounced = f.calls.find(([command]) => command === CommandId.ExportMix);
  assert.deepEqual(bounced[1].mix_source_list, [{ source_type: 'Bus', name: 'Vocal Unity' }]);
  assert.deepEqual(await readdir(path.join(f.directory, 'Bounced Files')), []);
  f.assertRestored();
});

test('legacy wet rejects two tracks assigned to the same bus before contacting the host', async t => {
  const f = await fixture(t);
  f.args.fx_returns[0].wet_bus.current = 'Vocal Post';
  await assert.rejects(f.run, /distinct current wet_bus/);
  assert.deepEqual(f.calls, []);
});


test('legacy both/unity renders wet on the original and aligned dry in the copy', async t => {
  const f = await fixture(t, { includeDry: true });
  f.args.fader = 'unity';
  f.args.mode = 'both';
  const result = JSON.parse((await f.run()).content[0].text);
  assert.deepEqual(result.files.map(({ mode, name, frames }) => [mode, name, frames]), [
    ['Wet', 'Vocal', 48], ['Wet', 'Room', 48], ['Dry', 'Vocal', 48],
  ]);
  f.assertRestored();
});


test('legacy both/current uses the post-fader bus on the original and the dry main output on the copy', async t => {
  const f = await fixture(t, { includeDry: true, dryCurrent: true });
  f.args.mode = 'both';
  f.args.tracks[0].dry_current_bus = 'Vocal Main Out';
  const result = JSON.parse((await f.run()).content[0].text);
  const exports = f.calls.filter(([command]) => command === CommandId.ExportMix);
  assert.deepEqual(exports.map(([, body]) => body.mix_source_list), [
    [{ source_type: 'Bus', name: 'Vocal Post' }],
    [{ source_type: 'Bus', name: 'Room Post' }],
    [{ source_type: 'Bus', name: 'Vocal Main Out' }],
  ]);
  assert.deepEqual(result.files.map(({ mode, name, frames }) => [mode, name, frames]), [
    ['Wet', 'Vocal', 48], ['Wet', 'Room', 48], ['Dry', 'Vocal', 48],
  ]);
  f.assertRestored();
});

test('legacy both/current requires an explicit dry main output route before calling Pro Tools', async t => {
  const f = await fixture(t, { includeDry: true, dryCurrent: true });
  f.args.mode = 'both';
  await assert.rejects(f.run, /Supply dry_current_bus for every dry\/current track/);
  assert.deepEqual(f.calls, []);
  f.assertRestored();
});

test('bus exports send explicit sample locations when ExportMix declares them', async t => {
  const f = await fixture(t, { explicitBounds: true });
  await f.run();
  f.assertRestored();
});
