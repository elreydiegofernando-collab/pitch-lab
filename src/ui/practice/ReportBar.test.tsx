// @vitest-environment happy-dom
/** ReportBar: every next step the report can offer has its glyph next to its words, the check-up's two included. */
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
