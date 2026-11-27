import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const [, , bus, directory = tmpdir()] = process.argv;
const childEnv = {
  ...process.env,
  PTSL_PROTO_PATH: process.env.PTSL_PROTO_PATH || fileURLToPath(new URL('../ptsl_sdk/PTSL.2024.10.0.proto', import.meta.url)),
  ALLOW_WRITES: bus ? 'export' : '',
};
const client = new Client({ name: 'protools-host-check', version: '1.0' });
const server = fileURLToPath(new URL('../dist/index.js', import.meta.url));
try {
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [server], env: childEnv }));
  const { tools } = await client.listTools();
  if (!tools.some(tool => tool.name === 'export_stems')) throw new Error('export_stems is missing.');
  console.log('Connected to Pro Tools through MCP. export_stems is available.');
  if (bus) {
    const result = await client.callTool({
      name: 'export_stems', arguments: { buses: [bus], directory: resolve(directory), offline: false },
    });
    for (const item of result.content ?? []) if (item.type === 'text') console.log(item.text);
    if (result.isError) process.exitCode = 1;
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  await client.close();
}
