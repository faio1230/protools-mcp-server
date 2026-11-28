import { PTSLClient } from '../grpc/client.js';
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { CommandId, PermissionGroup } from '../grpc/commands.js';
import { readSessionTracks } from './tracks.js';

export interface SessionTrack {
  id: string;
  name: string;
  type: string;
  format?: string;
  track_attributes?: {
    is_muted?: boolean;
    is_soloed?: boolean;
    is_soloed_safe?: boolean;
    is_selected?: string | number;
  };
}

export async function sendCompleted(
  client: PTSLClient,
  command: CommandId,
  body: Record<string, unknown> = {},
  operation: string = CommandId[command]
): Promise<any> {
  const response = await client.sendRequest(command, body);
  const status = response?.header?.status;
  if (status !== 'Completed' && status !== 'TStatus_Completed' && status !== 3) {
    const detail = response?.response_error_json || status || 'missing command status';
    throw new Error(`${operation} failed: ${detail}`);
  }
  return response;
}

export async function getSessionTracks(client: PTSLClient): Promise<SessionTrack[]> {
  return readSessionTracks(client);
}

type StateChange = () => Promise<unknown>;
interface SessionState {
  apply(change: StateChange, restore: StateChange): Promise<void>;
  setTimelineRange(start: string, end: string, locationType?: string): Promise<void>;
  soloTrack(tracks: SessionTrack[], target: SessionTrack): Promise<void>;
}

const sessionLocks = new WeakMap<PTSLClient, Promise<void>>();

const sampleLocation = 'TLType_Samples';
const timeFields = ['in_time', 'out_time', 'play_start_marker_time', 'pre_roll_start_time', 'post_roll_stop_time'] as const;
const rollFields = ['pre_roll_enabled', 'post_roll_enabled'] as const;

interface TimelineSnapshot {
  selection: Record<string, unknown>;
  getUnits: Record<string, string>;
  setLocationType: boolean;
}

export interface SessionSelectionSnapshot extends TimelineSnapshot {
  sessionPath: string;
  selectedTracks: string[];
}

async function captureTimeline(client: PTSLClient): Promise<TimelineSnapshot> {
  const [getLocationType, setLocationType] = await Promise.all([
    client.hasMessageField('GetTimelineSelectionRequestBody', 'location_type'),
    client.hasMessageField('SetTimelineSelectionRequestBody', 'location_type'),
  ]);
  const getUnits: Record<string, string> = getLocationType ? { location_type: sampleLocation } : { time_scale: 'Samples' };
  const { response_body: selection } = await sendCompleted(client, CommandId.GetTimelineSelection, getUnits);
  if (!/^-?\d+$/.test(selection?.in_time ?? '') || !/^-?\d+$/.test(selection?.out_time ?? '')) {
    throw new Error('Could not capture the Pro Tools timeline selection in samples');
  }
  return { selection, getUnits, setLocationType };
}

async function getMainCounter(client: PTSLClient): Promise<string> {
  const { response_body: body } = await sendCompleted(client, CommandId.GetMainCounterFormat);
  const format = String(body?.current_setting ?? body?.current_type ?? '').replace(/^(TOOptions_|TLType_)/, '');
  if (!['Samples', 'TimeCode', 'MinSecs', 'BarsBeats', 'FeetFrames'].includes(format)) {
    throw new Error('Could not determine the Pro Tools main counter format');
  }
  return format;
}

async function writeTimeline(
  client: PTSLClient, snapshot: TimelineSnapshot, values: Record<string, unknown>, locationType?: string,
  assertSession: () => Promise<void> = async () => {}
): Promise<void> {
  const command = async (body: Record<string, unknown>) => {
    await assertSession();
    await sendCompleted(client, CommandId.SetTimelineSelection, body);
  };
  if (!locationType || snapshot.setLocationType) {
    await command(locationType ? { ...values, location_type: locationType } : values);
    return;
  }

  // Legacy SetTimelineSelection interprets times in the current main counter format.
  const current = await getMainCounter(client);
  const requested = locationType.replace(/^TLType_/, '');
  if (current === requested) {
    await command(values);
    return;
  }
  const setCounter = async (time_scale: string) => {
    await assertSession();
    await sendCompleted(client, CommandId.SetMainCounterFormat, { time_scale });
  };
  const failures: unknown[] = [];
  try {
    await setCounter(requested);
    await command(values);
  } catch (error) {
    failures.push(error);
  } finally {
    try {
      await setCounter(current);
    } catch (error) {
      failures.push(new Error(`Could not restore main counter format: ${error}`));
    }
  }
  if (failures.length) throw new Error(failures.map(String).join('\n'));
}

async function restoreTimeline(
  client: PTSLClient, snapshot: TimelineSnapshot, assertSession?: () => Promise<void>
): Promise<void> {
  const { selection } = snapshot;
  const values: Record<string, unknown> = {};
  for (const key of timeFields) {
    if (typeof selection[key] === 'string' && selection[key] !== '') values[key] = selection[key];
  }
  for (const key of rollFields) {
    if (typeof selection[key] === 'boolean') values[key] = selection[key] ? 'TB_True' : 'TB_False';
  }
  await writeTimeline(client, snapshot, values, sampleLocation, assertSession);
  await assertSession?.();
  const { response_body: restored } = await sendCompleted(client, CommandId.GetTimelineSelection, snapshot.getUnits);
  if (Object.keys(values).some((key) => restored?.[key] !== selection[key])) {
    throw new Error('The restored timeline selection differs from the captured selection');
  }
}

async function activeSessionPath(client: PTSLClient): Promise<string> {
  const { response_body: body } = await sendCompleted(client, CommandId.GetSessionPath);
  const file = body?.session_path?.path;
  if (typeof file !== 'string' || !path.isAbsolute(file)) {
    throw new Error('Pro Tools did not report an active local session path');
  }
  return realpath(file);
}

async function assertSessionPath(client: PTSLClient, expected: string): Promise<void> {
  if (await activeSessionPath(client) !== expected) {
    throw new Error(`Active Pro Tools session differs from ${expected}`);
  }
}

async function explicitTrackSelection(client: PTSLClient): Promise<string[]> {
  const tracks = await getSessionTracks(client);
  const selected: string[] = [];
  for (const track of tracks) {
    const state = track.track_attributes?.is_selected;
    if ([2, 4, 'SetExplicitly', 'TAState_SetExplicitly', 'SetExplicitlyAndImplicitly', 'TAState_SetExplicitlyAndImplicitly'].includes(state ?? '')) {
      selected.push(track.name);
    } else if (![1, 3, 'None', 'TAState_None', 'SetImplicitly', 'TAState_SetImplicitly'].includes(state ?? '')) {
      throw new Error(`Could not capture the track selection state of "${track.name}"`);
    }
  }
  if (selected.some(name => tracks.filter(track => track.name === name).length !== 1)) {
    throw new Error('Selected track names are ambiguous');
  }
  return selected;
}

export async function captureSessionSelection(client: PTSLClient): Promise<SessionSelectionSnapshot> {
  const sessionPath = await activeSessionPath(client);
  const timeline = await captureTimeline(client);
  const selectedTracks = await explicitTrackSelection(client);
  await assertSessionPath(client, sessionPath);
  return { sessionPath, selectedTracks, ...timeline };
}

export async function restoreSessionSelection(client: PTSLClient, snapshot: SessionSelectionSnapshot): Promise<void> {
  const assertSession = () => assertSessionPath(client, snapshot.sessionPath);
  await assertSession();
  const failures: unknown[] = [];
  try {
    const sameSelection = (names: string[]) => names.length === snapshot.selectedTracks.length &&
      names.every(name => snapshot.selectedTracks.includes(name));
    const current = await explicitTrackSelection(client);
    if (!sameSelection(current)) {
      await assertSession();
      const modern = snapshot.setLocationType;
      await sendCompleted(client, CommandId.SelectTracksByName, snapshot.selectedTracks.length ? {
        track_names: snapshot.selectedTracks, selection_mode: modern ? 'SMode_Replace' : 'SM_Replace',
      } : {
        track_names: current, selection_mode: modern ? 'SMode_Subtract' : 'SM_Subtract',
      });
      if (!sameSelection(await explicitTrackSelection(client))) {
        throw new Error('The restored track selection differs from the captured selection');
      }
    }
  } catch (error) {
    failures.push(error);
  }
  try {
    await restoreTimeline(client, snapshot, assertSession);
  } catch (error) {
    failures.push(error);
  }
  if (failures.length) throw new Error(failures.map(String).join('\n'));
}

/** For operations that already hold the session lock and need a temporary sample range. */
export async function withTimelineRange<T>(
  client: PTSLClient, start: string, end: string, operation: () => Promise<T>
): Promise<T> {
  const sessionPath = await activeSessionPath(client);
  const assertSession = () => assertSessionPath(client, sessionPath);
  const snapshot = await captureTimeline(client);
  const failures: unknown[] = [];
  let result!: T;
  try {
    await writeTimeline(client, snapshot, { in_time: start, out_time: end }, sampleLocation, assertSession);
    const { response_body: current } = await sendCompleted(client, CommandId.GetTimelineSelection, snapshot.getUnits);
    if (current?.in_time !== start || current?.out_time !== end) {
      throw new Error('Pro Tools did not activate the requested sample range');
    }
    await assertSession();
    result = await operation();
  } catch (error) {
    failures.push(error);
  } finally {
    try {
      await restoreTimeline(client, snapshot, assertSession);
    } catch (error) {
      failures.push(new Error(`Could not restore Pro Tools timeline selection: ${error}`));
    }
  }
  if (failures.length) throw new Error(failures.map(String).join('\n'));
  return result;
}

/**
 * Serialize bounces within one client. Register each restoration before sending
 * its change, since a failed request can still have changed state on the host.
 */
export async function withSessionState<T>(
  client: PTSLClient,
  callback: (state: SessionState) => Promise<T>
): Promise<T> {
  const previous = sessionLocks.get(client);
  let release!: () => void;
  const lock = new Promise<void>((resolve) => { release = resolve; });
  sessionLocks.set(client, lock);
  await previous;

  const restores: StateChange[] = [];
  const state: SessionState = {
    async apply(change, restore) {
      restores.push(restore);
      await change();
    },
    async setTimelineRange(start, end, locationType) {
      const snapshot = await captureTimeline(client);
      if (!snapshot.setLocationType && !client.isPermissionGroupAllowed(PermissionGroup.PRINT)) {
        const current = await getMainCounter(client);
        if (current !== 'Samples' || (locationType && locationType !== sampleLocation)) {
          throw new Error('Exact selection restoration on this PTSL SDK requires a Samples main counter and range, or print permission.');
        }
      }
      await state.apply(
        () => writeTimeline(client, snapshot, { in_time: start, out_time: end }, locationType),
        () => restoreTimeline(client, snapshot)
      );
    },
    async soloTrack(tracks, target) {
      const snapshot = new Map(tracks.map((track) => [track.name, { ...track.track_attributes }]));
      if (snapshot.size !== tracks.length || tracks.some(({ name, track_attributes }) =>
        !name || typeof track_attributes?.is_soloed !== 'boolean' || typeof track_attributes?.is_muted !== 'boolean'
      )) {
        throw new Error('Could not capture track mute and solo states before isolating the track');
      }

      const changeTrackState = async (command: CommandId, names: string[], enabled: boolean) => {
        if (names.length) await sendCompleted(client, command, { track_names: names, enabled });
      };
      const attributes = snapshot.get(target.name);
      if (!attributes) throw new Error(`Could not capture the state of "${target.name}"`);
      const otherSolos = tracks.filter((track) => track.name !== target.name && track.track_attributes?.is_soloed);
      if (attributes.is_soloed && !attributes.is_muted && otherSolos.length === 0) return;

      await state.apply(async () => {
        await changeTrackState(CommandId.SetTrackSoloState, otherSolos.map((track) => track.name), false);
        if (attributes.is_muted) await changeTrackState(CommandId.SetTrackMuteState, [target.name], false);
        if (!attributes.is_soloed) await changeTrackState(CommandId.SetTrackSoloState, [target.name], true);
        const current = await getSessionTracks(client);
        const isolated = current.find(({ name }) => name === target.name);
        if (!isolated?.track_attributes?.is_soloed || isolated.track_attributes.is_muted ||
            current.some(({ name, track_attributes }) => name !== target.name && track_attributes?.is_soloed)) {
          throw new Error(`Could not solo "${target.name}" on its own. Check the session's solo and group settings.`);
        }
      }, async () => {
        const failures: unknown[] = [];
        let current: SessionTrack[];
        try {
          current = await getSessionTracks(client);
        } catch {
          // Even if the read fails, try to reverse the operations we issued.
          current = [
            { ...target, track_attributes: { is_soloed: true, is_muted: false } },
            ...otherSolos.map((track) => ({ ...track, track_attributes: { ...track.track_attributes, is_soloed: false } })),
          ];
        }
        for (const [key, command] of [
          ['is_soloed', CommandId.SetTrackSoloState],
          ['is_muted', CommandId.SetTrackMuteState],
        ] as const) {
          for (const enabled of [false, true]) {
            const names = current.filter(({ name, track_attributes }) =>
              snapshot.get(name)?.[key] === enabled && track_attributes?.[key] !== enabled
            ).map(({ name }) => name);
            try {
              await changeTrackState(command, names, enabled);
            } catch (error) {
              failures.push(error);
            }
          }
        }
        const restored = await getSessionTracks(client);
        const byName = new Map(restored.map(({ name, track_attributes }) => [name, track_attributes]));
        for (const [name, before] of snapshot) {
          const after = byName.get(name);
          if (before?.is_soloed !== after?.is_soloed || before?.is_muted !== after?.is_muted) {
            failures.push(new Error(`Mute or solo state differs for "${name}"`));
          }
        }
        if (failures.length) throw new Error(failures.map(String).join('\n'));
      });
    },
  };

  const errors: unknown[] = [];
  let result!: T;
  try {
    result = await callback(state);
  } catch (error) {
    errors.push(error);
  } finally {
    for (const restore of restores.reverse()) {
      try {
        await restore();
      } catch (error) {
        errors.push(new Error(`Could not restore Pro Tools session state: ${error}`));
      }
    }
    release();
    if (sessionLocks.get(client) === lock) sessionLocks.delete(client);
  }
  if (errors.length > 1) throw new Error(errors.map(String).join('\n'));
  if (errors.length === 1) throw errors[0];
  return result;
}
