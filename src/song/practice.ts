/**
 * Learning a song (owner, 2026-10-22: "I'd love to be able to practice on a song and get better at it"): a suggested
 * path through the song, and its progress phrase by phrase, all read back from the log (song attempts carry their
 * phrases, key and speed). Pure.
 *
 * The path: listen to the whole song; then each phrase slowly (75%), then at full speed; then pairs of phrases joined;
 * then the whole song. A phrase counts as learned once a full-speed take of it reaches SONG_PASS_SCORE. The path is a
 * suggestion: any phrase can be practised at any time (the song itself is already earned).
 *
 * CONTRACT STUB: the song practice builder replaces the bodies and keeps these signatures.
 */
import type { Song } from './types';
import type { AttemptRecord } from '../storage/schema';

export type PracticeStepKind = 'listen' | 'phrase-slow' | 'phrase' | 'join' | 'whole';

export interface PracticeStep {
  kind: PracticeStepKind;
  /** [from, to) into pitchedView(song).phrases; null for 'listen' and 'whole'. */
  phrase: { from: number; to: number } | null;
  /** 0.75 for a slow phrase, 1 otherwise. */
  speed: 0.75 | 1;
  /** Plain: "Phrase 3, slowly: “O holy night”". */
  title: string;
  status: 'done' | 'current' | 'next';
}

export interface PhraseProgress {
  index: number;
  /** The phrase's words. */
  text: string;
  /** Best and latest full-speed score (0..1), null before one. */
  best: number | null;
  last: number | null;
  takes: number;
  learned: boolean;
}

export interface SongPractice {
  songId: string;
  steps: PracticeStep[];
  /** Index into steps of the suggested next step (steps.length when the whole song is learned). */
  current: number;
  phrases: PhraseProgress[];
  whole: { best: number | null; last: number | null; takes: number };
  /** The first take of this song ever, and the best whole-song take: for "then and now". Null before one. */
  firstAttemptId: string | null;
  bestWholeAttemptId: string | null;
}

/** This profile's practice of a song, from its log. `song` is as charted (the path is over pitchedView(song).phrases). */
export function songPractice(song: Song, log: readonly AttemptRecord[]): SongPractice {
  void song;
  void log;
  throw new Error('songPractice: not built yet');
}
