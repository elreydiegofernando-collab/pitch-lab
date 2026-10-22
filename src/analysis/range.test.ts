import { describe, expect, it } from 'vitest';
import { CONFIG } from '../config';
import { analyzeRange } from './range';
import { makeTrack, notesMidi, sustained, withVibrato } from './fixtures';

const FR = 48000 / 512;

describe('analyzeRange', () => {
  it('finds the lowest and highest notes held for >= holdSec', () => {
    const hold = CONFIG.range.holdSec + 0.3; // clear of frame-quantization at the boundary
    const notes = [sustained(48, 0, hold), sustained(60, hold + 0.2, 2 * hold + 0.2), sustained(72, 2 * hold + 0.4, 3 * hold + 0.4)];
    const track = makeTrack({ duration: notes[2].end, midi: notesMidi(notes) });
    const r = analyzeRange(track);
    expect(r.lowestMidi).toBe(48);
    expect(r.highestMidi).toBe(72);
    expect(r.heldNotes.length).toBe(3);
    for (const n of r.heldNotes) expect(n.durationSec).toBeGreaterThanOrEqual(CONFIG.range.holdSec - 0.02);
  });

  it('reports each held note\'s start and duration', () => {
    const notes = [sustained(50, 0.5, 2.0), sustained(62, 3.0, 5.4)];
    const r = analyzeRange(makeTrack({ duration: 6, midi: notesMidi(notes) }));
    expect(r.heldNotes.map((n) => n.midi)).toEqual([50, 62]);
    expect(Math.abs(r.heldNotes[0].start - 0.5)).toBeLessThan(0.05);
    expect(Math.abs(r.heldNotes[0].durationSec - 1.5)).toBeLessThan(0.05);
    expect(Math.abs(r.heldNotes[1].start - 3.0)).toBeLessThan(0.05);
    expect(Math.abs(r.heldNotes[1].durationSec - 2.4)).toBeLessThan(0.05);
  });

  it('ignores a note held shorter than holdSec', () => {
    const shortHold = CONFIG.range.holdSec - 0.3;
    const notes = [sustained(50, 0, shortHold), sustained(65, shortHold + 0.2, shortHold + 0.2 + CONFIG.range.holdSec + 0.5)];
    const track = makeTrack({ duration: notes[1].end, midi: notesMidi(notes) });
    const r = analyzeRange(track);
    expect(r.heldNotes.some((n) => n.midi === 50)).toBe(false);
    expect(r.heldNotes.some((n) => n.midi === 65)).toBe(true);
    expect(r.lowestMidi).toBe(65);
    expect(r.highestMidi).toBe(65);
  });

  it('the hold threshold is holdSec: just over it counts, just under it does not', () => {
    const over = analyzeRange(makeTrack({ duration: 2.5, midi: notesMidi([sustained(55, 0.3, 0.3 + CONFIG.range.holdSec + 0.05)]) }));
    expect(over.heldNotes.map((n) => n.midi)).toEqual([55]);
    const under = analyzeRange(makeTrack({ duration: 2.5, midi: notesMidi([sustained(55, 0.3, 0.3 + CONFIG.range.holdSec - 0.1)]) }));
    expect(under.heldNotes).toEqual([]);
  });

  it('a siren that glides through many notes without holding any yields no held notes', () => {
    const track = makeTrack({ duration: 2, midi: (t) => 48 + 24 * t }); // continuous glide, 2 octaves over 2s
    const r = analyzeRange(track);
    expect(r.heldNotes).toEqual([]);
    expect(r.lowestMidi).toBeNull();
    expect(r.highestMidi).toBeNull();
  });

  it('a slow siren (a semitone per 0.8 s) holds nothing for a full second either', () => {
    const r = analyzeRange(makeTrack({ duration: 6, midi: (t) => 48 + t / 0.8 }));
    expect(r.heldNotes).toEqual([]);
  });

  it('an all-unvoiced track returns nulls, not a throw', () => {
    const track = makeTrack({ duration: 1, midi: () => NaN });
    const r = analyzeRange(track);
    expect(r.lowestMidi).toBeNull();
    expect(r.highestMidi).toBeNull();
    expect(r.heldNotes).toEqual([]);
    expect(analyzeRange([]).heldNotes).toEqual([]);
  });
});

describe('analyzeRange: real singing', () => {
  it('a note held with vibrato (+/-45 c, 5.8 Hz) is one hold, at the right semitone', () => {
    const r = analyzeRange(makeTrack({ duration: 3, midi: withVibrato(() => 64, 5.8, 45), jitterCents: 4, seed: 3 }));
    expect(r.heldNotes.length).toBe(1);
    expect(r.heldNotes[0].midi).toBe(64);
    expect(r.heldNotes[0].durationSec).toBeGreaterThan(2.9);
  });

  it('a note sung 40 cents sharp (between two semitones) is still one hold, labelled with the nearest note, not split by rounding flicker', () => {
    const r = analyzeRange(makeTrack({ duration: 3, midi: () => 60.42, jitterCents: 15, seed: 11 }));
    expect(r.heldNotes.length).toBe(1);
    expect(r.heldNotes[0].midi).toBe(60);
    expect(r.heldNotes[0].durationSec).toBeGreaterThan(2.9);
  });

  it('a sloppy hold (10 c RMS jitter) is still a hold', () => {
    const r = analyzeRange(makeTrack({ duration: 2, midi: () => 57, jitterCents: 10, seed: 5 }));
    expect(r.heldNotes.map((n) => n.midi)).toEqual([57]);
  });

  it('a step to the next semitone ends a hold: 0.7 s on C then 0.7 s on C-sharp is two short holds, neither long enough', () => {
    const r = analyzeRange(makeTrack({ duration: 1.4, midi: (t) => (t < 0.7 ? 60 : 61) }));
    expect(r.heldNotes).toEqual([]);
    // but a long hold on each is two holds
    const two = analyzeRange(makeTrack({ duration: 4, midi: (t) => (t < 2 ? 60 : 61) }));
    expect(two.heldNotes.map((n) => n.midi)).toEqual([60, 61]);
  });

  it('the note is the hold\'s median, not its first frame: a scooped start does not mislabel it', () => {
    const r = analyzeRange(makeTrack({ duration: 3, midi: (t) => 60 - 0.8 * Math.max(0, 1 - t / 0.15) }));
    expect(r.heldNotes.map((n) => n.midi)).toEqual([60]);
  });

  it('octave glitch frames and 1-3 frame dropouts inside a hold do not break it', () => {
    const base = makeTrack({ duration: 3, midi: () => 60, jitterCents: 4, seed: 7 });
    const messy = base.map((f, i) => (i % 70 === 35 ? { ...f, midi: f.midi + 12 } : i % 53 < 2 ? { ...f, voiced: false } : f));
    const r = analyzeRange(messy);
    expect(r.heldNotes.length).toBe(1);
    expect(r.heldNotes[0].midi).toBe(60);
  });

  it('a detector glitch of up to three frames (here +7 semitones) inside a hold does not split it; a longer departure does', () => {
    const at = Math.round(1.2 * FR);
    const glitch = analyzeRange(makeTrack({ duration: 3, midi: (t) => { const i = Math.round(t * FR); return i >= at && i < at + 3 ? 67 : 60; } }));
    expect(glitch.heldNotes.length).toBe(1);
    expect(glitch.heldNotes[0].durationSec).toBeGreaterThan(2.9);
    const bend = analyzeRange(makeTrack({ duration: 3, midi: (t) => { const i = Math.round(t * FR); return i >= at && i < at + 40 ? 62 : 60; } })); // a real 0.4 s bend away
    // the 0.4 s bend to 62 is too short to count; what is left is two valid holds of 60 (1.2 s before it, 1.4 s after)
    expect(bend.heldNotes.map((n) => n.midi)).toEqual([60, 60]);
    expect(bend.heldNotes[0].durationSec).toBeLessThan(1.4);
    expect(bend.heldNotes[1].durationSec).toBeLessThan(1.6);
  });

  it('a one-frame excursion outside the band does not end a hold, a sustained one does', () => {
    const one = analyzeRange(makeTrack({ duration: 3, midi: (t) => (Math.round(t * FR) === 140 ? 61.2 : 60) }));
    expect(one.heldNotes.length).toBe(1);
    const long = analyzeRange(makeTrack({ duration: 4, midi: (t) => (t < 2 ? 60 : 61.2) }));
    expect(long.heldNotes.length).toBe(2);
  });

  it('frames the detector marked voiced but with confidence below the gate do not count as a clean hold', () => {
    const r = analyzeRange(makeTrack({ duration: 3, midi: () => 60, confidence: CONFIG.audio.minConfidence - 0.1 }));
    expect(r.heldNotes).toEqual([]);
  });

  it('a range-finder take: siren down, hold low, rest, siren up, hold high gives exactly those two extremes', () => {
    const track = makeTrack({
      duration: 12,
      midi: (t) => {
        if (t < 3) return 60 - 9 * (t / 3) * 1.0; // 60 -> 51 siren
        if (t < 5.2) return 51; // hold low 2.2 s
        if (t < 6) return NaN;
        if (t < 9) return 60 + 11 * ((t - 6) / 3); // 60 -> 71 siren
        return 71; // hold high 3 s
      },
      jitterCents: 5,
      seed: 2,
    });
    const r = analyzeRange(track);
    expect(r.lowestMidi).toBe(51);
    expect(r.highestMidi).toBe(71);
    expect(r.heldNotes.length).toBe(2);
  });

  it('is deterministic and does not mutate the track', () => {
    const track = makeTrack({ duration: 3, midi: () => 60, jitterCents: 6, seed: 4 });
    const copy = track.map((f) => ({ ...f }));
    expect(analyzeRange(track)).toEqual(analyzeRange(track));
    expect(track).toEqual(copy);
  });
});

/**
 * Vibrato up to the top of the classical zone (CONFIG.vibrato.styles.classical.extentCents, +/-100 c) must not
 * cost a singer their range: foundations.range-finder.1 gates on the span of the held notes, so a trained voice
 * whose hold was cut by its own vibrato could not pass the first level. Every case below is one rate x one start
 * phase, because the cut used to depend on both (a hold survived or not depending on where in the cycle it began).
 */
describe('analyzeRange: wide vibrato', () => {
  const RATES = [5, 5.8, 6.5, 7];
  const PHASES = Array.from({ length: 8 }, (_, k) => (k * Math.PI) / 4);
  const cases = (extentCents: number, durationSec: number, midi = 64) =>
    RATES.flatMap((rate) =>
      PHASES.map((phase, k) => ({
        label: `+/-${extentCents} c at ${rate} Hz, phase ${k}`,
        track: makeTrack({ duration: durationSec, midi: withVibrato(() => midi, rate, extentCents, 0, phase), jitterCents: 4, seed: 3 + k }),
      })),
    );

  it.each([60, 80, 100])('a 3 s hold with +/-%i c vibrato is one hold, the whole 3 s, at the sung semitone, at every rate and phase', (extent) => {
    for (const { label, track } of cases(extent, 3)) {
      const r = analyzeRange(track);
      expect(r.heldNotes.length, label).toBe(1);
      expect(r.heldNotes[0].midi, label).toBe(64);
      expect(r.heldNotes[0].start, label).toBeLessThan(0.1);
      expect(r.heldNotes[0].durationSec, label).toBeGreaterThan(2.9);
      expect(r.lowestMidi, label).toBe(64);
    }
  });

  it('a hold only just over holdSec (1.2 s) is still found under +/-100 c vibrato, wherever in its cycle it began', () => {
    for (const { label, track } of cases(100, CONFIG.range.holdSec + 0.2)) {
      const r = analyzeRange(track);
      expect(r.heldNotes.map((n) => n.midi), label).toEqual([64]);
    }
  });

  it('vibrato does not blur a semitone step: two seconds of C then two of C-sharp, both with +/-80 c vibrato, are two holds', () => {
    for (const rate of RATES) {
      for (const [k, phase] of PHASES.entries()) {
        const track = makeTrack({
          duration: 4,
          midi: withVibrato((t) => (t < 2 ? 60 : 61), rate, 80, 0, phase),
          jitterCents: 4,
          seed: 20 + k,
        });
        const r = analyzeRange(track);
        const label = `${rate} Hz, phase ${k}`;
        expect(r.heldNotes.map((n) => n.midi), label).toEqual([60, 61]);
        expect(r.heldNotes[0].durationSec, label).toBeGreaterThan(1.8);
        expect(r.heldNotes[1].durationSec, label).toBeGreaterThan(1.8);
      }
    }
  });

  it('plateaus a semitone apart that each last 1.2 s are each a hold, with or without vibrato on them', () => {
    for (const extent of [0, 80]) {
      const track = makeTrack({ duration: 4.8, midi: withVibrato((t) => 50 + Math.floor(t / 1.2), 5.8, extent), jitterCents: 4, seed: 5 });
      const r = analyzeRange(track);
      expect(r.heldNotes.map((n) => n.midi), `+/-${extent} c`).toEqual([50, 51, 52, 53]);
    }
  });

  it('a slow wide wobble (+/-120 c at 3.5 Hz) on one note is still a held note', () => {
    const r = analyzeRange(makeTrack({ duration: 3, midi: withVibrato(() => 60, 3.5, 120), jitterCents: 4, seed: 2 }));
    expect(r.heldNotes.map((n) => n.midi)).toEqual([60]);
  });

  it('a slow siren is not a run of holds, however wide the vibrato on it: 50 c/s, 80 c/s and 125 c/s, with and without +/-80 c', () => {
    for (const centsPerSec of [50, 80, 125]) {
      for (const extent of [0, 80]) {
        const track = makeTrack({ duration: 6, midi: withVibrato((t) => 50 + (centsPerSec / 100) * t, 5.8, extent), jitterCents: 4, seed: 2 });
        const r = analyzeRange(track);
        expect(r.heldNotes, `${centsPerSec} c/s, +/-${extent} c`).toEqual([]);
      }
    }
  });

  it('but a note that merely sags (15 c/s over 4 s) is one held note', () => {
    const r = analyzeRange(makeTrack({ duration: 4, midi: (t) => 60 - (15 / 100) * t, jitterCents: 4, seed: 2 }));
    expect(r.heldNotes.map((n) => n.midi)).toEqual([60]);
    expect(r.heldNotes[0].durationSec).toBeGreaterThan(3.9);
  });

  it('a slow scoop up into the note (200 c over 0.5 s) does not lose the hold that follows it', () => {
    for (const hold of [1.2, 2]) {
      const track = makeTrack({ duration: 0.5 + hold, midi: (t) => 60 - 2 * Math.max(0, 1 - t / 0.5), jitterCents: 4, seed: 2 });
      const r = analyzeRange(track);
      expect(r.heldNotes.map((n) => n.midi), `${hold} s hold`).toEqual([60]);
      expect(r.heldNotes[0].durationSec, `${hold} s hold`).toBeGreaterThan(hold - 0.1);
    }
  });

  it('a note change within the first half second of a run still ends the first note: 0.3 s of C then 3 s of D leaves one hold, on D', () => {
    const r = analyzeRange(makeTrack({ duration: 3.3, midi: (t) => (t < 0.3 ? 60 : 62), jitterCents: 3, seed: 2 }));
    expect(r.heldNotes.map((n) => n.midi)).toEqual([62]);
    expect(r.heldNotes[0].durationSec).toBeGreaterThan(2.5);
  });

  it('frames without a usable pitch (voiced but NaN or infinite) are ignored rather than poisoning the centre line', () => {
    const base = makeTrack({ duration: 3, midi: () => 60, jitterCents: 4, seed: 2 });
    const r = analyzeRange(base.map((f, i) => (i % 40 === 17 ? { ...f, midi: NaN } : i % 40 === 18 ? { ...f, midi: Infinity } : f)));
    expect(r.heldNotes.map((n) => n.midi)).toEqual([60]);
  });

  it('does not depend on the frame rate: the same 3 s +/-80 c hold at 100 fps and at 50 fps is one hold', () => {
    for (const frameRate of [100, 50]) {
      const r = analyzeRange(makeTrack({ duration: 3, frameRate, midi: withVibrato(() => 64, 5.8, 80, 0, 1), jitterCents: 4, seed: 2 }));
      expect(r.heldNotes.map((n) => n.midi), `${frameRate} fps`).toEqual([64]);
      expect(r.heldNotes[0].durationSec, `${frameRate} fps`).toBeGreaterThan(2.9);
    }
  });
});
