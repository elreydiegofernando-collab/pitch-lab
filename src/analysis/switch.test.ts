import { describe, expect, it } from 'vitest';
import { analyzeSwitch, type VibratoCue } from './switch';
import { makeTrack, withVibrato } from './fixtures';

const RATE = 5.8;
const EXT = 45;

/** Pitch 60 with vibrato on exactly during the given [start, end) spans; NaN (silence) outside `voiced`. */
function contour(spans: ReadonlyArray<readonly [number, number]>, voiced: (t: number) => boolean = () => true) {
  return (t: number) => {
    if (!voiced(t)) return NaN;
    const on = spans.some(([a, b]) => t >= a && t < b);
    const a = spans.find(([s, e]) => t >= s && t < e)?.[0] ?? 0;
    return 60 + (on ? (EXT / 100) * Math.sin(2 * Math.PI * RATE * (t - a)) : 0);
  };
}

const bloomCues = (cue: number, end: number): VibratoCue[] => [
  { start: 0, end: cue, vibrato: false },
  { start: cue, end, vibrato: true },
];

describe('analyzeSwitch: straight to bloom', () => {
  it('a bloom right on the cue is clean, ~0 ms late and scores 1', () => {
    const track = makeTrack({ duration: 3, midi: withVibrato(() => 60, RATE, EXT, 1.5), jitterCents: 4, seed: 5 });
    const r = analyzeSwitch(track, bloomCues(1.5, 3));
    expect(r.windows.map((w) => w.actual)).toEqual(['straight', 'vibrato']);
    expect(r.windows.map((w) => w.cue)).toEqual(['straight', 'vibrato']);
    expect(r.boundaries.length).toBe(1);
    expect(r.boundaries[0].toVibrato).toBe(true);
    expect(Math.abs(r.boundaries[0].latencyMs!)).toBeLessThan(150);
    expect(r.boundaries[0].clean).toBe(true);
    expect(r.switchCleanRate).toBe(1);
    expect(r.bloomOnCueScore).toBe(1);
    expect(Math.abs(r.bloomOnCueLatencyMs!)).toBeLessThan(150);
  });

  it('measures the bloom latency to within a lobe, with no detection-window delay added on top', () => {
    for (const late of [0.3, 0.5]) {
      const track = makeTrack({ duration: 4, midi: withVibrato(() => 60, RATE, EXT, 1.5 + late), jitterCents: 4, seed: 5 });
      const r = analyzeSwitch(track, bloomCues(1.5, 4));
      expect(Math.abs(r.bloomOnCueLatencyMs! - late * 1000), `${late}s late`).toBeLessThan(120);
    }
  });

  it('a bloom 300 ms late is still a clean switch and still scores high; 800 ms late is not clean and scores lower; 1.1 s late lower still', () => {
    const score = (late: number) => {
      const track = makeTrack({ duration: 4.5, midi: withVibrato(() => 60, RATE, EXT, 1.5 + late), jitterCents: 4, seed: 5 });
      return analyzeSwitch(track, bloomCues(1.5, 4.5));
    };
    const a = score(0.3);
    const b = score(0.8);
    const c = score(1.1);
    expect(a.boundaries[0].clean).toBe(true);
    expect(a.bloomOnCueScore!).toBeGreaterThan(0.9);
    expect(b.boundaries[0].clean).toBe(false);
    expect(b.bloomOnCueScore!).toBeLessThan(a.bloomOnCueScore!);
    expect(b.bloomOnCueScore!).toBeGreaterThan(0.4);
    expect(c.bloomOnCueScore!).toBeLessThan(b.bloomOnCueScore!);
    expect(c.bloomOnCueScore!).toBeGreaterThan(0.1);
  });

  it('the bloom score passes its own pass gate (>= 0.5) for a normal human reaction and fails it for a really late one', () => {
    const run = (late: number) =>
      analyzeSwitch(makeTrack({ duration: 4.5, midi: withVibrato(() => 60, RATE, EXT, 1.5 + late), jitterCents: 5, seed: 2 }), bloomCues(1.5, 4.5)).bloomOnCueScore!;
    expect(run(0.4)).toBeGreaterThanOrEqual(0.5);
    expect(run(2.2)).toBeLessThan(0.5);
  });

  it('a singer who never blooms gets bloomOnCueScore 0 (not null) and an unclean boundary', () => {
    const track = makeTrack({ duration: 3, midi: () => 60, jitterCents: 4, seed: 5 });
    const r = analyzeSwitch(track, bloomCues(1.5, 3));
    expect(r.boundaries[0].latencyMs).toBeNull();
    expect(r.boundaries[0].clean).toBe(false);
    expect(r.bloomOnCueLatencyMs).toBeNull();
    expect(r.bloomOnCueScore).toBe(0);
    expect(r.switchCleanRate).toBe(0);
    expect(r.windows.map((w) => w.actual)).toEqual(['straight', 'straight']);
  });

  it('jumping the gun: vibrato already running 0.6 s BEFORE the cue is not a clean bloom on cue', () => {
    const track = makeTrack({ duration: 4, midi: withVibrato(() => 60, RATE, EXT, 0.9), jitterCents: 4, seed: 5 });
    const r = analyzeSwitch(track, bloomCues(1.5, 4));
    expect(r.boundaries[0].latencyMs!).toBeLessThan(-400);
    expect(r.boundaries[0].clean).toBe(false);
    expect(r.bloomOnCueScore!).toBeLessThan(1);
    expect(r.windows[0].vibratoFraction).toBeGreaterThan(0.3); // and the supposedly straight window was not
  });

  it('anticipating the cue by 150 ms is fine', () => {
    const track = makeTrack({ duration: 4, midi: withVibrato(() => 60, RATE, EXT, 1.35), jitterCents: 4, seed: 5 });
    const r = analyzeSwitch(track, bloomCues(1.5, 4));
    expect(r.boundaries[0].clean).toBe(true);
    expect(r.bloomOnCueScore).toBe(1);
  });

  it('the straight part must actually be straight for the window to read straight', () => {
    const track = makeTrack({ duration: 4, midi: withVibrato(() => 60, RATE, EXT, 0), jitterCents: 4, seed: 5 }); // vibrato throughout
    const r = analyzeSwitch(track, bloomCues(2, 4));
    expect(r.windows[0].cue).toBe('straight');
    expect(r.windows[0].actual).toBe('vibrato');
    expect(r.windows[0].vibratoFraction).toBeGreaterThan(0.8);
  });
});

describe('analyzeSwitch: a bloom BEFORE the cue', () => {
  /** Straight cue to 2.0 s, vibrato cue after; the singer's vibrato starts `early` seconds before the cue. */
  const bloomScore = (early: number) =>
    analyzeSwitch(makeTrack({ duration: 4.5, midi: withVibrato(() => 60, RATE, EXT, 2.0 - early), jitterCents: 4, seed: 5 }), bloomCues(2.0, 4.5)).bloomOnCueScore!;

  // The early-bloom constants are module-local and PROVISIONAL, so this pins the SHAPE of the penalty, not its numbers:
  // free inside the anticipation allowance, a falling score past it, nothing left a little later still, never rising on the way.
  it('a bloom a little early (0.2 s) scores 1, 0.4 s early costs something but still scores over half, and 1.0 s early scores nothing', () => {
    expect(bloomScore(0.2)).toBe(1);
    const a = bloomScore(0.4);
    expect(a).toBeGreaterThan(0.5);
    expect(a).toBeLessThan(1);
    expect(bloomScore(1.0)).toBe(0);
  });

  it('the earlier the bloom, the lower (never higher) the score, from on the cue to well before it', () => {
    let previous = 1;
    for (const early of [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.8, 1.0, 1.2]) {
      const s = bloomScore(early);
      expect(s, `${early} s early`).toBeLessThanOrEqual(previous + 1e-9);
      expect(s, `${early} s early`).toBeGreaterThanOrEqual(0);
      previous = s;
    }
    expect(previous).toBe(0);
  });
});

describe('analyzeSwitch: on/off switching', () => {
  const cues4 = (len = 2): VibratoCue[] => [0, 1, 2, 3].map((i) => ({ start: i * len, end: (i + 1) * len, vibrato: i % 2 === 0 }));

  it('four windows (on, off, on, off) switched on the cue: every boundary clean, switchCleanRate 1', () => {
    const track = makeTrack({ duration: 8, midi: contour([[0, 2], [4, 6]]), jitterCents: 4, seed: 5 });
    const r = analyzeSwitch(track, cues4());
    expect(r.windows.map((w) => w.actual)).toEqual(['vibrato', 'straight', 'vibrato', 'straight']);
    expect(r.boundaries.map((b) => b.toVibrato)).toEqual([false, true, false]);
    expect(r.boundaries.every((b) => b.clean)).toBe(true);
    expect(r.switchCleanRate).toBe(1);
    // the straight -> vibrato boundary is also scored as a bloom
    expect(r.bloomOnCueScore).toBe(1);
  });

  it('latencies are signed and sensible at each boundary, on the off switches too', () => {
    const track = makeTrack({ duration: 8, midi: contour([[0, 2.3], [4.3, 6.3]]), jitterCents: 4, seed: 5 }); // 0.3 s slow every time
    const r = analyzeSwitch(track, cues4());
    for (const b of r.boundaries) expect(Math.abs(b.latencyMs! - 300), `t=${b.t}`).toBeLessThan(120);
    expect(r.switchCleanRate).toBe(1);
  });

  it('a 0.9 s reaction is not a clean switch; neither is switching 0.6 s early', () => {
    const slow = analyzeSwitch(makeTrack({ duration: 8, midi: contour([[0, 2.9], [4.9, 6.9]]), jitterCents: 4, seed: 5 }), cues4());
    expect(slow.switchCleanRate!).toBeLessThan(0.5);
    const early = analyzeSwitch(makeTrack({ duration: 8, midi: contour([[0, 1.4], [3.4, 5.4]]), jitterCents: 4, seed: 5 }), cues4());
    expect(early.switchCleanRate!).toBeLessThan(0.5);
  });

  it('switchCleanRate is the fraction of boundaries that were clean', () => {
    // first two switches on time, the last (vibrato -> straight at 6 s) never happens: vibrato runs to the end
    const track = makeTrack({ duration: 8, midi: contour([[0, 2], [4, 8]]), jitterCents: 4, seed: 5 });
    const r = analyzeSwitch(track, cues4());
    expect(r.boundaries.map((b) => b.clean)).toEqual([true, true, false]);
    expect(r.switchCleanRate).toBeCloseTo(2 / 3, 6);
  });

  it('a singer who stays straight through the whole drill does NOT get credit for the "off" switches', () => {
    const track = makeTrack({ duration: 8, midi: () => 60, jitterCents: 4, seed: 5 });
    const r = analyzeSwitch(track, cues4());
    expect(r.switchCleanRate).toBe(0);
    expect(r.boundaries.every((b) => !b.clean)).toBe(true);
    expect(r.bloomOnCueScore).toBe(0);
  });

  it('a singer who stays in vibrato throughout does not get credit for the "on" switches either', () => {
    const track = makeTrack({ duration: 8, midi: contour([[0, 8]]), jitterCents: 4, seed: 5 });
    const r = analyzeSwitch(track, cues4());
    expect(r.switchCleanRate!).toBeLessThan(0.5);
  });

  it('survives 6 c RMS jitter', () => {
    const track = makeTrack({ duration: 8, midi: contour([[0, 2], [4, 6]]), jitterCents: 6, seed: 8 });
    const r = analyzeSwitch(track, cues4());
    expect(r.switchCleanRate).toBe(1);
  });

  it('a break in the sound at the switch (a 150 ms re-attack) makes it unclean even if the state changed on time', () => {
    const track = makeTrack({ duration: 4, midi: (t) => (t >= 1.95 && t < 2.1 ? NaN : contour([[2, 4]])(t)), jitterCents: 4, seed: 5 });
    const r = analyzeSwitch(track, bloomCues(2, 4));
    expect(r.boundaries[0].reattacked).toBe(true);
    expect(r.boundaries[0].clean).toBe(false);
    expect(r.boundaries[0].latencyMs).not.toBeNull();
  });

  it('a two-frame detector dropout at the switch is not a re-attack', () => {
    const track = makeTrack({ duration: 4, midi: contour([[2, 4]]), jitterCents: 4, seed: 5 }).map((f) => (f.t > 2.04 && f.t < 2.06 ? { ...f, voiced: false } : f));
    const r = analyzeSwitch(track, bloomCues(2, 4));
    expect(r.boundaries[0].reattacked).toBe(false);
    expect(r.boundaries[0].clean).toBe(true);
  });
});

describe('analyzeSwitch: the plan', () => {
  it('only CONTIGUOUS cue changes are switches: a rest between two notes is not a boundary, and each note\'s bloom is scored', () => {
    // note 1: straight 0-1.5, vibrato 1.5-3; rest; note 2 (a new pitch): straight 5-6.5, vibrato 6.5-8
    const m1 = contour([[1.5, 3]], (t) => t < 3);
    const m2 = contour([[6.5, 8]], (t) => t >= 5 && t < 8);
    const track = makeTrack({ duration: 8, midi: (t) => (t < 3 ? m1(t) : m2(t) + 2), jitterCents: 4, seed: 5 });
    const cues: VibratoCue[] = [
      { start: 0, end: 1.5, vibrato: false },
      { start: 1.5, end: 3, vibrato: true },
      { start: 5, end: 6.5, vibrato: false },
      { start: 6.5, end: 8, vibrato: true },
    ];
    const r = analyzeSwitch(track, cues);
    expect(r.boundaries.map((b) => b.t)).toEqual([1.5, 6.5]);
    expect(r.switchCleanRate).toBe(1);
    expect(r.bloomOnCueScore).toBe(1);
    expect(r.windows.map((w) => w.actual)).toEqual(['straight', 'vibrato', 'straight', 'vibrato']);
  });

  it('bloomOnCueLatencyMs is the mean latency over the blooms that happened; the score averages in the ones that did not', () => {
    // bloom 1 on cue (1.5), bloom 2 never happens
    const m1 = contour([[1.5, 3]], (t) => t < 3);
    const track = makeTrack({ duration: 8, midi: (t) => (t < 3 ? m1(t) : t >= 5 ? 62 : NaN), jitterCents: 4, seed: 5 });
    const cues: VibratoCue[] = [
      { start: 0, end: 1.5, vibrato: false },
      { start: 1.5, end: 3, vibrato: true },
      { start: 5, end: 6.5, vibrato: false },
      { start: 6.5, end: 8, vibrato: true },
    ];
    const r = analyzeSwitch(track, cues);
    expect(Math.abs(r.bloomOnCueLatencyMs!)).toBeLessThan(150);
    expect(r.bloomOnCueScore!).toBeCloseTo(0.5, 6);
    expect(r.switchCleanRate).toBe(0.5);
  });

  it('merges back-to-back same-state cues and tolerates unsorted or degenerate input', () => {
    const track = makeTrack({ duration: 4, midi: withVibrato(() => 60, RATE, EXT, 2), jitterCents: 4, seed: 5 });
    const shuffled: VibratoCue[] = [
      { start: 2, end: 4, vibrato: true },
      { start: 1, end: 1, vibrato: false }, // zero length: dropped
      { start: 0, end: 2, vibrato: false },
    ];
    const r = analyzeSwitch(track, shuffled);
    expect(r.windows.length).toBe(2);
    expect(r.windows[0].cue).toBe('straight');
    expect(r.boundaries.length).toBe(1);
    expect(r.boundaries[0].clean).toBe(true);
  });

  it('a plan with one window (or none) has nothing to switch: null rates, not a throw', () => {
    const track = makeTrack({ duration: 3, midi: withVibrato(() => 60, RATE, EXT), jitterCents: 4, seed: 5 });
    const one = analyzeSwitch(track, [{ start: 0, end: 3, vibrato: true }]);
    expect(one.boundaries).toEqual([]);
    expect(one.switchCleanRate).toBeNull();
    expect(one.bloomOnCueScore).toBeNull();
    expect(one.bloomOnCueLatencyMs).toBeNull();
    expect(one.windows[0].actual).toBe('vibrato');
    const none = analyzeSwitch(track, []);
    expect(none.windows).toEqual([]);
    expect(none.switchCleanRate).toBeNull();
  });

  it('a window with no voice is "silent"; empty or all-unvoiced tracks do not throw', () => {
    const silent = makeTrack({ duration: 3, midi: () => NaN });
    const r = analyzeSwitch(silent, bloomCues(1.5, 3));
    expect(r.windows.map((w) => w.actual)).toEqual(['silent', 'silent']);
    expect(r.boundaries[0].clean).toBe(false);
    expect(() => analyzeSwitch([], bloomCues(1.5, 3))).not.toThrow();
  });

  it('is deterministic and does not mutate the track', () => {
    const track = makeTrack({ duration: 4, midi: withVibrato(() => 60, RATE, EXT, 2), jitterCents: 4, seed: 5 });
    const copy = track.map((f) => ({ ...f }));
    expect(analyzeSwitch(track, bloomCues(2, 4))).toEqual(analyzeSwitch(track, bloomCues(2, 4)));
    expect(track).toEqual(copy);
  });
});
