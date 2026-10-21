/**
 * Fixed constants shared by every e2e module: the preview server's address,
 * the fixture paths, and how to find a real Chrome. Kept in one file so the
 * global setup (which starts the server) and the test files (which only
 * consume its URL) never need to pass data between processes.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Repo root (one level up from e2e/). */
export const ROOT_DIR = path.resolve(HERE, '..');

/** Must match vite.config.ts BASE. */
export const BASE_PATH = '/pitch-lab/';

/** Fixed so --strictPort fails fast instead of silently drifting to another port. */
export const PREVIEW_PORT = 4173;

export const PREVIEW_URL = `http://localhost:${PREVIEW_PORT}${BASE_PATH}`;

export const ARTIFACTS_DIR = path.join(HERE, '.artifacts');

export const TONE_WAV_PATH = path.join(ARTIFACTS_DIR, 'tone-a3-220hz.wav');
export const VIBRATO_WAV_PATH = path.join(ARTIFACTS_DIR, 'vibrato-330hz.wav');

/** Fallback path when the `chrome` channel isn't resolvable (e.g. a fresh machine image). */
export const CHROME_EXECUTABLE_WIN = 'C:/Program Files/Google/Chrome/Application/chrome.exe';

/** Generous: covers `npm run build` plus starting vite preview on a cold cache. */
export const SERVER_READY_TIMEOUT_MS = 90_000;
