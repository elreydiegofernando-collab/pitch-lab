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
import { jargonIn } from '../../coaching/plain';
import { MetricTiles, VerdictLine, notJudgedLine, unmeasuredLine } from './ReportParts';

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

  it('says why a check-up task measured nothing, in plain words that never judge', () => {
    const lines = (['stopped', 'quiet', 'silent'] as const).map(unmeasuredLine);
    expect(lines).toEqual([
      'Stopped early, so this task was not measured.',
      'Not all of this task was heard, so it was not measured.',
      'Nothing came through the microphone, so this task was not measured.',
    ]);
    for (const line of lines) {
      expect(jargonIn(line), line).toEqual([]);
      expect(line).not.toMatch(/judged|test|level|fail/i);
    }
  });
});

describe('MetricTiles', () => {
  it('shows a met tile in plain words, with a check and the words "goal met"', async () => {
    await show(<MetricTiles tiles={[tile()]} />);
    const el = container.querySelector('.pl-tile')!;
    expect(el.className).toContain('pl-tile--met');
    expect(el.textContent).toContain('In tune');
    expect(el.querySelector('[data-testid="tile-accuracy.inTolerancePct-value"]')!.textContent).toBe('82% of the time');
    expect(el.querySelector('[data-testid="tile-accuracy.inTolerancePct-goal"]')!.textContent).toBe('Goal: 70% of the time or more');
    expect(el.textContent).toContain('goal met');
    expect(el.querySelector('svg')).not.toBeNull();
  });

  it('shows an unmet tile with a minus and "goal not met", and a lower-is-better goal as "within" or "no more than"', async () => {
    await show(
      <MetricTiles
        tiles={[tile({ metric: 'onset.settleMs', label: 'Time to find the note', value: 310, display: '310 ms', target: 250, targetDisplay: '250 ms', op: '<=', met: false })]}
      />,
    );
    const el = container.querySelector('.pl-tile')!;
    expect(el.className).not.toContain('pl-tile--met');
    expect(el.querySelector('[data-testid="tile-onset.settleMs-value"]')!.textContent).toBe('About a third of a second');
    expect(el.querySelector('[data-testid="tile-onset.settleMs-goal"]')!.textContent).toBe('Goal: within about a quarter of a second');
    expect(el.textContent).toContain('goal not met');
  });

  it('says a miss in words, never "828¢": about 8 half steps, against a goal of how close', async () => {
    await show(
      <MetricTiles tiles={[tile({ metric: 'glide.endAbsCents', label: 'Slide ending off by', value: 828, display: '828¢', target: 48, targetDisplay: '48¢', op: '<=', met: false })]} />,
    );
    const el = container.querySelector('.pl-tile')!;
    expect(el.textContent).toContain('Slide ending off by');
    expect(el.textContent).toContain('About 8 half steps');
    expect(el.textContent).toContain('Goal: within about half the way to the next note');
    expect(el.textContent).not.toContain('828');
    expect(el.textContent).not.toContain('¢');
  });

  it('says "Not measured" for a metric the take could not measure, still with its goal', async () => {
    await show(<MetricTiles tiles={[tile({ value: null, display: '–', met: null })]} />);
    expect(container.querySelector('[data-testid="tile-accuracy.inTolerancePct-value"]')!.textContent).toBe('Not measured');
    expect(container.textContent).toContain('Goal: 70% of the time or more');
    expect(container.textContent).toContain('not measured');
    expect(container.querySelector('.pl-tile--met')).toBeNull();
  });

  it('shows no unit and no jargon on any tile, whatever the metric', async () => {
    const tiles: ReportTile[] = [
      tile(),
      tile({ metric: 'accuracy.medianAbsCents', label: 'Typical miss', value: 18, target: 25, op: '<=', met: true }),
      tile({ metric: 'accuracy.absDriftCentsPerSec', label: 'Drift', value: 2, target: 6.25, op: '<=', met: true }),
      tile({ metric: 'glide.cracks', label: 'Breaks', value: 3, target: 3.8, op: '<=', met: true }),
      tile({ metric: 'range.spanSemitones', label: 'Low to high', value: 15, target: 12, op: '>=', met: true }),
    ];
    await show(<MetricTiles tiles={tiles} />);
    const text = container.textContent ?? '';
    expect(jargonIn(text)).toEqual([]);
    expect(text).not.toMatch(/\d\s*(?:¢|ms|Hz|dB)\b/);
    expect(text).not.toMatch(/[≥≤]/);
    expect(container.querySelector('[data-testid="tile-glide.cracks-value"]')!.textContent).toBe('3 breaks');
    expect(container.querySelector('[data-testid="tile-glide.cracks-goal"]')!.textContent).toBe('Goal: up to 3 breaks');
  });

  it('lets a label that is a music word be tapped to learn it', async () => {
    await show(<MetricTiles tiles={[tile(), tile({ metric: 'glide.smoothness', label: 'Smoothness', value: 0.5, target: 0.25, op: '>=', met: true })]} />);
    const inTune = container.querySelector('[data-testid="tile-accuracy.inTolerancePct"] button[data-term="in-tune"]')!;
    expect(inTune.textContent).toBe('In tune');
    expect(container.querySelector('[data-testid="tile-glide.smoothness"] button')).toBeNull();
    await act(() => {
      (inTune as HTMLButtonElement).click();
    });
    expect(document.querySelector('[role="dialog"]')?.getAttribute('aria-label')).toBe('In tune');
    await act(() => {
      document.querySelector<HTMLButtonElement>('button[aria-label="Close"]')!.click();
    });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it('is absent without tiles', async () => {
    await show(<MetricTiles tiles={[]} />);
    expect(container.querySelector('.pl-tiles')).toBeNull();
  });
});

describe('RangeCard', () => {
  const range: VocalRange = { comfortable: { low: 48, high: 69 }, extended: { low: 45, high: 72 }, measuredAt: '2026-10-21T09:00:00.000Z' };

  it('writes the ranges as note names, in the singer’s notation', async () => {
    expect(rangeLabel(48, 69, 'sharps')).toBe('C3–A4');
    expect(rangeLabel(46, 70, 'flats')).toBe('B♭2–B♭4');
    await show(<RangeCard range={range} notation="sharps" />);
    expect(container.textContent).toContain('Practice range');
    expect(container.textContent).toContain('C3–A4');
    expect(container.textContent).toContain('Full reach');
    expect(container.textContent).toContain('A2–C5');
  });

  it('explains the note names and marks middle C when it is on the strip', async () => {
    await show(<RangeCard range={range} notation="sharps" />);
    expect(container.querySelector('[data-testid="middle-c"]')).not.toBeNull();
    expect(container.textContent).toContain('The dot marks middle C (C4)');
    await show(<RangeCard range={{ ...range, comfortable: { low: 64, high: 76 }, extended: { low: 62, high: 79 } }} notation="sharps" />);
    expect(container.querySelector('[data-testid="middle-c"]')).toBeNull();
    expect(container.textContent).toContain('middle C is C4');
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
