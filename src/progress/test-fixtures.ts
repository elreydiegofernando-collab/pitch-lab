/**
 * Hand-built worlds, exercises and attempts shared by the progress tests, so they never depend on
 * the real exercise catalog (that has its own cross-check in catalog.integration.test.ts).
 * Ids follow the catalog's convention: "<world>.NN" levels, "<world>.boss", "<world>.audition.N".
 */
import type { AuditionDef, ExerciseDef, LevelDef, WorldDef, WorldId } from '../exercises/types';
import type { AttemptRecord } from '../storage/schema';
import type { LevelProgress, Mastery, ProgressSnapshot } from './types';

export const P1 = 'singer-1';
export const P2 = 'singer-2';
export const DAY_MS = 86_400_000;
/** Midday UTC, so +/- a few hours never crosses a day boundary in the tests that care. */
export const BASE_MS = Date.parse('2026-03-01T12:00:00.000Z');

const pad = (n: number): string => String(n).padStart(2, '0');

export function level(worldId: WorldId, index: number, title: string): LevelDef {
  const id = `${worldId}.${pad(index)}`;
  return { id, worldId, index, title, exerciseId: `${id}.ex`, kind: 'level' };
}

export function bossLevel(worldId: WorldId, index: number): LevelDef {
  const id = `${worldId}.boss`;
  return { id, worldId, index, title: 'Boss Recital', exerciseId: `${id}.ex`, kind: 'boss' };
}

export function audition(worldId: WorldId, exerciseCount: number, unlockThrough: string[]): AuditionDef {
  return {
    id: `${worldId}.audition`,
    worldId,
    exerciseIds: Array.from({ length: exerciseCount }, (_, i) => `${worldId}.audition.${i + 1}`),
    unlockThrough,
  };
}

export function world(id: WorldId, title: string, levels: LevelDef[], unlockedBy: string | null, aud: AuditionDef | null = null): WorldDef {
  return { id, title, accent: '--tally', summary: '', levels, audition: aud, unlockedBy };
}

/**
 * Foundations (nine levels + boss, the real titles), Vibrato (three + boss), Inflections (two +
 * boss) and Song Stage (no levels, opened by the Foundations boss), chained like the catalog.
 */
export function fixtureWorlds(): WorldDef[] {
  return [
    world(
      'foundations',
      'Foundations',
      [
        level('foundations', 1, 'Range finder'),
        level('foundations', 2, 'Pitch match'),
        level('foundations', 3, 'Sustain I'),
        level('foundations', 4, 'Sustain II'),
        level('foundations', 5, 'Sirens & glides'),
        level('foundations', 6, 'Crispness'),
        level('foundations', 7, 'Interval jumps I'),
        level('foundations', 8, 'Interval jumps II'),
        level('foundations', 9, 'Legato lines'),
        bossLevel('foundations', 10),
      ],
      null,
      audition('foundations', 4, ['foundations.04', 'foundations.05', 'foundations.08', 'foundations.09']),
    ),
    world(
      'vibrato',
      'Vibrato',
      [level('vibrato', 1, 'Oscillation I'), level('vibrato', 2, 'Pulse builder I'), level('vibrato', 3, 'Free vibrato'), bossLevel('vibrato', 4)],
      'foundations.boss',
      audition('vibrato', 2, ['vibrato.02', 'vibrato.03']),
    ),
    world('inflections', 'Inflections', [level('inflections', 1, 'Intentional scoop'), level('inflections', 2, 'Slides I'), bossLevel('inflections', 3)], 'vibrato.boss'),
    world('song-stage', 'Song Stage', [], 'foundations.boss'),
  ];
}

/** The ids of a world's levels in order. */
export function levelIds(w: WorldDef): string[] {
  return [...w.levels].sort((a, b) => a.index - b.index).map((l) => l.id);
}

let seq = 0;

/** One attempt; times advance one second per call so replay order is the creation order. */
export function attempt(p: Partial<AttemptRecord> = {}): AttemptRecord {
  seq += 1;
  const passed = p.passed ?? true;
  const createdAt = p.createdAt ?? new Date(BASE_MS + seq * 1000).toISOString();
  const levelId = p.levelId === undefined ? null : p.levelId;
  return {
    id: p.id ?? `attempt-${String(seq).padStart(6, '0')}`,
    profileId: p.profileId ?? P1,
    createdAt,
    updatedAt: p.updatedAt ?? createdAt,
    deletedAt: p.deletedAt ?? null,
    exerciseId: p.exerciseId ?? (levelId ? `${levelId}.ex` : 'exercise'),
    levelId,
    kind: p.kind ?? 'practice',
    score: p.score ?? (passed ? 0.85 : 0.3),
    passed,
    mastery: (p.mastery ?? (passed ? 1 : 0)) as Mastery,
    metrics: p.metrics ?? {},
    durationSec: p.durationSec ?? 60,
    tonicMidi: p.tonicMidi ?? null,
    tempoBpm: p.tempoBpm ?? null,
    takeId: p.takeId ?? null,
    songId: p.songId ?? null,
  };
}

/** A passing attempt on a level (a boss uses kind 'boss'). */
export function pass(levelId: string, extra: Partial<AttemptRecord> = {}): AttemptRecord {
  return attempt({ levelId, kind: levelId.endsWith('.boss') ? 'boss' : 'practice', passed: true, ...extra });
}

/** A failing attempt on a level. */
export function fail(levelId: string, extra: Partial<AttemptRecord> = {}): AttemptRecord {
  return attempt({ levelId, kind: levelId.endsWith('.boss') ? 'boss' : 'practice', passed: false, ...extra });
}

/** A passed audition exercise (`<world>.audition.<n>`, 1-based). */
export function passAudition(worldId: WorldId, n: number, extra: Partial<AttemptRecord> = {}): AttemptRecord {
  return attempt({ kind: 'audition', exerciseId: `${worldId}.audition.${n}`, levelId: null, passed: true, ...extra });
}

/** Passed audition tests 1..n of a world, in the order they are sung. */
export function passAuditions(worldId: WorldId, n: number, extra: Partial<AttemptRecord> = {}): AttemptRecord[] {
  return Array.from({ length: n }, (_, i) => passAudition(worldId, i + 1, extra));
}

/** Passing attempts, in order, for every level of every world up to and including `targetLevelId`. */
export function passThrough(worlds: readonly WorldDef[], targetLevelId: string, extra: Partial<AttemptRecord> = {}): AttemptRecord[] {
  const out: AttemptRecord[] = [];
  for (const w of worlds) {
    for (const id of levelIds(w)) {
      out.push(pass(id, extra));
      if (id === targetLevelId) return out;
    }
  }
  throw new Error(`passThrough: unknown level ${targetLevelId}`);
}

/** An ISO time `days` days after the base day at `hourUtc` o'clock. */
export function at(days: number, hourUtc = 12): string {
  return new Date(Date.UTC(2026, 2, 1 + days, hourUtc, 0, 0)).toISOString();
}

export function statusesOf(snapshot: ProgressSnapshot, ids: readonly string[]): string[] {
  return ids.map((id) => snapshot.levels[id]?.status ?? 'missing');
}

export function passedIds(snapshot: ProgressSnapshot): string[] {
  return Object.values(snapshot.levels)
    .filter((l) => l.status === 'passed')
    .map((l) => l.levelId)
    .sort();
}

export function levelProgress(partial: Partial<LevelProgress> & { levelId: string }): LevelProgress {
  return { status: 'locked', bestScore: 0, mastery: 0, attempts: 0, passedAt: null, viaAudition: false, ...partial };
}

/** A minimal ExerciseDef for lookups (tiers and scored metrics are what the progress code reads). */
export function exerciseDef(id: string, over: Partial<ExerciseDef> = {}): ExerciseDef {
  return {
    id,
    worldId: 'foundations',
    kind: 'sustain',
    title: id,
    goal: 'goal',
    pattern: [{ semis: 0, beats: 4 }],
    tempoBpm: 60,
    tonicPlacement: 'mid',
    countInBeats: 2,
    metronome: false,
    demo: { timbre: 'sine', vibrato: null },
    analyzers: ['accuracy'],
    scoring: [{ metric: 'accuracy.inTolerancePct', weight: 1, best: 100, worst: 0 }],
    pass: { score: 0.6 },
    tolerance: 'default',
    tiers: { solid: 0.8, studio: 0.92 },
    ...over,
  };
}

/** Deterministic PRNG (mulberry32): the property tests must be reproducible. */
export function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Recursively freeze, to prove a function never mutates its inputs. */
export function deepFreeze<T>(o: T): T {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o as object)) deepFreeze(v);
  }
  return o;
}
