/**
 * ScoreReveal: the report's one celebratory moment (docs/DESIGN.md §9, §13.5). The 160 px score ring counts up to the
 * score over 600 ms; after a pass the three tally lights then light in sequence, 120 ms apart. A take that did not
 * pass gets the count-up and its tally as they are, with no sequence. Reduced motion shows the finished state at once.
 */
import type { JSX } from 'preact';
import { ScoreRing } from '../components/ScoreRing';
import { TallyLights } from '../components/TallyLights';
import { percent } from './copy';
import { prefersReducedMotion, useCountUp, useStaggeredCount } from './motion';

const COUNT_UP_MS = 600;
const LIGHT_STEP_MS = 120;

export interface ScoreRevealProps {
  /** 0..1. */
  score: number;
  /** Tally lights earned by this take, 0..3. */
  tally: number;
  /** Passed: the lights light in sequence after the ring. */
  celebrate: boolean;
  /** 'neutral' for a miss (never alarm colours), 'muted' for a take that was not judged. */
  tone: 'accent' | 'neutral' | 'muted';
}

export function ScoreReveal(props: ScoreRevealProps): JSX.Element {
  const animate = !prefersReducedMotion();
  const shown = useCountUp(props.score, COUNT_UP_MS, animate);
  const lit = useStaggeredCount(props.tally, COUNT_UP_MS, LIGHT_STEP_MS, animate && props.celebrate);
  return (
    <div class={`pl-reveal pl-reveal--${props.tone}`} data-testid="score-reveal">
      <ScoreRing value={shown} size={160} stroke={12} label={`Score ${percent(props.score)}`}>
        <span class="pl-readout-l" aria-hidden="true">
          {percent(shown)}
        </span>
      </ScoreRing>
      <TallyLights class="pl-reveal__tally" lit={lit} />
    </div>
  );
}
