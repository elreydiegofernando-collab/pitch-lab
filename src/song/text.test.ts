import { describe, expect, it } from 'vitest';
import { decodeUtf8OrWindows1252, decodeWindows1252 } from './text';

describe('decodeWindows1252', () => {
  it('leaves ASCII and the Latin-1 range alone', () => {
    const all = Uint8Array.from([0x41, 0x7a, 0x20, 0xa0, 0xa9, 0xe9, 0xff]);
    expect(decodeWindows1252(all)).toBe(String.fromCharCode(0x41, 0x7a, 0x20, 0xa0, 0xa9, 0xe9, 0xff));
  });

  it('maps the 0x80-0x9F punctuation the way windows-1252 does, independent of the engine', () => {
    const decode = (b: number) => decodeWindows1252(Uint8Array.of(b));
    expect(decode(0x80)).toBe('€'); // euro
    expect(decode(0x91)).toBe('‘');
    expect(decode(0x92)).toBe('’'); // the apostrophe in "don't"
    expect(decode(0x93)).toBe('“');
    expect(decode(0x94)).toBe('”');
    expect(decode(0x96)).toBe('–'); // en dash
    expect(decode(0x97)).toBe('—');
    expect(decode(0x99)).toBe('™');
    expect(decode(0x9f)).toBe('Ÿ');
  });

  it('keeps the five unassigned bytes as C1 controls (the WHATWG mapping)', () => {
    for (const b of [0x81, 0x8d, 0x8f, 0x90, 0x9d]) expect(decodeWindows1252(Uint8Array.of(b))).toBe(String.fromCharCode(b));
  });

  it('decodes long input and an empty one', () => {
    const big = new Uint8Array(20000).fill(0x61);
    expect(decodeWindows1252(big)).toBe('a'.repeat(20000));
    expect(decodeWindows1252(new Uint8Array(0))).toBe('');
  });
});

describe('decodeUtf8OrWindows1252', () => {
  it('uses UTF-8 when the bytes are valid UTF-8 (and drops a BOM)', () => {
    expect(decodeUtf8OrWindows1252(new TextEncoder().encode('café ’'))).toBe('café ’');
    expect(decodeUtf8OrWindows1252(Uint8Array.of(0xef, 0xbb, 0xbf, 0x61))).toBe('a');
  });

  it('falls back to windows-1252 otherwise', () => {
    expect(decodeUtf8OrWindows1252(Uint8Array.of(0x63, 0x61, 0x66, 0xe9))).toBe('café');
    expect(decodeUtf8OrWindows1252(Uint8Array.of(0x92))).toBe('’');
  });
});
