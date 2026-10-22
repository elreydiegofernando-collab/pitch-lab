/**
 * Runtime guard for the advanced analyzers. Every per-take analyzer must stay far under
 * real time on a 60 s take in node (typically 0.2-8 ms; the ceiling is 60 ms), and song-level
 * scoring on a four-minute song gets 400 ms (typically 4-20 ms). The measured numbers are printed
 * below. The ceilings are ~10x the measurements because they exist to catch an accidental O(n^2),
 * not to benchmark: a tighter bar flakes when other test workers share the machine.
 */
import { describe, expect, it } from 'vitest';
import type { SongNote, SongPhrase } from '../song/types';
import type { TargetNote } from '../core/types';
import { alignNotesDtw } from './dtw';
import { analyzeGlide } from './glide';
import { analyzeInflection } from './inflections';
import { scoreSongPhrases } from './phrases';
import { analyzeRun } from './runs';
import { detectCracks } from './cracks';
import { segmentPlateaus } from './segment';
import { analyzeTransitions } from './transitions';
import { makeTrack } from './fixtures';
import { makeSung, runNotes, sungContour } from './advanced-test-helpers';
import type { AnalyzeContext, InflectionKind } from './types';

const CTX: AnalyzeContext = { toleranceCents: 25, vibratoStyle: 'pop' };
const TAKE_BUDGET_MS = 60;
const SONG_BUDGET_MS = 400;

/** Median of 7 timed calls after 2 warm-ups. */
function timeMs(fn: () => unknown): number {
  fn();
  fn();
  const samples: number[] = [];
  for (let i = 0; i < 7; i++) {
    const t0 = performance.now();
    fn();
    samples.push(performance.now() - t0);
  }
  samples.sort((a, b) => a - b);
  return samples[3];
}

const rows: string[] = [];
function report(name: string, ms: number, budget: number): void {
  rows.push(`${name.padEnd(46)} ${ms.toFixed(2).padStart(8)} ms   (budget ${budget} ms)`);
  expect(ms).toBeLessThan(budget);
}

describe('advanced analyzers: runtime on a 60 s take (93.75 fps, 5625 frames)', () => {
  // A 60 s take: a siren, a legato line, a run, and each inflection sit somewhere inside it.
  const sirenTake = makeTrack({ duration: 60, midi: (t) => 48 + 24 * ((t % 6) / 6), jitterCents: 8 });
  const legatoNotes = runNotes(
    Array.from({ length: 70 }, (_, i) => 55 + ((i * 5) % 9)),
    1.2,
    0.2,
  );
  const legatoTake = makeSung(legatoNotes, { transitionMs: 40 });

  it('detectCracks', () => report('detectCracks (60 s siren take)', timeMs(() => detectCracks(sirenTake)), TAKE_BUDGET_MS));

  it('analyzeGlide (one 3 s glide inside the 60 s take)', () => {
    const g: TargetNote = { midi: 48, toMidi: 72, start: 12.0, end: 15.0 };
    report('analyzeGlide (3 s glide in a 60 s take)', timeMs(() => analyzeGlide(sirenTake, g, CTX)), TAKE_BUDGET_MS);
  });

  it('analyzeTransitions (70 connected notes)', () => report('analyzeTransitions (70-note legato)', timeMs(() => analyzeTransitions(legatoTake, legatoNotes, CTX)), TAKE_BUDGET_MS));

  it('analyzeRun (30-note run; and the same asked of a 60 s take)', () => {
    const notes = runNotes(Array.from({ length: 30 }, (_, i) => 55 + ((i * 5) % 11)), 6, 0.2);
    const take = makeSung(notes);
    report('analyzeRun (30 notes, 5 s)', timeMs(() => analyzeRun(take, notes, CTX)), TAKE_BUDGET_MS);
    const long = runNotes(Array.from({ length: 300 }, (_, i) => 55 + ((i * 5) % 11)), 5, 0.2); // 60 s of notes
    const longTake = makeSung(long);
    report('analyzeRun (300 notes, 60 s)', timeMs(() => analyzeRun(longTake, long, CTX)), TAKE_BUDGET_MS * 2);
  });

  it('analyzeInflection, each kind, given the whole take', () => {
    // One 60 s take with a real instance of every inflection in it (so none of the calls takes an early exit).
    const scoopG: TargetNote = { midi: 62, toMidi: 64, start: 20.0, end: 20.4167 };
    const scoopH: TargetNote = { midi: 64, start: 20.4167, end: 22 };
    const fallH: TargetNote = { midi: 67, start: 30, end: 31.7 };
    const fallG: TargetNote = { midi: 67, toMidi: 62, start: 31.7, end: 32.5333 };
    const slideG: TargetNote = { midi: 60, toMidi: 65, start: 40, end: 40.8333 };
    const slideB: TargetNote = { midi: 65, start: 40.8333, end: 42 };
    const turnSeq: TargetNote[] = [
      { midi: 60, start: 45, end: 45.8 },
      { midi: 62, start: 45.8, end: 46.2 },
      { midi: 60, start: 46.2, end: 46.6 },
      { midi: 59, start: 46.6, end: 47 },
      { midi: 60, start: 47, end: 48 },
    ];
    const flipLow: TargetNote = { midi: 60, start: 50, end: 51.8 };
    const flipHigh: TargetNote = { midi: 67, start: 51.8, end: 53.6 };
    const all = [scoopG, scoopH, fallH, fallG, { midi: 62, start: 32.5333, end: 32.6 }, { midi: 60, start: 39, end: 40 }, slideG, slideB, ...turnSeq, flipLow, flipHigh];
    const contour = sungContour(all, 30);
    const filler = makeTrack({
      duration: 60,
      midi: (t) => contour(t),
      jitterCents: 6,
      rmsDb: (t) => (t >= fallG.start && t < fallG.end ? -20 - 30 * ((t - fallG.start) / (fallG.end - fallG.start)) : -20),
    });
    expect(filler.filter((f) => f.voiced).length).toBeGreaterThan(1000);
    const cases: Array<[InflectionKind, TargetNote[]]> = [
      ['scoop', [scoopG]],
      ['fall', [fallH]],
      ['slide', [slideG]],
      ['turn', [turnSeq[0], turnSeq[1]].map((n, i) => (i === 0 ? { ...n, end: 48 } : n))],
      ['flip', [flipLow, flipHigh]],
    ];
    for (const [kind, targets] of cases) {
      const r = analyzeInflection(filler, kind, targets, CTX);
      expect(r.score, `${kind}: ${r.notes.join(' | ')}`).toBeGreaterThan(0.5); // it really analysed the singing
      report(`analyzeInflection ${kind} (whole 60 s take)`, timeMs(() => analyzeInflection(filler, kind, targets, CTX)), TAKE_BUDGET_MS);
    }
  });

  it('segmentPlateaus', () => report('segmentPlateaus (60 s legato take)', timeMs(() => segmentPlateaus(legatoTake)), TAKE_BUDGET_MS * 2));
});

describe('advanced analyzers: runtime on a four-minute song', () => {
  const notes: SongNote[] = [];
  const phrases: SongPhrase[] = [];
  for (let p = 0; p < 40; p++) {
    const from = notes.length;
    for (let i = 0; i < 12; i++) notes.push({ midi: 55 + ((p * 3 + i * 2) % 12), start: p * 6 + i * 0.4, duration: 0.4, lyric: '', type: 'normal' });
    phrases.push({ start: p * 6, end: p * 6 + 4.8, from, to: notes.length });
  }
  const contour = sungContour(notes.map((n) => ({ midi: n.midi, start: n.start, end: n.start + n.duration })), 25);
  const take = makeTrack({ duration: 242, midi: contour, jitterCents: 8 }); // 22,687 frames

  it('alignNotesDtw (480 notes, 22.7k frames)', () => {
    const dn = notes.map((n) => ({ midi: n.midi, start: n.start, end: n.start + n.duration }));
    report('alignNotesDtw (4-min song, 480 notes)', timeMs(() => alignNotesDtw(take, dn, { bandMs: 200 })), SONG_BUDGET_MS);
  });

  it('scoreSongPhrases (40 phrases)', () => report('scoreSongPhrases (4-min song, 40 phrases)', timeMs(() => scoreSongPhrases(take, notes, phrases, CTX)), SONG_BUDGET_MS));

  it('scoreSongPhrases on a ballad (160 long notes: every one gets the vibrato analyzer)', () => {
    const slow: SongNote[] = [];
    const slowPhrases: SongPhrase[] = [];
    for (let p = 0; p < 40; p++) {
      const from = slow.length;
      for (let i = 0; i < 4; i++) slow.push({ midi: 55 + ((p * 3 + i * 4) % 12), start: p * 6 + i * 1.5, duration: 1.5, lyric: '', type: 'normal' });
      slowPhrases.push({ start: p * 6, end: p * 6 + 6, from, to: slow.length });
    }
    const slowContour = sungContour(slow.map((n) => ({ midi: n.midi, start: n.start, end: n.start + n.duration })), 25);
    const vibrato = makeTrack({ duration: 242, midi: (t) => slowContour(t) + 0.4 * Math.sin(2 * Math.PI * 5.8 * t), jitterCents: 8 });
    const scores = scoreSongPhrases(vibrato, slow, slowPhrases, CTX);
    expect(scores.every((x) => x.vibratoPresent)).toBe(true);
    report('scoreSongPhrases (4-min ballad, 160 long notes)', timeMs(() => scoreSongPhrases(vibrato, slow, slowPhrases, CTX)), 800);
  });

  it('prints the table', () => {
    console.log(`\nadvanced analyzers, median of 7 calls:\n${rows.join('\n')}\n`);
    expect(rows.length).toBeGreaterThan(8);
  });
});

describe('alignNotesDtw is banded: memory and work grow with the song, not with song x notes (TA-12)', () => {
  // A wall-clock budget cannot tell a banded alignment from an unbanded one of a four-minute song (both finish in a few hundred ms on a quiet machine),
  // but the backpointer array of an unbanded one is 34 MB for four minutes and ~200 MB for ten (an iPhone tab-kill), against 0.1 MB banded. So the
  // structure is pinned: the DP's cell count, which is also its memory.
  const song = (minutes: number) => {
    const count = Math.round(minutes * 60 * 2); // two notes a second
    const notes = Array.from({ length: count }, (_, i) => ({ midi: 55 + ((i * 7) % 12), start: 0.5 + i * 0.5, end: 1.0 + i * 0.5 }));
    const take = makeTrack({ duration: 0.5 + count * 0.5 + 1, midi: (t) => notes.find((n) => t >= n.start && t < n.end)?.midi ?? NaN, jitterCents: 8 });
    return { notes, take };
  };

  it('a ten-minute, 1,200-note song holds at most a few cells per frame (not 1,200)', () => {
    const { notes, take } = song(10);
    expect(notes).toHaveLength(1200);
    const al = alignNotesDtw(take, notes, { bandMs: 200 });
    expect(al.activeFrames).toBeGreaterThan(50_000);
    // a frame sits inside the corridors of at most 3 half-second notes with a 200 ms band
    expect(al.cells).toBeLessThanOrEqual(3 * al.activeFrames);
    expect(al.cells).toBeGreaterThanOrEqual(al.activeFrames);
    expect(al.cells * 4).toBeLessThan(2_000_000); // < 8 MB of Int32 backpointers; unbanded would be ~270 MB
  });

  it('doubling the song doubles the cells (linear), where an unbanded alignment would quadruple them', () => {
    const five = song(5);
    const ten = song(10);
    const a = alignNotesDtw(five.take, five.notes, { bandMs: 200 });
    const b = alignNotesDtw(ten.take, ten.notes, { bandMs: 200 });
    const ratio = b.cells / a.cells;
    expect(ratio).toBeGreaterThan(1.9);
    expect(ratio).toBeLessThan(2.1);
  });

  it('cells are what the corridor says: a wider band holds more of them, an infinite band holds every pair', () => {
    const { notes, take } = song(1); // 120 notes, ~5,600 frames
    const narrow = alignNotesDtw(take, notes, { bandMs: 100 });
    const wide = alignNotesDtw(take, notes, { bandMs: 600 });
    const all = alignNotesDtw(take, notes, { bandMs: 1e9 });
    expect(narrow.cells).toBeLessThan(wide.cells);
    expect(all.cells).toBe(all.activeFrames * notes.length);
    expect(wide.cells).toBeLessThan(all.cells / 10);
  });

  it('is cheap in time as well: the ten-minute song aligns in well under a second', () => {
    const { notes, take } = song(10);
    const t0 = performance.now();
    alignNotesDtw(take, notes, { bandMs: 200 });
    expect(performance.now() - t0).toBeLessThan(2000); // ~0.2 s measured; a generous ceiling, the structure tests above are the real guard
  });
});
