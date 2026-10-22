/**
 * Page helpers for the tests that drive the real UI of the production build: the things every one of them does the
 * same way (the first-run sheets, a deep link as a fresh load, the toast region, a recorder for the screens that ever
 * rendered, the service worker, a download). Selectors are the app's `data-testid`s and roles, never its copy, except
 * where the copy IS the claim being tested.
 */
import type { Download, Page } from 'playwright-core';
import { PREVIEW_URL } from './config';

/** The app saves a changed setting 400 ms after the change (src/state/settings.ts SAVE_DEBOUNCE_MS); a person is never faster than that. */
const SETTINGS_SETTLE_MS = 550;

/**
 * Dismiss the two first-run sheets (voice care, then "Before you start"), the way a brand-new singer does, and give
 * the "seen" flags the moment they take to be saved. Without it a test would be quicker than any person: an import
 * that lands inside that window drops the unsaved flag and the voice-care sheet comes back.
 */
export async function dismissFirstRun(page: Page): Promise<void> {
  await page.getByTestId('voice-care-done').click({ timeout: 10_000 });
  await page.getByRole('button', { name: 'Later' }).click({ timeout: 10_000 });
  await page.waitForTimeout(SETTINGS_SETTLE_MS);
}

/** Open the app at a deep link as a fresh load. The router reads the hash once at boot, so a hash change alone would do nothing. */
export async function openDeepLink(page: Page, hash: string): Promise<void> {
  await page.goto('about:blank');
  await page.goto(`${PREVIEW_URL}${hash}`, { waitUntil: 'load' });
}

/** The messages of the toasts on screen right now. */
export function toastMessages(page: Page): Promise<string[]> {
  return page.locator('.pl-toast__msg').allTextContents();
}

/** Wait until a toast with exactly this message is on screen (a refused navigation says what opens it). */
export async function waitForToast(page: Page, message: string, timeoutMs = 10_000): Promise<void> {
  await page.locator('.pl-toast__msg', { hasText: message }).first().waitFor({ state: 'visible', timeout: timeoutMs });
}

interface SeenWindow {
  __plSeen?: Set<string>;
}

/**
 * From now on, every document this page loads records each `data-testid` that ever enters its DOM, even for one frame.
 * Call before navigating. `screensSeen` reads the record: it proves a locked screen was never rendered, which a test of
 * the page it finally landed on cannot.
 */
export async function recordScreens(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const seen = new Set<string>();
    (window as unknown as SeenWindow).__plSeen = seen;
    const note = (node: Node): void => {
      if (node.nodeType !== 1) return;
      const el = node as Element;
      const own = el.getAttribute('data-testid');
      if (own) seen.add(own);
      for (const inner of el.querySelectorAll('[data-testid]')) seen.add(inner.getAttribute('data-testid') as string);
    };
    new MutationObserver((records) => {
      for (const r of records) r.addedNodes.forEach(note);
    }).observe(document, { childList: true, subtree: true });
  });
}

/** Every `data-testid` seen since the page's last load (see recordScreens). */
export function screensSeen(page: Page): Promise<string[]> {
  return page.evaluate(() => [...((window as unknown as SeenWindow).__plSeen ?? [])]);
}

/** True once the page is controlled by the app's service worker (it has installed, activated and claimed this page). */
export async function waitForServiceWorkerControl(page: Page): Promise<boolean> {
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

/**
 * Make sure this page is served by the installed service worker. The first load only installs it; the next one is
 * controlled, so reload once if it is not yet. Returns whether the page ended up controlled.
 */
export async function ensureServiceWorkerControl(page: Page): Promise<boolean> {
  if (await waitForServiceWorkerControl(page)) return true;
  await page.reload({ waitUntil: 'load' });
  return waitForServiceWorkerControl(page);
}

/** The bytes of a download Playwright caught. */
export async function readDownload(download: Download): Promise<Buffer> {
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk as Uint8Array));
  return Buffer.concat(chunks);
}

/** Back until Home shows (Back is an in-app button; the URL never changes). */
export async function goHome(page: Page): Promise<void> {
  for (let i = 0; i < 8; i++) {
    if (await page.getByTestId('home-screen').isVisible()) return;
    await page.getByRole('button', { name: 'Back' }).first().click();
  }
  await page.getByTestId('home-screen').waitFor({ state: 'visible', timeout: 5_000 });
}

/** Open a screen from Home by its row. */
export async function openFromHome(page: Page, row: string): Promise<void> {
  await goHome(page);
  await page.getByTestId(row).click();
}
