/**
 * Service-worker registration. vite.config.ts configures vite-plugin-pwa with
 * `injectRegister: false`, so nothing registers the generated service worker
 * except this module, and `registerType: 'prompt'`, so the UI (not the plugin)
 * decides when to show "update available" and when to actually activate it.
 */
import type { Unsubscribe } from '../audio/engine-types';

/** Mirrors the service worker's lifecycle for the Diagnostics screen (docs/PHASES.md Phase 1). */
export type SwStatus = 'unsupported' | 'none' | 'installing' | 'waiting' | 'active';

let status: SwStatus = 'none';
const statusListeners = new Set<(status: SwStatus) => void>();

/** Current, synchronous snapshot — for reading the state once (e.g. a signal store's initial value). */
export function getSwStatus(): SwStatus {
  return status;
}

/**
 * Subscribes to every lifecycle transition (c.f. `AudioEngine.onState` in
 * `src/audio/engine.ts`). Fires only on an actual change, never immediately on
 * subscribe, so callers that need the current value too should read
 * `getSwStatus()` before subscribing.
 */
export function onStatusChange(listener: (status: SwStatus) => void): Unsubscribe {
  statusListeners.add(listener);
  return () => statusListeners.delete(listener);
}

function setStatus(next: SwStatus): void {
  if (status === next) return;
  status = next;
  for (const listener of statusListeners) listener(status);
}

export interface RegisterHandlers {
  /**
   * A new version finished precaching and is waiting to activate. Call `update()`
   * (typically from the user tapping "Update" in a toast) to activate it; the page
   * will then reload under the new service worker.
   */
  onNeedRefresh: (update: () => Promise<void>) => void;
  /** Everything needed to run offline has been cached for the first time. */
  onOfflineReady?: () => void;
}

/**
 * True under Vitest, where no bundler ever puts vite-plugin-pwa in the pipeline
 * (see vitest.config.ts), so 'virtual:pwa-register' would never resolve. Vite
 * exposes the test runner's `VITEST=true` through `import.meta.env` (verified
 * against this toolchain); in a real production bundle `VITEST` is simply
 * absent from the inlined env object, so this reads `undefined`, not throws.
 */
function isTestEnv(): boolean {
  return import.meta.env.VITEST === 'true';
}

/**
 * Registers the generated service worker and wires vite-plugin-pwa's
 * prompt-to-update flow to `handlers`. Safe to call unconditionally at startup:
 * it no-ops when service workers are unsupported or under test, and the dynamic
 * import means a missing 'virtual:pwa-register' (dev server with no plugin, or
 * any other environment that never saw vite-plugin-pwa) fails into the same
 * no-op rather than throwing at module load.
 */
export function registerServiceWorker(handlers: RegisterHandlers): void {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator) || isTestEnv()) {
    setStatus('unsupported');
    return;
  }
  setStatus('installing');
  import('virtual:pwa-register')
    .then(({ registerSW }) => {
      const updateSW = registerSW({
        immediate: true,
        onNeedRefresh() {
          setStatus('waiting');
          handlers.onNeedRefresh(async () => {
            await updateSW(true);
            setStatus('active');
          });
        },
        onOfflineReady() {
          if (status !== 'waiting') setStatus('active');
          handlers.onOfflineReady?.();
        },
        onRegisterError(err: unknown) {
          setStatus('unsupported');
          console.error('[pwa] service worker registration failed', err);
        },
      });
    })
    .catch((err: unknown) => {
      setStatus('unsupported');
      console.error('[pwa] virtual:pwa-register unavailable', err);
    });
}
