// @vitest-environment happy-dom
/**
 * The gauge's needle reaches the track's edges at full scale (its lane spans the track; percentages are of the lane), and
 * it reads in words, never in units: "On it", "A little high" or "A little low", each with a glyph.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createRef, render } from 'preact';
import { act } from 'preact/test-utils';
import { jargonIn } from '../../coaching/plain';
import { CONFIG } from '../../config';
import { CentsGauge, HOLD_QUIET_SEC, HOLD_SEC, needleTransform, pitchWords, type CentsGaugeHandle, type CentsGaugeProps } from './CentsGauge';

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

async function mount(props: CentsGaugeProps = {}): Promise<{ handle: CentsGaugeHandle; lane: HTMLElement; needle: HTMLElement; track: HTMLElement }> {
  const c = document.createElement('div');
  container = c;
  document.body.appendChild(c);
  const ref = createRef<CentsGaugeHandle>();
  await act(() => {
    render(<CentsGauge ref={ref} toleranceCents={25} testId="pitch" {...props} />, c);
  });
  const track = c.querySelector<HTMLElement>('.pl-cents-gauge__track')!;
  const lane = track.querySelector<HTMLElement>('.pl-cents-gauge__lane')!;
  const needle = lane.querySelector<HTMLElement>('.pl-cents-gauge__needle')!;
  return { handle: ref.current!, lane, needle, track };
}

/** Where the needle's centre lands, as a share of the track: the lane spans the track, the needle sits at its centre. */
const landsAt = (transform: string): number => 0.5 + Number(/translateX\((-?[\d.]+)%\)/.exec(transform)![1]) / 100;

const words = (): string => container!.querySelector('[data-testid="pitch"]')?.textContent ?? '';
const readout = (): HTMLElement => container!.querySelector<HTMLElement>('.pl-cents-gauge__readout')!;
/** The glyphs of the readout that are showing (the others are display: none). */
const glyphs = (): string[] =>
  [...readout().querySelectorAll<HTMLElement>('span[aria-hidden="true"]')].filter((s) => s.style.display !== 'none').map((s) => s.querySelector('svg')?.getAttribute('class') ?? '');

describe('CentsGauge: the needle', () => {
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
    handle.update(-11, true);
    expect(landsAt(lane.style.transform)).toBeCloseTo(0.39, 9);
  });

  it('hides the needle when unvoiced, and shows it again with a voice', async () => {
    const { handle, needle } = await mount();
    handle.update(Number.NaN, false);
    expect(needle.style.opacity).toBe('0');
    handle.update(3, true);
    expect(needle.style.opacity).toBe('1');
    handle.update(Number.NaN, false);
    expect(needle.style.opacity).toBe('0');
  });
});

describe('CentsGauge: the words', () => {
  it('says "On it" inside the in-tune zone, "A little high" above it and "A little low" below it, as the zone says', () => {
    expect(pitchWords(3, true)).toEqual({ side: 'on', text: 'On it' });
    expect(pitchWords(-20, true)).toEqual({ side: 'on', text: 'On it' });
    expect(pitchWords(30, false)).toEqual({ side: 'high', text: 'A little high' });
    expect(pitchWords(-30, false)).toEqual({ side: 'low', text: 'A little low' });
    expect(pitchWords(Number.NaN, false)).toEqual({ side: 'none', text: '–' });
  });

  it('says "Too high" or "Too low" from a whole step off (only a reading against the note asked for gets that far)', () => {
    const far = CONFIG.display.farOffCents;
    expect(far).toBe(200);
    expect(pitchWords(far, false)).toEqual({ side: 'too-high', text: 'Too high' });
    expect(pitchWords(-far - 50, false)).toEqual({ side: 'too-low', text: 'Too low' });
    expect(pitchWords(far - 1, false)).toEqual({ side: 'high', text: 'A little high' });
    expect(pitchWords(-(far - 1), false)).toEqual({ side: 'low', text: 'A little low' });
  });

  it('writes them with a glyph each (never colour alone), and a dash with no voice', async () => {
    const { handle } = await mount();
    expect(words()).toBe('–');
    expect(readout().dataset.side).toBe('none');
    handle.update(2, true);
    expect(words()).toBe('On it');
    expect(readout().dataset.side).toBe('on');
    expect(glyphs()).toHaveLength(1);
    expect(glyphs()[0]).toContain('lucide-check');
    handle.update(40, false);
    expect(words()).toBe('A little high');
    expect(glyphs()).toHaveLength(1);
    expect(glyphs()[0]).toContain('lucide-arrow-up');
    handle.update(-40, false);
    expect(words()).toBe('A little low');
    expect(glyphs()).toHaveLength(1);
    expect(glyphs()[0]).toContain('lucide-arrow-down');
    handle.update(Number.NaN, false);
    expect(words()).toBe('–');
    expect(glyphs()).toHaveLength(0);
  });

  it('writes the words in the text-safe hue: on it in the on hue, off the zone in the off hue, no voice quiet', async () => {
    const { handle } = await mount();
    handle.update(30, false);
    expect(readout().style.color).toBe('var(--off-text)');
    handle.update(3, true);
    expect(readout().style.color).toBe('var(--on-text)');
    handle.update(Number.NaN, false);
    expect(readout().style.color).toBe('var(--text-mid)');
  });

  it('keeps the needle’s colour with the words: inside the zone, outside it', async () => {
    const { handle, needle } = await mount();
    handle.update(3, true);
    expect(needle.style.background).toBe('var(--on)');
    handle.update(30, false);
    expect(needle.style.background).toBe('var(--off)');
  });

  it('writes nothing new while the words stay the same, so a steady voice costs no DOM writes', async () => {
    const { handle } = await mount();
    handle.update(2, true);
    const node = container!.querySelector('[data-testid="pitch"]')!.firstChild;
    handle.update(4, true);
    handle.update(-6, true);
    expect(container!.querySelector('[data-testid="pitch"]')!.firstChild).toBe(node);
    expect(words()).toBe('On it');
  });
});

describe('CentsGauge: the words hold a moment (given the frame’s time)', () => {
  it('reads at once without a clock, and at once for the first reading and for a voice after silence', async () => {
    const { handle } = await mount();
    handle.update(30, false, 10);
    expect(words()).toBe('A little high');
    handle.update(Number.NaN, false, 10.02);
    handle.update(Number.NaN, false, 10.4);
    expect(words()).toBe('–');
    handle.update(-30, false, 10.41);
    expect(words()).toBe('A little low');
    handle.update(2, true); // no clock: no wait
    expect(words()).toBe('On it');
  });

  it('changes the words only when the new reading has lasted HOLD_SEC, and restarts the wait when it flips back', async () => {
    const { handle } = await mount();
    handle.update(2, true, 1);
    expect(words()).toBe('On it');
    handle.update(30, false, 1.05);
    handle.update(30, false, 1.05 + HOLD_SEC - 0.01);
    expect(words()).toBe('On it');
    handle.update(2, true, 1.15); // back: the wait is dropped
    handle.update(30, false, 1.16); // a new wait starts here
    handle.update(30, false, 1.16 + HOLD_SEC - 0.01);
    expect(words()).toBe('On it');
    handle.update(30, false, 1.16 + HOLD_SEC);
    expect(words()).toBe('A little high');
    expect(readout().dataset.side).toBe('high');
    expect(glyphs()).toHaveLength(1);
    expect(glyphs()[0]).toContain('lucide-arrow-up');
  });

  it('goes quiet only after HOLD_QUIET_SEC, a longer wait than a change of words', async () => {
    expect(HOLD_QUIET_SEC).toBeGreaterThan(HOLD_SEC);
    const { handle } = await mount();
    handle.update(2, true, 1);
    handle.update(Number.NaN, false, 1.02);
    handle.update(Number.NaN, false, 1.02 + HOLD_SEC + 0.01);
    expect(words()).toBe('On it');
    handle.update(Number.NaN, false, 1.02 + HOLD_QUIET_SEC);
    expect(words()).toBe('–');
    expect(glyphs()).toHaveLength(0);
  });

  it('moves the needle on every frame, held words or not, and hides it with the voice', async () => {
    const { handle, lane, needle } = await mount();
    handle.update(2, true, 1);
    handle.update(40, false, 1.02);
    expect(words()).toBe('On it');
    expect(landsAt(lane.style.transform)).toBeCloseTo(0.9, 9);
    expect(needle.style.background).toBe('var(--off)');
    handle.update(Number.NaN, false, 1.04);
    expect(needle.style.opacity).toBe('0');
    expect(words()).toBe('On it');
  });

  it('restarts a wait when the clock goes backwards (a new take), instead of stalling', async () => {
    const { handle } = await mount();
    handle.update(2, true, 100);
    handle.update(30, false, 100.02);
    handle.update(30, false, 0.5); // a new clock, long before the wait began
    expect(words()).toBe('On it');
    handle.update(30, false, 0.5 + HOLD_SEC);
    expect(words()).toBe('A little high');
  });
});

describe('CentsGauge: no units in the main view', () => {
  it('shows no number and no unit, and describes itself in plain words', async () => {
    const { handle, track } = await mount();
    handle.update(17, false);
    expect(container!.textContent).not.toMatch(/\d/);
    expect(container!.textContent).not.toContain('¢');
    expect(container!.querySelector('[data-testid="cents"]')).toBeNull();
    const label = track.getAttribute('aria-label')!;
    expect(label).toContain('in-tune zone');
    expect(jargonIn(label)).toEqual([]);
    for (const text of ['On it', 'A little high', 'A little low']) expect(jargonIn(text)).toEqual([]);
  });

  it('shows the distance as a number only when asked (Details), small, at the right end', async () => {
    const { handle } = await mount({ numbers: true, numbersTestId: 'cents' });
    const number = (): string => container!.querySelector('[data-testid="cents"]')?.textContent ?? '';
    expect(number()).toBe('––');
    handle.update(44, false);
    expect(number()).toBe('+44¢');
    expect(words()).toBe('A little high');
    handle.update(-11, true);
    expect(number()).toBe('-11¢');
    handle.update(0.3, true);
    expect(number()).toBe('0¢');
    handle.update(-0.3, true);
    expect(number()).toBe('0¢');
    handle.update(Number.NaN, false);
    expect(number()).toBe('––');
  });

  it('shows no needle until there is a voice to show, from the very first paint', async () => {
    const { needle } = await mount();
    expect(needle.style.opacity).toBe('0');
  });

  it('shades the zone as wide as the level’s tolerance, of the whole strip', async () => {
    await mount({ toleranceCents: 10 });
    const band = container!.querySelector<HTMLElement>('.pl-cents-gauge__band')!;
    expect(band.style.width).toBe('20%');
    expect(band.style.left).toBe('40%');
  });
});
