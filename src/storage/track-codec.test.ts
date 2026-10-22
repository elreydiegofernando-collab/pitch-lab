import { describe, expect, it } from 'vitest';
import { FRAME_RATE, makeTrack, notesMidi, sequence, withVibrato } from '../analysis/fixtures';
import { CONFIG } from '../config';
import type { PitchFrame } from '../core/types';
import { MAX_TRACK_FRAMES, base64ToBytes, bytesToBase64, decodeTrack, encodeTrack, estimateFrameRate, isStoredTrack } from './track-codec';

function frame(overrides: Partial<PitchFrame> & { t: number }): PitchFrame {
  return { f0Hz: 440, midi: 69, centsFromNearest: 0, confidence: 0.95, rmsDb: -20, voiced: true, ...overrides };
}

describe('encodeTrack / decodeTrack round trip', () => {
  const track = makeTrack({
    duration: 3,
    midi: sequence([
      [1, () => 60.2],
      [0.4, () => NaN], // a breath
      [1.6, withVibrato(() => 64, 5.8, 40)],
    ]),
    rmsDb: (t) => -30 + 5 * Math.sin(t),
    confidence: 0.91,
    jitterCents: 4,
    seed: 99,
  });

  it('restores every frame: time, midi, level, confidence and voicing', () => {
    const decoded = decodeTrack(encodeTrack(track));
    expect(decoded).toHaveLength(track.length);
    for (let i = 0; i < track.length; i++) {
      const a = track[i];
      const b = decoded[i];
      expect(b.t).toBeCloseTo(a.t, 9);
      expect(b.voiced).toBe(a.voiced);
      if (a.voiced) expect(b.midi).toBeCloseTo(a.midi, 4); // float32 resolution near MIDI 60 is ~4e-6
      else expect(b.midi).toBeNaN();
      expect(b.rmsDb).toBeCloseTo(a.rmsDb, 4);
      expect(b.confidence).toBeCloseTo(a.confidence, 5);
    }
  });

  it('re-derives f0Hz and centsFromNearest from midi (NaN stays NaN)', () => {
    const decoded = decodeTrack(encodeTrack(track));
    for (let i = 0; i < track.length; i++) {
      const a = track[i];
      const b = decoded[i];
      if (a.voiced) {
        expect(b.f0Hz / a.f0Hz).toBeCloseTo(1, 5);
        expect(b.centsFromNearest).toBeCloseTo(a.centsFromNearest, 2);
      } else {
        expect(b.f0Hz).toBeNaN();
        expect(b.centsFromNearest).toBeNaN();
      }
    }
  });

  it('measures the frame rate from the track itself', () => {
    expect(encodeTrack(track).frameRate).toBeCloseTo(FRAME_RATE, 9);
    const at100 = makeTrack({ duration: 2, midi: () => 60, frameRate: 100 });
    expect(encodeTrack(at100).frameRate).toBeCloseTo(100, 9);
    expect(decodeTrack(encodeTrack(at100))[150].t).toBeCloseTo(1.5, 9);
  });

  it('honours an explicit frameRate, and falls back to measuring when it is unusable', () => {
    expect(encodeTrack(track, { frameRate: 50 }).frameRate).toBe(50);
    for (const bad of [0, -1, NaN, Infinity]) expect(encodeTrack(track, { frameRate: bad }).frameRate).toBeCloseTo(FRAME_RATE, 9);
  });

  it('keeps the take-relative start time t0, including a negative one', () => {
    const early = makeTrack({ duration: 1, midi: notesMidi([{ midi: 62, start: -1, end: 5 }]), t0: -0.5 });
    const stored = encodeTrack(early);
    expect(stored.t0).toBe(-0.5);
    expect(decodeTrack(stored)[0].t).toBe(-0.5);
  });

  it('preserves a frame that was gated out (unvoiced) although it still carried a pitch', () => {
    const gated = [frame({ t: 0, midi: 61.5, voiced: false, confidence: 0.3 }), frame({ t: 0.01, midi: 61.6, voiced: true })];
    const decoded = decodeTrack(encodeTrack(gated, { frameRate: 100 }));
    expect(decoded[0].voiced).toBe(false);
    expect(decoded[0].midi).toBeCloseTo(61.5, 4);
    expect(decoded[1].voiced).toBe(true);
  });

  it('is a stable little-endian float32 base64 format', () => {
    // 1.0f32 little-endian = 00 00 80 3f
    const stored = encodeTrack([frame({ t: 0, midi: 1, rmsDb: 1, confidence: 1 })], { frameRate: 10 });
    expect(stored.midi).toBe('AACAPw==');
    expect(stored.rmsDb).toBe('AACAPw==');
    expect(stored.confidence).toBe('AACAPw==');
    expect(stored.voiced).toBe('AACAPw=='); // voiced === true -> 1.0
    expect(encodeTrack([frame({ t: 0, voiced: false })], { frameRate: 10 }).voiced).toBe('AAAAAA=='); // 0.0
  });

  it('is compact: four float32 arrays, base64', () => {
    const n = track.length;
    const stored = encodeTrack(track);
    const expected = 4 * Math.ceil((n * 4) / 3);
    for (const key of ['midi', 'rmsDb', 'confidence', 'voiced'] as const) expect(stored[key]).toHaveLength(expected);
  });

  it('survives a JSON round trip (that is how it is stored and backed up)', () => {
    const decoded = decodeTrack(JSON.parse(JSON.stringify(encodeTrack(track))));
    expect(decoded).toHaveLength(track.length);
  });
});

describe('edge tracks', () => {
  it('an empty track encodes to empty arrays and decodes to nothing', () => {
    const stored = encodeTrack([]);
    expect(stored.midi).toBe('');
    expect(stored.t0).toBe(0);
    expect(stored.frameRate).toBeCloseTo(FRAME_RATE, 9);
    expect(decodeTrack(stored)).toEqual([]);
  });

  it('a single frame uses the nominal frame rate', () => {
    const stored = encodeTrack([frame({ t: 2 })]);
    expect(stored.frameRate).toBeCloseTo(FRAME_RATE, 9);
    expect(stored.t0).toBe(2);
    expect(decodeTrack(stored)).toHaveLength(1);
  });

  it('frames with identical times fall back to the nominal rate instead of dividing by zero', () => {
    const stored = encodeTrack([frame({ t: 1 }), frame({ t: 1 }), frame({ t: 1 })]);
    expect(Number.isFinite(stored.frameRate)).toBe(true);
    expect(stored.frameRate).toBeGreaterThan(0);
  });
});

describe('decodeTrack never throws on damaged input', () => {
  const good = encodeTrack(makeTrack({ duration: 0.2, midi: () => 60 }));

  it.each([
    ['null', null],
    ['a string', 'track'],
    ['an empty object', {}],
    ['a missing array', { ...good, midi: undefined }],
    ['a non-string array', { ...good, rmsDb: 12 }],
    ['invalid base64', { ...good, midi: '***not base64***' }],
    ['bytes that are not a whole number of float32s', { ...good, confidence: btoa('abcde') }],
    ['arrays of different lengths', { ...good, voiced: encodeTrack(makeTrack({ duration: 0.1, midi: () => 60 })).voiced }],
    ['a zero frame rate', { ...good, frameRate: 0 }],
    ['a NaN start time', { ...good, t0: NaN }],
  ])('returns [] for %s', (_label, bad) => {
    expect(decodeTrack(bad)).toEqual([]);
  });

  it('the undamaged track still decodes', () => {
    expect(decodeTrack(good).length).toBeGreaterThan(10);
  });
});

describe('isStoredTrack', () => {
  it('accepts a well-formed stored track and rejects the rest', () => {
    const good = encodeTrack([frame({ t: 0 })]);
    expect(isStoredTrack(good)).toBe(true);
    expect(isStoredTrack({ ...good, frameRate: -1 })).toBe(false);
    expect(isStoredTrack({ ...good, t0: '0' })).toBe(false);
    expect(isStoredTrack({ ...good, voiced: null })).toBe(false);
    expect(isStoredTrack(null)).toBe(false);
    expect(isStoredTrack('x')).toBe(false);
  });
});

describe('encodeTrack puts every frame on the grid', () => {
  const frameAt = (t: number, midi = 60): PitchFrame => frame({ t, midi, f0Hz: 440 * 2 ** ((midi - 69) / 12) });

  it('fills dropped frames with unvoiced slots so time is never compressed', () => {
    const full = makeTrack({ duration: 1, midi: () => 60 });
    const dropped = full.filter((_, i) => i < 20 || i >= 30); // ten frames missing (lost render quanta)
    const back = decodeTrack(encodeTrack(dropped));
    expect(back).toHaveLength(full.length);
    for (let i = 0; i < full.length; i++) {
      expect(back[i].t).toBeCloseTo(full[i].t, 9);
      expect(back[i].voiced).toBe(i < 20 || i >= 30);
    }
    expect(back[25].confidence).toBe(0);
    expect(back[25].rmsDb).toBe(CONFIG.audio.rmsFloorDb);
    expect(back[25].midi).toBeNaN();
  });

  it('snaps jittered timestamps to the nearest grid slot, one frame per slot', () => {
    const full = makeTrack({ duration: 1, midi: () => 60 });
    const wobbly = full.map((f, i) => ({ ...f, t: f.t + ((i % 5) - 2) * 0.0005, midi: 60 + i * 0.001 }));
    const back = decodeTrack(encodeTrack(wobbly, { frameRate: FRAME_RATE }));
    expect(back).toHaveLength(full.length);
    expect(back[10].midi).toBeCloseTo(60.01, 5);
    expect(back.every((f) => f.voiced)).toBe(true);
  });

  it('survives the grid phase shifting after a dropped block (the framer restarts its hop schedule)', () => {
    const full = makeTrack({ duration: 1.5, midi: () => 60 });
    // Frames 0-59 on the original grid; after a lost quantum the rest sit on a grid shifted by 3.7 ms.
    const shifted = full.map((f, i) => ({ ...f, t: i < 60 ? f.t : f.t + 0.0037, midi: 60 + i * 0.001 }));
    const back = decodeTrack(encodeTrack(shifted));
    expect(back).toHaveLength(full.length);
    const halfFrame = 0.5 / FRAME_RATE;
    for (let i = 0; i < full.length; i++) {
      expect(Math.abs(back[i].t - shifted[i].t)).toBeLessThanOrEqual(halfFrame + 1e-9);
      expect(back[i].midi).toBeCloseTo(60 + i * 0.001, 5); // every frame kept, none merged or lost
    }
  });

  it('puts a lone frame at its own time, and ignores frames with unusable times', () => {
    const one = decodeTrack(encodeTrack([frameAt(2.5, 67)]));
    expect(one).toHaveLength(1);
    expect(one[0].t).toBeCloseTo(2.5, 12);
    expect(one[0].midi).toBeCloseTo(67, 5);

    const enc = encodeTrack([frameAt(0), frameAt(NaN), frameAt(0.5), frameAt(1)], { frameRate: 2 });
    expect(enc.frameRate).toBe(2);
    expect(decodeTrack(enc).map((f) => f.t)).toEqual([0, 0.5, 1]);
  });

  it('sorts an out-of-order stream before packing it', () => {
    const full = makeTrack({ duration: 0.5, midi: (t) => 60 + t });
    const shuffled = [...full].reverse();
    const back = decodeTrack(encodeTrack(shuffled));
    expect(back.map((f) => f.t)).toEqual(decodeTrack(encodeTrack(full)).map((f) => f.t));
    expect(back[10].midi).toBeCloseTo(full[10].midi, 5);
  });

  it('refuses a runaway time span (corrupt timestamps) instead of allocating for it', () => {
    expect(() => encodeTrack([frameAt(0), frameAt(1e9)], { frameRate: 94 })).toThrow(RangeError);
    expect(MAX_TRACK_FRAMES).toBeGreaterThan(60 * 60 * 94); // an hour of singing is nowhere near the limit
  });
});

describe('estimateFrameRate', () => {
  it('is the reciprocal median spacing, robust to a dropped frame', () => {
    const track = makeTrack({ duration: 2, midi: () => 60 });
    expect(estimateFrameRate(track)).toBeCloseTo(FRAME_RATE, 6);
    const gappy = track.filter((_, i) => i !== 40 && i !== 41 && i !== 90);
    expect(estimateFrameRate(gappy)).toBeCloseTo(FRAME_RATE, 6);
  });

  it('falls back to the nominal hop rate when it cannot be measured', () => {
    expect(estimateFrameRate([])).toBeCloseTo(1 / CONFIG.audio.hopSeconds, 9);
    expect(estimateFrameRate([frame({ t: 1 })])).toBeCloseTo(1 / CONFIG.audio.hopSeconds, 9);
    expect(estimateFrameRate([frame({ t: 1 }), frame({ t: 1 })])).toBeCloseTo(1 / CONFIG.audio.hopSeconds, 9);
  });
});

describe('base64', () => {
  /** The platform's own encoder (btoa), as an independent reference. */
  const reference = (bytes: Uint8Array): string => {
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  };

  it('matches the platform encoder for every length mod 3 and decodes back', () => {
    let seed = 7;
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) & 255;
    for (const n of [0, 1, 2, 3, 4, 5, 6, 7, 31, 32, 33, 100, 12287, 12288, 12289, 40000]) {
      const bytes = Uint8Array.from({ length: n }, rnd);
      const text = bytesToBase64(bytes);
      expect(text).toBe(reference(bytes));
      expect(Array.from(base64ToBytes(text))).toEqual(Array.from(bytes));
    }
  });

  it('ignores whitespace and rejects bad input', () => {
    expect(Array.from(base64ToBytes('AQID\nBAUG'))).toEqual([1, 2, 3, 4, 5, 6]);
    expect(Array.from(base64ToBytes('AQI='))).toEqual([1, 2]);
    expect(() => base64ToBytes('A*ID')).toThrow(SyntaxError);
    expect(() => base64ToBytes('AQIDB')).toThrow(SyntaxError); // 5 chars: impossible length
    expect(() => base64ToBytes('AQ=D')).toThrow(SyntaxError); //  data after padding
    expect(() => base64ToBytes('é')).toThrow(SyntaxError);
  });
});
