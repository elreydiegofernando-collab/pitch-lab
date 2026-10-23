// @vitest-environment happy-dom
/**
 * "Learn this song": the step to do now with its one action, which waits for a calibration before a sung step and
 * while a take runs; and the whole song learned.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render } from 'preact';
import { act } from 'preact/test-utils';
import { songPractice } from '../../song/practice';
import { parseUltraStar } from '../../song/ultrastar';
import { LearnPanel, stepAction, type LearnPanelProps } from './LearnPanel';

const SONG = parseUltraStar(`#TITLE:T\n#ARTIST:N\n#BPM:60\n#GAP:0\n: 0 4 0  O\n: 4 4 2  ho\n- 10\n: 12 4 4  ly\nE\n`, { id: 't', source: 'bundled' }).song;
const PRACTICE = songPractice(SONG, []);

let container: HTMLElement;
const q = (id: string): HTMLElement | null => container.querySelector<HTMLElement>(`[data-testid="${id}"]`);

async function show(props: Partial<LearnPanelProps> = {}): Promise<LearnPanelProps> {
  const full: LearnPanelProps = { practice: PRACTICE, step: PRACTICE.steps[1], index: 1, busy: false, canSing: true, onStart: vi.fn(), onProgress: vi.fn(), ...props };
  container = document.createElement('div');
  document.body.appendChild(container);
  await act(() => {
    render(<LearnPanel {...full} />, container);
  });
  return full;
}

afterEach(async () => {
  await act(() => {
    render(null, container);
  });
  container.remove();
});

describe('LearnPanel', () => {
  it('shows the step and starts it in one tap', async () => {
    const props = await show();
    expect(q('learn-count')?.textContent).toBe(`Step 2 of ${PRACTICE.steps.length}`);
    expect(q('learn-step')?.textContent).toBe('Phrase 1, slowly: “O ho”');
    q('learn-start')!.click();
    expect(props.onStart).toHaveBeenCalledWith(PRACTICE.steps[1]);
    q('learn-progress')!.click();
    expect(props.onProgress).toHaveBeenCalledTimes(1);
    // A secondary button: the bar's Sing stays the one amber action.
    expect(q('learn-start')?.classList.contains('pl-btn--secondary')).toBe(true);
  });

  it('waits for a calibration before a sung step, never before listening, and while a take runs', async () => {
    await show({ canSing: false });
    expect((q('learn-start') as HTMLButtonElement).disabled).toBe(true);
    await act(() => {
      render(<LearnPanel practice={PRACTICE} step={PRACTICE.steps[0]} index={0} busy={false} canSing={false} onStart={vi.fn()} onProgress={vi.fn()} />, container);
    });
    expect((q('learn-start') as HTMLButtonElement).disabled).toBe(false);
    expect(q('learn-start')?.textContent).toBe('Listen');
    await act(() => {
      render(<LearnPanel practice={PRACTICE} step={PRACTICE.steps[0]} index={0} busy canSing onStart={vi.fn()} onProgress={vi.fn()} />, container);
    });
    expect((q('learn-start') as HTMLButtonElement).disabled).toBe(true);
  });

  it('says when the whole song is learned, and still links to the progress', async () => {
    await show({ step: null, index: PRACTICE.steps.length });
    expect(q('learn-step')?.textContent).toBe('You have learned the whole song.');
    expect(q('learn-start')).toBeNull();
    expect(q('learn-progress')).not.toBeNull();
  });

  it('names each step’s action plainly', () => {
    expect(PRACTICE.steps.map(stepAction)).toEqual(['Listen', 'Sing it slowly', 'Sing it', 'Sing it slowly', 'Sing it', 'Sing them together', 'Sing the whole song']);
  });
});
