/**
 * Take recorder: turns the engine's live frame stream (and optional raw audio)
 * into a TAKE-RELATIVE, LATENCY-COMPENSATED PitchTrack the analyzers consume,
 * and packs it for storage.
 *
 * Timebase (docs/ARCHITECTURE.md): `PitchFrame.t` is the AudioContext time of
 * the analysis window's centre on the INPUT timeline. A sound scheduled for
 * output time D reaches the input at D + roundTrip, where roundTrip is the
 * route's calibrated output + input latency. So
 *
 *     takeTime = frame.t - downbeat - roundTrip          (t' = t - D - rt)
 *
 * and takeTime 0 is "the moment the singer heard the downbeat", the origin
 * every TargetNote is written against.
 *
 * Pure parts (time maths, audio alignment, track encode/decode, base64) are
 * plain functions; `TakeRecorder` only touches the injected engine, so the
 * whole file runs without a browser.
 */
import type { PitchFrame } from '../core/types';
import { encodeTrack, estimateFrameRate, type StoredTrack } from '../storage/track-codec';
import type { AudioEngine, Recording, Unsubscribe } from './engine-types';
import type { LatencyCalibration } from './latency-types';
import { encodeWav } from './wav';

/**
 * Frames earlier than this many seconds before the (compensated) downbeat are
 * dropped: that is count-in bleed, not singing. It is the longest lookback any
 * analyzer asks for (PLAN.onsetLookbackSec in src/exercises/plan.ts), so a
 * singer who anticipates the beat is still seen, with silence around the onset.
 * CONFIG has no take knob yet: proposed `CONFIG.take.preRollSec`.
 */
export const TAKE_PRE_ROLL_SEC = 0.5;

/**
 * How long `stop()` waits for the worklet to flush the recorded audio before giving up on the audio and returning
 * the pitch track alone. iOS can kill the worklet mid-take (call, Siri, lock), and a take report must never hang
 * on that. CONFIG has no take knob yet: proposed `CONFIG.take.audioFlushTimeoutMs`.
 */
export const AUDIO_FLUSH_TIMEOUT_MS = 3000;

/** The slice of AudioEngine a take needs; inject a fake in tests. */
export type TakeEngine = Pick<AudioEngine, 'onFrame' | 'startRecording' | 'stopRecording'>;

/** TakeRecord.track: Float32 arrays (little-endian) base64-encoded, uniform grid `t0 + i / frameRate`. */
export type EncodedTrack = StoredTrack;

// ---------------------------------------------------------------- time maths

/** Input-timeline time -> take time (seconds). */
export function toTakeTime(inputT: number, downbeat: number, roundTripSec: number): number {
  return inputT - downbeat - roundTripSec;
}

/** Take time -> input-timeline time: when to stop recording for a take that ends at `takeT`. */
export function toInputTime(takeT: number, downbeat: number, roundTripSec: number): number {
  return takeT + downbeat + roundTripSec;
}

/**
 * Calibrated round trip in seconds. Missing, non-finite or negative values mean
 * "uncompensated" (0): a negative latency is physically impossible, so it can
 * only be measurement noise.
 */
export function roundTripSeconds(latency: Pick<LatencyCalibration, 'roundTripMs'> | null | undefined): number {
  return roundTripMs(latency) / 1000;
}

/** The same, in the milliseconds the calibration stores (exactly, so TakeRecord.latencyMs round-trips). */
function roundTripMs(latency: Pick<LatencyCalibration, 'roundTripMs'> | null | undefined): number {
  const ms = latency?.roundTripMs;
  return typeof ms === 'number' && Number.isFinite(ms) && ms > 0 ? ms : 0;
}

// ---------------------------------------------------------------- audio alignment

export interface TakeAudio {
  samples: Float32Array;
  sampleRate: number;
  /**
   * Take time of samples[0]. Always 0: audio is trimmed (or zero-padded) to
   * begin exactly at the compensated downbeat, so a stored WAV needs no side
   * metadata: sample i is take time i / sampleRate.
   */
  t0: 0;
}

/**
 * Cut `rec` to the take timeline: sample 0 = take time 0, ending at `endSec`
 * (default: the end of the recording). A recording that started after the
 * downbeat is zero-padded at the head. Returns null when nothing is left.
 * Drops count-in audio (reference-tone and click bleed) as a side effect.
 */
export function alignRecording(rec: Recording, offsetSec: number, endSec = Infinity): TakeAudio | null {
  const sr = rec.sampleRate;
  const len = rec.samples.length;
  if (!(sr > 0) || len === 0) return null;
  const i0 = Math.round((offsetSec - rec.startTime) * sr); // index of take time 0 (negative: recording began late)
  const pad = i0 < 0 ? -i0 : 0; //                           zeros that stand in for the unrecorded head
  const from = i0 < 0 ? 0 : i0; //                           first recorded sample that is kept
  const stop = Number.isFinite(endSec) ? Math.min(len, i0 + Math.max(0, Math.round(endSec * sr))) : len;
  const body = Math.max(0, stop - from);
  if (body === 0) return null; //                            nothing recorded inside the window
  if (pad === 0) return { samples: rec.samples.subarray(from, from + body), sampleRate: sr, t0: 0 };
  const samples = new Float32Array(pad + body);
  samples.set(rec.samples.subarray(from, from + body), pad);
  return { samples, sampleRate: sr, t0: 0 };
}

// ---------------------------------------------------------------- recorder

export interface TakeRecorderOptions {
  /** AudioContext time of the exercise downbeat (take time 0 before latency compensation). */
  downbeat: number;
  /** The route's calibration (or any `{ roundTripMs }`); null/undefined = uncompensated. */
  latency?: Pick<LatencyCalibration, 'roundTripMs'> | null;
  /** Also keep the raw audio (for slow-down playback and WAV export). Default false. */
  recordAudio?: boolean;
  /** Keep only frames and audio inside this take-time window. Default [-TAKE_PRE_ROLL_SEC, +Infinity). */
  window?: { startSec?: number; endSec?: number };
  /** Give up on the audio (keeping the track) if the engine has not flushed it after this long. Default AUDIO_FLUSH_TIMEOUT_MS. */
  audioFlushTimeoutMs?: number;
}

export interface TakeResult {
  /** Take-relative, latency-compensated, ascending in time. Unvoiced frames included (analyzers need the gaps). */
  track: PitchFrame[];
  /** Trimmed to the take timeline; null when audio was not requested or nothing was captured. */
  audio: TakeAudio | null;
  /** The compensation applied, ms (TakeRecord.latencyMs). */
  latencyMs: number;
  /** AudioContext time of the downbeat the take is relative to. */
  downbeat: number;
  /** Frames per second of `track` (measured; the engine's nominal rate when there are too few frames). */
  frameRate: number;
}

type RecorderState = 'idle' | 'recording' | 'done';

/**
 * Collects one take. `start()` just before the count-in, `stop()` once the
 * singer is done AND the last compensated frames have arrived: use
 * `toInputTime(exerciseEnd, downbeat, roundTripSeconds(latency))` to schedule it.
 *
 * The per-frame listener only range-checks and appends the engine's own frame
 * object: no allocation, no copying on the live path. Compensated copies are
 * built once, in `stop()`.
 */
export class TakeRecorder {
  private readonly engine: TakeEngine;
  private readonly downbeat: number;
  private readonly latencyMs: number;
  private readonly offset: number;
  private readonly recordAudio: boolean;
  private readonly fromSec: number;
  private readonly toSec: number;
  private readonly flushTimeoutMs: number;

  private state: RecorderState = 'idle';
  private frames: PitchFrame[] = [];
  private unsubscribe: Unsubscribe | null = null;
  private result: Promise<TakeResult> | null = null;

  constructor(engine: TakeEngine, opts: TakeRecorderOptions) {
    this.engine = engine;
    this.downbeat = opts.downbeat;
    this.latencyMs = roundTripMs(opts.latency);
    this.offset = this.downbeat + this.latencyMs / 1000;
    this.recordAudio = opts.recordAudio === true;
    this.fromSec = opts.window?.startSec ?? -TAKE_PRE_ROLL_SEC;
    this.toSec = opts.window?.endSec ?? Infinity;
    this.flushTimeoutMs = opts.audioFlushTimeoutMs ?? AUDIO_FLUSH_TIMEOUT_MS;
  }

  /** Frames kept so far. */
  get frameCount(): number {
    return this.frames.length;
  }

  get recording(): boolean {
    return this.state === 'recording';
  }

  private readonly onFrame = (frame: PitchFrame): void => {
    const t = frame.t - this.offset;
    if (t >= this.fromSec && t <= this.toSec) this.frames.push(frame); // NaN fails both comparisons
  };

  /** Begin listening (and recording audio, when asked). Throws if the take was already started. */
  start(): void {
    if (this.state !== 'idle') throw new Error('TakeRecorder: already started');
    this.state = 'recording';
    this.unsubscribe = this.engine.onFrame(this.onFrame);
    if (this.recordAudio) this.engine.startRecording();
  }

  /** Stop and return the take. Idempotent: later calls resolve to the same result. Stopping before start() yields an empty take. */
  stop(): Promise<TakeResult> {
    if (this.result) return this.result;
    const wasRecording = this.state === 'recording';
    this.state = 'done';
    this.detach();
    this.result = this.finish(wasRecording && this.recordAudio);
    return this.result;
  }

  /** Abort: unsubscribe, discard frames and audio. The recorder cannot be reused. */
  cancel(): void {
    if (this.state === 'done') return;
    const hadAudio = this.state === 'recording' && this.recordAudio;
    this.state = 'done';
    this.detach();
    this.frames = [];
    this.result = Promise.resolve(this.build([], null));
    if (hadAudio) void this.engine.stopRecording().catch(() => undefined); // release the engine's assembler
  }

  private detach(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  private async finish(stopAudio: boolean): Promise<TakeResult> {
    let audio: TakeAudio | null = null;
    if (stopAudio) {
      try {
        const rec = await withTimeout(this.engine.stopRecording(), this.flushTimeoutMs);
        audio = rec ? alignRecording(rec, this.offset, this.toSec) : null;
      } catch {
        audio = null; // a failed or stuck audio flush must not lose the pitch track
      }
    }
    const frames = this.frames;
    this.frames = [];
    return this.build(frames, audio);
  }

  private build(frames: PitchFrame[], audio: TakeAudio | null): TakeResult {
    const track = compensateFrames(frames, this.offset);
    return {
      track,
      audio,
      latencyMs: this.latencyMs,
      downbeat: this.downbeat,
      frameRate: estimateFrameRate(track),
    };
  }
}

/** `p`'s value, or null if it has not settled after `ms`. A late settlement is ignored (and never an unhandled rejection). */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return new Promise<T | null>((resolve, reject) => {
    const timer = setTimeout(() => resolve(null), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

/** Compensated copies of `frames` (t' = t - offset), dropping non-finite times and sorting if the stream arrived out of order. */
export function compensateFrames(frames: readonly PitchFrame[], offsetSec: number): PitchFrame[] {
  const out: PitchFrame[] = [];
  let sorted = true;
  for (let i = 0; i < frames.length; i++) {
    const f = frames[i];
    const t = f.t - offsetSec;
    if (!Number.isFinite(t)) continue;
    if (out.length > 0 && t < out[out.length - 1].t) sorted = false;
    out.push({ ...f, t });
  }
  if (!sorted) out.sort((a, b) => a.t - b.t);
  return out;
}

// ---------------------------------------------------------------- track <-> storage

// The packed form of a take's pitch track is the storage layer's: ONE codec (storage/track-codec.ts) for the
// recorder that writes it and the storage layer that reads it, re-exported here for the recorder's callers.
export { base64ToBytes, bytesToBase64, decodeTrack, encodeTrack, estimateFrameRate } from '../storage/track-codec';

/**
 * Everything the storage layer's `saveTake` needs from a finished take (the
 * record id and profile are added there): the packed track, the WAV bytes (or
 * null), the audio sample rate, and the latency that was compensated.
 */
export function encodeTake(take: TakeResult): {
  track: EncodedTrack;
  audio: ArrayBuffer | null;
  sampleRate: number | null;
  latencyMs: number;
} {
  return {
    track: encodeTrack(take.track, { frameRate: take.frameRate }),
    audio: take.audio ? encodeWav(take.audio.samples, take.audio.sampleRate) : null,
    sampleRate: take.audio ? take.audio.sampleRate : null,
    latencyMs: take.latencyMs,
  };
}
