/**
 * The song coach: one song take (a phrase, phrases joined, or the whole song) and the log before it, into a Coaching
 * (src/coaching/types.ts) the same CoachCard shows: the main problem located by syllable and time, plain words, "since
 * last time" on the same phrases, and help that deepens with each miss in a row on those phrases (depthFor).
 *
 * How a take is read (readTake): the take's pitch line is aligned to the notes of the phrases it was judged on, the way
 * the phrase scorer aligns it (analysis/phrases.ts: one banded alignment, octave-agnostic when CONFIG.song.octaveAgnostic,
 * a frame scoring 1 on the note and 0 at two and a half tolerances, coverage-aware). Each note then has how much of it was
 * sung, where it sat, how steady a long one was, and when it came in; the voice's breaks are the crack detector's jumps
 * (analysis/cracks.ts) that no written note change explains. Every second of note time a note lost is charged to one
 * cause (unsung, late, a dropout, a broken note, a leap, the top or bottom of the phrase, a wrong note, a wavering hold,
 * or a lean flat or sharp), a break costs a little more on top (it is heard even when it costs little score), and the
 * cause that cost the most is the main problem: one SONG_TIPS id, worded by the syllable it happened on ("on “ho-” in
 * “O holy night” at 0:12 you were a little flat"), with up to four spots. Times are the song's own clock.
 *
 * A passed take gets the polish line: what it passed at, and the next step of the learning path (song/practice.ts). The
 * help comes from the song ladders (src/coaching/content/song.ts, LADDERS_SONG); until a tip has one, its plain one-line
 * fallback below stands alone.
 *
 * Moves: practise the phrase alone (from a take of several phrases, when the problem sits in one of them), listen to it
 * slowly from the second miss in a row, Send to Claude from the third, "Practise <level>" from the fourth when the ladder
 * names an earlier level the log shows passed (from the second when that level trains a focus of the latest voice
 * check-up, coach.ts checkupFocusLevels), and a rest after many misses or many takes in a short time. CoachMove has
 * no phrase move: "practise phrase 3 alone" rides on 'practise-level' with a PHRASE_MOVE_PREFIX id (phraseOfMove reads it).
 */
import { detectCracks } from '../analysis/cracks';
import { alignNotesDtw, foldToNearestOctave, octaveFoldedDistance } from '../analysis/dtw';
import { cleanOctaveSpikes, estimateFrameDt, median } from '../analysis/track';
import { analyzeVibrato } from '../analysis/vibrato';
import type { PhraseScore } from '../analysis/types';
import { CONFIG } from '../config';
import { clamp01 } from '../core/math';
import type { Notation } from '../core/music';
import type { PitchFrame, PitchTrack } from '../core/types';
import { getExercise, getLevel } from '../exercises/catalog';
import { SONG_PASS_SCORE, isFullSpeed, nextStepAfter, sameSpan, songPractice, songTakes, type PracticeStep } from '../song/practice';
import type { Song, SongNote } from '../song/types';
import type { AttemptRecord } from '../storage/schema';
import { FOCUS_PRACTISE_DEPTH, REST_MISSES, checkupFocusLevels, depthFor, restDue } from './coach';
import { ladderFor } from './content/index';
import * as P from './plain';
import type { SongTipId } from './song-tips';
import type { CoachDepth, CoachMove, Coaching, ProblemSpot, ProgressLine, TakeProblem } from './types';

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

// ---------------------------------------------------------------- knobs (PROVISIONAL: tune on real song takes)

/** As the phrase scorer: the start of each note not counted against it (consonants), real seconds ... */
const ONSET_ALLOWANCE_SEC = 0.05;
/** ... and a frame's score reaching 0 at this many tolerances. */
const ZERO_TOLERANCES = 2.5;
/** Real seconds of a note's arrival left out of where it sat (the scoop or slide onto it). */
const ARRIVAL_SKIP_SEC = 0.1;
/** Notes held at least this long (real seconds) are judged for steadiness, after HOLD_SKIP_SEC of their arrival. */
const LONG_NOTE_SEC = 0.75;
const HOLD_SKIP_SEC = 0.15;
const MIN_HOLD_FRAMES = 8;
/** A note sung for less than this share of it counts as unsung. */
const UNSUNG_COVER = 0.25;
/** A low note sung for less than this share of it was too quiet to follow. */
const QUIET_COVER = 0.6;
/** Coming in this much later (or earlier) than the note, real seconds. */
const LATE_SEC = 0.15;
const EARLY_SEC = 0.15;
/** A frame within this of the note before, and at least this far from its own, is still on the note before (lagging). */
const LAG_MATCH_CENTS = 60;
/** Silence this long (real seconds) while a note was due, after the singing had begun: the sound dropped out. */
const BREATH_MIN_SEC = 0.3;
/** A jump of at least this many half steps into a note, landing at least LEAP_MISS_CENTS off it. */
const LEAP_SEMITONES = 5;
const LEAP_MISS_CENTS = 35;
/** A phrase spans at least this many half steps before its top and bottom notes stand out; they lie within EDGE_WITHIN of the end. */
const EDGE_SPAN_SEMITONES = 4;
const EDGE_WITHIN = 1;
/** A top note at least this flat came out flat; a bottom note this far off came out off. */
const HIGH_FLAT_CENTS = 20;
const LOW_OFF_CENTS = 35;
/** A note this far off sounded as a different note. */
const OFF_NOTE_CENTS = 70;
/** A note centred within this of its pitch was on it (what it lost is the detector's jitter or a vibrato). */
const NOISE_CENTS = 10;
/** A long note this spread out wavered; one that slipped this much from its start to its end sank. */
const UNSTEADY_SD_CENTS = 25;
const SINK_CENTS = 30;
/**
 * Flat (or sharp) is the main problem only when LEAN_SHARE of that loss went one way; the words add how the phrase sat as
 * a whole when its lean went that way by at least BIAS_MIN_CENTS.
 */
const BIAS_MIN_CENTS = 10;
const LEAN_SHARE = 2 / 3;
/** A break is heard even when it costs little score: it counts as this many seconds of lost note time on top. */
const CRACK_COST_SEC = 0.6;
/** A jump within this long (real seconds) of a written note change, no bigger than the change plus EXPLAIN_SLACK_CENTS, is that change. */
const EXPLAIN_SEC = 0.3;
const EXPLAIN_SLACK_CENTS = 350;
/** After a break the pitch stays at least this far from where it was (or the voice cuts out), over PERSIST_SEC. */
const PERSIST_CENTS = 150;
const PERSIST_SEC = 0.06;
const FALLBACK_DT_SEC = 512 / 48000;
const MAX_SPOTS = 4;
/** Words of context around a syllable ("in “O holy night”"). */
const CONTEXT_WORDS = 6;

/**
 * The fix in one plain line, for a tip whose song ladder is not written yet (the ladder's own tip replaces it once it
 * exists). Same rules as every ladder: second person, no numbers or jargon, no exclamation marks, never push or strain.
 */
export const SONG_FALLBACK_TIPS: Readonly<Record<SongTipId, string>> = {
  'song.flat': 'Keep the air moving to the end of each word, and aim a little higher, onto the middle of each note.',
  'song.sharp': 'Ease off a little: loosen your jaw and use a little less breath, so each note settles onto its middle.',
  'song.off-notes': 'Listen to the phrase slowly and hum the notes that went astray, then sing the words again.',
  'song.leap': 'Hear the top of the jump in your head before you leave the note below, then land on it lightly.',
  'song.high': 'Keep the highest notes light and easy, and let them sit on the breath instead of reaching up for them.',
  'song.low': 'Let the low notes stay relaxed and warm, with the air still flowing, rather than fading to a whisper.',
  'song.late': 'Breathe in before the beat, so each word starts right on it.',
  'song.early': 'Let the melody lead: wait for each note and start the word with it, not before it.',
  'song.breath': 'Take a full, easy breath before the phrase and plan where the next one goes, so the sound lasts to the end.',
  'song.cracks': 'Sing that note a little lighter and softer, and let your voice change gears smoothly instead of holding on.',
  'song.unsteady': 'On the long notes keep the air flowing evenly and your jaw loose, so the pitch stays level to the end.',
  'song.unsung': 'Sing every word, even softly: a quiet note still counts, and you can build it up from there.',
  'song.polish': 'That one is there. Go on to the next step.',
  'song.join': 'Take a quick, quiet breath between the phrases and come straight back in on the first word.',
};

// ---------------------------------------------------------------- the phrase move

/** CoachMove has no phrase move: "practise phrase 3 alone" is a 'practise-level' move whose id is this prefix and the phrase. */
export const PHRASE_MOVE_PREFIX = 'song-phrase:';

/** The "practise phrase N alone" move for an index into pitchedView(song).phrases. */
export function phraseMove(index: number): CoachMove {
  return { kind: 'practise-level', levelId: `${PHRASE_MOVE_PREFIX}${index}`, title: `phrase ${index + 1} alone` };
}

/** The phrase (index into pitchedView(song).phrases) a phrase move practises; null for any other move. */
export function phraseOfMove(move: CoachMove): number | null {
  if (move.kind !== 'practise-level' || !move.levelId.startsWith(PHRASE_MOVE_PREFIX)) return null;
  const raw = move.levelId.slice(PHRASE_MOVE_PREFIX.length);
  return /^\d{1,5}$/.test(raw) ? Number(raw) : null;
}

// ---------------------------------------------------------------- misses in a row

/** Misses in a row on exactly these phrases of this song, this take included (0 after a pass). */
export function songMissesInARow(songId: string, phrase: { from: number; to: number } | null, log: readonly AttemptRecord[]): number {
  const rows = songTakes(songId, log);
  let n = 0;
  for (let i = rows.length - 1; i >= 0; i--) {
    if (!sameSpan(rows[i].phrase, phrase)) continue;
    if (rows[i].attempt.passed) break;
    n++;
  }
  return n;
}

// ---------------------------------------------------------------- the words

interface Syllable {
  /** Its first note (index into song.notes). */
  first: number;
  /** As the singer finds it in the words: "ho-", "-ly", "night". */
  label: string;
  /** Its word, by index into the phrase's words. */
  word: number;
}

interface PhraseWords {
  /** Per note of the phrase (note index - phrase.from): the index of its syllable, -1 before the first one. */
  syllableOf: number[];
  syllables: Syllable[];
  /** The phrase's words without their punctuation, and the clause each belongs to (split at , ; : . ! ?). */
  words: string[];
  clauseOf: number[];
}

/** A word or syllable without the punctuation around it (apostrophes and inner hyphens stay). */
function bare(text: string): string {
  return text.replace(/^[^\p{L}\p{N}']+/u, '').replace(/[^\p{L}\p{N}'-]+$/u, '');
}

function phraseWords(song: Song, from: number, to: number): PhraseWords {
  const syllableOf: number[] = [];
  const raw: Array<{ first: number; core: string; word: number; startsWord: boolean }> = [];
  const words: string[] = [];
  const clauseOf: number[] = [];
  let clause = 0;
  let open = false; // the word so far continues into the next syllable
  let clauseEnds = false;
  for (let i = from; i < to; i++) {
    const lyric = song.notes[i].lyric;
    if (lyric === '') {
      syllableOf.push(raw.length - 1);
      continue;
    }
    const core = lyric.trim();
    const startsWord = !open || /^\s/.test(lyric) || words.length === 0;
    if (startsWord) {
      if (clauseEnds && words.length > 0) clause += 1;
      clauseEnds = false;
      words.push('');
      clauseOf.push(clause);
    }
    words[words.length - 1] += core.replace(/-$/, '');
    raw.push({ first: i, core, word: words.length - 1, startsWord });
    syllableOf.push(raw.length - 1);
    open = core !== '' && !/\s$/.test(lyric) && !/[,;:.!?)"”’]$/.test(core);
    if (/[,;:.!?]["”’)]*$/.test(core)) clauseEnds = true;
  }
  const syllables = raw.map((s, k): Syllable => {
    const endsWord = k === raw.length - 1 || raw[k + 1].startsWord;
    const core = bare(s.core).replace(/-+$/, '');
    const label = core === '' ? '' : `${s.startsWord ? '' : '-'}${core}${endsWord ? '' : '-'}`;
    return { first: s.first, label, word: s.word };
  });
  return { syllableOf, syllables, words: words.map(bare), clauseOf };
}

/** The words around word `w`, within its clause and at most CONTEXT_WORDS long ("O holy night", "…stars are brightly shining"). */
function contextOf(pw: PhraseWords, w: number): string {
  const inClause: number[] = [];
  for (let k = 0; k < pw.words.length; k++) if (pw.clauseOf[k] === pw.clauseOf[w] && pw.words[k] !== '') inClause.push(k);
  let lo = 0;
  let hi = inClause.length;
  if (hi > CONTEXT_WORDS) {
    const at = Math.max(0, inClause.indexOf(w));
    lo = Math.max(0, Math.min(at - Math.floor((CONTEXT_WORDS - 1) / 2), inClause.length - CONTEXT_WORDS));
    hi = lo + CONTEXT_WORDS;
  }
  const text = inClause
    .slice(lo, hi)
    .map((k) => pw.words[k])
    .join(' ');
  return `${lo > 0 ? '…' : ''}${text}${hi < inClause.length ? '…' : ''}`;
}

// ---------------------------------------------------------------- reading the take

interface NoteRead {
  /** Index into song.notes, and its phrase (index into song.phrases). */
  i: number;
  phrase: number;
  note: SongNote;
  /** Its length in real seconds (slowed takes last longer). */
  w: number;
  /** The share of it that was sung (0..1). */
  cover: number;
  /**
   * Real seconds of note time it lost, as the scorer counts it, split three ways: not sung at all, sung while still on
   * the note before (lagging behind), and sung off its pitch.
   */
  missLoss: number;
  lagLoss: number;
  pitchLoss: number;
  /** Where it sat against the written note, signed (+ sharp), octave-folded as scored; null when too little was sung. */
  err: number | null;
  /** Long notes: the spread of the hold about its own middle, and how far it moved from its start to its end. */
  sd: number | null;
  sink: number | null;
  long: boolean;
  /** A long note that slipped down as it was held, or wavered (a regular vibrato is not wavering). */
  sank: boolean;
  wavered: boolean;
  /** When the voice arrived on it, real seconds against the note (+ late); null when that cannot be read. */
  onsetSec: number | null;
  /** Real seconds of silence while it was due, after the singing had begun (and where that began, song time). */
  silentSec: number;
  silentAt: number | null;
  /** The top (bottom) of its phrase, when the phrase has a range; the highest note of the whole take. */
  high: boolean;
  low: boolean;
  topOfTake: boolean;
  /** Half steps jumped into it from the note just before (0 when there is none, or a rest comes between). */
  leap: number;
  /** The previous note of its phrase (index into song.notes), or null. */
  prev: number | null;
  /** The first note of a phrase sung straight after another one in the same take. */
  joins: boolean;
  /** After the last note of its phrase that was sung: the singing had stopped. */
  trailing: boolean;
}

interface Crack {
  /** Song time. */
  t: number;
  cents: number;
  /** The note it broke on (index into the reads). */
  read: number;
}

interface TakeRead {
  reads: NoteRead[];
  cracks: Crack[];
  /** No frame of the take was voiced during its phrases. */
  silent: boolean;
  /** The phrases judged (indices into song.phrases), in order. */
  phrases: number[];
}

function mean(xs: readonly number[]): number {
  let s = 0;
  for (const x of xs) s += x;
  return xs.length > 0 ? s / xs.length : NaN;
}

const finite = (x: number | null | undefined): x is number => x !== null && x !== undefined && Number.isFinite(x);
const voiced = (f: PitchFrame): boolean => f.voiced && Number.isFinite(f.midi);

/** Signed cents of a sung pitch against a written note, folded to the nearest octave when songs are scored that way. */
function signedCents(midi: number, target: number): number {
  return ((CONFIG.song.octaveAgnostic ? foldToNearestOctave(midi, target) : midi) - target) * 100;
}

/** Index of the first frame at or after `t` (the track is in time order). */
function frameAt(track: readonly PitchFrame[], t: number): number {
  let lo = 0;
  let hi = track.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (track[mid].t < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function readTake(take: SongTake, track: readonly PitchFrame[]): TakeRead {
  const { song } = take;
  const speed = take.speed > 0 ? take.speed : 1;
  const tol = CONFIG.tolerance.default;
  const phrases = [...new Set(take.scores.map((s) => s.phraseIndex))].filter((p) => Number.isInteger(p) && p >= 0 && p < song.phrases.length).sort((a, b) => a - b);

  const order: Array<{ i: number; phrase: number }> = [];
  for (const p of phrases) {
    const ph = song.phrases[p];
    for (let i = Math.max(0, ph.from); i < Math.min(ph.to, song.notes.length); i++) order.push({ i, phrase: p });
  }
  const dtwNotes = order.map(({ i }) => ({ midi: song.notes[i].midi, start: song.notes[i].start, end: song.notes[i].start + song.notes[i].duration }));
  const al = alignNotesDtw(track, dtwNotes, {
    bandMs: CONFIG.song.dtwBandMs * speed,
    pitchDistanceCents: CONFIG.song.octaveAgnostic ? octaveFoldedDistance : undefined,
  });
  const dtRaw = estimateFrameDt(track);
  const dt = Number.isFinite(dtRaw) && dtRaw > 0 ? dtRaw : FALLBACK_DT_SEC * speed;
  const framesOf: number[][] = order.map(() => []);
  for (let k = 0; k < track.length; k++) {
    const j = al.frameToNote[k];
    if (j >= 0 && voiced(track[k])) framesOf[j].push(k);
  }

  // Where the singing began and ended within each phrase: silence before the first sound is a late start, not a dropout.
  const sungSpan = new Map<number, { first: number; last: number }>();
  for (const p of phrases) {
    const ph = song.phrases[p];
    const band = (CONFIG.song.dtwBandMs / 1000) * speed;
    let first = Infinity;
    let last = -Infinity;
    for (let k = frameAt(track, ph.start - band); k < track.length && track[k].t <= ph.end + band; k++) {
      if (!voiced(track[k])) continue;
      first = Math.min(first, track[k].t);
      last = Math.max(last, track[k].t);
    }
    sungSpan.set(p, { first, last });
  }

  let topMidi = -Infinity;
  for (const { i } of order) topMidi = Math.max(topMidi, song.notes[i].midi);
  const phraseEdges = new Map<number, { lo: number; hi: number }>();
  for (const p of phrases) {
    const ph = song.phrases[p];
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = ph.from; i < ph.to; i++) {
      lo = Math.min(lo, song.notes[i].midi);
      hi = Math.max(hi, song.notes[i].midi);
    }
    phraseEdges.set(p, { lo, hi });
  }

  const reads = order.map(({ i, phrase }, j): NoteRead => {
    const note = song.notes[i];
    const ph = song.phrases[phrase];
    const w = note.duration / speed;
    const frames = framesOf[j];
    const expected = Math.max(1, (note.duration - ONSET_ALLOWANCE_SEC * speed) / dt);
    const cover = Math.min(1, frames.length / expected);
    const prevIndex = i > ph.from ? i - 1 : null;
    const prevNote = prevIndex !== null ? song.notes[prevIndex] : null;

    // Lagging behind: the note's first frames still on the note before it (sung later than the alignment corridor allows,
    // so the scorer sees a wrong pitch). Their loss is lateness, not a wrong note.
    let lag = 0;
    if (prevNote && prevNote.midi !== note.midi) {
      while (lag < frames.length) {
        const midi = track[frames[lag]].midi;
        if (Math.abs(signedCents(midi, prevNote.midi)) <= LAG_MATCH_CENTS && Math.abs(signedCents(midi, note.midi)) >= LAG_MATCH_CENTS) lag++;
        else break;
      }
    }
    const lossOf = (k: number): number => 1 - clamp01(1 - Math.abs(signedCents(track[k].midi, note.midi)) / (ZERO_TOLERANCES * tol));
    const perFrame = w / expected; // real seconds of note time one frame stands for
    let lagLoss = 0;
    for (let q = 0; q < lag; q++) lagLoss += perFrame * lossOf(frames[q]);
    const own = frames.slice(lag);
    let pitchLoss = 0;
    for (const k of own) pitchLoss += perFrame * lossOf(k);

    const cents = own.map((k) => signedCents(track[k].midi, note.midi));
    const arrived = own.length > 0 ? track[own[0]].t : note.start + note.duration;
    const held = own.filter((k) => track[k].t >= arrived + Math.min(ARRIVAL_SKIP_SEC * speed, note.duration * 0.3));
    const heldCents = held.map((k) => signedCents(track[k].midi, note.midi));
    const err = heldCents.length >= 3 ? median(heldCents) : cents.length >= 3 ? median(cents) : null;

    const long = w >= LONG_NOTE_SEC;
    let sd: number | null = null;
    let sink: number | null = null;
    let vibrato = false;
    if (long) {
      const holdFrames = own.filter((k) => track[k].t >= arrived + HOLD_SKIP_SEC * speed);
      const hold = holdFrames.map((k) => signedCents(track[k].midi, note.midi));
      if (hold.length >= MIN_HOLD_FRAMES) {
        const m = mean(hold);
        sd = Math.sqrt(mean(hold.map((e) => (e - m) * (e - m))));
        const third = Math.max(1, Math.floor(hold.length / 3));
        sink = median(hold.slice(-third)) - median(hold.slice(0, third));
        // A regular vibrato spreads the pitch on purpose: that is not wavering (measured on the take's real time).
        const real = holdFrames.map((k) => ({ ...track[k], t: track[k].t / speed }));
        const v = analyzeVibrato(real, { midi: note.midi, start: note.start / speed, end: (note.start + note.duration) / speed }, { toleranceCents: tol, vibratoStyle: 'pop' }, { windows: false });
        vibrato = v.present && !v.flags.includes('wobble') && !v.flags.includes('irregular');
      }
    }
    // A hold that slid down steadily sank (a straight slide spreads about half as much as it moves); one that went up and
    // down wavered.
    const sank = sink !== null && sink <= -SINK_CENTS && (sd === null || Math.abs(sink) >= 1.5 * sd);
    const wavered = sd !== null && sd >= UNSTEADY_SD_CENTS && !vibrato && !sank;
    // When the voice arrived on the note: after the lag, or the alignment's own reading (within its corridor).
    const offset = al.onsetOffsetMs[j];
    let onsetSec: number | null = null;
    if (lag > 0 && own.length > 0) onsetSec = (arrived - note.start) / speed;
    else if (own.length >= 3 && err !== null && Math.abs(err) <= 100 && offset !== null) onsetSec = offset / 1000 / speed;

    // Silence while the note was due, between the first and last sound of its phrase.
    const span = sungSpan.get(phrase) ?? { first: Infinity, last: -Infinity };
    let silentSec = 0;
    let silentAt: number | null = null;
    let runStart: number | null = null;
    const end = note.start + note.duration;
    const closeRun = (t: number): void => {
      if (runStart === null) return;
      const len = (Math.min(t, end) - runStart) / speed;
      if (len > silentSec) {
        silentSec = len;
        silentAt = runStart;
      }
      runStart = null;
    };
    for (let k = frameAt(track, note.start); k < track.length && track[k].t < end; k++) {
      const f = track[k];
      if (voiced(f)) closeRun(f.t);
      else if (runStart === null && f.t > span.first && f.t < span.last) runStart = f.t;
    }
    closeRun(Math.min(end, span.last));
    if (silentSec < BREATH_MIN_SEC) {
      silentSec = 0;
      silentAt = null;
    }

    const edges = phraseEdges.get(phrase) ?? { lo: note.midi, hi: note.midi };
    const ranged = edges.hi - edges.lo >= EDGE_SPAN_SEMITONES;
    const leadsIn = prevNote !== null && note.start - (prevNote.start + prevNote.duration) < 0.3 * speed;
    return {
      i,
      phrase,
      note,
      w,
      cover,
      missLoss: w * (1 - cover),
      lagLoss,
      pitchLoss,
      err,
      sd,
      sink,
      long,
      sank,
      wavered,
      onsetSec,
      silentSec,
      silentAt,
      high: ranged && note.midi >= edges.hi - EDGE_WITHIN,
      low: ranged && note.midi <= edges.lo + EDGE_WITHIN,
      topOfTake: note.midi === topMidi,
      leap: prevNote && leadsIn ? Math.abs(note.midi - prevNote.midi) : 0,
      prev: prevIndex,
      joins: phrases.length > 1 && phrase !== phrases[0] && i === ph.from,
      trailing: false,
    };
  });
  // The notes after the last one sung in each phrase: the singing stopped there.
  const lastSung = new Map<number, number>();
  reads.forEach((r, k) => {
    if (r.cover >= UNSUNG_COVER) lastSung.set(r.phrase, k);
  });
  reads.forEach((r, k) => {
    r.trailing = k > (lastSung.get(r.phrase) ?? -1);
  });

  return { reads, cracks: findCracks(take, track, reads, speed), silent: !track.some((f, k) => voiced(f) && al.frameToNote[k] >= 0), phrases };
}

/** The read of the note at song time `t`: the one sounding, else the nearest. */
function readAt(reads: readonly NoteRead[], t: number): number {
  let best = -1;
  let bestD = Infinity;
  reads.forEach((r, k) => {
    const end = r.note.start + r.note.duration;
    const d = t < r.note.start ? r.note.start - t : t > end ? t - end : 0;
    if (d < bestD) {
      bestD = d;
      best = k;
    }
  });
  return best;
}

/** Median pitch of the voiced frames in [a, b). */
function pitchIn(track: readonly PitchFrame[], a: number, b: number): { midi: number; frames: number } {
  const xs: number[] = [];
  for (let k = frameAt(track, a); k < track.length && track[k].t < b; k++) if (voiced(track[k])) xs.push(track[k].midi);
  return { midi: xs.length > 0 ? median(xs) : NaN, frames: xs.length };
}

/**
 * The breaks: the crack detector's jumps (and dropouts the voice came back from at another pitch), on the take's real
 * time, inside the judged phrases, that no written note change explains and after which the pitch stayed away (a detector
 * blip comes straight back).
 */
function findCracks(take: SongTake, track: readonly PitchFrame[], reads: readonly NoteRead[], speed: number): Crack[] {
  if (reads.length === 0) return [];
  const realTime = speed === 1 ? track : track.map((f) => ({ ...f, t: f.t / speed }));
  const out: Crack[] = [];
  for (const e of detectCracks(realTime)) {
    if (e.kind === 'dropout' && e.cents === undefined) continue;
    const t = e.t * speed;
    const k = readAt(reads, t);
    if (k < 0) continue;
    const r = reads[k];
    const ph = take.song.phrases[r.phrase];
    if (t < ph.start - EXPLAIN_SEC * speed || t > ph.end + EXPLAIN_SEC * speed) continue;
    const size = e.cents ?? 0;
    const nearStart = (b: NoteRead): boolean => Math.abs(t - b.note.start) <= EXPLAIN_SEC * speed;
    // A silence the voice came back from on another pitch is a consonant or a breath when a note starts there: only one in
    // the middle of a note is a break.
    if (e.kind === 'dropout' && reads.some(nearStart)) continue;
    // A jump near a written note change (from the note sung before it, across a breath too), about as big: that is the
    // melody, not a break.
    const explained = reads.some((b, q) => {
      if (q === 0 || !nearStart(b)) return false;
      const interval = Math.abs(b.note.midi - reads[q - 1].note.midi) * 100;
      return interval >= 100 && size <= interval + EXPLAIN_SLACK_CENTS;
    });
    if (explained) continue;
    if (e.kind === 'jump') {
      const window = PERSIST_SEC * speed;
      const before = pitchIn(track, t - window, t + 1e-6);
      const after = pitchIn(track, t + 1e-6 + (e.durationMs / 1000) * speed, t + 2 * window + (e.durationMs / 1000) * speed);
      const stayed = after.frames >= 3 && Number.isFinite(before.midi) && Math.abs(after.midi - before.midi) * 100 >= PERSIST_CENTS;
      const cutOut = after.frames < 2;
      if (!stayed && !cutOut) continue;
    }
    out.push({ t, cents: size, read: k });
  }
  return out;
}

// ---------------------------------------------------------------- what cost the most

type Cause = 'cracks' | 'unsung' | 'breath' | 'join' | 'late' | 'early' | 'leap' | 'high' | 'low' | 'off' | 'flat' | 'sharp' | 'unsteady';

/** Ties go to the first: the more specific cause, the one a singer can act on. */
const PRIORITY: readonly Cause[] = ['cracks', 'unsung', 'breath', 'join', 'late', 'early', 'leap', 'high', 'low', 'off', 'flat', 'sharp', 'unsteady'];

const TIP_OF: Readonly<Record<Cause, SongTipId>> = {
  cracks: 'song.cracks',
  unsung: 'song.unsung',
  breath: 'song.breath',
  join: 'song.join',
  late: 'song.late',
  early: 'song.early',
  leap: 'song.leap',
  high: 'song.high',
  low: 'song.low',
  off: 'song.off-notes',
  flat: 'song.flat',
  sharp: 'song.sharp',
  unsteady: 'song.unsteady',
};

interface Charges {
  /** Real seconds of note time lost, per cause. */
  total: Map<Cause, number>;
  /** Per cause, per read: what that note lost to it. */
  byRead: Map<Cause, Map<number, number>>;
  /** The flat and sharp losses went both ways: they were merged into 'off'. */
  scattered: boolean;
  /** Per phrase (index into song.phrases): where its notes typically sat (a weighted median), and its lean (a weighted mean). */
  baseline: Map<number, number>;
  bias: Map<number, number>;
}

/** Where the sung notes of each phrase typically sat, and their lean: signed cents weighted by how much of each was sung. */
function phraseLeans(tr: TakeRead): { baseline: Map<number, number>; bias: Map<number, number> } {
  const baseline = new Map<number, number>();
  const bias = new Map<number, number>();
  for (const p of tr.phrases) {
    const sung = tr.reads.filter((n) => n.phrase === p && n.err !== null && n.cover >= UNSUNG_COVER);
    if (sung.length === 0) continue;
    const weight = (n: NoteRead): number => n.w * n.cover;
    const total = sung.reduce((s, n) => s + weight(n), 0);
    bias.set(p, sung.reduce((s, n) => s + weight(n) * (n.err ?? 0), 0) / total);
    const sorted = [...sung].sort((a, b) => (a.err ?? 0) - (b.err ?? 0));
    let acc = 0;
    for (const n of sorted) {
      acc += weight(n);
      if (acc >= total / 2) {
        baseline.set(p, n.err ?? 0);
        break;
      }
    }
  }
  return { baseline, bias };
}

function charge(c: Charges, cause: Cause, read: number, loss: number): void {
  if (!(loss > 0)) return;
  c.total.set(cause, (c.total.get(cause) ?? 0) + loss);
  let per = c.byRead.get(cause);
  if (!per) {
    per = new Map();
    c.byRead.set(cause, per);
  }
  per.set(read, (per.get(read) ?? 0) + loss);
}

function chargeTake(tr: TakeRead): Charges {
  const c: Charges = { total: new Map(), byRead: new Map(), scattered: false, ...phraseLeans(tr) };
  const cracked = new Set(tr.cracks.map((k) => k.read));
  for (let k = 0; k < tr.reads.length; k++) {
    const n = tr.reads[k];
    charge(c, n.joins ? 'join' : 'late', k, n.lagLoss);
    let rest = n.missLoss;
    if (n.onsetSec !== null && n.onsetSec >= LATE_SEC && rest > 0) {
      const part = Math.min(rest, n.onsetSec);
      charge(c, n.joins ? 'join' : 'late', k, part);
      rest -= part;
    }
    if (n.onsetSec !== null && n.onsetSec <= -EARLY_SEC) charge(c, 'early', k, 0.5 * Math.min(n.w, -n.onsetSec));
    if (rest > 0 && n.silentSec > 0) {
      const part = Math.min(rest, n.silentSec);
      charge(c, 'breath', k, part);
      rest -= part;
    }
    if (rest > 0) {
      if (n.trailing) charge(c, 'unsung', k, rest);
      else if (n.joins && n.cover < UNSUNG_COVER) charge(c, 'join', k, rest);
      else if (n.low && n.cover < QUIET_COVER) charge(c, 'low', k, rest);
      else charge(c, 'unsung', k, rest);
    }
    const pitch = n.pitchLoss;
    if (pitch > 0) {
      const e = n.err;
      // A leap, the top or bottom of a phrase, or a wrong note stands out from where the rest of its phrase sat: a phrase
      // sung flat throughout is a flat phrase, not a set of flat high notes.
      const rel = e === null ? null : e - (c.baseline.get(n.phrase) ?? 0);
      const both = (min: number): boolean => e !== null && rel !== null && Math.abs(e) >= min && Math.abs(rel) >= min;
      if (cracked.has(k)) charge(c, 'cracks', k, pitch);
      else if (n.long && (n.sank || n.wavered)) charge(c, 'unsteady', k, pitch);
      else if (e === null) charge(c, 'unsung', k, pitch);
      else if (Math.abs(e) < NOISE_CENTS) continue; // centred on the note: what it lost is jitter or a vibrato, not a lean
      else if (n.leap >= LEAP_SEMITONES && both(LEAP_MISS_CENTS)) charge(c, 'leap', k, pitch);
      else if (n.high && e <= -HIGH_FLAT_CENTS && rel !== null && rel <= -HIGH_FLAT_CENTS) charge(c, 'high', k, pitch);
      else if (n.low && both(LOW_OFF_CENTS)) charge(c, 'low', k, pitch);
      else if (both(OFF_NOTE_CENTS)) charge(c, 'off', k, pitch);
      else charge(c, e < 0 ? 'flat' : 'sharp', k, pitch);
    }
  }
  for (const crack of tr.cracks) charge(c, 'cracks', crack.read, CRACK_COST_SEC);

  // The lean: flat or sharp only when most of that loss went one way; misses both ways are wrong notes, not a lean.
  const flat = c.total.get('flat') ?? 0;
  const sharp = c.total.get('sharp') ?? 0;
  const both = flat + sharp;
  if (both > 0) {
    const keep: Cause | null = flat >= LEAN_SHARE * both ? 'flat' : sharp >= LEAN_SHARE * both ? 'sharp' : null;
    if (keep === null) {
      c.scattered = true;
      for (const way of ['flat', 'sharp'] as const) {
        for (const [read, loss] of c.byRead.get(way) ?? []) charge(c, 'off', read, loss);
        c.total.delete(way);
        c.byRead.delete(way);
      }
    } else {
      const drop = keep === 'flat' ? 'sharp' : 'flat';
      c.total.delete(drop);
      c.byRead.delete(drop);
    }
  }
  return c;
}

function mainCause(c: Charges): Cause | null {
  let best: Cause | null = null;
  let bestLoss = 0;
  for (const cause of PRIORITY) {
    const loss = c.total.get(cause) ?? 0;
    if (loss > bestLoss + 1e-9) {
      best = cause;
      bestLoss = loss;
    }
  }
  return best;
}

// ---------------------------------------------------------------- the words for it

interface Wording {
  take: SongTake;
  tr: TakeRead;
  words: Map<number, PhraseWords>;
  notation: Notation;
}

function wordsOf(wd: Wording, phrase: number): PhraseWords {
  let pw = wd.words.get(phrase);
  if (!pw) {
    const ph = wd.take.song.phrases[phrase];
    pw = phraseWords(wd.take.song, ph.from, ph.to);
    wd.words.set(phrase, pw);
  }
  return pw;
}

/** “ho-”, “the second note of “-ing””, or “note 3” for a note without words. */
function noteLabel(wd: Wording, r: NoteRead): string {
  const ph = wd.take.song.phrases[r.phrase];
  const pw = wordsOf(wd, r.phrase);
  const s = pw.syllableOf[r.i - ph.from] ?? -1;
  const syl = s >= 0 ? pw.syllables[s] : undefined;
  if (!syl || syl.label === '') return `note ${r.i - ph.from + 1} of the phrase`;
  if (syl.first === r.i) return `“${syl.label}”`;
  let nth = 1;
  for (let i = syl.first + 1; i <= r.i; i++) if (pw.syllableOf[i - ph.from] === s) nth += 1;
  return `the ${P.ordinal(nth)} note of “${syl.label}”`;
}

/** “ho-” in “O holy night” at 0:12 */
function where(wd: Wording, r: NoteRead, t: number = r.note.start): string {
  const ph = wd.take.song.phrases[r.phrase];
  const pw = wordsOf(wd, r.phrase);
  const s = pw.syllableOf[r.i - ph.from] ?? -1;
  const syl = s >= 0 ? pw.syllables[s] : undefined;
  const context = syl && syl.label !== '' ? contextOf(pw, syl.word) : '';
  // The words around it, unless they are only the word itself ("night" alone needs no "in “night”").
  const inWords = context !== '' && syl !== undefined && context !== pw.words[syl.word] ? ` in “${context}”` : '';
  return `${noteLabel(wd, r)}${inWords} at ${P.clock(t)}`;
}

/** Reads charged to a cause, worst first. */
function worst(c: Charges, cause: Cause): number[] {
  const per = c.byRead.get(cause);
  if (!per) return [];
  return [...per.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]).map(([read]) => read);
}

function spot(t: number, label: string): ProblemSpot {
  return { t, label };
}

/** "the phrase", "these phrases", "the song". */
function scopeWords(take: SongTake, tr: TakeRead): string {
  if (take.phrase === null && tr.phrases.length > 1) return 'the song';
  return tr.phrases.length > 1 ? 'these phrases' : 'the phrase';
}

function describe(cause: Cause, c: Charges, wd: Wording): { what: string; spots: ProblemSpot[] } {
  const { tr } = wd;
  const ranked = worst(c, cause);
  const r0 = ranked.length > 0 ? tr.reads[ranked[0]] : undefined;
  const chips = (label: (r: NoteRead) => string): ProblemSpot[] =>
    ranked.slice(0, MAX_SPOTS).map((k) => spot(tr.reads[k].note.start, `${P.clock(tr.reads[k].note.start)}, ${noteLabel(wd, tr.reads[k])}, ${label(tr.reads[k])}`));
  const off = (r: NoteRead): string => (r.err === null ? 'hard to hear' : P.offWords(r.err));

  switch (cause) {
    case 'cracks': {
      // Worst first by size in whole half steps (a few cents either way is the detector's jitter), then the earliest.
      const breaks = [...tr.cracks].sort((a, b) => Math.round(b.cents / 100) - Math.round(a.cents / 100) || a.t - b.t);
      const first = breaks[0];
      const r = tr.reads[first.read];
      const top = r.topOfTake ? ', the highest note' : r.high ? ', the top of the phrase' : '';
      const what =
        breaks.length === 1
          ? `Your voice broke on ${where(wd, r, first.t)}${top}.`
          : `Your voice broke ${P.times(breaks.length)}, most clearly on ${where(wd, r, first.t)}${top}.`;
      const spots = breaks.slice(0, MAX_SPOTS).map((b) => {
        const rb = tr.reads[b.read];
        return spot(b.t, `${P.clock(b.t)}, ${noteLabel(wd, rb)}, voice broke${rb.topOfTake ? ' on the highest note' : ''}`);
      });
      return { what, spots };
    }
    case 'unsung': {
      const total = tr.reads.length;
      const missed = tr.reads.filter((n) => n.cover < UNSUNG_COVER);
      const sungCount = total - missed.length;
      const lastSung = tr.reads.reduce((acc, n, k) => (n.cover >= UNSUNG_COVER ? k : acc), -1);
      const trailing = lastSung >= 0 && lastSung < total - 1 && tr.reads.slice(lastSung + 1).every((n) => n.cover < UNSUNG_COVER);
      let what: string;
      if (trailing) {
        const next = tr.reads[lastSung + 1];
        what = `The singing stopped before ${where(wd, next)}, so the last ${P.count(total - lastSung - 1, 'note')} went unsung.`;
      } else if (missed.length > 0 && r0) {
        const firstMissed = missed.includes(r0) ? r0 : missed[0];
        what = `You sang ${sungCount} of the ${total} notes; ${where(wd, firstMissed)} was not sung.`;
      } else if (r0) {
        what = `Some notes were only partly sung; ${where(wd, r0)} came through for ${P.shareText(r0.cover)} of its length.`;
      } else {
        what = 'Some notes went unsung.';
      }
      return { what, spots: chips((n) => (n.cover < UNSUNG_COVER ? 'not sung' : 'only partly sung')) };
    }
    case 'breath': {
      const r = r0 ?? tr.reads[0];
      return {
        what: `The sound dropped out for ${P.durationWords(r.silentSec)} in the middle of ${tr.phrases.length > 1 ? 'a phrase' : 'the phrase'}, on ${where(wd, r, r.silentAt ?? r.note.start)}.`,
        spots: ranked.slice(0, MAX_SPOTS).map((k) => {
          const n = tr.reads[k];
          const t = n.silentAt ?? n.note.start;
          return spot(t, `${P.clock(t)}, ${noteLabel(wd, n)}, the sound dropped out`);
        }),
      };
    }
    case 'join': {
      const r = r0 ?? tr.reads[0];
      const how = r.onsetSec !== null && r.onsetSec >= LATE_SEC ? `you came in ${P.durationWords(r.onsetSec)} late` : 'the first word went unsung';
      return {
        what: `After the breath between the phrases ${how}, on ${where(wd, r)}.`,
        spots: chips((n) => (n.onsetSec !== null && n.onsetSec >= LATE_SEC ? `${P.durationWords(n.onsetSec)} late after the breath` : 'not sung after the breath')),
      };
    }
    case 'late':
    case 'early': {
      const late = cause === 'late';
      const timed = tr.reads.filter((n) => n.onsetSec !== null && (late ? n.onsetSec >= LATE_SEC : n.onsetSec <= -EARLY_SEC));
      const r = r0 ?? timed[0] ?? tr.reads[0];
      const by = Math.abs(r.onsetSec ?? 0);
      const typical = timed.length > 0 ? median(timed.map((n) => Math.abs(n.onsetSec ?? 0))) : by;
      const what =
        timed.length <= 1
          ? `You came in ${late ? 'late' : 'early'} on ${where(wd, r)}, by ${P.durationWords(by)}.`
          : late
            ? `You came in late on ${timed.length} of the words, by ${P.durationWords(typical)} as a rule; ${where(wd, r)} was the latest.`
            : `You came in ahead of the beat on ${timed.length} of the words, by ${P.durationWords(typical)} as a rule; ${where(wd, r)} was the earliest.`;
      return { what, spots: chips((n) => `${P.durationWords(Math.abs(n.onsetSec ?? 0))} ${late ? 'late' : 'early'}`) };
    }
    case 'leap': {
      const r = r0 ?? tr.reads[0];
      const from = r.prev !== null ? tr.reads.find((n) => n.i === r.prev) : undefined;
      const dir = from && from.note.midi > r.note.midi ? 'down' : 'up';
      const fromLabel = from ? ` from ${noteLabel(wd, from)}` : '';
      return {
        what: `The big jump ${dir}${fromLabel} to ${where(wd, r)} landed ${off(r)}.`,
        spots: chips((n) => `after the jump, ${off(n)}`),
      };
    }
    case 'high': {
      const r = r0 ?? tr.reads[0];
      const name = P.nameOf(r.note.midi, wd.notation);
      const top = wd.take.song.notes.slice(wd.take.song.phrases[r.phrase].from, wd.take.song.phrases[r.phrase].to).every((n) => n.midi <= r.note.midi);
      const what =
        ranked.length === 1
          ? `${top ? 'The highest note' : 'A high note'}, ${name} on ${where(wd, r)}, came out ${off(r)}.`
          : `The high notes came out flat; ${name} on ${where(wd, r)} was ${off(r)}.`;
      return { what, spots: chips(off) };
    }
    case 'low': {
      const r = r0 ?? tr.reads[0];
      const name = P.nameOf(r.note.midi, wd.notation);
      const quiet = r.cover < QUIET_COVER;
      const what = quiet
        ? `The low notes were too quiet to follow: ${name} on ${where(wd, r)} came through for only ${P.shareText(r.cover)} of its length.`
        : `The lowest notes came out off: ${name} on ${where(wd, r)} was ${off(r)}.`;
      return { what, spots: chips((n) => (n.cover < QUIET_COVER ? 'too quiet to follow' : off(n))) };
    }
    case 'off': {
      const r = r0 ?? tr.reads[0];
      const offNotes = ranked.map((k) => tr.reads[k]);
      if (c.scattered) {
        const flat = offNotes.filter((n) => (n.err ?? 0) < 0).length;
        const sharp = offNotes.length - flat;
        return {
          what: `Your notes landed off the middle both ways (${flat} flat and ${sharp} sharp); on ${where(wd, r)} you were ${off(r)}.`,
          spots: chips(off),
        };
      }
      const k = offNotes.filter((n) => n.err !== null && Math.abs(n.err) >= OFF_NOTE_CENTS).length || 1;
      return {
        what: `${k === 1 ? 'One note' : `${P.sentence(P.numberWord(k))} notes`} landed on a different note from the one written; on ${where(wd, r)} you were ${off(r)}.`,
        spots: chips(off),
      };
    }
    case 'flat':
    case 'sharp': {
      const r = r0 ?? tr.reads[0];
      // The lean of the phrase the worst note is in, when it went the same way.
      const lean = c.bias.get(r.phrase);
      const agrees = lean !== undefined && Math.abs(lean) >= BIAS_MIN_CENTS && lean < 0 === (cause === 'flat');
      const notesThere = tr.reads.filter((n) => n.phrase === r.phrase).length;
      const whole = tr.phrases.length > 1 ? 'that phrase as a whole was' : 'overall you sang';
      const overall = agrees && notesThere > 1 ? `; ${whole} ${P.offWords(lean)}` : '';
      return { what: `On ${where(wd, r)} you were ${off(r)}${overall}.`, spots: chips(off) };
    }
    case 'unsteady': {
      const r = r0 ?? tr.reads[0];
      const what = r.wavered
        ? `Your long notes wavered: ${where(wd, r)} was ${P.steadiness(r.sd ?? NaN)}.`
        : `Your long notes sank as you held them: ${where(wd, r)} slipped ${P.pitchDistance(Math.abs(r.sink ?? 0))} by its end.`;
      return { what, spots: chips((n) => (n.wavered ? P.steadiness(n.sd ?? NaN) : 'sank as you held it')) };
    }
  }
}

/** The main problem of a missed take, located and in plain words. */
function locateSong(take: SongTake, tr: TakeRead, notation: Notation): TakeProblem {
  const wd: Wording = { take, tr, words: new Map(), notation };
  if (tr.silent || tr.reads.length === 0) {
    return { tipId: 'song.unsung', metric: null, what: `The app heard nothing it could follow during ${scopeWords(take, tr)}.`, spots: [] };
  }
  const charges = chargeTake(tr);
  const cause = mainCause(charges);
  // Nothing the reading can pin down (the scorer and this reading part ways): say the score plainly.
  if (cause === null) {
    return { tipId: 'song.off-notes', metric: 'song.phraseScore', what: `This take scored ${P.shareText(take.attempt.score)}, short of the ${P.shareText(SONG_PASS_SCORE)} that passes.`, spots: [] };
  }
  const found = describe(cause, charges, wd);
  return { tipId: TIP_OF[cause], metric: 'song.phraseScore', what: P.sentence(found.what), spots: found.spots.slice(0, MAX_SPOTS) };
}

// ---------------------------------------------------------------- since last time

function speedWords(speed: number): string {
  if (isFullSpeed(speed)) return 'full speed';
  if (Math.abs(speed - 0.5) < 0.01) return 'half speed';
  return 'slowed down';
}

function movedBy(delta: number, step: number): boolean | null {
  if (delta >= step) return true;
  if (delta <= -step) return false;
  return null;
}

/** The same phrases sung the time before against this time: the score, the time in tune, and the speed when it changed. */
function songProgressLines(previous: AttemptRecord | null, current: AttemptRecord): ProgressLine[] {
  if (!previous) return [];
  const lines: ProgressLine[] = [
    { label: 'Score', before: P.shareText(previous.score), now: P.shareText(current.score), better: movedBy(current.score - previous.score, 0.03) },
  ];
  const tolBefore = previous.metrics['song.inTolerancePct'];
  const tolNow = current.metrics['song.inTolerancePct'];
  if (finite(tolBefore) && finite(tolNow)) {
    lines.push({ label: 'Time in tune', before: P.percentText(tolBefore), now: P.percentText(tolNow), better: movedBy(tolNow - tolBefore, 3) });
  }
  const sb = previous.songSpeed;
  const sn = current.songSpeed;
  if (finite(sb) && finite(sn) && Math.abs(sb - sn) > 0.01) {
    lines.push({ label: 'Speed', before: speedWords(sb), now: speedWords(sn), better: sn > sb });
  }
  return lines;
}

// ---------------------------------------------------------------- the coaching

/** "Next, sing phrase 3 at full speed.": the step after a pass (song/practice.ts nextStepAfter) in plain words. */
export function nextStepLine(step: PracticeStep | null | undefined): string {
  if (!step) return 'That is the whole song learned. Sing it through again any time to keep it.';
  const p = step.phrase;
  switch (step.kind) {
    case 'listen':
      return 'Next, listen to the whole song once.';
    case 'phrase-slow':
      return `Next, sing phrase ${(p?.from ?? 0) + 1} slowly.`;
    case 'phrase':
      return `Next, sing phrase ${(p?.from ?? 0) + 1} at full speed.`;
    case 'join':
      return `Next, join phrases ${(p?.from ?? 0) + 1} and ${(p?.from ?? 0) + 2}: sing them together.`;
    case 'whole':
      return 'Next, sing the whole song.';
  }
}

/** An earlier level the ladder names, offered only when the log shows it passed (never the Range finder). */
function practiseLevelMove(levelId: string | undefined, log: readonly AttemptRecord[]): CoachMove | null {
  if (levelId === undefined) return null;
  const level = getLevel(levelId);
  const def = level ? getExercise(level.exerciseId) : undefined;
  if (!level || !def || def.kind === 'range-finder') return null;
  if (!log.some((a) => a.deletedAt === null && a.levelId === levelId && a.passed)) return null;
  return { kind: 'practise-level', levelId, title: level.kind === 'boss' ? def.title : level.title };
}

/** The phrase (index into song.phrases) the problem sits in: its first spot's, else the judged phrase that scored lowest. */
function problemPhrase(take: SongTake, tr: TakeRead, problem: TakeProblem): number | null {
  if (tr.phrases.length === 0) return null;
  const t = problem.spots[0]?.t;
  if (t !== undefined) {
    const k = readAt(tr.reads, t);
    if (k >= 0) return tr.reads[k].phrase;
  }
  let lowest: PhraseScore | null = null;
  for (const s of take.scores) if (!lowest || s.pitchScore < lowest.pitchScore) lowest = s;
  return lowest?.phraseIndex ?? tr.phrases[0];
}

/** The coaching for a finished song take; `log` is the profile's attempt log AFTER this take was written. */
export function coachSongTake(take: SongTake, log: readonly AttemptRecord[], opts?: { notation?: Notation; now?: number }): Coaching {
  const { attempt } = take;
  const at = log.findIndex((a) => a.id === attempt.id);
  const upTo = at >= 0 ? log.slice(0, at + 1) : [...log, attempt];
  const before = upTo.slice(0, -1);
  const passed = attempt.passed;
  const songId = take.song.id;
  const misses = passed ? 0 : 1 + songMissesInARow(songId, take.phrase, before);
  const depth: CoachDepth = passed ? 1 : depthFor(misses);
  const notation = opts?.notation ?? 'sharps';

  const track = cleanOctaveSpikes(take.track);
  const tr = readTake(take, track);

  let problem: TakeProblem;
  if (passed) {
    problem = { tipId: 'song.polish', metric: 'song.phraseScore', what: `That passed at ${P.shareText(attempt.score)}.`, spots: [] };
  } else {
    problem = locateSong(take, tr, notation);
  }

  const rows = songTakes(songId, before);
  let previous: AttemptRecord | null = null;
  for (let i = rows.length - 1; i >= 0; i--) {
    if (sameSpan(rows[i].phrase, take.phrase)) {
      previous = rows[i].attempt;
      break;
    }
  }
  const progress = songProgressLines(previous, attempt);

  const tipId = problem.tipId as SongTipId;
  const ladder = ladderFor(tipId);
  const moves: CoachMove[] = [];
  if (!passed) {
    const phrase = problemPhrase(take, tr, problem);
    const several = take.phrase === null ? take.song.phrases.length > 1 : take.phrase.to - take.phrase.from > 1;
    if (several && phrase !== null && tr.phrases.length > 1) moves.push(phraseMove(phrase));
    if (depth >= 2) moves.push({ kind: 'listen-slow' });
    // A level that trains the latest check-up's focus is offered from the second miss, as in the exercise coach.
    const level = practiseLevelMove(ladder?.practiseLevelId, upTo);
    if (level?.kind === 'practise-level' && depth >= (checkupFocusLevels(before).has(level.levelId) ? FOCUS_PRACTISE_DEPTH : 4)) moves.push(level);
    if (depth >= 3) moves.push({ kind: 'send-to-claude' });
  }
  const now = opts?.now ?? Date.parse(attempt.createdAt);
  if (misses >= REST_MISSES || (Number.isFinite(now) && restDue(upTo, now))) moves.push({ kind: 'rest' });

  let tip: string;
  if (passed) {
    tip = nextStepLine(nextStepAfter(songPractice(take.song, upTo), take.phrase, take.speed));
  } else {
    tip = ladder?.tip ?? SONG_FALLBACK_TIPS[tipId] ?? SONG_FALLBACK_TIPS['song.off-notes'];
  }

  return {
    depth,
    missesInARow: misses,
    passed,
    problem,
    tip,
    why: !passed && depth >= 2 ? (ladder?.why ?? null) : null,
    steps: !passed && depth >= 3 ? (ladder?.steps ?? []) : [],
    easier: !passed && depth >= 4 ? (ladder?.easier ?? null) : null,
    progress,
    moves,
  };
}
