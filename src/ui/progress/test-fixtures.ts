/**
 * Builders shared by the progress screens' tests (not a test file itself): attempts against the REAL catalog,
 * snapshots computed the way the session computes them, and a few in-memory storage doubles. Nothing here is
 * bundled into the app (no module imports it outside the tests).
 */
import { WORLDS, getExercise, getLevel } from '../../exercises';
import type { LevelDef } from '../../exercises/types';
import { computeSnapshot, withRoutines, type ProgressSnapshot } from '../../progress';
import type { AttemptRecord, ProfileRecord, TakeRecord } from '../../storage/schema';
import type { Metrics } from '../../analysis/types';

export const PROFILE_ID = 'profile-1';

/** Minutes east of UTC for the machine running the tests: the same offset the session uses for calendar days. */
export function localOffsetMinutes(): number {
  return -new Date().getTimezoneOffset();
}

/** ISO time of 12:00 local, `daysAgo` days before `now`: a time that can never straddle a calendar-day boundary. */
export function localNoon(daysAgo: number, now: number = Date.now()): string {
  const d = new Date(now);
  d.setHours(12, 0, 0, 0);
  d.setDate(d.getDate() - daysAgo);
  return d.toISOString();
}

let seq = 0;

export interface AttemptOptions {
  daysAgo?: number;
  score?: number;
  passed?: boolean;
  metrics?: Metrics;
  durationSec?: number;
  profileId?: string;
  now?: number;
}

/** One attempt at a catalog level (a boss uses kind 'boss'), dated local noon `daysAgo` days back. */
export function attemptAt(levelId: string, opts: AttemptOptions = {}): AttemptRecord {
  const level = getLevel(levelId);
  if (!level) throw new Error(`no level ${levelId}`);
  seq += 1;
  const createdAt = localNoon(opts.daysAgo ?? 0, opts.now);
  // Several attempts a day must replay in creation order: a rising second keeps the HLC-like stamp ordered.
  const updatedAt = new Date(Date.parse(createdAt) + seq * 1000).toISOString();
  const passed = opts.passed ?? true;
  return {
    id: `attempt-${String(seq).padStart(6, '0')}`,
    profileId: opts.profileId ?? PROFILE_ID,
    createdAt,
    updatedAt,
    deletedAt: null,
    exerciseId: level.exerciseId,
    levelId: level.id,
    kind: level.kind === 'boss' ? 'boss' : 'practice',
    score: opts.score ?? (passed ? 0.86 : 0.3),
    passed,
    mastery: passed ? 2 : 0,
    metrics: opts.metrics ?? {},
    durationSec: opts.durationSec ?? 60,
    tonicMidi: 55,
    tempoBpm: null,
    takeId: null,
    songId: null,
  };
}

/** The levels of a world in order. */
export function levelsInOrder(worldId: string): LevelDef[] {
  const world = WORLDS.find((w) => w.id === worldId);
  if (!world) throw new Error(`no world ${worldId}`);
  return [...world.levels].sort((a, b) => a.index - b.index);
}

/** Passing attempts for a world's levels, in order, up to and including `lastLevelId` (the whole world when omitted). */
export function passWorld(worldId: string, lastLevelId?: string, opts: AttemptOptions = {}): AttemptRecord[] {
  const out: AttemptRecord[] = [];
  for (const level of levelsInOrder(worldId)) {
    out.push(attemptAt(level.id, opts));
    if (level.id === lastLevelId) break;
  }
  return out;
}

/** The snapshot the session would compute for this log. */
export function snapshotOf(attempts: readonly AttemptRecord[], now: number = Date.now(), profileId: string = PROFILE_ID): ProgressSnapshot {
  return computeSnapshot(profileId, WORLDS, attempts, now, { getExercise: withRoutines(getExercise), utcOffsetMinutes: localOffsetMinutes() });
}

export function profileRecord(over: Partial<ProfileRecord> & { id: string; name: string }): ProfileRecord {
  return {
    profileId: over.id,
    createdAt: '2026-10-01T10:00:00.000Z',
    updatedAt: '2026-10-01T10:00:00.000Z',
    deletedAt: null,
    voiceType: 'unknown',
    range: null,
    ...over,
  };
}

export function takeRecord(over: Partial<TakeRecord> & { id: string }): TakeRecord {
  return {
    profileId: PROFILE_ID,
    createdAt: '2026-10-21T15:42:00.000Z',
    updatedAt: '2026-10-21T15:42:00.000Z',
    deletedAt: null,
    exerciseId: 'foundations.sustain.1',
    // 188 frames of Float32 (752 bytes) in base64, for a 2.0 s take at 93.75 frames/s.
    track: { frameRate: 93.75, t0: 0, midi: 'A'.repeat(1004), rmsDb: '', confidence: '', voiced: '' },
    audioRef: `takes/${over.id}.wav`,
    sampleRate: 48000,
    latencyMs: 90,
    ...over,
  };
}
