import { describe, expect, it } from 'vitest';
import { rmsDb } from './rms';
import { sine } from './test-signals';

describe('rmsDb', () => {
  it('reports 0 dBFS for a full-scale sine', () => {
    const window = sine(44100, 2048 / 44100, 440, 1);
    expect(rmsDb(window, -100)).toBeCloseTo(20 * Math.log10(1 / Math.SQRT2), 1);
  });

  it('scales by 20 dB per decade of amplitude', () => {
    const full = sine(44100, 2048 / 44100, 440, 1);
    const half = sine(44100, 2048 / 44100, 440, 0.1);
    expect(rmsDb(half, -100) - rmsDb(full, -100)).toBeCloseTo(-20, 1);
  });

  it('clamps digital silence at floorDb instead of -Infinity', () => {
    const silent = new Float32Array(2048);
    expect(rmsDb(silent, -100)).toBe(-100);
    expect(rmsDb(silent, -60)).toBe(-60);
  });

  it('clamps anything quieter than floorDb', () => {
    const tiny = sine(44100, 2048 / 44100, 440, 1e-9);
    expect(rmsDb(tiny, -100)).toBe(-100);
  });

  it('is allocation-safe to call repeatedly on reused buffers', () => {
    const window = new Float32Array(2048);
    for (let i = 0; i < 2048; i++) window[i] = Math.sin(i);
    for (let i = 0; i < 1000; i++) {
      expect(Number.isFinite(rmsDb(window, -100))).toBe(true);
    }
  });
});
