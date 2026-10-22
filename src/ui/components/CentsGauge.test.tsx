// @vitest-environment happy-dom
/** The cents gauge's needle reaches the track's edges at full scale (its lane spans the track; percentages are of the lane). */
import { afterEach, describe, expect, it } from 'vitest';
import { createRef, render } from 'preact';
import { act } from 'preact/test-utils';
import { CentsGauge, needleTransform, type CentsGaugeHandle } from './CentsGauge';

let container: HTMLElement | null = null;

afterEach(async () => {
  const c = container;
  if (!c) return;
  await act(() => {
    render(null, c);
  });
  c.remove();
  container = null;
});

async function mount(): Promise<{ handle: CentsGaugeHandle; lane: HTMLElement; needle: HTMLElement; track: HTMLElement }> {
  const c = document.createElement('div');
  container = c;
  document.body.appendChild(c);
  const ref = createRef<CentsGaugeHandle>();
  await act(() => {
    render(<CentsGauge ref={ref} toleranceCents={25} testId="cents" />, c);
  });
  const track = c.querySelector<HTMLElement>('.pl-cents-gauge__track')!;
  const lane = track.querySelector<HTMLElement>('.pl-cents-gauge__lane')!;
  const needle = lane.querySelector<HTMLElement>('.pl-cents-gauge__needle')!;
  return { handle: ref.current!, lane, needle, track };
}

/** Where the needle's centre lands, as a share of the track: the lane spans the track, the needle sits at its centre. */
const landsAt = (transform: string): number => 0.5 + Number(/translateX\((-?[\d.]+)%\)/.exec(transform)![1]) / 100;

describe('CentsGauge', () => {
  it('maps +-50c to the track edges, the centre to the centre, and clamps beyond', () => {
    expect(landsAt(needleTransform(50))).toBeCloseTo(1, 9);
    expect(landsAt(needleTransform(-50))).toBeCloseTo(0, 9);
    expect(landsAt(needleTransform(0))).toBeCloseTo(0.5, 9);
    expect(landsAt(needleTransform(25))).toBeCloseTo(0.75, 9);
    expect(landsAt(needleTransform(-43))).toBeCloseTo(0.07, 9);
    expect(landsAt(needleTransform(120))).toBeCloseTo(1, 9);
    expect(landsAt(needleTransform(Number.NaN))).toBeCloseTo(0.5, 9);
  });

  it('moves the full-width lane, never the 3 px needle itself (a percentage of the needle is a percentage of 3 px)', async () => {
    const { handle, lane, needle } = await mount();
    handle.update(44, false);
    expect(lane.style.transform).toBe(needleTransform(44));
    expect(landsAt(lane.style.transform)).toBeCloseTo(0.94, 9);
    expect(needle.style.transform).toBe('');
    expect(needle.style.opacity).toBe('1');
    expect(container!.querySelector('[data-testid="cents"]')?.textContent).toBe('+44¢');
    handle.update(-11, true);
    expect(landsAt(lane.style.transform)).toBeCloseTo(0.39, 9);
  });

  it('hides the needle when unvoiced, and writes the readout in the text-safe hue', async () => {
    const { handle, needle } = await mount();
    handle.update(Number.NaN, false);
    expect(needle.style.opacity).toBe('0');
    handle.update(30, false);
    expect(container!.querySelector<HTMLElement>('.pl-cents-gauge__readout')!.style.color).toBe('var(--off-text)');
    handle.update(3, true);
    expect(container!.querySelector<HTMLElement>('.pl-cents-gauge__readout')!.style.color).toBe('var(--on-text)');
  });
});
