import { describe, expect, it } from 'vitest';
import type { PitchFrame, TargetNote } from '../core/types';
import { alignNotesDtw, foldToNearestOctave, octaveFoldedDistance, type DtwNote } from './dtw';
import { makeTrack, notesMidi, sustained } from './fixtures';
import { framerStyleUnvoiced, makeSung, runNotes } from './advanced-test-helpers';
import { centsOff } from '../core/music';
import { seededRandom } from '../dsp/test-signals';

const NOTES: TargetNote[] = [
  sustained(60, 0, 0.2),
  sustained(64, 0.2, 0.4),
  sustained(67, 0.4, 0.6),
  sustained(71, 0.6, 0.8),
  sustained(74, 0.8, 1.0),
];

/** Per note: the median pitch of the frames assigned to it. */
function assignedMedians(track: readonly PitchFrame[], frameToNote: Int32Array, m: number): Array<number | null> {
  const lists: number[][] = Array.from({ length: m }, () => []);
  frameToNote.forEach((j, i) => {
    if (j >= 0) lists[j].push(track[i].midi);
  });
  return lists.map((l) => (l.length === 0 ? null : l.slice().sort((a, b) => a - b)[l.length >> 1]));
}

describe('alignNotesDtw', () => {
  it('aligns a perfectly timed take to the right note, in order', () => {
    const track = makeTrack({ duration: 1.0, midi: notesMidi(NOTES) });
    const al = alignNotesDtw(track, NOTES, { bandMs: 150 });
    const meds = assignedMedians(track, al.frameToNote, NOTES.length);
    NOTES.forEach((n, i) => {
      expect(al.ranges[i]).not.toBeNull();
      expect(Math.abs(centsOff(meds[i] as number, n.midi))).toBeLessThan(30);
      expect(Math.abs(al.onsetOffsetMs[i] as number)).toBeLessThan(25);
    });
  });

  it('tolerates +80 ms of uniform lateness without swapping neighbours, and reports it', () => {
    const offset = 0.08;
    const track = makeTrack({ duration: 1.0 + offset, midi: (t) => notesMidi(NOTES)(t - offset) });
    const al = alignNotesDtw(track, NOTES, { bandMs: 150 });
    const meds = assignedMedians(track, al.frameToNote, NOTES.length);
    NOTES.forEach((n, i) => {
      expect(Math.abs(centsOff(meds[i] as number, n.midi))).toBeLessThan(30);
      expect(Math.abs((al.onsetOffsetMs[i] as number) - 80)).toBeLessThan(25);
    });
  });

  it('tolerates -80 ms (singer ahead of the beat) including the first and last notes', () => {
    const offset = -0.08;
    const track = makeTrack({ duration: 1.0, midi: (t) => notesMidi(NOTES)(t - offset) });
    const al = alignNotesDtw(track, NOTES, { bandMs: 150 });
    const meds = assignedMedians(track, al.frameToNote, NOTES.length);
    NOTES.forEach((n, i) => {
      expect(al.ranges[i]).not.toBeNull();
      expect(Math.abs(centsOff(meds[i] as number, n.midi))).toBeLessThan(30);
    });
    expect(al.onsetOffsetMs[2] as number).toBeCloseTo(-80, -1);
  });

  it('tolerates a progressive drift (a singer who gradually falls behind by up to 100 ms)', () => {
    const notes = runNotes([60, 63, 65, 67, 70, 67, 65, 63, 60, 63], 6, 0.2);
    const warp = (t: number): number => t - 0.2 - (0.1 * (t - 0.2)) / 1.7; // 0 -> ~100 ms late by the last note
    const track = makeTrack({ duration: 2.3, midi: (t) => notesMidi(notes)(warp(t) + 0.2) });
    const al = alignNotesDtw(track, notes, { bandMs: 150 });
    const meds = assignedMedians(track, al.frameToNote, notes.length);
    notes.forEach((n, i) => expect(Math.abs(centsOff(meds[i] as number, n.midi))).toBeLessThan(30));
    expect(al.onsetOffsetMs[9] as number).toBeGreaterThan(al.onsetOffsetMs[1] as number);
  });

  it('leaves an unsung note empty and does not let its neighbours absorb the wrong frames', () => {
    const sparse = (t: number): number => {
      if (t >= 0 && t < 0.2) return 60;
      if (t >= 0.4 && t < 0.6) return 67; // note 1 (0.2-0.4) is never sung
      if (t >= 0.6 && t < 0.8) return 71;
      if (t >= 0.8 && t < 1.0) return 74;
      return NaN;
    };
    const track = makeTrack({ duration: 1.0, midi: sparse });
    const al = alignNotesDtw(track, NOTES, { bandMs: 150 });
    expect(al.ranges[1]).toBeNull();
    expect(al.onsetOffsetMs[1]).toBeNull();
    for (const i of [0, 2, 3, 4]) expect(al.ranges[i]).not.toBeNull();
    const meds = assignedMedians(track, al.frameToNote, NOTES.length);
    expect(meds[0]).toBeCloseTo(60, 6);
    expect(meds[2]).toBeCloseTo(67, 6);
  });

  it('assigns a wrong-pitch passage to the nearest note that can hold it, never out of order', () => {
    const track = makeTrack({ duration: 1.0, midi: (t) => (t >= 0.4 && t < 0.6 ? 69 : notesMidi(NOTES)(t)) }); // note 2 sung 2 semitones sharp of 67
    const al = alignNotesDtw(track, NOTES, { bandMs: 150 });
    let prev = -1;
    for (const j of al.frameToNote) {
      if (j < 0) continue;
      expect(j).toBeGreaterThanOrEqual(prev);
      prev = j;
    }
  });

  it('only considers frames inside a corridor: a note sung far outside it is unaligned', () => {
    const track = makeTrack({ duration: 2, midi: (t) => (t >= 1.2 && t < 1.4 ? 64 : NaN) }); // note 1 (0.2-0.4) sung 1 s late
    const al = alignNotesDtw(track, NOTES.slice(0, 2), { bandMs: 150 });
    expect(al.ranges[1]).toBeNull();
    expect(al.frameToNote.every((j) => j === -1)).toBe(true);
  });

  it('a wider corridor reaches a later note', () => {
    const track = makeTrack({ duration: 2, midi: (t) => (t >= 0.6 && t < 0.8 ? 64 : NaN) }); // note 1 (0.2-0.4) sung 0.4 s late: past a 150 ms corridor (ends 0.55), inside a 400 ms one
    expect(alignNotesDtw(track, NOTES.slice(0, 2), { bandMs: 150 }).ranges[1]).toBeNull();
    expect(alignNotesDtw(track, NOTES.slice(0, 2), { bandMs: 400 }).ranges[1]).not.toBeNull();
  });

  it('octaveFoldedDistance treats an octave-down rendition as a perfect match, and the DTW honours it', () => {
    expect(octaveFoldedDistance(48, 60)).toBeCloseTo(0, 5);
    expect(octaveFoldedDistance(72.5, 60)).toBeCloseTo(50, 5);
    expect(octaveFoldedDistance(61, 60)).toBeCloseTo(100, 5);
    expect(foldToNearestOctave(48.3, 60)).toBeCloseTo(60.3, 6);
    expect(foldToNearestOctave(84.3, 60)).toBeCloseTo(60.3, 6);

    // A phrase an octave low aligns like one at pitch only when folded.
    const down = makeTrack({ duration: 1.0, midi: (t) => notesMidi(NOTES)(t) - 12 });
    const folded = alignNotesDtw(down, NOTES, { bandMs: 150, pitchDistanceCents: octaveFoldedDistance });
    expect(folded.totalCost).toBeLessThan(5);
    const plain = alignNotesDtw(down, NOTES, { bandMs: 150 });
    expect(plain.totalCost).toBeGreaterThan(1000);
  });

  it('frameToNote and ranges agree, and every voiced in-corridor frame is assigned', () => {
    const track = makeSung(runNotes([60, 63, 65, 67, 63], 6, 0.2), { jitterCents: 8 });
    const notes = runNotes([60, 63, 65, 67, 63], 6, 0.2);
    const al = alignNotesDtw(track, notes, { bandMs: 150 });
    notes.forEach((n, j) => {
      const r = al.ranges[j];
      expect(r).not.toBeNull();
      if (!r) return;
      for (let i = r.startIdx; i < r.endIdx; i++) if (track[i].voiced) expect(al.frameToNote[i]).toBe(j);
      expect(al.onsetOffsetMs[j]).toBeCloseTo((track[r.startIdx].t - n.start) * 1000, 6);
    });
    track.forEach((f, i) => {
      if (!f.voiced) return expect(al.frameToNote[i]).toBe(-1);
      const inAnyBand = notes.some((n) => f.t >= n.start - 0.15 && f.t <= n.end + 0.15);
      if (inAnyBand) expect(al.frameToNote[i]).toBeGreaterThanOrEqual(0);
    });
  });

  it('is deterministic', () => {
    const track = makeSung(runNotes([60, 63, 65, 67, 63], 9, 0.2), { jitterCents: 10, seed: 3 });
    const notes = runNotes([60, 63, 65, 67, 63], 9, 0.2);
    const a = alignNotesDtw(track, notes, { bandMs: 150 });
    const b = alignNotesDtw(track, notes, { bandMs: 150 });
    expect(Array.from(a.frameToNote)).toEqual(Array.from(b.frameToNote));
    expect(a.totalCost).toBe(b.totalCost);
  });

  it('returns empty, non-throwing results for empty inputs and silence', () => {
    expect(alignNotesDtw([], NOTES, { bandMs: 150 }).ranges).toEqual(NOTES.map(() => null));
    const none = alignNotesDtw(makeTrack({ duration: 0.5, midi: () => 60 }), [], { bandMs: 150 });
    expect(none.ranges).toEqual([]);
    expect(none.frameToNote.every((j) => j === -1)).toBe(true);
    const silent = alignNotesDtw(makeTrack({ duration: 1, midi: () => NaN }), NOTES, { bandMs: 150 });
    expect(silent.ranges.every((r) => r === null)).toBe(true);
    expect(silent.totalCost).toBe(0);
  });

  it('handles a single note, zero-length notes and overlapping notes without throwing', () => {
    const track = makeTrack({ duration: 1, midi: () => 60 });
    expect(alignNotesDtw(track, [sustained(60, 0, 1)], { bandMs: 100 }).ranges[0]).not.toBeNull();
    expect(() => alignNotesDtw(track, [sustained(60, 0.5, 0.5), sustained(62, 0.5, 0.5)], { bandMs: 100 })).not.toThrow();
    expect(() => alignNotesDtw(track, [sustained(60, 0, 0.6), sustained(62, 0.4, 1)], { bandMs: 100 })).not.toThrow();
  });

  it('matches a brute-force full-table DP on random sung-like inputs (optimal cost, all rules)', () => {
    const rand = seededRandom(20261021);
    const TIME_PEN = 30;
    const CAP = 600;
    for (let trial = 0; trial < 60; trial++) {
      // random ordered notes
      const m = 1 + Math.floor(rand() * 7);
      const notes: DtwNote[] = [];
      let t = 0.1 + rand() * 0.2;
      for (let j = 0; j < m; j++) {
        const dur = 0.08 + rand() * 0.35;
        notes.push({ midi: 50 + Math.floor(rand() * 20), start: t, end: t + dur });
        t += dur + (rand() < 0.4 ? rand() * 0.2 : 0);
      }
      // random singer: per note timing offset, sometimes silent, sometimes wrong pitch, plus stray voiced noise
      const offsets = notes.map(() => (rand() - 0.5) * 0.2);
      const mode = notes.map(() => rand());
      const total = t + 0.4;
      const track = makeTrack({
        duration: total,
        seed: trial + 1,
        jitterCents: 10,
        midi: (tt) => {
          for (let j = 0; j < m; j++) {
            if (tt >= notes[j].start + offsets[j] && tt < notes[j].end + offsets[j]) {
              if (mode[j] < 0.12) return NaN;
              if (mode[j] < 0.25) return notes[j].midi + 2 + 3 * rand();
              return notes[j].midi;
            }
          }
          return rand() < 0.04 ? 55 + 15 * rand() : NaN;
        },
      });
      const bandMs = 100 + Math.floor(rand() * 100);
      const al = alignNotesDtw(track, notes, { bandMs, timePenaltyCents: TIME_PEN, maxFrameCostCents: CAP });

      // reference
      const band = bandMs / 1000;
      const n = track.length;
      const inBand = (i: number, j: number): boolean => track[i].t >= notes[j].start - band && track[i].t <= notes[j].end + band + 1e-9;
      const cost = (i: number, j: number): number => {
        const d = Math.min(CAP, Math.abs(centsOff(track[i].midi, notes[j].midi)));
        const over = Math.max(0, notes[j].start - track[i].t, track[i].t - notes[j].end);
        return d + TIME_PEN * Math.min(1, over / band);
      };
      const freeOk = (i: number): boolean => {
        if (!track[i].voiced) return true;
        for (let j = 0; j < m; j++) if (inBand(i, j)) return false;
        return true;
      };
      const f: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(Infinity));
      f[0][0] = 0;
      for (let i = 0; i <= n; i++) {
        for (let j = 0; j <= m; j++) {
          if (i === 0 && j === 0) continue;
          let best = Infinity;
          if (j > 0) best = Math.min(best, f[i][j - 1]);
          if (i > 0) {
            if (j > 0 && track[i - 1].voiced && inBand(i - 1, j - 1)) best = Math.min(best, f[i - 1][j] + cost(i - 1, j - 1));
            if (freeOk(i - 1)) best = Math.min(best, f[i - 1][j]);
          }
          f[i][j] = best;
        }
      }
      expect(al.totalCost).toBeCloseTo(f[n][m], 6);

      // the reported assignment must itself realise that cost
      let realised = 0;
      let prevJ = -1;
      for (let i = 0; i < n; i++) {
        const j = al.frameToNote[i];
        if (j >= 0) {
          expect(j).toBeGreaterThanOrEqual(prevJ);
          expect(track[i].voiced && inBand(i, j)).toBe(true);
          realised += cost(i, j);
          prevJ = j;
        } else if (track[i].voiced) {
          expect(freeOk(i)).toBe(true);
        }
      }
      expect(realised).toBeCloseTo(al.totalCost, 6);
    }
  });

  it('aligns a four-minute song (22k frames, 480 notes) quickly', () => {
    const notes = runNotes(
      Array.from({ length: 480 }, (_, i) => 55 + ((i * 7) % 12)),
      2,
      0.5,
    );
    const track = makeTrack({ duration: 242, midi: notesMidi(notes), jitterCents: 8 });
    const t0 = performance.now();
    const al = alignNotesDtw(track, notes, { bandMs: 200 });
    const ms = performance.now() - t0;
    expect(al.ranges.every((r) => r !== null)).toBe(true);
    expect(ms).toBeLessThan(800); // ~4-45 ms measured; only catches pathological complexity
  });
});

describe('alignNotesDtw: frames as the real Framer emits them (TA-13)', () => {
  // The Framer fills midi/f0 for EVERY frame, voiced or not: an unvoiced frame carries the detector's low-confidence guess. Only `voiced`
  // says whether to use it. Fixtures mark unvoiced frames NaN, which would hide an analyzer reading "finite pitch" as "voiced".
  const notes = runNotes([60, 63, 65, 67, 70, 67], 6, 0.2);

  function takeWithBreaths(): PitchFrame[] {
    const contour = makeSung(notes, { jitterCents: 6, seed: 4 });
    // breaths: no voice for 4 frames before notes 2 and 4, and a dropout inside note 3
    const gaps: Array<[number, number]> = [[0.2 + 2 / 6 - 0.045, 0.2 + 2 / 6], [0.2 + 4 / 6 - 0.045, 0.2 + 4 / 6], [0.2 + 3 / 6 + 0.06, 0.2 + 3 / 6 + 0.1]];
    return contour.map((f) => (gaps.some(([a, b]) => f.t >= a && f.t < b) ? { ...f, voiced: false, midi: NaN, f0Hz: NaN, centsFromNearest: NaN, confidence: 0.1 } : f));
  }

  it('the track really has unvoiced frames, and the helper gives them finite low-confidence pitches', () => {
    const nan = takeWithBreaths();
    const finite = framerStyleUnvoiced(nan);
    const unvoiced = nan.map((f, i) => (f.voiced ? -1 : i)).filter((i) => i >= 0);
    expect(unvoiced.length).toBeGreaterThanOrEqual(10);
    for (const i of unvoiced) {
      expect(Number.isNaN(nan[i].midi)).toBe(true);
      expect(Number.isFinite(finite[i].midi)).toBe(true);
      expect(finite[i].voiced).toBe(false);
      expect(finite[i].confidence).toBeLessThan(0.8);
    }
    nan.forEach((f, i) => {
      if (f.voiced) expect(finite[i]).toBe(f);
    });
  });

  for (const seed of [1, 2, 3]) {
    it(`aligns the same with NaN gaps and with finite random pitches in them (guess seed ${seed})`, () => {
      const nan = takeWithBreaths();
      const finite = framerStyleUnvoiced(nan, seed);
      const a = alignNotesDtw(nan, notes, { bandMs: 150 });
      const b = alignNotesDtw(finite, notes, { bandMs: 150 });
      expect(Array.from(b.frameToNote)).toEqual(Array.from(a.frameToNote));
      expect(b.ranges).toEqual(a.ranges);
      expect(b.onsetOffsetMs).toEqual(a.onsetOffsetMs);
      expect(b.totalCost).toBe(a.totalCost);
      expect(b.cells).toBe(a.cells);
      expect(b.activeFrames).toBe(a.activeFrames);
    });
  }

  it('an unvoiced frame never gets assigned to a note, whatever pitch it carries', () => {
    const finite = framerStyleUnvoiced(takeWithBreaths());
    const al = alignNotesDtw(finite, notes, { bandMs: 150 });
    finite.forEach((f, i) => {
      if (!f.voiced) expect(al.frameToNote[i]).toBe(-1);
    });
  });
});
