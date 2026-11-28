import { lstat, mkdir, mkdtemp, readdir, realpath, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { loadConfig } from '../config.js';
import type { PTSLClient } from '../grpc/client.js';
import { CommandId, PermissionGroup } from '../grpc/commands.js';
import { printDryTracks } from './dry-tracks.js';
import { dryImportPreset, withDryCurrentTracks } from './dry-current.js';
import { sendCompleted, withSessionState, withTimelineRange } from './mixer-state.js';
import { readWav, writeStemWav } from './stem-wav.js';
import { readSessionTracks } from './tracks.js';
import { exportLegacyBusPrint, exportMixBuses, supportsExportMixBounds } from './legacy-bus-print.js';

export { readWav } from './stem-wav.js';

const wetBusSchema = {
  type: 'object',
  additionalProperties: false,
  properties: { unity: { type: 'string', minLength: 1 }, current: { type: 'string', minLength: 1 } },
  description: 'Optional dedicated mix source for each fader setting. Supply these for all wet tracks to use legacy bus bounce.',
};

export const stemTool = {
  name: 'export_stems',
  description: 'Export aligned Dry, Wet or both sets of named tracks to 48 kHz / 24-bit WAVs under the session Bounced Files folder. Dry export saves and reopens the source session while rendering a working copy. You can set mono or stereo separately per track and pass FX return tracks for separate wet WAVs. The existing buses and directory form bounces named buses.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      buses: { type: 'array', minItems: 1, uniqueItems: true, items: { type: 'string', minLength: 1 } },
      directory: { type: 'string', description: 'Existing parent directory on the Pro Tools computer.' },
      offline: { type: 'boolean', description: 'Defaults to false. Enable for sessions that support offline bounce.' },
      tracks: { type: 'array', minItems: 1, items: { anyOf: [
        { type: 'string', minLength: 1 },
        { type: 'object', required: ['name'], additionalProperties: false, properties: {
          name: { type: 'string', minLength: 1 },
          dry_channels: { type: 'integer', enum: [1, 2] },
          dry_current_bus: { type: 'string', minLength: 1,
            description: 'Dedicated main track output bus for a legacy dry/current bounce. Requires a dry import preset that includes Main Output Assignments.' },
          wet_channels: { type: 'integer', enum: [1, 2] },
          wet_bus: wetBusSchema,
        } },
      ] } },
      mode: { type: 'string', enum: ['dry', 'wet', 'both'], default: 'both' },
      fader: { type: 'string', enum: ['unity', 'current'], default: 'unity' },
      fx_returns: { type: 'array', uniqueItems: true, items: { anyOf: [
        { type: 'string', minLength: 1 },
        { type: 'object', required: ['name'], additionalProperties: false, properties: {
          name: { type: 'string', minLength: 1 },
          wet_channels: { type: 'integer', enum: [1, 2] },
          wet_bus: wetBusSchema,
        } },
      ] }, description: 'Auxiliary FX returns to print separately with wet exports.' },
      start_sample: { type: 'integer', description: 'First sample, relative to session start. Defaults to the timeline selection or the range covered by the requested audio tracks.' },
      end_sample: { type: 'integer', description: 'Exclusive final sample, relative to session start.' },
    },
    oneOf: [{ required: ['buses', 'directory'] }, { required: ['tracks'] }],
    additionalProperties: false,
  },
};

export async function exportStems(args: StemExportArgs, client: PTSLClient) {
  if (args.tracks !== undefined) return exportTrackStems(args, client);
  for (const key of ['mode', 'fader', 'fx_returns', 'start_sample', 'end_sample'] as const) {
    if (args[key] !== undefined) throw new Error(key + ' requires tracks.');
  }
  return withSessionState(client, () => exportBusStems(args, client));
}

async function exportBusStems(args: StemExportArgs, client: PTSLClient) {
  if (!client.isPermissionGroupAllowed(PermissionGroup.EXPORT)) throw new Error('Set ALLOW_WRITES=export to export stems.');
  const { buses, directory, offline = false } = args;
  if (!Array.isArray(buses) || !buses.length || buses.some(bus => typeof bus !== 'string' || !bus.trim()) ||
      new Set(buses).size !== buses.length) throw new Error('Provide one or more distinct bus names.');
  if (typeof directory !== 'string' || !path.isAbsolute(directory)) throw new Error('An absolute output directory is required.');
  if (typeof offline !== 'boolean') throw new Error('offline must be a boolean.');

  const request = (id: CommandId, body?: Record<string, unknown>) => requiredBody(client, id, body);

  const rate = (await request(CommandId.GetSessionSampleRate))?.sample_rate;
  const rateMatch = /^(?:SR_|SRate_)(\d+)$/.exec(String(rate));
  if (!rateMatch || !Number(rateMatch[1])) throw new Error('Unrecognized session sample rate: ' + rate);
  const selection = await request(CommandId.GetTimelineSelection, await sampleSelectionUnits(client));
  const start = selection?.in_time;
  const end = selection?.out_time;
  if (!/^-?\d+$/.test(start) || !/^-?\d+$/.test(end) || Number(end) <= Number(start)) {
    throw new Error('Select a nonempty timeline range before bouncing.');
  }
  const expectedFrames = (Number(end) - Number(start)) * 48000 / Number(rateMatch[1]);
  const folder = await mkdtemp(path.join(directory, 'stems-'));
  try {
    const bounds = await supportsExportMixBounds(client) ? { start, end } : undefined;
    await exportMixBuses(client, buses, folder, offline, bounds);
    const names = (await readdir(folder, { withFileTypes: true }))
      .filter(entry => entry.isFile() && /\.wav$/i.test(entry.name)).map(entry => entry.name).sort();
    if (names.length !== buses.length) throw new Error('Expected ' + buses.length + ' WAV files, found ' + names.length);
    const files = await Promise.all(names.map(name => readWav(path.join(folder, name))));
    if (files.some(f => f.frames !== files[0].frames || f.frames < Math.floor(expectedFrames) || f.frames > Math.ceil(expectedFrames))) {
      throw new Error('WAV lengths do not match the selection.');
    }
    return { content: [{ type: 'text', text: JSON.stringify({ folder, buses, start, end, sampleRate: 48000, bitDepth: 24, files }) }] };
  } catch (error) {
    throw new Error('Stem export incomplete in ' + folder + ': ' + (error instanceof Error ? error.message : String(error)));
  }
}

interface StemExportArgs {
  buses?: unknown;
  directory?: unknown;
  offline?: unknown;
  tracks?: unknown;
  mode?: unknown;
  fader?: unknown;
  fx_returns?: unknown;
  start_sample?: unknown;
  end_sample?: unknown;
}

interface TrackStem {
  name: string;
  dry_channels?: number;
  dry_current_bus?: string;
  wet_channels?: number;
  wet_bus?: { unity?: string; current?: string };
}

function readTrackStem(entry: unknown): TrackStem {
  const spec = typeof entry === 'string' ? { name: entry } : entry;
  if (!spec || typeof spec !== 'object') throw new Error('Provide track names or track objects.');
  const { name, dry_channels, dry_current_bus, wet_channels, wet_bus } = spec as Record<string, unknown>;
  if (typeof name !== 'string' || !name.trim() || /[<>:"/\\|?*\x00-\x1f]|[ .]$/u.test(name) ||
      /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) {
    throw new Error('Track name is unsuitable for a WAV filename: ' + String(name));
  }
  if ((dry_channels !== undefined && dry_channels !== 1 && dry_channels !== 2) ||
      (wet_channels !== undefined && wet_channels !== 1 && wet_channels !== 2)) {
    throw new Error('Channel overrides must be 1 (mono) or 2 (stereo) on ' + name);
  }
  if (wet_bus !== undefined && (!wet_bus || typeof wet_bus !== 'object' || Array.isArray(wet_bus) ||
      Object.entries(wet_bus).some(([key, value]) =>
        !['unity', 'current'].includes(key) || typeof value !== 'string' || !value.trim()))) {
    throw new Error('wet_bus must specify a named unity or current bus for ' + name);
  }
  if (dry_current_bus !== undefined && (typeof dry_current_bus !== 'string' || !dry_current_bus.trim())) {
    throw new Error('dry_current_bus must specify a dedicated main track output bus for ' + name);
  }
  return { name, dry_channels, dry_current_bus, wet_channels, wet_bus: wet_bus as TrackStem['wet_bus'] };
}

function sample(value: unknown) {
  if ((typeof value === 'number' || typeof value === 'string' && /^-?\d+$/.test(value)) &&
      Number.isSafeInteger(Number(value))) return Number(value);
  throw new Error('Use integer sample positions for both time bounds.');
}

function checkStemLength(frames: number, expected: number) {
  if (frames < Math.floor(expected) || frames > Math.ceil(expected)) {
    throw new Error(`Unexpected WAV length of ${frames} frames (expected ${expected}).`);
  }
}

async function requiredBody(client: PTSLClient, command: CommandId, values: Record<string, unknown> = {}) {
  return (await sendCompleted(client, command, values)).response_body;
}

async function sampleSelectionUnits(client: PTSLClient) {
  return await client.hasMessageField?.('GetTimelineSelectionRequestBody', 'location_type')
    ? { location_type: 'TLType_Samples' } : { time_scale: 'Samples' };
}

async function getClipExtent(client: PTSLClient, trackNames: string[]): Promise<[number, number]> {
  const usesLocationType = await client.hasMessageField('ExportSessionInfoAsTextRequestBody', 'location_type');
  const report = await requiredBody(client, CommandId.ExportSessionInfoAsText, {
    include_file_list: false,
    include_clip_list: false,
    include_markers: false,
    include_plugin_list: false,
    include_track_edls: true,
    track_list_type: usesLocationType ? 'TListType_AllTracks' : 'AllTracks',
    fade_handling_type: usesLocationType ? 'FHType_ShowCrossfades' : 'ShowCrossfades',
    output_type: usesLocationType ? 'ESIOType_String' : 'ESI_String',
    ...(usesLocationType ? { location_type: 'TLType_Samples' } : { track_offset_options: 'Samples' }),
  });
  const requested = new Set(trackNames);
  const clipBounds = new Map<string, [number, number]>();
  let track = '';
  let eventColumn = -1;
  let startColumn = -1;
  let endColumn = -1;
  const sampleColumn = (value: string) => sample(/^-?\d{1,3}(,\d{3})+$/.test(value) ? value.replace(/,/g, '') : value);
  for (const line of String(report?.session_info ?? '').split(/\r\n|\n|\r/)) {
    if (line.startsWith('TRACK NAME:')) {
      track = line.slice('TRACK NAME:'.length).trim();
      eventColumn = startColumn = endColumn = -1;
    }
    if (!requested.has(track)) continue;
    const fields = line.split('\t').map(field => field.trim());
    const header = fields.findIndex(field => /^EVENT(?:\s*#)?$/.test(field));
    if (header >= 0 && fields.includes('START TIME')) {
      eventColumn = header;
      startColumn = fields.indexOf('START TIME');
      endColumn = fields.indexOf('END TIME');
    } else if (startColumn >= 0 && endColumn >= 0 && /^\d+$/.test(fields[eventColumn])) {
      const start = sampleColumn(fields[startColumn] ?? '');
      const end = sampleColumn(fields[endColumn] ?? '');
      if (end <= start) continue;
      const [first, last] = clipBounds.get(track) ?? [start, end];
      clipBounds.set(track, [Math.min(first, start), Math.max(last, end)]);
    }
  }
  if (clipBounds.size !== requested.size) {
    throw new Error('Could not establish sample bounds for every requested track. Select a timeline range or supply sample bounds.');
  }
  const extents = [...clipBounds.values()];
  return [Math.min(...extents.map(([start]) => start)), Math.max(...extents.map(([, end]) => end))];
}

async function exportTrackStems(args: StemExportArgs, client: PTSLClient) {
  const { mode = 'both', fader = 'unity', offline = false, fx_returns = [] } = args;
  if (args.buses !== undefined || args.directory !== undefined) throw new Error('Track exports use the session Bounced Files folder.');
  if (mode !== 'dry' && mode !== 'wet' && mode !== 'both') throw new Error('mode must be dry, wet, or both.');
  if (fader !== 'unity' && fader !== 'current') throw new Error('fader must be unity or current.');
  if (typeof offline !== 'boolean') throw new Error('offline must be a boolean.');
  if (!Array.isArray(args.tracks) || !args.tracks.length) throw new Error('Provide at least one track.');
  if (!Array.isArray(fx_returns)) throw new Error('fx_returns must contain track names or objects.');
  if (mode === 'dry' && fx_returns.length) throw new Error('FX returns require a wet export.');
  const tracks = args.tracks.map(readTrackStem);
  const returns = fx_returns.map(readTrackStem);
  const names = [...tracks, ...returns].map(track => track.name.normalize().toLowerCase());
  if (new Set(names).size !== names.length) throw new Error('Track and FX return filenames must be distinct.');
  if ((args.start_sample === undefined) !== (args.end_sample === undefined)) throw new Error('Supply both start_sample and end_sample.');
  const includesDry = mode !== 'wet';
  const includesWet = mode !== 'dry';
  const trackBuses = [...tracks, ...returns].map(spec => spec.wet_bus?.[fader]);
  const legacyWet = includesWet && trackBuses.some(Boolean);
  if (legacyWet && (trackBuses.some(bus => !bus) || new Set(trackBuses.map(bus => bus?.normalize().toLowerCase())).size !== trackBuses.length)) {
    throw new Error('Supply a distinct ' + fader + ' wet_bus for every wet track and return.');
  }
  const dryCurrent = includesDry && fader === 'current';
  const dryBuses = tracks.map(spec => spec.dry_current_bus);
  const legacyDry = dryCurrent && dryBuses.some(Boolean);
  if (legacyDry && (dryBuses.some(bus => !bus) ||
      new Set(dryBuses.map(bus => bus?.normalize().toLowerCase())).size !== dryBuses.length)) {
    throw new Error('Supply a distinct dry_current_bus for every dry/current track.');
  }
  const nativeWet = includesWet && !legacyWet;
  const nativeDry = dryCurrent && !legacyDry;
  const nativeBounce = nativeWet || nativeDry;
  const permissions = [PermissionGroup.EXPORT];
  if (includesDry) permissions.push(PermissionGroup.SESSION);
  if (includesDry || legacyWet) permissions.push(PermissionGroup.PRINT);
  if (!permissions.every(group => client.isPermissionGroupAllowed(group))) {
    throw new Error('Track stem export requires ALLOW_WRITES=' + permissions.join(','));
  }

  const presetVariable = fader === 'current' ? 'PTSL_STEM_WET_CURRENT_PRESET' : 'PTSL_STEM_WET_UNITY_PRESET';
  let preset: string | undefined;
  if (nativeBounce) {
    if (!await client.hasCommand('BounceTrack')) {
      const fallback = [
        nativeDry && 'Supply dry_current_bus for every dry/current track with a matching dry import preset.',
        nativeWet && 'Supply wet_bus for every wet track and return.',
      ].filter(Boolean).join(' ');
      throw new Error('Native track rendering requires BounceTrack and a matching Pro Tools SDK (2025.06 or newer). ' + fallback);
    }
    preset = process.env[presetVariable] || loadConfig().stemPresets?.[fader];
    if (!preset || !path.isAbsolute(preset) || !(await stat(preset).catch(() => undefined))?.isFile()) {
      throw new Error('Configure an absolute Track Bounce preset with --' + fader + '-preset or ' + presetVariable + '.');
    }
  }

  if (dryCurrent) await dryImportPreset();

  return withSessionState(client, async () => {
    const sourceFile = (await requiredBody(client, CommandId.GetSessionPath))?.session_path?.path;
    if (typeof sourceFile !== 'string' || !path.isAbsolute(sourceFile) || !/\.ptx$/i.test(sourceFile)) {
      throw new Error('Open a saved local Pro Tools session.');
    }
    const session = await realpath(sourceFile);
    const trackList = await readSessionTracks(client);
    const resolveTrack = (spec: TrackStem, isReturn: boolean) => {
      const matching = trackList.filter(track => track.name === spec.name);
      if (matching.length !== 1) throw new Error('Expected one track named ' + spec.name);
      const [track] = matching;
      const audio = /^(?:AudioTrack|(?:TT|TType)_Audio)$/.test(track.type);
      const aux = /^(?:Aux|(?:TT|TType)_Aux)$/.test(track.type);
      const instrument = /^(?:Instrument|(?:TT|TType)_Instrument)$/.test(track.type);
      const format = /^(?:TF|TFormat)_(Mono|Stereo)$/.exec(track.format);
      if ((isReturn ? !aux : !(audio || !includesDry && instrument)) || !format || (nativeWet || nativeDry && !isReturn) && !track.id) {
        throw new Error('Unsupported track type, format or ID: ' + spec.name);
      }
      return { ...spec, id: track.id, channels: format[1] === 'Mono' ? 1 : 2 };
    };
    const audioTracks = tracks.map(track => resolveTrack(track, false));
    const fxTracks = returns.map(track => resolveTrack(track, true));
    const sessionRate = (await requiredBody(client, CommandId.GetSessionSampleRate))?.sample_rate;
    const rate = Number(/^(?:SR_|SRate_)(\d+)$/.exec(String(sessionRate))?.[1]);
    if (!rate) throw new Error('Unrecognized session sample rate: ' + String(sessionRate));
    const selection = args.start_sample === undefined
      ? await requiredBody(client, CommandId.GetTimelineSelection, await sampleSelectionUnits(client))
      : { in_time: args.start_sample, out_time: args.end_sample };
    let start = sample(selection?.in_time);
    let end = sample(selection?.out_time);
    if (start === end && args.start_sample === undefined) {
      [start, end] = await getClipExtent(client, tracks.map(track => track.name));
    }
    if (end <= start || !Number.isSafeInteger(end - start)) throw new Error('Select a nonempty timeline range before exporting stems.');
    const expected = (end - start) * 48000 / rate;
    const explicitBusBounds = (legacyWet || legacyDry) && await supportsExportMixBounds(client);
    const bounds = explicitBusBounds ? { start: String(start), end: String(end) } : undefined;

    const sessionDir = path.dirname(session);
    const parent = path.join(sessionDir, 'Bounced Files');
    await mkdir(parent, { recursive: true });
    if (await realpath(parent) !== parent) throw new Error('Bounced Files must be inside the session directory.');
    const stage = await mkdtemp(path.join(parent, '.stems-in-progress-'));
    const bounced: Array<{name: string; channels: number; frames: number; mode: 'Dry' | 'Wet'; fxReturn: boolean}> = [];
    let keepWork = false;
    const bounce = async (group: 'Dry' | 'Wet', id: string, name: string, channels: number, fxReturn: boolean, bus?: string) => {
      const destination = await mkdtemp(path.join(stage, '.bounce-'));
      const method = bus ? 'ExportMix' : 'Track Bounce';
      const location = (value: number) => ({ location: String(value), time_type: 'TLType_Samples' });
      try {
        const response = bus ? undefined : await requiredBody(client, CommandId.BounceTrack, {
          preset_path: preset,
          file_name_prefix: 'Stem',
          src_track_id: id,
          in_location: location(start),
          out_location: location(end),
          file_type: 'EMFType_WAV',
          offline_bounce: offline ? 'TB_True' : 'TB_False',
          location_info: { file_destination: 'EM_FD_Directory', directory: destination + path.sep, import_after_bounce: 'TB_False' },
        });
        const file = bus ? await exportLegacyBusPrint(client, { bus, directory: destination, offline, bounds })
          : Array.isArray(response?.file_paths) && response.file_paths.length === 1 ? response.file_paths[0] : undefined;
        if (typeof file !== 'string' || !path.isAbsolute(file) ||
            path.dirname(await realpath(file)) !== await realpath(destination) || !(await lstat(file)).isFile()) {
          throw new Error(method + ' did not produce exactly one WAV in its output directory for ' + name);
        }
        const wav = await readWav(file);
        checkStemLength(wav.frames, expected);
        if (wav.channels > 2) throw new Error(method + ' produced more than two channels on ' + name);
        const output = path.join(stage, group, name + '.wav');
        if (wav.channels === channels) await rename(wav.file, output);
        else {
          if (group === 'Wet' && channels === 2) {
            const source = bus ? 'Use a stereo wet bus.' : 'Use a Track Bounce preset and routing that render the stereo signal.';
            throw new Error('Pro Tools bounced ' + name + ' as mono. ' + source);
          }
          await writeStemWav(wav, output, channels);
        }
        bounced.push({ name, channels, frames: wav.frames, mode: group, fxReturn });
      } finally {
        await rm(destination, { recursive: true, force: true });
      }
    };

    try {
      if (includesWet) {
        await mkdir(path.join(stage, 'Wet'));
        const bounceWet = async () => {
          for (const track of [...audioTracks, ...fxTracks]) {
            const active = await requiredBody(client, CommandId.GetSessionPath);
            if (await realpath(active?.session_path?.path) !== session) throw new Error('Active session changed during stem export.');
            await bounce('Wet', track.id, track.name, track.wet_channels ?? track.channels, fxTracks.includes(track),
              track.wet_bus?.[fader]);
          }
        };
        if (legacyWet) await withTimelineRange(client, String(start), String(end), bounceWet);
        else await bounceWet();
      }
      if (dryCurrent) {
        await mkdir(path.join(stage, 'Dry'));
        const work = path.join(stage, 'Work');
        keepWork = true;
        await withDryCurrentTracks(client, tracks.map(track => track.name), work, async imported => {
          const activeSession = async () => realpath((await requiredBody(client, CommandId.GetSessionPath))?.session_path?.path);
          const copy = await activeSession();
          if (!copy.startsWith(work + path.sep)) throw new Error('Print working copy is not active.');
          const bounceDry = async () => {
            for (const track of audioTracks) {
              if (await activeSession() !== copy) throw new Error('Active session changed during dry/current stem export.');
              const matches = imported.filter(candidate => candidate.name === track.name);
              if (matches.length !== 1 || !matches[0].id) throw new Error('Could not identify dry print track ' + track.name);
              await bounce('Dry', matches[0].id, track.name, track.dry_channels ?? track.channels, false, track.dry_current_bus);
            }
          };
          if (legacyDry) await withTimelineRange(client, String(start), String(end), bounceDry);
          else await bounceDry();
        }, { deactivateSourceTracks: legacyDry });
        keepWork = false;
      }
      if (includesDry && fader === 'unity') {
        keepWork = true;
        const printed = await printDryTracks(client, tracks.map(track => track.name), {
          range: [start, end], runDir: stage,
          channels: new Map(audioTracks.map(track => [track.name, track.dry_channels ?? track.channels])),
        });
        keepWork = false;
        bounced.push(...printed.files.map(file => ({ ...file, mode: 'Dry' as const, fxReturn: false })));
      }
      if (bounced.some(file => file.frames !== bounced[0].frames)) throw new Error('The WAVs are not sample aligned.');
      const delivery = path.join(stage, 'Delivery');
      await mkdir(delivery);
      if (includesDry) await rename(path.join(stage, 'Dry'), path.join(delivery, 'Dry'));
      if (includesWet) await rename(path.join(stage, 'Wet'), path.join(delivery, 'Wet'));
      const folder = path.join(parent, 'Stems-' + randomUUID());
      await rename(delivery, folder);
      return { content: [{ type: 'text', text: JSON.stringify({
        folder, start, end, sessionSampleRate: rate, sampleRate: 48000, bitDepth: 24, fader,
        files: bounced.map(file => ({ ...file, file: path.join(folder, file.mode, file.name + '.wav') })),
      }) }] };
    } catch (error) {
      if (keepWork) {
        const active = await requiredBody(client, CommandId.GetSessionPath)
          .then(body => realpath(body.session_path.path)).catch(() => undefined);
        if (active === session) keepWork = false;
      }
      if (keepWork) throw new Error(String(error) + ' (working files retained in ' + stage + ')');
      throw error;
    } finally {
      if (!keepWork) await rm(stage, { recursive: true, force: true });
      else {
        for (const name of ['Dry', 'Wet', 'In Progress']) await rm(path.join(stage, name), { recursive: true, force: true });
      }
    }
  });
}
