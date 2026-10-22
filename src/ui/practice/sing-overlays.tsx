/**
 * The small things laid over the Sing screen's canvas (docs/DESIGN.md §13.4): the count-in beat counter, the cue pill,
 * the 2 px progress hairline and the context chip. Each one reads its own runner signal, so a cue change or a beat
 * re-renders only that piece, and the hairline writes `transform` straight to its element (no re-render at all).
 */
import { useEffect, useRef } from 'preact/hooks';
import type { JSX } from 'preact';
import { effect, type ReadonlySignal } from '@preact/signals';
import { clamp01 } from '../../core/math';

export interface CountInOverlayProps {
  /** Beats still to come (the runner's countIn): 3, 2, 1. Null hides the overlay. */
  beat: number | null;
  /** How many beats the whole count-in has (the exercise's countInBeats), so "4 · 3 · 2 · 1" shows every number. */
  beats: number;
}

/** The sequence shown for a count-in: the whole count, largest first. */
export function countInSequence(beat: number, beats: number): number[] {
  const total = Math.max(Math.floor(beats), Math.floor(beat), 1);
  return Array.from({ length: total }, (_, i) => total - i);
}

export function CountInOverlay(props: CountInOverlayProps): JSX.Element | null {
  const { beat } = props;
  if (beat === null) return null;
  const sequence = countInSequence(beat, props.beats);
  return (
    <div class="pl-count-in" data-testid="count-in">
      <div class="pl-count-in__panel">
        <ol class="pl-count-in__row" aria-hidden="true">
          {sequence.map((n, i) => (
            <li key={n} class={`pl-count-in__beat${n === beat ? ' pl-count-in__beat--now' : n > beat ? ' pl-count-in__beat--gone' : ''}`}>
              {i > 0 ? <span class="pl-count-in__dot">·</span> : null}
              <span class="pl-readout-xl pl-tabular">{n}</span>
            </li>
          ))}
        </ol>
        <p class="pl-visually-hidden" role="status" aria-live="polite">
          Count-in, {beat}
        </p>
      </div>
    </div>
  );
}

/** Cues longer than this read as a sentence, not as a stage label. */
const SHORT_CUE_CHARS = 14;

export function CuePill(props: { cue: string | null }): JSX.Element | null {
  const { cue } = props;
  if (!cue) return null;
  return (
    <div class={`pl-cue-pill${cue.length > SHORT_CUE_CHARS ? ' pl-cue-pill--sentence' : ''}`} data-testid="cue-pill" role="status">
      {cue}
    </div>
  );
}

/** The 2 px amber line across the top of the canvas: how far through the take. */
export function ProgressHairline(props: { progress: ReadonlySignal<number | null> }): JSX.Element {
  const barRef = useRef<HTMLDivElement>(null);
  useEffect(
    () =>
      effect(() => {
        const p = props.progress.value;
        const bar = barRef.current;
        if (!bar) return;
        bar.style.transform = `scaleX(${p === null ? 0 : clamp01(p)})`;
        bar.style.opacity = p === null ? '0' : '1';
      }),
    [props.progress],
  );
  return (
    <div class="pl-hairline" aria-hidden="true">
      <div ref={barRef} class="pl-hairline__bar" data-testid="progress-hairline" />
    </div>
  );
}

export function ContextChip(props: { text: string | null }): JSX.Element | null {
  if (!props.text) return null;
  return (
    <div class="pl-pchip pl-context-chip" data-testid="context-chip">
      {props.text}
    </div>
  );
}
