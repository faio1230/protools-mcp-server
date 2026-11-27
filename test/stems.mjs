import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CommandId } from '../dist/grpc/commands.js';
import { allTools, handleToolCall } from '../dist/tools/index.js';

function wav(frames) {
  const b = Buffer.alloc(44 + frames * 6);
  b.write('RIFF');
  b.writeUInt32LE(b.length - 8, 4);
  b.write('WAVEfmt ', 8);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(2, 22);
  b.writeUInt32LE(48000, 24);
  b.writeUInt32LE(288000, 28);
  b.writeUInt16LE(6, 32);
  b.writeUInt16LE(24, 34);
  b.write('data', 36);
  b.writeUInt32LE(frames * 6, 40);
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
