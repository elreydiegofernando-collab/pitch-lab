/**
 * Song mode's take pipeline with a fake engine, synth and clock: no Web Audio, no mic. The fake AudioContext's
 * clock is the faked wall clock, so the session's timers and ctx.currentTime advance together. Takes are sung as
 * synthesized pitch tracks on the INPUT timeline (scheduled time + the route's round trip), exactly as the engine
 * would deliver them.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { effect } from '@preact/signals';
import { makeTrack } from '../analysis/fixtures';
import type { EngineError, EngineState, Recording } from '../audio/engine-types';
import type { LatencyCalibration } from '../audio/latency-types';
import type { NoteSpec, ReferenceSynth, ScheduledHandle } from '../audio/synth-types';
import type { PitchFrame } from '../core/types';
import type { AttemptFields } from '../progress/attempt';
import { DEFAULT_SETTINGS } from '../state/settings-types';
import { pitchedView } from '../song/pitched';
import { parseUltraStar } from '../song/ultrastar';
import type { Song } from '../song/types';
import type { AppStorage, SaveTakeInput } from '../storage';
import type { AttemptRecord, ProfileRecord, TakeRecord } from '../storage/schema';
import {
  COUNT_IN_BEATS,
  NO_CALIBRATION_MESSAGE,
  PHRASE_LEAD_SEC,
  PHRASE_TAIL_SEC,
  backingSchedule,
  countInBeatSec,
  createSongSession,
  metronomeBpm,
  phraseRows,
  scoreSongSegment,
  selectionWindow,
  songTimeAt,
  toTakeTime,
  type SongSession,
  type SongSessionDeps,
  type SongSpeed,
  type SongTimeline,
  type SongWindow,
} from './song-session';

// The app singletons are never used (every dependency is injected); mocking them keeps their side effects out.
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

/** Two phrases of a scale, 120 bpm grid (a beat is 0.125 s): C4 D4 E4 F4 | G4 F4 E4 D4. */
const CHART = `#TITLE:Scale Song
#ARTIST:Nobody
#BPM:120
#GAP:0
: 0 4 0  do
: 4 4 2  re
: 8 4 4  mi
: 12 8 5  fa
- 22
: 24 4 7  sol
: 28 4 5  fa
: 32 4 4  mi
: 36 8 2  re
E
`;

const ROUND_TRIP_MS = 120;
const CALIBRATION: LatencyCalibration = { route: 'wired', method: 'loopback', roundTripMs: ROUND_TRIP_MS, jitterMs: 2, matched: 8, date: '2026-10-22' };
const PROFILE: ProfileRecord = {
  id: 'singer-1',
  profileId: 'singer-1',
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '0',
  deletedAt: null,
  name: 'Daniel',
  voiceType: 'tenor',
  range: { comfortable: { low: 52, high: 69 }, extended: { low: 45, high: 72 }, measuredAt: '2026-10-01T00:00:00.000Z' },
};

function chart(): Song {
  return parseUltraStar(CHART).song;
}

/** A buffer source as the session drives it: what it plays, and how it was started. */
interface FakeSource {
  buffer: AudioBuffer | null;
  start: ReturnType<typeof vi.fn<(when: number, offset: number, duration: number) => void>>;
  stop: () => void;
  connect: () => void;
  disconnect: () => void;
}

/** The AudioContext slice the session reads: its clock is the faked wall clock; buffer sources are recorded. */
function fakeContext(sources: FakeSource[]): AudioContext {
  const node = () => ({ connect: () => {}, disconnect: () => {} });
  return {
    get currentTime() {
      return Date.now() / 1000;
    },
    sampleRate: 48_000,
    createGain: () => ({ ...node(), gain: { value: 1, setTargetAtTime: () => {} } }),
    createBufferSource: () => {
      const source: FakeSource = { ...node(), buffer: null, start: vi.fn(), stop: () => {} };
      sources.push(source);
      return source;
    },
  } as unknown as AudioContext;
}

/** An AudioBuffer holding `channels` (decoded backing or a stretch). */
function fakeBuffer(channels: Float32Array[], sampleRate: number): AudioBuffer {
  return {
    sampleRate,
    length: channels[0].length,
    numberOfChannels: channels.length,
    duration: channels[0].length / sampleRate,
    getChannelData: (c: number) => channels[c],
  } as unknown as AudioBuffer;
}

class FakeEngine {
  state: EngineState = 'idle';
  error: EngineError | null = null;
  context: AudioContext | null = null;
  output: AudioNode | null = {} as AudioNode;
  readonly sources: FakeSource[] = [];
  private readonly frameListeners = new Set<(f: PitchFrame) => void>();
  private readonly stateListeners = new Set<(s: EngineState, e: EngineError | null) => void>();
  readonly start = vi.fn(async () => {
    this.ensureContext();
    this.setState('running');
  });
  ensureContext(): AudioContext {
    this.context ??= fakeContext(this.sources);
    return this.context;
  }
  readonly resume = vi.fn(async () => this.setState('running'));
  readonly reset = vi.fn(async () => this.setState('running'));
  readonly stop = vi.fn(async () => this.setState('idle'));
  onFrame(listener: (f: PitchFrame) => void): () => void {
    this.frameListeners.add(listener);
    return () => this.frameListeners.delete(listener);
  }
  onState(listener: (s: EngineState, e: EngineError | null) => void): () => void {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }
  setState(state: EngineState, error: EngineError | null = null): void {
    this.state = state;
    this.error = error;
    for (const l of [...this.stateListeners]) l(state, error);
  }
  emit(frames: readonly PitchFrame[]): void {
    for (const f of frames) for (const l of [...this.frameListeners]) l(f);
  }
  startRecording(): void {}
  stopRecording(): Promise<Recording> {
    return Promise.resolve({ samples: new Float32Array(0), sampleRate: 48_000, startTime: 0 });
  }
}

function fakeSynth(): { synth: ReferenceSynth; notes: NoteSpec[]; clicks: number[] } {
  const notes: NoteSpec[] = [];
  const clicks: number[] = [];
  const handle = (startAt: number, endAt: number): ScheduledHandle => ({ startAt, endAt, stop: () => {} });
  const synth: ReferenceSynth = {
    setVolume: () => {},
    playNote: (spec) => {
      notes.push(spec);
      return handle(spec.startAt ?? 0, (spec.startAt ?? 0) + spec.duration);
    },
    playGlide: (spec) => handle(spec.startAt ?? 0, spec.startAt ?? 0),
    playSequence: () => handle(0, 0),
    click: (at) => {
      clicks.push(at);
    },
    startMetronome: () => ({ ...handle(0, Infinity), bpm: 0, beat0: 0, setBpm: () => {} }),
    stopAll: () => {},
  };
  return { synth, notes, clicks };
}

interface Rig {
  session: SongSession;
  song: Song;
  engine: FakeEngine;
  notes: NoteSpec[];
  clicks: number[];
  recordAttempt: ReturnType<typeof vi.fn<(fields: AttemptFields) => Promise<{ attempt: AttemptRecord }>>>;
  saveTake: ReturnType<typeof vi.fn<(input: SaveTakeInput) => Promise<TakeRecord>>>;
  createBuffer: ReturnType<typeof vi.fn<(samples: Float32Array, sampleRate: number) => AudioBuffer>>;
}

/** The backing track of a rig: a stereo tone this long, at a low rate so a stretch stays quick. */
const BACKING_RATE = 8000;

function rig(opts: { latency?: LatencyCalibration | null; backing?: { seconds: number; offsetMs: number } } = {}): Rig {
  const backing = opts.backing;
  const song: Song = backing ? { ...chart(), backingRef: 'songs/rec-1.backing', offsetMs: backing.offsetMs } : chart();
  const engine = new FakeEngine();
  const { synth, notes, clicks } = fakeSynth();
  const recordAttempt = vi.fn(async (fields: AttemptFields) => ({
    attempt: { ...fields, id: 'attempt-1', createdAt: new Date().toISOString(), updatedAt: '1', deletedAt: null } as AttemptRecord,
  }));
  const saveTake = vi.fn(
    async (input: SaveTakeInput): Promise<TakeRecord> => ({
      id: input.id ?? 'take-x',
      profileId: input.profileId,
      createdAt: new Date().toISOString(),
      updatedAt: '1',
      deletedAt: null,
      exerciseId: input.exerciseId,
      track: input.track,
      audioRef: null,
      sampleRate: input.sampleRate,
      latencyMs: input.latencyMs,
    }),
  );
  const read = vi.fn(async (path: string) => (backing && path === song.backingRef ? new Blob([new Uint8Array(16)]) : undefined));
  const storage = { takes: { save: saveTake }, songs: { setOffset: vi.fn(async () => undefined) }, opfs: { read } } as unknown as AppStorage;
  const createBuffer = vi.fn((samples: Float32Array, sampleRate: number) => fakeBuffer([samples], sampleRate));
  const deps: SongSessionDeps = {
    engine,
    // Like getSynth(): getting the synth creates the AudioContext (inside the gesture).
    synth: () => {
      engine.ensureContext();
      return synth;
    },
    storage: () => storage,
    profile: () => PROFILE,
    settings: () => ({ ...DEFAULT_SETTINGS, keepTakeAudio: false }),
    latency: () => (opts.latency === undefined ? CALIBRATION : opts.latency),
    recordAttempt,
    decodeAudio: async () => {
      if (!backing) throw new Error('no backing in this rig');
      const n = backing.seconds * BACKING_RATE;
      const tone = (hz: number) => Float32Array.from({ length: n }, (_, i) => 0.3 * Math.sin((2 * Math.PI * hz * i) / BACKING_RATE));
      return fakeBuffer([tone(220), tone(330)], BACKING_RATE);
    },
    createBuffer,
  };
  const session = createSongSession(song, { deps, recordId: backing ? 'rec-1' : null });
  session.setShift(0); // sing in the chart's own key, so the expected pitches are the chart's
  return { session, song, engine, notes, clicks, recordAttempt, saveTake, createBuffer };
}

/** Let the session's promise chains run (engine start, scoring, writes). */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
  await vi.advanceTimersByTimeAsync(0);
}

/**
 * A singer following a take timeline: song time `window.start + tau * sungSpeed` at take time tau, every note held
 * to 30 ms before its end, as raw frames on the input timeline (heard at startAt, answered a round trip later).
 */
function sungFrames(tl: SongTimeline, song: Song, sungSpeed: number = tl.speed, centsOff = 0): PitchFrame[] {
  const notes = pitchedView(song).notes;
  const midiAtSongTime = (t: number): number => {
    const n = notes.find((x) => t >= x.start && t < x.start + x.duration - 0.03);
    return n ? n.midi + centsOff / 100 : NaN;
  };
  const track = makeTrack({ duration: tl.passSec + 0.4, t0: -0.4, midi: (tau) => midiAtSongTime(tl.window.start + tau * sungSpeed), jitterCents: 4, seed: 11 });
  return track.map((f) => ({ ...f, t: f.t + tl.startAt + ROUND_TRIP_MS / 1000 }));
}

/** Sing one take of the current selection: start, sing along, let it run out, wait for the result. */
async function singTake(r: Rig, sing: (tl: SongTimeline) => PitchFrame[]): Promise<SongTimeline> {
  r.session.sing();
  await settle();
  const tl = r.session.timeline.value;
  if (!tl || tl.kind !== 'take') throw new Error(`no take timeline (phase ${r.session.phase.value})`);
  r.engine.emit(sing(tl));
  await vi.advanceTimersByTimeAsync((tl.startAt + tl.passSec + 1 - Date.now() / 1000) * 1000);
  await settle();
  return tl;
}

beforeEach(() => {
  vi.useFakeTimers({ now: 100_000 });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('pure helpers', () => {
  it('windows a phrase with a lead-in and a tail, the whole song, or a phrase to the end (loop bounds)', () => {
    const song = chart();
    const [p0, p1] = song.phrases;
    const first = selectionWindow(song, 1)!;
    expect(first).toEqual({ start: 3 - PHRASE_LEAD_SEC, end: 5.5 + PHRASE_TAIL_SEC, firstNote: 3, from: p1.from, to: p1.to });
    expect(selectionWindow(song, null)).toEqual({ start: -PHRASE_LEAD_SEC, end: 5.5 + PHRASE_TAIL_SEC, firstNote: 0, from: 0, to: song.notes.length });
    expect(selectionWindow(song, 0, { toEnd: true })).toMatchObject({ start: -PHRASE_LEAD_SEC, end: 5.5 + PHRASE_TAIL_SEC, from: p0.from, to: song.notes.length });
    expect(selectionWindow(song, 0)).toMatchObject({ end: 2.5 + PHRASE_TAIL_SEC, to: p0.to });
    expect(selectionWindow(song, 7)).toBeNull();
  });

  it('lists phrases with their lyrics and where each sits in the pitched view', () => {
    const song = chart();
    // A spoken phrase in between: nothing to score, so the pitched view (and its indices) skip it.
    const spoken: Song = {
      ...song,
      notes: [...song.notes.slice(0, 4), { start: 2.6, duration: 0.2, midi: 0, lyric: ' (spoken)', type: 'freestyle' }, ...song.notes.slice(4)],
      phrases: [song.phrases[0], { start: 2.6, end: 2.8, from: 4, to: 5 }, { ...song.phrases[1], from: 5, to: 9 }],
    };
    const rows = phraseRows(spoken);
    expect(rows.map((r) => r.pitchedIndex)).toEqual([0, null, 1]);
    expect(rows.map((r) => r.text)).toEqual(['do re mi fa', '(spoken)', 'sol fa mi re']);
    expect(rows[0].syllables.map((s) => s.note)).toEqual([0, 1, 2, 3]);
    expect(pitchedView(spoken).phrases).toHaveLength(2);
  });

  it('puts notes on the slowed take timeline and reads the song time back from the clock', () => {
    const song = chart();
    const w = selectionWindow(song, 1)!;
    const notes = song.notes.slice(w.from, w.to);
    expect(toTakeTime(notes, w.start, 0.5)[0]).toMatchObject({ midi: 67, start: (3 - w.start) / 0.5, end: (3.5 - w.start) / 0.5 });
    const tl = { startAt: 10, window: w, speed: 0.5 as SongSpeed, passSec: (w.end - w.start) / 0.5, repeat: false };
    expect(songTimeAt(tl, 9.9)).toBeNull();
    expect(songTimeAt(tl, 12)).toBeCloseTo(w.start + 1, 9);
    expect(songTimeAt(tl, 12.12, 0.12)).toBeCloseTo(w.start + 1, 9);
    expect(songTimeAt(tl, 10 + tl.passSec + 0.01)).toBeNull();
    expect(songTimeAt({ ...tl, repeat: true }, 10 + tl.passSec + 2)).toBeCloseTo(w.start + 1, 9);
  });

  it('places the backing on the stretched buffer at the song offset, late when the audio starts after the window', () => {
    const song: Song = { ...chart(), offsetMs: 2000 };
    // Song time 1 s plays backing 3 s, which sits at 6 s in a half-speed stretch.
    expect(backingSchedule(song, 1, 0.5, 50, 4, 100)).toEqual({ when: 50, offset: 6, duration: 4 });
    // Offset -1500 ms: song time 0.5 s is backing -1 s, so the source starts 2 s (slowed) into the pass.
    const late = backingSchedule({ ...song, offsetMs: -1500 }, 0.5, 0.5, 50, 6, 100)!;
    expect(late.when).toBeCloseTo(52, 9);
    expect(late.offset).toBe(0);
    expect(late.duration).toBeCloseTo(4, 9);
    // Nothing of a 3 s backing is left at backing 5 s.
    expect(backingSchedule(song, 3, 1, 50, 4, 3)).toBeNull();
  });

  it('folds the chart grid into a singable click and count-in', () => {
    expect(metronomeBpm({ bpm: 80 })).toBe(80);
    expect(metronomeBpm({ bpm: 385.8 })).toBeCloseTo(96.45, 6);
    expect(metronomeBpm({ bpm: 30 })).toBe(60);
    expect(metronomeBpm({})).toBe(120);
    expect(countInBeatSec({ bpm: 100 }, 1)).toBeCloseTo(0.6, 9);
    const slow = countInBeatSec({ bpm: 60 }, 0.5); // 2 s per beat at half speed, folded to 1 s
    expect(slow).toBeGreaterThanOrEqual(0.4);
    expect(slow).toBeLessThanOrEqual(1);
  });

  it('scores a take sung at 75% on the slowed timeline and maps the phrases back to song time', () => {
    const song = chart();
    const view = pitchedView(song);
    const w = selectionWindow(song, null)!;
    const speed = 0.75;
    const track = makeTrack({
      duration: (w.end - w.start) / speed,
      midi: (tau) => {
        const t = w.start + tau * speed;
        const n = view.notes.find((x) => t >= x.start && t < x.start + x.duration - 0.03);
        return n ? n.midi : NaN;
      },
      jitterCents: 4,
      seed: 3,
    });
    const scores = scoreSongSegment(track, { view, phrases: [0, 1], originSongSec: w.start, speed, ctx: { toleranceCents: 25, vibratoStyle: 'pop' } });
    expect(scores.map((s) => s.phraseIndex)).toEqual([0, 1]);
    for (const [i, s] of scores.entries()) {
      expect(s.pitchScore, `phrase ${i}`).toBeGreaterThan(0.85);
      expect(s.start).toBeCloseTo(view.phrases[i].start, 9);
      expect(s.end).toBeCloseTo(view.phrases[i].end, 9);
      expect(Math.abs(s.timingOffsetMs ?? 0)).toBeLessThan(60);
    }
  });
});

describe('a song take', () => {
  it('refuses to sing without a latency calibration for the route, and says so', async () => {
    const r = rig({ latency: null });
    r.session.sing();
    await settle();
    expect(r.session.phase.value).toBe('error');
    expect(r.session.error.value).toEqual({ code: 'no-calibration', message: NO_CALIBRATION_MESSAGE });
    expect(r.session.latencyMs.value).toBeNull();
    expect(r.engine.start).not.toHaveBeenCalled();
    expect(r.recordAttempt).not.toHaveBeenCalled();
  });

  it('starts the mic inside the gesture, counts in, and scores the phrase it recorded', async () => {
    const r = rig();
    r.session.select(1);
    r.session.sing();
    expect(r.engine.start).toHaveBeenCalledTimes(1); // synchronously, before any await
    await settle();
    const tl = r.session.timeline.value!;
    expect(tl).toMatchObject({ kind: 'take', speed: 1, window: selectionWindow(r.song, 1) });
    expect(r.session.phase.value).toBe('count-in');
    expect(r.session.countIn.value).toBe(COUNT_IN_BEATS);
    // Three clicks lead into the first note.
    const firstNoteAt = tl.startAt + (tl.window.firstNote - tl.window.start);
    const beat = countInBeatSec(r.song, 1);
    expect(r.clicks.map((t) => t - firstNoteAt)).toEqual([-3 * beat, -2 * beat, -beat].map((x) => expect.closeTo(x, 9)));

    r.engine.emit(sungFrames(tl, r.song));
    await vi.advanceTimersByTimeAsync((firstNoteAt - Date.now() / 1000 + 0.01) * 1000);
    expect(r.session.phase.value).toBe('singing');
    expect(r.session.countIn.value).toBeNull();
    // The guide plays the phrase's four notes on the take clock, scheduled a second ahead.
    await vi.advanceTimersByTimeAsync(2000);
    expect(r.notes.map((n) => n.midi)).toEqual([67, 65, 64, 62]);
    expect(r.notes[0].startAt).toBeCloseTo(firstNoteAt, 9);
    await vi.advanceTimersByTimeAsync((tl.startAt + tl.passSec + 1 - Date.now() / 1000) * 1000);
    await settle();

    expect(r.session.phase.value).toBe('done');
    const result = r.session.result.value!;
    expect(result.phrases).toHaveLength(1);
    expect(result.phrases[0]).toMatchObject({ phraseIndex: 1, text: 'sol fa mi re' });
    expect(result.phrases[0].score.pitchScore).toBeGreaterThan(0.85);
    expect(result.phrases[0].score.start).toBeCloseTo(r.song.phrases[1].start, 9);
    expect(Math.abs(result.phrases[0].score.timingOffsetMs ?? 0)).toBeLessThan(60); // the round trip was taken out once
    expect(result).toMatchObject({ passed: true, attemptError: null, saveError: null, unfinished: 0 });
    expect(r.session.lastScores.value.get(1)).toBeCloseTo(result.phrases[0].score.pitchScore, 12);
  });

  it('keeps the melody guide silent during a take on a speaker, where the mic would score it', async () => {
    const r = rig({ latency: { ...CALIBRATION, route: 'speaker' } });
    expect(r.session.headphones.value).toBe(false);
    r.session.select(0);
    await singTake(r, (tl) => sungFrames(tl, r.song));
    expect(r.notes).toEqual([]); // no guide note while recording
    expect(r.clicks).toHaveLength(COUNT_IN_BEATS); // the count-in still clicks
    // Listening is another matter: nothing is recorded, so the guide plays.
    r.session.dismissResult();
    r.session.listen();
    await settle();
    await vi.advanceTimersByTimeAsync(4000);
    expect(r.notes.map((n) => n.midi)).toEqual([60, 62, 64, 65]);
  });

  it('writes a song attempt (never a level pass) and saves the take under it', async () => {
    const r = rig();
    r.session.select(0);
    await singTake(r, (tl) => sungFrames(tl, r.song));
    expect(r.recordAttempt).toHaveBeenCalledTimes(1);
    const fields = r.recordAttempt.mock.calls[0][0];
    expect(fields).toMatchObject({
      profileId: PROFILE.id,
      kind: 'song',
      songId: r.song.id,
      exerciseId: `song.${r.song.id}`,
      levelId: null,
      mastery: 0,
      passed: true,
      tonicMidi: 60,
    });
    expect(fields.score).toBeCloseTo(r.session.result.value!.score, 12);
    expect(Object.keys(fields.metrics).sort()).toEqual(['song.inTolerancePct', 'song.phraseScore']);
    expect(fields.durationSec).toBeGreaterThan(3);
    expect(r.saveTake).toHaveBeenCalledTimes(1);
    expect(r.saveTake.mock.calls[0][0]).toMatchObject({ id: fields.takeId, profileId: PROFILE.id, exerciseId: `song.${r.song.id}`, latencyMs: ROUND_TRIP_MS, audio: null });
    expect(r.session.result.value?.savedTake?.id).toBe(fields.takeId);
  });

  it('a wrong-note take is written as not passed', async () => {
    const r = rig();
    r.session.select(0);
    await singTake(r, (tl) => sungFrames(tl, r.song, tl.speed, 150)); // a semitone and a half sharp throughout
    const result = r.session.result.value!;
    expect(result.passed).toBe(false);
    expect(result.score).toBeLessThan(0.3);
    expect(r.recordAttempt.mock.calls[0][0]).toMatchObject({ kind: 'song', passed: false });
  });

  it('a slowed take is scored where it was sung and mapped back to song time', async () => {
    const r = rig();
    r.session.select(1);
    r.session.setSpeed(0.5);
    const tl = await singTake(r, (t) => sungFrames(t, r.song)); // sung at the slowed tempo
    expect(tl.passSec).toBeCloseTo((tl.window.end - tl.window.start) / 0.5, 9);
    expect(r.notes[0].duration).toBeCloseTo(0.5 / 0.5, 9); // the guide plays at the slowed tempo, same pitch
    const slowed = r.session.result.value!;
    expect(slowed.speed).toBe(0.5);
    expect(slowed.phrases[0].score.pitchScore).toBeGreaterThan(0.85);
    expect(slowed.phrases[0].score.start).toBeCloseTo(r.song.phrases[1].start, 9);
    expect(slowed.phrases[0].score.end).toBeCloseTo(r.song.phrases[1].end, 9);

    // The same phrase sung at full tempo against the slowed take runs ahead of every note after the first.
    r.session.dismissResult();
    await singTake(r, (t) => sungFrames(t, r.song, 1));
    expect(r.session.result.value!.phrases[0].score.pitchScore).toBeLessThan(slowed.phrases[0].score.pitchScore - 0.3);
  });

  it('stopping a whole-song take judges only the phrases that had ended', async () => {
    const r = rig();
    r.session.select(null);
    r.session.sing();
    await settle();
    const tl = r.session.timeline.value!;
    r.engine.emit(sungFrames(tl, r.song));
    // Stop half a second into the second phrase (input side: heard, then a round trip).
    const stopAt = tl.startAt + (r.song.phrases[1].start + 0.5 - tl.window.start) + ROUND_TRIP_MS / 1000;
    await vi.advanceTimersByTimeAsync((stopAt - Date.now() / 1000) * 1000);
    expect(r.session.phase.value).toBe('singing');
    r.session.stop();
    await settle();
    const result = r.session.result.value!;
    expect(result.phrases.map((p) => p.phraseIndex)).toEqual([0]);
    expect(result.unfinished).toBe(1);
    expect(r.recordAttempt).toHaveBeenCalledTimes(1);
  });

  it('a take cancelled in the count-in or interrupted writes nothing', async () => {
    const r = rig();
    r.session.sing();
    await settle();
    expect(r.session.phase.value).toBe('count-in');
    r.session.stop();
    expect(r.session.phase.value).toBe('idle');

    r.session.sing();
    await settle();
    const tl = r.session.timeline.value!;
    await vi.advanceTimersByTimeAsync((tl.startAt + 1.5 - Date.now() / 1000) * 1000);
    r.engine.setState('interrupted', { code: 'session-interrupted', message: 'call' });
    await settle();
    expect(r.session.error.value?.code).toBe('interrupted');
    await vi.advanceTimersByTimeAsync(10_000);
    await settle();
    expect(r.recordAttempt).not.toHaveBeenCalled();
    expect(r.saveTake).not.toHaveBeenCalled();
  });

  it('leaving the screen discards an unfinished take and turns off the mic it opened', async () => {
    const r = rig();
    r.session.sing();
    await settle();
    r.session.dispose();
    await vi.advanceTimersByTimeAsync(20_000);
    await settle();
    expect(r.recordAttempt).not.toHaveBeenCalled();
    expect(r.engine.stop).toHaveBeenCalledTimes(1);
  });
});

describe('listening and looping', () => {
  it('loops the selected phrase pass after pass, within its bounds', async () => {
    const r = rig();
    r.session.select(1);
    r.session.setLoop(true);
    r.session.play();
    expect(r.session.phase.value).toBe('playing');
    await settle();
    const first = r.session.timeline.value!;
    const w: SongWindow = selectionWindow(r.song, 1)!;
    expect(first).toMatchObject({ kind: 'play', repeat: true, window: w });
    expect(first.passSec).toBeCloseTo(w.end - w.start, 9);

    await vi.advanceTimersByTimeAsync((first.startAt + 2 * first.passSec + 0.2 - Date.now() / 1000) * 1000);
    // Pass 2 is under way: the song time wraps to the phrase's start, and every guide note fell inside the phrase.
    expect(r.session.timeline.value).toBe(first);
    expect(songTimeAt(first, Date.now() / 1000)).toBeCloseTo(w.start + 0.2, 6);
    const offsets = r.notes.map((n) => {
      const rel = (n.startAt ?? 0) - first.startAt;
      return rel - Math.floor(rel / first.passSec + 1e-9) * first.passSec + w.start;
    });
    expect(r.notes.length).toBeGreaterThanOrEqual(8);
    for (const songTime of offsets) {
      expect(songTime).toBeGreaterThanOrEqual(w.firstNote - 1e-9);
      expect(songTime).toBeLessThan(w.end);
    }
    expect(new Set(r.notes.map((n) => n.midi))).toEqual(new Set([67, 65, 64, 62]));

    r.session.stop();
    expect(r.session.phase.value).toBe('idle');
    expect(r.session.selection.value).toBe(1);
  });

  it('Play runs on from the selection, and pausing leaves the phrase that was playing selected', async () => {
    const r = rig();
    r.session.select(0);
    r.session.play();
    await settle();
    const tl = r.session.timeline.value!;
    expect(tl).toMatchObject({ kind: 'play', repeat: false, window: selectionWindow(r.song, 0, { toEnd: true }) });
    await vi.advanceTimersByTimeAsync((tl.startAt + (r.song.phrases[1].start + 0.3 - tl.window.start) - Date.now() / 1000) * 1000);
    expect(r.session.phase.value).toBe('playing');
    r.session.stop();
    expect(r.session.selection.value).toBe(1);
  });

  it('plays the backing at the song offset, and slowed down from one WSOLA stretch per speed', async () => {
    const r = rig({ backing: { seconds: 8, offsetMs: 500 } });
    await settle();
    expect(r.session.backing.value).toEqual({ status: 'ready', durationSec: 8 });

    r.session.select(1);
    r.session.listen();
    await settle();
    let tl = r.session.timeline.value!;
    expect(r.engine.sources).toHaveLength(1);
    // Song time window.start plays backing second window.start + 0.5 (the offset), for the whole pass.
    expect(r.engine.sources[0].buffer?.duration).toBe(8);
    expect(r.engine.sources[0].start).toHaveBeenCalledWith(expect.closeTo(tl.startAt, 9), expect.closeTo(tl.window.start + 0.5, 9), expect.closeTo(tl.passSec, 9));
    r.session.stop();

    // Choosing half speed starts the stretch at once, in slices that yield to the UI, before anything plays.
    const progress: Array<number | null> = [];
    const unwatch = effect(() => {
      progress.push(r.session.stretching.value?.progress ?? null);
    });
    r.session.setSpeed(0.5);
    for (let i = 0; i < 50 && r.createBuffer.mock.calls.length === 0; i++) await vi.advanceTimersByTimeAsync(10);
    await settle();
    unwatch();
    expect(r.createBuffer).toHaveBeenCalledTimes(1);
    expect(r.createBuffer.mock.calls[0][0].length).toBe(Math.round((8 * BACKING_RATE) / 0.5));
    expect(progress[progress.length - 1]).toBeNull();
    expect(progress.filter((p) => p !== null && p > 0 && p < 1).length).toBeGreaterThan(0);

    r.session.listen();
    await settle();
    tl = r.session.timeline.value!;
    const slowed = r.engine.sources[1];
    expect(slowed.buffer?.duration).toBeCloseTo(16, 9);
    // On the stretch, backing second b sits at b / 0.5.
    expect(slowed.start).toHaveBeenCalledWith(expect.closeTo(tl.startAt, 9), expect.closeTo((tl.window.start + 0.5) / 0.5, 9), expect.closeTo(tl.passSec, 9));
    r.session.stop();
    r.session.listen();
    await settle();
    expect(r.createBuffer).toHaveBeenCalledTimes(1); // computed once for this speed
  });

  it('Listen plays the selection once, then rests', async () => {
    const r = rig();
    r.session.select(0);
    r.session.listen();
    await settle();
    const tl = r.session.timeline.value!;
    expect(tl).toMatchObject({ kind: 'listen', repeat: false });
    await vi.advanceTimersByTimeAsync((tl.startAt + tl.passSec + 0.3 - Date.now() / 1000) * 1000);
    expect(r.session.phase.value).toBe('idle');
    expect(r.session.timeline.value).toBeNull();
    expect(r.notes.map((n) => n.midi)).toEqual([60, 62, 64, 65]);
  });
});
