/**
 * Audio-level check: real runs synthesized as audio and decoded through the real
 * Framer + MPM detector (same pattern as src/audio/framer.integration.test.ts), not
 * hand-built PitchTracks. Confirms analyzeRun labels notes correctly on detector
 * output - the 43 ms window smearing every move, the onset latency, any glitch frames -
 * at both common sample rates and at 3, 6, 9 and 12 notes per second.
 */
import { describe, expect, it } from 'vitest';
import type { TargetNote } from '../core/types';
import { analyzeRun } from './runs';
import { runNotes, sungContour } from './advanced-test-helpers';
import { trackFromAudio } from './core-test-helpers';
import { midiToHz } from '../core/music';
import { synthesize } from '../dsp/test-signals';
import type { AnalyzeContext, RunNoteVerdict } from './types';

const CTX: AnalyzeContext = { toleranceCents: 25, vibratoStyle: 'pop' };
const PATTERN = [60, 63, 65, 67, 70, 67, 65, 63];

function audioRun(notes: readonly TargetNote[], midi: (t: number) => number, sampleRate: number) {
  const f0 = (t: number): number => {
    const m = midi(t);
    return Number.isFinite(m) ? midiToHz(m) : NaN;
  };
  const signal = synthesize({ sampleRate, duration: notes[notes.length - 1].end + 0.3, f0 });
  return analyzeRun(trackFromAudio(signal, sampleRate), notes, CTX);
}

const labels = (r: ReturnType<typeof analyzeRun>): RunNoteVerdict[] => r.notes.map((n) => n.verdict);

describe('analyzeRun (audio-level: synthesized audio -> Framer -> MPM)', () => {
  for (const sampleRate of [48000, 44100]) {
    for (const nps of [3, 6, 9, 12]) {
      it(`defines every note of a clean ${nps} notes/s run at ${sampleRate} Hz`, () => {
        const notes = runNotes(PATTERN, nps, 0.3);
        const r = audioRun(notes, sungContour(notes, 30), sampleRate);
        expect(labels(r)).toEqual(notes.map(() => 'defined'));
        expect(r.score).toBeGreaterThan(0.95);
        for (const n of r.notes) expect(Math.abs(n.medianErrorCents as number)).toBeLessThan(15);
      });
    }

    for (const nps of [3, 6, 9]) {
      it(`labels a swooped-through note smeared and a silent note missed at ${nps} notes/s, ${sampleRate} Hz`, () => {
        const notes = runNotes(PATTERN, nps, 0.3);
        const base = sungContour(notes, 30);
        const midi = (t: number): number => {
          if (t >= notes[5].start && t < notes[5].end) return NaN;
          if (t >= notes[3].start && t < notes[3].end) return notes[2].midi + (notes[4].midi - notes[2].midi) * ((t - notes[3].start) / (notes[3].end - notes[3].start));
          return base(t);
        };
        const r = audioRun(notes, midi, sampleRate);
        expect(labels(r)).toEqual(['defined', 'defined', 'defined', 'smeared', 'defined', 'missed', 'defined', 'defined']);
        expect(r.score).toBeLessThan(0.85);
      });
    }
  }

  it('reports the real timing of a 6 notes/s run sung 60 ms late', () => {
    const notes = runNotes(PATTERN, 6, 0.4);
    const base = sungContour(notes, 30);
    const r = audioRun(notes, (t) => base(t - 0.06), 48000);
    expect(labels(r)).toEqual(notes.map(() => 'defined'));
    for (const n of r.notes) expect(Math.abs((n.timingErrorMs as number) - 60)).toBeLessThan(30);
  });
});
