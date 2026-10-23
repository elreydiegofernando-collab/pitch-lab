/**
 * The top of a practice try's report (docs/DESIGN.md 13.3, "The practice report"): calm, because practice is not a
 * test. "Good try" or "Not quite yet" with a glyph (never colour alone), the step it was ("Lesson 5 · Step 2 of 4:
 * Echo one note"), the step's good tries as dots and words, and a line when this try finished the step. No score ring
 * and no metric tiles. The verdict heading takes the focus when the report opens (Report.tsx), so it is read out.
 */
import type { JSX } from 'preact';
import { CircleCheck, Info, MicOff, RotateCcw } from 'lucide-preact';
import { GoodTries } from './GoodTries';
import { drillNextLine, type DrillSummary } from './drill';

const GLYPHS = { good: CircleCheck, 'not-yet': RotateCcw, silent: MicOff, 'not-judged': Info } as const;

/** "Lesson 5 · Step 2 of 4: Echo one note, 2 seconds". */
export function drillCaption(summary: Pick<DrillSummary, 'lessonName' | 'step' | 'stepCount' | 'practice'>): string {
  const where = `Step ${summary.step + 1} of ${summary.stepCount}`;
  const step = summary.practice ? `${where}: ${summary.practice.title}` : where;
  return summary.lessonName ? `${summary.lessonName} · ${step}` : step;
}

export function DrillVerdict(props: { summary: DrillSummary }): JSX.Element {
  const { summary } = props;
  const { kind, word, reason } = summary.verdict;
  const Glyph = GLYPHS[kind];
  const next = drillNextLine(summary);
  return (
    <header class={`pl-verdict pl-drill pl-drill--${kind}`} data-testid="drill-verdict">
      <div class="pl-verdict__line">
        <Glyph size={28} strokeWidth={2} aria-hidden="true" />
        <h2 class="pl-display-m" data-testid="verdict" tabIndex={-1}>
          {word}
        </h2>
      </div>
      <p class="pl-body-s pl-muted" data-testid="drill-step">
        {drillCaption(summary)}
      </p>
      {reason ? (
        <p class="pl-body-s" data-testid="verdict-reason">
          {reason}
        </p>
      ) : null}
      <GoodTries good={summary.goodTries} needed={summary.needed} class="pl-drill__tries" />
      {next ? (
        <p class="pl-body-s pl-drill__next" data-testid="drill-next">
          {next}
        </p>
      ) : null}
    </header>
  );
}
