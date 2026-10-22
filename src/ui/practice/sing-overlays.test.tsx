// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { render } from 'preact';
import { act } from 'preact/test-utils';
import { signal } from '@preact/signals';
import { ContextChip, CountInOverlay, CuePill, ProgressHairline, countInSequence } from './sing-overlays';

let container: HTMLElement;

async function show(node: preact.ComponentChild): Promise<void> {
  container = document.createElement('div');
  await act(() => {
    render(node, container);
  });
}

afterEach(async () => {
  if (!container) return;
  await act(() => {
    render(null, container);
  });
  container = undefined as never;
});

describe('countInSequence', () => {
  it('counts the whole count-in down to 1, largest first', () => {
    expect(countInSequence(3, 4)).toEqual([4, 3, 2, 1]);
    expect(countInSequence(2, 2)).toEqual([2, 1]);
  });

  it('never loses the beat it was given, or shows nothing', () => {
    expect(countInSequence(4, 2)).toEqual([4, 3, 2, 1]);
    expect(countInSequence(1, 0)).toEqual([1]);
  });
});

describe('CountInOverlay', () => {
  it('shows nothing outside the count-in', async () => {
    await show(<CountInOverlay beat={null} beats={4} />);
    expect(container.querySelector('[data-testid="count-in"]')).toBeNull();
  });

  it('shows the whole count with the current beat marked and the spent ones set back', async () => {
    await show(<CountInOverlay beat={2} beats={4} />);
    const beats = [...container.querySelectorAll('.pl-count-in__beat')];
    expect(beats.map((b) => b.querySelector('.pl-readout-xl')?.textContent)).toEqual(['4', '3', '2', '1']);
    expect(beats.map((b) => b.className.includes('--now'))).toEqual([false, false, true, false]);
    expect(beats.map((b) => b.className.includes('--gone'))).toEqual([true, true, false, false]);
    expect(container.querySelectorAll('.pl-count-in__dot')).toHaveLength(3);
  });

  it('tells a screen reader the beat, and does not block the canvas', async () => {
    await show(<CountInOverlay beat={3} beats={4} />);
    expect(container.querySelector('[role="status"]')?.textContent).toBe('Count-in, 3');
    expect(container.querySelector('.pl-count-in__row')?.getAttribute('aria-hidden')).toBe('true');
  });
});

describe('CuePill', () => {
  it('shows a short cue as a stage label and a longer one as a sentence', async () => {
    await show(<CuePill cue="Bloom" />);
    expect(container.textContent).toBe('Bloom');
    expect(container.querySelector('.pl-cue-pill--sentence')).toBeNull();
    await act(() => {
      render(<CuePill cue="Hold it steady and straight" />, container);
    });
    expect(container.querySelector('.pl-cue-pill--sentence')).not.toBeNull();
  });

  it('shows nothing without a cue', async () => {
    await show(<CuePill cue={null} />);
    expect(container.querySelector('[data-testid="cue-pill"]')).toBeNull();
  });
});

describe('ProgressHairline', () => {
  it('moves with transform and opacity only, straight from the signal', async () => {
    const progress = signal<number | null>(null);
    await show(<ProgressHairline progress={progress} />);
    const bar = container.querySelector<HTMLElement>('.pl-hairline__bar')!;
    expect(bar.style.transform).toBe('scaleX(0)');
    expect(bar.style.opacity).toBe('0');
    progress.value = 0.25;
    expect(bar.style.transform).toBe('scaleX(0.25)');
    expect(bar.style.opacity).toBe('1');
    progress.value = 7; // never past the end
    expect(bar.style.transform).toBe('scaleX(1)');
    progress.value = null;
    expect(bar.style.opacity).toBe('0');
  });

  it('stops following the signal once it is gone', async () => {
    const progress = signal<number | null>(0.1);
    await show(<ProgressHairline progress={progress} />);
    const bar = container.querySelector<HTMLElement>('.pl-hairline__bar')!;
    await act(() => {
      render(null, container);
    });
    progress.value = 0.9;
    expect(bar.style.transform).toBe('scaleX(0.1)');
  });
});

describe('ContextChip', () => {
  it('shows its text, or nothing', async () => {
    await show(<ContextChip text="Test 2 of 4" />);
    expect(container.textContent).toBe('Test 2 of 4');
    await act(() => {
      render(<ContextChip text={null} />, container);
    });
    expect(container.querySelector('[data-testid="context-chip"]')).toBeNull();
  });
});
