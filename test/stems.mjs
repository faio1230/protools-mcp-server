import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CommandId } from '../dist/grpc/commands.js';
import { allTools, handleToolCall } from '../dist/tools/index.js';

function wav(frames, channels = 2) {
  const align = channels * 3;
  const b = Buffer.alloc(44 + frames * align);
  b.write('RIFF');
  b.writeUInt32LE(b.length - 8, 4);
  b.write('WAVEfmt ', 8);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(channels, 22);
  b.writeUInt32LE(48000, 24);
  b.writeUInt32LE(48000 * align, 28);
  b.writeUInt16LE(align, 32);
  b.writeUInt16LE(24, 34);
  b.write('data', 36);
  b.writeUInt32LE(frames * align, 40);
  return b;
}

async function setup(t, options = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'test-stems-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const calls = [];
  const client = {
    isPermissionGroupAllowed: group => group === 'export' && options.allowed !== false,
    async sendRequest(id, body) {
      calls.push(id);
      let result;
      if (id === CommandId.GetSessionSampleRate) result = { sample_rate: 'SR_48000' };
      else if (id === CommandId.GetTimelineSelection) {
        assert.equal(body.time_scale, 'Samples');
        result = { in_time: '1000', out_time: options.end || '1032' };
      } else if (id === CommandId.ExportMix) {
        assert.deepEqual(body.mix_source_list, [{ source_type: 'Bus', name: 'Band' }, { source_type: 'Bus', name: 'Click' }]);
        assert.ok(body.location_info.directory.endsWith(path.sep));
        assert.equal(body.audio_info.delivery_format, 'EM_DF_FilePerMixSource');
        if (options.failed) {
          return { header: { status: 'Failed' }, response_error_json: 'Unknown bus' };
        }
        for (const name of ['Band', 'Click']) {
          await writeFile(path.join(body.location_info.directory, name + '.wav'), wav(name === 'Band' ? 32 : options.frames || 32));
        }
      } else assert.fail('Unexpected request ' + id);
      return { header: { status: 'Completed' }, response_body: result };
    },
  };
  return { directory, calls, run: () => handleToolCall('export_stems', { directory, buses: ['Band', 'Click'] }, client) };
}

test('MCP entry point exports the selected interval and reports verified files', async t => {
  assert.ok(allTools.some(tool => tool.name === 'export_stems'));
  const fixture = await setup(t);
  const run = async () => JSON.parse((await fixture.run()).content[0].text);
  const first = await run();
  assert.deepEqual(first.files.map(f => [f.frames, f.channels]), [[32, 2], [32, 2]]);
  assert.notEqual((await run()).folder, first.folder);
});
test('rejects a cursor-only selection before creating output', async t => {
  const fixture = await setup(t, { end: '1000' });
  await assert.rejects(fixture.run, /nonempty timeline/);
  assert.deepEqual(await readdir(fixture.directory), []);
});
test('rejects unexpected stem duration', async t => {
  const fixture = await setup(t, { frames: 31 });
  await assert.rejects(fixture.run, /lengths do not match/);
});
test('returns the incomplete folder and host error on a failed bounce', async t => {
  const fixture = await setup(t, { failed: true });
  await assert.rejects(fixture.run, /incomplete in .*stems-.*Unknown bus/);
});
test('requires export permission before any host call', async t => {
  const fixture = await setup(t, { allowed: false });
  await assert.rejects(fixture.run, /ALLOW_WRITES=export/);
  assert.equal(fixture.calls.length, 0);
});

test('track export shares exact sample bounds across dry and wet files, then reopens the source', async t => {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'track-stems-')));
  const source = path.join(directory, 'Source.ptx');
  const preset = path.join(directory, 'Track Bounce.ptpreset');
  const previous = process.env.PTSL_STEM_WET_UNITY_PRESET;
  process.env.PTSL_STEM_WET_UNITY_PRESET = preset;
  t.after(async () => {
    if (previous === undefined) delete process.env.PTSL_STEM_WET_UNITY_PRESET;
    else process.env.PTSL_STEM_WET_UNITY_PRESET = previous;
    await rm(directory, { recursive: true, force: true });
  });
  await writeFile(source, 'original');
  await writeFile(preset, 'preset');
  let active = source;
  let selected;
  let failDry = false;
  let selection = ['11', '11'];
  const bounces = [];
  const original = [
    { id: 'voice', name: 'Voice', type: 'TType_Audio', format: 'TFormat_Mono', track_attributes: { contains_clips: true, is_selected: 'TAState_None' } },
    { id: 'band', name: 'Band', type: 'TType_Audio', format: 'TFormat_Stereo', track_attributes: { contains_clips: true, is_selected: 'TAState_None' } },
    { id: 'room', name: 'Room', type: 'TType_Aux', format: 'TFormat_Stereo', track_attributes: { is_selected: 'TAState_None' } },
  ];
  const client = {
    isPermissionGroupAllowed: () => true,
    hasCommand: async name => name === 'BounceTrack',
    hasMessageField: async () => true,
    async sendRequest(id, body) {
      let response_body = {};
      switch (id) {
        case CommandId.GetSessionPath:
          response_body = { session_path: { path: active } };
          break;
        case CommandId.GetTrackList:
          response_body = { track_list: original };
          break;
        case CommandId.GetSessionSampleRate:
          response_body = { sample_rate: 'SRate_48000' };
          break;
        case CommandId.GetTimelineSelection:
          response_body = { in_time: selection[0], out_time: selection[1] };
          break;
        case CommandId.ExportSessionInfoAsText:
          assert.equal(body.location_type, 'TLType_Samples');
          assert.equal(body.output_type, 'ESIOType_String');
          response_body = { session_info: [
            'TRACK NAME:\tVoice', 'CHANNEL\tEVENT #\tCLIP NAME\tSTART TIME\tEND TIME\tDURATION',
            'L\t1\tvoice clip.wav\t14\t51\t37',
            'TRACK NAME:\tBand', 'EVENT #\tCLIP NAME\tSTART TIME\tEND TIME\tDURATION',
            '1\tband clip.wav\t11\t37\t26'
          ].join('\r\n') };
          break;
        case CommandId.BounceTrack: {
          assert.equal(active, source);
          assert.equal(body.preset_path, preset);
          assert.deepEqual(body.in_location, { location: '11', time_type: 'TLType_Samples' });
          assert.deepEqual(body.out_location, { location: '51', time_type: 'TLType_Samples' });
          bounces.push(body.src_track_id);
          const output = path.join(body.location_info.directory, 'render.wav');
          await writeFile(output, wav(40, 2));
          response_body = { file_paths: [output] };
          break;
        }
        case CommandId.SaveSession:
          assert.equal(active, source);
          break;
        case CommandId.SaveSessionAs:
          active = path.join(body.session_location, body.session_name + '.ptx');
          await writeFile(active, 'working copy');
          break;
        case CommandId.GetEditModeOptions:
          response_body = { edit_mode_options: { link_track_and_edit_selection: false } };
          break;
        case CommandId.GetMainCounterFormat:
          response_body = { current_setting: 'TimeCode' };
          break;
        case CommandId.SetEditModeOptions:
        case CommandId.SetMainCounterFormat:
        case CommandId.ConsolidateClip:
          assert.notEqual(active, source);
          break;
        case CommandId.SelectTracksByName:
          selected = body.track_names[0];
          response_body = { track_list: [{ name: selected }] };
          break;
        case CommandId.SetTimelineSelection:
          selection = [body.in_time, body.out_time];
          break;
        case CommandId.ExportClipsAsFiles:
          assert.deepEqual(selection, ['11', '51']);
          if (failDry) return { header: { status: 'Failed' }, response_error_json: 'Export failed' };
          await writeFile(path.join(body.file_path, 'render.wav'), wav(40, selected === 'Voice' ? 1 : 2));
          break;
        case CommandId.CloseSession:
          assert.notEqual(active, source);
          assert.equal(body.save_on_close, false);
          active = undefined;
          break;
        case CommandId.OpenSession:
          assert.equal(body.session_path, source);
          active = source;
          selection = ['11', '11'];
          break;
        default:
          assert.fail('Unexpected command: ' + id);
      }
      return { header: { status: 'Completed' }, response_body };
    },
  };
  const args = {
    tracks: [{ name: 'Voice', dry_channels: 2, wet_channels: 2 }, 'Band'],
    fx_returns: ['Room'],
  };
  const result = JSON.parse((await handleToolCall('export_stems', args, client)).content[0].text);
  assert.equal(active, source);
  assert.equal(await readFile(source, 'utf8'), 'original');
  assert.deepEqual(bounces, ['voice', 'band', 'room']);
  assert.deepEqual(result.files.map(({ mode, name, channels, frames, fxReturn }) => [mode, name, channels, frames, fxReturn]), [
    ['Wet', 'Voice', 2, 40, false], ['Wet', 'Band', 2, 40, false], ['Wet', 'Room', 2, 40, true],
    ['Dry', 'Voice', 2, 40, false], ['Dry', 'Band', 2, 40, false],
  ]);
  for (const file of result.files) {
    assert.equal((await readFile(file.file)).readUInt16LE(22), file.channels);
  }
  assert.deepEqual(await readdir(path.join(directory, 'Bounced Files')), [path.basename(result.folder)]);

  failDry = true;
  await assert.rejects(handleToolCall('export_stems', args, client), /Export failed/);
  assert.equal(active, source);
  assert.deepEqual(await readdir(path.join(directory, 'Bounced Files')), [path.basename(result.folder)]);
});
