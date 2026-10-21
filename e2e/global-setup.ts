/**
 * Vitest `globalSetup` for the e2e config: write the WAV fixtures, build the
 * production app, start `vite preview` on the fixed port, and wait for it —
 * once for the whole run (test files just read PREVIEW_URL from config.ts).
 * Exporting `setup`/`teardown` is the documented contract for a globalSetup
 * module (see vitest's loadGlobalSetupFiles).
 */
import type { ChildProcess } from 'node:child_process';
import { PREVIEW_URL } from './config';
import { writeFixtures } from './fixtures';
import { buildApp, startPreviewServer, stopPreviewServer, waitForServerReady } from './preview-server';

let serverProcess: ChildProcess | null = null;

export async function setup(): Promise<void> {
  console.log('[e2e] writing fake-mic WAV fixtures...');
  writeFixtures();

  console.log('[e2e] building the app ("npm run build")...');
  buildApp();

  console.log(`[e2e] starting "vite preview" and waiting for ${PREVIEW_URL} ...`);
  serverProcess = startPreviewServer();
  await waitForServerReady();
  console.log('[e2e] preview server is ready.');
}

export async function teardown(): Promise<void> {
  if (serverProcess) {
    stopPreviewServer(serverProcess);
    serverProcess = null;
  }
}
