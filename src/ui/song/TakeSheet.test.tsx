// @vitest-environment happy-dom
/**
 * The song take sheet: the breakdown, the coaching card for the take (where it went wrong by syllable and time, its
 * moves), exactly one amber action (the way on after a pass, Retry after a miss), and the titles of joined takes.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render } from 'preact';
import { act } from 'preact/test-utils';
import { phraseMove } from '../../coaching/song';
import type { Coaching } from '../../coaching/types';
import type { SongTakeResult } from '../../runtime/song-session';
import { TakeSheet, selectionTitle, type TakeSheetProps } from './TakeSheet';

const MISS: Coaching = {
  depth: 2,
  missesInARow: 2,
  passed: false,
  problem: { tipId: 'song.flat', metric: 'song.phraseScore', what: 'On “ho-” in “O holy night” at 0:11 you were a little flat.', spots: [{ t: 11, label: '0:11, “ho-”, a little flat' }] },
  tip: 'Keep the air moving to the end of each word.',
  why: 'Singing flat usually comes from too little energy behind the note.',
  steps: [],
  easier: null,
  progress: [{ label: 'Score', before: '52%', now: '61%', better: true }],
  moves: [phraseMove(1), { kind: 'listen-slow' }],
};

function result(over: Partial<SongTakeResult> = {}): SongTakeResult {
  return {
    selection: { from: 0, to: 2 },
    speed: 1,
    shift: 0,
    phrase: { from: 0, to: 2 },
    phrases: [
      { phraseIndex: 0, text: 'O holy night', score: { phraseIndex: 0, start: 10, end: 15, pitchScore: 0.8, inTolerancePct: 70, timingOffsetMs: 20, stabilitySdCents: 8, vibratoPresent: false } },
      { phraseIndex: 1, text: 'The stars shine', score: { phraseIndex: 1, start: 16, end: 20, pitchScore: 0.4, inTolerancePct: 30, timingOffsetMs: 40, stabilitySdCents: 9, vibratoPresent: false } },
    ],
    score: 0.6,
    inTolerancePct: 50,
    passed: false,
    attempt: null,
    attemptError: null,
    savedTake: null,
    saveError: null,
    audio: null,
    unfinished: 0,
    coaching: MISS,
    ...over,
  };
}

let container: HTMLElement;

async function show(props: Partial<TakeSheetProps> = {}): Promise<TakeSheetProps> {
  const full: TakeSheetProps = {
    result: result(),
    open: true,
    forward: null,
    takePlaying: false,
    onClose: vi.fn(),
    onRetry: vi.fn(),
    onPlayTake: vi.fn(),
    listen: { slow: true, playing: false, onClick: vi.fn() },
    onMove: vi.fn(),
    ...props,
  };
  container = document.createElement('div');
  document.body.appendChild(container);
  await act(() => {
    render(<TakeSheet {...full} />, container);
  });
  return full;
}

const q = <T extends Element = HTMLElement>(sel: string): T | null => container.querySelector<T>(sel);
const buttons = (): HTMLButtonElement[] => [...container.querySelectorAll<HTMLButtonElement>('.pl-song-result__actions button')];

afterEach(async () => {
  await act(() => {
    render(null, container);
  });
  container.remove();
});

describe('TakeSheet', () => {
  it('shows the coaching for the take: where it went wrong, the help, since last time and its moves', async () => {
    const props = await show();
    expect(q('[role="dialog"]')?.getAttribute('aria-label')).toBe('Phrases 1 and 2');
    expect(q('[data-testid="coach-what"]')?.textContent).toBe(MISS.problem.what);
    expect(q('[data-testid="coach-spot"]')?.textContent).toBe('0:11, “ho-”, a little flat');
    expect(q('[data-testid="coach-why"]')?.textContent).toBe(MISS.why);
    expect(q('[data-testid="coach-progress"]')?.textContent).toContain('52%');
    q<HTMLButtonElement>('[data-testid="coach-practise"]')!.click();
    expect(props.onMove).toHaveBeenCalledWith(phraseMove(1));
    expect(q('[data-testid="coach-practise"]')?.textContent).toBe('Practise phrase 2 alone');
    q<HTMLButtonElement>('[data-testid="coach-listen"]')!.click();
    expect(props.listen!.onClick).toHaveBeenCalledTimes(1);
    expect(q('[data-testid="coach-listen"]')?.textContent).toBe('Listen slowly');
  });

  it('after a miss, Retry is the one amber action; after a pass, the way on is', async () => {
    const miss = await show({ forward: { label: 'Next phrase', onClick: vi.fn() } });
    let [retry, next] = buttons();
    expect(retry.textContent).toBe('Sing them again');
    expect(retry.classList.contains('pl-btn--primary')).toBe(true);
    expect(next.classList.contains('pl-btn--primary')).toBe(false);
    retry.click();
    expect(miss.onRetry).toHaveBeenCalledTimes(1);
    await act(() => {
      render(null, container);
    });
    container.remove();

    const forward = { label: 'Full speed', ariaLabel: 'Full speed (Phrase 1: “O holy night”)', onClick: vi.fn() };
    await show({ result: result({ selection: { from: 0, to: 1 }, passed: true, score: 0.82, speed: 0.75, coaching: { ...MISS, passed: true, depth: 1, why: null, moves: [] } }), forward });
    [retry, next] = buttons();
    expect(retry.textContent).toBe('Retry phrase');
    expect(retry.classList.contains('pl-btn--primary')).toBe(false);
    expect(next.textContent).toBe('Full speed');
    expect(next.getAttribute('aria-label')).toBe(forward.ariaLabel);
    expect(next.classList.contains('pl-btn--primary')).toBe(true);
    expect(container.querySelectorAll('.pl-btn--primary')).toHaveLength(1);
    next.click();
    expect(forward.onClick).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain('Sung at 75% speed');
  });

  it('with nowhere to go, Done closes, and a take with no coaching still shows its breakdown', async () => {
    const props = await show({ result: result({ selection: null, coaching: null }) });
    expect(q('[data-testid="coach-card"]')).toBeNull();
    expect(container.querySelectorAll('.pl-song-breakdown__row')).toHaveLength(2);
    const done = buttons().find((b) => b.textContent === 'Done')!;
    done.click();
    expect(props.onClose).toHaveBeenCalledTimes(1);
    expect(buttons()[0].textContent).toBe('Sing again');
  });

  it('titles a selection by its phrases', () => {
    expect(selectionTitle(null)).toBe('Whole song');
    expect(selectionTitle({ from: 2, to: 3 })).toBe('Phrase 3');
    expect(selectionTitle({ from: 2, to: 4 })).toBe('Phrases 3 and 4');
    expect(selectionTitle({ from: 2, to: 5 })).toBe('Phrases 3 to 5');
  });
});
