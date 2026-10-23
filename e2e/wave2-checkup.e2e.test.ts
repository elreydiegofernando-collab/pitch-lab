/**
 * The voice check-up through the real UI of the production build, for a brand-new singer, on ONE browser profile so
 * IndexedDB carries from step to step the way it does on a phone:
 *
 *   Home leads with "Start with a 4-minute voice check-up", above the Continue card and the one amber button -> the card
 *   opens the check-up's intro (what it is, the five tasks in their order, a voice-care line, Start) -> Start opens task 1
 *   of 5, the Range finder, which is sung into the fake mic and saves a range -> its report is a check-up report (a range
 *   and what it opened, no score ring) whose one amber button is "Next task" -> task 2 of 5 opens with the range task 1
 *   saved (no default-range note) -> leaving part way shows "Task 2 of 5" on the check-up screen and on Home, and so does
 *   closing Pitch Lab and opening it again (a reload): every take is already in the log, so the check-up picks up where it
 *   stopped -> nothing left the app's own origin, and nothing threw.
 *
 * The fake mic loops e2e/range-signal.ts (A2 held, a siren, D4 held, a siren, a breath), which
 * range-signal.e2e.test.ts proves passes the Range finder from any point of the loop. The rest of the battery is not
 * sung here: a steady loop is not a siren or a run of short notes, so the four placement tests are covered where they can
 * be told apart from the signal, in the unit suites (runtime/checkup.test.ts, checkup/summary.test.ts).
 */
import { afterAll, beforeAll, describe, expect, it, type TestContext } from 'vitest';
import type { Browser, BrowserContext, Page } from 'playwright-core';
import { PREVIEW_URL, RANGE_WAV_PATH } from './config';
import { launchWithFakeMic } from './chrome';
import { dismissFirstRun } from './ui';
import { CHECKUP_TASKS } from '../src/checkup/types';

/** The Range finder is 20 s of material after a 4 s count-in; scoring is well under a second. */
const TAKE_TIMEOUT_MS = 60_000;

/** The app words a range with an en dash (U+2013), and a context chip with a middle dot (U+00B7). Built from code points so this file stays plain ASCII. */
const EN_DASH = String.fromCharCode(0x2013);
const MIDDLE_DOT = String.fromCharCode(0xb7);
/** The notes the fake singer holds (range-signal.ts: A2 and D4), and the comfortable range the app trims from them. */
const EXTENDED_RANGE = `A2${EN_DASH}D4`;
const COMFORTABLE_RANGE = `B2${EN_DASH}B3`;

const APP_ORIGIN = new URL(PREVIEW_URL).origin;
const TASK_COUNT = CHECKUP_TASKS.length;

/** The Sing screen's chip for a check-up task, from its 1-based place: "Check-up · 2 of 5" (src/ui/practice/copy.ts). */
function chip(place: number): string {
  return `Check-up ${MIDDLE_DOT} ${place} of ${TASK_COUNT}`;
}

interface Journey {
  /** Home showed the check-up card and it opened the intro. */
  onIntro: boolean;
  /** Task 1, the Range finder, was sung and its report is the one in front of the singer. */
  sangRange: boolean;
  /** "Next task" opened task 2, and the singer left it. */
  leftPartWay: boolean;
}

describe('Wave 2 - the voice check-up, through the real UI', () => {
  let browser: Browser;
  let context: BrowserContext;
  let page: Page;
  const journey: Journey = { onIntro: false, sangRange: false, leftPartWay: false };
  const requested: string[] = [];
  const faults: string[] = [];

  /** Steps that build on an earlier one are skipped, not failed, when it did not happen: the red test is the first one. */
  function need(t: TestContext, step: keyof Journey): void {
    if (!journey[step]) t.skip(`needs the step before it (${step})`);
  }

  beforeAll(async () => {
    const launched = await launchWithFakeMic(RANGE_WAV_PATH);
    browser = launched.browser;
    if (launched.note) console.warn(`[e2e] ${launched.note}`);
    context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    context.on('request', (r) => requested.push(r.url()));
    page = await context.newPage();
    page.on('pageerror', (e) => faults.push(`page error: ${e.message}`));
    page.on('console', (m) => {
      if (m.type() === 'error') faults.push(`console error: ${m.text()}`);
    });
  }, 120_000);

  afterAll(async () => {
    await context?.close();
    await browser?.close();
  });

  it('a new singer opens Home to the voice check-up card, above Continue, with the one amber button', async () => {
    // ?debug=1 only adds the read-only window.__pitchlab hook; the app is the same one.
    await page.goto(`${PREVIEW_URL}?debug=1`, { waitUntil: 'load' });
    await page.getByTestId('home-screen').waitFor({ state: 'visible', timeout: 15_000 });
    await dismissFirstRun(page);

    const card = page.getByTestId('checkup-card');
    await card.waitFor({ state: 'visible', timeout: 10_000 });
    expect(await card.getAttribute('data-kind'), 'a profile that has sung nothing gets the first-step card').toBe('first');
    expect(await card.textContent()).toContain('Start with a 4-minute voice check-up');
    const start = page.getByTestId('checkup-card-button');
    expect((await start.textContent())?.trim()).toBe('Start the check-up');

    // One amber button at a time (DESIGN 13.0): the check-up's, with Continue stepping back to a secondary button below it.
    expect(await start.getAttribute('class')).toContain('pl-btn--primary');
    const continueButton = page.getByTestId('continue-button');
    expect(await continueButton.getAttribute('class')).toContain('pl-btn--secondary');
    expect(await continueButton.getAttribute('class')).not.toContain('pl-btn--primary');
    expect(await page.getByTestId('home-screen').locator('.pl-btn--primary').count(), 'Home shows exactly one amber button').toBe(1);
    const cardBox = await card.boundingBox();
    const continueBox = await page.getByTestId('continue-card').boundingBox();
    expect(cardBox, 'the check-up card is laid out').not.toBeNull();
    expect(continueBox, 'the Continue card is laid out').not.toBeNull();
    expect((cardBox?.y ?? 1e9) < (continueBox?.y ?? 0), 'the check-up card sits above the Continue card').toBe(true);

    // Nothing has been sung or started: no singing screen, and the mic is off.
    expect(await page.getByTestId('sing-screen').count()).toBe(0);
    expect(await page.evaluate(() => window.__pitchlab?.info().state)).not.toBe('running');
  }, 60_000);

  it('the card opens the intro: what it is, the five tasks in their order, a care line and Start', async () => {
    await page.getByTestId('checkup-card-button').click();
    const screen = page.getByTestId('checkup-screen');
    await screen.waitFor({ state: 'visible', timeout: 10_000 });
    expect(await screen.getAttribute('data-view')).toBe('intro');

    // A check-up, not a test: the intro says so, and says nothing here can lower progress.
    expect(await page.getByRole('heading', { name: 'A check-up, not a test' }).count()).toBe(1);
    expect(await page.getByTestId('checkup-intro').textContent()).toContain('Nothing here can lower your progress');

    // The five tasks, numbered, in the battery's order, the Range finder first.
    const titles = await page.locator('[data-testid^="checkup-task-"] .ck-task__title').allTextContents();
    expect(titles).toHaveLength(5);
    expect(titles).toEqual(CHECKUP_TASKS.map((task) => task.title));
    expect(titles[0]).toBe('Find your range');
    for (let n = 1; n <= TASK_COUNT; n++) expect(await page.getByTestId(`checkup-task-${n}`).count(), `task ${n} is listed`).toBe(1);

    // Voice care, the app's usual words; no earlier check-up to show on the first one.
    expect(await page.getByTestId('checkup-care').textContent()).toContain('Stop if anything hurts');
    expect(await page.getByTestId('checkup-last').count()).toBe(0);
    expect(await page.getByTestId('checkup-last-results').count()).toBe(0);

    const startButton = page.getByTestId('checkup-start');
    expect((await startButton.textContent())?.trim()).toBe('Start');
    expect(await startButton.isEnabled()).toBe(true);
    expect(await page.getByTestId('sing-screen').count(), 'reading the intro starts nothing').toBe(0);
    journey.onIntro = true;
  }, 40_000);

  it('Start opens task 1 of 5, the Range finder; sung into the fake mic it saves a range and offers "Next task"', async (t) => {
    need(t, 'onIntro');
    await page.getByTestId('checkup-start').click();
    await page.getByTestId('sing-screen').waitFor({ state: 'visible', timeout: 10_000 });

    // Task 1 of 5, by its plain title; the Range finder needs no saved range, so no default-range note.
    expect((await page.getByTestId('context-chip').textContent())?.trim()).toBe(chip(1));
    expect((await page.locator('.pl-appbar__title').textContent())?.trim()).toBe('Find your range');
    expect(await page.getByText('Using a default range until you pass the Range finder.').count()).toBe(0);

    // Sing (the mic opens inside this tap): the count-in, then the take.
    await page.getByTestId('sing-button').click();
    await page.getByTestId('count-in').waitFor({ timeout: 10_000 });
    await page.locator('[data-testid="sing-screen"][data-phase="singing"]').waitFor({ timeout: 10_000 });
    expect(await page.getByTestId('engine-state').textContent()).toContain('Listening');
    expect(await page.evaluate(() => window.__pitchlab?.frameCount() ?? 0), 'the mic is delivering frames').toBeGreaterThan(0);

    await page.getByTestId('report-screen').waitFor({ timeout: TAKE_TIMEOUT_MS });

    // A check-up report: the range it measured, calm words, no score ring (a check-up, not a test). When it did not
    // save a range the report says why ("Not all of this task was heard..."): the failure carries that line, so a take
    // Chrome's fake microphone dropped out of reads differently from a regression.
    const verdict = (await page.getByTestId('verdict').textContent())?.trim();
    const reason = (await page.getByTestId('verdict-reason').count()) > 0 ? (await page.getByTestId('verdict-reason').textContent())?.trim() : 'no reason line';
    expect(verdict, `the Range finder take saved no range (the report's reason line: ${reason})`).toBe('Range saved');
    const range = (await page.getByTestId('range-card').textContent()) ?? '';
    expect(range, 'extended range = the lowest and highest notes held').toContain(EXTENDED_RANGE);
    expect(range, 'comfortable range = trimmed inside them').toContain(COMFORTABLE_RANGE);
    expect(await page.getByTestId('score-reveal').count(), 'a check-up task is measured, never graded: no score ring, no tally lights').toBe(0);
    const unlocked = (await page.getByTestId('unlocked-strip').textContent()) ?? '';
    expect(unlocked, 'passing the Range finder by singing it opens the next level').toContain('Pitch match');

    // The way on: "Next task" is the one amber button; the same task can be sung again, as a secondary one.
    const primary = page.getByTestId('report-primary');
    expect((await primary.textContent())?.trim()).toBe('Next task');
    expect(await primary.getAttribute('class')).toContain('pl-btn--primary');
    const again = page.getByTestId('report-retry');
    expect((await again.textContent())?.trim()).toBe('Sing it again');
    expect(await again.getAttribute('class')).toContain('pl-btn--secondary');
    expect(await page.getByTestId('report-checkup-results').count(), 'the results wait until the last task').toBe(0);

    // Leaving Sing turned the mic off, and the URL never changed.
    expect(await page.evaluate(() => window.__pitchlab?.info().state)).toBe('idle');
    expect(page.url()).toBe(`${PREVIEW_URL}?debug=1`);
    journey.sangRange = true;
  }, TAKE_TIMEOUT_MS + 60_000);

  it('"Next task" opens task 2 of 5 with the range task 1 saved, and leaving it shows "Task 2 of 5" on the check-up and on Home', async (t) => {
    need(t, 'sangRange');
    await page.getByTestId('report-primary').click();
    await page.getByTestId('sing-screen').waitFor({ state: 'visible', timeout: 10_000 });
    expect((await page.getByTestId('context-chip').textContent())?.trim()).toBe(chip(2));
    expect((await page.locator('.pl-appbar__title').textContent())?.trim()).toBe(CHECKUP_TASKS[1].title);
    expect(await page.getByText('Using a default range until you pass the Range finder.').count(), 'task 1 saved a range, so this task is not sung in a default one').toBe(0);
    expect(await page.locator('[data-testid="sing-screen"]').getAttribute('data-phase')).toBe('idle');
    expect(await page.getByTestId('sing-button').isEnabled()).toBe(true);

    // Leave part way: Back lands on the check-up screen, which has become "in progress".
    await page.getByRole('button', { name: 'Back' }).first().click();
    const screen = page.getByTestId('checkup-screen');
    await screen.waitFor({ state: 'visible', timeout: 10_000 });
    expect(await screen.getAttribute('data-view')).toBe('progress');
    expect((await page.getByTestId('checkup-progress-title').textContent())?.trim()).toBe(`Task 2 of ${TASK_COUNT}`);
    expect(await page.getByTestId('checkup-task-1').getAttribute('data-state')).toBe('done');
    expect(await page.getByTestId('checkup-task-2').getAttribute('data-state')).toBe('next');
    for (let n = 3; n <= TASK_COUNT; n++) expect(await page.getByTestId(`checkup-task-${n}`).getAttribute('data-state'), `task ${n} is still to come`).toBe('ahead');
    expect(await page.getByTestId('checkup-resume').textContent()).toContain('even after closing Pitch Lab');
    expect((await page.getByTestId('checkup-continue').textContent())?.trim()).toBe('Continue');
    expect((await page.getByTestId('checkup-restart').textContent())?.trim()).toBe('Start over');

    // And Home now invites the singer back, in the same words.
    await page.getByRole('button', { name: 'Back' }).first().click();
    await page.getByTestId('home-screen').waitFor({ state: 'visible', timeout: 10_000 });
    const card = page.getByTestId('checkup-card');
    await card.waitFor({ state: 'visible', timeout: 10_000 });
    expect(await card.getAttribute('data-kind')).toBe('continue');
    expect(await card.textContent()).toContain('Finish your voice check-up');
    expect(await card.textContent()).toContain(`Task 2 of ${TASK_COUNT} is next.`);
    expect((await page.getByTestId('checkup-card-button').textContent())?.trim()).toBe('Continue the check-up');
    journey.leftPartWay = true;
  }, 60_000);

  it('closing Pitch Lab and opening it again still shows "Task 2 of 5", and Continue sings task 2', async (t) => {
    need(t, 'leftPartWay');
    // A reload is what closing the app and opening it again is: the page and the in-memory session are gone, the log is not.
    await page.reload({ waitUntil: 'load' });
    await page.getByTestId('home-screen').waitFor({ state: 'visible', timeout: 15_000 });
    const card = page.locator('[data-testid="checkup-card"][data-kind="continue"]');
    await card.waitFor({ state: 'visible', timeout: 15_000 });
    expect(await card.textContent()).toContain('Finish your voice check-up');
    expect(await card.textContent()).toContain(`Task 2 of ${TASK_COUNT} is next.`);
    expect(await page.getByTestId('voice-care-done').count(), 'the first-run sheets are done for good').toBe(0);

    await page.getByTestId('checkup-card-button').click();
    const screen = page.getByTestId('checkup-screen');
    await screen.waitFor({ state: 'visible', timeout: 10_000 });
    expect(await screen.getAttribute('data-view')).toBe('progress');
    expect((await page.getByTestId('checkup-progress-title').textContent())?.trim()).toBe(`Task 2 of ${TASK_COUNT}`);
    expect(await page.getByTestId('checkup-task-1').getAttribute('data-state'), 'the Range finder take survived the reload').toBe('done');

    // Continue picks the check-up up at task 2, not at the top.
    await page.getByTestId('checkup-continue').click();
    await page.getByTestId('sing-screen').waitFor({ state: 'visible', timeout: 10_000 });
    expect((await page.getByTestId('context-chip').textContent())?.trim()).toBe(chip(2));
    expect((await page.locator('.pl-appbar__title').textContent())?.trim()).toBe(CHECKUP_TASKS[1].title);
    expect(await page.evaluate(() => window.__pitchlab?.info().state), 'task 2 is waiting for the singer, the mic is off').not.toBe('running');
  }, 60_000);

  it('never asked anything outside the app\'s own origin, and threw nothing', async (t) => {
    need(t, 'onIntro');
    const outside = requested.filter((url) => !url.startsWith(APP_ORIGIN) && !url.startsWith('blob:') && !url.startsWith('data:') && url !== 'about:blank');
    expect(outside, 'no request left the app (no analytics, no CDN, no audio upload)').toEqual([]);
    expect(requested.length, 'the request log is recording').toBeGreaterThan(10);
    expect(faults).toEqual([]);
  });
});
