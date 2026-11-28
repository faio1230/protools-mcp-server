import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { access, mkdir, mkdtemp, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { loadConfig } from '../config.js';
import type { PTSLClient } from '../grpc/client.js';
import { CommandId as C, PermissionGroup } from '../grpc/commands.js';
import { assertPrintCopy, restorePrintSource } from './print-session.js';
import { captureSessionSelection, sendCompleted } from './mixer-state.js';
import { readSessionTracks } from './tracks.js';

interface PrintTrack { name: string; id: string }

/** Resolve before switching sessions, so an unconfigured preset cannot interrupt the operator. */
export async function dryImportPreset(): Promise<string> {
  const preset = process.env.PTSL_STEM_DRY_IMPORT_PRESET || loadConfig().stemPresets?.dryImport;
  if (!preset || !path.isAbsolute(preset) || !(await stat(preset).catch(() => undefined))?.isFile()) {
    throw new Error('Configure a Track Data to Import preset with --dry-import-preset (clips, clip gain, volume settings and volume automation only).');
  }
  await access(preset, constants.R_OK);
  return preset;
}

/** Import fader data and playlists onto new tracks in a copy with the source tempo map. */
export async function withDryCurrentTracks<T>(
  client: PTSLClient, names: string[], workDir: string,
  bounce: (tracks: PrintTrack[]) => Promise<T>, options?: { deactivateSourceTracks: boolean }
): Promise<T> {
  if (![PermissionGroup.EXPORT, PermissionGroup.SESSION, PermissionGroup.PRINT].every(p => client.isPermissionGroupAllowed(p))) {
    throw new Error('Dry/current export requires export,session,print permissions.');
  }
  const preset = await dryImportPreset();
  const request = async (command: C, body: Record<string, unknown> = {}) =>
    (await sendCompleted(client, command, body)).response_body;
  await mkdir(workDir, { recursive: true });
  const work = await realpath(await mkdtemp(path.join(workDir, 'DryImport-')));
  const copyName = path.basename(work);
  const selection = await captureSessionSelection(client);
  await request(C.SaveSession);
  let failure: unknown;
  try {
    await request(C.SaveSessionAs, { session_name: copyName, session_location: work + path.sep });
    await assertPrintCopy(client, work, copyName);
    const existing = await readSessionTracks(client);
    const originalIds = new Set(existing.map(t => t.id));
    const renamed: string[] = [];
    // Free the requested names in the disposable copy so imported tracks are unambiguous.
    for (const name of names) {
      const matches = existing.filter(t => t.name === name);
      if (matches.length !== 1 || !matches[0].id) throw new Error('Could not identify source track ' + name);
      await assertPrintCopy(client, work, copyName);
      const newName = 'Print-' + randomUUID();
      await request(C.RenameTargetTrack, { current_name: name, new_name: newName });
      renamed.push(newName);
    }
    await assertPrintCopy(client, work, copyName);
    if (options?.deactivateSourceTracks) {
      await request(C.SetTrackInactiveState, { track_names: renamed, enabled: true });
    }
    await assertPrintCopy(client, work, copyName);
    await request(C.Import, {
      import_type: 'Session', session_path: selection.sessionPath,
      session_data: {
        audio_options: 'LinkToSourceAudio', video_options: 'LinkToSourceVideo',
        match_options: 'MT_ImportAsNewTrack', playlist_options: 'ImportReplaceExistingPlaylists',
        track_data_to_import: {
          track_data_preset_path: preset, clips_and_media: true, clip_gain: true, volume_automation: true,
        },
        timecode_mapping_units: 'MaintainRelativeTimeCodeValues',
        adjust_session_start_time_to_match_source: false,
      },
    });
    await assertPrintCopy(client, work, copyName);
    const imported = await readSessionTracks(client);
    if (options?.deactivateSourceTracks) {
      const inactiveStates = [2, 3, 4, 'SetExplicitly', 'SetImplicitly', 'SetExplicitlyAndImplicitly'];
      for (const name of renamed) {
        const silent = imported.find(t => t.name === name && originalIds.has(t.id));
        const inactive = silent?.track_attributes?.is_inactive;
        if (!inactiveStates.includes(typeof inactive === 'string' ? inactive.replace(/^TAState_/, '') : inactive)) {
          throw new Error('Could not verify that the original track is inactive in the print copy: ' + name);
        }
      }
    }
    const tracks = names.map(name => {
      const matches = imported.filter(t => t.name === name);
      const track = matches[0];
      if (matches.length !== 1 || !track?.id || originalIds.has(track.id) ||
          !['AudioTrack', 'TT_Audio', 'TType_Audio'].includes(track.type) ||
          !track.track_attributes?.contains_clips || track.track_attributes?.is_frozen) {
        throw new Error('Expected one new, unfrozen imported audio playlist for ' + name);
      }
      return { name, id: String(track.id) };
    });
    return await bounce(tracks);
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    try {
      await restorePrintSource(client, selection, work, copyName);
    } catch (error) {
      throw new Error([failure && String(failure), 'Could not restore ' + selection.sessionPath + ': ' + error].filter(Boolean).join('\n'));
    }
  }
}
