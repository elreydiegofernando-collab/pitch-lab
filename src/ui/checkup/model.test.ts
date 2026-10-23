/**
 * The check-up screens' shared model: every word a singer reads is plain, every focus skill names a real Foundations
 * level, the running session reads as the right screen state, and the log is read back through the engine without a
 * crash. The session, settings and check-up modules are doubles; the unlock registry, the catalog, the progress engine
 * and the router are the real ones.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../state/session', async () => (await import('./test-support')).sessionModule());
vi.mock('../../state/settings', async () => (await import('./test-support')).settingsDouble());
vi.mock('../../runtime/checkup', async () => (await import('./test-support')).checkupRuntimeModule());
vi.mock('../../checkup/summary', async () => (await import('./test-support')).summaryModule());

import { jargonIn } from '../../coaching/plain';
import { CHECKUP_SKILLS, SKILL_LEVELS, SKILL_NAMES } from '../../checkup/skills';
import { checkupsOf, compareCheckups, recheckDue } from '../../checkup/summary';
import { CHECKUP_TASKS } from '../../checkup/types';
import { getLevel } from '../../exercises';
import { installRouteGuard, resetRouterForTests, route, routeOf } from '../../router';
import { abandonCheckup, activeCheckup } from '../../runtime/checkup';
import { activeProfile, attemptLog } from '../../state/session';
import { settings } from '../../state/settings';
import { DEFAULT_SETTINGS } from '../../state/settings-types';
import type { VocalRange } from '../../storage/schema';
import { attemptAt, levelsInOrder, passWorld, snapshotOf } from '../progress/test-fixtures';
import {
  CARE_LINE,
  FOCUS_PRACTISE,
  PITCH_INTRO,
  PITCH_SHORT,
  RATING_WORD,
  anyMeasured,
  buildCheckups,
  checkupLine,
  checkups,
  daysSince,
  elapsedWords,
  focusLevelId,
  focusLine,
  isInProgress,
  isSkill,
  levelTitle,
  nextTaskIndex,
  openCheckup,
  orderedSkills,
  safeCompare,
  safeRecheckDue,
  skillLabel,
  sungCount,
  taskStates,
} from './model';
import { profileRecord, sessionOf, skill, summaryOf } from './test-support';

const NOW = Date.parse('2026-10-22T12:00:00.000Z');
const NOT_ADVICE = /\b(push|pushing|force|forcing|strain|straining)\b/i;
const RANGE: VocalRange = { comfortable: { low: 47, high: 69 }, extended: { low: 45, high: 72 }, measuredAt: '2026-10-21T09:00:00.000Z' };

describe('the words are plain', () => {
  const copy: Array<[string, string]> = [
    ['PITCH_INTRO', PITCH_INTRO],
    ['PITCH_SHORT', PITCH_SHORT],
    ['CARE_LINE', CARE_LINE],
    ...CHECKUP_SKILLS.flatMap((s): Array<[string, string]> => [
      [`label of ${s}`, SKILL_NAMES[s].label],
      [`words of ${s}`, SKILL_NAMES[s].words],
    ]),
    ...Object.entries(RATING_WORD).map(([k, v]): [string, string] => [`RATING_WORD.${k}`, v]),
    ...CHECKUP_SKILLS.map((s): [string, string] => [`FOCUS_PRACTISE.${s}`, FOCUS_PRACTISE[s]]),
    ...CHECKUP_TASKS.flatMap((t): Array<[string, string]> => [
      [`${t.exerciseId} title`, t.title],
      [`${t.exerciseId} ask`, t.ask],
    ]),
  ];

  it.each(copy)('%s has no jargon, no exclamation mark and no push, force or strain', (_name, text) => {
    expect(text.length).toBeGreaterThan(0);
    expect(jargonIn(text)).toEqual([]);
    expect(text).not.toMatch(NOT_ADVICE);
  });

  it('says the pitch in two plain sentences, and that nothing can lower progress', () => {
    expect(PITCH_INTRO).toBe(
      'About four minutes: five short tasks so Pitch Lab can find where to start you and what to focus on. Nothing here can lower your progress.',
    );
    expect(PITCH_INTRO.split('. ')).toHaveLength(2);
    expect(PITCH_SHORT).toContain('Nothing here can lower your progress.');
  });

  it('rates in words that are never a grade', () => {
    expect(RATING_WORD).toEqual({ solid: 'Solid', 'getting-there': 'Getting there', focus: 'Focus here', 'not-measured': 'Not measured' });
    for (const word of Object.values(RATING_WORD)) expect(word).not.toMatch(/fail|wrong|bad|poor|pass/i);
  });

  it('keeps stop-if-it-hurts in the voice-care line', () => {
    expect(CARE_LINE).toMatch(/stop if anything hurts/i);
  });
});

describe('what to focus on', () => {
  it('has something to practise for every skill, in words that name no level (the button beside it does)', () => {
    expect(Object.keys(FOCUS_PRACTISE).sort()).toEqual([...CHECKUP_SKILLS].sort());
    for (const s of CHECKUP_SKILLS) {
      expect(FOCUS_PRACTISE[s].length, s).toBeGreaterThan(30);
      expect(FOCUS_PRACTISE[s], s).not.toMatch(/\bSustain\b|\bCrispness\b|\bLegato lines\b|\bPitch match\b|\bSirens\b/);
    }
  });

  it('treats a crack as where a voice changes gears, never as a failure', () => {
    expect(FOCUS_PRACTISE.slides).toMatch(/changes gears/i);
    expect(FOCUS_PRACTISE.slides).not.toMatch(/fail|wrong|bad/i);
  });

  it('covers where a slide ends as well as its breaks: a slide can be rated for its landing alone', () => {
    expect(FOCUS_PRACTISE.slides).toMatch(/arrive right on its last note/);
  });

  it('knows the six skills, and no others', () => {
    expect(CHECKUP_SKILLS.every(isSkill)).toBe(true);
    expect(isSkill('vibrato')).toBe(false);
    expect(skillLabel('slides')).toBe('Slides');
    expect(skillLabel('vibrato')).toBe('vibrato');
  });

  it('names every skill as "Then and now" does: the engine\'s own label', () => {
    for (const s of CHECKUP_SKILLS) expect(skillLabel(s)).toBe(SKILL_NAMES[s].label);
  });

  describe('which level to offer', () => {
    /** The progress of a singer who has passed Foundations in order up to `lastLevelId` (nothing for null). */
    const through = (lastLevelId: string | null) => snapshotOf(lastLevelId === null ? [] : passWorld('foundations', lastLevelId));

    it('is a real Foundations level that trains the skill, for every skill and every place the singer can be', () => {
      const places = [null, ...levelsInOrder('foundations').filter((l) => l.kind !== 'boss').map((l) => l.id)];
      for (const place of places) {
        const snap = through(place);
        for (const s of CHECKUP_SKILLS) {
          const id = focusLevelId(s, snap);
          expect(SKILL_LEVELS[s], `${s} at ${place}`).toContain(id);
          expect(getLevel(id)?.worldId).toBe('foundations');
          expect(levelTitle(id)).toBe(getLevel(id)?.title);
        }
      }
    });

    it('is the level of the skill\'s family the singer is on now', () => {
      expect(focusLevelId('steadiness', through('foundations.02'))).toBe('foundations.03');
      expect(focusLevelId('steadiness', through('foundations.03'))).toBe('foundations.13'); // Hold it steady
      expect(focusLevelId('starts', through('foundations.13'))).toBe('foundations.10');
      expect(focusLevelId('starts', through('foundations.10'))).toBe('foundations.07');
      expect(focusLevelId('slides', through('foundations.09'))).toBe('foundations.12'); // Small slides
      expect(focusLevelId('slides', through('foundations.12'))).toBe('foundations.05'); // Sirens
    });

    it('is the first of the family when the singer is not on one of its levels (a passed level can be sung again, a closed one shows as locked)', () => {
      expect(focusLevelId('steadiness', through('foundations.10'))).toBe('foundations.03'); // both passed
      expect(focusLevelId('starts', through('foundations.03'))).toBe('foundations.10'); // not open yet
      expect(focusLevelId('pitch', through(null))).toBe('foundations.02'); // nothing sung yet
      expect(focusLevelId('range', through('foundations.03'))).toBe('foundations.01');
    });
  });

  it('reads a focus as a short line, in the engine\'s words', () => {
    expect(focusLine([])).toBe('Everything measured is solid');
    expect(focusLine(['slides'])).toBe('Focus: slides');
    expect(focusLine(['slides', 'starts'])).toBe('Focus: slides and note starts');
    expect(focusLine(['range', 'pitch', 'steadiness'])).toBe('Focus: range, pitch and steadiness');
    expect(focusLine(['connected'])).toBe('Focus: connected lines');
  });

  it('says how a check-up went in one line, and never calls nothing "solid"', () => {
    const measured = summaryOf('m', { focus: ['slides'] });
    expect(anyMeasured(measured)).toBe(true);
    expect(checkupLine(measured)).toBe('Focus: slides');
    expect(checkupLine(summaryOf('m', { focus: [] }))).toBe('Everything measured is solid');
    const silent = summaryOf('s', { focus: [], skills: CHECKUP_SKILLS.map((s) => skill(s, 'not-measured')) });
    expect(anyMeasured(silent)).toBe(false);
    expect(checkupLine(silent)).toBe('Nothing could be measured');
    // One skill measured is enough to say the rest.
    const one = summaryOf('o', { focus: [], skills: CHECKUP_SKILLS.map((s) => skill(s, s === 'pitch' ? 'solid' : 'not-measured')) });
    expect(checkupLine(one)).toBe('Everything measured is solid');
    for (const line of [checkupLine(measured), checkupLine(silent)]) expect(jargonIn(line)).toEqual([]);
  });

  it('puts the skills in the battery order, and an unknown one last', () => {
    const shuffled = [skill('connected', 'solid'), skill('slides', 'focus'), skill('range', 'solid'), { ...skill('range', 'solid'), skill: 'vibrato' as never }, skill('pitch', 'solid')];
    expect(orderedSkills(shuffled).map((s) => s.skill)).toEqual(['range', 'pitch', 'connected', 'slides', 'vibrato']);
  });
});

describe('time in words', () => {
  it('counts whole days, never negative, and 0 for a time that does not parse', () => {
    expect(daysSince('2026-10-19T12:00:00.000Z', NOW)).toBe(3);
    expect(daysSince('2026-10-22T11:00:00.000Z', NOW)).toBe(0);
    expect(daysSince('2026-10-30T12:00:00.000Z', NOW)).toBe(0);
    expect(daysSince('not a date', NOW)).toBe(0);
  });

  it('says how long as days, weeks or months', () => {
    expect(elapsedWords(0)).toBe('less than a day');
    expect(elapsedWords(1)).toBe('1 day');
    expect(elapsedWords(6)).toBe('6 days');
    expect(elapsedWords(14)).toBe('2 weeks');
    expect(elapsedWords(21)).toBe('3 weeks');
    expect(elapsedWords(45)).toBe('6 weeks');
    expect(elapsedWords(60)).toBe('2 months');
    expect(elapsedWords(95)).toBe('3 months');
    for (const d of [0, 1, 6, 14, 21, 45, 60, 95, 400]) expect(jargonIn(elapsedWords(d))).toEqual([]);
  });
});

describe('the running session', () => {
  it('counts the tasks sung and finds the next one', () => {
    expect(sungCount(sessionOf(0))).toBe(0);
    expect(nextTaskIndex(sessionOf(0))).toBe(0);
    expect(sungCount(sessionOf(2))).toBe(2);
    expect(nextTaskIndex(sessionOf(2))).toBe(2);
    expect(sungCount(sessionOf(5))).toBe(5);
    expect(nextTaskIndex(sessionOf(5))).toBeNull();
  });

  it('finds the first gap when a task in the middle was never sung', () => {
    const session = sessionOf(5, { attemptIds: ['a', null, 'c', 'd', 'e'] });
    expect(sungCount(session)).toBe(4);
    expect(nextTaskIndex(session)).toBe(1);
  });

  it('is in progress only with some tasks sung, some to go, and not finished', () => {
    expect(isInProgress(null)).toBe(false);
    expect(isInProgress(sessionOf(0))).toBe(false);
    expect(isInProgress(sessionOf(3))).toBe(true);
    expect(isInProgress(sessionOf(5))).toBe(false);
    expect(isInProgress(sessionOf(3, { finishedAt: '2026-10-22T14:05:00.000Z' }))).toBe(false);
  });

  it('marks each task sung, next or to come', () => {
    expect(taskStates(null)).toEqual(['next', 'ahead', 'ahead', 'ahead', 'ahead']);
    expect(taskStates(sessionOf(0))).toEqual(['next', 'ahead', 'ahead', 'ahead', 'ahead']);
    expect(taskStates(sessionOf(2))).toEqual(['done', 'done', 'next', 'ahead', 'ahead']);
    expect(taskStates(sessionOf(5))).toEqual(['done', 'done', 'done', 'done', 'done']);
  });
});

describe('opening the check-up from outside it', () => {
  beforeEach(() => {
    resetRouterForTests([routeOf('home')]);
    installRouteGuard(() => ({ ok: true }));
    activeCheckup.value = null;
    vi.mocked(abandonCheckup).mockClear();
  });

  it('opens the intro, dropping a finished or empty session first', () => {
    activeCheckup.value = sessionOf(5, { finishedAt: '2026-10-22T14:05:00.000Z' });
    openCheckup();
    expect(abandonCheckup).toHaveBeenCalledTimes(1);
    expect(activeCheckup.value).toBeNull();
    expect(route.value).toEqual(routeOf('checkup'));

    resetRouterForTests([routeOf('home')]);
    installRouteGuard(() => ({ ok: true }));
    activeCheckup.value = sessionOf(0);
    openCheckup();
    expect(abandonCheckup).toHaveBeenCalledTimes(2);
  });

  it('keeps a check-up left part way, so the screen can continue it', () => {
    const part = sessionOf(2);
    activeCheckup.value = part;
    openCheckup();
    expect(abandonCheckup).not.toHaveBeenCalled();
    expect(activeCheckup.value).toBe(part);
    expect(route.value).toEqual(routeOf('checkup'));
  });

  it('has nothing to drop when no check-up is running', () => {
    openCheckup();
    expect(abandonCheckup).not.toHaveBeenCalled();
    expect(route.value).toEqual(routeOf('checkup'));
  });
});

describe('reading the log back through the engine', () => {
  const a = summaryOf('a', { daysAgo: 30, now: NOW });
  const b = summaryOf('b', { daysAgo: 2, now: NOW });

  beforeEach(() => {
    vi.mocked(checkupsOf).mockReset();
    vi.mocked(compareCheckups).mockClear();
    vi.mocked(recheckDue).mockClear();
  });
  afterEach(() => {
    vi.mocked(checkupsOf).mockReset();
  });

  it('hands the engine the log, the notation and the saved range, and lets it replay the progress around each check-up itself', () => {
    vi.mocked(checkupsOf).mockReturnValue([a, b]);
    const log = [attemptAt('foundations.01')];
    expect(buildCheckups(log, 'profile-1', 'flats', RANGE)).toEqual([a, b]);
    expect(checkupsOf).toHaveBeenCalledTimes(1);
    const [seenLog, snapshotAfter, notation, savedRange] = vi.mocked(checkupsOf).mock.calls[0] as unknown as [unknown, (id: string) => unknown, string, unknown];
    expect(seenLog).toBe(log);
    expect(snapshotAfter('anything')).toBeNull();
    expect(notation).toBe('flats');
    // Without the saved range the engine cannot name the notes of a range ("B2–A4"): the screens would say "Not measured".
    expect(savedRange).toBe(RANGE);
  });

  it('is empty without a profile, and when the engine fails on the log (a screen never goes blank over it)', () => {
    vi.mocked(checkupsOf).mockReturnValue([a]);
    expect(buildCheckups([], null, 'sharps', null)).toEqual([]);
    expect(checkupsOf).not.toHaveBeenCalled();
    vi.mocked(checkupsOf).mockImplementation(() => {
      throw new Error('engine failed');
    });
    expect(buildCheckups([], 'profile-1', 'sharps', null)).toEqual([]);
  });

  it('compares through the engine, and gives null when it cannot', () => {
    expect(safeCompare(a, b)?.before).toBe(a);
    expect(compareCheckups).toHaveBeenCalledWith(a, b);
    vi.mocked(compareCheckups).mockImplementationOnce(() => {
      throw new Error('cannot compare');
    });
    expect(safeCompare(a, b)).toBeNull();
  });

  it('asks the engine whether a re-check is due, and says no when it cannot tell', () => {
    expect(safeRecheckDue([a], NOW)).toBe(true); // 30 days old
    expect(safeRecheckDue([b], NOW)).toBe(false); // 2 days old
    vi.mocked(recheckDue).mockImplementationOnce(() => {
      throw new Error('cannot tell');
    });
    expect(safeRecheckDue([a], NOW)).toBe(false);
  });
});

describe('checkups: the active profile\'s, computed once for every screen', () => {
  const a = summaryOf('a', { daysAgo: 30, now: NOW });

  beforeEach(() => {
    vi.mocked(checkupsOf).mockReset();
    vi.mocked(checkupsOf).mockReturnValue([a]);
    activeProfile.value = { ...profileRecord('Daniel'), range: RANGE };
    attemptLog.value = [];
    settings.value = { ...DEFAULT_SETTINGS };
  });
  afterEach(() => {
    vi.mocked(checkupsOf).mockReset();
  });

  it('reads the log, the notation and the profile\'s saved range, and shares one answer until one of them changes', () => {
    expect(checkups.value).toEqual([a]);
    expect(checkups.value).toBe(checkups.value);
    expect(checkupsOf).toHaveBeenCalledTimes(1);
    const args = vi.mocked(checkupsOf).mock.calls[0] as unknown as [unknown, unknown, string, unknown];
    expect(args[0]).toBe(attemptLog.value);
    expect(args[2]).toBe('sharps');
    expect(args[3]).toBe(RANGE);
  });

  it('reads again when an attempt is added, the notation changes or the range is saved', () => {
    void checkups.value;
    attemptLog.value = [attemptAt('foundations.01')];
    void checkups.value;
    expect(checkupsOf).toHaveBeenCalledTimes(2);
    settings.value = { ...DEFAULT_SETTINGS, notation: 'flats' };
    void checkups.value;
    expect(checkupsOf).toHaveBeenCalledTimes(3);
    const moved: VocalRange = { ...RANGE, measuredAt: '2026-10-22T10:00:00.000Z' };
    activeProfile.value = { ...profileRecord('Daniel'), range: moved };
    void checkups.value;
    expect(checkupsOf).toHaveBeenCalledTimes(4);
    expect((vi.mocked(checkupsOf).mock.calls[3] as unknown as unknown[])[3]).toBe(moved);
  });

  it('is empty before a profile is loaded', () => {
    activeProfile.value = null;
    expect(checkups.value).toEqual([]);
  });
});
