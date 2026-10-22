/**
 * The coaching content contract: every tip id has a ladder in the part that owns its prefix, every ladder belongs to a
 * real tip, and the words follow the plain-language rules (owner, 2026-10-22: written for someone relearning to sing).
 */
import { describe, expect, it } from 'vitest';
import { COACHING_TIPS } from '../../exercises/tips';
import { getLevel } from '../../exercises';
import { LADDER_PARTS, LADDERS, ladderFor } from './index';

const TIP_IDS = COACHING_TIPS.map((t) => t.id);
const prefixOf = (id: string): string => id.split('.')[0];

/** Units and symbols a singer relearning music should never have to decode. */
const BANNED = [/¢/, /\bcents?\b/i, /\bHz\b/, /semitone/i, /\bbpm\b/i, /!/];
const sentences = (text: string): number => text.split(/(?<=[.?])\s+(?=[A-Z“"(])/).filter((s) => s.trim()).length;

describe.each(LADDER_PARTS.map((p) => [p.name, p] as const))('coaching ladders: %s', (_name, part) => {
  const owned = TIP_IDS.filter((id) => (part.prefixes as readonly string[]).includes(prefixOf(id)));

  it('has a ladder for every tip id it owns, and none it does not', () => {
    expect(Object.keys(part.ladders).sort()).toEqual([...owned].sort());
  });

  it.each(owned.map((id) => [id]))('%s reads plainly and has every depth', (id) => {
    const ladder = part.ladders[id];
    expect(ladder, `missing ladder for ${id}`).toBeDefined();
    if (!ladder) return;
    const words = [ladder.tip, ladder.why, ...ladder.steps, ladder.easier];
    for (const text of words) {
      expect(text.trim().length, `${id}: empty text`).toBeGreaterThan(0);
      for (const re of BANNED) expect(text, `${id}: "${text}" uses ${re}`).not.toMatch(re);
    }
    expect(sentences(ladder.tip), `${id}: the tip is one or two sentences`).toBeLessThanOrEqual(2);
    expect(sentences(ladder.why), `${id}: why is two or three sentences`).toBeLessThanOrEqual(3);
    expect(sentences(ladder.easier), `${id}: easier is one to three sentences`).toBeLessThanOrEqual(3);
    expect(ladder.steps.length, `${id}: 3 to 6 steps`).toBeGreaterThanOrEqual(3);
    expect(ladder.steps.length, `${id}: 3 to 6 steps`).toBeLessThanOrEqual(6);
    for (const step of ladder.steps) expect(step.length, `${id}: a step is one short action`).toBeLessThanOrEqual(180);
    if (ladder.practiseLevelId !== undefined) expect(getLevel(ladder.practiseLevelId), `${id}: unknown level`).toBeDefined();
  });
});

describe('coaching ladders: the index', () => {
  it('joins the parts without overlap', () => {
    const total = LADDER_PARTS.reduce((n, p) => n + Object.keys(p.ladders).length, 0);
    expect(Object.keys(LADDERS)).toHaveLength(total);
  });

  it('finds a ladder by tip id, and nothing for an unknown id', () => {
    expect(ladderFor('no.such-tip')).toBeUndefined();
    expect(ladderFor('__proto__')).toBeUndefined();
  });
});
