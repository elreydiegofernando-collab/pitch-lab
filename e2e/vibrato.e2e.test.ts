/**
 * One Chrome launch, fed the 330 Hz + 5.5 Hz/+-50c vibrato fixture. Confirms
 * the raw track reaching window.__pitchlab (and so the analyzers, in later
 * phases) is unsmoothed: CONFIG.display.smoothing is display-only, per
 * SPEC.md §7 and ARCHITECTURE.md's performance rules.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Browser } from 'playwright-core';
import { PREVIEW_URL, VIBRATO_WAV_PATH } from './config';
import { launchWithFakeMic } from './chrome';
import { getFrames, waitForVoicedFrames } from './debug-hook';
import { centsFromReference, detrend, estimateHalfExtent, estimateRateHz, voicedFrames } from './pitch-math';

/**
 * Chrome's fake microphone now and then delivers a silent chunk (about 0.7 s, 32768 samples at 48 kHz) in the middle of
 * the file: a page with none of Pitch Lab's code in it sees the same dropouts in the raw stream. The app's track then has
 * unvoiced stretches inside the vibrato. The rate is measured within the voiced runs (a gap between them is no cycle),
 * and the test waits for enough voiced signal instead of enough frames of any kind.
 */
const MAX_GAP_SEC = 0.1;
/** Voiced frames to wait for: about 4.3 s of voiced signal at ~93 frames a second, 23 cycles of a 5.5 Hz vibrato. */
const VOICED_FRAMES_NEEDED = 400;

describe('vibrato — 330 Hz carrier, 5.5 Hz +/-50c', () => {
  let browser: Browser;

  beforeAll(async () => {
    const launched = await launchWithFakeMic(VIBRATO_WAV_PATH);
    browser = launched.browser;
    if (launched.note) console.warn(`[e2e] ${launched.note}`);
  }, 120_000);

  afterAll(async () => {
    await browser?.close();
  });

  it('measures rate 5.5 +/-0.5 Hz and half-extent 50 +/-12 c from the raw voiced track', async () => {
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      await page.goto(`${PREVIEW_URL}?debug=1#/live`, { waitUntil: 'load' });
      await page.getByTestId('sing-button').click();
      // 5.5 Hz over several seconds gives plenty of cycles; the fixture is 10 s long and loops.
      await waitForVoicedFrames(page, VOICED_FRAMES_NEEDED, 25_000);

      const frames = await getFrames(page);
      const voiced = voicedFrames(frames);
      expect(voiced.length).toBeGreaterThan(200);

      const times = voiced.map((f) => f.t);
      const cents = voiced.map((f) => centsFromReference(f.f0Hz, 330));
      const detrended = detrend(times, cents, 0.7);

      const rateHz = estimateRateHz(times, detrended, MAX_GAP_SEC);
      expect(rateHz).toBeGreaterThanOrEqual(5.0);
      expect(rateHz).toBeLessThanOrEqual(6.0);

      const halfExtentCents = estimateHalfExtent(detrended);
      expect(halfExtentCents).toBeGreaterThanOrEqual(38);
      expect(halfExtentCents).toBeLessThanOrEqual(62);
    } finally {
      await context.close();
    }
  }, 45_000);
});
