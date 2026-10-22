/**
 * docs/DESIGN.md section 12 on the production build, for every screen a singer can reach: the page never scrolls sideways
 * (the phrase scrubber scrolls inside its own row, the page does not), every control is at least 48 px square, and nothing
 * throws. Run as a singer who has passed Foundations (a hand-built backup), so the later screens are open: the map and its
 * levels and Boss Recital, an audition, the workout, Song Stage with its player and import, the Vibrato meter, the dashboard,
 * Live, all five Setup steps, Settings, Profiles, Data, Diagnostics and About, plus the sheets that open over them. At a
 * phone's smallest supported width (375 px, DESIGN.md section 7) and on a wide desktop window.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Browser, Page } from 'playwright-core';
import { PREVIEW_URL, TONE_WAV_PATH } from './config';
import { launchWithFakeMic } from './chrome';
import { FOUNDATIONS_RUN, craftBackup } from './backup-fixture';
import { goHome, openDeepLink, openFromHome } from './ui';

/** DESIGN.md sections 6 and 12: touch targets are at least 48 x 48 px. Half a pixel of rounding is forgiven. */
const MIN_TARGET_PX = 48;

interface Audit {
  overflow: number;
  small: string[];
}

/** The page's sideways overflow, and the visible controls smaller than the minimum target. */
async function audit(page: Page, label: string, problems: string[]): Promise<void> {
  await page.waitForTimeout(200); // the screen's 200 ms fade-rise and any late font have settled
  const r: Audit = await page.evaluate((min) => {
    const doc = document.documentElement;
    const overflow = Math.max(doc.scrollWidth, document.body.scrollWidth) - window.innerWidth;
    const small: string[] = [];
    const controls = 'button, a[href], [role="button"], [role="radio"], [role="switch"], [role="checkbox"], input:not([type="hidden"]), select, textarea';
    for (const el of document.querySelectorAll(controls)) {
      const style = getComputedStyle(el);
      if (style.visibility === 'hidden' || style.display === 'none') continue;
      if (el.closest('.pl-visually-hidden')) continue; // the file pickers behind their buttons
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      if (rect.width < min - 0.5 || rect.height < min - 0.5) {
        const name = (el.getAttribute('aria-label') ?? el.textContent ?? el.tagName).trim().replace(/\s+/g, ' ').slice(0, 40);
        small.push(`${el.tagName.toLowerCase()} "${name}" is ${Math.round(rect.width)} x ${Math.round(rect.height)}`);
      }
    }
    return { overflow, small };
  }, MIN_TARGET_PX);
  if (r.overflow > 0) problems.push(`${label}: the page scrolls sideways by ${r.overflow} px`);
  for (const s of r.small) problems.push(`${label}: ${s}`);
}

describe('Wave 2 - every screen keeps to the layout rules in DESIGN.md', () => {
  let browser: Browser;

  beforeAll(async () => {
    const launched = await launchWithFakeMic(TONE_WAV_PATH);
    browser = launched.browser;
    if (launched.note) console.warn(`[e2e] ${launched.note}`);
  }, 120_000);

  afterAll(async () => {
    await browser?.close();
  });

  it.each([
    { name: 'a 375 px phone', width: 375, height: 667 },
    { name: 'a 1280 px desktop window', width: 1280, height: 800 },
  ])('on $name: no sideways scroll, no control under 48 px, no errors', async ({ width, height }) => {
    const context = await browser.newContext({ viewport: { width, height } });
    try {
      const page = await context.newPage();
      const faults: string[] = [];
      page.on('pageerror', (e) => faults.push(`page error: ${e.message}`));
      page.on('console', (m) => {
        if (m.type() === 'error') faults.push(`console error: ${m.text()}`);
      });
      const problems: string[] = [];

      // First run: the two sheets, as a new singer meets them.
      await page.goto(PREVIEW_URL, { waitUntil: 'load' });
      await page.getByTestId('voice-care-done').waitFor({ timeout: 15_000 });
      await audit(page, 'voice-care sheet', problems);
      await page.getByTestId('voice-care-done').click();
      await page.getByRole('button', { name: 'Later' }).waitFor({ timeout: 10_000 });
      await audit(page, 'headphone sheet', problems);
      await page.getByRole('button', { name: 'Later' }).click();
      await page.waitForTimeout(600); // the seen flags are saved after 400 ms; an import inside that window would drop them

      // A singer who has passed Foundations, restored from a backup, so the later screens are open.
      await openFromHome(page, 'util-data');
      const crafted = craftBackup({ profileId: 'e2e-layout-singer', name: 'Layout Singer', voiceType: 'tenor', passed: FOUNDATIONS_RUN });
      await page.getByTestId('import-file').setInputFiles({ name: 'foundations.json', mimeType: 'application/json', buffer: Buffer.from(crafted.json, 'utf8') });
      await page.getByTestId('import-report').waitFor({ timeout: 15_000 });
      await audit(page, 'data, after an import', problems);
      await goHome(page);
      await audit(page, 'home', problems);

      /** From Home, open a row, wait for its screen, audit it, and come back. */
      async function visit(row: string, screen: string, label: string, extra?: () => Promise<void>): Promise<void> {
        await openFromHome(page, row);
        await page.getByTestId(screen).waitFor({ state: 'visible', timeout: 15_000 });
        await audit(page, label, problems);
        if (extra) await extra();
        await goHome(page);
      }

      await visit('dest-map', 'map-screen', 'map', async () => {
        await page.getByTestId('node-vibrato.01').locator('button').click();
        await page.getByTestId('level-screen').waitFor();
        await audit(page, 'level', problems);
        await page.getByTestId('sing-button').click();
        await page.getByTestId('sing-screen').waitFor();
        await audit(page, 'sing, ready', problems);
        await page.getByRole('button', { name: 'Back' }).first().click();
        await page.getByRole('button', { name: 'Back' }).first().click();
        await page.getByTestId('node-foundations.boss').locator('button').click();
        await page.getByTestId('level-screen').waitFor();
        await audit(page, 'boss recital level', problems);
        await page.getByRole('button', { name: 'Back' }).first().click();
        await page.getByTestId('audition-row-vibrato').click();
        await page.getByTestId('audition-screen').waitFor();
        await audit(page, 'audition intro', problems);
      });
      await visit('dest-workout', 'workout-screen', 'workout');
      await visit('dest-songs', 'songs-screen', 'songs', async () => {
        await page.getByTestId('song-row').first().waitFor({ timeout: 15_000 });
        await audit(page, 'songs, loaded', problems);
        await page.getByTestId('song-row').first().click();
        await page.getByTestId('song-player').waitFor({ state: 'visible', timeout: 15_000 });
        await audit(page, 'song player', problems);
        await page.getByRole('button', { name: 'More options' }).click();
        await audit(page, 'song player, More', problems);
        await page.keyboard.press('Escape');
        await page.getByRole('button', { name: 'Back' }).first().click();
        await page.getByTestId('song-import-button').click();
        await page.getByTestId('song-import-screen').waitFor();
        await audit(page, 'song import', problems);
      });
      await visit('dest-vibrato-meter', 'vibrato-meter-screen', 'vibrato meter');
      await visit('dest-live', 'live-screen', 'live');
      await visit('dest-dashboard', 'dashboard-screen', 'dashboard');
      await visit('util-setup', 'setup-screen', 'setup, step 1', async () => {
        for (let step = 2; step <= 5; step++) {
          await page.getByRole('button', { name: 'Next' }).click();
          await audit(page, `setup, step ${step}`, problems);
        }
      });
      await visit('util-settings', 'settings-screen', 'settings');
      await visit('util-profiles', 'profiles-screen', 'profiles', async () => {
        await page.getByRole('button', { name: 'New profile' }).click();
        await audit(page, 'profiles, new profile sheet', problems);
        await page.keyboard.press('Escape');
      });
      await visit('util-data', 'data-screen', 'data');
      await visit('util-diagnostics', 'diagnostics-screen', 'diagnostics');
      await visit('util-about', 'about-screen', 'about');

      expect(problems).toEqual([]);
      expect(faults).toEqual([]);
    } finally {
      await context.close();
    }
  }, 180_000);

  it('Live and the Sing screen fit a 320 px phone (an iPhone SE): the readouts wrap, the page never scrolls sideways', async () => {
    const context = await browser.newContext({ viewport: { width: 320, height: 568 } });
    try {
      const page = await context.newPage();
      const overflow = (): Promise<number> =>
        page.evaluate(() => Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - window.innerWidth);
      await openDeepLink(page, '#/live');
      await page.getByTestId('live-screen').waitFor({ timeout: 15_000 });
      await page.waitForTimeout(300);
      expect(await overflow(), 'Live scrolls sideways').toBe(0);
      await openDeepLink(page, '#/level/foundations.01');
      await page.getByTestId('level-screen').waitFor({ timeout: 15_000 });
      await page.getByTestId('sing-button').click();
      await page.getByTestId('sing-screen').waitFor({ timeout: 15_000 });
      await page.waitForTimeout(300);
      expect(await overflow(), 'the Sing screen scrolls sideways').toBe(0);
    } finally {
      await context.close();
    }
  }, 60_000);
});
