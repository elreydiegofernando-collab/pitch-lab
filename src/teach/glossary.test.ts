/**
 * The glossary contract (owner, 2026-10-23: "why are you using technical terms without teaching me first?"): every music
 * word has a plain explanation, and the explanations themselves follow the plain-words rules, so tapping a word never
 * trades one thing to look up for another.
 */
import { describe, expect, it } from 'vitest';
import { jargonIn } from '../coaching/plain';
import { TERM_IDS, TERMS } from './glossary';
import { GLOSSARY } from './glossary-content';

/**
 * On top of the coach's own list (coaching/plain.ts JARGON, also run below): words a beginner should not meet in an
 * explanation because they are not glossary terms, and the old names the plain words replace.
 */
const ALSO_BANNED = [
  /\bsettl(?:e|es|ed|ing)\b/i,
  /tolerance/i,
  /\bintervals?\b/i,
  /\bregister\b/i,
  /\bfalsetto\b/i,
  /\bdiaphragm/i,
  /\b(?:chest|head) voice\b/i,
  /\bfrequenc/i,
  /\bhertz\b/i,
  /\bdecibel/i,
  /\bmidi\b/i,
  /\bpitch class\b/i,
  /\bmetronome\b/i,
  /\blegato\b/i,
  /\bstaccato\b/i,
  /\btimbre\b/i,
  /\bglissando\b/i,
];

/** Effort the voice should never make: these words only ever follow "never" ("never pushing"), as in the coaching copy. */
const HARD_WORDS = /\b(?:push|forc|strain)\w*/gi;

const sentences = (text: string): number => text.split(/(?<=[.?])\s+(?=[A-Z“"(])/).filter((s) => s.trim()).length;

describe('the glossary covers every music word', () => {
  it('explains every term the contract lists, and nothing else', () => {
    expect(Object.keys(GLOSSARY).sort()).toEqual([...TERM_IDS].sort());
  });

  it('shows each term as the word the contract gives it', () => {
    for (const id of TERM_IDS) expect(GLOSSARY[id].word, id).toBe(TERMS[id]);
  });
});

describe.each(TERM_IDS.map((id) => [id] as const))('the explanation of %s', (id) => {
  const entry = GLOSSARY[id];
  const texts = [entry.plain, ...(entry.example === undefined ? [] : [entry.example])];

  it('says what it means in one or two plain sentences, then gives an example', () => {
    expect(entry.plain.trim().length).toBeGreaterThan(0);
    expect(entry.plain, 'a capital to start, a full stop to end').toMatch(/^[A-Z“"].*[.?”"]$/s);
    expect(sentences(entry.plain), 'one or two sentences').toBeLessThanOrEqual(2);
    expect(entry.plain.length, 'short enough for a small sheet').toBeLessThanOrEqual(190);
    expect(entry.example, 'every word has an everyday or on-screen example').toBeDefined();
    if (entry.example !== undefined) {
      expect(entry.example).toMatch(/^[A-Z“"].*[.?”"]$/s);
      expect(sentences(entry.example), 'up to three sentences').toBeLessThanOrEqual(3);
      expect(entry.example.length).toBeLessThanOrEqual(230);
    }
    for (const t of texts) expect(t, 'no stray spaces').toBe(t.trim().replace(/\s{2,}/g, ' '));
  });

  it('reads plainly: no units, no jargon, no exclamation marks', () => {
    for (const t of texts) {
      expect(jargonIn(t), t).toEqual([]);
      for (const re of ALSO_BANNED) expect(t, `"${t}" uses ${re}`).not.toMatch(re);
    }
  });

  it('never tells the singer to push, force or strain', () => {
    for (const t of texts) {
      for (const hard of t.matchAll(HARD_WORDS)) {
        expect(t.slice(0, hard.index).trimEnd(), `"${hard[0]}" only as "never ${hard[0]}" in: ${t}`).toMatch(/\bnever$/i);
      }
    }
  });
});
