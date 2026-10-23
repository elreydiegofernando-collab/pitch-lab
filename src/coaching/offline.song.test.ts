/**
 * The song side of the offline coaching analysis (offline.ts, scripts/coach.mjs) on synthesized takes of a small hymn.
 *
 * What is held here:
 *  - the few rules offline.ts restates from the song player (the window of a take, how its phrases are scored, the pass mark)
 *    equal the player's own, so a change there fails a test here;
 *  - a song coaching file is read, checked and refused as the contract says;
 *  - a take is re-scored from its pitch line to the same number the player wrote, at any speed and in any key, and taken
 *    apart by note and syllable: a flat note, a voice break, a dropout, an unsung note, a steady lateness, an octave off;
 *    the melody's own leaps are never read as breaks;
 *  - the graph of a phrase has its lyrics under the time axis, in song time;
 *  - the takes are compared, the history of a backup is read, and the engines are called through fakes (and the real ones
 *    answer, or say they are not built yet);
 *  - scripts/coach.mjs reads a song file end to end.
 */
import { describe, expect, it, vi } from 'vitest';
import { makeTrack } from '../analysis/fixtures';
import { metricsFromResults } from '../analysis/score';
import { encodeWav } from '../audio/wav';
import { CONFIG } from '../config';
import { centsFromNearest, midiToHz } from '../core/music';
import type { PitchFrame } from '../core/types';
import { notesContour, synthesize } from '../dsp/test-signals';
import { buildSongAttempt } from '../progress/attempt';
import { pitchedView, type PitchedView } from '../song/pitched';
import { SONG_PASS_SCORE } from '../song/practice';
import { transposeSong } from '../song/transpose';
import { parseUltraStar } from '../song/ultrastar';
import type { Song } from '../song/types';
import type { AttemptRecord, BackupFile, ProfileRecord } from '../storage/schema';
import { bytesToBase64, decodeTrack, encodeTrack } from '../storage/track-codec';
import {
  CoachInputError,
  REAL_SONG_ENGINE,
  SONG_LEAD_SEC,
  SONG_TAIL_SEC,
  analyzeReports,
  compareSongTakes,
  diagnoseSongFile,
  formatReport,
  formatSongDiagnosis,
  isSongReport,
  phraseWords,
  readCoachInput,
  renderPitchGraph,
  rescoreSongSegment,
  songPhraseRows,
  songTrackClock,
  songWindow,
  trackFromSamples,
  type Report,
  type SongCoachEngine,
  type SongDiagnosis,
} from './offline';
import type { Coaching, SongCoachingFile } from './types';

// The app singletons are never used (nothing here starts a session); mocking them keeps their side effects out of the import
// of runtime/song-session.ts, which the restated rules are checked against.
vi.mock('../audio/engine', () => ({ getEngine: () => undefined }));
vi.mock('../state/audio', () => ({ getSynth: () => undefined }));
vi.mock('../state/session', async () => {
  const { signal } = await import('@preact/signals');
  return { appStorage: signal(null), activeProfile: signal(null), recordAttempt: async () => undefined };
});
vi.mock('../state/settings', async () => {
  const { signal } = await import('@preact/signals');
  const types = await import('../state/settings-types');
  return { settings: signal(types.DEFAULT_SETTINGS), deviceSettings: signal(types.DEFAULT_DEVICE_SETTINGS) };
});
const session = await import('../runtime/song-session');

// The src tsconfig carries no Node types (the app is browser code), so the Node modules the CLI test needs are loaded
// dynamically, with just the signatures used (as offline.test.ts does).
const fs = (await import(/* @vite-ignore */ `node:${'fs'}`)) as {
  mkdirSync(path: string, opts: { recursive: boolean }): void;
  mkdtempSync(prefix: string): string;
  rmSync(path: string, opts: { recursive: boolean; force: boolean }): void;
  writeFileSync(path: string, data: string | Uint8Array): void;
};
const os = (await import(/* @vite-ignore */ `node:${'os'}`)) as { tmpdir(): string };
const path = (await import(/* @vite-ignore */ `node:${'path'}`)) as { join(...parts: string[]): string };
const url = (await import(/* @vite-ignore */ `node:${'url'}`)) as { fileURLToPath(u: URL): string };
const childProcess = (await import(/* @vite-ignore */ `node:${'child_process'}`)) as {
  execFileSync(file: string, args: string[], opts: { cwd: string; encoding: 'utf8'; timeout: number; stdio: string[] }): string;
};
const proc = (globalThis as unknown as { process: { execPath: string; env: Record<string, string | undefined> } }).process;
const ROOT = url.fileURLToPath(new URL('../../', import.meta.url));

// ---------------------------------------------------------------- the chart

/**
 * A small hymn on a 120 bpm grid (an UltraStar beat is 0.125 s). Three phrases; notes, by index into the pitched notes:
 *   phrase 1 (0.0-3.5 s):  O(0, G4) ho(1, G4) ly(2, F4, 1.0 s) night(3, C4, 1.5 s)
 *   phrase 2 (4.0-8.5 s):  the(4, D4) stars(5, E4) are(6, F4) bright(7, E4) ly(8, D4, 1.5 s) ~(9, C4, the same syllable, 1.0 s)
 *   phrase 3 (9.0-12.0 s): shin(10, C4) ing(11, G4) now(12, E4, 2.0 s)
 * Two big leaps (5 half steps down into "night", 7 up into "ing"), long notes to hold, one syllable on two notes.
 */
const CHART = `#TITLE:Test Hymn
#ARTIST:Nobody
#BPM:120
#GAP:0
: 0 4 7  O
: 4 4 7  ho
: 8 8 5  ly
: 16 12 0  night
- 30
: 32 4 2  the
: 36 4 4  stars
: 40 4 5  are
: 44 4 4  bright
: 48 12 2  ly
: 60 8 0 ~
- 70
: 72 4 0  shin
: 76 4 7  ing
: 80 16 4  now
E
`;

function chart(): Song {
  return { ...parseUltraStar(CHART).song, id: 'test-hymn' };
}

const NIGHT = 3;
const STARS = 5;
const BRIGHT = 7;
const LY = 8;
const ING = 11;
const NOW = 12;

// ---------------------------------------------------------------- singing a take

interface Flip {
  note: number;
  semis: number;
  from?: number;
  sec?: number;
}

interface Faults {
  /** Cents off the written pitch, by pitched note index (negative = flat). */
  off?: Record<number, number>;
  /** The voice comes in this many (real) seconds after the notes. */
  late?: number;
  /** Notes not sung at all. */
  unsung?: number[];
  /** The voice flips by `semis` for `sec` real seconds, from `from` of the way through the note, then comes back. */
  flip?: Flip | Flip[];
  /** The sound stops inside a note for `sec` real seconds, from 35% of it. */
  dropout?: { note: number; sec: number };
  /** Sung this many octaves away (-1 = an octave below). */
  octaves?: number;
  /** Hold every note right up to the next one (a legato line: its leaps are one frame apart). */
  legato?: boolean;
  /** A regular vibrato on a note: the pitch swings by +/- `cents` at `hz` a second. */
  vibrato?: { note: number; hz: number; cents: number };
  /** A note that wavers: its pitch drifts slowly and unevenly up and down by about +/- `cents`. */
  wobble?: { note: number; cents: number };
  seed?: number;
}

const T0 = Date.UTC(2026, 9, 22, 18, 0);
const isoAt = (minutes: number): string => new Date(T0 + minutes * 60_000).toISOString();

interface Sung {
  frames: PitchFrame[];
  view: PitchedView;
  /** Pitched phrases the take covers, and the window it was sung over (the song player's own). */
  covered: number[];
  window: { start: number; end: number; firstNote: number };
  passSec: number;
  phrase: { from: number; to: number } | null;
  shift: number;
  speed: number;
}

/**
 * `selection`: an index into Song.phrases (in the main chart every phrase is sung, so it is also the pitched index), or null for
 * the whole song. The window is the song player's own (selectionWindow); the voice is on the take's own clock.
 */
function singTake(song: Song, o: { selection: number | null; shift?: number; speed?: number; faults?: Faults }): Sung {
  const shift = o.shift ?? 0;
  const speed = o.speed ?? 1;
  const faults = o.faults ?? {};
  const sung = transposeSong(song, shift);
  const view = pitchedView(sung);
  const window = session.selectionWindow(sung, o.selection === null ? null : session.onePhrase(o.selection));
  if (!window) throw new Error('no window');
  // the pitched phrases the selection scores (a spoken phrase has none), by the player's own rule
  const covered = session.scoredPhrasesOf(session.phraseRows(sung), o.selection === null ? null : session.onePhrase(o.selection));
  const notes = covered.flatMap((pi) => Array.from({ length: view.phrases[pi].to - view.phrases[pi].from }, (_, k) => view.phrases[pi].from + k));
  const passSec = (window.end - window.start) / speed;
  const hold = faults.legato ? 0 : 0.04;
  const flips: Flip[] = faults.flip === undefined ? [] : Array.isArray(faults.flip) ? faults.flip : [faults.flip];
  const midiAt = (t: number): number => {
    const s = window.start + (t - (faults.late ?? 0)) * speed;
    for (const k of notes) {
      const n = view.notes[k];
      if (s < n.start || s >= n.start + n.duration - hold) continue;
      if (faults.unsung?.includes(k)) return NaN;
      if (faults.dropout?.note === k && s >= n.start + n.duration * 0.35 && s < n.start + n.duration * 0.35 + faults.dropout.sec * speed) return NaN;
      let m = n.midi + (faults.off?.[k] ?? 0) / 100 + 12 * (faults.octaves ?? 0);
      if (faults.vibrato?.note === k) m += (faults.vibrato.cents / 100) * Math.sin(2 * Math.PI * faults.vibrato.hz * t);
      // a slow, uneven drift up and down (two unrelated slow swings), nothing like a regular vibrato
      if (faults.wobble?.note === k) m += ((faults.wobble.cents / 100) * (Math.sin(2 * Math.PI * 1.3 * t) + 0.7 * Math.sin(2 * Math.PI * 2.3 * t + 1))) / 1.7;
      for (const f of flips) {
        if (f.note !== k) continue;
        const at = n.start + n.duration * (f.from ?? 0.5);
        if (s >= at && s < at + (f.sec ?? 0.15) * speed) m += f.semis;
      }
      return m;
    }
    return NaN;
  };
  const frames = makeTrack({ duration: passSec + 0.3, t0: -0.5, midi: midiAt, jitterCents: 3, seed: faults.seed ?? 11 });
  return { frames, view, covered, window, passSec, phrase: o.selection === null ? null : { from: covered[0], to: covered[covered.length - 1] + 1 }, shift, speed };
}

/** The pitch line as the app saved it (32-bit floats on a grid): what the attempt's score is computed from. */
const asSaved = (frames: readonly PitchFrame[]): PitchFrame[] => decodeTrack(encodeTrack(frames));

let seq = 0;

/** The attempt the song player writes for a take, from its own scoring (scoreSongSegment) of what was saved. */
function attemptOf(t: Sung, o: { minutes: number; profileId?: string; sungSec?: number; finished?: number[] }): AttemptRecord {
  seq += 1;
  const finished = o.finished ?? t.covered;
  const scores = session.scoreSongSegment(asSaved(t.frames), {
    view: t.view,
    phrases: finished,
    originSongSec: t.window.start,
    speed: t.speed,
    ctx: { toleranceCents: CONFIG.tolerance.default, vibratoStyle: 'pop' },
  });
  const metrics = metricsFromResults({ phrases: scores });
  const score = metrics['song.phraseScore'] ?? 0;
  const at = isoAt(o.minutes);
  return {
    ...buildSongAttempt({
      profileId: o.profileId ?? 'p1',
      songId: 'test-hymn',
      score,
      passed: score >= SONG_PASS_SCORE,
      metrics,
      durationSec: o.sungSec ?? t.passSec,
      tonicMidi: t.view.notes[0].midi,
      phrase: t.phrase,
      songShift: t.shift,
      songSpeed: t.speed,
    }),
    id: `song-att-${String(seq).padStart(3, '0')}`,
    createdAt: at,
    updatedAt: at,
    deletedAt: null,
  };
}

type FileTake = SongCoachingFile['takes'][number];

function takeOf(t: Sung, minutes: number, over: Partial<FileTake> = {}): FileTake {
  return { attempt: attemptOf(t, { minutes }), phrase: t.phrase, shift: t.shift, speed: t.speed, track: encodeTrack(t.frames), audioWavBase64: null, ...over };
}

/** A song coaching file as "Send to Claude" writes it; `takes` are given oldest first, and listed newest first. */
function songFile(takes: FileTake[], song: Song = chart()): SongCoachingFile {
  return {
    app: 'pitch-lab',
    kind: 'song-coaching',
    version: 1,
    exportedAt: isoAt(120),
    appVersion: '0.1.0+song-test',
    song,
    profile: { name: 'Test Singer', voiceType: 'baritone', range: null },
    settings: { notation: 'sharps' },
    device: { route: 'wired', latencyMs: 120, userAgent: 'vitest' },
    takes: [...takes].reverse(),
  };
}

const enc = (x: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(x));
const readSong = (file: SongCoachingFile, name = 'song.json') => readCoachInput(enc(file), name);

/** The diagnosis of a file with fakes for the engines unless given (a clean read of the numbers). */
function diagnose(file: SongCoachingFile, opts: Parameters<typeof diagnoseSongFile>[1] = {}): SongDiagnosis {
  return diagnoseSongFile(file, { engine: fakeSongEngine(), ...opts });
}

function fakeCoaching(over: Partial<Coaching> = {}): Coaching {
  return {
    depth: 1,
    missesInARow: 1,
    passed: false,
    problem: { tipId: 'song.flat', metric: 'song.phraseScore', what: 'You were a little flat on "stars".', spots: [{ t: 5.1, label: '0:05, near E4' }] },
    tip: 'Aim a little higher.',
    why: null,
    steps: [],
    easier: null,
    progress: [],
    moves: [],
    ...over,
  };
}

/** Engines that answer with fixed values, and remember what they were asked. */
function fakeSongEngine(): SongCoachEngine & { asked: Array<{ scores: number; trackStart: number; logLength: number }> } {
  const asked: Array<{ scores: number; trackStart: number; logLength: number }> = [];
  return {
    asked,
    coachSongTake: (take, log) => {
      asked.push({ scores: take.scores.length, trackStart: take.track[0]?.t ?? NaN, logLength: log.length });
      return fakeCoaching({ passed: take.attempt.passed });
    },
    songMissesInARow: (_id, _phrase, log) => log.filter((a) => !a.passed).length,
    songPractice: () => {
      throw new Error('songPractice: not built yet');
    },
  };
}

// ---------------------------------------------------------------- the rules offline.ts restates

describe('the rules restated from the song player', () => {
  const song = chart();
  const rows = songPhraseRows(song);

  /** The part of the player's window the take's clock is built from. */
  const theirs = (selection: ReturnType<typeof session.onePhrase> | null): { start: number; end: number; firstNote: number } | null => {
    const w = session.selectionWindow(song, selection);
    return w ? { start: w.start, end: w.end, firstNote: w.firstNote } : null;
  };

  it('cut a take the way the player does: the same window for a phrase, phrases joined and the whole song', () => {
    expect(SONG_LEAD_SEC).toBe(session.PHRASE_LEAD_SEC);
    expect(SONG_TAIL_SEC).toBe(session.PHRASE_TAIL_SEC);
    for (const sel of [null, 0, 1, 2]) {
      const mine = songWindow(song, rows, sel === null ? null : { from: sel, to: sel + 1 });
      expect(mine, `selection ${sel}`).toEqual(theirs(sel === null ? null : session.onePhrase(sel)));
    }
    // phrases joined: from the first note of the first to the last note of the last, in the same lead and tail
    expect(songWindow(song, rows, { from: 0, to: 2 })).toEqual(theirs({ from: 0, to: 2 }));
    expect(songWindow(song, rows, { from: 0, to: 2 })).toEqual({ start: -1, end: 9, firstNote: 0 });
    expect(songWindow(song, rows, { from: 1, to: 3 })).toEqual(theirs({ from: 1, to: 3 }));
  });

  it('list the phrases the way the player does', () => {
    const theirs = session.phraseRows(song);
    expect(rows.map((r) => [r.index, r.pitchedIndex, r.text, r.start, r.end])).toEqual(theirs.map((r) => [r.index, r.pitchedIndex, r.text, r.start, r.end]));
    expect(rows.map((r) => r.text)).toEqual(['O ho ly night', 'the stars are bright ly', 'shin ing now']);
  });

  it('score the phrases of a take as the player does, slowed and in another key', () => {
    for (const [selection, shift, speed] of [[1, 0, 1], [1, 2, 0.75], [null, -3, 0.5], [2, 0, 0.75]] as const) {
      const t = singTake(song, { selection, shift, speed, faults: { off: { [STARS]: -40 } } });
      const frames = asSaved(t.frames);
      const ours = rescoreSongSegment(frames, t.view, t.covered, t.window.start, speed, { toleranceCents: CONFIG.tolerance.default, vibratoStyle: 'pop' });
      const theirs = session.scoreSongSegment(frames, { view: t.view, phrases: t.covered, originSongSec: t.window.start, speed, ctx: { toleranceCents: CONFIG.tolerance.default, vibratoStyle: 'pop' } });
      expect(ours, `selection ${selection} shift ${shift} speed ${speed}`).toEqual(theirs);
    }
  });

  it('read a chart with a spoken phrase: it has no pitched number, and the others keep theirs', () => {
    const spoken = parseUltraStar(`#TITLE:Spoken\n#ARTIST:N\n#BPM:120\n#GAP:0\n: 0 4 0  a\n- 6\nF 8 4 0  blah\n- 14\n: 16 4 2  b\nE\n`).song;
    const r = songPhraseRows(spoken);
    expect(r.map((x) => x.pitchedIndex)).toEqual([0, null, 1]);
    expect(r.map((x) => x.pitchedIndex)).toEqual(session.phraseRows(spoken).map((x) => x.pitchedIndex));
    // the window of pitched phrase 1 is the third phrase of the chart, not the second
    const w = session.selectionWindow(spoken, session.onePhrase(2));
    expect(songWindow(spoken, r, { from: 1, to: 2 })).toEqual({ start: w?.start, end: w?.end, firstNote: w?.firstNote });
    // and the player maps a pitched span to the same phrases of the chart
    expect(session.selectionOfPitched(session.phraseRows(spoken), { from: 1, to: 2 })).toEqual({ from: 2, to: 3 });
  });

  it('use the song player\'s pass mark', () => {
    expect(SONG_PASS_SCORE).toBe(session.SONG_PASS_SCORE);
  });

  it('name phrases from 1, as the app shows them', () => {
    expect(phraseWords({ from: 2, to: 3 }, 12)).toBe('phrase 3');
    expect(phraseWords({ from: 2, to: 4 }, 12)).toBe('phrases 3-4');
    expect(phraseWords(null, 12)).toBe('the whole song (12 phrases)');
    expect(phraseWords(null, 12, true)).toBe('the whole song');
  });
});

// ---------------------------------------------------------------- reading the file

describe('reading a song coaching file', () => {
  const take = (): FileTake => takeOf(singTake(chart(), { selection: 1 }), 0);

  it('recognizes it by its content, and keeps what it holds', () => {
    const input = readSong(songFile([take()]), 'whatever.bin');
    expect(input.kind).toBe('song-coaching');
    if (input.kind !== 'song-coaching') return;
    expect(input.file.song.id).toBe('test-hymn');
    expect(input.file.takes).toHaveLength(1);
    expect(input.file.takes[0].phrase).toEqual({ from: 1, to: 2 });
    expect(input.file.takes[0].speed).toBe(1);
    expect(input.file.settings.notation).toBe('sharps');
  });

  it('refuses what it cannot use, and says which take or note is wrong', () => {
    const file = songFile([take()]);
    expect(() => readSong({ ...file, version: 2 as never })).toThrow(/made by a newer app \(coaching file version 2\)/);
    expect(() => readSong({ ...file, takes: [] })).toThrow(/the file holds no takes/);
    expect(() => readSong({ ...file, song: { ...file.song, notes: [] } })).toThrow(/the song has no notes/);
    expect(() => readSong({ ...file, song: { ...file.song, notes: [{ ...file.song.notes[0], type: 'spiral' as never }, ...file.song.notes.slice(1)] } })).toThrow(/song note 1 has an unknown type "spiral"/);
    expect(() => readSong({ ...file, takes: [{ ...file.takes[0], phrase: { from: 2, to: 9 } }] })).toThrow(/take 1 covers phrases 3 to 9, which the song does not have \(it has 3\)/);
    expect(() => readSong({ ...file, takes: [{ ...file.takes[0], phrase: { from: 2, to: 2 } }] })).toThrow(/take 1 covers phrases 3 to 2/);
    expect(() => readSong({ ...file, takes: [{ ...file.takes[0], track: { frameRate: 1 } as never }] })).toThrow(/take 1 has a damaged pitch line/);
    expect(() => readSong({ ...file, takes: [{ ...file.takes[0], speed: Infinity as never, attempt: { ...file.takes[0].attempt, songSpeed: undefined } }] })).toThrow(/take 1 does not say what speed it was sung at/);
    expect(() => readCoachInput(enc({ app: 'pitch-lab', kind: 'song-coaching', version: 1 }), 's.json')).toThrow(CoachInputError);
  });

  it('takes the key and speed from the attempt row when the take does not say', () => {
    const file = songFile([take()]);
    const t = file.takes[0];
    const input = readSong({ ...file, takes: [{ ...t, shift: undefined as never, speed: undefined as never, attempt: { ...t.attempt, songShift: 2, songSpeed: 0.75 } }] });
    if (input.kind !== 'song-coaching') throw new Error('not a song file');
    expect([input.file.takes[0].shift, input.file.takes[0].speed]).toEqual([2, 0.75]);
  });

  it('keeps the new fields of an attempt as the app does: null stays null, an older row stays silent, a bad value goes alone', () => {
    const base = take().attempt;
    const read = (over: Record<string, unknown>) => {
      const file = songFile([take()]);
      const input = readSong({ ...file, takes: [{ ...file.takes[0], attempt: { ...base, ...over } as AttemptRecord }] });
      if (input.kind !== 'song-coaching') throw new Error('not a song file');
      return input.file.takes[0].attempt;
    };
    const whole = read({ phrase: null, songShift: null, songSpeed: null, checkupId: null });
    expect([whole.phrase, whole.songShift, whole.songSpeed, whole.checkupId]).toEqual([null, null, null, null]);
    const older = read({ phrase: undefined, songShift: undefined, songSpeed: undefined });
    expect('phrase' in older || 'songSpeed' in older).toBe(false);
    const bad = read({ phrase: { from: 3, to: 1 }, songShift: 1.5, songSpeed: 9, checkupId: 'has a space' });
    expect([bad.phrase, bad.songShift, bad.songSpeed, bad.checkupId]).toEqual([undefined, undefined, undefined, undefined]);
    expect(read({ checkupId: 'abc-123' }).checkupId).toBe('abc-123');
  });
});

// ---------------------------------------------------------------- a clean take

describe('a clean take of one phrase', () => {
  const song = chart();
  const sung = singTake(song, { selection: 1 });
  const d = diagnose(songFile([takeOf(sung, 0)]));
  const t = d.takes[0];

  it('passes, agrees with what the player wrote, and flags nothing', () => {
    expect(t.source).toBe('track');
    expect(t.phrase).toEqual({ from: 1, to: 2 });
    expect(t.covered).toEqual([1]);
    expect(t.judged).toEqual([1]);
    expect(t.verdict.passed).toBe(true);
    expect(t.verdict.score).toBeGreaterThan(0.9);
    expect(t.verdict.app?.passed).toBe(true);
    expect(t.verdict.agrees).toBe(true);
    expect(t.checks).toEqual([]);
    expect(t.syllables.flatMap((s) => s.flags)).toEqual([]);
    expect(t.cracks).toEqual([]);
    expect(t.worst).toEqual([]);
    expect(t.insights).toEqual([]);
  });

  it('reads the phrase with its words, its score and the syllables of its notes', () => {
    expect(t.phrases).toHaveLength(1);
    expect(t.phrases[0]).toMatchObject({ phraseIndex: 1, text: 'the stars are bright ly', notes: 6, syllables: 5, passes: true });
    expect(t.syllables.map((s) => s.text)).toEqual(['the', 'stars', 'are', 'bright', 'ly']);
    // "ly ~" is one syllable on two notes: a melisma, named by its first note and spanning both
    const ly = t.syllables[4];
    expect([ly.first, ly.last, ly.notes.length, ly.target]).toEqual([LY, LY + 1, 2, 'D4-C4']);
    expect(t.syllables[1].label).toBe('phrase 2 "stars" (E4, 0:04.5)');
    for (const n of t.syllables.flatMap((s) => s.notes)) {
      expect(n.coverage).toBeGreaterThan(0.9);
      expect(Math.abs(n.biasCents ?? 99)).toBeLessThan(10);
    }
  });

  it('draws the phrase in song time, with its syllables under the axis and a bar for every note', () => {
    expect(t.graphs).toHaveLength(1);
    const lines = t.graphs[0].lines;
    const text = lines.join('\n');
    expect(t.graphs[0].phraseIndex).toBe(1);
    // the axis runs over the song's own seconds (phrase 2 is 4.0-8.5 s), never from 0
    expect(text).toMatch(/0:04 +0:04\.5 +0:05 +0:05\.5 +0:06 /);
    const lyrics = lines.find((l) => /\bthe\b.*\bstars\b/.test(l));
    expect(lyrics).toBeDefined();
    expect(lyrics).toMatch(/the\s+stars\s+are\s+bright\s+ly/);
    const plot = lines.filter((l) => /^ *[A-G][#b]?\d \|/.test(l)).map((l) => l.slice(l.indexOf('|') + 1));
    expect(plot.length).toBeGreaterThan(4);
    expect(plot.join('')).toContain('*');
    expect(plot.join('')).not.toContain('x'); // no crack drawn
    expect(text).not.toContain('F flat  S sharp'); // no mark drawn, so no legend
  });

  it('prints plain ASCII, with the sections an analyst looks for', () => {
    const text = formatSongDiagnosis(d);
    expect(text).toMatch(/^[\x00-\x7F]*$/);
    expect(text).not.toMatch(/undefined|NaN|\[object|Infinity/);
    expect(text).toContain('PITCH LAB SONG READ: Test Hymn (test-hymn)');
    expect(text).toContain('Song:     Test Hymn by Nobody (test-hymn)');
    expect(text).toContain('Phrases, as the song player scored them');
    expect(text).toContain('PASS');
    expect(text).toContain('Pitch graph, phrase 2 "the stars are bright ly"');
    expect(text).toContain('none: no syllable scored under 75% or broke.');
    expect(d.summary[0]).toMatch(/^The newest take \(.*\), phrase 2 at 100% speed, in the chart's own key: PASS at \d+(\.\d+)?% against a 70% pass mark\.$/);
  });
});

// ---------------------------------------------------------------- key, speed and the clock

describe('a take at another speed and in another key', () => {
  const song = chart();

  it('reads clean at 75% a whole tone up: the clock of a slowed take is mapped back', () => {
    const sung = singTake(song, { selection: 0, shift: 2, speed: 0.75 });
    const d = diagnose(songFile([takeOf(sung, 0)]));
    const t = d.takes[0];
    expect(t.verdict.passed).toBe(true);
    expect(t.verdict.agrees).toBe(true);
    expect(t.syllables.flatMap((s) => s.flags)).toEqual([]);
    expect(t.keyText).toBe("2 half steps up from the chart's key; the notes sit D4-A4 here");
    expect(t.windowStart).toBe(-1);
    // the graph is in song time too: the phrase starts at 0:00 whatever the speed
    expect(t.graphs[0].lines.join('\n')).toMatch(/0:00 +0:00\.5 +0:01 /);
    expect(formatSongDiagnosis(d)).toContain('at 75% speed, 2 half steps up from the chart');
  });

  it('puts a pitch line saved on the song clock back on the take clock, and says so', () => {
    const sung = singTake(song, { selection: 1, speed: 0.75 });
    const onTake = diagnose(songFile([takeOf(sung, 0)])).takes[0];
    const mapped = sung.frames.map((f) => ({ ...f, t: sung.window.start + f.t * sung.speed }));
    expect(songTrackClock(asSaved(mapped), sung.window.start, 0.75, sung.passSec)).toBe('song');
    expect(songTrackClock(asSaved(sung.frames), sung.window.start, 0.75, sung.passSec)).toBe('take');
    const onSong = diagnose(songFile([takeOf(sung, 0, { track: encodeTrack(mapped) })])).takes[0];
    expect(onSong.notes.join(' ')).toMatch(/saved pitch line is on the song's own clock/);
    expect(onSong.verdict.score).toBeCloseTo(onTake.verdict.score, 2);
    expect(onSong.verdict.agrees).toBe(true);
    expect(onTake.notes.join(' ')).not.toMatch(/song's own clock/);
  });

  it('cannot tell the clocks apart when they are the same, and reads it as the take clock', () => {
    // a whole-song take of a chart that starts one second in has a window starting at 0: both clocks agree
    const track = asSaved(makeTrack({ duration: 5, midi: () => 60 }));
    expect(songTrackClock(track, 0, 1, 5)).toBe('take');
    expect(songTrackClock(track, 3, 1, 0)).toBe('take');
  });
});

// ---------------------------------------------------------------- what went wrong, and where

describe('taking a take apart', () => {
  const song = chart();
  const of = (faults: Faults, selection: number | null = 1, over: { speed?: number; shift?: number } = {}): SongDiagnosis =>
    diagnose(songFile([takeOf(singTake(song, { selection, faults, ...over }), 0)]));

  it('names a flat syllable, by how many cents, and puts it first', () => {
    const t = of({ off: { [STARS]: -50 } }).takes[0];
    expect(t.worst[0].text).toBe('stars');
    expect(t.worst[0].flags).toContain('flat');
    expect(t.worst[0].what).toMatch(/^flat by (4[5-9]|5[0-5]) cents$/);
    expect(t.worst[0].score).toBeLessThan(0.3); // a frame scores 0 at two and a half tolerances: 50 cents of 62 is 0.2
    const note = t.syllables[1].notes[0];
    expect(note.biasCents).toBeLessThan(-44);
    expect(note.biasCents).toBeGreaterThan(-56);
    expect(t.verdict.agrees).toBe(true);
    expect(t.insights.join(' ')).not.toMatch(/steady lean/); // one note is not a lean
  });

  it('scores every note over the same alignment as its phrase: the notes add up to the phrase score the player gave', () => {
    // a take with every kind of trouble in it, slowed and in another key, so any difference in alignment would show
    const faults: Faults = { off: { [STARS]: -50, [NIGHT]: 35 }, unsung: [LY + 1], late: 0.1, flip: { note: NOW, semis: 4 } };
    for (const speed of [1, 0.75]) {
      const t = of(faults, null, { speed, shift: 3 }).takes[0];
      expect(t.phrases).toHaveLength(3);
      for (const p of t.phrases) {
        const notes = t.syllables.flatMap((s) => s.notes).filter((n) => n.phraseIndex === p.phraseIndex);
        expect(notes.length).toBe(p.notes);
        const weight = notes.reduce((s, n) => s + (n.end - n.start), 0);
        const mean = notes.reduce((s, n) => s + (n.end - n.start) * n.score, 0) / weight;
        expect(mean, `phrase ${p.phraseIndex + 1} at speed ${speed}`).toBeCloseTo(p.pitchScore, 9);
      }
    }
  });

  it('calls a sharp note sharp, and a note a whole step away a different note', () => {
    const sharp = of({ off: { [STARS]: 45 } }).takes[0];
    expect(sharp.worst[0].flags).toContain('sharp');
    expect(sharp.worst[0].what).toMatch(/^sharp by (4\d|5[0-2]) cents$/);
    const wrong = of({ off: { [STARS]: -200 } }).takes[0];
    expect(wrong.worst[0].flags).toContain('off-note');
    expect(wrong.worst[0].what).toMatch(/a different note: 2 half steps under the written one/);
    expect(wrong.worst[0].score).toBe(0);
  });

  it('finds a voice break inside a held note, on its syllable, and draws it', () => {
    const d = of({ flip: { note: LY, semis: 5, from: 0.4, sec: 0.15 } }, 1);
    const t = d.takes[0];
    // the voice jumps away and straight back: one break, with how long it stayed away
    expect(t.cracks).toHaveLength(1);
    expect(t.cracks[0]).toMatchObject({ kind: 'flip', phraseIndex: 1, noteIndex: LY, syllable: 'ly' });
    expect(t.cracks[0].cents as number).toBeGreaterThan(450);
    expect(t.cracks[0].cents as number).toBeLessThan(550);
    expect(t.cracks[0].heldMs as number).toBeGreaterThan(110);
    expect(t.cracks[0].heldMs as number).toBeLessThan(190);
    // "ly" is held from 6.0 s for 1.5 s, and breaks 40% of the way through it
    expect(t.cracks[0].t).toBeGreaterThan(6.4);
    expect(t.cracks[0].t).toBeLessThan(6.8);
    expect(t.syllables[4].flags).toContain('cracked');
    expect(t.insights.join(' ')).toMatch(/1 break in the voice, where the melody does not jump: "ly" near D4 at 0:06\.\d \(\+5 half steps for \d+ ms, then back\) \(song\.cracks\)/);
    const graph = t.graphs[0].lines.join('\n');
    expect(graph).toMatch(/\|.*x/);
    expect(graph).toMatch(/cracks at 0:06\.\d/);
    expect(graph).toMatch(/^ +X/m); // the mark under the syllable
    expect(graph).toContain('F flat  S sharp  W wrong note'); // the legend comes with a mark
  });

  it('counts two breaks in two notes as two, each with its own note', () => {
    const t = of({ flip: [{ note: LY, semis: 5, from: 0.3, sec: 0.12 }, { note: LY + 1, semis: -5, from: 0.3, sec: 0.12 }] }, 1).takes[0];
    const flips = t.cracks.filter((c) => c.kind === 'flip');
    expect(flips.map((c) => c.noteIndex)).toEqual([LY, LY + 1]);
    expect(flips.map((c) => Math.sign(c.cents as number))).toEqual([1, -1]);
    expect(t.insights.join(' ')).toMatch(/2 breaks in the voice/);
  });

  it('never reads the melody\'s own leaps as breaks, with a gap between the notes or without one', () => {
    for (const legato of [false, true]) {
      const t = of({ legato }, 2).takes[0]; // "shin" to "ing" leaps up 7 half steps
      expect(t.cracks, `legato ${legato}`).toEqual([]);
      expect(t.verdict.passed).toBe(true);
    }
    // a leap sung a quarter of a second late is still the leap: the written step is looked for either side of the jump
    const late = of({ legato: true, late: 0.15 }, 2).takes[0];
    expect(late.cracks).toEqual([]);
  });

  it('finds the sound stopping in the middle of a note', () => {
    const t = of({ dropout: { note: NOW, sec: 0.5 } }, 2).takes[0];
    expect(t.cracks).toHaveLength(1);
    expect(t.cracks[0]).toMatchObject({ kind: 'dropped', noteIndex: NOW, syllable: 'now' });
    expect(t.cracks[0].durationMs).toBeGreaterThan(400);
    expect(t.syllables[2].flags).toContain('dropped');
    expect(t.insights.join(' ')).toMatch(/The sound dropped out inside 1 note: "now" at 0:\d\d\.\d \(\d+ ms\) \(song\.breath\)/);
    expect(t.syllables[2].what).toMatch(/the sound dropped out in the middle of it/);
  });

  it('says a note was left unsung, and where the singing stopped', () => {
    const t = of({ unsung: [BRIGHT, LY, LY + 1] }, 1).takes[0];
    expect(t.syllables[3].flags).toContain('unsung');
    expect(t.syllables[4].flags).toContain('unsung');
    expect(t.worst.map((s) => s.text)).toEqual(expect.arrayContaining(['bright', 'ly']));
    expect(t.insights.join(' ')).toMatch(/3 notes of 6 left unsung: "bright" \(phrase 2, 0:05\.5\)/);
    expect(t.verdict.passed).toBe(false);
    expect(t.verdict.agrees).toBe(true);
  });

  it('reads a steady lateness as the latency calibration, not as the singer', () => {
    const t = of({ late: 0.18 }, null).takes[0];
    const timed = t.syllables.flatMap((s) => s.notes).filter((n) => n.offsetMs !== null);
    expect(timed.length).toBeGreaterThan(8);
    // two notes on the same pitch one after the other cannot be told apart by pitch, so the alignment puts their join at the written time:
    // nearly every note, not every one, shows the lateness
    expect(timed.filter((n) => (n.offsetMs as number) > 140).length).toBeGreaterThanOrEqual(timed.length - 1);
    expect(t.insights.join(' ')).toMatch(/Almost every note comes in late by about the same amount \(median \+1[6-9]\d ms, spread \d+ ms\): that is the look of the latency calibration \(120 ms on this route\)/);
    expect(t.syllables.filter((s) => s.flags.includes('late')).length).toBeGreaterThanOrEqual(8);
    expect(t.verdict.passed).toBe(true);
  });

  it('calls a long note that wanders a waver, and a long note with a regular vibrato not one', () => {
    const wavering = of({ wobble: { note: NIGHT, cents: 70 } }, 0).takes[0];
    expect(wavering.syllables[3].flags).toContain('wobbly');
    expect(wavering.syllables[3].what).toMatch(/wavered \(spread \d+ cents\)/);
    expect(wavering.insights.join(' ')).toMatch(/Long notes wavered or sank: "night" \(C4, 0:02\.0\) \(song\.unsteady\)/);
    // the same swing of pitch, sung as a vibrato of six wobbles a second, is the singer's voice, not wavering
    const vibrato = of({ vibrato: { note: NIGHT, hz: 5.8, cents: 45 } }, 0).takes[0];
    const note = vibrato.syllables[3].notes[0];
    expect(note.vibrato).toBe(true);
    expect(note.stabilitySdCents as number).toBeGreaterThan(25);
    expect(vibrato.syllables[3].flags).not.toContain('wobbly');
    expect(vibrato.phrases[0].vibratoPresent).toBe(true);
    expect(vibrato.insights.join(' ')).not.toMatch(/wavered/);
  });

  it('notes an octave away without counting it against the take', () => {
    const t = of({ octaves: -1 }, 1).takes[0];
    expect(t.verdict.passed).toBe(true);
    expect(t.verdict.agrees).toBe(true);
    expect(t.insights.join(' ')).toMatch(/Sung an octave below the written note on 6 of 6 sung notes/);
    expect(t.syllables[0].what).toMatch(/sung an octave below \(not counted against it\)/);
  });

  it('finds a lean, and the end of the range that carries it', () => {
    // every note of the whole song 40 cents flat, the highest ones (the G4s) 60
    const off: Record<number, number> = {};
    for (let k = 0; k <= NOW; k++) off[k] = -40;
    off[0] = -65;
    off[1] = -65;
    off[ING] = -65;
    const t = of({ off }, null).takes[0];
    expect(t.insights.join(' ')).toMatch(/Flat on 13 of 13 sung notes \(median -40 cents\): a steady lean, not scatter \(song\.flat\)/);
    expect(t.insights.join(' ')).toMatch(/The highest notes \(F4-G4, 4 of them\) come out -65 cents against -40 for the rest \(song\.high\)/);
  });

  it('finds the landings after big jumps off when the rest are on', () => {
    const t = of({ off: { [ING]: 55 } }, 2).takes[0];
    expect(t.insights.join(' ')).not.toMatch(/Landings after big jumps/); // one landing is not a pattern
    const both = of({ off: { [ING]: 55, [NIGHT]: -50 } }, null).takes[0];
    expect(both.insights.join(' ')).toMatch(/Landings after big jumps are off \(median 5\d cents against \d+ on the other notes\): "(ing|night)" \((5|7) half steps (up|down), [+-]5\d cents\)/);
  });

  it('judges a take stopped by hand on the phrases it got to the end of, as the player does', () => {
    const sung = singTake(song, { selection: null });
    // phrase 2 ends at 8.5 s of the song, 9.5 s into the take; stop at 9.8 s: phrase 3 never finished
    const stopAt = 9.8;
    const frames = sung.frames.filter((f) => f.t <= stopAt);
    const cut = { ...sung, frames };
    const attempt = attemptOf(cut, { minutes: 0, finished: [0, 1], sungSec: stopAt });
    const d = diagnose(songFile([{ attempt, phrase: null, shift: 0, speed: 1, track: encodeTrack(frames), audioWavBase64: null }]));
    const t = d.takes[0];
    expect(t.covered).toEqual([0, 1, 2]);
    expect(t.judged).toEqual([0, 1]);
    expect(t.phrases.map((p) => p.phraseIndex)).toEqual([0, 1]);
    expect(t.verdict.why[0]).toMatch(/The take was stopped early: 2 of 3 phrases got to the end and were judged/);
    expect(t.verdict.agrees).toBe(true);
    expect(formatSongDiagnosis(d)).toContain('Judged:   2 of 3 phrases');
  });

  it('draws the phrase it is asked for (--phrase), in every take that covers it, and the worst few otherwise', () => {
    // a note or two left out of every phrase, so every phrase fails
    const takes = [takeOf(singTake(song, { selection: null, faults: { unsung: [NIGHT, BRIGHT, LY, LY + 1, NOW] } }), 0)];
    const worst = diagnose(songFile(takes)).takes[0];
    expect(worst.phrases.every((p) => !p.passes)).toBe(true);
    expect(worst.graphs.map((g) => g.phraseIndex)).toEqual([0, 1, 2]); // at most three, the ones that did not pass first
    const oneGood = diagnose(songFile([takeOf(singTake(song, { selection: null, faults: { unsung: [NIGHT] } }), 0)])).takes[0];
    expect(oneGood.phrases.filter((p) => p.passes).length).toBe(2);
    expect(oneGood.graphs.map((g) => g.phraseIndex)).toEqual([0]); // the one that failed; passing phrases are drawn only when asked for
    const asked = diagnose(songFile(takes), { phrase: 3 }).takes[0];
    expect(asked.graphs.map((g) => g.phraseIndex)).toEqual([2]);
    const none = diagnose(songFile(takes), { phrase: 9 });
    expect(none.takes[0].graphs.length).toBeGreaterThan(0);
    expect(none.notes.join(' ')).toMatch(/--phrase 9: the song has 3 scored phrases/);
  });
});

// ---------------------------------------------------------------- odd takes and odd charts

describe('odd takes and odd charts', () => {
  it('reads a take with no voice in it: a miss, every syllable unsung, nothing invented', () => {
    const song = chart();
    const sung = singTake(song, { selection: 1 });
    const silent: Sung = { ...sung, frames: sung.frames.map((f) => ({ ...f, voiced: false, midi: NaN, f0Hz: NaN, confidence: 0.1, rmsDb: -80 })) };
    const d = diagnose(songFile([takeOf(silent, 0)]));
    const t = d.takes[0];
    expect(t.verdict.passed).toBe(false);
    expect(t.verdict.score).toBe(0);
    expect(t.verdict.agrees).toBe(true);
    expect(t.syllables.every((s) => s.flags.includes('unsung'))).toBe(true);
    expect(t.cracks).toEqual([]);
    expect(t.worst).toHaveLength(5);
    const text = formatSongDiagnosis(d);
    expect(text).not.toMatch(/undefined|NaN|\[object|Infinity/);
    expect(text).toMatch(/^[\x00-\x7F]*$/);
    expect(text).toMatch(/5 notes of 6 left unsung|6 notes of 6 left unsung/);
  });

  it('reads a take whose saved pitch line is empty, as a take with no pitch line', () => {
    const song = chart();
    const t = diagnose(songFile([takeOf(singTake(song, { selection: 1 }), 0, { track: encodeTrack([]) })])).takes[0];
    expect(t.source).toBe('metrics');
    expect(t.notes.join(' ')).toMatch(/the saved pitch line could not be decoded/);
    expect(t.notes.join(' ')).toMatch(/No pitch line for this take/);
  });

  it('reads a chart with a spoken phrase: the pitched phrases are numbered without it, and the window is the right one', () => {
    const spoken = {
      ...parseUltraStar(`#TITLE:Spoken\n#ARTIST:N\n#BPM:120\n#GAP:0\n: 0 8 0  la\n: 8 8 4  la\n- 18\nF 20 8 0  blah\n- 30\n: 32 8 2  do\n: 40 8 5  re\n: 48 8 7  mi\nE\n`).song,
      id: 'spoken',
    };
    // Song.phrases: 0 sung, 1 spoken, 2 sung; pitched phrases 0 and 1. Sing pitched phrase 2 (Song.phrases index 2) a little flat.
    const sung = singTake(spoken, { selection: 2, faults: { off: { 2: -50 } } });
    expect(sung.covered).toEqual([1]);
    expect(sung.phrase).toEqual({ from: 1, to: 2 });
    const file = { ...songFile([takeOf(sung, 0)], spoken) };
    const d = diagnose(file);
    const t = d.takes[0];
    expect(d.song.phrases).toBe(2);
    expect(d.chart.map((c) => c.text)).toEqual(['la la', 'do re mi']);
    expect(t.covered).toEqual([1]);
    expect(t.verdict.passed).toBe(true);
    expect(t.verdict.agrees).toBe(true);
    expect(t.windowStart).toBe(session.selectionWindow(spoken, session.onePhrase(2))?.start);
    expect(t.worst[0]?.text).toBe('do');
    expect(t.worst[0]?.what).toMatch(/flat by (4[5-9]|5[0-5]) cents/);
    expect(formatSongDiagnosis(d)).toContain('Sang:     phrase 2 at 100% speed');
  });
});

// ---------------------------------------------------------------- the take with no pitch line, and the one with audio

describe('a take with no pitch line, and a take with audio', () => {
  const song = chart();

  it('reads the numbers the app saved, and says what to ask for', () => {
    const sung = singTake(song, { selection: 1, faults: { off: { [STARS]: -50 } } });
    const d = diagnose(songFile([takeOf(sung, 0, { track: null })]));
    const t = d.takes[0];
    expect(t.source).toBe('metrics');
    expect(t.graphs).toEqual([]);
    expect(t.phrases).toEqual([]);
    expect(t.verdict.agrees).toBeNull();
    expect(t.verdict.passed).toBe(t.verdict.app?.passed);
    expect(t.notes.join(' ')).toMatch(/No pitch line for this take/);
    expect(d.engine.status).toBe('unused');
    const text = formatSongDiagnosis(d);
    expect(text).toContain('saved numbers only');
    expect(text).toContain('a take with no pitch line cannot be located');
    expect(text).not.toContain('Pitch graph');
  });

  it('rebuilds the pitch line from the audio when the file has none', () => {
    const sung = singTake(song, { selection: 1, faults: { off: { [STARS]: -50 } } });
    const sampleRate = 48000;
    const w0 = sung.window.start;
    const spans = sung.view.notes
      .slice(sung.view.phrases[1].from, sung.view.phrases[1].to)
      .map((n) => ({ midi: n.midi + (n.midi === sung.view.notes[STARS].midi && n.start === sung.view.notes[STARS].start ? -0.5 : 0), start: n.start - w0, end: n.start + n.duration - w0 - 0.04 }));
    const samples = synthesize({ sampleRate, duration: sung.passSec + 0.4, f0: notesContour(spans), amp: 0.3 });
    const rebuilt = trackFromSamples(samples, sampleRate);
    const attempt = attemptOf({ ...sung, frames: rebuilt }, { minutes: 0 });
    const wav = bytesToBase64(new Uint8Array(encodeWav(samples, sampleRate)));
    const t = diagnose(songFile([{ attempt, phrase: sung.phrase, shift: 0, speed: 1, track: null, audioWavBase64: wav }])).takes[0];
    expect(t.source).toBe('audio');
    expect(t.verdict.agrees).toBe(true);
    expect(t.worst[0].text).toBe('stars');
    expect(t.worst[0].what).toMatch(/flat by (4[0-9]|5[0-5]) cents/);
    // a WAV given beside the file goes to its newest take, and is checked against the saved pitch line
    const withLine = songFile([takeOf(singTake(song, { selection: 1 }), 0)]);
    const wavInput = readCoachInput(new Uint8Array(encodeWav(samples, sampleRate)), 'pitch-lab-take-2026-10-22.wav');
    const reports = analyzeReports([readSong(withLine), wavInput], { songEngine: fakeSongEngine() });
    const first = reports[0];
    if (!isSongReport(first)) throw new Error('not a song read');
    expect(first.takes[0].trackCheck).not.toBeNull();
    expect(first.takes[0].checks.join(' ')).toMatch(/Audio check: the pitch line rebuilt from the audio has \d+ voiced frames against \d+ saved/);
  }, 60_000);
});

// ---------------------------------------------------------------- across the takes

describe('across the takes of a phrase', () => {
  const song = chart();
  // oldest first: three takes of phrase 2 at full speed, each a little better than the one before
  const specs: Faults[] = [
    { off: { [STARS]: -60, [BRIGHT]: -60, 4: -60 }, unsung: [LY], seed: 1 },
    { off: { [STARS]: -45, [BRIGHT]: -45 }, seed: 2 },
    { off: { [STARS]: -30 }, seed: 3 },
  ];
  const file = songFile(specs.map((faults, i) => takeOf(singTake(song, { selection: 1, faults }), i * 4)));
  const d = diagnose(file);

  it('lists the takes newest first, and compares them oldest to newest', () => {
    expect(d.takes.map((t) => t.index)).toEqual([1, 2, 3]);
    expect(d.comparison?.rows.map((r) => r.index)).toEqual([3, 2, 1]);
    expect(d.comparison?.rows.map((r) => r.scope)).toEqual(['phrase 2', 'phrase 2', 'phrase 2']);
    const scores = d.comparison?.rows.map((r) => r.score) ?? [];
    expect(scores[0]).toBeLessThan(scores[1]);
    expect(scores[1]).toBeLessThan(scores[2]);
    expect(d.comparison?.scoreTrend).toBe('better');
  });

  it('says what improves, and what keeps coming back', () => {
    const cmp = d.comparison;
    expect(cmp).not.toBeNull();
    if (!cmp) return;
    expect(cmp.phrases).toHaveLength(1);
    expect(cmp.phrases[0]).toMatchObject({ phraseIndex: 1, verdict: 'better' });
    expect(cmp.improved.join(' ')).toMatch(/^Phrase 2: \d+% -> \d+% -> \d+%/);
    expect(cmp.worsened).toEqual([]);
    expect(cmp.repeats.join(' ')).toMatch(/The same trouble spots keep coming back: phrase 2, "stars" \(E4\) in 3 of 3 takes \(flat\)/);
    const text = formatSongDiagnosis(d);
    expect(text).toContain('ACROSS THE TAKES (oldest to newest; take 1 is the newest)');
    expect(text).toContain('Improving:');
    expect(text).toContain('Repeating:');
    expect(text).toMatch(/phrase +2 +the stars are bright ly +\d+% -> \d+% -> \d+% +better/);
    expect(text.indexOf('TAKE 1 (newest) of 3')).toBeLessThan(text.indexOf('TAKE 3 of 3'));
    // the graphs are drawn for the newest take; the others point at --take
    expect(text).toContain('(The graphs are drawn for the first take shown: --take 2 draws this one');
    expect((text.match(/Pitch graph, phrase/g) ?? []).length).toBe(1);
    expect((formatSongDiagnosis(d, { take: 3 }).match(/Pitch graph, phrase/g) ?? []).length).toBe(1);
    expect(formatSongDiagnosis(d, { take: 3 })).not.toContain('TAKE 1 (newest)');
    expect(formatSongDiagnosis(d, { take: 9 })).toContain('(no take 9: the file has 3)');
  });

  it('weighs a slowed take against a full-speed one, and does not let the slowed ones decide the trend', () => {
    const slow = singTake(song, { selection: 1, speed: 0.75 });
    const full = singTake(song, { selection: 1, faults: { off: { [STARS]: -60, [BRIGHT]: -60 } } });
    const fast = singTake(song, { selection: 1, faults: { off: { [STARS]: -60, [BRIGHT]: -60 }, seed: 5 } });
    const dd = diagnose(songFile([takeOf(full, 0), takeOf(slow, 4), takeOf(fast, 8)]));
    const trend = dd.comparison?.phrases[0];
    expect(trend?.series.map((s) => s.speed)).toEqual([1, 0.75, 1]);
    // the two full-speed takes are the basis: they are alike, so the phrase is "same" even though the slowed take was far better
    expect(trend?.verdict).toBe('same');
    expect(dd.comparison?.hints.join(' ')).toMatch(/Phrase 2: \d+% slowed against \d+% at full speed\. The notes are within reach; the speed is what is missing\./);
    expect(formatSongDiagnosis(dd)).toMatch(/\d+% -> \d+%\* -> \d+%/);
  });

  it('copes with one take, and with takes of different phrases', () => {
    expect(compareSongTakes([d.takes[0]], song).rows).toHaveLength(1);
    const mixed = diagnose(songFile([takeOf(singTake(song, { selection: 0 }), 0), takeOf(singTake(song, { selection: 1 }), 4), takeOf(singTake(song, { selection: null }), 8)]));
    expect(mixed.comparison?.scoreTrend).toBe('unknown');
    expect(mixed.comparison?.phrases.map((p) => p.phraseIndex)).toEqual([0, 1]);
    expect(mixed.summary.join(' ')).toMatch(/over different phrases, so read them phrase by phrase/);
  });

  it('reads the streak from the misses in a row on the newest take\'s phrases', () => {
    expect(d.streak.scope).toBe('phrase 2');
    expect(d.streak.depth).toBeGreaterThanOrEqual(1);
    const text = formatSongDiagnosis(d);
    expect(text).toMatch(/Streak: {3}(at least )?\d+ (miss|misses) in a row on phrase 2, so the app is at coaching depth \d of 4/);
  });
});

// ---------------------------------------------------------------- the history in a backup

describe('the history of a song in a backup', () => {
  const song = chart();
  const profile: ProfileRecord = { id: 'p1', profileId: 'p1', createdAt: isoAt(-1000), updatedAt: isoAt(-1000), deletedAt: null, name: 'Test Singer', voiceType: 'baritone', range: null };
  const backupInput = (attempts: AttemptRecord[]) => {
    const file: BackupFile = { format: 'pitch-lab-backup', version: 1, exportedAt: isoAt(130), profiles: [profile], attempts, settings: { schemaVersion: 1, profiles: {} } };
    return readCoachInput(enc(file), 'pitch-lab-backup-2026-10-22.json');
  };
  const older = (id: string, minutes: number, score: number): AttemptRecord => {
    const a = attemptOf(singTake(song, { selection: 1 }), { minutes });
    const { phrase: _phrase, songShift: _shift, songSpeed: _speed, ...rest } = a;
    return { ...rest, id, createdAt: isoAt(minutes), updatedAt: isoAt(minutes), score, passed: score >= SONG_PASS_SCORE };
  };

  const takes = [takeOf(singTake(song, { selection: 1, faults: { off: { [STARS]: -50 } } }), 20), takeOf(singTake(song, { selection: 1 }), 30)];
  const inBackup = [older('old-1', -3000, 0.41), older('old-2', -2000, 0.55), ...takes.map((t) => t.attempt)];

  it('lists every take of the song, the older ones as older, with the first, best and latest', () => {
    const [report] = analyzeReports([readSong(songFile(takes)), backupInput(inBackup)], { songEngine: fakeSongEngine() });
    if (!isSongReport(report)) throw new Error('not a song read');
    const h = report.history;
    expect(h?.fromBackup).toBe(true);
    expect(h?.rows).toHaveLength(4);
    expect(h?.rows.map((r) => r.scope)).toEqual(['an older take', 'an older take', 'phrase 2', 'phrase 2']);
    expect(h?.rows.map((r) => r.inFile)).toEqual([false, false, true, true]);
    expect(h?.rows[0].speed).toBeNull();
    expect(h?.first?.score).toBe(0.41);
    expect(h?.last?.id).toBe(takes[1].attempt.id);
    expect(h?.scopes.map((s) => [s.scope, s.takes])).toEqual([['phrase 2', 2], ['older takes (phrases not logged)', 2]]);
    const text = formatReport(report);
    expect(text).toContain('THE HISTORY OF THIS SONG (4 takes in the backup; 2 with a pitch line in the file)');
    expect(text).toMatch(/first take: +\d{4}-\d\d-\d\d \d\d:\d\d, an older take: miss at 41%/);
    expect(text).toMatch(/\* \d{4}-\d\d-\d\d \d\d:\d\d +phrase 2 +100% +key 0/);
  });

  it('says it is the takes in the file only when no backup came with it', () => {
    const [report] = analyzeReports([readSong(songFile(takes))], { songEngine: fakeSongEngine() });
    if (!isSongReport(report)) throw new Error('not a song read');
    expect(report.history?.fromBackup).toBe(false);
    expect(report.history?.rows).toHaveLength(2);
    expect(formatReport(report)).toContain('give the backup too for the whole log');
  });

  it('leaves out takes newer than the file\'s newest, and says how many', () => {
    const newer = [{ ...attemptOf(singTake(song, { selection: 1 }), { minutes: 90 }), id: 'newer-1' }, { ...attemptOf(singTake(song, { selection: 1 }), { minutes: 95 }), id: 'newer-2' }];
    const [report] = analyzeReports([readSong(songFile(takes)), backupInput([...inBackup, ...newer])], { songEngine: fakeSongEngine() });
    if (!isSongReport(report)) throw new Error('not a song read');
    expect(report.notes.join(' ')).toMatch(/The backup holds 2 takes of this song newer than the newest in the file; they are left out of this read/);
    expect(report.history?.rows.some((r) => r.id.startsWith('newer'))).toBe(false);
    expect(report.history?.rows).toHaveLength(4);
  });

  it('says so when the backup has none of this singer', () => {
    const stranger = backupInput([{ ...older('x', 0, 0.5), profileId: 'someone-else' }]);
    const [report] = analyzeReports([readSong(songFile(takes)), stranger], { songEngine: fakeSongEngine() });
    if (!isSongReport(report)) throw new Error('not a song read');
    expect(report.notes.join(' ')).toMatch(/The backup has no attempts for this song file's profile/);
  });
});

// ---------------------------------------------------------------- the file the app writes

describe('the file the app writes', () => {
  it('is the file this tool reads: song-export.ts buildSongCoachingFileFrom, serialized as the share sheet takes it', async () => {
    const { buildSongCoachingFileFrom, songCoachingBlob, songCoachingFileName } = await import('./song-export');
    const song = chart();
    // oldest first: phrase 2 a little flat, phrase 2 slowed a tone up, the whole song
    const sungs = [singTake(song, { selection: 1, faults: { off: { [STARS]: -50 } } }), singTake(song, { selection: 1, speed: 0.75, shift: 2 }), singTake(song, { selection: null })];
    const attempts = sungs.map((s, i) => ({ ...attemptOf(s, { minutes: i * 5 }), takeId: `take-${i}` }));
    const records = new Map(
      sungs.map((s, i) => [
        `take-${i}`,
        { id: `take-${i}`, profileId: 'p1', createdAt: attempts[i].createdAt, updatedAt: attempts[i].createdAt, deletedAt: null, exerciseId: 'song.test-hymn', track: encodeTrack(s.frames), audioRef: null, sampleRate: 48000, latencyMs: 123 },
      ]),
    );
    const singer: ProfileRecord = { id: 'p1', profileId: 'p1', createdAt: isoAt(-1000), updatedAt: isoAt(-1000), deletedAt: null, name: 'Test Singer', voiceType: 'baritone', range: null };
    const file = await buildSongCoachingFileFrom(
      song,
      { includeAudio: false },
      {
        storage: {
          profiles: { active: async () => singer },
          attempts: { listByExercise: async (profileId, exerciseId) => attempts.filter((a) => a.profileId === profileId && a.exerciseId === exerciseId) },
          takes: { get: async (id) => records.get(id), audio: async () => undefined },
        },
        settings: { notation: 'flats' },
        device: { route: 'wired', latencyMs: 90, userAgent: 'vitest' },
        now: new Date(T0 + 60 * 60_000),
        appVersion: '0.1.0+song-export-test',
      },
    );
    const name = songCoachingFileName(file);
    expect(name).toMatch(/^pitch-lab-coach-song-test-hymn-\d{4}-\d\d-\d\d-\d{4}\.json$/);
    const [d] = analyzeReports([readCoachInput(new TextEncoder().encode(await songCoachingBlob(file).text()), name)], { songEngine: fakeSongEngine() });
    if (!isSongReport(d)) throw new Error('not a song read');
    expect(d.name).toBe(name);
    expect(d.appVersion).toBe('0.1.0+song-export-test');
    expect(d.singer.notation).toBe('flats');
    expect(d.takes.map((t) => [t.phrase, t.speed, t.shift])).toEqual([[null, 1, 0], [{ from: 1, to: 2 }, 0.75, 2], [{ from: 1, to: 2 }, 1, 0]]);
    expect(d.takes.map((t) => t.source)).toEqual(['track', 'track', 'track']);
    expect(d.takes.every((t) => t.verdict.agrees === true)).toBe(true);
    expect(d.takes.every((t) => t.checks.length === 0)).toBe(true);
    expect(d.takes[2].worst[0].text).toBe('stars');
    expect(d.comparison?.rows.map((r) => r.index)).toEqual([3, 2, 1]);
    // the newest take's own latency compensation is what the file reports for the route
    expect(file.device.latencyMs).toBe(123);
    expect(formatSongDiagnosis(d)).toContain('flat by');
  });
});

// ---------------------------------------------------------------- the engines

describe('the song coach and the practice path', () => {
  const song = chart();
  const file = songFile([takeOf(singTake(song, { selection: 1, faults: { off: { [STARS]: -50 } } }), 0), takeOf(singTake(song, { selection: 1, faults: { off: { [STARS]: -45 } } }), 4)]);

  it('hands the coach the take the way the player does: scored phrases, and the pitch line on the song\'s own clock', () => {
    const engine = fakeSongEngine();
    const d = diagnoseSongFile(file, { engine });
    expect(engine.asked).toHaveLength(2);
    // the log it is given is the log after the take: one take, then two
    expect(engine.asked.map((a) => a.logLength).sort()).toEqual([1, 2]);
    expect(engine.asked.every((a) => a.scores === 1)).toBe(true);
    // phrase 2 starts at 4 s of the song: its window at 3 s, the pre-roll half a second before: the line begins near 2.5 s
    expect(engine.asked[0].trackStart).toBeGreaterThan(2.4);
    expect(engine.asked[0].trackStart).toBeLessThan(2.6);
    expect(d.engine).toEqual({ status: 'ok', message: null });
    const text = formatSongDiagnosis(d);
    expect(text).toContain('Located problem (engine, coaching/song.ts):');
    expect(text).toContain('  song.flat on song.phraseScore:\n    You were a little flat on "stars".');
    expect(text).toContain('  where, worst first:\n    - 0:05, near E4');
    expect(text).toContain('What the app tells the singer (coachSongTake): depth 1, 1 miss in a row:');
    expect(text).toContain('tip:    Aim a little higher.');
    expect(d.summary.join(' ')).toContain("The song coach's pick, song.flat: You were a little flat on \"stars\".");
  });

  it('does not stop at an engine that throws: the read still comes out, with the reason', () => {
    const broken: SongCoachEngine = {
      coachSongTake: () => {
        throw new Error('coachSongTake: not built yet');
      },
      songMissesInARow: () => {
        throw new Error('songMissesInARow: not built yet');
      },
      songPractice: () => {
        throw new Error('songPractice: not built yet');
      },
    };
    const d = diagnoseSongFile(file, { engine: broken });
    expect(d.takes[0].verdict.passed).toBeDefined();
    expect(d.takes[0].engine.problem).toBeNull();
    expect(d.engine.status).toBe('not-built');
    expect(d.practice.status).toBe('not-built');
    expect(d.streak.misses).toBeGreaterThanOrEqual(0); // this tool's own count stands in
    const text = formatSongDiagnosis(d);
    expect(text).toContain('not available: the song coach is not built yet in this checkout.');
    expect(text).toContain('not available: song/practice.ts still throws "not built yet"');
    expect(text).toContain('TAKE 1 (newest) of 2');
  });

  it('runs the real engines too: they answer, or say they are not built yet', () => {
    const d = diagnoseSongFile(file, { engine: REAL_SONG_ENGINE });
    expect(['ok', 'not-built']).toContain(d.engine.status);
    expect(['ok', 'not-built']).toContain(d.practice.status);
    if (d.engine.status === 'ok') {
      const problem = d.takes[0].engine.problem;
      expect(problem).not.toBeNull();
      expect(problem?.tipId.startsWith('song.')).toBe(true);
      expect(d.takes[0].engine.coaching?.problem).toBe(problem);
    }
    if (d.practice.status === 'ok') {
      expect(d.practice.value?.songId).toBe('test-hymn');
      expect(d.practice.value?.phrases).toHaveLength(3);
    }
    expect(formatSongDiagnosis(d)).toMatch(/^[\x00-\x7F]*$/);
  });
});

// ---------------------------------------------------------------- the graph

describe('the pitch graph with lyrics', () => {
  const notes = [
    { midi: 60, start: 10, end: 11 },
    { midi: 64, start: 11, end: 12 },
  ];
  const at = (g: ReturnType<typeof renderPitchGraph>, text: string): number => (g.lines.find((l) => l.includes(text)) ?? '').indexOf(text) - g.labelWidth;

  it('runs from a start that is not zero, with the axis in the clock it is given', () => {
    const g = renderPitchGraph({ notes, track: [], cracks: [], totalSec: 12 }, { width: 40, startSec: 9.5, endSec: 12.5, timeLabel: (t) => `${t}s!` });
    expect(g.startSec).toBe(9.5);
    expect(g.endSec).toBe(12.5);
    expect(g.binSec).toBeCloseTo(0.075, 9);
    const text = g.lines.join('\n');
    expect(text).toMatch(/10s! +11s! +12s!/);
    expect(text).not.toMatch(/^ +0s/m);
    // a note outside the window is not drawn at all
    const out = renderPitchGraph({ notes: [{ midi: 60, start: 0, end: 1 }, ...notes], track: [], cracks: [], totalSec: 12 }, { width: 40, startSec: 9.5, endSec: 12.5 });
    expect(out.lines.join('\n')).toBe(renderPitchGraph({ notes, track: [], cracks: [], totalSec: 12 }, { width: 40, startSec: 9.5, endSec: 12.5 }).lines.join('\n'));
  });

  it('writes each syllable at the column its note starts in, and a mark under it', () => {
    const g = renderPitchGraph(
      { notes, track: [], cracks: [], totalSec: 12 },
      { width: 40, startSec: 9.5, endSec: 12.5, lyrics: [{ t: 10, text: 'ho', mark: 'F' }, { t: 11, text: 'ly', mark: 'LE' }], markLegend: 'F flat  L late  E early' },
    );
    // column of t: floor((t - 9.5) / 0.075)
    expect(at(g, 'ho')).toBe(Math.floor((10 - 9.5) / 0.075 + 1e-9));
    expect(at(g, 'ly')).toBe(Math.floor((11 - 9.5) / 0.075 + 1e-9));
    const markRow = g.lines.find((l) => /^ +F +LE$/.test(l));
    expect(markRow).toBeDefined();
    expect((markRow as string).indexOf('F') - g.labelWidth).toBe(at(g, 'ho'));
    expect((markRow as string).indexOf('LE') - g.labelWidth).toBe(at(g, 'ly'));
    expect(g.lines).toContain(`${' '.repeat(g.labelWidth)}F flat  L late  E early`);
    expect(g.lyricsHidden).toBe(0);
  });

  it('puts crowded syllables on a second row, shortens one that still does not fit, and counts the ones with no room', () => {
    const crowd = [
      { t: 10.0, text: 'ex' },
      { t: 10.1, text: 'tra' },
      { t: 10.2, text: 'or' },
      { t: 10.3, text: 'din' },
      { t: 10.4, text: 'ar' },
      { t: 10.5, text: 'y' },
    ];
    const g = renderPitchGraph({ notes, track: [], cracks: [], totalSec: 12 }, { width: 24, startSec: 9.5, endSec: 12.5, lyrics: crowd });
    const first = g.lines.findIndex((l) => /\bex\b/.test(l));
    const second = g.lines.findIndex((l) => /\btra\b/.test(l));
    expect(first).toBeGreaterThan(-1);
    expect(second).toBe(first + 1); // the next syllable goes on the second row, straight under the first
    // each starts where its note does (column 4 of 24 over three seconds), whole and not running into the next
    expect(g.lines[first].indexOf('ex') - g.labelWidth).toBe(4);
    expect(g.lines[second].indexOf('tra') - g.labelWidth).toBe(4);
    // "or" and "din" start in the middle of the two before them on both rows: counted, not squeezed in or written over; "ar" and "y" fit
    expect(g.lyricsHidden).toBe(2);
    expect(g.lines.join('\n')).toMatch(/\(2 syllables too close to the next to be written here\)/);
    expect(g.lines.some((l) => /\bar\b/.test(l))).toBe(true);
  });

  it('leaves the graph of an exercise take exactly as it was when no lyrics or window are given', () => {
    const frame = (t: number, midi: number): PitchFrame => ({ t, f0Hz: midiToHz(midi), midi, centsFromNearest: centsFromNearest(midi), confidence: 0.95, rmsDb: -20, voiced: true });
    const track = Array.from({ length: 100 }, (_, i) => frame(i / 50, 60));
    const g = renderPitchGraph({ notes: [{ midi: 60, start: 0, end: 2 }], track, cracks: [], totalSec: 2 }, { width: 40 });
    expect(g.startSec).toBe(0);
    expect(g.lyricsHidden).toBe(0);
    expect(g.lines.some((l) => /^ +0s +1s +2s$/.test(l) || /^ +0s /.test(l))).toBe(true);
  });
});

// ---------------------------------------------------------------- scripts/coach.mjs

describe('scripts/coach.mjs on a song file', () => {
  const song = chart();
  const takes = [
    takeOf(singTake(song, { selection: 1, faults: { off: { [STARS]: -55, [BRIGHT]: -50 }, flip: { note: LY, semis: 5 }, seed: 1 } }), 0),
    takeOf(singTake(song, { selection: 1, faults: { off: { [STARS]: -45 }, seed: 2 } }), 4),
    takeOf(singTake(song, { selection: 1, faults: { off: { [STARS]: -35 }, seed: 3 } }), 8),
  ];
  const run = (args: string[]): { status: number; out: string; err: string } => {
    try {
      const out = childProcess.execFileSync(proc.execPath, [path.join(ROOT, 'scripts/coach.mjs'), ...args], { cwd: ROOT, encoding: 'utf8', timeout: 90_000, stdio: ['ignore', 'pipe', 'pipe'] });
      return { status: 0, out, err: '' };
    } catch (e) {
      const x = e as { status?: number; stdout?: string; stderr?: string };
      return { status: x.status ?? -1, out: x.stdout ?? '', err: x.stderr ?? '' };
    }
  };

  it('reads a song file end to end, with a backup beside it, and one take or one phrase on request', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pitch-lab-coach-song-'));
    try {
      const file = path.join(dir, 'pitch-lab-coach-song-test-hymn-2026-10-22-1900.json');
      fs.writeFileSync(file, JSON.stringify(songFile(takes)));
      const backupPath = path.join(dir, 'pitch-lab-backup-2026-10-22.json');
      const backup: BackupFile = {
        format: 'pitch-lab-backup',
        version: 1,
        exportedAt: isoAt(130),
        profiles: [{ id: 'p1', profileId: 'p1', createdAt: isoAt(-1000), updatedAt: isoAt(-1000), deletedAt: null, name: 'Test Singer', voiceType: 'baritone', range: null }],
        attempts: takes.map((t) => t.attempt),
        settings: { schemaVersion: 1, profiles: {} },
      };
      fs.writeFileSync(backupPath, JSON.stringify(backup));

      const r = run([file, backupPath]);
      expect(r.status).toBe(0);
      expect(r.out).toContain('PITCH LAB SONG READ: Test Hymn (test-hymn)');
      expect(r.out).toContain('TAKE 1 (newest) of 3');
      expect(r.out).toContain('Worst syllables');
      expect(r.out).toContain('Pitch graph, phrase 2');
      expect(r.out).toContain('THE HISTORY OF THIS SONG (3 takes in the backup');
      expect(r.out).toContain('ACROSS THE TAKES');
      expect(r.out).toMatch(/^[\x00-\x7F]*$/);

      const json = run([file, '--json', '--take', '2']);
      expect(json.status).toBe(0);
      const parsed = JSON.parse(json.out) as Array<{ source: string; takes: Array<{ index: number; verdict: { passed: boolean } }>; comparison: { rows: unknown[] } }>;
      expect(parsed[0].source).toBe('song-coaching');
      expect(parsed[0].takes.map((t) => t.index)).toEqual([2]);
      expect(parsed[0].comparison.rows).toHaveLength(3);

      const one = run([file, '--take=3']);
      expect(one.out).toContain('TAKE 3 of 3');
      expect(one.out).not.toContain('TAKE 1 (newest)');
      expect(one.out).toContain('Pitch graph, phrase 2');

      const phrase = run([file, '--phrase', '2', '--take', '1']);
      expect(phrase.status).toBe(0);
      expect(phrase.out).toContain('Pitch graph, phrase 2 "the stars are bright ly"');

      expect(run([file, '--phrase', 'x']).status).toBe(2);

      const newer = path.join(dir, 'newer.json');
      fs.writeFileSync(newer, JSON.stringify({ ...songFile(takes), version: 2 }));
      const bad = run([newer]);
      expect(bad.status).toBe(1);
      expect(bad.err).toContain('newer.json: made by a newer app (coaching file version 2)');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 180_000);

  it('lists a song file by its name too', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pitch-lab-coach-song-list-'));
    try {
      fs.writeFileSync(path.join(dir, 'pitch-lab-coach-song-amazing-grace-2026-10-22-1900.json'), '{}');
      fs.writeFileSync(path.join(dir, 'pitch-lab-song-twinkle-2026-10-22-1901.json'), '{}');
      fs.writeFileSync(path.join(dir, 'pitch-lab-coach-foundations-05-2026-10-22-1405.json'), '{}');
      const r = run(['--list', dir]);
      expect(r.status).toBe(0);
      expect(r.out).toMatch(/song +\d+ KB +.*pitch-lab-coach-song-amazing-grace/);
      expect(r.out).toMatch(/song +\d+ KB +.*pitch-lab-song-twinkle/);
      expect(r.out).toMatch(/coach +\d+ KB +.*pitch-lab-coach-foundations-05/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 90_000);
});

// ---------------------------------------------------------------- one backup, the songs it holds

describe('the songs a backup holds, from the numbers', () => {
  it('tallies each song: takes, passes, best, latest, whole-song and phrase takes, slowed takes', () => {
    const song = chart();
    const attempts = [
      attemptOf(singTake(song, { selection: null }), { minutes: 0 }),
      attemptOf(singTake(song, { selection: 1, speed: 0.75 }), { minutes: 5 }),
      attemptOf(singTake(song, { selection: 1, faults: { unsung: [STARS, BRIGHT, LY] } }), { minutes: 10 }),
    ];
    const profile: ProfileRecord = { id: 'p1', profileId: 'p1', createdAt: isoAt(-1000), updatedAt: isoAt(-1000), deletedAt: null, name: 'Test Singer', voiceType: 'baritone', range: null };
    const exercise: AttemptRecord = {
      id: 'ex-1', profileId: 'p1', createdAt: isoAt(-10), updatedAt: isoAt(-10), deletedAt: null, exerciseId: 'foundations.siren.1', levelId: 'foundations.05', kind: 'practice',
      score: 0.5, passed: false, mastery: 0, metrics: {}, durationSec: 21, tonicMidi: 48, tempoBpm: 60, takeId: null,
    };
    const file: BackupFile = { format: 'pitch-lab-backup', version: 1, exportedAt: isoAt(60), profiles: [profile], attempts: [exercise, ...attempts], settings: { schemaVersion: 1, profiles: {} } };
    const reports: Report[] = analyzeReports([readCoachInput(enc(file), 'pitch-lab-backup-2026-10-22.json')], { engine: undefined });
    const overview = reports.flatMap((r) => (r.source === 'backup' ? [r.overview] : []))[0];
    expect(overview?.songs).toHaveLength(1);
    expect(overview?.songs[0]).toMatchObject({ songId: 'test-hymn', attempts: 3, wholeTakes: 1, phraseTakes: 2, slowedTakes: 1 });

    // A take whose phrase was dropped as damaged cannot say what it covered: neither a whole-song take nor a phrase take
    // (only an explicit null is the whole song, as in the app's song/practice.ts).
    const { phrase: _dropped, ...damaged } = attemptOf(singTake(song, { selection: 1 }), { minutes: 15 });
    const withDamaged: BackupFile = { ...file, attempts: [...file.attempts, damaged] };
    const again = analyzeReports([readCoachInput(enc(withDamaged), 'pitch-lab-backup-2026-10-22.json')], { engine: undefined });
    const tally = again.flatMap((r) => (r.source === 'backup' ? [r.overview] : []))[0]?.songs[0];
    expect(tally).toMatchObject({ attempts: 4, wholeTakes: 1, phraseTakes: 2 });
    expect(overview?.songs[0].passes).toBe(2);
    expect(overview?.songs[0].best).toBeGreaterThan(0.9);
    expect(overview?.songs[0].last).toBeLessThan(0.7);
    const text = reports.map((r) => formatReport(r)).join('\n');
    expect(text).toContain('Songs, newest first (numbers only');
    expect(text).toMatch(/test-hymn +3 takes +2 passes +best +\d+% +last +\d+% +\(whole song 1, phrases 2, slowed 1\)/);
  });
});

// ---------------------------------------------------------------- a sample for the docs (only when asked for)

describe('samples', () => {
  it.runIf(proc.env.COACH_SAMPLE_DIR !== undefined)('writes a sample song file and backup into COACH_SAMPLE_DIR', () => {
    const out = proc.env.COACH_SAMPLE_DIR as string;
    fs.mkdirSync(out, { recursive: true });
    const song = chart();
    // oldest first: phrase 2 slowly with trouble, at speed, better, then the whole song
    const takes = [
      takeOf(singTake(song, { selection: 1, speed: 0.75, faults: { off: { [STARS]: -55, [BRIGHT]: -50 }, flip: { note: LY, semis: 5 }, seed: 1 } }), 0),
      takeOf(singTake(song, { selection: 1, speed: 0.75, faults: { off: { [STARS]: -40 }, seed: 2 } }), 4),
      takeOf(singTake(song, { selection: 1, faults: { off: { [STARS]: -45, [BRIGHT]: -30 }, late: 0.05, seed: 3 } }), 9),
      takeOf(singTake(song, { selection: null, faults: { off: { [STARS]: -35, [NIGHT]: -40 }, dropout: { note: NOW, sec: 0.4 }, seed: 4 } }), 15),
    ];
    fs.writeFileSync(path.join(out, 'pitch-lab-coach-song-test-hymn-2026-10-22-1900.json'), JSON.stringify(songFile(takes)));
    const backup: BackupFile = {
      format: 'pitch-lab-backup',
      version: 1,
      exportedAt: isoAt(120),
      profiles: [{ id: 'p1', profileId: 'p1', createdAt: isoAt(-1000), updatedAt: isoAt(-1000), deletedAt: null, name: 'Test Singer', voiceType: 'baritone', range: null }],
      attempts: takes.map((t) => t.attempt),
      settings: { schemaVersion: 1, profiles: {} },
    };
    fs.writeFileSync(path.join(out, 'pitch-lab-backup-songs-2026-10-22.json'), JSON.stringify(backup));
  });
});
