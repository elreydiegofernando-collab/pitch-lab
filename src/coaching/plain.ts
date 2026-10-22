/**
 * Plain words and plain numbers for the coach (owner, 2026-10-22: "assume that I am just relearning how to sing").
 * Every helper turns an analyzer number into something a singer can read without a unit: no cents, Hz, dB or ms. Pitch
 * distances are measured against "the next note" (a half step, the next key on a piano), times read as "0:04" or "about
 * half a second", and rates as "about six wobbles a second". Pure, so every rule is tested once (plain.test.ts).
 */
import { CONFIG } from '../config';
import { noteName, type Notation } from '../core/music';

/** Words and symbols a singer relearning music should never have to decode (the coach's own check; the content test has its twin). */
export const JARGON: readonly RegExp[] = [
  /¢/,
  /\bcents?\b/i,
  /\bHz\b/,
  /\bdB\b/,
  /\bms\b/,
  /semitone/i,
  /\bbpm\b/i,
  /passaggio/i,
  /tessitura/i,
  /formant/i,
  /glottal/i,
  /\bonsets?\b/i,
  /melisma/i,
  /portamento/i,
  /!/,
];

/** The jargon `text` uses (empty when it reads plainly). */
export function jargonIn(text: string): RegExp[] {
  return JARGON.filter((re) => re.test(text));
}

/** "0:04", "1:05": take time as minutes and seconds (the downbeat is 0:00; anything before it reads 0:00). */
export function clock(t: number): string {
  const s = Number.isFinite(t) ? Math.max(0, Math.round(t)) : 0;
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

const SMALL = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve'];

/** "six" for 6 (zero to twelve in words, digits above). */
export function numberWord(n: number): string {
  const r = Math.round(n);
  return r >= 0 && r < SMALL.length ? SMALL[r] : String(r);
}

/** To the nearest half, in words: "four and a half", "six", "half". */
export function halvesWord(x: number): string {
  const h = Math.round(x * 2) / 2;
  const whole = Math.floor(h);
  const half = h - whole >= 0.5;
  if (whole === 0) return half ? 'half' : 'zero';
  return half ? `${numberWord(whole)} and a half` : numberWord(whole);
}

/** "once", "twice", "3 times". */
export function times(n: number): string {
  return n === 1 ? 'once' : n === 2 ? 'twice' : `${n} times`;
}

/** "A", "A and B", "A, B and C". */
export function listWords(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/** "1 note", "3 notes". */
export function count(n: number, noun: string, plural = `${noun}s`): string {
  return `${n} ${n === 1 ? noun : plural}`;
}

/** "2 of the 3 notes", "all 3 notes", "the one note". */
export function ofThe(k: number, n: number, noun: string, plural = `${noun}s`): string {
  if (n === 1) return `the one ${noun}`;
  if (k === n) return `all ${n} ${plural}`;
  return `${k} of the ${n} ${plural}`;
}

/** "52%" for a 0..100 percentage. */
export function percentText(pct: number): string {
  return `${Math.round(Math.max(0, Math.min(100, pct)))}%`;
}

/** "52%" for a 0..1 share. */
export function shareText(share: number): string {
  return percentText(share * 100);
}

/** From here up a pitch distance reads as an octave (a note sung an octave away from the demo is a whole miss, never folded). */
const OCTAVE_FROM = 1100;
const OCTAVE_TO = 1300;

/**
 * An unsigned pitch distance as words, measured against the next note (a half step): "a hair", "a little", "about a
 * quarter of the way to the next note", "nearly a half step", "about a whole step", "about 3 half steps", "about an
 * octave", "more than an octave".
 */
export function pitchDistance(absCents: number): string {
  const c = Math.abs(absCents);
  if (!Number.isFinite(c)) return 'too far to measure';
  if (c < 10) return 'a hair';
  if (c < 18) return 'a little';
  if (c < 30) return 'about a quarter of the way to the next note';
  if (c < 42) return 'about a third of the way to the next note';
  if (c < 60) return 'about half the way to the next note';
  if (c < 85) return 'nearly a half step';
  if (c < 125) return 'about a half step';
  if (c < 175) return 'more than a half step';
  if (c < 250) return 'about a whole step';
  if (c < OCTAVE_FROM) return `about ${Math.round(c / 100)} half steps`;
  if (c < OCTAVE_TO) return 'about an octave';
  return 'more than an octave';
}

/** Which way a signed pitch error went: + is sharp (too high), - is flat (too low). */
export function sharpOrFlat(signedCents: number): 'sharp' | 'flat' {
  return signedCents > 0 ? 'sharp' : 'flat';
}

/**
 * A signed pitch error in words: "right on the note", "a hair flat", "a little sharp", "flat by about a quarter of the
 * way to the next note", and an octave or more as "about an octave too low" (an octave away from the demo, not out of tune).
 */
export function offWords(signedCents: number): string {
  const c = Math.abs(signedCents);
  if (!Number.isFinite(c)) return 'too far off to measure';
  if (c < 5) return 'right on the note';
  const dir = sharpOrFlat(signedCents);
  if (c < 10) return `a hair ${dir}`;
  if (c < 18) return `a little ${dir}`;
  if (c >= OCTAVE_FROM) return `${pitchDistance(c)} too ${dir === 'sharp' ? 'high' : 'low'}`;
  return `${dir} by ${pitchDistance(c)}`;
}

const ORDINAL_WORDS = ['first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth'];

/** "first" to "tenth" in words, then "11th", "21st", "22nd", "23rd", "111th": how many tries in a row. */
export function ordinal(n: number): string {
  const r = Math.max(0, Math.round(n));
  if (r >= 1 && r <= 10) return ORDINAL_WORDS[r - 1];
  const lastTwo = r % 100;
  const suffix = lastTwo >= 11 && lastTwo <= 13 ? 'th' : r % 10 === 1 ? 'st' : r % 10 === 2 ? 'nd' : r % 10 === 3 ? 'rd' : 'th';
  return `${r}${suffix}`;
}

/** A length of time as words: "a split second", "about a quarter of a second", "about half a second", "about 3 seconds". */
export function durationWords(sec: number): string {
  const s = Math.abs(sec);
  if (!Number.isFinite(s)) return 'a long time';
  if (s < 0.07) return 'a split second';
  if (s < 0.15) return 'about a tenth of a second';
  if (s < 0.3) return 'about a quarter of a second';
  if (s < 0.4) return 'about a third of a second';
  if (s < 0.65) return 'about half a second';
  if (s < 0.88) return 'about three quarters of a second';
  if (s < 1.25) return 'about a second';
  if (s < 1.75) return 'about one and a half seconds';
  return `about ${Math.round(s)} seconds`;
}

/** "about six wobbles a second", "about four and a half pulses a second". */
export function perSecond(rate: number, noun: string): string {
  const h = Number.isFinite(rate) ? Math.round(rate * 2) / 2 : 0;
  if (!(h > 0)) return `less than half a ${noun} a second`;
  if (h === 0.5) return `about half a ${noun} a second`;
  return `about ${halvesWord(h)} ${h === 1 ? noun : `${noun}s`} a second`;
}

/** The vibrato speed in words. */
export function wobbles(rateHz: number): string {
  return perSecond(rateHz, 'wobble');
}

/** The natural vibrato speeds every style shares (CONFIG.vibrato.styles: 5 to 7 a second), in words. */
export function wobbleZone(): string {
  const z = CONFIG.vibrato.styles;
  const lo = Math.min(z.pop.rateHz[0], z.classical.rateHz[0]);
  const hi = Math.max(z.pop.rateHz[1], z.classical.rateHz[1]);
  return `${halvesWord(lo)} to ${halvesWord(hi)} wobbles a second`;
}

/** "a little" when `value` is past `limit` by at most `share` of it, else "a lot" (how far a reading strays past a line). */
export function howFar(value: number, limit: number, share = 0.3): 'a little' | 'a lot' {
  if (!(limit > 0)) return 'a lot';
  return Math.abs(value - limit) / limit <= share ? 'a little' : 'a lot';
}

/** How much the loudness changed across a note (relative to the take's own quietest point): "barely changed" ... "changed a lot". */
export function loudnessChange(rangeDb: number): string {
  if (!Number.isFinite(rangeDb) || rangeDb < 5) return 'barely changed';
  if (rangeDb < CONFIG.dynamics.minRangeDb) return 'changed only a little';
  if (rangeDb < 16) return 'changed clearly';
  return 'changed a lot';
}

/** How far the pitch moved with the loudness (the cents-per-loudness slope): "held still" ... "moved a lot". */
export function pitchWithLoudness(absSlope: number): string {
  const s = Math.abs(absSlope);
  if (!Number.isFinite(s)) return 'could not be measured';
  if (s < 0.5) return 'held still';
  if (s < CONFIG.dynamics.maxDriftCentsPerDb) return 'moved a little';
  if (s < 2) return 'moved';
  return 'moved a lot';
}

/** How steady a held pitch was (its spread): "very steady" ... "very wavery". */
export function steadiness(sdCents: number): string {
  if (!Number.isFinite(sdCents)) return 'could not be measured';
  if (sdCents < 8) return 'very steady';
  if (sdCents < 15) return 'steady';
  if (sdCents < 25) return 'a little wavery';
  if (sdCents < 40) return 'wavery';
  return 'very wavery';
}

/** How much a held pitch drifted, per second of holding: "held level" ... "drifted a lot". */
export function driftRate(absCentsPerSec: number): string {
  if (!Number.isFinite(absCentsPerSec)) return 'could not be measured';
  if (absCentsPerSec < 1.5) return 'held level';
  if (absCentsPerSec < 3) return 'drifted a little';
  if (absCentsPerSec < 6) return 'drifted';
  return 'drifted a lot';
}

/** Where in something a moment falls, 0..1: "near the start", "about half way", "near the end". */
export function whereIn(fraction: number): string {
  const f = Number.isFinite(fraction) ? Math.max(0, Math.min(1, fraction)) : 0.5;
  if (f < 0.15) return 'near the start';
  if (f < 0.35) return 'about a quarter of the way in';
  if (f < 0.65) return 'about half way';
  if (f < 0.85) return 'about three quarters of the way';
  return 'near the end';
}

/** A span of notes: "9 half steps", "an octave", "an octave and 2 half steps", "two octaves". */
export function spanWords(halfSteps: number): string {
  const n = Math.max(0, Math.round(halfSteps));
  if (n === 0) return 'no distance';
  if (n === 12) return 'an octave';
  if (n === 24) return 'two octaves';
  if (n < 12) return count(n, 'half step');
  if (n < 24) return `an octave and ${count(n - 12, 'half step')}`;
  return `two octaves and ${count(n - 24, 'half step')}`;
}

/** "note 3 (G3)": a target by its place in the take (1-based) and its name. */
export function noteRef(index: number, midi: number, notation: Notation): string {
  return `note ${index + 1} (${noteName(midi, notation)})`;
}

/** "G3" for a (possibly fractional) MIDI pitch. */
export function nameOf(midi: number, notation: Notation): string {
  return noteName(midi, notation);
}

/** Capitalise the first letter: a phrase that starts a sentence. */
export function sentence(text: string): string {
  return text.length > 0 ? text[0].toUpperCase() + text.slice(1) : text;
}
