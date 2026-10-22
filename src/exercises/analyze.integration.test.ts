/**
 * End to end through the real analyzers: a synthetic singer (test-singer.ts)
 * sings each realized exercise, analyzeTake aggregates, evaluate judges and
 * pickTip coaches. Checks that clean singing passes every level and that each
 * typical fault fails the levels that train against it, including the lazy
 * but plausible ones (vibrato out of its zone, loudness against the cue, a
 * take well off-centre), with the expected outcome stated per exercise where
 * some legitimately pass.
 */
import { describe, expect, it } from 'vitest';
import { CONFIG } from '../config';
import type { PitchFrame, TargetNote } from '../core/types';
import { makeTrack } from '../analysis/fixtures';
import { cleanOctaveSpikes } from '../analysis/track';
import type { InflectionKind } from '../analysis/types';
import { EXERCISES, getExercise } from './catalog';
import { analyzeTake, noteReach } from './analyze';
import { evaluate, reachHolds } from './evaluate';
import { nextTempo, startTempo } from './ladder';
import { planAnalysis } from './plan';
import { NO_VOICE_TIP, UNFIT_RANGE_TIP, pickTip } from './tips';
import { GOOD_SINGER, POOR_SINGER, SINGER_DB, flattened, singTake, unvoiced, type SingerModel } from './test-singer';
import { realize, rangeFromMeasurement, type RealizedExercise, type VoiceType } from './transpose';
import type { ExerciseDef } from './types';

const ex = (id: string): ExerciseDef => getExercise(id)!;

function run(def: ExerciseDef, singer: SingerModel, voice: VoiceType = 'tenor', range = null as ReturnType<typeof rangeFromMeasurement>, bpm?: number) {
  const realized = realize(def, range, voice, { bpm });
  const a = analyzeTake(def, realized, singTake(realized, singer), { vibratoStyle: 'pop' });
  return { a, e: evaluate(def, a.metrics, a), tip: pickTip(a.metrics, def, a.tipContext), realized };
}

/** A clean singer with natural vibrato wherever the exercise is about vibrato. */
const good = (def: ExerciseDef): SingerModel => ({ ...GOOD_SINGER, vibratoEverywhere: def.analyzers.includes('vibrato') });
const vibratoJudged = (def: ExerciseDef) => def.analyzers.includes('vibrato') || def.analyzers.includes('switch');

describe('clean singing', () => {
  it('passes every level, Boss Recital and audition', () => {
    for (const def of EXERCISES) {
      const { e } = run(def, good(def));
      expect(e.passed, `${def.id} scored ${e.score.toFixed(2)}`).toBe(true);
      if (def.kind !== 'range-finder') expect(e.mastery, def.id).toBeGreaterThanOrEqual(2);
    }
  });

  it('still passes every exercise with realistic frame-to-frame pitch jitter (6 cents)', () => {
    for (const def of EXERCISES) {
      const { e } = run(def, { ...good(def), jitterCents: 6, seed: 99 });
      expect(e.passed, `${def.id} scored ${e.score.toFixed(2)}`).toBe(true);
    }
  });

  it('passes in a saved high-baritone range as well', () => {
    const range = rangeFromMeasurement(43, 67, 'now');
    for (const def of EXERCISES) expect(run(def, good(def), 'baritone', range).e.passed, def.id).toBe(true);
  });

  it('gets the "clean take" message, not a correction', () => {
    expect(run(ex('foundations.sustain.2'), GOOD_SINGER).tip.id).toBe('general.polish');
  });
});

describe('each fault fails the levels that train against it', () => {
  it('silence fails everything, and the tip says nobody was heard', () => {
    for (const def of EXERCISES) {
      const { e, tip } = run(def, { ...GOOD_SINGER, silent: true });
      expect(e.passed, def.id).toBe(false);
      expect(tip.id, def.id).toBe(NO_VOICE_TIP.id);
    }
  });

  it('a whole tone off fails every level but the range finder', () => {
    for (const def of EXERCISES) {
      if (def.kind === 'range-finder') continue;
      const { e } = run(def, { ...good(def), offsetSemis: 2 });
      expect(e.passed, `${def.id} scored ${e.score.toFixed(2)}`).toBe(false);
    }
  });

  it('straight tone fails every vibrato-judged exercise', () => {
    for (const def of EXERCISES.filter(vibratoJudged)) {
      expect(run(def, { ...good(def), vibrato: null }).e.passed, def.id).toBe(false);
    }
  });

  it('vibrato through the "Straight" cues fails bloom and switching', () => {
    for (const def of EXERCISES.filter((d) => d.analyzers.includes('switch'))) {
      const { e } = run(def, { ...GOOD_SINGER, vibratoEverywhere: true, vibratoIgnoresCues: true });
      expect(e.passed, def.id).toBe(false);
    }
  });

  it('no change in loudness fails every dynamics exercise', () => {
    for (const def of EXERCISES.filter((d) => d.analyzers.includes('dynamics'))) {
      const { e, tip } = run(def, { ...GOOD_SINGER, flatLoudness: true });
      expect(e.passed, def.id).toBe(false);
      expect(tip.id, def.id).toBe('dyn.range-small');
    }
  });

  it('going sharp when loud fails the swells and is coached by name', () => {
    const { e, tip } = run(ex('dynamics.swell.3'), { ...GOOD_SINGER, centsPerDb: 3, inTuneAtDb: SINGER_DB.soft });
    expect(e.passed).toBe(false);
    expect(tip.id).toBe('dyn.sharp-loud');
  });

  it('going flat when soft is coached by name too', () => {
    const { e, tip } = run(ex('dynamics.swell.3'), { ...GOOD_SINGER, centsPerDb: 3, inTuneAtDb: SINGER_DB.loud });
    expect(e.passed).toBe(false);
    expect(tip.id).toBe('dyn.flat-soft');
  });

  it('scooping into notes fails crispness and the interval jumps, with the SPEC tip', () => {
    for (const id of ['foundations.staccato.1', 'foundations.intervals.1', 'foundations.intervals.2']) {
      const { e, tip } = run(ex(id), { ...GOOD_SINGER, scoopCents: 120, settleTauMs: 120 });
      expect(e.passed, id).toBe(false);
      expect(tip.id, id).toBe('onset.scoop-big');
    }
  });

  it('smearing fast runs fails the studio runs', () => {
    for (const id of ['runs.run.7', 'runs.run.8', 'runs.boss-recital', 'runs.audition.3']) {
      const { e } = run(ex(id), { ...GOOD_SINGER, transitionMs: 150 });
      expect(e.passed, id).toBe(false);
    }
  });

  it('a steady 30-cent sharp tells the singer to sing lower, and fails studio sustains but not easy ones', () => {
    const sharp = { ...GOOD_SINGER, biasCents: 30 };
    const easy = run(ex('foundations.sustain.1'), sharp);
    const studio = run(ex('foundations.legato.1'), sharp);
    expect(easy.e.passed).toBe(true);
    expect(studio.e.passed).toBe(false);
    expect(studio.tip.id).toBe('acc.sharp');
  });
});

describe('lazy singers: a hold or a figure that was not sung does not pass (negative controls for F2 and F7)', () => {
  function sung(def: ExerciseDef) {
    const realized = realize(def, null, 'tenor');
    return { realized, plan: planAnalysis(realized), take: singTake(realized, good(def)) };
  }
  const judge = (def: ExerciseDef, realized: RealizedExercise, take: PitchFrame[]) => {
    const a = analyzeTake(def, realized, take, { vibratoStyle: 'pop' });
    return { a, e: evaluate(def, a.metrics, a) };
  };

  it('coming in late, or stopping early, on every long hold fails the held-note levels; a quarter of the note is only a breath and a reaction time', () => {
    for (const id of ['foundations.pitch-match.1', 'foundations.sustain.1', 'foundations.sustain.2', 'foundations.audition.1']) {
      const def = ex(id);
      const { realized, plan, take } = sung(def);
      const holds = plan.accuracy.filter((n) => n.end - n.start >= 2.5);
      expect(holds.length, id).toBeGreaterThan(0);
      expect(judge(def, realized, take).e.passed, `${id} clean`).toBe(true);
      const without = (share: number) => {
        let late = take;
        let early = take;
        for (const h of holds) {
          const d = h.end - h.start;
          late = unvoiced(late, h.start, h.start + share * d);
          early = unvoiced(early, h.end - share * d, h.end);
        }
        return { late, early };
      };
      const missing = without(0.6);
      expect(judge(def, realized, missing.late).e.passed, `${id} silent for the first 60% of every hold`).toBe(false);
      expect(judge(def, realized, missing.early).e.passed, `${id} silent for the last 60% of every hold`).toBe(false);
      const fine = without(0.25);
      expect(judge(def, realized, fine.late).e.passed, `${id} 25% late`).toBe(true);
      expect(judge(def, realized, fine.early).e.passed, `${id} 25% early`).toBe(true);
    }
  });

  it('a hole of half a second in the middle of a siren is a break, marked on the trace and counted; the breath between sirens is not', () => {
    const def = ex('foundations.siren.1');
    const { realized, plan, take } = sung(def);
    expect(judge(def, realized, take).a.details.cracks, 'a clean take has no break').toEqual([]);
    const g = plan.glides[0];
    const mid = (g.start + g.end) / 2;
    const o = judge(def, realized, unvoiced(take, mid - 0.25, mid + 0.25));
    const hole = o.a.details.cracks.find((c) => c.kind === 'dropout' && c.durationMs >= 450);
    expect(hole, 'a dropout marker at least as long as the hole').toBeDefined();
    expect(hole!.t).toBeGreaterThan(mid - 0.4);
    expect(hole!.t).toBeLessThan(mid + 0.1);
    expect(o.a.metrics['glide.cracks']).toBeGreaterThanOrEqual(1);
  });

  it('is fair to a slow beginner: 0.9 s late on every Pitch match note still passes, at a reduced score; 1.2 s late does not (CONFIG.accuracy.lateStartAllowanceSec)', () => {
    const def = ex('foundations.pitch-match.1');
    const { realized, plan, take } = sung(def);
    const late = (sec: number) => judge(def, realized, plan.accuracy.reduce((t, n) => unvoiced(t, n.start, n.start + sec), take)).e;
    const clean = judge(def, realized, take).e;
    expect(late(0.9).passed).toBe(true);
    expect(late(0.9).score).toBeLessThan(clean.score - 0.05);
    expect(late(1.2).passed).toBe(false);
  });

  /** The window a figure occupies and the plain note a lazy singer sings there instead (plan.ts / inflections.ts TARGETS convention). */
  function plainNote(g: { kind: InflectionKind; targets: readonly TargetNote[] }): { from: number; to: number; midi: number } {
    const t = g.targets;
    switch (g.kind) {
      case 'scoop': return { from: t[0].start, to: t[0].end, midi: t[0].toMidi! }; // attack on the landing note, no scoop
      case 'fall': return { from: t[1].start, to: t[1].end, midi: t[0].midi }; // keep the held note, no fall
      case 'slide': return { from: t[1].start, to: t[1].end, midi: t[1].midi }; // stay on the first note, then jump
      case 'turn': return { from: t[0].start, to: t[0].end, midi: t[0].midi }; // main note only, no neighbours
      default: return { from: t[1].start, to: t[1].end, midi: t[0].midi }; // flip: stay on the low note
    }
  }

  it('skipping any ONE figure fails the studio levels, the Boss Recital and every audition above the easy tier', () => {
    // (A level that repeats one figure at the easy or default tier, such as three slides, tolerates one miss in three by design.)
    const judged = EXERCISES.filter((d) => d.analyzers.includes('inflection') && (d.tolerance === 'studio' || (d.kind === 'audition' && d.tolerance !== 'easy')));
    expect(judged.map((d) => d.id)).toEqual(expect.arrayContaining(['inflections.boss-recital', 'inflections.audition.2', 'inflections.audition.3', 'inflections.audition.4']));
    for (const def of judged) {
      const { realized, plan, take } = sung(def);
      expect(judge(def, realized, take).e.passed, `${def.id} clean`).toBe(true);
      plan.inflections.forEach((g, k) => {
        const w = plainNote(g);
        const o = judge(def, realized, flattened(take, w.from, w.to, w.midi));
        expect(o.e.passed, `${def.id}: figure ${k} (${g.kind}) as a plain note scored ${o.e.score.toFixed(2)}, inflection.score ${o.a.metrics['inflection.score']?.toFixed(2)}`).toBe(false);
      });
    }
  });

  it('a Boss Recital whose timed slide was skipped lands under the studio inflection gate (its mean alone would clear it)', () => {
    const def = ex('inflections.boss-recital');
    const { realized, plan, take } = sung(def);
    const slide = plan.inflections.find((g) => g.kind === 'slide')!;
    const w = plainNote(slide);
    const o = judge(def, realized, flattened(take, w.from, w.to, w.midi));
    const gate = def.pass.gates!.find((g) => g.metric === 'inflection.score')!;
    const figures = o.a.details.inflections.map((i) => i.result.score);
    expect(Math.max(...figures)).toBeGreaterThan(0.9); // the other three figures were sung well
    expect(figures.reduce((a, b) => a + b, 0) / figures.length).toBeGreaterThan(gate.value); // so a plain mean would have passed it
    expect(o.a.metrics['inflection.score']!).toBeLessThan(gate.value);
    expect(o.e.passed).toBe(false);
  });

  describe('a take sung only part way never passes (the analyzers measure what WAS sung, so the reach rule refuses the rest)', () => {
    const judged = EXERCISES.filter((d) => d.kind !== 'range-finder');
    const saved = rangeFromMeasurement(45, 72, 'now');

    it('going quiet from 20%, 40% or 60% of the take fails every level, Boss Recital and audition test, in the default and a saved range', () => {
      const passedOnMetricsAlone: string[] = [];
      for (const def of judged) {
        for (const range of [null, saved]) {
          const realized = realize(def, range, 'tenor');
          const take = singTake(realized, good(def));
          expect(judge(def, realized, take).e.passed, `${def.id} clean`).toBe(true);
          for (const share of [0.2, 0.4, 0.6]) {
            const quiet = unvoiced(take, share * realized.totalSec, realized.totalSec + 1);
            const { a, e } = judge(def, realized, quiet);
            expect(e.passed, `${def.id} quiet from ${share * 100}% of the take (${range ? 'saved' : 'default'} range)`).toBe(false);
            expect(e.mastery).toBe(0);
            if (evaluate(def, a.metrics).passed) {
              passedOnMetricsAlone.push(`${def.id}@${share}`);
              expect(e.unsung, `${def.id}@${share}: refused for its unsung notes`).toBeDefined();
              expect(pickTip(a.metrics, def, a.tipContext).id).toBe('general.unsung');
            }
          }
        }
      }
      // The hole this closes: the metrics of the part that was sung pass these on their own (sirens at 20%, a Boss at 60%).
      expect(passedOnMetricsAlone).toEqual(expect.arrayContaining(['foundations.siren.1@0.2', 'foundations.legato.1@0.4', 'dynamics.boss-recital@0.6']));
    });

    it('a take stopped part way is practice: not judged, whatever its metrics say', () => {
      const def = ex('foundations.siren.1');
      const realized = realize(def, saved, 'tenor');
      const take = singTake(realized, good(def));
      const stoppedAt = 0.3 * realized.totalSec;
      const sung = take.filter((f) => f.t < stoppedAt);
      const a = analyzeTake(def, realized, sung, { vibratoStyle: 'pop' });
      expect(evaluate(def, a.metrics).passed).toBe(true); // what was sung is clean...
      expect(evaluate(def, a.metrics, { ...a, complete: false })).toMatchObject({ passed: false, mastery: 0, notJudged: 'stopped' });
      // ...and a whole take is unaffected by the flag.
      const whole = analyzeTake(def, realized, take, { vibratoStyle: 'pop' });
      expect(evaluate(def, whole.metrics, { ...whole, complete: true }).passed).toBe(true);
      // A ladder never climbs on a stopped take.
      const run = ex('runs.run.1');
      const rung = startTempo(run);
      const r = realize(run, saved, 'tenor', { bpm: rung });
      const ra = analyzeTake(run, r, singTake(r, GOOD_SINGER).filter((f) => f.t < 0.6 * r.totalSec), { vibratoStyle: 'pop' });
      expect(nextTempo(run, rung, ra.metrics, { ...ra, complete: false })).toBe(rung);
    });

    it('a Boss Recital needs every note; a level forgives one note in ten; the Range finder measures, so it is exempt', () => {
      expect(reachHolds(ex('foundations.boss-recital'), { reached: 19, total: 20 })).toBe(false);
      expect(reachHolds(ex('foundations.boss-recital'), { reached: 20, total: 20 })).toBe(true);
      expect(reachHolds(ex('foundations.legato.1'), { reached: 18, total: 20 })).toBe(true);
      expect(reachHolds(ex('foundations.legato.1'), { reached: 17, total: 20 })).toBe(false);
      expect(reachHolds(ex('foundations.sustain.1'), { reached: 2, total: 3 })).toBe(false);
      expect(reachHolds(ex('foundations.range-finder.1'), { reached: 0, total: 6 })).toBe(true);
      // The one-hold case: a single swell sung for half of it is not sung.
      const def = ex('dynamics.audition.3');
      const realized = realize(def, saved, 'tenor');
      const take = singTake(realized, GOOD_SINGER);
      const longest = [...realized.notes].sort((x, y) => y.end - y.start - (x.end - x.start))[0];
      const half = unvoiced(take, longest.start + 0.55 * (longest.end - longest.start), longest.end);
      expect(noteReach(cleanOctaveSpikes(half), [longest]).reached).toBe(0);
      expect(noteReach(cleanOctaveSpikes(take), [longest]).reached).toBe(1);
    });
  });

  it('plain notes everywhere fail every inflection exercise, whatever its tier', () => {
    for (const def of EXERCISES.filter((d) => d.analyzers.includes('inflection'))) {
      const { realized, plan, take } = sung(def);
      let lazy = take;
      for (const g of plan.inflections) {
        const w = plainNote(g);
        lazy = flattened(lazy, w.from, w.to, w.midi);
      }
      expect(judge(def, realized, lazy).e.passed, def.id).toBe(false);
    }
  });
});

describe('the Vibrato world judges the style zone, not just any wobble (SPEC 8.3, 9.2)', () => {
  const judged = EXERCISES.filter((d) => d.analyzers.includes('vibrato'));

  it('covers every vibrato level, the Boss Recital and the auditions', () => {
    expect(judged.map((d) => d.id).sort()).toEqual([
      'vibrato.audition.2', 'vibrato.audition.3', 'vibrato.audition.4', 'vibrato.bloom.1', 'vibrato.boss-recital', 'vibrato.meter.1', 'vibrato.switch.1',
    ]);
  });

  it('fails a slow wide wobble, a fast bleat, an oversized and a token vibrato everywhere, coached by name', () => {
    const faults: Array<[string, NonNullable<SingerModel['vibrato']>, string]> = [
      ['wobble', { rateHz: 3.5, extentCents: 60 }, 'vib.slow'],
      ['bleat', { rateHz: 9.5, extentCents: 35 }, 'vib.fast'],
      ['oversized', { rateHz: 5.8, extentCents: 150 }, 'vib.wide'],
      ['token', { rateHz: 5.8, extentCents: 12 }, 'vib.narrow'],
    ];
    for (const def of judged) {
      for (const [name, vibrato, tip] of faults) {
        const o = run(def, { ...good(def), vibrato });
        expect(o.e.passed, `${def.id} ${name} scored ${o.e.score.toFixed(2)}`).toBe(false);
        expect(o.a.metrics['vibrato.inZone'], `${def.id} ${name}`).toBe(0);
        expect(o.tip.id, `${def.id} ${name}`).toBe(tip);
      }
    }
  });

  it('passes vibrato near, but inside, the zone edges', () => {
    for (const def of judged) {
      for (const vibrato of [{ rateHz: 5.2, extentCents: 25 }, { rateHz: 6.8, extentCents: 55 }]) {
        expect(run(def, { ...good(def), vibrato }).e.passed, `${def.id} ${vibrato.rateHz} Hz`).toBe(true);
      }
    }
  });
});

describe('the Dynamics world judges which way the loudness goes (SPEC 9.5)', () => {
  const dynamics = EXERCISES.filter((d) => d.analyzers.includes('dynamics'));

  it('fails a take sung against every cue (crescendos fading, swells inverted, steps swapped) and says so', () => {
    expect(dynamics).toHaveLength(10);
    for (const def of dynamics) {
      const o = run(def, { ...GOOD_SINGER, loudnessAgainstCues: 'invert' });
      expect(o.e.passed, `${def.id} scored ${o.e.score.toFixed(2)}`).toBe(false);
      expect(o.a.metrics['dynamics.rangeDb'], def.id).toBe(0);
      expect(o.tip.id, def.id).toBe('dyn.against-cue');
    }
  });

  it('passes a one-way ramp only where the cue asks for exactly that ramp', () => {
    // A crescendo singer legitimately passes Crescendo, a decrescendo singer Decrescendo; every swell, step drill,
    // the Boss and every audition (which mix the shapes) fail.
    for (const way of ['crescendo', 'decrescendo'] as const) {
      for (const def of dynamics) {
        const allowed = way === 'crescendo' ? def.id === 'dynamics.swell.1' : def.id === 'dynamics.swell.2';
        expect(run(def, { ...GOOD_SINGER, loudnessAgainstCues: way }).e.passed, `${def.id} sung as one ${way}`).toBe(allowed);
      }
    }
  });
});

describe('the level\'s own tolerance limits pitch in the Vibrato and Dynamics worlds too (SPEC 11)', () => {
  const atTier = (tier: ExerciseDef['tolerance']) => EXERCISES.filter((d) => (d.worldId === 'vibrato' || d.worldId === 'dynamics') && d.tolerance === tier);

  it('fails a take 40 cents off, sharp or flat, on every default and studio level, Boss and audition', () => {
    const strict = [...atTier('default'), ...atTier('studio')];
    expect(strict.length).toBeGreaterThanOrEqual(15);
    for (const def of strict) {
      for (const biasCents of [40, -40]) expect(run(def, { ...good(def), biasCents }).e.passed, `${def.id} ${biasCents} c`).toBe(false);
    }
  });

  it('fails 12 cents off at studio tolerance (±10) and lets it through at default (±25)', () => {
    for (const def of atTier('studio')) expect(run(def, { ...good(def), biasCents: 12 }).e.passed, def.id).toBe(false);
    for (const def of atTier('default')) expect(run(def, { ...good(def), biasCents: 12 }).e.passed, def.id).toBe(true);
  });
});

describe('the Runs tempo ladder (SPEC 9.4)', () => {
  /** Practice as the runner does it: start at the bottom rung and take nextTempo after every take. */
  function climb(def: ExerciseDef, singer: SingerModel): number[] {
    const sung: number[] = [];
    let bpm = startTempo(def);
    for (;;) {
      sung.push(bpm);
      const { a } = run(def, singer, 'tenor', null, bpm);
      const next = nextTempo(def, bpm, a.metrics, a);
      if (next === bpm) return sung;
      bpm = next;
    }
  }
  const studioLadders = ['runs.run.7', 'runs.run.8', 'runs.boss-recital'].map(ex);

  it('lets a singer 15-20 cents off, who passes at the pass tempo, climb the studio ladders all the way', () => {
    for (const def of studioLadders) {
      for (const biasCents of [15, 20]) {
        const singer = { ...GOOD_SINGER, biasCents };
        expect(run(def, singer).e.passed, `${def.id} ${biasCents} c at the pass tempo`).toBe(true);
        expect(climb(def, singer), `${def.id} ${biasCents} c`).toEqual([...def.tempoLadder!]);
      }
    }
  });

  it('holds a smeared run on its rung even when its run score clears 85%', () => {
    for (const def of [ex('runs.run.8'), ex('runs.boss-recital')]) {
      // As the moves between notes lengthen, definition falls off a cliff while the run score barely moves: the takes just past
      // the cliff clear the old fixed 85% mark yet fail the level's own pass rule, and must stay on their rung. The window is
      // searched rather than pinned, so a small retune of the definition measure moves it without breaking the test.
      let smeared = 0;
      for (let transitionMs = 140; transitionMs <= 160; transitionMs++) {
        const { a, e } = run(def, { ...GOOD_SINGER, transitionMs }, 'tenor', null, startTempo(def));
        if (e.passed || !(a.metrics['run.score']! >= CONFIG.runs.tempoAdvanceScore)) continue;
        smeared++;
        expect(nextTempo(def, startTempo(def), a.metrics, a), `${def.id} with ${transitionMs} ms moves`).toBe(startTempo(def));
      }
      expect(smeared, `${def.id}: a take that clears ${CONFIG.runs.tempoAdvanceScore} and still fails the level`).toBeGreaterThan(0);
    }
  });

  it('keeps a poor singer on the first rung of every studio ladder', () => {
    for (const def of studioLadders) expect(climb(def, POOR_SINGER), def.id).toEqual([startTempo(def)]);
  });
});

describe('ranges: nothing is folded for a singer who passed the Range finder', () => {
  const octave = rangeFromMeasurement(50, 62, 'now'); // the narrowest range a passed Range finder saves

  it('fits every exercise, every figure intact, into an octave, and a clean singer passes them all there', () => {
    for (const def of EXERCISES) {
      for (const voice of ['unknown', 'tenor', 'baritone'] as const) {
        const o = run(def, good(def), voice, octave);
        expect(o.realized.fit, `${def.id} ${voice}`).not.toBe('folded');
        expect(planAnalysis(o.realized).issues, `${def.id} ${voice}`).toEqual([]);
        expect(o.e.passed, `${def.id} ${voice} scored ${o.e.score.toFixed(2)}`).toBe(true);
      }
    }
    // These two spanned 13 semitones and lost their flip in a 12-semitone range.
    expect(realize(ex('inflections.boss-recital'), octave, 'unknown').inflections.map((g) => g.kind)).toEqual(['turn', 'turn', 'slide', 'flip']);
    expect(realize(ex('inflections.audition.4'), octave, 'unknown').inflections.map((g) => g.kind)).toEqual(['turn', 'turn', 'flip']);
  });

  it('refuses a take of an exercise folded into a narrower (legacy) range, though its metrics alone would pass', () => {
    const def = ex('inflections.audition.4');
    const o = run(def, GOOD_SINGER, 'unknown', rangeFromMeasurement(50, 61, 'now'));
    expect(o.realized.fit).toBe('folded');
    expect(o.realized.inflections.map((g) => g.kind)).toEqual(['turn', 'turn']); // the octave flip became a unison
    expect(evaluate(def, o.a.metrics).passed).toBe(true);
    expect(o.e).toMatchObject({ passed: false, mastery: 0, notJudged: 'folded' });
    expect(o.tip.id).toBe(UNFIT_RANGE_TIP.id);
  });
});

describe('the Range finder', () => {
  const def = ex('foundations.range-finder.1');

  /** Holds `low` and then `high` for three seconds each, like a singer exploring less (or more) than the guides. */
  function sweep(low: number, high: number) {
    const realized = realize(def, null, 'tenor');
    const midi = (t: number) => (t >= 1 && t < 4 ? low : t >= 6 && t < 9 ? high : NaN);
    return analyzeTake(def, realized, makeTrack({ duration: realized.totalSec + 1, t0: -0.5, midi, jitterCents: 3 }), { vibratoStyle: 'pop' });
  }

  it('passes an octave, fails a timid ten semitones with the tip to explore a little further', () => {
    expect(evaluate(def, sweep(50, 62).metrics).passed).toBe(true);
    const timid = sweep(50, 60);
    expect(timid.metrics['range.spanSemitones']).toBe(10);
    expect(evaluate(def, timid.metrics).passed).toBe(false);
    expect(pickTip(timid.metrics, def, timid.tipContext).id).toBe('range.narrow');
  });

  it('answers a sung take that never held a note with how to hold one, not a mic warning', () => {
    const realized = realize(def, null, 'tenor');
    const mid = realized.tonicMidi;
    // An 18-semitone siren up and down, never still: plenty of voice, no held note.
    const siren = (t: number) => (t < 0 || t >= realized.totalSec ? NaN : mid - 9 + 18 * (1 - Math.abs(((t / 4) % 1) * 2 - 1)));
    const a = analyzeTake(def, realized, makeTrack({ duration: realized.totalSec + 1, t0: -0.5, midi: siren, jitterCents: 3 }), { vibratoStyle: 'pop' });
    expect(a.voicedSec).toBeGreaterThan(10);
    expect(a.tipContext.noVoice).toBeFalsy();
    expect(a.metrics).toEqual({});
    expect(evaluate(def, a.metrics, a).passed).toBe(false);
    expect(pickTip(a.metrics, def, a.tipContext).id).toBe('range.missing');
  });
});

describe('what the take report gets', () => {
  it('ignores the breaths between siren phrases but marks a break inside a glide', () => {
    const def = ex('foundations.siren.1');
    expect(run(def, GOOD_SINGER).a.details.cracks).toEqual([]);
    const realized = realize(def, null, 'tenor');
    const glide = realized.notes.find((n) => n.toMidi !== undefined && n.toMidi - n.midi === 12)!;
    const mid = (glide.start + glide.end) / 2;
    const { a } = run(def, { ...GOOD_SINGER, breaks: [mid] });
    expect(a.metrics['glide.cracks']).toBeGreaterThanOrEqual(1);
    expect(a.details.cracks.some((c) => Math.abs(c.t - mid) < 0.1)).toBe(true);
  });

  it('gives a verdict for every run note, defined when sung cleanly', () => {
    const { a } = run(ex('runs.run.3'), GOOD_SINGER);
    const notes = a.details.runs.flatMap((r) => r.result.notes);
    expect(notes).toHaveLength(15);
    expect(notes.every((n) => n.verdict === 'defined')).toBe(true);
  });

  it('judges symmetry on the swell alone in the Dynamics Boss Recital', () => {
    const { a } = run(ex('dynamics.boss-recital'), GOOD_SINGER);
    const swell = a.details.dynamics.find((d) => d.shape === 'swell')!;
    expect(a.metrics['dynamics.symmetry']).toBeCloseTo(swell.result.symmetry!, 9);
  });

  it('measures against the level\'s tolerance, never a user setting', () => {
    const sharp = { ...GOOD_SINGER, biasCents: 30 };
    const easy = run(ex('foundations.sustain.1'), sharp).a.details.accuracy[0].result.inTolerancePct;
    const studio = run(ex('foundations.legato.1'), sharp).a.details.accuracy[0].result.inTolerancePct;
    expect(CONFIG.tolerance.easy).toBeGreaterThan(CONFIG.tolerance.studio);
    expect(easy).toBeGreaterThan(studio);
  });
});
