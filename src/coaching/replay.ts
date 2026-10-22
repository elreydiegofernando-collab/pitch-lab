/**
 * The targets a saved take was sung against, rebuilt from its attempt: the exercise realized at the tempo the take was
 * sung (AttemptRecord.tempoBpm, a ladder rung) and moved to the key it was sung in (AttemptRecord.tonicMidi), so a range
 * saved since then cannot shift the targets under it. Used to re-analyze the latest take (the Level screen's "Last time")
 * and to write the coaching file's realized targets (export.ts).
 */
import type { TargetNote } from '../core/types';
import { realize, type RealizedExercise, type VoiceType } from '../exercises/transpose';
import type { ExerciseDef } from '../exercises/types';
import type { AttemptRecord, VocalRange } from '../storage/schema';

/** Every pitch of a realization moved by `semis` (the timing is untouched). */
export function shiftRealized(r: RealizedExercise, semis: number): RealizedExercise {
  if (semis === 0) return r;
  const note = (n: TargetNote): TargetNote => (n.toMidi !== undefined ? { ...n, midi: n.midi + semis, toMidi: n.toMidi + semis } : { ...n, midi: n.midi + semis });
  return {
    ...r,
    tonicMidi: r.tonicMidi + semis,
    notes: r.notes.map(note),
    reference: r.reference.map(note),
    steps: r.steps.map((s) => ({
      ...s,
      ...(s.midi !== undefined ? { midi: s.midi + semis } : {}),
      ...(s.toMidi !== undefined ? { toMidi: s.toMidi + semis } : {}),
    })),
    inflections: r.inflections.map((g) => ({ kind: g.kind, notes: g.notes.map(note) })),
    range: { low: r.range.low + semis, high: r.range.high + semis },
  };
}

/** The realization a take of `def` was sung against (see the module doc). */
export function realizeAttempt(
  def: ExerciseDef,
  attempt: Pick<AttemptRecord, 'tempoBpm' | 'tonicMidi'>,
  range: VocalRange | null,
  voiceType: VoiceType,
): RealizedExercise {
  const bpm = attempt.tempoBpm !== null && Number.isFinite(attempt.tempoBpm) && attempt.tempoBpm > 0 ? attempt.tempoBpm : def.tempoBpm;
  const r = realize(def, range, voiceType, { bpm });
  const tonic = attempt.tonicMidi;
  return tonic !== null && Number.isFinite(tonic) ? shiftRealized(r, Math.round(tonic - r.tonicMidi)) : r;
}
