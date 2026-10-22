// @vitest-environment happy-dom
/** The report's plain parts, one by one: nothing here is colour-only. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render } from 'preact';
import { act } from 'preact/test-utils';
import type { ReportTile } from '../../exercises/evaluate';
import { routeOf } from '../../router';
import type { AfterTakeAction } from '../../runtime/types';
import type { VocalRange } from '../../storage/schema';
import { RangeCard, rangeLabel } from './RangeCard';
import { ReportBar, splitActions } from './ReportBar';
import { MetricTiles, TipCard, VerdictLine, notJudgedLine } from './ReportParts';

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

const tile = (over: Partial<ReportTile> = {}): ReportTile => ({
  metric: 'accuracy.inTolerancePct',
  label: 'In tune',
  value: 82,
  display: '82%',
  target: 70,
  targetDisplay: '70%',
  op: '>=',
  met: true,
  ...over,
});

describe('VerdictLine', () => {
  it('pairs each verdict with a glyph and words, in a heading the report can move focus to', async () => {
    for (const [verdict, word] of [
      ['passed', 'Passed'],
      ['not-yet', 'Not yet'],
      ['not-judged', 'Not judged'],
      ['done', 'Done'],
    ] as const) {
      await show(<VerdictLine verdict={verdict} word={word} caption="Sustain I" ladderLine={null} />);
      expect(container.querySelector('h2')?.textContent).toBe(word);
      expect(container.querySelector('h2')?.getAttribute('tabindex')).toBe('-1');
      expect(container.querySelector('svg')).not.toBeNull();
      await act(() => {
        render(null, container);
      });
    }
  });

  it('explains a take that was not judged, and shows the ladder line', async () => {
    await show(<VerdictLine verdict="not-judged" word="Not judged" caption="Interval jumps I" ladderLine="Next take at 104 bpm" />);
    expect(container.textContent).toContain('Not judged: this exercise doesn’t fit your saved range.');
    expect(container.textContent).toContain('Next take at 104 bpm');
  });

  it('says why: a folded range, or a take stopped part way (worded for a level or an audition test)', async () => {
    expect(notJudgedLine('folded')).toBe('Not judged: this exercise doesn’t fit your saved range.');
    expect(notJudgedLine('stopped')).toBe('Stopped early: practice only, not judged for the level.');
    expect(notJudgedLine('stopped', true)).toBe('Stopped early: practice only, not judged as a test.');
    await show(<VerdictLine verdict="not-judged" word="Not judged" caption="Sirens & glides" ladderLine={null} reasonLine={notJudgedLine('stopped')} />);
    expect(container.querySelector('[data-testid="verdict-reason"]')?.textContent).toBe('Stopped early: practice only, not judged for the level.');
    expect(container.textContent).not.toContain('saved range');
  });
});

describe('MetricTiles', () => {
  it('shows a met tile with a check and the words "target met"', async () => {
    await show(<MetricTiles tiles={[tile()]} />);
    const el = container.querySelector('.pl-tile')!;
    expect(el.className).toContain('pl-tile--met');
    expect(el.textContent).toContain('In tune');
    expect(el.textContent).toContain('82%');
    expect(el.textContent).toContain('≥ 70%');
    expect(el.textContent).toContain('target met');
    expect(el.querySelector('svg')).not.toBeNull();
  });

  it('shows an unmet tile with a minus and "target not met", and a lower-is-better target with ≤', async () => {
    await show(<MetricTiles tiles={[tile({ metric: 'onset.settleMs', label: 'Settle', display: '310 ms', targetDisplay: '250 ms', op: '<=', met: false })]} />);
    const el = container.querySelector('.pl-tile')!;
    expect(el.className).not.toContain('pl-tile--met');
    expect(el.textContent).toContain('≤ 250 ms');
    expect(el.textContent).toContain('target not met');
  });

  it('says "not measured" for a metric the take could not measure', async () => {
    await show(<MetricTiles tiles={[tile({ value: null, display: '–', met: null })]} />);
    expect(container.textContent).toContain('–');
    expect(container.textContent).toContain('not measured');
  });

  it('is absent without tiles', async () => {
    await show(<MetricTiles tiles={[]} />);
    expect(container.querySelector('.pl-tiles')).toBeNull();
  });
});

describe('TipCard', () => {
  it('shows the one tip with a Lightbulb', async () => {
    await show(<TipCard tip={{ id: 'acc.sharp', text: 'You sat 12¢ sharp on average.', metric: null, value: null }} />);
    expect(container.querySelector('[data-testid="tip"]')?.textContent).toBe('You sat 12¢ sharp on average.');
    expect(container.querySelector('svg')).not.toBeNull();
    expect(container.textContent).toContain('Coaching tip');
  });
});

describe('RangeCard', () => {
  const range: VocalRange = { comfortable: { low: 48, high: 69 }, extended: { low: 45, high: 72 }, measuredAt: '2026-10-21T09:00:00.000Z' };

  it('writes the ranges as note names, in the singer’s notation', async () => {
    expect(rangeLabel(48, 69, 'sharps')).toBe('C3–A4');
    expect(rangeLabel(46, 70, 'flats')).toBe('B♭2–B♭4');
    await show(<RangeCard range={range} notation="sharps" />);
    expect(container.textContent).toContain('Comfortable');
    expect(container.textContent).toContain('C3–A4');
    expect(container.textContent).toContain('A2–C5');
  });

  it('draws one key per semitone with a margin, and marks both ranges by shape as well as tint', async () => {
    await show(<RangeCard range={range} notation="sharps" />);
    const keys = container.querySelectorAll('.pl-rangecard__key');
    expect(keys).toHaveLength(72 - 45 + 1 + 2);
    expect(container.querySelectorAll('.pl-rangecard__key--comfort')).toHaveLength(69 - 48 + 1);
    expect(container.querySelectorAll('.pl-rangecard__key--extended').length).toBe(72 - 45 + 1 - (69 - 48 + 1));
    expect(container.querySelector('.pl-rangecard__bar--comfort')).not.toBeNull();
    expect(container.querySelector('.pl-rangecard__bar--extended')).not.toBeNull();
    expect(container.querySelector('.pl-rangecard__keys')?.getAttribute('aria-hidden')).toBe('true');
  });
});

describe('ReportBar', () => {
  const action = (kind: AfterTakeAction['kind'], label: string, primary: boolean): AfterTakeAction => ({ kind, label, primary, route: routeOf('map') });

  it('splits one primary from the rest, whatever the list says', () => {
    const list = [action('retry', 'Retry', false), action('next-level', 'Next level', true), action('level', 'Back to level', false)];
    const { primary, others } = splitActions(list);
    expect(primary?.kind).toBe('next-level');
    expect(others.map((a) => a.kind)).toEqual(['retry', 'level']);
    expect(splitActions([action('retry', 'A', true), action('level', 'B', true)]).primary?.kind).toBe('retry');
    expect(splitActions([action('retry', 'A', false), action('level', 'B', false)]).primary?.kind).toBe('retry');
    expect(splitActions([]).primary).toBeNull();
  });

  it('renders the primary full width on top and the others as secondary buttons, each calling onAct', async () => {
    const onAct = vi.fn();
    await show(<ReportBar actions={[action('next-level', 'Next level', true), action('retry', 'Retry', false)]} onAct={onAct} />);
    const primary = container.querySelector<HTMLButtonElement>('.pl-btn--primary')!;
    expect(primary.textContent).toContain('Next level');
    expect(primary.className).toContain('pl-btn--block');
    primary.click();
    container.querySelector<HTMLButtonElement>('.pl-btn--secondary')!.click();
    expect(onAct.mock.calls.map((c) => (c[0] as AfterTakeAction).kind)).toEqual(['next-level', 'retry']);
  });

  it('renders nothing when there is nothing to offer', async () => {
    await show(<ReportBar actions={[]} onAct={vi.fn()} />);
    expect(container.querySelector('nav')).toBeNull();
  });
});
