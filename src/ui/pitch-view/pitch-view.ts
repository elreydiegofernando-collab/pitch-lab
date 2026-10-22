/**
 * The live pitch display (docs/DESIGN.md §8): a scrolling piano-roll of
 * semitone lanes with the smoothed pitch trace, an amber now-line, and
 * (when an exercise sets them) target bars whose height is the tolerance
 * band. Main-thread Canvas 2D, two layers (static grid + dynamic trace),
 * zero allocation in `pushFrame` and the render loop. See docs/ARCHITECTURE.md
 * "Performance rules" and docs/DESIGN.md §8 for the full visual spec.
 */
import type { PitchFrame, TargetNote } from '../../core/types';
import { CONFIG } from '../../config';
import type { MarkerKind, PitchView, PitchViewOptions } from './types';
import { createSmoother, type Smoother } from './smoother';
import { createTrackRing, defaultTrackRingCapacity, type TrackRing } from './track-ring';
import { createScrollClock, type ScrollClock } from './clock';
import { decideAutoRange, midiToY, showsLaneLabel, tToX, updateLanes, type Lane, type TimeAxis } from './geometry';

// ---------------------------------------------------------------- tunables local to the view

/** Trace stroke widths (docs/DESIGN.md §8): 3px core, 8px under-stroke glow at 14% alpha. */
const CORE_WIDTH = 3;
const GLOW_WIDTH = 8;
const GLOW_ALPHA = 0.14;
const TARGET_IDLE_FILL_ALPHA = 0.08;
const TARGET_LOCKED_FILL_ALPHA = 0.3;
const VIBRATO_ZONE_FILL_ALPHA = 0.1;
/** A target counts as "locked" only while the latest voiced sample is this fresh. */
const LOCK_STALE_SEC = 0.2;
/** Auto-range re-centre animation; instant under reduced motion. */
const RANGE_TWEEN_SEC = 0.4;
const RANGE_SNAP_EPS = 0.01;
/** iOS caps a canvas backing store at this many pixels per side. */
const MAX_BACKING_PX = 4096;
const RESIZE_DEBOUNCE_MS = 120;
/** Reused (never re-literal'd per frame) dash pattern for the vibrato-zone edges. */
const VIBRATO_DASH: readonly number[] = [4, 3];

const LABEL_PAD_X = 4;
const LABEL_FONT = "600 13px 'Instrument Sans Variable', ui-sans-serif, system-ui, sans-serif";

type ColorKey =
  | 'bg0'
  | 'laneNatural'
  | 'laneAccidental'
  | 'line'
  | 'textHi'
  | 'textMid'
  | 'textLo'
  | 'tally'
  | 'on'
  | 'off'
  | 'alert';

const COLOR_VAR: Record<ColorKey, string> = {
  bg0: '--bg-0',
  laneNatural: '--lane-natural',
  laneAccidental: '--lane-accidental',
  line: '--line',
  textHi: '--text-hi',
  textMid: '--text-mid',
  textLo: '--text-lo',
  tally: '--tally',
  on: '--on',
  off: '--off',
  alert: '--alert',
};

const COLOR_FALLBACK: Record<ColorKey, string> = {
  bg0: '#0E0F13',
  laneNatural: '#13151B',
  laneAccidental: '#0B0C10',
  line: '#2A2E39',
  textHi: '#F2EFE8',
  textMid: '#AEB4BF',
  textLo: '#858C99',
  tally: '#FFB224',
  on: '#56B4E9',
  off: '#E69F00',
  alert: '#E8743B',
};

/** Precomputed colour strings, refreshed once per theme change (never per frame). */
interface Palette {
  bg0: string;
  laneNatural: string;
  laneAccidental: string;
  line: string;
  textHi: string;
  textMid: string;
  textLo: string;
  tally: string;
  on: string;
  off: string;
  alert: string;
  // Derived, with alpha baked in.
  onGlow: string;
  offGlow: string;
  textHiGlow: string;
  onFillLocked: string;
  textHiFillIdle: string;
  onZoneFill: string;
}

function hexToRgbTriplet(hex: string): string {
  let h = hex.trim();
  if (h.startsWith('#')) h = h.slice(1);
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  const num = Number.parseInt(h, 16);
  if (!Number.isFinite(num)) return '255, 255, 255';
  return `${(num >> 16) & 255}, ${(num >> 8) & 255}, ${num & 255}`;
}

function rgba(hex: string, alpha: number): string {
  return `rgba(${hexToRgbTriplet(hex)}, ${alpha})`;
}

function readPalette(): Palette {
  const cs = typeof getComputedStyle === 'function' ? getComputedStyle(document.documentElement) : null;
  const read = (key: ColorKey): string => {
    const raw = cs?.getPropertyValue(COLOR_VAR[key]).trim();
    return raw && raw.length > 0 ? raw : COLOR_FALLBACK[key];
  };
  const bg0 = read('bg0');
  const laneNatural = read('laneNatural');
  const laneAccidental = read('laneAccidental');
  const line = read('line');
  const textHi = read('textHi');
  const textMid = read('textMid');
  const textLo = read('textLo');
  const tally = read('tally');
  const on = read('on');
  const off = read('off');
  const alert = read('alert');
  return {
    bg0,
    laneNatural,
    laneAccidental,
    line,
    textHi,
    textMid,
    textLo,
    tally,
    on,
    off,
    alert,
    onGlow: rgba(on, GLOW_ALPHA),
    offGlow: rgba(off, GLOW_ALPHA),
    textHiGlow: rgba(textHi, GLOW_ALPHA),
    onFillLocked: rgba(on, TARGET_LOCKED_FILL_ALPHA),
    textHiFillIdle: rgba(textHi, TARGET_IDLE_FILL_ALPHA),
    onZoneFill: rgba(on, VIBRATO_ZONE_FILL_ALPHA),
  };
}

/** Trace colour classification: free singing, in tolerance, or out of tolerance. */
type TraceColor = 0 | 1 | 2;

/** Walks a sorted TargetNote[] forward in lock-step with increasing query times (zero allocation). */
function createTargetCursor() {
  let idx = 0;
  return {
    reset(): void {
      idx = 0;
    },
    /** Target MIDI (interpolated for a glide) active at absolute time `t`, or NaN when none is active. */
    midiAt(t: number, targets: readonly TargetNote[], origin: number): number {
      if (targets.length === 0) return NaN;
      while (idx < targets.length - 1 && origin + targets[idx].end <= t) idx++;
      const note = targets[idx];
      const absStart = origin + note.start;
      const absEnd = origin + note.end;
      if (t < absStart || t >= absEnd) return NaN;
      if (note.toMidi === undefined) return note.midi;
      const frac = absEnd > absStart ? (t - absStart) / (absEnd - absStart) : 1;
      return note.midi + (note.toMidi - note.midi) * Math.min(1, Math.max(0, frac));
    },
  };
}
type TargetCursor = ReturnType<typeof createTargetCursor>;

interface Marker {
  t: number;
  kind: MarkerKind;
  label?: string;
}
/** Markers older than the past window get dropped lazily; this bounds worst-case memory. */
const MAX_MARKERS = 256;

interface VibratoZone {
  minExtentCents: number;
  maxExtentCents: number;
}

export function createPitchView(container: HTMLElement, opts: PitchViewOptions = {}): PitchView {
  // ---------------------------------------------------------------- options & mutable state

  const reducedMotionQuery = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;

  const options = {
    pastSeconds: opts.pastSeconds ?? CONFIG.display.pastSeconds,
    futureSeconds: opts.futureSeconds ?? CONFIG.display.futureSeconds,
    autoRange: opts.autoRange ?? false,
    showNoteNames: opts.showNoteNames ?? true,
    notation: opts.notation ?? 'sharps',
    reducedMotion: opts.reducedMotion ?? reducedMotionQuery?.matches ?? false,
  };

  // Visible pitch range: `range` is what's drawn this frame; `rangeTarget` is what auto-range
  // (or setRange) wants it to become. They're equal except during a recentring tween.
  const initialCentre = ((opts.lowMidi ?? 50) + (opts.highMidi ?? 50 + CONFIG.display.autoRangeSemitones)) / 2;
  const initialSpan = (opts.highMidi ?? initialCentre + CONFIG.display.autoRangeSemitones / 2) -
    (opts.lowMidi ?? initialCentre - CONFIG.display.autoRangeSemitones / 2);
  // Stable objects, mutated in place (never reassigned) so an active auto-range tween doesn't
  // allocate a new {low,high} every rAF.
  const range = {
    low: opts.lowMidi ?? initialCentre - initialSpan / 2,
    high: opts.highMidi ?? initialCentre + initialSpan / 2,
  };
  const rangeTarget = { low: range.low, high: range.high };

  let toleranceCents = CONFIG.tolerance.default;
  let targets: readonly TargetNote[] = [];
  let targetOrigin = 0;
  let vibratoZone: VibratoZone | null = null;
  const markers: Marker[] = [];

  // ---------------------------------------------------------------- DOM

  container.style.position = container.style.position || 'relative';
  container.style.overflow = 'hidden';

  const staticCanvas = document.createElement('canvas');
  const dynamicCanvas = document.createElement('canvas');
  for (const c of [staticCanvas, dynamicCanvas]) {
    c.style.position = 'absolute';
    c.style.inset = '0';
    c.style.width = '100%';
    c.style.height = '100%';
    c.style.display = 'block';
  }
  container.appendChild(staticCanvas);
  container.appendChild(dynamicCanvas);

  const staticCtxOrNull = staticCanvas.getContext('2d', { alpha: false });
  const dynamicCtxOrNull = dynamicCanvas.getContext('2d', { alpha: true });
  if (!staticCtxOrNull || !dynamicCtxOrNull) {
    throw new Error('PitchView: 2D canvas context unavailable');
  }
  // Separate, non-union-typed consts: closures defined below capture these (not the
  // `| null` originals), so every later use stays statically non-null.
  const staticCtx: CanvasRenderingContext2D = staticCtxOrNull;
  const dynamicCtx: CanvasRenderingContext2D = dynamicCtxOrNull;

  // ---------------------------------------------------------------- sizing

  let width = 1;
  let height = 1;
  let lastCssW = -1;
  let lastCssH = -1;
  let staticDirty = true;

  function applyResize(): void {
    const rect = container.getBoundingClientRect();
    const cssW = Math.max(1, Math.round(rect.width));
    const cssH = Math.max(1, Math.round(rect.height));
    if (cssW === lastCssW && cssH === lastCssH) return;
    lastCssW = cssW;
    lastCssH = cssH;
    const rawDpr = Math.min(
      typeof devicePixelRatio === 'number' ? devicePixelRatio : 1,
      CONFIG.display.maxDevicePixelRatio,
    );
    const dpr = Math.min(rawDpr, MAX_BACKING_PX / Math.max(cssW, cssH, 1));
    const bw = Math.max(1, Math.round(cssW * dpr));
    const bh = Math.max(1, Math.round(cssH * dpr));
    for (const canvas of [staticCanvas, dynamicCanvas]) {
      if (canvas.width !== bw) canvas.width = bw;
      if (canvas.height !== bh) canvas.height = bh;
    }
    staticCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    dynamicCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    width = cssW;
    height = cssH;
    staticDirty = true;
    // iOS can blank a canvas across a resize/rotation; repaint immediately rather than
    // waiting for the next rAF (which is stopped while the view isn't running).
    drawStatic();
    renderDynamic(nowPerf());
  }

  let resizeTimer: ReturnType<typeof setTimeout> | null = null;
  function scheduleResize(): void {
    if (resizeTimer !== null) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      resizeTimer = null;
      applyResize();
    }, RESIZE_DEBOUNCE_MS);
  }

  const resizeObserver = typeof ResizeObserver === 'function' ? new ResizeObserver(() => scheduleResize()) : null;
  resizeObserver?.observe(container);
  const onWindowResize = (): void => scheduleResize();
  window.addEventListener('resize', onWindowResize);
  const vv = (typeof window !== 'undefined' ? window.visualViewport : null) ?? null;
  vv?.addEventListener('resize', onWindowResize);

  // ---------------------------------------------------------------- theme

  let colors = readPalette();
  // Trace colour lookups by TraceColor index (0 free / 1 on / 2 off), rebuilt only on a
  // palette refresh so the render loop never allocates an array.
  let traceGlowColors: readonly string[] = [colors.textHiGlow, colors.onGlow, colors.offGlow];
  let traceCoreColors: readonly string[] = [colors.textHi, colors.on, colors.off];
  function refreshPalette(): void {
    colors = readPalette();
    traceGlowColors = [colors.textHiGlow, colors.onGlow, colors.offGlow];
    traceCoreColors = [colors.textHi, colors.on, colors.off];
    staticDirty = true;
    drawStatic();
  }
  const themeObserver =
    typeof MutationObserver === 'function'
      ? new MutationObserver(() => refreshPalette())
      : null;
  themeObserver?.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  const colorSchemeQuery = typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : null;
  const onColorSchemeChange = (): void => refreshPalette();
  colorSchemeQuery?.addEventListener('change', onColorSchemeChange);

  // ---------------------------------------------------------------- hot-path state

  const smoother: Smoother = createSmoother(CONFIG.display.smoothing);
  const ring: TrackRing = createTrackRing(defaultTrackRingCapacity(options.pastSeconds));
  const clock: ScrollClock = createScrollClock({ hopSeconds: CONFIG.audio.hopSeconds });
  const traceCursor: TargetCursor = createTargetCursor();
  const queryCursor: TargetCursor = createTargetCursor();
  // Scratch buffer for the auto-range / vibrato-zone "recent voiced median" (preallocated, reused;
  // sorted in place by medianOfFirstN so no view/array is ever allocated to read it back).
  const medianScratch = new Float32Array(256);
  // Reused time-axis object (mutated in place on resize/option change) and auto-range config
  // (static, built once): avoids an object literal per frame in strokeTracePass/drawTargetBars/
  // drawMarkers/updateAutoRange.
  const axis: TimeAxis = {
    width,
    pastSeconds: options.pastSeconds,
    futureSeconds: options.futureSeconds,
    nowLineFraction: CONFIG.display.nowLineFraction,
  };
  function syncAxis(): void {
    axis.width = width;
    axis.pastSeconds = options.pastSeconds;
    axis.futureSeconds = options.futureSeconds;
  }
  const autoRangeCfg = { span: CONFIG.display.autoRangeSemitones, margin: CONFIG.display.autoRangeMarginSemitones };
  // Persistent static-grid lane buffer, mutated in place by updateLanes() instead of rebuilt:
  // an active auto-range tween sets staticDirty on every rAF frame for RANGE_TWEEN_SEC (see
  // updateAutoRange below), and docs/ARCHITECTURE.md forbids allocation in that loop. `laneCount`
  // is how many of `laneBuf`'s slots are in use this repaint; trailing slots are kept, not freed,
  // for reuse the next time the range widens.
  const laneBuf: Lane[] = [];
  let laneCount = 0;

  function nowPerf(): number {
    return typeof performance !== 'undefined' ? performance.now() : Date.now();
  }

  function pushFrame(frame: PitchFrame): void {
    const displayMidi = smoother.update(frame.midi, frame.t, frame.voiced);
    ring.push(frame.t, displayMidi, frame.voiced);
    clock.onFrame(frame.t, nowPerf());
  }

  // ---------------------------------------------------------------- static layer (grid)

  function drawStatic(): void {
    if (!staticDirty) return;
    const ctx = staticCtx;
    ctx.save();
    ctx.fillStyle = colors.bg0;
    ctx.fillRect(0, 0, width, height);

    laneCount = updateLanes(laneBuf, range.low, range.high, height, options.notation);
    for (let i = 0; i < laneCount; i++) {
      const lane = laneBuf[i];
      ctx.fillStyle = lane.accidental ? colors.laneAccidental : colors.laneNatural;
      ctx.fillRect(0, lane.yTop, width, Math.max(1, lane.yBottom - lane.yTop));
    }

    ctx.strokeStyle = colors.line;
    ctx.lineWidth = 1;
    for (let i = 0; i < laneCount; i++) {
      const lane = laneBuf[i];
      if (!lane.isC) continue;
      ctx.beginPath();
      ctx.moveTo(0, lane.yBottom + 0.5);
      ctx.lineTo(width, lane.yBottom + 0.5);
      ctx.stroke();
    }

    if (options.showNoteNames) {
      ctx.font = LABEL_FONT;
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'left';
      for (let i = 0; i < laneCount; i++) {
        const lane = laneBuf[i];
        if (!showsLaneLabel(lane.midi, lane.yBottom - lane.yTop)) continue;
        ctx.fillStyle = lane.isC ? colors.textHi : colors.textMid;
        ctx.fillText(lane.label, LABEL_PAD_X, (lane.yTop + lane.yBottom) / 2);
      }
    }

    ctx.restore();
    staticDirty = false;
  }

  // ---------------------------------------------------------------- auto-range / vibrato-zone reference

  /** Median display-MIDI of the voiced samples in the last `windowSec`, or NaN. */
  function recentVoicedMedian(tNow: number, windowSec: number): number {
    const fromT = tNow - windowSec;
    let i = ring.lowerBound(fromT);
    const last = ring.latest;
    let n = 0;
    for (; i <= last && n < medianScratch.length; i++) {
      if (ring.voicedAt(i)) medianScratch[n++] = ring.midiAt(i);
    }
    if (n === 0) return NaN;
    return medianOfFirstN(medianScratch, n);
  }

  /** The pitch the auto-range / vibrato-zone should centre on: the active target, else recent voiced pitch. */
  function currentReferenceMidi(tNow: number): number {
    queryCursor.reset();
    const targetMidi = queryCursor.midiAt(tNow, targets, targetOrigin);
    if (Number.isFinite(targetMidi)) return targetMidi;
    return recentVoicedMedian(tNow, 1.5);
  }

  function isLocked(tNow: number): boolean {
    queryCursor.reset();
    const targetMidi = queryCursor.midiAt(tNow, targets, targetOrigin);
    if (!Number.isFinite(targetMidi)) return false;
    const last = ring.latest;
    if (last < 0 || !ring.voicedAt(last)) return false;
    if (tNow - ring.tAt(last) > LOCK_STALE_SEC) return false;
    return Math.abs((ring.midiAt(last) - targetMidi) * 100) <= toleranceCents;
  }

  // ---------------------------------------------------------------- dynamic layer (per rAF)

  function classifyColor(t: number, midi: number, cursor: TargetCursor): TraceColor {
    if (targets.length === 0) return 0;
    const targetMidi = cursor.midiAt(t, targets, targetOrigin);
    if (!Number.isFinite(targetMidi)) return 0;
    return Math.abs((midi - targetMidi) * 100) <= toleranceCents ? 1 : 2;
  }

  function strokeTracePass(ctx: CanvasRenderingContext2D, tNow: number, lineWidth: number, colorsFor: readonly string[]): void {
    ctx.lineWidth = lineWidth;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    traceCursor.reset();
    const fromT = tNow - options.pastSeconds;
    let i = ring.lowerBound(fromT);
    const last = ring.latest;
    let curColor: TraceColor | -1 = -1;
    let pathOpen = false;
    let prevX = 0;
    let prevY = 0;
    for (; i <= last; i++) {
      const t = ring.tAt(i);
      if (t > tNow) break;
      if (!ring.voicedAt(i)) {
        if (pathOpen) {
          ctx.stroke();
          pathOpen = false;
        }
        curColor = -1;
        continue;
      }
      const midi = ring.midiAt(i);
      const x = tToX(t, tNow, axis);
      const y = midiToY(midi, range.low, range.high, height);
      const c = classifyColor(t, midi, traceCursor);
      if (c !== curColor) {
        if (pathOpen) ctx.stroke();
        ctx.strokeStyle = colorsFor[c];
        ctx.beginPath();
        ctx.moveTo(curColor !== -1 ? prevX : x, curColor !== -1 ? prevY : y);
        curColor = c;
        pathOpen = true;
      }
      ctx.lineTo(x, y);
      prevX = x;
      prevY = y;
    }
    if (pathOpen) ctx.stroke();
  }

  function drawNowLine(ctx: CanvasRenderingContext2D): void {
    const x = width * CONFIG.display.nowLineFraction;
    ctx.strokeStyle = colors.tally;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, height);
    ctx.stroke();
  }

  function drawTargetBars(ctx: CanvasRenderingContext2D, tNow: number): void {
    if (targets.length === 0) return;
    const tolSemitones = toleranceCents / 100;
    const fromT = tNow - options.pastSeconds;
    const toT = tNow + options.futureSeconds;
    const locked = isLocked(tNow);
    for (let ti = 0; ti < targets.length; ti++) {
      const note = targets[ti];
      const absStart = targetOrigin + note.start;
      const absEnd = targetOrigin + note.end;
      if (absEnd < fromT || absStart > toT) continue;
      const x0 = tToX(Math.max(absStart, fromT), tNow, axis);
      const x1 = tToX(Math.min(absEnd, toT), tNow, axis);
      const isCurrent = tNow >= absStart && tNow < absEnd;
      const fill = isCurrent && locked ? colors.onFillLocked : colors.textHiFillIdle;
      const outline = isCurrent && locked ? colors.on : colors.line;
      const outlineWidth = isCurrent && locked ? 1.5 : 1;

      ctx.fillStyle = fill;
      ctx.strokeStyle = outline;
      ctx.lineWidth = outlineWidth;

      if (note.toMidi === undefined) {
        const yTop = midiToY(note.midi + tolSemitones, range.low, range.high, height);
        const yBottom = midiToY(note.midi - tolSemitones, range.low, range.high, height);
        const h = Math.max(2, yBottom - yTop);
        const r = Math.min(6, h / 2, (x1 - x0) / 2);
        drawRoundedRect(ctx, x0, yTop, Math.max(1, x1 - x0), h, Math.max(0, r));
        ctx.fill();
        ctx.stroke();
        // Tolerance-band centre line.
        ctx.beginPath();
        const yMid = midiToY(note.midi, range.low, range.high, height);
        ctx.moveTo(x0, yMid);
        ctx.lineTo(x1, yMid);
        ctx.strokeStyle = outline;
        ctx.lineWidth = 1;
        ctx.stroke();
      } else {
        // Sloped band for a glide: a trapezoid between the start and end tolerance edges.
        const startMidi = note.midi;
        const endMidi = note.toMidi;
        const yTopStart = midiToY(startMidi + tolSemitones, range.low, range.high, height);
        const yBottomStart = midiToY(startMidi - tolSemitones, range.low, range.high, height);
        const yTopEnd = midiToY(endMidi + tolSemitones, range.low, range.high, height);
        const yBottomEnd = midiToY(endMidi - tolSemitones, range.low, range.high, height);
        ctx.beginPath();
        ctx.moveTo(x0, yTopStart);
        ctx.lineTo(x1, yTopEnd);
        ctx.lineTo(x1, yBottomEnd);
        ctx.lineTo(x0, yBottomStart);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
      }
    }
  }

  /** One ±extent band of the vibrato zone (called twice: above and below centre; no array literal). */
  function drawVibratoZoneBand(ctx: CanvasRenderingContext2D, loMidi: number, hiMidi: number): void {
    const yA = midiToY(loMidi, range.low, range.high, height);
    const yB = midiToY(hiMidi, range.low, range.high, height);
    const yTop = Math.min(yA, yB);
    const h = Math.max(1, Math.abs(yB - yA));
    ctx.fillRect(0, yTop, width, h);
    ctx.strokeRect(0, yTop, width, h);
  }

  function drawVibratoZone(ctx: CanvasRenderingContext2D, tNow: number): void {
    if (!vibratoZone) return;
    const centre = currentReferenceMidi(tNow);
    if (!Number.isFinite(centre)) return;
    const minSemi = vibratoZone.minExtentCents / 100;
    const maxSemi = vibratoZone.maxExtentCents / 100;
    ctx.fillStyle = colors.onZoneFill;
    ctx.strokeStyle = colors.on;
    ctx.lineWidth = 1;
    ctx.setLineDash(VIBRATO_DASH);
    drawVibratoZoneBand(ctx, centre + minSemi, centre + maxSemi);
    drawVibratoZoneBand(ctx, centre - maxSemi, centre - minSemi);
    ctx.setLineDash(EMPTY_DASH);
  }

  function drawMarkers(ctx: CanvasRenderingContext2D, tNow: number): void {
    if (markers.length === 0) return;
    const fromT = tNow - options.pastSeconds;
    for (let mi = 0; mi < markers.length; mi++) {
      const m = markers[mi];
      if (m.t < fromT || m.t > tNow) continue;
      const x = tToX(m.t, tNow, axis);
      if (m.kind === 'crack') {
        ctx.strokeStyle = colors.alert;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, height);
        ctx.stroke();
        drawZigzag(ctx, x, 10, colors.alert);
        // docs/DESIGN.md §3: a crack marker must pair color with position AND text, not color
        // and a glyph alone. `m.label` is a stored string reference, not a template literal, so
        // this stays allocation-free per frame.
        ctx.font = LABEL_FONT;
        ctx.textBaseline = 'alphabetic';
        ctx.textAlign = 'left';
        ctx.fillStyle = colors.alert;
        ctx.fillText(m.label ?? 'crack', x + 4, 10);
      } else if (m.kind === 'onset') {
        ctx.fillStyle = colors.textMid;
        ctx.beginPath();
        ctx.arc(x, 8, 3, 0, Math.PI * 2);
        ctx.fill();
      } else {
        ctx.fillStyle = colors.textMid;
        ctx.beginPath();
        ctx.arc(x, 8, 2.5, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  // ---------------------------------------------------------------- range tween (auto-range)

  function updateAutoRange(tNow: number, dtSec: number): void {
    if (options.autoRange) {
      const ref = currentReferenceMidi(tNow);
      const decision = decideAutoRange(rangeTarget, ref, autoRangeCfg);
      if (decision) {
        rangeTarget.low = decision.low;
        rangeTarget.high = decision.high;
      }
    }
    const dLow = rangeTarget.low - range.low;
    const dHigh = rangeTarget.high - range.high;
    if (Math.abs(dLow) < RANGE_SNAP_EPS && Math.abs(dHigh) < RANGE_SNAP_EPS) {
      if (range.low !== rangeTarget.low || range.high !== rangeTarget.high) {
        range.low = rangeTarget.low;
        range.high = rangeTarget.high;
        staticDirty = true;
      }
      return;
    }
    const rate = options.reducedMotion ? 1 : Math.min(1, dtSec / RANGE_TWEEN_SEC);
    range.low += dLow * rate;
    range.high += dHigh * rate;
    staticDirty = true;
  }

  // ---------------------------------------------------------------- rAF loop

  let running = false;
  let rafHandle = 0;
  let lastFrameTime = NaN;
  let fpsCount = 0;
  let fpsWindowStart = NaN;
  let fpsValue = 0;

  function renderDynamic(perfNowMs: number): void {
    drawStatic();
    syncAxis();
    const tNow = clock.now(perfNowMs);
    const ctx = dynamicCtx;
    ctx.clearRect(0, 0, width, height);
    if (!Number.isFinite(tNow)) return;

    const dtSec = Number.isFinite(lastFrameTime) ? Math.max(0, (perfNowMs - lastFrameTime) / 1000) : 0;
    lastFrameTime = perfNowMs;
    updateAutoRange(tNow, dtSec);

    drawVibratoZone(ctx, tNow);
    drawTargetBars(ctx, tNow);
    // Below CONFIG.display.lowFpsThreshold (Low Power Mode caps rAF at 30fps), skip the glow
    // under-stroke - the one purely cosmetic pass - to leave more of the frame budget for the
    // core trace, target bars and markers. `fpsValue` is 0 until the first 1s window completes,
    // so this never falsely triggers during startup.
    const lowFps = fpsValue > 0 && fpsValue < CONFIG.display.lowFpsThreshold;
    if (!lowFps) strokeTracePass(ctx, tNow, GLOW_WIDTH, traceGlowColors);
    strokeTracePass(ctx, tNow, CORE_WIDTH, traceCoreColors);
    drawMarkers(ctx, tNow);
    drawNowLine(ctx);
  }

  function tick(perfNowMs: number): void {
    if (!running) return;
    renderDynamic(perfNowMs);

    fpsCount++;
    if (!Number.isFinite(fpsWindowStart)) fpsWindowStart = perfNowMs;
    else if (perfNowMs - fpsWindowStart >= 1000) {
      fpsValue = (fpsCount * 1000) / (perfNowMs - fpsWindowStart);
      fpsCount = 0;
      fpsWindowStart = perfNowMs;
    }

    rafHandle = requestAnimationFrame(tick);
  }

  function start(): void {
    if (running) return;
    running = true;
    lastFrameTime = NaN;
    fpsCount = 0;
    fpsWindowStart = NaN;
    rafHandle = requestAnimationFrame(tick);
  }

  function stop(): void {
    if (!running) return;
    running = false;
    if (rafHandle) cancelAnimationFrame(rafHandle);
    rafHandle = 0;
  }

  let wasRunningBeforeHide = false;
  const onVisibilityChange = (): void => {
    if (document.hidden) {
      wasRunningBeforeHide = running;
      stop();
    } else if (wasRunningBeforeHide) {
      start();
    }
  };
  document.addEventListener('visibilitychange', onVisibilityChange);

  // ---------------------------------------------------------------- public API

  function setRange(lowMidi: number, highMidi: number): void {
    range.low = lowMidi;
    range.high = highMidi;
    rangeTarget.low = lowMidi;
    rangeTarget.high = highMidi;
    staticDirty = true;
  }

  function setAutoRange(on: boolean): void {
    options.autoRange = on;
  }

  function setTargets(notes: readonly TargetNote[], origin: number): void {
    targets = notes;
    targetOrigin = origin;
  }

  function setToleranceCents(cents: number): void {
    toleranceCents = cents;
  }

  function setVibratoZone(zone: { minExtentCents: number; maxExtentCents: number } | null): void {
    vibratoZone = zone;
  }

  function addMarker(t: number, kind: MarkerKind, label?: string): void {
    markers.push({ t, kind, label });
    if (markers.length > MAX_MARKERS) markers.splice(0, markers.length - MAX_MARKERS);
  }

  function clear(): void {
    ring.clear();
    markers.length = 0;
    smoother.reset();
    clock.reset();
  }

  function setOptions(patch: Partial<PitchViewOptions>): void {
    if (patch.pastSeconds !== undefined) options.pastSeconds = patch.pastSeconds;
    if (patch.futureSeconds !== undefined) options.futureSeconds = patch.futureSeconds;
    if (patch.autoRange !== undefined) options.autoRange = patch.autoRange;
    if (patch.showNoteNames !== undefined) {
      options.showNoteNames = patch.showNoteNames;
      staticDirty = true;
    }
    if (patch.notation !== undefined) {
      options.notation = patch.notation;
      staticDirty = true;
    }
    if (patch.reducedMotion !== undefined) options.reducedMotion = patch.reducedMotion;
    if (patch.lowMidi !== undefined || patch.highMidi !== undefined) {
      setRange(patch.lowMidi ?? range.low, patch.highMidi ?? range.high);
    }
  }

  function destroy(): void {
    stop();
    document.removeEventListener('visibilitychange', onVisibilityChange);
    resizeObserver?.disconnect();
    window.removeEventListener('resize', onWindowResize);
    vv?.removeEventListener('resize', onWindowResize);
    themeObserver?.disconnect();
    colorSchemeQuery?.removeEventListener('change', onColorSchemeChange);
    if (resizeTimer !== null) clearTimeout(resizeTimer);
    staticCanvas.remove();
    dynamicCanvas.remove();
  }

  // ---------------------------------------------------------------- initial paint

  applyResize();

  return {
    pushFrame,
    setRange,
    setAutoRange,
    setTargets,
    setToleranceCents,
    setVibratoZone,
    addMarker,
    clear,
    setOptions,
    start,
    stop,
    get fps() {
      return fpsValue;
    },
    destroy,
  };
}

// ---------------------------------------------------------------- small render helpers (module scope: no per-frame allocation)

const EMPTY_DASH: readonly number[] = [];

/**
 * Median of `buf[0..n)`, sorting that range in place (insertion sort: n is at
 * most a couple hundred samples, and this runs at most once per frame). Avoids
 * allocating a view/array just to read one middle value back out.
 */
function medianOfFirstN(buf: Float32Array, n: number): number {
  for (let i = 1; i < n; i++) {
    const key = buf[i];
    let j = i - 1;
    while (j >= 0 && buf[j] > key) {
      buf[j + 1] = buf[j];
      j--;
    }
    buf[j + 1] = key;
  }
  return buf[n >> 1];
}

/** `roundRect` is on the Canvas spec but missing from this TS version's lib.dom.d.ts; feature-detect it structurally instead of reaching for `any`. */
interface RoundRectCapable {
  roundRect?(x: number, y: number, w: number, h: number, radii: number): void;
}

function drawRoundedRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const rr2 = (ctx as CanvasRenderingContext2D & RoundRectCapable).roundRect;
  if (typeof rr2 === 'function') {
    ctx.beginPath();
    rr2.call(ctx, x, y, w, h, r);
    return;
  }
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

function drawZigzag(ctx: CanvasRenderingContext2D, x: number, y: number, color: string): void {
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(x - 5, y);
  ctx.lineTo(x - 1.5, y - 5);
  ctx.lineTo(x + 1.5, y + 5);
  ctx.lineTo(x + 5, y);
  ctx.stroke();
}
