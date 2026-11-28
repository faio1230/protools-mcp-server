import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { randomUUID } from 'node:crypto';

export interface StemPresets {
  unity?: string;
  current?: string;
  dryImport?: string;
}

export interface Config {
  protoPath: string;
  serverAddress?: string;
  sdkVersion?: string;
  stemPresets?: StemPresets;
}

const DEFAULT_CONFIG_DIR = path.join(os.homedir(), '.protools-mcp');
const DEFAULT_CONFIG_FILE = path.join(DEFAULT_CONFIG_DIR, 'config.json');

/**
 * Get the config directory path
 */
export function getConfigDir(): string {
  return DEFAULT_CONFIG_DIR;
}

/**
 * Get the config file path
 */
export function getConfigPath(): string {
  return DEFAULT_CONFIG_FILE;
}

/**
 * Load configuration from file or environment
 */
export function loadConfig(): Config {
  // First try to load from config file
  if (fs.existsSync(DEFAULT_CONFIG_FILE)) {
    const data = fs.readFileSync(DEFAULT_CONFIG_FILE, 'utf-8');
    const config = JSON.parse(data.replace(/^\uFEFF/, ''));
    return {
      protoPath: config.protoPath,
      serverAddress: config.serverAddress || 'localhost:31416',
      sdkVersion: config.sdkVersion || process.env.PTSL_SDK_VERSION,
      stemPresets: config.stemPresets,
    };
  }

  // Fall back to environment variable
  const protoPath = process.env.PTSL_PROTO_PATH;
  if (protoPath) {
    return {
      protoPath,
      serverAddress: process.env.PTSL_SERVER_ADDRESS || 'localhost:31416',
      sdkVersion: process.env.PTSL_SDK_VERSION,
    };
  }

  throw new Error(
    'No configuration found. Please either:\n' +
    `  1. Create ${DEFAULT_CONFIG_FILE} with your PTSL.proto path\n` +
    '  2. Set PTSL_PROTO_PATH environment variable\n' +
    '  3. Run npm run setup'
  );
}

/**
 * Save configuration to file
 */
export function saveConfig(config: Config): void {
  writeJsonFile(DEFAULT_CONFIG_FILE, config);
}

/** Write a JSON config via a same-directory temporary file. */
export function writeJsonFile(file: string, value: unknown): void {
  writeConfigFile(file, JSON.stringify(value, null, 2) + '\n');
}

/** Write configuration text via a same-directory temporary file. */
export function writeConfigFile(file: string, content: string): void {
  // Follow an existing config symlink so that setup preserves it.
  const target = fs.existsSync(file) ? fs.realpathSync(file) : file;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = path.join(path.dirname(target), `.${path.basename(target)}.${randomUUID()}.tmp`);
  const mode = fs.existsSync(target) ? fs.statSync(target).mode & 0o777 : 0o600;
  try {
    fs.writeFileSync(temporary, content, { encoding: 'utf8', mode, flag: 'wx' });
    fs.renameSync(temporary, target);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

/** Validate that the configured proto path is a readable file. */
export function validateConfig(config: Config): void {
  if (typeof config.protoPath !== 'string' || !config.protoPath) {
    throw new Error('Set protoPath to the Avid PTSL SDK file or run npm run setup.');
  }
  if (!fs.existsSync(config.protoPath) || !fs.statSync(config.protoPath).isFile()) {
    throw new Error(`PTSL.proto file not found at: ${config.protoPath}`);
  }
  fs.accessSync(config.protoPath, fs.constants.R_OK);
}
