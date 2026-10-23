/**
 * The Foundations lessons as the owner asked for them (2026-10-23): a lesson per level in the brief's order, one new thing
 * each, every music word taught before any later lesson leans on it, plain words throughout, and practice that is short,
 * echo-shaped and lenient. The catalog-level rules (the echo shape, drill length, the lesson validator) live in
 * src/exercises/validate.ts; this file pins the teaching content itself.
 */
import { describe, expect, it } from 'vitest';
import type { Metrics } from '../analysis/types';
import { CHECKUP_TASKS } from '../checkup/types';
import { jargonIn } from '../coaching/plain';
import { CATALOG, getExercise, getLevel, getWorld, levelsOf } from '../exercises/catalog';
import { ENTRY, populationValue, type ScoredMetric } from '../exercises/catalog/scoring';
import { CUE } from '../exercises/cues';
import { gateHolds } from '../exercises/evaluate';
import { metricsProducedBy } from '../exercises/metrics';
import { realize } from '../exercises/transpose';
import type { ExerciseDef, PatternStep } from '../exercises/types';
import { isDrillId, validateLessons } from '../exercises/validate';
import { TERMS, type TermId } from '../teach/glossary';
import { GLOSSARY } from '../teach/glossary-content';
import { FOUNDATIONS_LESSON_ORDER } from './foundations';
import { LESSONS, lessonFor, lessonOfDrill } from './index';
import type { LessonDef } from './types';

const ex = (id: string): ExerciseDef => {
  const e = getExercise(id);
  if (!e) throw new Error(`missing exercise ${id}`);
  return e;
};
const checkOf = (lesson: LessonDef): ExerciseDef => ex(getLevel(lesson.levelId)!.exerciseId);
const drillsOf = (lesson: LessonDef): ExerciseDef[] => lesson.practice.map((p) => ex(p.exerciseId));
/** The Foundations exercises sung today (the retired ones, kept only to read old takes back, are not lessons' material). */
const FOUNDATION_EXERCISES = CATALOG.exercises.filter((e) => e.worldId === 'foundations' && e.retired === undefined);

/** The brief, in order: level id, lesson title, and the music words the lesson teaches. */
const BRIEF: ReadonlyArray<readonly [string, string, readonly TermId[]]> = [
  ['foundations.01', 'Range finder', ['range', 'count-in']],
  ['foundations.02', 'Match one note', ['pitch', 'note', 'in-tune', 'sharp', 'flat', 'in-tune-zone', 'echo']],
  ['foundations.03', 'Hold it', ['breath-support']],
  ['foundations.13', 'Hold it steady', ['steady', 'wobble', 'drift']],
  ['foundations.10', 'Two notes, one step apart', ['step', 'half-step']],
  ['foundations.07', 'Two notes, a jump apart', ['jump']],
  ['foundations.08', 'Bigger jumps', ['octave']],
  ['foundations.11', 'Three notes: do-re-mi', ['scale', 'do-re-mi']],
  ['foundations.09', 'Five notes in a row', ['phrase']],
  ['foundations.12', 'Small slides', ['slide']],
  ['foundations.05', 'Sirens', ['siren', 'gear-change', 'crack']],
  ['foundations.06', 'Clean starts', ['clean-start', 'scoop', 'beat']],
  ['foundations.boss', 'Boss Recital', []],
];

/** Every word a singer reads in a lesson: its pages, its practice, and the drills and check it plays. */
function textsOf(lesson: LessonDef): string[] {
  const { learn } = lesson;
  const exercises = [...drillsOf(lesson), checkOf(lesson)];
  return [
    lesson.title,
    lesson.outcome,
    learn.what,
    learn.why,
    ...learn.how,
    ...learn.onScreen,
    ...lesson.practice.flatMap((p) => [p.title, p.ask]),
    ...exercises.flatMap((e) => [e.title, e.goal, ...(e.steps ?? []), e.passPlain ?? '', ...e.pattern.flatMap((s) => (s.cue ? [s.cue] : []))]),
  ].filter((t) => t !== '');
}

/** Words that must never reach a singer here: the coach's jargon, and the analyst's names for what these lessons teach. */
const NOT_FOR_SINGERS: readonly RegExp[] = [
  /\btolerance\b/i,
  /\bsettl(e|es|ed|ing)\b/i,
  /\bovershoot/i,
  /\binterval/i,
  /\blegato\b/i,
  /\bstaccato\b/i,
  /\btonic\b/i,
  /\bsustain/i,
  /\bglid(e|es|ing)\b/i,
  /\bcrisp/i,
  /\bregister\b/i,
  /\bfalsetto\b/i,
  // Glossary words Foundations never teaches.
  /\bvibrato\b/i,
  /\btempo\b/i,
];

/**
 * Music words that would confuse before they are taught, so no earlier lesson uses them. Everyday words that the glossary
 * also explains (note, slide, siren, range, count-in) are left out: the first lesson needs them in their plain sense,
 * and they stay tappable wherever they appear.
 */
const TAUGHT_FIRST: readonly TermId[] = [
  'pitch', 'in-tune', 'sharp', 'flat', 'in-tune-zone', 'echo', 'breath-support', 'steady', 'wobble', 'drift', 'step', 'half-step', 'jump',
  'octave', 'scale', 'do-re-mi', 'phrase', 'gear-change', 'crack', 'clean-start', 'scoop', 'beat',
];

/** A glossary word as the lesson screens find it (src/ui/lesson/terms.tsx): any case, a space or a hyphen between its parts, a plural. */
const wordRe = (word: string): RegExp =>
  new RegExp(`\\b${word.split(/[\s-]+/).map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[\\s-]')}(?:e?s)?\\b`, 'i');
/** The ways a term is written in running text: its word, and "drift" for "drifting" (the screens link it too). */
const wordsOf = (t: TermId): string[] => (t === 'drift' ? [TERMS[t], 'drift'] : [TERMS[t]]);

/** The chunks of an echo pattern: what the app plays, and the pitches sung back after it (a slide by its two ends). */
function chunksOf(pattern: readonly PatternStep[]): Array<{ heard: number[]; sung: number[] }> {
  const out: Array<{ heard: number[]; sung: number[] }> = [];
  for (const s of pattern) {
    if (s.cue === CUE.listen) {
      const last = out[out.length - 1];
      if (!last || last.sung.length > 0) out.push({ heard: [], sung: [] });
      const heard = out[out.length - 1].heard;
      heard.push(s.semis!);
      if (s.glideToSemis !== undefined) heard.push(s.glideToSemis);
    } else if (s.semis !== undefined && out.length > 0) {
      const line = out[out.length - 1].sung;
      for (const p of s.glideToSemis === undefined ? [s.semis] : [s.semis, s.glideToSemis]) if (line[line.length - 1] !== p) line.push(p);
    }
  }
  return out;
}

describe('the Foundations lessons follow the brief', () => {
  it('teach every Foundations level, in level order, under the brief\'s titles', () => {
    const levels = levelsOf('foundations');
    expect(FOUNDATIONS_LESSON_ORDER.map((l) => l.levelId)).toEqual(levels.map((l) => l.id));
    expect(FOUNDATIONS_LESSON_ORDER.map((l) => [l.levelId, l.title])).toEqual(BRIEF.map(([id, title]) => [id, title]));
    for (const level of levels) expect(lessonFor(level.id), level.id).toBe(FOUNDATIONS_LESSON_ORDER[level.index - 1]);
    expect(Object.keys(LESSONS).filter((id) => id.startsWith('foundations.')).sort()).toEqual(levels.map((l) => l.id).sort());
  });

  it('pass the lesson validator against the real catalog', () => {
    expect(validateLessons(LESSONS, CATALOG).map((i) => `${i.path}: ${i.message}`)).toEqual([]);
  });

  it('teach the music words the brief gives each lesson, each one once, and explain each on its Learn page', () => {
    FOUNDATIONS_LESSON_ORDER.forEach((lesson, i) => {
      expect(lesson.learn.terms, lesson.levelId).toEqual(BRIEF[i][2]);
      const page = [lesson.learn.what, lesson.learn.why, ...lesson.learn.how, ...lesson.learn.onScreen].join(' ');
      for (const t of lesson.learn.terms) expect(page, `${lesson.levelId} explains "${TERMS[t]}"`).toMatch(wordRe(TERMS[t]));
    });
    const taught = FOUNDATIONS_LESSON_ORDER.flatMap((l) => l.learn.terms);
    expect(new Set(taught).size).toBe(taught.length);
  });

  it('are titled as their levels are, so the map, its requirement lines and the banners all use one name', () => {
    for (const lesson of FOUNDATIONS_LESSON_ORDER) expect(lesson.title, lesson.levelId).toBe(getLevel(lesson.levelId)!.title);
  });

  it('explain each lesson\'s words without leaning on a word a later lesson teaches (the explanations its Learn page shows)', () => {
    const teacher = new Map<TermId, number>();
    FOUNDATIONS_LESSON_ORDER.forEach((l, i) => l.learn.terms.forEach((t) => teacher.set(t, i)));
    const early: string[] = [];
    FOUNDATIONS_LESSON_ORDER.forEach((lesson, i) => {
      for (const term of lesson.learn.terms) {
        const entry = GLOSSARY[term];
        for (const t of TAUGHT_FIRST) {
          const at = teacher.get(t);
          if (at === undefined || at <= i) continue;
          for (const text of [entry.plain, entry.example ?? '']) {
            if (wordsOf(t).some((w) => wordRe(w).test(text))) early.push(`"${entry.word}" (${lesson.levelId}) uses "${TERMS[t]}" (taught in ${BRIEF[at][0]}): ${text}`);
          }
        }
      }
    });
    expect(early).toEqual([]);
  });

  it('never lean on a music word before the lesson that teaches it', () => {
    const teacher = new Map<TermId, number>();
    FOUNDATIONS_LESSON_ORDER.forEach((l, i) => l.learn.terms.forEach((t) => teacher.set(t, i)));
    const early: string[] = [];
    FOUNDATIONS_LESSON_ORDER.forEach((lesson, i) => {
      for (const t of TAUGHT_FIRST) {
        const at = teacher.get(t);
        if (at === undefined || at <= i) continue;
        for (const text of textsOf(lesson)) {
          if (wordsOf(t).some((w) => wordRe(w).test(text))) early.push(`${lesson.levelId} uses "${TERMS[t]}" (taught in ${BRIEF[at][0]}): ${text}`);
        }
      }
    });
    expect(early).toEqual([]);
  });

  it('speak plainly: no units, no jargon, no exclamation marks, in the lessons and every Foundations exercise', () => {
    const texts = [
      ...FOUNDATIONS_LESSON_ORDER.flatMap(textsOf),
      ...FOUNDATION_EXERCISES.flatMap((e) => [e.title, e.goal, ...(e.steps ?? []), e.passPlain ?? '', ...e.pattern.flatMap((s) => (s.cue ? [s.cue] : []))]),
      getWorld('foundations')!.summary,
      ...levelsOf('foundations').map((l) => l.title),
      ...CHECKUP_TASKS.flatMap((t) => [t.title, t.ask]),
    ].filter((t) => t !== '');
    const found = texts.flatMap((t) => [...jargonIn(t), ...NOT_FOR_SINGERS.filter((re) => re.test(t))].map((re) => `${re}: ${t}`));
    expect(found).toEqual([]);
  });

  it('say what the outcome is, and keep the Learn page to a few short how-to lines', () => {
    for (const lesson of FOUNDATIONS_LESSON_ORDER) {
      expect(lesson.outcome, lesson.levelId).toMatch(/^You can /);
      expect(lesson.learn.how.length, lesson.levelId).toBeGreaterThanOrEqual(3);
      expect(lesson.learn.how.length, lesson.levelId).toBeLessThanOrEqual(5);
      for (const line of lesson.learn.how) expect(line.length, line).toBeLessThan(170);
    }
  });

  it('give every check plain steps and a pass rule in plain words', () => {
    for (const lesson of FOUNDATIONS_LESSON_ORDER) {
      const check = checkOf(lesson);
      expect(check.steps?.length ?? 0, check.id).toBeGreaterThanOrEqual(3);
      expect(check.passPlain, check.id).toBeTruthy();
    }
  });
});

describe('practice: short, echo-shaped and lenient', () => {
  it('asks for two or three good tries on each of two to four drills, each drill belonging to its lesson alone', () => {
    const seen = new Set<string>();
    for (const lesson of FOUNDATIONS_LESSON_ORDER) {
      expect(lesson.practice.length, lesson.levelId).toBeGreaterThanOrEqual(2);
      expect(lesson.practice.length, lesson.levelId).toBeLessThanOrEqual(4);
      lesson.practice.forEach((step, i) => {
        expect([2, 3], step.exerciseId).toContain(step.goodTries);
        expect(isDrillId(step.exerciseId), step.exerciseId).toBe(true);
        expect(seen.has(step.exerciseId), step.exerciseId).toBe(false);
        seen.add(step.exerciseId);
        expect(lessonOfDrill(step.exerciseId)).toEqual({ lesson, step: i });
      });
    }
    expect([...seen].sort()).toEqual(FOUNDATION_EXERCISES.filter((e) => isDrillId(e.id)).map((e) => e.id).sort());
  });

  it('keeps each drill to 5-12 seconds of singing, less than its check asks', () => {
    const singing = (e: ExerciseDef): number => realize(e, null, 'unknown').notes.reduce((s, n) => s + n.end - n.start, 0);
    for (const lesson of FOUNDATIONS_LESSON_ORDER) {
      const check = singing(checkOf(lesson));
      for (const d of drillsOf(lesson)) {
        const sec = singing(d);
        expect(sec, d.id).toBeGreaterThanOrEqual(5 - 1e-9);
        expect(sec, d.id).toBeLessThanOrEqual(12 + 1e-9);
        expect(sec, `${d.id} vs its check`).toBeLessThan(check);
      }
    }
  });

  it('lets the singer each check is made for (its tier\'s entry singer) make a good try on every drill', () => {
    for (const lesson of FOUNDATIONS_LESSON_ORDER) {
      lesson.practice.forEach((step) => {
        const tol = ex(step.exerciseId).tolerance;
        const m: Metrics = {};
        for (const c of step.good.conditions) m[c.metric] = populationValue(c.metric as ScoredMetric, tol, ENTRY[tol]);
        for (const c of step.good.conditions) expect(gateHolds(c, m), `${step.exerciseId}: ${c.metric} ${c.op} ${c.value}`).toBe(true);
      });
    }
  });

  it('opens every lesson with a first step a struggling beginner already gets right', () => {
    for (const lesson of FOUNDATIONS_LESSON_ORDER) {
      const first = lesson.practice[0];
      const tol = ex(first.exerciseId).tolerance;
      const m: Metrics = {};
      for (const c of first.good.conditions) m[c.metric] = populationValue(c.metric as ScoredMetric, tol, 'B');
      for (const c of first.good.conditions) expect(gateHolds(c, m), `${first.exerciseId}: ${c.metric}`).toBe(true);
    }
  });
});

describe('the echo: the app plays it, then the singer sings it', () => {
  it('plays exactly each chunk before it is sung, a slide by its two ends (the Range finder by its starting notes)', () => {
    for (const e of FOUNDATION_EXERCISES) {
      expect(e.pattern[0].cue, e.id).toBe(CUE.listen);
      for (const c of chunksOf(e.pattern)) {
        if (e.kind === 'range-finder') expect([c.heard[0]], e.id).toEqual([c.sung[0]]);
        else expect(c.sung, e.id).toEqual(c.heard.filter((p, i) => p !== c.heard[i - 1]));
      }
    }
  });

  it('never asks for more than three notes at once, unless the take has already sung each of them', () => {
    for (const e of FOUNDATION_EXERCISES) {
      const sung = new Set<number>();
      for (const c of chunksOf(e.pattern)) {
        if (c.sung.length > 3) expect(c.sung.every((p) => sung.has(p)), `${e.id}: ${c.sung.join(' ')}`).toBe(true);
        for (const p of c.sung) sung.add(p);
      }
      if (isDrillId(e.id)) for (const c of chunksOf(e.pattern)) if (c.sung.length > 3) expect(e.id).toMatch(/five-(up|down)$/);
    }
  });

  it('sounds nothing while the singer sings: no metronome, and every reference tone ends before the next sung note', () => {
    for (const e of FOUNDATION_EXERCISES) {
      expect(e.metronome, e.id).toBe(false);
      const r = realize(e, null, 'tenor');
      for (const tone of r.reference) {
        for (const n of r.notes) expect(tone.end <= n.start + 1e-9 || tone.start >= n.end - 1e-9, `${e.id}: a tone at ${tone.start.toFixed(2)} s overlaps a sung note`).toBe(true);
      }
      expect(r.reference.every((t) => t.start >= 0), `${e.id}: no starting pitch in the count-in, the Listen plays it`).toBe(true);
    }
  });
});

describe('the placement audition and the voice check-up follow the lessons', () => {
  it('sings its tests in level order: match and hold, steps and jumps, the connected line, the siren', () => {
    const a = getWorld('foundations')!.audition!;
    expect(a.exerciseIds).toEqual(['foundations.audition.5', 'foundations.audition.6', 'foundations.audition.7', 'foundations.audition.8']);
    expect(a.unlockThrough).toEqual(['foundations.13', 'foundations.08', 'foundations.09', 'foundations.05']);
    const indexes = a.unlockThrough.map((id) => getLevel(id)!.index);
    expect([...indexes].sort((x, y) => x - y)).toEqual(indexes);
    // Clean starts and the Boss Recital are always sung.
    expect(Math.max(...indexes)).toBeLessThan(getLevel('foundations.06')!.index);
  });

  it('runs the check-up in the same order after the Range finder, each task still measuring the skills it rates', () => {
    expect(CHECKUP_TASKS.map((t) => t.exerciseId)).toEqual(['foundations.range.1', ...getWorld('foundations')!.audition!.exerciseIds]);
    // A check-up sung before the rebuild reads back task by task under the retired tests it was sung as.
    expect(CHECKUP_TASKS.map((t) => t.formerExerciseIds)).toEqual([
      ['foundations.range-finder.1'], ['foundations.audition.1'], ['foundations.audition.3'], ['foundations.audition.4'], ['foundations.audition.2'],
    ]);
    for (const task of CHECKUP_TASKS) {
      const produced = metricsProducedBy(ex(task.exerciseId).analyzers);
      for (const s of task.skills) for (const m of s.metrics) expect(produced.has(m), `${task.exerciseId} measures ${m}`).toBe(true);
    }
  });
});
