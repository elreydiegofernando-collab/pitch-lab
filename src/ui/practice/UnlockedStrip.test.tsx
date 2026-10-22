// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { render } from 'preact';
import { act } from 'preact/test-utils';
import type { UnlockEvent } from '../../runtime/types';
import { UnlockedStrip, unlockLines } from './UnlockedStrip';

const passed = (levelId: string, title: string): UnlockEvent => ({ kind: 'level-passed', levelId, title, mastery: 1 });
const opened = (levelId: string, title: string): UnlockEvent => ({ kind: 'level-opened', levelId, title });

describe('unlockLines', () => {
  it('leaves out the pass of the level just sung and any tally change: the verdict and the lights say those', () => {
    const lines = unlockLines([passed('foundations.03', 'Sustain I'), { kind: 'mastery', levelId: 'foundations.02', title: 'Pitch match', mastery: 3 }, opened('foundations.04', 'Sustain II')], 'foundations.03');
    expect(lines).toEqual([{ id: 'opened', kind: 'Level', text: 'Sustain II' }]);
  });

  it('lists the other levels an audition test passed, and what it opened', () => {
    const lines = unlockLines([passed('vibrato.01', 'Oscillation I'), passed('vibrato.02', 'Pulse builder I'), opened('vibrato.03', 'Free vibrato')], null);
    expect(lines).toEqual([
      { id: 'passed', kind: 'Passed', text: 'Oscillation I, Pulse builder I' },
      { id: 'opened', kind: 'Level', text: 'Free vibrato' },
    ]);
  });

  it('shortens a long run of levels to first to last', () => {
    const many = ['a', 'b', 'c', 'd', 'e'].map((id) => opened(`x.${id}`, `Level ${id}`));
    expect(unlockLines(many, null)).toEqual([{ id: 'opened', kind: 'Level', text: 'Level a to Level e (5 levels)' }]);
  });

  it('names worlds, features and songs, in the order the runtime gave them', () => {
    const lines = unlockLines(
      [
        opened('vibrato.01', 'Oscillation I'),
        { kind: 'world-opened', worldId: 'vibrato', title: 'Vibrato' },
        { kind: 'feature', featureId: 'live.vibrato', title: 'Vibrato readouts on the Live trace' },
        { kind: 'songs', requiredWorld: 'foundations', count: 3 },
        { kind: 'songs', requiredWorld: 'vibrato', count: 1 },
      ],
      'foundations.boss',
    );
    expect(lines.map((l) => [l.kind, l.text])).toEqual([
      ['Level', 'Oscillation I'],
      ['World', 'Vibrato'],
      ['Feature', 'Vibrato readouts on the Live trace'],
      ['Songs', '3 songs now open'],
      ['Songs', '1 song now open'],
    ]);
  });

  it('is empty when nothing opened', () => {
    expect(unlockLines([], null)).toEqual([]);
    expect(unlockLines([{ kind: 'mastery', levelId: 'a', title: 'A', mastery: 2 }], null)).toEqual([]);
  });
});

describe('UnlockedStrip', () => {
  let container: HTMLElement;
  afterEach(async () => {
    await act(() => {
      render(null, container);
    });
  });

  it('shows the LockOpen glyph, a heading and one row per line, or nothing', async () => {
    container = document.createElement('div');
    await act(() => {
      render(<UnlockedStrip events={[opened('foundations.04', 'Sustain II')]} ownLevelId={null} />, container);
    });
    expect(container.querySelector('section[aria-label="Unlocked"] svg')).not.toBeNull();
    expect(container.querySelector('h2')?.textContent).toBe('Unlocked');
    expect(container.querySelectorAll('li')).toHaveLength(1);
    await act(() => {
      render(<UnlockedStrip events={[]} ownLevelId={null} />, container);
    });
    expect(container.querySelector('section')).toBeNull();
  });
});
