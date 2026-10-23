import { describe, expect, it } from 'vitest';
import type { Metrics } from '../analysis/types';
import { CONFIG } from '../config';
import { EXERCISES, getExercise } from './catalog';
import { evaluate, gateHolds } from './evaluate';
import { COACHING_TIPS, NO_VOICE_TIP, POLISH_TIP, UNFIT_RANGE_TIP, getTip, pickTip, tipIdsFor } from './tips';
import type { ExerciseDef } from './types';

const ex = (id: string): ExerciseDef => getExercise(id)!;
/** Metrics at each term's best value (a clean take). */
const clean = (def: ExerciseDef): Metrics => {
  const m: Metrics = {};
  for (const t of def.scoring) m[t.metric] = t.best;
  for (const g of def.pass.gates ?? []) if (m[g.metric] === undefined) m[g.metric] = g.op === '>=' ? g.value + 1 : Math.max(0, g.value - 1);
  return m;
};

describe('the rule table', () => {
  it('has unique ids and coach-like copy: one or two plain sentences, no exclamation marks', () => {
    expect(new Set(COACHING_TIPS.map((t) => t.id)).size).toBe(COACHING_TIPS.length);
    for (const t of [...COACHING_TIPS, POLISH_TIP, NO_VOICE_TIP, UNFIT_RANGE_TIP]) {
      expect(t.text, t.id).not.toMatch(/!/);
      expect(t.text, t.id).toMatch(/[.]$/);
      const sentences = t.text.split(/(?<=[.?])\s+(?=[A-Z{“])/);
      expect(sentences.length, t.id).toBeLessThanOrEqual(2);
      for (const ph of t.text.match(/\{[a-z]+\}/g) ?? []) expect(['{v}', '{pct}'], t.id).toContain(ph);
    }
  });

  it('carries the SPEC §12 examples word for word', () => {
    expect(getTip('onset.scoop-big')!.text).toMatch(/^Start the note on the pitch: hear it before you sing/);
    expect(getTip('dyn.sharp-loud')!.text).toMatch(/Keep the breath steady as you crescendo; don’t push\./);
  });

  it('explains every metric every exercise judges', () => {
    for (const def of EXERCISES) {
      const explained = new Set(def.tipIds!.flatMap((id) => getTip(id)!.relatesTo ?? [getTip(id)!.when.metric]));
      for (const m of [...def.scoring.map((t) => t.metric), ...(def.pass.gates ?? []).map((g) => g.metric)]) {
        expect(explained.has(m), `${def.id}: ${m}`).toBe(true);
      }
    }
  });

  it('only offers figure tips for figures the exercise contains', () => {
    expect(tipIdsFor(ex('inflections.boss-recital'))).toEqual(expect.arrayContaining(['turn.shape', 'slide.shape', 'flip.shape']));
    expect(tipIdsFor(ex('inflections.boss-recital'))).not.toContain('scoop.shape');
    expect(tipIdsFor(ex('foundations.hold.1'))).not.toContain('turn.shape');
  });

  it('only talks about the tempo stepping up on levels that have a tempo ladder', () => {
    expect(getTip('run.score')!.text).toMatch(/moves the tempo up/);
    expect(getTip('run.score')!.text).not.toMatch(/85/); // the ladder advances on a passing take, not at a fixed run score
    for (const def of EXERCISES) {
      const laddered = (def.tempoLadder?.length ?? 0) > 0;
      if (!laddered) expect(def.tipIds, def.id).not.toContain('run.score');
      else expect(def.tipIds, def.id).toContain('run.score');
    }
    expect(tipIdsFor(ex('vibrato.oscillation.1'))).toEqual(expect.arrayContaining(['run.score-any', 'run.missed', 'run.smeared']));
  });

  it('pins the owner\'s 85%: the run-score tip talks at 0.85 and below and is quiet above it (0.849 / 0.85 / 0.851)', () => {
    const when = getTip('run.score')!.when;
    expect(CONFIG.runs.tempoAdvanceScore).toBe(0.85);
    expect(when).toEqual({ metric: 'run.score', op: '<=', value: 0.85 });
    expect(gateHolds(when, { 'run.score': 0.849 })).toBe(true);
    expect(gateHolds(when, { 'run.score': 0.85 })).toBe(true);
    expect(gateHolds(when, { 'run.score': 0.851 })).toBe(false);
  });

  it('describes a turn in an order that fits both an upper and an inverted turn', () => {
    const text = getTip('turn.shape')!.text;
    expect(text).not.toMatch(/upper, main, lower, main/);
    expect(text).toMatch(/upper/);
    expect(text).toMatch(/lower/);
  });

  it('asks the Range finder for the span its pass gate needs', () => {
    const def = ex('foundations.range.1');
    const gate = def.pass.gates!.find((g) => g.metric === 'range.spanSemitones')!.value;
    const narrow = pickTip({ 'range.spanSemitones': gate - 1 }, def);
    expect(narrow.id).toBe('range.narrow');
    expect(narrow.text).toContain(`need ${gate}`);
    expect(pickTip({ 'range.spanSemitones': gate }, def).id).not.toBe('range.narrow');
  });
});

describe('pickTip', () => {
  it('coaches the SPEC example when a scoop is over 40 cents', () => {
    const def = ex('foundations.clean-starts.1');
    const tip = pickTip({ ...clean(def), 'onset.scoopCents': 60 }, def);
    expect(tip.id).toBe('onset.scoop-big');
    expect(tip.text).toContain('You scooped up from 60¢ below.');
  });

  it('draws the SPEC line at 40 cents: just above it gets "start the note on the pitch", just below the milder tip', () => {
    // Exactly 40 is left open: the code says >= while SPEC §12 says "above".
    const def = ex('foundations.clean-starts.1');
    expect(pickTip({ ...clean(def), 'onset.scoopCents': 41 }, def).id).toBe('onset.scoop-big');
    expect(pickTip({ ...clean(def), 'onset.scoopCents': 39 }, def).id).toBe('onset.scoop');
  });

  it('never promises a tempo step on a level without a ladder', () => {
    // A clean oscillation whose run score alone is low: the run tip that fits is the generic one.
    const osc = ex('vibrato.oscillation.1');
    const m = { ...clean(osc), 'run.score': 0.5, 'run.definedRate': 0.95, 'run.missedRate': 0 };
    expect(pickTip(m, osc).id).toBe('run.score-any');
    const turn = ex('inflections.turn.1');
    expect(pickTip({ ...clean(turn), 'run.score': 0.5 }, turn).id).not.toBe('run.score');
    const run3 = ex('runs.run.3');
    expect(pickTip({ ...clean(run3), 'run.score': 0.5 }, run3).id).toBe('run.score');
  });

  it('says the loudness went against the cue when it did, and that it barely moved when it did not move', () => {
    const def = ex('dynamics.swell.3');
    const m = { ...clean(def), 'dynamics.rangeDb': 0 };
    expect(pickTip(m, def, { loudnessAgainstCue: true }).id).toBe('dyn.against-cue');
    expect(pickTip(m, def, {}).id).toBe('dyn.range-small');
  });

  it('explains a take that could not be judged because the exercise was folded into the saved range', () => {
    const def = ex('inflections.audition.4');
    expect(pickTip(clean(def), def, { unfitRange: true }).id).toBe(UNFIT_RANGE_TIP.id);
    expect(pickTip(clean(def), def, { unfitRange: true, noVoice: true }).id).toBe(NO_VOICE_TIP.id);
  });

  it('names the direction of a bias from the signed context', () => {
    const def = ex('foundations.steady.1');
    const m = { ...clean(def), 'accuracy.absBiasCents': 18, 'accuracy.inTolerancePct': 60 };
    expect(pickTip(m, def, { biasCents: 18 }).id).toBe('acc.sharp');
    expect(pickTip(m, def, { biasCents: -18 }).id).toBe('acc.flat');
    expect(pickTip(m, def).id).not.toMatch(/acc\.(sharp|flat)/);
  });

  it('names no direction when the notes missed both ways: the lean must explain half the typical offset (review R1)', () => {
    const def = ex('foundations.jumps.1');
    // Notes about 30 off each way: the typical offset is 30, the signed average near zero.
    const m = { ...clean(def), 'accuracy.absBiasCents': 30, 'accuracy.inTolerancePct': 20 };
    for (const biasCents of [1.8, -4, 14.9]) expect(pickTip(m, def, { biasCents }).id, String(biasCents)).not.toMatch(/acc\.(sharp|flat)/);
    expect(pickTip(m, def, { biasCents: 15 }).id).toBe('acc.sharp');
    // The same for drift and vibrato centring: no direction tip for a lean that explains little (Hold it steady judges the drift).
    const sustain = ex('foundations.steady.1');
    const drift = { ...clean(sustain), 'accuracy.absDriftCentsPerSec': 8 };
    expect(pickTip(drift, sustain, { driftCentsPerSec: -1 }).id).not.toMatch(/acc\.drift-(flat|sharp)/);
    expect(pickTip(drift, sustain, { driftCentsPerSec: -6 }).id).toBe('acc.drift-flat');
  });

  it('says how many notes a take needs: every one on a short exercise, a count on a long one (review R7)', () => {
    const sirens = ex('foundations.sirens.1');
    expect(pickTip(clean(sirens), sirens, { reach: { reached: 8, total: 9 } }).text).toBe(
      'You sang 8 of the 9 notes. Keep singing to the end of the exercise: a take passes only when every note is sung.',
    );
    const legato = ex('foundations.five-notes.1');
    expect(pickTip(clean(legato), legato, { reach: { reached: 12, total: 20 } }).text).toMatch(/a take passes only when at least 18 of them are sung\.$/);
  });

  it('coaches sharp-when-loud from the dynamics verdict', () => {
    const def = ex('dynamics.swell.3');
    const tip = pickTip({ ...clean(def), 'dynamics.absSlopeCentsPerDb': 3 }, def, { dynamicsVerdict: 'sharp-when-loud' });
    expect(tip.id).toBe('dyn.sharp-loud');
  });

  it('says so when notes never settled instead of quoting a number it does not have', () => {
    const def = ex('foundations.clean-starts.1');
    const m = clean(def);
    delete m['onset.settleMs'];
    expect(pickTip(m, def).id).toBe('onset.settle-missing');
  });

  it('targets the weakest figure in a mixed Boss Recital', () => {
    const def = ex('inflections.boss-recital');
    const m = { ...clean(def), 'inflection.score': 0.5 };
    expect(pickTip(m, def, { worstInflection: 'flip' }).id).toBe('flip.shape');
    expect(pickTip(m, def, { worstInflection: 'turn' }).id).toBe('turn.shape');
    expect(pickTip(m, def).id).toBe('inflection.shape');
  });

  it('fills placeholders with the measured value', () => {
    const def = ex('runs.run.3');
    const tip = pickTip({ ...clean(def), 'run.missedRate': 0.25 }, def);
    expect(tip.id).toBe('run.missed');
    expect(tip.text.startsWith('25% of the notes were missed.')).toBe(true);
  });

  it('praises only a clean, passed take', () => {
    for (const def of EXERCISES) {
      const m = clean(def);
      expect(evaluate(def, m).passed, def.id).toBe(true);
      expect(pickTip(m, def).id, def.id).toBe(POLISH_TIP.id);
    }
  });

  it('always gives a failed take something to work on', () => {
    for (const def of EXERCISES) {
      const m: Metrics = {};
      for (const t of def.scoring) m[t.metric] = t.worst;
      const tip = pickTip(m, def);
      expect(evaluate(def, m).passed).toBe(false);
      expect(tip.id, def.id).not.toBe(POLISH_TIP.id);
      expect(tip.text.length).toBeGreaterThan(20);
    }
  });

  it('notices when nobody sang', () => {
    const def = ex('foundations.hold.1');
    expect(pickTip({}, def).id).toBe(NO_VOICE_TIP.id);
    expect(pickTip({ 'accuracy.inTolerancePct': 0 }, def, { noVoice: true }).id).toBe(NO_VOICE_TIP.id);
  });

  it('does not blame the mic when someone sang but nothing could be measured', () => {
    // The analyzer context says a voice was there: a Range finder take that never held a note for a second.
    const finder = ex('foundations.range.1');
    expect(pickTip({}, finder, { noVoice: false }).id).toBe('range.missing');
    expect(pickTip({}, finder).id).toBe(NO_VOICE_TIP.id); // without a context, nothing measured still means nobody sang
  });

  it('puts a failed gate ahead of a small loss elsewhere', () => {
    const def = ex('foundations.five-notes.1');
    const m = { ...clean(def), 'transition.cleanRate': 0.2, 'accuracy.sdCents': 12 };
    expect(pickTip(m, def).id).toBe('transition.smeared');
  });
});
