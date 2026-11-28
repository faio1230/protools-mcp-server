import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { Command, Option } from 'commander';
import { loadSync } from '@grpc/proto-loader';
import { mergeCodexEnvironment } from './codex-config.js';
import { getConfigPath, loadConfig, saveConfig, validateConfig, writeJsonFile, type StemPresets } from './config.js';

const projectDir = fileURLToPath(new URL('../', import.meta.url));
const serverEntry = path.join(projectDir, 'dist', 'index.js');
const serverName = 'protools';
const exportEnvironment = { ALLOW_WRITES: 'export,session,print', PTSL_EXPORT_ONLY: '1' };
const sdkFilePattern = /^PTSL(?:\.[0-9]+(?:\.[0-9]+){1,2})?\.proto$/i;

type Client = 'codex' | 'claude' | 'both' | 'none';

interface SetupOptions {
  proto?: string;
  client?: Client;
  sdkVersion?: string;
  exportOnly?: boolean;
  unityPreset?: string;
  currentPreset?: string;
  dryImportPreset?: string;
}

function resolveInput(input: string): string {
  const expanded = input.replace(/^~(?=[/\\]|$)/, os.homedir());
  return path.resolve(expanded);
}

function readDirectory(root: string): fs.Dirent[] {
  try {
    return fs.readdirSync(root, { withFileTypes: true });
  } catch (error) {
    if (['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '')) {
      return [];
    }
    throw error;
  }

}

function findProtoFiles(root: string, depth: number): string[] {
  return readDirectory(root).flatMap(entry => {
    const target = path.join(root, entry.name);
    if (sdkFilePattern.test(entry.name) && (entry.isFile() || entry.isSymbolicLink())) {
      return fs.existsSync(target) ? [fs.realpathSync(target)] : [];
    }
    if (entry.isDirectory() && depth > 0 && !entry.name.startsWith('.') && entry.name !== 'node_modules') {
      return findProtoFiles(target, depth - 1);
    }
    return [];
  });
}

function discoverProtoFiles(): string[] {
  const roots = [path.join(projectDir, 'ptsl_sdk')];
  for (const folder of ['Desktop', 'Documents', 'Downloads']) {
    const homeFolder = path.join(os.homedir(), folder);
    readDirectory(homeFolder).filter(entry => entry.isDirectory() && /ptsl|pro.?tools|avid|scripting/i.test(entry.name))
      .forEach(entry => roots.push(path.join(homeFolder, entry.name)));
  }
  const directLocations = [projectDir, os.homedir(), ...['Desktop', 'Documents', 'Downloads']
    .map(folder => path.join(os.homedir(), folder))];
  return [...new Set([
    ...directLocations.flatMap(folder => findProtoFiles(folder, 0)),
    ...roots.flatMap(root => findProtoFiles(root, 5)),
  ])].sort();
}

function selectProto(input: string): string {
  let candidate = resolveInput(input);
  if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
    const files = [...new Set(findProtoFiles(candidate, 8))];
    if (files.length !== 1) {
      throw new Error(files.length === 0
        ? `No PTSL.proto found in ${candidate}. Extract the SDK from Avid or pass the path directly.`
        : `Multiple PTSL.proto files found in ${candidate}. Pass the matching file directly:\n${files.join('\n')}`);
    }
    candidate = files[0];
  }
  validateConfig({ protoPath: candidate });
  const definition = loadSync(candidate);
  const service = definition['ptsl.PTSL'] ?? definition['ptsl_2024_10_0.PTSL'];
  if (!service || !('SendGrpcRequest' in service) || !('SendGrpcStreamingRequest' in service)) {
    throw new Error(`${candidate} does not define the supported PTSL RPC service. Select PTSL.proto from the Avid SDK.`);
  }
  return fs.realpathSync(candidate);
}

async function chooseProto(
  options: SetupOptions,
  savedPath: string | undefined,
  prompt?: ReturnType<typeof createInterface>
): Promise<string> {
  if (options.proto) {
    return selectProto(options.proto);
  }
  // Setup is repeatable without rediscovering an SDK that was already selected.
  for (const candidate of [savedPath, process.env.PTSL_PROTO_PATH]) {
    if (candidate && fs.existsSync(candidate)) {
      return selectProto(candidate);
    }
  }

  const files = discoverProtoFiles();
  if (files.length === 1) {
    return selectProto(files[0]);
  }
  if (prompt) {
    if (files.length > 1) {
      console.log('Select the SDK that matches your Pro Tools installation.');
      files.forEach((file, index) => console.log(`  ${index + 1}. ${file}`));
    }
    const choice = (await prompt.question('Enter the SDK folder, PTSL.proto path, or a numbered choice: ')).trim();
    if (choice) {
      return selectProto(files[Number(choice) - 1] ?? choice);
    }
  }
  const found = files.length ? `\n${files.join('\n')}` : '';
  throw new Error(`Pass --proto with the extracted SDK folder or PTSL.proto from Avid.${found}`);
}

async function chooseClient(
  client: Client | undefined,
  prompt?: ReturnType<typeof createInterface>
): Promise<Client> {
  if (client) {
    return client;
  }
  if (prompt) {
    const answer = (await prompt.question('Which MCP client should setup register (codex, claude, both, none)? ')).trim().toLowerCase();
    if (answer === 'codex' || answer === 'claude' || answer === 'both' || answer === 'none') {
      return answer;
    }
  }
  throw new Error('Choose --client codex, --client claude, --client both, or --client none.');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function registerClaude(exportOnly: boolean): void {
  let configDir: string;
  if (process.platform === 'darwin') {
    configDir = path.join(os.homedir(), 'Library', 'Application Support', 'Claude');
  } else if (process.platform === 'win32') {
    const appData = process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming');
    configDir = path.join(appData, 'Claude');
  } else {
    throw new Error('Claude Desktop setup is supported on macOS and Windows.');
  }

  const configPath = path.join(configDir, 'claude_desktop_config.json');
  const content: unknown = fs.existsSync(configPath)
    ? JSON.parse(fs.readFileSync(configPath, 'utf8').replace(/^\uFEFF/, ''))
    : {};
  if (!isRecord(content) || (content.mcpServers !== undefined && !isRecord(content.mcpServers))) {
    throw new Error(`Unexpected Claude Desktop configuration format in ${configPath}.`);
  }
  const servers = content.mcpServers ?? {};
  const existing = servers[serverName];
  if (existing !== undefined && (!isRecord(existing) || !isLocalRegistration(existing))) {
    throw new Error(`An existing ${serverName} entry in ${configPath} points to a different server. Rename or remove that entry before retrying.`);
  }
  const registration = { ...existing, command: process.execPath, args: [serverEntry] };
  const environment = existing?.env;
  if (exportOnly && environment !== undefined && !isRecord(environment)) {
    throw new Error(`Unexpected environment format for ${serverName} in ${configPath}.`);
  }
  writeJsonFile(configPath, {
    ...content,
    mcpServers: {
      ...servers,
      [serverName]: exportOnly
        ? { ...registration, env: { ...(isRecord(environment) ? environment : {}), ...exportEnvironment } }
        : registration,
    },
  });
  console.log(`Registered Pro Tools with Claude Desktop. Restart Claude Desktop to load it.`);
}

function isLocalRegistration(entry: Record<string, unknown>): boolean {
  if (!Array.isArray(entry.args) || entry.args.length !== 1 || typeof entry.args[0] !== 'string') {
    return false;
  }
  return path.isAbsolute(entry.args[0]) && path.relative(serverEntry, entry.args[0]) === '';
}

function runCodex(args: string[]): string {
  const options = { encoding: 'utf8' as const, timeout: 30_000, windowsHide: true };
  try {
    return execFileSync(process.platform === 'win32' ? 'codex.exe' : 'codex', args, options);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
    if (process.platform === 'win32') {
      // npm places a cmd shim on PATH. Launch its JavaScript entry directly.
      for (const folder of (process.env.PATH ?? '').split(path.delimiter).filter(Boolean)) {
        const entry = path.join(folder.replace(/^"(.*)"$/, '$1'), 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
        if (fs.existsSync(entry)) {
          return execFileSync(process.execPath, [entry, ...args], options);
        }
      }
    }
    throw new Error('Install the Codex CLI and make it available on PATH, then rerun setup.');
  }
}

function registerCodex(exportOnly: boolean): void {
  const registrations: unknown = JSON.parse(runCodex(['mcp', 'list', '--json']));
  if (!Array.isArray(registrations)) {
    throw new Error('Could not read Codex MCP registrations. Update the Codex CLI and rerun setup.');
  }
  const existing: unknown = registrations.find(entry => isRecord(entry) && entry.name === serverName);
  if (isRecord(existing)) {
    if (!isRecord(existing.transport) || !isLocalRegistration(existing.transport)) {
      throw new Error(`An existing Codex ${serverName} entry points to a different server. Rename or remove it before retrying.`);
    }
    if (existing.enabled === false) {
      throw new Error(`The existing Codex ${serverName} entry is disabled. Enable it in Codex settings to use it.`);
    }
    const environment = existing.transport.env;
    if (exportOnly && (!isRecord(environment) ||
      Object.entries(exportEnvironment).some(([key, value]) => environment[key] !== value))) {
      mergeCodexEnvironment(serverName, entry => isRecord(entry) && isLocalRegistration(entry), exportEnvironment);
    }
  } else {
    const envArgs = exportOnly ? Object.entries(exportEnvironment).flatMap(([key, value]) => ['--env', `${key}=${value}`]) : [];
    runCodex(['mcp', 'add', serverName, ...envArgs, '--', process.execPath, serverEntry]);
  }
  console.log('Registered Pro Tools with Codex. Start a new Codex session to load it.');
}

function chooseStemPresets(options: SetupOptions, saved: StemPresets | undefined): StemPresets | undefined {
  const requested = {
    unity: options.unityPreset,
    current: options.currentPreset,
    dryImport: options.dryImportPreset,
  };
  const presets: StemPresets = { ...saved };
  for (const key of ['unity', 'current', 'dryImport'] as const) {
    const input = requested[key];
    if (input) {
      const file = resolveInput(input);
      if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
        throw new Error(`Stem export preset must be a readable file: ${file}`);
      }
      fs.accessSync(file, fs.constants.R_OK);
      presets[key] = fs.realpathSync(file);
    }
  }
  return Object.keys(presets).length ? presets : undefined;
}

async function setup(options: SetupOptions): Promise<void> {
  const prompt = process.stdin.isTTY && process.stdout.isTTY
    ? createInterface({ input: process.stdin, output: process.stdout })
    : undefined;
  try {
    const saved = fs.existsSync(getConfigPath()) ? loadConfig() : undefined;
    const protoPath = await chooseProto(options, saved?.protoPath, prompt);
    const client = await chooseClient(options.client, prompt);
    if (client !== 'none' && !fs.existsSync(serverEntry)) {
      throw new Error('The server build is missing. Run npm run setup from the repository.');
    }

    const config = {
      protoPath,
      serverAddress: saved?.serverAddress ?? process.env.PTSL_SERVER_ADDRESS ?? 'localhost:31416',
      sdkVersion: options.sdkVersion ?? (saved?.protoPath === protoPath ? saved.sdkVersion : undefined) ??
        process.env.PTSL_SDK_VERSION,
      stemPresets: chooseStemPresets(options, saved?.stemPresets),
    };
    saveConfig(config);
    console.log(`Saved the PTSL SDK path to ${getConfigPath()}.`);
    if (client === 'codex' || client === 'both') {
      registerCodex(options.exportOnly ?? false);
    }
    if (client === 'claude' || client === 'both') {
      registerClaude(options.exportOnly ?? false);
    }
  } finally {
    prompt?.close();
  }
}

const program = new Command()
  .name('protools-mcp-setup')
  .description('Save a local Avid PTSL SDK path and register the Pro Tools MCP server')
  .option('--proto <path>', 'path to PTSL.proto or its extracted SDK folder')
  .option('--sdk-version <version>', 'SDK version, if known (for example 2024.10)')
  .option('--export-only', 'configure the client for stem export with restricted write permissions')
  .option('--unity-preset <path>', 'save the wet unity-gain Bounce Track preset')
  .option('--current-preset <path>', 'save the wet current-level Bounce Track preset')
  .option('--dry-import-preset <path>', 'save the dry current-level Track Data to Import preset')
  .addOption(new Option('--client <client>', 'local MCP client to configure').choices(['codex', 'claude', 'both', 'none']))
  .action(setup);

program.parseAsync().catch((error: unknown) => {
  console.error(`Setup failed. ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
