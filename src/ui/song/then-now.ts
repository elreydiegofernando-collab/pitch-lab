/**
 * "Then and now" on the song's progress screen: a saved song take read back against the song, so its pitch line can be
 * drawn over the notes it was sung against and its phrases scored one by one. Pure.
 *
 * A take's pitch line is stored on the take's own timeline (runtime/song-session.ts: t = 0 at the start of its window,
 * real seconds at its speed). Its attempt says what it covered, in which key and at what speed, so the window is rebuilt
 * from the song exactly as the player built it (selectionOfPitched, selectionWindow) and the line is put on the song's
 * clock (toSongClock). Its phrases are scored again from the line the way the session scored them (scoreSongSegment).
 */
import { foldToNearestOctave } from '../../analysis/dtw';
import { CONFIG } from '../../config';
import type { PitchFrame, VibratoStyle } from '../../core/types';
import { phraseRows, scoreSongSegment, scoredPhrasesOf, selectionOfPitched, selectionWindow, toSongClock, windowNotes } from '../../runtime/song-session';
import { pitchedView } from '../../song/pitched';
import { isFullSpeed, songTakes, type PitchedSpan } from '../../song/practice';
import { transposeSong } from '../../song/transpose';
import type { Song, SongNote } from '../../song/types';
import type { AttemptRecord } from '../../storage/schema';
import { formatPercent } from './format';

export interface SongTakeView {
  attempt: AttemptRecord;
  /** What it covered and how: "Phrase 1, slowly", "Whole song". */
  label: string;
  /** "22 Oct". */
  when: string;
  score: number;
  /** The phrases it covered (into pitchedView(song).phrases); null for the whole song. */
  phrase: PitchedSpan | null;
  /** The window drawn, song time, and the notes sung in it (in the take's own key). */
  start: number;
  end: number;
  notes: SongNote[];
  /** Its pitch line on the song's clock; null when the take's recording was not kept. */
  track: PitchFrame[] | null;
  /** Each phrase it covered (index into pitchedView(song).phrases) and its score (0..1), from the pitch line. */
  phraseScores: ReadonlyMap<number, number>;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "22 Oct" in local time. */
export function dayMonth(iso: string): string {
  const d = new Date(iso);
  return Number.isFinite(d.getTime()) ? `${d.getDate()} ${MONTHS[d.getMonth()]}` : '';
}

/** "Whole song", "Phrase 3", "Phrases 3 and 4", "Phrases 3 to 5", with ", slowly" or ", at half speed". */
export function takeLabel(phrase: PitchedSpan | null, speed: number): string {
  let what: string;
  if (phrase === null) what = 'Whole song';
  else if (phrase.to - phrase.from === 1) what = `Phrase ${phrase.from + 1}`;
  else what = phrase.to - phrase.from === 2 ? `Phrases ${phrase.from + 1} and ${phrase.to}` : `Phrases ${phrase.from + 1} to ${phrase.to}`;
  if (isFullSpeed(speed)) return what;
  return Math.abs(speed - 0.5) < 0.01 ? `${what}, at half speed` : `${what}, slowly`;
}

/**
 * A saved take of `song` (as charted) read back: `track` is its stored pitch line (take time), or null when it was not
 * kept. Null for an attempt that is not a readable take of this song (another song, or one that did not record its
 * phrases).
 */
export function songTakeView(song: Song, attempt: AttemptRecord, track: readonly PitchFrame[] | null, vibratoStyle: VibratoStyle = 'pop'): SongTakeView | null {
  const row = songTakes(song.id, [attempt], pitchedView(song).phrases.length)[0];
  if (!row) return null;
  const sung = transposeSong(song, row.shift);
  const rows = phraseRows(sung);
  const selection = selectionOfPitched(rows, row.phrase);
  const window = selection === undefined ? null : selectionWindow(sung, selection);
  if (!window) return null;
  const notes = windowNotes(sung, window);
  const onClock = track && track.length > 0 ? toSongClock(track, window.start, row.speed) : null;
  const phraseScores = new Map<number, number>();
  if (track && track.length > 0) {
    const scores = scoreSongSegment(track, {
      view: pitchedView(sung),
      phrases: scoredPhrasesOf(rows, selection ?? null),
      originSongSec: window.start,
      speed: row.speed,
      ctx: { toleranceCents: CONFIG.tolerance.default, vibratoStyle },
    });
    for (const s of scores) phraseScores.set(s.phraseIndex, s.pitchScore);
  }
  return {
    attempt,
    label: takeLabel(row.phrase, row.speed),
    when: dayMonth(attempt.createdAt),
    score: row.score,
    phrase: row.phrase,
    start: window.start,
    end: window.end,
    notes,
    track: onClock,
    phraseScores,
  };
}

/** "Show as table" for then and now: each phrase either take covered, its score then and now, and the takes' own scores. */
export function thenNowTable(then: SongTakeView | null, now: SongTakeView | null, texts: readonly string[]): { columns: string[]; rows: string[][] } {
  const cell = (v: SongTakeView | null, i: number): string => {
    const s = v?.phraseScores.get(i);
    return s === undefined ? '–' : formatPercent(s);
  };
  const phrases = new Set<number>([...(then?.phraseScores.keys() ?? []), ...(now?.phraseScores.keys() ?? [])]);
  const rows = [...phrases]
    .sort((a, b) => a - b)
    .map((i) => [`${i + 1}. ${texts[i] ?? ''}`.trim(), cell(then, i), cell(now, i)]);
  rows.push(['The take as scored', then ? formatPercent(then.score) : '–', now ? formatPercent(now.score) : '–']);
  return { columns: ['Phrase', 'Then', 'Now'], rows };
}

/** A frame's pitch folded to the octave of the note sounding then (or of the nearest note), as the scorer reads it. */
export function drawnMidi(f: PitchFrame, notes: readonly SongNote[]): number {
  let target: SongNote | undefined;
  let best = Infinity;
  for (const n of notes) {
    const d = f.t < n.start ? n.start - f.t : f.t > n.start + n.duration ? f.t - (n.start + n.duration) : 0;
    if (d < best) {
      best = d;
      target = n;
    }
  }
  return target && CONFIG.song.octaveAgnostic ? foldToNearestOctave(f.midi, target.midi) : f.midi;
}
