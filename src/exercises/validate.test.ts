import { describe, expect, it } from 'vitest';
import { CATALOG, getExercise } from './catalog';
import { CUE } from './cues';
import type { ExerciseDef, WorldDef } from './types';
import { RANGE_CASES, validateCatalog, validateExercise, type ValidationIssue } from './validate';

type Mutable = { worlds: WorldDef[]; exercises: ExerciseDef[] };
const clone = (): Mutable => JSON.parse(JSON.stringify(CATALOG)) as Mutable;
const exOf = (c: Mutable, id: string) => c.exercises.find((e) => e.id === id)!;
const worldOf = (c: Mutable, id: string) => c.worlds.find((w) => w.id === id)!;
const text = (issues: readonly ValidationIssue[]) => issues.map((i) => `${i.path}: ${i.message}`);

/** Validate a mutated copy of the real catalog (no range cases unless asked: they are slow and checked elsewhere). */
function issuesAfter(mutate: (c: Mutable) => void, withRanges = false): string[] {
  const c = clone();
  mutate(c);
  return text(validateCatalog(c, withRanges ? RANGE_CASES : []));
}

describe('validateCatalog on the real catalog', () => {
  it('finds nothing wrong, transposition included', () => {
    expect(text(validateCatalog(CATALOG))).toEqual([]);
  });

  it('accepts each exercise on its own', () => {
    for (const e of CATALOG.exercises) expect(text(validateExercise(e))).toEqual([]);
  });
});

describe('validateCatalog catches', () => {
  const cases: Array<[string, (c: Mutable) => void, RegExp]> = [
    ['a duplicate exercise id', (c) => c.exercises.push({ ...exOf(c, 'foundations.sustain.1') }), /duplicate exercise id/],
    ['a level pointing at a missing exercise', (c) => (worldOf(c, 'foundations').levels[2].exerciseId = 'foundations.nope.1'), /references missing exercise/],
    ['a score term on a metric no analyzer produces', (c) => exOf(c, 'foundations.sustain.1').scoring.push({ metric: 'run.score', weight: 0.1, best: 1, worst: 0 }), /no listed analyzer/],
    ['a gate on the wrong side', (c) => (exOf(c, 'foundations.sustain.1').pass.gates![0].op = '<='), /gated with >=/],
    ['tiers out of order', (c) => (exOf(c, 'foundations.sustain.1').tiers = { solid: 0.5, studio: 0.9 }), /tiers must satisfy/],
    ['a gate a perfect take would fail', (c) => (exOf(c, 'foundations.sustain.1').pass.gates![0].value = 99), /stricter than the term's best/],
    ['an exercise without gates', (c) => (exOf(c, 'foundations.sustain.1').pass.gates = []), /at least one gate/],
    ['tolerance loosening inside a world', (c) => (exOf(c, 'foundations.intervals.2').tolerance = 'easy'), /looser than an earlier level/],
    ['a world opening at studio', (c) => (exOf(c, 'foundations.range-finder.1').tolerance = 'studio'), /cannot open at studio/],
    ['a Boss Recital below studio', (c) => (exOf(c, 'runs.boss-recital').tolerance = 'default'), /sung at studio tolerance/],
    ['a second Boss Recital', (c) => (worldOf(c, 'vibrato').levels[3].kind = 'boss'), /exactly one Boss Recital/],
    ['a Boss Recital that is not last', (c) => worldOf(c, 'dynamics').levels.reverse(), /must be the last level/],
    ['levels numbered out of order', (c) => (worldOf(c, 'runs').levels[1].index = 7), /index 7 should be 2/],
    ['worlds in the wrong order', (c) => c.worlds.reverse(), /world order/],
    ['a world unlocked by the wrong boss', (c) => (worldOf(c, 'runs').unlockedBy = 'foundations.boss'), /must be unlocked by inflections/],
    ['an audition reaching into another world', (c) => (worldOf(c, 'vibrato').audition!.unlockThrough[0] = 'inflections.02'), /not a level of vibrato/],
    ['an audition skipping the Boss Recital', (c) => (worldOf(c, 'runs').audition!.unlockThrough[2] = 'runs.boss'), /never skip the Boss Recital/],
    ['an audition looser than what it skips', (c) => (exOf(c, 'foundations.audition.4').tolerance = 'default'), /sung at default but skips up to foundations.09 at studio/],
    ['an audition that skips a skill it never tests', (c) => (exOf(c, 'foundations.audition.4').analyzers = ['accuracy']), /without testing its "transitions" skill/],
    ['an audition test from another world', (c) => (worldOf(c, 'dynamics').audition!.exerciseIds[0] = 'runs.audition.1'), /belongs to runs, not dynamics/],
    ['an exercise nothing uses', (c) => c.exercises.push({ ...exOf(c, 'foundations.sustain.1'), id: 'foundations.sustain.9' }), /not used by any level or audition/],
    ['an attack without a breath before it', (c) => {
      const e = exOf(c, 'foundations.staccato.1');
      e.pattern = e.pattern.map((s) => (s.semis === undefined ? { ...s, beats: 0.25 } : s));
    }, /follows only 0\.18 s of silence/],
    ['a malformed slide', (c) => {
      const e = exOf(c, 'inflections.slide.1');
      e.pattern[1] = { semis: 4, beats: 1 };
    }, /a slide is a held note followed by a glide/],
    ['a cue that looks like a semantic one', (c) => (exOf(c, 'foundations.sustain.1').pattern[0].cue = 'straight'), /looks like the semantic cue "Straight"/],
    ['a vibrato exercise without the style demo', (c) => (exOf(c, 'vibrato.meter.1').demo = { timbre: 'soft', vibrato: null }), /vibrato 'style'/],
    ['a ladder that does not end at the pass tempo', (c) => (exOf(c, 'runs.run.3').tempoLadder = [45, 68]), /top rung/],
    ['a kind missing its core analyzer', (c) => (exOf(c, 'foundations.staccato.1').analyzers = ['accuracy']), /needs the "onset" analyzer/],
    ['a two-sentence goal', (c) => (exOf(c, 'foundations.sustain.1').goal = 'Hold it. Then rest.'), /single plain sentence/],
    ['a repeated pattern with no breath', (c) => exOf(c, 'foundations.legato.1').pattern.pop(), /must end with a rest/],
    ['an exercise with no coaching tips', (c) => (exOf(c, 'foundations.sustain.1').tipIds = []), /no coaching tips/],
    ['a switch drill window too short to judge', (c) => (exOf(c, 'vibrato.switch.1').pattern[1].beats = 0.5), /window of 0\.50 s is shorter/],
    ['symmetry judged without a swell', (c) => {
      const e = exOf(c, 'dynamics.swell.3');
      e.pattern = e.pattern.map((s) => (s.cue === CUE.swell ? { ...s, cue: CUE.crescendo } : s));
    }, /symmetry needs a note cued/],
    ['a dynamics hold with no loudness cue to follow', (c) => (exOf(c, 'dynamics.swell.1').pattern[0].cue = 'Hold it, nice and even'), /needs a loudness cue/],
    ['material wider than the narrowest range the Range finder saves', (c) => (exOf(c, 'foundations.sustain.2').pattern[2].semis = 14),
      /foundations\.sustain\.2: material spans 14 semitones, wider than the narrowest range the Range finder saves \(12\)/],
    ['a Range finder asking for more than its guide bars span', (c) => (exOf(c, 'foundations.range-finder.1').pass.gates![0].value = 14),
      /guide bars span 12 semitones but a pass needs 14/],
    ['a Range finder that does not gate the span', (c) => (exOf(c, 'foundations.range-finder.1').pass.gates = []), /must gate range\.spanSemitones/],
  ];

  for (const [name, mutate, re] of cases) {
    it(name, () => {
      const found = issuesAfter(mutate);
      expect(found.some((m) => re.test(m)), `expected ${re} in:\n${found.join('\n')}`).toBe(true);
    });
  }

  it('material too wide for the default ranges', () => {
    const found = issuesAfter((c) => {
      const e = exOf(c, 'foundations.sustain.2');
      e.pattern[2] = { ...e.pattern[2], semis: 26 };
    }, true);
    expect(found.some((m) => /folded/.test(m))).toBe(true);
    expect(found.some((m) => /does not fit the default comfortable range/.test(m))).toBe(true);
  });
});

describe('RANGE_CASES', () => {
  it('cover both voice types, every default, typical saved ranges and the narrowest range the Range finder saves, folding nothing', () => {
    expect(new Set(RANGE_CASES.map((c) => c.voiceType))).toEqual(new Set(['tenor', 'baritone', 'other', 'unknown']));
    expect(RANGE_CASES.filter((c) => c.range === null)).toHaveLength(4);
    expect(RANGE_CASES.filter((c) => c.allowFold)).toHaveLength(0);
    const finder = getExercise('foundations.range-finder.1')!;
    const minSpan = finder.pass.gates!.find((g) => g.metric === 'range.spanSemitones')!.value;
    const widths = RANGE_CASES.flatMap((c) => (c.range ? [c.range.extended.high - c.range.extended.low] : []));
    expect(Math.min(...widths)).toBe(minSpan);
  });
});
