import { describe, expect, it } from 'vitest';
import {
  bestTransposition,
  centsBetweenHz,
  centsFromNearest,
  centsOff,
  hzToMidi,
  isAccidental,
  midiToHz,
  noteName,
  octaveOf,
  parseNote,
} from './music';

describe('hz <-> midi', () => {
  it('maps reference points', () => {
    expect(hzToMidi(440)).toBeCloseTo(69, 10);
    expect(midiToHz(60)).toBeCloseTo(261.6256, 3);
    expect(hzToMidi(82.4069)).toBeCloseTo(40, 3); // E2
    expect(hzToMidi(1046.502)).toBeCloseTo(84, 3); // C6
  });
  it('round-trips', () => {
    for (let m = 30; m <= 96; m += 0.37) expect(hzToMidi(midiToHz(m))).toBeCloseTo(m, 9);
  });
  it('rejects invalid input', () => {
    expect(hzToMidi(0)).toBeNaN();
    expect(hzToMidi(-5)).toBeNaN();
    expect(hzToMidi(NaN)).toBeNaN();
    expect(hzToMidi(Infinity)).toBeNaN();
  });
});

describe('cents', () => {
  it('centsFromNearest stays in [-50, 50)', () => {
    expect(centsFromNearest(69)).toBeCloseTo(0, 10);
    expect(centsFromNearest(69.25)).toBeCloseTo(25, 10);
    expect(centsFromNearest(68.75)).toBeCloseTo(-25, 10);
    expect(centsFromNearest(69.5)).toBeCloseTo(-50, 10);
    expect(centsFromNearest(NaN)).toBeNaN();
  });
  it('centsOff is signed, positive = sharp', () => {
    expect(centsOff(69.1, 69)).toBeCloseTo(10, 10);
    expect(centsOff(68.8, 69)).toBeCloseTo(-20, 10);
  });
  it('centsBetweenHz', () => {
    expect(centsBetweenHz(880, 440)).toBeCloseTo(1200, 9);
    expect(centsBetweenHz(440 * Math.pow(2, 1 / 1200), 440)).toBeCloseTo(1, 9);
  });
});

describe('names', () => {
  it('formats with glyphs', () => {
    expect(noteName(60)).toBe('C4');
    expect(noteName(66)).toBe('F♯4');
    expect(noteName(66, 'flats')).toBe('G♭4');
    expect(noteName(40)).toBe('E2');
    expect(noteName(84)).toBe('C6');
    expect(noteName(59.6)).toBe('C4');
    expect(noteName(NaN)).toBe('–');
    expect(octaveOf(59)).toBe(3);
  });
  it('parses ASCII and Unicode', () => {
    expect(parseNote('C4')).toBe(60);
    expect(parseNote('F#3')).toBe(54);
    expect(parseNote('F♯3')).toBe(54);
    expect(parseNote('Bb2')).toBe(46);
    expect(parseNote('E♭5')).toBe(75);
    expect(parseNote('Cb4')).toBe(59);
    expect(parseNote('H2')).toBeNaN();
  });
  it('knows black keys', () => {
    expect(isAccidental(61)).toBe(true);
    expect(isAccidental(60)).toBe(false);
    expect(isAccidental(70)).toBe(true);
  });
});

describe('bestTransposition', () => {
  it('centres material in range', () => {
    // C4..G4 (60..67) into tenor C3..A4 (48..69): centre 58.5 vs 63.5 -> -5
    expect(bestTransposition([60, 62, 64, 65, 67], { low: 48, high: 69 })).toBe(-5);
  });
  it('keeps the top in range when material is wider than the range', () => {
    expect(bestTransposition([48, 76], { low: 50, high: 70 })).toBe(-6);
  });
  it('is 0 for empty input', () => {
    expect(bestTransposition([], { low: 48, high: 69 })).toBe(0);
  });
});
