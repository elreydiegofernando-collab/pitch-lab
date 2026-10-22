/**
 * Octave-agnostic song scoring over the bundled charts, combined with ordinary lateness (TA-02 of the Wave 1 review).
 *
 * SPEC 10 / RESEARCH 7: "a man's melody an octave up or down is not an error". The scorer folds each sung pitch to the octave nearest its
 * target in the alignment cost AND in the scores. src/song/scoring.integration.test.ts tests an octave-low take only on time and a late take
 * only in key; nothing combined them, so the alignment could stop folding (the DTW then sees every note an octave away, falls back on its timing
 * penalty alone, misscores the pitch AND hides the singer's lateness) with the whole suite green. A take an octave off AND 120 ms late is what a
 * real baritone with a little output latency sings, so that is what is pinned here, on every bundled chart.
 */
import { describe, expect, it } from 'vitest';
import { makeTrack, notesMidi } from './fixtures';
import { scoreSongPhrases } from './phrases';
import { pitchedView } from '../song/pitched';
import { parseUltraStar } from '../song/ultrastar';
import { songDurationSec } from '../song/timing';
import type { Song } from '../song/types';

const charts = import.meta.glob('../../public/songs/*.txt', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;
const songs: Song[] = Object.entries(charts).map(([path, text]) => parseUltraStar(text, { id: path.split('/').pop()!.replace('.txt', ''), source: 'bundled' }).song);

const CTX = { toleranceCents: 25, vibratoStyle: 'pop' as const };

/** A take that sings `song` shifted by `semis` and delayed by `delaySec`. */
function take(song: Song, semis: number, delaySec: number) {
  const targets = song.notes.map((n) => ({ midi: n.midi + semis, start: n.start + delaySec, end: n.start + n.duration + delaySec }));
  return makeTrack({ duration: songDurationSec(song) + delaySec + 0.5, midi: notesMidi(targets) });
}

const mean = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;
const median = (xs: number[]): number => {
  const s = xs.slice().sort((a, b) => a - b);
  return s.length % 2 === 1 ? s[s.length >> 1] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

describe('the bundled charts', () => {
  it('there are charts to test', () => {
    expect(songs.length).toBeGreaterThanOrEqual(1);
  });

  for (const song of songs) {
    describe(song.id, () => {
      const view = pitchedView(song);

      for (const semis of [-12, 12]) {
        it(`sung an octave ${semis < 0 ? 'low' : 'high'} and 120 ms late: the pitch is right and the median timing offset is the 120 ms`, () => {
          const scores = scoreSongPhrases(take(song, semis, 0.12), view.notes, view.phrases, CTX);
          expect(scores).toHaveLength(song.phrases.length);
          expect(mean(scores.map((s) => s.pitchScore))).toBeGreaterThanOrEqual(0.94);
          expect(mean(scores.map((s) => s.inTolerancePct))).toBeGreaterThan(90);
          const offsets = scores.map((s) => s.timingOffsetMs).filter((x): x is number => x !== null);
          expect(offsets.length).toBeGreaterThan(0);
          // 120 ms of lateness plus the frame quantisation: if the alignment stopped folding, this reads ~5 ms (the lateness is hidden)
          expect(median(offsets)).toBeGreaterThanOrEqual(100);
          expect(median(offsets)).toBeLessThanOrEqual(160);
        });
      }

      it('sung in the right octave and on time, the same take is right in pitch and on the beat', () => {
        const scores = scoreSongPhrases(take(song, 0, 0), view.notes, view.phrases, CTX);
        expect(mean(scores.map((s) => s.pitchScore))).toBeGreaterThanOrEqual(0.97);
        const offsets = scores.map((s) => s.timingOffsetMs).filter((x): x is number => x !== null);
        expect(Math.abs(median(offsets))).toBeLessThan(60);
      });
    });
  }
});
