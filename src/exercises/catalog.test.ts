import { describe, expect, it } from 'vitest';
import { CONFIG } from '../config';
import {
  CATALOG, EXERCISES, WORLDS, WORLD_ORDER, bossOf, getAudition, getExercise, getLevel, levelForExercise, levelsOf, nextLevel, worldsUnlockedBy,
} from './catalog';
import { CUE } from './cues';
import { planAnalysis } from './plan';
import { realize } from './transpose';
import type { ExerciseDef, ExerciseKind, WorldId } from './types';
import { validateCatalog } from './validate';

const ex = (id: string): ExerciseDef => {
  const e = getExercise(id);
  if (!e) throw new Error(`missing exercise ${id}`);
  return e;
};
const kindsOf = (w: WorldId): ExerciseKind[] => levelsOf(w).map((l) => ex(l.exerciseId).kind);
const realizeId = (id: string) => realize(ex(id), null, 'tenor');

describe('catalog validity', () => {
  it('passes every validator check', () => {
    const issues = validateCatalog(CATALOG);
    expect(issues.map((i) => `${i.path}: ${i.message}`)).toEqual([]);
  });

  it('is plain JSON data (no functions, no undefined)', () => {
    expect(JSON.parse(JSON.stringify(EXERCISES))).toEqual(EXERCISES);
    expect(JSON.parse(JSON.stringify(WORLDS))).toEqual(WORLDS);
  });

  it('is frozen so no caller can edit it at runtime', () => {
    expect(Object.isFrozen(EXERCISES)).toBe(true);
    expect(Object.isFrozen(EXERCISES[0].pattern[0])).toBe(true);
    expect(Object.isFrozen(WORLDS[0].levels)).toBe(true);
  });
});

describe('worlds and unlocks (SPEC §11, §11.2)', () => {
  it('runs Foundations -> Vibrato -> Inflections -> Runs & Riffs -> Dynamics, then Song Stage', () => {
    expect(WORLD_ORDER).toEqual(['foundations', 'vibrato', 'inflections', 'runs', 'dynamics', 'song-stage']);
  });

  it('opens each world with the previous Boss Recital, and Song Stage with the Foundations one', () => {
    const by = Object.fromEntries(WORLDS.map((w) => [w.id, w.unlockedBy]));
    expect(by).toEqual({
      foundations: null,
      vibrato: 'foundations.boss',
      inflections: 'vibrato.boss',
      runs: 'inflections.boss',
      dynamics: 'runs.boss',
      'song-stage': 'foundations.boss',
    });
    expect(worldsUnlockedBy('foundations.boss').map((w) => w.id)).toEqual(['vibrato', 'song-stage']);
  });

  it('gives every later world 6-10 levels ending in exactly one studio-tolerance Boss Recital, and Foundations 13 small lessons', () => {
    for (const w of WORLDS.filter((x) => x.id !== 'song-stage')) {
      const foundations = w.id === 'foundations';
      if (foundations) expect(w.levels).toHaveLength(13);
      else {
        expect(w.levels.length).toBeGreaterThanOrEqual(6);
        expect(w.levels.length).toBeLessThanOrEqual(10);
      }
      const boss = bossOf(w.id)!;
      expect(boss).toBe(w.levels[w.levels.length - 1]);
      expect(w.levels.filter((l) => l.kind === 'boss')).toHaveLength(1);
      expect(ex(boss.exerciseId).kind).toBe('boss-recital');
      // The boss is sung at its world's strictest tolerance: studio, except in Foundations, which never reaches it.
      expect(ex(boss.exerciseId).tolerance).toBe(foundations ? 'default' : 'studio');
    }
  });

  it('tightens tolerance inside each world, never loosening: easy -> default -> studio, and easy -> default in Foundations', () => {
    const strict = { easy: 0, default: 1, studio: 2 } as const;
    for (const w of WORLDS.filter((x) => x.id !== 'song-stage')) {
      const tols = w.levels.map((l) => strict[ex(l.exerciseId).tolerance]);
      expect(tols[0]).toBe(0);
      for (let i = 1; i < tols.length; i++) expect(tols[i]).toBeGreaterThanOrEqual(tols[i - 1]);
      if (w.id === 'foundations') {
        expect(new Set(tols)).toEqual(new Set([0, 1]));
      } else {
        expect(tols[tols.length - 1]).toBe(2);
        expect(new Set(tols).size).toBe(3);
      }
    }
  });

  it('keeps Song Stage a song shelf: no levels, no audition', () => {
    const song = WORLDS.find((w) => w.id === 'song-stage')!;
    expect(song.levels).toEqual([]);
    expect(song.audition).toBeNull();
  });

  it('never steps across a world with nextLevel, and steps in level order, not id order', () => {
    expect(nextLevel('foundations.06')?.id).toBe('foundations.boss');
    expect(nextLevel('foundations.13')?.id).toBe('foundations.10');
    expect(nextLevel('foundations.09')?.id).toBe('foundations.12');
    expect(nextLevel('foundations.boss')).toBeNull();
    expect(nextLevel('nope')).toBeNull();
    expect(getLevel('vibrato.01')?.worldId).toBe('vibrato');
    expect(levelForExercise('foundations.steady.1')?.id).toBe('foundations.13');
    expect(levelForExercise('foundations.audition.5')).toBeUndefined();
  });
});

describe('the Foundations rebuild keeps every old take readable', () => {
  const RETIRED = [
    'foundations.range-finder.1', 'foundations.pitch-match.1', 'foundations.sustain.1', 'foundations.sustain.2', 'foundations.siren.1',
    'foundations.staccato.1', 'foundations.intervals.1', 'foundations.intervals.2', 'foundations.legato.1', 'foundations.boss-recital',
    'foundations.audition.1', 'foundations.audition.2', 'foundations.audition.3', 'foundations.audition.4',
  ];

  it('keeps the old material under its old ids, retired: readable, but played by no level or audition', () => {
    const played = new Set(WORLDS.flatMap((w) => [...w.levels.map((l) => l.exerciseId), ...(w.audition?.exerciseIds ?? [])]));
    for (const id of RETIRED) {
      expect(ex(id).retired, id).toBe('2026-10-23');
      expect(played.has(id), id).toBe(false);
      expect(levelForExercise(id), id).toBeUndefined();
    }
    expect(EXERCISES.filter((e) => e.retired !== undefined).map((e) => e.id).sort()).toEqual([...RETIRED].sort());
    // The old material as it was sung: Sustain II held for six and eight seconds and never judged a wobble.
    expect(ex('foundations.sustain.2').title).toBe('Sustain II');
    expect((ex('foundations.sustain.2').pass.gates ?? []).map((g) => g.metric)).not.toContain('accuracy.sdCents');
  });

  it('gives Hold it steady a level of its own: it judges a wobble, so a pass of Sustain II (the old .04) is not a pass of it', () => {
    expect(getLevel('foundations.04')).toBeUndefined();
    expect(levelsOf('foundations')[3]).toMatchObject({ id: 'foundations.13', title: 'Hold it steady', exerciseId: 'foundations.steady.1' });
    expect((ex('foundations.steady.1').pass.gates ?? []).map((g) => g.metric)).toContain('accuracy.sdCents');
  });

  it('records the old placement audition, so what its tests granted stays granted (only the levels that still teach the same)', () => {
    const former = getAudition('foundations.audition')!.former!;
    expect(former.exerciseIds).toEqual(['foundations.audition.1', 'foundations.audition.2', 'foundations.audition.3', 'foundations.audition.4']);
    expect(former.unlockThrough).toEqual(['foundations.04', 'foundations.05', 'foundations.08', 'foundations.09']);
    expect(former.keeps).not.toContain('foundations.13');
    expect(former.keeps).not.toContain('foundations.04');
    for (const id of ['foundations.10', 'foundations.11', 'foundations.12']) expect(former.keeps, id).not.toContain(id);
  });
});

describe('Foundations (SPEC §9.1): thirteen small lessons', () => {
  it('teaches one new thing per level, in the lessons\' order, keeping every persisted level id', () => {
    expect(levelsOf('foundations').map((l) => [l.index, l.id, l.title])).toEqual([
      [1, 'foundations.01', 'Range finder'],
      [2, 'foundations.02', 'Match one note'],
      [3, 'foundations.03', 'Hold it'],
      [4, 'foundations.13', 'Hold it steady'],
      [5, 'foundations.10', 'Two notes, one step apart'],
      [6, 'foundations.07', 'Two notes, a jump apart'],
      [7, 'foundations.08', 'Bigger jumps'],
      [8, 'foundations.11', 'Three notes: do-re-mi'],
      [9, 'foundations.09', 'Five notes in a row'],
      [10, 'foundations.12', 'Small slides'],
      [11, 'foundations.05', 'Sirens'],
      [12, 'foundations.06', 'Clean starts'],
      [13, 'foundations.boss', 'Boss Recital'],
    ]);
    expect(kindsOf('foundations')).toEqual([
      'range-finder', 'pitch-match', 'sustain', 'sustain', 'intervals', 'intervals', 'intervals', 'legato', 'legato', 'siren', 'siren', 'staccato',
      'boss-recital',
    ]);
  });

  it('keeps the levels the progressive-disclosure features key on: the sirens open crack markers, clean starts the start readouts', () => {
    expect(getLevel('foundations.05')!.title).toBe('Sirens');
    expect(ex(getLevel('foundations.05')!.exerciseId).kind).toBe('siren');
    expect(getLevel('foundations.06')!.title).toBe('Clean starts');
    expect(ex(getLevel('foundations.06')!.exerciseId).kind).toBe('staccato');
  });

  it('opens wide and narrows once, at Hold it steady, where a narrower in-tune zone shows the wobble', () => {
    const tols = levelsOf('foundations').map((l) => ex(l.exerciseId).tolerance);
    expect(tols.slice(0, 3)).toEqual(['easy', 'easy', 'easy']);
    expect(tols.slice(3).every((t) => t === 'default')).toBe(true);
    for (const e of EXERCISES.filter((x) => x.worldId === 'foundations' && x.retired === undefined)) expect(e.tolerance, e.id).not.toBe('studio');
  });

  it('plays every chunk before it is sung, with nothing sounding while the singer sings', () => {
    for (const e of EXERCISES.filter((x) => x.worldId === 'foundations' && x.retired === undefined)) {
      expect(e.pattern[0].cue, e.id).toBe(CUE.listen);
      expect(e.metronome, e.id).toBe(false);
      const r = realizeId(e.id);
      expect(r.reference.length, e.id).toBeGreaterThan(0);
      for (const tone of r.reference) for (const n of r.notes) expect(tone.end <= n.start || tone.start >= n.end, e.id).toBe(true);
    }
  });

  it('holds a note 4 seconds in Hold it, then 4 to 6 seconds in Hold it steady, judging the wobble and the drift only there', () => {
    const holds = (id: string) => planAnalysis(realizeId(id)).holds.map((h) => Math.round(h.note.end - h.note.start));
    expect(holds('foundations.hold.1')).toEqual([4, 4, 4]);
    expect(holds('foundations.steady.1')).toEqual([4, 5, 6]);
    const judged = (id: string) => [...ex(id).scoring.map((t) => t.metric), ...(ex(id).pass.gates ?? []).map((g) => g.metric)];
    expect(judged('foundations.hold.1')).not.toContain('accuracy.sdCents');
    expect(judged('foundations.steady.1')).toEqual(expect.arrayContaining(['accuracy.sdCents', 'accuracy.absDriftCentsPerSec']));
  });

  it('moves two notes at a time by a step, then jumps of a third and a fifth, then up to an octave, landing each second note as a fresh start', () => {
    const moves = (id: string) => {
      const notes = realizeId(id).notes;
      const out = new Set<number>();
      for (let i = 0; i + 1 < notes.length; i += 2) out.add(Math.abs(notes[i + 1].midi - notes[i].midi));
      return [...out].sort((a, b) => a - b);
    };
    expect(moves('foundations.steps.1')).toEqual([1, 2]);
    expect(moves('foundations.jumps.1')).toEqual([4, 7]);
    expect(moves('foundations.jumps.2')).toEqual([7, 12]);
    for (const id of ['foundations.steps.1', 'foundations.jumps.1', 'foundations.jumps.2', 'foundations.clean-starts.1', 'foundations.match.1']) {
      const r = realizeId(id);
      expect(planAnalysis(r).attacks, id).toHaveLength(r.notes.length);
    }
  });

  it('joins three notes, then five, into connected lines', () => {
    const lines = (id: string) => planAnalysis(realizeId(id)).transitions.map((t) => t.length);
    expect(lines('foundations.do-re-mi.1')).toEqual([3, 3, 3, 3]);
    expect(lines('foundations.five-notes.1')).toEqual([3, 3, 5, 5]);
  });

  it('slides a step and a third before the full sirens, and judges cracks and the range finder\'s range where they belong', () => {
    const glides = (id: string) => realizeId(id).notes.filter((n) => n.toMidi !== undefined).map((n) => Math.abs(n.toMidi! - n.midi));
    expect(glides('foundations.slides.1')).toEqual([2, 2, 4, 4]);
    expect(Math.max(...glides('foundations.sirens.1'))).toBe(12);
    expect(ex('foundations.sirens.1').analyzers).toEqual(['glide', 'cracks']);
    expect(ex('foundations.range.1').analyzers).toEqual(['range']);
  });

  it('plays a slide or a siren as it is sung: the same slides, at the speed sung, before the singer slides', () => {
    for (const id of ['foundations.slides.1', 'foundations.sirens.1', 'foundations.drill.first-slide', 'foundations.audition.8']) {
      const r = realizeId(id);
      const heard = r.reference.filter((n) => n.toMidi !== undefined).map((n) => [n.toMidi! - n.midi, Math.round((n.end - n.start) * 100)]);
      const sung = r.notes.filter((n) => n.toMidi !== undefined).map((n) => [n.toMidi! - n.midi, Math.round((n.end - n.start) * 100)]);
      expect(heard, id).toEqual(sung);
    }
  });

  it('has a pitch match that plays each note before the singer sings it', () => {
    const r = realizeId('foundations.match.1');
    expect(r.reference).toHaveLength(r.notes.length);
    r.notes.forEach((n, i) => {
      expect(n.midi).toBe(r.reference[i].midi);
      expect(n.start).toBeGreaterThan(r.reference[i].end);
    });
  });

  it('ends with a short tune, phrase by phrase: a long held note, do-re-mi, a jump, steps down and a slide home', () => {
    const r = realizeId('foundations.boss-tune');
    const plan = planAnalysis(r);
    expect(plan.holds[0].note.end - plan.holds[0].note.start).toBeGreaterThanOrEqual(3.5);
    expect(plan.attacks.map((a) => a.note.midi - r.tonicMidi)).toEqual([0, 0, 4, 7, 2]); // each phrase starts from silence
    expect(plan.transitions.map((t) => t.length)).toEqual([3, 2, 3]);
    expect(plan.glides).toHaveLength(1);
    expect(r.notes.every((n) => n.midi - r.tonicMidi >= 0 && n.midi - r.tonicMidi <= 7)).toBe(true);
  });
});

describe('Vibrato (SPEC §9.2)', () => {
  it('builds from oscillation to pulses to free vibrato to bloom and switching', () => {
    expect(kindsOf('vibrato')).toEqual([
      'oscillation', 'oscillation', 'pulse-builder', 'pulse-builder', 'pulse-builder', 'vibrato-meter', 'straight-to-bloom', 'vibrato-switch', 'boss-recital',
    ]);
  });

  it('narrows the oscillation from a whole tone to a semitone while speeding up', () => {
    const o1 = realizeId('vibrato.oscillation.1');
    const o2 = realizeId('vibrato.oscillation.2');
    expect(Math.abs(o1.notes[1].midi - o1.notes[0].midi)).toBe(2);
    expect(Math.abs(o2.notes[1].midi - o2.notes[0].midi)).toBe(1);
    expect(o2.pulseHz!).toBeGreaterThan(o1.pulseHz!);
  });

  it('pulses at 3-4 Hz, then 4-5 Hz, then toward the natural rate, with a metronome', () => {
    const rates = ['vibrato.pulse.1', 'vibrato.pulse.2', 'vibrato.pulse.3'].map((id) => realizeId(id).pulseHz!);
    expect(rates[0]).toBeGreaterThanOrEqual(3);
    expect(rates[0]).toBeLessThanOrEqual(4);
    expect(rates[1]).toBeGreaterThanOrEqual(4);
    expect(rates[1]).toBeLessThanOrEqual(5);
    expect(rates[2]).toBeGreaterThan(rates[1]);
    expect(rates[2]).toBeLessThanOrEqual(CONFIG.vibrato.styles.pop.rateHz[1]);
    for (const id of ['vibrato.pulse.1', 'vibrato.pulse.2', 'vibrato.pulse.3']) expect(ex(id).metronome).toBe(true);
  });

  it('demos every vibrato-judged exercise in the singer\'s style zone', () => {
    for (const e of EXERCISES.filter((x) => x.analyzers.includes('vibrato') || x.analyzers.includes('switch'))) {
      expect(e.demo.vibrato).toBe('style');
    }
  });

  it('asks for straight tone first, then a bloom on the cue', () => {
    const plan = realizeId('vibrato.bloom.1').vibratoPlan;
    expect(plan.map((p) => p.vibrato)).toEqual([false, true, false, true, false, true]);
  });

  it('switches on and off inside one held note', () => {
    const def = ex('vibrato.switch.1');
    expect(def.pattern.filter((s) => s.cue === CUE.straight).length).toBeGreaterThanOrEqual(3);
    expect(def.pattern.filter((s) => s.cue === CUE.vibrato).length).toBeGreaterThanOrEqual(3);
  });
});

describe('Inflections (SPEC §9.3)', () => {
  it('covers scoop, fall, slide, turn and flip, with flips on the passaggio', () => {
    expect(kindsOf('inflections')).toEqual(['scoop', 'fall', 'slide', 'slide', 'turn', 'flip', 'turn', 'flip', 'boss-recital']);
    for (const id of ['inflections.flip.1', 'inflections.flip.2']) expect(ex(id).tonicPlacement).toBe('passaggio');
  });

  it('turns through an upper and a lower neighbour', () => {
    const groups = realizeId('inflections.turn.1').inflections.filter((g) => g.kind === 'turn');
    const offsets = new Set(groups.map((g) => Math.sign(g.notes[1].midi - g.notes[0].midi)));
    expect(offsets).toEqual(new Set([1, -1]));
  });

  it('times every slide and flips upward', () => {
    for (const g of realizeId('inflections.slide.2').inflections) {
      const glide = g.notes.find((n) => n.toMidi !== undefined)!;
      expect(glide.end - glide.start).toBeGreaterThan(0);
    }
    for (const g of realizeId('inflections.flip.2').inflections) expect(g.notes[1].midi).toBeGreaterThan(g.notes[0].midi);
  });

  it('chains a turn, a slide and a flip in its Boss Recital', () => {
    const kinds = new Set(realizeId('inflections.boss-recital').inflections.map((g) => g.kind));
    expect(kinds).toEqual(new Set(['turn', 'slide', 'flip']));
  });

  it('keeps the Boss Recital and the octave-flip audition inside an octave, the flip landing on the octave', () => {
    for (const id of ['inflections.boss-recital', 'inflections.audition.4']) {
      const r = realizeId(id);
      const pitches = r.notes.flatMap((n) => (n.toMidi === undefined ? [n.midi] : [n.midi, n.toMidi]));
      expect(Math.max(...pitches) - Math.min(...pitches), id).toBeLessThanOrEqual(12);
      const flip = r.inflections.find((g) => g.kind === 'flip')!;
      expect(flip.notes[1].midi - r.tonicMidi, id).toBe(12);
    }
    expect(ex('inflections.boss-recital').goal).toMatch(/slide up a fourth/);
  });
});

describe('Runs & Riffs (SPEC §9.4)', () => {
  const runLevels = levelsOf('runs').filter((l) => l.kind === 'level').map((l) => ex(l.exerciseId));

  it('covers 3, 5 and 7-note pentatonic and blues fragments, up and down', () => {
    const lengths = new Set(runLevels.map((e) => e.pattern.filter((s) => s.semis !== undefined).length));
    expect(lengths).toEqual(new Set([3, 5, 7]));
    const directions = new Set(
      runLevels.map((e) => {
        const s = e.pattern.filter((p) => p.semis !== undefined).map((p) => p.semis!);
        return Math.sign(s[s.length - 1] - s[0]);
      }),
    );
    expect(directions).toEqual(new Set([1, -1]));
    const blues = runLevels.filter((e) => e.pattern.some((s) => s.semis === 6));
    expect(blues.length).toBeGreaterThanOrEqual(3);
  });

  it('climbs CONFIG.runs.tempoLadderNps rungs from slow, passing at the top rung', () => {
    const rungs = CONFIG.runs.tempoLadderNps.map((n) => Math.round(n * 15));
    for (const e of [...runLevels, ex('runs.boss-recital')]) {
      const ladder = e.tempoLadder!;
      for (const b of ladder) expect(rungs).toContain(b);
      expect(ladder[ladder.length - 1]).toBe(e.tempoBpm);
      expect(ladder[0]).toBeLessThan(e.tempoBpm);
    }
    expect(ex('runs.run.1').tempoLadder![0]).toBe(rungs[0]);
  });

  it('gets faster and longer toward the Boss Recital', () => {
    const tempo = runLevels.map((e) => e.tempoBpm);
    for (let i = 1; i < tempo.length; i++) expect(tempo[i]).toBeGreaterThanOrEqual(tempo[i - 1]);
    const boss = realizeId('runs.boss-recital');
    expect(Math.max(...planAnalysis(boss).runs.map((r) => r.length))).toBeGreaterThanOrEqual(12);
    expect(ex('runs.boss-recital').tempoBpm).toBe(Math.max(...tempo));
  });
});

describe('Dynamics (SPEC §9.5)', () => {
  it('works up to messa di voce on the passaggio', () => {
    expect(kindsOf('dynamics').every((k) => k === 'swell' || k === 'boss-recital')).toBe(true);
    expect(ex('dynamics.swell.6').tonicPlacement).toBe('passaggio');
    const swells = planAnalysis(realizeId('dynamics.swell.3')).dynamics;
    expect(swells.every((d) => d.shape === 'swell')).toBe(true);
  });

  it('chains a swell, sudden steps and a long fade, judging symmetry on the swell only', () => {
    const shapes = planAnalysis(realizeId('dynamics.boss-recital')).dynamics.map((d) => d.shape);
    expect(shapes).toEqual(['swell', null, 'decrescendo']);
  });
});

describe('auditions (SPEC §11)', () => {
  it('gives each training world one audition that never reaches the Boss Recital', () => {
    for (const w of WORLDS.filter((x) => x.id !== 'song-stage')) {
      const a = getAudition(`${w.id}.audition`)!;
      expect(a.worldId).toBe(w.id);
      for (const through of a.unlockThrough) {
        expect(getLevel(through)!.worldId).toBe(w.id);
        expect(getLevel(through)!.kind).toBe('level');
      }
    }
  });

  it('never names the Foundations range finder as a level an audition test grants', () => {
    // A data-level check only: the guard that matters is in progress (the audition is withheld until the Range finder is
    // sung and the engine never grants it, whatever this data says; src/progress/catalog.integration.test.ts).
    const through = getAudition('foundations.audition')!.unlockThrough;
    expect(through).not.toContain('foundations.01');
    expect(through.every((id) => getLevel(id)!.index > getLevel('foundations.01')!.index)).toBe(true);
  });
});
