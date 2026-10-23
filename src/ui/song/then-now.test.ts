/**
 * "Then and now": a saved song take read back against the song, in its own key and speed, its pitch line put on the
 * song's clock and its phrases scored again; and the table that stands in for the drawings.
 */
import { describe, expect, it, vi } from 'vitest';
import { makeTrack } from '../../analysis/fixtures';
import type { PitchFrame } from '../../core/types';
import { PHRASE_LEAD_SEC } from '../../runtime/song-session';
import { pitchedView } from '../../song/pitched';
import { parseUltraStar } from '../../song/ultrastar';
import type { AttemptRecord } from '../../storage/schema';
import { dayMonth, drawnMidi, songTakeView, takeLabel, thenNowTable } from './then-now';

// The session module's app singletons are never used here (only its pure helpers); mocking them keeps their side effects out.
vi.mock('../../audio/engine', () => ({ getEngine: () => undefined }));
vi.mock('../../state/audio', () => ({ getSynth: () => undefined }));
vi.mock('../../state/session', async () => {
  const { signal } = await import('@preact/signals');
  return { appStorage: signal(null), activeProfile: signal(null), attemptLog: signal([]), recordAttempt: async () => undefined };
});

const SONG = parseUltraStar(
  `#TITLE:Scale Song
#ARTIST:Nobody
#BPM:120
#GAP:0
: 0 4 0  do
: 4 4 2  re
: 8 4 4  mi
: 12 8 5  fa
- 22
: 24 4 7  sol
: 28 4 5  fa
: 32 4 4  mi
: 36 8 2  re
E
`,
  { id: 'scale', source: 'bundled' },
).song;

function attempt(extra: Partial<AttemptRecord>): AttemptRecord {
  return {
    id: 'a1',
    profileId: 'p1',
    createdAt: '2026-10-21T18:30:00.000Z',
    updatedAt: '1',
    deletedAt: null,
    exerciseId: 'song.scale',
    levelId: null,
    kind: 'song',
    score: 0.81,
    passed: true,
    mastery: 0,
    metrics: {},
    durationSec: 4,
    tonicMidi: 62,
    tempoBpm: null,
    takeId: 't1',
    songId: 'scale',
    phrase: { from: 1, to: 2 },
    songShift: 2,
    songSpeed: 0.75,
    ...extra,
  };
}

/** A singer in tune on the take's own timeline: take time tau is song time windowStart + tau x speed, the key `shift`. */
function sung(windowStart: number, speed: number, shift: number, seconds: number): PitchFrame[] {
  const notes = pitchedView(SONG).notes;
  return makeTrack({
    duration: seconds,
    midi: (tau) => {
      const s = windowStart + tau * speed;
      const n = notes.find((x) => s >= x.start && s < x.start + x.duration - 0.03);
      return n ? n.midi + shift : NaN;
    },
    jitterCents: 3,
    seed: 5,
  });
}

describe('songTakeView', () => {
  it('reads a slowed take in its own key: its window, its notes, its line on the song clock, and its phrase scored again', () => {
    const p2 = SONG.phrases[1];
    const windowStart = SONG.notes[p2.from].start - PHRASE_LEAD_SEC;
    const track = sung(windowStart, 0.75, 2, (p2.end + 0.5 - windowStart) / 0.75);
    const view = songTakeView(SONG, attempt({}), track)!;
    expect(view).toMatchObject({ label: 'Phrase 2, slowly', score: 0.81, phrase: { from: 1, to: 2 } });
    expect(view.start).toBeCloseTo(windowStart, 9);
    expect(view.notes.map((n) => n.midi)).toEqual([69, 67, 66, 64]); // G4 F4 E4 D4 up two half steps
    expect(view.track![0].t).toBeCloseTo(windowStart, 9);
    expect(view.track![view.track!.length - 1].t).toBeCloseTo(windowStart + track[track.length - 1].t * 0.75, 6);
    expect([...view.phraseScores.keys()]).toEqual([1]);
    expect(view.phraseScores.get(1)).toBeGreaterThan(0.85);
  });

  it('reads a whole-song take, and a take without its recording has no line and no phrase scores', () => {
    const whole = songTakeView(SONG, attempt({ phrase: null, songSpeed: 1, songShift: 0 }), null)!;
    expect(whole).toMatchObject({ label: 'Whole song', track: null });
    expect(whole.start).toBeCloseTo(-PHRASE_LEAD_SEC, 9);
    expect(whole.notes).toHaveLength(8);
    expect(whole.phraseScores.size).toBe(0);
  });

  it('cannot read another song’s take, or one that did not record its phrases', () => {
    expect(songTakeView(SONG, attempt({ songId: 'other' }), null)).toBeNull();
    expect(songTakeView(SONG, attempt({ songSpeed: undefined }), null)).toBeNull();
  });
});

describe('the words and the table', () => {
  it('labels a take by what it covered and how fast', () => {
    expect(takeLabel(null, 1)).toBe('Whole song');
    expect(takeLabel({ from: 0, to: 1 }, 0.75)).toBe('Phrase 1, slowly');
    expect(takeLabel({ from: 0, to: 2 }, 0.5)).toBe('Phrases 1 and 2, at half speed');
    expect(takeLabel({ from: 1, to: 4 }, 1)).toBe('Phrases 2 to 4');
    expect(dayMonth('2026-10-21T12:00:00')).toBe('21 Oct');
  });

  it('lists each phrase either take covered, then and now, and the takes’ own scores', () => {
    const then = { phraseScores: new Map([[0, 0.42]]), score: 0.42 } as never;
    const now = { phraseScores: new Map([[0, 0.9], [1, 0.7]]), score: 0.8 } as never;
    expect(thenNowTable(then, now, ['do re mi fa', 'sol fa mi re'])).toEqual({
      columns: ['Phrase', 'Then', 'Now'],
      rows: [
        ['1. do re mi fa', '42%', '90%'],
        ['2. sol fa mi re', '–', '70%'],
        ['The take as scored', '42%', '80%'],
      ],
    });
  });

  it('draws a line an octave away from the notes on them, as the scorer hears it', () => {
    const notes = pitchedView(SONG).notes;
    const f = { t: 0.1, midi: 72.1, f0Hz: 0, centsFromNearest: 0, confidence: 1, rmsDb: -20, voiced: true };
    expect(drawnMidi(f, notes)).toBeCloseTo(60.1, 9);
  });
});
