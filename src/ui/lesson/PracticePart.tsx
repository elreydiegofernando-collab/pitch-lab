/**
 * Practise, the second part of a lesson (docs/DESIGN.md 13.3): the practice steps as a list, each with its title, its
 * ask and its good tries (dots and words). The step the singer is on is marked "Now" ("Next" while the lesson is still at
 * Learn; after a missed check, the step that trains what was missed, done or not), and the bar's amber button practises
 * it too; a step that is done can be practised again, and so can every
 * step of a passed lesson. Each of those is one large tap target (the thumb zone), never a small link. A step still ahead
 * is plain text: the steps build on each other, one new thing at a time. Practice has no pass or fail and never opens or
 * passes anything.
 */
import type { JSX } from 'preact';
import { Check, ChevronRight, Repeat } from 'lucide-preact';
import type { LessonDef, LessonProgress } from '../../lessons/types';
import { GoodTries } from './GoodTries';

export type StepState = 'done' | 'now' | 'ahead';

/**
 * A step's state: the one being practised now (`now`: the first step not done, or after a missed check the step to go
 * back to, which may be done already), done, or still ahead. A passed lesson has no "now": every step is open.
 */
export function stepState(progress: LessonProgress, index: number, now: number = progress.currentStep): StepState {
  if (!progress.passed && index === now) return 'now';
  if (progress.steps[index]?.done) return 'done';
  return 'ahead';
}

export interface PracticePartProps {
  lesson: LessonDef;
  progress: LessonProgress;
  /** The step marked Now (model.ts nowStep); default the first step not done. */
  now?: number;
  /** The singer has tried something in this lesson (it is past Learn): the current step reads "Now", else "Next". */
  started: boolean;
  /** Open the practice of step `index` (the Sing screen, on a practice try). */
  onPractise: (index: number) => void;
  headingId: string;
}

/**
 * What the step's corner says: "Now" on the current step ("Next" before the first try, while Learn is the part the
 * singer is at), "Again" on a done one, "Practise" on any other step of a passed lesson.
 */
function Corner(props: { state: StepState; open: boolean; current: string }): JSX.Element | null {
  if (props.state === 'now') {
    return (
      <span class="pl-step__now" aria-hidden="true">
        {props.current}
      </span>
    );
  }
  if (!props.open) return null;
  return props.state === 'done' ? (
    <span class="pl-step__go">
      <Repeat size={16} strokeWidth={2} aria-hidden="true" />
      Again
    </span>
  ) : (
    <span class="pl-step__go">
      Practise
      <ChevronRight size={16} strokeWidth={2} aria-hidden="true" />
    </span>
  );
}

export function PracticePart(props: PracticePartProps): JSX.Element {
  const { lesson, progress, started, onPractise, headingId } = props;
  const now = props.now ?? progress.currentStep;
  const current = started ? 'Now' : 'Next';
  const words: Readonly<Record<StepState, string>> = { done: 'done', now: current.toLowerCase(), ahead: 'still ahead' };
  return (
    <>
      <h3 class="pl-part__heading" id={headingId}>
        <span class="pl-part__title">Practise</span>
      </h3>
      <p class="pl-body-s pl-muted pl-prose">Short tries with no pass or fail. The app plays it first, then it is your turn. A step is done after a few good tries.</p>
      <ol class={`pl-steps${progress.passed ? ' pl-steps--open' : ''}`} aria-label="Practice steps">
        {lesson.practice.map((step, i) => {
          const state = stepState(progress, i, now);
          const counts = progress.steps[i] ?? { good: 0, needed: step.goodTries, done: false };
          // The step being practised now, a done step, and every step of a passed lesson can be tapped; a step still
          // ahead waits for the ones before it.
          const open = state !== 'ahead' || progress.passed;
          const content = (
            <>
              <span class="pl-step__mark" aria-hidden="true">
                {counts.done ? <Check size={16} strokeWidth={2.5} /> : i + 1}
              </span>
              <span class="pl-step__body">
                <span class="pl-step__top">
                  <span class="pl-step__title">
                    <span class="pl-visually-hidden">{`Step ${i + 1}, ${words[state]}: `}</span>
                    {step.title}
                  </span>
                  <Corner state={state} open={open} current={current} />
                </span>
                <span class="pl-step__ask">{step.ask}</span>
                <GoodTries good={counts.good} needed={counts.needed} />
              </span>
            </>
          );
          return (
            <li key={step.exerciseId} class={`pl-step pl-step--${state}`} data-testid={`step-${i}`} data-state={state}>
              {open ? (
                <button type="button" class="pl-step__row" onClick={() => onPractise(i)} data-testid={`step-${i}-practise`}>
                  {content}
                </button>
              ) : (
                <div class="pl-step__row">{content}</div>
              )}
            </li>
          );
        })}
      </ol>
    </>
  );
}
