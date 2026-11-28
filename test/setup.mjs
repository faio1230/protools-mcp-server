import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { getStaticTOMLValue, parseTOML } from 'toml-eslint-parser';

const setup = fileURLToPath(new URL('../dist/setup.js', import.meta.url));
const server = realpathSync(fileURLToPath(new URL('../dist/index.js', import.meta.url)));
const fixture = 'syntax = "proto3"; package ptsl_2024_10_0; service PTSL { rpc SendGrpcRequest (Noop) returns (Noop); rpc SendGrpcStreamingRequest (Noop) returns (stream Noop); } message Noop {}';
const mockCodex = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const { getStaticTOMLValue, parseTOML } = require(process.env.SETUP_TOML_MODULE);
const file = path.join(process.env.CODEX_HOME, 'config.toml');
const args = process.argv.slice(2);
const source = fs.readFileSync(file, 'utf8');
if (args.join(' ') === 'mcp list --json') {
  const entries = Object.entries(getStaticTOMLValue(parseTOML(source)).mcp_servers || {});
  console.log(JSON.stringify(entries.map(([name, transport]) => ({ name, transport, enabled: true }))));
} else if (args.slice(0, 4).join(' ') === 'mcp add protools --') {
  fs.appendFileSync(file, '\\n[mcp_servers.protools]\\ncommand = ' + JSON.stringify(args[4]) +
    '\\nargs = ' + JSON.stringify(args.slice(5)) + '\\n');
} else {
  console.error('Unexpected Codex CLI call', args);
  process.exit(1);
}
`;

function sandbox(t) {
  const home = mkdtempSync(join(tmpdir(), 'protools setup '));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('PTSL_')));
  // Override both POSIX and Windows home variables for the fresh process.
  env.HOME = home;
  env.USERPROFILE = home;
  env.APPDATA = join(home, 'AppData', 'Roaming');
  env.CODEX_HOME = join(home, 'codex');
  env.SETUP_TOML_MODULE = createRequire(import.meta.url).resolve('toml-eslint-parser');
  for (const key of Object.keys(env)) {
    if (key.toUpperCase() === 'PATH') delete env[key];
  }
  const bin = join(home, 'bin');
  env.PATH = [bin, dirname(process.execPath)].join(delimiter);
  const command = process.platform === 'win32'
    ? join(bin, 'node_modules', '@openai', 'codex', 'bin', 'codex.js')
    : join(bin, 'codex');
  mkdirSync(dirname(command), { recursive: true });
  writeFileSync(command, mockCodex, { mode: 0o700 });
  const config = join(env.CODEX_HOME, 'config.toml');
  mkdirSync(env.CODEX_HOME);
  writeFileSync(config, '[mcp_servers.other]\ncommand = "custom"\n');
  const proto = join(home, 'Downloads', 'Avid PTSL SDK', 'Source', 'PTSL.2024.10.0.proto');
  mkdirSync(dirname(proto), { recursive: true });
  writeFileSync(proto, fixture);
  return { home, env, config, proto };
}

function runSetup(env, args, platform) {
  const script = `
    ${platform ? `Object.defineProperty(process, 'platform', { value: ${JSON.stringify(platform)} });` : ''}
    process.argv.splice(1, 0, ${JSON.stringify(setup)});
    await import(${JSON.stringify(pathToFileURL(setup).href)});
  `;
  return spawnSync(process.execPath, ['--input-type=module', '-e', script, '--', ...args], { env, encoding: 'utf8' });
}

function configContents(file) {
  return getStaticTOMLValue(parseTOML(readFileSync(file, 'utf8')));
}

test('setup locates a versioned SDK, saves presets, and adds export settings to an existing Codex server', t => {
  const { home, env, config, proto } = sandbox(t);
  const unity = join(home, 'unity preset');
  const current = join(home, 'current-level preset');
  const dryImport = join(home, 'dry import preset');
  for (const file of [unity, current, dryImport]) writeFileSync(file, '');
  const initial = runSetup(env, [
    '--client', 'codex', '--unity-preset', unity, '--current-preset', current,
    '--dry-import-preset', dryImport,
  ]);
  assert.equal(initial.status, 0, initial.stderr);
  assert.deepEqual(configContents(config).mcp_servers.protools.args, [server]);
  const saved = join(home, '.protools-mcp', 'config.json');
  let savedConfig = JSON.parse(readFileSync(saved, 'utf8'));
  assert.equal(savedConfig.sdkVersion, undefined);
  assert.equal(savedConfig.protoPath, realpathSync(proto));
  assert.deepEqual(savedConfig.stemPresets, {
    unity: realpathSync(unity), current: realpathSync(current), dryImport: realpathSync(dryImport),
  });

  const custom = readFileSync(config, 'utf8') +
    'startup_timeout_sec = 42 # keep this comment\n[mcp_servers.protools.env]\nCUSTOM = "keep me"\n';
  writeFileSync(config, custom);
  const upgraded = runSetup(env, ['--client', 'codex', '--export-only', '--sdk-version', '2024.10']);
  assert.equal(upgraded.status, 0, upgraded.stderr);
  const registrations = configContents(config).mcp_servers;
  assert.equal(registrations.other.command, 'custom');
  assert.equal(registrations.protools.startup_timeout_sec, 42);
  assert.deepEqual(registrations.protools.env, {
    CUSTOM: 'keep me', ALLOW_WRITES: 'export,session,print', PTSL_EXPORT_ONLY: '1',
  });
  assert.ok(readFileSync(config, 'utf8').startsWith(custom));
  savedConfig = JSON.parse(readFileSync(saved, 'utf8'));
  assert.equal(savedConfig.sdkVersion, '2024.10');
  assert.deepEqual(savedConfig.stemPresets, {
    unity: realpathSync(unity), current: realpathSync(current), dryImport: realpathSync(dryImport),
  });

  const latest = readFileSync(config, 'utf8');
  const repeated = runSetup(env, ['--client', 'codex', '--export-only']);
  assert.equal(repeated.status, 0, repeated.stderr);
  assert.equal(readFileSync(config, 'utf8'), latest);
});

test('setup merges Codex settings in an inline table and protects an unrelated target', t => {
  const { env, config } = sandbox(t);
  const target = `command = "node", args = [${JSON.stringify(server)}], env = { ALLOW_WRITES = "memory", CUSTOM = "keep" }`;
  writeFileSync(config, `mcp_servers = { protools = { ${target} } } # preserve\n`);
  const upgraded = runSetup(env, ['--client', 'codex', '--export-only']);
  assert.equal(upgraded.status, 0, upgraded.stderr);
  assert.match(readFileSync(config, 'utf8'), /# preserve/);
  assert.deepEqual(configContents(config).mcp_servers.protools.env, {
    CUSTOM: 'keep', ALLOW_WRITES: 'export,session,print', PTSL_EXPORT_ONLY: '1',
  });
  const different = '[mcp_servers.protools]\ncommand = "unrelated"\n';
  writeFileSync(config, different);
  const conflict = runSetup(env, ['--client', 'codex', '--export-only']);
  assert.equal(conflict.status, 1);
  assert.match(conflict.stderr, /different server/);
  assert.equal(readFileSync(config, 'utf8'), different);
});

test('Claude Desktop registration preserves settings on macOS and Windows config paths', t => {
  const { home, env } = sandbox(t);
  for (const [platform, config] of [
    ['darwin', join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json')],
    ['win32', join(env.APPDATA, 'Claude', 'claude_desktop_config.json')],
  ]) {
    mkdirSync(dirname(config), { recursive: true });
    writeFileSync(config, JSON.stringify({
      preferences: { keep: true },
      mcpServers: { other: { command: 'custom' } },
    }));
    const result = runSetup(env, ['--client', 'claude', '--export-only'], platform);
    assert.equal(result.status, 0, result.stderr);
    const modified = JSON.parse(readFileSync(config, 'utf8'));
    assert.deepEqual(modified.preferences, { keep: true });
    assert.deepEqual(modified.mcpServers.other, { command: 'custom' });
    assert.equal(modified.mcpServers.protools.command, process.execPath);
    assert.deepEqual(modified.mcpServers.protools.args, [server]);
    assert.equal(modified.mcpServers.protools.env.PTSL_EXPORT_ONLY, '1');
  }

  const missing = runSetup(env, ['--client', 'none', '--dry-import-preset', home]);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /must be a readable file/);
  assert.ok(existsSync(join(home, '.protools-mcp', 'config.json')));
});
