import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
const tracks = process.argv.slice(2);
if (!tracks.length) throw new Error('Provide one or more audio track names.');
const client = new Client({ name: 'print-tracks', version: '1.0' });
try {
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL('../dist/index.js', import.meta.url))],
    env: { PATH: process.env.PATH, HOME: process.env.HOME,
      PTSL_PROTO_PATH: process.env.PTSL_PROTO_PATH || fileURLToPath(new URL('../ptsl_sdk/PTSL.2024.10.0.proto', import.meta.url)),
      PTSL_EXPORT_ONLY: '1', ALLOW_WRITES: 'export,session,print' },
  }));
  const result = await client.callTool({ name: 'export_dry_tracks', arguments: { tracks } }, undefined, { timeout: 30 * 60_000 });
  for (const item of result.content ?? []) if (item.type === 'text') console.log(item.text);
  if (result.isError) process.exitCode = 1;
} catch (error) {
  console.error(error.message); process.exitCode = 1;
} finally {
  await client.close();
}
