// @vitest-environment happy-dom
/** LastTimeCard: a placeholder its size while the last take is read back, then its coaching; nothing after a pass. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render } from 'preact';
import { act } from 'preact/test-utils';
import type { LastTimeSources } from '../../coaching/last-time';
import type { Coaching } from '../../coaching/types';
import { getExercise } from '../../exercises';
import { LastTimeCard, type LastTimeCardProps } from './LastTimeCard';

const def = getExercise('foundations.sustain.1')!;
const SOURCES: LastTimeSources = {
  def,
  log: [],
  profile: { range: null, voiceType: 'tenor' },
  takes: null,
  notation: 'sharps',
  vibratoStyle: 'pop',
  isLevelPassed: () => false,
  now: 0,
};

const COACHING: Coaching = {
  depth: 4,
  missesInARow: 5,
  passed: false,
  problem: { tipId: 'acc.flat', metric: 'accuracy.absBiasCents', what: 'On average you sang a little flat.', spots: [{ t: 4, label: 'note 2 (D4), a little flat' }] },
  tip: 'Aim each note a hair higher.',
  why: 'Why it happens.',
  steps: ['One.', 'Two.', 'Three.'],
  easier: 'An easier way in.',
  progress: [],
  moves: [{ kind: 'listen-slow' }, { kind: 'send-to-claude' }],
};

let container: HTMLElement;

async function show(props: Partial<LastTimeCardProps>): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  await act(() => {
    render(<LastTimeCard sources={SOURCES} latestId="a1" listen={null} onMove={vi.fn()} {...props} />, container);
  });
}

const flush = () => act(async () => void (await new Promise((r) => setTimeout(r, 0))));
const q = <T extends Element = HTMLElement>(sel: string): T | null => container.querySelector<T>(sel);

afterEach(async () => {
  if (!container) return;
  await act(() => {
    render(null, container);
  });
  container.remove();
  container = undefined as never;
});

describe('LastTimeCard', () => {
  it('holds its place while the last take is read back, then shows its coaching', async () => {
    let finish: (c: Coaching | null) => void = () => undefined;
    const load = vi.fn(() => new Promise<Coaching | null>((resolve) => (finish = resolve)));
    await show({ load });
    expect(load).toHaveBeenCalledWith(SOURCES);
    expect(q('[data-testid="last-time-loading"]')?.getAttribute('aria-busy')).toBe('true');
    finish(COACHING);
    await flush();
    expect(q('[data-testid="last-time-loading"]')).toBeNull();
    const card = q('[data-testid="last-time"]')!;
    expect(card.textContent).toContain('Last time');
    expect(card.textContent).toContain('On average you sang a little flat.');
    expect(card.textContent).toContain('Aim each note a hair higher.');
    expect(card.textContent).toContain('An easier way in.');
    // No replay on this screen: the spots are a plain list.
    expect(q('[data-testid="coach-spot"]')?.tagName).toBe('SPAN');
  });

  it('shows nothing when there is nothing to say', async () => {
    await show({ load: vi.fn(async () => null) });
    await flush();
    expect(container.textContent).toBe('');
  });

  it('wires the moves to the level: listen from the tap, and Send to Claude', async () => {
    const onMove = vi.fn();
    const listen = vi.fn();
    await show({ load: vi.fn(async () => COACHING), onMove, listen: { slow: false, playing: false, onClick: listen } });
    await flush();
    q<HTMLButtonElement>('[data-testid="coach-listen"]')!.click();
    expect(listen).toHaveBeenCalledTimes(1);
    q<HTMLButtonElement>('[data-testid="coach-send"]')!.click();
    expect(onMove).toHaveBeenCalledWith({ kind: 'send-to-claude' });
  });

  it('reads the coaching again when a newer take comes in', async () => {
    const load = vi.fn(async () => COACHING);
    await show({ load });
    await flush();
    await act(() => {
      render(<LastTimeCard sources={SOURCES} latestId="a2" listen={null} onMove={vi.fn()} load={load} />, container);
    });
    await flush();
    expect(load).toHaveBeenCalledTimes(2);
  });
});
