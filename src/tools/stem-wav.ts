import { open } from 'node:fs/promises';

export async function readWav(file: string) {
  const { dataOffset: _dataOffset, ...wav } = await inspectWav(file);
  return wav;
}

async function inspectWav(file: string) {
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
    let dataOffset = 0;
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
        dataOffset = offset;
      }
      offset += length + (length % 2);
    }
    if (!dataBytes || !alignment || dataBytes % alignment) throw new Error('Invalid WAV data: ' + file);
    return { file, channels, frames: dataBytes / alignment, dataOffset };
  } finally {
    await handle.close();
  }
}

// Convert verified 24-bit mono/stereo using bounded chunks and preserve the exact frame count.
export async function writeStemWav(input: Awaited<ReturnType<typeof readWav>>, output: string, channels: number) {
  if (![1, 2].includes(input.channels) || ![1, 2].includes(channels) || input.channels === channels) {
    throw new Error('Expected a mono-to-stereo or stereo-to-mono conversion.');
  }
  const { dataOffset, frames } = await inspectWav(input.file);
  const dataSize = frames * channels * 3;
  const padding = dataSize % 2;
  if (dataSize + padding + 36 > 0xffffffff) throw new Error('Converted stem exceeds the RIFF WAV size limit.');
  const header = Buffer.alloc(44);
  header.write('RIFF');
  header.writeUInt32LE(dataSize + padding + 36, 4);
  header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(48000, 24);
  header.writeUInt32LE(48000 * channels * 3, 28);
  header.writeUInt16LE(channels * 3, 32);
  header.writeUInt16LE(24, 34);
  header.write('data', 36);
  header.writeUInt32LE(dataSize, 40);
  const source = await open(input.file, 'r');
  try {
    const target = await open(output, 'wx');
    try {
      await target.writeFile(header);
      const bufferFrames = 8192;
      const sourceChunk = Buffer.alloc(bufferFrames * input.channels * 3);
      const targetChunk = Buffer.alloc(bufferFrames * channels * 3);
      for (let frame = 0; frame < frames; frame += bufferFrames) {
        const count = Math.min(bufferFrames, frames - frame);
        const sourceBytes = count * input.channels * 3;
        const read = await source.read(sourceChunk, 0, sourceBytes, dataOffset + frame * input.channels * 3);
        if (read.bytesRead !== sourceBytes) throw new Error('Truncated WAV data during channel conversion.');
        for (let i = 0; i < count; i++) {
          if (input.channels === 1) {
            const value = sourceChunk.readIntLE(i * 3, 3);
            targetChunk.writeIntLE(value, i * 6, 3);
            targetChunk.writeIntLE(value, i * 6 + 3, 3);
          } else {
            const average = (sourceChunk.readIntLE(i * 6, 3) + sourceChunk.readIntLE(i * 6 + 3, 3)) / 2;
            targetChunk.writeIntLE(Math.round(average), i * 3, 3);
          }
        }
        await target.writeFile(targetChunk.subarray(0, count * channels * 3));
      }
      if (padding) await target.writeFile(Buffer.alloc(1));
    } finally {
      await target.close();
    }
  } finally {
    await source.close();
  }
}
