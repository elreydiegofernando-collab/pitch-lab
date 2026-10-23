// @vitest-environment happy-dom
/**
 * LiveHint on a fake engine: it listens to frames only while a take is on, follows the singer a few times a second,
 * writes the page only when the hint changes (never per frame, and never through Preact), always shows words with a
 * glyph, goes quiet when the engine stops delivering, and respects reduced motion. What it says and when is
 * live-hint.test.ts; here it is the screen side.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'preact';
import { act } from 'preact/test-utils';
import { FRAME_RATE } from '../../analysis/fixtures';
import type { PitchFrame } from '../../core/types';
import { CUE } from '../../exercises/cues';
import { LiveHint, type LiveHintProps } from './LiveHint';
import { HINTS, HINT_TICK_MS } from './live-hint';
import { exercise, note, prepare, rest, voiceFrames } from './live-hint-fixtures';

/** The slice of the engine the hint uses: a frame subscription we can drive by hand. */
function fakeEngine() {
  const listeners = new Set<(f: PitchFrame) => void>();
  return {
    onFrame: vi.fn((l: (f: PitchFrame) => void) => {
      listeners.add(l);
      return () => {
        listeners.delete(l);
      };
    }),
    emit(frames: readonly PitchFrame[]): void {
      for (const f of frames) for (const l of [...listeners]) l(f);
    },
    get listeners(): number {
      return listeners.size;
    },
  };
}

/** Engine time of take time 0. */
const ORIGIN = 50;

/** An eight-second hold from take time 0, in the zone of Hold it steady and after (+-25), where steady and wobbly are said. */
const HOLD = prepare(exercise([note(0, 8)], { tolerance: 'default' }));
const NOTE = HOLD.realized.steps[0].midi!;
/** An echo: the app plays the note for two seconds, a one-second rest, then the singer's three. */
const ECHO = prepare(exercise([note(0, 2, { cue: CUE.listen }), rest(1), note(0, 3, { cue: CUE.sing })]));

let engine: ReturnType<typeof fakeEngine>;
let container: HTMLElement;

const base = (): LiveHintProps => ({ engine, prepared: HOLD, origin: ORIGIN, active: true });

async function mount(over: Partial<LiveHintProps> = {}): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  await act(() => {
    render(<LiveHint {...base()} {...over} />, container);
  });
}
async function update(over: Partial<LiveHintProps>): Promise<void> {
  await act(() => {
    render(<LiveHint {...base()} {...over} />, container);
  });
}

const root = (): HTMLElement => container.querySelector<HTMLElement>('[data-testid="live-hint"]')!;
const words = (): string => container.querySelector('[data-testid="live-hint-text"]')!.textContent ?? '';
const kind = (): string => root().dataset.kind ?? '';
const tick = (): Promise<void> =>
  act(() => {
    vi.advanceTimersByTime(HINT_TICK_MS);
  });

/** Frames from take time `from` to `to`; `midi(take)` is the pitch (NaN = silence). */
function voice(from: number, to: number, midi: (take: number) => number, jitterCents = 2): PitchFrame[] {
  return voiceFrames(ORIGIN, from, to, midi, jitterCents, 11);
}
const silence = (from: number, to: number): PitchFrame[] => voice(from, to, () => NaN, 0);
const on = (cents = 0) => (): number => NOTE + cents / 100;

/** Deliver `frames` as the engine would, a timer period at a time, and look after each tick: what the hint said on the way. */
async function play(frames: readonly PitchFrame[]): Promise<string[]> {
  const per = Math.round((FRAME_RATE * HINT_TICK_MS) / 1000);
  const seen: string[] = [];
  for (let i = 0; i < frames.length; i += per) {
    engine.emit(frames.slice(i, i + per));
    await tick();
    seen.push(kind());
  }
  return seen;
}

beforeEach(() => {
  vi.useFakeTimers();
  engine = fakeEngine();
  document.documentElement.dataset.reducedMotion = 'off';
});

afterEach(async () => {
  if (container) {
    await act(() => {
      render(null, container);
    });
    container.remove();
    container = undefined as never;
  }
  vi.useRealTimers();
  delete document.documentElement.dataset.reducedMotion;
});

describe('LiveHint: outside a take', () => {
  it('is in the page but hidden, and not a live region (a screen reader reads it on demand, never mid-take)', async () => {
    await mount({ active: false });
    expect(kind()).toBe('none');
    expect(root().getAttribute('role')).toBe('status');
    expect(root().getAttribute('aria-live')).toBe('off');
    expect(root().querySelector('.pl-live-hint__pill')).not.toBeNull();
  });

  it('costs nothing: no frame subscription and no timer', async () => {
    await mount({ active: false });
    expect(engine.onFrame).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    await update({ active: true, origin: null });
    expect(engine.listeners).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    await update({ active: true, prepared: null });
    expect(engine.listeners).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('LiveHint: during a take', () => {
  it('listens to the engine and reads it a few times a second, and lets go when the take is over', async () => {
    await mount();
    expect(engine.listeners).toBe(1);
    expect(vi.getTimerCount()).toBe(1);
    await update({ active: false });
    expect(engine.listeners).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(kind()).toBe('none');
  });

  it('says "sing now" to a singer who has not started, then follows the voice: a little lower, then steady', async () => {
    await mount();
    expect(await play(silence(0, 0.6))).toContain('sing');
    expect(kind()).toBe('sing');
    expect(words()).toBe(HINTS.sing.text);
    expect(root().dataset.glyph).toBe('mic');
    expect(root().dataset.tone).toBe('go');

    // 80 cents sharp in a +-25 zone: "a little lower".
    await play(voice(0.6, 2.2, on(80)));
    expect(kind()).toBe('lower');
    expect(words()).toBe('a little lower');
    expect(root().dataset.glyph).toBe('down');
    expect(root().dataset.tone).toBe('adjust');

    // Down onto the note and held: it settles to "on it", then "steady, good".
    const kinds = await play(voice(2.2, 5.5, on(0)));
    expect(kinds).toContain('on-it');
    expect(kind()).toBe('steady');
    expect(words()).toBe('steady, good');
    expect(root().dataset.glyph).toBe('check');
    expect(root().dataset.tone).toBe('good');
  });

  it('says "a little higher" to a flat voice and "a bit wobbly" to a swinging one', async () => {
    await mount();
    await play([...silence(0, 0.4), ...voice(0.4, 2.2, on(-80))]);
    expect(kind()).toBe('higher');
    expect(words()).toBe('a little higher');
    expect(root().dataset.glyph).toBe('up');
    await update({ origin: ORIGIN + 100 }); // a fresh take
    expect(kind()).toBe('none');
    const swing = (t: number): number => NOTE + 0.35 * Math.sin(2 * Math.PI * 3.5 * t);
    const shifted = (t: number): number => swing(t - 100);
    await play([...voice(100, 100.4, () => NaN, 0), ...voice(100.4, 104, shifted, 2)]);
    expect(kind()).toBe('wobbly');
    expect(words()).toBe('a bit wobbly: soften and keep the air even');
    expect(root().dataset.glyph).toBe('waves');
  });

  it('says "listen..." while the app plays, "breathe" in the rest, "sing now" on the singer\'s turn', async () => {
    await mount({ prepared: ECHO });
    await play(silence(0, 0.9));
    expect(kind()).toBe('listen');
    expect(words()).toBe('listen...');
    expect(root().dataset.glyph).toBe('ear');
    expect(root().dataset.tone).toBe('quiet');
    await play(silence(0.9, 2.5));
    expect(kind()).toBe('breathe');
    expect(words()).toBe('breathe');
    expect(root().dataset.glyph).toBe('wind');
    await play(silence(2.5, 3.6));
    expect(kind()).toBe('sing');
    expect(words()).toBe('sing now');
    expect(root().dataset.glyph).toBe('mic');
  });

  it('keeps what it says through a re-render of the screen around it (the cue changes at every step)', async () => {
    await mount();
    await play(silence(0, 0.6));
    expect(kind()).toBe('sing');
    await update({});
    await update({});
    expect(kind()).toBe('sing');
    expect(words()).toBe('sing now');
    expect(root().dataset.glyph).toBe('mic');
    expect(engine.listeners).toBe(1);
    expect(vi.getTimerCount()).toBe(1);
  });

  it('starts clean for the next take: the old subscription is gone and the line is hidden', async () => {
    await mount();
    await play([...silence(0, 0.4), ...voice(0.4, 2.2, on(0))]);
    expect(kind()).not.toBe('none');
    await update({ origin: ORIGIN + 20 });
    expect(engine.listeners).toBe(1);
    expect(engine.onFrame).toHaveBeenCalledTimes(2);
    expect(kind()).toBe('none');
  });
});

describe('LiveHint: the hot path', () => {
  /** Everything written to the hint's part of the page, as the browser reports it (delivered after a microtask). */
  function watch(target: Element): { written: () => number; stop: () => void } {
    let count = 0;
    const observer = new MutationObserver((records) => {
      count += records.length;
    });
    observer.observe(target, { attributes: true, childList: true, characterData: true, subtree: true });
    return { written: () => count, stop: () => observer.disconnect() };
  }
  const settled = (): Promise<void> => act(() => {});

  it('writes the page only when the hint changes: never per frame, never while it holds', async () => {
    await mount();
    const frames = [...silence(0, 0.4), ...voice(0.4, 6, on(0))];
    const spy = watch(root());
    const first = frames.slice(0, Math.floor(frames.length * 0.6));
    const kinds = await play(first);
    await settled();
    const changes = kinds.filter((k, i) => i > 0 && k !== kinds[i - 1]).length + 1;
    expect(first.length).toBeGreaterThan(300);
    // A change writes the words and three attributes (one when the line only fades out): a handful, not hundreds.
    expect(spy.written()).toBeGreaterThan(0);
    expect(spy.written()).toBeLessThanOrEqual(changes * 4);

    // Once the hint holds, more frames and more looks write nothing at all.
    expect(kind()).toBe('steady');
    const before = spy.written();
    await play(frames.slice(first.length, first.length + 30)); // still inside the four-second hold
    await settled();
    expect(kind()).toBe('steady');
    expect(spy.written()).toBe(before);
    spy.stop();
  });

  it('looks a few times a second, not once per frame', async () => {
    expect(HINT_TICK_MS).toBeGreaterThanOrEqual(100);
    expect(HINT_TICK_MS).toBeLessThanOrEqual(500);
    await mount();
    engine.emit(silence(0, 0.6));
    await act(() => {
      vi.advanceTimersByTime(HINT_TICK_MS - 1);
    });
    expect(kind()).toBe('none'); // frames have arrived, and the page has not been touched
    await act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(kind()).toBe('sing');
  });

  it('does no work between looks: frames arriving touch no part of the page', async () => {
    await mount();
    const spy = watch(container);
    engine.emit([...silence(0, 0.4), ...voice(0.4, 4, on(0))]);
    await settled();
    expect(spy.written()).toBe(0);
    spy.stop();
  });

  it('goes quiet when the engine stops delivering frames, rather than keep saying something stale', async () => {
    await mount();
    await play(silence(0, 0.6));
    expect(kind()).toBe('sing');
    await tick();
    await tick();
    expect(kind()).toBe('sing');
    await tick();
    expect(kind()).toBe('none');
    // And speaks again when frames come back.
    await play(silence(0.6, 1.2));
    expect(kind()).toBe('sing');
  });
});

describe('LiveHint: for everyone', () => {
  it('has every glyph in the page, each a hidden decoration next to the words (never colour alone)', async () => {
    await mount({ active: false });
    const glyphs = [...root().querySelectorAll<HTMLElement>('.pl-live-hint__glyph')].map((g) => g.dataset.glyph);
    expect(new Set(glyphs)).toEqual(new Set(Object.values(HINTS).map((h) => h.glyph)));
    for (const glyph of root().querySelectorAll('.pl-live-hint__glyph')) {
      expect(glyph.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
    }
  });

  it('always shows words and the glyph that goes with them, whatever it says', async () => {
    await mount();
    const seen = new Set<string>();
    for (const frames of [silence(0, 0.6), voice(0.6, 2.2, on(80)), voice(2.2, 3.4, on(0)), voice(3.4, 5, on(-80))]) {
      await play(frames);
      const info = HINTS[kind() as keyof typeof HINTS];
      if (!info) continue;
      seen.add(kind());
      expect(words()).toBe(info.text);
      expect(root().dataset.glyph).toBe(info.glyph);
      expect(root().querySelector(`.pl-live-hint__glyph[data-glyph="${info.glyph}"]`)).not.toBeNull();
    }
    expect(seen.size).toBeGreaterThanOrEqual(3);
  });

  it('fades with opacity only, and not at all under reduced motion', async () => {
    document.documentElement.dataset.reducedMotion = 'on';
    await mount();
    expect(root().dataset.motion).toBe('reduce');
    await update({ active: false });
    await update({ active: true });
    expect(root().dataset.motion).toBe('reduce');
    document.documentElement.dataset.reducedMotion = 'off';
    await update({ origin: ORIGIN + 1 });
    expect(root().dataset.motion).toBe('full');
  });

  it('takes nothing from the singer: no pointer events to catch, no focus to take', async () => {
    await mount();
    expect(root().querySelector('button, a, input, [tabindex]')).toBeNull();
  });
});
