/**
 * Data & backup and Song Stage, driven with a hand-built backup (e2e/backup-fixture.ts) the way a singer restoring a
 * backup from another device would: a profile whose attempt log passes Foundations through its Boss Recital opens Song
 * Stage and its songs, with the songs that need a later world shown locked; a backup that stops one level short does not;
 * a backup made before Foundations became lessons keeps what still counts and puts the singer on the first new lesson;
 * and a file that is not a backup changes nothing and says so in plain words.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Browser, BrowserContext, Page } from 'playwright-core';
import { PREVIEW_URL, ROOT_DIR, TONE_WAV_PATH } from './config';
import { launchWithFakeMic } from './chrome';
import { FOUNDATIONS_RUN, FOUNDATIONS_RUN_BEFORE_LESSONS, craftBackup } from './backup-fixture';
import { dismissFirstRun, goHome, openDeepLink, openFromHome, recordScreens, screensSeen, waitForToast } from './ui';

/** A locked song's line. Screen readers hear "Locked." first (the Locked component), so it is in the text too. */
const BOSS_LINE = /Pass the .+ Boss Recital to unlock this song\.$/;

/** The bundled charts as the library ships them: id -> title, read from public/songs the way a browser would fetch them. */
function bundledSongs(): Array<{ id: string; title: string }> {
  const dir = path.join(ROOT_DIR, 'public', 'songs');
  const index = JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8')) as { songs: Array<{ id: string; file: string }> };
  return index.songs.map((s) => {
    const title = /^#TITLE:(.*)$/im.exec(fs.readFileSync(path.join(dir, s.file), 'utf8'))?.[1].trim();
    if (!title) throw new Error(`song ${s.id} has no #TITLE`);
    return { id: s.id, title };
  });
}

describe('Wave 2 - restoring a backup, and what it opens', () => {
  let browser: Browser;
  let context: BrowserContext;
  let page: Page;
  let faults: string[];

  beforeAll(async () => {
    const launched = await launchWithFakeMic(TONE_WAV_PATH);
    browser = launched.browser;
    if (launched.note) console.warn(`[e2e] ${launched.note}`);
  }, 120_000);

  afterAll(async () => {
    await browser?.close();
  });

  /** A brand-new device: nothing sung, first-run sheets dismissed, parked on Home. */
  async function freshDevice(): Promise<void> {
    context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    page = await context.newPage();
    faults = [];
    page.on('pageerror', (e) => faults.push(`page error: ${e.message}`));
    page.on('console', (m) => {
      if (m.type() === 'error') faults.push(`console error: ${m.text()}`);
    });
    await recordScreens(page);
    await page.goto(PREVIEW_URL, { waitUntil: 'load' });
    await page.getByTestId('home-screen').waitFor({ state: 'visible', timeout: 15_000 });
    await dismissFirstRun(page);
  }

  /** Data & backup -> pick this file in the import picker -> the report it shows. */
  async function importFile(name: string, text: string): Promise<string> {
    await openFromHome(page, 'util-data');
    await page.getByTestId('data-screen').waitFor();
    await page.getByTestId('import-file').setInputFiles({ name, mimeType: 'application/json', buffer: Buffer.from(text, 'utf8') });
    const report = page.getByTestId('import-report');
    await report.waitFor({ timeout: 15_000 });
    return (await report.textContent()) ?? '';
  }

  it('a log that passes Foundations through its Boss Recital opens Song Stage and its songs, with the later ones locked', async () => {
    await freshDevice();
    try {
      // Before: Song Stage is a locked line, and so is everything else the Boss Recital opens.
      expect(await page.getByTestId('dest-songs').getAttribute('data-locked')).toBe('true');
      expect(await page.getByTestId('continue-card').textContent()).toContain('Range finder');

      const crafted = craftBackup({ profileId: 'e2e-crafted-tenor', name: 'Crafted Tenor', voiceType: 'tenor', passed: FOUNDATIONS_RUN });
      expect(crafted.attempts).toBe(FOUNDATIONS_RUN.length);
      const report = await importFile('foundations-complete.json', crafted.json);
      expect(report).toContain('Backup imported.');
      expect(report).toContain('Added 1 profile.');
      expect(report).toContain(`Added ${FOUNDATIONS_RUN.length} attempts to the practice history.`);
      expect(report).toContain('Replaced the empty starter profile.');

      // After: the next number on the set list is the first level of the world the Boss Recital opened.
      await goHome(page);
      const card = page.getByTestId('continue-card');
      expect(await card.getAttribute('data-world')).toBe('vibrato');
      expect(await card.textContent()).toContain('Oscillation I');
      expect(await page.getByTestId('profile-chip').getAttribute('aria-label')).toContain('Crafted Tenor');
      for (const row of ['dest-songs', 'dest-dashboard', 'dest-workout', 'dest-vibrato-meter']) {
        expect(await page.getByTestId(row).getAttribute('data-locked'), `${row} is open`).toBeNull();
      }

      // Song Stage lists the bundled library: the songs this singer has earned are controls; the others are shown locked.
      await page.getByTestId('dest-songs').click();
      await page.getByTestId('songs-screen').waitFor();
      await page.getByTestId('song-row').first().waitFor({ timeout: 15_000 });
      const open = page.getByTestId('song-row');
      const locked = page.getByTestId('song-row-locked');
      const library = bundledSongs();
      expect(library.length).toBeGreaterThanOrEqual(12);
      const nOpen = await open.count();
      const nLocked = await locked.count();
      expect(nOpen, 'some songs are open').toBeGreaterThanOrEqual(1);
      expect(nLocked, 'some songs are still locked').toBeGreaterThanOrEqual(1);
      expect(nOpen + nLocked, 'every bundled song is listed once').toBe(library.length);
      expect(await page.locator('#songs-open').textContent()).toContain(`${nOpen}`);
      expect(await page.locator('#songs-locked').textContent()).toContain(`${nLocked}`);
      expect(await page.getByTestId('song-import-button').isVisible(), 'importing your own songs is earned with the Boss Recital too').toBe(true);

      const openTitles: string[] = [];
      for (let i = 0; i < nOpen; i++) {
        const row = open.nth(i);
        expect(await row.evaluate((el) => el.tagName), 'an open song is a control').toBe('BUTTON');
        openTitles.push(((await row.locator('.pl-song-row__title').textContent()) ?? '').trim());
      }
      const lockedTitles: string[] = [];
      for (let i = 0; i < nLocked; i++) {
        const row = locked.nth(i);
        expect(await row.evaluate((el) => el.tagName), 'a locked song is not a control').not.toBe('BUTTON');
        expect(await row.locator('button').count()).toBe(0);
        const line = ((await row.locator('.pl-song-row__locked').textContent()) ?? '').trim();
        expect(line, 'it says which Boss Recital opens it').toMatch(BOSS_LINE);
        expect(line, 'and never the one this singer has already passed').not.toContain('Foundations');
        lockedTitles.push(((await row.locator('.pl-song-row__title').textContent()) ?? '').trim());
      }
      expect([...openTitles, ...lockedTitles].sort()).toEqual(library.map((s) => s.title).sort());

      // An open song opens from its row and from a deep link; a locked one is refused with its requirement, whichever way.
      const byTitle = new Map(library.map((s) => [s.title, s.id]));
      await open.first().click();
      await page.getByTestId('song-player').waitFor({ state: 'visible', timeout: 15_000 });
      const openId = byTitle.get(openTitles[0]) as string;
      const lockedId = byTitle.get(lockedTitles[0]) as string;

      await openDeepLink(page, `#/song/${openId}`);
      await page.getByTestId('song-player').waitFor({ state: 'visible', timeout: 15_000 });
      await openDeepLink(page, `#/song/${lockedId}`);
      await page.getByTestId('songs-screen').waitFor({ state: 'visible', timeout: 15_000 });
      await page.locator('.pl-toast__msg', { hasText: /Boss Recital to unlock this song\.$/ }).first().waitFor({ state: 'visible', timeout: 10_000 });
      expect(await screensSeen(page), 'the locked song never rendered').not.toContain('song-player');

      // What the Boss Recital opened beyond Song Stage opens too.
      await goHome(page);
      for (const [row, screen] of [
        ['dest-dashboard', 'dashboard-screen'],
        ['dest-workout', 'workout-screen'],
        ['dest-vibrato-meter', 'vibrato-meter-screen'],
        ['dest-map', 'map-screen'],
      ] as const) {
        await page.getByTestId(row).click();
        await page.getByTestId(screen).waitFor({ state: 'visible', timeout: 15_000 });
        await goHome(page);
      }
      await page.getByTestId('dest-map').click();
      expect(await page.getByTestId('world-vibrato').getAttribute('data-open')).toBe('true');
      expect(await page.getByTestId('node-vibrato.01').getAttribute('data-state')).toBe('current');
      expect(await page.getByTestId('node-foundations.boss').getAttribute('data-state')).toBe('passed');
      expect(await page.getByTestId('world-inflections').getAttribute('data-open'), 'the world after Vibrato is still shut').toBe('false');

      // It survives a reload.
      await openDeepLink(page, '');
      await page.getByTestId('continue-card').waitFor();
      expect(await page.getByTestId('dest-songs').getAttribute('data-locked')).toBeNull();
      expect(faults).toEqual([]);
    } finally {
      await context.close();
    }
  }, 120_000);

  it('a log that stops one level short of the Boss Recital leaves Song Stage locked', async () => {
    await freshDevice();
    try {
      const crafted = craftBackup({ profileId: 'e2e-crafted-nearly', name: 'Nearly There', passed: FOUNDATIONS_RUN.slice(0, -1) });
      expect(await importFile('foundations-short.json', crafted.json)).toContain('Backup imported.');

      await goHome(page);
      const card = page.getByTestId('continue-card');
      expect(await card.getAttribute('data-world')).toBe('foundations');
      expect(await card.textContent()).toContain('Lesson 13');
      expect(await card.textContent()).toContain('Boss Recital');
      expect(await page.getByTestId('dest-dashboard').getAttribute('data-locked')).toBeNull(); // a first level passed opens it
      expect(await page.getByTestId('dest-songs').getAttribute('data-locked')).toBe('true');
      expect(await page.getByTestId('dest-vibrato-meter').getAttribute('data-locked')).toBe('true');

      await openDeepLink(page, '#/songs');
      await page.getByTestId('home-screen').waitFor({ state: 'visible', timeout: 15_000 });
      await waitForToast(page, 'Pass the Foundations Boss Recital to open Song Stage.');
      expect(await screensSeen(page)).not.toContain('songs-screen');
      expect(faults).toEqual([]);
    } finally {
      await context.close();
    }
  }, 60_000);

  it('a backup made before Foundations became lessons keeps what still counts, and puts the singer on Hold it steady', async () => {
    // The owner's own situation (2026-10-23): Range finder, Pitch match, Sustain I and Sustain II passed under the old ids.
    // The first three are the same lessons now, so they stand; Sustain II is gone (Hold it steady is a new lesson with a new
    // id: it judges a wobble, which Sustain II never did), so the singer is on Hold it steady, the fourth lesson.
    await freshDevice();
    try {
      const crafted = craftBackup({ profileId: 'e2e-crafted-owner', name: 'Old Backup', voiceType: 'tenor', passed: FOUNDATIONS_RUN_BEFORE_LESSONS.slice(0, 4) });
      const report = await importFile('before-lessons.json', crafted.json);
      expect(report).toContain('Backup imported.');
      expect(report).toContain('Added 4 attempts to the practice history.');

      await goHome(page);
      const card = page.getByTestId('continue-card');
      expect(await card.getAttribute('data-lesson'), 'the lesson the singer is on').toBe('foundations.13');
      const cardText = (await card.textContent()) ?? '';
      expect(cardText).toMatch(/Next up\s*\S\s*Lesson 4/i);
      expect(cardText).toContain('Hold it steady');
      expect(await page.getByTestId('continue-practice').textContent(), 'a lesson not started says so').toBe('New lesson');
      expect(await page.getByTestId('dest-dashboard').getAttribute('data-locked'), 'a level passed opens the dashboard').toBeNull();
      expect(await page.getByTestId('dest-songs').getAttribute('data-locked'), 'Song Stage is still earned').toBe('true');

      // The map: what counts is passed, the new lesson is the one in progress, and the old Sustain II has no place.
      await page.getByTestId('dest-map').click();
      await page.getByTestId('map-screen').waitFor();
      for (const id of ['foundations.01', 'foundations.02', 'foundations.03']) expect(await page.getByTestId(`node-${id}`).getAttribute('data-state'), id).toBe('passed');
      expect(await page.getByTestId('node-foundations.13').getAttribute('data-state')).toBe('current');
      expect(await page.getByTestId('node-foundations.10').getAttribute('data-state')).toBe('locked');
      expect(await page.getByTestId('node-foundations.10').textContent()).toContain('Pass Hold it steady to unlock.');
      expect(await page.locator('[data-testid="node-foundations.04"]').count(), 'Sustain II is no longer a lesson').toBe(0);
      expect(await page.locator('[data-testid^="node-foundations."]').count()).toBe(13);
      expect(await page.getByTestId('world-foundations').textContent()).toContain('3 of 13');

      // Hold it steady opens as a first lesson does: Learn open by itself, nothing practised, nothing taken.
      await page.getByTestId('node-foundations.13').locator('button').click();
      await page.getByTestId('level-screen').waitFor();
      expect(await page.getByTestId('level-label').textContent()).toContain('Lesson 4');
      expect(await page.getByTestId('lesson-title').textContent()).toBe('Hold it steady');
      expect(await page.getByTestId('part-learn').getAttribute('data-state')).toBe('now');
      await page.getByTestId('learn-page').waitFor();
      expect(await page.getByTestId('check-status').textContent()).toContain('Not taken yet');

      // A lesson passed in the old backup is passed, but its Learn and Practise were never done here: they say so.
      await goHome(page);
      await page.getByTestId('dest-map').click();
      await page.getByTestId('node-foundations.03').locator('button').click();
      await page.getByTestId('level-screen').waitFor();
      expect(await page.getByTestId('lesson-title').textContent()).toBe('Hold it');
      expect(await page.getByTestId('part-check').getAttribute('data-state')).toBe('done');
      expect(await page.getByTestId('part-learn').getAttribute('data-state')).toBe('next');
      expect(await page.getByTestId('part-practise').getAttribute('data-state')).toBe('next');
      expect(await page.getByTestId('check-status').textContent()).toContain('Passed');
      expect(faults).toEqual([]);
    } finally {
      await context.close();
    }
  }, 90_000);

  it('a whole backup from before the lessons does not skip the new ones: Song Stage waits until they are passed', async () => {
    await freshDevice();
    try {
      const crafted = craftBackup({ profileId: 'e2e-crafted-oldfull', name: 'Old Full Run', voiceType: 'tenor', passed: FOUNDATIONS_RUN_BEFORE_LESSONS });
      const report = await importFile('before-lessons-full.json', crafted.json);
      expect(report).toContain('Backup imported.');
      expect(report).toContain(`Added ${FOUNDATIONS_RUN_BEFORE_LESSONS.length} attempts to the practice history.`);

      await goHome(page);
      const card = page.getByTestId('continue-card');
      expect(await card.getAttribute('data-lesson'), 'the first lesson with no pass yet').toBe('foundations.13');
      expect(await page.getByTestId('dest-songs').getAttribute('data-locked'), 'the old Boss Recital pass waits behind the new lessons').toBe('true');
      expect(await page.getByTestId('dest-vibrato-meter').getAttribute('data-locked')).toBe('true');

      await openDeepLink(page, '#/songs');
      await page.getByTestId('home-screen').waitFor({ state: 'visible', timeout: 15_000 });
      await waitForToast(page, 'Pass the Foundations Boss Recital to open Song Stage.');
      expect(await screensSeen(page)).not.toContain('songs-screen');
      expect(faults).toEqual([]);
    } finally {
      await context.close();
    }
  }, 90_000);

  it('says so in plain words, and changes nothing, when the file is not a backup', async () => {
    await freshDevice();
    try {
      const cases: ReadonlyArray<readonly [string, string, string]> = [
        ['notes.json', '{ "hello": "world" }', 'not a recognised pitch-lab-backup file'],
        ['broken.json', '{ "format": "pitch-lab-backup", "version": 1, "profiles": [', 'not valid JSON'],
        ['from-the-future.json', JSON.stringify({ format: 'pitch-lab-backup', version: 99, profiles: [], attempts: [] }), 'newer version of Pitch Lab'],
      ];
      for (const [name, text, why] of cases) {
        const report = await importFile(name, text);
        expect(report, name).toContain('That file was not imported.');
        expect(report, name).toContain('Nothing on this device changed.');
        expect(report, name).toContain(why);
      }
      await goHome(page);
      expect(await page.getByTestId('continue-card').textContent(), 'still the starter profile, still at the start').toContain('Range finder');
      expect(await page.getByTestId('profile-chip').getAttribute('aria-label')).toContain('Me');
    } finally {
      await context.close();
    }
  }, 60_000);

  it('Delete all data wipes the device, and the backup brings the singer back (the full round trip)', async () => {
    await freshDevice();
    try {
      const crafted = craftBackup({ profileId: 'e2e-crafted-wipe', name: 'Round Tripper', voiceType: 'tenor', passed: FOUNDATIONS_RUN });
      expect(await importFile('foundations-complete.json', crafted.json)).toContain('Backup imported.');
      await goHome(page);
      expect(await page.getByTestId('continue-card').getAttribute('data-world')).toBe('vibrato');

      // Delete everything: the sheet wants the word DELETE, then it says what it did and lands on a fresh Home.
      await openFromHome(page, 'util-data');
      await page.getByRole('button', { name: 'Delete all data' }).click();
      const sheet = page.getByRole('dialog', { name: 'Delete all data?' });
      await sheet.waitFor({ state: 'visible' });
      const confirm = sheet.getByRole('button', { name: 'Delete everything' });
      expect(await confirm.isDisabled(), 'not until DELETE is typed').toBe(true);
      await page.waitForFunction(() => document.activeElement?.closest('[role="dialog"]') != null, undefined, { timeout: 10_000 });
      await sheet.getByTestId('delete-all-confirm').fill('DELETE');
      await confirm.click();
      await page.getByTestId('home-screen').waitFor({ state: 'visible', timeout: 15_000 });
      await waitForToast(page, 'All data deleted.');

      // A fresh singer again: the voice-care note is read per profile, so it comes back. "Before you start" and the latency
      // calibration belong to the device, and Delete all data keeps them (storage deleteAllData: "Device calibration is kept").
      await page.getByTestId('voice-care-done').click({ timeout: 10_000 });
      expect(await page.getByRole('dialog', { name: 'Before you start' }).count()).toBe(0);
      expect(await page.getByTestId('continue-card').textContent()).toContain('Range finder');
      expect(await page.getByTestId('profile-chip').getAttribute('aria-label')).toContain('Me');
      expect(await page.getByTestId('dest-songs').getAttribute('data-locked'), 'Song Stage is locked again').toBe('true');
      await page.waitForTimeout(600); // the "seen" flags are saved after 400 ms
      await openFromHome(page, 'util-data');
      await page.getByTestId('storage-card').waitFor();
      expect(await page.getByTestId('storage-card').textContent()).toMatch(/Attempts0Recordings0/);

      // The same backup restores them.
      await page.getByTestId('import-file').setInputFiles({ name: 'foundations-complete.json', mimeType: 'application/json', buffer: Buffer.from(crafted.json, 'utf8') });
      const report = (await page.getByTestId('import-report').textContent()) ?? '';
      expect(report).toContain('Backup imported.');
      expect(report).toContain(`Added ${FOUNDATIONS_RUN.length} attempts to the practice history.`);
      await goHome(page);
      expect(await page.getByTestId('continue-card').getAttribute('data-world')).toBe('vibrato');
      expect(await page.getByTestId('profile-chip').getAttribute('aria-label')).toContain('Round Tripper');
      expect(await page.getByTestId('dest-songs').getAttribute('data-locked')).toBeNull();

      // The same file again adds nothing and says so.
      const again = await importFile('foundations-complete.json', crafted.json);
      expect(again).toContain('Nothing new in that backup.');
      expect(again).toContain(`Skipped ${FOUNDATIONS_RUN.length} attempts that were already here.`);
      expect(faults).toEqual([]);
    } finally {
      await context.close();
    }
  }, 90_000);

  it('imports what it can read from a damaged backup, and says what it left out', async () => {
    await freshDevice();
    try {
      const crafted = craftBackup({ profileId: 'e2e-crafted-damaged', name: 'Damaged Backup', passed: FOUNDATIONS_RUN.slice(0, 2) });
      const file = JSON.parse(crafted.json) as { attempts: unknown[] };
      file.attempts.push({ id: 'e2e-bad-attempt', profileId: 'e2e-crafted-damaged', kind: 'not-a-kind' }); // one row the importer cannot read
      const report = await importFile('damaged.json', JSON.stringify(file));
      expect(report).toContain('Backup imported.');
      expect(report).toContain('Added 2 attempts');
      expect(report).toContain('Could not read 1 attempt, so it was left out.');

      await goHome(page);
      expect(await page.getByTestId('continue-card').textContent(), 'the two readable attempts count').toContain('Hold it');
    } finally {
      await context.close();
    }
  }, 60_000);
});
