import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PTSLClient } from '../dist/grpc/client.js';
import { CommandId } from '../dist/grpc/commands.js';

// The versioned SDK definition is supplied by the developer.
test('2024.10 archived definition encodes a registered command for the live service', {
  skip: !process.env.PTSL_2024_TEST_PROTO,
}, async () => {
  const client = new PTSLClient(process.env.PTSL_2024_TEST_PROTO);
  await client.connect();
  const stub = client.client;
  try {
    const method = stub.constructor.service.SendGrpcRequest;
    assert.equal(method.path, '/ptsl.PTSL/SendGrpcRequest');
    assert.equal(stub.constructor.service.SendGrpcStreamingRequest.path, '/ptsl.PTSL/SendGrpcStreamingRequest');
    stub.SendGrpcStreamingRequest = async function* (request) {
      yield { header: { status: 'InProgress' } };
      const message = method.requestDeserialize(method.requestSerialize(request));
      assert.equal(message.header.version, 5);
      if (message.header.command === 'RegisterConnection') {
        assert.equal(message.header.session_id, '');
        yield { header: { status: 'Completed' }, response_body_json: '{"session_id":"test-session"}' };
      } else {
        assert.equal(message.header.command, 'GetTimelineSelection');
        assert.equal(message.header.session_id, 'test-session');
        yield { header: { status: 'Completed' }, response_body_json: '{"in_time":"1","out_time":"2"}' };
      }
    };
    await client.registerConnection('host-check');
    const result = await client.sendRequest(CommandId.GetTimelineSelection, { time_scale: 'Samples' });
    assert.equal(result.response_body.out_time, '2');
    stub.SendGrpcStreamingRequest = async function* () { yield { header: { status: 'Pending' } }; };
    await assert.rejects(client.sendRequest(CommandId.GetTimelineSelection), /without a completion response/);
  } finally {
    stub.close();
  }
});
