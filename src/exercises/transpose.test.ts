import { describe, expect, it } from 'vitest';
import { parseNote } from '../core/music';
import { seededRandom } from '../dsp/test-signals';
import type { VocalRange } from '../storage/schema';
import { EXERCISES, getExercise } from './catalog';
import { CUE } from './cues';
import {
  DEFAULT_RANGES, PASSAGGIO_ZONE, effectiveRange, materialSpan, passaggioCentre, rangeFromMeasurement, realize, usesExtendedRange, type VoiceType,
} from './transpose';
import type { ExerciseDef } from './types';

const ex = (id: string): ExerciseDef => getExercise(id)!;
const saved = (extLow: number, extHigh: number, comLow: number, comHigh: number): VocalRange => ({
  extended: { low: extLow, high: extHigh },
  comfortable: { low: comLow, high: comHigh },
  measuredAt: '2026-10-21T00:00:00.000Z',
});
const pitches = (r: ReturnType<typeof realize>) => [
  ...r.notes.flatMap((n) => (n.toMidi === undefined ? [n.midi] : [n.midi, n.toMidi])),
  ...r.reference.map((n) => n.midi),
];

/** Minimal exercise for timeline tests. */
function def(over: Partial<ExerciseDef>): ExerciseDef {
  return {
    id: 'foundations.test.1', worldId: 'foundations', kind: 'sustain', title: 'T', goal: 'G.',
    pattern: [{ semis: 0, beats: 2 }], tempoBpm: 60, tonicPlacement: 'mid', countInBeats: 2, metronome: false,
    demo: { timbre: 'sine', vibrato: null }, analyzers: ['accuracy'],
    scoring: [{ metric: 'accuracy.inTolerancePct', weight: 1, best: 90, worst: 50 }],
    pass: { score: 0.6, gates: [{ metric: 'accuracy.inTolerancePct', op: '>=', value: 60 }] },
    tolerance: 'easy', tiers: { solid: 0.8, studio: 0.92 },
    ...over,
  };
}

describe('default ranges (beginner-safe, RESEARCH §6)', () => {
  it('are tenor C3-A4, baritone A2-F4, other/unknown C3-E4', () => {
    const r = (v: VoiceType) => [DEFAULT_RANGES[v].low, DEFAULT_RANGES[v].high];
    expect(r('tenor')).toEqual([parseNote('C3'), parseNote('A4')]);
    expect(r('baritone')).toEqual([parseNote('A2'), parseNote('F4')]);
    expect(r('other')).toEqual([parseNote('C3'), parseNote('E4')]);
    expect(r('unknown')).toEqual([parseNote('C3'), parseNote('E4')]);
  });

  it('centre a beginner\'s home note near F3-G3', () => {
    const r = realize(ex('foundations.sustain.1'), null, 'unknown');
    expect(r.tonicMidi).toBeGreaterThanOrEqual(parseNote('F3'));
    expect(r.tonicMidi).toBeLessThanOrEqual(parseNote('G3'));
  });

  it('use the default as both comfortable and extended when nothing is saved', () => {
    const e = effectiveRange(null, 'baritone');
    expect(e.saved).toBe(false);
    expect(e.comfortable).toEqual(DEFAULT_RANGES.baritone);
    expect(e.extended).toEqual(DEFAULT_RANGES.baritone);
  });
});

describe('effectiveRange', () => {
  it('uses a saved range, keeping comfortable inside extended', () => {
    const e = effectiveRange(saved(50, 70, 48, 66), 'tenor');
    expect(e.saved).toBe(true);
    expect(e.comfortable).toEqual({ low: 48, high: 66 });
    expect(e.extended).toEqual({ low: 48, high: 70 });
  });

  it('falls back to the voice default for an invalid saved range', () => {
    const bad = { extended: { low: NaN, high: 60 }, comfortable: { low: 70, high: 60 }, measuredAt: 'x' };
    expect(effectiveRange(bad, 'tenor').saved).toBe(false);
    expect(effectiveRange(bad, 'tenor').comfortable).toEqual(DEFAULT_RANGES.tenor);
  });
});

describe('rangeFromMeasurement', () => {
  it('saves the measured extremes as extended and trims comfortable inside them', () => {
    expect(rangeFromMeasurement(45, 70, 'now')).toEqual({ extended: { low: 45, high: 70 }, comfortable: { low: 47, high: 67 }, measuredAt: 'now' });
  });

  it('keeps at least seven semitones comfortable, and the whole span when it is that narrow', () => {
    const r = rangeFromMeasurement(50, 60, 'now')!;
    expect(r.comfortable.high - r.comfortable.low).toBe(7);
    expect(r.comfortable.low).toBeGreaterThanOrEqual(50);
    expect(r.comfortable.high).toBeLessThanOrEqual(60);
    expect(rangeFromMeasurement(52, 57, 'now')!.comfortable).toEqual({ low: 52, high: 57 });
  });

  it('orders, rounds and clamps to the supported E2-C6', () => {
    expect(rangeFromMeasurement(70.4, 30, 'now')!.extended).toEqual({ low: 40, high: 70 });
    expect(rangeFromMeasurement(null, 60, 'now')).toBeNull();
    expect(rangeFromMeasurement(NaN, 60, 'now')).toBeNull();
    expect(rangeFromMeasurement(30, 90, 'now')).toMatchObject({ extended: { low: 40, high: 84 }, comfortable: { low: 42, high: 81 } });
  });

  it('places a narrow voice\'s seven comfortable semitones by the 2:3 trim, exactly', () => {
    // Widths 8-11 keep seven comfortable semitones, starting floor((width - 7) * 2 / 5) above the low note; 12 trims 2 and 3.
    const comfortLow = (width: number) => rangeFromMeasurement(48, 48 + width, 'now')!.comfortable;
    expect([8, 9, 10, 11, 12].map((w) => comfortLow(w).low)).toEqual([48, 48, 49, 49, 50]);
    for (const w of [8, 9, 10, 11, 12]) expect(comfortLow(w).high - comfortLow(w).low, `width ${w}`).toBe(7);
    expect(rangeFromMeasurement(48, 58, 'now')!.comfortable).toEqual({ low: 49, high: 56 });
  });
});

describe('realize: the take timeline', () => {
  const d = def({
    pattern: [
      { semis: 0, beats: 1, cue: 'First', syllable: 'ah' },
      { semis: 2, beats: 2 },
      { beats: 1 },
      { semis: 4, beats: 1, glideToSemis: 0, cue: 'Glide' },
    ],
    tempoBpm: 120,
    countInBeats: 4,
  });

  it('starts at the downbeat after the count-in and lays steps out in beats', () => {
    const r = realize(d, null, 'unknown');
    expect(r.countInSec).toBeCloseTo(2, 9);
    expect(r.notes.map((n) => [n.start, n.end])).toEqual([[0, 0.5], [0.5, 1.5], [2, 2.5]]);
    expect(r.notes[2].toMidi).toBe(r.tonicMidi);
    expect(r.notes[0].lyric).toBe('ah');
    expect(r.totalSec).toBeCloseTo(2.5, 9);
    expect(r.cues).toEqual([{ t: 0, text: 'First' }, { t: 2, text: 'Glide' }]);
  });

  it('plays the starting pitch during the count-in', () => {
    const r = realize(d, null, 'unknown');
    expect(r.reference).toEqual([{ midi: r.tonicMidi, start: -2, end: 0 }]);
  });

  it('honours a tempo override (tempo ladders, slowed demos)', () => {
    const r = realize(d, null, 'unknown', { bpm: 60 });
    expect(r.bpm).toBe(60);
    expect(r.totalSec).toBeCloseTo(5, 9);
  });

  it('gives a scoop\'s landing, not its start, as the starting pitch', () => {
    const r = realize(ex('inflections.scoop.1'), null, 'tenor');
    expect(r.reference[0].start).toBeLessThan(0);
    expect(r.reference[0].midi).toBe(r.notes[0].toMidi);
  });

  it('turns Listen steps into reference tones, never sung targets', () => {
    const p = def({ pattern: [{ semis: 3, beats: 2, cue: CUE.listen }, { beats: 1 }, { semis: 3, beats: 2, cue: CUE.sing }] });
    const r = realize(p, null, 'unknown');
    expect(r.notes).toHaveLength(1);
    expect(r.reference).toEqual([{ midi: r.tonicMidi + 3, start: 0, end: 2 }]);
  });

  it('repeats in new keys and sounds each new starting pitch in the breath before it', () => {
    const r = realize(ex('foundations.staccato.1'), null, 'tenor');
    expect(r.notes).toHaveLength(15);
    expect(r.notes[5].midi - r.notes[0].midi).toBe(2);
    expect(r.notes[10].midi - r.notes[0].midi).toBe(4);
    const keyTones = r.reference.filter((n) => n.start >= 0);
    expect(keyTones.map((n) => n.midi)).toEqual([r.notes[5].midi, r.notes[10].midi]);
    for (const k of keyTones) expect(r.notes.some((n) => n.start < k.end && n.end > k.start)).toBe(false);
  });

  it('exposes the vibrato plan, inflection figures and pulse rate the analyzers take', () => {
    expect(realize(ex('vibrato.pulse.2'), null, 'tenor').pulseHz).toBeCloseTo(4.5, 9);
    expect(realize(ex('vibrato.oscillation.1'), null, 'tenor').pulseHz).toBeCloseTo(80 / 60, 9);
    expect(realize(ex('foundations.sustain.1'), null, 'tenor').pulseHz).toBeNull();
    const bloom = realize(ex('vibrato.bloom.1'), null, 'tenor');
    expect(bloom.vibratoPlan[0]).toEqual({ start: 0, end: 3, vibrato: false });
    expect(bloom.vibratoPlan[1]).toEqual({ start: 3, end: 6, vibrato: true });
    const slide = realize(ex('inflections.slide.1'), null, 'tenor').inflections[0];
    expect(slide.kind).toBe('slide');
    expect(slide.notes.map((n) => n.toMidi !== undefined)).toEqual([false, true, false]);
  });
});

describe('realize: where the material goes', () => {
  const tenor = saved(47, 72, 49, 69);
  const baritone = saved(43, 67, 45, 64);

  it('places mid, high and low in rising order inside the comfortable range', () => {
    const at = (placement: ExerciseDef['tonicPlacement']) => realize(def({ tonicPlacement: placement }), tenor, 'tenor').tonicMidi;
    expect(at('low')).toBeLessThan(at('mid'));
    expect(at('mid')).toBeLessThan(at('high'));
    for (const p of ['low', 'mid', 'high', 'fit-span'] as const) {
      expect(at(p)).toBeGreaterThanOrEqual(49);
      expect(at(p)).toBeLessThanOrEqual(69);
    }
  });

  it('centres passaggio material on the voice type\'s passaggio zone', () => {
    const p = def({ tonicPlacement: 'passaggio', pattern: [{ semis: 0, beats: 2 }, { semis: 1, beats: 2 }] });
    for (const [voice, range] of [['tenor', tenor], ['baritone', baritone]] as const) {
      const r = realize(p, range, voice);
      const centre = (r.tonicMidi * 2 + 1) / 2;
      const zone = PASSAGGIO_ZONE[voice]!;
      expect(centre).toBeGreaterThanOrEqual(zone.low - 0.5);
      expect(centre).toBeLessThanOrEqual(zone.high + 0.5);
    }
    expect(passaggioCentre('unknown', { low: 48, high: 64 })).toBe(62);
  });

  it('puts a baritone\'s passaggio swell lower than a tenor\'s', () => {
    const swell = ex('dynamics.swell.6');
    expect(realize(swell, baritone, 'baritone').tonicMidi).toBeLessThan(realize(swell, tenor, 'tenor').tonicMidi);
  });

  it('lets only range and top-end exercises use the extended range', () => {
    const narrowComfort = saved(45, 72, 52, 62);
    expect(usesExtendedRange(ex('foundations.siren.1'))).toBe(true);
    expect(usesExtendedRange(ex('inflections.flip.2'))).toBe(true);
    expect(usesExtendedRange(ex('foundations.range-finder.1'))).toBe(true);
    expect(usesExtendedRange(ex('foundations.legato.1'))).toBe(false);
    const legato = realize(ex('foundations.legato.1'), narrowComfort, 'unknown');
    expect(legato.fit).toBe('extended'); // 11 semitones won't fit a 10-semitone comfortable range
    const sustain = realize(ex('foundations.sustain.1'), narrowComfort, 'unknown');
    expect(sustain.fit).toBe('fits');
    for (const m of pitches(sustain)) {
      expect(m).toBeGreaterThanOrEqual(52);
      expect(m).toBeLessThanOrEqual(62);
    }
  });

  it('folds material wider than the whole extended range by octaves, still inside it', () => {
    const wide = def({ pattern: [{ semis: 0, beats: 1 }, { semis: 24, beats: 1 }] });
    const r = realize(wide, saved(50, 59, 50, 57), 'unknown');
    expect(r.fit).toBe('folded');
    for (const m of pitches(r)) {
      expect(m).toBeGreaterThanOrEqual(50);
      expect(m).toBeLessThanOrEqual(59);
    }
  });

  it('never places any catalog note outside the extended range, for any saved range', () => {
    const rand = seededRandom(20261021);
    const voices: VoiceType[] = ['tenor', 'baritone', 'other', 'unknown'];
    for (let trial = 0; trial < 60; trial++) {
      const low = 40 + Math.floor(rand() * 16);
      const span = 9 + Math.floor(rand() * 22);
      const range = rangeFromMeasurement(low, low + span, 'now')!;
      const voice = voices[trial % voices.length];
      for (const e of EXERCISES) {
        const r = realize(e, range, voice);
        for (const m of pitches(r)) {
          expect(m).toBeGreaterThanOrEqual(range.extended.low);
          expect(m).toBeLessThanOrEqual(range.extended.high);
        }
      }
    }
  });

  it('fits every exercise into both default voice ranges without folding', () => {
    for (const e of EXERCISES) {
      for (const voice of ['tenor', 'baritone', 'unknown'] as const) expect(realize(e, null, voice).fit).not.toBe('folded');
    }
  });

  it('reports the span of the material over all repeats', () => {
    expect(materialSpan(ex('foundations.staccato.1'))).toEqual({ lo: 0, hi: 11 });
    expect(materialSpan(ex('inflections.boss-recital'))).toEqual({ lo: 1, hi: 12 });
    expect(materialSpan(ex('inflections.audition.4'))).toEqual({ lo: 0, hi: 12 });
  });

  it('keeps every catalog exercise inside an octave, so the narrowest saved range never folds one', () => {
    for (const e of EXERCISES) {
      const { lo, hi } = materialSpan(e);
      expect(hi - lo, e.id).toBeLessThanOrEqual(12);
    }
    const octave = rangeFromMeasurement(50, 62, 'now')!;
    for (const e of EXERCISES) for (const voice of ['tenor', 'baritone', 'unknown'] as const) expect(realize(e, octave, voice).fit, `${e.id} ${voice}`).not.toBe('folded');
  });
});
