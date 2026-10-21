/** Builds the production app and runs/waits-on/stops `vite preview` for the e2e suite. */
import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { PREVIEW_PORT, PREVIEW_URL, ROOT_DIR, SERVER_READY_TIMEOUT_MS } from './config';

/** Runs `npm run build`; throws with the failing exit code if it doesn't succeed. */
export function buildApp(): void {
  const result = spawnSync('npm', ['run', 'build'], {
    cwd: ROOT_DIR,
    shell: true,
    stdio: 'inherit',
  });
  if (result.status !== 0) {
    const reason = result.error ? result.error.message : `exit code ${result.status ?? `signal ${result.signal}`}`;
    throw new Error(`"npm run build" failed (${reason}). See build output above.`);
  }
}

/** Starts `vite preview` on the fixed port. Caller must await `waitForServerReady()` before using it. */
export function startPreviewServer(): ChildProcess {
  const child = spawn('npx', ['vite', 'preview', '--port', String(PREVIEW_PORT), '--strictPort'], {
    cwd: ROOT_DIR,
    shell: true,
    stdio: 'inherit',
  });
  child.on('error', (err) => {
    console.error('[e2e] "vite preview" could not be started:', err);
  });
  return child;
}

/** Polls `PREVIEW_URL` until it answers, or throws after SERVER_READY_TIMEOUT_MS. */
export async function waitForServerReady(): Promise<void> {
  const deadline = Date.now() + SERVER_READY_TIMEOUT_MS;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(PREVIEW_URL);
      if (res.ok) return;
      lastError = new Error(`unexpected status ${res.status}`);
    } catch (err) {
      lastError = err;
    }
    await delay(300);
  }
  throw new Error(`"vite preview" never answered at ${PREVIEW_URL} within ${SERVER_READY_TIMEOUT_MS}ms: ${String(lastError)}`);
}

/** Stops a server started by `startPreviewServer()`. */
export function stopPreviewServer(child: ChildProcess): void {
  if (child.pid == null || child.exitCode != null) return;
  if (process.platform === 'win32') {
    // `shell: true` wraps the process in a cmd.exe host; killing only that
    // parent orphans the node/esbuild process still holding the port, so the
    // next run's --strictPort bind fails. /t kills the whole process tree.
    try {
      execFileSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore' });
    } catch {
      // Best-effort: nothing more to do if the process already exited.
    }
  } else {
    child.kill('SIGTERM');
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
