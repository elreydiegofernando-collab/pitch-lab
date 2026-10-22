import { afterEach, describe, expect, it, vi } from 'vitest';
import { newId, newShortId } from './ids';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** The platform's getRandomValues, captured before a test replaces `crypto`. */
function realGetRandomValues(): <T extends ArrayBufferView>(array: T) => T {
  const real = globalThis.crypto;
  return <T extends ArrayBufferView>(array: T): T => real.getRandomValues(array as unknown as Uint8Array<ArrayBuffer>) as unknown as T;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('newId', () => {
  it('returns a v4 UUID', () => {
    expect(newId()).toMatch(UUID_V4);
  });

  it('uses crypto.randomUUID() when the browser has it', () => {
    vi.stubGlobal('crypto', { randomUUID: () => 'fixed-by-randomUUID' });
    expect(newId()).toBe('fixed-by-randomUUID');
  });

  it('builds a valid v4 UUID from getRandomValues() when randomUUID() is missing (insecure context, old Safari)', () => {
    vi.stubGlobal('crypto', { getRandomValues: realGetRandomValues() });
    for (let i = 0; i < 50; i++) expect(newId()).toMatch(UUID_V4);
  });

  it('still returns a valid v4 UUID with no Web Crypto at all', () => {
    vi.stubGlobal('crypto', undefined);
    for (let i = 0; i < 50; i++) expect(newId()).toMatch(UUID_V4);
  });

  it('never collides across 20k ids, in any tier', () => {
    const getRandomValues = realGetRandomValues();
    const tiers: Array<() => void> = [
      () => {},
      () => vi.stubGlobal('crypto', { getRandomValues }),
      () => vi.stubGlobal('crypto', undefined),
    ];
    for (const setup of tiers) {
      vi.unstubAllGlobals();
      setup();
      const seen = new Set<string>();
      for (let i = 0; i < 20_000; i++) seen.add(newId());
      expect(seen.size).toBe(20_000);
    }
  });
});

describe('newShortId', () => {
  it('has the requested length and only [0-9a-z]', () => {
    expect(newShortId()).toMatch(/^[0-9a-z]{8}$/);
    expect(newShortId(3)).toMatch(/^[0-9a-z]{3}$/);
    expect(newShortId(24)).toMatch(/^[0-9a-z]{24}$/);
  });

  it('works without Web Crypto', () => {
    vi.stubGlobal('crypto', undefined);
    expect(newShortId(12)).toMatch(/^[0-9a-z]{12}$/);
  });

  it('is not constant', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) seen.add(newShortId());
    expect(seen.size).toBeGreaterThan(190);
  });
});
