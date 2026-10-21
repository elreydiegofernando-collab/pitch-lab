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
