/**
 * Small deterministic content hash used to derive stable ids for imported songs
 * (Song.id contract: "hash of content for imports, slug for bundled" - song/types.ts).
 * Re-importing the exact same chart yields the same id, so storage/songs-repo.ts
 * (which upserts on Song.id) refreshes one record instead of duplicating it.
 *
 * Two independent 32-bit FNV-1a passes (different offset bases, the second also
 * folds in the input length) give 64 bits: a collision would make an import
 * silently overwrite a DIFFERENT song, so 32 bits (about 1 in 4 billion per pair)
 * was judged too thin for a library that only ever grows. Not cryptographic.
 */

const FNV_PRIME = 0x01000193;
const FNV_BASIS_A = 0x811c9dc5;
const FNV_BASIS_B = 0x9747b28c;

function toHex8(n: number): string {
  return (n >>> 0).toString(16).padStart(8, '0');
}

/** 32-bit FNV-1a over UTF-16 code units. */
export function fnv1a32(input: string): number {
  let h = FNV_BASIS_A;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, FNV_PRIME);
  }
  return h >>> 0;
}

function pair(length: number, next: (i: number) => number): string {
  let a = FNV_BASIS_A;
  let b = FNV_BASIS_B ^ length;
  for (let i = 0; i < length; i++) {
    const c = next(i);
    a = Math.imul(a ^ c, FNV_PRIME);
    b = Math.imul(b ^ ((c + i) & 0xffff), FNV_PRIME);
  }
  return toHex8(a) + toHex8(b);
}

/** 16 hex characters (64 bits) over a string. */
export function hashContent(input: string): string {
  return pair(input.length, (i) => input.charCodeAt(i));
}

/** The same hash over raw bytes (e.g. an imported MIDI file), so file content, not its name, defines identity. */
export function hashBytes(bytes: ArrayLike<number>): string {
  return pair(bytes.length, (i) => bytes[i] & 0xff);
}
