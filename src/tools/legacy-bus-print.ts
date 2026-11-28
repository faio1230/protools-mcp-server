import { readdir } from 'node:fs/promises';
import path from 'node:path';
import type { PTSLClient } from '../grpc/client.js';
import { CommandId } from '../grpc/commands.js';
import { sendCompleted } from './mixer-state.js';

export interface ExportMixBounds {
  start: string;
  end: string;
}

export async function supportsExportMixBounds(client: PTSLClient): Promise<boolean> {
  return !!(await client.hasMessageField?.('ExportMixRequestBody', 'start_time') &&
    await client.hasMessageField('ExportMixRequestBody', 'end_time'));
}

export async function exportMixBuses(
  client: PTSLClient,
  buses: string[],
  directory: string,
  offline: boolean,
  bounds?: ExportMixBounds,
): Promise<void> {
  const location = (value: string) => ({ location: value, time_type: 'TLType_Samples' });
  await sendCompleted(client, CommandId.ExportMix, {
    file_name: 'Stem',
    file_type: 'EM_WAV',
    mix_source_list: buses.map(name => ({ source_type: 'Bus', name })),
    audio_info: {
      compression_type: 'CT_PCM',
      export_format: 'EF_Interleaved',
      bit_depth: 'Bit24',
      sample_rate: 'SR_48000',
      delivery_format: 'EM_DF_FilePerMixSource',
      pad_to_frame_boundary: 'TB_False',
    },
    location_info: {
      file_destination: 'EM_FD_Directory',
      directory: directory + path.sep,
      import_after_bounce: 'TB_False',
    },
    offline_bounce: offline ? 'TB_True' : 'TB_False',
    ...(bounds ? { start_time: location(bounds.start), end_time: location(bounds.end) } : {}),
  });
}

/** Render the caller's isolated bus into an empty staging directory. */
export async function exportLegacyBusPrint(
  client: PTSLClient,
  { bus, directory, offline, bounds }: { bus: string; directory: string; offline: boolean; bounds?: ExportMixBounds },
): Promise<string> {
  await exportMixBuses(client, [bus], directory, offline, bounds);
  const files = (await readdir(directory, { withFileTypes: true }))
    .filter(entry => entry.isFile() && /\.wav$/i.test(entry.name));
  if (files.length !== 1) {
    throw new Error(`ExportMix produced ${files.length} WAV files for bus "${bus}". Expected one.`);
  }
  return path.join(directory, files[0].name);
}
