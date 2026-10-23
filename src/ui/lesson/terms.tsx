/**
 * Music words in running text, made tappable (owner, 2026-10-23: "why are you using technical terms without teaching me
 * first?"). linkTerms finds the glossary's words (src/teach/glossary.ts) in a sentence and renders each one with the
 * Term component, so the singer can tap it for its plain explanation. Only the first time a word appears in a part of
 * the screen is it linked (`seen` is shared across that part's sentences), so a page never turns into a field of links.
 *
 * Matching is plain and forgiving: any case, a space or a hyphen between the parts of a word ("in tune", "in-tune"),
 * and a plural ("notes", "echoes"); the longest word wins ("in-tune zone" before "in tune", "half step" before "step").
 */
import type { ComponentChildren } from 'preact';
import { TERMS, TERM_IDS, type TermId } from '../../teach/glossary';
import { Term } from '../teach/Term';

/** Other ways a word is written in a sentence (the glossary's own word is "drifting"). */
const ALIASES: Readonly<Partial<Record<TermId, readonly string[]>>> = {
  drift: ['drift'],
};

/** Words that never take a plural ("in tunes" is not "in tune"). */
const NO_PLURAL: ReadonlySet<TermId> = new Set<TermId>(['in-tune']);

interface Entry {
  id: TermId;
  word: string;
}

const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** A word as a pattern: its parts joined by a space or a hyphen. */
function wordPattern(word: string): string {
  return word.split(/[\s-]+/).map(escape).join('[\\s-]');
}

const ENTRIES: readonly Entry[] = TERM_IDS.flatMap((id): Entry[] => [{ id, word: TERMS[id] }, ...(ALIASES[id] ?? []).map((word) => ({ id, word }))]).sort(
  (a, b) => b.word.length - a.word.length,
);

const SOURCE = `\\b(?:${ENTRIES.map((e) => `(${wordPattern(e.word)}${NO_PLURAL.has(e.id) ? '' : '(?:e?s)?'})`).join('|')})\\b`;

/** The glossary term a matched word belongs to. */
function idOf(match: RegExpExecArray): TermId | null {
  for (let i = 1; i < match.length; i++) if (match[i] !== undefined) return ENTRIES[i - 1].id;
  return null;
}

/**
 * `text` with the first appearance of each glossary word (not yet in `seen`) rendered as a Term; `seen` gains the words
 * linked. Text without a music word comes back as the string itself.
 */
export function linkTerms(text: string, seen: Set<TermId>): ComponentChildren {
  const re = new RegExp(SOURCE, 'gi');
  const out: ComponentChildren[] = [];
  let last = 0;
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    const id = idOf(m);
    if (id === null || seen.has(id)) continue;
    seen.add(id);
    if (m.index > last) out.push(text.slice(last, m.index));
    out.push(
      <Term key={`${id}-${m.index}`} id={id}>
        {m[0]}
      </Term>,
    );
    last = m.index + m[0].length;
  }
  if (out.length === 0) return text;
  if (last < text.length) out.push(text.slice(last));
  return out;
}
