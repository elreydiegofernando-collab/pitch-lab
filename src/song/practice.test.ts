/**
 * Learning a song from the log: the suggested path (listen, each phrase slowly then at full speed, pairs joined, the
 * whole song), each phrase's best, last and takes, what counts as learned, and the takes for "then and now".
 */
import { describe, expect, it } from 'vitest';
import { normalizeAttemptFields } from '../storage/attempts-repo';
import type { AttemptRecord } from '../storage/schema';
import { SONG_PASS_SCORE, nextStepAfter, pitchedPhraseTexts, songPractice, songTakes, type PitchedSpan } from './practice';
import { parseUltraStar } from './ultrastar';
import type { Song } from './types';

/** Three phrases at 120 bpm, with a spoken line between the first two (not scored, so not on the path). */
const CHART = `#TITLE:Three Lines
#ARTIST:Nobody
#BPM:120
#GAP:0
: 0 4 0  O
: 4 4 2  ho
: 8 4 4 ly
: 12 8 5  night
- 22
F 24 4 0  (spoken)
- 30
: 32 4 7  The
: 36 4 5  stars
: 40 8 4  shine
- 50
: 52 4 2  It
: 56 4 4  is
: 60 8 0  bright
E
`;

const SONG: Song = parseUltraStar(CHART, { id: 'three-lines', source: 'bundled' }).song;
let seq = 0;

function take(phrase: PitchedSpan | null, score: number, extra: Partial<AttemptRecord> = {}): AttemptRecord {
  seq += 1;
  const at = new Date(Date.parse('2026-10-22T12:00:00Z') + seq * 60_000).toISOString();
  return {
    id: `a${seq}`,
    profileId: 'p1',
    createdAt: at,
    updatedAt: at,
    deletedAt: null,
    exerciseId: `song.${SONG.id}`,
    levelId: null,
    kind: 'song',
    score,
    passed: score >= SONG_PASS_SCORE,
    mastery: 0,
    metrics: { 'song.phraseScore': score },
    durationSec: 5,
    tonicMidi: 60,
    tempoBpm: null,
    takeId: null,
    songId: SONG.id,
    phrase,
    songShift: 0,
    songSpeed: 1,
    ...extra,
  };
}

const one = (i: number): PitchedSpan => ({ from: i, to: i + 1 });
const slow = { songSpeed: 0.75 };

describe('the learning path', () => {
  it('lists the steps in order: listen, each phrase slowly then at full speed, pairs joined, the whole song', () => {
    const p = songPractice(SONG, []);
    expect(p.steps.map((s) => `${s.kind}:${s.phrase ? `${s.phrase.from}-${s.phrase.to}` : '*'}@${s.speed}`)).toEqual([
      'listen:*@1',
      'phrase-slow:0-1@0.75',
      'phrase:0-1@1',
      'phrase-slow:1-2@0.75',
      'phrase:1-2@1',
      'phrase-slow:2-3@0.75',
      'phrase:2-3@1',
      'join:0-2@1',
      'join:1-3@1',
      'whole:*@1',
    ]);
    expect(p.steps[1].title).toBe('Phrase 1, slowly: “O holy night”');
    expect(p.steps[4].title).toBe('Phrase 2: “The stars shine”');
    expect(p.steps[7].title).toBe('Phrases 1 and 2 together');
    expect(p.current).toBe(0);
    expect(p.steps.map((s) => s.status)).toEqual(['current', ...Array(9).fill('next')]);
    expect(p.phrases.map((ph) => ph.text)).toEqual(['O holy night', 'The stars shine', 'It is bright']);
    expect(p).toMatchObject({ whole: { best: null, last: null, takes: 0 }, firstAttemptId: null, bestWholeAttemptId: null });
  });

  it('moves on as the log shows each step done: a slowed pass, then the phrase learned at full speed', () => {
    const missSlow = take(one(0), 0.55, slow);
    expect(songPractice(SONG, [missSlow]).current).toBe(1); // listened (a take exists); the slow step is not passed yet
    const passSlow = take(one(0), 0.8, slow);
    expect(songPractice(SONG, [missSlow, passSlow]).current).toBe(2); // phrase 1 at full speed
    const learned = take(one(0), 0.74);
    const p = songPractice(SONG, [missSlow, passSlow, learned]);
    expect(p.current).toBe(3);
    expect(p.steps.slice(0, 4).map((s) => s.status)).toEqual(['done', 'done', 'done', 'current']);
    expect(p.phrases[0]).toEqual({ index: 0, text: 'O holy night', best: 0.74, last: 0.74, takes: 3, learned: true });
  });

  it('a phrase learned at full speed needs no slow pass, and a later phrase done early stays done', () => {
    const p = songPractice(SONG, [take(one(0), 0.9), take(one(2), 0.85)]);
    expect(p.current).toBe(3); // phrase 2, slowly
    expect(p.steps[5].status).toBe('done'); // phrase 3 slowly: learned anyway
    expect(p.steps[6].status).toBe('done');
    expect(p.steps[4].status).toBe('next');
  });

  it('joins are done by a passed full-speed take covering both phrases', () => {
    const log = [take(one(0), 0.9), take(one(1), 0.9), take(one(2), 0.9), take({ from: 0, to: 2 }, 0.65), take({ from: 0, to: 3 }, 0.8)];
    const p = songPractice(SONG, log);
    expect(p.steps[7].status).toBe('done');
    expect(p.steps[8].status).toBe('done');
    expect(p.current).toBe(9); // the whole song
    expect(p.steps[9]).toMatchObject({ kind: 'whole', status: 'current' });
  });

  it('the whole song learned at full speed finishes the path, and a slowed whole take does not', () => {
    const slowWhole = take(null, 0.95, slow);
    expect(songPractice(SONG, [slowWhole]).current).toBe(1);
    const p = songPractice(SONG, [slowWhole, take(null, 0.72)]);
    expect(p.current).toBe(p.steps.length);
    expect(p.steps.every((s) => s.status === 'done')).toBe(true);
  });
});

describe('the step after a pass', () => {
  const kindOf = (s: ReturnType<typeof nextStepAfter>): string => (s ? `${s.kind}:${s.phrase ? `${s.phrase.from}-${s.phrase.to}` : '*'}` : 'none');

  it('goes from a slowed pass to full speed, then on to the next phrase, then joins them', () => {
    const slowPass = take(one(0), 0.8, slow);
    expect(kindOf(nextStepAfter(songPractice(SONG, [slowPass]), one(0), 0.75))).toBe('phrase:0-1');
    const fullPass = take(one(0), 0.8);
    expect(kindOf(nextStepAfter(songPractice(SONG, [slowPass, fullPass]), one(0), 1))).toBe('phrase-slow:1-2');
    const log = [slowPass, fullPass, take(one(1), 0.9)];
    expect(kindOf(nextStepAfter(songPractice(SONG, log), one(1), 1))).toBe('phrase-slow:2-3');
    // With the phrase after it learned already, the two are joined next.
    const ahead = [take(one(2), 0.9), take(one(1), 0.9)];
    expect(kindOf(nextStepAfter(songPractice(SONG, ahead), one(1), 1))).toBe('join:1-3');
  });

  it('after a joined pass follows the path, and after the whole song at full speed there is nothing left', () => {
    const log = [take(one(0), 0.9), take(one(1), 0.9), take(one(2), 0.9), take({ from: 0, to: 2 }, 0.9)];
    expect(kindOf(nextStepAfter(songPractice(SONG, log), { from: 0, to: 2 }, 1))).toBe('join:1-3');
    const slowWhole = take(null, 0.9, slow);
    expect(kindOf(nextStepAfter(songPractice(SONG, [...log, slowWhole]), null, 0.75))).toBe('whole:*');
    const whole = take(null, 0.9);
    expect(nextStepAfter(songPractice(SONG, [...log, whole]), null, 1)).toBeNull();
  });
});

describe('progress from the log', () => {
  it('keeps best and last at full speed, counts every take of the phrase alone, and ignores joined takes for it', () => {
    const log = [take(one(1), 0.5), take(one(1), 0.9, slow), take(one(1), 0.66), take({ from: 1, to: 3 }, 0.95), take(one(1), 0.6)];
    const ph = songPractice(SONG, log).phrases[1];
    expect(ph).toEqual({ index: 1, text: 'The stars shine', best: 0.66, last: 0.6, takes: 4, learned: false });
  });

  it('reads the whole song apart from its phrases, and finds the first take and the best whole take', () => {
    const first = take(one(0), 0.4, slow);
    const w1 = take(null, 0.6);
    const w2 = take(null, 0.81);
    const w3 = take(null, 0.75);
    const fast = take(null, 0.99, { songSpeed: 0.5 });
    const p = songPractice(SONG, [first, w1, w2, w3, fast]);
    expect(p.whole).toEqual({ best: 0.81, last: 0.75, takes: 4 });
    expect(p.firstAttemptId).toBe(first.id);
    expect(p.bestWholeAttemptId).toBe(w2.id);
  });

  it('leaves out other songs, other kinds, deleted rows, takes from before phrases were recorded, and phrases the chart lacks', () => {
    const mine = take(one(0), 0.9);
    const log: AttemptRecord[] = [
      take(one(0), 0.9, { songId: 'another-song', exerciseId: 'song.another-song' }),
      take(one(0), 0.9, { deletedAt: '2026-10-22T13:00:00Z' }),
      take(one(0), 0.9, { songSpeed: undefined, phrase: undefined }), // an older take: what it covered is unknown
      take({ from: 2, to: 9 }, 0.9),
      { ...take(one(0), 0.9), kind: 'practice' },
      mine,
    ];
    expect(songTakes(SONG.id, log, 3).map((r) => r.attempt.id)).toEqual([mine.id]);
    expect(songPractice(SONG, log).phrases[0].takes).toBe(1);
    expect(songPractice(SONG, log).firstAttemptId).toBe(mine.id);
  });

  it('names each phrase by its words, skipping a spoken one', () => {
    expect(pitchedPhraseTexts(SONG)).toEqual(['O holy night', 'The stars shine', 'It is bright']);
    expect(SONG.phrases).toHaveLength(4);
  });

  it('a take whose phrases were dropped as damaged cannot say what it covered: never a whole-song take', () => {
    // A passed take of phrase 2 in a damaged or hand-edited backup: the import's sanitizer drops the bad phrase alone.
    const { id, createdAt, updatedAt, deletedAt, ...fields } = { ...take(one(1), 0.9), phrase: { from: 1, to: 1 } };
    const clean = normalizeAttemptFields(fields);
    expect('phrase' in clean).toBe(false);
    expect(clean.songSpeed).toBe(1);
    const row: AttemptRecord = { ...clean, id, createdAt, updatedAt, deletedAt };
    expect(songTakes(SONG.id, [row], 3)).toEqual([]);
    const p = songPractice(SONG, [row]);
    expect(p.current).toBe(0); // the path has not moved: nothing is learned, the whole song least of all
    expect(p.whole).toEqual({ best: null, last: null, takes: 0 });
    expect(p.phrases.map((ph) => ph.learned)).toEqual([false, false, false]);
    expect(p.bestWholeAttemptId).toBeNull();
    // Only an explicit null is the whole song.
    const whole = take(null, 0.9);
    expect(songTakes(SONG.id, [whole], 3).map((r) => r.phrase)).toEqual([null]);
    expect(songPractice(SONG, [whole]).bestWholeAttemptId).toBe(whole.id);
  });
});
