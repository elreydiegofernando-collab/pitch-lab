/**
 * ReadoutCluster: the note name and the gauge, in plain words (owner, 2026-10-23: no cents, Hz or dB in the main view).
 * The note is the letter the voice is nearest to, and the gauge says "On it", "A little high" or "A little low". The
 * numbers (pitch in Hz, loudness in dB, the distance in cents) appear only on request: `details`, which the Live screen
 * turns on from its small Details toggle (`onDetailsChange`). The single subscriber to engine.onFrame lives here; it
 * throttles to one DOM write per animation frame and never touches Preact state (docs/ARCHITECTURE.md performance rules)
 * so it stays cheap at ~94 frames/second.
 *
 * With `targetAt` (the Sing screen, during a take) the gauge reads the voice against the note being asked for, not the
 * nearest one, so it agrees with the live hint and the bars ("Too low" a whole step under it); it shows nothing while
 * nothing is asked, and neither it nor the note name reads the voice while the app plays a note.
 */
import { useEffect, useRef } from 'preact/hooks';
import type { JSX } from 'preact';
import { ChevronDown, ChevronUp } from 'lucide-preact';
import type { AudioEngine } from '../../audio/engine-types';
import type { PitchFrame } from '../../core/types';
import { noteName, type Notation } from '../../core/music';
import { Term } from '../teach/Term';
import { CentsGauge, type CentsGaugeHandle } from './CentsGauge';

export interface ReadoutClusterProps {
  engine: AudioEngine;
  toleranceCents?: number;
  notation?: Notation;
  /** Show the numbers under the words (pitch in Hz, loudness in dB, the distance in cents). Off unless a screen turns it on. */
  details?: boolean;
  /** Offers the small Details toggle, and is called with the next state when it is tapped. Without it there is no toggle. */
  onDetailsChange?: (next: boolean) => void;
  /**
   * What the voice is measured against at a frame's time (engine seconds): the note asked for (MIDI), 'listen' while the
   * app plays a note (nothing is read), or null when nothing is asked (the gauge shows nothing). Without it the gauge
   * reads the nearest note (free singing). Read on every frame, so a new function each render costs nothing.
   */
  targetAt?: (frameT: number) => number | 'listen' | null;
  class?: string;
}

const UNSET = '––';

export function ReadoutCluster(props: ReadoutClusterProps): JSX.Element {
  const { engine, toleranceCents = 25, notation = 'sharps', details = false, onDetailsChange, class: className } = props;

  const noteRef = useRef<HTMLSpanElement>(null);
  const hzRef = useRef<HTMLSpanElement>(null);
  const dbRef = useRef<HTMLSpanElement>(null);
  const gaugeRef = useRef<CentsGaugeHandle>(null);
  const pendingFrame = useRef<PitchFrame | null>(null);
  const rafHandle = useRef<number | null>(null);
  // The latest target reader, read at paint time: a screen may hand a new one each render without re-subscribing.
  const targetRef = useRef(props.targetAt);
  targetRef.current = props.targetAt;

  useEffect(() => {
    function paint(): void {
      rafHandle.current = null;
      const frame = pendingFrame.current;
      if (!frame) return;
      const target = targetRef.current ? targetRef.current(frame.t) : undefined;

      if (noteRef.current) {
        // While the app plays a note the microphone may hear the app, not the singer: no name is read then.
        noteRef.current.textContent = frame.voiced && target !== 'listen' ? noteName(frame.midi, notation) : '–';
      }
      // The numbers exist only while Details is open: closed, there is nothing to write.
      if (hzRef.current) {
        hzRef.current.textContent = frame.voiced ? frame.f0Hz.toFixed(1) : UNSET;
      }
      if (dbRef.current) {
        dbRef.current.textContent = frame.rmsDb.toFixed(0);
      }
      // Against the note asked for when there is a target reader (nothing when none is asked), else the nearest note.
      const cents = !frame.voiced ? NaN : target === undefined ? frame.centsFromNearest : typeof target === 'number' ? (frame.midi - target) * 100 : NaN;
      // The frame's time lets the gauge hold its words a moment, so a voice at the edge of the zone does not flicker them.
      gaugeRef.current?.update(cents, Number.isFinite(cents) && Math.abs(cents) <= toleranceCents, frame.t);
    }

    function onFrame(frame: PitchFrame): void {
      pendingFrame.current = frame;
      if (rafHandle.current === null) {
        rafHandle.current = requestAnimationFrame(paint);
      }
    }

    const unsubscribe = engine.onFrame(onFrame);
    return () => {
      unsubscribe();
      if (rafHandle.current !== null) cancelAnimationFrame(rafHandle.current);
    };
  }, [engine, notation, toleranceCents]);

  const classes = [
    'pl-readouts',
    onDetailsChange ? 'pl-readouts--has-details' : '',
    details ? 'pl-readouts--details' : '',
    className ?? '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div class={classes}>
      <div class="pl-readouts__note">
        <span class="pl-label">
          <Term id="note">Note</Term>
        </span>
        <span ref={noteRef} class="pl-readout-xl pl-readouts__note-value" data-testid="live-note">
          {'–'}
        </span>
      </div>
      <div class="pl-readouts__gauge">
        <CentsGauge ref={gaugeRef} toleranceCents={toleranceCents} testId="live-pitch" numbers={details} numbersTestId="live-cents" />
      </div>
      {onDetailsChange ? (
        <button
          type="button"
          class="pl-readouts__details-btn"
          aria-pressed={details}
          data-testid="live-details-toggle"
          onClick={() => onDetailsChange(!details)}
        >
          <span class="pl-readouts__details-pill">
            Details
            {details ? <ChevronUp size={14} strokeWidth={2.5} aria-hidden="true" /> : <ChevronDown size={14} strokeWidth={2.5} aria-hidden="true" />}
          </span>
        </button>
      ) : null}
      {details ? (
        <div class="pl-readouts__details" data-testid="live-details">
          <span class="pl-readouts__detail">
            <span class="pl-readouts__detail-name">Pitch</span>
            <span ref={hzRef} class="pl-data" data-testid="live-hz">
              {UNSET}
            </span>
            <span class="pl-readouts__meter-unit">Hz</span>
          </span>
          <span class="pl-readouts__detail">
            <span class="pl-readouts__detail-name">Loudness</span>
            <span ref={dbRef} class="pl-data" data-testid="live-db">
              {UNSET}
            </span>
            <span class="pl-readouts__meter-unit">dB</span>
          </span>
        </div>
      ) : null}
    </div>
  );
}
