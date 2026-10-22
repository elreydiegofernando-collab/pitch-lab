import { describe, expect, it } from 'vitest';
import { getExercise } from './catalog';
import { CUE } from './cues';
import { PLAN, planAnalysis } from './plan';
import { realize } from './transpose';
import type { ExerciseDef, PatternStep } from './types';

const ex = (id: string): ExerciseDef => getExercise(id)!;
const planOf = (id: string) => planAnalysis(realize(ex(id), null, 'tenor'));

/** Realize a bare pattern at 60 bpm (1 beat = 1 s) with the tonic at the unknown-voice default. */
function planPattern(pattern: PatternStep[], analyzers: ExerciseDef['analyzers'] = ['accuracy']) {
  const def = {
    ...ex('foundations.sustain.1'),
    pattern,
    tempoBpm: 60,
    repeats: undefined,
    analyzers,
  } as ExerciseDef;
  const r = realize(def, null, 'unknown');
  return { r, plan: planAnalysis(r), t: r.tonicMidi };
}

describe('phrases, holds and attacks', () => {
  const { plan, t } = planPattern([
    { semis: 0, beats: 1 },
    { semis: 0, beats: 1 },
    { semis: 2, beats: 1 },
    { beats: 1 },
    { semis: 4, beats: 2 },
  ]);

  it('splits phrases at rests and merges repeated steps into one held note', () => {
    expect(plan.phrases.map((p) => [p.start, p.end])).toEqual([[0, 3], [4, 6]]);
    expect(plan.holds.map((h) => [h.note.midi - t, h.note.start, h.note.end])).toEqual([[0, 0, 2], [2, 2, 3], [4, 4, 6]]);
  });

  it('treats only voice onsets from silence as attacks, judged from the middle of the silence', () => {
    expect(plan.attacks.map((a) => [a.note.midi - t, a.from])).toEqual([[0, -PLAN.onsetLookbackSec], [4, 3.5]]);
  });

  it('analyzes accuracy on long enough holds, and transitions on connected notes only', () => {
    expect(plan.accuracy).toHaveLength(3);
    expect(plan.transitions.map((q) => q.map((n) => n.midi - t))).toEqual([[0, 2]]);
    expect(plan.crackSpans).toEqual([{ start: 0, end: 3 }, { start: 4, end: 6 }]);
  });

  it('starts a phrase after a Listen tone as an attack, from the middle of the silence after it', () => {
    const { plan: p } = planPattern([{ semis: 0, beats: 2, cue: CUE.listen }, { beats: 1 }, { semis: 0, beats: 2 }]);
    expect(p.attacks).toHaveLength(1);
    expect(p.attacks[0].from).toBeCloseTo(2.5, 9);
  });
});

describe('inflection targets (analysis/inflections.ts TARGETS)', () => {
  it('scoop: the rising glide, plus the landing hold', () => {
    const g = planOf('inflections.scoop.1').inflections[0];
    expect(g.kind).toBe('scoop');
    expect(g.targets[0].toMidi! - g.targets[0].midi).toBe(2);
    expect(g.targets[1].midi).toBe(g.targets[0].toMidi);
    expect(g.targets[1].start).toBeCloseTo(g.targets[0].end, 9);
  });

  it('fall: the held note, then the fall glide from it', () => {
    const g = planOf('inflections.fall.1').inflections[0];
    expect(g.targets[0].toMidi).toBeUndefined();
    expect(g.targets[1].midi).toBe(g.targets[0].midi);
    expect(g.targets[1].toMidi!).toBeLessThan(g.targets[1].midi);
  });

  it('slide: the hold before, the timed glide, and the landing hold', () => {
    const g = planOf('inflections.slide.1').inflections[0];
    expect(g.targets).toHaveLength(3);
    expect(g.targets[1].midi).toBe(g.targets[0].midi);
    expect(g.targets[2].midi).toBe(g.targets[1].toMidi);
  });

  it('turn: one group per neighbour, each with the main note spanning the figure', () => {
    const groups = planOf('inflections.turn.1').inflections.slice(0, 2);
    expect(groups.map((g) => g.kind)).toEqual(['turn', 'turn']);
    const [a, b] = groups;
    expect(a.targets[0]).toEqual(b.targets[0]);
    expect(a.targets[1].midi - a.targets[0].midi).toBe(2);
    expect(b.targets[1].midi - b.targets[0].midi).toBe(-1);
    for (const g of groups) {
      expect(g.targets[1].start).toBeGreaterThan(g.targets[0].start);
      expect(g.targets[1].end).toBeLessThan(g.targets[0].end);
    }
  });

  it('flip: the note before and the higher landing note', () => {
    for (const g of planOf('inflections.flip.1').inflections) {
      expect(g.targets).toHaveLength(2);
      expect(g.targets[1].midi).toBeGreaterThan(g.targets[0].midi);
      expect(g.targets[1].start).toBeCloseTo(g.targets[0].end, 9);
    }
  });

  it('reports a malformed figure instead of guessing', () => {
    const { plan } = planPattern([{ semis: 0, beats: 1, cue: CUE.slide }, { semis: 4, beats: 1 }], ['inflection']);
    expect(plan.inflections).toEqual([]);
    expect(plan.issues[0]).toMatch(/slide/);
    const turn = planPattern([{ semis: 0, beats: 1, cue: CUE.turn }, { semis: 2, beats: 1 }], ['inflection']);
    expect(turn.plan.issues[0]).toMatch(/turn/);
  });
});

describe('vibrato and pulses', () => {
  it('merges cue windows into one take-level plan, split only where the state changes', () => {
    const plan = planOf('vibrato.switch.1');
    expect(plan.vibratoPlan.map((w) => w.vibrato)).toEqual([false, true, false, true, false, true, false, true, false]);
    expect(plan.vibrato.every((n) => n.end - n.start >= PLAN.vibratoMinNoteSec)).toBe(true);
    expect(plan.vibrato).toHaveLength(4);
  });

  it('never treats a cued switch drill as a pulse train', () => {
    expect(planOf('vibrato.switch.1').pulses).toEqual([]);
  });

  it('times pulse trains in pulses per second and alternations in cycles per second', () => {
    const pulse = planOf('vibrato.pulse.1').pulses;
    expect(pulse).toHaveLength(3);
    expect(pulse[0].notes).toHaveLength(1);
    expect(pulse[0].rateHz).toBeCloseTo(3.5, 9);
    const osc = planOf('vibrato.oscillation.2').pulses;
    expect(osc[0].notes).toHaveLength(24);
    expect(osc[0].rateHz).toBeCloseTo((4 * 70) / 60 / 2, 9);
  });

  it('analyzes free-vibrato holds of at least a second when there are no switch cues', () => {
    const plan = planOf('vibrato.meter.1');
    expect(plan.vibratoPlan).toEqual([]);
    expect(plan.vibrato).toHaveLength(3);
  });
});

describe('runs and dynamics', () => {
  it('turns each run into one sequence of distinct notes, never across a breath', () => {
    const plan = planOf('runs.run.3');
    expect(plan.runs).toHaveLength(3);
    for (const q of plan.runs) expect(q).toHaveLength(5);
  });

  it('keeps a glide out of run sequences', () => {
    const runs = planOf('inflections.boss-recital').runs;
    expect(runs).toHaveLength(1);
    expect(runs[0]).toHaveLength(5);
  });

  it('labels dynamics holds with the shape their cue asks for', () => {
    expect(planOf('dynamics.swell.1').dynamics.map((d) => d.shape)).toEqual(['crescendo', 'crescendo', 'crescendo']);
    expect(planOf('dynamics.swell.2').dynamics.map((d) => d.shape)).toEqual(['decrescendo', 'decrescendo', 'decrescendo']);
    expect(planOf('dynamics.swell.4').dynamics.map((d) => d.shape)).toEqual([null, null]);
  });

  it('gives every dynamics hold the loudness path to follow, soft/loud steps included', () => {
    expect(planOf('dynamics.swell.1').dynamics[0].contour).toEqual({ points: ['soft', 'loud'], smooth: true });
    expect(planOf('dynamics.swell.4').dynamics.map((d) => d.contour)).toEqual([
      { points: ['soft', 'loud', 'soft'], smooth: false },
      { points: ['loud', 'soft', 'loud'], smooth: false },
    ]);
    expect(planOf('dynamics.boss-recital').dynamics.map((d) => d.contour?.points.join('-'))).toEqual(['soft-loud-soft', 'soft-loud-soft-loud', 'loud-soft']);
    const { plan } = planPattern([{ semis: 0, beats: 4, cue: 'Hold it, nice and even' }]);
    expect(plan.dynamics[0]).toMatchObject({ shape: null, contour: null });
  });
});
