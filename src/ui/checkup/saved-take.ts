/**
 * A check-up task's saved take, read back for the side-by-side pitch lines (CheckupResults): the attempt from the log,
 * its pitch line from storage.takes (decodeTrack), and the notes it was sung against, rebuilt from the attempt
 * (coaching/replay.ts realizeAttempt: the tempo and key it was sung in, so a range saved since cannot move the bars).
 * The cracks are found again by the analyzers, for the replay's markers. A take that was not saved, or cannot be read,
 * is said in plain words, never a blank or a throw.
 */
import { useEffect, useMemo, useState } from 'preact/hooks';
import type { CrackEvent } from '../../analysis/types';
import { realizeAttempt } from '../../coaching/replay';
import { CONFIG } from '../../config';
import type { PitchTrack, TargetNote, VibratoStyle } from '../../core/types';
import { analyzeTake, getExercise } from '../../exercises';
import { activeProfile, appStorage, attemptLog } from '../../state/session';
import { settings } from '../../state/settings';
import type { TakesApi } from '../../storage';
import type { AttemptRecord, ProfileRecord } from '../../storage/schema';
import { decodeTrack } from '../../storage/track-codec';

/** What TraceReplay draws for one take. */
export interface SavedTake {
  notes: readonly TargetNote[];
  totalSec: number;
  toleranceCents: number;
  track: PitchTrack;
  cracks: readonly CrackEvent[];
}

export type SavedTakeState =
  | { status: 'loading' }
  /** Nothing to draw, and why, in a plain sentence. */
  | { status: 'missing'; message: string }
  | { status: 'ready'; take: SavedTake };

export interface SavedTakeSources {
  /** Where saved takes are read from; null when storage is not open. */
  takes: Pick<TakesApi, 'get'> | null;
  profile: Pick<ProfileRecord, 'range' | 'voiceType'> | null;
  vibratoStyle: VibratoStyle;
}

export const NOT_SUNG = 'This task was not sung.';
export const NOT_SAVED = 'The pitch line of this take was not saved.';
export const NOT_READABLE = 'The pitch line of this take could not be read.';

const missing = (message: string): SavedTakeState => ({ status: 'missing', message });

/** Read one attempt's take back; resolves, never rejects. */
export async function loadSavedTake(attempt: AttemptRecord | undefined, src: SavedTakeSources): Promise<SavedTakeState> {
  if (!attempt) return missing(NOT_SUNG);
  const def = getExercise(attempt.exerciseId);
  if (!def) return missing(NOT_READABLE);
  if (!attempt.takeId || !src.takes) return missing(NOT_SAVED);

  let record: Awaited<ReturnType<TakesApi['get']>>;
  try {
    record = await src.takes.get(attempt.takeId);
  } catch {
    return missing(NOT_READABLE);
  }
  if (!record) return missing(NOT_SAVED);
  const track = decodeTrack(record.track);
  if (track.length === 0) return missing(NOT_READABLE);

  let realized: ReturnType<typeof realizeAttempt>;
  try {
    realized = realizeAttempt(def, attempt, src.profile?.range ?? null, src.profile?.voiceType ?? 'unknown');
  } catch {
    return missing(NOT_READABLE);
  }
  let cracks: readonly CrackEvent[] = [];
  try {
    cracks = analyzeTake(def, realized, track, { vibratoStyle: src.vibratoStyle }).details.cracks;
  } catch {
    // The analyzers could not read this line: it still draws, only without crack markers.
  }
  return { status: 'ready', take: { notes: realized.notes, totalSec: realized.totalSec, toleranceCents: CONFIG.tolerance[def.tolerance], track, cracks } };
}

/** The take behind one task of a check-up (its attempt id), loading in the background. */
export function useSavedTake(attemptId: string | null): SavedTakeState {
  const log = attemptLog.value;
  const profile = activeProfile.value;
  const takes = appStorage.value?.takes ?? null;
  const vibratoStyle = settings.value.vibratoStyle;
  const attempt = useMemo(() => (attemptId === null ? undefined : log.find((a) => a.id === attemptId)), [log, attemptId]);
  const [state, setState] = useState<SavedTakeState>({ status: 'loading' });

  useEffect(() => {
    let live = true;
    setState({ status: 'loading' });
    loadSavedTake(attempt, { takes, profile, vibratoStyle }).then(
      (next) => {
        if (live) setState(next);
      },
      () => {
        if (live) setState(missing(NOT_READABLE));
      },
    );
    return () => {
      live = false;
    };
    // Read once per take: the sources object is rebuilt on every render.
  }, [attempt?.id, attempt?.takeId, takes, profile?.id, vibratoStyle]);

  return state;
}
