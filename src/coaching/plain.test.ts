/** The coach's plain words: every number a singer reads, without a unit (owner, 2026-10-22). */
import { describe, expect, it } from 'vitest';
import * as P from './plain';

describe('plain: times', () => {
  it('reads take time as minutes and seconds, from the downbeat', () => {
    expect(P.clock(0)).toBe('0:00');
    expect(P.clock(4.4)).toBe('0:04');
    expect(P.clock(4.6)).toBe('0:05');
    expect(P.clock(65)).toBe('1:05');
    expect(P.clock(-0.4)).toBe('0:00');
    expect(P.clock(Number.NaN)).toBe('0:00');
  });

  it('says a length of time in words', () => {
    expect(P.durationWords(0.04)).toBe('a split second');
    expect(P.durationWords(0.1)).toBe('about a tenth of a second');
    expect(P.durationWords(0.25)).toBe('about a quarter of a second');
    expect(P.durationWords(0.35)).toBe('about a third of a second');
    expect(P.durationWords(0.5)).toBe('about half a second');
    expect(P.durationWords(0.75)).toBe('about three quarters of a second');
    expect(P.durationWords(1.1)).toBe('about a second');
    expect(P.durationWords(1.5)).toBe('about one and a half seconds');
    expect(P.durationWords(3.2)).toBe('about 3 seconds');
    expect(P.durationWords(-0.5)).toBe('about half a second');
  });
});

describe('plain: pitch distances', () => {
  it('measures against the next note, never in units', () => {
    expect(P.pitchDistance(5)).toBe('a hair');
    expect(P.pitchDistance(12)).toBe('a little');
    expect(P.pitchDistance(25)).toBe('about a quarter of the way to the next note');
    expect(P.pitchDistance(35)).toBe('about a third of the way to the next note');
    expect(P.pitchDistance(50)).toBe('about half the way to the next note');
    expect(P.pitchDistance(70)).toBe('nearly a half step');
    expect(P.pitchDistance(100)).toBe('about a half step');
    expect(P.pitchDistance(150)).toBe('more than a half step');
    expect(P.pitchDistance(200)).toBe('about a whole step');
    expect(P.pitchDistance(310)).toBe('about 3 half steps');
    expect(P.pitchDistance(-25)).toBe('about a quarter of the way to the next note');
    expect(P.pitchDistance(1000)).toBe('about 10 half steps');
    expect(P.pitchDistance(1190)).toBe('about an octave');
    expect(P.pitchDistance(1500)).toBe('more than an octave');
  });

  it('says a note sung an octave away is an octave too high or low', () => {
    expect(P.offWords(-1200)).toBe('about an octave too low');
    expect(P.offWords(1150)).toBe('about an octave too high');
    expect(P.offWords(-1800)).toBe('more than an octave too low');
    expect(P.offWords(-900)).toBe('flat by about 9 half steps');
  });

  it('says sharp or flat with the distance', () => {
    expect(P.offWords(3)).toBe('right on the note');
    expect(P.offWords(-7)).toBe('a hair flat');
    expect(P.offWords(12)).toBe('a little sharp');
    expect(P.offWords(-25)).toBe('flat by about a quarter of the way to the next note');
    expect(P.offWords(90)).toBe('sharp by about a half step');
    expect(P.sharpOrFlat(-1)).toBe('flat');
    expect(P.sharpOrFlat(1)).toBe('sharp');
  });

  it('says how far a reading strays past a line', () => {
    expect(P.howFar(4, 5)).toBe('a little');
    expect(P.howFar(3, 5)).toBe('a lot');
    expect(P.howFar(130, 100)).toBe('a little');
    expect(P.howFar(140, 100)).toBe('a lot');
  });
});

describe('plain: rates and counts', () => {
  it('says vibrato speed as wobbles a second, to the nearest half', () => {
    expect(P.wobbles(5.8)).toBe('about six wobbles a second');
    expect(P.wobbles(4.4)).toBe('about four and a half wobbles a second');
    expect(P.wobbles(1)).toBe('about one wobble a second');
    expect(P.wobbles(0.4)).toBe('about half a wobble a second');
    expect(P.wobbles(0)).toBe('less than half a wobble a second');
    expect(P.perSecond(3.5, 'pulse')).toBe('about three and a half pulses a second');
    expect(P.wobbleZone()).toBe('five to seven wobbles a second');
  });

  it('counts in words', () => {
    expect(P.times(1)).toBe('once');
    expect(P.times(2)).toBe('twice');
    expect(P.times(5)).toBe('5 times');
    expect(P.numberWord(6)).toBe('six');
    expect(P.numberWord(14)).toBe('14');
    expect(P.halvesWord(4.5)).toBe('four and a half');
    expect(P.count(1, 'note')).toBe('1 note');
    expect(P.count(3, 'note')).toBe('3 notes');
    expect(P.ofThe(2, 3, 'note')).toBe('2 of the 3 notes');
    expect(P.ofThe(3, 3, 'note')).toBe('all 3 notes');
    expect(P.ofThe(1, 1, 'note')).toBe('the one note');
    expect(P.listWords(['3'])).toBe('3');
    expect(P.listWords(['3', '5'])).toBe('3 and 5');
    expect(P.listWords(['1', '3', '5'])).toBe('1, 3 and 5');
    expect(P.percentText(52.4)).toBe('52%');
    expect(P.shareText(0.666)).toBe('67%');
  });

  it('says which try it is in words up to ten, then with the right English ending (review R8)', () => {
    expect([1, 2, 3, 5, 10].map(P.ordinal)).toEqual(['first', 'second', 'third', 'fifth', 'tenth']);
    expect([11, 12, 13, 14, 20].map(P.ordinal)).toEqual(['11th', '12th', '13th', '14th', '20th']);
    expect([21, 22, 23, 24, 31, 42, 53].map(P.ordinal)).toEqual(['21st', '22nd', '23rd', '24th', '31st', '42nd', '53rd']);
    expect([101, 111, 112, 113, 121].map(P.ordinal)).toEqual(['101st', '111th', '112th', '113th', '121st']);
  });

  it('says loudness, steadiness and drift in words', () => {
    expect(P.loudnessChange(2)).toBe('barely changed');
    expect(P.loudnessChange(7)).toBe('changed only a little');
    expect(P.loudnessChange(12)).toBe('changed clearly');
    expect(P.loudnessChange(20)).toBe('changed a lot');
    expect(P.pitchWithLoudness(0.2)).toBe('held still');
    expect(P.pitchWithLoudness(0.8)).toBe('moved a little');
    expect(P.pitchWithLoudness(3)).toBe('moved a lot');
    expect(P.steadiness(5)).toBe('very steady');
    expect(P.steadiness(30)).toBe('wavery');
    expect(P.driftRate(1)).toBe('held level');
    expect(P.driftRate(7)).toBe('drifted a lot');
  });

  it('says where in something a moment falls, and how far apart two notes are', () => {
    expect(P.whereIn(0.05)).toBe('near the start');
    expect(P.whereIn(0.5)).toBe('about half way');
    expect(P.whereIn(0.95)).toBe('near the end');
    expect(P.spanWords(9)).toBe('9 half steps');
    expect(P.spanWords(1)).toBe('1 half step');
    expect(P.spanWords(12)).toBe('an octave');
    expect(P.spanWords(14)).toBe('an octave and 2 half steps');
    expect(P.spanWords(24)).toBe('two octaves');
  });

  it('names a note by its bar and its name, in the singer’s notation', () => {
    expect(P.noteRef(2, 55, 'sharps')).toBe('note 3 (G3)');
    expect(P.noteRef(0, 61, 'flats')).toBe('note 1 (D♭4)');
    expect(P.sentence('the slide up')).toBe('The slide up');
  });
});

describe('plain: no jargon', () => {
  it('finds the jargon a singer should never have to decode', () => {
    expect(P.jargonIn('You sat 12¢ sharp')).not.toHaveLength(0);
    expect(P.jargonIn('a 5.8 Hz vibrato')).not.toHaveLength(0);
    expect(P.jargonIn('a balanced onset')).not.toHaveLength(0);
    expect(P.jargonIn('it took 240 ms')).not.toHaveLength(0);
    expect(P.jargonIn('two semitones up')).not.toHaveLength(0);
    expect(P.jargonIn('Great job!')).not.toHaveLength(0);
    expect(P.jargonIn('You sang a little flat; note 3 (G3) was the furthest off.')).toHaveLength(0);
  });

  it('never puts jargon in any helper’s words', () => {
    const out: string[] = [];
    for (let c = -400; c <= 400; c += 7) out.push(P.pitchDistance(c), P.offWords(c));
    for (let s = 0; s <= 5; s += 0.05) out.push(P.durationWords(s));
    for (let r = 0; r <= 12; r += 0.25) out.push(P.wobbles(r), P.perSecond(r, 'pulse'));
    for (let d = 0; d <= 30; d += 0.5) out.push(P.loudnessChange(d), P.pitchWithLoudness(d / 10), P.steadiness(d * 2), P.driftRate(d / 3));
    for (let n = 0; n <= 30; n++) out.push(P.spanWords(n), P.times(n));
    for (const text of out) expect(P.jargonIn(text), text).toHaveLength(0);
  });
});
