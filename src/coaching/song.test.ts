/**
 * The song coach on synthetic takes scored by the real phrase scorer: the main problem located by syllable and time (a
 * flat syllable, a break on the high note, a phrase sung late), help that deepens with each miss in a row on the same
 * phrases only, "since last time" on those phrases, the moves, and the polish line after a pass.
 */
import { describe, expect, it } from 'vitest';
import { makeTrack } from '../analysis/fixtures';
import { scoreSongPhrases } from '../analysis/phrases';
import { metricsFromResults } from '../analysis/score';
import type { PitchFrame } from '../core/types';
import { SONG_PASS_SCORE, type PitchedSpan } from '../song/practice';
import { pitchedView } from '../song/pitched';
import type { Song } from '../song/types';
import { parseUltraStar } from '../song/ultrastar';
import type { AttemptRecord } from '../storage/schema';
import { ladderFor } from './content/index';
import { jargonIn } from './plain';
import { SONG_FALLBACK_TIPS, coachSongTake, nextStepLine, phraseMove, phraseOfMove, songMissesInARow, type SongTake } from './song';
import { SONG_TIP_IDS, type SongTipId } from './song-tips';
import { attemptOf, CHECKUP_MATCH_HOLD, CHECKUP_SIREN, checkupWithFocus } from './test-takes';

/** Two phrases at 60 bpm (a beat is a quarter second): "O holy night" with its top note on "night", then "The stars shine". */
const HOLY = `#TITLE:Holy Test
#ARTIST:Nobody
#BPM:60
#GAP:0
: 40 4 0  O
: 44 6 2  ho
: 50 2 4 ly
: 52 8 9  night!
- 64
: 64 4 7  The
: 68 4 5  stars
: 72 8 4  shine.
E
`;

/** One phrase that is mostly its high note: "O holy night", the "night" held three seconds on the top. */
const HIGH = `#TITLE:High Test
#ARTIST:Nobody
#BPM:60
#GAP:0
: 40 2 4  O
: 42 2 5  ho
: 44 2 7 ly
: 46 12 9  night
E
`;

/** One quick phrase of eight half-second notes: "a b c d e f g h" as words. */
const QUICK = `#TITLE:Quick Test
#ARTIST:Nobody
#BPM:120
#GAP:0
: 40 4 0  Glo
: 44 4 2 ry
: 48 4 4  to
: 52 4 5  the
: 56 4 7  new
: 60 4 5 born
: 64 4 4  king
: 68 4 2  now
E
`;

const chart = (text: string, id: string): Song => parseUltraStar(text, { id, source: 'bundled' }).song;

let seq = 0;
const T0 = Date.parse('2026-10-22T12:00:00Z');

function row(songId: string, phrase: PitchedSpan | null, score: number, extra: Partial<AttemptRecord> = {}): AttemptRecord {
  seq += 1;
  const at = new Date(T0 + seq * 60_000).toISOString();
  return {
    id: `att-${seq}`,
    profileId: 'p1',
    createdAt: at,
    updatedAt: at,
    deletedAt: null,
    exerciseId: `song.${songId}`,
    levelId: null,
    kind: 'song',
    score,
    passed: score >= SONG_PASS_SCORE,
    mastery: 0,
    metrics: { 'song.phraseScore': score, 'song.inTolerancePct': score * 90 },
    durationSec: 5,
    tonicMidi: 60,
    tempoBpm: null,
    takeId: null,
    songId,
    phrase,
    songShift: 0,
    songSpeed: 1,
    ...extra,
  };
}

interface Singing {
  /** Cents off per note index (into the pitched notes), + sharp. */
  cents?: Record<number, number>;
  /** Cents off every other note. */
  rest?: number;
  /** Sing everything this much later than written (seconds). */
  late?: number;
  /** Replace the sung pitch (MIDI, NaN for silence) at song time t. */
  edit?: (t: number, midi: number) => number;
}

/** A take of `phrases` (pitched indices) of `song`, sung on the song's own clock and scored as the session scores it. */
function sungTake(song: Song, phrases: PitchedSpan | null, how: Singing = {}, extra: Partial<AttemptRecord> = {}): SongTake {
  const view = pitchedView(song);
  const span = phrases ?? { from: 0, to: view.phrases.length };
  const judged = view.phrases.slice(span.from, span.to);
  const first = view.notes[judged[0].from];
  const lastPhrase = judged[judged.length - 1];
  const last = view.notes[lastPhrase.to - 1];
  const t0 = first.start - 1;
  const late = how.late ?? 0;
  const midiAt = (t: number): number => {
    const s = t - late;
    const k = view.notes.findIndex((n, i) => i >= judged[0].from && i < lastPhrase.to && s >= n.start && s < n.start + n.duration);
    if (k < 0) return NaN;
    const off = how.cents?.[k] ?? how.rest ?? 0;
    return view.notes[k].midi + off / 100;
  };
  const track: PitchFrame[] = makeTrack({
    duration: last.start + last.duration + 0.5 + late - t0,
    t0,
    midi: (t) => (how.edit ? how.edit(t, midiAt(t)) : midiAt(t)),
    jitterCents: 3,
    seed: 7,
  });
  const scores = scoreSongPhrases(track, view.notes, judged, { toleranceCents: 25, vibratoStyle: 'pop' }).map((s, k) => ({ ...s, phraseIndex: span.from + k }));
  const metrics = metricsFromResults({ phrases: scores });
  const score = metrics['song.phraseScore'] ?? 0;
  const attempt = row(song.id, phrases, score, { metrics, ...extra });
  return { song: { ...song, notes: view.notes, phrases: view.phrases }, phrase: phrases, shift: 0, speed: 1, track, scores, attempt };
}

const words = (t: SongTake, log: readonly AttemptRecord[] = [t.attempt]) => coachSongTake(t, log, { notation: 'sharps', now: Date.parse(t.attempt.createdAt) });

function expectPlain(text: string): void {
  expect(jargonIn(text), `"${text}" reads plainly`).toEqual([]);
  expect(text).not.toMatch(/\b(push|forc|strain)\w*/i);
}

describe('where a song take went wrong', () => {
  it('names a flat syllable by its words and time, and says how flat the phrase was overall', () => {
    const song = chart(HOLY, 'holy');
    const take = sungTake(song, { from: 0, to: 1 }, { cents: { 1: -45 }, rest: -12 });
    expect(take.attempt.passed).toBe(false);
    const c = words(take);
    expect(c.problem.tipId).toBe('song.flat');
    expect(c.problem.what).toBe(
      'On “ho-” in “O holy night” at 0:11 you were flat by about half the way to the next note; overall you sang flat by about a quarter of the way to the next note.',
    );
    expect(c.problem.spots[0]).toEqual({ t: 11, label: '0:11, “ho-”, flat by about half the way to the next note' });
    expect(c.problem.spots.length).toBeLessThanOrEqual(4);
    expectPlain(c.problem.what);
    for (const s of c.problem.spots) expectPlain(s.label);
  });

  it('names a break on the highest note', () => {
    const song = chart(HIGH, 'high');
    // The voice flips up into another gear on "night" for a second and a half, cuts out briefly, and comes back.
    const take = sungTake(song, { from: 0, to: 1 }, {
      edit: (t, midi) => (t >= 12.2 && t < 13.7 ? midi + 7 : t >= 13.7 && t < 13.82 ? NaN : midi),
    });
    expect(take.attempt.passed).toBe(false);
    const c = words(take);
    expect(c.problem.tipId).toBe('song.cracks');
    expect(c.problem.what).toBe('Your voice broke twice, most clearly on “night” in “O holy night” at 0:12, the highest note.');
    expect(c.problem.spots.map((s) => s.label)).toEqual(['0:12, “night”, voice broke on the highest note', '0:14, “night”, voice broke on the highest note']);
    expectPlain(c.problem.what);
  });

  it('never hears a quick breath between joined phrases, onto a new note, as a break', () => {
    // Two phrases back to back: "O ho" ends on D4 and, a fifth of a second later, "night" starts on G4.
    const song = chart(`#TITLE:Joined\n#ARTIST:N\n#BPM:60\n#GAP:0\n: 40 4 0  O\n: 44 8 2  ho\n- 52\n: 53 8 7  night\n: 61 4 5  now\nE\n`, 'joined');
    const take = sungTake(song, { from: 0, to: 2 }, { cents: { 3: -90 } });
    const c = words(take);
    expect(c.problem.tipId).not.toBe('song.cracks');
    expect(c.problem.spots.some((s) => s.label.includes('voice broke'))).toBe(false);
  });

  it('says when the words came in late', () => {
    const song = chart(QUICK, 'quick');
    const take = sungTake(song, { from: 0, to: 1 }, { late: 0.42 });
    expect(take.attempt.passed).toBe(false);
    const c = words(take);
    expect(c.problem.tipId).toBe('song.late');
    expect(c.problem.what).toMatch(/^You came in late on \d of the words, by about (a third of a second|half a second) as a rule; “.+” in “Glory to the newborn king now” at 0:\d\d was the latest\.$/);
    expect(c.problem.spots.every((s) => / late$/.test(s.label))).toBe(true);
    expectPlain(c.problem.what);
  });

  it('reads a slowed take on the song’s own clock, naming the same syllable at the same time', () => {
    const song = chart(HOLY, 'holy-slow');
    const view = pitchedView(song);
    const judged = [view.phrases[0]];
    const flatAt = (t: number): number => {
      const k = view.notes.findIndex((n, i) => i < judged[0].to && t >= n.start && t < n.start + n.duration);
      return k < 0 ? NaN : view.notes[k].midi + (k === 1 ? -45 : -12) / 100;
    };
    // Sung at 75%: on the song's clock the frames come closer together (the session maps a slowed take back).
    const track = makeTrack({ duration: 6, t0: 9, midi: flatAt, jitterCents: 3, seed: 7, frameRate: 93.75 / 0.75 });
    const scores = scoreSongPhrases(track, view.notes, judged, { toleranceCents: 25, vibratoStyle: 'pop' });
    const score = metricsFromResults({ phrases: scores })['song.phraseScore'] ?? 0;
    const attempt = row(song.id, { from: 0, to: 1 }, score, { songSpeed: 0.75 });
    const take: SongTake = { song: { ...song, notes: view.notes, phrases: view.phrases }, phrase: { from: 0, to: 1 }, shift: 0, speed: 0.75, track, scores, attempt };
    const c = words(take);
    expect(c.problem.tipId).toBe('song.flat');
    expect(c.problem.what).toMatch(/^On “ho-” in “O holy night” at 0:11 you were flat/);
  });

  it('a phrase sung well passes with the next step of the path, and no more help', () => {
    const song = chart(HOLY, 'holy-pass');
    const take = sungTake(song, { from: 0, to: 1 });
    expect(take.attempt.passed).toBe(true);
    const c = words(take);
    expect(c).toMatchObject({ passed: true, depth: 1, missesInARow: 0, why: null, steps: [], easier: null });
    expect(c.problem).toMatchObject({ tipId: 'song.polish', spots: [] });
    expect(c.problem.what).toMatch(/^That passed at \d+%\.$/);
    // Phrase 1 learned at full speed: the path goes on to phrase 2, slowly.
    expect(c.tip).toBe('Next, sing phrase 2 slowly.');
    expect(c.moves).toEqual([]);
  });

  it('hears nothing when nothing was sung', () => {
    const song = chart(HOLY, 'holy-silent');
    const take = sungTake(song, { from: 0, to: 1 }, { edit: () => NaN });
    const c = words(take);
    expect(c.problem.tipId).toBe('song.unsung');
    expect(c.problem.what).toBe('The app heard nothing it could follow during the phrase.');
  });
});

describe('help that deepens with misses in a row on the same phrases', () => {
  it('counts misses on exactly these phrases, and starts again after a pass', () => {
    const id = 'holy';
    const log = [row(id, { from: 0, to: 1 }, 0.4), row(id, { from: 0, to: 1 }, 0.9), row(id, { from: 0, to: 1 }, 0.5), row(id, { from: 1, to: 2 }, 0.3), row(id, { from: 0, to: 1 }, 0.6)];
    expect(songMissesInARow(id, { from: 0, to: 1 }, log)).toBe(2);
    expect(songMissesInARow(id, { from: 1, to: 2 }, log)).toBe(1);
    expect(songMissesInARow(id, { from: 0, to: 2 }, log)).toBe(0);
    expect(songMissesInARow(id, null, log)).toBe(0);
    expect(songMissesInARow('other', { from: 0, to: 1 }, log)).toBe(0);
  });

  it('goes one step deeper with each miss on the phrase, and back to the start on another phrase', () => {
    const song = chart(HOLY, 'holy-deep');
    const log: AttemptRecord[] = [];
    const depths: number[] = [];
    for (let i = 0; i < 4; i++) {
      const take = sungTake(song, { from: 0, to: 1 }, { cents: { 1: -45 }, rest: -12 });
      log.push(take.attempt);
      const c = words(take, log);
      depths.push(c.depth);
      if (i === 2) {
        expect(c.missesInARow).toBe(3);
        expect(c.moves.map((m) => m.kind)).toEqual(['listen-slow', 'send-to-claude']);
      }
    }
    expect(depths).toEqual([1, 2, 3, 4]);
    // The same singer misses phrase 2 next: that is a first miss there.
    const other = sungTake(song, { from: 1, to: 2 }, { rest: -60 });
    log.push(other.attempt);
    const c = words(other, log);
    expect(c.missesInARow).toBe(1);
    expect(c.depth).toBe(1);
  });

  it('compares with the last take of the same phrases, not another phrase', () => {
    const song = chart(HOLY, 'holy-since');
    const before = row(song.id, { from: 0, to: 1 }, 0.4, { metrics: { 'song.phraseScore': 0.4, 'song.inTolerancePct': 30 }, songSpeed: 0.75 });
    const between = row(song.id, { from: 1, to: 2 }, 0.95);
    const take = sungTake(song, { from: 0, to: 1 }, { cents: { 1: -45 }, rest: -12 });
    const c = words(take, [before, between, take.attempt]);
    expect(c.progress.map((l) => l.label)).toEqual(['Score', 'Time in tune', 'Speed']);
    expect(c.progress[0]).toMatchObject({ before: '40%', better: true });
    expect(c.progress[2]).toEqual({ label: 'Speed', before: 'slowed down', now: 'full speed', better: true });
    expect(words(take).progress).toEqual([]);
  });

  it('offers an earlier level from the second miss when it trains a focus of the latest voice check-up', () => {
    const song = chart(HOLY, 'holy-focus');
    const flat = () => sungTake(song, { from: 0, to: 1 }, { cents: { 1: -45 }, rest: -12 });
    const first = flat();
    const second = flat();
    expect(words(second, [first.attempt, second.attempt]).problem.tipId).toBe('song.flat');
    expect(ladderFor('song.flat')?.practiseLevelId).toBe('foundations.02'); // a flat lean builds on Match one note
    const pitchMatch = attemptOf(null, { exerciseId: 'foundations.match.1', levelId: 'foundations.02', passed: true });
    const levels = (log: AttemptRecord[]) => words(second, [...log, first.attempt, second.attempt]).moves.filter((m) => m.kind === 'practise-level');

    // The latest check-up found pitch to focus on: Match one note is offered at the second miss on the phrase.
    expect(levels([pitchMatch, ...checkupWithFocus(CHECKUP_MATCH_HOLD, 'c-pitch')])).toEqual([{ kind: 'practise-level', levelId: 'foundations.02', title: 'Match one note' }]);
    // Without that check-up (or with another focus), it waits for the fourth miss as before.
    expect(levels([pitchMatch])).toEqual([]);
    expect(levels([pitchMatch, ...checkupWithFocus(CHECKUP_SIREN, 'c-slides')])).toEqual([]);
  });

  it('offers the phrase alone from a take of the whole song, and rest after many misses', () => {
    const song = chart(HOLY, 'holy-whole');
    // Phrase 2 goes badly flat; phrase 1 is fine.
    const take = sungTake(song, null, { cents: { 4: -70, 5: -60, 6: -65 } });
    expect(take.attempt.passed).toBe(false);
    const c = words(take);
    const move = c.moves.find((m) => phraseOfMove(m) !== null);
    expect(move).toEqual(phraseMove(1));
    expect(phraseOfMove(move!)).toBe(1);
    expect(c.problem.spots[0].t).toBeGreaterThanOrEqual(16);

    const log: AttemptRecord[] = [];
    let last = c;
    for (let i = 0; i < 6; i++) {
      const t = sungTake(song, null, { cents: { 4: -70, 5: -60, 6: -65 } });
      log.push(t.attempt);
      last = words(t, log);
    }
    expect(last.moves.some((m) => m.kind === 'rest')).toBe(true);
  });
});

describe('the words', () => {
  it('uses the song ladder when it exists, else a plain one-line tip', () => {
    const song = chart(HOLY, 'holy-tip');
    const c = words(sungTake(song, { from: 0, to: 1 }, { cents: { 1: -45 }, rest: -12 }));
    const id = c.problem.tipId as SongTipId;
    expect(c.tip).toBe(ladderFor(id)?.tip ?? SONG_FALLBACK_TIPS[id]);
  });

  it('has a plain fallback tip for every song tip id', () => {
    expect(Object.keys(SONG_FALLBACK_TIPS).sort()).toEqual([...SONG_TIP_IDS].sort());
    for (const tip of Object.values(SONG_FALLBACK_TIPS)) {
      expectPlain(tip);
      expect(tip).not.toMatch(/\d/);
    }
  });

  it('says the next step of the path in plain words', () => {
    expect(nextStepLine({ kind: 'join', phrase: { from: 2, to: 4 }, speed: 1, title: '', status: 'current' })).toBe('Next, join phrases 3 and 4: sing them together.');
    expect(nextStepLine(null)).toBe('That is the whole song learned. Sing it through again any time to keep it.');
  });
});
