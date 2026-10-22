/**
 * "Last time" (the Level screen): when the latest take of an exercise missed, its coaching, ready BEFORE the next try.
 * The saved take is read back (storage.takes, its pitch line decoded), re-analyzed against the targets it was sung
 * against (replay.ts) and coached against the log, exactly as the report did; a take whose pitch line was not saved is
 * coached from the attempt's metrics alone. Null when there is no take yet or the latest one passed.
 */
import type { Notation } from '../core/music';
import type { VibratoStyle } from '../core/types';
import { analyzeTake } from '../exercises/analyze';
import { evaluate } from '../exercises/evaluate';
import { canPassAtTempo } from '../exercises/ladder';
import { pickTip } from '../exercises/tips';
import type { ExerciseDef } from '../exercises/types';
import type { TakesApi } from '../storage';
import type { AttemptRecord, ProfileRecord } from '../storage/schema';
import { decodeTrack } from '../storage/track-codec';
import { coachFrom } from './coach';
import { realizeAttempt } from './replay';
import type { Coaching } from './types';

export interface LastTimeSources {
  def: ExerciseDef;
  /** The active profile's attempt log, oldest first. */
  log: readonly AttemptRecord[];
  profile: Pick<ProfileRecord, 'range' | 'voiceType'>;
  /** Where saved takes are read from; null when storage is not open (the attempt's metrics are used). */
  takes: Pick<TakesApi, 'get'> | null;
  notation: Notation;
  vibratoStyle: VibratoStyle;
  isLevelPassed: (levelId: string) => boolean;
  /** Now (epoch ms), for the voice-care rest rule. */
  now: number;
}

/** The latest take of the exercise in the log, if any. */
export function latestTake(exerciseId: string, log: readonly AttemptRecord[]): AttemptRecord | null {
  for (let i = log.length - 1; i >= 0; i--) if (log[i].exerciseId === exerciseId && log[i].deletedAt === null) return log[i];
  return null;
}

/**
 * True when the latest take of `def` missed (the Level screen then shows "Last time"). A lower rung of a tempo ladder
 * that passed its own rule is progress, not a miss.
 */
export function lastTakeMissed(def: ExerciseDef, log: readonly AttemptRecord[]): boolean {
  const last = latestTake(def.id, log);
  if (!last || last.passed) return false;
  if (def.tempoLadder && def.tempoLadder.length > 0 && !canPassAtTempo(def, last.tempoBpm)) return !evaluate(def, last.metrics).passed;
  return true;
}

/**
 * The coaching of the latest take when it missed; null otherwise. Never rejects: an unreadable take falls back to its
 * metrics. A miss that measures clean read back (it was stopped near its end: the log knew, the pitch line does not) is
 * coached as stopped (coach.ts coachFrom never coaches a miss as clean).
 */
export async function lastTimeCoaching(src: LastTimeSources): Promise<Coaching | null> {
  const { def, log } = src;
  const attempt = latestTake(def.id, log);
  if (!attempt || !lastTakeMissed(def, log)) return null;
  const realized = realizeAttempt(def, attempt, src.profile.range, src.profile.voiceType);
  const ctx = { notation: src.notation, vibratoStyle: src.vibratoStyle, isLevelPassed: src.isLevelPassed, now: src.now };

  let record: Awaited<ReturnType<TakesApi['get']>> = undefined;
  if (attempt.takeId && src.takes) {
    try {
      record = await src.takes.get(attempt.takeId);
    } catch {
      record = undefined;
    }
  }
  const track = record ? decodeTrack(record.track) : [];
  if (track.length > 0) {
    try {
      const analysis = analyzeTake(def, realized, track, { vibratoStyle: src.vibratoStyle });
      const tip = pickTip(analysis.metrics, def, analysis.tipContext);
      return coachFrom({ def, attempt, tip, passed: false, metrics: analysis.metrics, analysis, realized, track }, log, ctx);
    } catch {
      // A pitch line the analyzers cannot read costs the detail, never the advice: fall through to the metrics.
    }
  }
  const tip = pickTip(attempt.metrics, def);
  return coachFrom({ def, attempt, tip, passed: false, metrics: attempt.metrics, analysis: null, realized }, log, ctx);
}
