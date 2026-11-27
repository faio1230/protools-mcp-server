import { mkdtemp, open, readdir } from 'node:fs/promises';
import path from 'node:path';
import type { PTSLClient } from '../grpc/client.js';
import { CommandId, PermissionGroup } from '../grpc/commands.js';

export const stemTool = {
  name: 'export_stems',
  description: 'Bounce named session buses over the current nonempty selection to separate 48 kHz / 24-bit WAVs. Supply an existing absolute destination directory. Creates a unique subfolder and returns file paths, channel counts and sample lengths. Requires ALLOW_WRITES=export.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      buses: { type: 'array', minItems: 1, uniqueItems: true, items: { type: 'string', minLength: 1 } },
      directory: { type: 'string', description: 'Existing parent directory on the Pro Tools computer.' },
      offline: { type: 'boolean', description: 'Defaults to false. Enable for sessions that support offline bounce.' },
    },
    required: ['buses', 'directory'],
    additionalProperties: false,
  },
};

async function readWav(file: string) {
  const handle = await open(file, 'r');
  try {
    const size = (await handle.stat()).size;
    async function read(offset: number, length: number) {
      const bytes = Buffer.alloc(length);
      if ((await handle.read(bytes, 0, length, offset)).bytesRead !== length) throw new Error('Truncated WAV header');
      return bytes;
    }
    const header = await read(0, 12);
    if (header.toString('ascii', 0, 4) !== 'RIFF' || header.toString('ascii', 8) !== 'WAVE') {
      throw new Error('Expected a RIFF/WAVE file: ' + file);
    }
    let channels = 0;
    let alignment = 0;
    let dataBytes = 0;
    for (let offset = 12; offset + 8 <= size;) {
      const chunk = await read(offset, 8);
      const id = chunk.toString('ascii', 0, 4);
      const length = chunk.readUInt32LE(4);
      offset += 8;
      if (offset + length > size) throw new Error('Truncated WAV chunk: ' + file);
      if (id === 'fmt ') {
        if (length < 16) throw new Error('Invalid WAV format chunk');
        const fmt = await read(offset, Math.min(length, 40));
        const tag = fmt.readUInt16LE(0);
        const pcm = tag === 1 || (tag === 0xfffe && fmt.length >= 40 &&
          fmt.subarray(24, 40).toString('hex') === '0100000000001000800000aa00389b71');
        channels = fmt.readUInt16LE(2);
        alignment = fmt.readUInt16LE(12);
        if (!pcm || !channels || alignment !== channels * 3 || fmt.readUInt32LE(4) !== 48000 || fmt.readUInt16LE(14) !== 24) {
          throw new Error('Expected 48 kHz, 24-bit PCM: ' + file);
        }
      } else if (id === 'data') {
        dataBytes = length;
      }
      offset += length + (length % 2);
    }
    if (!dataBytes || !alignment || dataBytes % alignment) throw new Error('Invalid WAV data: ' + file);
    return { file, channels, frames: dataBytes / alignment };
  } finally {
    await handle.close();
  }
}

export async function exportStems(args: { buses?: unknown; directory?: unknown; offline?: unknown }, client: PTSLClient) {
  if (!client.isPermissionGroupAllowed(PermissionGroup.EXPORT)) throw new Error('Set ALLOW_WRITES=export to export stems.');
  const { buses, directory, offline = false } = args;
  if (!Array.isArray(buses) || !buses.length || buses.some(bus => typeof bus !== 'string' || !bus.trim()) ||
      new Set(buses).size !== buses.length) throw new Error('Provide one or more distinct bus names.');
  if (typeof directory !== 'string' || !path.isAbsolute(directory)) throw new Error('An absolute output directory is required.');
  if (typeof offline !== 'boolean') throw new Error('offline must be a boolean.');

  async function request(id: CommandId, body: object = {}) {
    const response = await client.sendRequest(id, body);
    if (!['Completed', 'TStatus_Completed'].includes(response.header?.status)) {
      throw new Error(response.response_error_json || 'PTSL command did not complete: ' + id);
    }
    return response.response_body;
  }

  const rate = (await request(CommandId.GetSessionSampleRate))?.sample_rate;
  const rateMatch = /^(?:SR_|SRate_)(\d+)$/.exec(String(rate));
  if (!rateMatch || !Number(rateMatch[1])) throw new Error('Unrecognized session sample rate: ' + rate);
  const selection = await request(CommandId.GetTimelineSelection, { time_scale: 'Samples' });
  const start = selection?.in_time;
  const end = selection?.out_time;
  if (!/^-?\d+$/.test(start) || !/^-?\d+$/.test(end) || Number(end) <= Number(start)) {
    throw new Error('Select a nonempty timeline range before bouncing.');
  }
  const expectedFrames = (Number(end) - Number(start)) * 48000 / Number(rateMatch[1]);
  const folder = await mkdtemp(path.join(directory, 'stems-'));
  try {
    await request(CommandId.ExportMix, {
      file_name: 'Stem', file_type: 'EM_WAV',
      mix_source_list: buses.map(name => ({ source_type: 'Bus', name })),
      audio_info: {
        compression_type: 'CT_PCM', export_format: 'EF_Interleaved', bit_depth: 'Bit24', sample_rate: 'SR_48000',
        delivery_format: 'EM_DF_FilePerMixSource', pad_to_frame_boundary: 'TB_False',
      },
      location_info: { file_destination: 'EM_FD_Directory', directory: folder, import_after_bounce: 'TB_False' },
      offline_bounce: offline ? 'TB_True' : 'TB_False',
    });
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
