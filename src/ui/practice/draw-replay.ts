/**
 * Draws the take replay onto a 2D canvas (docs/DESIGN.md §8 and §13.5): the piano-roll lanes, the target bars (their
 * height is the tolerance band), the sung trace in blue inside the band and orange outside it, crack ticks and the run
 * verdict glyphs. Static: it paints once per size or theme change, so there is no hot path here, but it still follows
 * the canvas rules (no shadowBlur, same-colour runs batched into one path, text only for the short crack labels).
 *
 * Colour never carries a verdict alone: runs get a filled circle (defined), a half-filled circle (smeared) or a cross
 * (missed); cracks get a tick, a zig-zag and the word "crack".
 */
import type { CrackEvent } from '../../analysis/types';
import { isAccidental } from '../../core/music';
import type { TargetNote } from '../../core/types';
import { midiToY } from '../pitch-view/geometry';
import type { PitchWindow, RunGlyph, TraceColor, TraceSegment } from './replay-geometry';

export interface ReplayPalette {
  bg0: string;
  laneNatural: string;
  laneAccidental: string;
  line: string;
  textHi: string;
  textMid: string;
  on: string;
  off: string;
  alert: string;
  good: string;
  meh: string;
}

const PALETTE_VARS: Record<keyof ReplayPalette, string> = {
  bg0: '--bg-0',
  laneNatural: '--lane-natural',
  laneAccidental: '--lane-accidental',
  line: '--line',
  textHi: '--text-hi',
  textMid: '--text-mid',
  on: '--on',
  off: '--off',
  alert: '--alert',
  good: '--good',
  meh: '--meh',
};

/** The dark theme's tokens: what a canvas uses when the stylesheet has not loaded (tests, first paint). */
const FALLBACK_PALETTE: ReplayPalette = {
  bg0: '#0E0F13',
  laneNatural: '#13151B',
  laneAccidental: '#0B0C10',
  line: '#2A2E39',
  textHi: '#F2EFE8',
  textMid: '#AEB4BF',
  on: '#56B4E9',
  off: '#E69F00',
  alert: '#E8743B',
  good: '#19C39A',
  meh: '#F0E442',
};

/** The current theme's colours, read from the CSS tokens. */
export function readReplayPalette(): ReplayPalette {
  const style = typeof getComputedStyle === 'function' && typeof document !== 'undefined' ? getComputedStyle(document.documentElement) : null;
  const out = { ...FALLBACK_PALETTE };
  if (!style) return out;
  for (const key of Object.keys(PALETTE_VARS) as Array<keyof ReplayPalette>) {
    const value = style.getPropertyValue(PALETTE_VARS[key]).trim();
    if (value) out[key] = value;
  }
  return out;
}

export interface ReplaySpec {
  /** CSS pixels. */
  width: number;
  height: number;
  window: PitchWindow;
  /** Take time at the left edge of the plotted area. */
  t0: number;
  pxPerSec: number;
  /** Plot starts this far from the left edge (room for the live view's note names, or the DOM gutter's width is outside). */
  padLeft: number;
  /** Paint the lane shading and octave lines (the report). The Sing preview sits over the live view's own lanes. */
  lanes: boolean;
  /** Stronger bars for the preview, which has to read over the live view's lanes. */
  preview: boolean;
  notes: readonly TargetNote[];
  toleranceCents: number;
  segments: readonly TraceSegment[];
  cracks: readonly CrackEvent[];
  glyphs: readonly RunGlyph[];
  palette: ReplayPalette;
}

const GLYPH_RADIUS = 4.5;
const GLYPH_GAP = 3;
const TRACE_CORE = 2.5;
const TRACE_UNDER = 6;
const TRACE_UNDER_ALPHA = 0.14;
const BAR_FILL_ALPHA = 0.08;
const BAR_FILL_ALPHA_PREVIEW = 0.16;
const LABEL_FONT = "600 12px 'Instrument Sans Variable', ui-sans-serif, system-ui, sans-serif";

function roundedRectPath(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, radius: number): void {
  const r = Math.max(0, Math.min(radius, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

export function drawReplay(ctx: CanvasRenderingContext2D, spec: ReplaySpec): void {
  const { width, height, window: win } = spec;
  const xOf = (t: number): number => spec.padLeft + (t - spec.t0) * spec.pxPerSec;
  const yOf = (midi: number): number => midiToY(midi, win.low, win.high, height);

  ctx.clearRect(0, 0, width, height);
  if (spec.lanes) drawLanes(ctx, spec, yOf);
  drawBars(ctx, spec, xOf, yOf);
  drawTrace(ctx, spec, xOf, yOf);
  drawCracks(ctx, spec, xOf);
  drawGlyphs(ctx, spec, xOf, yOf);
  ctx.globalAlpha = 1;
}

function drawLanes(ctx: CanvasRenderingContext2D, spec: ReplaySpec, yOf: (midi: number) => number): void {
  const { width, window: win, palette } = spec;
  ctx.fillStyle = palette.bg0;
  ctx.fillRect(0, 0, width, spec.height);
  const top = Math.ceil(win.high + 0.5);
  const bottom = Math.floor(win.low - 0.5);
  for (let m = top; m >= bottom; m--) {
    const yTop = yOf(m + 0.5);
    const yBottom = yOf(m - 0.5);
    ctx.fillStyle = isAccidental(m) ? palette.laneAccidental : palette.laneNatural;
    ctx.fillRect(0, yTop, width, Math.max(1, yBottom - yTop));
  }
  ctx.strokeStyle = palette.line;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let m = top; m >= bottom; m--) {
    if (((m % 12) + 12) % 12 !== 0) continue;
    const y = Math.round(yOf(m - 0.5)) + 0.5;
    ctx.moveTo(0, y);
    ctx.lineTo(width, y);
  }
  ctx.stroke();
}

function drawBars(ctx: CanvasRenderingContext2D, spec: ReplaySpec, xOf: (t: number) => number, yOf: (midi: number) => number): void {
  const { palette } = spec;
  const tol = spec.toleranceCents / 100;
  const fillAlpha = spec.preview ? BAR_FILL_ALPHA_PREVIEW : BAR_FILL_ALPHA;
  ctx.lineWidth = 1;
  for (const note of spec.notes) {
    const x0 = xOf(note.start);
    const x1 = xOf(note.end);
    if (x1 < 0 || x0 > spec.width) continue;
    const w = Math.max(1, x1 - x0);
    ctx.strokeStyle = spec.preview ? palette.textMid : palette.line;
    ctx.fillStyle = palette.textHi;
    if (note.toMidi === undefined) {
      const yTop = yOf(note.midi + tol);
      const yBottom = yOf(note.midi - tol);
      roundedRectPath(ctx, x0, yTop, w, Math.max(2, yBottom - yTop), 4);
      ctx.globalAlpha = fillAlpha;
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.stroke();
      const yMid = yOf(note.midi);
      ctx.beginPath();
      ctx.moveTo(x0, yMid);
      ctx.lineTo(x0 + w, yMid);
      ctx.stroke();
    } else {
      // A glide is a sloped band between the tolerance edges at its two ends.
      ctx.beginPath();
      ctx.moveTo(x0, yOf(note.midi + tol));
      ctx.lineTo(x1, yOf(note.toMidi + tol));
      ctx.lineTo(x1, yOf(note.toMidi - tol));
      ctx.lineTo(x0, yOf(note.midi - tol));
      ctx.closePath();
      ctx.globalAlpha = fillAlpha;
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.stroke();
    }
  }
}

function drawTrace(ctx: CanvasRenderingContext2D, spec: ReplaySpec, xOf: (t: number) => number, yOf: (midi: number) => number): void {
  if (spec.segments.length === 0) return;
  const colours: Record<TraceColor, string> = { 0: spec.palette.textHi, 1: spec.palette.on, 2: spec.palette.off };
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (const pass of [{ width: TRACE_UNDER, alpha: TRACE_UNDER_ALPHA }, { width: TRACE_CORE, alpha: 1 }]) {
    ctx.lineWidth = pass.width;
    ctx.globalAlpha = pass.alpha;
    for (const color of [0, 1, 2] as const) {
      ctx.strokeStyle = colours[color];
      ctx.beginPath();
      let any = false;
      for (const seg of spec.segments) {
        if (seg.color !== color) continue;
        any = true;
        ctx.moveTo(xOf(seg.t[0]), yOf(seg.midi[0]));
        // A one-frame segment still shows as a dot: round caps draw a zero-length line.
        if (seg.t.length === 1) ctx.lineTo(xOf(seg.t[0]) + 0.01, yOf(seg.midi[0]));
        for (let i = 1; i < seg.t.length; i++) ctx.lineTo(xOf(seg.t[i]), yOf(seg.midi[i]));
      }
      if (any) ctx.stroke();
    }
  }
  ctx.globalAlpha = 1;
}

/** At most this many cracks carry the word "crack"; beyond it the ticks and glyphs speak for themselves. */
const MAX_CRACK_LABELS = 5;

function drawCracks(ctx: CanvasRenderingContext2D, spec: ReplaySpec, xOf: (t: number) => number): void {
  if (spec.cracks.length === 0) return;
  const { palette } = spec;
  const labelled = spec.cracks.length <= MAX_CRACK_LABELS;
  for (const crack of spec.cracks) {
    const x = xOf(crack.t);
    if (x < 0 || x > spec.width) continue;
    ctx.strokeStyle = palette.alert;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, spec.height);
    ctx.stroke();
    // The zig-zag glyph, as in the live view.
    ctx.beginPath();
    ctx.moveTo(x - 5, 10);
    ctx.lineTo(x - 1.5, 5);
    ctx.lineTo(x + 1.5, 15);
    ctx.lineTo(x + 5, 10);
    ctx.stroke();
    if (labelled) {
      ctx.font = LABEL_FONT;
      ctx.textBaseline = 'alphabetic';
      ctx.textAlign = x > spec.width - 48 ? 'right' : 'left';
      ctx.fillStyle = palette.alert;
      ctx.fillText('crack', x > spec.width - 48 ? x - 8 : x + 8, 14);
    }
  }
}

function drawGlyphs(ctx: CanvasRenderingContext2D, spec: ReplaySpec, xOf: (t: number) => number, yOf: (midi: number) => number): void {
  if (spec.glyphs.length === 0) return;
  const { palette } = spec;
  const tol = spec.toleranceCents / 100;
  const r = GLYPH_RADIUS;
  for (const g of spec.glyphs) {
    const x = xOf(g.t);
    if (x < -r || x > spec.width + r) continue;
    // Just above the bar; below it when the bar is at the top of the canvas.
    let y = yOf(g.midi + tol) - r - GLYPH_GAP;
    if (y < r + 2) y = yOf(g.midi - tol) + r + GLYPH_GAP;

    // A halo in the background colour keeps the glyph readable over bars and the trace.
    ctx.fillStyle = palette.bg0;
    ctx.beginPath();
    ctx.arc(x, y, r + 1.5, 0, Math.PI * 2);
    ctx.fill();

    if (g.verdict === 'defined') {
      ctx.fillStyle = palette.good;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
    } else if (g.verdict === 'smeared') {
      ctx.strokeStyle = palette.meh;
      ctx.fillStyle = palette.meh;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(x, y, r - 0.75, 0, Math.PI * 2);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(x, y, r - 0.75, Math.PI / 2, (Math.PI * 3) / 2);
      ctx.closePath();
      ctx.fill();
    } else {
      ctx.strokeStyle = palette.alert;
      ctx.lineWidth = 2;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(x - r + 1, y - r + 1);
      ctx.lineTo(x + r - 1, y + r - 1);
      ctx.moveTo(x + r - 1, y - r + 1);
      ctx.lineTo(x - r + 1, y + r - 1);
      ctx.stroke();
    }
  }
}
