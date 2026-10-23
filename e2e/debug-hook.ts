/**
 * The `?debug` hook the ui agent exposes on `window.__pitchlab` (see
 * AGENTS.md's debug-hook contract). This file is the one place that knows
 * its shape, so every test calls the same typed helpers instead of each
 * writing its own `page.evaluate` string.
 */
import type { Page } from 'playwright-core';
import type { PitchFrame } from '../src/core/types';
import type { EngineInfo } from '../src/audio/engine-types';

export interface PitchLabDebugHook {
  engine: unknown;
  frameCount(): number;
  frames(n?: number): PitchFrame[];
  renderFps(): number | null;
  info(): EngineInfo;
}

declare global {
  interface Window {
    __pitchlab?: PitchLabDebugHook;
  }
}

/** Total frames the engine has produced since it last started, or 0 before the hook exists. */
export async function getFrameCount(page: Page): Promise<number> {
  return page.evaluate(() => window.__pitchlab?.frameCount() ?? 0);
}

/** The last `n` frames (or every buffered frame when `n` is omitted). */
export async function getFrames(page: Page, n?: number): Promise<PitchFrame[]> {
  return page.evaluate((count) => window.__pitchlab?.frames(count) ?? [], n);
}

export async function getRenderFps(page: Page): Promise<number | null> {
  return page.evaluate(() => window.__pitchlab?.renderFps() ?? null);
}

/**
 * The best render rate (`getRenderFps`) read within `windowMs`, reading every half second and stopping as soon as a
 * reading reaches `target`. A browser asks the page for a frame at whatever rate its compositor keeps, and a headless
 * Chrome on a machine busy with other things halves that, or worse, for stretches of seconds: the same idle build read
 * 56, 32 and 4 fps in runs a few minutes apart. A render loop that cannot reach `target` at any moment still fails; a
 * slow stretch of the machine no longer does.
 */
export async function bestRenderFps(page: Page, target: number, windowMs: number): Promise<number> {
  const deadline = Date.now() + windowMs;
  let best = 0;
  for (;;) {
    best = Math.max(best, (await getRenderFps(page)) ?? 0);
    if (best >= target || Date.now() >= deadline) return best;
    await page.waitForTimeout(500);
  }
}

export async function getEngineInfo(page: Page): Promise<EngineInfo | null> {
  return page.evaluate(() => window.__pitchlab?.info() ?? null);
}

/**
 * Polls until `frameCount() > minCount`. Written as its own helper (rather
 * than an inline `waitForFunction` at each call site) because `?? 0 > n`
 * parses as `?? (0 > n)` in JS — the parenthesised form below is the
 * correct, and only, way to combine the two.
 */
export async function waitForFrames(page: Page, minCount: number, timeoutMs = 10_000): Promise<void> {
  await page.waitForFunction(
    (n) => (window.__pitchlab?.frameCount() ?? 0) > n,
    minCount,
    { timeout: timeoutMs },
  );
}

/**
 * Polls until at least `minCount` of the retained frames are voiced. For a measurement that needs a stretch of real
 * signal: Chrome's fake microphone now and then delivers a silent chunk (about 0.7 s), so a count of frames of any kind
 * can be reached with far less voiced signal than its length suggests.
 */
export async function waitForVoicedFrames(page: Page, minCount: number, timeoutMs = 10_000): Promise<void> {
  await page.waitForFunction(
    (n) => (window.__pitchlab?.frames().filter((f) => f.voiced).length ?? 0) >= n,
    minCount,
    { timeout: timeoutMs, polling: 250 },
  );
}
