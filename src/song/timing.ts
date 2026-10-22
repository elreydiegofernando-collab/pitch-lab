/**
 * Song timeline helpers: the one place that knows how a song's note clock relates to its
 * optional backing track, so no caller has to get the sign of `offsetMs` right.
 *
 * Song.notes are seconds from song time 0. `Song.offsetMs` is where, in the BACKING AUDIO,
 * song time 0 falls (for UltraStar that is exactly #GAP: the audio starts `offsetMs` before
 * beat 0). So at song time `t` the backing track must be playing its position
 * `t + offsetMs / 1000`. If the backing sounds late against the notes, RAISE the offset;
 * if early, lower it. A negative offset means the audio starts after song time 0.
 */
import type { Song } from './types';

/** Position (seconds) in the backing track that plays at song time `songTimeSec`. May be negative (audio not started yet). */
export function backingTimeAt(song: Song, songTimeSec: number): number {
  return songTimeSec + song.offsetMs / 1000;
}

/** Inverse of backingTimeAt: the song time at which the backing track is at `backingSec`. */
export function songTimeAtBacking(song: Song, backingSec: number): number {
  return backingSec - song.offsetMs / 1000;
}

/** Song time at which the last note ends (0 for an empty song). */
export function songDurationSec(song: Song): number {
  let end = 0;
  for (const n of song.notes) end = Math.max(end, n.start + n.duration);
  return end;
}

/**
 * Index of the phrase being sung at song time `t`: the phrase whose [start, end] window
 * contains `t` or, during a rest (including before the first phrase), the NEXT phrase, so a
 * lyric display can show what is coming. Returns -1 once the last phrase has ended, or when
 * the song has no phrases.
 */
export function phraseIndexAt(song: Song, t: number): number {
  const ps = song.phrases;
  if (ps.length === 0 || t > ps[ps.length - 1].end) return -1;
  let lo = 0;
  let hi = ps.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (ps[mid].end < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
