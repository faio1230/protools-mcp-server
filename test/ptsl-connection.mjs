import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { PTSLClient } from '../dist/grpc/client.js';
import { CommandId } from '../dist/grpc/commands.js';
import { handleDiagnosticTool } from '../dist/tools/diagnostic.js';

const schema = `
syntax = "proto3";
package ptsl;
enum CommandId {
  CId_CreateSession = 0;
  CId_GetTrackList = 3;
  CId_ExportClipsAsFiles = 10;
  CId_ExportMix = 28;
  CId_GetSessionName = 42;
  CId_GetPTSLVersion = 55;
  CId_RegisterConnection = 70;
  CId_SetTrackMuteState = 85;
  CId_BounceTrack = 134;
}
enum TaskStatus { Queued = 0; TStatus_Completed = 3; TStatus_Failed = 4; }
message RequestHeader {
  CommandId command = 2;
  int32 version = 3;
  string session_id = 4;
  int32 version_minor = 5;
  int32 version_revision = 6;
}
message ResponseHeader { TaskStatus status = 3; }
message Request { RequestHeader header = 1; string request_body_json = 2; }
message Response {
  ResponseHeader header = 1;
  string response_body_json = 2;
  string response_error_json = 3;
}
service PTSL {
  rpc SendGrpcRequest(Request) returns (Response);
  rpc SendGrpcStreamingRequest(Request) returns (stream Response);
}
`;

function complete(body) {
  return { header: { status: 'TStatus_Completed' }, response_body_json: JSON.stringify(body) };
}

test('diagnostics recover after startup offline and writes are never replayed after host restart', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'ptsl-connection-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const protoPath = join(directory, 'PTSL.proto');
  await writeFile(protoPath, schema);
  await writeFile(join(directory, 'PTSL_Versions.h'), [
    'static const int32_t PTSL_VERSION = 2026;',
    'static const int32_t PTSL_VERSION_MINOR = 4;',
    'static const int32_t PTSL_VERSION_REVISION = 1;',
  ].join('\n'));

  const listener = createServer();
  await new Promise((resolve, reject) => listener.on('error', reject).listen(0, '127.0.0.1', resolve));
  const endpoint = `127.0.0.1:${listener.address().port}`;
  await new Promise(resolve => listener.close(resolve));

  const oldPermissions = process.env.ALLOW_WRITES;
  process.env.ALLOW_WRITES = 'track_state,export';
  const oldPreset = process.env.PTSL_STEM_WET_UNITY_PRESET;
  const preset = join(directory, 'test.preset');
  await writeFile(preset, 'fake preset');
  process.env.PTSL_STEM_WET_UNITY_PRESET = preset;
  t.after(() => {
    if (oldPermissions === undefined) delete process.env.ALLOW_WRITES;
    else process.env.ALLOW_WRITES = oldPermissions;
    if (oldPreset === undefined) delete process.env.PTSL_STEM_WET_UNITY_PRESET;
    else process.env.PTSL_STEM_WET_UNITY_PRESET = oldPreset;
  });
  const client = new PTSLClient(protoPath, endpoint);
  await client.connect();
  t.after(() => client.client.close());
  assert.equal(await client.getCommandId('GetTrackList'), CommandId.GetTrackList);
  assert.equal(await client.hasCommand('BounceTrack'), true);
  assert.equal(await client.hasMessageField('RequestHeader', 'version_minor'), true);
  assert.equal(client.isConnected(), false);

  async function diagnose() {
    const result = await handleDiagnosticTool('diagnose_ptsl_connection', {}, client);
    return JSON.parse(result.content[0].text);
  }
  const offline = await diagnose();
  assert.equal(offline.schema.status, 'ok');
  assert.equal(offline.registration.status, 'failed');
  assert.match(offline.registration.error, /DEADLINE_EXCEEDED|UNAVAILABLE/);
  assert.equal(offline.request_version, '2026.4.1');
  assert.equal(offline.legacy_2024_10, false);
  assert.equal(offline.export_presets.unity.result.readable, true);
  assert.equal(offline.export_presets.unity.host_content, 'unverified');
  assert.equal(offline.host_version.status, 'skipped');
  assert.equal(offline.export_commands[0].host_execution, 'unverified');

  let hostGeneration = 1;
  let registrations = 0;
  let writes = 0;
  const service = (await protoLoader.load(protoPath, {
    keepCase: true, longs: String, enums: String, defaults: true,
  }))['ptsl.PTSL'];
  const host = new grpc.Server();
  t.after(() => host.forceShutdown());
  host.addService(service, {
    SendGrpcStreamingRequest(call) {
      assert.equal(call.request.header.command, 'CId_BounceTrack');
      assert.equal(call.request.header.session_id, `generation-${hostGeneration}`);
      call.write({ header: { status: 'Queued' } });
      call.write(complete({ file_paths: ['/example.wav'] }));
      call.end();
    },
    SendGrpcRequest(call, cb) {
      const header = call.request.header;
      assert.deepEqual([header.version, header.version_minor, header.version_revision], [2026, 4, 1]);
      if (header.command === 'CId_RegisterConnection') {
        assert.equal(header.session_id, '');
        registrations++;
        return cb(null, complete({ session_id: `generation-${hostGeneration}` }));
      }
      if (header.command === 'CId_SetTrackMuteState') writes++;
      if (header.session_id !== `generation-${hostGeneration}`) {
        return cb(null, {
          header: { status: 'TStatus_Failed' },
          response_error_json: '{"errors":[{"command_error_message":"Request refused. Use the RegisterConnection command first"}]}',
        });
      }
      if (header.command === 'CId_GetPTSLVersion') return cb(null, complete({ version: 2026, version_minor: 4, version_revision: 1 }));
      if (header.command === 'CId_GetSessionName') return cb(null, complete({ session_name: 'Tracking' }));
      if (header.command === 'CId_GetTrackList') return cb(null, complete({ track_list: [{ name: 'Vocal' }] }));
      return cb(null, complete({}));
    },
  });
  await new Promise((resolve, reject) => {
    host.bindAsync(endpoint, grpc.ServerCredentials.createInsecure(), error => error ? reject(error) : resolve());
  });


  const [online] = await Promise.all([diagnose(), client.sendRequest(CommandId.GetSessionName)]);
  assert.equal(registrations, 1);
  assert.equal(client.isConnected(), true);
  assert.equal(online.host_version.result.version, '2026.4.1');
  assert.equal(online.session.result.name, 'Tracking');
  assert.equal(online.tracks.result.count, 1);
  assert.equal(online.export_commands[2].declared_in_local_schema, true);
  const bounce = await client.sendRequest(CommandId.BounceTrack);
  assert.deepEqual(bounce.response_body.file_paths, ['/example.wav']);

  hostGeneration++;
  await assert.rejects(client.sendRequest(CommandId.SetTrackMuteState), /RegisterConnection command first.*next request/);
  assert.equal(writes, 1);
  assert.equal(client.isConnected(), false);
  await client.sendRequest(CommandId.GetSessionName);
  assert.equal(registrations, 2);
  assert.equal(writes, 1);
});

test('temporary export permission uses the actual destination and rejects escapes', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'ptsl-export-permission-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const oldPermissions = process.env.ALLOW_WRITES;
  delete process.env.ALLOW_WRITES;
  t.after(() => {
    if (oldPermissions !== undefined) process.env.ALLOW_WRITES = oldPermissions;
  });
  const client = new PTSLClient('/unused/PTSL.proto');
  const check = body => client.checkCommandPermission(CommandId.ExportClipsAsFiles, body);
  check({ file_path: join(directory, 'clip.wav') });
  const outside = tmpdir() + '-sibling';
  assert.throws(() => check({ file_path: outside, output_path: directory }), /blocked/);
  assert.throws(() => check({ file_path: 'relative' }), /blocked/);
  assert.throws(() => check({ file_path: directory + '/../escape' }), /blocked/);
  const link = join(directory, 'link');
  await symlink(join(directory, 'missing-target'), link);
  assert.throws(() => check({ file_path: join(link, 'clip.wav') }), /blocked/);
  assert.throws(() => client.checkCommandPermission(CommandId.ExportMix, {
    file_name: '../escape',
    location_info: { file_destination: 'EM_FD_Directory', directory },
  }), /blocked/);
});
