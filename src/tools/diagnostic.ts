import { constants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import path from 'node:path';
import { loadConfig, type StemPresets } from '../config.js';
import { PTSLClient } from '../grpc/client.js';
import { CommandId } from '../grpc/commands.js';
import { readSessionTracks } from './tracks.js';

/**
 * Diagnostic tool for sampling PTSL command responses
 *
 * This helps verify that our MCP response formatting matches
 * the actual JSON structure returned by PTSL.
 */

export const diagnosticTools = [
  {
    name: 'diagnose_ptsl_connection',
    description: 'Check the local PTSL schema, Pro Tools registration, host API version, open session, track retrieval, and which export commands the local SDK declares. Does not run exports.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'sample_ptsl_responses',
    description: 'Sample actual JSON responses from various PTSL commands to verify response formatting. Logs output to server console.',
    inputSchema: {
      type: 'object',
      properties: {
        commands: {
          type: 'array',
          items: { type: 'string' },
          description: 'Array of command names to sample (e.g., ["GetTrackList", "GetClipList", "GetMemoryLocations"]). If not provided, samples common commands.',
        },
      },
    },
  },
];

export async function handleDiagnosticTool(
  toolName: string,
  args: any,
  client: PTSLClient
): Promise<any> {
  if (toolName === 'diagnose_ptsl_connection') {
    return await diagnosePTSLConnection(client);
  }
  if (toolName === 'sample_ptsl_responses') {
    return await samplePTSLResponses(client, args.commands);
  }
  throw new Error(`Unknown diagnostic tool: ${toolName}`);
}

const probeTimeoutMs = 5_000;

async function check<T>(probe: () => Promise<T>) {
  try {
    return { status: 'ok' as const, result: await probe() };
  } catch (error) {
    return { status: 'failed' as const, error: error instanceof Error ? error.message : String(error) };
  }
}

async function readHostBody(client: PTSLClient, command: CommandId) {
  const response = await client.sendRequest(command, {}, false, probeTimeoutMs);
  if (response.header?.status !== 'Completed' || !response.response_body) {
    throw new Error(`${CommandId[command]} returned ${response.header?.status ?? 'no task status'}: ` +
      (response.response_error_json || response.response_body_json || 'No response body returned.'));
  }
  return response.response_body;
}

async function describePresets() {
  let saved: StemPresets | undefined;
  try {
    saved = loadConfig().stemPresets;
  } catch {
    // A client given a proto directly can still diagnose environment presets.
  }
  const presets = {
    unity: process.env.PTSL_STEM_WET_UNITY_PRESET || saved?.unity,
    current: process.env.PTSL_STEM_WET_CURRENT_PRESET || saved?.current,
    dry_import: process.env.PTSL_STEM_DRY_IMPORT_PRESET || saved?.dryImport,
  };
  return Object.fromEntries(await Promise.all(Object.entries(presets).map(async ([name, file]) => {
    if (!file) return [name, { status: 'not_configured' }];
    const result = await check(async () => {
      if (!path.isAbsolute(file) || !(await stat(file)).isFile()) {
        throw new Error('An absolute path to a preset file is required.');
      }
      await access(file, constants.R_OK);
      return { readable: true };
    });
    return [name, { path: file, ...result, host_content: 'unverified' }];
  })));
}

async function diagnosePTSLConnection(client: PTSLClient) {
  const schema = await check(async () => {
    await client.connect();
    return { loaded: true };
  });
  const skipped = { status: 'skipped' };
  const registration = schema.status === 'ok' ? await check(async () => {
    await client.registerConnection();
    return { registered: true };
  }) : skipped;

  const exportCommands = ['ExportMix', 'ExportClipsAsFiles', 'BounceTrack'];
  const exports = await Promise.all(exportCommands.map(async command => ({
    command,
    declared_in_local_schema: schema.status === 'ok' ? await client.hasCommand(command) : null,
    host_execution: 'unverified',
  })));

  const [hostVersion, session, tracks] = registration.status === 'ok' ? await Promise.all([
    check(async () => {
      const body = await readHostBody(client, CommandId.GetPTSLVersion);
      const major = body.version;
      const minor = body.version_minor ?? body.versionMinor;
      const revision = body.version_revision ?? body.versionRevision;
      return {
        version: major === undefined ? null : minor === undefined ? String(major) : `${major}.${minor}.${revision ?? 0}`,
        raw_response: body,
      };
    }),
    check(async () => {
      const body = await readHostBody(client, CommandId.GetSessionName);
      return { name: body.session_name ?? body.sessionName ?? null };
    }),
    check(async () => {
      const tracks = await readSessionTracks(client, probeTimeoutMs);
      return { count: tracks.length };
    }),
  ]) : [skipped, skipped, skipped];

  const connection = client.getConnectionInfo();
  const bounceTrack = exports.find(item => item.command === 'BounceTrack')?.declared_in_local_schema;
  const clipExport = exports.find(item => item.command === 'ExportClipsAsFiles')?.declared_in_local_schema;
  const mixExport = exports.find(item => item.command === 'ExportMix')?.declared_in_local_schema;
  const nativeBounceStatus = connection.legacy_2024_10 || bounceTrack === false ? 'unavailable' : 'unverified';
  const report = {
    ...connection,
    schema,
    registration,
    host_version: hostVersion,
    session,
    tracks,
    export_commands: exports,
    export_presets: await describePresets(),
    export_workflows: {
      dry_unity: { clip_export_declared: clipExport, host_execution: 'unverified' },
      dry_current_native: { track_bounce_declared: bounceTrack, status: nativeBounceStatus, presets: ['current', 'dry_import'] },
      dry_current_via_routed_buses: {
        mix_export_declared: mixExport,
        status: mixExport === false ? 'unavailable' : 'unverified',
        preset: 'dry_import',
        routing: 'Supply a distinct dry_current_bus matching each track’s main output.',
      },
      wet_native: { track_bounce_declared: bounceTrack, status: nativeBounceStatus, preset: 'unity or current' },
      wet_via_routed_buses: {
        mix_export_declared: mixExport,
        status: mixExport === false ? 'unavailable' : 'unverified',
        routing: 'A distinct prepared wet bus for each requested track and return at the chosen fader mode.',
      },
    },
    allowed_write_groups: client.getAllowedPermissionGroups(),
  };
  return {
    content: [{ type: 'text', text: JSON.stringify(report, null, 2) }],
  };
}

async function samplePTSLResponses(client: PTSLClient, commandNames?: string[]) {
  const defaultCommands = [
    'GetTrackList',
    'GetClipList',
    'GetMemoryLocations',
    'GetTimelineSelection',
    'GetSessionName',
    'GetSessionSampleRate',
    'GetSessionLength',
  ];

  const commands = commandNames || defaultCommands;
  const results: { [key: string]: any } = {};
  const errors: { [key: string]: string } = {};

  console.error('\n' + '='.repeat(80));
  console.error('PTSL RESPONSE SAMPLING TOOL');
  console.error('='.repeat(80));

  for (const commandName of commands) {
    // Get command ID from CommandId enum
    const commandId = (CommandId as any)[commandName];

    if (commandId === undefined) {
      errors[commandName] = 'Command not found in CommandId enum';
      console.error(`\n❌ ${commandName}: Command not found`);
      continue;
    }

    try {
      console.error(`\n📡 Sampling ${commandName} (ID: ${commandId})...`);
      const response = await client.sendRequest(commandId);

      // Log the full response structure
      console.error('\n' + '-'.repeat(80));
      console.error(`Response for ${commandName}:`);
      console.error('-'.repeat(80));
      console.error(JSON.stringify(response, null, 2));
      console.error('-'.repeat(80));

      // Store summary
      results[commandName] = {
        status: response.header?.status,
        hasResponseBody: !!response.response_body,
        responseBodyKeys: response.response_body ? Object.keys(response.response_body) : [],
        firstItem: getFirstItem(response.response_body),
      };

      console.error(`✅ ${commandName}: ${response.header?.status || 'Unknown status'}`);

    } catch (error: any) {
      errors[commandName] = error.message || String(error);
      console.error(`❌ ${commandName}: ${error.message}`);
    }
  }

  console.error('\n' + '='.repeat(80));
  console.error('SAMPLING COMPLETE');
  console.error('='.repeat(80));

  // Return summary to user
  let summaryText = '**PTSL Response Sampling Complete**\n\n';
  summaryText += `Sampled ${commands.length} commands. Check server console for full JSON responses.\n\n`;

  if (Object.keys(results).length > 0) {
    summaryText += '**Successful Samples:**\n';
    for (const [cmd, info] of Object.entries(results)) {
      summaryText += `- ${cmd}: ${info.status}\n`;
      if (info.responseBodyKeys.length > 0) {
        summaryText += `  - Response keys: ${info.responseBodyKeys.join(', ')}\n`;
      }
    }
  }

  if (Object.keys(errors).length > 0) {
    summaryText += '\n**Errors:**\n';
    for (const [cmd, error] of Object.entries(errors)) {
      summaryText += `- ${cmd}: ${error}\n`;
    }
  }

  summaryText += '\n**Note:** Full JSON responses have been logged to the server console (stderr).';

  return {
    content: [
      {
        type: 'text',
        text: summaryText,
      },
    ],
  };
}

/**
 * Get the first item from a response body to show structure
 */
function getFirstItem(responseBody: any): any {
  if (!responseBody) return null;

  // Check common array field names
  const arrayFields = ['clips', 'track_list', 'memory_locations', 'playlists', 'elements_list'];

  for (const field of arrayFields) {
    if (responseBody[field] && Array.isArray(responseBody[field]) && responseBody[field].length > 0) {
      const item = responseBody[field][0];
      // Return keys only for brevity
      return {
        field: field,
        keys: Object.keys(item),
      };
    }
  }

  return null;
}
