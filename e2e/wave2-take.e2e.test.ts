/**
 * A singer's first session through the real UI of the production build, on ONE browser profile, so IndexedDB and the
 * service worker carry from step to step the way they do on a phone:
 *
 *   Home -> voice care -> Continue -> Lesson 1, the Range finder (Learn, Practise, Check) -> its check -> Sing -> a passed
 *   report (its audio, its range, what it opened) -> the map shows the next lesson open and the rest still locked -> Listen
 *   plays the next lesson's demo without the mic, and Esc in the middle of a take goes back and saves nothing -> a reload
 *   keeps the progress, the attempt and the take (IndexedDB), and the take replays -> the app works offline once the
 *   service worker has installed -> Export backup downloads valid JSON with no audio, Export WAV downloads the real take ->
 *   the backup restores the singer on a fresh device -> a second profile does not see the first one's unlocks -> nothing
 *   left the app's own origin. (The practice drills of a lesson are sung in wave2-lesson.e2e.test.ts.)
 *
 * The fake mic loops e2e/range-signal.ts (A2 held, a siren, D4 held, a siren, a breath), which
 * range-signal.e2e.test.ts proves passes the Range finder from any point of the loop. That matters here: the take is the
 * first of the launch, so its engine start also creates the AudioContext (the case that once recorded nothing).
 */
import { afterAll, beforeAll, describe, expect, it, type TestContext } from 'vitest';
import type { Browser, BrowserContext, Locator, Page } from 'playwright-core';
import { PREVIEW_URL, RANGE_WAV_PATH } from './config';
import { launchWithFakeMic } from './chrome';
import { rangeFinder } from '../src/exercises/catalog/foundations';
import { realize } from '../src/exercises/transpose';
import {
  dismissFirstRun,
  ensureServiceWorkerControl,
  goHome,
  openDeepLink,
  openFromHome,
  readDownload,
  recordScreens,
  screensSeen,
  toastMessages,
  waitForToast,
} from './ui';

/** The Range finder is 25 s of material after a 2 s count-in; scoring is well under a second. */
const TAKE_TIMEOUT_MS = 60_000;

/** The app words a range with an en dash (U+2013), as in "A2-D4". Built from its code point so this file stays plain ASCII. */
const EN_DASH = String.fromCharCode(0x2013);
/** The notes the fake singer holds (range-signal.ts: A2 and D4). */
const EXTENDED_RANGE = `A2${EN_DASH}D4`;
/** The comfortable range the app trims from them: two semitones in from the bottom, three from the top (B2 and B3). */
const COMFORTABLE_RANGE = `B2${EN_DASH}B3`;

const APP_ORIGIN = new URL(PREVIEW_URL).origin;

interface Journey {
  /** The first take passed, so the steps that build on it can run. */
  sang: boolean;
  /** The backup file Export backup downloaded. */
  backup: { name: string; text: string } | null;
}

/** A singer's row on the Profiles screen, found by the name it shows (an exact match: "Me" is also inside "Range not measured"). */
function profileRow(page: Page, name: string): Locator {
  return page.locator('.pl-profiles-item').filter({ has: page.locator('.pl-profiles-name', { hasText: new RegExp(`^${name}$`) }) });
}

describe('Wave 2 - a first session, through the real UI', () => {
  let browser: Browser;
  let context: BrowserContext;
  let page: Page;
  const journey: Journey = { sang: false, backup: null };
  const requested: string[] = [];
  const faults: string[] = [];

  /** Steps that build on the first take are skipped, not failed, when it did not happen: the red test is the first one. */
  function needFirstTake(t: TestContext): void {
    if (!journey.sang) t.skip('needs the first take to have passed');
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
    await recordScreens(page);
  }, 120_000);

  afterAll(async () => {
    await context?.close();
    await browser?.close();
  });

  it('Home -> voice care -> Continue -> Lesson 1 -> its check: a passed Range finder, with its audio, its range and what it opened', async () => {
    // ?debug=1 only adds the read-only window.__pitchlab hook; the app is the same one.
    await page.goto(`${PREVIEW_URL}?debug=1`, { waitUntil: 'load' });
    await page.getByTestId('home-screen').waitFor({ state: 'visible', timeout: 15_000 });

    // First run, in order: the voice-care note, then the headphone prompt. A new singer sees the note before anything else.
    const careSheet = page.getByRole('dialog', { name: 'Voice care' });
    await careSheet.waitFor({ state: 'visible', timeout: 10_000 });
    expect((await careSheet.getByTestId('voice-care-note').textContent())?.toLowerCase()).toContain('not medical advice');
    await page.getByTestId('voice-care-done').click();
    const headphoneSheet = page.getByRole('dialog', { name: 'Before you start' });
    await headphoneSheet.waitFor({ state: 'visible', timeout: 10_000 });
    await headphoneSheet.getByRole('button', { name: 'Later' }).click();
    await headphoneSheet.waitFor({ state: 'hidden' });

    // Home's one amber button continues at the first lesson on the set list.
    const card = page.getByTestId('continue-card');
    expect(await card.textContent()).toContain('Range finder');
    expect(await card.textContent()).toMatch(/Next up\s*\S\s*Lesson 1/i);
    await page.getByTestId('continue-button').click();
    await page.getByTestId('level-screen').waitFor();

    // The lesson: Learn, Practise and Check on one page, Learn open by itself (a first visit), the amber move Practise.
    expect(await page.getByTestId('level-label').textContent()).toContain('Lesson 1');
    expect(await page.getByTestId('lesson-title').textContent()).toBe('Range finder');
    expect(await page.getByTestId('part-learn').getAttribute('data-state')).toBe('now');
    expect(await page.getByTestId('part-practise').getAttribute('data-state')).toBe('next');
    expect(await page.getByTestId('part-check').getAttribute('data-state')).toBe('next');
    await page.getByTestId('learn-page').waitFor();
    expect((await page.getByTestId('sing-button').textContent())?.trim()).toBe('Practise');
    // The Range finder measures rather than grades: its check shows the saved range (none yet), never a score.
    expect(await page.getByTestId('saved-range').textContent()).toContain('Not measured yet');
    expect(await page.getByTestId('best-score').count()).toBe(0);

    // The check can be taken any time (never pushed): Lesson -> Sing (ready) -> Sing (the mic opens inside this tap).
    await page.getByTestId('skip-to-check').click();
    await page.getByTestId('sing-screen').waitFor();
    expect(await page.getByTestId('context-chip').count(), 'the check is the level, not a practice step').toBe(0);
    await page.getByTestId('sing-button').click();
    await page.getByTestId('count-in').waitFor({ timeout: 10_000 });
    await page.locator('[data-testid="sing-screen"][data-phase="singing"]').waitFor({ timeout: 10_000 });
    expect(await page.getByTestId('engine-state').textContent()).toContain('Listening');
    const frames = await page.evaluate(() => window.__pitchlab?.frameCount() ?? 0);
    expect(frames, 'the mic is delivering frames').toBeGreaterThan(0);

    await page.getByTestId('report-screen').waitFor({ timeout: TAKE_TIMEOUT_MS });

    // The verdict, and what the fake singer actually held.
    expect((await page.getByTestId('verdict').textContent())?.trim()).toBe('Range saved');
    const range = (await page.getByTestId('range-card').textContent()) ?? '';
    expect(range, 'extended range = the lowest and highest notes held').toContain(EXTENDED_RANGE);
    expect(range, 'comfortable range = trimmed inside them').toContain(COMFORTABLE_RANGE);
    expect(await page.getByTestId('score-reveal').count(), 'the Range finder measures, it does not grade').toBe(0);

    // The first take of a launch must have its audio (playback is offered), and what it opened is listed.
    await page.getByTestId('play-take').waitFor({ timeout: 5_000 });
    const unlocked = (await page.getByTestId('unlocked-strip').textContent()) ?? '';
    for (const opened of ['Match one note', 'Progress dashboard', 'Daily workout', 'Personal records']) expect(unlocked, `Unlocked strip lists ${opened}`).toContain(opened);
    expect(await page.getByTestId('report-primary').textContent()).toContain('Next level');

    // Leaving Sing turned the mic off.
    expect(await page.evaluate(() => window.__pitchlab?.info().state)).toBe('idle');

    // The URL never changed.
    expect(page.url()).toBe(`${PREVIEW_URL}?debug=1`);
    journey.sang = true;
  }, TAKE_TIMEOUT_MS + 60_000);

  it('the next lesson opens on the map, and everything after it is still locked', async (t) => {
    needFirstTake(t);
    // "Next level" opens Lesson 2, Match one note.
    await page.getByTestId('report-primary').click();
    await page.getByTestId('level-screen').waitFor();
    expect(await page.getByTestId('level-label').textContent()).toContain('Lesson 2');
    expect(await page.getByTestId('lesson-title').textContent()).toBe('Match one note');
    expect(await page.getByTestId('sing-button').isEnabled()).toBe(true);

    await openFromHome(page, 'dest-map');
    await page.getByTestId('map-screen').waitFor();
    expect(await page.getByTestId('node-foundations.01').getAttribute('data-state')).toBe('passed');
    const next = page.getByTestId('node-foundations.02');
    expect(await next.getAttribute('data-state')).toBe('current');
    expect(await next.locator('button').count(), 'the next lesson is a control').toBe(1);
    expect(await next.getByTestId('node-practice').textContent(), 'the lesson you are on says where its practice is').toContain('New lesson');
    const after = page.getByTestId('node-foundations.03');
    expect(await after.getAttribute('data-state')).toBe('locked');
    expect(await after.locator('button').count(), 'the lesson after that is not').toBe(0);
    expect(await after.textContent()).toContain('Pass Match one note to unlock.');
    expect(await page.getByTestId('world-foundations').textContent()).toContain('1 of 13');

    // It opens from the map, and not the one beyond it.
    await next.locator('button').click();
    await page.getByTestId('level-screen').waitFor();
    expect(await page.getByTestId('level-label').textContent()).toContain('Lesson 2');
    expect(await page.getByTestId('check-status').textContent()).toContain('Not taken yet');
    expect(await toastMessages(page)).toEqual([]);
  }, 40_000);

  it('Listen plays the demo and Stop ends it, without ever opening the microphone', async (t) => {
    needFirstTake(t);
    // We are on Lesson 2 (Match one note). Listen starts the AudioContext inside the tap and builds the real demo.
    const listen = page.getByTestId('listen-button');
    await listen.click();
    await page.waitForFunction(() => document.querySelector('[data-testid="listen-button"]')?.getAttribute('aria-label') === 'Stop the demo', undefined, { timeout: 10_000 });
    expect(await page.evaluate(() => window.__pitchlab?.info().state), 'a demo needs speakers, not the mic').not.toBe('running');
    await listen.click();
    await page.waitForFunction(() => document.querySelector('[data-testid="listen-button"]')?.getAttribute('aria-label') === 'Listen to the demo', undefined, { timeout: 10_000 });
    expect(await toastMessages(page)).toEqual([]);
    expect(await page.getByRole('alert').count(), 'no error banner').toBe(0);
  }, 40_000);

  it('Esc in the middle of a take goes back to the lesson, turns the mic off and saves nothing', async (t) => {
    needFirstTake(t);
    await page.getByTestId('sing-button').click(); // Lesson -> Sing (ready): the amber move is the first practice step
    await page.getByTestId('sing-screen').waitFor();
    expect((await page.getByTestId('context-chip').textContent())?.trim()).toMatch(/^Practice\s*\S\s*step 1 of 3$/);
    await page.getByTestId('sing-button').click(); // the mic opens, the count-in starts
    await page.getByTestId('count-in').waitFor({ timeout: 10_000 });
    expect(await page.evaluate(() => window.__pitchlab?.info().state)).toBe('running');

    await page.keyboard.press('Escape');
    await page.getByTestId('level-screen').waitFor({ timeout: 10_000 });
    expect(await page.getByTestId('level-label').textContent()).toContain('Lesson 2');
    await page.waitForFunction(() => window.__pitchlab?.info().state === 'idle', undefined, { timeout: 10_000 });
    expect(await page.getByTestId('check-status').textContent(), 'half a take is not an attempt').toContain('Not taken yet');
    expect(await page.getByTestId('good-tries').first().textContent(), 'and not a try of the practice step either').toContain('0 of 2');
    expect(await page.getByTestId('report-screen').count()).toBe(0);
  }, 40_000);

  it('a reload keeps the progress, the attempt and the take (IndexedDB), and the take replays', async (t) => {
    needFirstTake(t);
    await page.reload({ waitUntil: 'load' });
    await page.getByTestId('home-screen').waitFor({ state: 'visible', timeout: 15_000 });
    await page.getByTestId('continue-card').waitFor();

    // The first-run sheets are done for good (they decide once this profile's settings have loaded, so give them a moment
    // to appear if they were going to); progress picks up at the next lesson.
    await page.waitForTimeout(700);
    expect(await page.getByTestId('voice-care-done').count(), 'voice care is not asked twice').toBe(0);
    const card = (await page.getByTestId('continue-card').textContent()) ?? '';
    expect(card).toContain('Match one note');
    expect(card).toMatch(/Next up\s*\S\s*Lesson 2/i);
    expect(await page.getByTestId('dest-dashboard').getAttribute('data-locked'), 'the dashboard stays open').toBeNull();

    // The attempt: Lesson 1 remembers its saved range, and the log counts the take.
    await page.getByTestId('dest-map').click();
    await page.getByTestId('node-foundations.01').locator('button').click();
    await page.getByTestId('level-screen').waitFor();
    expect(await page.getByTestId('saved-range').textContent()).toContain(COMFORTABLE_RANGE);

    // The take: one attempt, one recording with its audio, kept durably, and it replays.
    await openFromHome(page, 'util-data');
    await page.getByTestId('data-screen').waitFor();
    const storage = page.getByTestId('storage-card');
    await storage.waitFor();
    expect(await page.getByTestId('storage-durable').textContent()).toContain('Saved on this device');
    expect(await storage.textContent()).toMatch(/Attempts1Recordings1/);
    const row = page.getByTestId('recording-row');
    await row.waitFor();
    expect(await row.count()).toBe(1);
    expect(await row.textContent()).toContain('Range finder');
    expect(await row.textContent()).toContain('Audio');
    const play = row.getByRole('button', { name: /^Play / });
    await play.click();
    await row.getByRole('button', { name: /^Stop / }).waitFor({ timeout: 15_000 }); // read back from storage, decoded, now playing
    expect(await row.getByRole('alert').count(), 'no playback error').toBe(0);
    await row.getByRole('button', { name: /^Stop / }).click();
    await row.getByRole('button', { name: /^Play / }).waitFor();

    // Profiles shows the saved range.
    await openFromHome(page, 'util-profiles');
    expect(await profileRow(page, 'Me').textContent()).toContain(COMFORTABLE_RANGE);
  }, 60_000);

  it('works offline once the service worker has installed, progress included', async (t) => {
    needFirstTake(t);
    expect(await ensureServiceWorkerControl(page), 'the service worker controls the page').toBe(true);
    await context.setOffline(true);
    try {
      await page.reload({ waitUntil: 'load' });
      await page.getByTestId('home-screen').waitFor({ state: 'visible', timeout: 15_000 });
      await page.getByTestId('continue-card').waitFor();
      expect(await page.getByTestId('continue-card').textContent()).toContain('Match one note');

      // The map, a lesson and the saved take are all still there with no network.
      await page.getByTestId('dest-map').click();
      await page.getByTestId('node-foundations.02').locator('button').click();
      await page.getByTestId('level-screen').waitFor();
      expect(await page.getByTestId('level-label').textContent()).toContain('Lesson 2');
      await openFromHome(page, 'util-data');
      await page.getByTestId('recording-row').waitFor();

      // And the song charts that ship with the app are served from the service worker's cache.
      const charts = await page.evaluate(async (root) => {
        const index = (await (await fetch(`${root}songs/index.json`)).json()) as { songs: Array<{ id: string; file: string }> };
        const bad: string[] = [];
        for (const song of index.songs) if (!(await fetch(`${root}songs/${song.file}`)).ok) bad.push(song.id);
        return { count: index.songs.length, bad };
      }, new URL(PREVIEW_URL).pathname);
      expect(charts.count).toBeGreaterThanOrEqual(12);
      expect(charts.bad).toEqual([]);
    } finally {
      await context.setOffline(false);
    }
  }, 60_000);

  it('Export backup downloads valid JSON that holds the singer and the attempt, and no audio', async (t) => {
    needFirstTake(t);
    await page.reload({ waitUntil: 'load' });
    await openFromHome(page, 'util-data');
    await page.getByTestId('data-screen').waitFor();

    const [download] = await Promise.all([page.waitForEvent('download', { timeout: 15_000 }), page.getByRole('button', { name: 'Export backup' }).click()]);
    expect(download.suggestedFilename()).toMatch(/^pitch-lab-backup-\d{4}-\d{2}-\d{2}\.json$/);
    const text = (await readDownload(download)).toString('utf8');
    journey.backup = { name: download.suggestedFilename(), text };

    const file = JSON.parse(text) as {
      format: string;
      version: number;
      exportedAt: string;
      profiles: Array<{ id: string; name: string; voiceType: string; deletedAt: string | null; range: { comfortable: { low: number; high: number }; extended: { low: number; high: number } } | null }>;
      attempts: Array<{ profileId: string; exerciseId: string; levelId: string | null; kind: string; passed: boolean; score: number; takeId: string | null; metrics: Record<string, number> }>;
      settings: { schemaVersion: number; profiles: Record<string, { voiceCareSeen?: boolean }> };
    };
    expect(file.format).toBe('pitch-lab-backup');
    expect(file.version).toBe(1);
    expect(Number.isFinite(Date.parse(file.exportedAt))).toBe(true);

    const me = file.profiles.find((p) => p.name === 'Me' && p.deletedAt === null);
    expect(me, 'the singer is in the backup').toBeDefined();
    expect(me?.range?.extended).toEqual({ low: 45, high: 62 }); // A2 and D4
    expect(me?.range?.comfortable).toEqual({ low: 47, high: 59 }); // B2 and B3

    expect(file.attempts).toHaveLength(1);
    const attempt = file.attempts[0];
    expect(attempt).toMatchObject({ profileId: me?.id, exerciseId: 'foundations.range.1', levelId: 'foundations.01', kind: 'practice', passed: true, takeId: null });
    expect(attempt.score).toBeGreaterThan(0.99);
    expect(attempt.metrics['range.spanSemitones']).toBe(17);
    expect(file.settings.profiles[me?.id ?? '']?.voiceCareSeen).toBe(true);

    // A backup carries progress, never audio: no take, no track, no audio reference, no WAV bytes.
    for (const forbidden of ['audioRef', '"track"', 'RIFF', '"takes"', 'rmsDb']) expect(text, `the backup must not contain ${forbidden}`).not.toContain(forbidden);
  }, 40_000);

  it('Export WAV downloads the real take: mono 16-bit PCM of the whole take, not silence', async (t) => {
    needFirstTake(t);
    const row = page.getByTestId('recording-row');
    await row.waitFor();
    const [download] = await Promise.all([page.waitForEvent('download', { timeout: 15_000 }), row.getByRole('button', { name: /^Export WAV/ }).click()]);
    expect(download.suggestedFilename()).toMatch(/^pitch-lab-take-\d{4}-\d{2}-\d{2}\.wav$/);
    const wav = await readDownload(download);

    expect(wav.toString('ascii', 0, 4)).toBe('RIFF');
    expect(wav.toString('ascii', 8, 12)).toBe('WAVE');
    expect(wav.toString('ascii', 12, 16)).toBe('fmt ');
    expect({ format: wav.readUInt16LE(20), channels: wav.readUInt16LE(22), bits: wav.readUInt16LE(34) }).toEqual({ format: 1, channels: 1, bits: 16 });
    const sampleRate = wav.readUInt32LE(24);
    expect([44100, 48000]).toContain(sampleRate);
    expect(wav.toString('ascii', 36, 40)).toBe('data');
    const dataBytes = wav.readUInt32LE(40);
    expect(wav.length).toBe(44 + dataBytes);

    // The take is the pre-roll, the Range finder's material (the app plays each note first, so it is 25 s) and the tail:
    // read from the exercise itself, so a change to its length is a change here and not a surprise.
    const material = realize(rangeFinder, null, 'unknown').totalSec;
    const seconds = dataBytes / 2 / sampleRate;
    expect(seconds).toBeGreaterThan(material - 1);
    expect(seconds).toBeLessThan(material + 2);
    // It is the fake singer's voice (a tone with a peak of 0.3), not silence: a healthy overall level, though a good part
    // of the take is breaths and sirens.
    let sumSquares = 0;
    let peak = 0;
    const n = dataBytes / 2;
    for (let i = 0; i < n; i++) {
      const v = wav.readInt16LE(44 + i * 2) / 32768;
      sumSquares += v * v;
      peak = Math.max(peak, Math.abs(v));
    }
    expect(Math.sqrt(sumSquares / n), 'the take has the voice in it').toBeGreaterThan(0.03);
    expect(peak).toBeGreaterThan(0.15);
    expect(peak).toBeLessThan(0.5);
  }, 40_000);

  it('the backup restores the singer, their range and their progress on a fresh device', async (t) => {
    needFirstTake(t);
    if (!journey.backup) t.skip('needs the exported backup');
    const device = await browser.newContext({ viewport: { width: 390, height: 844 } });
    try {
      const fresh = await device.newPage();
      await fresh.goto(PREVIEW_URL, { waitUntil: 'load' });
      await dismissFirstRun(fresh);
      expect(await fresh.getByTestId('continue-card').textContent(), 'a new device starts at the beginning').toContain('Range finder');

      await openFromHome(fresh, 'util-data');
      await fresh.getByTestId('import-file').setInputFiles({
        name: journey.backup?.name ?? 'backup.json',
        mimeType: 'application/json',
        buffer: Buffer.from(journey.backup?.text ?? '', 'utf8'),
      });
      const report = fresh.getByTestId('import-report');
      await report.waitFor({ timeout: 15_000 });
      const reportText = (await report.textContent()) ?? '';
      expect(reportText).toContain('Backup imported.');
      expect(reportText).toContain('Added 1 profile.');
      expect(reportText).toContain('Added 1 attempt');
      expect(reportText).toContain('Restored the settings of 1 profile.');
      expect(reportText).toContain('Replaced the empty starter profile.');

      // Progress is back, and so is the range.
      await goHome(fresh);
      const card = (await fresh.getByTestId('continue-card').textContent()) ?? '';
      expect(card).toContain('Match one note');
      expect(card).toMatch(/Next up\s*\S\s*Lesson 2/i);
      expect(await fresh.getByTestId('dest-dashboard').getAttribute('data-locked')).toBeNull();
      await openFromHome(fresh, 'util-profiles');
      expect(await fresh.locator('.pl-profiles-item').count(), 'the empty starter profile was replaced, not kept beside it').toBe(1);
      expect(await profileRow(fresh, 'Me').textContent()).toContain(COMFORTABLE_RANGE);

      // The restored settings say voice care was read: it is not asked again.
      await fresh.reload({ waitUntil: 'load' });
      await fresh.getByTestId('continue-card').waitFor();
      expect(await fresh.getByTestId('voice-care-done').count()).toBe(0);
    } finally {
      await device.close();
    }
  }, 60_000);

  it('a second profile does not see the first profile\'s unlocks, and the first keeps them', async (t) => {
    needFirstTake(t);
    await goHome(page);
    await page.getByTestId('profile-chip').click();
    await page.getByTestId('profiles-screen').waitFor();
    await page.getByRole('button', { name: 'New profile' }).click();
    const sheet = page.getByRole('dialog', { name: 'New profile' });
    // A person types after the sheet has settled. Typing in its very first frame can be lost (its form resets in an
    // after-paint effect, the same one flush that moves focus into the sheet), so wait for that focus, as a person's
    // eyes and thumb do.
    await page.waitForFunction(() => document.activeElement?.closest('[role="dialog"]') != null, undefined, { timeout: 10_000 });
    await sheet.getByLabel('Name').fill('Sam');
    await sheet.getByRole('radio', { name: 'Tenor' }).click();
    await sheet.getByRole('button', { name: 'Create profile' }).click();

    // Creating it switches to it: Home, for Sam, who has not read the voice-care note and has passed nothing.
    await page.getByTestId('home-screen').waitFor({ state: 'visible', timeout: 15_000 });
    await page.getByTestId('voice-care-done').click({ timeout: 10_000 });
    expect(await page.getByTestId('profile-chip').getAttribute('aria-label')).toContain('Sam');
    const card = (await page.getByTestId('continue-card').textContent()) ?? '';
    expect(card).toContain('Range finder');
    expect(card).toMatch(/Next up\s*\S\s*Lesson 1/i);
    for (const row of ['dest-dashboard', 'dest-workout', 'dest-songs', 'dest-vibrato-meter']) {
      expect(await page.getByTestId(row).getAttribute('data-locked'), `${row} is locked for Sam`).toBe('true');
    }
    await page.getByTestId('dest-map').click();
    expect(await page.getByTestId('node-foundations.01').getAttribute('data-state')).toBe('current');
    expect(await page.getByTestId('node-foundations.02').getAttribute('data-state'), "Sam has not passed the first singer's level").toBe('locked');

    // Both are listed, each with their own range.
    await openFromHome(page, 'util-profiles');
    expect(await profileRow(page, 'Sam').textContent()).toContain('Range not measured');
    expect(await profileRow(page, 'Me').textContent()).toContain(COMFORTABLE_RANGE);

    // Sam is the active profile across a reload, so the first singer's deep links are refused for Sam...
    await openDeepLink(page, '#/dashboard');
    await page.getByTestId('home-screen').waitFor({ state: 'visible', timeout: 15_000 });
    await waitForToast(page, 'Pass your first level to see the progress dashboard.');
    expect(await screensSeen(page)).not.toContain('dashboard-screen');

    // ...and open again for the first singer once they are back.
    await openFromHome(page, 'util-profiles');
    await page.getByRole('button', { name: 'Sing as Me' }).click();
    await page.getByTestId('home-screen').waitFor({ state: 'visible' });
    expect(await page.getByTestId('profile-chip').getAttribute('aria-label')).toContain('Me');
    expect(await page.getByTestId('continue-card').textContent()).toContain('Match one note');
    await openDeepLink(page, '#/dashboard');
    await page.getByTestId('dashboard-screen').waitFor({ state: 'visible', timeout: 15_000 });
    expect(await toastMessages(page)).toEqual([]);
  }, 90_000);

  it('never asked anything outside the app\'s own origin, and threw nothing', async (t) => {
    needFirstTake(t);
    const outside = requested.filter((url) => !url.startsWith(APP_ORIGIN) && !url.startsWith('blob:') && !url.startsWith('data:') && url !== 'about:blank');
    expect(outside, 'no request left the app (no analytics, no CDN, no audio upload)').toEqual([]);
    expect(requested.length, 'the request log is recording').toBeGreaterThan(10);
    expect(faults).toEqual([]);
  });
});
