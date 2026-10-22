/** Record ids: client-generated, globally unique, never reused (soft delete keeps the row). */

type CryptoLike = {
  randomUUID?: () => string;
  getRandomValues?: <T extends ArrayBufferView>(array: T) => T;
};

function webCrypto(): CryptoLike | undefined {
  return (globalThis as { crypto?: CryptoLike }).crypto;
}

/** Fills `out` with random bytes: Web Crypto when present, Math.random otherwise. */
function fillRandom(out: Uint8Array): Uint8Array {
  const c = webCrypto();
  if (c && typeof c.getRandomValues === 'function') {
    c.getRandomValues(out);
    return out;
  }
  for (let i = 0; i < out.length; i++) out[i] = Math.floor(Math.random() * 256);
  return out;
}

const HEX: string[] = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0'));

/**
 * v4 UUID. Prefers `crypto.randomUUID()` (secure contexts, Safari 15.4+), then a
 * v4 built from `crypto.getRandomValues()`, then Math.random() for ancient
 * WebViews. Ids only need to be unique, never unguessable, so even the last
 * tier is acceptable.
 */
export function newId(): string {
  const c = webCrypto();
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  const b = fillRandom(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40; // version 4
  b[8] = (b[8] & 0x3f) | 0x80; // variant 10xx
  const h = (from: number, to: number): string => {
    let s = '';
    for (let i = from; i < to; i++) s += HEX[b[i]];
    return s;
  };
  return `${h(0, 4)}-${h(4, 6)}-${h(6, 8)}-${h(8, 10)}-${h(10, 16)}`;
}

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';

/** Short random id over [0-9a-z] (no dashes) for non-record identifiers: a device id, a temp-file suffix. */
export function newShortId(len = 8): string {
  const bytes = fillRandom(new Uint8Array(len));
  let out = '';
  for (let i = 0; i < len; i++) out += ALPHABET[bytes[i] % ALPHABET.length];
  return out;
}
