import { describe, expect, it } from 'vitest';
import { CONFIG } from '../config';
import type { PitchFrame } from '../core/types';
import { phraseIsScorable, scoreSongPhrases, scoreSongTake } from './phrases';
import { FRAME_RATE, makeTrack, withVibrato } from './fixtures';
import { framerStyleUnvoiced } from './advanced-test-helpers';
import { toTakeRelative } from './track';
import type { AnalyzeContext } from './types';
import type { SongNote, SongNoteType, SongPhrase } from '../song/types';

const CTX: AnalyzeContext = { toleranceCents: 25, vibratoStyle: 'pop' };

function note(midi: number, start: number, duration: number, type: SongNoteType = 'normal'): SongNote {
  return { midi, start, duration, lyric: '', type };
}

/** Phrase 0: four half-second notes (0-2 s). Phrase 1: three notes then a 1.5 s held note (2.5-6 s). */
const NOTES: SongNote[] = [
  note(60, 0.0, 0.5),
  note(62, 0.5, 0.5),
  note(64, 1.0, 0.5),
  note(62, 1.5, 0.5),
  note(64, 2.5, 0.5),
  note(65, 3.0, 0.5),
  note(67, 3.5, 0.5),
  note(67, 4.0, 2.0),
];
const PHRASES: SongPhrase[] = [
  { start: 0, end: 2.0, from: 0, to: 4 },
  { start: 2.5, end: 6.0, from: 4, to: 8 },
];

/** Pitch contour of the song as sung (silence between phrases), shifted by `semis`. */
function contour(notes: readonly SongNote[], semis = 0, shiftSec = 0): (t: number) => number {
  return (t) => {
    const tt = t - shiftSec;
    for (const n of notes) if (tt >= n.start && tt < n.start + n.duration) return n.midi + semis;
    return NaN;
  };
}

function sing(midi: (t: number) => number, duration = 6.2, jitter = 6, seed = 5): PitchFrame[] {
  return makeTrack({ duration, midi, jitterCents: jitter, seed });
}

describe('scoreSongPhrases: pitch', () => {
  it('scores an in-pitch, on-time rendition highly in every phrase', () => {
    const scores = scoreSongPhrases(sing(contour(NOTES)), NOTES, PHRASES, CTX);
    expect(scores).toHaveLength(2);
    for (const s of scores) {
      expect(s.pitchScore).toBeGreaterThan(0.9);
      expect(s.inTolerancePct).toBeGreaterThan(90);
      expect(Math.abs(s.timingOffsetMs as number)).toBeLessThan(25);
    }
  });

  it('copies the phrase span and index through', () => {
    const scores = scoreSongPhrases(sing(contour(NOTES)), NOTES, PHRASES, CTX);
    scores.forEach((s, i) => {
      expect(s.phraseIndex).toBe(i);
      expect(s.start).toBe(PHRASES[i].start);
      expect(s.end).toBe(PHRASES[i].end);
    });
  });

  it('scores an octave-down rendition fully when octave-agnostic, and poorly when not', () => {
    const track = sing(contour(NOTES, -12));
    for (const s of scoreSongPhrases(track, NOTES, PHRASES, CTX, { octaveAgnostic: true })) {
      expect(s.pitchScore).toBeGreaterThan(0.9);
      expect(s.inTolerancePct).toBeGreaterThan(90);
    }
    for (const s of scoreSongPhrases(track, NOTES, PHRASES, CTX, { octaveAgnostic: false })) {
      expect(s.pitchScore).toBeLessThan(0.1);
      expect(s.inTolerancePct).toBeLessThan(10);
    }
  });

  it('treats octave-agnostic scoring as the default (CONFIG.song.octaveAgnostic)', () => {
    const track = sing(contour(NOTES, 12));
    expect(scoreSongPhrases(track, NOTES, PHRASES, CTX)[0].pitchScore).toBeGreaterThan(0.9);
  });

  it('forgives a singer who changes octave part-way (a tenor taking the top note down)', () => {
    const mixed = (t: number): number => contour(NOTES)(t) - (t >= 3.5 ? 12 : 0);
    for (const s of scoreSongPhrases(sing(mixed), NOTES, PHRASES, CTX, { octaveAgnostic: true })) expect(s.pitchScore).toBeGreaterThan(0.9);
  });

  it('does not forgive a wrong note, octave or not', () => {
    const wrongNote = (t: number): number => contour(NOTES)(t) + (t >= 1.0 && t < 1.5 ? 3 : 0); // one note a minor third sharp
    const [p0] = scoreSongPhrases(sing(wrongNote), NOTES, PHRASES, CTX, { octaveAgnostic: true });
    expect(p0.pitchScore).toBeLessThan(0.85);
    expect(p0.pitchScore).toBeGreaterThan(0.5);
    expect(p0.inTolerancePct).toBeLessThan(85);
  });

  it('separates bias from stability: 40 c sharp throughout is out of tolerance but perfectly steady', () => {
    const [, p1] = scoreSongPhrases(sing(contour(NOTES, 0.4)), NOTES, PHRASES, CTX);
    expect(p1.inTolerancePct).toBeLessThan(10);
    expect(p1.pitchScore).toBeGreaterThan(0.2);
    expect(p1.pitchScore).toBeLessThan(0.6);
    expect(p1.stabilitySdCents as number).toBeLessThan(12);
  });

  it('judges the same take more kindly at the easy level', () => {
    const track = sing(contour(NOTES, 0.4));
    const easy = scoreSongPhrases(track, NOTES, PHRASES, { toleranceCents: 50, vibratoStyle: 'pop' })[0];
    const std = scoreSongPhrases(track, NOTES, PHRASES, CTX)[0];
    expect(easy.inTolerancePct).toBeGreaterThan(std.inTolerancePct + 50);
    expect(easy.pitchScore).toBeGreaterThan(std.pitchScore);
  });
});

describe('scoreSongPhrases: cannot be gamed', () => {
  it('a drone on one pitch does not score the melody', () => {
    const drone = (t: number): number => (t >= 0 && t < 6 ? 60 : NaN);
    for (const s of scoreSongPhrases(sing(drone), NOTES, PHRASES, CTX)) {
      expect(s.pitchScore).toBeLessThan(0.4);
      expect(s.inTolerancePct).toBeLessThan(40);
    }
  });

  it('a continuous slide through the whole range does not score the melody', () => {
    const sweep = (t: number): number => (t >= 0 && t < 6 ? 55 + 14 * (0.5 + 0.5 * Math.sin(t * 2.5)) : NaN);
    for (const s of scoreSongPhrases(sing(sweep), NOTES, PHRASES, CTX)) expect(s.pitchScore).toBeLessThan(0.4);
  });
});

describe('scoreSongPhrases: coverage', () => {
  it('scores silence zero and a half-sung phrase about half', () => {
    const silent = scoreSongPhrases(sing(() => NaN), NOTES, PHRASES, CTX);
    for (const s of silent) {
      expect(s.pitchScore).toBe(0);
      expect(s.inTolerancePct).toBe(0);
      expect(s.timingOffsetMs).toBeNull();
      expect(s.stabilitySdCents).toBeNull();
      expect(s.vibratoPresent).toBe(false);
    }
    const half = (t: number): number => (t < 1.0 ? contour(NOTES)(t) : NaN); // first two notes of phrase 0 only
    const [p0, p1] = scoreSongPhrases(sing(half), NOTES, PHRASES, CTX);
    expect(p0.pitchScore).toBeGreaterThan(0.4);
    expect(p0.pitchScore).toBeLessThan(0.6);
    expect(p1.pitchScore).toBe(0);
  });

  it('counts a note sung for only the start of its length as partly sung', () => {
    const clipped = (t: number): number => {
      const base = contour(NOTES)(t);
      for (const n of NOTES) if (t >= n.start && t < n.start + n.duration) return t - n.start < 0.2 ? base : NaN;
      return NaN;
    };
    const [p0] = scoreSongPhrases(sing(clipped), NOTES, PHRASES, CTX);
    expect(p0.pitchScore).toBeLessThan(0.6);
    expect(p0.pitchScore).toBeGreaterThan(0.2);
  });

  it('weights notes by duration: missing the long final note costs more than missing a short one', () => {
    const missShort = (t: number): number => (t >= 3.0 && t < 3.5 ? NaN : contour(NOTES)(t));
    const missLong = (t: number): number => (t >= 4.0 ? NaN : contour(NOTES)(t));
    const a = scoreSongPhrases(sing(missShort), NOTES, PHRASES, CTX)[1].pitchScore;
    const b = scoreSongPhrases(sing(missLong), NOTES, PHRASES, CTX)[1].pitchScore;
    expect(a).toBeGreaterThan(b + 0.2);
  });

  it('keeps phrases independent: a perfect first phrase and a silent second', () => {
    const [p0, p1] = scoreSongPhrases(sing((t) => (t < 2.2 ? contour(NOTES)(t) : NaN)), NOTES, PHRASES, CTX);
    expect(p0.pitchScore).toBeGreaterThan(0.9);
    expect(p1.pitchScore).toBe(0);
  });

  it('does not let one phrase take the first frames of the next when they run back to back', () => {
    const notes = [note(60, 0, 0.5), note(62, 0.5, 0.5), note(72, 1.0, 0.5), note(74, 1.5, 0.5)];
    const phrases: SongPhrase[] = [
      { start: 0, end: 1.0, from: 0, to: 2 },
      { start: 1.0, end: 2.0, from: 2, to: 4 },
    ];
    const scores = scoreSongPhrases(sing(contour(notes), 2.2), notes, phrases, CTX, { octaveAgnostic: false });
    for (const s of scores) {
      expect(s.pitchScore).toBeGreaterThan(0.9);
      expect(s.inTolerancePct).toBeGreaterThan(90);
    }
  });
});

describe('scoreSongPhrases: timing and latency', () => {
  it('reports how late the singer is, after the DTW', () => {
    for (const late of [0.06, 0.12]) {
      const [p0, p1] = scoreSongPhrases(sing(contour(NOTES, 0, late), 6.4), NOTES, PHRASES, CTX);
      expect(Math.abs((p0.timingOffsetMs as number) - late * 1000)).toBeLessThan(30);
      expect(Math.abs((p1.timingOffsetMs as number) - late * 1000)).toBeLessThan(30);
      expect(p0.pitchScore).toBeGreaterThan(0.85);
    }
  });

  it('reports a singer ahead of the beat as negative', () => {
    const [p0] = scoreSongPhrases(sing(contour(NOTES, 0, -0.08)), NOTES, PHRASES, CTX);
    expect(p0.timingOffsetMs as number).toBeLessThan(-40);
  });

  it('measures the singer, not the system: latency removed with toTakeRelative leaves ~0', () => {
    // Frames as the engine reports them: song starts at AudioContext time 10 s, the round trip is 140 ms.
    const latencyMs = 140;
    const songStartT = 10;
    const raw = sing(contour(NOTES, 0, latencyMs / 1000), 6.4).map((f) => ({ ...f, t: f.t + songStartT }));
    const compensated = toTakeRelative(raw, songStartT, latencyMs);
    const [c0, c1] = scoreSongPhrases(compensated, NOTES, PHRASES, CTX);
    expect(Math.abs(c0.timingOffsetMs as number)).toBeLessThan(25);
    expect(Math.abs(c1.timingOffsetMs as number)).toBeLessThan(25);
    // forgetting the compensation shows up as the full latency (the track is still scored: the corridor is wide)
    const [u0] = scoreSongPhrases(toTakeRelative(raw, songStartT, 0), NOTES, PHRASES, CTX);
    expect(Math.abs((u0.timingOffsetMs as number) - latencyMs)).toBeLessThan(30);
  });

  it('scoreSongTake does the compensation itself: raw engine frames in, the singer timing out', () => {
    const latencyMs = 140;
    const songStartT = 10;
    const raw = sing(contour(NOTES, 0, latencyMs / 1000 + 0.03), 6.5).map((f) => ({ ...f, t: f.t + songStartT })); // 140 ms system latency + the singer 30 ms late
    const [t0, t1] = scoreSongTake(raw, songStartT, latencyMs, NOTES, PHRASES, CTX);
    expect(Math.abs((t0.timingOffsetMs as number) - 30)).toBeLessThan(25);
    expect(Math.abs((t1.timingOffsetMs as number) - 30)).toBeLessThan(25);
    const manual = scoreSongPhrases(toTakeRelative(raw, songStartT, latencyMs), NOTES, PHRASES, CTX);
    expect(scoreSongTake(raw, songStartT, latencyMs, NOTES, PHRASES, CTX)).toEqual(manual);
    expect(t0.pitchScore).toBeGreaterThan(0.85);
  });

  it('pins the 200 ms corridor: a singer 150 ms late is measured as 150, one 300 ms late can only be measured as the corridor edge', () => {
    expect(CONFIG.song.dtwBandMs).toBe(200);
    const offset = (late: number) => scoreSongPhrases(sing(contour(NOTES, 0, late), 7), NOTES, PHRASES, CTX)[0].timingOffsetMs as number;
    expect(Math.abs(offset(0.15) - 150)).toBeLessThan(20);
    expect(Math.abs(offset(0.3) - CONFIG.song.dtwBandMs)).toBeLessThan(15);
  });

  it('does not let a note sung far outside the corridor count as sung', () => {
    // 0.6 s late is past the 200 ms corridor: only the first ~100 ms of each note still falls inside it.
    const wayLate = scoreSongPhrases(sing(contour(NOTES, 0, 0.6), 7), NOTES, PHRASES, CTX)[0];
    const onTime = scoreSongPhrases(sing(contour(NOTES)), NOTES, PHRASES, CTX)[0];
    expect(wayLate.pitchScore).toBeLessThan(0.45);
    expect(wayLate.pitchScore).toBeLessThan(onTime.pitchScore - 0.5);
  });
});

describe('scoreSongPhrases: stability and vibrato', () => {
  it('reports a small stability SD for a steady held note and a large one for a wobbly one', () => {
    const steady = scoreSongPhrases(sing(contour(NOTES)), NOTES, PHRASES, CTX)[1];
    expect(steady.stabilitySdCents as number).toBeLessThan(12);
    const wobble = (t: number): number => contour(NOTES)(t) + (t >= 4.0 ? 0.35 * Math.sin(2 * Math.PI * 2.2 * t) : 0);
    const wobbly = scoreSongPhrases(sing(wobble), NOTES, PHRASES, CTX)[1];
    expect(wobbly.stabilitySdCents as number).toBeGreaterThan(18);
  });

  it('has no stability figure for a phrase without a long note', () => {
    expect(scoreSongPhrases(sing(contour(NOTES)), NOTES, PHRASES, CTX)[0].stabilitySdCents).toBeNull();
  });

  it('finds vibrato on a held note, and none on a straight one', () => {
    const vib = withVibrato(contour(NOTES), 5.8, 40, 4.4);
    const [, withV] = scoreSongPhrases(sing(vib), NOTES, PHRASES, CTX);
    const [, straight] = scoreSongPhrases(sing(contour(NOTES)), NOTES, PHRASES, CTX);
    expect(withV.vibratoPresent).toBe(true);
    expect(straight.vibratoPresent).toBe(false);
  });

  it('does not look for vibrato on short notes', () => {
    const vib = withVibrato(contour(NOTES), 5.8, 40, 0);
    expect(scoreSongPhrases(sing(vib), NOTES, PHRASES, CTX)[0].vibratoPresent).toBe(false);
  });

  it('keeps vibrato out of the pitch score: a centred +/-40 c vibrato is still a good phrase', () => {
    const vib = withVibrato(contour(NOTES), 5.8, 40, 4.4);
    expect(scoreSongPhrases(sing(vib), NOTES, PHRASES, CTX)[1].pitchScore).toBeGreaterThan(0.6);
  });
});

describe('scoreSongPhrases: note types and edge cases', () => {
  const MIXED: SongNote[] = [note(60, 0, 0.5), note(60, 0.5, 0.5, 'rap'), note(62, 1.0, 0.5, 'golden'), note(62, 1.5, 0.5, 'freestyle')];
  const MIXED_PHRASE: SongPhrase[] = [{ start: 0, end: 2, from: 0, to: 4 }];

  it('skips rap and freestyle notes: not singing them costs nothing', () => {
    const onlyPitched = (t: number): number => contour([MIXED[0], MIXED[2]])(t);
    const [s] = scoreSongPhrases(sing(onlyPitched, 2.2), MIXED, MIXED_PHRASE, CTX);
    expect(s.pitchScore).toBeGreaterThan(0.9);
    expect(s.inTolerancePct).toBeGreaterThan(90);
  });

  it('counts golden notes as pitched', () => {
    const silentGolden = (t: number): number => (t >= 1.0 && t < 1.5 ? NaN : contour([MIXED[0]])(t));
    const [s] = scoreSongPhrases(sing(silentGolden, 2.2), MIXED, MIXED_PHRASE, CTX);
    expect(s.pitchScore).toBeLessThan(0.6);
  });

  it('returns zeros for a phrase that is all rap/freestyle, and says it is not scorable', () => {
    const rapOnly: SongNote[] = [note(60, 0, 0.5, 'rap'), note(60, 0.5, 0.5, 'freestyle')];
    const phrase: SongPhrase = { start: 0, end: 1, from: 0, to: 2 };
    expect(phraseIsScorable(rapOnly, phrase)).toBe(false);
    expect(phraseIsScorable(MIXED, MIXED_PHRASE[0])).toBe(true);
    const [s] = scoreSongPhrases(sing(contour(rapOnly), 1.2), rapOnly, [phrase], CTX);
    expect(s).toEqual({ phraseIndex: 0, start: 0, end: 1, pitchScore: 0, inTolerancePct: 0, timingOffsetMs: null, stabilitySdCents: null, vibratoPresent: false });
  });

  it('handles empty inputs and out-of-range phrase indices', () => {
    expect(scoreSongPhrases(sing(contour(NOTES)), NOTES, [], CTX)).toEqual([]);
    expect(scoreSongPhrases([], NOTES, PHRASES, CTX).map((s) => s.pitchScore)).toEqual([0, 0]);
    const odd = scoreSongPhrases(sing(contour(NOTES)), NOTES, [{ start: 0, end: 1, from: 6, to: 99 }, { start: 0, end: 1, from: 3, to: 3 }, { start: 0, end: 1, from: -4, to: 2 }], CTX);
    expect(odd).toHaveLength(3);
    expect(odd[1].pitchScore).toBe(0);
    expect(odd[2].pitchScore).toBeGreaterThan(0.8);
  });

  it('scores a single looped phrase from a take that covers only that phrase', () => {
    const loop = makeTrack({ duration: 2.2, midi: contour(NOTES.slice(4)), jitterCents: 6, t0: 2.5 }).map((f) => f);
    const only: SongPhrase[] = [PHRASES[1]];
    const [s] = scoreSongPhrases(loop, NOTES, only, CTX);
    expect(s.pitchScore).toBeGreaterThan(0.2); // the take stops at 4.7 s, before the long note ends
    expect(s.phraseIndex).toBe(0);
  });

  it('does not mutate its inputs', () => {
    const track = sing(contour(NOTES));
    const copy = track.map((f) => ({ ...f }));
    const notesCopy = NOTES.map((n) => ({ ...n }));
    scoreSongPhrases(track, NOTES, PHRASES, CTX);
    expect(track).toEqual(copy);
    expect(NOTES).toEqual(notesCopy);
  });

  it('scores a four-minute song (480 notes, 40 phrases) in well under a second', () => {
    const notes: SongNote[] = [];
    const phrases: SongPhrase[] = [];
    for (let p = 0; p < 40; p++) {
      const from = notes.length;
      for (let i = 0; i < 12; i++) notes.push(note(55 + ((p * 3 + i * 2) % 12), p * 6 + i * 0.4, 0.4));
      phrases.push({ start: p * 6, end: p * 6 + 4.8, from, to: notes.length });
    }
    const track = makeTrack({ duration: 242, midi: contour(notes), jitterCents: 8 });
    const t0 = performance.now();
    const scores = scoreSongPhrases(track, notes, phrases, CTX);
    const ms = performance.now() - t0;
    expect(scores).toHaveLength(40);
    for (const s of scores) expect(s.pitchScore).toBeGreaterThan(0.9);
    expect(ms).toBeLessThan(400);
  });
});

describe('scoreSongPhrases: octave-agnostic scoring folds the alignment cost too (TA-02)', () => {
  // Leaps of a fifth to an octave, so a singer an octave off is far from EVERY target note unless the DTW cost is folded as well as the scores.
  // Without the fold the alignment falls back on the timing penalty alone: it both misscores the pitch and hides the singer's lateness.
  const LEAPS: SongNote[] = [55, 67, 57, 69, 60, 72, 55, 64].map((m, i) => note(m, i * 0.5, 0.5));
  const LEAP_PHRASE: SongPhrase[] = [{ start: 0, end: 4, from: 0, to: 8 }];
  const take = (semis: number, late: number) => sing(contour(LEAPS, semis, late), 4.5, 3);

  for (const semis of [-12, 12]) {
    it(`sung an octave ${semis < 0 ? 'low' : 'high'} and 120 ms late, the pitch is right and the lateness is still reported`, () => {
      const [s] = scoreSongPhrases(take(semis, 0.12), LEAPS, LEAP_PHRASE, CTX);
      expect(s.pitchScore).toBeGreaterThan(0.9);
      expect(s.inTolerancePct).toBeGreaterThan(90);
      expect(s.timingOffsetMs as number).toBeGreaterThan(95);
      expect(s.timingOffsetMs as number).toBeLessThan(145);
    });
  }

  it('on pitch and on time it scores the same as before: nothing to fold', () => {
    const [s] = scoreSongPhrases(take(0, 0), LEAPS, LEAP_PHRASE, CTX);
    expect(s.pitchScore).toBeGreaterThan(0.97);
    expect(Math.abs(s.timingOffsetMs as number)).toBeLessThan(25);
  });

  it('with folding switched off, the same octave-low take is a different (worse) take', () => {
    const [s] = scoreSongPhrases(take(-12, 0.12), LEAPS, LEAP_PHRASE, CTX, { octaveAgnostic: false });
    expect(s.pitchScore).toBeLessThan(0.1);
  });
});

describe('scoreSongPhrases: the rules for what feeds stability and timing (TA-07)', () => {
  it('stability skips the note\'s onset: a 60 c scoop in the first 120 ms of a long note does not make it unsteady', () => {
    const long = [note(64, 0, 2.0)];
    const phrase: SongPhrase[] = [{ start: 0, end: 2, from: 0, to: 1 }];
    const scooped = (t: number): number => (t >= 0 && t < 2 ? 64 - (t < 0.12 ? 0.6 * (1 - t / 0.12) : 0) : NaN);
    const [s] = scoreSongPhrases(sing(scooped, 2.2, 2), long, phrase, CTX);
    expect(s.stabilitySdCents as number).toBeLessThan(5); // ~2 c of jitter; with the onset counted it is ~10
  });

  it('timing ignores a note sung on the wrong level: a tritone-wrong, 200 ms late note does not contaminate the singer\'s timing', () => {
    const two = [note(60, 0, 1.0), note(64, 1.0, 1.0)];
    const phrase: SongPhrase[] = [{ start: 0, end: 2, from: 0, to: 2 }];
    const wrongAndLate = (t: number): number => (t < 1.0 ? 60 : t >= 1.2 && t < 2.2 ? 70 : NaN);
    const [s] = scoreSongPhrases(sing(wrongAndLate, 2.4, 2), two, phrase, CTX, { octaveAgnostic: false });
    expect(Math.abs(s.timingOffsetMs as number)).toBeLessThan(20);
    // the control: the same lateness on the RIGHT note is the singer's timing, and is reported
    const rightAndLate = (t: number): number => (t < 1.0 ? 60 : t >= 1.2 && t < 2.2 ? 64 : NaN);
    const [r] = scoreSongPhrases(sing(rightAndLate, 2.4, 2), two, phrase, CTX, { octaveAgnostic: false });
    expect(r.timingOffsetMs as number).toBeGreaterThan(80);
  });

  it('timing ignores a note that got fewer than 3 voiced frames, and counts one that got 3', () => {
    const three = [note(60, 0, 0.5), note(62, 0.5, 0.5), note(64, 1.0, 0.5)];
    const phrase: SongPhrase[] = [{ start: 0, end: 1.5, from: 0, to: 3 }];
    const dtFrame = 1 / FRAME_RATE;
    /** Note 1 on time, note 2 sung `frames` frames long and 150 ms late, note 3 80 ms late. */
    const sparse = (frames: number) => (t: number): number => {
      if (t < 0.5) return 60;
      if (t >= 0.65 && t < 0.65 + frames * dtFrame - 0.001) return 62;
      if (t >= 1.08 && t < 1.5) return 64;
      return NaN;
    };
    const two = scoreSongPhrases(sing(sparse(2), 1.7, 1), three, phrase, CTX)[0];
    const three3 = scoreSongPhrases(sing(sparse(3), 1.7, 1), three, phrase, CTX)[0];
    // two frames: only notes 1 and 3 count (about 0 and 80 ms) -> median ~40; three frames: note 2's 150 ms counts too -> median ~85
    expect(two.timingOffsetMs as number).toBeGreaterThan(25);
    expect(two.timingOffsetMs as number).toBeLessThan(65);
    expect(three3.timingOffsetMs as number).toBeGreaterThan(70);
  });
});

describe('scoreSongPhrases: frames as the real Framer emits them (TA-13)', () => {
  // The Framer fills midi/f0 for every frame, voiced or not. Only `voiced` may decide what is scored.
  const gaps: Array<[number, number]> = [[0.45, 0.52], [1.46, 1.52], [3.4, 3.5], [4.8, 4.9]];
  const base = contour(NOTES);
  const nanTake = makeTrack({ duration: 6.2, midi: (t) => (gaps.some(([a, b]) => t >= a && t < b) ? NaN : base(t)), jitterCents: 6, seed: 5 });

  for (const seed of [1, 2, 3]) {
    it(`scores identically with NaN gaps and with finite random pitches in them (seed ${seed})`, () => {
      expect(nanTake.filter((f) => !f.voiced).length).toBeGreaterThanOrEqual(10);
      const finite = framerStyleUnvoiced(nanTake, seed);
      expect(scoreSongPhrases(finite, NOTES, PHRASES, CTX)).toEqual(scoreSongPhrases(nanTake, NOTES, PHRASES, CTX));
      expect(scoreSongPhrases(finite, NOTES, PHRASES, CTX, { octaveAgnostic: false })).toEqual(scoreSongPhrases(nanTake, NOTES, PHRASES, CTX, { octaveAgnostic: false }));
    });
  }
});
