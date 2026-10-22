/**
 * Does a Song from this module work with the real phrase scorer (analysis/phrases.ts)? Synthesised
 * takes of every bundled chart: sung perfectly, an octave low (scoring is octave-agnostic by default),
 * in the wrong key, and late. A cross-module check of the time semantics: note times are take times.
 */
import { describe, expect, it } from 'vitest';
import { makeTrack, notesMidi } from '../analysis/fixtures';
import { scoreSongPhrases } from '../analysis/phrases';
import { pitchedView } from './pitched';
import { parseUltraStar } from './ultrastar';
import { songDurationSec } from './timing';
import type { Song } from './types';

const charts = import.meta.glob('../../public/songs/*.txt', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;
const songs: Song[] = Object.entries(charts).map(([path, text]) => parseUltraStar(text, { id: path.split('/').pop()!.replace('.txt', ''), source: 'bundled' }).song);

const CTX = { toleranceCents: 25, vibratoStyle: 'pop' as const };

/** A take that sings `song` shifted by `semis` and delayed by `delaySec`. */
function take(song: Song, semis: number, delaySec: number) {
  const targets = song.notes.map((n) => ({ midi: n.midi + semis, start: n.start + delaySec, end: n.start + n.duration + delaySec }));
  return makeTrack({ duration: songDurationSec(song) + delaySec + 0.5, midi: notesMidi(targets) });
}

const mean = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;

describe('phrase scoring over the bundled charts', () => {
  for (const song of songs) {
    describe(song.id, () => {
      const view = pitchedView(song);

      it('scores a perfect take highly in every phrase', () => {
        const scores = scoreSongPhrases(take(song, 0, 0), view.notes, view.phrases, CTX);
        expect(scores).toHaveLength(song.phrases.length);
        for (const s of scores) {
          expect(s.pitchScore).toBeGreaterThan(0.85);
          expect(s.inTolerancePct).toBeGreaterThan(85);
          expect(Math.abs(s.timingOffsetMs ?? 0)).toBeLessThan(60);
        }
      });

      it('accepts the same song sung an octave lower (octave-agnostic by default)', () => {
        const scores = scoreSongPhrases(take(song, -12, 0), view.notes, view.phrases, CTX);
        expect(mean(scores.map((s) => s.pitchScore))).toBeGreaterThan(0.85);
      });

      it('does not give credit for the wrong key', () => {
        const right = scoreSongPhrases(take(song, 0, 0), view.notes, view.phrases, CTX);
        const wrong = scoreSongPhrases(take(song, 3, 0), view.notes, view.phrases, CTX);
        expect(mean(wrong.map((s) => s.pitchScore))).toBeLessThan(mean(right.map((s) => s.pitchScore)) - 0.3);
      });

      it('sees a late take as late', () => {
        const scores = scoreSongPhrases(take(song, 0, 0.15), view.notes, view.phrases, CTX);
        const offsets = scores.map((s) => s.timingOffsetMs).filter((x): x is number => x !== null);
        expect(mean(offsets)).toBeGreaterThan(100);
        expect(mean(offsets)).toBeLessThan(200);
      });
    });
  }
});
