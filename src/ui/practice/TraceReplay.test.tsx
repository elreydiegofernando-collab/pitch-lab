// @vitest-environment happy-dom
/** TraceReplay on a stand-in canvas: what it paints, at what size, and what it says in words. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'preact';
import { act } from 'preact/test-utils';
import type { RunResult } from '../../analysis/types';
import { makeTrack } from '../../analysis/fixtures';
import type { TargetNote } from '../../core/types';
import { REPLAY_HEIGHT, TraceReplay, backingScale, type TraceReplayProps } from './TraceReplay';

interface Recorded {
  calls: Array<{ name: string; args: unknown[] }>;
  sets: Array<{ prop: string; value: unknown }>;
}

/** One recording 2D context per canvas, so a test can read what was painted. */
const painted: Recorded[] = [];

function recordingContext(): CanvasRenderingContext2D {
  const rec: Recorded = { calls: [], sets: [] };
  painted.push(rec);
  const state: Record<string, unknown> = {};
  return new Proxy(
    {},
    {
      get(_t, prop: string) {
        if (prop in state) return state[prop];
        return (...args: unknown[]) => {
          rec.calls.push({ name: prop, args });
        };
      },
      set(_t, prop: string, value: unknown) {
        state[prop] = value;
        rec.sets.push({ prop, value });
        return true;
      },
    },
  ) as unknown as CanvasRenderingContext2D;
}

const NOTES: TargetNote[] = [
  { midi: 60, start: 0, end: 1.5 },
  { midi: 64, start: 2, end: 3.5 },
];
const TRACK = makeTrack({ duration: 4, t0: -0.3, midi: (t) => (t < 0 ? NaN : t < 1.8 ? 60.1 : t < 2.2 ? NaN : 64.4), jitterCents: 2, seed: 3 });

let container: HTMLElement;
let width = 340;

async function mount(props: Partial<TraceReplayProps> = {}): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  await act(() => {
    render(<TraceReplay notes={NOTES} totalSec={3.5} toleranceCents={25} track={TRACK} {...props} />, container);
  });
}

const q = <T extends Element = HTMLElement>(sel: string): T | null => container.querySelector<T>(sel);
const last = (): Recorded => painted[painted.length - 1];
const names = (r: Recorded): string[] => r.calls.map((c) => c.name);

beforeEach(() => {
  width = 340;
  painted.length = 0;
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => recordingContext() as never);
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() => ({ width, height: 160, top: 0, left: 0, right: width, bottom: 160, x: 0, y: 0, toJSON: () => ({}) }));
});

afterEach(async () => {
  if (container) {
    await act(() => {
      render(null, container);
    });
    container.remove();
    container = undefined as never;
  }
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('backingScale', () => {
  it('uses the device ratio, at most 2', () => {
    expect(backingScale(340, 160, 1)).toBe(1);
    expect(backingScale(340, 160, 2)).toBe(2);
    expect(backingScale(340, 160, 3)).toBe(2);
  });

  it('keeps the widest canvas inside what iOS allows', () => {
    expect(backingScale(3000, 160, 2) * 3000).toBeLessThanOrEqual(4096 + 1e-9);
    expect(backingScale(3200, 160, 1)).toBeCloseTo(1, 6);
  });

  it('falls back to 1 for a nonsense ratio', () => {
    expect(backingScale(340, 160, 0)).toBe(1);
    expect(backingScale(340, 160, Number.NaN)).toBe(1);
  });
});

describe('TraceReplay: the report', () => {
  it('paints the lanes, the bars and the trace once it has a size, at the device scale (capped at 2)', async () => {
    vi.stubGlobal('devicePixelRatio', 3);
    await mount();
    const canvas = q<HTMLCanvasElement>('canvas')!;
    expect(canvas.width).toBe(680);
    expect(canvas.height).toBe(REPLAY_HEIGHT * 2);
    expect(canvas.style.width).toBe('340px');
    expect(canvas.style.height).toBe(`${REPLAY_HEIGHT}px`);
    const calls = names(last());
    expect(calls).toContain('fillRect'); // the lanes
    expect(calls).toContain('arcTo'); // a rounded bar
    expect(calls).toContain('stroke'); // the trace
    expect(last().sets.some((s) => s.prop === 'shadowBlur')).toBe(false);
    expect(last().calls.find((c) => c.name === 'setTransform')?.args.slice(0, 1)).toEqual([2]);
  });

  it('paints nothing, and does not throw, before it has a size or a context', async () => {
    width = 0;
    await mount();
    expect(painted).toHaveLength(0);
    await act(() => {
      render(null, container);
    });
    container.remove();
    width = 340;
    vi.mocked(HTMLCanvasElement.prototype.getContext).mockImplementation(() => null);
    await mount();
    expect(q('canvas')).not.toBeNull();
  });

  it('names the pitches on the side as text, with each C marked', async () => {
    await mount();
    const names = [...container.querySelectorAll('.pl-replay__note')].map((n) => n.textContent);
    expect(names).toContain('C4');
    expect(names).toContain('E4');
    expect(container.querySelector('.pl-replay__note--c')?.textContent).toBe('C4');
    expect(q('.pl-replay__gutter')?.getAttribute('aria-hidden')).toBe('true');
  });

  it('describes the canvas and keys its colours and shapes in words', async () => {
    await mount({
      cracks: [{ t: 1, kind: 'jump', cents: 300, durationMs: 20 }],
    });
    expect(q('canvas')?.getAttribute('role')).toBe('img');
    expect(q('canvas')?.getAttribute('aria-label')).toBe('Replay of your take against 2 target notes');
    const legend = q('.pl-replay__legend')!.textContent!;
    expect(legend).toContain('In the band');
    expect(legend).toContain('Outside the band');
    expect(legend).toContain('1 crack marked');
    expect(q('.pl-replay__keys svg')).not.toBeNull();
  });

  it('counts the verdict of every run note', async () => {
    const runNotes: TargetNote[] = [
      { midi: 60, start: 0, end: 0.2 },
      { midi: 62, start: 0.2, end: 0.4 },
      { midi: 64, start: 0.4, end: 0.6 },
    ];
    const result: RunResult = {
      score: 0.7,
      components: { reached: 1, accuracy: 1, definition: 1, timing: 1 },
      notes: [
        { index: 0, targetMidi: 60, reached: true, reachedMs: 90, medianErrorCents: 2, definition: 1, timingErrorMs: 0, verdict: 'defined' },
        { index: 1, targetMidi: 62, reached: true, reachedMs: 90, medianErrorCents: 2, definition: 1, timingErrorMs: 0, verdict: 'defined' },
        { index: 2, targetMidi: 64, reached: false, reachedMs: 0, medianErrorCents: null, definition: 0, timingErrorMs: null, verdict: 'missed' },
      ],
    };
    await mount({ notes: runNotes, totalSec: 0.6, runs: [{ notes: runNotes, result }] });
    const legend = q('.pl-replay__legend')!.textContent!;
    expect(legend).toContain('2 defined');
    expect(legend).toContain('0 smeared');
    expect(legend).toContain('1 missed');
    // Notes 0.2 s apart fit a 340 px box: no sideways scroll.
    expect(q('.pl-replay__scroll')?.getAttribute('role')).toBeNull();
  });

  it('widens for run notes packed tighter than a glyph, and scrolls inside its own row', async () => {
    // Two runs nine notes a second, ten seconds apart: the take is long, so the box cannot give each note its room.
    const burst = (from: number): TargetNote[] => Array.from({ length: 12 }, (_, i) => ({ midi: 60 + (i % 5), start: from + i / 9, end: from + (i + 1) / 9 }));
    const first = burst(0);
    const second = burst(10);
    const scored = (notes: TargetNote[]): RunResult => ({
      score: 0.8,
      components: { reached: 1, accuracy: 1, definition: 1, timing: 1 },
      notes: notes.map((n, index) => ({ index, targetMidi: n.midi, reached: true, reachedMs: 80, medianErrorCents: 3, definition: 0.9, timingErrorMs: 0, verdict: 'defined' as const })),
    });
    await mount({
      notes: [...first, ...second],
      totalSec: 11.4,
      runs: [
        { notes: first, result: scored(first) },
        { notes: second, result: scored(second) },
      ],
    });
    const scroller = q('.pl-replay__scroll')!;
    expect(scroller.getAttribute('role')).toBe('region');
    expect(scroller.getAttribute('tabindex')).toBe('0');
    expect(scroller.getAttribute('aria-label')).toContain('scrolls sideways');
    expect(Number.parseFloat(q<HTMLCanvasElement>('canvas')!.style.width)).toBeGreaterThan(340);
    expect(q('.pl-replay__legend')!.textContent).toContain('Scroll sideways');
  });

  it('says so when nothing was sung', async () => {
    await mount({ track: makeTrack({ duration: 2, t0: 0, midi: () => NaN }) });
    expect(q('.pl-replay__legend')!.textContent).toContain('No sung pitch was picked up');
    expect(q('.pl-replay__swatch')).toBeNull();
  });

  it('marks a coaching spot at its take time, and names it for a screen reader', async () => {
    await mount({ mark: { t: 2, label: '0:02, near E4' } });
    const mark = q<HTMLElement>('[data-testid="replay-mark"]')!;
    expect(mark).not.toBeNull();
    expect(mark.getAttribute('aria-hidden')).toBe('true');
    // The same x the canvas draws take time 2 at: past the lead-in, inside the plotted width.
    const x = Number.parseFloat(mark.style.left);
    expect(x).toBeGreaterThan(8);
    expect(x).toBeLessThan(340);
    expect(mark.style.height).toBe(`${REPLAY_HEIGHT}px`);
    expect(q('[data-testid="replay-mark-text"]')?.textContent).toBe('Marked on the replay: 0:02, near E4');
    // A later moment sits further right.
    await act(() => {
      render(<TraceReplay notes={NOTES} totalSec={3.5} toleranceCents={25} track={TRACK} mark={{ t: 3, label: '0:03' }} />, container);
    });
    expect(Number.parseFloat(q<HTMLElement>('[data-testid="replay-mark"]')!.style.left)).toBeGreaterThan(x);
  });

  it('draws no mark without one, and never on the preview', async () => {
    await mount();
    expect(q('[data-testid="replay-mark"]')).toBeNull();
    expect(q('[data-testid="replay-mark-text"]')?.textContent).toBe('');
    await act(() => {
      render(null, container);
    });
    container.remove();
    await mount({ mode: 'preview', track: undefined, window: { low: 56, high: 68 }, padLeft: 40, mark: { t: 1, label: '0:01' } });
    expect(q('[data-testid="replay-mark"]')).toBeNull();
  });

  it('repaints when the theme changes', async () => {
    await mount();
    const before = painted.length;
    document.documentElement.setAttribute('data-theme', 'light');
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20)); // the observer reports on a later turn
    });
    expect(painted.length).toBeGreaterThan(before);
    document.documentElement.removeAttribute('data-theme');
  });
});

describe('TraceReplay: the preview', () => {
  it('paints only the bars, over the live view’s lanes, clear of its note names', async () => {
    await mount({ mode: 'preview', track: undefined, window: { low: 56, high: 68 }, padLeft: 40 });
    expect(q('.pl-replay--preview')?.getAttribute('aria-hidden')).toBe('true');
    expect(q('.pl-replay__legend')).toBeNull();
    expect(q('.pl-replay__gutter')).toBeNull();
    const calls = names(last());
    expect(calls).not.toContain('fillRect'); // no lanes: the live view paints those
    expect(calls).toContain('arcTo');
    const firstBar = last().calls.find((c) => c.name === 'moveTo')!;
    expect(firstBar.args[0] as number).toBeGreaterThanOrEqual(40);
  });

  it('lays the whole exercise across the width, not a scrolling window', async () => {
    await mount({ mode: 'preview', track: undefined, window: { low: 56, high: 68 }, padLeft: 40 });
    const xs = last().calls.filter((c) => c.name === 'arcTo').map((c) => c.args[0] as number);
    expect(Math.max(...xs)).toBeLessThanOrEqual(340);
    expect(Math.max(...xs)).toBeGreaterThan(200);
  });
});
