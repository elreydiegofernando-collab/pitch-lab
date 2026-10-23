// @vitest-environment happy-dom
/** ReportBar: every next step the report can offer has its glyph next to its words, the check-up's and the lesson's included. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render } from 'preact';
import { act } from 'preact/test-utils';
import { routeOf } from '../../router';
import type { AfterTakeAction } from '../../runtime/types';
import { ReportBar } from './ReportBar';

let container: HTMLElement | null = null;

afterEach(async () => {
  if (!container) return;
  const c = container;
  await act(() => {
    render(null, c);
  });
  container = null;
});

async function show(actions: AfterTakeAction[], onAct = vi.fn()): Promise<HTMLElement> {
  const c = document.createElement('div');
  container = c;
  await act(() => {
    render(<ReportBar actions={actions} onAct={onAct} />, c);
  });
  return c;
}

describe('ReportBar: the check-up’s next steps', () => {
  it('"Next task" and "See your results" are the amber primary, each with a glyph, and call onAct', async () => {
    const cases: AfterTakeAction[] = [
      { kind: 'next-task', label: 'Next task', primary: true, route: routeOf('sing', { target: 'checkup', itemIndex: '2' }) },
      { kind: 'checkup-results', label: 'See your results', primary: true, route: routeOf('checkup') },
    ];
    for (const action of cases) {
      const onAct = vi.fn();
      const c = await show([action], onAct);
      const primary = c.querySelector<HTMLButtonElement>('.pl-btn--primary')!;
      expect(primary.textContent).toContain(action.label);
      expect(primary.querySelector('svg')).not.toBeNull();
      primary.click();
      expect(onAct).toHaveBeenCalledWith(action);
      await act(() => {
        render(null, c);
      });
      container = null;
    }
  });
});

describe('ReportBar: a lesson’s practice try', () => {
  const drill = (step: number) => routeOf('sing', { target: 'drill', levelId: 'foundations.02', itemIndex: String(step) });
  const lesson = routeOf('level', { levelId: 'foundations.02' });

  it('each practice step, as the amber primary or under it, has its glyph and calls onAct', async () => {
    const lists: AfterTakeAction[][] = [
      [
        { kind: 'next-step', label: 'Next step', primary: true, route: drill(1) },
        { kind: 'next-try', label: 'One more try', primary: false, route: drill(0) },
      ],
      [
        { kind: 'take-check', label: 'Take the check', primary: true, route: routeOf('sing', { target: 'level', levelId: 'foundations.02' }) },
        { kind: 'next-try', label: 'One more try', primary: false, route: drill(1) },
      ],
      [
        { kind: 'next-try', label: 'Try again', primary: true, route: drill(0) },
        { kind: 'lesson', label: 'Back to the lesson', primary: false, route: lesson },
      ],
    ];
    for (const actions of lists) {
      const onAct = vi.fn();
      const c = await show(actions, onAct);
      const primary = c.querySelector<HTMLButtonElement>('[data-testid="report-primary"]')!;
      expect(primary.textContent).toContain(actions[0].label);
      expect(primary.querySelector('svg')).not.toBeNull();
      const other = c.querySelector<HTMLButtonElement>(`[data-testid="report-${actions[1].kind}"]`)!;
      expect(other.textContent).toContain(actions[1].label);
      expect(other.querySelector('svg')).not.toBeNull();
      expect(c.querySelectorAll('.pl-btn--primary')).toHaveLength(1);
      other.click();
      primary.click();
      expect(onAct.mock.calls).toEqual([[actions[1]], [actions[0]]]);
      await act(() => {
        render(null, c);
      });
      container = null;
    }
  });
});
