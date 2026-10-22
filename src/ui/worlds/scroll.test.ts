// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NODE_ANCHOR, afterFonts, prefersReducedMotion, revealElement } from './scroll';

function rectOf(top: number, height: number): DOMRect {
  return { top, height, bottom: top + height, left: 0, right: 100, width: 100, x: 0, y: top, toJSON: () => ({}) } as DOMRect;
}

function elementAt(top: number, height = 80): HTMLElement {
  const el = document.createElement('div');
  document.body.appendChild(el);
  el.getBoundingClientRect = () => rectOf(top, height);
  return el;
}

afterEach(() => {
  document.body.innerHTML = '';
  delete document.documentElement.dataset.reducedMotion;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('prefersReducedMotion', () => {
  it('follows the value src/state/theme.ts resolved onto <html>', () => {
    document.documentElement.dataset.reducedMotion = 'on';
    expect(prefersReducedMotion()).toBe(true);
    document.documentElement.dataset.reducedMotion = 'off';
    expect(prefersReducedMotion()).toBe(false);
  });

  it('falls back to the OS setting before that is written', () => {
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: query.includes('reduce') }));
    expect(prefersReducedMotion()).toBe(true);
    vi.stubGlobal('matchMedia', () => ({ matches: false }));
    expect(prefersReducedMotion()).toBe(false);
  });
});

describe('revealElement on the document', () => {
  let scrollTo: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    scrollTo = vi.fn();
    vi.stubGlobal('scrollTo', scrollTo);
    vi.stubGlobal('innerHeight', 800);
    vi.stubGlobal('scrollY', 200);
  });

  it('puts the centre of a node about 40% down the viewport', () => {
    revealElement(elementAt(1000, 80), 'node', true);
    expect(scrollTo).toHaveBeenCalledWith({ top: Math.round(200 + 1000 + 40 - 800 * NODE_ANCHOR), behavior: 'smooth' });
    expect(NODE_ANCHOR).toBe(0.4);
  });

  it('puts the top of a world just under the app bar', () => {
    const bar = document.createElement('header');
    bar.className = 'pl-appbar';
    bar.getBoundingClientRect = () => rectOf(0, 52);
    document.body.appendChild(bar);
    revealElement(elementAt(1000), 'top', true);
    expect(scrollTo).toHaveBeenCalledWith({ top: 200 + 1000 - 52 - 8, behavior: 'smooth' });
  });

  it('scrolls instantly when asked, and never above the top of the page', () => {
    revealElement(elementAt(10, 80), 'node', false);
    expect(scrollTo).toHaveBeenCalledWith({ top: 0, behavior: 'auto' });
  });

  it('is instant under reduced motion by default', () => {
    document.documentElement.dataset.reducedMotion = 'on';
    revealElement(elementAt(1000), 'node');
    expect(scrollTo.mock.calls[0][0].behavior).toBe('auto');
    document.documentElement.dataset.reducedMotion = 'off';
    revealElement(elementAt(1000), 'node');
    expect(scrollTo.mock.calls[1][0].behavior).toBe('smooth');
  });
});

describe('revealElement inside a scrolling container', () => {
  it('scrolls the container, measured against its own box', () => {
    const scroller = document.createElement('div');
    scroller.style.overflowY = 'auto';
    Object.defineProperty(scroller, 'scrollHeight', { value: 3000 });
    Object.defineProperty(scroller, 'clientHeight', { value: 600 });
    scroller.scrollTop = 500;
    scroller.getBoundingClientRect = () => rectOf(100, 600);
    scroller.scrollTo = vi.fn() as never;
    document.body.appendChild(scroller);
    const el = document.createElement('div');
    el.getBoundingClientRect = () => rectOf(900, 80);
    scroller.appendChild(el);
    const windowScroll = vi.fn();
    vi.stubGlobal('scrollTo', windowScroll);

    revealElement(el, 'node', true);

    // 500 (scrolled) + (900 - 100) (offset in the box) + 40 (half the node) - 600 * 0.4
    expect(scroller.scrollTo).toHaveBeenCalledWith({ top: Math.round(500 + 800 + 40 - 240), behavior: 'smooth' });
    expect(windowScroll).not.toHaveBeenCalled();
  });
});

describe('afterFonts', () => {
  function stubFonts(fonts: unknown): void {
    Object.defineProperty(document, 'fonts', { value: fonts, configurable: true });
  }

  afterEach(() => {
    Reflect.deleteProperty(document, 'fonts');
  });

  it('runs at once when the browser has no font set', () => {
    stubFonts(undefined);
    const cb = vi.fn();
    afterFonts(cb);
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('runs at once when the fonts are loaded', () => {
    stubFonts({ status: 'loaded', ready: Promise.resolve() });
    const cb = vi.fn();
    afterFonts(cb);
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('waits for fonts that are still loading', async () => {
    let done: () => void = () => undefined;
    stubFonts({ status: 'loading', ready: new Promise<void>((resolve) => (done = resolve)) });
    const cb = vi.fn();
    afterFonts(cb);
    expect(cb).not.toHaveBeenCalled();
    done();
    await Promise.resolve();
    await Promise.resolve();
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('does not run when it was cancelled first (the screen went away)', async () => {
    let done: () => void = () => undefined;
    stubFonts({ status: 'loading', ready: new Promise<void>((resolve) => (done = resolve)) });
    const cb = vi.fn();
    const cancel = afterFonts(cb);
    cancel();
    done();
    await Promise.resolve();
    await Promise.resolve();
    expect(cb).not.toHaveBeenCalled();
  });
});
