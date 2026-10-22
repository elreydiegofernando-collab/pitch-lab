import { describe, expect, it } from 'vitest';
import { clamp, clamp01 } from './math';

describe('clamp / clamp01', () => {
  it('limits to the range and leaves values inside it alone', () => {
    expect(clamp(5, 0, 10)).toBe(5);
    expect(clamp(-1, 0, 10)).toBe(0);
    expect(clamp(11, 0, 10)).toBe(10);
    expect(clamp(0, 0, 10)).toBe(0);
    expect(clamp(10, 0, 10)).toBe(10);
    expect(clamp01(0.4)).toBe(0.4);
    expect(clamp01(-0.1)).toBe(0);
    expect(clamp01(1.1)).toBe(1);
    expect(clamp01(-Infinity)).toBe(0);
    expect(clamp01(Infinity)).toBe(1);
  });

  it('lets NaN through rather than inventing a number', () => {
    expect(clamp01(NaN)).toBeNaN();
    expect(clamp(NaN, 0, 1)).toBeNaN();
  });
});
