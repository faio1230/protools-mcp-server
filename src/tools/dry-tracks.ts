import { mkdir, mkdtemp, readdir, realpath, rename } from 'node:fs/promises';
import path from 'node:path';
import type { PTSLClient } from '../grpc/client.js';
import { CommandId as C, PermissionGroup as P } from '../grpc/commands.js';
import { readSessionTracks } from './tracks.js';
import { readWav, writeStemWav } from './stem-wav.js';
import { captureSessionSelection, withSessionState } from './mixer-state.js';
import { assertPrintCopy, restorePrintSource } from './print-session.js';

export const dryTool = {
  name: 'export_dry_tracks',
  description: 'Print active audio playlists pre-insert and pre-fader at unity. Specify track names from get_track_list. Automatically saves a working session copy, consolidates clips there, and writes aligned 48 kHz/24-bit mono or stereo WAVs in Bounced Files beside the source session. Leaves the print copy open.',
  inputSchema: {
    type: 'object' as const,
    properties: { tracks: { type: 'array', minItems: 1, uniqueItems: true, items: { type: 'string' } } },
    required: ['tracks'], additionalProperties: false,
  },
};

let printing = false;
interface DryPrintOptions {
  range: [number, number];
  runDir: string;
  channels: ReadonlyMap<string, number>;
}

export async function exportDryTracks(client: PTSLClient, names: unknown) {
  const result = await withSessionState(client, () => printDryTracks(client, names));
  return { content: [{ type: 'text', text: JSON.stringify(result) }] };
}

export async function printDryTracks(client: PTSLClient, names: unknown, options?: DryPrintOptions) {
  if (printing) throw new Error('A dry export is already in progress.');
  if (![P.EXPORT, P.SESSION, P.PRINT].every(p => client.isPermissionGroupAllowed(p))) throw new Error('Dry export requires export,session,print permissions.');
  if (!Array.isArray(names) || !names.length || names.some(n => typeof n !== 'string' || !n.trim() || /[\/\\:\x00-\x1f]/u.test(n)) ||
      new Set(names.map(n => n.normalize().toLowerCase())).size !== names.length) throw new Error('Supply distinct audio track names suitable for WAV filenames.');

  const request = async (id: C, body: object = {}) => {
    const r = await client.sendRequest(id, body);
    if (!['Completed','TStatus_Completed'].includes(r.header?.status)) throw new Error(r.response_error_json || 'PTSL failed: ' + C[id]);
    return r.response_body;
  };
  const currentSession = async () => realpath((await request(C.GetSessionPath)).session_path.path);
  const getRange = async () => {
    const r = await request(C.GetTimelineSelection, { time_scale: 'Samples' });
    if (!/^-?\d+$/.test(r?.in_time) || !/^-?\d+$/.test(r?.out_time) || Number(r.out_time) <= Number(r.in_time)) throw new Error('Could not establish a nonempty clip range.');
    return [Number(r.in_time), Number(r.out_time)];
  };
  let runDir = '';
  let copy: { work: string; name: string } | undefined;
  let selection: Awaited<ReturnType<typeof captureSessionSelection>> | undefined;
  let failure: unknown;
  printing = true;
  try {
    const session = await currentSession();
    const trackList = await readSessionTracks(client);
    const tracks = names.map(name => {
      const matches = trackList.filter(t => t.name === name);
      if (matches.length !== 1) throw new Error('Expected one track named ' + name + ' in ' + path.basename(session) +
        '; found ' + matches.length + '. Available tracks: ' + trackList.map(t => t.name).join(', '));
      const t = matches[0];
      if (!['TT_Audio','AudioTrack','TType_Audio'].includes(t.type) || !/^(?:TF|TFormat)_(?:Mono|Stereo)$/.test(t.format)) {
        throw new Error('Unsupported track ' + name + ': ' + t.type + ', ' + t.format);
      }
      const frozen = t.track_attributes?.is_frozen === true;
      if (!frozen && !t.track_attributes?.contains_clips) throw new Error('Active playlist contains no clips: ' + name);
      return { name, channels: t.format.endsWith('_Mono') ? 1 : 2, frozen };
    });
    const r = String((await request(C.GetSessionSampleRate)).sample_rate);
    const rate = Number(/^(?:SR_|SRate_)(\d+)$/.exec(r)?.[1]);
    if (!rate) throw new Error('Unrecognized session rate: ' + r);
    const parent = path.join(path.dirname(session), 'Bounced Files');
    await mkdir(parent, { recursive: true });
    runDir = options?.runDir ?? await mkdtemp(path.join(parent, 'Dry-'));
    const work = path.join(runDir, 'Work');
    await mkdir(work);
    const copyName = 'Print-' + path.basename(runDir);
    if (options) {
      selection = await captureSessionSelection(client);
      if (selection.sessionPath !== session) throw new Error('Active session changed before export.');
      await request(C.SaveSession);
    }
    copy = { work, name: copyName };
    await request(C.SaveSessionAs, { session_name: copyName, session_location: work + path.sep });
    const assertCopy = () => assertPrintCopy(client, work, copyName);
    await assertCopy();
    const frozen = tracks.filter(t => t.frozen).map(t => t.name);
    if (frozen.length) {
      await request(C.SetTrackFrozenState, { track_names: frozen, enabled: false });
      const thawed = await readSessionTracks(client);
      for (const name of frozen) {
        const t = thawed.find(track => track.name === name);
        if (t?.track_attributes?.is_frozen || !t?.track_attributes?.contains_clips) {
          throw new Error('Could not access original playlist in the print copy: ' + name);
        }
      }
    }
    const editOptions = (await request(C.GetEditModeOptions)).edit_mode_options;
    const counter = (await request(C.GetMainCounterFormat)).current_setting;
    if (!editOptions || !counter) throw new Error('Could not read selection settings.');
    const selectOne = async (name: string) => {
      const result = await request(C.SelectTracksByName, { track_names: [name], selection_mode: 'SM_Replace' });
      if (result?.track_list?.length !== 1 || result.track_list[0].name !== name) throw new Error('Could not isolate track: ' + name);
    };
    const prints = [];
    try {
      await request(C.SetEditModeOptions, { edit_mode_options: { ...editOptions, link_track_and_edit_selection: true, link_timeline_and_edit_selection: true } });
      await request(C.SetMainCounterFormat, { time_scale: 'Samples' });
      let [start, end] = options?.range ?? [Infinity, -Infinity];
      if (!options) {
        for (const track of tracks) {
          await selectOne(track.name);
          await request(C.SelectAllClipsOnTrack, { track_name: track.name });
          const [a,b] = await getRange();
          start = Math.min(start,a); end = Math.max(end,b);
        }
      }
      const frames = (end - start) * 48000 / rate;
      const stage = path.join(runDir,'In Progress');
      await mkdir(stage);
      for (const [i, track] of tracks.entries()) {
        await assertCopy();
        await selectOne(track.name);
        await request(C.SetTimelineSelection, { in_time: String(start), out_time: String(end) });
        const [a,b] = await getRange();
        if (a !== start || b !== end) throw new Error('Unexpected selection on ' + track.name);
        await request(C.ConsolidateClip);
        const dest = path.join(work, String(i + 1));
        await mkdir(dest);
        await request(C.ExportClipsAsFiles, { file_path: dest + path.sep, format: track.channels === 1 ? 'EF_Mono' : 'EF_Interleaved', file_type: 'WAV', bit_depth: 'Bit24', sample_rate_custom: 48000, duplicate_names: 'AutoRenaming' });
        const files = (await readdir(dest)).filter(n => !n.startsWith('.') && /\.wav$/i.test(n));
        if (files.length !== 1) throw new Error('Expected one exported clip on ' + track.name);
        const wav = await readWav(path.join(dest,files[0]));
        if (wav.channels !== track.channels || wav.frames < Math.floor(frames) || wav.frames > Math.ceil(frames) || (prints.length && prints[0].frames !== wav.frames)) throw new Error('Unexpected channel count or duration on ' + track.name);
        const channels = options?.channels.get(track.name) ?? track.channels;
        const file = path.join(stage, track.name + '.wav');
        if (channels === wav.channels) await rename(wav.file, file);
        else await writeStemWav(wav, file, channels);
        prints.push({ name: track.name, channels, frames: wav.frames });
      }
      const folder = path.join(runDir, options ? 'Dry' : 'WAV');
      await rename(stage,folder);
      return { folder, start, end, files: prints, workingCopy: await currentSession() };
    } finally {
      await assertCopy();
      try { await request(C.SetMainCounterFormat,{ time_scale: counter }); }
      finally { await request(C.SetEditModeOptions,{ edit_mode_options: editOptions }); }
    }
  } catch (error) {
    failure = error;
    throw new Error((error instanceof Error ? error.message : String(error)) + (!options && runDir ? ' (run folder: ' + runDir + ')' : ''));
  } finally {
    try {
      if (selection && copy) await restorePrintSource(client, selection, copy.work, copy.name);
    } catch (restoreError) {
      throw new Error([failure && String(failure), 'Could not reopen the original session: ' + String(restoreError)]
        .filter(Boolean).join('\n'));
    } finally {
      printing = false;
    }
  }
}
