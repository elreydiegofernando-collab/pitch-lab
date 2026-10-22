import { describe, expect, it } from 'vitest';
import { makeTrack } from '../../analysis/fixtures';
import type { TargetNote } from '../../core/types';
import { drawReplay, readReplayPalette, type ReplaySpec } from './draw-replay';
import { traceSegments, type RunGlyph } from './replay-geometry';

/** A canvas context that records every call and every property it is given. */
function recordingContext() {
  const calls: Array<{ name: string; args: unknown[] }> = [];
  const sets: Array<{ prop: string; value: unknown }> = [];
  const state: Record<string, unknown> = {};
  const ctx = new Proxy(
    {},
    {
      get(_target, prop: string) {
        if (prop in state) return state[prop];
        return (...args: unknown[]) => {
          calls.push({ name: prop, args });
        };
      },
      set(_target, prop: string, value: unknown) {
        state[prop] = value;
        sets.push({ prop, value });
        return true;
      },
    },
  );
  return { ctx: ctx as unknown as CanvasRenderingContext2D, calls, sets };
}

const notes: TargetNote[] = [
  { midi: 60, start: 0, end: 2 },
  { midi: 62, start: 2, end: 3, toMidi: 65 },
];

function spec(over: Partial<ReplaySpec> = {}): ReplaySpec {
  const track = makeTrack({ duration: 3, t0: 0, midi: (t) => (t < 1 ? 60 : t < 2 ? 60.8 : 63) });
  return {
    width: 340,
    height: 160,
    window: { low: 56, high: 70 },
    t0: -0.3,
    pxPerSec: 90,
    padLeft: 8,
    lanes: true,
    preview: false,
    notes,
    toleranceCents: 25,
    segments: traceSegments(track, notes, 25),
    cracks: [],
    glyphs: [],
    palette: readReplayPalette(),
    ...over,
  };
}

const countOf = (calls: Array<{ name: string }>, name: string): number => calls.filter((c) => c.name === name).length;

describe('drawReplay', () => {
  it('never uses shadowBlur or a filter', () => {
    const { ctx, sets } = recordingContext();
    drawReplay(ctx, spec({ cracks: [{ t: 1, kind: 'jump', durationMs: 20 }], glyphs: [{ t: 0.5, midi: 60, verdict: 'defined' }] }));
    expect(sets.some((s) => s.prop === 'shadowBlur' || s.prop === 'filter')).toBe(false);
  });

  it('paints the lanes only when asked, so the preview can sit over the live view', () => {
    const withLanes = recordingContext();
    drawReplay(withLanes.ctx, spec({ lanes: true }));
    const without = recordingContext();
    drawReplay(without.ctx, spec({ lanes: false, preview: true }));
    expect(countOf(withLanes.calls, 'fillRect')).toBeGreaterThan(10);
    expect(countOf(without.calls, 'fillRect')).toBe(0);
  });

  it('draws one bar per target, and a sloped band for a glide', () => {
    const { ctx, calls } = recordingContext();
    drawReplay(ctx, spec({ segments: [] }));
    // A plain bar: a rounded rectangle path plus its centre line; a glide: one closed four-point path.
    expect(countOf(calls, 'arcTo')).toBe(4);
    expect(countOf(calls, 'closePath')).toBe(2);
  });

  it('strokes the trace in the in-band and out-of-band colours, each colour as one batched path', () => {
    const { ctx, sets } = recordingContext();
    const s = spec();
    drawReplay(ctx, s);
    const strokes = sets.filter((x) => x.prop === 'strokeStyle').map((x) => x.value);
    expect(strokes).toContain(s.palette.on);
    expect(strokes).toContain(s.palette.off);
  });

  it('marks every crack with a tick, a zig-zag and the word, up to five of them', () => {
    const { ctx, calls } = recordingContext();
    drawReplay(ctx, spec({ segments: [], cracks: [{ t: 0.5, kind: 'jump', cents: 300, durationMs: 20 }, { t: 1.5, kind: 'dropout', durationMs: 80 }] }));
    const words = calls.filter((c) => c.name === 'fillText').map((c) => c.args[0]);
    expect(words).toEqual(['crack', 'crack']);
  });

  it('drops the words, not the ticks, when there are many cracks', () => {
    const { ctx, calls } = recordingContext();
    const cracks = Array.from({ length: 8 }, (_, i) => ({ t: i * 0.3, kind: 'jump' as const, durationMs: 20 }));
    drawReplay(ctx, spec({ segments: [], cracks }));
    expect(countOf(calls, 'fillText')).toBe(0);
    expect(countOf(calls, 'lineTo')).toBeGreaterThanOrEqual(8 * 4);
  });

  it('draws each verdict with its own shape: a disc, a half disc, a cross', () => {
    const verdicts: RunGlyph[] = [
      { t: 0.5, midi: 60, verdict: 'defined' },
      { t: 1, midi: 60, verdict: 'smeared' },
      { t: 1.5, midi: 60, verdict: 'missed' },
    ];
    const { ctx, calls } = recordingContext();
    drawReplay(ctx, spec({ segments: [], notes: [], glyphs: verdicts }));
    const arcs = countOf(calls, 'arc');
    // halo x3, disc x1, ring + half x2 for the smeared note
    expect(arcs).toBe(3 + 1 + 2);
    // the cross is two strokes in one path
    expect(calls.filter((c) => c.name === 'moveTo').length).toBeGreaterThanOrEqual(2);
  });

  it('puts a glyph below the bar when the bar is at the top of the canvas', () => {
    const { ctx, calls } = recordingContext();
    drawReplay(ctx, spec({ segments: [], notes: [], window: { low: 56, high: 61 }, glyphs: [{ t: 0.5, midi: 61, verdict: 'defined' }] }));
    const halo = calls.find((c) => c.name === 'arc');
    expect(halo).toBeDefined();
    expect(halo!.args[1] as number).toBeGreaterThan(5);
  });

  it('skips targets and glyphs that fall outside the canvas', () => {
    const { ctx, calls } = recordingContext();
    drawReplay(ctx, spec({ segments: [], notes: [{ midi: 60, start: 900, end: 901 }], glyphs: [{ t: 900, midi: 60, verdict: 'defined' }] }));
    expect(countOf(calls, 'arcTo')).toBe(0);
    expect(countOf(calls, 'arc')).toBe(0);
  });
});

describe('readReplayPalette', () => {
  it('falls back to the dark theme tokens when there is no stylesheet', () => {
    const p = readReplayPalette();
    expect(p.on).toBe('#56B4E9');
    expect(p.off).toBe('#E69F00');
    expect(p.alert).toBe('#E8743B');
  });
});
