import { describe, expect, it } from 'vitest';
import type { PitchFrame, TargetNote } from '../core/types';
import { CONFIG } from '../config';
import { alignedNoteStats, analyzeRun } from './runs';
import { FRAME_RATE, makeTrack, sustained } from './fixtures';
import { framerStyleUnvoiced, makeSung, runNotes, sungContour } from './advanced-test-helpers';
import type { AnalyzeContext, RunNoteVerdict } from './types';

const CTX: AnalyzeContext = { toleranceCents: 25, vibratoStyle: 'pop' };
const PATTERN = [60, 63, 65, 67, 70, 67, 65, 63]; // eight notes: minor pentatonic up and back down
const TEMPOS = [3, 6, 9] as const;

type Contour = (t: number) => number;

function sing(notes: readonly TargetNote[], midi: Contour, jitter = 6, seed = 7): PitchFrame[] {
  return makeTrack({ duration: notes[notes.length - 1].end + 0.2, midi, jitterCents: jitter, seed });
}

/** The clean, finite-move contour of `notes`, with a hook to rewrite part of it. */
function sung(notes: readonly TargetNote[], rewrite?: (t: number, base: number) => number): Contour {
  const base = sungContour(notes, 30);
  return rewrite ? (t) => rewrite(t, base(t)) : base;
}

const inSlot = (n: TargetNote, t: number): boolean => t >= n.start && t < n.end;

/** Note i swooped straight through: the pitch ramps across its whole slot from the previous note's pitch to the next note's. */
function swoop(notes: readonly TargetNote[], i: number): Contour {
  const n = notes[i];
  const a = notes[i - 1].midi;
  const b = notes[i + 1].midi;
  return sung(notes, (t, base) => (inSlot(n, t) ? a + (b - a) * ((t - n.start) / (n.end - n.start)) : base));
}

/** Note i approached by a long slide: it takes `share` of its slot to reach the pitch. */
function slideIn(notes: readonly TargetNote[], i: number, share: number): Contour {
  const n = notes[i];
  const a = notes[i - 1].midi;
  const reach = n.start + share * (n.end - n.start);
  return sung(notes, (t, base) => (t >= n.start && t < reach ? a + (n.midi - a) * ((t - n.start) / (reach - n.start)) : inSlot(n, t) ? n.midi : base));
}

const silent = (notes: readonly TargetNote[], i: number): Contour => sung(notes, (t, base) => (inSlot(notes[i], t) ? NaN : base));
const wrong = (notes: readonly TargetNote[], i: number, semis: number): Contour => sung(notes, (t, base) => (inSlot(notes[i], t) ? notes[i].midi + semis : base));
const heldPrevious = (notes: readonly TargetNote[], i: number): Contour => sung(notes, (t, base) => (inSlot(notes[i], t) ? notes[i - 1].midi : base));

function verdicts(r: ReturnType<typeof analyzeRun>): RunNoteVerdict[] {
  return r.notes.map((n) => n.verdict);
}

describe('analyzeRun: clean runs', () => {
  for (const nps of TEMPOS) {
    it(`labels every note of a clean ${nps} notes/s run defined, and scores it high`, () => {
      const notes = runNotes(PATTERN, nps, 0.2);
      const r = analyzeRun(sing(notes, sung(notes)), notes, CTX);
      expect(r.notes).toHaveLength(notes.length);
      expect(verdicts(r)).toEqual(notes.map(() => 'defined'));
      for (const n of r.notes) {
        expect(n.reached).toBe(true);
        expect(n.reachedMs).toBeGreaterThanOrEqual(CONFIG.runs.reachedMinMs);
        expect(n.definition).toBeGreaterThan(0.8);
        expect(Math.abs(n.medianErrorCents as number)).toBeLessThan(15);
        expect(Math.abs(n.timingErrorMs as number)).toBeLessThan(30);
      }
      expect(r.score).toBeGreaterThan(0.9);
      expect(r.score).toBeLessThanOrEqual(1);
      expect(r.components.reached).toBe(1);
    });
  }

  it('indexes notes and carries their target pitches', () => {
    const notes = runNotes(PATTERN, 6, 0.2);
    const r = analyzeRun(sing(notes, sung(notes)), notes, CTX);
    r.notes.forEach((n, i) => {
      expect(n.index).toBe(i);
      expect(n.targetMidi).toBe(PATTERN[i]);
    });
  });

  it('is stable across noise seeds (12 c jitter)', () => {
    const notes = runNotes(PATTERN, 6, 0.2);
    for (let seed = 1; seed <= 15; seed++) {
      const r = analyzeRun(sing(notes, sung(notes), 12, seed), notes, CTX);
      expect(verdicts(r)).toEqual(notes.map(() => 'defined'));
    }
  });
});

describe('analyzeRun: one smeared and one missed note, at 3, 6 and 9 notes/s', () => {
  for (const nps of TEMPOS) {
    it(`labels a note swooped through as smeared and a silent note as missed at ${nps} notes/s`, () => {
      const notes = runNotes(PATTERN, nps, 0.2);
      const smeared = swoop(notes, 3);
      const both = (t: number): number => (inSlot(notes[5], t) ? NaN : smeared(t)); // note 3 swooped, note 5 silent
      const r = analyzeRun(sing(notes, both), notes, CTX);
      expect(verdicts(r)).toEqual(['defined', 'defined', 'defined', 'smeared', 'defined', 'missed', 'defined', 'defined']);
      expect(r.notes[5].medianErrorCents).toBeNull();
      expect(r.notes[5].timingErrorMs).toBeNull();
      expect(r.notes[3].definition).toBeLessThan(0.6);
      // the clean notes around them are untouched
      for (const i of [0, 1, 2, 4, 6, 7]) expect(r.notes[i].verdict).toBe('defined');
      expect(r.score).toBeLessThan(0.85); // below the tempo-advance bar
    });

    it(`labels a long slide into a note as smeared at ${nps} notes/s`, () => {
      const notes = runNotes(PATTERN, nps, 0.2);
      const r = analyzeRun(sing(notes, slideIn(notes, 4, 0.85)), notes, CTX);
      expect(r.notes[4].verdict).toBe('smeared');
      for (const i of [0, 1, 2, 6, 7]) expect(r.notes[i].verdict).toBe('defined');
    });

    it(`labels a skipped note (the previous pitch held through its slot) as missed at ${nps} notes/s`, () => {
      const notes = runNotes(PATTERN, nps, 0.2);
      const r = analyzeRun(sing(notes, heldPrevious(notes, 2)), notes, CTX);
      expect(r.notes[2].verdict).toBe('missed');
      expect(r.notes[1].verdict).toBe('defined');
      expect(r.notes[3].verdict).toBe('defined');
    });

    it(`labels a clearly wrong note (+200 c) as missed, without smearing its neighbours, at ${nps} notes/s`, () => {
      const notes = runNotes(PATTERN, nps, 0.2);
      const r = analyzeRun(sing(notes, wrong(notes, 5, 2)), notes, CTX);
      expect(r.notes[5].verdict).toBe('missed');
      for (const i of [3, 4, 6, 7]) expect(r.notes[i].verdict).toBe('defined');
    });
  }

  it('labels a note that is only about 80 cents flat as smeared (near, not landed), not missed', () => {
    const notes = runNotes(PATTERN, 6, 0.2);
    const r = analyzeRun(sing(notes, wrong(notes, 4, -0.8)), notes, CTX);
    expect(r.notes[4].reached).toBe(false);
    expect(r.notes[4].verdict).toBe('smeared');
  });

  it('a run with a missed note scores below a clean one, and silence scores zero', () => {
    const notes = runNotes(PATTERN, 6, 0.2);
    const clean = analyzeRun(sing(notes, sung(notes)), notes, CTX).score;
    const oneMissed = analyzeRun(sing(notes, silent(notes, 3)), notes, CTX).score;
    const halfMissed = analyzeRun(sing(notes, (t) => (notes.slice(0, 4).some((n) => inSlot(n, t)) ? NaN : sung(notes)(t))), notes, CTX).score;
    const none = analyzeRun(sing(notes, () => NaN), notes, CTX);
    expect(clean).toBeGreaterThan(oneMissed);
    expect(oneMissed).toBeGreaterThan(halfMissed);
    expect(none.score).toBe(0);
    expect(verdicts(none)).toEqual(notes.map(() => 'missed'));
  });
});

describe('analyzeRun: cannot be gamed', () => {
  it('holding one pitch through the whole run does not pass', () => {
    const notes = runNotes(PATTERN, 6, 0.2);
    const r = analyzeRun(sing(notes, (t) => (t >= 0.2 && t < notes[notes.length - 1].end ? 60 : NaN)), notes, CTX);
    expect(r.notes.filter((n) => n.verdict === 'defined').length).toBeLessThanOrEqual(2); // only the notes that happen to be that pitch
    expect(r.score).toBeLessThan(0.5);
  });

  it('sliding up and down continuously through the range does not pass', () => {
    const notes = runNotes(PATTERN, 6, 0.2);
    const sweep = (t: number): number => (t >= 0.2 && t < notes[notes.length - 1].end ? 62 + 8 * Math.sin((t - 0.2) * 2 * Math.PI * 1.2) : NaN);
    const r = analyzeRun(sing(notes, sweep), notes, CTX);
    expect(r.notes.filter((n) => n.verdict === 'defined').length).toBeLessThanOrEqual(3);
    expect(r.score).toBeLessThan(0.7);
  });

  it('a random pitch every 100 ms does not pass', () => {
    const notes = runNotes(PATTERN, 6, 0.2);
    const pitches = [61.7, 66.2, 59.1, 69.4, 64.6, 70.9, 62.3, 68.2, 60.5, 66.9, 63.8, 71.2, 65.5, 58.9];
    const noise = (t: number): number => (t >= 0.2 && t < notes[notes.length - 1].end ? pitches[Math.floor((t - 0.2) / 0.1) % pitches.length] : NaN);
    const r = analyzeRun(sing(notes, noise), notes, CTX);
    expect(r.notes.filter((n) => n.verdict === 'defined').length).toBeLessThanOrEqual(2);
    expect(r.score).toBeLessThan(0.6);
  });

  it('every note 100 cents flat has no defined notes and cannot reach the tempo-advance score', () => {
    const notes = runNotes(PATTERN, 6, 0.2);
    const r = analyzeRun(sing(notes, (t) => sung(notes)(t) - 1), notes, CTX);
    expect(r.notes.filter((n) => n.verdict === 'defined')).toEqual([]);
    expect(r.score).toBeLessThan(CONFIG.runs.tempoAdvanceScore);
  });
});

describe('analyzeRun: timing against the metronome', () => {
  it('reports how late each note changed', () => {
    const notes = runNotes(PATTERN, 4.5, 0.4);
    const late = 0.05;
    const r = analyzeRun(sing(notes, (t) => sung(notes)(t - late)), notes, CTX);
    for (const n of r.notes) expect(Math.abs((n.timingErrorMs as number) - late * 1000)).toBeLessThan(25);
    expect(verdicts(r)).toEqual(notes.map(() => 'defined'));
  });

  it('reports a singer ahead of the beat as negative', () => {
    const notes = runNotes(PATTERN, 4.5, 0.4);
    const r = analyzeRun(sing(notes, (t) => sung(notes)(t + 0.06)), notes, CTX);
    for (const n of r.notes.slice(1)) expect(Math.abs((n.timingErrorMs as number) + 60)).toBeLessThan(25);
  });

  it('scores a take that is on the beat above the same take 80 ms late, which still has every note defined', () => {
    for (const nps of TEMPOS) {
      const notes = runNotes(PATTERN, nps, 0.4);
      const onTime = analyzeRun(sing(notes, sung(notes)), notes, CTX);
      const lateTake = analyzeRun(sing(notes, (t) => sung(notes)(t - 0.08)), notes, CTX);
      expect(verdicts(lateTake)).toEqual(notes.map(() => 'defined'));
      expect(lateTake.components.timing).toBeLessThan(onTime.components.timing);
      expect(lateTake.components.timing).toBeGreaterThan(0.5);
    }
  });

  it('tolerates a singer who gradually falls behind by about 100 ms', () => {
    const notes = runNotes(PATTERN, 6, 0.4);
    const end = notes[notes.length - 1].end;
    const warped = (t: number): number => sung(notes)(t - (0.1 * (t - 0.4)) / (end - 0.4));
    const r = analyzeRun(sing(notes, warped), notes, CTX);
    expect(verdicts(r)).toEqual(notes.map(() => 'defined'));
    expect(r.notes[7].timingErrorMs as number).toBeGreaterThan((r.notes[1].timingErrorMs as number) + 40);
  });

  it('ignores singing before the first note and after the last', () => {
    const notes = runNotes(PATTERN, 6, 1.0);
    const noisy = sung(notes, (t, base) => (Number.isFinite(base) ? base : t < 0.6 || t > notes[notes.length - 1].end + 0.6 ? 58 : NaN));
    const r = analyzeRun(makeTrack({ duration: notes[notes.length - 1].end + 1.2, midi: noisy, jitterCents: 6 }), notes, CTX);
    expect(verdicts(r)).toEqual(notes.map(() => 'defined'));
  });
});

describe('analyzeRun: the level sets how accurate is accurate', () => {
  it('the same 30 c flat run scores better accuracy at the easy level than at studio', () => {
    const notes = runNotes(PATTERN, 4.5, 0.2);
    const flat = sing(notes, (t) => sung(notes)(t) - 0.3);
    const easy = analyzeRun(flat, notes, { toleranceCents: 50, vibratoStyle: 'pop' });
    const std = analyzeRun(flat, notes, CTX);
    const studio = analyzeRun(flat, notes, { toleranceCents: 10, vibratoStyle: 'pop' });
    expect(easy.components.accuracy).toBeGreaterThan(std.components.accuracy);
    expect(std.components.accuracy).toBeGreaterThan(studio.components.accuracy);
    expect(easy.components.accuracy).toBeGreaterThan(0.6);
    expect(studio.components.accuracy).toBeLessThan(0.1);
    // but flatness is not smear: every note is still distinct
    expect(verdicts(studio)).toEqual(notes.map(() => 'defined'));
    expect(studio.notes[0].medianErrorCents as number).toBeLessThan(-20);
  });

  it('combines the four components with CONFIG.runs.weights', () => {
    const notes = runNotes(PATTERN, 6, 0.2);
    const r = analyzeRun(sing(notes, silent(notes, 3)), notes, CTX);
    const w = CONFIG.runs.weights;
    expect(r.score).toBeCloseTo(w.reached * r.components.reached + w.accuracy * r.components.accuracy + w.definition * r.components.definition + w.timing * r.components.timing, 9);
    for (const v of Object.values(r.components)) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });
});

describe('analyzeRun: reached is 40 ms inside +/-50 c', () => {
  /** Three notes; the middle one is on pitch for `onMs` of its 300 ms, and 140 c sharp the rest of the time. */
  function shortTouch(onMs: number) {
    const notes = [sustained(60, 0, 0.3), sustained(65, 0.3, 0.6), sustained(60, 0.6, 0.9)];
    const mid = 0.45;
    const midi = (t: number): number => {
      if (t < 0.3 || t >= 0.6) return t < 0.3 ? 60 : 60;
      return Math.abs(t - mid) <= onMs / 2000 ? 65 : 66.4;
    };
    return analyzeRun(makeTrack({ duration: 1, midi, jitterCents: 0 }), notes, CTX).notes[1];
  }

  it('does not count a touch of 25 ms, and counts one of 70 ms', () => {
    expect(shortTouch(25).reached).toBe(false);
    expect(shortTouch(70).reached).toBe(true);
    expect(shortTouch(70).reachedMs).toBeGreaterThanOrEqual(CONFIG.runs.reachedMinMs);
  });

  it('pins the owner\'s band: a note held 45 c off is reached, one held 55 c off is not (+/-50 c)', () => {
    expect(CONFIG.runs.reachedTolCents).toBe(50);
    const held = (offCents: number) => {
      const notes = [sustained(60, 0, 0.3), sustained(65, 0.3, 0.6), sustained(60, 0.6, 0.9)];
      const midi = (t: number): number => (t >= 0.3 && t < 0.6 ? 65 + offCents / 100 : 60);
      return analyzeRun(makeTrack({ duration: 1, midi, jitterCents: 0 }), notes, CTX).notes[1];
    };
    expect(held(45).reached).toBe(true);
    expect(held(-45).reached).toBe(true);
    expect(held(55).reached).toBe(false);
    expect(held(-55).reached).toBe(false);
  });
});

describe('analyzeRun: housekeeping', () => {
  it('handles no notes, no frames and one note', () => {
    expect(analyzeRun([], [], CTX)).toEqual({ notes: [], score: 0, components: { reached: 0, accuracy: 0, definition: 0, timing: 0 } });
    const none = analyzeRun([], runNotes(PATTERN, 6), CTX);
    expect(none.score).toBe(0);
    expect(verdicts(none)).toEqual(PATTERN.map(() => 'missed'));
    const one = [sustained(60, 0, 0.5)];
    expect(analyzeRun(makeTrack({ duration: 0.6, midi: () => 60 }), one, CTX).notes[0].verdict).toBe('defined');
  });

  it('falls back to the default tolerance if given a non-positive one', () => {
    const notes = runNotes(PATTERN, 6, 0.2);
    const r = analyzeRun(sing(notes, sung(notes)), notes, { toleranceCents: 0, vibratoStyle: 'pop' });
    expect(r.score).toBeGreaterThan(0.9);
  });

  it('exposes the per-note measurements it scores from (alignedNoteStats)', () => {
    const notes = runNotes(PATTERN, 6, 0.2);
    const stats = alignedNoteStats(sing(notes, sung(notes)), notes, CONFIG.runs.dtwBandMs);
    expect(stats).toHaveLength(notes.length);
    for (const s of stats) {
      expect(s.frames).toBeGreaterThan(5);
      expect(s.reachedMs).toBeGreaterThan(80);
      expect(s.closestCents).toBeLessThan(25);
      expect(s.startT).not.toBeNull();
    }
  });

  it('does not mutate the track or the notes', () => {
    const notes = runNotes(PATTERN, 6, 0.2);
    const track = sing(notes, sung(notes));
    const copyT = track.map((f) => ({ ...f }));
    const copyN = notes.map((n) => ({ ...n }));
    analyzeRun(track, notes, CTX);
    expect(track).toEqual(copyT);
    expect(notes).toEqual(copyN);
  });

  it('scores a 30-note run (the Boss Recital length) in a few milliseconds', () => {
    const notes = runNotes(Array.from({ length: 30 }, (_, i) => 55 + ((i * 5) % 11)), 6, 0.2);
    const track = makeSung(notes);
    analyzeRun(track, notes, CTX);
    const t0 = performance.now();
    analyzeRun(track, notes, CTX);
    expect(performance.now() - t0).toBeLessThan(80); // ~2 ms measured; only catches pathological complexity
  });
});

describe('analyzeRun: reached is the longest CONTIGUOUS stretch in band, not the sum of bursts (TA-05)', () => {
  /** One value per frame (NaN = unvoiced) at the real frame rate. */
  const frames = (values: readonly number[]) => makeTrack({ duration: values.length / FRAME_RATE + 1e-4, midi: (t) => values[Math.round(t * FRAME_RATE)] ?? NaN, jitterCents: 0 });
  const rep = (v: number, n: number): number[] => Array.from({ length: n }, () => v);
  const notes = [sustained(60, 0, 0.3), sustained(65, 0.3, 0.6), sustained(60, 0.6, 0.9)];
  /** The middle note: 4 frames 140 c sharp, then `middle`, padded with sharp frames to the end of its slot. */
  const take = (middle: readonly number[]) => frames([...rep(60, 28), ...rep(66.4, 4), ...middle, ...rep(66.4, Math.max(0, 24 - middle.length)), ...rep(60, 30)]);
  const run = (middle: readonly number[]) => analyzeRun(take(middle), notes, CTX);

  it('two 3-frame bursts split by a 6-frame dropout are not a reach (3 frames = 32 ms < 40 ms)', () => {
    const split = run([...rep(65, 3), ...rep(NaN, 6), ...rep(65, 3)]);
    expect(split.notes[1].reachedMs).toBeLessThan(CONFIG.runs.reachedMinMs);
    expect(split.notes[1].reached).toBe(false);
    expect(split.notes[1].verdict).toBe('smeared');
    // the same six frames in one stretch DO reach, and the run scores higher for it
    const joined = run(rep(65, 6));
    expect(joined.notes[1].reachedMs).toBeGreaterThanOrEqual(CONFIG.runs.reachedMinMs);
    expect(joined.notes[1].reached).toBe(true);
    expect(split.score).toBeLessThan(joined.score);
  });

  it('two 2-frame bursts split by a 5-frame dropout are not a reach either', () => {
    const split = run([...rep(65, 2), ...rep(NaN, 5), ...rep(65, 2)]);
    expect(split.notes[1].reachedMs).toBeLessThan(CONFIG.runs.reachedMinMs);
    expect(split.notes[1].reached).toBe(false);
    expect(split.score).toBeLessThan(run(rep(65, 4)).score);
  });

  it('pins the owner\'s 40 ms in frames: 3 frames in band (32 ms) are not a reach, 4 frames (43 ms) are', () => {
    expect(CONFIG.runs.reachedMinMs).toBe(40);
    expect(run(rep(65, 3)).notes[1].reached).toBe(false);
    expect(run(rep(65, 4)).notes[1].reached).toBe(true);
  });

  it('reports the longer of two bursts, not their sum', () => {
    const r = run([...rep(65, 5), ...rep(NaN, 6), ...rep(65, 3)]);
    expect(r.notes[1].reachedMs).toBeGreaterThanOrEqual(CONFIG.runs.reachedMinMs);
    expect(r.notes[1].reachedMs).toBeLessThan(75); // 5 frames = 53 ms; the sum would be 85 ms
  });
});

describe('analyzeRun: frames as the real Framer emits them (TA-13)', () => {
  // An unvoiced Framer frame carries the detector's low-confidence guess, finite and random. Only `voiced` may say whether to use it.
  const notes = runNotes(PATTERN, 6, 0.2);
  const base = sungContour(notes, 30);
  // breaths before notes 2 and 4, and a dropout inside note 5
  const gaps: Array<[number, number]> = [[0.2 + 2 / 6 - 0.05, 0.2 + 2 / 6 + 0.01], [0.2 + 4 / 6 - 0.05, 0.2 + 4 / 6 + 0.01], [0.2 + 5 / 6 + 0.06, 0.2 + 5 / 6 + 0.12]];
  const nanTake = makeTrack({ duration: 2.4, midi: (t) => (gaps.some(([a, b]) => t >= a && t < b) ? NaN : base(t)), jitterCents: 6, seed: 7 });

  it('the take has unvoiced frames', () => {
    expect(nanTake.filter((f) => !f.voiced).length).toBeGreaterThanOrEqual(10);
  });

  for (const seed of [1, 2, 3]) {
    it(`gives the same per-note measurements, verdicts and score with NaN gaps and with finite random pitches in them (seed ${seed})`, () => {
      const finiteTake = framerStyleUnvoiced(nanTake, seed);
      expect(analyzeRun(finiteTake, notes, CTX)).toEqual(analyzeRun(nanTake, notes, CTX));
      expect(alignedNoteStats(finiteTake, notes, CONFIG.runs.dtwBandMs)).toEqual(alignedNoteStats(nanTake, notes, CONFIG.runs.dtwBandMs));
    });
  }

  it('does not let a breath\'s random pitch move a note\'s onset: note 2 changes when the singer changed, not at the detector\'s guess', () => {
    const finiteTake = framerStyleUnvoiced(nanTake, 5);
    const stats = alignedNoteStats(finiteTake, notes, CONFIG.runs.dtwBandMs);
    const clean = alignedNoteStats(nanTake, notes, CONFIG.runs.dtwBandMs);
    for (let j = 0; j < notes.length; j++) expect(stats[j].onsetOffsetMs).toBe(clean[j].onsetOffsetMs);
    expect(Math.abs(stats[1].onsetOffsetMs as number)).toBeLessThan(40);
  });
});
