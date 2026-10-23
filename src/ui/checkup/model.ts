/**
 * What the check-up screens share (docs/DESIGN.md 11-13; src/checkup is the engine): the plain words for ratings, what to
 * practise for each focus skill, the finished check-ups read back from the log, and the small rules that turn the running
 * session into a screen state. Pure apart from `checkups`, `useCheckups` and `openCheckup`.
 *
 * Owner, 2026-10-22: "if you can hold a note, but you have voice cracking ... you should maybe practice voice
 * cracking. Then you should have like assessment on where you've been and like how you've gotten better." So a rating
 * is never a grade ("Focus here", never "Failed"), a crack is something to practise, and nothing here can lower progress.
 *
 * The skills' plain names and the Foundations levels behind them are the engine's (src/checkup/skills.ts), so the skill
 * list, "Then and now" and the focus buttons all say the same words. Every word of ours a singer reads is plain
 * (src/coaching/plain.ts): no cents, Hz, semitones or bpm, no exclamation marks, and never "push", "force" or "strain" as
 * advice. model.test.ts checks every string below against those rules.
 */
import { computed } from '@preact/signals';
import { listWords } from '../../coaching/plain';
import { CHECKUP_SKILLS, SKILL_LEVELS, SKILL_NAMES } from '../../checkup/skills';
import { checkupsOf, compareCheckups, recheckDue } from '../../checkup/summary';
import { CHECKUP_TASKS, type CheckupComparison, type CheckupSkill, type CheckupSummary, type SkillRating, type SkillResult } from '../../checkup/types';
import type { Notation } from '../../core/music';
import { getLevel } from '../../exercises';
import { levelStatus, type ProgressSnapshot } from '../../progress';
import { navigate } from '../../router';
import { abandonCheckup, activeCheckup, type CheckupSession } from '../../runtime/checkup';
import { activeProfile, attemptLog } from '../../state/session';
import { settings } from '../../state/settings';
import type { AttemptRecord, VocalRange } from '../../storage/schema';

// ---------------------------------------------------------------- the words

export function isSkill(value: string): value is CheckupSkill {
  return (CHECKUP_SKILLS as readonly string[]).includes(value);
}

/** A skill's name for a list or a heading ("Slides", "Note starts"): the engine's, as "Then and now" says it. */
export function skillLabel(skill: string): string {
  return isSkill(skill) ? SKILL_NAMES[skill].label : skill;
}

/** A rating is a word and a glyph (never colour alone), and never a grade. */
export const RATING_WORD: Readonly<Record<SkillRating, string>> = {
  solid: 'Solid',
  'getting-there': 'Getting there',
  focus: 'Focus here',
  'not-measured': 'Not measured',
};

/**
 * What to practise for a focus skill, in plain words. It names no level (the button beside it does: which level is the
 * one to work on depends on where the singer is, focusLevelId), and it never says to push: a crack is where a voice
 * changes gears.
 */
export const FOCUS_PRACTISE: Readonly<Record<CheckupSkill, string>> = {
  range:
    'Warm up gently, then sing the Range finder again. It finds the notes that feel easy, and every other exercise is built around them.',
  pitch: 'Hear the note, hum it quietly in your head, then sing it back and check where you landed. Take it one note at a time.',
  steadiness: 'Hold one note and keep the breath even from start to finish, so it neither wavers nor sinks. Start with short, easy holds.',
  slides:
    'Slide up and down on “oo”, softly and a little slower than feels natural. If it breaks in one spot, that is where a voice changes gears: keep the sound light and glide across it. Let each slide arrive right on its last note before you stop.',
  starts: 'Hear the note first, then begin right on it, with no scoop up from below. Short notes are the way to practise this.',
  connected: 'Sing a line of notes joined together, each one arriving clean before the next begins.',
};

/**
 * The level to offer for a focus skill: of the Foundations levels that train it (the engine's SKILL_LEVELS, in order) the
 * one the singer is on now, else the first (a passed level can be sung again; a level not open yet is shown as locked).
 */
export function focusLevelId(skill: CheckupSkill, snapshot: ProgressSnapshot): string {
  const levels = SKILL_LEVELS[skill];
  return levels.find((id) => levelStatus(id, snapshot) === 'current') ?? levels[0];
}

/** The one pitch for the check-up, wherever it is offered (the intro screen). */
export const PITCH_INTRO =
  'About four minutes: five short tasks so Pitch Lab can find where to start you and what to focus on. Nothing here can lower your progress.';
/** The same pitch under a title that already says "4-minute" (Home's card). */
export const PITCH_SHORT = 'Five short tasks so Pitch Lab can find where to start you and what to focus on. Nothing here can lower your progress.';
/** Voice care before singing, in the app's usual words. */
export const CARE_LINE = 'Sing at an easy volume. Stop if anything hurts, scratches or goes hoarse.';

/** "Focus: slides and note starts", or "Everything measured is solid" when nothing needs focus. */
export function focusLine(focus: readonly CheckupSkill[]): string {
  const names = focus.filter(isSkill).map((s) => SKILL_NAMES[s].words);
  return names.length > 0 ? `Focus: ${listWords(names)}` : 'Everything measured is solid';
}

/** True when at least one skill of the check-up was measured (a take that was silent, stopped early or not sung measures nothing). */
export function anyMeasured(summary: Pick<CheckupSummary, 'skills'>): boolean {
  return summary.skills.some((s) => s.rating !== 'not-measured');
}

/**
 * One line about how a check-up went, for a list or a card: "Focus: slides and note starts", "Everything measured is
 * solid", or, when nothing came through at all, "Nothing could be measured" (never "everything is solid" of nothing).
 */
export function checkupLine(summary: Pick<CheckupSummary, 'skills' | 'focus'>): string {
  return anyMeasured(summary) ? focusLine(summary.focus) : 'Nothing could be measured';
}

/** A summary's skills in the battery's order (an unknown skill, if the engine ever adds one, goes last). */
export function orderedSkills(skills: readonly SkillResult[]): SkillResult[] {
  const rank = (s: SkillResult): number => {
    const at = CHECKUP_SKILLS.indexOf(s.skill);
    return at < 0 ? CHECKUP_SKILLS.length : at;
  };
  return [...skills].sort((a, b) => rank(a) - rank(b));
}

/** The title of a catalog level, or null for an id the catalog does not know. */
export function levelTitle(levelId: string): string | null {
  return getLevel(levelId)?.title ?? null;
}

// ---------------------------------------------------------------- time

const DAY_MS = 86_400_000;

/** How long ago, in whole days (0 when the time does not parse or is in the future). */
export function daysSince(iso: string, now: number): number {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? Math.max(0, Math.floor((now - ms) / DAY_MS)) : 0;
}

/** "less than a day", "6 days", "3 weeks", "2 months": for "It has been ... since your last check-up." */
export function elapsedWords(days: number): string {
  if (days < 1) return 'less than a day';
  if (days < 14) return `${days} ${days === 1 ? 'day' : 'days'}`;
  if (days < 60) return `${Math.round(days / 7)} weeks`;
  const months = Math.round(days / 30);
  return `${months} ${months === 1 ? 'month' : 'months'}`;
}

// ---------------------------------------------------------------- the running session

/** How many tasks of the running check-up have been sung. */
export function sungCount(session: CheckupSession): number {
  let n = 0;
  for (let i = 0; i < CHECKUP_TASKS.length; i++) if (session.attemptIds[i] != null) n += 1;
  return n;
}

/** The first task not sung yet (0-based); null when every task has been sung. */
export function nextTaskIndex(session: CheckupSession): number | null {
  for (let i = 0; i < CHECKUP_TASKS.length; i++) if (session.attemptIds[i] == null) return i;
  return null;
}

/** A check-up the singer left part way: some tasks sung, some still to sing, not marked finished. */
export function isInProgress(session: CheckupSession | null): session is CheckupSession {
  return session !== null && session.finishedAt === null && sungCount(session) > 0 && nextTaskIndex(session) !== null;
}

export type TaskState = 'done' | 'next' | 'ahead';

/** Each task's place in the running check-up: sung, the one to sing now, or still to come. */
export function taskStates(session: CheckupSession | null): TaskState[] {
  const next = session ? nextTaskIndex(session) : 0;
  return CHECKUP_TASKS.map((_, i) => (session && session.attemptIds[i] != null ? 'done' : i === next ? 'next' : 'ahead'));
}

/**
 * Open the check-up from outside it (Home, the dashboard). One left part way is kept and continued; a finished or empty
 * one is dropped first, so the intro shows rather than the results of the last sitting.
 */
export function openCheckup(): void {
  const session = activeCheckup.peek();
  if (session !== null && !isInProgress(session)) abandonCheckup();
  navigate('checkup');
}

// ---------------------------------------------------------------- the log

/**
 * Every finished check-up of the profile, oldest first, read back from its log. `savedRange` is the profile's saved
 * range: a take keeps only the span of a range, so the engine names its notes ("B2–A4") on the check-up whose Range
 * finder saved it. The progress around each check-up (where to start, what it opened) the engine replays from the log
 * itself (`() => null`: the same answer as the take's own outcome would give).
 *
 * Should the engine ever fail on a log, this is empty: a check-up screen never goes blank over a summary it cannot build
 * (the report does the same with its coaching).
 */
export function buildCheckups(log: readonly AttemptRecord[], profileId: string | null, notation: Notation, savedRange: VocalRange | null): CheckupSummary[] {
  if (profileId === null) return [];
  try {
    return checkupsOf(log, () => null, notation, savedRange);
  } catch {
    return [];
  }
}

/** "Then and now" between two check-ups; null when the engine cannot compare them. */
export function safeCompare(before: CheckupSummary, after: CheckupSummary): CheckupComparison | null {
  try {
    return compareCheckups(before, after);
  } catch {
    return null;
  }
}

/** recheckDue, or false when the engine cannot say: a re-check is only ever a suggestion. */
export function safeRecheckDue(summaries: readonly CheckupSummary[], now: number): boolean {
  try {
    return recheckDue(summaries, now);
  } catch {
    return false;
  }
}

/**
 * The active profile's finished check-ups, oldest first. Computed once per change of its log, saved range or notation,
 * and shared by every screen that shows them (Home, the dashboard, the check-up screens), so reading a long log back is
 * not repeated each time one of them opens.
 */
export const checkups = computed<CheckupSummary[]>(() =>
  buildCheckups(attemptLog.value, activeProfile.value?.id ?? null, settings.value.notation, activeProfile.value?.range ?? null),
);

/** `checkups`, read in a component (it re-renders when they change). */
export function useCheckups(): CheckupSummary[] {
  return checkups.value;
}
