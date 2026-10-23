/**
 * Review R5: in every echo exercise the app plays the note when the count-in ends, so no text the singer reads may send
 * them in at that moment (they would sing over the note they asked to hear first). Scans every word the app teaches or
 * coaches with: the glossary, the coaching ladders and tips, the lessons, and the live exercises.
 */
import { describe, expect, it } from 'vitest';
import { LADDERS } from '../coaching/content/index';
import { EXERCISES } from '../exercises';
import { COACHING_TIPS, NO_VOICE_TIP, POLISH_TIP, STOPPED_TIP, UNFIT_RANGE_TIP, UNSUNG_TIP } from '../exercises/tips';
import { LESSONS } from '../lessons';
import { GLOSSARY } from './glossary-content';

/** A sentence that sends the singer in when the count-in (or the countdown) ends. */
const SING_AT_COUNT_IN: readonly RegExp[] = [
  /\b(start|begin)\s+(singing|to sing)\b[^.]*\b(count-?in|countdown)\b[^.]*\b(ends?|is over|finishes)\b/i,
  /\b(count-?in|countdown)\b[^.]*\b(ends?|is over|finishes)\b[^.]*\b(start|begin)\s+(singing|to sing)\b/i,
  /\b(start|begin)\s+(singing|to sing)\s+(when|as soon as|once)\s+it\s+(ends|is over|finishes)\b/i,
];

const offends = (text: string): boolean => SING_AT_COUNT_IN.some((re) => re.test(text));

/** Every text the app teaches or coaches with, labelled by where it lives. */
function everyText(): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const [id, e] of Object.entries(GLOSSARY)) out.push([`glossary ${id}`, `${e.plain} ${e.example ?? ''}`]);
  for (const [id, l] of Object.entries(LADDERS)) out.push([`ladder ${id}`, [l.tip, l.why, ...l.steps, l.easier].join(' ')]);
  for (const t of [...COACHING_TIPS, NO_VOICE_TIP, POLISH_TIP, STOPPED_TIP, UNFIT_RANGE_TIP, UNSUNG_TIP]) out.push([`tip ${t.id}`, t.text]);
  for (const [id, lesson] of Object.entries(LESSONS)) {
    const { learn } = lesson;
    out.push([`lesson ${id}`, [lesson.title, lesson.outcome, learn.what, learn.why, ...learn.how, ...learn.onScreen, ...lesson.practice.flatMap((p) => [p.title, p.ask])].join(' ')]);
  }
  for (const def of EXERCISES) if (def.retired === undefined) out.push([`exercise ${def.id}`, [def.goal, ...(def.steps ?? []), def.passPlain ?? ''].join(' ')]);
  return out;
}

describe('the count-in in words (review R5)', () => {
  it('catches the wording that sent the singer in over the note', () => {
    expect(offends('On the Sing screen a big number counts down, like 3, 2, 1. Start singing when it ends.')).toBe(true);
    expect(offends('Check that the mic is allowed, then start singing as soon as the count-in ends.')).toBe(true);
    expect(offends('After the count-in, the app plays a note. Sing it back on a soft “oo”.')).toBe(false);
  });

  it('never tells the singer to start singing when the count-in ends, anywhere', () => {
    const texts = everyText();
    expect(texts.length).toBeGreaterThan(100);
    expect(texts.filter(([, text]) => offends(text)).map(([where]) => where)).toEqual([]);
  });

  it('teaches the count-in as clicks before the take, with the note played first and the singer in on their turn', () => {
    const entry = GLOSSARY['count-in'];
    const words = `${entry.plain} ${entry.example ?? ''}`;
    expect(words).toMatch(/plays the note first/i);
    expect(words).toMatch(/your turn/i);
  });
});
