/**
 * The Wave 1 engines in a real browser. The unit tests run them in Node, against fake-indexeddb, a fake OPFS and a
 * hand-rolled Web Audio evaluator; nothing in the app imports them yet (the exercise runner is Wave 2), so the production
 * build cannot reach them either. This file bundles them with Vite (the same bundler and the same TypeScript the app uses),
 * serves the bundle to the installed Chrome, and drives them through the real thing:
 *
 *  - storage: IndexedDB + OPFS, a relaunch, deletes that must really delete, a wipe, and a backup round trip;
 *  - the Listen demos: every exercise's demo built with the real synth into a real OfflineAudioContext and read back
 *    through the production framer and pitch detector.
 *
 * The page-side code is plain JavaScript in e2e/browser/wave1-checks.js (served as-is, never serialized from TypeScript).
 */
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright-core';
import { build } from 'vite';
import { ARTIFACTS_DIR, CHROME_EXECUTABLE_WIN, ROOT_DIR } from './config';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(ARTIFACTS_DIR, 'wave1');
const BUNDLE = path.join(OUT_DIR, 'wave1.js');
const CHECKS = path.join(HERE, 'browser', 'wave1-checks.js');

/** What the page-side checks need from the Wave 1 modules, as one flat bundle. */
function entrySource(): string {
  const src = (file: string) => path.join(ROOT_DIR, 'src', file).replaceAll('\\', '/');
  return [
    `export { getStorage, encodeTrack, newId } from '${src('storage/index.ts')}';`,
    `export { encodeWav } from '${src('audio/wav.ts')}';`,
    `export { EXERCISES } from '${src('exercises/catalog/index.ts')}';`,
    `export { realize } from '${src('exercises/transpose.ts')}';`,
    `export { buildDemo } from '${src('audio/demos.ts')}';`,
    `export { createSynth } from '${src('audio/synth.ts')}';`,
    `export { Framer } from '${src('audio/framer.ts')}';`,
    `export { createDetector } from '${src('dsp/detector.ts')}';`,
    `export { CONFIG, hopSizeFor } from '${src('config.ts')}';`,
  ].join('\n');
}

async function launchChrome(): Promise<Browser> {
  try {
    return await chromium.launch({ channel: 'chrome', headless: true });
  } catch {
    return await chromium.launch({ executablePath: CHROME_EXECUTABLE_WIN, headless: true });
  }
}

/**
 * Runs one of the page-side checks (e2e/browser/wave1-checks.js) with the Wave 1 bundle. The callback is serialized into
 * the page, so it must not contain a literal `import()`: vitest rewrites that into a helper the page does not have.
 * `new Function` keeps the page's own dynamic import out of that transform.
 */
function inPage<T>(page: Page, check: 'storageSmoke' | 'demosSmoke', args: unknown[] = []): Promise<T> {
  return page.evaluate(
    async ({ check, args, bundle, checks }) => {
      const load = new Function('url', 'return import(url)') as (url: string) => Promise<Record<string, (...a: unknown[]) => unknown>>;
      const [wave1, mod] = await Promise.all([load(bundle), load(checks)]);
      return mod[check](wave1, ...args);
    },
    { check, args, bundle: '/wave1.js', checks: '/checks.js' },
  ) as Promise<T>;
}

interface Seeded {
  flags: { persistent: boolean; db: boolean; opfs: boolean; kv: boolean; backend: string };
  take: { audioRef: string | null; wavBytes: number; audioBackBytes: number | null };
  usage: { attemptCount: number; takeCount: number; binaryBytes: number; binaryBackend: string };
  reconcile: { orphanFilesRemoved: number; danglingTakes: number; danglingSongs: number };
  json: string;
  attemptId: string;
  takeId: string;
}

interface Verified {
  afterRelaunch: { attempts: number; hasAttempt: boolean };
  takeAfterRelaunch: { present: boolean; audioBytes: number | null };
  reconcileAfterRelaunch: { orphanFilesRemoved: number; danglingTakes: number; danglingSongs: number };
  afterDelete: { take: unknown; binaryBytes: number };
  afterWipe: { attempts: number; usage: { attemptCount: number; takeCount: number; binaryBytes: number } };
  import: { ok: boolean; profilesAdded: number; attemptsAdded: number; errors: string[] };
  afterImport: { profiles: number; attempts: number };
  secondImport: { ok: boolean; profilesAdded: number; attemptsAdded: number; attemptsSkipped: number };
  afterSecondImport: { attempts: number };
}

describe('the Wave 1 engines in a real Chrome', () => {
  let browser: Browser;
  let server: http.Server;
  let baseUrl: string;

  beforeAll(async () => {
    fs.mkdirSync(OUT_DIR, { recursive: true });
    const entry = path.join(OUT_DIR, 'entry.ts');
    fs.writeFileSync(entry, entrySource());
    await build({
      configFile: false,
      root: ROOT_DIR,
      logLevel: 'silent',
      build: { outDir: OUT_DIR, emptyOutDir: false, minify: false, copyPublicDir: false, lib: { entry, formats: ['es'], fileName: 'wave1' } },
    });
    server = http.createServer((req, res) => {
      const url = (req.url ?? '/').split('?')[0];
      const file = url === '/wave1.js' ? BUNDLE : url === '/checks.js' ? CHECKS : null;
      if (file) {
        res.writeHead(200, { 'content-type': 'text/javascript' });
        res.end(fs.readFileSync(file));
      } else {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end('<!doctype html><title>wave1</title><body>wave1</body>');
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
    browser = await launchChrome();
  }, 120_000);

  afterAll(async () => {
    await browser?.close();
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  });

  it('storage: real IndexedDB and OPFS keep an attempt and a take with audio across a relaunch, delete for real, and restore from a backup', async () => {
    const context = await browser.newContext();
    try {
      const first = await context.newPage();
      await first.goto(baseUrl);
      const seeded = await inPage<Seeded>(first, 'storageSmoke', ['seed']);
      expect(seeded.flags).toEqual({ persistent: true, db: true, opfs: true, kv: true, backend: 'opfs' }); // every layer durable, the files in OPFS proper
      expect(seeded.take.audioRef).toMatch(/^takes\/.+\.wav$/);
      expect(seeded.take.audioBackBytes).toBe(seeded.take.wavBytes);
      expect(seeded.usage).toMatchObject({ attemptCount: 1, takeCount: 1, binaryBytes: seeded.take.wavBytes, binaryBackend: 'opfs' });
      expect(seeded.reconcile).toEqual({ orphanFilesRemoved: 0, danglingTakes: 0, danglingSongs: 0 });

      // A new page of the same browser context is a relaunch of the app against the same databases.
      const second = await context.newPage();
      await second.goto(baseUrl);
      const v = await inPage<Verified>(second, 'storageSmoke', ['verify', seeded]);
      expect(v.afterRelaunch).toEqual({ attempts: 1, hasAttempt: true });
      expect(v.takeAfterRelaunch).toEqual({ present: true, audioBytes: seeded.take.wavBytes });
      expect(v.reconcileAfterRelaunch).toEqual({ orphanFilesRemoved: 0, danglingTakes: 0, danglingSongs: 0 });
      expect(v.afterDelete).toEqual({ take: null, binaryBytes: 0 }); // the record and its file go together
      expect(v.afterWipe.attempts).toBe(0);
      expect(v.afterWipe.usage).toMatchObject({ attemptCount: 0, takeCount: 0, binaryBytes: 0 });
      expect(v.import).toMatchObject({ ok: true, profilesAdded: 1, attemptsAdded: 1, errors: [] });
      expect(v.afterImport).toEqual({ profiles: 1, attempts: 1 });
      expect(v.secondImport).toMatchObject({ ok: true, profilesAdded: 0, attemptsAdded: 0, attemptsSkipped: 1 }); // importing twice adds nothing
      expect(v.afterSecondImport.attempts).toBe(1);
    } finally {
      await context.close();
    }
  });

  it('demos: every Listen demo renders in Chrome\'s Web Audio, audible and unclipped, with every sustained note at its pitch', async () => {
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      await page.goto(baseUrl);
      const r = await inPage<{ exercises: number; variants: number; pitchChecks: number; problems: string[] }>(page, 'demosSmoke');
      expect(r.problems).toEqual([]);
      expect(r.exercises).toBeGreaterThanOrEqual(60);
      expect(r.variants).toBeGreaterThan(r.exercises); // plus the classical-style and the slow-first demos
      expect(r.pitchChecks).toBeGreaterThanOrEqual(100);
    } finally {
      await context.close();
    }
  }, 180_000);
});
