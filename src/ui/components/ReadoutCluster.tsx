/**
 * ReadoutCluster: note name, the cents gauge, Hz and dB. The single
 * subscriber to engine.onFrame lives here; it throttles to one DOM write per
 * animation frame and never touches Preact state (docs/ARCHITECTURE.md
 * performance rules) so it stays cheap at ~94 frames/second.
 */
import { useEffect, useRef } from 'preact/hooks';
import type { JSX } from 'preact';
import type { AudioEngine } from '../../audio/engine-types';
import type { PitchFrame } from '../../core/types';
import { noteName, type Notation } from '../../core/music';
import { CentsGauge, type CentsGaugeHandle } from './CentsGauge';

export interface ReadoutClusterProps {
  engine: AudioEngine;
  toleranceCents?: number;
  notation?: Notation;
  class?: string;
}

const UNSET = '––';

export function ReadoutCluster(props: ReadoutClusterProps): JSX.Element {
  const { engine, toleranceCents = 25, notation = 'sharps', class: className } = props;

  const noteRef = useRef<HTMLSpanElement>(null);
  const hzRef = useRef<HTMLSpanElement>(null);
  const dbRef = useRef<HTMLSpanElement>(null);
  const gaugeRef = useRef<CentsGaugeHandle>(null);
  const pendingFrame = useRef<PitchFrame | null>(null);
  const rafHandle = useRef<number | null>(null);

  useEffect(() => {
    function paint(): void {
      rafHandle.current = null;
      const frame = pendingFrame.current;
      if (!frame) return;

      if (noteRef.current) {
        noteRef.current.textContent = frame.voiced ? noteName(frame.midi, notation) : '–';
      }
      if (hzRef.current) {
        hzRef.current.textContent = frame.voiced ? frame.f0Hz.toFixed(1) : UNSET;
      }
      if (dbRef.current) {
        dbRef.current.textContent = frame.rmsDb.toFixed(0);
      }
      const cents = frame.voiced ? frame.centsFromNearest : NaN;
      gaugeRef.current?.update(cents, frame.voiced && Math.abs(cents) <= toleranceCents);
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

  return (
    <div class={['pl-readouts', className ?? ''].filter(Boolean).join(' ')}>
      <div class="pl-readouts__note">
        <span class="pl-label">Note</span>
        <span ref={noteRef} class="pl-readout-xl pl-readouts__note-value" data-testid="live-note">
          {'–'}
        </span>
      </div>
      <div class="pl-readouts__gauge">
        <CentsGauge ref={gaugeRef} toleranceCents={toleranceCents} testId="live-cents" />
      </div>
      <div class="pl-readouts__meters">
        <span class="pl-readouts__meter">
          <span ref={hzRef} class="pl-data" data-testid="live-hz">
            {UNSET}
          </span>
          <span class="pl-readouts__meter-unit">Hz</span>
        </span>
        <span class="pl-readouts__meter">
          <span ref={dbRef} class="pl-data" data-testid="live-db">
            {UNSET}
          </span>
          <span class="pl-readouts__meter-unit">dB</span>
        </span>
      </div>
    </div>
  );
}
