import { describe, expect, it } from 'vitest';
import { LESSONS } from '../lessons';
import type { LessonDef } from '../lessons/types';
import { CATALOG, getExercise } from './catalog';
import { CUE } from './cues';
import type { ExerciseDef, WorldDef } from './types';
import { RANGE_CASES, validateCatalog, validateExercise, validateLessons, type ValidationIssue } from './validate';

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

  it('accepts each exercise sung today on its own (retired ones are history, never judged as material to sing)', () => {
    const live = CATALOG.exercises.filter((e) => e.retired === undefined);
    expect(live.length).toBeLessThan(CATALOG.exercises.length);
    for (const e of live) expect(text(validateExercise(e))).toEqual([]);
  });

  it('lets a lesson play a slide as it is sung (a Listen that glides), and nothing else', () => {
    const glidingListens = CATALOG.exercises.filter((e) => e.retired === undefined && e.pattern.some((s) => s.cue === CUE.listen && s.glideToSemis !== undefined));
    expect(glidingListens.map((e) => e.id)).toContain('foundations.sirens.1');
    expect(new Set(glidingListens.map((e) => e.worldId))).toEqual(new Set(['foundations']));
  });
});

describe('validateCatalog catches', () => {
  const cases: Array<[string, (c: Mutable) => void, RegExp]> = [
    ['a duplicate exercise id', (c) => c.exercises.push({ ...exOf(c, 'foundations.hold.1') }), /duplicate exercise id/],
    ['a level pointing at a missing exercise', (c) => (worldOf(c, 'foundations').levels[2].exerciseId = 'foundations.nope.1'), /references missing exercise/],
    ['a score term on a metric no analyzer produces', (c) => exOf(c, 'foundations.hold.1').scoring.push({ metric: 'run.score', weight: 0.1, best: 1, worst: 0 }), /no listed analyzer/],
    ['a gate on the wrong side', (c) => (exOf(c, 'foundations.hold.1').pass.gates![0].op = '<='), /gated with >=/],
    ['tiers out of order', (c) => (exOf(c, 'foundations.hold.1').tiers = { solid: 0.5, studio: 0.9 }), /tiers must satisfy/],
    ['a gate a perfect take would fail', (c) => (exOf(c, 'foundations.hold.1').pass.gates![0].value = 99), /stricter than the term's best/],
    ['an exercise without gates', (c) => (exOf(c, 'foundations.hold.1').pass.gates = []), /at least one gate/],
    ['tolerance loosening inside a world', (c) => (exOf(c, 'foundations.jumps.2').tolerance = 'easy'), /looser than an earlier level/],
    ['a world opening at studio', (c) => (exOf(c, 'foundations.range.1').tolerance = 'studio'), /cannot open at studio/],
    ['a Boss Recital looser than its world', (c) => (exOf(c, 'runs.boss-recital').tolerance = 'default'), /runs\.boss: the Boss Recital is sung at its world's strictest tolerance/],
    ['a second Boss Recital', (c) => (worldOf(c, 'vibrato').levels[3].kind = 'boss'), /exactly one Boss Recital/],
    ['a Boss Recital that is not last', (c) => worldOf(c, 'dynamics').levels.reverse(), /must be the last level/],
    ['levels numbered out of order', (c) => (worldOf(c, 'runs').levels[1].index = 7), /index 7 should be 2/],
    ['worlds in the wrong order', (c) => c.worlds.reverse(), /world order/],
    ['a world unlocked by the wrong boss', (c) => (worldOf(c, 'runs').unlockedBy = 'foundations.boss'), /must be unlocked by inflections/],
    ['an audition reaching into another world', (c) => (worldOf(c, 'vibrato').audition!.unlockThrough[0] = 'inflections.02'), /not a level of vibrato/],
    ['an audition skipping the Boss Recital', (c) => (worldOf(c, 'runs').audition!.unlockThrough[2] = 'runs.boss'), /never skip the Boss Recital/],
    ['an audition looser than what it skips', (c) => (exOf(c, 'foundations.audition.7').tolerance = 'easy'), /sung at easy but skips up to foundations.09 at default/],
    ['an audition that skips a skill it never tests', (c) => (exOf(c, 'foundations.audition.7').analyzers = ['accuracy']), /without testing its "transitions" skill/],
    ['an audition test from another world', (c) => (worldOf(c, 'dynamics').audition!.exerciseIds[0] = 'runs.audition.1'), /belongs to runs, not dynamics/],
    ['an exercise nothing uses', (c) => c.exercises.push({ ...exOf(c, 'foundations.hold.1'), id: 'foundations.hold.9' }), /not used by any level or audition/],
    ['an attack without a breath before it', (c) => {
      const e = exOf(c, 'foundations.clean-starts.1');
      e.pattern = e.pattern.map((s) => (s.semis === undefined ? { ...s, beats: 0.25 } : s));
    }, /follows only 0\.21 s of silence/],
    ['a malformed slide', (c) => {
      const e = exOf(c, 'inflections.slide.1');
      e.pattern[1] = { semis: 4, beats: 1 };
    }, /a slide is a held note followed by a glide/],
    ['a cue that looks like a semantic one', (c) => (exOf(c, 'foundations.hold.1').pattern[0].cue = 'straight'), /looks like the semantic cue "Straight"/],
    ['a vibrato exercise without the style demo', (c) => (exOf(c, 'vibrato.meter.1').demo = { timbre: 'soft', vibrato: null }), /vibrato 'style'/],
    ['a ladder that does not end at the pass tempo', (c) => (exOf(c, 'runs.run.3').tempoLadder = [45, 68]), /top rung/],
    ['a kind missing its core analyzer', (c) => (exOf(c, 'foundations.clean-starts.1').analyzers = ['accuracy']), /needs the "onset" analyzer/],
    ['a two-sentence goal', (c) => (exOf(c, 'foundations.hold.1').goal = 'Hold it. Then rest.'), /single plain sentence/],
    ['a repeated pattern with no breath', (c) => exOf(c, 'vibrato.oscillation.1').pattern.pop(), /must end with a rest/],
    ['an exercise with no coaching tips', (c) => (exOf(c, 'foundations.hold.1').tipIds = []), /no coaching tips/],
    ['a switch drill window too short to judge', (c) => (exOf(c, 'vibrato.switch.1').pattern[1].beats = 0.5), /window of 0\.50 s is shorter/],
    ['symmetry judged without a swell', (c) => {
      const e = exOf(c, 'dynamics.swell.3');
      e.pattern = e.pattern.map((s) => (s.cue === CUE.swell ? { ...s, cue: CUE.crescendo } : s));
    }, /symmetry needs a note cued/],
    ['a dynamics hold with no loudness cue to follow', (c) => (exOf(c, 'dynamics.swell.1').pattern[0].cue = 'Hold it, nice and even'), /needs a loudness cue/],
    ['material wider than the narrowest range the Range finder saves', (c) => (exOf(c, 'foundations.steady.1').pattern[2].semis = 13),
      /foundations\.steady\.1: material spans 14 semitones, wider than the narrowest range the Range finder saves \(12\)/],
    ['a Range finder asking for more than its guide bars span', (c) => (exOf(c, 'foundations.range.1').pass.gates![0].value = 14),
      /guide bars span 12 semitones but a pass needs 14/],
    ['a Range finder that does not gate the span', (c) => (exOf(c, 'foundations.range.1').pass.gates = []), /must gate range\.spanSemitones/],
    // Levels are ordered by index; the id is persisted identity.
    ['a level id that is not a world number', (c) => (worldOf(c, 'foundations').levels[4].id = 'foundations.steps'), /foundations\.steps: a level id is foundations\.NN/],
    // The echo rule (worlds taught as lessons).
    ['an echo that plays another note than the one sung back', (c) => (exOf(c, 'foundations.match.1').pattern[0].semis = 1),
      /foundations\.match\.1 step 1: the Listen plays 1 but the chunk asks for 0/],
    ['an echo exercise that opens with the singer', (c) => (exOf(c, 'foundations.hold.1').pattern[0].cue = 'Sing'), /opens with the app playing the first chunk/],
    ['a metronome under an echo exercise', (c) => (exOf(c, 'foundations.hold.1').metronome = true), /sounds nothing while the singer sings: no metronome/],
    ['no breath between the Listen and the singer\'s turn', (c) => (exOf(c, 'foundations.hold.1').pattern[1].beats = 0.25),
      /the singer's turn after a Listen lasts 0\.25 s/],
    ['a sung chunk running straight into the next Listen', (c) => exOf(c, 'foundations.hold.1').pattern.splice(3, 1), /ends with a breath before the next Listen/],
    ['a chunk too long to hold in mind', (c) => {
      const line = [0, 2, 4, 5, 7, 9];
      exOf(c, 'foundations.do-re-mi.1').pattern = [
        ...line.map((semis) => ({ semis, beats: 1, cue: CUE.listen })), { beats: 1 }, ...line.map((semis) => ({ semis, beats: 1 })),
      ];
    }, /a chunk of 6 notes is more than a beginner can hold in mind/],
    // A Listen step may glide only where a slide is played as it is sung (a world taught as lessons).
    ['a gliding Listen outside the worlds taught as lessons', (c) => {
      const e = exOf(c, 'vibrato.oscillation.1');
      e.pattern = [{ semis: 0, beats: 1, glideToSemis: 2, cue: CUE.listen }, ...e.pattern];
    }, /vibrato\.oscillation\.1 step 0: a Listen step cannot glide/],
    // Retired material (sung before a rebuild, kept only to read old takes back) is sung by nothing.
    ['a level playing a retired exercise', (c) => (worldOf(c, 'foundations').levels[2].exerciseId = 'foundations.sustain.1'), /foundations\.03: plays foundations\.sustain\.1, which is retired/],
    ['an audition testing with a retired exercise', (c) => (worldOf(c, 'foundations').audition!.exerciseIds[0] = 'foundations.audition.1'),
      /foundations\.audition\.1: a retired exercise is never sung/],
    ['a former audition test that is not retired', (c) => {
      const f = worldOf(c, 'foundations').audition!.former!;
      (f.exerciseIds as string[])[0] = 'foundations.audition.5';
    }, /foundations\.audition\.5 must be a retired audition test of foundations/],
    ['a former audition that would grant the Range finder', (c) => (worldOf(c, 'foundations').audition!.former!.keeps as string[]).push('foundations.01'),
      /can never grant foundations\.01/],
    ['a former audition that keeps a level no former test reached', (c) => (worldOf(c, 'foundations').audition!.former!.keeps as string[]).push('foundations.12'),
      /keeps foundations\.12, which no former test could have reached/],
    // Lesson drills.
    ['a practice drill played by a level', (c) => (worldOf(c, 'foundations').levels[2].exerciseId = 'foundations.drill.hold-4s'), /a practice drill is never a level or an audition test/],
    ['a practice drill that asks for too much singing', (c) => {
      const e = exOf(c, 'foundations.drill.hold-2s');
      e.pattern = e.pattern.map((s) => (s.semis !== undefined && s.cue !== CUE.listen ? { ...s, beats: s.beats * 3 } : s));
    }, /a practice drill asks for 18\.0 s of singing; keep it within 5-12 s/],
  ];

  for (const [name, mutate, re] of cases) {
    it(name, () => {
      const found = issuesAfter(mutate);
      expect(found.some((m) => re.test(m)), `expected ${re} in:\n${found.join('\n')}`).toBe(true);
    });
  }

  it('material too wide for the default ranges', () => {
    const found = issuesAfter((c) => {
      const e = exOf(c, 'foundations.steady.1');
      e.pattern[2] = { ...e.pattern[2], semis: 26 };
    }, true);
    expect(found.some((m) => /folded/.test(m))).toBe(true);
    expect(found.some((m) => /does not fit the default comfortable range/.test(m))).toBe(true);
  });
});

describe('validateLessons', () => {
  type Mut<T> = T extends ReadonlyArray<infer U> ? Array<Mut<U>> : T extends object ? { -readonly [K in keyof T]: Mut<T[K]> } : T;
  type MutableLessons = Record<string, Mut<LessonDef>>;
  const lessonsAfter = (mutate: (l: MutableLessons, c: Mutable) => void): string[] => {
    const lessons = JSON.parse(JSON.stringify(LESSONS)) as MutableLessons;
    const c = clone();
    mutate(lessons, c);
    return text(validateLessons(lessons as Record<string, LessonDef>, c));
  };

  it('finds nothing wrong with the real lessons', () => {
    expect(text(validateLessons(LESSONS, CATALOG))).toEqual([]);
  });

  const cases: Array<[string, (l: MutableLessons, c: Mutable) => void, RegExp]> = [
    ['a lesson for a level that does not exist', (l) => (l['foundations.03'].levelId = 'foundations.99'), /teaches foundations\.99, which is not a level/],
    ['a term taught twice', (l) => l['foundations.03'].learn.terms.push('pitch'), /term "pitch" is already taught by foundations\.02/],
    ['an unknown term', (l) => (l['foundations.03'].learn.terms as string[]).push('tessitura'), /unknown term "tessitura"/],
    ['a Learn page with one how-to line', (l) => (l['foundations.03'].learn.how = ['Sing.']), /1 how-to lines; expected 3-5/],
    ['one practice step', (l) => l['foundations.03'].practice.splice(1), /has 1 practice steps; expected 2-4/],
    ['a level\'s own exercise as a drill', (l) => (l['foundations.03'].practice[0].exerciseId = 'foundations.hold.1'), /is a level's exercise or an audition test, never a drill/],
    ['a retired exercise as a drill', (l) => (l['foundations.03'].practice[0].exerciseId = 'foundations.sustain.1'), /foundations\.sustain\.1 is retired: practice never sings it/],
    ['a drill shared by two lessons', (l) => (l['foundations.03'].practice[0].exerciseId = 'foundations.drill.echo-one'), /foundations\.drill\.echo-one is already a practice step of foundations\.02/],
    ['a drill no lesson uses', (l) => l['foundations.03'].practice.pop(), /foundations\.drill\.hold-4s: a practice drill that no lesson uses/],
    ['a good try on a metric the drill does not measure', (l) => l['foundations.03'].practice[0].good.conditions.push({ metric: 'glide.cracks', op: '<=', value: 2 }),
      /reads glide\.cracks, which foundations\.drill\.hold-2s does not measure/],
    ['a good try held the wrong way', (l) => (l['foundations.03'].practice[0].good.conditions[0].op = '<='), /accuracy\.inTolerancePct is better higher: hold it to >=/],
    ['a good try stricter than the check', (l) => (l['foundations.13'].practice[0].good.conditions[0].value = 10),
      /a good try asks accuracy\.sdCents <= 10, more than the check's own gate/],
    ['practice at another tolerance than the check', (_l, c) => (exOf(c, 'foundations.drill.hold-2s').tolerance = 'default'),
      /sung at default, its check at easy: practise in the zone the check uses/],
  ];

  for (const [name, mutate, re] of cases) {
    it(`catches ${name}`, () => {
      const found = lessonsAfter(mutate);
      expect(found.some((m) => re.test(m)), `expected ${re} in:\n${found.join('\n')}`).toBe(true);
    });
  }
});

describe('RANGE_CASES', () => {
  it('cover both voice types, every default, typical saved ranges and the narrowest range the Range finder saves, folding nothing', () => {
    expect(new Set(RANGE_CASES.map((c) => c.voiceType))).toEqual(new Set(['tenor', 'baritone', 'other', 'unknown']));
    expect(RANGE_CASES.filter((c) => c.range === null)).toHaveLength(4);
    expect(RANGE_CASES.filter((c) => c.allowFold)).toHaveLength(0);
    const finder = getExercise('foundations.range.1')!;
    const minSpan = finder.pass.gates!.find((g) => g.metric === 'range.spanSemitones')!.value;
    const widths = RANGE_CASES.flatMap((c) => (c.range ? [c.range.extended.high - c.range.extended.low] : []));
    expect(Math.min(...widths)).toBe(minSpan);
  });
});
