/**
 * Contract guard for the analysis-core analyzers. The assignments below are
 * compile-time checks (npm run typecheck): if an analyzer's signature drifts
 * from the function type in src/analysis/types.ts, this file stops compiling.
 * The runtime tests check the other half of the contract: results are plain
 * JSON-serialisable data (they are stored in AttemptRecord.metrics and shown
 * in take reports) and every Metrics key is a finite number.
 */
import { describe, expect, it } from 'vitest';
import { analyzeAccuracy } from './accuracy';
import { analyzeDynamics } from './dynamics';
import { analyzeOnset } from './onset';
import { analyzeRange } from './range';
import { analyzeVibrato } from './vibrato';
import { analyzePulse } from './pulse';
import { analyzeSwitch } from './switch';
import { metricsFromResults } from './score';
import { makeTrack, sustained, withVibrato } from './fixtures';
import type { AnalyzeAccuracy, AnalyzeContext, AnalyzeDynamics, AnalyzeOnset, AnalyzeRange, AnalyzeVibrato } from './types';

// Compile-time: each analyzer is usable wherever the contract type is expected.
const asAccuracy: AnalyzeAccuracy = analyzeAccuracy;
const asOnset: AnalyzeOnset = analyzeOnset;
const asVibrato: AnalyzeVibrato = analyzeVibrato;
const asDynamics: AnalyzeDynamics = analyzeDynamics;
const asRange: AnalyzeRange = analyzeRange;

const ctx: AnalyzeContext = { toleranceCents: 25, vibratoStyle: 'pop' };

describe('analysis-core contract', () => {
  it('analyzers are assignable to the contract function types', () => {
    for (const fn of [asAccuracy, asOnset, asVibrato, asDynamics, asRange]) expect(typeof fn).toBe('function');
  });

  it('results of a normal take are plain JSON data that survives a round trip unchanged', () => {
    const note = sustained(60, 0.3, 4);
    const track = makeTrack({ duration: 4.5, midi: (t) => (t < 0.3 ? NaN : withVibrato(() => 60, 5.8, 40, 1.5)(t)), jitterCents: 4, seed: 3, rmsDb: (t) => -30 + 8 * Math.sin(t) });
    const results = {
      accuracy: asAccuracy(track, note, ctx),
      onset: asOnset(track, note, ctx),
      vibrato: asVibrato(track, note, ctx),
      dynamics: asDynamics(track, note, ctx),
      range: asRange(track),
      pulse: analyzePulse(track, note, 5.8),
      switch: analyzeSwitch(track, [
        { start: 0.3, end: 1.5, vibrato: false },
        { start: 1.5, end: 4, vibrato: true },
      ]),
    };
    for (const [name, value] of Object.entries(results)) {
      expect(JSON.parse(JSON.stringify(value)), name).toEqual(value);
    }
  });

  it('every metric a take produces is a finite number, even a take that is entirely silence', () => {
    const note = sustained(60, 0, 3);
    for (const midi of [(t: number) => (t < 0 ? 60 : NaN), withVibrato(() => 60, 5.8, 45)]) {
      const track = makeTrack({ duration: 3, midi, jitterCents: 3, seed: 1 });
      const m = metricsFromResults({
        accuracy: asAccuracy(track, note, ctx),
        onset: asOnset(track, note, ctx),
        vibrato: asVibrato(track, note, ctx),
        dynamics: asDynamics(track, note, ctx),
        range: asRange(track),
        pulse: analyzePulse(track, note, 4.5),
        switch: analyzeSwitch(track, [
          { start: 0, end: 1.5, vibrato: false },
          { start: 1.5, end: 3, vibrato: true },
        ]),
      });
      for (const [k, v] of Object.entries(m)) expect(Number.isFinite(v), k).toBe(true);
    }
  });
});
