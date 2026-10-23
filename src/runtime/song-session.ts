/**
 * Song mode's take pipeline (SPEC §10, DESIGN.md §13.9; docs/ARCHITECTURE.md "Song mode scores pitchedView(song)").
 *
 * One session per Song player visit (createSongSession). It holds the singer's choices (key, speed, loop, the
 * selected phrase, guide, metronome, backing level and offset) and drives the audio on the AudioContext clock:
 *
 *  - the song is shifted only with transposeSong (default: suggestTransposition into the saved range, rangeFit
 *    says what still sits outside it) and scored as pitchedView(song): freestyle and rap notes out, phrases
 *    re-indexed;
 *  - the melody guide is the reference synth, scheduled note by note a second ahead (a lookahead scheduler, so a
 *    whole song never queues hundreds of voices at once);
 *  - the backing track (storage binary, then decodeAudioData) plays from backingTimeAt(song, t), so song time and
 *    the audio stay aligned at any offset; a slowed speed plays a WSOLA time-stretch of it (same pitch), computed
 *    once per speed in slices as soon as the speed is chosen, off the critical path;
 *  - a take is recorded with TakeRecorder (downbeat = the AudioContext time the window's first song second sounds,
 *    latency = the route's calibration) and scored ON THE SLOWED TIMELINE, where the singer really sang: the notes
 *    are stretched to the take's speed, scored, and the phrase scores are mapped back to song time. Then
 *    buildSongAttempt -> session.recordAttempt (a song attempt never passes a level) and the take is saved (pitch
 *    track on the take's own timeline, plus audio when the profile keeps it);
 *  - every attempt records what the take covered, so the log alone tells a song's progress (song/practice.ts): its
 *    phrases ([from, to) into pitchedView(song).phrases: the ones it finished, or null for the whole song sung through),
 *    its key (songShift) and its speed (songSpeed). Then the coach reads the take (coaching/song.ts coachSongTake) on
 *    the song's own clock, against the log it was written into, for the take sheet's coaching card.
 *
 * A selection is a stretch of Song.phrases ([from, to): one phrase, phrases joined, or null for the whole song), so a
 * learning-path step (pitched phrase indices) maps onto it with selectionOfPitched.
 *
 * Scoring needs the route's latency calibration: without one, sing() refuses and says so. listen(), play() and
 * sing() are called straight from click handlers: the AudioContext (and, for sing, the mic) start there, before
 * any await (the iOS gesture rule). Audio never leaves the device.
 */
import { batch, computed, signal, type ReadonlySignal } from '@preact/signals';
import { scoreSongPhrases } from '../analysis/phrases';
import { metricsFromResults } from '../analysis/score';
import type { AnalyzeContext, PhraseScore } from '../analysis/types';
import { getEngine } from '../audio/engine';
import type { AudioEngine, EngineError } from '../audio/engine-types';
import type { LatencyCalibration } from '../audio/latency-types';
import { musicalClickGain } from '../audio/synth';
import type { ReferenceSynth, ScheduledHandle } from '../audio/synth-types';
import { TakeRecorder, encodeTake, roundTripSeconds, toInputTime, type TakeAudio } from '../audio/take-recorder';
import { coachSongTake } from '../coaching/song';
import type { Coaching } from '../coaching/types';
import { CONFIG } from '../config';
import type { PitchFrame, PitchTrack, TargetNote } from '../core/types';
import { WsolaStretcher } from '../dsp/wsola';
import { effectiveRange } from '../exercises/transpose';
import { buildSongAttempt, songExerciseId, type AttemptFields } from '../progress/attempt';
import { getSynth } from '../state/audio';
import { activeProfile, appStorage, attemptLog, recordAttempt } from '../state/session';
import { TAKE_AUDIO_NOT_KEPT } from './messages';
import { deviceSettings, settings } from '../state/settings';
import type { Settings } from '../state/settings-types';
import { isPitchedNote, pitchedView, type PitchedView } from '../song/pitched';
import { SONG_PASS_SCORE, type PitchedSpan } from '../song/practice';
import { backingTimeAt, phraseIndexAt, songTimeAtBacking } from '../song/timing';
import { rangeFit, suggestTransposition, transposeSong, type RangeFit } from '../song/transpose';
import type { Song, SongNote } from '../song/types';
import { newId, type AppStorage } from '../storage';
import type { AttemptRecord, ProfileRecord, TakeRecord, VocalRange } from '../storage/schema';

// ---------------------------------------------------------------- knobs

/** The speeds a song plays and is sung at (SPEC §10 "slow down"; DESIGN.md §13.9: 50 / 75 / 100%). */
export type SongSpeed = 0.5 | 0.75 | 1;
export const SONG_SPEEDS: readonly SongSpeed[] = [0.5, 0.75, 1];

/** Song seconds a window starts before its first note: the lead-in the singer hears (and the backing plays). */
export const PHRASE_LEAD_SEC = 1;
/** Song seconds a window runs past its last note, so a held final note is heard and recorded to its end. */
export const PHRASE_TAIL_SEC = 0.5;
/** Count-in clicks before a take's first note (the first note falls on the next beat). */
export const COUNT_IN_BEATS = 3;
/**
 * A song take reads as passed at this duration-weighted phrase score (song/practice.ts, where a phrase counts as
 * learned at it too). It decides the attempt's `passed` and the result's verdict only: a song never passes a level.
 */
export { SONG_PASS_SCORE };
/** The key stepper's reach either way, semitones. */
export const MAX_TRANSPOSE = 12;
/** The backing-offset slider's reach either side of the chart's own offset, ms (DESIGN.md §13.8). */
export const OFFSET_RANGE_MS = 2000;

/** DESIGN.md §13.9: the banner and the refusal say the same thing. */
export const NO_CALIBRATION_MESSAGE = 'Run the timing check in Setup first, so your takes line up.';

/** Guide notes and backing passes are scheduled this far ahead of the AudioContext clock. */
const LOOKAHEAD_SEC = 1;
const TICK_MS = 100;
/** Lead before the first scheduled sound, so nothing is scheduled in the past. */
const START_LEAD_SEC = 0.12;
/** The recorder runs this long past the last compensated frame of the window (frames arrive a hop late). */
const STOP_MARGIN_SEC = 0.2;
/** Count-in beats are folded into this span of real seconds (a 60 bpm hymn at half speed would click every 2 s). */
const COUNT_IN_MIN_BEAT_SEC = 0.4;
const COUNT_IN_MAX_BEAT_SEC = 1;
/** The chart's grid tempo is folded by octaves into this bpm span for the metronome and the count-in. */
const METRONOME_MIN_BPM = 50;
const METRONOME_MAX_BPM = 160;
/** WSOLA windows stretched per slice before yielding to the UI. */
const STRETCH_SLICE_FRAMES = 800;
/** How long an engine already 'starting' (another tap) may take before the take gives up on it. */
const ENGINE_START_TIMEOUT_MS = 15_000;
const OFFSET_SAVE_DEBOUNCE_MS = 400;
const EPS = 1e-6;

// ---------------------------------------------------------------- types

/** Song.phrases indices [from, to): one phrase ({ from: i, to: i + 1 }), or phrases joined. */
export interface PhraseSpan {
  from: number;
  to: number;
}

/** What is selected to play and sing: a stretch of Song.phrases, or null for the whole song. */
export type SongSelection = PhraseSpan | null;

export type SongPhase =
  | 'idle'
  | 'listening' //  Listen: the selection once (melody guide, backing)
  | 'playing' //    Play: from the selection on (or the selected phrase in a loop)
  | 'starting' //   Sing tapped: the mic is starting
  | 'count-in'
  | 'singing'
  | 'scoring' //    judging, writing the attempt, saving the take
  | 'done' //       the result is ready (the sheet is open)
  | 'error';

/** A stretch of the song to play or sing, in song seconds. */
export interface SongWindow {
  /** Lead-in start and tail end. */
  start: number;
  end: number;
  /** When the first note starts (the count-in leads into it). */
  firstNote: number;
  /** [from, to) indices into Song.notes. */
  from: number;
  to: number;
}

/** What is sounding: the UI draws it (target bars, lyrics, progress) against the AudioContext clock. */
export interface SongTimeline {
  kind: 'listen' | 'play' | 'take';
  /** AudioContext time at which song time `window.start` sounds in the first pass (output side: add the route latency for the input timeline). */
  startAt: number;
  window: SongWindow;
  speed: SongSpeed;
  /** Seconds one pass lasts on the AudioContext clock. */
  passSec: number;
  /** A looped phrase: pass k starts `k * passSec` after `startAt`, back to back, until stopped. */
  repeat: boolean;
  /** The pitched notes of the window, song time (the target bars). */
  notes: readonly SongNote[];
}

/** A phrase of the song as the player lists it. */
export interface PhraseRow {
  /** Index into Song.phrases. */
  index: number;
  start: number;
  end: number;
  /** The phrase's lyrics (the syllables joined, verbatim), or '' when it has none. */
  text: string;
  /** Notes that start a syllable: [note index into Song.notes, its text]. */
  syllables: ReadonlyArray<{ note: number; text: string }>;
  /** Index into pitchedView(song).phrases; null for a spoken or rapped phrase (nothing to score). */
  pitchedIndex: number | null;
}

export interface SongPhraseResult {
  /** Index into Song.phrases. */
  phraseIndex: number;
  text: string;
  /** Scored on the slowed timeline, mapped back to song time (start, end and timingOffsetMs are song time). */
  score: PhraseScore;
}

export interface SongTakeResult {
  selection: SongSelection;
  speed: SongSpeed;
  shift: number;
  /** What the attempt recorded it covered: [from, to) into pitchedView(song).phrases, or null for the whole song. */
  phrase: PitchedSpan | null;
  phrases: SongPhraseResult[];
  /** song.phraseScore: 0..1, duration-weighted over the phrases. */
  score: number;
  /** song.inTolerancePct: 0..100. */
  inTolerancePct: number;
  passed: boolean;
  /** The attempt in the log; null when it could not be written (`attemptError` says why: the take is lost). */
  attempt: AttemptRecord | null;
  attemptError: string | null;
  /** The saved take (pitch track, plus audio when kept); null when not saved (`saveError` says why). */
  savedTake: TakeRecord | null;
  saveError: string | null;
  /** The take's audio, when the profile keeps it (Play take). */
  audio: TakeAudio | null;
  /** Phrases left out because the take was stopped before they ended. */
  unfinished: number;
  /** The coach's reading of the take (coaching/song.ts); null if it could not be made (the breakdown still shows). */
  coaching: Coaching | null;
}

export interface SongError {
  code: 'no-calibration' | 'nothing-to-score' | 'mic' | 'interrupted' | 'stopped-early' | 'internal';
  /** Plain language with the fix (DESIGN.md §6). */
  message: string;
}

export type BackingState =
  | { status: 'none' }
  | { status: 'loading' }
  | { status: 'ready'; durationSec: number }
  | { status: 'error'; message: string };

/** The audio engine slice a song session uses (inject a fake in tests). */
export type SongEngine = Pick<
  AudioEngine,
  'state' | 'error' | 'context' | 'output' | 'start' | 'resume' | 'reset' | 'stop' | 'onFrame' | 'onState' | 'startRecording' | 'stopRecording'
>;

export interface SongSessionDeps {
  engine: SongEngine;
  /** The reference synth on the engine's output (getSynth: it creates and resumes the AudioContext, so call it inside a gesture first). */
  synth(): ReferenceSynth;
  storage(): AppStorage | null;
  profile(): ProfileRecord | null;
  settings(): Settings;
  /** The calibration of the route in use now; null when there is none. May read signals (read inside computeds). */
  latency(): LatencyCalibration | null;
  /** session.recordAttempt: appends the attempt for the ACTIVE profile and recomputes progress. */
  recordAttempt(fields: AttemptFields): Promise<{ attempt: AttemptRecord }>;
  /** The active profile's attempt log (session.attemptLog), read after a take is written: the coach's history. */
  log(): readonly AttemptRecord[];
  /** Decodes a backing-track file (MP3 or WAV). */
  decodeAudio(bytes: ArrayBuffer): Promise<AudioBuffer>;
  /** A one-channel AudioBuffer holding `samples` (a stretched backing, a take's audio). */
  createBuffer(samples: Float32Array, sampleRate: number): AudioBuffer;
}

export interface SongSession {
  /** The song as stored (original key). */
  readonly original: Song;
  /** The storage.songs record id of an imported song; null for a bundled chart. */
  readonly recordId: string | null;
  /** The song as sung: transposed by `shift`, carrying the singer's backing offset. */
  readonly song: ReadonlySignal<Song>;
  /** pitchedView(song): what is scored. */
  readonly view: ReadonlySignal<PitchedView>;
  readonly phrases: readonly PhraseRow[];
  /** The shift that fits the singer's range (suggestTransposition): the stepper marks it "fits your range". */
  readonly suggestedShift: number;
  readonly shift: ReadonlySignal<number>;
  /** How the song at `shift` sits in the singer's range (the saved one, or the voice type's default). */
  readonly fit: ReadonlySignal<RangeFit>;
  readonly speed: ReadonlySignal<SongSpeed>;
  readonly loop: ReadonlySignal<boolean>;
  readonly selection: ReadonlySignal<SongSelection>;
  /**
   * The melody guide plays during takes (Listen and Play always play it). In headphones only: on a speaker the mic
   * would hear the synth sing every note in tune and score it as the singer (see `headphones`).
   */
  readonly guide: ReadonlySignal<boolean>;
  readonly metronome: ReadonlySignal<boolean>;
  /** 0..1 */
  readonly backingVolume: ReadonlySignal<number>;
  readonly offsetMs: ReadonlySignal<number>;
  readonly backing: ReadonlySignal<BackingState>;
  /** A slowed backing being prepared: its speed and 0..1 progress; null when none is. */
  readonly stretching: ReadonlySignal<{ speed: SongSpeed; progress: number } | null>;
  /** The route's round trip, ms; null without a calibration (no scoring). */
  readonly latencyMs: ReadonlySignal<number | null>;
  /** The calibrated route is headphones (wired or Bluetooth): the guide can sound during takes. */
  readonly headphones: ReadonlySignal<boolean>;
  readonly phase: ReadonlySignal<SongPhase>;
  readonly timeline: ReadonlySignal<SongTimeline | null>;
  /** Count-in beats still to come (3, 2, 1); null otherwise. */
  readonly countIn: ReadonlySignal<number | null>;
  readonly result: ReadonlySignal<SongTakeResult | null>;
  readonly error: ReadonlySignal<SongError | null>;
  /** The last score (0..1) of each phrase sung in this visit, by Song.phrases index. */
  readonly lastScores: ReadonlySignal<ReadonlyMap<number, number>>;
  readonly takePlaying: ReadonlySignal<boolean>;
  /** A problem that blocks nothing but deserves a line (an offset that could not be saved); null when none. */
  readonly notice: ReadonlySignal<string | null>;
  setShift(semis: number): void;
  setSpeed(speed: SongSpeed): void;
  setLoop(on: boolean): void;
  select(selection: SongSelection): void;
  setGuide(on: boolean): void;
  setMetronome(on: boolean): void;
  setBackingVolume(volume: number): void;
  /** Within OFFSET_RANGE_MS of the chart's offset; saved for an imported song. */
  setOffsetMs(ms: number): void;
  /** Play (or stop) the selection once. Call straight from the click handler. */
  listen(): void;
  /**
   * Play (or stop) `selection` once at `speed`, leaving the chosen phrase and speed as they are (the coaching card's
   * "Listen slowly"). Call straight from the click handler.
   */
  listenTo(selection: SongSelection, speed: SongSpeed): void;
  /** Play (or pause) from the selection on; with loop on, the selected phrase over and over. Call straight from the click handler. */
  play(): void;
  /** Record a take of the selection. Call straight from the click handler: the mic starts here. */
  sing(): void;
  /** Stop playback; cancel a count-in (nothing written); end a take now (the phrases already finished are judged). */
  stop(): void;
  /** Play (or stop) the last take's audio. */
  playTake(): void;
  /** Close the result. */
  dismissResult(): void;
  /** Leaving the screen: stop audio, discard an unfinished take (nothing written), turn the mic off. Idempotent. */
  dispose(): void;
}

// ---------------------------------------------------------------- pure helpers

/** The phrases as the player lists them: lyrics, syllables, and where each sits in the pitched view. */
export function phraseRows(song: Song): PhraseRow[] {
  let pitched = 0;
  return song.phrases.map((p, index) => {
    const syllables: Array<{ note: number; text: string }> = [];
    let scorable = false;
    for (let i = Math.max(0, p.from); i < Math.min(p.to, song.notes.length); i++) {
      const note = song.notes[i];
      if (isPitchedNote(note)) scorable = true;
      if (note.lyric !== '') syllables.push({ note: i, text: note.lyric });
    }
    return {
      index,
      start: p.start,
      end: p.end,
      text: syllables.map((s) => s.text).join('').trim(),
      syllables,
      pitchedIndex: scorable ? pitched++ : null,
    };
  });
}

/** The selection of one phrase (index into Song.phrases). */
export function onePhrase(index: number): PhraseSpan {
  return { from: index, to: index + 1 };
}

/** The same stretch of the song (null = the whole song). */
export function sameSelection(a: SongSelection, b: SongSelection): boolean {
  if (a === null || b === null) return a === b;
  return a.from === b.from && a.to === b.to;
}

/** A selection that fits a song of `phraseCount` phrases. */
export function isValidSelection(selection: SongSelection, phraseCount: number): boolean {
  if (selection === null) return true;
  const { from, to } = selection;
  return Number.isInteger(from) && Number.isInteger(to) && from >= 0 && to > from && to <= phraseCount;
}

/** The pitched phrases a selection scores (indices into pitchedView(song).phrases, in order): every one for the whole song. */
export function scoredPhrasesOf(rows: readonly PhraseRow[], selection: SongSelection): number[] {
  const out: number[] = [];
  for (const row of rows) {
    if (row.pitchedIndex === null) continue;
    if (selection === null || (row.index >= selection.from && row.index < selection.to)) out.push(row.pitchedIndex);
  }
  return out;
}

/**
 * The selection that sings pitched phrases [from, to) (a learning-path step, an attempt's `phrase`); null stays the
 * whole song, and undefined is a span this song does not have.
 */
export function selectionOfPitched(rows: readonly PhraseRow[], span: PitchedSpan | null): SongSelection | undefined {
  if (span === null) return null;
  const first = rows.find((r) => r.pitchedIndex === span.from);
  const last = rows.find((r) => r.pitchedIndex === span.to - 1);
  if (!first || !last || span.to <= span.from) return undefined;
  return { from: first.index, to: last.index + 1 };
}

/**
 * The window a selection plays and is sung over: from PHRASE_LEAD_SEC before its first note to PHRASE_TAIL_SEC
 * after its last one. Phrases cover their own notes, the whole song (null) every note; `toEnd` runs the selection on
 * to the end of the song (Play without loop). Null when the selection has no notes.
 */
export function selectionWindow(song: Song, selection: SongSelection, opts: { toEnd?: boolean } = {}): SongWindow | null {
  let from = 0;
  let to = song.notes.length;
  if (selection !== null) {
    const first = song.phrases[selection.from];
    const last = song.phrases[selection.to - 1];
    if (!first || !last || selection.to <= selection.from) return null;
    from = Math.max(0, first.from);
    to = opts.toEnd ? song.notes.length : Math.min(last.to, song.notes.length);
  }
  if (to <= from) return null;
  let first = Infinity;
  let last = -Infinity;
  for (let i = from; i < to; i++) {
    const n = song.notes[i];
    first = Math.min(first, n.start);
    last = Math.max(last, n.start + n.duration);
  }
  return { start: first - PHRASE_LEAD_SEC, end: last + PHRASE_TAIL_SEC, firstNote: first, from, to };
}

/** The next phrase after `index` with pitches to score (Next phrase skips spoken ones); null after the last one. */
export function nextScorablePhrase(rows: readonly PhraseRow[], index: number): number | null {
  for (let i = index + 1; i < rows.length; i++) if (rows[i].pitchedIndex !== null) return i;
  return null;
}

/** The pitched notes of a window (the guide melody and the target bars), song time. */
export function windowNotes(song: Song, window: SongWindow): SongNote[] {
  return song.notes.slice(window.from, window.to).filter(isPitchedNote);
}

/**
 * A take's pitch line (take time: 0 at the window start, real seconds at the take's speed) on the song's own clock:
 * song time = `originSongSec` + take time x `speed`. What the coach and the then-and-now drawing read.
 */
export function toSongClock(track: PitchTrack, originSongSec: number, speed: number): PitchFrame[] {
  return track.map((f) => ({ ...f, t: originSongSec + f.t * speed }));
}

/**
 * Notes on a take's timeline: take time 0 is song time `originSongSec`, and at `speed` every song second lasts
 * 1 / speed real seconds. Pitch is untouched. For the target bars (PitchView.setTargets) and the scorer.
 */
export function toTakeTime(notes: readonly SongNote[], originSongSec: number, speed: number): TargetNote[] {
  return notes.map((n) => ({
    midi: n.midi,
    start: (n.start - originSongSec) / speed,
    end: (n.start + n.duration - originSongSec) / speed,
    lyric: n.lyric,
  }));
}

/**
 * The song time sounding at AudioContext time `ctxTime` on a timeline, `latencySec` after it was scheduled (0 for
 * the output side; the route's round trip for the input timeline). Null before the first pass starts and after the
 * last one ends.
 */
export function songTimeAt(timeline: Pick<SongTimeline, 'startAt' | 'window' | 'speed' | 'passSec' | 'repeat'>, ctxTime: number, latencySec = 0): number | null {
  let elapsed = ctxTime - timeline.startAt - latencySec;
  if (elapsed < 0) return null;
  if (timeline.repeat && timeline.passSec > 0) elapsed %= timeline.passSec;
  else if (elapsed > timeline.passSec) return null;
  return timeline.window.start + elapsed * timeline.speed;
}

/** The chart's grid tempo folded by octaves into a singable click (Song.bpm is the chart's grid, not a marking). */
export function metronomeBpm(song: Pick<Song, 'bpm'>): number {
  let bpm = song.bpm !== undefined && Number.isFinite(song.bpm) && song.bpm > 0 ? song.bpm : 120;
  while (bpm >= METRONOME_MAX_BPM) bpm /= 2;
  while (bpm < METRONOME_MIN_BPM) bpm *= 2;
  return bpm;
}

/** Real seconds between count-in clicks at `speed`: the chart's beat, folded into a comfortable span. */
export function countInBeatSec(song: Pick<Song, 'bpm'>, speed: number): number {
  let beat = 60 / metronomeBpm(song) / speed;
  while (beat > COUNT_IN_MAX_BEAT_SEC) beat /= 2;
  while (beat < COUNT_IN_MIN_BEAT_SEC) beat *= 2;
  return beat;
}

/**
 * Where a pass of the backing track plays: its pass starts at AudioContext time `startAt` with song time
 * `fromSongSec`, at `speed`, for `passSec` real seconds, from a buffer `bufferSec` long that is the backing
 * stretched to `speed` (backing position b sits at b / speed in it). When the backing starts after the window
 * (b < 0) the source starts that much later; null when nothing of the backing falls in the pass.
 */
export function backingSchedule(
  song: Song,
  fromSongSec: number,
  speed: number,
  startAt: number,
  passSec: number,
  bufferSec: number,
): { when: number; offset: number; duration: number } | null {
  // The backing's first sample sounds at this song time (song/timing.ts owns the sign of the offset).
  const audioStart = songTimeAtBacking(song, 0);
  const wait = Math.max(0, (audioStart - fromSongSec) / speed); // real seconds of the pass before the audio begins
  const offset = wait > 0 ? 0 : backingTimeAt(song, fromSongSec) / speed;
  const duration = Math.min(passSec - wait, bufferSec - offset);
  return duration > EPS ? { when: startAt + wait, offset, duration } : null;
}

export interface SegmentScoring {
  /** pitchedView of the song as sung (transposed). */
  view: PitchedView;
  /** Indices into view.phrases to score, in song order. */
  phrases: readonly number[];
  /** Song time at take time 0 (the window start). */
  originSongSec: number;
  speed: number;
  ctx: AnalyzeContext;
}

/**
 * Scores one take on the slowed timeline and maps the phrase scores back to song time. `track` is take-relative
 * and latency-compensated (TakeRecorder: t = 0 is the moment the window start was heard), so it goes to
 * scoreSongPhrases, the latency-free half of scoreSongTake: compensating again would shift every note by the round
 * trip. The notes are stretched to the take's speed first, because that is where the singer sang them: onset
 * allowances, the DTW corridor and vibrato rates are real-time quantities. Each result keeps the index into
 * view.phrases in `phraseIndex`; start, end and timingOffsetMs come back in song time.
 */
export function scoreSongSegment(track: PitchTrack, input: SegmentScoring): PhraseScore[] {
  const { view, originSongSec: s0, speed: r } = input;
  const notes: SongNote[] = view.notes.map((n) => ({ ...n, start: (n.start - s0) / r, duration: n.duration / r }));
  const phrases = input.phrases.map((i) => {
    const p = view.phrases[i];
    return { ...p, start: (p.start - s0) / r, end: (p.end - s0) / r };
  });
  return scoreSongPhrases(track, notes, phrases, input.ctx).map((s, k) => ({
    ...s,
    phraseIndex: input.phrases[k],
    start: s0 + s.start * r,
    end: s0 + s.end * r,
    timingOffsetMs: s.timingOffsetMs === null ? null : s.timingOffsetMs * r,
  }));
}

/** Plain words for an engine that would not start or stopped (DESIGN.md §6: the cause and the fix). */
function micMessage(error: EngineError | null): string {
  switch (error?.code) {
    case 'permission-denied':
      return 'Microphone blocked. In Settings › Safari › Microphone choose Allow (in Chrome: the site settings), then tap Sing again.';
    case 'no-microphone':
      return 'No microphone was found. Connect one, then tap Sing again.';
    case 'mic-in-use':
      return 'Another app is using the microphone. Close it, then tap Sing again.';
    case 'insecure-context':
    case 'no-mediadevices':
    case 'worklet-unsupported':
      return "This browser can't record here. Open Pitch Lab in Safari on iPhone or Chrome on a computer.";
    case 'route-changed':
      return 'Your audio route changed. Tap Sing again (and recalibrate latency if you switched headphones).';
    case 'session-interrupted':
    case 'mic-ended':
      return 'The microphone stopped (a call, Siri or the lock screen). Tap Sing again.';
    default:
      return 'The microphone could not start. Tap Sing to try again.';
  }
}

/** Wired or Bluetooth headphones: what plays cannot reach the mic. A speaker or an undeclared route can. */
export function isHeadphoneRoute(calibration: Pick<LatencyCalibration, 'route'> | null): boolean {
  return calibration?.route === 'wired' || calibration?.route === 'bluetooth';
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function clampNumber(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/** The singer's range as song/transpose.ts reads it: the saved one, else the voice type's default. */
function singerRange(profile: ProfileRecord | null): VocalRange {
  const r = effectiveRange(profile?.range ?? null, profile?.voiceType ?? 'unknown');
  return { comfortable: r.comfortable, extended: r.extended, measuredAt: profile?.range?.measuredAt ?? '' };
}

// ---------------------------------------------------------------- the app's wiring

function defaultDeps(): SongSessionDeps {
  const engine = getEngine();
  return {
    engine,
    synth: getSynth,
    storage: () => appStorage.value,
    profile: () => activeProfile.value,
    settings: () => settings.value,
    latency: () => {
      const d = deviceSettings.value;
      return d.latency[d.route] ?? null;
    },
    recordAttempt,
    log: () => attemptLog.value,
    // Decoding needs no gesture: before the first tap there is no AudioContext, so an offline one decodes (at the
    // usual phone rate; playback resamples if the real context differs).
    decodeAudio: (bytes) => (engine.context ?? new OfflineAudioContext(1, 1, 48_000)).decodeAudioData(bytes),
    createBuffer: (samples, sampleRate) => {
      const buffer = new AudioBuffer({ length: Math.max(1, samples.length), numberOfChannels: 1, sampleRate });
      buffer.getChannelData(0).set(samples);
      return buffer;
    },
  };
}

// ---------------------------------------------------------------- the session

interface PassEvent {
  /** Real seconds from the pass start. */
  at: number;
  kind: 'note' | 'click';
  midi: number;
  duration: number;
}

interface Playback {
  timeline: SongTimeline;
  timer: ReturnType<typeof setTimeout> | null;
  voices: ScheduledHandle[];
  sources: AudioBufferSourceNode[];
  gain: GainNode | null;
}

interface ActiveTake {
  token: number;
  recorder: TakeRecorder;
  window: SongWindow;
  speed: SongSpeed;
  shift: number;
  selection: SongSelection;
  /** Indices into view.phrases. */
  phrases: number[];
  /** AudioContext time the window start sounds (the recorder's downbeat). */
  startAt: number;
  passSec: number;
  /** The round trip the recorder compensates, seconds. */
  roundTripSec: number;
  timers: Array<ReturnType<typeof setTimeout>>;
  unwatch: () => void;
}

/**
 * The session for one Song player visit. `recordId` is the storage.songs record of an imported song (its offset is
 * saved there); `deps` replaces the app's engine, synth, storage and session (tests).
 */
export function createSongSession(original: Song, opts: { recordId?: string | null; deps?: SongSessionDeps } = {}): SongSession {
  const deps = opts.deps ?? defaultDeps();
  const engine = deps.engine;
  const recordId = opts.recordId ?? null;
  const rows = phraseRows(original);
  /** view.phrases index -> Song.phrases index. */
  const originalOfPitched: number[] = [];
  for (const row of rows) if (row.pitchedIndex !== null) originalOfPitched[row.pitchedIndex] = row.index;

  const range = singerRange(deps.profile());
  const suggestedShift = clampNumber(suggestTransposition(original, range), -MAX_TRANSPOSE, MAX_TRANSPOSE);
  const fileOffsetMs = original.offsetMs;

  const shift = signal(suggestedShift);
  const speed = signal<SongSpeed>(1);
  const loop = signal(false);
  const selection = signal<SongSelection>(original.phrases.length > 0 ? onePhrase(0) : null);
  const guide = signal(true);
  const metronome = signal(false);
  const backingVolume = signal(0.8);
  const offsetMs = signal(original.offsetMs);
  const backing = signal<BackingState>({ status: original.backingRef ? 'loading' : 'none' });
  const stretching = signal<{ speed: SongSpeed; progress: number } | null>(null);
  const phase = signal<SongPhase>('idle');
  const timeline = signal<SongTimeline | null>(null);
  const countIn = signal<number | null>(null);
  const result = signal<SongTakeResult | null>(null);
  const error = signal<SongError | null>(null);
  const lastScores = signal<ReadonlyMap<number, number>>(new Map());
  const takePlaying = signal(false);
  const notice = signal<string | null>(null);

  const song = computed<Song>(() => ({ ...transposeSong(original, shift.value), offsetMs: offsetMs.value }));
  const view = computed(() => pitchedView(song.value));
  const fit = computed(() => rangeFit(original, range, shift.value));
  const latencyMs = computed(() => deps.latency()?.roundTripMs ?? null);
  const headphones = computed(() => isHeadphoneRoute(deps.latency()));

  let disposed = false;
  let playback: Playback | null = null;
  let take: ActiveTake | null = null;
  /** Bumped by every new take and every cancel, so a superseded take's async steps stop where they are. */
  let takeToken = 0;
  /** The same for Listen and Play, whose backing may still be decoding or stretching when they are stopped. */
  let listenToken = 0;
  /** The phrase Play started from (0 for the whole song): pausing never selects one before it. */
  let playFrom = 0;
  let micStartedHere = false;
  /** Whether the mic was already on when the player opened (dispose leaves such a mic alone). */
  const micWasOn = engine.state !== 'idle' && engine.state !== 'error';
  const stretched = new Map<SongSpeed, Promise<AudioBuffer | null>>();
  let takeSource: AudioBufferSourceNode | null = null;
  let offsetTimer: ReturnType<typeof setTimeout> | null = null;

  const busyTaking = (): boolean => {
    const p = phase.value;
    return p === 'starting' || p === 'count-in' || p === 'singing' || p === 'scoring';
  };

  const fail = (code: SongError['code'], message: string): void => {
    batch(() => {
      error.value = { code, message };
      phase.value = 'error';
      countIn.value = null;
      timeline.value = null;
    });
  };

  // ---------------------------------------------------------------- backing track

  const backingReady: Promise<AudioBuffer | null> = (async () => {
    const ref = original.backingRef;
    const storage = deps.storage();
    if (!ref) return null;
    try {
      if (!storage) throw new Error('storage is not open');
      const blob = await storage.opfs.read(ref);
      if (!blob) throw new Error('the file is missing from this device. Import the song again with its backing track');
      const buffer = await deps.decodeAudio(await blob.arrayBuffer());
      if (!disposed) backing.value = { status: 'ready', durationSec: buffer.duration };
      return buffer;
    } catch (err) {
      if (!disposed) backing.value = { status: 'error', message: `The backing track can't be played: ${messageOf(err)}.` };
      return null;
    }
  })();

  /** The backing at a speed: the decoded track, or its WSOLA stretch (computed once per speed, in slices). */
  function backingAt(s: SongSpeed): Promise<AudioBuffer | null> {
    if (s === 1) return backingReady;
    let pending = stretched.get(s);
    if (!pending) {
      pending = backingReady.then((buffer) => (buffer ? stretchBacking(buffer, s) : null));
      stretched.set(s, pending);
    }
    return pending;
  }

  async function stretchBacking(buffer: AudioBuffer, s: SongSpeed): Promise<AudioBuffer | null> {
    // One channel (a stereo pair stretched apart would drift out of phase): the mixdown.
    const mono = new Float32Array(buffer.length);
    for (let c = 0; c < buffer.numberOfChannels; c++) {
      const data = buffer.getChannelData(c);
      for (let i = 0; i < mono.length; i++) mono[i] += data[i] / buffer.numberOfChannels;
    }
    const stretcher = new WsolaStretcher(mono, buffer.sampleRate, s);
    stretching.value = { speed: s, progress: 0 };
    try {
      while (!stretcher.process(STRETCH_SLICE_FRAMES)) {
        if (disposed) return null;
        stretching.value = { speed: s, progress: stretcher.progress };
        await new Promise<void>((resolve) => setTimeout(resolve, 0)); // let the UI breathe between slices
      }
      return deps.createBuffer(stretcher.output, buffer.sampleRate);
    } catch (err) {
      // The track still plays at full speed; slowed down, the melody guide carries on alone.
      if (!disposed) notice.value = `The backing track can't be slowed down (${messageOf(err)}), so slowed playback is the melody alone.`;
      return null;
    } finally {
      if (stretching.value?.speed === s) stretching.value = null;
    }
  }

  // ---------------------------------------------------------------- playback (guide, backing, clicks)

  function passEvents(w: SongWindow, s: SongSpeed, withGuide: boolean, withClicks: boolean): PassEvent[] {
    const events: PassEvent[] = [];
    if (withGuide) {
      for (const n of windowNotes(song.value, w)) events.push({ at: (n.start - w.start) / s, kind: 'note', midi: n.midi, duration: n.duration / s });
    }
    if (withClicks) {
      const beat = 60 / metronomeBpm(original);
      for (let k = Math.ceil(w.start / beat - EPS); k * beat < w.end - EPS; k++) events.push({ at: (k * beat - w.start) / s, kind: 'click', midi: 0, duration: 0 });
    }
    return events.sort((a, b) => a.at - b.at);
  }

  function stopPlayback(): void {
    const pb = playback;
    if (!pb) return;
    playback = null;
    if (pb.timer !== null) clearTimeout(pb.timer);
    for (const v of pb.voices) v.stop();
    for (const src of pb.sources) {
      try {
        src.stop();
      } catch {
        // never started
      }
      src.disconnect();
    }
    pb.gain?.disconnect();
    try {
      deps.synth().stopAll(); // clicks already handed to the synth cannot be cancelled one by one
    } catch {
      // no AudioContext: nothing was scheduled
    }
  }

  /**
   * Schedule a window on the AudioContext clock: guide notes and clicks LOOKAHEAD_SEC ahead, one backing source per
   * pass. `onEnd` runs once a pass that does not repeat has sounded.
   */
  function startPlayback(tl: SongTimeline, synth: ReferenceSynth, events: readonly PassEvent[], backingBuffer: AudioBuffer | null, onEnd: () => void): void {
    stopPlayback();
    const ctx = engine.context;
    if (!ctx) return;
    const pb: Playback = { timeline: tl, timer: null, voices: [], sources: [], gain: null };
    playback = pb;
    timeline.value = tl;
    const output = engine.output;
    if (backingBuffer && output) {
      pb.gain = ctx.createGain();
      pb.gain.gain.value = backingVolume.value;
      pb.gain.connect(output);
    }
    const prefs = deps.settings();
    let schedPass = 0;
    let schedIndex = 0;
    let backedPass = -1;

    const tick = (): void => {
      if (playback !== pb) return;
      const now = ctx.currentTime;
      const horizon = now + LOOKAHEAD_SEC;
      pb.voices = pb.voices.filter((v) => v.endAt > now);
      for (;;) {
        const passStart = tl.startAt + schedPass * tl.passSec;
        if (passStart > horizon) break;
        if (backedPass < schedPass && backingBuffer && pb.gain) {
          backedPass = schedPass;
          const slot = backingSchedule(song.value, tl.window.start, tl.speed, passStart, tl.passSec, backingBuffer.duration);
          const late = slot ? Math.max(0, now - slot.when) : 0; // a stalled tab: join the backing where it should be by now
          if (slot && slot.duration - late > EPS) {
            const src = ctx.createBufferSource();
            src.buffer = backingBuffer;
            src.connect(pb.gain);
            src.start(slot.when + late, slot.offset + late, slot.duration - late);
            pb.sources.push(src);
          }
        }
        while (schedIndex < events.length && passStart + events[schedIndex].at <= horizon) {
          const e = events[schedIndex++];
          const at = passStart + e.at;
          if (at < now) continue; // a stalled tab: never schedule into the past
          if (e.kind === 'click') synth.click(at, false, musicalClickGain(prefs.referenceVolume));
          else pb.voices.push(synth.playNote({ midi: e.midi, startAt: at, duration: e.duration, gain: prefs.referenceVolume, timbre: prefs.referenceTimbre }));
        }
        if (schedIndex < events.length || !tl.repeat) break;
        schedPass++;
        schedIndex = 0;
      }
      if (!tl.repeat && now >= tl.startAt + tl.passSec) {
        onEnd();
        return;
      }
      pb.timer = setTimeout(tick, TICK_MS);
    };
    tick();
  }

  // ---------------------------------------------------------------- listen / play

  /** Listen or Play the selection, or (`only`, Listen) another stretch at another speed, leaving the choices alone. */
  function startListening(kind: 'listen' | 'play', only?: { selection: SongSelection; speed: SongSpeed }): void {
    if (disposed || busyTaking()) return;
    stopTakePlayback();
    const current = phase.value;
    if ((kind === 'listen' && current === 'listening') || (kind === 'play' && current === 'playing')) {
      stop();
      return;
    }
    let synth: ReferenceSynth;
    try {
      synth = deps.synth(); // creates and resumes the AudioContext inside the gesture
    } catch (err) {
      fail('internal', `Audio could not start (${messageOf(err)}). Tap Reset audio under More, then try again.`);
      return;
    }
    stopPlayback();
    const sel = only ? only.selection : selection.value;
    const repeat = kind === 'play' && loop.value;
    const w = isValidSelection(sel, rows.length) ? selectionWindow(song.value, sel, { toEnd: kind === 'play' && !repeat }) : null;
    if (!w) return;
    const s = only ? only.speed : speed.value;
    playFrom = sel?.from ?? 0;
    batch(() => {
      error.value = null;
      phase.value = kind === 'listen' ? 'listening' : 'playing';
    });
    const token = ++listenToken;
    void backingAt(s).then((buffer) => {
      const ctx = engine.context;
      if (disposed || listenToken !== token || !ctx) return;
      const passSec = (w.end - w.start) / s;
      const tl: SongTimeline = { kind, startAt: ctx.currentTime + START_LEAD_SEC, window: w, speed: s, passSec, repeat, notes: windowNotes(song.value, w) };
      startPlayback(tl, synth, passEvents(w, s, true, metronome.value), buffer, () => {
        stopPlayback();
        batch(() => {
          phase.value = 'idle';
          timeline.value = null;
        });
      });
    });
  }

  /** The phrase sounding now during Play, so a pause leaves it selected (Sing then sings it). */
  function phrasePlayingNow(): number | null {
    const tl = timeline.value;
    const ctx = engine.context;
    if (!tl || tl.repeat || !ctx) return null; // a loop plays the selected phrase: it stays selected
    const t = songTimeAt(tl, ctx.currentTime);
    const index = t === null ? -1 : phraseIndexAt(song.value, t);
    // Never back into the phrase before the one Play started from (its tail sounds during the lead-in).
    return index < 0 ? null : Math.max(index, playFrom);
  }

  // ---------------------------------------------------------------- takes

  function startMic(): Promise<void> {
    if (engine.state === 'running') return Promise.resolve();
    if (engine.state === 'interrupted' || engine.state === 'suspended') {
      return engine.error?.code === 'route-changed' ? engine.reset() : engine.resume();
    }
    if (engine.state === 'starting') return Promise.resolve();
    micStartedHere = true;
    return engine.start();
  }

  /** Resolves once the engine has left 'starting' (another tap may have started it), or after a timeout. */
  function settled(): Promise<void> {
    if (engine.state !== 'starting') return Promise.resolve();
    return new Promise<void>((resolve) => {
      const timer = setTimeout(done, ENGINE_START_TIMEOUT_MS);
      const unsubscribe = engine.onState((state) => {
        if (state !== 'starting') done();
      });
      function done(): void {
        clearTimeout(timer);
        unsubscribe();
        resolve();
      }
    });
  }

  function cancelTake(): void {
    const t = take;
    takeToken++;
    if (!t) return;
    take = null;
    for (const timer of t.timers) clearTimeout(timer);
    t.unwatch();
    t.recorder.cancel();
    stopPlayback();
  }

  function sing(): void {
    if (disposed) return;
    if (busyTaking()) return;
    const calibration = deps.latency();
    if (!calibration) {
      fail('no-calibration', NO_CALIBRATION_MESSAGE);
      return;
    }
    const sel = selection.value;
    const phrases = scoredPhrasesOf(rows, sel);
    const w = selectionWindow(song.value, sel);
    if (phrases.length === 0 || !w) {
      fail('nothing-to-score', 'This phrase has no sung pitches to score (it is spoken or rapped). Pick another phrase.');
      return;
    }
    listenToken++;
    stopPlayback();
    stopTakePlayback(); // the last take must not sound into this one
    // The gesture-sensitive prefix: the mic and the AudioContext start here, before any await (iOS).
    const ready = startMic();
    const token = ++takeToken;
    batch(() => {
      error.value = null;
      result.value = null;
      phase.value = 'starting';
    });
    void runTake(token, ready, calibration, sel, phrases, w).catch((err: unknown) => {
      if (token !== takeToken) return;
      cancelTake();
      fail('internal', `Something went wrong with this take (${messageOf(err)}). Nothing was saved. Tap Sing to try again.`);
    });
  }

  async function runTake(token: number, ready: Promise<void>, calibration: LatencyCalibration, sel: SongSelection, phrases: number[], w: SongWindow): Promise<void> {
    await ready;
    await settled();
    if (disposed || token !== takeToken) return;
    const ctx = engine.context;
    if (engine.state !== 'running' || !ctx) {
      fail('mic', micMessage(engine.error));
      return;
    }
    const s = speed.value;
    const backingBuffer = await backingAt(s);
    if (disposed || token !== takeToken) return;
    if (engine.state !== 'running') {
      fail('mic', micMessage(engine.error));
      return;
    }

    const synth = deps.synth();
    const prefs = deps.settings();
    const beat = countInBeatSec(original, s);
    const lead = (w.firstNote - w.start) / s;
    const startAt = ctx.currentTime + START_LEAD_SEC + Math.max(0, COUNT_IN_BEATS * beat - lead);
    const firstNoteAt = startAt + lead;
    const passSec = (w.end - w.start) / s;
    const roundTripSec = roundTripSeconds(calibration); // exactly what the recorder compensates

    const recorder = new TakeRecorder(engine, {
      downbeat: startAt,
      latency: calibration,
      recordAudio: prefs.keepTakeAudio,
      window: { endSec: passSec },
    });
    recorder.start();

    const timers: Array<ReturnType<typeof setTimeout>> = [];
    const at = (ctxTime: number, fn: () => void): void => {
      timers.push(setTimeout(fn, Math.max(0, (ctxTime - ctx.currentTime) * 1000)));
    };
    const unwatch = engine.onState((state) => {
      if (state !== 'running' && take?.token === token && phase.value !== 'scoring') {
        cancelTake();
        fail('interrupted', 'The take was interrupted (a call, Siri or a route change). Nothing was saved. Tap Sing to try again.');
      }
    });
    take = { token, recorder, window: w, speed: s, shift: shift.value, selection: sel, phrases, startAt, passSec, roundTripSec, timers, unwatch };

    const tl: SongTimeline = { kind: 'take', startAt, window: w, speed: s, passSec, repeat: false, notes: windowNotes(song.value, w) };
    // The guide sings every note in tune: on a speaker the mic would score it as the singer, so it plays in headphones only.
    startPlayback(tl, synth, passEvents(w, s, guide.value && isHeadphoneRoute(calibration), metronome.value), backingBuffer, () => stopPlayback());
    for (let k = COUNT_IN_BEATS; k >= 1; k--) synth.click(firstNoteAt - k * beat, k === COUNT_IN_BEATS, musicalClickGain(prefs.referenceVolume));
    batch(() => {
      phase.value = 'count-in';
      countIn.value = COUNT_IN_BEATS;
    });
    for (let k = COUNT_IN_BEATS - 1; k >= 1; k--) {
      const beatsLeft = k;
      at(firstNoteAt - k * beat, () => {
        if (take?.token === token) countIn.value = beatsLeft;
      });
    }
    at(firstNoteAt, () => {
      if (take?.token !== token) return;
      batch(() => {
        countIn.value = null;
        phase.value = 'singing';
      });
    });
    at(toInputTime(passSec, startAt, roundTripSec) + STOP_MARGIN_SEC, () => void finishTake(token, false));
  }

  async function finishTake(token: number, stoppedEarly: boolean): Promise<void> {
    const t = take;
    if (!t || t.token !== token) return;
    const ctx = engine.context;
    // Take time (input side) reached when stopped by hand: only the phrases that had ended are judged.
    const reached = stoppedEarly && ctx ? ctx.currentTime - t.startAt - t.roundTripSec : Infinity;
    take = null;
    for (const timer of t.timers) clearTimeout(timer);
    t.unwatch();
    stopPlayback();
    batch(() => {
      phase.value = 'scoring';
      countIn.value = null;
    });

    const recorded = await t.recorder.stop();
    const v = view.value;
    const finished = t.phrases.filter((i) => (v.phrases[i].end - t.window.start) / t.speed <= reached);
    if (finished.length === 0) {
      fail('stopped-early', 'Stopped before the first phrase ended, so nothing was scored or saved.');
      return;
    }

    const prefs = deps.settings();
    const scores = scoreSongSegment(recorded.track, {
      view: v,
      phrases: finished,
      originSongSec: t.window.start,
      speed: t.speed,
      ctx: { toleranceCents: CONFIG.tolerance.default, vibratoStyle: prefs.vibratoStyle },
    });
    const metrics = metricsFromResults({ phrases: scores });
    const score = metrics['song.phraseScore'] ?? 0;
    const passed = score >= SONG_PASS_SCORE;
    const sungSec = Math.min(t.passSec, reached);
    // What the take covered: the whole song sung through, or exactly the phrases it finished (a whole-song take stopped
    // after two phrases is a take of those two: its score is theirs).
    const covered: PitchedSpan | null =
      t.selection === null && finished.length === t.phrases.length ? null : { from: finished[0], to: finished[finished.length - 1] + 1 };

    let attempt: AttemptRecord | null = null;
    let attemptError: string | null = null;
    let savedTake: TakeRecord | null = null;
    let saveError: string | null = null;
    const profile = deps.profile();
    const storage = deps.storage();
    const takeId = newId();
    const fields: AttemptFields = buildSongAttempt({
      profileId: profile?.id ?? '',
      songId: original.id,
      score,
      passed,
      metrics,
      durationSec: sungSec,
      tonicMidi: v.notes.length > 0 ? v.notes[0].midi : null,
      takeId,
      phrase: covered,
      songShift: t.shift,
      songSpeed: t.speed,
    });
    if (!profile) {
      attemptError = 'No singer profile is active, so this take was not saved.';
    } else {
      try {
        ({ attempt } = await deps.recordAttempt(fields));
      } catch (err) {
        attemptError = `This take could not be saved (${messageOf(err)}). Your score is shown here only.`;
      }
    }
    if (attempt && profile) {
      try {
        if (!storage) throw new Error('storage is not open');
        savedTake = await storage.takes.save({ id: takeId, profileId: profile.id, exerciseId: songExerciseId(original.id), ...encodeTake(recorded) });
        // The store keeps the take but drops its sound when the audio will not write (no space left to free): say so.
        if (recorded.audio && savedTake.audioRef === null) saveError = TAKE_AUDIO_NOT_KEPT;
      } catch (err) {
        saveError = `The take's recording was not kept (${messageOf(err)}). The score is saved.`;
      }
    }

    // The coaching: this take, on the song's own clock, against the log it was written into (a take that could not be
    // written is coached as it stands, against the log before it). It never holds up or blanks the result.
    let coaching: Coaching | null = null;
    try {
      const coached: AttemptRecord = attempt ?? { ...fields, id: `unsaved-${takeId}`, createdAt: new Date().toISOString(), updatedAt: '', deletedAt: null };
      coaching = coachSongTake(
        {
          song: { ...song.value, notes: v.notes, phrases: v.phrases },
          phrase: covered,
          shift: t.shift,
          speed: t.speed,
          track: toSongClock(recorded.track, t.window.start, t.speed),
          scores,
          attempt: coached,
        },
        deps.log(),
        { notation: prefs.notation, now: Date.now() },
      );
    } catch {
      coaching = null;
    }

    const phraseResults: SongPhraseResult[] = scores.map((ps) => {
      const index = originalOfPitched[ps.phraseIndex];
      return { phraseIndex: index, text: rows[index].text, score: { ...ps, phraseIndex: index } };
    });
    const outcome: SongTakeResult = {
      selection: t.selection,
      speed: t.speed,
      shift: t.shift,
      phrase: covered,
      phrases: phraseResults,
      score,
      inTolerancePct: metrics['song.inTolerancePct'] ?? 0,
      passed,
      attempt,
      attemptError,
      savedTake,
      saveError,
      audio: recorded.audio,
      unfinished: t.phrases.length - finished.length,
      coaching,
    };
    if (disposed) return;
    const scoresByPhrase = new Map(lastScores.value);
    for (const r of phraseResults) scoresByPhrase.set(r.phraseIndex, r.score.pitchScore);
    batch(() => {
      lastScores.value = scoresByPhrase;
      result.value = outcome;
      timeline.value = null;
      phase.value = 'done';
    });
  }

  // ---------------------------------------------------------------- controls

  function stop(): void {
    const p = phase.value;
    if (p === 'listening' || p === 'playing') {
      const playing = p === 'playing' ? phrasePlayingNow() : null;
      listenToken++;
      stopPlayback();
      batch(() => {
        if (playing !== null) selection.value = onePhrase(playing);
        phase.value = 'idle';
        timeline.value = null;
      });
    } else if (p === 'starting' || p === 'count-in') {
      cancelTake();
      batch(() => {
        phase.value = 'idle';
        countIn.value = null;
        timeline.value = null;
      });
    } else if (p === 'singing' && take) {
      void finishTake(take.token, true);
    }
  }

  /**
   * Stop the last take's playback ('Play take'), at once and synchronously (it runs inside a gesture, before the mic
   * opens). Called before anything else sounds or records: on the speaker the mic would otherwise record the old take
   * into the new one, and in headphones it would play over the guide.
   */
  function stopTakePlayback(): void {
    const src = takeSource;
    if (!src) return;
    takeSource = null;
    src.onended = null;
    try {
      src.stop();
    } catch {
      // already stopped
    }
    src.disconnect();
    takePlaying.value = false;
  }

  /** A change of key, speed, loop or phrase: whatever plays was set up for the old one. */
  function settle(): boolean {
    if (disposed || busyTaking()) return false;
    stopTakePlayback();
    if (phase.value === 'listening' || phase.value === 'playing') stop();
    if (phase.value === 'error') {
      batch(() => {
        error.value = null;
        phase.value = 'idle';
      });
    }
    return true;
  }

  function playTake(): void {
    if (takeSource) {
      stopTakePlayback();
      return;
    }
    const audio = result.value?.audio;
    if (!audio || disposed) return;
    try {
      deps.synth(); // the AudioContext, inside the gesture
    } catch {
      return;
    }
    const ctx = engine.context;
    const output = engine.output;
    if (!ctx || !output) return;
    const src = ctx.createBufferSource();
    src.buffer = deps.createBuffer(audio.samples, audio.sampleRate);
    src.connect(output);
    src.onended = () => {
      src.disconnect();
      if (takeSource === src) takeSource = null;
      takePlaying.value = false;
    };
    takeSource = src;
    takePlaying.value = true;
    src.start();
  }

  return {
    original,
    recordId,
    song,
    view,
    phrases: rows,
    suggestedShift,
    shift,
    fit,
    speed,
    loop,
    selection,
    guide,
    metronome,
    backingVolume,
    offsetMs,
    backing,
    stretching,
    latencyMs,
    headphones,
    phase,
    timeline,
    countIn,
    result,
    error,
    lastScores,
    takePlaying,
    notice,
    setShift(semis) {
      if (!settle()) return;
      shift.value = clampNumber(Math.round(semis), -MAX_TRANSPOSE, MAX_TRANSPOSE);
    },
    setSpeed(s) {
      if (!settle()) return;
      speed.value = s;
      if (s !== 1 && original.backingRef) void backingAt(s); // start the stretch now, so it is ready by Listen or Sing
    },
    setLoop(on) {
      if (!settle()) return;
      loop.value = on;
    },
    select(sel) {
      if (!settle()) return;
      if (isValidSelection(sel, rows.length)) selection.value = sel === null ? null : { from: sel.from, to: sel.to };
    },
    // The guide, the metronome and the offset apply from the next playback or loop pass: what already sounds is
    // left alone (adjusting the offset against a looping phrase is the point of looping it).
    setGuide(on) {
      guide.value = on;
    },
    setMetronome(on) {
      if (disposed || busyTaking()) return;
      metronome.value = on;
    },
    setBackingVolume(volume) {
      const v = clampNumber(volume, 0, 1);
      backingVolume.value = v;
      const g = playback?.gain;
      const ctx = engine.context;
      if (g && ctx) g.gain.setTargetAtTime(v, ctx.currentTime, 0.02);
    },
    setOffsetMs(ms) {
      if (disposed || busyTaking()) return;
      offsetMs.value = clampNumber(Math.round(ms), fileOffsetMs - OFFSET_RANGE_MS, fileOffsetMs + OFFSET_RANGE_MS);
      const storage = deps.storage();
      if (recordId === null || !storage) return;
      if (offsetTimer !== null) clearTimeout(offsetTimer);
      offsetTimer = setTimeout(() => {
        offsetTimer = null;
        storage.songs.setOffset(recordId, offsetMs.value).then(
          () => {
            if (!disposed) notice.value = null;
          },
          (err: unknown) => {
            if (!disposed) notice.value = `The new offset could not be saved (${messageOf(err)}). It applies until you leave this song.`;
          },
        );
      }, OFFSET_SAVE_DEBOUNCE_MS);
    },
    listen: () => startListening('listen'),
    listenTo: (sel, s) => startListening('listen', { selection: sel, speed: s }),
    play: () => startListening('play'),
    sing,
    stop,
    playTake,
    dismissResult() {
      if (phase.value === 'done') phase.value = 'idle';
    },
    dispose() {
      if (disposed) return;
      cancelTake();
      stopPlayback();
      stopTakePlayback();
      disposed = true;
      if (offsetTimer !== null) {
        clearTimeout(offsetTimer);
        offsetTimer = null;
        const storage = deps.storage();
        if (recordId !== null && storage) void storage.songs.setOffset(recordId, offsetMs.value).catch(() => undefined);
      }
      // The mic runs only on the screen that turned it on: a mic this player opened (its own takes, or Reset audio and a
      // reconnect from More, which open it too) goes off when it is left; one that was already on stays on.
      if (micStartedHere || (!micWasOn && engine.state !== 'idle')) void engine.stop().catch(() => undefined);
    },
  };
}
