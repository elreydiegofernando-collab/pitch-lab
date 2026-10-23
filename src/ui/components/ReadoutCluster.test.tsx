// @vitest-environment happy-dom
/**
 * The readout cluster says it in words: the note's name, and "On it", "A little high" or "A little low". No cents, Hz or
 * dB in the main view; the numbers come only with Details. One frame subscriber, however it is shown.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'preact';
import { act } from 'preact/test-utils';
import { jargonIn } from '../../coaching/plain';
import { centsFromNearest, midiToHz } from '../../core/music';
import type { PitchFrame } from '../../core/types';
import { createFakeEngine } from '../practice/test-fakes';
import { ReadoutCluster, type ReadoutClusterProps } from './ReadoutCluster';

let container: HTMLElement;
let rig: ReturnType<typeof createFakeEngine>;

const frame = (midi: number, over: Partial<PitchFrame> = {}): PitchFrame => ({
  t: 0,
  f0Hz: midiToHz(midi),
  midi,
  centsFromNearest: centsFromNearest(midi),
  confidence: 0.95,
  rmsDb: -22,
  voiced: true,
  ...over,
});
const SILENCE: PitchFrame = { t: 0, f0Hz: NaN, midi: NaN, centsFromNearest: NaN, confidence: 0.1, rmsDb: -80, voiced: false };

async function mount(props: Partial<ReadoutClusterProps> = {}): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  await act(() => {
    render(<ReadoutCluster engine={rig.engine} toleranceCents={25} {...props} />, container);
  });
}

/** Take time, in seconds: the engine's frames come every 20 ms or so, and the readout paints on every animation frame. */
let clock = 0;
const FRAME_SEC = 0.02;

/**
 * Hold `f` for `seconds` as the engine would deliver it, one frame every FRAME_SEC, each painted by its own animation
 * frame. The default is long enough for any change of words to show (see HOLD_SEC and HOLD_QUIET_SEC).
 */
async function sing(f: PitchFrame, seconds = 0.4): Promise<void> {
  await act(() => {
    for (let i = 0; i < Math.max(1, Math.round(seconds / FRAME_SEC)); i++) {
      clock += FRAME_SEC;
      rig.emit([{ ...f, t: clock }]);
      vi.advanceTimersByTime(20);
    }
  });
}

const q = <T extends Element = HTMLElement>(sel: string): T | null => container.querySelector<T>(sel);
const text = (sel: string): string => q(sel)?.textContent ?? '';

beforeEach(() => {
  vi.useFakeTimers();
  rig = createFakeEngine();
  clock = 0;
});

afterEach(async () => {
  await act(() => {
    render(null, container);
  });
  container.remove();
  vi.useRealTimers();
});

describe('ReadoutCluster: the main view', () => {
  it('shows the note and the words, and nothing in units: no Hz, no dB, no cents', async () => {
    await mount();
    expect(text('[data-testid="live-note"]')).toBe('–');
    expect(text('[data-testid="live-pitch"]')).toBe('–');
    for (const id of ['live-hz', 'live-db', 'live-cents', 'live-details']) expect(q(`[data-testid="${id}"]`), id).toBeNull();
    await sing(frame(57)); // A3, dead on
    expect(text('[data-testid="live-note"]')).toBe('A3');
    expect(text('[data-testid="live-pitch"]')).toBe('On it');
    expect(container.textContent).not.toMatch(/Hz|dB|¢/);
    expect(jargonIn(container.textContent ?? '')).toEqual([]);
  });

  it('says "A little high" above the in-tune zone and "A little low" below it', async () => {
    await mount();
    await sing(frame(57.4)); // 40 c above A3, past the 25 c zone
    expect(text('[data-testid="live-note"]')).toBe('A3');
    expect(text('[data-testid="live-pitch"]')).toBe('A little high');
    await sing(frame(56.6)); // 40 c below A3
    expect(text('[data-testid="live-pitch"]')).toBe('A little low');
    await sing(frame(57.2)); // 20 c: inside the zone
    expect(text('[data-testid="live-pitch"]')).toBe('On it');
  });

  it('follows the zone the level sets: 20 c is on it for the easy zone and a little high for the studio one', async () => {
    await mount({ toleranceCents: 50 });
    await sing(frame(57.2));
    expect(text('[data-testid="live-pitch"]')).toBe('On it');
    await act(() => {
      render(null, container);
    });
    container.remove();
    await mount({ toleranceCents: 10 });
    await sing(frame(57.2));
    expect(text('[data-testid="live-pitch"]')).toBe('A little high');
  });

  it('goes back to dashes when the voice stops', async () => {
    await mount();
    await sing(frame(60.3));
    expect(text('[data-testid="live-note"]')).toBe('C4');
    await sing(SILENCE);
    expect(text('[data-testid="live-note"]')).toBe('–');
    expect(text('[data-testid="live-pitch"]')).toBe('–');
  });

  it('names the note in the singer’s notation', async () => {
    await mount({ notation: 'flats' });
    await sing(frame(58)); // the black key above A3
    expect(text('[data-testid="live-note"]')).toBe('B♭3');
  });

  it('labels the note with a word that can be tapped to learn what it means', async () => {
    await mount();
    const term = q<HTMLButtonElement>('.pl-readouts__note button[data-term="note"]')!;
    expect(term.textContent).toBe('Note');
    await act(() => {
      term.click();
    });
    expect(document.querySelector('[role="dialog"]')?.getAttribute('aria-label')).toBe('Note');
    await act(() => {
      document.querySelector<HTMLButtonElement>('button[aria-label="Close"]')!.click();
    });
  });

  it('has no Details toggle unless the screen offers one (the Sing screen does not)', async () => {
    await mount();
    expect(q('[data-testid="live-details-toggle"]')).toBeNull();
  });
});

describe('ReadoutCluster: the words hold a moment', () => {
  it('does not flicker at the edge of the zone: a reading that does not last leaves the words as they were', async () => {
    await mount();
    await sing(frame(57.1)); // 10 c: on it
    expect(text('[data-testid="live-pitch"]')).toBe('On it');
    await sing(frame(57.4), 0.08); // 40 c, but only for 80 ms
    expect(text('[data-testid="live-pitch"]')).toBe('On it');
    await sing(frame(57.1), 0.04); // back inside: the wait is dropped without a change
    await sing(frame(57.4), 0.08); // out again: the wait starts over
    expect(text('[data-testid="live-pitch"]')).toBe('On it');
    await sing(frame(57.4), 0.2); // it has lasted now
    expect(text('[data-testid="live-pitch"]')).toBe('A little high');
  });

  it('keeps the words through a breath between two syllables, and blanks them after a longer quiet', async () => {
    await mount();
    await sing(frame(57.1));
    await sing(SILENCE, 0.2);
    expect(text('[data-testid="live-pitch"]')).toBe('On it');
    await sing(frame(57.1), 0.1); // the voice is back: nothing was lost
    await sing(SILENCE, 0.5);
    expect(text('[data-testid="live-pitch"]')).toBe('–');
  });

  it('shows the first reading, and a voice that comes back after silence, at once', async () => {
    await mount();
    await sing(frame(57.4), 0.02);
    expect(text('[data-testid="live-pitch"]')).toBe('A little high');
    await sing(SILENCE, 0.5);
    expect(text('[data-testid="live-pitch"]')).toBe('–');
    await sing(frame(56.6), 0.02);
    expect(text('[data-testid="live-pitch"]')).toBe('A little low');
  });

  it('never holds the number Details shows: it is the reading of every frame', async () => {
    await mount({ details: true });
    await sing(frame(57.1));
    expect(text('[data-testid="live-cents"]')).toBe('+10¢');
    await sing(frame(57.4), 0.02);
    expect(text('[data-testid="live-cents"]')).toBe('+40¢');
    expect(text('[data-testid="live-pitch"]')).toBe('On it');
  });
});

describe('ReadoutCluster: Details', () => {
  it('offers a small toggle, off, that asks the screen to turn it on and off', async () => {
    const onDetailsChange = vi.fn();
    await mount({ onDetailsChange });
    const toggle = q<HTMLButtonElement>('[data-testid="live-details-toggle"]')!;
    expect(toggle.textContent).toBe('Details');
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    await act(() => {
      toggle.click();
    });
    expect(onDetailsChange).toHaveBeenLastCalledWith(true);
    await act(() => {
      render(null, container);
    });
    container.remove();
    await mount({ onDetailsChange, details: true });
    expect(q('[data-testid="live-details-toggle"]')!.getAttribute('aria-pressed')).toBe('true');
    await act(() => {
      q<HTMLButtonElement>('[data-testid="live-details-toggle"]')!.click();
    });
    expect(onDetailsChange).toHaveBeenLastCalledWith(false);
  });

  it('shows pitch in Hz, loudness in dB and the distance in cents only when open, painted by the same frame', async () => {
    await mount({ details: true });
    expect(text('[data-testid="live-hz"]')).toBe('––');
    await sing(frame(57.4));
    expect(text('[data-testid="live-hz"]')).toBe(midiToHz(57.4).toFixed(1));
    expect(text('[data-testid="live-db"]')).toBe('-22');
    expect(text('[data-testid="live-cents"]')).toBe('+40¢');
    await sing(frame(57.003));
    expect(text('[data-testid="live-cents"]')).toBe('0¢');
    await sing(frame(57.4));
    expect(text('[data-testid="live-pitch"]')).toBe('A little high');
    expect(text('[data-testid="live-details"]')).toContain('Hz');
    expect(text('[data-testid="live-details"]')).toContain('dB');
    await sing(SILENCE);
    expect(text('[data-testid="live-hz"]')).toBe('––');
    expect(text('[data-testid="live-cents"]')).toBe('––');
  });

  it('fills the numbers in when it is opened mid-song, from the next frame', async () => {
    const props = { engine: rig.engine, toleranceCents: 25 };
    container = document.createElement('div');
    document.body.appendChild(container);
    await act(() => {
      render(<ReadoutCluster {...props} details={false} />, container);
    });
    await sing(frame(57));
    expect(q('[data-testid="live-hz"]')).toBeNull();
    await act(() => {
      render(<ReadoutCluster {...props} details />, container);
    });
    expect(text('[data-testid="live-hz"]')).toBe('––');
    await sing(frame(57));
    expect(text('[data-testid="live-hz"]')).toBe('220.0');
    expect(rig.listeners).toBe(1);
  });
});

describe('ReadoutCluster: against the note asked for (the Sing screen, review R1)', () => {
  it('reads a voice a half step off its note as off, where the nearest note would have said "On it"', async () => {
    await mount({ toleranceCents: 50, targetAt: () => 55 }); // G3 asked, on the wide zone of the first lessons
    await sing(frame(56)); // G♯3, dead on that key
    expect(text('[data-testid="live-note"]')).toBe('G♯3');
    expect(text('[data-testid="live-pitch"]')).toBe('A little high');
    await sing(frame(55.2));
    expect(text('[data-testid="live-pitch"]')).toBe('On it');
  });

  it('says "Too high" or "Too low" a whole step or more off, as the live hint says "a lot"', async () => {
    await mount({ targetAt: () => 55 });
    await sing(frame(57)); // A3: a whole step over G3
    expect(text('[data-testid="live-pitch"]')).toBe('Too high');
    await sing(frame(52.5));
    expect(text('[data-testid="live-pitch"]')).toBe('Too low');
    await sing(frame(54.4));
    expect(text('[data-testid="live-pitch"]')).toBe('A little low');
  });

  it('reads nothing while the app plays a note, and shows no words while nothing is asked', async () => {
    let target: number | 'listen' | null = 'listen';
    await mount({ targetAt: () => target });
    await sing(frame(55)); // on a speaker the microphone hears the app's own note
    expect(text('[data-testid="live-note"]')).toBe('–');
    expect(text('[data-testid="live-pitch"]')).toBe('–');
    target = null; // a rest, or a slide
    await sing(frame(55));
    expect(text('[data-testid="live-note"]')).toBe('G3');
    expect(text('[data-testid="live-pitch"]')).toBe('–');
  });

  it('asks for the target at each frame’s own time', async () => {
    const asked: number[] = [];
    await mount({
      targetAt: (t) => {
        asked.push(t);
        return 55;
      },
    });
    await sing(frame(55), 0.1);
    expect(asked.length).toBeGreaterThan(0);
    expect(asked.every((t) => t > 0 && t <= clock + 1e-9)).toBe(true);
  });
});

describe('ReadoutCluster: the frame subscription', () => {
  it('listens to the engine once, however it is shown, and lets go when it leaves', async () => {
    await mount({ details: true, onDetailsChange: () => {} });
    expect(rig.listeners).toBe(1);
    await act(() => {
      render(null, container);
    });
    expect(rig.listeners).toBe(0);
  });
});
