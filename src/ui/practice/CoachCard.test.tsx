// @vitest-environment happy-dom
/** CoachCard at each depth: more help with each miss in a row, spot chips that mark the replay, calm buttons, plain words. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render } from 'preact';
import { act } from 'preact/test-utils';
import { jargonIn } from '../../coaching/plain';
import type { CoachMove, Coaching } from '../../coaching/types';
import { getExercise } from '../../exercises';
import { CoachCard, depthLine, hasSlowDemo, restLine, type CoachCardProps } from './CoachCard';

let container: HTMLElement;

async function show(props: Partial<CoachCardProps> & { coaching: Coaching }): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  await act(() => {
    render(<CoachCard {...props} />, container);
  });
}

afterEach(async () => {
  if (!container) return;
  await act(() => {
    render(null, container);
  });
  container.remove();
  container = undefined as never;
});

const q = <T extends Element = HTMLElement>(sel: string): T | null => container.querySelector<T>(sel);
const all = (sel: string): HTMLElement[] => [...container.querySelectorAll<HTMLElement>(sel)];

const LADDER = {
  tip: 'Aim each note a hair higher than feels natural.',
  why: 'The pitch drops when the breath runs low. Keeping the air moving keeps the note up.',
  steps: ['Take a calm breath before the note.', 'Hear the note in your head.', 'Sing it and keep the air moving to the end.'],
  easier: 'Try it on a soft hum first, then open to "ah".',
};

function coaching(depth: 1 | 2 | 3 | 4, over: Partial<Coaching> = {}): Coaching {
  const misses = depth === 1 ? 1 : depth === 2 ? 2 : depth === 3 ? 3 : 5;
  const moves: CoachMove[] = [];
  if (depth === 4) moves.push({ kind: 'listen-slow' }, { kind: 'practise-level', levelId: 'foundations.02', title: 'Match one note' });
  if (depth >= 3) moves.push({ kind: 'send-to-claude' });
  return {
    depth,
    missesInARow: misses,
    passed: false,
    problem: {
      tipId: 'acc.flat',
      metric: 'accuracy.absBiasCents',
      what: 'On average you sang a little flat; note 2 (D4) was the furthest off.',
      spots: [
        { t: 4, label: 'note 2 (D4), flat by about a quarter of the way to the next note' },
        { t: 8, label: 'note 3 (E4), a little flat' },
      ],
    },
    tip: LADDER.tip,
    why: depth >= 2 ? LADDER.why : null,
    steps: depth >= 3 ? LADDER.steps : [],
    easier: depth >= 4 ? LADDER.easier : null,
    progress: [],
    moves,
    ...over,
  };
}

describe('CoachCard: the depths', () => {
  it('depth 1: where it slipped, the spots and the tip, and nothing more', async () => {
    await show({ coaching: coaching(1) });
    expect(q('[data-testid="coach-card"]')?.getAttribute('data-depth')).toBe('1');
    expect(q('[data-testid="coach-what"]')?.textContent).toBe('On average you sang a little flat; note 2 (D4) was the furthest off.');
    expect(q('[data-testid="tip"]')?.textContent).toBe(LADDER.tip);
    expect(container.textContent).toContain('Try this');
    expect(q('[data-testid="coach-depth"]')).toBeNull();
    expect(q('[data-testid="coach-why"]')).toBeNull();
    expect(q('[data-testid="coach-steps"]')).toBeNull();
    expect(q('[data-testid="coach-easier"]')).toBeNull();
    expect(q('[data-testid="coach-moves"]')).toBeNull();
  });

  it('depth 2: says why more appears, and why it happens', async () => {
    await show({ coaching: coaching(2) });
    expect(q('[data-testid="coach-depth"]')?.textContent).toBe('Second try in a row, so here is why it happens.');
    expect(q('[data-testid="coach-why"]')?.textContent).toBe(LADDER.why);
    expect(q('[data-testid="coach-steps"]')).toBeNull();
  });

  it('depth 3: numbered steps, and Send to Claude', async () => {
    const onMove = vi.fn();
    await show({ coaching: coaching(3), onMove, listen: { slow: true, playing: false, onClick: vi.fn() } });
    expect(q('[data-testid="coach-depth"]')?.textContent).toBe('Third try in a row, so here is a step-by-step.');
    const steps = all('[data-testid="coach-steps"] li');
    expect(steps.map((li) => li.textContent)).toEqual(LADDER.steps.map((s, i) => `${i + 1}${s}`));
    expect(q('[data-testid="coach-easier"]')).toBeNull();
    expect(q('[data-testid="coach-listen"]')).toBeNull();
    q<HTMLButtonElement>('[data-testid="coach-send"]')!.click();
    expect(onMove).toHaveBeenCalledWith({ kind: 'send-to-claude' });
  });

  it('depth 4: an easier way in, a slow listen, an earlier level to practise and Send to Claude', async () => {
    const onMove = vi.fn();
    const listen = vi.fn();
    await show({ coaching: coaching(4), onMove, listen: { slow: true, playing: false, onClick: listen } });
    expect(q('[data-testid="coach-depth"]')?.textContent).toBe('Fifth try in a row, so here is a gentler way in.');
    expect(q('[data-testid="coach-easier"]')?.textContent).toBe(LADDER.easier);
    const listenButton = q<HTMLButtonElement>('[data-testid="coach-listen"]')!;
    expect(listenButton.textContent).toBe('Listen slowly');
    listenButton.click();
    expect(listen).toHaveBeenCalledTimes(1);
    const practise = q<HTMLButtonElement>('[data-testid="coach-practise"]')!;
    expect(practise.textContent).toBe('Practise Match one note');
    practise.click();
    expect(onMove).toHaveBeenCalledWith({ kind: 'practise-level', levelId: 'foundations.02', title: 'Match one note' });
  });

  it('makes each music word in its prose tappable where it first appears, once per card (review R7)', async () => {
    await show({
      coaching: coaching(3, {
        problem: { tipId: 'acc.sharp', metric: 'accuracy.absBiasCents', what: 'On average you sang sharp by about a half step.', spots: [] },
        tip: 'Aim a little lower: sharp means too high.',
        why: 'A note sung sharp sits about a half step too high when the jaw is tight.',
      }),
    });
    const terms = all('[data-testid="coach-card"] button[data-term]');
    expect(terms.map((t) => [t.dataset.term, t.textContent])).toEqual([
      ['sharp', 'sharp'],
      ['half-step', 'half step'],
      ['note', 'note'], // first met in the why
    ]);
    // Inside the "what": the first time each word appears; the tip and the why repeat them as plain text.
    expect(q('[data-testid="coach-what"] button[data-term="sharp"]')).not.toBeNull();
    expect(q('[data-testid="tip"] button[data-term]')).toBeNull();
    expect(q('[data-testid="coach-why"] button[data-term="sharp"]')).toBeNull();
    await act(() => {
      terms[0].click();
    });
    expect(document.querySelector('[role="dialog"]')?.getAttribute('aria-label')).toBe('Sharp');
  });

  it('reads "Listen again" without a slow demo, "Stop" while it plays, and hides the listen with no demo to play', async () => {
    await show({ coaching: coaching(4), listen: { slow: false, playing: false, onClick: vi.fn() } });
    expect(q('[data-testid="coach-listen"]')?.textContent).toBe('Listen again');
    await act(() => {
      render(<CoachCard coaching={coaching(4)} listen={{ slow: false, playing: true, onClick: vi.fn() }} />, container);
    });
    expect(q('[data-testid="coach-listen"]')?.textContent).toBe('Stop');
    await act(() => {
      render(<CoachCard coaching={coaching(4)} listen={null} />, container);
    });
    expect(q('[data-testid="coach-listen"]')).toBeNull();
    expect(q('[data-testid="coach-send"]')).not.toBeNull();
  });

  it('counts a long run of misses in good English (review R8)', () => {
    const line = (n: number) => depthLine({ depth: 4, missesInARow: n, passed: false });
    expect(line(11)).toBe('11th try in a row, so here is a gentler way in.');
    expect(line(21)).toBe('21st try in a row, so here is a gentler way in.');
    expect(line(22)).toBe('22nd try in a row, so here is a gentler way in.');
    expect(line(23)).toBe('23rd try in a row, so here is a gentler way in.');
    expect(depthLine({ depth: 3, missesInARow: 3, passed: false })).toBe('Third try in a row, so here is a step-by-step.');
  });

  it('a pass: the next step, without nagging', async () => {
    await show({ coaching: coaching(1, { passed: true, missesInARow: 0, tip: 'Clean take. Replay to light the next tally.' }) });
    expect(container.textContent).toContain('Next');
    expect(container.textContent).not.toContain('Try this');
    expect(q('[data-testid="coach-depth"]')).toBeNull();
    expect(depthLine({ depth: 4, missesInARow: 0, passed: true })).toBeNull();
  });

  it('keeps the screen’s one amber button: every coaching button is secondary or quieter', async () => {
    await show({ coaching: coaching(4), onMove: vi.fn(), listen: { slow: true, playing: false, onClick: vi.fn() } });
    expect(q('.pl-btn--primary')).toBeNull();
    expect(all('.pl-btn').length).toBe(3);
  });
});

describe('CoachCard: spots', () => {
  it('marks a spot on the replay when tapped, and clears it when tapped again', async () => {
    const onSelectSpot = vi.fn();
    await show({ coaching: coaching(1), selectedSpot: null, onSelectSpot });
    const chips = all('[data-testid="coach-spot"]');
    expect(chips.map((c) => c.textContent)).toEqual(['note 2 (D4), flat by about a quarter of the way to the next note', 'note 3 (E4), a little flat']);
    expect(chips.every((c) => c.tagName === 'BUTTON' && c.getAttribute('aria-pressed') === 'false')).toBe(true);
    expect(container.textContent).toContain('Tap one to mark it on the replay above.');
    chips[1].click();
    expect(onSelectSpot).toHaveBeenLastCalledWith(1);
    await act(() => {
      render(<CoachCard coaching={coaching(1)} selectedSpot={1} onSelectSpot={onSelectSpot} />, container);
    });
    const marked = all('[data-testid="coach-spot"]')[1];
    expect(marked.getAttribute('aria-pressed')).toBe('true');
    marked.click();
    expect(onSelectSpot).toHaveBeenLastCalledWith(null);
  });

  it('lists the spots as plain text where there is no replay to mark', async () => {
    await show({ coaching: coaching(1) });
    const chips = all('[data-testid="coach-spot"]');
    expect(chips).toHaveLength(2);
    expect(chips.every((c) => c.tagName === 'SPAN')).toBe(true);
    expect(container.textContent).not.toContain('Tap one');
  });

  it('shows no spot list when the problem cannot be placed', async () => {
    await show({ coaching: coaching(1, { problem: { tipId: 'general.no-voice', metric: null, what: 'No singing came through.', spots: [] } }) });
    expect(q('.pl-coach__spots')).toBeNull();
  });

  it('shows the tip alone when there is no located problem to say', async () => {
    await show({ coaching: coaching(1, { problem: { tipId: 'acc.flat', metric: null, what: '', spots: [] } }) });
    expect(q('[data-testid="coach-what"]')).toBeNull();
    expect(q('[data-testid="tip"]')?.textContent).toBe(LADDER.tip);
  });
});

describe('CoachCard: since last time, and rest', () => {
  it('lists each measure before and now, with better or worse in words and a glyph', async () => {
    await show({
      coaching: coaching(2, {
        progress: [
          { label: 'Time in tune', before: '52%', now: '68%', better: true },
          { label: 'Breaks', before: '1', now: '2', better: false },
          { label: 'Typical miss', before: 'a little', now: 'a little', better: null },
        ],
      }),
    });
    expect(container.textContent).toContain('Since last time');
    const lines = all('[data-testid="coach-progress-line"]');
    expect(lines).toHaveLength(3);
    expect(lines[0].textContent).toContain('Time in tune');
    expect(lines[0].textContent).toContain('52%');
    expect(lines[0].textContent).toContain('68%');
    expect(lines[0].textContent).toContain('better');
    expect(lines[0].className).toContain('pl-coach__line--better');
    expect(lines[1].textContent).toContain('not as good');
    expect(lines[2].textContent).toContain('about the same');
    for (const line of lines) expect(line.querySelectorAll('svg').length).toBeGreaterThanOrEqual(2);
    // A screen reader hears which value is which.
    expect(lines[0].textContent).toContain('Last time');
    expect(lines[0].textContent).toContain('this time');
  });

  it('asks for a rest in plain words, with the voice-care line', async () => {
    await show({ coaching: coaching(4, { missesInARow: 6, moves: [{ kind: 'rest' }] }) });
    const rest = q('[data-testid="coach-rest"]')!;
    expect(rest.textContent).toContain('That is a lot of tries in a row.');
    expect(rest.textContent).toContain('Stop if anything hurts, scratches or goes hoarse.');
    expect(restLine({ missesInARow: 1 })).toMatch(/^You have sung a lot in the last few minutes\./);
    // The rest is a note, not a button.
    expect(q('[data-testid="coach-moves"]')).toBeNull();
  });

  it('says it all in plain words', async () => {
    await show({ coaching: coaching(4, { moves: [{ kind: 'rest' }, { kind: 'send-to-claude' }], progress: [{ label: 'Time in tune', before: '52%', now: '68%', better: true }] }), onMove: vi.fn() });
    expect(jargonIn(container.textContent ?? '')).toEqual([]);
  });
});

describe('hasSlowDemo', () => {
  it('is true for a slow demo or a tempo ladder', () => {
    expect(hasSlowDemo(getExercise('runs.run.3')!)).toBe(true);
    expect(hasSlowDemo(getExercise('inflections.turn.1')!)).toBe(true);
    expect(hasSlowDemo(getExercise('foundations.sustain.1')!)).toBe(false);
  });
});
