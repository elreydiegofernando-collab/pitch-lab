/**
 * Byte-to-text decoding for legacy song files (UltraStar .txt and MIDI text events).
 *
 * Old files are rarely UTF-8: they are windows-1252, where bytes 0x80-0x9F are the "smart"
 * punctuation that lyrics are full of (the apostrophe in "don't" is 0x92). The WHATWG
 * `TextDecoder('windows-1252')` handles that in browsers, but engines differ (Node 22 here
 * decodes the label as plain ISO-8859-1 and returns C1 control characters), so the table is
 * spelled out and the result is the same everywhere.
 */

/**
 * Code points for bytes 0x80..0x9F in windows-1252 (the WHATWG index; the five unassigned bytes
 * 0x81, 0x8D, 0x8F, 0x90, 0x9D stay C1 controls). Numbers, not a string literal, so no invisible
 * control characters live in this source file.
 */
const CP1252_HIGH: readonly number[] = [
  0x20ac, 0x0081, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030, 0x0160, 0x2039, 0x0152, 0x008d, 0x017d, 0x008f,
  0x0090, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0x009d, 0x017e, 0x0178,
];

/** Decodes bytes as windows-1252 (ASCII and 0xA0-0xFF are identical to Latin-1). */
export function decodeWindows1252(bytes: Uint8Array): string {
  const parts: string[] = [];
  const CHUNK = 8192;
  for (let start = 0; start < bytes.length; start += CHUNK) {
    let s = '';
    const end = Math.min(bytes.length, start + CHUNK);
    for (let i = start; i < end; i++) {
      const b = bytes[i];
      s += String.fromCharCode(b >= 0x80 && b <= 0x9f ? CP1252_HIGH[b - 0x80] : b);
    }
    parts.push(s);
  }
  return parts.join('');
}

/** Strict UTF-8 (a BOM is dropped), else windows-1252. */
export function decodeUtf8OrWindows1252(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return decodeWindows1252(bytes);
  }
}
