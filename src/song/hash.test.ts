import { describe, expect, it } from 'vitest';
import { fnv1a32, hashBytes, hashContent } from './hash';

describe('hashContent', () => {
  it('is deterministic and 64 bits (16 hex characters)', () => {
    expect(hashContent('hello')).toBe(hashContent('hello'));
    expect(hashContent('hello')).toMatch(/^[0-9a-f]{16}$/);
    expect(hashContent('')).toMatch(/^[0-9a-f]{16}$/);
  });

  it('differs for different content, including tiny edits and reorderings', () => {
    const seen = new Set<string>();
    for (const s of ['a', 'b', 'ab', 'ba', 'a ', ' a', 'A', 'abc', 'acb', '#TITLE:x', '#TITLE:y', 'é', 'e' + String.fromCharCode(0x301)]) seen.add(hashContent(s));
    expect(seen.size).toBe(13);
  });

  it('has no collisions across many near-identical chart-like strings', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 20000; i++) seen.add(hashContent(`#BPM:120\n: ${i} 4 0 la\nE\n`));
    expect(seen.size).toBe(20000);
  });
});

describe('hashBytes', () => {
  it('matches hashContent for ASCII text and differs for different bytes', () => {
    const text = 'MThd test';
    expect(hashBytes(new TextEncoder().encode(text))).toBe(hashContent(text));
    expect(hashBytes([1, 2, 3])).not.toBe(hashBytes([1, 2, 4]));
    expect(hashBytes([1, 2, 3])).toBe(hashBytes(Uint8Array.of(1, 2, 3)));
  });

  it('uses only the low byte of each element', () => {
    expect(hashBytes([0x141])).toBe(hashBytes([0x41]));
  });
});

describe('fnv1a32', () => {
  it('matches the published FNV-1a test vectors', () => {
    expect(fnv1a32('')).toBe(0x811c9dc5);
    expect(fnv1a32('a')).toBe(0xe40c292c);
    expect(fnv1a32('foobar')).toBe(0xbf9cf968);
  });
});
