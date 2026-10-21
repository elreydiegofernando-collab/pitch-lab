/**
 * Launches the installed Chrome (not Playwright's bundled Chromium — we
 * need the real fake-device/fake-audio-capture pipeline a branded build
 * ships) fed by a WAV as its fake microphone. One launch is reused by every
 * test in a file that needs that WAV; see ARCHITECTURE.md's e2e section.
 */
import { chromium, type Browser } from 'playwright-core';
import { CHROME_EXECUTABLE_WIN, PREVIEW_URL } from './config';
import { waitForFrames } from './debug-hook';

export interface LaunchedBrowser {
  browser: Browser;
  headless: boolean;
  /** Non-null when headless fake-mic capture didn't work, so the report can say so instead of hiding it. */
  note: string | null;
}

function fakeMicArgs(wavPath: string): string[] {
  return [
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    `--use-file-for-fake-audio-capture=${wavPath}`,
    '--autoplay-policy=no-user-gesture-required',
  ];
}

async function launchChrome(headless: boolean, wavPath: string): Promise<Browser> {
  const args = fakeMicArgs(wavPath);
  try {
    return await chromium.launch({ channel: 'chrome', headless, args });
  } catch {
    // The 'chrome' channel needs Playwright's own registry entry for it;
    // fall back to the known path on a plain Windows install.
    return await chromium.launch({ executablePath: CHROME_EXECUTABLE_WIN, headless, args });
  }
}

/** Does fake-mic audio actually reach the AudioWorklet in this browser instance? */
async function fakeMicDeliversFrames(browser: Browser): Promise<boolean> {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await page.goto(`${PREVIEW_URL}?debug=1#/live`, { waitUntil: 'load' });
    await page.getByTestId('sing-button').click();
    await waitForFrames(page, 10, 8_000);
    return true;
  } catch {
    return false;
  } finally {
    await context.close();
  }
}

/**
 * Launches Chrome with `wavPath` as the fake mic, preferring headless. Some
 * Chrome builds don't deliver fake-capture audio to an AudioWorklet in
 * headless mode; when the smoke check sees no frames we relaunch headed
 * (per AGENTS.md's instruction) and return why, instead of hiding it.
 */
export async function launchWithFakeMic(wavPath: string): Promise<LaunchedBrowser> {
  const headlessBrowser = await launchChrome(true, wavPath);
  if (await fakeMicDeliversFrames(headlessBrowser)) {
    return { browser: headlessBrowser, headless: true, note: null };
  }
  await headlessBrowser.close();

  const headedBrowser = await launchChrome(false, wavPath);
  const okHeaded = await fakeMicDeliversFrames(headedBrowser);
  return {
    browser: headedBrowser,
    headless: false,
    note: okHeaded
      ? 'Headless Chrome did not deliver fake-mic audio to the AudioWorklet; fell back to a headed window.'
      : 'Fake-mic audio did not reach the AudioWorklet in headless OR headed Chrome — the fake-capture/worklet pipeline needs investigation, not just a headless quirk.',
  };
}
