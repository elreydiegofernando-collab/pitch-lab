import { describe, expect, it } from 'vitest';
import { makeTrack } from '../analysis/fixtures';
import { midiToHz } from '../core/music';
import type { PitchFrame } from '../core/types';
import * as storageCodec from '../storage/track-codec';
import type { SaveTakeInput } from '../storage/takes-repo';
import type { Recording } from './engine-types';
import {
  TAKE_PRE_ROLL_SEC,
  TakeRecorder,
  alignRecording,
  base64ToBytes,
  bytesToBase64,
  compensateFrames,
  decodeTrack,
  encodeTake,
  encodeTrack,
  estimateFrameRate,
  roundTripSeconds,
  toInputTime,
  toTakeTime,
  type TakeEngine,
} from './take-recorder';
import { parseWav } from './wav';

// ---------------------------------------------------------------- fakes

class FakeEngine implements TakeEngine {
  listeners = new Set<(f: PitchFrame) => void>();
  starts = 0;
  stops = 0;
  nextRecording: Recording | Error = { samples: new Float32Array(0), sampleRate: 48000, startTime: 0 };
  onFrame(listener: (f: PitchFrame) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  emit(f: PitchFrame): void {
    for (const l of [...this.listeners]) l(f);
  }
  startRecording(): void {
    this.starts++;
  }
  stopRecording(): Promise<Recording> {
    this.stops++;
    return this.nextRecording instanceof Error ? Promise.reject(this.nextRecording) : Promise.resolve(this.nextRecording);
  }
}

const frameAt = (t: number, midi = 60, voiced = true): PitchFrame => ({
  t,
  f0Hz: voiced ? midiToHz(midi) : NaN,
  midi: voiced ? midi : NaN,
  centsFromNearest: voiced ? 0 : NaN,
  confidence: voiced ? 0.95 : 0.1,
  rmsDb: voiced ? -20 : -80,
  voiced,
});

// ---------------------------------------------------------------- time maths

describe('take-time maths', () => {
  it('t\' = t - downbeat - roundTrip, and toInputTime inverts it', () => {
    expect(toTakeTime(12.62, 10, 0.12)).toBeCloseTo(2.5, 12);
    expect(toInputTime(2.5, 10, 0.12)).toBeCloseTo(12.62, 12);
    for (const [t, d, rt] of [[5.5, 4.25, 0.3], [0, 0, 0], [123.456, 100, 0.0125]] as const) {
      expect(toInputTime(toTakeTime(t, d, rt), d, rt)).toBeCloseTo(t, 12);
    }
  });

  it('roundTripSeconds: ms to seconds; missing, bad or negative values mean uncompensated', () => {
    expect(roundTripSeconds({ roundTripMs: 150 })).toBeCloseTo(0.15, 12);
    expect(roundTripSeconds(null)).toBe(0);
    expect(roundTripSeconds(undefined)).toBe(0);
    expect(roundTripSeconds({ roundTripMs: -4 })).toBe(0);
    expect(roundTripSeconds({ roundTripMs: NaN })).toBe(0);
    expect(roundTripSeconds({ roundTripMs: Infinity })).toBe(0);
  });
});

// ---------------------------------------------------------------- recorder

describe('TakeRecorder: compensation', () => {
  it('re-bases frames so t = 0 is the downbeat as the singer heard it', () => {
    const engine = new FakeEngine();
    const downbeat = 10;
    const latencyMs = 120;
    const rec = new TakeRecorder(engine, { downbeat, latency: { roundTripMs: latencyMs } });
    rec.start();
    // A singer who lands a note 1.5 s after the downbeat, as heard: it reaches the input at D + rt + 1.5.
    const input = [10.12 + 1.0, 10.12 + 1.5, 10.12 + 1.5 + 0.0107];
    for (const t of input) engine.emit(frameAt(t));
    return rec.stop().then((take) => {
      expect(take.track.map((f) => f.t)).toEqual([
        expect.closeTo(1.0, 9),
        expect.closeTo(1.5, 9),
        expect.closeTo(1.5107, 9),
      ]);
      expect(take.latencyMs).toBe(120); // exactly the calibrated ms
      expect(take.downbeat).toBe(10);
      expect(take.audio).toBeNull();
      // Everything but t is carried through untouched.
      expect(take.track[0].midi).toBe(60);
      expect(take.track[0].voiced).toBe(true);
    });
  });

  it('without calibration the offset is just the downbeat', async () => {
    const engine = new FakeEngine();
    const rec = new TakeRecorder(engine, { downbeat: 3 });
    rec.start();
    engine.emit(frameAt(3.5));
    const take = await rec.stop();
    expect(take.track[0].t).toBeCloseTo(0.5, 12);
    expect(take.latencyMs).toBe(0);
  });

  it('does not mutate the engine frames it was handed', async () => {
    const engine = new FakeEngine();
    const rec = new TakeRecorder(engine, { downbeat: 1, latency: { roundTripMs: 100 } });
    rec.start();
    const f = frameAt(2.1);
    engine.emit(f);
    const take = await rec.stop();
    expect(f.t).toBe(2.1);
    expect(take.track[0]).not.toBe(f);
  });

  it('keeps unvoiced frames: analyzers need the gaps', async () => {
    const engine = new FakeEngine();
    const rec = new TakeRecorder(engine, { downbeat: 0 });
    rec.start();
    engine.emit(frameAt(0.1, 60, true));
    engine.emit(frameAt(0.11, 60, false));
    engine.emit(frameAt(0.12, 60, true));
    const take = await rec.stop();
    expect(take.track.map((f) => f.voiced)).toEqual([true, false, true]);
    expect(take.track[1].midi).toBeNaN();
  });

  it('sorts a stream that arrived out of order and drops frames with no usable time', async () => {
    const engine = new FakeEngine();
    const rec = new TakeRecorder(engine, { downbeat: 0, window: { startSec: -1 } });
    rec.start();
    for (const t of [0.3, 0.1, NaN, 0.2, Infinity]) engine.emit(frameAt(t));
    const take = await rec.stop();
    expect(take.track.map((f) => f.t)).toEqual([0.1, 0.2, 0.3]);
  });
});

describe('TakeRecorder: take window', () => {
  it('drops count-in bleed before the pre-roll but keeps a singer who anticipates the beat', async () => {
    const engine = new FakeEngine();
    const downbeat = 5;
    const rec = new TakeRecorder(engine, { downbeat, latency: { roundTripMs: 200 } });
    rec.start();
    const offset = downbeat + 0.2;
    engine.emit(frameAt(offset - 1.0)); //                     count-in
    engine.emit(frameAt(offset - TAKE_PRE_ROLL_SEC - 0.01)); // just outside the pre-roll
    engine.emit(frameAt(offset - TAKE_PRE_ROLL_SEC + 0.01)); // just inside: early start
    engine.emit(frameAt(offset + 0.5));
    const take = await rec.stop();
    expect(take.track.map((f) => f.t)).toEqual([expect.closeTo(-TAKE_PRE_ROLL_SEC + 0.01, 9), expect.closeTo(0.5, 9)]);
  });

  it('honours an explicit window end', async () => {
    const engine = new FakeEngine();
    const rec = new TakeRecorder(engine, { downbeat: 0, window: { startSec: 0, endSec: 2 } });
    rec.start();
    for (const t of [-0.05, 0, 1, 2, 2.01, 9]) engine.emit(frameAt(t));
    const take = await rec.stop();
    expect(take.track.map((f) => f.t)).toEqual([0, 1, 2]);
  });
});

describe('TakeRecorder: lifecycle', () => {
  it('unsubscribes on stop, so late frames are ignored and the engine keeps no listener', async () => {
    const engine = new FakeEngine();
    const rec = new TakeRecorder(engine, { downbeat: 0 });
    rec.start();
    expect(engine.listeners.size).toBe(1);
    expect(rec.recording).toBe(true);
    engine.emit(frameAt(0.1));
    expect(rec.frameCount).toBe(1);
    const take = await rec.stop();
    expect(engine.listeners.size).toBe(0);
    expect(rec.recording).toBe(false);
    engine.emit(frameAt(0.2));
    expect(take.track).toHaveLength(1);
  });

  it('stop() is idempotent and returns the same result', async () => {
    const engine = new FakeEngine();
    const rec = new TakeRecorder(engine, { downbeat: 0, recordAudio: true });
    rec.start();
    engine.emit(frameAt(0.1));
    const a = rec.stop();
    const b = rec.stop();
    expect(b).toBe(a);
    expect((await a).track).toHaveLength(1);
    expect(engine.stops).toBe(1);
  });

  it('start() twice throws; stop() before start() is an empty take that never touches the engine', async () => {
    const engine = new FakeEngine();
    const rec = new TakeRecorder(engine, { downbeat: 0, recordAudio: true });
    rec.start();
    expect(() => rec.start()).toThrow(/already started/);
    const fresh = new TakeRecorder(engine, { downbeat: 0, recordAudio: true });
    const take = await fresh.stop();
    expect(take.track).toEqual([]);
    expect(take.audio).toBeNull();
    expect(engine.starts).toBe(1); // only the first recorder started anything
    expect(engine.stops).toBe(0);
  });

  it('cancel() discards frames, releases the engine recording and cannot be restarted', async () => {
    const engine = new FakeEngine();
    const rec = new TakeRecorder(engine, { downbeat: 0, recordAudio: true });
    rec.start();
    engine.emit(frameAt(0.1));
    rec.cancel();
    expect(engine.listeners.size).toBe(0);
    expect(engine.stops).toBe(1);
    const take = await rec.stop();
    expect(take.track).toEqual([]);
    expect(take.audio).toBeNull();
    expect(() => rec.start()).toThrow();
  });

  it('only records audio when asked', async () => {
    const engine = new FakeEngine();
    const rec = new TakeRecorder(engine, { downbeat: 0 });
    rec.start();
    await rec.stop();
    expect(engine.starts).toBe(0);
    expect(engine.stops).toBe(0);
  });

  it('a worklet that never answers must not hang the take: the track comes back without audio after the timeout', async () => {
    const engine = new FakeEngine();
    engine.stopRecording = () => new Promise<Recording>(() => undefined); // never settles
    const rec = new TakeRecorder(engine, { downbeat: 0, recordAudio: true, audioFlushTimeoutMs: 25 });
    rec.start();
    engine.emit(frameAt(0.1));
    const t0 = performance.now();
    const take = await rec.stop();
    expect(performance.now() - t0).toBeGreaterThanOrEqual(20);
    expect(performance.now() - t0).toBeLessThan(2000);
    expect(take.audio).toBeNull();
    expect(take.track).toHaveLength(1);
  });

  it('audio that arrives before the timeout is kept', async () => {
    const engine = new FakeEngine();
    engine.nextRecording = { samples: Float32Array.from({ length: 480 }, () => 0.1), sampleRate: 48000, startTime: 0 };
    const rec = new TakeRecorder(engine, { downbeat: 0, recordAudio: true, audioFlushTimeoutMs: 5000 });
    rec.start();
    const take = await rec.stop();
    expect(take.audio?.samples.length).toBe(480);
  });

  it('a failed audio flush must not lose the pitch track', async () => {
    const engine = new FakeEngine();
    engine.nextRecording = new Error('worklet gone');
    const rec = new TakeRecorder(engine, { downbeat: 0, recordAudio: true });
    rec.start();
    engine.emit(frameAt(0.1));
    const take = await rec.stop();
    expect(take.audio).toBeNull();
    expect(take.track).toHaveLength(1);
  });
});

// ---------------------------------------------------------------- audio alignment

describe('alignRecording', () => {
  const sr = 1000; // a toy rate keeps the arithmetic readable
  const ramp = (n: number): Float32Array => Float32Array.from({ length: n }, (_, i) => i + 1);

  it('starts at the compensated downbeat: sample i is take time i / sampleRate', () => {
    // Recording began 2 s before the downbeat; round trip 0.25 s: take time 0 is input time 12.25 -> index 2250.
    const rec: Recording = { samples: ramp(6000), sampleRate: sr, startTime: 10 };
    const audio = alignRecording(rec, 10 + 2 + 0.25)!;
    expect(audio.t0).toBe(0);
    expect(audio.sampleRate).toBe(sr);
    expect(audio.samples[0]).toBe(2251); // ramp value at index 2250
    expect(audio.samples.length).toBe(6000 - 2250);
  });

  it('trims the tail at the window end', () => {
    const rec: Recording = { samples: ramp(6000), sampleRate: sr, startTime: 0 };
    const audio = alignRecording(rec, 1, 2.5)!; // take time 0 = index 1000, 2.5 s of it
    expect(audio.samples[0]).toBe(1001);
    expect(audio.samples.length).toBe(2500);
  });

  it('zero-pads the head when the recording started after the downbeat', () => {
    const rec: Recording = { samples: ramp(100), sampleRate: sr, startTime: 5.3 };
    const audio = alignRecording(rec, 5)!; // recording is 300 ms late
    expect(audio.samples.length).toBe(300 + 100);
    expect(Array.from(audio.samples.subarray(0, 300)).every((v) => v === 0)).toBe(true);
    expect(audio.samples[300]).toBe(1);
  });

  it('returns null when nothing falls inside the window, or the recording is empty', () => {
    expect(alignRecording({ samples: ramp(100), sampleRate: sr, startTime: 0 }, 50)).toBeNull(); // ended before the downbeat
    expect(alignRecording({ samples: new Float32Array(0), sampleRate: sr, startTime: 0 }, 0)).toBeNull();
    expect(alignRecording({ samples: ramp(100), sampleRate: 0, startTime: 0 }, 0)).toBeNull();
    // Window closes before the recording even starts.
    expect(alignRecording({ samples: ramp(100), sampleRate: sr, startTime: 10 }, 0, 5)).toBeNull();
  });

  it('puts a sung impulse at the same take time in the audio and in the track', async () => {
    // An impulse sung 1.2 s after the downbeat with 180 ms round trip; the recording started in the count-in.
    const sample = 48000;
    const downbeat = 20;
    const latency = 0.18;
    const startTime = 18.5;
    const samples = new Float32Array(sample * 6);
    const impulseInput = downbeat + latency + 1.2;
    samples[Math.round((impulseInput - startTime) * sample)] = 1;
    const engine = new FakeEngine();
    engine.nextRecording = { samples, sampleRate: sample, startTime };
    const rec = new TakeRecorder(engine, { downbeat, latency: { roundTripMs: 180 }, recordAudio: true });
    rec.start();
    engine.emit(frameAt(impulseInput));
    const take = await rec.stop();
    const idx = take.audio!.samples.indexOf(1);
    expect(idx / sample).toBeCloseTo(1.2, 4);
    expect(take.track[0].t).toBeCloseTo(1.2, 9);
  });
});

// ---------------------------------------------------------------- frame helpers

describe('frame helpers', () => {
  it('compensateFrames subtracts the offset and keeps order', () => {
    const out = compensateFrames([frameAt(5), frameAt(5.5)], 4.25);
    expect(out.map((f) => f.t)).toEqual([0.75, 1.25]);
  });
});

// ---------------------------------------------------------------- track <-> storage

describe('the track codec is the storage layer\'s', () => {
  // The format's own tests (gaps, grid snapping, base64, damaged input) live with the one implementation, in
  // src/storage/track-codec.test.ts: a recorder that packs a take and the storage layer that reads it must agree.
  it('is re-exported, not copied', () => {
    expect(encodeTrack).toBe(storageCodec.encodeTrack);
    expect(decodeTrack).toBe(storageCodec.decodeTrack);
    expect(estimateFrameRate).toBe(storageCodec.estimateFrameRate);
    expect(bytesToBase64).toBe(storageCodec.bytesToBase64);
    expect(base64ToBytes).toBe(storageCodec.base64ToBytes);
  });

  it('packs a take that drops frames without compressing time, as the storage layer will read it back', () => {
    const full = makeTrack({ duration: 1, midi: () => 60 });
    const dropped = full.filter((_, i) => i < 20 || i >= 30); // ten frames lost by the worklet
    const back = decodeTrack(encodeTrack(dropped));
    expect(back).toHaveLength(full.length);
    expect(back[40].t).toBeCloseTo(full[40].t, 9);
    expect(back[25].voiced).toBe(false);
  });
});

// ---------------------------------------------------------------- storage hand-off

describe('encodeTake', () => {
  it('packs track, WAV audio and latency for saveTake', async () => {
    const sample = 48000;
    const engine = new FakeEngine();
    const samples = Float32Array.from({ length: sample }, (_, i) => 0.5 * Math.sin((2 * Math.PI * 220 * i) / sample));
    engine.nextRecording = { samples, sampleRate: sample, startTime: 9.5 };
    const rec = new TakeRecorder(engine, { downbeat: 10, latency: { roundTripMs: 90 }, recordAudio: true });
    rec.start();
    const src = makeTrack({ duration: 0.4, t0: 10.09, midi: () => 57 });
    for (const f of src) engine.emit(f);
    const take = await rec.stop();
    const packed = encodeTake(take);
    expect(packed.latencyMs).toBeCloseTo(90, 9);
    expect(packed.sampleRate).toBe(sample);
    const back = decodeTrack(packed.track);
    expect(back.length).toBe(take.track.length);
    expect(back[0].t).toBeCloseTo(take.track[0].t, 9);
    const wav = parseWav(packed.audio!);
    expect(wav.sampleRate).toBe(sample);
    expect(wav.frames).toBe(take.audio!.samples.length);
    // The audio began 0.59 s before take time 0 (downbeat 10 + 0.09 round trip - start 9.5): trimmed away.
    expect(wav.frames).toBe(sample - Math.round(0.59 * sample));
  });

  it("matches what the storage layer's saveTake takes (type-checked), with the record ids added", async () => {
    const engine = new FakeEngine();
    const rec = new TakeRecorder(engine, { downbeat: 0, latency: { roundTripMs: 40 } });
    rec.start();
    engine.emit(frameAt(0.1));
    const input: SaveTakeInput = { profileId: 'profile-1', exerciseId: 'foundations.sustain.1', ...encodeTake(await rec.stop()) };
    expect(input.latencyMs).toBeCloseTo(40, 9);
    expect(input.audio).toBeNull();
    expect(decodeTrack(input.track)).toHaveLength(1);
  });

  it('is all-null for a take with no audio', async () => {
    const engine = new FakeEngine();
    const rec = new TakeRecorder(engine, { downbeat: 0 });
    rec.start();
    engine.emit(frameAt(0.1));
    const packed = encodeTake(await rec.stop());
    expect(packed.audio).toBeNull();
    expect(packed.sampleRate).toBeNull();
    expect(packed.latencyMs).toBe(0);
    expect(decodeTrack(packed.track)).toHaveLength(1);
  });
});
