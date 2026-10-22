// @vitest-environment happy-dom
/**
 * Home, the hub (docs/DESIGN.md 13.1): the Continue card, the Momentum chip, training destinations that stay as static
 * Locked lines until earned, the utilities, the boot states and the first-run sheets. The session and settings modules
 * are replaced by signal doubles over the real unlock registry, and the real router and route guard are used.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../state/session', async () => (await import('../worlds/test-support')).sessionDouble());
vi.mock('../../state/settings', async () => (await import('../worlds/test-support')).settingsDouble());
vi.mock('../../audio/platform', () => ({
  isIOS: () => false,
  isStandalone: () => false,
  isWindows: () => false,
  isLikelyBluetoothLabel: () => false,
}));

import { computeMomentum, requirementHint } from '../../progress';
import { resetRouterForTests, route, routeOf } from '../../router';
import type { AttemptRecord } from '../../storage/schema';
import { localUtcOffsetMinutes } from '../worlds/momentum-bars';
import { activeProfile, attemptLog, bootError, bootPhase, snapshot } from '../../state/session';
import { deviceSettings, settings } from '../../state/settings';
import { DEFAULT_DEVICE_SETTINGS, DEFAULT_SETTINGS } from '../../state/settings-types';
import {
  attempt,
  attemptsThrough,
  byTestId,
  flush,
  installGuardOver,
  mount,
  profileRecord,
  snapshotOf,
  textOf,
  waitUntil,
  type Mounted,
} from '../worlds/test-support';
import { Home } from './Home';

const DOT = '·';
let view: Mounted | null = null;

async function showHome(): Promise<HTMLElement> {
  view = mount(<Home />);
  await flush();
  return view.container;
}

function dialogLabel(c: HTMLElement): string | null {
  return c.querySelector('[role="dialog"]')?.getAttribute('aria-label') ?? null;
}

beforeEach(() => {
  resetRouterForTests();
  bootPhase.value = 'ready';
  bootError.value = null;
  activeProfile.value = profileRecord('Daniel');
  snapshot.value = snapshotOf(null);
  attemptLog.value = [];
  // A returning singer on a set-up device: no first-run sheets unless a test asks for them.
  settings.value = { ...DEFAULT_SETTINGS, voiceCareSeen: true };
  deviceSettings.value = { ...DEFAULT_DEVICE_SETTINGS, headphoneGuideSeen: true };
  installGuardOver(() => snapshot.peek());
});

afterEach(() => {
  view?.unmount();
  view = null;
});

describe('Home: the hub', () => {
  it('renders the root, the title and the profile chip in the app bar', async () => {
    const c = await showHome();
    expect(byTestId(c, 'home-screen')).not.toBeNull();
    expect(textOf(c.querySelector('.pl-appbar__title'))).toBe('Pitch Lab');
    const chip = byTestId(c, 'profile-chip')!;
    expect(textOf(chip)).toBe('D');
    expect(chip.getAttribute('aria-label')).toContain('Daniel');
    expect(c.querySelector('.pl-appbar__back')).toBeNull();
  });

  it('opens Profiles from the profile chip', async () => {
    const c = await showHome();
    byTestId<HTMLButtonElement>(c, 'profile-chip')!.click();
    expect(route.value).toEqual(routeOf('profiles'));
  });

  it('lists the six training destinations and the six utilities', async () => {
    const c = await showHome();
    const training = byTestId(c, 'training-list')!;
    expect(
      [...training.querySelectorAll('.pl-row__title')].map((el) => textOf(el)),
    ).toEqual(['World map', 'Daily workout', 'Song Stage', 'Vibrato meter', 'Live pitch', 'Progress dashboard']);
    const utilities = byTestId(c, 'utility-list')!;
    expect(
      [...utilities.querySelectorAll('.pl-row__title')].map((el) => textOf(el)),
    ).toEqual(['Setup & calibration', 'Settings', 'Profiles', 'Data & backup', 'Diagnostics', 'About & voice care']);
  });

  it('opens a utility and an open training destination', async () => {
    const c = await showHome();
    byTestId<HTMLButtonElement>(c, 'dest-map')!.click();
    expect(route.value).toEqual(routeOf('map'));
    resetRouterForTests();
    byTestId<HTMLButtonElement>(c, 'util-data')!.click();
    expect(route.value).toEqual(routeOf('data'));
  });
});

describe('Home: everything is earned', () => {
  it('shows every locked destination as a static Locked line with its requirement, never a control', async () => {
    const c = await showHome();
    const expected: Record<string, Parameters<typeof requirementHint>[0]> = {
      workout: 'daily-workout',
      songs: 'song-stage',
      'vibrato-meter': 'tool.vibrato-meter',
      dashboard: 'dashboard',
    };
    for (const [key, feature] of Object.entries(expected)) {
      const row = byTestId(c, `dest-${key}`)!;
      expect(row.tagName, key).toBe('DIV');
      expect(row.getAttribute('data-locked'), key).toBe('true');
      expect(row.querySelector('button'), key).toBeNull();
      const locked = row.querySelector('.pl-locked.pl-locked--compact');
      expect(locked, key).not.toBeNull();
      expect(textOf(locked)).toContain(requirementHint(feature));
      expect(textOf(locked)).toContain('Locked.');
    }
  });

  it('keeps the destinations that are open from the start as buttons', async () => {
    const c = await showHome();
    for (const key of ['map', 'live']) {
      const row = byTestId(c, `dest-${key}`)!;
      expect(row.tagName, key).toBe('BUTTON');
      expect(row.querySelector('.pl-locked'), key).toBeNull();
    }
  });

  it('clicking a locked row does nothing', async () => {
    const c = await showHome();
    byTestId(c, 'dest-songs')!.click();
    expect(route.value).toEqual(routeOf('home'));
  });

  it('opens the daily workout and the dashboard after the first level, and shows the Momentum chip', async () => {
    const c = await showHome();
    expect(byTestId(c, 'momentum-chip')).toBeNull();

    snapshot.value = snapshotOf('foundations.01');
    await flush();
    expect(byTestId(c, 'dest-workout')!.tagName).toBe('BUTTON');
    expect(byTestId(c, 'dest-dashboard')!.tagName).toBe('BUTTON');
    expect(byTestId(c, 'dest-songs')!.getAttribute('data-locked')).toBe('true');
    expect(byTestId(c, 'dest-vibrato-meter')!.getAttribute('data-locked')).toBe('true');
    expect(byTestId(c, 'momentum-chip')).not.toBeNull();
  });

  it('opens Song Stage and the Vibrato meter with the Foundations Boss Recital', async () => {
    snapshot.value = snapshotOf('foundations.boss');
    const c = await showHome();
    expect(byTestId(c, 'dest-songs')!.tagName).toBe('BUTTON');
    expect(byTestId(c, 'dest-vibrato-meter')!.tagName).toBe('BUTTON');
    expect(c.querySelector('.pl-locked')).toBeNull();
  });
});

describe('Home: the Continue card', () => {
  it('names the first level on a fresh profile and opens it', async () => {
    const c = await showHome();
    const card = byTestId(c, 'continue-card')!;
    expect(textOf(card.querySelector('.pl-label'))).toBe(`Next up ${DOT} 01`);
    expect(textOf(card.querySelector('.wl-continue__title'))).toBe('Range finder');
    expect(textOf(card.querySelector('.wl-continue__world'))).toBe('Foundations');
    expect(textOf(card)).toContain('Continue');

    byTestId<HTMLButtonElement>(c, 'continue-button')!.click();
    expect(route.value).toEqual(routeOf('level', { levelId: 'foundations.01' }));
  });

  it('follows the singer to the current level, with its number, goal and tally lights', async () => {
    snapshot.value = snapshotOf('foundations.03');
    const c = await showHome();
    const card = byTestId(c, 'continue-card')!;
    expect(textOf(card.querySelector('.pl-label'))).toBe(`Next up ${DOT} 04`);
    expect(textOf(card.querySelector('.wl-continue__title'))).toBe('Sustain II');
    expect(card.querySelector('.pl-prose')?.textContent?.length).toBeGreaterThan(10);
    expect(card.querySelector('.pl-tally-lights')).not.toBeNull();

    byTestId<HTMLButtonElement>(c, 'continue-button')!.click();
    expect(route.value).toEqual(routeOf('level', { levelId: 'foundations.04' }));
  });

  it('wears the hue of the current world', async () => {
    snapshot.value = snapshotOf('foundations.boss');
    const c = await showHome();
    const card = byTestId(c, 'continue-card')!;
    expect(card.getAttribute('data-world')).toBe('vibrato');
    expect(card.getAttribute('style')).toContain('--world-vibrato');
    expect(textOf(card.querySelector('.wl-continue__title'))).toBe('Oscillation I');
  });

  it('titles a Boss Recital by its exercise and numbers it as the last entry', async () => {
    snapshot.value = snapshotOf('foundations.09');
    const c = await showHome();
    const card = byTestId(c, 'continue-card')!;
    expect(textOf(card.querySelector('.pl-label'))).toBe(`Next up ${DOT} 10`);
    expect(textOf(card.querySelector('.wl-continue__title'))).toBe('Foundations Boss Recital');
  });

  it('shows the best score of a level that was sung but not passed yet', async () => {
    snapshot.value = snapshotOf('foundations.03', [attempt({ levelId: 'foundations.04', passed: false, score: 0.57 })]);
    const c = await showHome();
    expect(textOf(byTestId(c, 'continue-card'))).toContain('Best so far 57%');
  });

  it('says every level is passed, and links to the dashboard', async () => {
    snapshot.value = snapshotOf('dynamics.boss');
    const c = await showHome();
    const card = byTestId(c, 'continue-card')!;
    expect(textOf(card)).toContain('Every level passed');
    expect(byTestId(c, 'continue-button')).toBeNull();

    byTestId<HTMLButtonElement>(c, 'continue-dashboard')!.click();
    expect(route.value).toEqual(routeOf('dashboard'));
  });
});

describe('Home: the Momentum chip', () => {
  /** Local noon, `days` calendar days ago (a DST change cannot move it to another day). */
  const noonDaysAgo = (days: number, from = new Date()): string => {
    const d = new Date(from);
    d.setHours(12, 0, 0, 0);
    d.setDate(d.getDate() - days);
    return d.toISOString();
  };
  /** What the dashboard shows for this log right now (dashboard-model momentumView). */
  const dashboardMomentum = (log: readonly AttemptRecord[]): number =>
    Math.round(computeMomentum(log, Date.now(), { utcOffsetMinutes: localUtcOffsetMinutes() }));

  it('shows the number and seven bars, and opens the dashboard', async () => {
    const log = attemptsThrough('foundations.02').map((a, i) => ({ ...a, createdAt: noonDaysAgo(2 - i), durationSec: 900 }));
    attemptLog.value = log;
    snapshot.value = snapshotOf('foundations.02');
    const c = await showHome();
    const chip = byTestId<HTMLButtonElement>(c, 'momentum-chip')!;
    const expected = dashboardMomentum(log);
    expect(expected).toBeGreaterThan(0);
    expect(textOf(chip.querySelector('.wl-momentum__value'))).toBe(String(expected));
    expect(chip.querySelectorAll('.wl-momentum__bar')).toHaveLength(7);
    expect(chip.querySelectorAll('.wl-momentum__bar--today')).toHaveLength(1);
    expect(chip.getAttribute('aria-label')).toContain(`Momentum ${expected} of 100`);

    chip.click();
    expect(route.value).toEqual(routeOf('dashboard'));
  });

  it('agrees with the dashboard, not with a session snapshot computed days ago', async () => {
    // The snapshot is recomputed only at boot and after a take: here it still holds the Momentum of the last session.
    const log = attemptsThrough('foundations.02').map((a) => ({ ...a, createdAt: noonDaysAgo(14), durationSec: 1200 }));
    attemptLog.value = log;
    snapshot.value = { ...snapshotOf('foundations.02'), momentum: 63.2 };
    const c = await showHome();
    const value = textOf(byTestId(c, 'momentum-chip')!.querySelector('.wl-momentum__value'));
    expect(value).toBe(String(dashboardMomentum(log)));
    expect(value).not.toBe('63');
  });

  it('re-reads the clock when the app comes back into view after days away', async () => {
    const start = new Date();
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(start);
      const log = attemptsThrough('foundations.02').map((a) => ({ ...a, createdAt: noonDaysAgo(0, start), durationSec: 1200 }));
      attemptLog.value = log;
      snapshot.value = snapshotOf('foundations.02');
      const c = await showHome();
      const valueNode = () => textOf(byTestId(c, 'momentum-chip')!.querySelector('.wl-momentum__value'));
      const before = dashboardMomentum(log);
      expect(valueNode()).toBe(String(before));

      // Two weeks later the singer switches back to the app, which stayed open (no relaunch, no take).
      vi.setSystemTime(new Date(start.getTime() + 14 * 86_400_000));
      const after = dashboardMomentum(log);
      expect(after).not.toBe(before); // the test means something: two weeks of rest moved Momentum
      document.dispatchEvent(new Event('visibilitychange'));
      await flush();
      expect(valueNode()).toBe(String(after));
      // The bars moved on too: today is a rest day now.
      const bars = [...byTestId(c, 'momentum-chip')!.querySelectorAll('.wl-momentum__bar')];
      expect(bars[6].classList.contains('wl-momentum__bar--rest')).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('fills the bars from the attempt log, today last', async () => {
    const log = attemptsThrough('foundations.02').map((a) => ({ ...a, createdAt: new Date().toISOString(), durationSec: 600 }));
    attemptLog.value = log;
    snapshot.value = snapshotOf('foundations.02');
    const c = await showHome();
    const bars = [...byTestId(c, 'momentum-chip')!.querySelectorAll('.wl-momentum__bar')];
    expect(bars[6].classList.contains('wl-momentum__bar--none')).toBe(false);
    expect(bars[0].classList.contains('wl-momentum__bar--none')).toBe(true);
  });

  it('dims the rest days between practice days, and says how many days were practiced', async () => {
    // Local noon, counted in calendar days (a DST change cannot move it to another day).
    const noonDaysAgo = (days: number): string => {
      const d = new Date();
      d.setHours(12, 0, 0, 0);
      d.setDate(d.getDate() - days);
      return d.toISOString();
    };
    const [first, second] = attemptsThrough('foundations.02');
    attemptLog.value = [
      { ...first, createdAt: noonDaysAgo(3), durationSec: 600 },
      { ...second, createdAt: noonDaysAgo(0), durationSec: 600 },
    ];
    snapshot.value = snapshotOf('foundations.02');
    const c = await showHome();
    const chip = byTestId(c, 'momentum-chip')!;
    const bars = [...chip.querySelectorAll('.wl-momentum__bar')];
    expect(bars.map((b) => [b.classList.contains('wl-momentum__bar--none'), b.classList.contains('wl-momentum__bar--rest')])).toEqual([
      [true, false],
      [true, false],
      [true, false],
      [false, false],
      [false, true],
      [false, true],
      [false, false],
    ]);
    expect(chip.getAttribute('aria-label')).toContain('Practiced 2 of the last 4 days.');
  });
});

describe('Home: boot states', () => {
  it('shows a skeleton, not the cards, while the session boots', async () => {
    bootPhase.value = 'booting';
    activeProfile.value = null;
    const c = await showHome();
    expect(byTestId(c, 'boot-skeleton')).not.toBeNull();
    expect(byTestId(c, 'continue-card')).toBeNull();
    expect(byTestId(c, 'training-list')).toBeNull();
    expect(byTestId(c, 'profile-chip')).toBeNull();
    // The utilities never need progress, so they are there at once.
    expect(byTestId(c, 'utility-list')).not.toBeNull();
    expect(c.querySelector('[aria-busy="true"]')).not.toBeNull();
  });

  it('fills in when the boot finishes', async () => {
    bootPhase.value = 'booting';
    activeProfile.value = null;
    const c = await showHome();
    bootPhase.value = 'ready';
    activeProfile.value = profileRecord('Daniel');
    await flush();
    expect(byTestId(c, 'boot-skeleton')).toBeNull();
    expect(byTestId(c, 'continue-card')).not.toBeNull();
    expect(byTestId(c, 'profile-chip')).not.toBeNull();
  });

  it('shows a plain error and a Reload button when the boot failed, and keeps the utilities', async () => {
    bootPhase.value = 'failed';
    bootError.value = 'Saved data could not be opened in this browser.';
    const c = await showHome();
    const failed = byTestId(c, 'boot-failed')!;
    expect(textOf(failed)).toContain('Saved data could not be opened in this browser.');
    const reload = [...failed.querySelectorAll('button')].find((b) => textOf(b) === 'Reload');
    expect(reload).toBeDefined();
    expect(byTestId(c, 'continue-card')).toBeNull();
    expect(byTestId(c, 'training-list')).toBeNull();
    expect(byTestId(c, 'dest-live')).toBeNull();
    expect(byTestId(c, 'util-diagnostics')).not.toBeNull();
    expect(byTestId(c, 'profile-chip')).toBeNull();
  });

  it('reloads the page from the Reload button', async () => {
    bootPhase.value = 'failed';
    const reload = vi.spyOn(window.location, 'reload').mockImplementation(() => {});
    try {
      const c = await showHome();
      [...c.querySelectorAll('button')].find((b) => textOf(b) === 'Reload')!.click();
      expect(reload).toHaveBeenCalledTimes(1);
    } finally {
      reload.mockRestore();
    }
  });

  it('shows no first-run sheet while booting or after a failed boot', async () => {
    settings.value = { ...DEFAULT_SETTINGS };
    bootPhase.value = 'booting';
    const c = await showHome();
    await flush();
    expect(dialogLabel(c)).toBeNull();
    bootPhase.value = 'failed';
    await flush();
    expect(dialogLabel(c)).toBeNull();
  });
});

describe('Home: first run', () => {
  beforeEach(() => {
    settings.value = { ...DEFAULT_SETTINGS };
    deviceSettings.value = { ...DEFAULT_DEVICE_SETTINGS };
  });

  it('shows the voice-care sheet first, and only that one', async () => {
    const c = await showHome();
    await waitUntil(() => dialogLabel(c) !== null);
    expect(dialogLabel(c)).toBe('Voice care');
    expect(c.querySelectorAll('[role="dialog"]')).toHaveLength(1);
    const sheet = textOf(c.querySelector('[role="dialog"]'));
    expect(sheet).toContain('Never sing through pain or hoarseness');
    expect(sheet).toContain('This is not medical advice.');
    expect(c.querySelectorAll('[data-testid="voice-care-list"] li')).toHaveLength(5);
  });

  it('sets voiceCareSeen on "Got it", then shows the headphone and Setup prompt', async () => {
    const c = await showHome();
    await waitUntil(() => dialogLabel(c) === 'Voice care');
    byTestId<HTMLButtonElement>(c, 'voice-care-done')!.click();
    expect(settings.value.voiceCareSeen).toBe(true);
    await waitUntil(() => dialogLabel(c) === 'Before you start');
    expect(textOf(c.querySelector('[role="dialog"]'))).toContain('Wired headphones are recommended');
  });

  it('dismisses the headphone prompt with Later and never shows either sheet again', async () => {
    const c = await showHome();
    await waitUntil(() => dialogLabel(c) === 'Voice care');
    byTestId<HTMLButtonElement>(c, 'voice-care-done')!.click();
    await waitUntil(() => dialogLabel(c) === 'Before you start');
    [...c.querySelectorAll('button')].find((b) => textOf(b) === 'Later')!.click();
    expect(deviceSettings.value.headphoneGuideSeen).toBe(true);
    await waitUntil(() => dialogLabel(c) === null);
  });

  it('opens Setup from "Set up now"', async () => {
    const c = await showHome();
    await waitUntil(() => dialogLabel(c) === 'Voice care');
    byTestId<HTMLButtonElement>(c, 'voice-care-done')!.click();
    await waitUntil(() => dialogLabel(c) === 'Before you start');
    [...c.querySelectorAll('button')].find((b) => textOf(b) === 'Set up now')!.click();
    expect(deviceSettings.value.headphoneGuideSeen).toBe(true);
    expect(route.value).toEqual(routeOf('setup'));
  });

  it('counts closing the voice-care sheet any other way as having read it', async () => {
    const c = await showHome();
    await waitUntil(() => dialogLabel(c) === 'Voice care');
    c.querySelector<HTMLButtonElement>('[role="dialog"] .pl-sheet__close')!.click();
    expect(settings.value.voiceCareSeen).toBe(true);
  });

  it('asks a second profile on the same device for the voice-care note again, but not for the headphones', async () => {
    deviceSettings.value = { ...DEFAULT_DEVICE_SETTINGS, headphoneGuideSeen: true };
    settings.value = { ...DEFAULT_SETTINGS, voiceCareSeen: false };
    const c = await showHome();
    await waitUntil(() => dialogLabel(c) === 'Voice care');
    byTestId<HTMLButtonElement>(c, 'voice-care-done')!.click();
    await flush();
    await flush();
    expect(dialogLabel(c)).toBeNull();
  });

  it('shows nothing to a returning singer on a set-up device', async () => {
    settings.value = { ...DEFAULT_SETTINGS, voiceCareSeen: true };
    deviceSettings.value = { ...DEFAULT_DEVICE_SETTINGS, headphoneGuideSeen: true };
    const c = await showHome();
    await flush();
    await flush();
    expect(dialogLabel(c)).toBeNull();
  });
});

describe('Home: Setup & calibration', () => {
  it('carries a dot and the reason until latency is calibrated for the current route', async () => {
    const c = await showHome();
    const row = byTestId(c, 'util-setup')!;
    expect(row.querySelector('.pl-dot')).not.toBeNull();
    expect(textOf(row)).toContain('Calibrate latency so your takes line up');
    expect(textOf(row)).toContain('Needs attention');
  });

  it('is quiet once the route is calibrated and the headphone guide has been seen', async () => {
    deviceSettings.value = {
      ...DEFAULT_DEVICE_SETTINGS,
      headphoneGuideSeen: true,
      route: 'wired',
      latency: { wired: { route: 'wired', method: 'tap', roundTripMs: 40, jitterMs: 3, matched: 8, date: '2026-10-22' } },
    };
    const c = await showHome();
    const row = byTestId(c, 'util-setup')!;
    expect(row.querySelector('.pl-dot')).toBeNull();
    expect(textOf(row)).toContain('Headphones, mic, latency');
  });
});
