/**
 * Attempt records (schema.ts AttemptRecord): one row per sung attempt,
 * APPEND-ONLY. There is deliberately no update or delete here - progression
 * (progress/*) is always derived by replaying this log, never by mutating a
 * row. `RawStore.add()` also rejects a duplicate id at the database level, so
 * append-only holds even if a caller computes the same id twice.
 *
 * An attempt is written durably the moment it is added: `addAttempt` resolves
 * only after its transaction has committed (strict durability), because iOS can
 * kill an installed PWA mid-session and nothing may wait to be flushed later.
 */
import type { Metrics } from '../analysis/types';
import type { Mastery } from '../progress/types';
import type { PitchLabDb } from './db';
import { newId } from './ids';
import type { AttemptRecord } from './schema';

const STORE = 'attempts';

export type NewAttempt = Omit<AttemptRecord, 'id' | 'createdAt' | 'updatedAt' | 'deletedAt'>;

export const ATTEMPT_KINDS: readonly AttemptRecord['kind'][] = ['practice', 'audition', 'boss', 'record', 'song', 'workout'];

const MAX_ID_LENGTH = 200;
const MAX_METRICS = 64;
/** `group.name`, like every MetricKey. The dot rules out `__proto__`, `constructor` and friends. */
const METRIC_KEY_RE = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/;

/** Keeps only finite-number values under well-formed metric keys (NaN and Infinity cannot survive a JSON backup). */
export function sanitizeMetrics(raw: unknown): Metrics {
  const out: Record<string, number> = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out as Metrics;
  let kept = 0;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (kept >= MAX_METRICS) break;
    if (key.length > 64 || !METRIC_KEY_RE.test(key) || typeof value !== 'number' || !Number.isFinite(value)) continue;
    out[key] = value;
    kept += 1;
  }
  return out as Metrics;
}

function idField(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_ID_LENGTH) {
    throw new TypeError(`attempts-repo: ${field} must be a non-empty string`);
  }
  return value;
}

function finiteOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Validates and normalises the caller-supplied part of an attempt: structural problems throw a
 * TypeError (so a bug cannot poison progression with a corrupt row), numeric ones are clamped.
 * Also the single path the backup importer uses for incoming rows.
 */
export function normalizeAttemptFields(input: unknown): NewAttempt {
  const a = input as Record<string, unknown> | null | undefined;
  if (!a || typeof a !== 'object') throw new TypeError('attempts-repo: an attempt must be an object');

  const kind = a.kind as AttemptRecord['kind'];
  if (!ATTEMPT_KINDS.includes(kind)) throw new TypeError(`attempts-repo: unknown attempt kind: ${String(a.kind)}`);
  if (typeof a.score !== 'number' || !Number.isFinite(a.score)) throw new TypeError('attempts-repo: score must be a finite number');
  if (typeof a.passed !== 'boolean') throw new TypeError('attempts-repo: passed must be a boolean');
  if (a.mastery !== 0 && a.mastery !== 1 && a.mastery !== 2 && a.mastery !== 3) throw new TypeError('attempts-repo: mastery must be 0, 1, 2 or 3');
  if (typeof a.durationSec !== 'number' || !Number.isFinite(a.durationSec)) throw new TypeError('attempts-repo: durationSec must be a finite number');

  const out: NewAttempt = {
    profileId: idField(a.profileId, 'profileId'),
    exerciseId: idField(a.exerciseId, 'exerciseId'),
    levelId: a.levelId === null || a.levelId === undefined ? null : idField(a.levelId, 'levelId'),
    kind,
    score: Math.min(1, Math.max(0, a.score)),
    passed: a.passed,
    mastery: a.mastery as Mastery,
    metrics: sanitizeMetrics(a.metrics),
    durationSec: Math.max(0, a.durationSec),
    tonicMidi: finiteOrNull(a.tonicMidi),
    tempoBpm: finiteOrNull(a.tempoBpm),
    takeId: typeof a.takeId === 'string' && a.takeId ? a.takeId : null,
  };
  if (typeof a.songId === 'string' && a.songId) out.songId = a.songId;
  else if (a.songId === null) out.songId = null;
  return out;
}

/**
 * Appends one attempt. Call this the moment a take finishes scoring. Resolves after the
 * row is committed to disk; rejects (without having stored anything) if the input is invalid
 * or the write fails.
 */
export async function addAttempt(db: PitchLabDb, input: NewAttempt): Promise<AttemptRecord> {
  const fields = normalizeAttemptFields(input);
  const id = newId();
  const record: AttemptRecord = {
    ...fields,
    id,
    createdAt: db.nowIso(),
    updatedAt: db.nextTimestamp(),
    deletedAt: null,
  };
  await db.store<AttemptRecord>(STORE).add(record, id);
  return record;
}

export interface AttemptQueryOptions {
  /** Include tombstoned rows (none exist locally today; a future sync may import some). */
  includeDeleted?: boolean;
}

export async function getAttempt(db: PitchLabDb, id: string, opts: AttemptQueryOptions = {}): Promise<AttemptRecord | undefined> {
  const attempt = await db.store<AttemptRecord>(STORE).get(id);
  if (!attempt) return undefined;
  return attempt.deletedAt !== null && !opts.includeDeleted ? undefined : attempt;
}

/**
 * A profile's whole attempt log, oldest first - the order progress replays it in. Ordered by
 * the HLC `updatedAt` (set once, at append, and never touched again), not `createdAt`: two
 * attempts appended in the same millisecond, or after the wall clock stepped backward, still
 * sort in exactly the order they were appended.
 */
export async function listAttemptsByProfile(db: PitchLabDb, profileId: string, opts: AttemptQueryOptions = {}): Promise<AttemptRecord[]> {
  const rows = await db.store<AttemptRecord>(STORE).getAllByIndex('profileId', profileId);
  return sortByAppendOrder(opts.includeDeleted ? rows : rows.filter((a) => a.deletedAt === null));
}

/** One exercise's attempts for one profile, oldest first. */
export async function listAttemptsByExercise(
  db: PitchLabDb,
  profileId: string,
  exerciseId: string,
  opts: AttemptQueryOptions = {},
): Promise<AttemptRecord[]> {
  const rows = await db.store<AttemptRecord>(STORE).getAllByIndex('profileExercise', [profileId, exerciseId]);
  return sortByAppendOrder(opts.includeDeleted ? rows : rows.filter((a) => a.deletedAt === null));
}

function sortByAppendOrder(rows: AttemptRecord[]): AttemptRecord[] {
  return rows.sort((a, b) => (a.updatedAt !== b.updatedAt ? (a.updatedAt < b.updatedAt ? -1 : 1) : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
