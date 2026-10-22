import { describe, expect, it } from 'vitest';
import type { PitchFrame, TargetNote } from '../core/types';
import { analyzeInflection } from './inflections';
import { makeTrack } from './fixtures';
import { sungContour } from './advanced-test-helpers';
import type { AnalyzeContext, InflectionKind } from './types';

const CTX: AnalyzeContext = { toleranceCents: 25, vibratoStyle: 'pop' };
const STUDIO: AnalyzeContext = { toleranceCents: 10, vibratoStyle: 'pop' };
const EASY: AnalyzeContext = { toleranceCents: 50, vibratoStyle: 'pop' };

type Contour = (t: number) => number;

interface TrackOpts {
  jitter?: number;
  seed?: number;
  /** Level (dB) as a function of time; default a steady -20 while voiced. */
  rms?: (t: number) => number;
  duration?: number;
}

function track(midi: Contour, end: number, o: TrackOpts = {}): PitchFrame[] {
  return makeTrack({ duration: o.duration ?? end + 0.4, midi, jitterCents: o.jitter ?? 6, seed: o.seed ?? 3, rmsDb: o.rms ?? ((t) => (Number.isFinite(midi(t)) ? -20 : -80)) });
}

const run = (t: PitchFrame[], kind: InflectionKind, targets: TargetNote[], ctx = CTX) => analyzeInflection(t, kind, targets, ctx);
const hasNote = (r: { notes: string[] }, re: RegExp): boolean => r.notes.some((n) => re.test(n));

// ---------------------------------------------------------------- scoop
describe('analyzeInflection: scoop', () => {
  // 62 up to 64 over half a beat (0.4167 s), arriving on the beat at 1.4167 s, then held.
  const G: TargetNote = { midi: 62, toMidi: 64, start: 1.0, end: 1.4167 };
  const H: TargetNote = { midi: 64, start: 1.4167, end: 3.0 };
  const ideal = sungContour([G, H], 30);

  it('scores a committed scoop that arrives on the beat, from the glide target alone', () => {
    const r = run(track(ideal, 3.0), 'scoop', [G]);
    expect(r.kind).toBe('scoop');
    expect(r.detected).toBe(true);
    expect(r.sizeCents).toBeGreaterThan(160);
    expect(r.sizeCents).toBeLessThan(240);
    expect(r.timeMs).toBeGreaterThan(330);
    expect(r.timeMs).toBeLessThan(500);
    expect(r.landingAbsCents).toBeLessThan(15);
    expect(r.score).toBeGreaterThan(0.9);
    expect(r.notes).toEqual([]);
  });

  it('gives the same verdict with the landing hold supplied', () => {
    const r = run(track(ideal, 3.0), 'scoop', [G, H]);
    expect(r.detected).toBe(true);
    expect(r.score).toBeGreaterThan(0.9);
    expect(r.landingAbsCents).toBeLessThan(15);
  });

  it('also accepts two plain notes (start-below, landing)', () => {
    const r = run(track(ideal, 3.0), 'scoop', [
      { midi: 62, start: 1.0, end: 1.4167 },
      { midi: 64, start: 1.4167, end: 3.0 },
    ]);
    expect(r.detected).toBe(true);
    expect(r.score).toBeGreaterThan(0.85);
  });

  it('does not credit a note that simply started on pitch: no scoop was sung', () => {
    const r = run(track((t) => (t >= 1.0 && t < 3.0 ? 64 : NaN), 3.0), 'scoop', [G]);
    expect(r.detected).toBe(false);
    expect(r.score).toBeLessThanOrEqual(0.45);
    expect(hasNote(r, /No scoop/)).toBe(true);
  });

  it('does not credit a step up from the lower note as a scoop (it is an interval, not a slide in)', () => {
    const step = (t: number): number => (t < 1.0 ? NaN : t < 1.4167 ? 62 : 64);
    const r = run(track(step, 3.0), 'scoop', [G]);
    expect(r.detected).toBe(false);
    expect(r.score).toBeLessThanOrEqual(0.45);
    expect(hasNote(r, /step from below/)).toBe(true);
  });

  it('scores an arrival 400 ms late below an on-time one, and says so', () => {
    const lateScoop = sungContour([{ midi: 62, toMidi: 64, start: 1.0, end: 1.8167 }, { midi: 64, start: 1.8167, end: 3.0 }], 30);
    const late = run(track(lateScoop, 3.0), 'scoop', [G]);
    const good = run(track(ideal, 3.0), 'scoop', [G]);
    expect(late.score).toBeLessThan(good.score - 0.15);
    expect(hasNote(late, /late/)).toBe(true);
    expect(late.timeMs).toBeGreaterThan(700);
  });

  it('scores a scoop that never settles on the landing pitch low', () => {
    const r = run(track((t) => (t >= 1.0 ? 62.2 + 0.3 * Math.sin(t * 5) : NaN), 3.0), 'scoop', [G]);
    expect(r.timeMs).toBeNull();
    expect(r.score).toBeLessThanOrEqual(0.3);
    expect(hasNote(r, /Never settled/)).toBe(true);
  });

  it('measures how deep the scoop was, so an over-deep one scores below one of the requested size', () => {
    const deep = sungContour([{ midi: 59, toMidi: 64, start: 1.0, end: 1.4167 }, H], 30);
    const r = run(track(deep, 3.0), 'scoop', [G]);
    expect(r.sizeCents).toBeGreaterThan(450);
    expect(r.score).toBeLessThan(run(track(ideal, 3.0), 'scoop', [G]).score - 0.1);
    expect(hasNote(r, /Scoop was/)).toBe(true);
  });

  it('judges the landing against the level: 30 c flat is fine at easy, poor at studio', () => {
    const flatLand = sungContour([G, { ...H, midi: 63.7 }].map((n, i) => (i === 0 ? { ...n, toMidi: 63.7 } : n)), 30);
    const easy = run(track(flatLand, 3.0), 'scoop', [G, H], EASY);
    const studio = run(track(flatLand, 3.0), 'scoop', [G, H], STUDIO);
    expect(easy.score).toBeGreaterThan(studio.score + 0.1);
    expect(studio.landingAbsCents).toBeGreaterThan(20);
  });

  it('is honest when there is no audio', () => {
    const r = run(track(() => NaN, 3.0), 'scoop', [G]);
    expect(r.detected).toBe(false);
    expect(r.score).toBe(0);
    expect(r.sizeCents).toBeNull();
    expect(r.notes.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------- fall
describe('analyzeInflection: fall', () => {
  // Hold 67 for 1.7 s, then a one-beat fall to 62; the level dies away over the fall.
  const H: TargetNote = { midi: 67, start: 0.5, end: 2.2 };
  const F: TargetNote = { midi: 67, toMidi: 62, start: 2.2, end: 3.0333 };
  const fadeRms = (t: number): number => (t < F.start ? -20 : t < F.end ? -20 - 30 * ((t - F.start) / (F.end - F.start)) : -50);
  const idealFall = (t: number): number => (t < 0.5 ? NaN : t < F.start ? 67 : t < F.end ? 67 - 5 * ((t - F.start) / (F.end - F.start)) : t < 3.1 ? 62 : NaN);

  it('scores a held note released into one smooth fall as the sound fades (hold target alone)', () => {
    const r = run(track(idealFall, 3.1, { rms: fadeRms }), 'fall', [H]);
    expect(r.kind).toBe('fall');
    expect(r.detected).toBe(true);
    expect(r.sizeCents).toBeGreaterThan(400);
    expect(r.timeMs).toBeGreaterThan(500);
    expect(r.timeMs).toBeLessThan(1100);
    expect(r.score).toBeGreaterThan(0.85);
    expect(r.notes).toEqual([]);
  });

  it('scores the same take against the requested drop and duration when the fall glide is supplied', () => {
    const r = run(track(idealFall, 3.1, { rms: fadeRms }), 'fall', [H, F]);
    expect(r.detected).toBe(true);
    expect(r.score).toBeGreaterThan(0.9);
    expect(r.sizeCents).toBeGreaterThan(400);
  });

  it('reports a landing only when the fall ends on a held pitch', () => {
    const r = run(track(idealFall, 3.1, { rms: fadeRms }), 'fall', [H, F]);
    expect(r.landingAbsCents === null || r.landingAbsCents < 30).toBe(true);
    const toSilence = (t: number): number => (t < F.end - 0.2 ? idealFall(t) : NaN);
    expect(run(track(toSilence, 3.1, { rms: fadeRms }), 'fall', [H, F]).landingAbsCents).toBeNull();
  });

  it('notes it when the level does not die away (a pitch drop is not necessarily a sung fall-off)', () => {
    const faded = run(track(idealFall, 3.1, { rms: fadeRms }), 'fall', [H]);
    const steady = run(track(idealFall, 3.1), 'fall', [H]);
    expect(hasNote(steady, /die away/)).toBe(true);
    expect(steady.score).toBeLessThan(faded.score - 0.1);
    expect(steady.detected).toBe(true);
  });

  it('does not credit an instant step down as a fall', () => {
    const step = (t: number): number => (t < 0.5 ? NaN : t < F.start ? 67 : 62);
    const r = run(track(step, 3.1, { rms: fadeRms }), 'fall', [H, F]);
    expect(r.detected).toBe(false);
    expect(r.score).toBeLessThanOrEqual(0.4);
    expect(hasNote(r, /one step/)).toBe(true);
  });

  it('does not credit a note that was simply held, then stopped', () => {
    const r = run(track((t) => (t >= 0.5 && t < 2.3 ? 67 : NaN), 3.0), 'fall', [H]);
    expect(r.detected).toBe(false);
    expect(r.score).toBeLessThanOrEqual(0.4);
    expect(hasNote(r, /never fell/)).toBe(true);
  });

  it('does not credit a droop of under a semitone as a fall', () => {
    const droop = (t: number): number => (t < 0.5 ? NaN : t < F.start ? 67 : 67 - 0.8 * Math.min(1, (t - F.start) / 0.8));
    const r = run(track(droop, 3.1, { rms: fadeRms }), 'fall', [H, F]);
    expect(r.detected).toBe(false);
    expect(r.score).toBeLessThanOrEqual(0.4);
  });

  it('notes and penalises a hold that sagged before the fall', () => {
    const sag = (t: number): number => (t < 0.5 ? NaN : t < F.start - 0.4 ? 67 : t < F.start ? 67 - 0.6 * ((t - (F.start - 0.4)) / 0.4) : t < F.end ? 66.4 - 4.4 * ((t - F.start) / (F.end - F.start)) : 62);
    const r = run(track(sag, 3.1, { rms: fadeRms }), 'fall', [H, F]);
    const clean = run(track(idealFall, 3.1, { rms: fadeRms }), 'fall', [H, F]);
    expect(hasNote(r, /sagged/)).toBe(true);
    expect(r.score).toBeLessThan(clean.score - 0.03);
  });

  it('is honest when there is no audio', () => {
    const r = run(track(() => NaN, 3.0), 'fall', [H]);
    expect(r.detected).toBe(false);
    expect(r.score).toBe(0);
    expect(r.notes.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------- slide
describe('analyzeInflection: slide', () => {
  const A: TargetNote = { midi: 60, start: 0.2, end: 1.0 };
  const G: TargetNote = { midi: 60, toMidi: 65, start: 1.0, end: 1.8333 };
  const B: TargetNote = { midi: 65, start: 1.8333, end: 3.0 };
  const ideal = sungContour([A, G, B], 30);

  it('scores a slide that starts on the cue, moves evenly and arrives as the bar ends (glide target alone)', () => {
    const r = run(track(ideal, 3.0), 'slide', [G]);
    expect(r.kind).toBe('slide');
    expect(r.detected).toBe(true);
    expect(r.timeMs).toBeGreaterThan(740);
    expect(r.timeMs).toBeLessThan(930);
    expect(r.landingAbsCents).toBeLessThan(15);
    expect(Math.abs(r.sizeCents as number)).toBeLessThan(30);
    expect(r.score).toBeGreaterThan(0.9);
    expect(r.notes).toEqual([]);
  });

  it('gives the same verdict with the holds before and after supplied', () => {
    const r = run(track(ideal, 3.0), 'slide', [A, G, B]);
    expect(r.detected).toBe(true);
    expect(r.score).toBeGreaterThan(0.9);
  });

  it('scores a slide that takes twice as long, arriving late, below the right one, and says so', () => {
    const slow = sungContour([A, { ...G, end: 2.6667 }, { ...B, start: 2.6667 }], 30);
    const r = run(track(slow, 3.0), 'slide', [G]);
    expect(r.score).toBeLessThan(0.8);
    expect(r.timeMs).toBeGreaterThan(1400);
    expect(hasNote(r, /took about/)).toBe(true);
    expect(hasNote(r, /late/)).toBe(true);
  });

  it('scores a slide that is over in a third of the time below the right one', () => {
    const quick = sungContour([A, { ...G, end: 1.28 }, { ...B, start: 1.28 }], 30);
    const r = run(track(quick, 3.0), 'slide', [G]);
    expect(r.score).toBeLessThan(0.85);
    expect(r.timeMs).toBeLessThan(450);
  });

  it('reports a slide that falls short as a negative size and a poor landing', () => {
    const short = sungContour([A, { ...G, toMidi: 63.5 }, { ...B, midi: 63.5 }], 30);
    const r = run(track(short, 3.0), 'slide', [G, B]);
    expect(r.sizeCents as number).toBeLessThan(-100);
    expect(r.landingAbsCents as number).toBeGreaterThan(100);
    expect(r.score).toBeLessThan(0.7);
  });

  it('notes a slide that moved in steps', () => {
    const steps = (t: number): number => {
      if (t < 0.2) return NaN;
      if (t < G.start) return 60;
      if (t > G.end) return 65;
      return 60 + Math.min(5, Math.floor(((t - G.start) / (G.end - G.start)) * 5) + 0.5);
    };
    const r = run(track(steps, 3.0), 'slide', [G]);
    expect(hasNote(r, /step/)).toBe(true);
    expect(r.score).toBeLessThan(run(track(ideal, 3.0), 'slide', [G]).score - 0.15);
  });

  it('notes a break inside the slide and marks it down', () => {
    const cracked = (t: number): number => (t > 1.4 && t < 1.8333 ? ideal(t) + 3.2 : ideal(t));
    const r = run(track(cracked, 3.0), 'slide', [G]);
    expect(hasNote(r, /break/)).toBe(true);
    expect(r.score).toBeLessThan(0.85);
  });

  it('does not credit a note that never moved', () => {
    const r = run(track((t) => (t >= 0.2 && t < 3.0 ? 60 : NaN), 3.0), 'slide', [G]);
    expect(r.detected).toBe(false);
    expect(r.score).toBeLessThanOrEqual(0.3);
    expect(hasNote(r, /travelled/)).toBe(true);
  });

  it('does not credit a jump to the end note as a slide', () => {
    const jump = (t: number): number => (t < 0.2 ? NaN : t < 1.8333 ? 60 : 65);
    const r = run(track(jump, 3.0), 'slide', [G]);
    expect(r.detected).toBe(false);
    expect(r.score).toBeLessThanOrEqual(0.3);
    expect(hasNote(r, /jumped/)).toBe(true);
  });

  it('does not pass a slide that takes three times the requested length', () => {
    const crawl = sungContour([A, { ...G, end: 3.5 }, { ...B, start: 3.5, end: 5 }], 30);
    const r = run(track(crawl, 5.0), 'slide', [G]);
    expect(r.score).toBeLessThanOrEqual(0.45);
  });

  it('does not credit a singer who just holds the destination note the whole time', () => {
    const r = run(track((t) => (t >= 0.2 && t < 3.0 ? 65 : NaN), 3.0), 'slide', [G]);
    expect(r.detected).toBe(false);
    expect(r.score).toBeLessThanOrEqual(0.3);
  });

  it('works downwards', () => {
    const down: TargetNote = { midi: 65, toMidi: 60, start: 1.0, end: 1.8333 };
    const dn = sungContour([{ midi: 65, start: 0.2, end: 1.0 }, down, { midi: 60, start: 1.8333, end: 3.0 }], 30);
    const r = run(track(dn, 3.0), 'slide', [down]);
    expect(r.detected).toBe(true);
    expect(r.score).toBeGreaterThan(0.9);
  });

  it('asks for a glide target', () => {
    const r = run(track(ideal, 3.0), 'slide', [A]);
    expect(r.detected).toBe(false);
    expect(r.notes.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------- turn
describe('analyzeInflection: turn', () => {
  // main 60, upper neighbour 62, main, lower neighbour 59, main.
  const SEQ: TargetNote[] = [
    { midi: 60, start: 1.0, end: 1.8 },
    { midi: 62, start: 1.8, end: 2.2 },
    { midi: 60, start: 2.2, end: 2.6 },
    { midi: 59, start: 2.6, end: 3.0 },
    { midi: 60, start: 3.0, end: 4.0 },
  ];
  const MAIN: TargetNote = { midi: 60, start: 1.0, end: 4.0 };
  const UP = SEQ[1];
  const DOWN = SEQ[3];
  const ideal = sungContour(SEQ, 30);

  it('scores an upper-neighbour excursion that returns to the main note (main + neighbour)', () => {
    const r = run(track(ideal, 4.0), 'turn', [MAIN, UP]);
    expect(r.kind).toBe('turn');
    expect(r.detected).toBe(true);
    expect(r.sizeCents).toBeGreaterThan(170);
    expect(r.sizeCents).toBeLessThan(230);
    expect(r.landingAbsCents).toBeLessThan(15);
    expect(r.score).toBeGreaterThan(0.9);
    expect(r.notes).toEqual([]);
  });

  it('scores the lower-neighbour excursion of the same figure', () => {
    const r = run(track(ideal, 4.0), 'turn', [MAIN, DOWN]);
    expect(r.detected).toBe(true);
    expect(r.sizeCents).toBeGreaterThan(70);
    expect(r.sizeCents).toBeLessThan(130);
    expect(r.score).toBeGreaterThan(0.9);
  });

  it('scores the whole figure from the full note sequence', () => {
    const r = run(track(ideal, 4.0), 'turn', SEQ);
    expect(r.detected).toBe(true);
    expect(r.score).toBeGreaterThan(0.9);
    expect(r.timeMs).toBeGreaterThan(1000);
    expect(r.landingAbsCents).toBeLessThan(15);
  });

  it('does not credit a neighbour that was never sung', () => {
    const flatMain = (t: number): number => (t >= 1.0 && t < 4.0 ? 60 : NaN);
    for (const targets of [[MAIN, UP], [MAIN, DOWN], SEQ]) {
      const r = run(track(flatMain, 4.0), 'turn', targets);
      expect(r.detected).toBe(false);
      expect(r.score).toBeLessThanOrEqual(0.4);
      expect(hasNote(r, /Never reached the/)).toBe(true);
    }
  });

  it('says a neighbour sung a whole step too wide was never reached (it is nowhere near the pitch asked for)', () => {
    const wide = sungContour(SEQ.map((n, i) => (i === 1 ? { ...n, midi: 64 } : n)), 30);
    const r = run(track(wide, 4.0), 'turn', [MAIN, UP]);
    expect(r.detected).toBe(false);
    expect(r.score).toBeLessThanOrEqual(0.4);
    expect(hasNote(r, /Never reached the upper neighbour \(\+200c\)/)).toBe(true);
  });

  it('marks down a neighbour that is reached but sung 45 c off', () => {
    const off = sungContour(SEQ.map((n, i) => (i === 3 ? { ...n, midi: 58.55 } : n)), 30); // lower neighbour 145 c down instead of 100
    const good = run(track(ideal, 4.0), 'turn', [MAIN, DOWN]);
    const r = run(track(off, 4.0), 'turn', [MAIN, DOWN]);
    expect(r.detected).toBe(true);
    expect(r.score).toBeLessThan(good.score - 0.05);
    expect(r.sizeCents).toBeGreaterThan(130);
  });

  it('notes when the voice never lands back on the main note', () => {
    const stays = (t: number): number => (t < 1.0 ? NaN : t < 1.8 ? 60 : 62);
    const r = run(track(stays, 4.0), 'turn', [MAIN, UP]);
    expect(r.landingAbsCents).toBeNull();
    expect(hasNote(r, /land back on the main/)).toBe(true);
    expect(r.score).toBeLessThanOrEqual(0.45);
  });

  it('needs a main note and a neighbour inside it', () => {
    expect(run(track(ideal, 4.0), 'turn', [MAIN]).detected).toBe(false);
    expect(run(track(ideal, 4.0), 'turn', [UP, MAIN]).detected).toBe(false); // neighbour not inside the main span
    expect(run(track(ideal, 4.0), 'turn', []).notes.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------- flip
describe('analyzeInflection: flip', () => {
  const LOW: TargetNote = { midi: 60, start: 0.5, end: 2.3 };
  const HIGH: TargetNote = { midi: 67, start: 2.3, end: 4.1 };

  /** An abrupt flip with a brief confidence dip at the break, as a register change shows in the detector. */
  function flipTrack(contour: Contour, dip = true): PitchFrame[] {
    const t = track(contour, 4.1);
    return dip ? t.map((f) => (f.t > 2.27 && f.t < 2.36 ? { ...f, confidence: 0.6 } : f)) : t;
  }
  const abrupt = (t: number): number => (t < 0.5 ? NaN : t < 2.3 ? 60 : 67);

  it('scores a quick flip up a fifth that lands centred', () => {
    const r = run(flipTrack(abrupt), 'flip', [LOW, HIGH]);
    expect(r.kind).toBe('flip');
    expect(r.detected).toBe(true);
    expect(r.sizeCents).toBeGreaterThan(650);
    expect(r.sizeCents).toBeLessThan(750);
    expect(r.timeMs).toBeLessThan(80);
    expect(r.landingAbsCents).toBeLessThan(12);
    expect(r.score).toBeGreaterThan(0.9);
  });

  it('reports the confidence dip at the break as an observation, and is honest that it cannot prove intent', () => {
    const withDip = run(flipTrack(abrupt, true), 'flip', [LOW, HIGH]);
    const noDip = run(flipTrack(abrupt, false), 'flip', [LOW, HIGH]);
    expect(hasNote(withDip, /Confidence dipped/)).toBe(true);
    expect(hasNote(withDip, /cannot show whether it was intended/)).toBe(true);
    expect(hasNote(noDip, /Confidence dipped/)).toBe(false);
    expect(withDip.score).toBeCloseTo(noDip.score, 6); // observed, never scored
  });

  it('does not call a long slide up a flip', () => {
    const slideUp = (t: number): number => (t < 0.5 ? NaN : t < 2.1 ? 60 : t < 2.6 ? 60 + 7 * ((t - 2.1) / 0.5) : 67);
    const r = run(flipTrack(slideUp, false), 'flip', [LOW, HIGH]);
    expect(r.timeMs).toBeGreaterThan(250);
    expect(hasNote(r, /slide, not a flip/)).toBe(true);
    expect(r.score).toBeLessThan(run(flipTrack(abrupt, false), 'flip', [LOW, HIGH]).score - 0.1);
  });

  it('marks down a flip that lands 200 c flat', () => {
    const flat = (t: number): number => (t < 0.5 ? NaN : t < 2.3 ? 60 : 65);
    const r = run(flipTrack(flat), 'flip', [LOW, HIGH]);
    expect(r.landingAbsCents).toBeGreaterThan(150);
    expect(r.score).toBeLessThan(0.65);
  });

  it('judges the landing against the level', () => {
    const sharp = (t: number): number => (t < 0.5 ? NaN : t < 2.3 ? 60 : 67.3);
    const studio = run(flipTrack(sharp), 'flip', [LOW, HIGH], STUDIO);
    const easy = run(flipTrack(sharp), 'flip', [LOW, HIGH], EASY);
    expect(easy.score).toBeGreaterThan(studio.score + 0.1);
  });

  it('does not credit a jump of a third when a fifth was asked for', () => {
    const small = (t: number): number => (t < 0.5 ? NaN : t < 2.3 ? 60 : 63);
    const r = run(flipTrack(small), 'flip', [LOW, HIGH]);
    expect(r.detected).toBe(false);
    expect(r.score).toBeLessThanOrEqual(0.45);
    expect(hasNote(r, /jump was only/)).toBe(true);
  });

  it('is honest when the landing note was never sung', () => {
    const r = run(flipTrack((t) => (t >= 0.5 && t < 2.3 ? 60 : NaN)), 'flip', [LOW, HIGH]);
    expect(r.detected).toBe(false);
    expect(r.score).toBe(0);
    expect(r.notes.length).toBeGreaterThan(0);
  });

  it('flips downward too, and scores each flip in a longer group', () => {
    const dn = (t: number): number => (t < 0.5 ? NaN : t < 2.3 ? 67 : 60);
    expect(run(flipTrack(dn, false), 'flip', [{ ...LOW, midi: 67 }, { ...HIGH, midi: 60 }]).score).toBeGreaterThan(0.85);
    const two = (t: number): number => (t < 0.5 ? NaN : t < 2.3 ? 60 : t < 4.1 ? 67 : 72);
    const r = run(track(two, 5.9), 'flip', [LOW, HIGH, { midi: 72, start: 4.1, end: 5.9 }]);
    expect(r.detected).toBe(true);
    expect(r.score).toBeGreaterThan(0.85);
  });

  it('needs two notes', () => {
    expect(run(flipTrack(abrupt), 'flip', [LOW]).detected).toBe(false);
  });
});

// ---------------------------------------------------------------- shared behaviour
describe('analyzeInflection: shared behaviour', () => {
  it('keeps every score in 0..1 and every result JSON-serialisable', () => {
    const kinds: InflectionKind[] = ['scoop', 'fall', 'slide', 'turn', 'flip'];
    const targets: TargetNote[] = [
      { midi: 60, toMidi: 64, start: 0.2, end: 0.7 },
      { midi: 64, start: 0.7, end: 1.6 },
      { midi: 62, start: 1.6, end: 2.2 },
    ];
    const noise = makeTrack({ duration: 3, midi: (t) => 60 + 5 * Math.sin(t * 9), jitterCents: 40 });
    for (const kind of kinds) {
      for (const tk of [noise, [], makeTrack({ duration: 3, midi: () => NaN })]) {
        const r = analyzeInflection(tk, kind, targets, CTX);
        expect(r.kind).toBe(kind);
        expect(r.score).toBeGreaterThanOrEqual(0);
        expect(r.score).toBeLessThanOrEqual(1);
        expect(JSON.parse(JSON.stringify(r))).toEqual(r);
      }
    }
  });

  it('throws on an unknown kind rather than guessing', () => {
    expect(() => analyzeInflection([], 'yodel' as unknown as InflectionKind, [], CTX)).toThrow();
  });

  it('does not mutate the track or the targets', () => {
    const G: TargetNote = { midi: 62, toMidi: 64, start: 1.0, end: 1.4167 };
    const tk = track(sungContour([G, { midi: 64, start: 1.4167, end: 3 }], 30), 3);
    const copy = tk.map((f) => ({ ...f }));
    const g0 = { ...G };
    analyzeInflection(tk, 'scoop', [G], CTX);
    expect(tk).toEqual(copy);
    expect(G).toEqual(g0);
  });
});
