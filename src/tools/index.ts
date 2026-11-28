import { PTSLClient } from '../grpc/client.js';
import { dryTool, exportDryTracks } from './dry-tracks.js';
import { exportStems, stemTool } from './stems.js';
import { sessionTools, handleSessionTool } from './session.js';
import { trackTools, handleTrackTool } from './tracks.js';
import { transportTools, handleTransportTool } from './transport.js';
import { clipTools, handleClipTool } from './clips.js';
import { editingTools, handleEditingTool } from './editing.js';
import { markerTools, handleMarkerTool } from './markers.js';
import { timelineTools, handleTimelineTool } from './timeline.js';
import { analyzeTools, handleAnalyzeTool } from './analyze.js';
import { rawTools, handleRawTool } from './raw.js';
import { diagnosticTools, handleDiagnosticTool } from './diagnostic.js';
import { withSessionLock } from './session-lock.js';

/**
 * All available MCP tools
 */
export const allTools = [
  stemTool,
  dryTool,
  ...sessionTools,
  ...trackTools,
  ...transportTools,
  ...clipTools,
  ...editingTools,
  ...markerTools,
  ...timelineTools,
  ...analyzeTools,
  ...rawTools,
  ...diagnosticTools,
];

const exportProfile = new Set([
  'diagnose_ptsl_connection',
  'get_track_list',
  'export_stems',
  'export_dry_tracks',
]);

export function getExposedTools() {
  return process.env.PTSL_EXPORT_ONLY === '1'
    ? allTools.filter(tool => exportProfile.has(tool.name))
    : allTools;
}
export async function handleToolCall(
  toolName: string,
  args: any,
  client: PTSLClient
): Promise<any> {
  if (process.env.PTSL_EXPORT_ONLY === '1' && !exportProfile.has(toolName)) {
    throw new Error('Tool is not enabled in this server profile.');
  }
  const endpoint = client.getConnectionInfo?.().endpoint ?? 'localhost:31416';
  return await withSessionLock(endpoint, () => dispatchToolCall(toolName, args, client));
}

async function dispatchToolCall(toolName: string, args: any, client: PTSLClient): Promise<any> {
  if (toolName === dryTool.name) return exportDryTracks(client, args.tracks);
  if (toolName === stemTool.name) return exportStems(args, client);

  // Check session tools
  if (sessionTools.find((t) => t.name === toolName)) {
    return await handleSessionTool(toolName, args, client);
  }

  // Check track tools
  if (trackTools.find((t) => t.name === toolName)) {
    return await handleTrackTool(toolName, args, client);
  }

  // Check transport tools
  if (transportTools.find((t) => t.name === toolName)) {
    return await handleTransportTool(toolName, args, client);
  }

  // Check clip tools
  if (clipTools.find((t) => t.name === toolName)) {
    return await handleClipTool(toolName, args, client);
  }

  // Check editing tools
  if (editingTools.find((t) => t.name === toolName)) {
    return await handleEditingTool(toolName, args, client);
  }

  // Check marker tools
  if (markerTools.find((t) => t.name === toolName)) {
    return await handleMarkerTool(toolName, args, client);
  }

  // Check timeline tools
  if (timelineTools.find((t) => t.name === toolName)) {
    return await handleTimelineTool(toolName, args, client);
  }

  // Check analyze tools
  if (analyzeTools.find((t) => t.name === toolName)) {
    return await handleAnalyzeTool(toolName, args, client);
  }

  // Check raw tools
  if (rawTools.find((t) => t.name === toolName)) {
    return await handleRawTool(toolName, args, client);
  }

  // Check diagnostic tools
  if (diagnosticTools.find((t) => t.name === toolName)) {
    return await handleDiagnosticTool(toolName, args, client);
  }

  throw new Error(`Unknown tool: ${toolName}`);
}
