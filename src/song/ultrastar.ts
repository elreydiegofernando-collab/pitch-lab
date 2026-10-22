/**
 * UltraStar `.txt` parser and serializer (format 1.1.0, usdx.eu/format, plus legacy
 * files; see docs/RESEARCH.md §7). It is the native song-mode format: it carries lyrics,
 * phrase breaks and golden/freestyle/rap note types that MIDI cannot.
 *
 * Time. The file counts "beats"; one beat lasts `60 / (BPM * 4)` seconds (the quarter-
 * beat convention: UltraStar multiplies #BPM by 4, so with the ideal #BPM = the song's
 * tempo a beat is a sixteenth note). Song.bpm is the file's #BPM, i.e. the musical tempo
 * when the chart follows that ideal grid. #GAP (ms from the START OF THE AUDIO to beat 0)
 * is NOT folded into note times: Song.notes are seconds from song time 0 (= beat 0),
 * which is also take time 0 in analysis/phrases.ts. The gap becomes Song.offsetMs:
 *
 *     backing-audio position = song time + offsetMs
 *
 * (see timing.ts, which wraps this so callers never juggle the sign).
 *
 * Body lines (from the USDX parser):
 *   `: s l p text`  normal   `* s l p text` golden   `F ...` freestyle   `R ...` rap
 *   `G ...` rap + golden (kept as 'rap': SongNoteType has no golden-rap)
 *   Pitch 0 is C4 (MIDI 60). The text after the single separating space is kept VERBATIM
 *   (leading and trailing spaces mark word breaks); "~" means "continue the previous
 *   syllable" and is normalised to '' (a zero-length note is read as freestyle, as USDX does).
 *   `- a [b]` ends a phrase. In normal files `a` is the beat at which the finished line is
 *   cleared and the optional `b` the beat at which the next line appears; each only widens
 *   the phrase windows INTO the gap between the two phrases (notes always define the
 *   phrases, so a sloppy break can never move a note into the wrong phrase). In legacy
 *   `#RELATIVE:YES` files the second number is instead the offset added to every later
 *   beat (`Rel += b`, as USDX does) and the first is relative to the current offset.
 *   `B beat bpm` changes tempo mid-song. `P1`/`P2` select a duet voice (P1 is imported,
 *   the rest reported in `warnings`); `E` ends the song.
 *
 * Tolerant of a BOM, CR/LF/CRLF, indented lines and extra spaces between numeric fields.
 * Malformed input throws UltraStarParseError with a 1-based line number. Oddities that
 * are harmless (a duet's second voice, text after `E`, an ignored header) go to `warnings`.
 *
 * Numbers are range-checked as they are read (LIMITS below): the result is a valid Song or an
 * UltraStarParseError, never a Song holding Infinity or NaN (which JSON stores as null). A
 * 400-digit beat parses to Infinity, and a #BPM of 1e-300 would make one beat last for ever.
 */
import { clamp } from '../core/math';
import type { Song, SongNote, SongNoteType, SongPhrase } from './types';
import { hashContent } from './hash';
import { rateSong } from './difficulty';
import { decodeUtf8OrWindows1252 } from './text';

export class UltraStarParseError extends Error {
  /** 1-based source line, or 0 for a whole-file problem (e.g. a missing header). */
  readonly line: number;
  constructor(line: number, message: string) {
    super(line > 0 ? `Line ${line}: ${message}` : message);
    this.name = 'UltraStarParseError';
    this.line = line;
  }
}

export interface UltraStarParseOptions {
  /** Override the computed id. Bundled charts pass a stable slug instead of a content hash. */
  id?: string;
  /** Song.source for the result. Default 'ultrastar'. */
  source?: 'ultrastar' | 'bundled';
}

export interface UltraStarParseResult {
  /** The song, difficulty already rated (rateSong), backingRef null, offsetMs = #GAP. */
  song: Song;
  /** #AUDIO (or legacy #MP3) filename, verbatim from the header; the Song has no field for it. */
  audioFile: string | null;
  /** Every header keyed by its UPPERCASED name, value trimmed. Feed back to serializeUltraStar. */
  headers: Record<string, string>;
  /** Tolerated oddities worth surfacing (duet voice dropped, legacy quirks). Never thrown. */
  warnings: string[];
}

const NOTE_TYPES: Record<string, SongNoteType> = {
  ':': 'normal',
  '*': 'golden',
  F: 'freestyle',
  R: 'rap',
  // Golden rap has no SongNoteType of its own. 'rap' is kept: downstream scoring cares more
  // that rap pitch is not judged than about the golden bonus (reported in contractIssues).
  G: 'rap',
};
const TYPE_CHARS: Record<SongNoteType, string> = { normal: ':', golden: '*', freestyle: 'F', rap: 'R' };

/**
 * Sanity bounds for numbers read from a chart. A real chart never comes near them; they only keep absurd
 * values out of Song.notes. USDX itself rejects a #BPM below its MIN_BPM of 1 (it checks BPM * 4, so a
 * floor of 0.25 would also be defensible).
 */
const LIMITS = {
  /** |start beat|, note length and the numbers of a line break: hours of music at any real #BPM. */
  maxBeat: 1e7,
  /** |pitch| in semitones from C4 (a piano spans 88). */
  maxPitch: 200,
  /** #BPM and `B` tempo values. */
  minBpm: 1,
  /** serializeUltraStar writes #BPM = bpm * grid (up to 48), so this leaves room for a 20 000 bpm MIDI file. */
  maxBpm: 1e6,
} as const;

const HEADER_RE = /^#([A-Za-z][A-Za-z0-9_-]*)\s*:(.*)$/;
const NOTE_RE = /^([:*FRG])\s+(-?\d+)\s+(-?\d+)\s+(-?\d+)(?:\s(.*))?$/;
const NOTE_LIKE_RE = /^[:*FRG](?:\s|$)/;
const BREAK_RE = /^-(?:\s+(-?\d+))?(?:\s+(-?\d+))?\s*$/;
const BREAK_LIKE_RE = /^-(?:\s|$)/;
const BPM_CHANGE_RE = /^B\s+(-?\d+(?:[.,]\d+)?)\s+(\d+(?:[.,]\d+)?)\s*$/;
const PLAYER_RE = /^P\s*([12])\s*$/;
const END_RE = /^E\s*$/;

interface RawNote {
  line: number;
  type: SongNoteType;
  beat: number;
  length: number;
  pitch: number;
  lyric: string;
}
interface RawBreak {
  a: number | null;
  b: number | null;
}
type Item = { kind: 'note'; note: RawNote } | { kind: 'break'; brk: RawBreak };

interface Voice {
  items: Item[];
  /** #RELATIVE running offset (USDX: Rel[track]). */
  rel: number;
  noteCount: number;
}

/** Strips a BOM and unifies line endings. The result is also what content ids are hashed from. */
function normalizeText(text: string): string {
  const noBom = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  return noBom.replace(/\r\n?/g, '\n');
}

function decimal(raw: string): number {
  return parseFloat(raw.replace(',', '.'));
}

/** The start of a bad field or line for an error message (a 300-digit number must not make the message huge). */
function shown(raw: string, max = 24): string {
  return raw.length > max ? `${raw.slice(0, max)}…` : raw;
}

/**
 * parseInt of a regex-matched integer field. Throws UltraStarParseError(lineNo) unless the value is finite
 * and |value| <= max: parseInt turns a 309-digit string into Infinity. A negative zero comes back as 0.
 */
function integerField(raw: string, lineNo: number, what: string, max: number): number {
  const v = parseInt(raw, 10);
  if (!Number.isFinite(v) || Math.abs(v) > max) throw new UltraStarParseError(lineNo, `${what} is out of range ("${shown(raw)}")`);
  return v === 0 ? 0 : v;
}

function isTruthy(v: string | undefined): boolean {
  if (v === undefined) return false;
  const u = v.trim().toUpperCase();
  return u === 'YES' || u === 'TRUE' || u === '1';
}

/** Beat -> seconds, honouring `B` tempo changes. `span` keeps constant-tempo lengths exact. */
function makeTimeMap(bpm: number, changes: ReadonlyArray<{ beat: number; bpm: number }>) {
  const spb0 = 60 / (bpm * 4);
  if (changes.length === 0) {
    return { at: (beat: number) => beat * spb0, span: (_beat: number, length: number) => length * spb0 };
  }
  const segs: Array<{ beat: number; sec: number; spb: number }> = [{ beat: 0, sec: 0, spb: spb0 }];
  for (const c of [...changes].sort((p, q) => p.beat - q.beat)) {
    const prev = segs[segs.length - 1];
    segs.push({ beat: c.beat, sec: prev.sec + (c.beat - prev.beat) * prev.spb, spb: 60 / (c.bpm * 4) });
  }
  const at = (beat: number): number => {
    let s = segs[0];
    for (const seg of segs) {
      if (seg.beat <= beat) s = seg;
      else break;
    }
    return s.sec + (beat - s.beat) * s.spb;
  };
  return { at, span: (beat: number, length: number) => at(beat + length) - at(beat) };
}

/** Parses an UltraStar `.txt` file's text into a Song (difficulty rated). */
export function parseUltraStar(text: string, opts: UltraStarParseOptions = {}): UltraStarParseResult {
  const normalized = normalizeText(text);
  const lines = normalized.split('\n');
  if (lines.every((l) => l.trim() === '')) throw new UltraStarParseError(0, 'Empty UltraStar file');

  const warnings: string[] = [];
  const headers: Record<string, string> = {};

  // Pass 1: headers (anywhere in the file) and where the song ends (the LAST `E` line, so a
  // duet that closes each voice with its own `E` still imports in full).
  let end = lines.length;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (END_RE.test(lines[i].trim())) {
      end = i;
      break;
    }
  }
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trimStart();
    if (!t.startsWith('#')) continue;
    const m = HEADER_RE.exec(t);
    if (m) headers[m[1].toUpperCase()] = m[2].trim();
    else if (i < end) warnings.push(`Line ${i + 1}: ignored a malformed header line.`);
  }
  if (end < lines.length) {
    const trailing = lines.slice(end + 1).filter((l) => l.trim() !== '' && !l.trimStart().startsWith('#')).length;
    if (trailing > 0) warnings.push(`Ignored ${trailing} line(s) after the final "E".`);
  }

  const bpmRaw = headers.BPM;
  if (bpmRaw === undefined) throw new UltraStarParseError(0, 'Missing required #BPM header');
  const bpm = decimal(bpmRaw);
  if (!Number.isFinite(bpm) || bpm < LIMITS.minBpm || bpm > LIMITS.maxBpm) {
    throw new UltraStarParseError(0, `Invalid #BPM header: "${shown(bpmRaw)}" (expected ${LIMITS.minBpm} to ${LIMITS.maxBpm})`);
  }

  let gapMs = 0;
  if (headers.GAP !== undefined && headers.GAP !== '') {
    const g = decimal(headers.GAP);
    if (Number.isFinite(g)) gapMs = g;
    else warnings.push(`Ignored an invalid #GAP header ("${headers.GAP}"); assumed 0.`);
  }

  const relative = isTruthy(headers.RELATIVE);
  const versionMajor = parseInt((headers.VERSION ?? '').split('.')[0], 10);
  if (relative && Number.isFinite(versionMajor) && versionMajor >= 1) {
    warnings.push('#RELATIVE was removed in format 1.0.0; read as a legacy file.');
  }

  // Pass 2: the body.
  const voices: [Voice, Voice] = [
    { items: [], rel: 0, noteCount: 0 },
    { items: [], rel: 0, noteCount: 0 },
  ];
  const tempoChanges: Array<{ beat: number; bpm: number }> = [];
  let current = 0;
  let zeroLength = 0;

  for (let i = 0; i < end; i++) {
    const lineNo = i + 1;
    const t = lines[i].trimStart();
    if (t.trim() === '' || t.startsWith('#')) continue;
    const voice = voices[current];

    const pl = PLAYER_RE.exec(t.trim());
    if (pl) {
      current = pl[1] === '1' ? 0 : 1;
      continue;
    }
    // An `E` before the last one closes one duet voice; the song ends at the last `E` (see pass 1).
    if (END_RE.test(t.trim())) continue;

    const nm = NOTE_RE.exec(t);
    if (nm) {
      const length = integerField(nm[3], lineNo, 'Note length', LIMITS.maxBeat);
      if (length < 0) throw new UltraStarParseError(lineNo, `Negative note length (${length})`);
      const beat = integerField(nm[2], lineNo, 'Note start', LIMITS.maxBeat) + (relative ? voice.rel : 0);
      if (beat < 0) throw new UltraStarParseError(lineNo, `Note starts before beat 0 (beat ${beat})`);
      // #RELATIVE offsets accumulate, so the start is checked again once they are added.
      if (beat > LIMITS.maxBeat) throw new UltraStarParseError(lineNo, `Note start is out of range (beat ${beat}, the limit is ${LIMITS.maxBeat})`);
      const pitch = integerField(nm[4], lineNo, 'Note pitch', LIMITS.maxPitch);
      let type = NOTE_TYPES[nm[1]];
      if (length === 0) {
        // USDX reads a zero-length note as freestyle: nothing can be sung in no time.
        type = 'freestyle';
        zeroLength++;
      }
      const rawLyric = nm[5] ?? '';
      voice.items.push({
        kind: 'note',
        note: { line: lineNo, type, beat, length, pitch, lyric: rawLyric.trim() === '~' ? '' : rawLyric },
      });
      voice.noteCount++;
      continue;
    }
    if (NOTE_LIKE_RE.test(t)) {
      throw new UltraStarParseError(lineNo, `Malformed note line (expected "${t[0]} <startBeat> <length> <pitch> <text>"): "${t.length > 50 ? t.slice(0, 50) + '…' : t}"`);
    }

    const bm = BREAK_RE.exec(t);
    if (bm) {
      const a = bm[1] !== undefined ? integerField(bm[1], lineNo, 'Line break beat', LIMITS.maxBeat) : null;
      const b = bm[2] !== undefined ? integerField(bm[2], lineNo, 'Line break beat', LIMITS.maxBeat) : null;
      if (relative) {
        voice.items.push({ kind: 'break', brk: { a: a === null ? null : a + voice.rel, b: null } });
        voice.rel += b ?? 0;
      } else {
        voice.items.push({ kind: 'break', brk: { a, b } });
      }
      continue;
    }
    if (BREAK_LIKE_RE.test(t)) {
      throw new UltraStarParseError(lineNo, `Malformed line break (expected "- <beat> [<beat>]"): "${t}"`);
    }

    const cm = BPM_CHANGE_RE.exec(t);
    if (cm) {
      const beat = decimal(cm[1]);
      const newBpm = decimal(cm[2]);
      if (!(newBpm >= LIMITS.minBpm && newBpm <= LIMITS.maxBpm)) throw new UltraStarParseError(lineNo, `Invalid tempo in BPM change: "${shown(t, 50)}"`);
      // Before beat 0 would put the first notes at a negative time (the time map assumes the song starts at beat 0).
      if (!(beat >= 0 && beat <= LIMITS.maxBeat)) throw new UltraStarParseError(lineNo, `Tempo change beat is out of range: "${shown(t, 50)}"`);
      tempoChanges.push({ beat, bpm: newBpm });
      continue;
    }

    throw new UltraStarParseError(lineNo, `Unrecognized line: "${t.length > 50 ? t.slice(0, 50) + '…' : t}"`);
  }

  if (zeroLength > 0) warnings.push(`${zeroLength} zero-length note(s) were read as freestyle.`);

  // Choose the voice: P1, unless it is empty and P2 is not.
  let chosen = voices[0];
  if (voices[0].noteCount === 0 && voices[1].noteCount > 0) {
    chosen = voices[1];
    warnings.push('Duet file with no player 1 notes: imported player 2 instead.');
  } else if (voices[1].noteCount > 0) {
    warnings.push(`Duet file: skipped player 2's part (${voices[1].noteCount} note(s)); only player 1 was imported.`);
  }
  if (chosen.noteCount === 0) throw new UltraStarParseError(0, 'No notes found');

  // Group notes into phrases by the line breaks, in FILE order.
  interface Group {
    notes: RawNote[];
    /** Hints from the break that closed this group. */
    closing: RawBreak | null;
  }
  const groups: Group[] = [];
  let open: Group = { notes: [], closing: null };
  for (const item of chosen.items) {
    if (item.kind === 'note') {
      open.notes.push(item.note);
    } else if (open.notes.length > 0) {
      open.closing = item.brk;
      groups.push(open);
      open = { notes: [], closing: null };
    } else if (groups.length > 0) {
      // back-to-back breaks: keep the first end hint, take the last "next appears" hint
      const prev = groups[groups.length - 1].closing;
      if (prev) groups[groups.length - 1].closing = { a: prev.a ?? item.brk.a, b: item.brk.b ?? prev.b };
    }
  }
  if (open.notes.length > 0) groups.push(open);

  // Seconds.
  const tm = makeTimeMap(bpm, tempoChanges);
  const notes: SongNote[] = [];
  const noteLines: number[] = [];
  const spans: Array<{ from: number; to: number }> = [];
  for (const g of groups) {
    const from = notes.length;
    for (const rn of g.notes) {
      notes.push({ start: tm.at(rn.beat), duration: tm.span(rn.beat, rn.length), midi: 60 + rn.pitch, lyric: rn.lyric, type: rn.type });
      noteLines.push(rn.line);
    }
    spans.push({ from, to: notes.length });
  }
  // The limits make every time finite; this is the backstop. A non-finite number in a Song would survive as JSON null.
  for (let i = 0; i < notes.length; i++) {
    if (!Number.isFinite(notes[i].start) || !Number.isFinite(notes[i].duration)) {
      throw new UltraStarParseError(noteLines[i], 'Note timing is out of range');
    }
  }
  for (let i = 1; i < notes.length; i++) {
    if (notes[i].start < notes[i - 1].start - 1e-9) {
      throw new UltraStarParseError(noteLines[i], 'Notes are not in chronological order (this note starts before the one above it)');
    }
  }

  // Phrase windows: the notes' own bounds, widened by the break hints inside the gap only.
  const phrases: SongPhrase[] = [];
  for (let gi = 0; gi < spans.length; gi++) {
    const { from, to } = spans[gi];
    let lastEnd = -Infinity;
    for (let k = from; k < to; k++) lastEnd = Math.max(lastEnd, notes[k].start + notes[k].duration);
    phrases.push({ start: notes[from].start, end: lastEnd, from, to });
  }
  for (let gi = 0; gi + 1 < groups.length; gi++) {
    const closing = groups[gi].closing;
    if (!closing) continue;
    const lo = phrases[gi].end;
    const hi = phrases[gi + 1].start;
    if (!(hi > lo)) continue;
    const a = closing.a !== null ? clamp(tm.at(closing.a), lo, hi) : lo;
    phrases[gi].end = a;
    if (closing.b !== null) phrases[gi + 1].start = clamp(tm.at(closing.b), a, hi);
  }
  for (const p of phrases) {
    if (!Number.isFinite(p.start) || !Number.isFinite(p.end)) throw new UltraStarParseError(0, 'Phrase timing is out of range');
  }

  const song: Song = {
    id: opts.id ?? `us-${hashContent(normalized)}`,
    title: headers.TITLE ?? '',
    artist: headers.ARTIST ?? '',
    source: opts.source ?? 'ultrastar',
    bpm,
    notes,
    phrases,
    backingRef: null,
    offsetMs: gapMs,
    difficulty: { lowestMidi: 0, highestMidi: 0, rangeSemitones: 0, maxLeapSemitones: 0, notesPerSec: 0, melismaRate: 0, longNoteRatio: 0, requiredWorld: 'foundations' },
  };
  if (opts.source === 'bundled') {
    const licence = headers.LICENCE || headers.LICENSE || headers.COMMENT;
    if (licence) song.licence = licence;
  }
  // Never leave the placeholder in place: an unrated song would unlock at Foundations.
  song.difficulty = rateSong(song);

  return { song, audioFile: headers.AUDIO || headers.MP3 || null, headers, warnings };
}

/**
 * Decodes UltraStar file bytes: UTF-8 (BOM or not), UTF-16 with a BOM, else windows-1252
 * (what most legacy files are). `File.text()` would turn a legacy file's accents to mojibake.
 */
export function decodeUltraStarBytes(bytes: ArrayBuffer | Uint8Array): string {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (u8.length >= 2 && u8[0] === 0xff && u8[1] === 0xfe) return new TextDecoder('utf-16le').decode(u8.subarray(2));
  if (u8.length >= 2 && u8[0] === 0xfe && u8[1] === 0xff) return new TextDecoder('utf-16be').decode(u8.subarray(2));
  return decodeUtf8OrWindows1252(u8);
}

export interface UltraStarSerializeOptions {
  /** Extra headers (typically a previous parse's `headers`), merged under the ones written here. */
  headers?: Record<string, string>;
  /** #AUDIO filename. Song carries no field for it; omitted when neither this nor headers.AUDIO/MP3 is set. */
  audioFile?: string;
  /**
   * Beat-grid refinement k: #BPM is written as song.bpm * k so one beat is 1/k of the song's own beat.
   * 'auto' (default) picks the smallest k that keeps every note boundary within 4 ms of the grid,
   * which is 1 for anything parsed from UltraStar and finer for off-grid (e.g. MIDI) songs.
   */
  grid?: number | 'auto';
}

const GRID_CANDIDATES = [1, 2, 3, 4, 6, 8, 12, 16, 24, 32, 48];
const GRID_TOLERANCE_SEC = 0.004;

function gridError(song: Song, bpm: number, k: number): number {
  const spb = 60 / (bpm * k * 4);
  let worst = 0;
  for (const n of song.notes) {
    for (const t of [n.start, n.start + n.duration]) {
      const frac = Math.abs(t / spb - Math.round(t / spb)) * spb;
      if (frac > worst) worst = frac;
    }
  }
  return worst;
}

function chooseGrid(song: Song, bpm: number, grid: number | 'auto'): number {
  if (grid !== 'auto') return grid;
  let best = 1;
  let bestErr = Infinity;
  for (const k of GRID_CANDIDATES) {
    const err = gridError(song, bpm, k);
    if (err <= GRID_TOLERANCE_SEC) return k;
    if (err < bestErr) {
      bestErr = err;
      best = k;
    }
  }
  return best;
}

function num(n: number): string {
  return String(Math.round(n * 1e6) / 1e6);
}
function oneLine(s: string): string {
  return s.replace(/[\r\n]+/g, ' ').trim();
}

/**
 * Serializes a Song to UltraStar `.txt` text. The inverse of parseUltraStar modulo the
 * golden-rap distinction and headers this module does not own. Notes are written as
 * `<type> <beat> <length> <pitch> <text>` (empty text as "~"; pitches round to whole
 * semitones, as the format cannot hold cents), phrases as `- end [next]`.
 */
export function serializeUltraStar(song: Song, opts: UltraStarSerializeOptions = {}): string {
  const bpm = song.bpm;
  if (bpm === undefined || !(bpm > 0)) throw new Error('serializeUltraStar: song.bpm must be a positive number');
  const k = chooseGrid(song, bpm, opts.grid ?? 'auto');
  if (!(k > 0)) throw new Error('serializeUltraStar: grid must be a positive number');
  const spb = 60 / (bpm * k * 4);
  const toBeat = (sec: number): number => Math.round(sec / spb);

  const extra: Record<string, string> = { ...opts.headers };
  for (const key of ['VERSION', 'TITLE', 'ARTIST', 'BPM', 'GAP', 'AUDIO', 'MP3', 'COMMENT']) delete extra[key];
  const audio = opts.audioFile ?? opts.headers?.AUDIO ?? opts.headers?.MP3;
  const comment = opts.headers?.COMMENT ?? song.licence;

  const out: string[] = ['#VERSION:1.1.0', `#TITLE:${oneLine(song.title)}`, `#ARTIST:${oneLine(song.artist)}`];
  if (audio) out.push(`#AUDIO:${oneLine(audio)}`);
  out.push(`#BPM:${num(bpm * k)}`, `#GAP:${num(song.offsetMs)}`);
  if (comment) out.push(`#COMMENT:${oneLine(comment)}`);
  for (const [key, value] of Object.entries(extra)) {
    // only plain tag names: a key with a newline or colon would write a second, bogus line
    if (/^[A-Za-z][A-Za-z0-9_-]*$/.test(key) && typeof value === 'string' && value !== '') out.push(`#${key}:${oneLine(value)}`);
  }

  // Break line before the first note of each later phrase.
  const breakBefore = new Map<number, string>();
  for (let p = 0; p + 1 < song.phrases.length; p++) {
    const next = song.phrases[p + 1];
    if (next.from <= 0 || next.from >= song.notes.length) continue;
    const prevNote = song.notes[next.from - 1];
    const nextBeat = toBeat(song.notes[next.from].start);
    const lastEndBeat = toBeat(prevNote.start + prevNote.duration);
    const a = Math.min(Math.max(toBeat(song.phrases[p].end), lastEndBeat), Math.max(nextBeat, lastEndBeat));
    const b = toBeat(next.start);
    breakBefore.set(next.from, b < nextBeat && b >= a ? `- ${a} ${b}` : `- ${a}`);
  }

  for (let i = 0; i < song.notes.length; i++) {
    const brk = breakBefore.get(i);
    if (brk) out.push(brk);
    const n = song.notes[i];
    const beat = toBeat(n.start);
    let length = toBeat(n.start + n.duration) - beat;
    // A pitched note must keep length >= 1 or it would be re-read as freestyle.
    if (n.type !== 'freestyle') length = Math.max(1, length);
    else length = Math.max(0, length);
    const lyric = n.lyric === '' ? '~' : n.lyric.replace(/[\r\n]+/g, ' ');
    out.push(`${TYPE_CHARS[n.type]} ${beat} ${length} ${Math.round(n.midi) - 60} ${lyric}`);
  }
  out.push('E');
  return out.join('\n') + '\n';
}
