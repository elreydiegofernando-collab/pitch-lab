/**
 * A lesson through the real UI of the production build, for a brand-new singer, on ONE browser profile so IndexedDB
 * carries from step to step the way it does on a phone:
 *
 *   Home -> Continue -> Lesson 1 (Learn open by itself, a music word tapped and explained, the demo played without the mic)
 *   -> Practise -> a practice take sung into the fake mic -> a calm drill report ("Good try", its step, its good tries, no
 *   score, no tiles, nothing unlocked) whose amber button is "Again" -> Again sings the same step once more -> the step is
 *   done and the amber button is "Next step" -> Back to the lesson shows the step done -> a reload keeps it (the lesson's
 *   progress is read back from the log) and practice has passed or opened nothing (the dashboard is still locked).
 *
 * And the owner's rule, held to account in the take itself (2026-10-23: "I don't need the note playing along while I'm
 * singing. I need to know the note before I sing it."): the app plays exactly each chunk first (a Listen step, heard by
 * the page's oscillators on the audio clock), then the singer's turn, and nothing at all sounds while the singer sings, not
 * a guide tone and not a metronome click; the live hint says "listen..." before it says anything about the singer's pitch.
 *
 * The fake mic loops e2e/range-signal.ts (A2 held, a siren, D4 held, a siren, a breath). The first practice step of
 * Lesson 1 asks only that a try is sung to its end (nothing to judge yet), so any whole take of that loop is a good try.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Browser, BrowserContext, Page } from 'playwright-core';
import { PREVIEW_URL, RANGE_WAV_PATH } from './config';
import { launchWithFakeMic } from './chrome';
import { dismissFirstRun, openFromHome } from './ui';
import { drillSeeYourVoice } from '../src/exercises/catalog/foundations';
import { realize } from '../src/exercises/transpose';
import { HINTS } from '../src/ui/practice/live-hint';

/** A practice take is a 20 s drill after a 2 s count-in; scoring is well under a second. */
const TAKE_TIMEOUT_MS = 60_000;

/** The app's own middle dot (U+00B7), built from its code point so this file stays plain ASCII. */
const MIDDLE_DOT = String.fromCharCode(0xb7);

/** A tone voice (a Listen note) lasts well over this; a count-in or metronome click lasts 20 ms. */
const CLICK_MAX_LIFE_SEC = 0.1;
/** A voice's release tail may reach this far into the singer's turn without being heard as sound there (the next note's attack is later still). */
const RELEASE_TAIL_SEC = 0.02;

declare global {
  interface Window {
    /** Every oscillator the page starts (the synth's notes and clicks), on the audio clock: see recordSound. */
    __plOsc?: Array<{ start: number; stop: number | null }>;
    /** Each different live hint the Sing screen showed, in order: see recordHints. */
    __plHints?: Array<{ kind: string; text: string }>;
  }
}

/** From now on every document records each oscillator that is started, with when it starts and when it stops (audio-clock seconds). */
async function recordSound(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const log: Array<{ start: number; stop: number | null }> = [];
    window.__plOsc = log;
    type Tracked = OscillatorNode & { __plRec?: { start: number; stop: number | null } };
    const proto = AudioScheduledSourceNode.prototype;
    const start = proto.start;
    const stop = proto.stop;
    proto.start = function (this: AudioScheduledSourceNode, when?: number): void {
      if (this instanceof OscillatorNode) {
        const rec = { start: when ?? this.context.currentTime, stop: null as number | null };
        (this as Tracked).__plRec = rec;
        log.push(rec);
      }
      start.call(this, when);
    };
    proto.stop = function (this: AudioScheduledSourceNode, when?: number): void {
      const rec = (this as Tracked).__plRec;
      if (rec) rec.stop = when ?? this.context.currentTime;
      stop.call(this, when);
    };
  });
}

/** From now on every document records each different live hint (`data-testid="live-hint"`) that is shown, in order. */
async function recordHints(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const seen: Array<{ kind: string; text: string }> = [];
    window.__plHints = seen;
    const read = (): void => {
      const el = document.querySelector('[data-testid="live-hint"]');
      if (!el) return;
      const kind = el.getAttribute('data-kind') ?? '';
      if (kind === '' || kind === 'none') return;
      const text = el.querySelector('[data-testid="live-hint-text"]')?.textContent ?? '';
      const last = seen[seen.length - 1];
      if (!last || last.kind !== kind) seen.push({ kind, text });
    };
    new MutationObserver(read).observe(document, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['data-kind'] });
  });
}

describe('Wave 2 - a lesson, through the real UI', () => {
  let browser: Browser;
  let context: BrowserContext;
  let page: Page;
  const faults: string[] = [];

  beforeAll(async () => {
    const launched = await launchWithFakeMic(RANGE_WAV_PATH);
    browser = launched.browser;
    if (launched.note) console.warn(`[e2e] ${launched.note}`);
    context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    page = await context.newPage();
    page.on('pageerror', (e) => faults.push(`page error: ${e.message}`));
    page.on('console', (m) => {
      if (m.type() === 'error') faults.push(`console error: ${m.text()}`);
    });
    await recordSound(page);
    await recordHints(page);
  }, 120_000);

  afterAll(async () => {
    await context?.close();
    await browser?.close();
  });

  /** Sing the take on the Sing screen that is open (the mic opens inside the tap), and wait for its report. */
  async function singThrough(): Promise<void> {
    await page.evaluate(() => {
      if (window.__plOsc) window.__plOsc.length = 0; // the take's own sounds, not the demo's
      if (window.__plHints) window.__plHints.length = 0;
    });
    await page.getByTestId('sing-button').click();
    await page.getByTestId('count-in').waitFor({ timeout: 10_000 });
    await page.locator('[data-testid="sing-screen"][data-phase="singing"]').waitFor({ timeout: 10_000 });
    await page.getByTestId('report-screen').waitFor({ timeout: TAKE_TIMEOUT_MS });
  }

  it('Lesson 1: Learn, then Practise: a practice take ends in a calm report with its good tries, and Again sings the step once more', async () => {
    // ?debug=1 only adds the read-only window.__pitchlab hook; the app is the same one.
    await page.goto(`${PREVIEW_URL}?debug=1`, { waitUntil: 'load' });
    await page.getByTestId('home-screen').waitFor({ state: 'visible', timeout: 15_000 });
    await dismissFirstRun(page);

    // Home -> Lesson 1: Learn opens by itself, with the lesson's music words explained right there.
    await page.getByTestId('continue-button').click();
    await page.getByTestId('level-screen').waitFor();
    expect(await page.getByTestId('level-label').textContent()).toContain('Lesson 1');
    await page.getByTestId('learn-page').waitFor();
    const words = page.locator('[data-testid="learn-words"] .pl-term');
    expect(await words.allTextContents(), 'the words this lesson teaches, each tappable').toEqual(['range', 'count-in']);

    // A music word, tapped: its plain explanation and an example, and "Got it" closes it.
    await words.first().click();
    const sheet = page.getByRole('dialog', { name: 'Range' });
    await sheet.waitFor({ state: 'visible', timeout: 10_000 });
    expect(((await sheet.getByTestId('term-plain').textContent()) ?? '').length, 'it explains the word').toBeGreaterThan(30);
    expect(await sheet.getByTestId('term-example').count(), 'with an example').toBe(1);
    await sheet.getByRole('button', { name: 'Got it' }).click();
    await sheet.waitFor({ state: 'hidden' });

    // The Learn page plays the lesson's simplest try without ever opening the microphone; Stop ends it.
    const demo = page.getByTestId('learn-listen');
    await demo.click();
    await page.waitForFunction(() => document.querySelector('[data-testid="learn-listen"]')?.textContent?.trim() === 'Stop', undefined, { timeout: 10_000 });
    expect(await page.evaluate(() => window.__pitchlab?.info().state), 'a demo needs speakers, not the mic').not.toBe('running');
    await demo.click();
    await page.waitForFunction(() => document.querySelector('[data-testid="learn-listen"]')?.textContent?.trim() === 'Listen', undefined, { timeout: 10_000 });

    // Practise: the amber move is the first step, and the Sing screen says which step it is.
    expect((await page.getByTestId('sing-button').textContent())?.trim()).toBe('Practise');
    expect(await page.getByTestId('step-0').getAttribute('data-state')).toBe('now');
    expect(await page.getByTestId('step-0').getByTestId('good-tries').textContent()).toContain('0 of 2 good tries');
    await page.getByTestId('sing-button').click();
    await page.getByTestId('sing-screen').waitFor();
    expect((await page.getByTestId('context-chip').textContent())?.trim()).toBe(`Practice ${MIDDLE_DOT} step 1 of 2`);
    expect((await page.locator('.pl-appbar__title').textContent())?.trim()).toBe(drillSeeYourVoice.title);

    // Sing it. The take is the drill: three turns, each one heard first and then sung back.
    await singThrough();

    // The owner's rule, on the audio clock. The app played each chunk first (one Listen tone per turn, at the times the
    // drill gives them), and nothing sounded in the singer's turn: no tone and no click. The count-in clicks come before.
    const realized = realize(drillSeeYourVoice, null, 'unknown');
    const sound = ((await page.evaluate(() => window.__plOsc ?? [])) ?? []).map((o) => ({ start: o.start, stop: o.stop ?? o.start }));
    const tones = sound.filter((o) => o.stop - o.start > CLICK_MAX_LIFE_SEC).sort((a, b) => a.start - b.start);
    const clicks = sound.filter((o) => o.stop - o.start <= CLICK_MAX_LIFE_SEC);
    expect(tones.length, 'one tone per chunk to be sung: the app plays what to sing').toBe(realized.reference.length);
    expect(realized.reference.length).toBe(3);
    const downbeat = tones[0].start - realized.reference[0].start; // take time 0 on the audio clock
    tones.forEach((tone, i) => expect(tone.start - downbeat, `tone ${i + 1} starts when its chunk is to be heard`).toBeCloseTo(realized.reference[i].start, 1));
    expect(clicks.length, 'the count-in clicks').toBe(realized.countInSec > 0 ? Math.round(realized.countInSec / (60 / realized.bpm)) : 0);
    expect(Math.max(...clicks.map((c) => c.start)), 'every click is in the count-in: no metronome once the take starts').toBeLessThan(downbeat);
    expect(realized.notes.length, 'three turns to sing').toBe(3);
    for (const note of realized.notes) {
      for (const o of sound) {
        const overlap = Math.min(o.stop - downbeat, note.end) - Math.max(o.start - downbeat, note.start);
        expect(overlap, `nothing sounds while the singer sings (note at ${note.start} s)`).toBeLessThanOrEqual(RELEASE_TAIL_SEC);
      }
    }

    // The live hint is plain words, and it says "listen..." before it says anything about the singer's pitch.
    const hints = (await page.evaluate(() => window.__plHints ?? [])) ?? [];
    expect(hints.length, 'the take showed live hints').toBeGreaterThan(0);
    for (const h of hints) expect(h.text, `the hint "${h.kind}" is the app's own plain line`).toBe(HINTS[h.kind as keyof typeof HINTS]?.text);
    expect(hints[0].kind, 'the first thing the take says is to listen').toBe('listen');

    // The report: practice is training, not testing. "Good try", its step, its good tries, no score, no tiles, nothing unlocked.
    expect((await page.getByTestId('verdict').textContent())?.trim()).toBe('Good try');
    expect((await page.getByTestId('drill-step').textContent())?.trim()).toBe(`Lesson 1 ${MIDDLE_DOT} Step 1 of 2: ${drillSeeYourVoice.title}`);
    expect(await page.getByTestId('drill-verdict').getByTestId('good-tries').textContent()).toContain('1 of 2 good tries');
    expect(await page.getByTestId('drill-next').count(), 'the step is not done yet: no "on to the next one"').toBe(0);
    expect(await page.getByTestId('score-reveal').count(), 'no score ring on a practice try').toBe(0);
    expect(await page.locator('[data-testid^="tile-"]').count(), 'no metric tiles on a practice try').toBe(0);
    expect(await page.getByTestId('unlocked-strip').count(), 'practice opens nothing').toBe(0);
    await page.getByTestId('play-take').waitFor({ timeout: 5_000 }); // the try can be heard back
    expect((await page.getByTestId('report-primary').textContent())?.trim()).toBe('Again');
    expect(await page.getByTestId('report-lesson').count(), '"Back to the lesson" sits beside it').toBe(1);
    expect(await page.evaluate(() => window.__pitchlab?.info().state), 'leaving Sing turned the mic off').toBe('idle');

    // Again: the same step, once more. Its second good try finishes the step, and the way on is "Next step".
    await page.getByTestId('report-primary').click();
    await page.getByTestId('sing-screen').waitFor();
    expect((await page.getByTestId('context-chip').textContent())?.trim()).toBe(`Practice ${MIDDLE_DOT} step 1 of 2`);
    await singThrough();
    expect((await page.getByTestId('verdict').textContent())?.trim()).toBe('Good try');
    expect(await page.getByTestId('drill-verdict').getByTestId('good-tries').textContent()).toContain('2 of 2 good tries');
    expect((await page.getByTestId('drill-next').textContent())?.trim()).toBe('This step is done. On to the next one.');
    expect((await page.getByTestId('report-primary').textContent())?.trim()).toBe('Next step');
    expect(await page.getByTestId('report-next-try').count(), '"One more try" is still offered').toBe(1);
    expect(await page.getByTestId('unlocked-strip').count()).toBe(0);

    // Next step opens the second step; Back from it is the lesson, with the first step done and the second Now.
    await page.getByTestId('report-primary').click();
    await page.getByTestId('sing-screen').waitFor();
    expect((await page.getByTestId('context-chip').textContent())?.trim()).toBe(`Practice ${MIDDLE_DOT} step 2 of 2`);
    await page.getByRole('button', { name: 'Back' }).first().click();
    await page.getByTestId('level-screen').waitFor();
    expect(await page.getByTestId('step-0').getAttribute('data-state')).toBe('done');
    expect(await page.getByTestId('step-0').getByTestId('good-tries').textContent()).toContain('2 of 2 good tries');
    expect(await page.getByTestId('step-1').getAttribute('data-state')).toBe('now');
    expect(await page.getByTestId('part-learn').getAttribute('data-state')).toBe('done');
    expect(await page.getByTestId('part-practise').getAttribute('data-state')).toBe('now');
    expect(await page.getByTestId('part-check').getAttribute('data-state'), 'practice never passes the check').toBe('next');
    expect(await page.getByTestId('learn-page').count(), 'Learn waits, folded, once it has been read').toBe(0);
    expect(await page.getByTestId('learn-toggle').textContent()).toContain('Read again');
  }, TAKE_TIMEOUT_MS * 2 + 120_000);

  it('a reload keeps the lesson where it was, and practice has passed and opened nothing', async () => {
    await page.reload({ waitUntil: 'load' });
    await page.getByTestId('home-screen').waitFor({ state: 'visible', timeout: 15_000 });
    await page.getByTestId('continue-card').waitFor();
    await page.waitForTimeout(700); // the first-run sheets decide once this profile's settings have loaded
    expect(await page.getByTestId('voice-care-done').count()).toBe(0);

    // Home still leads to Lesson 1, now on its second practice step: the two good tries were read back from the log.
    const card = (await page.getByTestId('continue-card').textContent()) ?? '';
    expect(card).toMatch(/Next up\s*\S\s*Lesson 1/i);
    expect(card).toContain('Range finder');
    expect(await page.getByTestId('continue-practice').textContent()).toBe('Practice 2 of 2');

    // Everything is earned: two good practice tries opened nothing and passed nothing.
    expect(await page.getByTestId('dest-dashboard').getAttribute('data-locked'), 'the dashboard is still locked').toBe('true');
    expect(await page.getByTestId('dest-workout').getAttribute('data-locked'), 'and so is the workout').toBe('true');
    await page.getByTestId('dest-map').click();
    await page.getByTestId('map-screen').waitFor();
    expect(await page.getByTestId('node-foundations.01').getAttribute('data-state'), 'Lesson 1 is still the one in progress').toBe('current');
    expect(await page.getByTestId('node-foundations.02').getAttribute('data-state')).toBe('locked');
    expect(await page.getByTestId('node-foundations.01').getByTestId('node-practice').textContent()).toContain('Practice 2 of 2');

    // The lesson itself: step 1 done with its two good tries, the amber move is the second step.
    await page.getByTestId('node-foundations.01').locator('button').click();
    await page.getByTestId('level-screen').waitFor();
    expect(await page.getByTestId('step-0').getAttribute('data-state')).toBe('done');
    expect(await page.getByTestId('step-0').getByTestId('good-tries').textContent()).toContain('2 of 2 good tries');
    expect(await page.getByTestId('step-1').getAttribute('data-state')).toBe('now');
    expect((await page.getByTestId('sing-button').textContent())?.trim()).toBe('Practise');

    // The two tries are in the practice history (attempts with no level), each with its recording.
    await openFromHome(page, 'util-data');
    await page.getByTestId('storage-card').waitFor();
    expect(await page.getByTestId('storage-card').textContent()).toMatch(/Attempts2Recordings2/);
    expect(faults).toEqual([]);
  }, 60_000);
});
