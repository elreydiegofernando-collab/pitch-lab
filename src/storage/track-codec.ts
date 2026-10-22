/**
 * Compact storage form of a take's pitch track (schema.ts `TakeRecord.track`): four
 * Float32 arrays - midi, rmsDb, confidence and voiced (1 or 0) - each base64-encoded
 * little-endian, on a uniform grid `t0 + i / frameRate`, plus the frame rate and the
 * take-relative time of frame 0.
 *
 * This is the ONE implementation of the format. The take recorder (audio/take-recorder.ts)
 * re-exports it, so a take packed there and a take read back by the storage layer can
 * never disagree.
 *
 *  - Encoding puts every frame on the grid. A track with gaps (dropped render quanta) is
 *    resampled onto it, the missing slots written as unvoiced frames, so a decoded track
 *    never silently compresses time; jittered timestamps snap to the nearest slot, one
 *    frame per slot. Unvoiced frames keep their (low-confidence) midi. A bad `frameRate`
 *    option never costs a take: it falls back to measuring the track. Only an impossible
 *    time span (corrupt timestamps) throws, as a RangeError.
 *  - `f0Hz` and `centsFromNearest` are not stored; they are derived from `midi` on decode
 *    (the float32 round trip costs ~1e-4 cents). NaN midi (unvoiced) survives as NaN.
 *  - Decoding never throws: anything malformed yields an empty track, so a damaged record
 *    can never take a screen down.
 *
 * The base64 here is our own (no btoa/Buffer), so the codec also runs in a worker.
 */
import { CONFIG } from '../config';
import { centsFromNearest, midiToHz } from '../core/music';
import type { PitchFrame, PitchTrack } from '../core/types';
import type { TakeRecord } from './schema';

export type StoredTrack = TakeRecord['track'];

/** Nominal frame rate when it cannot be measured (fewer than two usable frames): the engine's hop rate. */
const NOMINAL_FRAME_RATE = 1 / CONFIG.audio.hopSeconds;

/** Upper bound on one stored track (about 6 h at 94 fps): a guard against corrupt timestamps, not a feature limit. */
export const MAX_TRACK_FRAMES = 2_000_000;

// ---------------------------------------------------------------- base64

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64_LOOKUP = (() => {
  const t = new Int8Array(128).fill(-1);
  for (let i = 0; i < 64; i++) t[B64.charCodeAt(i)] = i;
  return t;
})();

/** Standard base64 (RFC 4648, padded). Own implementation: no btoa/Buffer, so it also runs in a worker or worklet. */
export function bytesToBase64(bytes: Uint8Array): string {
  const parts: string[] = [];
  const n = bytes.length;
  const CHUNK = 3 * 4096;
  for (let start = 0; start < n; start += CHUNK) {
    const end = Math.min(n, start + CHUNK);
    let s = '';
    let i = start;
    for (; i + 2 < end; i += 3) {
      const v = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
      s += B64[(v >> 18) & 63] + B64[(v >> 12) & 63] + B64[(v >> 6) & 63] + B64[v & 63];
    }
    if (i < end) {
      const rem = end - i;
      const v = (bytes[i] << 16) | ((rem === 2 ? bytes[i + 1] : 0) << 8);
      s += B64[(v >> 18) & 63] + B64[(v >> 12) & 63] + (rem === 2 ? B64[(v >> 6) & 63] : '=') + '=';
    }
    parts.push(s);
  }
  return parts.join('');
}

/** Inverse of `bytesToBase64`. Ignores whitespace; throws SyntaxError on a bad character or length. */
export function base64ToBytes(text: string): Uint8Array {
  const chars: number[] = [];
  let pad = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 61) {
      pad++;
      continue;
    }
    if (c === 10 || c === 13 || c === 32 || c === 9) continue;
    const v = c < 128 ? B64_LOOKUP[c] : -1;
    if (v < 0 || pad > 0) throw new SyntaxError('base64: invalid character');
    chars.push(v);
  }
  if (chars.length % 4 === 1 || pad > 2 || (pad > 0 && (chars.length + pad) % 4 !== 0)) {
    throw new SyntaxError('base64: invalid length');
  }
  const out = new Uint8Array(Math.floor((chars.length * 3) / 4));
  let o = 0;
  let i = 0;
  for (; i + 3 < chars.length; i += 4) {
    const v = (chars[i] << 18) | (chars[i + 1] << 12) | (chars[i + 2] << 6) | chars[i + 3];
    out[o++] = (v >> 16) & 255;
    out[o++] = (v >> 8) & 255;
    out[o++] = v & 255;
  }
  const rem = chars.length - i;
  if (rem === 2) {
    out[o++] = ((chars[i] << 2) | (chars[i + 1] >> 4)) & 255;
  } else if (rem === 3) {
    const v = (chars[i] << 10) | (chars[i + 1] << 4) | (chars[i + 2] >> 2);
    out[o++] = (v >> 8) & 255;
    out[o++] = v & 255;
  }
  return out;
}

function float32ToBase64(values: ArrayLike<number>): string {
  const bytes = new Uint8Array(values.length * 4);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < values.length; i++) view.setFloat32(i * 4, values[i], true);
  return bytesToBase64(bytes);
}

/** The floats in `text`, or null when it is not base64 of a whole number of little-endian float32s. */
function base64ToFloat32(text: unknown): Float32Array | null {
  if (typeof text !== 'string') return null;
  let bytes: Uint8Array;
  try {
    bytes = base64ToBytes(text);
  } catch {
    return null;
  }
  if (bytes.length % 4 !== 0) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = new Float32Array(bytes.length / 4);
  for (let i = 0; i < out.length; i++) out[i] = view.getFloat32(i * 4, true);
  return out;
}

// ---------------------------------------------------------------- frame rate

/**
 * Measured frame rate: the reciprocal of the median frame spacing (robust to the odd dropped
 * quantum). Falls back to the engine's nominal hop rate when there are fewer than two frames
 * or no usable spacing.
 */
export function estimateFrameRate(track: PitchTrack): number {
  if (track.length < 2) return NOMINAL_FRAME_RATE;
  const dts: number[] = [];
  for (let i = 1; i < track.length; i++) {
    const dt = track[i].t - track[i - 1].t;
    if (dt > 0 && Number.isFinite(dt)) dts.push(dt);
  }
  if (dts.length === 0) return NOMINAL_FRAME_RATE;
  dts.sort((a, b) => a - b);
  const mid = dts.length >> 1;
  const median = dts.length % 2 === 1 ? dts[mid] : (dts[mid - 1] + dts[mid]) / 2;
  return 1 / median;
}

// ---------------------------------------------------------------- track <-> storage

/**
 * Packs a take-relative PitchTrack. `frameRate` defaults to the measured one (see
 * `estimateFrameRate`); an unusable value (not a positive finite number) is treated as absent.
 * Frames with a non-finite time are dropped. Throws a RangeError only when the time span would
 * need more than MAX_TRACK_FRAMES slots (corrupt timestamps).
 */
export function encodeTrack(track: PitchTrack, opts: { frameRate?: number } = {}): StoredTrack {
  const frames = track.filter((f) => Number.isFinite(f.t));
  if (frames.some((f, i) => i > 0 && f.t < frames[i - 1].t)) frames.sort((a, b) => a.t - b.t);
  const asked = opts.frameRate;
  const frameRate = typeof asked === 'number' && Number.isFinite(asked) && asked > 0 ? asked : estimateFrameRate(frames);
  if (frames.length === 0) return { frameRate, t0: 0, midi: '', rmsDb: '', confidence: '', voiced: '' };

  const t0 = frames[0].t;
  const n = Math.round((frames[frames.length - 1].t - t0) * frameRate) + 1;
  if (!(n <= MAX_TRACK_FRAMES)) throw new RangeError(`encodeTrack: track spans ${n} frames`);
  const midi = new Float32Array(n).fill(NaN);
  const rmsDb = new Float32Array(n).fill(CONFIG.audio.rmsFloorDb);
  const confidence = new Float32Array(n);
  const voiced = new Float32Array(n);
  const err = new Float64Array(n).fill(Infinity);
  for (const f of frames) {
    const x = (f.t - t0) * frameRate;
    const i = Math.round(x);
    const e = Math.abs(x - i);
    if (e >= err[i]) continue; // another frame sits closer to this grid slot
    err[i] = e;
    midi[i] = f.midi;
    rmsDb[i] = f.rmsDb;
    confidence[i] = f.confidence;
    voiced[i] = f.voiced ? 1 : 0;
  }
  return {
    frameRate,
    t0,
    midi: float32ToBase64(midi),
    rmsDb: float32ToBase64(rmsDb),
    confidence: float32ToBase64(confidence),
    voiced: float32ToBase64(voiced),
  };
}

/** Structural check of a stored track (what `saveTake` insists on before writing). */
export function isStoredTrack(value: unknown): value is StoredTrack {
  const t = value as Partial<Record<keyof StoredTrack, unknown>> | null | undefined;
  return (
    !!t &&
    typeof t === 'object' &&
    typeof t.frameRate === 'number' &&
    Number.isFinite(t.frameRate) &&
    t.frameRate > 0 &&
    typeof t.t0 === 'number' &&
    Number.isFinite(t.t0) &&
    typeof t.midi === 'string' &&
    typeof t.rmsDb === 'string' &&
    typeof t.confidence === 'string' &&
    typeof t.voiced === 'string'
  );
}

/** Unpacks a stored track into frames. Returns [] for anything malformed or with mismatched array lengths. */
export function decodeTrack(track: unknown): PitchFrame[] {
  if (!isStoredTrack(track)) return [];
  const midi = base64ToFloat32(track.midi);
  const rmsDb = base64ToFloat32(track.rmsDb);
  const confidence = base64ToFloat32(track.confidence);
  const voiced = base64ToFloat32(track.voiced);
  if (!midi || !rmsDb || !confidence || !voiced) return [];
  const n = midi.length;
  if (rmsDb.length !== n || confidence.length !== n || voiced.length !== n) return [];

  const frames: PitchFrame[] = new Array<PitchFrame>(n);
  for (let i = 0; i < n; i++) {
    const m = midi[i];
    frames[i] = {
      t: track.t0 + i / track.frameRate,
      f0Hz: Number.isFinite(m) ? midiToHz(m) : NaN,
      midi: m,
      centsFromNearest: centsFromNearest(m),
      confidence: confidence[i],
      rmsDb: rmsDb[i],
      voiced: voiced[i] >= 0.5,
    };
  }
  return frames;
}
