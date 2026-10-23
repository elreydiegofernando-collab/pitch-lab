// @vitest-environment happy-dom
/** Music words in running text become tappable terms: the first time each appears, matched plainly, the text kept exactly. */
import { afterEach, describe, expect, it } from 'vitest';
import { render } from 'preact';
import type { TermId } from '../../teach/glossary';
import { linkTerms } from './terms';

let container: HTMLElement | null = null;

/** Render sentences with one shared `seen`, as a part of a screen does; the linked term ids in order, and the text. */
function linked(...sentences: string[]): { ids: string[]; text: string; words: string[] } {
  container = document.createElement('div');
  document.body.appendChild(container);
  const seen = new Set<TermId>();
  render(
    <div>
      {sentences.map((s, i) => (
        <p key={i}>{linkTerms(s, seen)}</p>
      ))}
    </div>,
    container,
  );
  const terms = [...container.querySelectorAll<HTMLElement>('[data-term]')];
  return { ids: terms.map((t) => t.dataset.term ?? ''), words: terms.map((t) => t.textContent ?? ''), text: container.textContent ?? '' };
}

afterEach(() => {
  if (container) {
    render(null, container);
    container.remove();
    container = null;
  }
});

describe('linkTerms', () => {
  it('returns text with no music word as it is', () => {
    expect(linkTerms('Take a breath and relax your shoulders.', new Set())).toBe('Take a breath and relax your shoulders.');
  });

  it('links each word the first time it appears, and keeps the text exactly', () => {
    const r = linked('Sing the note back.', 'Then hold the note, in tune.');
    expect(r.ids).toEqual(['note', 'in-tune']);
    expect(r.text).toBe('Sing the note back.Then hold the note, in tune.');
  });

  it('takes the longest word first: an in-tune zone is not "in tune" plus "zone", a half step is not a step', () => {
    expect(linked('Stay inside the in-tune zone.').ids).toEqual(['in-tune-zone']);
    expect(linked('Move up a half step.').ids).toEqual(['half-step']);
  });

  it('matches any case, a space or a hyphen inside a word, and a plural', () => {
    const r = linked('Notes come in steps.', 'Keep it in-tune.', 'Echoes help.');
    expect(r.ids).toEqual(['note', 'step', 'in-tune', 'echo']);
    expect(r.words).toEqual(['Notes', 'steps', 'in-tune', 'Echoes']);
  });

  it('knows the other ways a word is written ("drifts" for drifting)', () => {
    expect(linked('The note drifts flat.').ids).toEqual(['note', 'drift', 'flat']);
  });

  it('never links inside another word, or a plural that is another word', () => {
    expect(linked('Write it in a notebook, with an orange pen, at a footstep pace.').ids).toEqual([]);
    expect(linked('It happens in tunes all the time.').ids).toEqual([]);
  });

  it('leaves alone the words a part has already linked', () => {
    const seen = new Set<TermId>(['note']);
    expect(linkTerms('Sing the note.', seen)).toBe('Sing the note.');
  });
});
