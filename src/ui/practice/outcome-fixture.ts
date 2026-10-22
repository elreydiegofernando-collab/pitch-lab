/**
 * A finished take on the real catalog for the report's tests: the synthetic singer sings a level, and the real analyzers,
 * scorer, tile builder and tip picker judge it, exactly as the runner's pipeline does (docs/ARCHITECTURE.md "Wave 1
 * integration"). Only the storage and the audio are stand-ins. Imported only by tests.
 */
import type { TakeAudio, TakeResult } from '../../audio/take-recorder';
import { analyzeTake, canPassAtTempo, evaluate, getExercise, getLevel, getWorld, ladderOf, passRequirements, pickTip, realize, reportTiles, startTempo } from '../../exercises';
import { GOOD_SINGER, singTake, type SingerModel } from '../../exercises/test-singer';
import { attempt } from '../../progress/test-fixtures';
import type { PreparedRun, TakeOutcome, UnlockEvent } from '../../runtime/types';
import type { VocalRange } from '../../storage/schema';
import { PROFILE_ID, TENOR_RANGE, snapshotAfter } from './test-fakes';

export interface OutcomeOptions {
  levelId?: string;
  /** The rung sung (a Runs ladder); default the first. */
  bpm?: number;
  singer?: Partial<SingerModel>;
  /** The saved range the material was placed in; null = the voice-type default. */
  range?: VocalRange | null;
  /** Attach take audio (a short tone at 16 kHz). */
  audio?: boolean;
  unlocked?: UnlockEvent[];
  nextBpm?: number | null;
  rangeSaved?: boolean;
  saveError?: string | null;
}

export function toneAudio(seconds = 0.5, sampleRate = 16000): TakeAudio {
  const samples = new Float32Array(Math.round(seconds * sampleRate));
  for (let i = 0; i < samples.length; i++) samples[i] = 0.3 * Math.sin((2 * Math.PI * 220 * i) / sampleRate);
  return { samples, sampleRate, t0: 0 };
}

export function makeOutcome(opts: OutcomeOptions = {}): TakeOutcome {
  const levelId = opts.levelId ?? 'foundations.03';
  const level = getLevel(levelId);
  const def = level ? getExercise(level.exerciseId) : undefined;
  if (!level || !def) throw new Error(`no level ${levelId}`);
  const range = opts.range === undefined ? TENOR_RANGE : opts.range;
  const bpm = opts.bpm ?? startTempo(def);
  const realized = realize(def, range, 'tenor', { bpm });
  const track = singTake(realized, { ...GOOD_SINGER, vibratoEverywhere: def.analyzers.includes('vibrato'), ...opts.singer });
  const take: TakeResult = { track, audio: opts.audio ? toneAudio() : null, latencyMs: 0, downbeat: 0, frameRate: 93.75 };
  const analysis = analyzeTake(def, realized, track, { vibratoStyle: 'pop' });
  const evaluation = evaluate(def, analysis.metrics, analysis);
  const prepared: PreparedRun = {
    target: { kind: 'level', levelId },
    def,
    level,
    world: getWorld(level.worldId) ?? null,
    realized,
    bpm,
    ladder: def.tempoLadder && def.tempoLadder.length > 0 ? { rungs: def.tempoLadder, index: Math.max(0, ladderOf(def).indexOf(bpm)) } : null,
    passLines: passRequirements(def),
    usingDefaultRange: range === null,
    audition: null,
    workout: null,
  };
  // As buildAttempt writes it: a lower rung of a tempo ladder never counts as passing the level, and an unpassed take has no tally.
  const counted = evaluation.passed && canPassAtTempo(def, bpm);
  const row = attempt({ profileId: PROFILE_ID, levelId, exerciseId: def.id, passed: counted, score: evaluation.score, mastery: counted ? evaluation.mastery : 0 });
  return {
    id: row.id,
    prepared,
    take,
    analysis,
    evaluation,
    tiles: reportTiles(def, analysis.metrics),
    tip: pickTip(analysis.metrics, def, analysis.tipContext),
    attempt: row,
    savedTake: null,
    saveError: opts.saveError ?? null,
    nextBpm: opts.nextBpm === undefined ? null : opts.nextBpm,
    rangeSaved: opts.rangeSaved ?? false,
    before: snapshotAfter([]),
    after: snapshotAfter([]),
    unlocked: opts.unlocked ?? [],
  };
}
