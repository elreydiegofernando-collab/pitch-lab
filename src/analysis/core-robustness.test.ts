/**
 * Adversarial robustness for the analysis-core analyzers: hundreds of random,
 * deliberately ugly tracks (irregular frame spacing, dropouts, wild pitches,
 * glitch frames, extreme levels, tiny and empty inputs) through every
 * analyzer. Nothing may throw, and no NaN / Infinity may leak into a field
 * that promises a finite number (the documented exception: an accuracy result
 * for a note that was never voiced, which is NaN by contract and which
 * metricsFromResults drops).
 */
import { describe, expect, it } from 'vitest';
import type { PitchFrame, TargetNote } from '../core/types';
import { centsFromNearest, midiToHz } from '../core/music';
import { seededRandom } from '../dsp/test-signals';
import { analyzeAccuracy } from './accuracy';
import { analyzeDynamics } from './dynamics';
import { analyzeOnset } from './onset';
import { analyzePulse } from './pulse';
import { analyzeRange } from './range';
import { metricsFromResults } from './score';
import { analyzeSwitch } from './switch';
import { cleanSpikes, heldPortion } from './track';
import { analyzeVibrato, findVibratoEpisodes } from './vibrato';
import type { AnalyzeContext } from './types';

type Rnd = () => number;

/** A random but physically ordered PitchTrack. */
function randomTrack(rnd: Rnd): PitchFrame[] {
  const n = Math.floor(rnd() ** 2 * 900); // 0..900 frames, skewed small
  const dt = 0.0098 + rnd() * 0.002;
  const frames: PitchFrame[] = [];
  let t = (rnd() - 0.3) * 2; // may start negative (count-in)
  let midi = 40 + rnd() * 40;
  let voiced = rnd() < 0.8;
  const mode = Math.floor(rnd() * 4); // 0 steady-ish, 1 vibrato, 2 random walk, 3 chaos
  for (let i = 0; i < n; i++) {
    t += dt * (rnd() < 0.03 ? 1 + Math.floor(rnd() * 5) : 1); // occasional dropped blocks
    if (rnd() < 0.04) voiced = !voiced;
    if (mode === 1) midi += 0.04 * Math.sin(i * 0.4) * (rnd() < 0.5 ? 1 : 0.5);
    else if (mode === 2) midi += (rnd() - 0.5) * 0.4;
    else if (mode === 3) midi = rnd() < 0.1 ? 30 + rnd() * 60 : midi + (rnd() - 0.5) * 3;
    else midi += (rnd() - 0.5) * 0.05;
    let m = midi;
    if (rnd() < 0.02) m += (rnd() < 0.5 ? 12 : -12) + (rnd() - 0.5); // glitch frames
    const isVoiced = voiced && rnd() > 0.02;
    const f0Hz = midiToHz(m);
    frames.push({
      t,
      f0Hz,
      midi: m,
      centsFromNearest: centsFromNearest(m),
      confidence: isVoiced ? 0.8 + rnd() * 0.2 : rnd() * 0.8,
      rmsDb: rnd() < 0.02 ? -100 : -80 + rnd() * 80,
      voiced: isVoiced,
    });
  }
  return frames;
}

function randomNote(rnd: Rnd, track: readonly PitchFrame[]): TargetNote {
  const t0 = track.length ? track[0].t : 0;
  const t1 = track.length ? track[track.length - 1].t : 1;
  const start = t0 + rnd() * (t1 - t0 + 0.5) - 0.2;
  const note: TargetNote = { midi: 36 + Math.floor(rnd() * 48), start, end: start + 0.05 + rnd() * 4 };
  // often aim at a pitch the track really visits, so the settled / scooped / overshot paths run too
  if (track.length > 0 && rnd() < 0.5) {
    const inside = track.filter((f) => f.t >= start && f.t < note.end && f.voiced);
    if (inside.length > 0) note.midi = Math.round(inside[Math.floor(rnd() * inside.length)].midi);
  }
  if (rnd() < 0.2) note.toMidi = note.midi + (rnd() - 0.5) * 24;
  return note;
}

const finite = (x: number | null, label: string): void => {
  if (x !== null) expect(Number.isFinite(x), label).toBe(true);
};
const inUnit = (x: number | null, label: string): void => {
  if (x !== null) {
    expect(Number.isFinite(x), label).toBe(true);
    expect(x, label).toBeGreaterThanOrEqual(0);
    expect(x, label).toBeLessThanOrEqual(1);
  }
};

describe('analysis-core robustness (random ugly tracks)', () => {
  it('no analyzer throws, and every promised number is finite, over 400 random takes', () => {
    const rnd = seededRandom(0xc0ffee);
    for (let iter = 0; iter < 400; iter++) {
      const track = randomTrack(rnd);
      const note = randomNote(rnd, track);
      const ctx: AnalyzeContext = { toleranceCents: [10, 25, 50][Math.floor(rnd() * 3)], vibratoStyle: rnd() < 0.5 ? 'pop' : 'classical' };
      const label = `#${iter} (${track.length} frames)`;

      const acc = analyzeAccuracy(track, note, ctx);
      expect(Number.isFinite(acc.inTolerancePct), label).toBe(true);
      expect(acc.inTolerancePct, label).toBeGreaterThanOrEqual(0);
      expect(acc.inTolerancePct, label).toBeLessThanOrEqual(100);
      expect(Number.isFinite(acc.voicedSec) && acc.voicedSec >= 0, label).toBe(true);
      expect(Number.isFinite(acc.coverage) && acc.coverage >= 0 && acc.coverage <= 1, label).toBe(true);
      if (acc.voicedSec > 0) for (const v of [acc.biasCents, acc.medianAbsCents, acc.sdCents]) expect(Number.isFinite(v), label).toBe(true);
      finite(acc.driftCentsPerSec, label);

      const ons = analyzeOnset(track, note, ctx);
      if (ons.settleMs !== null) expect(ons.settleMs, label).toBeGreaterThanOrEqual(0);
      finite(ons.settleMs, label);
      finite(ons.onsetT, label);
      finite(ons.riseMs, label);
      expect(Number.isFinite(ons.scoopCents) && ons.scoopCents >= 0, label).toBe(true);
      expect(Number.isFinite(ons.overshootCents) && ons.overshootCents >= 0, label).toBe(true);

      const vib = analyzeVibrato(track, rnd() < 0.5 ? note : null, ctx);
      finite(vib.rateHz, label);
      finite(vib.extentCents, label);
      finite(vib.rateSdHz, label);
      finite(vib.extentSdCents, label);
      finite(vib.centeringCents, label);
      inUnit(vib.regularity, label);
      for (const w of vib.windows) {
        finite(w.rateHz, label);
        finite(w.extentCents, label);
        expect(w.end, label).toBeGreaterThanOrEqual(w.start);
      }
      if (!vib.present) {
        expect(vib.rateHz, label).toBeNull();
        expect(vib.inZone, label).toBe(false);
      }

      const dyn = analyzeDynamics(track, note, ctx);
      expect(Number.isFinite(dyn.rangeDb) && dyn.rangeDb >= 0, label).toBe(true);
      finite(dyn.slopeCentsPerDb, label);
      inUnit(dyn.symmetry, label);
      inUnit(dyn.peakPosition, label);
      if (dyn.correlation !== null) expect(Math.abs(dyn.correlation), label).toBeLessThanOrEqual(1 + 1e-9);

      const rng = analyzeRange(track);
      if (rng.lowestMidi !== null && rng.highestMidi !== null) expect(rng.lowestMidi, label).toBeLessThanOrEqual(rng.highestMidi);
      for (const h of rng.heldNotes) {
        expect(Number.isFinite(h.midi) && Number.isFinite(h.start) && h.durationSec > 0, label).toBe(true);
      }

      const pls = analyzePulse(track, rnd() < 0.5 ? note : [note, { ...note, start: note.end, end: note.end + 1 }], 3 + rnd() * 3);
      finite(pls.measuredRateHz, label);
      finite(pls.rateErrorHz, label);
      finite(pls.swingCents, label);
      inUnit(pls.regularity, label);

      const cueEdge = note.start + (note.end - note.start) * rnd();
      const sw = analyzeSwitch(track, [
        { start: note.start, end: cueEdge, vibrato: rnd() < 0.5 },
        { start: cueEdge, end: note.end, vibrato: rnd() < 0.5 },
      ]);
      inUnit(sw.switchCleanRate, label);
      inUnit(sw.bloomOnCueScore, label);
      finite(sw.bloomOnCueLatencyMs, label);
      for (const b of sw.boundaries) finite(b.latencyMs, label);

      for (const e of findVibratoEpisodes(track)) {
        expect(Number.isFinite(e.startT) && Number.isFinite(e.endT) && e.endT >= e.startT, label).toBe(true);
      }
      cleanSpikes(track);
      heldPortion(track, note, 150);

      const metrics = metricsFromResults({ accuracy: acc, onset: ons, vibrato: vib, dynamics: dyn, range: rng, pulse: pls, switch: sw });
      for (const [k, v] of Object.entries(metrics)) expect(Number.isFinite(v), `${label} ${k}`).toBe(true);
    }
  });

  it('degenerate inputs: empty, one frame, identical timestamps, and a track that is all one huge value', () => {
    const note: TargetNote = { midi: 60, start: 0, end: 2 };
    const ctx: AnalyzeContext = { toleranceCents: 25, vibratoStyle: 'pop' };
    const frame = (t: number, midi = 60, voiced = true): PitchFrame => ({ t, f0Hz: midiToHz(midi), midi, centsFromNearest: centsFromNearest(midi), confidence: 0.95, rmsDb: -20, voiced });
    const cases: PitchFrame[][] = [
      [],
      [frame(0.5)],
      Array.from({ length: 50 }, () => frame(1)), // every timestamp identical
      Array.from({ length: 200 }, (_, i) => frame(i * 0.0107, 1e6)), // absurd pitch
      Array.from({ length: 200 }, (_, i) => ({ ...frame(i * 0.0107), rmsDb: Number.MAX_VALUE })),
    ];
    for (const [i, track] of cases.entries()) {
      expect(() => {
        analyzeAccuracy(track, note, ctx);
        analyzeOnset(track, note, ctx);
        analyzeVibrato(track, note, ctx);
        analyzeDynamics(track, note, ctx);
        analyzeRange(track);
        analyzePulse(track, note, 4);
        analyzeSwitch(track, [{ start: 0, end: 1, vibrato: false }, { start: 1, end: 2, vibrato: true }]);
        findVibratoEpisodes(track);
      }, `degenerate case ${i}`).not.toThrow();
    }
  });
});
