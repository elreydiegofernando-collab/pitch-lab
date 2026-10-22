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

  it('gives every training world 6-10 levels ending in exactly one studio-tolerance Boss Recital', () => {
    for (const w of WORLDS.filter((x) => x.id !== 'song-stage')) {
      expect(w.levels.length).toBeGreaterThanOrEqual(6);
      expect(w.levels.length).toBeLessThanOrEqual(10);
      const boss = bossOf(w.id)!;
      expect(boss).toBe(w.levels[w.levels.length - 1]);
      expect(w.levels.filter((l) => l.kind === 'boss')).toHaveLength(1);
      expect(ex(boss.exerciseId).kind).toBe('boss-recital');
      expect(ex(boss.exerciseId).tolerance).toBe('studio');
    }
  });

  it('tightens tolerance easy -> default -> studio inside each world, never loosening', () => {
    const strict = { easy: 0, default: 1, studio: 2 } as const;
    for (const w of WORLDS.filter((x) => x.id !== 'song-stage')) {
      const tols = w.levels.map((l) => strict[ex(l.exerciseId).tolerance]);
      expect(tols[0]).toBe(0);
      expect(tols[tols.length - 1]).toBe(2);
      for (let i = 1; i < tols.length; i++) expect(tols[i]).toBeGreaterThanOrEqual(tols[i - 1]);
      expect(new Set(tols).size).toBe(3);
    }
  });

  it('keeps Song Stage a song shelf: no levels, no audition', () => {
    const song = WORLDS.find((w) => w.id === 'song-stage')!;
    expect(song.levels).toEqual([]);
    expect(song.audition).toBeNull();
  });

  it('never steps across a world with nextLevel', () => {
    expect(nextLevel('foundations.09')?.id).toBe('foundations.boss');
    expect(nextLevel('foundations.boss')).toBeNull();
    expect(nextLevel('nope')).toBeNull();
    expect(getLevel('vibrato.01')?.worldId).toBe('vibrato');
    expect(levelForExercise('foundations.sustain.2')?.id).toBe('foundations.04');
    expect(levelForExercise('foundations.audition.1')).toBeUndefined();
  });
});

describe('Foundations (SPEC §9.1)', () => {
  it('follows the unlock map order', () => {
    expect(kindsOf('foundations')).toEqual([
      'range-finder', 'pitch-match', 'sustain', 'sustain', 'siren', 'staccato', 'intervals', 'intervals', 'legato', 'boss-recital',
    ]);
  });

  it('has the level names the progressive-disclosure features key on (Sirens & glides, Crispness)', () => {
    const titles = levelsOf('foundations').map((l) => l.title.toLowerCase());
    expect(titles.some((t) => t.includes('siren'))).toBe(true);
    expect(titles.some((t) => t.includes('crisp'))).toBe(true);
  });

  it('holds sustains for 4 to 8 seconds', () => {
    const holds = ['foundations.sustain.1', 'foundations.sustain.2'].flatMap((id) => planAnalysis(realizeId(id)).holds.map((h) => h.note.end - h.note.start));
    expect(Math.min(...holds)).toBeCloseTo(4, 6);
    expect(Math.max(...holds)).toBeCloseTo(8, 6);
  });

  it('jumps thirds and fifths, then fifths and octaves, landing each as a fresh attack', () => {
    const intervals = (id: string) => {
      const notes = realizeId(id).notes;
      const out = new Set<number>();
      for (let i = 0; i + 1 < notes.length; i += 2) out.add(Math.abs(notes[i + 1].midi - notes[i].midi));
      return [...out].sort((a, b) => a - b);
    };
    expect(intervals('foundations.intervals.1')).toEqual([3, 4, 7]);
    expect(intervals('foundations.intervals.2')).toEqual([7, 12]);
    for (const id of ['foundations.intervals.1', 'foundations.intervals.2', 'foundations.staccato.1', 'foundations.pitch-match.1']) {
      const r = realizeId(id);
      expect(planAnalysis(r).attacks).toHaveLength(r.notes.length);
    }
  });

  it('marks crack detection per phrase on the sirens and judges the range finder only on range', () => {
    expect(ex('foundations.siren.1').analyzers).toEqual(['glide', 'cracks']);
    expect(ex('foundations.range-finder.1').analyzers).toEqual(['range']);
  });

  it('has a pitch match that plays each note before the singer sings it', () => {
    const r = realizeId('foundations.pitch-match.1');
    expect(r.reference).toHaveLength(r.notes.length);
    r.notes.forEach((n, i) => {
      expect(n.midi).toBe(r.reference[i].midi);
      expect(n.start).toBeGreaterThan(r.reference[i].end);
    });
  });

  it('chains a long straight hold, an octave attack and a legato line in its Boss Recital', () => {
    const r = realizeId('foundations.boss-recital');
    const plan = planAnalysis(r);
    expect(Math.max(...plan.holds.map((h) => h.note.end - h.note.start))).toBeGreaterThanOrEqual(5);
    expect(plan.attacks.map((a) => a.note.midi - r.tonicMidi)).toEqual([0, 12]);
    expect(plan.transitions[0].length).toBeGreaterThanOrEqual(7);
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
