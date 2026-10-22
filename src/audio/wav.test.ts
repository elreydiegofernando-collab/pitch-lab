import { describe, expect, it } from 'vitest';
import { WAV_HEADER_BYTES, encodeWav, parseWav, wavToBlob } from './wav';

const ascii = (view: DataView, offset: number, n: number): string =>
  Array.from({ length: n }, (_, i) => String.fromCharCode(view.getUint8(offset + i))).join('');

/** Hand-build a WAV so the parser is tested against layouts our encoder never writes. */
function buildWav(opts: {
  format: number;
  channels: number;
  bits: number;
  sampleRate?: number;
  data: Uint8Array;
  /** Chunks written between 'fmt ' and 'data'. */
  extra?: Array<{ id: string; body: Uint8Array }>;
  /** Overrides the declared data size (streaming writers use 0 or 0xFFFFFFFF). */
  declaredDataSize?: number;
  extensible?: boolean;
}): ArrayBuffer {
  const { format, channels, bits, data } = opts;
  const sampleRate = opts.sampleRate ?? 48000;
  const fmtSize = opts.extensible ? 40 : 16;
  const chunks: Uint8Array[] = [];
  const u32 = (v: number) => new Uint8Array(new Uint32Array([v]).buffer);
  const tag = (s: string) => new Uint8Array(Array.from(s, (c) => c.charCodeAt(0)));
  const fmt = new Uint8Array(fmtSize);
  const fv = new DataView(fmt.buffer);
  fv.setUint16(0, opts.extensible ? 0xfffe : format, true);
  fv.setUint16(2, channels, true);
  fv.setUint32(4, sampleRate, true);
  fv.setUint32(8, (sampleRate * channels * bits) / 8, true);
  fv.setUint16(12, (channels * bits) / 8, true);
  fv.setUint16(14, bits, true);
  if (opts.extensible) {
    fv.setUint16(16, 22, true); // cbSize
    fv.setUint16(18, bits, true); // valid bits
    fv.setUint32(20, 0, true); // channel mask
    fv.setUint16(24, format, true); // SubFormat GUID, first two bytes
  }
  chunks.push(tag('fmt '), u32(fmtSize), fmt);
  for (const e of opts.extra ?? []) {
    chunks.push(tag(e.id), u32(e.body.length), e.body);
    if (e.body.length & 1) chunks.push(new Uint8Array(1));
  }
  chunks.push(tag('data'), u32(opts.declaredDataSize ?? data.length), data);
  const bodyLen = 4 + chunks.reduce((n, c) => n + c.length, 0);
  const all = [tag('RIFF'), u32(bodyLen), tag('WAVE'), ...chunks];
  const out = new Uint8Array(all.reduce((n, c) => n + c.length, 0));
  let p = 0;
  for (const c of all) {
    out.set(c, p);
    p += c.length;
  }
  return out.buffer;
}

describe('encodeWav', () => {
  it('writes the canonical 44-byte mono 16-bit PCM header', () => {
    const buf = encodeWav(new Float32Array([0, 0.5, -0.5, 1, -1]), 48000);
    const v = new DataView(buf);
    expect(buf.byteLength).toBe(WAV_HEADER_BYTES + 5 * 2);
    expect(ascii(v, 0, 4)).toBe('RIFF');
    expect(v.getUint32(4, true)).toBe(buf.byteLength - 8);
    expect(ascii(v, 8, 4)).toBe('WAVE');
    expect(ascii(v, 12, 4)).toBe('fmt ');
    expect(v.getUint32(16, true)).toBe(16);
    expect(v.getUint16(20, true)).toBe(1); //        PCM
    expect(v.getUint16(22, true)).toBe(1); //        mono
    expect(v.getUint32(24, true)).toBe(48000);
    expect(v.getUint32(28, true)).toBe(96000); //    byte rate
    expect(v.getUint16(32, true)).toBe(2); //        block align
    expect(v.getUint16(34, true)).toBe(16);
    expect(ascii(v, 36, 4)).toBe('data');
    expect(v.getUint32(40, true)).toBe(10);
  });

  it('maps 0, +/-1 and mid values to the expected little-endian PCM', () => {
    const v = new DataView(encodeWav(new Float32Array([0, 1, -1, 0.5, -0.5]), 44100));
    const at = (i: number) => v.getInt16(WAV_HEADER_BYTES + i * 2, true);
    expect(at(0)).toBe(0);
    expect(at(1)).toBe(32767);
    expect(at(2)).toBe(-32768);
    expect(at(3)).toBe(Math.round(0.5 * 32767));
    expect(at(4)).toBe(-16384);
  });

  it('clips out-of-range samples and turns NaN into silence', () => {
    const v = new DataView(encodeWav(new Float32Array([2.5, -3, NaN, Infinity, -Infinity]), 48000));
    const at = (i: number) => v.getInt16(WAV_HEADER_BYTES + i * 2, true);
    expect([at(0), at(1), at(2), at(3), at(4)]).toEqual([32767, -32768, 0, 32767, -32768]);
  });

  it('encodes an empty take as a valid header-only file', () => {
    const buf = encodeWav(new Float32Array(0), 48000);
    expect(buf.byteLength).toBe(WAV_HEADER_BYTES);
    const parsed = parseWav(buf);
    expect(parsed.frames).toBe(0);
    expect(parsed.samples.length).toBe(0);
    expect(parsed.sampleRate).toBe(48000);
  });

  it('rounds a fractional sample rate and rejects nonsense', () => {
    expect(parseWav(encodeWav(new Float32Array(4), 44100.4)).sampleRate).toBe(44100);
    for (const bad of [0, -1, NaN, Infinity, 0.2]) {
      expect(() => encodeWav(new Float32Array(1), bad)).toThrow(RangeError);
    }
  });

  it('encodes a subarray view, not the whole backing buffer', () => {
    const backing = new Float32Array([0.9, 0.9, 0.1, 0.2, 0.9]);
    const buf = encodeWav(backing.subarray(2, 4), 48000);
    expect(buf.byteLength).toBe(WAV_HEADER_BYTES + 4);
    const p = parseWav(buf);
    expect(p.samples[0]).toBeCloseTo(0.1, 4);
    expect(p.samples[1]).toBeCloseTo(0.2, 4);
  });
});

describe('WAV round trip', () => {
  it('returns every sample within half an LSB, at several sample rates', () => {
    for (const rate of [8000, 22050, 44100, 48000]) {
      const n = 4000;
      const x = new Float32Array(n);
      for (let i = 0; i < n; i++) x[i] = 0.8 * Math.sin((2 * Math.PI * 440 * i) / rate) * Math.cos(i / 900);
      const p = parseWav(encodeWav(x, rate));
      expect(p.sampleRate).toBe(rate);
      expect(p.channels).toBe(1);
      expect(p.bitsPerSample).toBe(16);
      expect(p.format).toBe('pcm');
      expect(p.frames).toBe(n);
      let worst = 0;
      for (let i = 0; i < n; i++) worst = Math.max(worst, Math.abs(p.samples[i] - x[i]));
      expect(worst).toBeLessThanOrEqual(0.5 / 32767 + 1e-7);
    }
  });

  it('is an exact fixed point after one quantisation', () => {
    const x = new Float32Array(2000);
    for (let i = 0; i < x.length; i++) x[i] = Math.sin(i * 0.037) * 0.99;
    const once = parseWav(encodeWav(x, 48000)).samples;
    const twice = parseWav(encodeWav(once, 48000)).samples;
    expect(Array.from(twice)).toEqual(Array.from(once));
  });

  it('preserves +/-1.0 exactly', () => {
    const p = parseWav(encodeWav(new Float32Array([1, -1, 0]), 48000));
    expect(Array.from(p.samples)).toEqual([1, -1, 0]);
  });

  it('accepts a Uint8Array view with a byte offset', () => {
    const wav = new Uint8Array(encodeWav(new Float32Array([0.25, -0.25]), 48000));
    const padded = new Uint8Array(wav.length + 7);
    padded.set(wav, 7);
    const p = parseWav(padded.subarray(7));
    expect(p.frames).toBe(2);
    expect(p.samples[0]).toBeCloseTo(0.25, 3);
  });
});

describe('wavToBlob', () => {
  it('wraps the encoded bytes as audio/wav', () => {
    const blob = wavToBlob(new Float32Array(100), 48000);
    expect(blob.type).toBe('audio/wav');
    expect(blob.size).toBe(WAV_HEADER_BYTES + 200);
  });
});

describe('parseWav robustness', () => {
  it('skips unknown chunks, including an odd-sized one that carries a pad byte', () => {
    const data = new Uint8Array(new Int16Array([1000, -1000, 2000]).buffer);
    const buf = buildWav({
      format: 1, channels: 1, bits: 16, data,
      extra: [{ id: 'LIST', body: new Uint8Array([1, 2, 3, 4, 5]) }, { id: 'junk', body: new Uint8Array(8) }],
    });
    const p = parseWav(buf);
    expect(p.frames).toBe(3);
    expect(p.samples[0]).toBeCloseTo(1000 / 32767, 6);
    expect(p.samples[1]).toBeCloseTo(-1000 / 32768, 6);
  });

  it('clamps a data size that overruns the file (streaming writers)', () => {
    const data = new Uint8Array(new Int16Array([5, 6, 7, 8]).buffer);
    for (const declared of [0xffffffff, 1_000_000]) {
      const p = parseWav(buildWav({ format: 1, channels: 1, bits: 16, data, declaredDataSize: declared }));
      expect(p.frames).toBe(4);
    }
  });

  it('mixes stereo down to mono by averaging', () => {
    const data = new Uint8Array(new Int16Array([16384, -16384, 32767, 32767, 0, 16384]).buffer); // L R pairs
    const p = parseWav(buildWav({ format: 1, channels: 2, bits: 16, data }));
    expect(p.channels).toBe(2);
    expect(p.frames).toBe(3);
    expect(p.samples[0]).toBeCloseTo(0, 4); // (+16384/32767 + -16384/32768) / 2: asymmetric scale, ~7e-6
    expect(p.samples[1]).toBeCloseTo(1, 6);
    expect(p.samples[2]).toBeCloseTo(0.25, 3);
  });

  it('reads 8-bit unsigned PCM', () => {
    const p = parseWav(buildWav({ format: 1, channels: 1, bits: 8, data: new Uint8Array([128, 255, 0]) }));
    expect(p.samples[0]).toBe(0);
    expect(p.samples[1]).toBeCloseTo(127 / 128, 6);
    expect(p.samples[2]).toBe(-1);
  });

  it('reads 24-bit and 32-bit signed PCM', () => {
    // 24-bit: +4194304 (0.5 of full scale), -8388608 (-1).
    const d24 = new Uint8Array([0x00, 0x00, 0x40, 0x00, 0x00, 0x80]);
    const p24 = parseWav(buildWav({ format: 1, channels: 1, bits: 24, data: d24 }));
    expect(p24.samples[0]).toBeCloseTo(0.5, 5);
    expect(p24.samples[1]).toBe(-1);
    const d32 = new Uint8Array(new Int32Array([1073741824, -2147483648]).buffer);
    const p32 = parseWav(buildWav({ format: 1, channels: 1, bits: 32, data: d32 }));
    expect(p32.samples[0]).toBeCloseTo(0.5, 5);
    expect(p32.samples[1]).toBe(-1);
  });

  it('reads 32- and 64-bit float, including through WAVE_FORMAT_EXTENSIBLE', () => {
    const d32 = new Uint8Array(new Float32Array([0.25, -0.75]).buffer);
    const p = parseWav(buildWav({ format: 3, channels: 1, bits: 32, data: d32 }));
    expect(p.format).toBe('float');
    expect(Array.from(p.samples)).toEqual([0.25, -0.75]);
    const ext = parseWav(buildWav({ format: 3, channels: 1, bits: 32, data: d32, extensible: true }));
    expect(Array.from(ext.samples)).toEqual([0.25, -0.75]);
    const d64 = new Uint8Array(new Float64Array([0.125, -0.5]).buffer);
    const p64 = parseWav(buildWav({ format: 3, channels: 1, bits: 64, data: d64 }));
    expect(Array.from(p64.samples)).toEqual([0.125, -0.5]);
    const extPcm = parseWav(buildWav({ format: 1, channels: 1, bits: 16, data: new Uint8Array(new Int16Array([16384]).buffer), extensible: true }));
    expect(extPcm.samples[0]).toBeCloseTo(0.5, 3);
  });

  it('drops a trailing partial frame', () => {
    const data = new Uint8Array([1, 0, 2, 0, 3]); // 2.5 samples of 16-bit
    expect(parseWav(buildWav({ format: 1, channels: 1, bits: 16, data })).frames).toBe(2);
  });

  it('throws on things that are not usable WAVs', () => {
    expect(() => parseWav(new ArrayBuffer(0))).toThrow(/RIFF/);
    expect(() => parseWav(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]).buffer)).toThrow(/RIFF/);
    // Format 2 (ADPCM) is not supported.
    expect(() => parseWav(buildWav({ format: 2, channels: 1, bits: 4, data: new Uint8Array(4) }))).toThrow(/unsupported/);
    // 12-bit PCM is not a thing.
    expect(() => parseWav(buildWav({ format: 1, channels: 1, bits: 12, data: new Uint8Array(4) }))).toThrow(/unsupported/);
    // RIFF header only: no fmt / data.
    const headerOnly = new Uint8Array(12);
    headerOnly.set([0x52, 0x49, 0x46, 0x46, 4, 0, 0, 0, 0x57, 0x41, 0x56, 0x45]);
    expect(() => parseWav(headerOnly.buffer)).toThrow(/fmt/);
    // fmt but no data.
    const noData = new Uint8Array(encodeWav(new Float32Array(2), 48000)).slice(0, 36);
    expect(() => parseWav(noData.buffer)).toThrow(/data/);
  });
});
