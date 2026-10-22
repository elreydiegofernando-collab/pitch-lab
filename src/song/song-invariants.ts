/**
 * Test-only helpers shared by the importer suites: what must hold for EVERY Song this module
 * produces, whatever the input, and a seeded random source for repeatable fuzzing.
 */
import { expect } from 'vitest';
import type { Song } from './types';

/** Small deterministic PRNG (an LCG), 0 <= x < 1. */
export function seededRandom(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** The invariants of a well-formed Song: finite numbers, ordered notes, phrases tiling the notes, JSON-safe. */
export function expectValidSong(song: Song): void {
  expect(song.notes.length).toBeGreaterThan(0);
  song.notes.forEach((n, i) => {
    expect(Number.isFinite(n.start) && Number.isFinite(n.duration) && Number.isFinite(n.midi)).toBe(true);
    expect(n.duration).toBeGreaterThanOrEqual(0);
    expect(n.start).toBeGreaterThanOrEqual(0);
    expect(typeof n.lyric).toBe('string');
    if (i > 0) expect(n.start).toBeGreaterThanOrEqual(song.notes[i - 1].start - 1e-9);
  });
  let next = 0;
  for (const p of song.phrases) {
    expect(p.from).toBe(next);
    expect(p.to).toBeGreaterThan(p.from);
    expect(p.to).toBeLessThanOrEqual(song.notes.length);
    expect(Number.isFinite(p.start) && Number.isFinite(p.end)).toBe(true);
    expect(p.end).toBeGreaterThanOrEqual(p.start);
    next = p.to;
  }
  expect(next).toBe(song.notes.length);
  expect(Number.isFinite(song.bpm ?? NaN) && (song.bpm as number) > 0).toBe(true);
  expect(Number.isFinite(song.offsetMs)).toBe(true);
  for (const [key, value] of Object.entries(song.difficulty)) {
    if (key !== 'requiredWorld') expect(Number.isFinite(value as number)).toBe(true);
  }
  expect(JSON.parse(JSON.stringify(song))).toEqual(song);
}
