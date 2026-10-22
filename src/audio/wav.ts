/**
 * WAV (RIFF) encode and parse. Export is the ONLY way voice audio leaves the
 * device (SPEC §4, §12), and only when the user taps Export, so the encoder is
 * deliberately plain: mono, 16-bit PCM, little-endian, the 44-byte canonical
 * header. The parser exists for round-trip tests and for reading back kept
 * takes; it accepts the common PCM / float layouts, extra chunks, odd chunk
 * padding and WAVE_FORMAT_EXTENSIBLE, and mixes any channel count down to mono.
 *
 * Pure: no DOM, no Web Audio. Not a hot path (runs once per export), so it
 * allocates freely; the only large allocation is the output buffer itself.
 */

/** Size of the canonical RIFF/WAVE header written by `encodeWav`. */
export const WAV_HEADER_BYTES = 44;

const FORMAT_PCM = 1;
const FORMAT_FLOAT = 3;
const FORMAT_EXTENSIBLE = 0xfffe;

/** RIFF sizes are 32-bit: the data chunk plus the 36 header bytes after 'RIFF size' must fit. */
const MAX_DATA_BYTES = 0xffffffff - 36;

function writeAscii(view: DataView, offset: number, text: string): void {
  for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
}

function readAscii(view: DataView, offset: number, length: number): string {
  let s = '';
  for (let i = 0; i < length; i++) s += String.fromCharCode(view.getUint8(offset + i));
  return s;
}

/**
 * Float32 samples in [-1, 1] -> mono 16-bit PCM WAV. Out-of-range samples are
 * clipped and NaN becomes silence. Scaling is `x * 32767` (positive) and
 * `x * 32768` (negative), so +/-1.0 map exactly to the PCM extremes and
 * `parseWav(encodeWav(x))` returns each sample to within half an LSB.
 */
export function encodeWav(samples: Float32Array, sampleRate: number): ArrayBuffer {
  if (!Number.isFinite(sampleRate) || sampleRate < 1) {
    throw new RangeError(`encodeWav: sampleRate must be a positive number, got ${sampleRate}`);
  }
  const rate = Math.round(sampleRate);
  const n = samples.length;
  const dataBytes = n * 2;
  if (dataBytes > MAX_DATA_BYTES) throw new RangeError('encodeWav: audio too long for a RIFF WAV file');

  const buffer = new ArrayBuffer(WAV_HEADER_BYTES + dataBytes);
  const view = new DataView(buffer);
  writeAscii(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  writeAscii(view, 8, 'WAVE');
  writeAscii(view, 12, 'fmt ');
  view.setUint32(16, 16, true); //          fmt chunk size
  view.setUint16(20, FORMAT_PCM, true);
  view.setUint16(22, 1, true); //           mono
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true); //    byte rate
  view.setUint16(32, 2, true); //           block align
  view.setUint16(34, 16, true); //          bits per sample
  writeAscii(view, 36, 'data');
  view.setUint32(40, dataBytes, true);

  let offset = WAV_HEADER_BYTES;
  for (let i = 0; i < n; i++) {
    let s = samples[i];
    if (s !== s) s = 0;
    else if (s > 1) s = 1;
    else if (s < -1) s = -1;
    view.setInt16(offset, Math.round(s < 0 ? s * 32768 : s * 32767), true);
    offset += 2;
  }
  return buffer;
}

/** `encodeWav` wrapped for a download / share link (`audio/wav`). */
export function wavToBlob(samples: Float32Array, sampleRate: number): Blob {
  return new Blob([encodeWav(samples, sampleRate)], { type: 'audio/wav' });
}

export interface ParsedWav {
  sampleRate: number;
  /** Channel count in the file; `samples` is always the mono mixdown. */
  channels: number;
  bitsPerSample: number;
  format: 'pcm' | 'float';
  /** Sample frames (one per channel-set). */
  frames: number;
  /** Mono mixdown (mean of the channels), nominally in [-1, 1]. */
  samples: Float32Array;
}

interface FmtChunk {
  format: number;
  channels: number;
  sampleRate: number;
  blockAlign: number;
  bitsPerSample: number;
}

/**
 * Parse a RIFF/WAVE file: PCM 8/16/24/32-bit or IEEE float 32/64-bit, any
 * channel count (mixed down to mono). Tolerates unknown chunks, odd-size
 * padding, WAVE_FORMAT_EXTENSIBLE, and a `data` size that overruns the file
 * (streaming writers). Throws `Error` for anything that is not a usable WAV.
 */
export function parseWav(data: ArrayBuffer | ArrayBufferView): ParsedWav {
  // isView, not instanceof ArrayBuffer: a buffer handed over from a worker or another realm fails the latter.
  const view = ArrayBuffer.isView(data) ? new DataView(data.buffer, data.byteOffset, data.byteLength) : new DataView(data);
  const total = view.byteLength;
  if (total < 12 || readAscii(view, 0, 4) !== 'RIFF' || readAscii(view, 8, 4) !== 'WAVE') {
    throw new Error('parseWav: not a RIFF/WAVE file');
  }

  let fmt: FmtChunk | null = null;
  let dataStart = -1;
  let dataBytes = 0;
  let pos = 12;
  while (pos + 8 <= total) {
    const id = readAscii(view, pos, 4);
    const size = view.getUint32(pos + 4, true);
    const body = pos + 8;
    if (id === 'fmt ') {
      if (size < 16 || body + 16 > total) throw new Error('parseWav: truncated fmt chunk');
      let format = view.getUint16(body, true);
      if (format === FORMAT_EXTENSIBLE && size >= 26 && body + 26 <= total) {
        format = view.getUint16(body + 24, true); // first two bytes of the SubFormat GUID
      }
      fmt = {
        format,
        channels: view.getUint16(body + 2, true),
        sampleRate: view.getUint32(body + 4, true),
        blockAlign: view.getUint16(body + 12, true),
        bitsPerSample: view.getUint16(body + 14, true),
      };
    } else if (id === 'data') {
      dataStart = body;
      dataBytes = Math.min(size, total - body);
      if (fmt) break; // fmt precedes data in every real file; stop walking
    }
    pos = body + size + (size & 1);
  }

  if (!fmt) throw new Error('parseWav: missing fmt chunk');
  if (dataStart < 0) throw new Error('parseWav: missing data chunk');
  const { channels, bitsPerSample } = fmt;
  const isFloat = fmt.format === FORMAT_FLOAT;
  if (fmt.format !== FORMAT_PCM && !isFloat) throw new Error(`parseWav: unsupported format code ${fmt.format}`);
  if (channels < 1) throw new Error('parseWav: no channels');
  const bytesPerSample = bitsPerSample >> 3;
  const supported = isFloat ? bitsPerSample === 32 || bitsPerSample === 64 : [8, 16, 24, 32].includes(bitsPerSample);
  if (!supported) throw new Error(`parseWav: unsupported ${isFloat ? 'float' : 'PCM'} depth ${bitsPerSample}`);

  const stride = channels * bytesPerSample; // block align, recomputed: some writers get the header field wrong
  const frames = Math.floor(dataBytes / stride);
  const samples = new Float32Array(frames);
  let o = dataStart;
  for (let f = 0; f < frames; f++) {
    let sum = 0;
    for (let c = 0; c < channels; c++) {
      sum += readSample(view, o, bitsPerSample, isFloat);
      o += bytesPerSample;
    }
    samples[f] = channels === 1 ? sum : sum / channels;
  }
  return { sampleRate: fmt.sampleRate, channels, bitsPerSample, format: isFloat ? 'float' : 'pcm', frames, samples };
}

function readSample(view: DataView, offset: number, bits: number, isFloat: boolean): number {
  if (isFloat) return bits === 32 ? view.getFloat32(offset, true) : view.getFloat64(offset, true);
  switch (bits) {
    case 8:
      return (view.getUint8(offset) - 128) / 128;
    case 16: {
      const v = view.getInt16(offset, true);
      return v < 0 ? v / 32768 : v / 32767; // exact inverse of encodeWav
    }
    case 24: {
      let v = view.getUint8(offset) | (view.getUint8(offset + 1) << 8) | (view.getUint8(offset + 2) << 16);
      if (v & 0x800000) v -= 0x1000000;
      return v < 0 ? v / 8388608 : v / 8388607;
    }
    default: {
      const v = view.getInt32(offset, true);
      return v < 0 ? v / 2147483648 : v / 2147483647;
    }
  }
}
