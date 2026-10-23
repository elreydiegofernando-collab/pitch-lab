/**
 * Wave 1 end to end, with no UI: the pure engines proving they work TOGETHER. A tenor's sung takes
 * (synthesized pitch tracks, good and bad) go through the real pipeline a Wave 2 runner will use:
 *
 *   realize (saved range) -> sing a PitchTrack -> TakeRecorder (latency compensation) -> analyzers
 *   (analyzeTake) -> metricsFromResults -> scoreExercise / evaluate -> coaching tip -> buildAttempt
 *   -> storage.attempts.add (IndexedDB, via fake-indexeddb) -> computeSnapshot -> the unlock registry
 *
 * and then checks what the snapshot says: pass or fail, mastery, the next level becoming current,
 * features opening, Boss Recitals opening worlds, auditions skipping inside a world only, songs
 * opening with the world their difficulty needs. Storage is closed, reopened, exported and
 * restored on a "new device", and the progress must come back identical.
 *
 * The take renditions are built with analysis/fixtures.ts (makeTrack, notesMidi), either by
 * hand for the four representative exercises (Foundations sustain, Vibrato straight-to-bloom, Runs
 * pentatonic at 6 notes/s, Dynamics swell) or, to climb the whole game, with the synthetic singer of
 * the exercises module (exercises/test-singer.ts, which follows every cue). Nothing here touches a
 * clock: the database runs on a fake one, so "days" pass at the test's say-so.
 */
import 'fake-indexeddb/auto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { analyzeAccuracy } from '../analysis/accuracy';
import { trackFromAudio } from '../analysis/core-test-helpers';
import { FRAME_RATE, makeTrack, notesMidi } from '../analysis/fixtures';
import { scoreSongTake } from '../analysis/phrases';
import { metricsFromResults, scoreExercise } from '../analysis/score';
import { TakeRecorder, encodeTake, type TakeEngine, type TakeResult } from '../audio/take-recorder';
import { parseWav } from '../audio/wav';
import type { Recording } from '../audio/engine-types';
import { centsFromNearest, midiToHz } from '../core/music';
import type { PitchFrame, TargetNote } from '../core/types';
import { DEFAULT_HARMONICS, seededRandom, synthesize } from '../dsp/test-signals';
import {
  CATALOG,
  EXERCISES,
  WORLDS,
  analyzeTake,
  bossOf,
  evaluate,
  getExercise,
  getLevel,
  isPassTempo,
  ladderOf,
  nextTempo,
  pickTip,
  rangeFromMeasurement,
  realize,
  startTempo,
  usesExtendedRange,
  validateCatalog,
  type Evaluation,
  type ExerciseDef,
  type PickedTip,
  type RealizedExercise,
  type TakeAnalysis,
} from '../exercises';
import { GOOD_SINGER, singTake, type SingerModel } from '../exercises/test-singer';
import type { LevelDef, WorldDef } from '../exercises/types';
import {
  FEATURE_IDS,
  buildAttempt,
  buildDailyWorkout,
  buildSongAttempt,
  computeMomentum,
  computeSnapshot,
  continueLevel,
  isAuditionAvailable,
  isExerciseOpenable,
  isFeatureUnlocked,
  isLevelOpenable,
  isSongUnlocked,
  isWorldUnlocked,
  levelRequirementHint,
  nextAuditionExercise,
  recordsForExercise,
  songExerciseId,
  songRequirementHint,
  withRoutines,
  type AttemptSource,
  type ProgressSnapshot,
} from '../progress';
import { pitchedView } from '../song/pitched';
import { parseUltraStar } from '../song/ultrastar';
import { loadBundledLibrary, type BundledLibrary } from '../song/library';
import { songDurationSec } from '../song/timing';
import { transposeSongToRange } from '../song/transpose';
import type { Song } from '../song/types';
import { openStorage, decodeTrack, type AppStorage } from '../storage';
import { openDb } from '../storage/db';
import type { AttemptRecord, ProfileRecord, VocalRange } from '../storage/schema';
import { freshName, installNoOpfs } from '../storage/test-helpers';

// A whole-game playthrough sings dozens of takes through the real analyzers; give each test room on a loaded machine.
vi.setConfig({ testTimeout: 120_000, hookTimeout: 60_000 });

// ================================================================ the rig

const START_MS = Date.parse('2026-10-21T09:00:00.000Z');
const DAY_MS = 86_400_000;
/** The round trip of a decent Bluetooth route (AirPods Pro 2 class): every take is compensated for it. */
const ROUND_TRIP_MS = 140;
/** AudioContext time of the downbeat: anything but 0, so a sign slip in the time base cannot hide. */
const DOWNBEAT = 12.5;
/** The tenor's measured extremes (A2 to D5), as the range finder will find them. */
const TENOR_LOW = 45;
const TENOR_HIGH = 72;

const ordered = (w: WorldDef): LevelDef[] => [...w.levels].sort((a, b) => a.index - b.index);
const TRAINING = WORLDS.filter((w) => w.levels.length > 0);
const ALL_LEVELS = TRAINING.flatMap(ordered);
const levelOf = (id: string): LevelDef => {
  const l = getLevel(id);
  if (!l) throw new Error(`no level ${id}`);
  return l;
};
const exerciseOf = (id: string): ExerciseDef => {
  const d = getExercise(id);
  if (!d) throw new Error(`no exercise ${id}`);
  return d;
};
const statusesOf = (s: ProgressSnapshot, world: string): string[] => ordered(WORLDS.find((w) => w.id === world)!).map((l) => s.levels[l.id].status);

/** The slice of the audio engine a take needs: frames in, no recording (unless a test supplies one). */
class FakeEngine implements TakeEngine {
  recording: Recording = { samples: new Float32Array(0), sampleRate: 48000, startTime: 0 };
  private readonly listeners = new Set<(f: PitchFrame) => void>();
  onFrame(listener: (f: PitchFrame) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  emit(f: PitchFrame): void {
    for (const l of [...this.listeners]) l(f);
  }
  startRecording(): void {}
  stopRecording(): Promise<Recording> {
    return Promise.resolve(this.recording);
  }
}

/**
 * What the app does around a take: the singer's frames reach the input timeline `downbeat + round trip`
 * later than they were sung, and the recorder puts them back (take time 0 = the downbeat).
 */
async function recordTake(sung: readonly PitchFrame[], opts: { latencyMs?: number; downbeat?: number; audio?: Recording } = {}): Promise<TakeResult> {
  const latencyMs = opts.latencyMs ?? ROUND_TRIP_MS;
  const downbeat = opts.downbeat ?? DOWNBEAT;
  const engine = new FakeEngine();
  if (opts.audio) engine.recording = opts.audio;
  const recorder = new TakeRecorder(engine, { downbeat, latency: { roundTripMs: latencyMs }, recordAudio: opts.audio !== undefined });
  recorder.start();
  const shift = downbeat + latencyMs / 1000;
  for (const f of sung) engine.emit({ ...f, t: f.t + shift });
  return recorder.stop();
}

/** A take-relative PitchTrack (t = 0 at the downbeat) of `sung`. */
type Rendition = (realized: RealizedExercise, def: ExerciseDef) => PitchFrame[];

interface Outcome {
  def: ExerciseDef;
  realized: RealizedExercise;
  take: TakeResult;
  analysis: TakeAnalysis;
  evaluation: Evaluation;
  tip: PickedTip;
  attempt: AttemptRecord;
  /** The progression after this attempt. */
  snapshot: ProgressSnapshot;
}

interface SingOptions {
  bpm?: number;
  /** Also save the take (pitch track, and audio when given) so the attempt points at it. */
  keepTake?: { audio?: Recording };
}

class Studio {
  snapshot!: ProgressSnapshot;
  /** Every attempt this studio wrote, in order. */
  readonly written: AttemptRecord[] = [];

  private constructor(
    readonly storage: AppStorage,
    readonly clock: { ms: number },
    readonly names: { db: string; bin: string; kv: string },
    public profile: ProfileRecord,
  ) {}

  /** A fresh install: a database on a fake clock, an active profile named `name`, a tenor. */
  static async open(name = 'Daniel'): Promise<Studio> {
    installNoOpfs(); // binaries fall back to IndexedDB blobs, as on Safari without OPFS writes
    const clock = { ms: START_MS };
    const names = { db: freshName('wave1-db'), bin: freshName('wave1-bin'), kv: freshName('wave1-kv') };
    const db = await openDb(names.db, { now: () => clock.ms });
    const storage = await openStorage({ db, binaryDbName: names.bin, kvDbName: names.kv });
    const me = await storage.profiles.active();
    await storage.profiles.rename(me.id, name);
    const profile = await storage.profiles.setVoiceType(me.id, 'tenor');
    const studio = new Studio(storage, clock, names, profile);
    await studio.refresh();
    return studio;
  }

  get now(): Date {
    return new Date(this.clock.ms);
  }

  /** Move the (fake) wall clock on. */
  advance(ms: number): void {
    this.clock.ms += ms;
  }

  /** Next morning, 09:00 UTC. */
  nextDay(): void {
    const d = new Date(this.clock.ms);
    this.clock.ms = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1, 9, 0, 0);
  }

  /** Progress as the app computes it: replay the whole stored log, with the catalog as the lookup. */
  async refresh(): Promise<ProgressSnapshot> {
    const attempts = await this.storage.attempts.listByProfile(this.profile.id);
    this.snapshot = computeSnapshot(this.profile.id, WORLDS, attempts, this.now, { getExercise: withRoutines(getExercise) });
    return this.snapshot;
  }

  async saveRange(range: VocalRange): Promise<void> {
    this.profile = await this.storage.profiles.setRange(this.profile.id, range);
  }

  /** One sung take, all the way into the stored log and the new snapshot. */
  async sing(def: ExerciseDef, source: AttemptSource, rendition: Rendition, opts: SingOptions = {}): Promise<Outcome> {
    const realized = realize(def, this.profile.range, this.profile.voiceType, opts.bpm !== undefined ? { bpm: opts.bpm } : undefined);
    const take = await recordTake(rendition(realized, def), { audio: opts.keepTake?.audio });
    const analysis = analyzeTake(def, realized, take.track, { vibratoStyle: 'pop' });
    const evaluation = evaluate(def, analysis.metrics);
    // The two scorers (the exercise layer's and the analysis layer's) are one rule, so they must agree take by take.
    const scored = scoreExercise(def, analysis.metrics);
    expect(scored.score, `${def.id}: scoreExercise vs evaluate`).toBeCloseTo(evaluation.score, 12);
    expect(scored.passed).toBe(evaluation.passed);
    expect(scored.mastery).toBe(evaluation.mastery);
    const tip = pickTip(analysis.metrics, def, analysis.tipContext);

    let takeId: string | null = null;
    if (opts.keepTake) takeId = (await this.storage.takes.save({ profileId: this.profile.id, exerciseId: def.id, ...encodeTake(take) })).id;

    const fields = buildAttempt({ profileId: this.profile.id, def, source, realized, evaluation, metrics: analysis.metrics, takeId });
    const attempt = await this.storage.attempts.add(fields);
    // The log keeps the take as it was built: nothing clamped, no metric lost to the repository's validation.
    expect(attempt, `${def.id}: stored as built`).toMatchObject(fields);
    expect(attempt.metrics).toEqual(analysis.metrics);
    this.written.push(attempt);
    this.advance((realized.countInSec + realized.totalSec + 25) * 1000); // sing, read the report, breathe
    return { def, realized, take, analysis, evaluation, tip, attempt, snapshot: await this.refresh() };
  }

  singLevel(levelId: string, rendition: Rendition = good, opts: SingOptions = {}): Promise<Outcome> {
    const level = levelOf(levelId);
    return this.sing(exerciseOf(level.exerciseId), { type: 'level', level }, rendition, opts);
  }

  singAudition(exerciseId: string, rendition: Rendition = good, opts: SingOptions = {}): Promise<Outcome> {
    return this.sing(exerciseOf(exerciseId), { type: 'audition' }, rendition, opts);
  }

  /** What a runner does with a world's audition: sing the tests IN ORDER from the next one, stop at the first miss. */
  async auditionRun(worldId: string, rendition: Rendition = good, stopAfter = Infinity): Promise<Outcome[]> {
    const out: Outcome[] = [];
    while (out.length < stopAfter) {
      const id = nextAuditionExercise(worldId as never, this.snapshot, WORLDS);
      if (id === null) break;
      expect(isExerciseOpenable(id, this.snapshot, WORLDS), `${id} is offered, so it must be openable`).toBe(true);
      const o = await this.singAudition(id, rendition);
      out.push(o);
      if (!o.attempt.passed) break;
    }
    return out;
  }

  /** The Range finder, sung through the tenor's whole compass, and its range saved: where every real run begins. */
  async findRange(): Promise<Outcome> {
    const o = await this.singLevel('foundations.01', rangeSweep(TENOR_LOW, TENOR_HIGH));
    const r = o.analysis.details.range!;
    const range = rangeFromMeasurement(r.lowestMidi, r.highestMidi, this.now.toISOString());
    if (!range) throw new Error('the range finder measured nothing');
    await this.saveRange(range);
    return o;
  }

  /** Re-open the database as a relaunch would: same name, same fake clock. */
  async relaunch(): Promise<Studio> {
    this.storage.close();
    const db = await openDb(this.names.db, { now: () => this.clock.ms });
    const storage = await openStorage({ db, binaryDbName: this.names.bin, kvDbName: this.names.kv });
    const again = new Studio(storage, this.clock, this.names, (await storage.profiles.get(this.profile.id))!);
    again.written.push(...this.written);
    await again.refresh();
    return again;
  }
}

// ================================================================ renditions (fixtures)

/** Seconds of the take before the downbeat that every rendition keeps (what the recorder's window keeps). */
const PRE_ROLL = 0.5;

/** A rendition of `realized` from a pitch contour (NaN = silence), with the usual few cents of detector jitter. */
function takeOf(realized: RealizedExercise, midi: (t: number) => number, extra: { rmsDb?: (t: number) => number; jitterCents?: number; seed?: number } = {}): PitchFrame[] {
  return makeTrack({ duration: realized.totalSec + 1, t0: -PRE_ROLL, midi, jitterCents: extra.jitterCents ?? 4, seed: extra.seed ?? 5, rmsDb: extra.rmsDb });
}

interface VoiceFault {
  /** Constant offset, cents (+ sharp). */
  bias?: number;
  /** Starts this far below each note ... */
  scoop?: number;
  /** ... closing the gap with this time constant. */
  tauMs?: number;
  /** A slow pitch wobble of this size, cents. */
  wobble?: number;
  /** Stops this long before each note ends (a breath). */
  release?: number;
}

/** A voice singing `notes`, with the faults of `o`: biased, scooping in, wobbling. */
function voice(notes: readonly TargetNote[], o: VoiceFault = {}): (t: number) => number {
  const base = notesMidi(notes);
  return (t) => {
    const n = notes.find((x) => t >= x.start && t < x.end - (o.release ?? 0.05));
    if (!n) return NaN;
    const wobble = ((o.wobble ?? 0) / 100) * Math.sin(2 * Math.PI * 2.5 * (t - n.start));
    const scoop = ((o.scoop ?? 0) / 100) * Math.exp(-((t - n.start) * 1000) / (o.tauMs ?? 40));
    return base(t) + (o.bias ?? 0) / 100 - scoop + wobble;
  };
}

/** The synthetic singer of the exercises module, with natural vibrato wherever the exercise judges vibrato. */
const singer =
  (model: Partial<SingerModel> = {}): Rendition =>
  (realized, def) =>
    singTake(realized, { ...GOOD_SINGER, vibratoEverywhere: def.analyzers.includes('vibrato'), ...model });

/** A clean singer who does everything the cues ask. */
const good: Rendition = singer();

/**
 * The range finder as a tenor sings it, on its own sung steps (the app plays the starting note first): the starting
 * note, a slide down to `low` and a hold there; a breath while the starting note plays again; then up to `high`.
 */
const rangeSweep =
  (low: number, high: number): Rendition =>
  (realized) => {
    const mid = realized.tonicMidi;
    const sung = realized.steps.filter((s) => s.role === 'sing');
    // The starting note, the slide down, the low hold; the starting note again, the slide up, the high hold.
    const ends = [mid, low, low, mid, high, high];
    if (sung.length !== ends.length) throw new Error(`rangeSweep: the Range finder sings ${sung.length} steps, not ${ends.length}`);
    const sweep = (t: number): number => {
      const k = sung.findIndex((s) => t >= s.start && t < s.end);
      if (k < 0) return NaN;
      const s = sung[k];
      if (s.toMidi === undefined) return ends[k];
      return ends[k - 1] + (ends[k] - ends[k - 1]) * ((t - s.start) / (s.end - s.start));
    };
    return takeOf(realized, sweep, { seed: 3 });
  };

/** Sustained notes with a fault. */
const held =
  (o: VoiceFault): Rendition =>
  (realized) =>
    takeOf(realized, voice(realized.notes, { scoop: 20, ...o }));

/** Straight-to-bloom: vibrato (5.8 Hz, +/-35 c) starts `lag` seconds after each "vibrato wanted" window opens. */
const vibratoOnCue =
  (lag: number, alwaysOn = false): Rendition =>
  (realized) => {
    const plan = realized.vibratoPlan;
    const base = voice(realized.notes);
    return takeOf(
      realized,
      (t) => {
        const m = base(t);
        if (!Number.isFinite(m)) return m;
        const window = plan.find((c) => c.vibrato && t >= c.start && t < c.end);
        const from = alwaysOn ? 0 : window ? window.start + lag : Infinity;
        return t >= from ? m + 0.35 * Math.sin(2 * Math.PI * 5.8 * (t - from)) : m;
      },
      { seed: 6 },
    );
  };

/** Every run note sung distinct, on its own plateau. */
const distinctRun: Rendition = (realized) => takeOf(realized, voice(realized.notes, { release: 0.04 }), { seed: 7 });

/** The same run as one continuous slide through the note centres: every note smeared into the next. */
const smearedRun: Rendition = (realized) => {
  const ns = realized.notes;
  return takeOf(
    realized,
    (t) => {
      if (t < ns[0].start || t >= ns[ns.length - 1].end) return NaN;
      for (let i = 0; i < ns.length - 1; i++) {
        const c0 = (ns[i].start + ns[i].end) / 2;
        const c1 = (ns[i + 1].start + ns[i + 1].end) / 2;
        if (t >= c0 && t < c1) return ns[i].midi + (ns[i + 1].midi - ns[i].midi) * ((t - c0) / (c1 - c0));
      }
      return ns[ns.length - 1].midi;
    },
    { seed: 7 },
  );
};

/** A swell on each held note (soft -> loud -> soft by default); `driftCentsPerDb` makes the pitch follow the loudness. */
const swell =
  (o: { soft?: number; loud?: number; driftCentsPerDb?: number } = {}): Rendition =>
  (realized) => {
    const soft = o.soft ?? -38;
    const loud = o.loud ?? -14;
    const db = (t: number): number => {
      const n = realized.notes.find((x) => t >= x.start && t < x.end);
      if (!n) return -80;
      const u = (t - n.start) / (n.end - n.start);
      return soft + (loud - soft) * (1 - Math.abs(2 * u - 1));
    };
    const base = voice(realized.notes);
    return takeOf(realized, (t) => base(t) + ((o.driftCentsPerDb ?? 0) * (db(t) + 38)) / 100, { rmsDb: db, seed: 8 });
  };

// ================================================================ the journey

let library: BundledLibrary;

/** The files that ship in public/songs (the index and the charts), as the static host would serve them. */
const SONG_FILES = import.meta.glob('../../public/songs/*', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;

/** A song the singer brings: eight sixteenth-note steps a second up a scale, then a held note. UltraStar text, as exported by any karaoke editor. */
const IMPORTED_CHART = `#VERSION:1.1.0
#TITLE:Quick Scale
#ARTIST:Nobody
#BPM:240
#GAP:0
: 0 2 0 la
: 2 2 2 la
: 4 2 4 la
: 6 2 5 la
: 8 2 7 la
: 10 2 9 la
: 12 2 11 la
: 14 2 12 la
- 16
: 20 8 12 ha
E
`;

beforeAll(async () => {
  // The bundled charts, loaded the way the app loads them: songs/index.json first, then each chart.
  const serve = async (url: string) => {
    const text = SONG_FILES[`../../public/songs/${url.split('/songs/')[1]}`];
    return { ok: text !== undefined, status: text !== undefined ? 200 : 404, text: async () => text ?? '' };
  };
  library = await loadBundledLibrary({ fetch: serve, baseUrl: '/pitch-lab/', store: null });
});

afterAll(() => {
  vi.unstubAllGlobals();
});

/** Which bundled songs the progression has opened, by id. */
const openSongs = (s: ProgressSnapshot): string[] => library.songs.filter((song) => isSongUnlocked(song.difficulty.requiredWorld, s, WORLDS)).map((song) => song.id);

describe('the catalog and the engines are wired together', () => {
  it('exports the worlds and exercises the progression reads, and the catalog validates', () => {
    expect(WORLDS.map((w) => w.id)).toEqual(['foundations', 'vibrato', 'inflections', 'runs', 'dynamics', 'song-stage']);
    expect(CATALOG.worlds).toBe(WORLDS);
    expect(CATALOG.exercises).toBe(EXERCISES);
    expect(new Set(EXERCISES.map((e) => e.id)).size).toBe(EXERCISES.length);
    for (const level of ALL_LEVELS) expect(getExercise(level.exerciseId), level.id).toBeDefined();
    for (const w of WORLDS) for (const id of w.audition?.exerciseIds ?? []) expect(getExercise(id), id).toBeDefined();
    expect(validateCatalog(CATALOG)).toEqual([]);
  });

  it('gates the bundled songs on worlds that exist, and every starter song loads', () => {
    expect(library.errors).toEqual([]);
    expect(library.songs.map((s) => s.id).sort()).toEqual(
      ['amazing-grace', 'auld-lang-syne', 'ave-maria', 'be-thou-my-vision', 'danny-boy', 'holy-holy-holy', 'it-is-well', 'o-holy-night', 'panis-angelicus', 'silent-night', 'the-holy-city', 'twinkle-twinkle'].sort(),
    );
    for (const song of library.songs) expect(bossOf(song.difficulty.requiredWorld), song.id).toBeDefined();
  });
});

describe('a tenor from first launch to the last Boss Recital', () => {
  let studio: Studio;
  /** Outcomes the later steps look back at. */
  const kept: Record<string, Outcome> = {};
  /** The song the singer imported (rated Runs & Riffs). */
  let imported: Song;

  beforeAll(async () => {
    studio = await Studio.open('Daniel');
  }, 60_000);

  // ---------------------------------------------------------------- first launch

  it('starts with only the first level open: everything else is earned, deep links included', () => {
    const s = studio.snapshot;
    expect(s.worldsUnlocked).toEqual(['foundations']);
    expect(s.features).toEqual(['live.basic', 'export']);
    expect(statusesOf(s, 'foundations')).toEqual(['current', ...Array(12).fill('locked')]);
    expect(s.momentum).toBe(0);
    expect(s.lastPracticeDay).toBeNull();

    // Locked means refused, with a one-line reason; there is no way around it by id.
    expect(isLevelOpenable('foundations.01', s)).toBe(true);
    for (const level of ALL_LEVELS.slice(1)) {
      expect(isLevelOpenable(level.id, s), level.id).toBe(false);
      expect(isExerciseOpenable(level.exerciseId, s, WORLDS), level.exerciseId).toBe(false);
    }
    expect(levelRequirementHint('foundations.02', s, WORLDS)).toBe('Pass Range finder to unlock.');
    expect(levelRequirementHint('vibrato.01', s, WORLDS)).toBe('Pass the Foundations Boss Recital to unlock Vibrato.');
    expect(isExerciseOpenable('imported.pack.exercise', s, WORLDS)).toBe(false);
    expect(openSongs(s)).toEqual([]);
    expect(continueLevel(s, WORLDS)?.id).toBe('foundations.01');
  });

  it('a second profile on the same device has its own, untouched progress', async () => {
    const beginner = await studio.storage.profiles.create({ name: 'Beginner', voiceType: 'other' });
    const fresh = computeSnapshot(beginner.id, WORLDS, await studio.storage.attempts.listByProfile(beginner.id), studio.now, { getExercise });
    expect(fresh.worldsUnlocked).toEqual(['foundations']);
    expect(statusesOf(fresh, 'foundations')[0]).toBe('current');
    expect((await studio.storage.profiles.list()).map((p) => p.name)).toEqual(['Daniel', 'Beginner']);
    expect(await studio.storage.profiles.activeId()).toBe(studio.profile.id); // creating a profile does not switch to it
  });

  // ---------------------------------------------------------------- Foundations

  it('the Range finder: a timid take fails, the real sweep passes, and the measured range is saved', async () => {
    const level = levelOf('foundations.01');
    const def = exerciseOf(level.exerciseId);

    // Before a range is saved, exercises realize in the tenor default.
    const unsaved = realize(def, null, 'tenor');
    expect(unsaved.range).toEqual({ low: 48, high: 69 });

    const timid = await studio.singLevel('foundations.01', (r, d) => rangeSweep(r.tonicMidi - 2, r.tonicMidi + 3)(r, d));
    expect(timid.analysis.metrics['range.spanSemitones']).toBe(5);
    expect(timid.evaluation.passed).toBe(false);
    expect(timid.attempt).toMatchObject({ kind: 'practice', levelId: level.id, passed: false, mastery: 0 });
    expect(timid.snapshot.levels[level.id]).toMatchObject({ status: 'current', attempts: 1, passedAt: null });
    expect(timid.snapshot.features).toEqual(['live.basic', 'export']);

    const sweep = await studio.findRange();
    kept.range = sweep;
    expect(sweep.analysis.details.range).toMatchObject({ lowestMidi: TENOR_LOW, highestMidi: TENOR_HIGH });
    expect(sweep.analysis.metrics['range.spanSemitones']).toBe(TENOR_HIGH - TENOR_LOW);
    expect(sweep.evaluation).toMatchObject({ passed: true, mastery: 3 });
    expect(sweep.attempt).toMatchObject({ passed: true, mastery: 3, tempoBpm: 60 });
    expect(sweep.snapshot.levels[level.id]).toMatchObject({ status: 'passed', attempts: 2, mastery: 3, viaAudition: false });
    expect(sweep.snapshot.levels['foundations.02'].status).toBe('current');

    // The saved range: comfortable trimmed inside the extremes, kept on the profile.
    expect(studio.profile.range).toMatchObject({ extended: { low: 45, high: 72 }, comfortable: { low: 47, high: 69 } });
    const stored = await studio.storage.profiles.get(studio.profile.id);
    expect(stored?.range).toEqual(studio.profile.range);

    // The first passed level opens the dashboard, the daily workout and personal records.
    for (const id of ['dashboard', 'daily-workout', 'records'] as const) expect(isFeatureUnlocked(id, sweep.snapshot), id).toBe(true);
    expect(isFeatureUnlocked('live.cracks', sweep.snapshot)).toBe(false);
  });

  it('every exercise now realizes inside the saved range: material in the comfortable range, only range work in the extended one', () => {
    const range = studio.profile.range!;
    for (const def of EXERCISES) {
      const r = realize(def, range, 'tenor');
      const allowed = usesExtendedRange(def) ? range.extended : range.comfortable;
      expect(r.fit, def.id).toBe('fits'); // a 27-semitone voice has room for all of it: nothing moved to the extended range, nothing folded by octaves
      expect(r.range, def.id).toEqual(allowed);
      for (const n of [...r.notes, ...r.reference]) {
        for (const m of n.toMidi === undefined ? [n.midi] : [n.midi, n.toMidi]) {
          expect(m, `${def.id}: ${m}`).toBeGreaterThanOrEqual(allowed.low);
          expect(m, `${def.id}: ${m}`).toBeLessThanOrEqual(allowed.high);
        }
      }
    }
    // The tenor's passaggio exercises sit where a tenor's break is (D4-G4), not at the bottom of the range.
    const swell = realize(exerciseOf('dynamics.audition.3'), range, 'tenor');
    expect(swell.notes[0].midi).toBeGreaterThanOrEqual(62);
    expect(swell.notes[0].midi).toBeLessThanOrEqual(67);
  });

  it('Match one note is the next level and passes with clean singing', async () => {
    const o = await studio.singLevel('foundations.02');
    expect(o.evaluation.passed).toBe(true);
    expect(o.snapshot.levels['foundations.02']).toMatchObject({ status: 'passed', attempts: 1 });
    expect(o.snapshot.levels['foundations.03'].status).toBe('current');
    // The app played each note before the singer sang it, and nothing while they sang.
    expect(o.realized.reference.map((r) => r.midi)).toEqual(o.realized.notes.map((n) => n.midi));
    o.realized.reference.forEach((r, i) => expect(r.end).toBeLessThan(o.realized.notes[i].start));
  });

  it('Hold it: a take 60 cents sharp fails with a coaching tip, and the next level stays shut', async () => {
    const poor = await studio.singLevel('foundations.03', held({ bias: 60 }), { keepTake: {} });
    kept.sustainPoor = poor;
    expect(poor.evaluation.passed).toBe(false);
    expect(poor.attempt).toMatchObject({ kind: 'practice', levelId: 'foundations.03', passed: false, mastery: 0 });
    expect(poor.snapshot.levels['foundations.03']).toMatchObject({ status: 'current', attempts: 1, mastery: 0, passedAt: null });
    expect(poor.snapshot.levels['foundations.03'].bestScore).toBeCloseTo(poor.evaluation.score, 6);
    expect(poor.snapshot.levels['foundations.13'].status).toBe('locked');
    expect(poor.tip.id).toBe('acc.sharp');
    expect(poor.tip.text).toMatch(/sharp/);
    expect(poor.attempt.takeId).not.toBeNull();
  });

  it('Hold it: metricsFromResults and scoreExercise agree with what the runner path recorded', async () => {
    // The same take, analyzed the long way round: one analyzer, then the generic aggregation and scorer.
    const def = exerciseOf('foundations.hold.1');
    const realized = realize(def, studio.profile.range, 'tenor');
    const take = await recordTake(held({ bias: 35, wobble: 25 })(realized, def));
    const ctx = { toleranceCents: 50, vibratoStyle: 'pop' as const };
    const results = realized.notes.map((n) => analyzeAccuracy(take.track, n, ctx));
    const long = metricsFromResults({ accuracy: results });
    const viaRunner = analyzeTake(def, realized, take.track, { vibratoStyle: 'pop' });
    for (const [metric, value] of Object.entries(long) as Array<[keyof typeof long, number]>) expect(viaRunner.metrics[metric], metric).toBeCloseTo(value, 9);
    const outcome = scoreExercise(def, long);
    expect(outcome.terms.map((t) => t.metric)).toEqual(def.scoring.map((t) => t.metric));
    expect(outcome.score).toBeCloseTo(evaluate(def, viaRunner.metrics).score, 12);
    expect(outcome.terms.every((t) => t.value !== null)).toBe(true);
  });

  it('Hold it: a modest take passes with one tally light and opens Hold it steady', async () => {
    const modest = await studio.singLevel('foundations.03', held({ bias: 32 }));
    expect(modest.evaluation.passed).toBe(true);
    expect(modest.evaluation.mastery).toBe(1);
    expect(modest.attempt).toMatchObject({ passed: true, mastery: 1 });
    expect(modest.snapshot.levels['foundations.03']).toMatchObject({ status: 'passed', mastery: 1, attempts: 2, viaAudition: false });
    expect(modest.snapshot.levels['foundations.03'].passedAt).toBe(modest.attempt.createdAt);
    expect(modest.snapshot.levels['foundations.13'].status).toBe('current');
    expect(statusesOf(modest.snapshot, 'foundations').slice(0, 5)).toEqual(['passed', 'passed', 'passed', 'current', 'locked']);
  });

  it('Hold it: replaying for mastery lifts the tally to studio, and a worse replay takes nothing back', async () => {
    const solid = await studio.singLevel('foundations.03', held({ bias: 24 }));
    expect(solid.evaluation.mastery).toBe(2);
    expect(solid.snapshot.levels['foundations.03'].mastery).toBe(2);

    const polished = await studio.singLevel('foundations.03', held({ bias: 2 }), { keepTake: {} });
    kept.sustainPolished = polished;
    expect(polished.evaluation).toMatchObject({ passed: true, mastery: 3 });
    expect(polished.snapshot.levels['foundations.03']).toMatchObject({ status: 'passed', mastery: 3, attempts: 4 });
    expect(polished.snapshot.levels['foundations.03'].bestScore).toBeGreaterThan(0.95);

    const worse = await studio.singLevel('foundations.03', held({ bias: 60 }));
    expect(worse.evaluation.passed).toBe(false);
    expect(worse.snapshot.levels['foundations.03']).toMatchObject({ status: 'passed', mastery: 3, attempts: 5 }); // never re-locks, never lowers
    expect(worse.snapshot.levels['foundations.13'].status).toBe('current');
  });

  it('personal records hold the best value of the passed takes only', async () => {
    const s = await studio.refresh();
    const records = recordsForExercise(s, 'foundations.hold.1');
    expect(records.length).toBeGreaterThan(0);
    const passedIds = new Set(studio.written.filter((a) => a.exerciseId === 'foundations.hold.1' && a.passed).map((a) => a.id));
    for (const r of records) expect(passedIds.has(r.attemptId), `${r.metric} came from a passed attempt`).toBe(true);
    // The closest and the most-in-tune PASSED takes hold those records (a smaller typical miss and a higher in-tune % are better).
    const passed = studio.written.filter((a) => a.exerciseId === 'foundations.hold.1' && a.passed);
    const best = (metric: 'accuracy.medianAbsCents' | 'accuracy.inTolerancePct', pick: (...v: number[]) => number) => pick(...passed.map((a) => a.metrics[metric]!));
    expect(records.find((r) => r.metric === 'accuracy.medianAbsCents')!.value).toBeCloseTo(best('accuracy.medianAbsCents', Math.min), 9);
    expect(records.find((r) => r.metric === 'accuracy.inTolerancePct')!.value).toBeCloseTo(best('accuracy.inTolerancePct', Math.max), 9);
    expect(records.find((r) => r.metric === 'accuracy.inTolerancePct')!.value).toBeGreaterThan(95);
    // The failed takes (a sharp 60 cents) hold no record at all, however they scored on one metric.
    const failedIds = new Set(studio.written.filter((a) => a.exerciseId === 'foundations.hold.1' && !a.passed).map((a) => a.id));
    expect(records.some((r) => failedIds.has(r.attemptId))).toBe(false);
  });

  it('a saved take replays: the stored pitch track analyzes to the same verdict', async () => {
    const saved = kept.sustainPolished;
    const record = await studio.storage.takes.get(saved.attempt.takeId!);
    expect(record).toMatchObject({ exerciseId: 'foundations.hold.1', profileId: studio.profile.id, latencyMs: ROUND_TRIP_MS });
    const replayed = decodeTrack(record!.track);
    expect(replayed).toHaveLength(saved.take.track.length);
    expect(replayed[0].t).toBeCloseTo(saved.take.track[0].t, 9);
    const again = analyzeTake(saved.def, saved.realized, replayed, { vibratoStyle: 'pop' });
    const verdict = evaluate(saved.def, again.metrics);
    expect(verdict.passed).toBe(saved.evaluation.passed);
    expect(verdict.mastery).toBe(saved.evaluation.mastery);
    expect(verdict.score).toBeCloseTo(saved.evaluation.score, 3);
  });

  it('Hold it steady: a wobbly take fails on the wobble with the steadiness tip; a level one passes and opens the step lesson, numbered 10', async () => {
    const wobbly = await studio.singLevel('foundations.13', held({ wobble: 45 }));
    expect(wobbly.evaluation.passed).toBe(false);
    expect(wobbly.evaluation.failedGates.map((i) => wobbly.def.pass.gates![i].metric)).toContain('accuracy.sdCents');
    expect(wobbly.tip.id).toBe('acc.unstable');
    expect(wobbly.snapshot.levels['foundations.10'].status).toBe('locked');

    const level = await studio.singLevel('foundations.13');
    expect(level.evaluation.passed).toBe(true);
    expect(level.analysis.metrics['accuracy.sdCents']).toBeLessThan(15);
    // The order is the lessons' (LevelDef.index), not the persisted numbers: 13 opens 10, and 05 is still far off.
    expect(level.snapshot.levels['foundations.10'].status).toBe('current');
    expect(level.snapshot.levels['foundations.05'].status).toBe('locked');
  });

  it('Two notes, a jump apart: sliding up into the landing fails on how slowly it lands; jumping straight to it passes', async () => {
    const step = await studio.singLevel('foundations.10');
    expect(step.evaluation.passed).toBe(true);
    expect(step.snapshot.levels['foundations.07'].status).toBe('current');

    const sliding = await studio.singLevel('foundations.07', singer({ scoopCents: 150, settleTauMs: 260 }));
    expect(sliding.evaluation.passed).toBe(false);
    expect(sliding.evaluation.failedGates.map((i) => sliding.def.pass.gates![i].metric)).toContain('onset.settleMs');
    expect(sliding.snapshot.levels['foundations.08'].status).toBe('locked');

    const straight = await studio.singLevel('foundations.07');
    expect(straight.evaluation.passed).toBe(true);
    expect(straight.snapshot.levels['foundations.08'].status).toBe('current');
  });

  it('bigger jumps, do-re-mi, five notes in a row and small slides pass in order, each opening the next', async () => {
    const order: Array<[string, string]> = [
      ['foundations.08', 'foundations.11'],
      ['foundations.11', 'foundations.09'],
      ['foundations.09', 'foundations.12'],
      ['foundations.12', 'foundations.05'],
    ];
    for (const [id, next] of order) {
      const o = await studio.singLevel(id);
      expect(o.evaluation.passed, id).toBe(true);
      expect(o.snapshot.levels[next].status, `${id} opens ${next}`).toBe('current');
    }
    expect(isFeatureUnlocked('live.cracks', studio.snapshot)).toBe(false);
  });

  it('Sirens: a siren that keeps cracking fails and every crack is marked; one crack still passes and opens the crack markers', async () => {
    // The voice cuts out for 60 ms in the middle of a glide: in every glide of the siren, then in just one.
    const glideMiddles = (realized: RealizedExercise): number[] => realized.notes.filter((n) => n.toMidi !== undefined).map((n) => (n.start + n.end) / 2);
    const breaking =
      (pick: (middles: number[]) => number[]): Rendition =>
      (realized) =>
        singTake(realized, { ...GOOD_SINGER, breaks: pick(glideMiddles(realized)) });

    const broken = await studio.singLevel('foundations.05', breaking((m) => m));
    const middles = glideMiddles(broken.realized);
    expect(middles.length).toBeGreaterThanOrEqual(5);
    expect(broken.analysis.metrics['glide.cracks']).toBe(middles.length);
    for (const at of middles) expect(broken.analysis.details.cracks.some((c) => Math.abs(c.t - at) < 0.1), `a crack is marked near ${at.toFixed(1)} s`).toBe(true);
    expect(broken.evaluation.passed).toBe(false);
    expect(isFeatureUnlocked('live.cracks', broken.snapshot)).toBe(false);
    expect(broken.snapshot.levels['foundations.06'].status).toBe('locked');

    // One crack is marked and costs score, but a developing voice still passes (the level is calibrated for it).
    const once = await studio.singLevel('foundations.05', breaking((m) => [m[2]]));
    expect(once.analysis.details.cracks).toHaveLength(1);
    expect(once.analysis.metrics['glide.cracks']).toBe(1);
    expect(once.evaluation.passed).toBe(true);
    expect(isFeatureUnlocked('live.cracks', once.snapshot)).toBe(true); // passing Sirens opens the markers
    expect(isFeatureUnlocked('live.onset', once.snapshot)).toBe(false);
    expect(once.snapshot.levels['foundations.06'].status).toBe('current');

    const clean = await studio.singLevel('foundations.05');
    expect(clean.analysis.details.cracks).toEqual([]);
    expect(clean.evaluation.passed).toBe(true);
    expect(clean.evaluation.score).toBeGreaterThan(once.evaluation.score);
    expect(clean.evaluation.mastery).toBeGreaterThanOrEqual(once.evaluation.mastery);
    expect(clean.snapshot.levels['foundations.05'].mastery).toBe(Math.max(once.evaluation.mastery, clean.evaluation.mastery));
  });

  it('Clean starts: a scooped take fails with the SPEC tip, the clean one opens the start readouts', async () => {
    const scooped = await studio.singLevel('foundations.06', singer({ scoopCents: 120, settleTauMs: 120 }));
    expect(scooped.evaluation.passed).toBe(false);
    expect(scooped.tip.id).toBe('onset.scoop-big');
    expect(scooped.tip.text).toContain('Start the note on the pitch');
    expect(isFeatureUnlocked('live.onset', scooped.snapshot)).toBe(false);

    const crisp = await studio.singLevel('foundations.06');
    expect(crisp.evaluation.passed).toBe(true);
    expect(crisp.analysis.metrics['onset.scoopCents']).toBeLessThan(30);
    expect(isFeatureUnlocked('live.onset', crisp.snapshot)).toBe(true);
    expect(isFeatureUnlocked('live.vibrato', crisp.snapshot)).toBe(false);
    expect(crisp.snapshot.worldsUnlocked).toEqual(['foundations']);
  });

  it('the Foundations Boss Recital opens Vibrato, Song Stage and the starter songs, and only after the earlier levels', async () => {
    expect(studio.snapshot.levels['foundations.boss'].status).toBe('current');
    expect(statusesOf(studio.snapshot, 'foundations')).toEqual([...Array(12).fill('passed'), 'current']);
    expect(isWorldUnlocked('vibrato', studio.snapshot)).toBe(false);
    expect(openSongs(studio.snapshot)).toEqual([]);

    const off = await studio.singLevel('foundations.boss', singer({ offsetSemis: 2 }));
    expect(off.evaluation.passed).toBe(false);
    expect(off.attempt.kind).toBe('boss');
    expect(isWorldUnlocked('vibrato', off.snapshot)).toBe(false);

    const boss = await studio.singLevel('foundations.boss');
    expect(boss.attempt).toMatchObject({ kind: 'boss', levelId: 'foundations.boss', passed: true });
    expect(boss.evaluation.passed).toBe(true);
    const s = boss.snapshot;
    expect(s.worldsUnlocked).toEqual(['foundations', 'vibrato', 'song-stage']);
    for (const id of ['live.vibrato', 'tool.vibrato-meter', 'setting.vibratoStyle', 'song-stage', 'song.import'] as const) expect(isFeatureUnlocked(id, s), id).toBe(true);
    expect(s.levels['vibrato.01'].status).toBe('current');
    expect(isLevelOpenable('vibrato.02', s)).toBe(false);
    expect(isWorldUnlocked('inflections', s)).toBe(false);
    expect(continueLevel(s, WORLDS)?.id).toBe('vibrato.01');

    // Songs open with the world their difficulty needs: the Foundations-rated ones now, nothing harder.
    expect(openSongs(s).sort()).toEqual(['auld-lang-syne', 'the-holy-city', 'twinkle-twinkle']);
    expect(library.songs.find((x) => x.id === 'ave-maria')!.difficulty.requiredWorld).toBe('runs');
    studio.nextDay();
  });

  it('importing your own song opens with the Foundations boss; it is rated by its difficulty and stays shut until that world is passed', async () => {
    expect(isFeatureUnlocked('song.import', studio.snapshot)).toBe(true);
    const { song, warnings } = parseUltraStar(IMPORTED_CHART);
    expect(warnings).toEqual([]);
    expect(song.source).toBe('ultrastar');
    expect(song.difficulty.requiredWorld).toBe('runs'); // eight notes a second in a chain: that is Runs & Riffs material

    const saved = await studio.storage.songs.import(studio.profile.id, song);
    expect(saved.song).toEqual(song); // the chart survives IndexedDB intact
    expect((await studio.storage.songs.import(studio.profile.id, song)).id).toBe(saved.id); // the same file again refreshes it
    expect(await studio.storage.songs.listByProfile(studio.profile.id)).toHaveLength(1);

    expect(isSongUnlocked(song.difficulty.requiredWorld, studio.snapshot, WORLDS)).toBe(false);
    expect(songRequirementHint('runs', studio.snapshot, WORLDS)).toBe('Pass the Runs & Riffs Boss Recital to unlock this song.');
    imported = song;
  });

  // ---------------------------------------------------------------- Vibrato: an audition, then straight-to-bloom

  it('a Vibrato audition skips levels inside the open world, stops at the first miss, and never reaches the boss', async () => {
    expect(isAuditionAvailable('vibrato', studio.snapshot, WORLDS)).toBe(true);
    expect(nextAuditionExercise('vibrato', studio.snapshot, WORLDS)).toBe('vibrato.audition.1');
    expect(isExerciseOpenable('inflections.audition.1', studio.snapshot, WORLDS)).toBe(false); // another world: closed

    const [pulses] = await studio.auditionRun('vibrato', good, 1);
    expect(pulses.attempt).toMatchObject({ kind: 'audition', levelId: null, exerciseId: 'vibrato.audition.1', passed: true });
    const afterOne = pulses.snapshot;
    expect(statusesOf(afterOne, 'vibrato').slice(0, 5)).toEqual(['passed', 'passed', 'passed', 'passed', 'current']);
    for (const id of ['vibrato.01', 'vibrato.02', 'vibrato.03', 'vibrato.04']) {
      expect(afterOne.levels[id]).toMatchObject({ viaAudition: true, mastery: 1, attempts: 0, status: 'passed' });
    }

    // Test 2 sung with a straight tone: missed, so the run stops, and nothing earned is taken back.
    expect(nextAuditionExercise('vibrato', afterOne, WORLDS)).toBe('vibrato.audition.2');
    const straight = await studio.singAudition('vibrato.audition.2', singer({ vibrato: null }));
    expect(straight.evaluation.passed).toBe(false);
    expect(straight.attempt.passed).toBe(false);
    expect(statusesOf(straight.snapshot, 'vibrato').slice(0, 5)).toEqual(['passed', 'passed', 'passed', 'passed', 'current']);

    const retake = await studio.singAudition('vibrato.audition.2');
    expect(retake.evaluation.passed).toBe(true);
    const s = retake.snapshot;
    expect(statusesOf(s, 'vibrato')).toEqual([...Array(6).fill('passed'), 'current', 'locked', 'locked']); // 01-06 granted, bloom next, boss still shut
    expect(s.levels['vibrato.boss'].status).toBe('locked');
    expect(isWorldUnlocked('inflections', s)).toBe(false);
    expect(s.worldsUnlocked).toEqual(['foundations', 'vibrato', 'song-stage']);
    expect(nextAuditionExercise('vibrato', s, WORLDS)).toBe('vibrato.audition.3');
  });

  it('Straight to bloom: vibrato that is late or never switches off fails; blooming on the cue passes', async () => {
    const level = levelOf('vibrato.07');
    expect(studio.snapshot.levels[level.id].status).toBe('current');
    const def = exerciseOf(level.exerciseId);
    expect(realize(def, studio.profile.range, 'tenor').vibratoPlan).toEqual([
      expect.objectContaining({ vibrato: false }),
      expect.objectContaining({ vibrato: true }),
      expect.objectContaining({ vibrato: false }),
      expect.objectContaining({ vibrato: true }),
      expect.objectContaining({ vibrato: false }),
      expect.objectContaining({ vibrato: true }),
    ]);

    const late = await studio.singLevel(level.id, vibratoOnCue(1.0));
    expect(late.analysis.metrics['vibrato.bloomOnCue']).toBeLessThan(0.5);
    expect(late.evaluation.passed).toBe(false);
    expect(late.snapshot.levels[level.id]).toMatchObject({ status: 'current', attempts: 1 });

    const always = await studio.singLevel(level.id, vibratoOnCue(0, true));
    expect(always.analysis.metrics['vibrato.present']).toBe(1); // it is vibrato, but it ignores the Straight cues
    expect(always.analysis.metrics['vibrato.switchCleanRate']).toBeLessThan(0.5);
    expect(always.evaluation.passed).toBe(false);

    const never = await studio.singLevel(level.id, singer({ vibrato: null })); // a straight tone all the way: it never blooms
    expect(never.analysis.metrics['vibrato.present'] ?? 0).toBe(0);
    expect(never.analysis.metrics['vibrato.bloomOnCue'] ?? 0).toBe(0);
    expect(never.evaluation.passed).toBe(false);

    const bloom = await studio.singLevel(level.id, vibratoOnCue(0.2));
    expect(bloom.analysis.metrics['vibrato.bloomOnCue']).toBeGreaterThan(0.9);
    expect(bloom.analysis.metrics['vibrato.rateHz']).toBeGreaterThan(5);
    expect(bloom.analysis.metrics['vibrato.rateHz']).toBeLessThan(7);
    expect(bloom.evaluation).toMatchObject({ passed: true, mastery: 3 });
    expect(bloom.snapshot.levels[level.id]).toMatchObject({ status: 'passed', attempts: 4, viaAudition: false });
    expect(bloom.snapshot.levels['vibrato.08'].status).toBe('current');
  });

  it('the Vibrato Boss Recital opens Inflections', async () => {
    expect((await studio.singLevel('vibrato.08')).evaluation.passed).toBe(true);
    const boss = await studio.singLevel('vibrato.boss');
    expect(boss.evaluation.passed).toBe(true);
    const s = boss.snapshot;
    expect(isWorldUnlocked('inflections', s)).toBe(true);
    expect(s.levels['inflections.01'].status).toBe('current');
    expect(isWorldUnlocked('runs', s)).toBe(false);
    expect(openSongs(s).sort()).toEqual(['amazing-grace', 'auld-lang-syne', 'holy-holy-holy', 'it-is-well', 'o-holy-night', 'panis-angelicus', 'the-holy-city', 'twinkle-twinkle']);
    studio.nextDay();
  });

  // ---------------------------------------------------------------- Inflections: an audition run with a miss in the middle

  it('Inflections: an audition run fails on a wrong note, resumes at the same test, and still leaves the boss to be sung', async () => {
    const [t1, t2] = await studio.auditionRun('inflections', good, 2);
    expect([t1.attempt.passed, t2.attempt.passed]).toEqual([true, true]);
    expect(nextAuditionExercise('inflections', t2.snapshot, WORLDS)).toBe('inflections.audition.3');

    const wrong = await studio.singAudition('inflections.audition.3', singer({ offsetSemis: 2 }));
    expect(wrong.attempt.passed).toBe(false);
    expect(nextAuditionExercise('inflections', wrong.snapshot, WORLDS)).toBe('inflections.audition.3'); // resume where it stopped
    expect(statusesOf(wrong.snapshot, 'inflections').slice(0, 5)).toEqual(['passed', 'passed', 'passed', 'passed', 'current']);

    const rest = await studio.auditionRun('inflections');
    expect(rest.map((o) => o.def.id)).toEqual(['inflections.audition.3', 'inflections.audition.4']);
    expect(rest.every((o) => o.attempt.passed)).toBe(true);
    const s = rest[rest.length - 1].snapshot;
    expect(statusesOf(s, 'inflections')).toEqual([...Array(8).fill('passed'), 'current']);
    expect(nextAuditionExercise('inflections', s, WORLDS)).toBeNull(); // nothing left for the audition to unlock
    expect(isWorldUnlocked('runs', s)).toBe(false); // the boss is always required to leave a world

    const boss = await studio.singLevel('inflections.boss');
    expect(boss.evaluation.passed).toBe(true);
    expect(isWorldUnlocked('runs', boss.snapshot)).toBe(true);
    expect(openSongs(boss.snapshot).sort()).toEqual([
      'amazing-grace',
      'auld-lang-syne',
      'be-thou-my-vision',
      'danny-boy',
      'holy-holy-holy',
      'it-is-well',
      'o-holy-night',
      'panis-angelicus',
      'silent-night',
      'the-holy-city',
      'twinkle-twinkle',
    ]);
    studio.nextDay();
  });

  // ---------------------------------------------------------------- Runs: pentatonic at 6 notes a second

  it('Runs: the tempo ladder climbs 3, 4.5, 6 notes a second, and only the pass tempo passes the level', async () => {
    const [first] = await studio.auditionRun('runs', good, 1);
    expect(first.attempt.passed).toBe(true);
    expect(first.snapshot.levels['runs.02'].viaAudition).toBe(true);
    expect(first.snapshot.levels['runs.03'].status).toBe('current');

    const level = levelOf('runs.03');
    const def = exerciseOf(level.exerciseId);
    expect(ladderOf(def)).toEqual([45, 68, 90]); // 3, 4.5 and 6 notes a second as sixteenths
    expect(def.tempoBpm).toBe(90);

    const sung: number[] = [];
    let bpm = startTempo(def);
    for (;;) {
      const o = await studio.singLevel(level.id, distinctRun, { bpm });
      sung.push(bpm);
      expect(o.realized.bpm).toBe(bpm);
      expect(o.evaluation.passed, `${bpm} bpm was sung well`).toBe(true);
      expect(o.attempt.tempoBpm).toBe(bpm);
      expect(o.attempt.passed, `${bpm} bpm counts as a pass only at the pass tempo`).toBe(isPassTempo(def, bpm));
      if (bpm >= def.tempoBpm) {
        expect(o.snapshot.levels[level.id].status).toBe('passed');
        break;
      }
      expect(o.snapshot.levels[level.id]).toMatchObject({ status: 'current', mastery: 0 });
      const next = nextTempo(def, bpm, o.analysis.metrics);
      expect(next).toBeGreaterThan(bpm);
      bpm = next;
    }
    expect(sung).toEqual([45, 68, 90]);
    expect(studio.snapshot.levels['runs.04'].status).toBe('current');
    // However the runner wrote them, no lower rung ever passed.
    const lower = studio.written.filter((a) => a.exerciseId === def.id && (a.tempoBpm ?? 0) < def.tempoBpm);
    expect(lower).toHaveLength(2);
    expect(lower.every((a) => !a.passed && a.mastery === 0)).toBe(true);
  });

  it('Runs: smeared notes at 6 a second fail with a note-by-note verdict, defined notes pass', async () => {
    // Re-sing the level at tempo as a replay: the smeared take cannot undo the pass, but its verdict is exact.
    const smeared = await studio.singLevel('runs.03', smearedRun);
    expect(smeared.evaluation.passed).toBe(false);
    expect(smeared.analysis.metrics['run.definedRate']).toBeLessThan(0.7);
    expect(smeared.tip.id).toBe('run.smeared');
    const verdicts = smeared.analysis.details.runs.flatMap((r) => r.result.notes.map((n) => n.verdict));
    expect(verdicts).toHaveLength(15); // 3 repeats of a 5-note run
    expect(verdicts.filter((v) => v === 'defined').length).toBeLessThan(verdicts.length);

    const defined = await studio.singLevel('runs.03', distinctRun);
    const clean = defined.analysis.details.runs.flatMap((r) => r.result.notes.map((n) => n.verdict));
    expect(clean.every((v) => v === 'defined')).toBe(true);
    expect(defined.snapshot.levels['runs.03']).toMatchObject({ status: 'passed', mastery: 3 });
  });

  it('the rest of the Runs world by audition, then the boss at its own pass tempo opens Dynamics', async () => {
    const rest = await studio.auditionRun('runs');
    expect(rest.map((o) => o.def.id)).toEqual(['runs.audition.2', 'runs.audition.3']);
    expect(rest.every((o) => o.attempt.passed)).toBe(true);
    const s = rest[rest.length - 1].snapshot;
    expect(statusesOf(s, 'runs')).toEqual([...Array(8).fill('passed'), 'current']);
    expect(s.levels['runs.03'].viaAudition).toBe(false); // played through, not granted
    expect(s.levels['runs.04'].viaAudition).toBe(true);
    expect(isWorldUnlocked('dynamics', s)).toBe(false);

    const bossDef = exerciseOf(levelOf('runs.boss').exerciseId);
    const boss = await studio.singLevel('runs.boss'); // default tempo = the boss's pass tempo
    expect(boss.realized.bpm).toBe(bossDef.tempoBpm);
    expect(boss.evaluation.passed).toBe(true);
    expect(isWorldUnlocked('dynamics', boss.snapshot)).toBe(true);
    expect(openSongs(boss.snapshot)).toHaveLength(library.songs.length); // Ave Maria (rated Runs) is the last to open
    expect(isSongUnlocked(imported.difficulty.requiredWorld, boss.snapshot, WORLDS)).toBe(true); // and so is the song the singer brought
    expect(isSongUnlocked(imported.difficulty.requiredWorld, rest[rest.length - 1].snapshot, WORLDS)).toBe(false); // one take earlier it was not
    studio.nextDay();
  });

  // ---------------------------------------------------------------- Dynamics: the swell

  it('Dynamics: no change in loudness, or pitch following loudness, fails the swell; a steady swell passes', async () => {
    const [grow] = await studio.auditionRun('dynamics', good, 1); // crescendo and decrescendo: levels 1-2 are granted
    expect(grow.attempt.passed).toBe(true);
    expect(studio.snapshot.levels['dynamics.03'].status).toBe('current');

    const level = levelOf('dynamics.03');
    const flat = await studio.singLevel(level.id, swell({ soft: -20, loud: -20 }));
    expect(flat.analysis.metrics['dynamics.rangeDb'] ?? 0).toBeLessThan(10);
    expect(flat.evaluation.passed).toBe(false);
    expect(flat.tip.id).toBe('dyn.range-small');

    const sharp = await studio.singLevel(level.id, swell({ driftCentsPerDb: 3 }));
    expect(sharp.analysis.metrics['dynamics.rangeDb']).toBeGreaterThan(15);
    expect(sharp.analysis.metrics['dynamics.absSlopeCentsPerDb']).toBeGreaterThan(2);
    expect(sharp.evaluation.passed).toBe(false);
    expect(sharp.tip.id).toBe('dyn.sharp-loud');

    const steady = await studio.singLevel(level.id, swell());
    expect(steady.analysis.metrics['dynamics.rangeDb']).toBeGreaterThan(20);
    expect(steady.analysis.metrics['dynamics.absSlopeCentsPerDb']).toBeLessThan(0.5);
    expect(steady.analysis.metrics['dynamics.symmetry']).toBeGreaterThan(0.9);
    expect(steady.evaluation).toMatchObject({ passed: true, mastery: 3 });
    expect(steady.snapshot.levels[level.id]).toMatchObject({ status: 'passed', attempts: 3 });
    expect(steady.snapshot.levels['dynamics.04'].status).toBe('current');
  });

  it('the last Boss Recital clears the game: every level, world, feature and song is open', async () => {
    const rest = await studio.auditionRun('dynamics');
    expect(rest.every((o) => o.attempt.passed)).toBe(true);
    expect(statusesOf(studio.snapshot, 'dynamics')).toEqual([...Array(6).fill('passed'), 'current']);

    const boss = await studio.singLevel('dynamics.boss');
    expect(boss.evaluation.passed).toBe(true);
    const s = boss.snapshot;
    expect(Object.values(s.levels).every((l) => l.status === 'passed')).toBe(true);
    expect(s.worldsUnlocked).toEqual(WORLDS.map((w) => w.id));
    expect(s.features).toEqual([...FEATURE_IDS]);
    expect(continueLevel(s, WORLDS)).toBeNull();
    expect(openSongs(s)).toHaveLength(library.songs.length);
    // Granted by an audition or played through, never both; no audition granted a Boss Recital, and Foundations was all sung.
    const granted = Object.values(s.levels).filter((l) => l.viaAudition).map((l) => l.levelId);
    expect(granted.sort()).toEqual(
      [
        ...['01', '02', '03', '04', '05', '06'].map((n) => `vibrato.${n}`),
        ...['01', '02', '03', '04', '05', '06', '07', '08'].map((n) => `inflections.${n}`),
        ...['01', '02', '04', '05', '06', '07', '08'].map((n) => `runs.${n}`),
        ...['01', '02', '04', '05', '06'].map((n) => `dynamics.${n}`),
      ].sort(),
    );
    expect(granted.some((id) => id.endsWith('.boss'))).toBe(false);
    expect(Object.values(s.levels).filter((l) => l.viaAudition === false && l.attempts === 0)).toEqual([]); // every other level was sung
  });

  // ---------------------------------------------------------------- songs

  it('a song take is scored by phrase, filed under the song, and changes no level', async () => {
    const song = library.songs.find((s) => s.id === 'twinkle-twinkle')!;
    expect(isSongUnlocked(song.difficulty.requiredWorld, studio.snapshot, WORLDS)).toBe(true);
    const fitted: Song = transposeSongToRange(song, studio.profile.range!);
    expect(fitted.difficulty.lowestMidi).toBeGreaterThanOrEqual(studio.profile.range!.extended.low);
    expect(fitted.difficulty.highestMidi).toBeLessThanOrEqual(studio.profile.range!.extended.high);
    const view = pitchedView(fitted);

    // Sung in time with the song and delayed by the route, as raw engine frames; scoreSongTake removes the latency.
    const sungNotes: TargetNote[] = view.notes.map((n) => ({ midi: n.midi, start: n.start, end: n.start + n.duration - 0.04 }));
    const songStart = DOWNBEAT;
    const frames = makeTrack({ duration: songDurationSec(fitted) + 1, midi: notesMidi(sungNotes), jitterCents: 5, seed: 21 }).map((f) => ({ ...f, t: f.t + songStart + ROUND_TRIP_MS / 1000 }));
    const phrases = scoreSongTake(frames, songStart, ROUND_TRIP_MS, view.notes, view.phrases, { toleranceCents: 25, vibratoStyle: 'pop' });
    expect(phrases).toHaveLength(view.phrases.length);
    const metrics = metricsFromResults({ phrases });
    expect(metrics['song.phraseScore']).toBeGreaterThan(0.85);
    expect(metrics['song.inTolerancePct']).toBeGreaterThan(80);
    expect(Math.abs(phrases[0].timingOffsetMs ?? 0)).toBeLessThan(60); // the latency was taken out, not blamed on the singer

    const before = JSON.stringify(studio.snapshot.levels);
    const fields = buildSongAttempt({ profileId: studio.profile.id, songId: song.id, score: metrics['song.phraseScore']!, passed: true, metrics, durationSec: songDurationSec(fitted), tonicMidi: fitted.notes[0].midi });
    const attempt = await studio.storage.attempts.add(fields);
    studio.written.push(attempt);
    const s = await studio.refresh();
    expect(JSON.stringify(s.levels)).toBe(before);
    expect(attempt).toMatchObject({ kind: 'song', songId: 'twinkle-twinkle', levelId: null, exerciseId: songExerciseId('twinkle-twinkle') });
    expect((await studio.storage.attempts.listByExercise(studio.profile.id, songExerciseId(song.id))).map((a) => a.id)).toEqual([attempt.id]);
    expect(Object.keys((await studio.storage.attempts.get(attempt.id))!.metrics).sort()).toEqual(['song.inTolerancePct', 'song.phraseScore']);
  });

  // ---------------------------------------------------------------- momentum

  it('Momentum grew over the days, rests are free, and a long break never resets it to zero', async () => {
    const s = await studio.refresh();
    expect(s.momentum).toBeGreaterThan(8);
    expect(s.momentum).toBeLessThanOrEqual(100);
    expect(s.lastPracticeDay).toBe(new Date(studio.written[studio.written.length - 1].createdAt).toISOString().slice(0, 10));

    const attempts = await studio.storage.attempts.listByProfile(studio.profile.id);
    const at = (days: number) => computeMomentum(attempts, new Date(studio.clock.ms + days * DAY_MS));
    expect(at(2)).toBeGreaterThanOrEqual(at(0) - 1e-9); // two rest days: healthy, no decay yet
    expect(at(30)).toBeLessThan(at(0));
    expect(at(400)).toBeGreaterThan(0); // never zero once the singer has practised
    // Every level stays passed through all of it: time never re-locks anything.
    const later = computeSnapshot(studio.profile.id, WORLDS, attempts, new Date(studio.clock.ms + 400 * DAY_MS), { getExercise });
    expect(Object.values(later.levels).every((l) => l.status === 'passed')).toBe(true);
  });

  // ---------------------------------------------------------------- storage

  it('every attempt is in the stored log, in order, with its metrics, and the log replays to the same progress', async () => {
    const stored = await studio.storage.attempts.listByProfile(studio.profile.id);
    expect(stored.map((a) => a.id)).toEqual(studio.written.map((a) => a.id));
    expect(stored.length).toBeGreaterThan(40);
    const sample = kept.sustainPolished;
    expect(stored.find((a) => a.id === sample.attempt.id)!.metrics).toEqual(sample.analysis.metrics);
    expect(await studio.refresh()).toEqual(computeSnapshot(studio.profile.id, WORLDS, stored, studio.now, { getExercise: withRoutines(getExercise) }));
    expect(JSON.parse(JSON.stringify(studio.snapshot))).toEqual(studio.snapshot); // plain data: it can be cached
  });

  it('survives a relaunch: the same attempts, profile and progress come back from IndexedDB', async () => {
    const before = JSON.stringify(studio.snapshot);
    studio = await studio.relaunch();
    expect(JSON.stringify(studio.snapshot)).toBe(before);
    expect(studio.profile.range).toMatchObject({ extended: { low: 45, high: 72 } });
    expect((await studio.storage.attempts.listByProfile(studio.profile.id)).length).toBe(studio.written.length);
    // The replayable take is still there too.
    expect((await studio.storage.takes.get(kept.sustainPolished.attempt.takeId!))?.exerciseId).toBe('foundations.hold.1');
  });

  it('a backup exported here restores the whole progress on a new device, and importing it again adds nothing', async () => {
    const json = await studio.storage.backup.exportJson([studio.profile.id]);
    const file = JSON.parse(json);
    expect(file).toMatchObject({ format: 'pitch-lab-backup', version: 1 });
    expect(file.attempts).toHaveLength(studio.written.length);
    expect(file.attempts.every((a: AttemptRecord) => a.takeId === null)).toBe(true); // audio never leaves the device
    expect(file.profiles.map((p: ProfileRecord) => p.name)).toEqual(['Daniel']);
    expect('songs' in file).toBe(false); // imported songs are local to the device

    // A new device: its own database and clock, a fresh default profile that the import retires.
    const newClock = { ms: studio.clock.ms + DAY_MS };
    const names = { db: freshName('wave1-new'), bin: freshName('wave1-newbin'), kv: freshName('wave1-newkv') };
    const db = await openDb(names.db, { now: () => newClock.ms });
    const device = await openStorage({ db, binaryDbName: names.bin, kvDbName: names.kv });
    const report = await device.backup.import(json);
    expect(report).toMatchObject({ attemptsAdded: studio.written.length, profilesAdded: 1 });
    expect(report.errors).toEqual([]);

    const restored = await device.profiles.get(studio.profile.id);
    expect(restored).toMatchObject({ name: 'Daniel', voiceType: 'tenor' });
    expect(restored?.range).toEqual(studio.profile.range);
    expect(await device.profiles.activeId()).toBe(studio.profile.id);

    const attempts = await device.attempts.listByProfile(studio.profile.id);
    expect(attempts).toHaveLength(studio.written.length);
    const now = new Date(newClock.ms);
    const here = computeSnapshot(studio.profile.id, WORLDS, await studio.storage.attempts.listByProfile(studio.profile.id), now, { getExercise });
    const there = computeSnapshot(studio.profile.id, WORLDS, attempts, now, { getExercise });
    expect(there).toEqual(here);
    expect(Object.values(there.levels).every((l) => l.status === 'passed')).toBe(true);

    const again = await device.backup.import(json);
    expect(again.attemptsAdded).toBe(0);
    expect(await device.attempts.listByProfile(studio.profile.id)).toHaveLength(studio.written.length);
    device.close();
  });
});

// ================================================================ independent scenarios

describe('the take recorder keeps the analyzers on the singer\'s clock', () => {
  const def = exerciseOf('foundations.clean-starts.1');
  const realized = realize(def, rangeFromMeasurement(TENOR_LOW, TENOR_HIGH, 'x'), 'tenor');
  const sung = singTake(realized, GOOD_SINGER);

  it('hands back exactly the take that was sung, whatever the route\'s latency and the downbeat', async () => {
    const direct = analyzeTake(def, realized, sung, { vibratoStyle: 'pop' });
    for (const [latencyMs, downbeat] of [[0, 0], [40, 3.25], [140, 12.5], [300, 99.75]] as const) {
      const take = await recordTake(sung, { latencyMs, downbeat });
      expect(take.latencyMs).toBe(latencyMs);
      expect(take.downbeat).toBe(downbeat);
      // At most the first (silent, pre-roll) frame can fall outside the recorder's window; every other frame is back on its own time.
      expect(sung.length - take.track.length).toBeLessThanOrEqual(1);
      for (let k = 1; k <= 200; k++) {
        expect(take.track[take.track.length - k].t, `${latencyMs} ms, frame ${k} from the end`).toBeCloseTo(sung[sung.length - k].t, 9);
      }
      const via = analyzeTake(def, realized, take.track, { vibratoStyle: 'pop' });
      for (const [metric, value] of Object.entries(direct.metrics) as Array<[keyof typeof direct.metrics, number]>) {
        expect(via.metrics[metric], `${latencyMs} ms ${metric}`).toBeCloseTo(value, 6);
      }
      expect(evaluate(def, via.metrics).passed).toBe(true);
    }
  });

  it('puts a route\'s latency back: a singer heard late is not scored as late', async () => {
    // The same performance, recorded WITHOUT compensation as if the app did not know the 300 ms route: every note lands 300 ms late.
    const slow = realize(exerciseOf('runs.run.3'), rangeFromMeasurement(TENOR_LOW, TENOR_HIGH, 'x'), 'tenor');
    const run = singTake(slow, GOOD_SINGER);
    const compensated = await recordTake(run, { latencyMs: 300 });
    const ignoring = await recordTake(run.map((f) => ({ ...f, t: f.t + 0.3 })), { latencyMs: 0 });
    const runDef = exerciseOf('runs.run.3');
    const ok = evaluate(runDef, analyzeTake(runDef, slow, compensated.track, { vibratoStyle: 'pop' }).metrics);
    const late = analyzeTake(runDef, slow, ignoring.track, { vibratoStyle: 'pop' });
    expect(ok.passed).toBe(true);
    expect(late.metrics['run.score']!).toBeLessThan(analyzeTake(runDef, slow, compensated.track, { vibratoStyle: 'pop' }).metrics['run.score']!);
  });

  it('keeps a take\'s audio aligned to take time 0, ready to save as a WAV next to its pitch track', async () => {
    const sampleRate = 8000;
    const secs = 1.5;
    const samples = Float32Array.from({ length: sampleRate * secs }, (_, i) => 0.4 * Math.sin((2 * Math.PI * 220 * i) / sampleRate));
    // The microphone started recording 1 s before the downbeat (count-in): the recorder drops that head.
    const take = await recordTake(sung.slice(0, 200), { audio: { samples, sampleRate, startTime: DOWNBEAT - 1 + ROUND_TRIP_MS / 1000 } });
    expect(take.audio).not.toBeNull();
    expect(take.audio!.samples.length).toBeLessThanOrEqual(samples.length - sampleRate + 1);
    const packed = encodeTake(take);
    const wav = parseWav(packed.audio!);
    expect(wav.sampleRate).toBe(sampleRate);
    expect(wav.frames).toBe(take.audio!.samples.length);
  });
});

describe('the whole game, every level sung in order through the real pipeline', () => {
  it('opens one level at a time, passes each at its own pass tempo, and ends with every world open', async () => {
    const studio = await Studio.open('Everything');
    await studio.findRange();
    let passed = 0;
    for (const world of TRAINING) {
      expect(isWorldUnlocked(world.id, studio.snapshot), `${world.id} is open when its turn comes`).toBe(true);
      for (const level of ordered(world)) {
        if (level.id === 'foundations.01') {
          passed += 1; // sung by findRange()
          continue;
        }
        const before = studio.snapshot;
        expect(before.levels[level.id].status, `${level.id} is the frontier`).toBe('current');
        const later = ALL_LEVELS.slice(ALL_LEVELS.indexOf(level) + 1);
        for (const l of later) expect(isLevelOpenable(l.id, before), `${l.id} is shut while ${level.id} is open`).toBe(false);

        const o = await studio.singLevel(level.id);
        expect(o.evaluation.passed, `${level.id} (${o.def.id}) scored ${o.evaluation.score.toFixed(2)}`).toBe(true);
        expect(o.evaluation.mastery, level.id).toBeGreaterThanOrEqual(2);
        expect(o.attempt, level.id).toMatchObject({ passed: true, kind: level.kind === 'boss' ? 'boss' : 'practice', levelId: level.id });
        expect(o.snapshot.levels[level.id].status).toBe('passed');
        passed += 1;
      }
      const boss = bossOf(world.id)!;
      expect(studio.snapshot.levels[boss.id].status).toBe('passed');
      studio.nextDay();
    }
    const s = studio.snapshot;
    expect(passed).toBe(ALL_LEVELS.length);
    expect(Object.values(s.levels).every((l) => l.status === 'passed' && !l.viaAudition)).toBe(true);
    expect(s.worldsUnlocked).toEqual(WORLDS.map((w) => w.id));
    expect(s.features).toEqual([...FEATURE_IDS]);
    expect(openSongs(s)).toHaveLength(library.songs.length);
    expect(studio.written).toHaveLength(ALL_LEVELS.length);
  }, 180_000);
});

describe('a daily workout built from real progress runs on the same engines', () => {
  it('offers only unlocked material, fits its budget with real take lengths, and builds Momentum without moving a level it did not earn', async () => {
    const studio = await Studio.open('Workout');
    await studio.findRange();
    for (const id of ['foundations.02', 'foundations.03', 'foundations.13']) expect((await studio.singLevel(id)).attempt.passed, id).toBe(true);
    studio.nextDay();

    const attempts = await studio.storage.attempts.listByProfile(studio.profile.id);
    const workout = buildDailyWorkout({ minutes: 10, snapshot: studio.snapshot, worlds: WORLDS, attempts, now: studio.now, getExercise });
    expect(workout.locked).toBe(false);
    expect(workout.totalEstSeconds).toBeLessThanOrEqual(10 * 60);
    expect(workout.items[0]).toMatchObject({ stage: 'warm-up', source: 'routine', levelId: null });
    expect(workout.items[workout.items.length - 1]).toMatchObject({ stage: 'cool-down', source: 'routine', levelId: null });
    const worldItems = workout.items.filter((i) => i.stage === 'world-item');
    expect(worldItems[0]).toMatchObject({ levelId: 'foundations.10', reason: 'current-level' }); // where the singer is: the step lesson, fifth in order

    const lookup = withRoutines(getExercise);
    const momentumBefore = studio.snapshot.momentum;
    const statusBefore = Object.fromEntries(Object.entries(studio.snapshot.levels).map(([id, l]) => [id, l.status]));
    let singingSec = 0;
    let routineTakes = 0;
    for (const item of workout.items) {
      expect(isExerciseOpenable(item.exerciseId, studio.snapshot, WORLDS), `${item.exerciseId} is openable`).toBe(true);
      const def = lookup(item.exerciseId)!;
      expect(def, item.exerciseId).toBeDefined();
      const source: AttemptSource = item.source === 'routine' ? { type: 'workout-routine' } : { type: 'workout-level', level: levelOf(item.levelId!) };
      for (let take = 0; take < item.takes; take++) {
        const o = await studio.sing(def, source, good);
        expect(o.attempt).toMatchObject({ kind: 'workout', levelId: item.levelId });
        expect(o.evaluation.passed, `${item.exerciseId} take ${take + 1}`).toBe(true);
        singingSec += o.attempt.durationSec;
        if (item.source === 'routine') routineTakes += 1;
      }
    }
    expect(routineTakes).toBeGreaterThanOrEqual(2);
    expect(singingSec).toBeLessThanOrEqual(workout.totalEstSeconds); // the estimate includes setup and reports: it cannot be short
    const s = await studio.refresh();
    expect(s.momentum).toBeGreaterThan(momentumBefore);
    expect(s.lastPracticeDay).toBe(studio.now.toISOString().slice(0, 10));
    // A routine moves nothing; the level item the singer was on is the only one that could advance, and it did exactly that.
    for (const [id, status] of Object.entries(statusBefore)) {
      if (status === 'passed') expect(s.levels[id].status, id).toBe('passed');
    }
    expect(s.levels['foundations.10'].status).toBe('passed');
    expect(s.levels['foundations.07'].status).toBe('current');
    expect(s.levels['foundations.08'].status).toBe('locked');
  }, 120_000);
});

describe('a take\'s audio stays on the device', () => {
  it('is saved next to its pitch track, comes back as a WAV, and never goes into a backup', async () => {
    const studio = await Studio.open('Keeper');
    await studio.findRange();
    const sampleRate = 8000;
    const samples = Float32Array.from({ length: sampleRate * 3 }, (_, i) => 0.3 * Math.sin((2 * Math.PI * 196 * i) / sampleRate));
    const o = await studio.singLevel('foundations.02', good, { keepTake: { audio: { samples, sampleRate, startTime: DOWNBEAT + ROUND_TRIP_MS / 1000 } } });
    const take = await studio.storage.takes.get(o.attempt.takeId!);
    expect(take?.audioRef).not.toBeNull();
    const blob = await studio.storage.takes.audio(take!);
    const wav = parseWav(await blob!.arrayBuffer());
    expect(wav.sampleRate).toBe(sampleRate);
    expect(wav.frames).toBe(o.take.audio!.samples.length);
    // The backup carries the attempt, never the audio or the take.
    const file = JSON.parse(await studio.storage.backup.exportJson());
    expect(JSON.stringify(file)).not.toContain(take!.audioRef!);
    expect(file.attempts.find((a: AttemptRecord) => a.id === o.attempt.id).takeId).toBeNull();
    expect('takes' in file).toBe(false);
  });
});

// ================================================================ the same pipeline on a real detector's output

/** Peak amplitude -> RMS of the synthesizer's default voice (a sum of harmonics): converts a dBFS level into an amplitude. */
const VOICE_RMS = Math.sqrt(DEFAULT_HARMONICS.reduce((sum, h) => sum + h * h, 0) / 2);
const SAMPLE_RATE = 48000;

/**
 * Audio of a noise-free sung track (its pitch contour and loudness, as a harmonic voice), decoded again by the
 * production Framer + MPM detector, with the frames back on the track's own time axis.
 */
function throughDetector(sung: readonly PitchFrame[]): PitchFrame[] {
  const t0 = sung[0].t;
  const rate = (sung.length - 1) / (sung[sung.length - 1].t - t0);
  const slot = (t: number) => {
    const x = (t - t0) * rate;
    const i = Math.floor(x);
    return { i, u: x - i };
  };
  const audio = synthesize({
    sampleRate: SAMPLE_RATE,
    duration: sung[sung.length - 1].t - t0 + 0.05,
    f0: (t) => {
      const { i, u } = slot(t + t0); // the audio starts at the track's first frame
      const a = sung[i];
      const b = sung[i + 1];
      return a && b && a.voiced && b.voiced ? midiToHz(a.midi + (b.midi - a.midi) * u) : NaN;
    },
    amp: (t) => Math.pow(10, sung[Math.min(sung.length - 1, Math.max(0, slot(t + t0).i))].rmsDb / 20) / VOICE_RMS,
  });
  return trackFromAudio(audio, SAMPLE_RATE).map((f) => ({ ...f, t: f.t + t0 }));
}

describe('the same pipeline on a real detector\'s output (synthesized audio -> Framer -> MPM)', () => {
  const range = rangeFromMeasurement(TENOR_LOW, TENOR_HIGH, '2026-10-21T09:00:00.000Z');

  interface Performance {
    def: ExerciseDef;
    analysis: TakeAnalysis;
    evaluation: Evaluation;
  }
  const performed = new Map<string, Promise<Performance>>();
  /** Each (exercise, singer) is performed once: the audio and the detector are the slow part. */
  function perform(id: string, model: Partial<SingerModel> = {}): Promise<Performance> {
    const key = id + JSON.stringify(model);
    let p = performed.get(key);
    if (!p) {
      p = sing(id, model);
      performed.set(key, p);
    }
    return p;
  }

  async function sing(id: string, model: Partial<SingerModel>): Promise<Performance> {
    const def = exerciseOf(id);
    const realized = realize(def, range, 'tenor');
    const sung = singTake(realized, { ...GOOD_SINGER, jitterCents: 0, vibratoEverywhere: def.analyzers.includes('vibrato'), ...model });
    const take = await recordTake(throughDetector(sung));
    const analysis = analyzeTake(def, realized, take.track, { vibratoStyle: 'pop' });
    return { def, analysis, evaluation: evaluate(def, analysis.metrics) };
  }

  /** Eleven short exercises that between them run every analyzer (the placement-audition tests are the briefest ones). */
  const PER_ANALYZER = [
    'foundations.range.1', //        range
    'foundations.audition.8', //     glide, cracks
    'foundations.audition.6', //     accuracy, onset
    'foundations.audition.7', //     accuracy, transitions
    'vibrato.audition.1', //         pulse
    'vibrato.audition.2', //         vibrato
    'vibrato.audition.4', //         switch, vibrato
    'inflections.audition.2', //     inflection, glide
    'inflections.audition.4', //     inflection, run
    'runs.run.5', //                 run
    'dynamics.audition.3', //        dynamics
  ];

  it('a clean singer passes an exercise for every analyzer, as the detector hears her', async () => {
    const covered = new Set<string>();
    for (const id of PER_ANALYZER) {
      const { def, evaluation, analysis } = await perform(id);
      expect(evaluation.passed, `${id} scored ${evaluation.score.toFixed(2)}, failed gates ${evaluation.failedGates}, ${JSON.stringify(analysis.metrics)}`).toBe(true);
      for (const a of def.analyzers) covered.add(a);
    }
    expect([...covered].sort()).toEqual(['accuracy', 'cracks', 'dynamics', 'glide', 'inflection', 'onset', 'pulse', 'range', 'run', 'switch', 'transitions', 'vibrato']);
  });

  it('the same faults still fail: wrong notes, a straight tone where vibrato is asked, a swell with no change in loudness, silence', async () => {
    const wrong = await perform('foundations.audition.7', { offsetSemis: 2 });
    expect(wrong.evaluation.passed).toBe(false);
    expect(wrong.analysis.metrics['accuracy.inTolerancePct']).toBeLessThan(10);

    const straight = await perform('vibrato.audition.2', { vibrato: null });
    expect(straight.evaluation.passed).toBe(false);
    expect(straight.analysis.metrics['vibrato.present']).toBe(0);

    const flat = await perform('dynamics.audition.3', { flatLoudness: true });
    expect(flat.evaluation.passed).toBe(false);
    expect(flat.analysis.metrics['dynamics.rangeDb'] ?? 0).toBeLessThan(10);

    const silent = await perform('foundations.audition.8', { silent: true });
    expect(silent.evaluation.passed).toBe(false);
    expect(silent.analysis.tipContext.noVoice).toBe(true);
  });

  it('measures what was sung, not what the detector made of it: vibrato rate and extent, run notes, swell range', async () => {
    const vib = (await perform('vibrato.audition.2')).analysis.metrics;
    expect(vib['vibrato.rateHz']).toBeGreaterThan(5.5);
    expect(vib['vibrato.rateHz']).toBeLessThan(6.1); // sung at 5.8 Hz
    expect(vib['vibrato.extentCents']).toBeGreaterThan(28); // sung at +/-35 c; the detector's 43 ms window trims a little
    expect(vib['vibrato.extentCents']).toBeLessThan(40);

    const run = await perform('runs.run.5');
    expect(run.analysis.details.runs.flatMap((r) => r.result.notes).every((n) => n.verdict === 'defined')).toBe(true);

    const swellMetrics = (await perform('dynamics.audition.3')).analysis.metrics;
    expect(swellMetrics['dynamics.rangeDb']).toBeGreaterThan(20); // sung from -38 to -14 dBFS: a 24 dB swell
    expect(swellMetrics['dynamics.rangeDb']).toBeLessThan(28);
  });
});

// ================================================================ hostile input

/** Random-walk pitch with random voicing and level: what a broken or very noisy microphone path might hand over. */
function garbage(seed: number, seconds: number): PitchFrame[] {
  const rand = seededRandom(seed);
  const out: PitchFrame[] = [];
  let midi = 60;
  for (let i = 0; i < Math.floor(seconds * FRAME_RATE); i++) {
    const voiced = rand() < 0.6;
    midi = Math.min(84, Math.max(40, midi + (rand() - 0.5) * (rand() < 0.1 ? 40 : 3)));
    out.push({ t: -0.5 + i / FRAME_RATE, f0Hz: midiToHz(midi), midi, centsFromNearest: centsFromNearest(midi), confidence: voiced ? 0.8 + rand() * 0.2 : rand() * 0.5, rmsDb: -60 + rand() * 50, voiced });
  }
  return out;
}

describe('hostile takes: whatever the microphone hands over, nothing throws, every number stays finite, and nothing passes that did not earn it', () => {
  const range = rangeFromMeasurement(TENOR_LOW, TENOR_HIGH, '2026-10-21T09:00:00.000Z');
  const unvoiced = (f: PitchFrame): PitchFrame => ({ ...f, voiced: false, midi: NaN, f0Hz: NaN, centsFromNearest: NaN, confidence: 0.1, rmsDb: -80 });

  const CASES: Array<{ name: string; make: (sung: PitchFrame[], seconds: number) => PitchFrame[]; passes?: (def: ExerciseDef) => boolean }> = [
    { name: 'no frames at all', make: () => [] },
    { name: 'a single frame', make: (sung) => sung.slice(0, 1) },
    { name: 'silence', make: (sung) => sung.map(unvoiced) },
    // The Range finder listens for held notes wherever they fall, so a clock that is off cannot change its verdict.
    { name: 'a clock 100 s out', make: (sung) => sung.map((f) => ({ ...f, t: f.t + 100 })), passes: (def) => def.kind === 'range-finder' },
    { name: 'voiced frames that carry no pitch', make: (sung) => sung.map((f) => ({ ...f, midi: NaN, f0Hz: NaN, centsFromNearest: NaN })) },
    { name: 'random pitch and level noise (seed 1)', make: (_, seconds) => garbage(1, seconds) },
    { name: 'random pitch and level noise (seed 2)', make: (_, seconds) => garbage(2, seconds) },
  ];

  it('holds for every exercise in the catalog', () => {
    const problems: string[] = [];
    for (const def of EXERCISES) {
      const realized = realize(def, range, 'tenor');
      const sung = singTake(realized, { ...GOOD_SINGER, vibratoEverywhere: def.analyzers.includes('vibrato') });
      for (const c of CASES) {
        try {
          const analysis = analyzeTake(def, realized, c.make(sung, realized.totalSec + 1.5), { vibratoStyle: 'pop' });
          const evaluation = evaluate(def, analysis.metrics);
          pickTip(analysis.metrics, def, analysis.tipContext);
          const fields = buildAttempt({ profileId: 'p', def, source: { type: 'audition' }, realized, evaluation, metrics: analysis.metrics });
          if (!(evaluation.score >= 0 && evaluation.score <= 1)) problems.push(`${def.id} [${c.name}]: score ${evaluation.score}`);
          for (const [metric, value] of Object.entries(fields.metrics)) if (!Number.isFinite(value)) problems.push(`${def.id} [${c.name}]: ${metric} = ${value}`);
          if (evaluation.passed && !c.passes?.(def)) problems.push(`${def.id} [${c.name}]: passed with ${evaluation.score.toFixed(2)}`);
        } catch (err) {
          problems.push(`${def.id} [${c.name}]: threw ${(err as Error).message}`);
        }
      }
    }
    expect(problems).toEqual([]);
  });
});

describe('the vibrato style setting moves the zone, and the zone is what the Vibrato meter gates on', () => {
  it('a wide vibrato is in the classical zone and out of the pop zone: the same take passes in one style and fails in the other', () => {
    const def = exerciseOf('vibrato.meter.1');
    const realized = realize(def, rangeFromMeasurement(TENOR_LOW, TENOR_HIGH, 'x'), 'tenor');
    const wide = singTake(realized, { ...GOOD_SINGER, vibrato: { rateHz: 5.8, extentCents: 70 }, vibratoEverywhere: true });
    const as = (style: 'pop' | 'classical') => {
      const analysis = analyzeTake(def, realized, wide, { vibratoStyle: style });
      return { metrics: analysis.metrics, evaluation: evaluate(def, analysis.metrics) };
    };
    const classical = as('classical');
    const pop = as('pop');
    expect(classical.metrics['vibrato.inZone']).toBe(1);
    expect(pop.metrics['vibrato.inZone']).toBe(0);
    expect(classical.evaluation.passed).toBe(true);
    expect(pop.evaluation.passed).toBe(false); // the level gates vibrato.inZone: a vibrato outside the singer's style zone is not the skill
    expect(classical.evaluation.score).toBeGreaterThan(pop.evaluation.score);
    expect(classical.metrics['vibrato.extentCents']).toBeCloseTo(pop.metrics['vibrato.extentCents']!, 9); // the same measurement either way
  });
});
