/**
 * Learning a song (owner, 2026-10-22: "I'd love to be able to practice on a song and get better at it"): a suggested
 * path through the song, and its progress phrase by phrase, all read back from the log (song attempts carry their
 * phrases, key and speed). Pure.
 *
 * The path: listen to the whole song; then each phrase slowly (75%), then at full speed; then pairs of phrases joined;
 * then the whole song. A phrase counts as learned once a full-speed take of it reaches SONG_PASS_SCORE. The path is a
 * suggestion: any phrase can be practised at any time (the song itself is already earned).
 *
 * How the log is read (songTakes):
 *  - a take of this song is a 'song' attempt with its id, a known speed and what it covered: takes written before song
 *    attempts carried their phrases (no `songSpeed`), and rows whose `phrase` is missing (null is the whole song), cannot
 *    say what they covered, and are left out of the path and the progress;
 *  - phrase progress (best, last, learned) counts only takes of that phrase on its own: a take of several phrases has one
 *    score for all of them, which says nothing about each one. Best and last are full-speed takes; `takes` counts every
 *    take of the phrase alone, slowed ones too (they are practice);
 *  - each step is done when the log shows it: listening once the song has a take (listening leaves no row; the player
 *    marks it heard for the visit), a slow step once a slowed take of the phrase reached the pass score or the phrase is
 *    learned, a phrase step once it is learned, a join once a full-speed take covering both phrases passed, and the whole
 *    song once a full-speed whole-song take passed. Once the whole song is learned, every step is done. The current step
 *    is the first one not done.
 */
import { pitchedView, isPitchedNote } from './pitched';
import type { Song } from './types';
import type { AttemptRecord } from '../storage/schema';

/**
 * A song take reads as passed at this duration-weighted phrase score (the first pass tier the catalog asks of a level).
 * It decides the attempt's `passed`, the take sheet's verdict and when a phrase counts as learned: a song never passes a
 * level. PROVISIONAL.
 */
export const SONG_PASS_SCORE = 0.7;

/** The speed of a slow step. */
export const SLOW_STEP_SPEED = 0.75;

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

/** [from, to) into pitchedView(song).phrases. */
export interface PitchedSpan {
  from: number;
  to: number;
}

/** One take of a song as the log tells it. */
export interface SongTakeRow {
  attempt: AttemptRecord;
  /** The phrases it covered; null for the whole song. */
  phrase: PitchedSpan | null;
  /** Half steps from the chart's key. */
  shift: number;
  speed: number;
  score: number;
}

/** Full speed (1), allowing for a speed stored as a float. */
export function isFullSpeed(speed: number): boolean {
  return speed >= 0.999;
}

/** The same phrases (null = the whole song). */
export function sameSpan(a: PitchedSpan | null, b: PitchedSpan | null): boolean {
  if (a === null || b === null) return a === b;
  return a.from === b.from && a.to === b.to;
}

/** `span` covers [from, to) (the whole song covers everything). */
export function spanCovers(span: PitchedSpan | null, from: number, to: number): boolean {
  return span === null || (span.from <= from && span.to >= to);
}

/**
 * The phrases a row covered: a span, null for the whole song, or undefined when the row cannot say. Only an explicit
 * null means the whole song (buildSongAttempt always writes the field once it writes a speed): a row without one (its
 * phrase dropped as damaged by the backup import's sanitizer, storage/attempts-repo.ts) is unreadable, never a whole-song
 * take, which would mark the song learned on the strength of one phrase.
 */
function validSpan(raw: unknown, phraseCount: number): PitchedSpan | null | undefined {
  if (raw === null) return null;
  if (raw === undefined || typeof raw !== 'object') return undefined;
  const { from, to } = raw as { from?: unknown; to?: unknown };
  if (!Number.isInteger(from) || !Number.isInteger(to)) return undefined;
  const f = from as number;
  const t = to as number;
  return f >= 0 && t > f && t <= phraseCount ? { from: f, to: t } : undefined;
}

/**
 * The takes of `songId` in the log, oldest first: song attempts with a known speed (see the module doc), whose phrases
 * fit a song of `phraseCount` phrases (a chart changed since cannot be read against the new one).
 */
export function songTakes(songId: string, log: readonly AttemptRecord[], phraseCount = Infinity): SongTakeRow[] {
  const rows: SongTakeRow[] = [];
  for (const a of log) {
    if (a.deletedAt !== null || a.kind !== 'song' || a.songId !== songId) continue;
    const speed = a.songSpeed;
    if (typeof speed !== 'number' || !Number.isFinite(speed) || speed <= 0) continue;
    const phrase = validSpan(a.phrase, phraseCount);
    if (phrase === undefined) continue;
    const shift = typeof a.songShift === 'number' && Number.isFinite(a.songShift) ? a.songShift : 0;
    rows.push({ attempt: a, phrase, shift, speed, score: Number.isFinite(a.score) ? a.score : 0 });
  }
  return rows;
}

/**
 * The words of each phrase of pitchedView(song), by its index there: the syllables joined, verbatim and trimmed (the
 * same text the player's phrase rows show).
 */
export function pitchedPhraseTexts(song: Song): string[] {
  const texts: string[] = [];
  for (const p of song.phrases) {
    let scorable = false;
    let text = '';
    for (let i = Math.max(0, p.from); i < Math.min(p.to, song.notes.length); i++) {
      const note = song.notes[i];
      if (isPitchedNote(note)) scorable = true;
      text += note.lyric;
    }
    if (scorable) texts.push(text.trim());
  }
  return texts;
}

/** “O holy night”, or nothing for a phrase without words. */
function quoted(text: string): string {
  return text ? `: “${text}”` : '';
}

function stepsFor(texts: readonly string[]): Array<Omit<PracticeStep, 'status'>> {
  const n = texts.length;
  const steps: Array<Omit<PracticeStep, 'status'>> = [{ kind: 'listen', phrase: null, speed: 1, title: 'Listen to the whole song' }];
  for (let i = 0; i < n; i++) {
    steps.push({ kind: 'phrase-slow', phrase: { from: i, to: i + 1 }, speed: SLOW_STEP_SPEED, title: `Phrase ${i + 1}, slowly${quoted(texts[i])}` });
    steps.push({ kind: 'phrase', phrase: { from: i, to: i + 1 }, speed: 1, title: `Phrase ${i + 1}${quoted(texts[i])}` });
  }
  for (let i = 0; i + 1 < n; i++) {
    steps.push({ kind: 'join', phrase: { from: i, to: i + 2 }, speed: 1, title: `Phrases ${i + 1} and ${i + 2} together` });
  }
  if (n > 0) steps.push({ kind: 'whole', phrase: null, speed: 1, title: 'The whole song' });
  return steps;
}

/** Best and latest score of full-speed rows, and how many rows there were. */
function tally(rows: readonly SongTakeRow[]): { best: number | null; last: number | null; takes: number } {
  let best: number | null = null;
  let last: number | null = null;
  for (const r of rows) {
    if (!isFullSpeed(r.speed)) continue;
    best = best === null ? r.score : Math.max(best, r.score);
    last = r.score;
  }
  return { best, last, takes: rows.length };
}

/**
 * The step after passing `phrase` at `speed` (a missed take stays where it is), so the take sheet and the coach say the
 * same thing: after a slowed pass, the same phrases at full speed; after a full-speed pass of one phrase, the next
 * phrase's first open step (slowly, then at full speed), else joining the two; after anything else, the path's current
 * step. Null once the whole song has been sung through at full speed and nothing is left open.
 */
export function nextStepAfter(practice: SongPractice, phrase: PitchedSpan | null, speed: number): PracticeStep | null {
  const find = (kind: PracticeStepKind, span: PitchedSpan | null): PracticeStep | undefined =>
    practice.steps.find((s) => s.kind === kind && sameSpan(s.phrase, span));
  const open = (step: PracticeStep | undefined): step is PracticeStep => step !== undefined && step.status !== 'done';
  if (!isFullSpeed(speed)) {
    const faster = phrase === null ? find('whole', null) : phrase.to - phrase.from === 1 ? find('phrase', phrase) : undefined;
    if (faster) return faster;
  }
  if (phrase !== null && phrase.to - phrase.from === 1) {
    const k = phrase.from;
    for (const step of [find('phrase-slow', { from: k + 1, to: k + 2 }), find('phrase', { from: k + 1, to: k + 2 }), find('join', { from: k, to: k + 2 })]) {
      if (open(step)) return step;
    }
  }
  return practice.steps[practice.current] ?? null;
}

/** This profile's practice of a song, from its log. `song` is as charted (the path is over pitchedView(song).phrases). */
export function songPractice(song: Song, log: readonly AttemptRecord[]): SongPractice {
  const texts = pitchedPhraseTexts(song);
  const count = Math.min(texts.length, pitchedView(song).phrases.length);
  const rows = songTakes(song.id, log, count);
  const passed = (r: SongTakeRow): boolean => r.score >= SONG_PASS_SCORE;

  const phrases: PhraseProgress[] = [];
  for (let i = 0; i < count; i++) {
    const alone = rows.filter((r) => r.phrase !== null && r.phrase.from === i && r.phrase.to === i + 1);
    const t = tally(alone);
    phrases.push({ index: i, text: texts[i], best: t.best, last: t.last, takes: t.takes, learned: t.best !== null && t.best >= SONG_PASS_SCORE });
  }
  const wholeRows = rows.filter((r) => r.phrase === null);
  const whole = tally(wholeRows);
  const wholeLearned = wholeRows.some((r) => isFullSpeed(r.speed) && passed(r));

  const base = stepsFor(texts.slice(0, count));
  const done = base.map((step): boolean => {
    if (wholeLearned) return true;
    const p = step.phrase;
    switch (step.kind) {
      case 'listen':
        return rows.length > 0;
      case 'phrase-slow':
        return p !== null && (phrases[p.from].learned || rows.some((r) => sameSpan(r.phrase, p) && !isFullSpeed(r.speed) && passed(r)));
      case 'phrase':
        return p !== null && phrases[p.from].learned;
      case 'join':
        return p !== null && rows.some((r) => isFullSpeed(r.speed) && passed(r) && spanCovers(r.phrase, p.from, p.to));
      case 'whole':
        return false;
    }
  });
  const firstOpen = done.indexOf(false);
  const current = firstOpen < 0 ? base.length : firstOpen;
  const steps: PracticeStep[] = base.map((step, i) => ({ ...step, status: i === current ? 'current' : done[i] ? 'done' : 'next' }));

  let bestWhole: SongTakeRow | null = null;
  for (const r of wholeRows) {
    if (isFullSpeed(r.speed) && (bestWhole === null || r.score >= bestWhole.score)) bestWhole = r;
  }

  return {
    songId: song.id,
    steps,
    current,
    phrases,
    whole,
    firstAttemptId: rows[0]?.attempt.id ?? null,
    bestWholeAttemptId: bestWhole?.attempt.id ?? null,
  };
}
