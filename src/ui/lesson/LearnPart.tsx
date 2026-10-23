/**
 * Learn, the first part of a lesson (docs/DESIGN.md 13.3): a short, friendly teaching page. What the skill is, why it
 * matters, the music words this lesson teaches (each tappable, and explained right here, before the steps that use
 * them: the first place the singer meets it), how to do it, what the screen will show while singing, and a demo to
 * hear. It opens by itself the first time (before any try); after that it folds away under its heading, one tap from
 * being read again.
 */
import type { JSX } from 'preact';
import { ChevronDown, Square, Volume2 } from 'lucide-preact';
import type { LearnPage } from '../../lessons/types';
import { GLOSSARY } from '../../teach/glossary-content';
import type { TermId } from '../../teach/glossary';
import { Button } from '../components/Button';
import { Term } from '../teach/Term';
import { linkTerms } from './terms';

export interface LearnPartProps {
  learn: LearnPage;
  open: boolean;
  onToggle: () => void;
  /** The demo to hear (the lesson's simplest try); null when there is none to play. */
  demo: { playing: boolean; onClick: () => void } | null;
  /** The id of the part's heading; the page it opens is `${headingId}-body`. */
  headingId: string;
}

/** The lesson's own music words, each tappable, with its plain explanation and example. */
function Words(props: { terms: readonly TermId[] }): JSX.Element {
  return (
    <dl class="pl-learn__words" data-testid="learn-words">
      {props.terms.map((id) => {
        const entry = GLOSSARY[id];
        return (
          <div key={id} class="pl-learn__word">
            <dt>
              <Term id={id} />
            </dt>
            {entry ? (
              <dd class="pl-prose">
                {entry.plain}
                {entry.example ? <span class="pl-learn__example">{entry.example}</span> : null}
              </dd>
            ) : null}
          </div>
        );
      })}
    </dl>
  );
}

export function LearnPart(props: LearnPartProps): JSX.Element {
  const { learn, open, onToggle, demo, headingId } = props;
  const bodyId = `${headingId}-body`;
  // Each music word in the text is linked once in this part, the first time it appears.
  const seen = new Set<TermId>();

  return (
    <>
      <h3 class="pl-part__heading" id={headingId}>
        <button type="button" class="pl-part__toggle" aria-expanded={open} aria-controls={open ? bodyId : undefined} onClick={onToggle} data-testid="learn-toggle">
          <span class="pl-part__title">Learn</span>
          <span class="pl-part__hint">{open ? 'Hide' : 'Read again'}</span>
          <ChevronDown class="pl-part__chevron" size={20} strokeWidth={2} aria-hidden="true" />
        </button>
      </h3>
      {open ? (
        <div class="pl-learn" id={bodyId} data-testid="learn-page">
          <div class="pl-learn__part">
            <h4 class="pl-label">What it is</h4>
            <p class="pl-body pl-prose">{linkTerms(learn.what, seen)}</p>
          </div>
          <div class="pl-learn__part">
            <h4 class="pl-label">Why it matters</h4>
            <p class="pl-body pl-prose">{linkTerms(learn.why, seen)}</p>
          </div>
          {learn.terms.length > 0 ? (
            <div class="pl-learn__part">
              <h4 class="pl-label">Words in this lesson</h4>
              <Words terms={learn.terms} />
            </div>
          ) : null}
          {learn.how.length > 0 ? (
            <div class="pl-learn__part">
              <h4 class="pl-label">How to do it</h4>
              <ol class="pl-learn__how">
                {learn.how.map((text, i) => (
                  <li key={i}>
                    <span class="pl-learn__n pl-tabular" aria-hidden="true">
                      {i + 1}
                    </span>
                    <span class="pl-prose">{linkTerms(text, seen)}</span>
                  </li>
                ))}
              </ol>
            </div>
          ) : null}
          {learn.onScreen.length > 0 ? (
            <div class="pl-learn__part">
              <h4 class="pl-label">What you will see</h4>
              <ul class="pl-learn__screen">
                {learn.onScreen.map((text, i) => (
                  <li key={i} class="pl-prose">
                    {linkTerms(text, seen)}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {demo ? (
            <div class="pl-learn__demo">
              <Button variant="secondary" icon={demo.playing ? Square : Volume2} onClick={demo.onClick} data-testid="learn-listen">
                {demo.playing ? 'Stop' : 'Listen'}
              </Button>
              <p class="pl-body-s pl-muted pl-prose">Hear how it goes before you try it.</p>
            </div>
          ) : null}
        </div>
      ) : null}
    </>
  );
}
