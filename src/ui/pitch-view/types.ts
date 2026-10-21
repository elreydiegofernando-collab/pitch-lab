import type { PitchFrame, TargetNote } from '../../core/types';

export type MarkerKind = 'crack' | 'onset' | 'info';

export interface PitchViewOptions {
  /** Seconds of history visible left of the "now" line. */
  pastSeconds?: number;
  /** Seconds of upcoming targets visible right of the "now" line (song mode / exercises). */
  futureSeconds?: number;
  /** Initial visible range, fractional MIDI. */
  lowMidi?: number;
  highMidi?: number;
  /** Follow the voice vertically (free singing). */
  autoRange?: boolean;
  showNoteNames?: boolean;
  notation?: 'sharps' | 'flats';
  /** Disable smooth scrolling animation niceties when the user prefers reduced motion. */
  reducedMotion?: boolean;
}

/**
 * Real-time scrolling pitch display (Canvas 2D, vanilla TS, no framework).
 * Must hold 60 fps on an iPhone: no per-frame allocations, DPR capped, static
 * grid on its own layer. Draws the display-smoothed line; analyzers never see
 * the smoothed values.
 */
export interface PitchView {
  /** Feed every frame from the engine (call from the engine's onFrame). */
  pushFrame(frame: PitchFrame): void;
  setRange(lowMidi: number, highMidi: number): void;
  setAutoRange(on: boolean): void;
  /**
   * Target bars. `origin` is the AudioContext input-timeline time that
   * corresponds to take time 0 (i.e. scheduled downbeat + round-trip latency).
   */
  setTargets(notes: readonly TargetNote[], origin: number): void;
  /** Tolerance band drawn around target bars, +/- cents. */
  setToleranceCents(cents: number): void;
  /** Shade a +/- cents band around the current target (vibrato meter). Null to hide. */
  setVibratoZone(zone: { minExtentCents: number; maxExtentCents: number } | null): void;
  addMarker(t: number, kind: MarkerKind, label?: string): void;
  clear(): void;
  setOptions(opts: Partial<PitchViewOptions>): void;
  /** Begin/stop the rAF loop (stop when hidden to save battery). */
  start(): void;
  stop(): void;
  /** Measured render rate over the last second (Diagnostics). */
  readonly fps: number;
  destroy(): void;
}
