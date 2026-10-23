/**
 * Everything is earned (SPEC 11.1), checked at the front door of the production build. A brand-new profile has passed
 * nothing, so every locked item must refuse a deep link, say what opens it, and never render its screen, not even for a
 * frame: a MutationObserver installed before the app boots records every screen that ever enters the DOM. Locked items
 * stay visible as static lines (never controls), and the sing and report routes cannot be deep-linked at all.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Browser, BrowserContext, Page } from 'playwright-core';
import { PREVIEW_URL, TONE_WAV_PATH } from './config';
import { launchWithFakeMic } from './chrome';
import { dismissFirstRun, openDeepLink, recordScreens, screensSeen, toastMessages, waitForToast } from './ui';

interface Refusal {
  hash: string;
  /** The requirement line the refusal says (docs/SPEC.md 11.2), exactly as a singer reads it. */
  toast: string;
  /** The screen the refusal lands on. */
  lands: string;
  /** Screens that must never have rendered. */
  never: string[];
}

const BOSS = 'Pass the Foundations Boss Recital to';
const REFUSED: readonly Refusal[] = [
  { hash: '#/level/foundations.02', toast: 'Pass Range finder to unlock.', lands: 'map-screen', never: ['level-screen'] },
  { hash: '#/level/foundations.03', toast: 'Pass Pitch match to unlock.', lands: 'map-screen', never: ['level-screen'] },
  { hash: '#/level/foundations.boss', toast: 'Pass Legato lines to unlock.', lands: 'map-screen', never: ['level-screen'] },
  { hash: '#/level/vibrato.01', toast: `${BOSS} unlock Vibrato.`, lands: 'map-screen', never: ['level-screen'] },
  { hash: '#/level/inflections.01', toast: 'Pass the Vibrato Boss Recital to unlock Inflections.', lands: 'map-screen', never: ['level-screen'] },
  { hash: '#/level/dynamics.boss', toast: 'Pass the Runs & Riffs Boss Recital to unlock Dynamics.', lands: 'map-screen', never: ['level-screen'] },
  { hash: '#/audition/vibrato', toast: `${BOSS} unlock Vibrato.`, lands: 'map-screen', never: ['audition-screen'] },
  { hash: '#/songs', toast: `${BOSS} open Song Stage.`, lands: 'home-screen', never: ['songs-screen'] },
  { hash: '#/song/amazing-grace', toast: `${BOSS} open Song Stage.`, lands: 'home-screen', never: ['song-player', 'songs-screen'] },
  { hash: '#/song-progress/amazing-grace', toast: `${BOSS} open Song Stage.`, lands: 'home-screen', never: ['song-progress', 'songs-screen'] },
  { hash: '#/checkup-results/not-on-this-device', toast: 'That check-up is not on this device.', lands: 'checkup-screen', never: ['checkup-results-screen'] },
  { hash: '#/song-import', toast: `${BOSS} import your own songs.`, lands: 'home-screen', never: ['song-import-screen'] },
  { hash: '#/dashboard', toast: 'Pass your first level to see the progress dashboard.', lands: 'home-screen', never: ['dashboard-screen'] },
  { hash: '#/workout', toast: 'Pass your first level to unlock the daily workout.', lands: 'home-screen', never: ['workout-screen'] },
  { hash: '#/vibrato-meter', toast: `${BOSS} use the vibrato meter.`, lands: 'home-screen', never: ['vibrato-meter-screen'] },
];

describe('Wave 2 - everything is earned, at the front door', () => {
  let browser: Browser;
  let context: BrowserContext;
  let page: Page;

  beforeAll(async () => {
    const launched = await launchWithFakeMic(TONE_WAV_PATH);
    browser = launched.browser;
    if (launched.note) console.warn(`[e2e] ${launched.note}`);
  }, 120_000);

  afterAll(async () => {
    await browser?.close();
  });

  // A fresh profile for each test: nothing sung, nothing passed. (The deep links in one test only read.)
  async function freshProfile(): Promise<void> {
    context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    page = await context.newPage();
    await recordScreens(page);
  }

  it.each(REFUSED)('refuses $hash with its requirement and never renders the locked screen', async ({ hash, toast, lands, never }) => {
    await freshProfile();
    try {
      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(e.message));
      await openDeepLink(page, hash);
      await page.getByTestId(lands).waitFor({ state: 'visible', timeout: 15_000 });
      await waitForToast(page, toast);
      const seen = await screensSeen(page);
      expect(seen, 'the recorder sees what renders').toContain(lands);
      for (const screen of never) expect(seen, `${screen} rendered for ${hash}`).not.toContain(screen);
      expect(seen).not.toContain('sing-screen');
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  }, 40_000);

  it('opens the level a fresh profile is on, with no refusal (the positive control)', async () => {
    await freshProfile();
    try {
      await openDeepLink(page, '#/level/foundations.01');
      await page.getByTestId('level-screen').waitFor({ state: 'visible', timeout: 15_000 });
      expect(await page.getByTestId('level-label').textContent()).toContain('01');
      expect(await toastMessages(page)).toEqual([]);
    } finally {
      await context.close();
    }
  }, 40_000);

  it('cannot deep-link a take or its report: they open Home, and nothing renders', async () => {
    await freshProfile();
    try {
      for (const hash of ['#/sing', '#/sing/level', '#/report', '#/sing/level/foundations.01']) {
        await openDeepLink(page, hash);
        await page.getByTestId('home-screen').waitFor({ state: 'visible', timeout: 15_000 });
        await page.getByTestId('continue-card').waitFor({ state: 'visible', timeout: 15_000 });
        const seen = await screensSeen(page);
        expect(seen, `${hash}: the recorder sees what renders`).toContain('home-screen');
        expect(seen, hash).not.toContain('sing-screen');
        expect(seen, hash).not.toContain('report-screen');
      }
    } finally {
      await context.close();
    }
  }, 60_000);

  it('shows the placement audition locked, with its requirement and no way to start it', async () => {
    await freshProfile();
    try {
      await openDeepLink(page, '#/audition/foundations');
      await page.getByTestId('audition-screen').waitFor({ state: 'visible', timeout: 15_000 });
      await page.getByTestId('audition-locked').waitFor({ state: 'visible' });
      expect(await page.getByTestId('audition-locked').textContent()).toContain('Pass Range finder to unlock the audition.');
      expect(await page.getByTestId('audition-start').count()).toBe(0);
      expect(await toastMessages(page)).toEqual([]); // the world is open, so this is not a refusal: the screen itself shows what is missing
    } finally {
      await context.close();
    }
  }, 40_000);

  it('shows every locked item as a static line with its requirement, never as a control', async () => {
    await freshProfile();
    try {
      await page.goto(PREVIEW_URL, { waitUntil: 'load' });
      await page.getByTestId('home-screen').waitFor({ state: 'visible', timeout: 15_000 });
      await dismissFirstRun(page);

      // Home: the four locked destinations keep their place, dimmed, with their requirement and no button.
      const locked: ReadonlyArray<readonly [string, string]> = [
        ['dest-workout', 'Pass your first level to unlock the daily workout.'],
        ['dest-songs', `${BOSS} open Song Stage.`],
        ['dest-vibrato-meter', `${BOSS} use the vibrato meter.`],
        ['dest-dashboard', 'Pass your first level to see the progress dashboard.'],
      ];
      for (const [row, line] of locked) {
        const el = page.getByTestId(row);
        expect(await el.getAttribute('data-locked'), row).toBe('true');
        expect(await el.textContent(), row).toContain(line);
        expect(await el.locator('button, a[href]').count(), `${row} must not hold a control`).toBe(0);
        expect(await el.evaluate((node) => node.tagName), row).not.toBe('BUTTON');
      }
      // The open ones are controls.
      for (const row of ['dest-map', 'dest-live']) expect(await page.getByTestId(row).evaluate((node) => node.tagName), row).toBe('BUTTON');

      // A tap on a locked row goes nowhere.
      await page.getByTestId('dest-songs').click({ force: true });
      await page.getByTestId('dest-dashboard').click({ force: true });
      expect(await page.getByTestId('home-screen').isVisible()).toBe(true);

      // The map: only the level the singer is on is a control; the rest say what opens them.
      await page.getByTestId('dest-map').click();
      await page.getByTestId('map-screen').waitFor({ state: 'visible' });
      expect(await page.getByTestId('node-foundations.01').getAttribute('data-state')).toBe('current');
      expect(await page.getByTestId('node-foundations.01').locator('button').count()).toBe(1);
      const nodes = page.locator('[data-testid^="node-foundations."]');
      expect(await nodes.count()).toBe(10);
      for (let i = 2; i <= 10; i++) {
        const id = i === 10 ? 'foundations.boss' : `foundations.${String(i).padStart(2, '0')}`;
        const node = page.getByTestId(`node-${id}`);
        expect(await node.getAttribute('data-state'), id).toBe('locked');
        expect(await node.locator('button').count(), `${id} must not be a control`).toBe(0);
        expect(await node.textContent(), id).toContain('to unlock.');
      }
      await page.getByTestId('node-foundations.03').click({ force: true });
      expect(await page.getByTestId('map-screen').isVisible()).toBe(true);
      expect(await page.getByTestId('level-screen').count()).toBe(0);

      // Worlds past Foundations are dimmed lists with one requirement line; Song Stage is a locked row.
      expect(await page.getByTestId('world-vibrato').getAttribute('data-open')).toBe('false');
      expect(await page.getByTestId('world-vibrato').textContent()).toContain(`${BOSS} unlock Vibrato.`);
      expect(await page.getByTestId('world-vibrato').locator('button').count()).toBe(0);
      expect(await page.getByTestId('song-stage-row').getAttribute('data-locked')).toBe('true');
      expect(await page.getByTestId('song-stage-row').locator('button').count()).toBe(0);
    } finally {
      await context.close();
    }
  }, 60_000);
});
