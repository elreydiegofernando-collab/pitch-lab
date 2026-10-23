/**
 * A music word the singer can tap to read its plain explanation (src/teach/glossary.ts has the words, glossary-content.ts
 * the explanations). Owner, 2026-10-23: "why are you using technical terms without teaching me first?" So every music word
 * the app shows is one of these: a dotted underline marks it, a tap opens a small sheet with what it means and an example,
 * and "Got it", Esc or a tap outside closes it.
 *
 * The button is a native one (Enter and Space work, focus returns to it on close) and a 48 px target made by its own box
 * (src/styles/teach.css). Its click stops there, so a word inside a tappable card never also taps the card. The sheet is
 * drawn on document.body, not where the word sits: a fixed sheet inside a transformed ancestor (an open More sheet is
 * one) would be placed against that ancestor instead of the screen.
 */
import { useCallback, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { render, type ComponentChildren, type JSX } from 'preact';
import { sentence } from '../../coaching/plain';
import { TERMS, type GlossaryEntry, type TermId } from '../../teach/glossary';
import { GLOSSARY } from '../../teach/glossary-content';
import { Button } from '../components/Button';
import { Sheet } from '../components/Sheet';
import '../../styles/teach.css';

export interface TermProps {
  id: TermId;
  /** The words shown (default: the term's own word); e.g. "in tune" inside a sentence. */
  children?: ComponentChildren;
}

/** Draws `children` as a tree of its own on document.body, for as long as it is mounted. */
function BodyPortal(props: { children: ComponentChildren }): null {
  const host = useRef<HTMLDivElement | null>(null);
  if (host.current === null) host.current = document.createElement('div');
  const node = host.current;
  useLayoutEffect(() => {
    document.body.appendChild(node);
    return () => {
      render(null, node);
      node.remove();
    };
  }, [node]);
  // After every render of the portal, so the tree it draws follows its props.
  useLayoutEffect(() => {
    render(props.children, node);
  });
  return null;
}

export function Term(props: TermProps): JSX.Element {
  const { id, children } = props;
  const [open, setOpen] = useState(false);
  // Stable: the sheet restarts its focus handling whenever its onClose changes.
  const close = useCallback(() => setOpen(false), []);
  const shown = children ?? TERMS[id];
  // An id the glossary does not know (it cannot happen in typed code) is just its words.
  const entry = GLOSSARY[id] as GlossaryEntry | undefined;
  if (!entry) {
    return (
      <span class="pl-term pl-term--plain" data-term={id}>
        {shown}
      </span>
    );
  }
  return (
    <>
      <button
        type="button"
        class="pl-term"
        data-term={id}
        aria-haspopup="dialog"
        title={`What “${entry.word}” means`}
        onClick={(e) => {
          e.stopPropagation();
          setOpen(true);
        }}
      >
        {shown}
      </button>
      {open ? (
        <BodyPortal>
          <Sheet open title={sentence(entry.word)} onClose={close} initialFocus="sheet">
            <p class="pl-body pl-prose" data-testid="term-plain">
              {entry.plain}
            </p>
            {entry.example ? (
              <div class="pl-term-sheet__example">
                <span class="pl-label">For example</span>
                <p class="pl-body-s pl-muted pl-prose" data-testid="term-example">
                  {entry.example}
                </p>
              </div>
            ) : null}
            <Button variant="secondary" block onClick={close}>
              Got it
            </Button>
          </Sheet>
        </BodyPortal>
      ) : null}
    </>
  );
}
