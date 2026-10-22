/**
 * Audio-level integration test for analyzeSwitch: a synthesized voice that
 * goes straight -> vibrato (a bloom) or on/off/on/off, through the real MPM
 * detector and Framer, scored against a cue plan. The latencies it reports
 * must match when the vibrato really started and stopped, not when a
 * detection window noticed.
 */
import { describe, expect, it } from 'vitest';
import { analyzeSwitch, type VibratoCue } from './switch';
import { attackEnvelope, singAudio } from './core-test-helpers';

const RATE = 5.8;
const EXT = 45;

/** Pitch 60 with vibrato during the given spans, the voice entering at 0.3 s. */
const voice = (spans: ReadonlyArray<readonly [number, number]>) => (t: number) => {
  if (t < 0.3) return NaN;
  const s = spans.find(([a, b]) => t >= a && t < b);
  return 60 + (s ? (EXT / 100) * Math.sin(2 * Math.PI * RATE * (t - s[0])) : 0);
};

describe('analyzeSwitch on real detector output', () => {
  it('straight-to-bloom: latencies match the real delays (on cue, 400 ms, 1000 ms) and score accordingly', () => {
    const cues: VibratoCue[] = [
      { start: 0.3, end: 2.0, vibrato: false },
      { start: 2.0, end: 4.5, vibrato: true },
    ];
    const results = [0, 0.4, 1.0].map((late) => analyzeSwitch(singAudio({ duration: 5, midi: voice([[2.0 + late, 5]]), amp: attackEnvelope(0.3, 0.05) }), cues));
    const [onCue, mid, late] = results;
    expect(onCue.boundaries[0].latencyMs!).toBeGreaterThan(-120);
    expect(onCue.boundaries[0].latencyMs!).toBeLessThan(150);
    expect(onCue.boundaries[0].clean).toBe(true);
    expect(onCue.bloomOnCueScore).toBe(1);
    expect(Math.abs(mid.boundaries[0].latencyMs! - 400)).toBeLessThan(130);
    expect(mid.boundaries[0].clean).toBe(true);
    expect(mid.bloomOnCueScore!).toBeGreaterThan(0.85);
    expect(Math.abs(late.boundaries[0].latencyMs! - 1000)).toBeLessThan(130);
    expect(late.boundaries[0].clean).toBe(false);
    expect(late.bloomOnCueScore!).toBeGreaterThan(0.3);
    expect(late.bloomOnCueScore!).toBeLessThan(0.7);
    expect(onCue.windows.map((w) => w.actual)).toEqual(['straight', 'vibrato']);
  });

  it('on/off switching on four 2-second windows, on the cue, in room noise: every switch clean', () => {
    const cues: VibratoCue[] = [0, 1, 2, 3].map((i) => ({ start: 0.3 + i * 2, end: 0.3 + (i + 1) * 2, vibrato: i % 2 === 0 }));
    const frames = singAudio({ duration: 8.6, midi: voice([[0.3, 2.3], [4.3, 6.3]]), amp: attackEnvelope(0.3, 0.05), noiseDb: -25 });
    const r = analyzeSwitch(frames, cues);
    expect(r.windows.map((w) => w.actual)).toEqual(['vibrato', 'straight', 'vibrato', 'straight']);
    expect(r.boundaries.length).toBe(3);
    expect(r.switchCleanRate).toBe(1);
    for (const b of r.boundaries) expect(Math.abs(b.latencyMs!)).toBeLessThan(250);
  });

  it('a singer who never leaves a straight tone gets no switches and a zero bloom score', () => {
    const cues: VibratoCue[] = [
      { start: 0.3, end: 2.0, vibrato: false },
      { start: 2.0, end: 4.5, vibrato: true },
    ];
    const r = analyzeSwitch(singAudio({ duration: 5, midi: voice([]), amp: attackEnvelope(0.3, 0.05), noiseDb: -25 }), cues);
    expect(r.switchCleanRate).toBe(0);
    expect(r.bloomOnCueScore).toBe(0);
    expect(r.boundaries[0].latencyMs).toBeNull();
  });

  it('a re-attack (the sound stops for 200 ms at the switch) is caught on real audio', () => {
    const cues: VibratoCue[] = [
      { start: 0.3, end: 2.0, vibrato: false },
      { start: 2.0, end: 4.5, vibrato: true },
    ];
    const m = voice([[2.2, 5]]);
    const frames = singAudio({ duration: 5, midi: (t) => (t >= 1.95 && t < 2.2 ? NaN : m(t)), amp: attackEnvelope(0.3, 0.05) });
    const r = analyzeSwitch(frames, cues);
    expect(r.boundaries[0].reattacked).toBe(true);
    expect(r.boundaries[0].clean).toBe(false);
  });
});
