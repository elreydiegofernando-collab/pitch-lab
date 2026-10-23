/**
 * One Chrome launch, fed the A3 (220 Hz) voice-like tone fixture, covering
 * every assertion in AGENTS.md's "Test pitch" / "Test render" / "Test no
 * URL writes" / "Test offline" items that fixture can drive.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Browser } from 'playwright-core';
import { PREVIEW_URL, TONE_WAV_PATH } from './config';
import { launchWithFakeMic } from './chrome';
import { bestRenderFps, getEngineInfo, getFrames, waitForFrames } from './debug-hook';
import { centsFromReference, frameRateOverWindow, median, voicedFrames } from './pitch-math';
import { dismissFirstRun, waitForServiceWorkerControl } from './ui';

/** How long after the first 3 s of the engine running the render rate gets to reach its bar (see bestRenderFps in debug-hook.ts). */
const RENDER_RATE_WINDOW_MS = 20_000;

describe('live pitch — A3 220 Hz tone', () => {
  let browser: Browser;
  let headless: boolean;

  beforeAll(async () => {
    const launched = await launchWithFakeMic(TONE_WAV_PATH);
    browser = launched.browser;
    headless = launched.headless;
    if (launched.note) console.warn(`[e2e] ${launched.note}`);
  }, 120_000);

  afterAll(async () => {
    await browser?.close();
  });

  it('locks onto A3 within 10 cents, holds >=85 fps, and reports honest mic constraints', async () => {
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      await page.goto(`${PREVIEW_URL}?debug=1#/live`, { waitUntil: 'load' });
      await page.getByTestId('sing-button').click();
      await waitForFrames(page, 300, 15_000);

      const frames = await getFrames(page);
      const voiced = voicedFrames(frames);
      expect(voiced.length).toBeGreaterThan(0);

      const medianHz = median(voiced.map((f) => f.f0Hz));
      expect(Math.abs(centsFromReference(medianHz, 220))).toBeLessThanOrEqual(10);

      expect(frameRateOverWindow(frames, 2)).toBeGreaterThanOrEqual(85);

      // The readout names the note being sung and shows a dash in a moment with no voice. Chrome's fake microphone drops
      // a silent chunk (about 0.7 s) now and then, so read it until it shows A3 rather than at one instant.
      await expect.poll(async () => (await page.getByTestId('live-note').textContent()) ?? '', { timeout: 8_000, interval: 200 }).toContain('A3');

      const info = await getEngineInfo(page);
      const settings = info?.trackSettings;
      // "where reported": some browsers omit a constraint entirely rather than echoing it back false.
      if (settings?.echoCancellation !== undefined) expect(settings.echoCancellation).toBe(false);
      if (settings?.noiseSuppression !== undefined) expect(settings.noiseSuppression).toBe(false);
      if (settings?.autoGainControl !== undefined) expect(settings.autoGainControl).toBe(false);
    } finally {
      await context.close();
    }
  }, 30_000);

  it('holds a usable canvas render rate with the engine running for 3 s', async () => {
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      await page.goto(`${PREVIEW_URL}?debug=1#/live`, { waitUntil: 'load' });
      await page.getByTestId('sing-button').click();
      await waitForFrames(page, 10, 10_000);
      await page.waitForTimeout(3_000);
      // The best rate seen within RENDER_RATE_WINDOW_MS after those 3 s (see bestRenderFps): the bar is unchanged, and a
      // loop that never reaches it still fails, but a machine that is busy for a few seconds does not fail the run.
      const fps = await bestRenderFps(page, 50, RENDER_RATE_WINDOW_MS);

      if (headless) {
        // Headless Chrome routinely throttles requestAnimationFrame well
        // below a real device's rate. Keep the assertion (soft) rather than
        // deleting it, per AGENTS.md, so a headed run still catches a real
        // regression; a bare log line would silently stop checking this.
        expect.soft(fps, 'renderFps — SOFT because this browser is headless; rAF is throttled').toBeGreaterThanOrEqual(50);
      } else {
        expect(fps).toBeGreaterThanOrEqual(50);
      }
    } finally {
      await context.close();
    }
  }, 45_000);

  it('never writes the URL when navigating with in-app buttons (Home -> Live)', async () => {
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      await page.goto(PREVIEW_URL, { waitUntil: 'load' });
      await page.getByTestId('home-screen').waitFor({ state: 'visible', timeout: 10_000 });

      // A fresh profile (this test's isolated browser context has no prior IndexedDB
      // settings) first shows Home's voice-care sheet ("Got it"), then the "Before you
      // start" headphone sheet ("Later"). Each sheet's scrim (src/ui/components/Sheet.tsx)
      // blocks taps on the page behind it by design, so dismiss both the way a real
      // first-time user would before exercising the in-app navigation this test targets.
      await dismissFirstRun(page);

      const before = page.url();
      await page.getByTestId('dest-live').click();
      await page.getByTestId('live-screen').waitFor({ state: 'visible', timeout: 10_000 });

      expect(page.url()).toBe(before);
    } finally {
      await context.close();
    }
  }, 15_000);

  it('serves the app shell and the sing flow offline (precached, including the worklet chunk)', async () => {
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      await page.goto(PREVIEW_URL, { waitUntil: 'load' });

      let controlled = await waitForServiceWorkerControl(page);
      if (!controlled) {
        // The first load may still be installing; one reload is enough once activation lands.
        await page.reload({ waitUntil: 'load' });
        controlled = await waitForServiceWorkerControl(page);
      }
      expect(controlled).toBe(true);

      await context.setOffline(true);
      await page.reload({ waitUntil: 'load' });
      await page.getByTestId('home-screen').waitFor({ state: 'visible', timeout: 10_000 });

      // The bundled public-domain song charts are precached with the app, so Song Stage has its starter songs on a
      // first launch with no network (public/songs: songs/index.json plus one UltraStar .txt per song).
      const base = new URL(PREVIEW_URL).pathname;
      const charts = await page.evaluate(async (root) => {
        const index = (await (await fetch(`${root}songs/index.json`)).json()) as { songs: Array<{ id: string; file: string }> };
        const sizes: Record<string, number> = {};
        for (const song of index.songs) {
          const res = await fetch(`${root}songs/${song.file}`);
          sizes[song.id] = res.ok ? (await res.text()).length : -1;
        }
        return sizes;
      }, base);
      expect(Object.keys(charts).length).toBeGreaterThanOrEqual(12);
      for (const [id, size] of Object.entries(charts)) expect(size, `${id} chart served offline`).toBeGreaterThan(200);

      // navigateFallback serves index.html for any precached route while offline.
      await page.goto(`${PREVIEW_URL}?debug=1#/live`, { waitUntil: 'load' });
      await page.getByTestId('sing-button').click();
      await waitForFrames(page, 10, 10_000);
    } finally {
      await context.setOffline(false);
      await context.close();
    }
  }, 40_000);
});
