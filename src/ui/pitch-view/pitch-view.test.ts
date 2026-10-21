// @vitest-environment happy-dom
/**
 * Regression test for [crack-marker-missing-required-text-label]: docs/DESIGN.md §3 requires a
 * crack/break marker to pair color with position AND text ("--alert vertical tick plus a small
 * zig-zag glyph and the label 'crack'"), but drawMarkers() used to draw only the tick and the
 * zig-zag glyph, never reading the `label` that addMarker()/Marker already carried.
 *
 * happy-dom ships no canvas adapter, so `HTMLCanvasElement.getContext('2d')` returns null and
 * `createPitchView` cannot run against it as-is. This fakes just the subset of the Canvas2D API
 * the module calls, and records every `fillText()` call so the assertion can check the marker's
 * label actually gets drawn, not just the tick and glyph.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PitchFrame } from '../../core/types';
import { createPitchView } from './pitch-view';

interface FakeCtx2D {
  readonly fillTextCalls: string[];
  fillStyle: string;
  strokeStyle: string;
  lineWidth: number;
  lineCap: string;
  lineJoin: string;
  font: string;
  textBaseline: string;
  textAlign: string;
  save(): void;
  restore(): void;
  fillRect(): void;
  strokeRect(): void;
  beginPath(): void;
  closePath(): void;
  moveTo(): void;
  lineTo(): void;
  arc(): void;
  arcTo(): void;
  stroke(): void;
  fill(): void;
  setLineDash(): void;
  clearRect(): void;
  setTransform(): void;
  fillText(text: string): void;
}

function createFakeCtx2D(): FakeCtx2D {
  const fillTextCalls: string[] = [];
  return {
    fillTextCalls,
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    lineCap: 'butt',
    lineJoin: 'miter',
    font: '',
    textBaseline: 'alphabetic',
    textAlign: 'start',
    save() {},
    restore() {},
    fillRect() {},
    strokeRect() {},
    beginPath() {},
    closePath() {},
    moveTo() {},
    lineTo() {},
    arc() {},
    arcTo() {},
    stroke() {},
    fill() {},
    setLineDash() {},
    clearRect() {},
    setTransform() {},
    fillText(text: string) {
      fillTextCalls.push(text);
    },
  };
}

const originalGetContext = HTMLCanvasElement.prototype.getContext;

/**
 * Installs the fake 2D context plus deterministic performance/rAF clocks `createPitchView`
 * needs, and returns handles to drive one render pass. `getContext` is restored and globals are
 * unstubbed in `afterEach` below.
 */
function stubRenderingEnv(): {
  fakeCtxs: FakeCtx2D[];
  /** Fires the single rAF callback `view.start()` scheduled, as if that frame had arrived. */
  fireFrame: (perfNowMs: number) => void;
} {
  const fakeCtxs: FakeCtx2D[] = [];
  // happy-dom ships no canvas adapter (getContext('2d') normally returns null); fake just the
  // subset of the Canvas2D API this module calls. Cast to a minimal shape instead of `any`.
  (HTMLCanvasElement.prototype as unknown as { getContext: () => FakeCtx2D }).getContext = () => {
    const ctx = createFakeCtx2D();
    fakeCtxs.push(ctx);
    return ctx;
  };

  vi.stubGlobal('performance', { now: () => 1000 });
  let pendingTick: ((t: number) => void) | null = null;
  vi.stubGlobal('requestAnimationFrame', (cb: (t: number) => void) => {
    pendingTick = cb;
    return 1;
  });
  vi.stubGlobal('cancelAnimationFrame', () => {});

  return {
    fakeCtxs,
    fireFrame: (perfNowMs: number) => {
      const cb = pendingTick;
      pendingTick = null;
      cb?.(perfNowMs);
    },
  };
}

describe('createPitchView: crack marker rendering (docs/DESIGN.md §3)', () => {
  afterEach(() => {
    HTMLCanvasElement.prototype.getContext = originalGetContext;
    vi.unstubAllGlobals();
  });

  /**
   * `performance.now()` is stubbed to a constant 1000ms, so pushFrame()'s internal
   * clock.onFrame(frame.t, 1000) anchors the scroll clock such that clock.now(1000) later
   * returns exactly `frame.t` - putting the marker exactly at "now" regardless of wall-clock time.
   */
  const frame: PitchFrame = { t: 10, f0Hz: 220, midi: 57, centsFromNearest: 0, confidence: 1, rmsDb: -10, voiced: true };

  it('draws the marker label text, not just the tick and zig-zag glyph', () => {
    const { fakeCtxs, fireFrame } = stubRenderingEnv();
    const container = document.createElement('div');
    document.body.appendChild(container);
    const view = createPitchView(container, { pastSeconds: 4.5, futureSeconds: 1.75 });

    view.pushFrame(frame);
    view.addMarker(10, 'crack', 'crack');
    view.start();
    fireFrame(1000);

    // staticCanvas.getContext() is called before dynamicCanvas.getContext() in createPitchView;
    // drawMarkers() only ever draws on the dynamic layer.
    expect(fakeCtxs[1].fillTextCalls).toContain('crack');

    view.stop();
    view.destroy();
  });

  it('falls back to the label "crack" when addMarker() is called without one', () => {
    const { fakeCtxs, fireFrame } = stubRenderingEnv();
    const container = document.createElement('div');
    document.body.appendChild(container);
    const view = createPitchView(container, { pastSeconds: 4.5, futureSeconds: 1.75 });

    view.pushFrame(frame);
    view.addMarker(10, 'crack'); // no label supplied
    view.start();
    fireFrame(1000);

    expect(fakeCtxs[1].fillTextCalls).toContain('crack');

    view.stop();
    view.destroy();
  });
});
