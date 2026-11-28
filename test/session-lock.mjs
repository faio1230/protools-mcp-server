import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout } from 'node:timers/promises';
import { test } from 'node:test';
import { getExposedTools, handleToolCall } from '../dist/tools/index.js';
import { withSessionLock } from '../dist/tools/session-lock.js';

test('every tool dispatch waits for the session lock and aliases use the same lock', async () => {
  const client = {
    getConnectionInfo: () => ({ endpoint: 'localhost:28451' }),
    sendRequest() {
      reads++;
      return { header: { status: 'Completed' }, response_body: { track_list: [] } };
    },
  };
  let reads = 0;
  let unblock;
  let acquired;
  const acquiredLock = new Promise(resolve => { acquired = resolve; });
  const releaseLock = new Promise(resolve => { unblock = resolve; });
  const holder = withSessionLock('[::1]:28451', async () => {
    acquired();
    await releaseLock;
  });

  await acquiredLock;
  const lookup = handleToolCall('get_track_list', {}, client);
  try {
    await setTimeout(25);
    assert.equal(reads, 0);
  } finally {
    unblock();
    await holder;
    await lookup;
  }
  assert.equal(reads, 1);
});

test('a separate MCP process holds the lock until its process exits', { timeout: 5_000 }, async () => {
  const script = `
    import { withSessionLock } from ${JSON.stringify(new URL('../dist/tools/session-lock.js', import.meta.url).href)};
    await withSessionLock('127.0.0.1:28452', async () => {
      process.send('acquired');
      await new Promise(() => {});
    });
  `;
  const owner = spawn(process.execPath, ['--input-type=module', '--eval', script], {
    stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
  });
  const exited = once(owner, 'exit');
  const acquired = once(owner, 'message');
  let entered = false;
  let follower;
  try {
    assert.equal(await Promise.race([acquired.then(([message]) => message), exited]), 'acquired');
    follower = withSessionLock('localhost:28452', async () => { entered = true; });
    await setTimeout(150);
    assert.equal(entered, false);
  } finally {
    owner.kill('SIGKILL');
    await exited;
  }
  await follower;
  assert.equal(entered, true);
});

test('export profile lists its allowlist and rejects unadvertised tools', async () => {
  const saved = process.env.PTSL_EXPORT_ONLY;
  process.env.PTSL_EXPORT_ONLY = '1';
  try {
    assert.deepEqual(getExposedTools().map(tool => tool.name).sort(), [
      'diagnose_ptsl_connection', 'export_dry_tracks', 'export_stems', 'get_track_list',
    ]);
    await assert.rejects(handleToolCall('ptsl_command', {}, {}), /not enabled/);
  } finally {
    if (saved === undefined) delete process.env.PTSL_EXPORT_ONLY;
    else process.env.PTSL_EXPORT_ONLY = saved;
  }
});
