/**
 * TraceReplay: a static canvas of a take (docs/DESIGN.md §13.5) or, without a take, a calm preview of the material
 * (the Sing screen's ready state). The report shows the targets, the sung trace (blue inside the band, orange outside),
 * crack ticks and the per-note run verdict glyphs; a legend under it names every shape and counts them, so nothing is
 * colour-only and the counts are the text alternative. Runs packed tighter than a glyph widen the canvas, which then
 * scrolls inside its own row. Repaints on resize and theme change; DPR is capped at 2 and there is no shadowBlur.
 */
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { JSX } from 'preact';
import type { CrackEvent, RunNoteVerdict, RunResult } from '../../analysis/types';
import { cleanOctaveSpikes } from '../../analysis/track';
import { noteName, type Notation } from '../../core/music';
import type { PitchFrame, TargetNote } from '../../core/types';
import { midiToY } from '../pitch-view/geometry';
import { drawReplay, readReplayPalette } from './draw-replay';
import {
  REPLAY_LEAD_SEC,
  REPLAY_TAIL_SEC,
  fitPitchWindow,
  minRunGapSec,
  pickLabelMidis,
  replayLayout,
  runGlyphs,
  traceSegments,
  verdictCounts,
  type PitchWindow,
} from './replay-geometry';
import { useElementSize } from './use-size';

/** Height of the report's replay (docs/DESIGN.md §13.5). */
export const REPLAY_HEIGHT = 160;
/** Width of the note-name column beside the report's replay. */
const GUTTER_WIDTH = 44;
const PAD_LEFT = 8;
const PAD_RIGHT = 12;
const PREVIEW_PAD_RIGHT = 12;
/** Names are at least this far apart (px). */
const LABEL_HEIGHT = 16;
/** iOS caps a canvas backing store at about 4096 pixels a side. */
const MAX_BACKING_PX = 4096;
const MAX_DPR = 2;
/** The scroll row opens this far before its first run note (px). */
const RUN_LEAD_PX = 48;

export interface RunScore {
  notes: readonly TargetNote[];
  result: RunResult;
}

export interface TraceReplayProps {
  /** 'report' (default) is the standalone replay; 'preview' paints targets only, over the live view's lanes. */
  mode?: 'report' | 'preview';
  /** Sung targets, take-relative seconds. */
  notes: readonly TargetNote[];
  /** Length of the material from the downbeat (RealizedExercise.totalSec). */
  totalSec: number;
  toleranceCents: number;
  /** The take, take-relative. Omit for a preview. */
  track?: readonly PitchFrame[];
  cracks?: readonly CrackEvent[];
  runs?: readonly RunScore[];
  /** Preview: the live view's own pitch window, so the bars sit on its lanes. */
  window?: PitchWindow;
  /** Preview: width of the live view's note-name column. */
  padLeft?: number;
  notation?: Notation;
}

/** Backing-store scale: the device ratio, at most 2, and small enough for the widest canvas iOS allows. */
export function backingScale(cssWidth: number, cssHeight: number, devicePixelRatio: number): number {
  const wanted = Math.min(devicePixelRatio > 0 ? devicePixelRatio : 1, MAX_DPR);
  return Math.min(wanted, MAX_BACKING_PX / Math.max(cssWidth, cssHeight, 1));
}

function VerdictGlyph(props: { verdict: RunNoteVerdict }): JSX.Element {
  const { verdict } = props;
  return (
    <svg class="pl-replay__glyph" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      {verdict === 'defined' ? <circle cx="8" cy="8" r="5.5" fill="var(--good)" /> : null}
      {verdict === 'smeared' ? (
        <>
          <circle cx="8" cy="8" r="5" fill="none" stroke="var(--meh)" stroke-width="1.5" />
          <path d="M8 3a5 5 0 0 0 0 10z" fill="var(--meh)" />
        </>
      ) : null}
      {verdict === 'missed' ? <path d="M3.5 3.5l9 9M12.5 3.5l-9 9" stroke="var(--alert)" stroke-width="2" stroke-linecap="round" /> : null}
    </svg>
  );
}

function CrackGlyph(): JSX.Element {
  return (
    <svg class="pl-replay__glyph" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path d="M2 8l3.5-5 3 10L12 8" fill="none" stroke="var(--alert)" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
    </svg>
  );
}

export function TraceReplay(props: TraceReplayProps): JSX.Element {
  const { notes, totalSec, toleranceCents } = props;
  const preview = props.mode === 'preview';
  const notation = props.notation ?? 'sharps';
  const [hostRef, host] = useElementSize<HTMLDivElement>();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const openedAtRun = useRef(false);
  const [themeEpoch, setThemeEpoch] = useState(0);

  const cleaned = useMemo(() => (props.track ? cleanOctaveSpikes(props.track) : []), [props.track]);
  const segments = useMemo(() => traceSegments(cleaned, notes, toleranceCents), [cleaned, notes, toleranceCents]);
  const glyphs = useMemo(() => runGlyphs(props.runs ?? []), [props.runs]);
  const fitted = useMemo(() => fitPitchWindow(notes, cleaned), [notes, cleaned]);
  const win = props.window ?? fitted;
  const cracks = props.cracks ?? [];

  const height = preview ? host.h : REPLAY_HEIGHT;
  const padLeft = preview ? (props.padLeft ?? 0) : PAD_LEFT;
  const t0 = preview ? 0 : -REPLAY_LEAD_SEC;
  const spanSec = preview ? totalSec : totalSec + REPLAY_LEAD_SEC + REPLAY_TAIL_SEC;
  const layout = useMemo(
    () =>
      replayLayout({
        spanSec,
        hostWidth: host.w,
        padLeft,
        padRight: preview ? PREVIEW_PAD_RIGHT : PAD_RIGHT,
        minGapSec: preview ? null : minRunGapSec(props.runs ?? []),
      }),
    [spanSec, host.w, padLeft, preview, props.runs],
  );
  const canvasWidth = preview ? host.w : layout.width;

  // Repaint when the theme flips: the palette is read from the CSS tokens.
  useEffect(() => {
    if (typeof MutationObserver !== 'function') return undefined;
    const observer = new MutationObserver(() => setThemeEpoch((n) => n + 1));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || host.w < 1 || canvasWidth < 1 || height < 1) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const scale = backingScale(canvasWidth, height, typeof devicePixelRatio === 'number' ? devicePixelRatio : 1);
    const backingW = Math.max(1, Math.round(canvasWidth * scale));
    const backingH = Math.max(1, Math.round(height * scale));
    if (canvas.width !== backingW) canvas.width = backingW;
    if (canvas.height !== backingH) canvas.height = backingH;
    canvas.style.width = `${canvasWidth}px`;
    canvas.style.height = `${height}px`;
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    drawReplay(ctx, {
      width: canvasWidth,
      height,
      window: win,
      t0,
      pxPerSec: layout.pxPerSec,
      padLeft,
      lanes: !preview,
      preview,
      notes,
      toleranceCents,
      segments,
      cracks,
      glyphs,
      palette: readReplayPalette(),
    });
  }, [host.w, canvasWidth, height, win, t0, layout, padLeft, preview, notes, toleranceCents, segments, cracks, glyphs, themeEpoch]);

  // A run replay opens at its first run, not at the count-in.
  useEffect(() => {
    const scroller = hostRef.current;
    if (preview || !scroller || !layout.scrolls || openedAtRun.current || glyphs.length === 0) return;
    openedAtRun.current = true;
    scroller.scrollLeft = Math.max(0, padLeft + (glyphs[0].t - t0) * layout.pxPerSec - RUN_LEAD_PX);
  }, [hostRef, preview, layout, glyphs, padLeft, t0]);

  if (preview) {
    return (
      <div ref={hostRef} class="pl-replay pl-replay--preview" aria-hidden="true">
        <canvas ref={canvasRef} />
      </div>
    );
  }

  const labelMidis = pickLabelMidis(notes, win, REPLAY_HEIGHT, LABEL_HEIGHT);
  const counts = verdictCounts(glyphs);
  const label = `Replay of your take against ${notes.length} target ${notes.length === 1 ? 'note' : 'notes'}`;

  return (
    <figure class="pl-replay">
      <div class="pl-replay__frame">
        <div class="pl-replay__gutter" aria-hidden="true" style={{ width: `${GUTTER_WIDTH}px`, height: `${REPLAY_HEIGHT}px` }}>
          {labelMidis.map((m) => (
            <span
              key={m}
              class={`pl-replay__note${((m % 12) + 12) % 12 === 0 ? ' pl-replay__note--c' : ''}`}
              style={{ top: `${midiToY(m, win.low, win.high, REPLAY_HEIGHT) - LABEL_HEIGHT / 2}px` }}
            >
              {noteName(m, notation)}
            </span>
          ))}
        </div>
        <div
          ref={hostRef}
          class="pl-replay__scroll"
          tabIndex={layout.scrolls ? 0 : undefined}
          role={layout.scrolls ? 'region' : undefined}
          aria-label={layout.scrolls ? 'Take replay, scrolls sideways' : undefined}
        >
          <canvas ref={canvasRef} role="img" aria-label={label} />
        </div>
      </div>
      <figcaption class="pl-replay__legend">
        {segments.length > 0 ? (
          <ul class="pl-replay__keys">
            <li>
              <span class="pl-replay__swatch pl-replay__swatch--on" aria-hidden="true" />
              In the band
            </li>
            <li>
              <span class="pl-replay__swatch pl-replay__swatch--off" aria-hidden="true" />
              Outside the band
            </li>
            {cracks.length > 0 ? (
              <li>
                <CrackGlyph />
                {cracks.length} {cracks.length === 1 ? 'crack' : 'cracks'} marked
              </li>
            ) : null}
            {glyphs.length > 0
              ? (['defined', 'smeared', 'missed'] as const).map((v) => (
                  <li key={v}>
                    <VerdictGlyph verdict={v} />
                    {counts[v]} {v}
                  </li>
                ))
              : null}
          </ul>
        ) : (
          <p class="pl-body-s pl-muted">No sung pitch was picked up in this take.</p>
        )}
        {layout.scrolls ? <p class="pl-body-s pl-muted">Scroll sideways to follow every note.</p> : null}
      </figcaption>
    </figure>
  );
}
