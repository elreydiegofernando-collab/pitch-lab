/**
 * The song coach: one song take (a phrase, phrases joined, or the whole song) and the log before it, into a Coaching
 * (src/coaching/types.ts) the same CoachCard shows: the main problem located by syllable and time, plain words, "since
 * last time" on the same phrases, and help that deepens with each miss in a row on those phrases (depthFor).
 *
 * CONTRACT STUB: the song practice builder replaces the bodies and keeps these signatures.
 */
import type { Notation } from '../core/music';
import type { PitchTrack } from '../core/types';
import type { PhraseScore } from '../analysis/types';
import type { Song } from '../song/types';
import type { AttemptRecord } from '../storage/schema';
import type { Coaching } from './types';

export interface SongTake {
  /** The song as sung: transposed, and pitchedView'ed (the notes and phrases the take was scored against). */
  song: Song;
  phrase: { from: number; to: number } | null;
  shift: number;
  speed: number;
  /** Take-relative, latency-compensated pitch line on the song's own clock (slowed takes already mapped back). */
  track: PitchTrack;
  scores: readonly PhraseScore[];
  /** This take's row of the log. */
  attempt: AttemptRecord;
}

/** Misses in a row on exactly these phrases of this song, this take included (0 after a pass). */
export function songMissesInARow(songId: string, phrase: { from: number; to: number } | null, log: readonly AttemptRecord[]): number {
  void songId;
  void phrase;
  void log;
  throw new Error('songMissesInARow: not built yet');
}

/** The coaching for a finished song take; `log` is the profile's attempt log AFTER this take was written. */
export function coachSongTake(take: SongTake, log: readonly AttemptRecord[], opts?: { notation?: Notation; now?: number }): Coaching {
  void take;
  void log;
  void opts;
  throw new Error('coachSongTake: not built yet');
}
