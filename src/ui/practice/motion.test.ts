// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { countUpValue, easeOutCubic, prefersReducedMotion, viewReducedMotion } from './motion';

afterEach(() => {
  delete document.documentElement.dataset.reducedMotion;
  vi.unstubAllGlobals();
});

describe('count-up curve', () => {
  it('starts at 0, ends on the target, and eases out in between', () => {
    expect(countUpValue(0, 0.86, 600)).toBe(0);
    expect(countUpValue(600, 0.86, 600)).toBeCloseTo(0.86, 12);
    expect(countUpValue(900, 0.86, 600)).toBeCloseTo(0.86, 12);
    // Ease-out: well over half way after half the time.
    expect(countUpValue(300, 1, 600)).toBeGreaterThan(0.8);
    let last = -1;
    for (let t = 0; t <= 600; t += 50) {
      const v = countUpValue(t, 1, 600);
      expect(v).toBeGreaterThanOrEqual(last);
      last = v;
    }
  });

  it('jumps straight to the target when there is no duration', () => {
    expect(countUpValue(0, 0.5, 0)).toBe(0.5);
  });

  it('clamps the ease input', () => {
    expect(easeOutCubic(-1)).toBe(0);
    expect(easeOutCubic(2)).toBe(1);
  });
});

describe('reduced motion', () => {
  it('follows what state/theme.ts resolved onto <html>', () => {
    document.documentElement.dataset.reducedMotion = 'on';
    expect(prefersReducedMotion()).toBe(true);
    document.documentElement.dataset.reducedMotion = 'off';
    expect(prefersReducedMotion()).toBe(false);
  });

  it('falls back to the OS query before the theme has run', () => {
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: query.includes('reduce'), media: query }));
    expect(prefersReducedMotion()).toBe(true);
    vi.stubGlobal('matchMedia', () => ({ matches: false }));
    expect(prefersReducedMotion()).toBe(false);
  });

  it('lets the pitch view read the OS preference when the setting is "system"', () => {
    expect(viewReducedMotion('system')).toBeUndefined();
    expect(viewReducedMotion('on')).toBe(true);
    expect(viewReducedMotion('off')).toBe(false);
  });
});
