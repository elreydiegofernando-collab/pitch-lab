/**
 * What the Data screen's recordings list says about a saved take: its title, its length and the name of its WAV
 * export. Pure; nothing here decodes audio or touches storage.
 */
import { getExercise } from '../../exercises';
import { withRoutines } from '../../progress';
import type { TakeRecord } from '../../storage/schema';
import { localDateStamp } from './format';

const lookup = withRoutines(getExercise);

/** Frames in a stored track, counted from the base64 length of its pitch array (4 bytes a frame) without decoding it. */
function takeFrames(track: TakeRecord['track']): number {
  const text = track.midi;
  if (typeof text !== 'string' || text.length === 0) return 0;
  const padding = text.endsWith('==') ? 2 : text.endsWith('=') ? 1 : 0;
  const bytes = Math.floor((text.length * 3) / 4) - padding;
  return Math.max(0, Math.floor(bytes / 4));
}

/** Seconds the track spans. */
export function takeSeconds(track: TakeRecord['track']): number {
  return track.frameRate > 0 ? takeFrames(track) / track.frameRate : 0;
}

/** The exercise's title, "Warm-up sirens" for a built-in routine, the song's title for a song take. */
export function takeTitle(exerciseId: string, songTitleOf?: (songId: string) => string | undefined): string {
  const def = lookup(exerciseId);
  if (def) return def.title;
  if (exerciseId.startsWith('song.')) return songTitleOf?.(exerciseId.slice('song.'.length)) ?? 'Song take';
  return 'Practice take';
}

/** `pitch-lab-take-2026-10-21.wav`, dated by the day the singer sang it (their own zone). */
export function takeFileName(take: Pick<TakeRecord, 'createdAt'>): string {
  return `pitch-lab-take-${localDateStamp(take.createdAt)}.wav`;
}
