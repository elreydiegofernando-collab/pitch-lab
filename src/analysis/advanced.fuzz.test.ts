/**
 * Robustness: every advanced analyzer fed seeded garbage (irregular frame spacing, random
 * voicing, wild pitches, duplicate times, one-frame tracks) against awkward targets
 * (zero-length, overlapping, unsorted, far outside the take). Nothing may throw, and no
 * score may be NaN or leave 0..1. Real takes are messier than the fixtures; this is the
 * floor under all the clean-signal tests.
 */
import { describe, expect, it } from 'vitest';
import type { PitchFrame, TargetNote } from '../core/types';
import type { SongNote, SongPhrase } from '../song/types';
import { seededRandom } from '../dsp/test-signals';
import { alignNotesDtw } from './dtw';
import { analyzeGlide, measureGlide } from './glide';
import { analyzeInflection } from './inflections';
import { scoreSongPhrases } from './phrases';
import { analyzeRun } from './runs';
import { detectCracks } from './cracks';
import { segmentPlateaus } from './segment';
import { analyzeTransitions } from './transitions';
import type { AnalyzeContext, InflectionKind } from './types';

const CTX: AnalyzeContext = { toleranceCents: 25, vibratoStyle: 'pop' };
const KINDS: InflectionKind[] = ['scoop', 'fall', 'slide', 'turn', 'flip'];

function garbageTrack(rand: () => number): PitchFrame[] {
  const n = Math.floor(rand() * 400);
  const frames: PitchFrame[] = [];
  let t = rand() * 2 - 0.5;
  const style = rand();
  for (let i = 0; i < n; i++) {
    t += style < 0.2 ? 0 : style < 0.5 ? 0.0107 : rand() * 0.05; // duplicate times, regular, or irregular
    const voiced = rand() < 0.7;
    const midi = voiced ? 20 + rand() * 80 : NaN;
    frames.push({
      t,
      f0Hz: voiced ? 440 * Math.pow(2, (midi - 69) / 12) : NaN,
      midi,
      centsFromNearest: voiced ? (midi - Math.round(midi)) * 100 : NaN,
      confidence: rand(),
      rmsDb: -80 + rand() * 80,
      voiced,
    });
  }
  return frames;
}

function garbageNotes(rand: () => number, glide = false): TargetNote[] {
  const n = Math.floor(rand() * 7);
  const notes: TargetNote[] = [];
  for (let i = 0; i < n; i++) {
    const start = rand() * 6 - 1;
    const note: TargetNote = { midi: 30 + rand() * 60, start, end: start + (rand() < 0.15 ? 0 : rand() < 0.1 ? -0.2 : rand() * 1.5) };
    if (glide || rand() < 0.3) note.toMidi = note.midi + (rand() - 0.5) * 24;
    notes.push(note);
  }
  return notes;
}

function finite01(x: number): void {
  expect(Number.isFinite(x)).toBe(true);
  expect(x).toBeGreaterThanOrEqual(-1e-9);
  expect(x).toBeLessThanOrEqual(1 + 1e-9);
}

describe('advanced analyzers survive garbage', () => {
  const ITER = 150;

  it('detectCracks and segmentPlateaus', () => {
    const rand = seededRandom(101);
    for (let i = 0; i < ITER; i++) {
      const tk = garbageTrack(rand);
      const events = detectCracks(tk);
      for (const e of events) {
        expect(Number.isFinite(e.t)).toBe(true);
        expect(Number.isFinite(e.durationMs)).toBe(true);
      }
      for (const s of segmentPlateaus(tk)) {
        expect(Number.isFinite(s.medianMidi)).toBe(true);
        expect(s.endIdx).toBeGreaterThan(s.startIdx);
      }
    }
  });

  it('analyzeGlide and measureGlide', () => {
    const rand = seededRandom(102);
    for (let i = 0; i < ITER; i++) {
      const tk = garbageTrack(rand);
      for (const g of garbageNotes(rand, true)) {
        const r = analyzeGlide(tk, g, CTX);
        finite01(r.smoothness);
        expect(r.stairSteps).toBeGreaterThanOrEqual(0);
        const m = measureGlide(tk, g);
        expect(Number.isFinite(m.travel)).toBe(true);
        if (m.durationMs !== null) expect(Number.isFinite(m.durationMs)).toBe(true);
      }
    }
  });

  it('analyzeTransitions', () => {
    const rand = seededRandom(103);
    for (let i = 0; i < ITER; i++) {
      const r = analyzeTransitions(garbageTrack(rand), garbageNotes(rand), CTX);
      finite01(r.cleanRate);
      for (const t of r.transitions) {
        expect(Number.isFinite(t.overshootCents)).toBe(true);
        if (t.durationMs !== null) expect(Number.isFinite(t.durationMs)).toBe(true);
      }
    }
  });

  it('analyzeInflection, every kind, any number of targets', () => {
    const rand = seededRandom(104);
    for (let i = 0; i < ITER; i++) {
      const tk = garbageTrack(rand);
      const targets = garbageNotes(rand);
      for (const kind of KINDS) {
        const r = analyzeInflection(tk, kind, targets, CTX);
        finite01(r.score);
        expect(r.kind).toBe(kind);
        for (const v of [r.sizeCents, r.timeMs, r.landingAbsCents]) if (v !== null) expect(Number.isFinite(v)).toBe(true);
      }
    }
  });

  it('analyzeRun', () => {
    const rand = seededRandom(105);
    for (let i = 0; i < ITER; i++) {
      const notes = garbageNotes(rand).sort((a, b) => a.start - b.start);
      const r = analyzeRun(garbageTrack(rand), notes, CTX);
      expect(r.notes).toHaveLength(notes.length);
      finite01(r.score);
      for (const v of Object.values(r.components)) finite01(v);
      for (const n of r.notes) finite01(n.definition);
    }
  });

  it('alignNotesDtw, including unsorted and overlapping notes', () => {
    const rand = seededRandom(106);
    for (let i = 0; i < ITER; i++) {
      const tk = garbageTrack(rand);
      const notes = garbageNotes(rand);
      const al = alignNotesDtw(tk, notes, { bandMs: rand() * 400 });
      expect(al.ranges).toHaveLength(notes.length);
      expect(al.frameToNote).toHaveLength(tk.length);
      expect(Number.isFinite(al.totalCost)).toBe(true);
    }
  });

  it('scoreSongPhrases', () => {
    const rand = seededRandom(107);
    for (let i = 0; i < ITER; i++) {
      const notes: SongNote[] = garbageNotes(rand).map((n) => ({ midi: n.midi, start: n.start, duration: Math.max(0, n.end - n.start), lyric: '', type: rand() < 0.2 ? 'rap' : 'normal' }));
      const phrases: SongPhrase[] = [];
      for (let p = 0; p < 3; p++) phrases.push({ start: p, end: p + 1, from: Math.floor(rand() * 8) - 1, to: Math.floor(rand() * 9) });
      const scores = scoreSongPhrases(garbageTrack(rand), notes, phrases, CTX, { octaveAgnostic: rand() < 0.5 });
      expect(scores).toHaveLength(phrases.length);
      for (const s of scores) {
        finite01(s.pitchScore);
        expect(Number.isFinite(s.inTolerancePct)).toBe(true);
        expect(s.inTolerancePct).toBeLessThanOrEqual(100 + 1e-9);
      }
    }
  });

  it('a single frame, and a track of identical frames', () => {
    const f: PitchFrame = { t: 1, f0Hz: 440, midi: 69, centsFromNearest: 0, confidence: 0.9, rmsDb: -20, voiced: true };
    const notes: TargetNote[] = [{ midi: 69, toMidi: 72, start: 0, end: 2 }, { midi: 72, start: 2, end: 3 }];
    const same = Array.from({ length: 50 }, () => ({ ...f }));
    for (const tk of [[f], same]) {
      expect(() => {
        detectCracks(tk);
        segmentPlateaus(tk);
        analyzeGlide(tk, notes[0], CTX);
        analyzeTransitions(tk, notes, CTX);
        analyzeRun(tk, notes, CTX);
        for (const k of KINDS) analyzeInflection(tk, k, notes, CTX);
      }).not.toThrow();
    }
  });
});
