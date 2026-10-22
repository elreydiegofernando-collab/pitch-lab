/**
 * Standard MIDI file import via @tonejs/midi (docs/RESEARCH.md §7). Unlike UltraStar, a MIDI
 * file does not say which track is the melody, so every track is scored and the best one is
 * picked automatically; every candidate (rejected ones too) is returned so a UI can offer a
 * manual override (`trackIndex`).
 *
 * Melody pick: a composite score of non-percussion, monophonic-ness, vocal-range fit
 * (E2-C6, the detector's range), a sensible notes-per-second density, enough notes to be a
 * tune, and a name match (/vocal|melody|lead|voice|voz/i) on the track or instrument name.
 *
 * Melody line: a track can hold chords, so the chosen notes are reduced to a SINGLE line
 * with the "skyline" rule (a pitch struck above a held one takes over; one struck below a
 * held higher note is accompaniment and is dropped; tiny legato overlaps are trimmed), so
 * Song.notes never overlap and each can be sung.
 *
 * Lyrics: scanned from the raw bytes on EVERY track (midi-events.ts: lyric events, karaoke
 * text events, "/" and "\" line marks, "@T" title and artist), then attached to the nearest
 * note onset within IMPORT_RULES.lyricMatchSec. @tonejs/midi alone would only see the first track.
 * When given an already-parsed `Midi` (no bytes) only its `header.meta` is available.
 *
 * Lyric spacing: imported charts keep their own spacing (types.ts), with ONE exception made here. A file
 * whose syllables hold no whitespace at all (LilyPond's hymn MIDIs write one event per syllable: "A", "maz",
 * "ing", "grace!") has no spacing to keep, and verbatim a phrase would read "Amazinggrace!". Each syllable then
 * gets one LEADING space (the bundled and UltraStar word-start convention) unless the previous syllable ends
 * with a hyphen, and the first syllable of every phrase loses it again. A file with whitespace anywhere in its
 * syllables (karaoke "lo ", " on ") stays verbatim.
 *
 * Phrases (midi-phrases.ts): the notes separated by rests of at least CONFIG.song.phraseGapMs, plus any karaoke
 * line break; then, because score-sequenced hymns are legato and have neither, the ends of lyric clauses
 * (a syllable ending in , ; : . ! ?); then a length cap for whatever is still long (lyric-less legato tunes).
 *
 * Timing: @tonejs/midi already turns ticks into seconds through the file's tempo map, so
 * mid-song tempo changes play at the right times; Song.bpm shows the opening tempo. Leading
 * silence beyond a 2 s lead-in is trimmed and recorded as Song.offsetMs (backing position =
 * song time + offset), the same convention as UltraStar's #GAP, so a backing track stays aligned
 * and the singer does not wait through a 20 s intro.
 */
import { Midi } from '@tonejs/midi';
import type { Track } from '@tonejs/midi';
import type { Song, SongNote } from './types';
import { hashBytes, hashContent } from './hash';
import { clamp01 } from '../core/math';
import { rateSong } from './difficulty';
import { extractLyrics, scanMidiTextEvents, type MidiTextEvent } from './midi-events';
import { buildPhrases, isBareLyrics, spacedSyllable, stripPhraseLeadingSpace } from './midi-phrases';

export class MidiImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MidiImportError';
  }
}

/** E2..C6 (MIDI 40..84): the pitch detector's supported range (CONFIG.audio.minHz/maxHz). */
const VOCAL_RANGE_MIDI: readonly [number, number] = [40, 84];

/**
 * Melody-track heuristics. CONFIG has no song-import section (reported in contractIssues),
 * so they are named here. All PROVISIONAL.
 */
const IMPORT_RULES = {
  /** Score of a percussion track: never auto-picked. */
  percussionScore: -1000,
  monophonicWeight: 3,
  rangeFitWeight: 3,
  /** Reaches 1 at this many notes: a three-note track cannot be a melody. */
  sizeWeight: 2,
  sizeFullNotes: 24,
  densityWeight: 1,
  /** Melodies run about this many notes per second; the density score falls off by octaves of ratio. */
  densityIdealNps: 2,
  /**
   * Melodies sit above the accompaniment: the median pitch scores 0 at registerLowMidi and 1 at
   * registerHighMidi. A mild nudge (it decides piano right hand over left, where the bass is the
   * "cleaner" line) that cannot outvote a polyphonic track or one outside the singing range.
   */
  registerWeight: 1.5,
  registerLowMidi: 48,
  registerHighMidi: 72,
  /** A melody runs through the song: the share of the file's length the track spans (first note to last end) scores up to this. */
  coverageWeight: 1.5,
  nameMatchBonus: 2.5,
  /** Two consecutive notes overlapping by more than this are treated as polyphony (legato overlaps are tiny). */
  overlapToleranceSec: 0.06,
  /** Skyline: a note struck below a held note by at most this long and this share of it is legato, not accompaniment. */
  legatoMaxOverlapSec: 0.25,
  legatoMaxShare: 0.5,
  /** Notes shorter than this cannot be sung (and are usually trimming debris). */
  minNoteSec: 0.03,
  /** A lyric event attaches to a note whose onset is within this many seconds. */
  lyricMatchSec: 0.3,
  /** Plain text events count as lyrics only if at least this many, and this share of them, line up with notes. */
  minTextLyricMatches: 3,
  minTextLyricShare: 0.5,
  /** Leading silence is trimmed down to this much (MidiImportOptions.leadInSec). */
  defaultLeadInSec: 2,
} as const;

const NAME_MATCH_RE = /vocal|melody|lead|voice|voz/i;
/** First-track names sequencers write when nobody named the song; the whole name must match, so "Tempo di Valse" survives. */
const GENERIC_TITLE_RE = /^(untitled|unnamed|tempo( track)?|conductor( track)?|control( track)?|track\s*\d*|sequence\s*\d*|midi( file)?|new song)$/i;

export interface MidiTrackCandidate {
  /** Index into `midi.tracks` (what `MidiImportOptions.trackIndex` expects). */
  index: number;
  name: string;
  /** General MIDI instrument name ('' when unknown). */
  instrument: string;
  score: number;
  noteCount: number;
  percussion: boolean;
  /** 0..1: share of consecutive note pairs that do not overlap (1 = a clean single line). */
  monophonicRatio: number;
  /** Notes per second over the track's own span. */
  density: number;
  /** 0..1: share of notes inside E2-C6. */
  rangeFitRatio: number;
  nameMatch: boolean;
  lowestMidi: number;
  highestMidi: number;
  /** Median pitch (the register the track lives in). */
  medianMidi: number;
  /** 0..1: share of the whole file's length between this track's first note and its last note end. */
  coverage: number;
}

export interface MidiImportResult {
  song: Song;
  /** Every track that has at least one note, scored, best first. */
  candidates: MidiTrackCandidate[];
  /** Index (into `midi.tracks`) of the track `song` was built from. */
  selectedTrackIndex: number;
  /** Tolerated oddities (no tempo event, tempo changes, unmatched lyrics ...). */
  warnings: string[];
  /** Syllables found in the file, and how many were attached to a melody note. */
  lyricSyllables: number;
  lyricsMatched: number;
}

export interface MidiImportOptions {
  /** Override the computed id. Default: content hash of the bytes plus the chosen track. */
  id?: string;
  /** Force this track (index into `midi.tracks`, see MidiImportResult.candidates) instead of the best candidate. */
  trackIndex?: number;
  /** Override the title (otherwise the karaoke @T header, then the file's first track name). */
  title?: string;
  /**
   * Song mode starts its clock at song time 0, so a melody that enters 20 s into the file would
   * leave the singer waiting in silence. By default (2 s) leading silence beyond this lead-in is
   * trimmed and recorded as Song.offsetMs (backing position = song time + offset), which keeps any
   * backing track the user adds aligned, exactly as UltraStar's #GAP does. Pass null to keep the
   * file's own timing.
   */
  leadInSec?: number | null;
}

type TrackStats = Omit<MidiTrackCandidate, 'index' | 'name' | 'score'>;

function scoreStats(track: Track, totalSec: number): TrackStats {
  const notes = [...track.notes].sort((a, b) => a.time - b.time);
  const n = notes.length;
  const percussion = track.channel === 9;

  let overlapping = 0;
  for (let i = 0; i + 1 < n; i++) {
    if (notes[i + 1].time - (notes[i].time + notes[i].duration) < -IMPORT_RULES.overlapToleranceSec) overlapping++;
  }
  const monophonicRatio = n > 1 ? 1 - overlapping / (n - 1) : n === 1 ? 1 : 0;

  let lastEnd = 0;
  let lowestMidi = Infinity;
  let highestMidi = -Infinity;
  let inRange = 0;
  for (const note of notes) {
    lastEnd = Math.max(lastEnd, note.time + note.duration);
    lowestMidi = Math.min(lowestMidi, note.midi);
    highestMidi = Math.max(highestMidi, note.midi);
    if (note.midi >= VOCAL_RANGE_MIDI[0] && note.midi <= VOCAL_RANGE_MIDI[1]) inRange++;
  }
  const span = n > 0 ? lastEnd - notes[0].time : 0;
  const instrument = track.instrument.name ?? '';
  const pitches = notes.map((x) => x.midi).sort((a, b) => a - b);
  const medianMidi = n === 0 ? 0 : n % 2 === 1 ? pitches[(n - 1) / 2] : (pitches[n / 2 - 1] + pitches[n / 2]) / 2;

  return {
    instrument,
    noteCount: n,
    percussion,
    monophonicRatio,
    density: span > 0 ? n / span : 0,
    rangeFitRatio: n > 0 ? inRange / n : 0,
    nameMatch: NAME_MATCH_RE.test(track.name) || NAME_MATCH_RE.test(instrument),
    lowestMidi: n > 0 ? lowestMidi : 0,
    highestMidi: n > 0 ? highestMidi : 0,
    medianMidi,
    coverage: totalSec > 0 ? clamp01(span / totalSec) : 1,
  };
}

function compositeScore(s: TrackStats): number {
  const R = IMPORT_RULES;
  if (s.percussion) return R.percussionScore;
  // Density score 1 at the ideal rate, 0.5 at half/double, 0 at a quarter/quadruple.
  const densityScore = s.density > 0 ? clamp01(1 - Math.abs(Math.log2(s.density / R.densityIdealNps)) / 2) : 0;
  const sizeScore = clamp01(s.noteCount / R.sizeFullNotes);
  const registerScore = clamp01((s.medianMidi - R.registerLowMidi) / (R.registerHighMidi - R.registerLowMidi));
  return (
    s.monophonicRatio * R.monophonicWeight +
    s.rangeFitRatio * R.rangeFitWeight +
    sizeScore * R.sizeWeight +
    densityScore * R.densityWeight +
    registerScore * R.registerWeight +
    s.coverage * R.coverageWeight +
    (s.nameMatch ? R.nameMatchBonus : 0)
  );
}

/**
 * Scores every non-empty track of a parsed MIDI file, best first. Exposed on its own so a
 * manual-override UI can list the choices without running the whole import.
 */
export function scoreMidiTracks(midi: Midi): MidiTrackCandidate[] {
  const candidates: MidiTrackCandidate[] = [];
  const totalSec = midi.tracks.length > 0 ? midi.duration : 0;
  midi.tracks.forEach((track, index) => {
    if (track.notes.length === 0) return;
    const stats = scoreStats(track, totalSec);
    candidates.push({ index, name: track.name, score: compositeScore(stats), ...stats });
  });
  // Stable: equal scores keep file order.
  return candidates.sort((a, b) => b.score - a.score);
}

interface RawNote {
  start: number;
  end: number;
  midi: number;
}

/**
 * Reduces a possibly polyphonic track to one singable line ("skyline"): notes are walked in
 * onset order; a note whose onset falls inside the previous kept note either takes over
 * (it is higher, or only a legato overlap) and trims that note, or is accompaniment under a
 * held note and is dropped. Exported for tests.
 */
export function monophonize(raw: readonly RawNote[]): RawNote[] {
  const R = IMPORT_RULES;
  const sorted = [...raw].sort((a, b) => a.start - b.start || b.midi - a.midi);
  const kept: RawNote[] = [];
  for (const n of sorted) {
    const cur = kept[kept.length - 1];
    if (!cur) {
      kept.push({ ...n });
      continue;
    }
    const overlap = cur.end - n.start;
    if (overlap <= 1e-6) {
      kept.push({ ...n });
      continue;
    }
    const legato = overlap <= R.legatoMaxOverlapSec && overlap <= R.legatoMaxShare * (cur.end - cur.start);
    if (legato || n.midi > cur.midi) {
      cur.end = n.start;
      kept.push({ ...n });
    }
    // else: struck under a held note: accompaniment, skipped.
  }
  return kept.filter((n) => n.end - n.start >= R.minNoteSec);
}

/** Index of the entry of the sorted `starts` nearest to `t`. */
function nearestIndex(starts: readonly number[], t: number): number {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (starts[mid] < t) lo = mid + 1;
    else hi = mid;
  }
  if (lo > 0 && Math.abs(starts[lo - 1] - t) <= Math.abs(starts[lo] - t)) return lo - 1;
  return lo;
}

function eventsFromHeader(midi: Midi): MidiTextEvent[] {
  const out: MidiTextEvent[] = [];
  for (const e of midi.header.meta) {
    if (e.type === 'lyrics' || e.type === 'text') out.push({ track: 0, ticks: e.ticks, kind: e.type, text: e.text });
  }
  return out;
}

function toBytes(data: ArrayLike<number> | ArrayBuffer): Uint8Array {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return Uint8Array.from(data);
}

/**
 * Imports a Song from MIDI bytes (ArrayBuffer, Uint8Array or a plain byte array), or from an
 * already-parsed @tonejs/midi `Midi` (handy for tests). Throws MidiImportError for an
 * unreadable file or one with no notes.
 */
export function importMidi(data: ArrayLike<number> | ArrayBuffer | Midi, opts: MidiImportOptions = {}): MidiImportResult {
  let midi: Midi;
  let bytes: Uint8Array | null = null;
  if (data instanceof Midi) {
    midi = data;
  } else {
    bytes = toBytes(data);
    try {
      midi = new Midi(bytes);
    } catch (e) {
      throw new MidiImportError(`Not a readable MIDI file: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  const warnings: string[] = [];
  const candidates = scoreMidiTracks(midi);
  if (candidates.length === 0) throw new MidiImportError('MIDI file has no track with notes');

  const selectedTrackIndex = opts.trackIndex ?? candidates[0].index;
  const track = midi.tracks[selectedTrackIndex];
  if (!track) throw new MidiImportError(`MIDI track ${selectedTrackIndex} does not exist`);
  if (track.notes.length === 0) throw new MidiImportError(`MIDI track ${selectedTrackIndex} ("${track.name}") has no notes`);
  const candidate = candidates.find((c) => c.index === selectedTrackIndex);
  if (candidate?.percussion) warnings.push(`Track ${selectedTrackIndex} ("${track.name}") is percussion; it has no melody to sing.`);

  const line = monophonize(track.notes.map((n) => ({ start: n.time, end: n.time + n.duration, midi: Math.round(n.midi) })));
  if (line.length === 0) throw new MidiImportError(`MIDI track ${selectedTrackIndex} ("${track.name}") has no notes long enough to sing`);
  if (line.length < track.notes.length * 0.75) {
    warnings.push(`Track ${selectedTrackIndex} is polyphonic: kept the top line (${line.length} of ${track.notes.length} notes).`);
  }
  const notes: SongNote[] = line.map((n) => ({ start: n.start, duration: n.end - n.start, midi: n.midi, lyric: '', type: 'normal' as const }));

  // Lyrics.
  const events = bytes ? scanMidiTextEvents(bytes) : eventsFromHeader(midi);
  const lyrics = extractLyrics(events);
  const starts = notes.map((n) => n.start);
  // Where does each syllable land? (-1: no melody note within lyricMatchSec)
  const placements = lyrics.syllables.map((syl) => {
    const t = midi.header.ticksToSeconds(syl.ticks);
    const idx = nearestIndex(starts, t);
    return Math.abs(starts[idx] - t) <= IMPORT_RULES.lyricMatchSec ? idx : -1;
  });
  const placed = placements.filter((i) => i >= 0).length;
  // Real lyric events are trusted even when they fit this track badly (they are lyrics for another
  // part, and the warning says so). Plain TEXT events are only words when most of them line up
  // with notes: a file with a handful of annotations ("Fuga 1", "Allegro") has no lyrics.
  const trusted =
    lyrics.source !== 'text' || (placed >= IMPORT_RULES.minTextLyricMatches && placed >= IMPORT_RULES.minTextLyricShare * lyrics.syllables.length);
  const forcedBreaks = new Set<number>();
  let lyricSyllables = 0;
  let matched = 0;
  // A file whose syllables hold no whitespace at all has no word spacing to keep (see the header): give each syllable
  // the word-start space, then take it off the first syllable of every phrase below.
  const bare = trusted && isBareLyrics(lyrics.syllables);
  if (trusted) {
    lyricSyllables = lyrics.syllables.length;
    lyrics.syllables.forEach((syl, k) => {
      const idx = placements[k];
      if (idx < 0) return;
      notes[idx].lyric += bare ? spacedSyllable(syl.text, lyrics.syllables[k - 1]?.text) : syl.text;
      if (syl.lineBreakBefore && idx > 0) forcedBreaks.add(idx);
      matched++;
    });
    if (lyricSyllables > 0 && matched < lyricSyllables) {
      warnings.push(`${lyricSyllables - matched} of ${lyricSyllables} lyric syllables did not line up with the melody track and were skipped.`);
    }
  }

  // Trim a long silent intro down to the lead-in (see MidiImportOptions.leadInSec). Whole milliseconds,
  // so the shift and Song.offsetMs agree exactly: backing position = new note time + offset = old time.
  const leadIn = opts.leadInSec === undefined ? IMPORT_RULES.defaultLeadInSec : opts.leadInSec;
  let trimmedMs = 0;
  if (leadIn !== null && Number.isFinite(leadIn) && leadIn >= 0 && notes[0].start > leadIn) {
    trimmedMs = Math.round((notes[0].start - leadIn) * 1000);
    for (const n of notes) n.start -= trimmedMs / 1000;
  }

  const tempos = midi.header.tempos;
  const rawBpm = tempos[0]?.bpm;
  // A corrupt tempo event (zero microseconds per beat) reads as an infinite bpm: treat it as missing.
  const bpm = rawBpm !== undefined && Number.isFinite(rawBpm) && rawBpm > 0 ? rawBpm : undefined;
  if (bpm === undefined) warnings.push('No usable tempo event found in the MIDI file; assumed 120 bpm for display.');
  else if (tempos.length > 1) warnings.push('The tempo changes during the song; Song.bpm shows the opening tempo (note times are exact).');

  let id = opts.id;
  if (id === undefined) {
    const base = bytes ? hashBytes(bytes) : hashContent(JSON.stringify(midi.toJSON()));
    id = `midi-${base}-t${selectedTrackIndex}`;
  }

  const phrases = buildPhrases(notes, forcedBreaks);
  if (bare) stripPhraseLeadingSpace(notes, phrases);

  const headerTitle = midi.header.name && !GENERIC_TITLE_RE.test(midi.header.name.trim()) ? midi.header.name.trim() : '';
  const song: Song = {
    id,
    title: opts.title ?? (lyrics.title || headerTitle),
    artist: lyrics.artist ?? '',
    source: 'midi',
    bpm: bpm ?? 120,
    notes,
    phrases,
    backingRef: null,
    offsetMs: trimmedMs,
    difficulty: { lowestMidi: 0, highestMidi: 0, rangeSemitones: 0, maxLeapSemitones: 0, notesPerSec: 0, melismaRate: 0, longNoteRatio: 0, requiredWorld: 'foundations' },
  };
  // Never leave the placeholder in place: an unrated song would unlock at Foundations.
  song.difficulty = rateSong(song);

  return { song, candidates, selectedTrackIndex, warnings, lyricSyllables, lyricsMatched: matched };
}
