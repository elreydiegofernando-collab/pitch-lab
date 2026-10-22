/**
 * One Chrome launch, fed the A3 (220 Hz) voice-like tone fixture, covering
 * every assertion in AGENTS.md's "Test pitch" / "Test render" / "Test no
 * URL writes" / "Test offline" items that fixture can drive.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Browser, Page } from 'playwright-core';
import { PREVIEW_URL, TONE_WAV_PATH } from './config';
import { launchWithFakeMic } from './chrome';
import { getEngineInfo, getFrames, getRenderFps, waitForFrames } from './debug-hook';
import { centsFromReference, frameRateOverWindow, median, voicedFrames } from './pitch-math';

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

      const liveNote = (await page.getByTestId('live-note').textContent()) ?? '';
      expect(liveNote).toContain('A3');

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
      const fps = (await getRenderFps(page)) ?? 0;

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
  }, 20_000);

  it('never writes the URL when navigating with in-app buttons (Home -> Live)', async () => {
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      await page.goto(PREVIEW_URL, { waitUntil: 'load' });
      await page.getByTestId('home-screen').waitFor({ state: 'visible', timeout: 10_000 });

      // A fresh profile (this test's isolated browser context has no prior IndexedDB
      // settings) always shows Home's first-run "Before you start" sheet, which — by
      // design (src/ui/components/Sheet.tsx's scrim) — blocks taps on the page behind
      // it. Dismiss it the way a real first-time user would before exercising the
      // in-app navigation this test actually targets.
      const dismissFirstRun = page.getByRole('button', { name: 'Later' });
      if (await dismissFirstRun.isVisible().catch(() => false)) {
        await dismissFirstRun.click();
      }

      const before = page.url();
      await page.getByTestId('home-screen').locator('a, button', { hasText: /live/i }).first().click();
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
      expect(Object.keys(charts).length).toBeGreaterThanOrEqual(6);
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

async function waitForServiceWorkerControl(page: Page): Promise<boolean> {
  try {
    return await page.evaluate(async () => {
      if (!('serviceWorker' in navigator)) return false;
      await navigator.serviceWorker.ready;
      return navigator.serviceWorker.controller != null;
    });
  } catch {
    return false;
  }
}
