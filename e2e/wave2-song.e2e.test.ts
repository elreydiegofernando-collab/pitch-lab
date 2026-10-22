/**
 * Song Stage through the real UI of the production build, for a singer who has earned it (a hand-built backup that passes
 * Foundations): the song player asks for a latency calibration before the first take, the calibration is done through
 * Setup (the Tap method, with the taps made on the audio clock so their timing is as steady as a person's best), Listen
 * plays the melody, a phrase is sung into the fake microphone, the take sheet reads the take phrase by phrase, and the
 * attempt and the recording land in Data & backup. Leaving the player turns the mic off.
 *
 * The fake mic holds a steady A3, which is not the melody, so the take is expected to score low ("Not yet"): this proves the
 * pipeline (count-in, recording, scoring, saving), not the singer. Real-voice scoring is the manual checklist's P14.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Browser, BrowserContext, Page } from 'playwright-core';
import { PREVIEW_URL, TONE_WAV_PATH } from './config';
import { launchWithFakeMic } from './chrome';
import { FOUNDATIONS_RUN, craftBackup } from './backup-fixture';
import { dismissFirstRun, goHome, openFromHome } from './ui';
import { CONFIG } from '../src/config';

/** A song take is a few seconds of count-in, a phrase, and its lead-in and tail. */
const TAKE_TIMEOUT_MS = 90_000;
/** How long after each click the Tap calibration is tapped, seconds: well inside the 0-500 ms matching window. */
const TAP_AFTER_CLICK_SEC = 0.12;
/** The first click sounds this long after Run is pressed (src/audio/latency.ts LEAD_SEC); any error only shifts every tap equally. */
const CALIBRATION_LEAD_SEC = 0.6;

/**
 * From now on, pressing "Run" on the Setup screen also taps its pad at fixed offsets after each click of the train, read
 * off the AudioContext clock (`?debug=1` exposes the engine). The app's own Tap method maps each tap's event time onto that
 * same clock, so the offset it measures is TAP_AFTER_CLICK_SEC plus the output's latency and its jitter is the polling's.
 */
async function armTapper(page: Page): Promise<void> {
  await page.evaluate(
    ({ clicks, intervalSec, leadSec, afterSec }) => {
      document.addEventListener(
        'click',
        (e) => {
          const button = (e.target as HTMLElement | null)?.closest('button');
          if (button?.textContent?.trim() !== 'Run') return;
          // The app's own handler creates the AudioContext on this same click; read the clock just after it.
          setTimeout(() => {
            const ctx = (window.__pitchlab?.engine as { context?: AudioContext | null } | undefined)?.context;
            if (!ctx) return;
            const startAt = ctx.currentTime + leadSec;
            let next = 0;
            const timer = setInterval(() => {
              while (next < clicks && ctx.currentTime >= startAt + next * intervalSec + afterSec) {
                document.querySelector('.pl-tap-pad')?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'touch' }));
                next++;
              }
              if (next >= clicks) clearInterval(timer);
            }, 2);
          }, 0);
        },
        true,
      );
    },
    { clicks: CONFIG.latency.tap.clicks, intervalSec: CONFIG.latency.tap.intervalSec, leadSec: CALIBRATION_LEAD_SEC, afterSec: TAP_AFTER_CLICK_SEC },
  );
}

describe('Wave 2 - Song Stage, through the real UI', () => {
  let browser: Browser;
  let context: BrowserContext;
  let page: Page;
  const faults: string[] = [];
  const state = { calibrated: false, songTitle: '' };

  beforeAll(async () => {
    const launched = await launchWithFakeMic(TONE_WAV_PATH);
    browser = launched.browser;
    if (launched.note) console.warn(`[e2e] ${launched.note}`);
    context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    page = await context.newPage();
    page.on('pageerror', (e) => faults.push(`page error: ${e.message}`));
    page.on('console', (m) => {
      if (m.type() === 'error') faults.push(`console error: ${m.text()}`);
    });
    await page.goto(`${PREVIEW_URL}?debug=1`, { waitUntil: 'load' });
    await page.getByTestId('home-screen').waitFor({ state: 'visible', timeout: 15_000 });
    await dismissFirstRun(page);

    // A singer who has passed Foundations, restored from a backup.
    await openFromHome(page, 'util-data');
    const crafted = craftBackup({ profileId: 'e2e-song-singer', name: 'Song Singer', voiceType: 'tenor', passed: FOUNDATIONS_RUN });
    await page.getByTestId('import-file').setInputFiles({ name: 'foundations.json', mimeType: 'application/json', buffer: Buffer.from(crafted.json, 'utf8') });
    await page.getByTestId('import-report').waitFor({ timeout: 15_000 });
    await goHome(page);
  }, 120_000);

  afterAll(async () => {
    await context?.close();
    await browser?.close();
  });

  it('asks for a latency calibration before the first take, and Calibrate leads to Setup', async () => {
    await page.getByTestId('dest-songs').click();
    await page.getByTestId('song-row').first().waitFor({ timeout: 15_000 });
    state.songTitle = (((await page.getByTestId('song-row').first().locator('.pl-song-row__title').textContent()) ?? '').trim());
    await page.getByTestId('song-row').first().click();
    await page.getByTestId('song-player').waitFor({ state: 'visible', timeout: 15_000 });

    expect(await page.getByTestId('song-player').textContent()).toContain('Calibrate latency first so your takes line up.');
    const primary = page.getByTestId('song-primary');
    expect((await primary.textContent())?.trim()).toBe('Calibrate');
    await primary.click();
    await page.getByTestId('setup-screen').waitFor({ state: 'visible' });
  }, 40_000);

  it('Setup calibrates the Tap method, and the player then offers Sing', async () => {
    await armTapper(page);
    // Step 1: say how you listen. Steps 2 and 3 (microphone, audio check) are skipped over.
    await page.getByRole('radio', { name: 'Wired' }).click();
    for (let step = 1; step < 4; step++) await page.getByRole('button', { name: 'Next' }).click();
    expect(await page.getByText('Step 4 of 5: Latency calibration').count()).toBe(1);

    await page.getByRole('radio', { name: 'Tap' }).click();
    await page.getByRole('button', { name: 'Run', exact: true }).click();
    const verdict = page.getByText('Good', { exact: true });
    await verdict.waitFor({ timeout: 30_000 });
    expect(await page.getByText(/\d+ ms/).first().textContent(), 'a plausible round trip').toMatch(/^\s*\d{2,3} ms/);
    await page.getByRole('button', { name: 'Save' }).click();
    state.calibrated = true;

    await page.getByRole('button', { name: 'Back' }).first().click(); // Setup -> the song player
    await page.getByTestId('song-player').waitFor({ state: 'visible' });
    expect(await page.getByTestId('song-player').textContent()).not.toContain('Calibrate latency first');
    expect((await page.getByTestId('song-primary').textContent())?.trim()).toBe('Sing');
  }, 60_000);

  it('Listen plays the melody and Stop ends it, without the microphone', async (t) => {
    if (!state.calibrated) t.skip('needs the calibration');
    const listen = page.getByRole('button', { name: 'Listen to the selection' });
    await listen.click();
    await page.getByRole('button', { name: 'Stop listening' }).waitFor({ timeout: 10_000 });
    expect(await page.evaluate(() => window.__pitchlab?.info().state)).not.toBe('running');
    await page.getByRole('button', { name: 'Stop listening' }).click();
    await page.getByRole('button', { name: 'Listen to the selection' }).waitFor({ timeout: 10_000 });
  }, 40_000);

  it('a sung phrase ends in a take sheet that reads it phrase by phrase, and the attempt and recording are saved', async (t) => {
    if (!state.calibrated) t.skip('needs the calibration');
    await page.getByTestId('song-primary').click();
    await page.getByTestId('song-result').waitFor({ state: 'visible', timeout: TAKE_TIMEOUT_MS });

    const sheet = page.getByRole('dialog', { name: 'Phrase 1' });
    const text = (await sheet.textContent()) ?? '';
    expect(text, 'a verdict in words').toMatch(/Passed|Not yet/);
    expect(text).toMatch(/\d+% of the time in tune/);
    expect(await sheet.locator('.pl-song-breakdown li').count(), 'the phrase-by-phrase breakdown').toBeGreaterThanOrEqual(1);
    await sheet.getByRole('button', { name: 'Play take' }).waitFor(); // the take's audio was captured
    expect(await sheet.getByRole('button', { name: /^(Retry phrase|Sing again)$/ }).count()).toBe(1);
    expect(await sheet.getByRole('button', { name: 'Next phrase' }).count()).toBe(1);
    expect(await sheet.getByRole('alert').count(), 'the take saved without a warning').toBe(0);

    await sheet.getByRole('button', { name: 'Close' }).click();
    await sheet.waitFor({ state: 'hidden' });

    // Leaving the player turns the mic off.
    await page.getByRole('button', { name: 'Back' }).first().click();
    await page.waitForFunction(() => window.__pitchlab?.info().state === 'idle', undefined, { timeout: 10_000 });

    // The attempt (10 passed levels + this take) and the recording, titled by the song.
    await openFromHome(page, 'util-data');
    await page.getByTestId('storage-card').waitFor();
    expect(await page.getByTestId('storage-card').textContent()).toMatch(/Attempts11Recordings1/);
    const row = page.getByTestId('recording-row');
    await row.waitFor();
    expect(await row.textContent()).toContain(state.songTitle);
    expect(faults).toEqual([]);
  }, TAKE_TIMEOUT_MS + 60_000);
});
