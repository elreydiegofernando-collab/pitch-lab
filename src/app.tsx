/**
 * App: applies the theme, switches screens on route change (200ms fade/rise,
 * none under reduced motion — see styles/base.css), mounts the global toast
 * region for service-worker updates, requests persistent storage after the
 * first successful engine start, and shows a break reminder after
 * CONFIG.health.breakReminderMin of actual singing time.
 */
import { useEffect, useRef, useState } from 'preact/hooks';
import type { JSX } from 'preact';
import { bindDesktopBackKey, route } from './router';
import { initTheme } from './state/theme';
import { settingsReady, storagePersistent } from './state/settings';
import { engineState } from './state/engine-store';
import { showToast } from './state/toast';
import { registerServiceWorker } from './pwa/register-sw';
import { requestPersistentStorage } from './pwa/persist';
import { CONFIG } from './config';
import { Banner } from './ui/components/Banner';
import { ToastRegion } from './ui/components/Toast';
import { About } from './ui/screens/About';
import { Diagnostics } from './ui/screens/Diagnostics';
import { Home } from './ui/screens/Home';
import { Live } from './ui/screens/Live';
import { Settings } from './ui/screens/Settings';
import { Setup } from './ui/screens/Setup';

function CurrentScreen(): JSX.Element {
  const name = route.value.name;
  switch (name) {
    case 'home':
      return <Home />;
    case 'live':
      return <Live />;
    case 'setup':
      return <Setup />;
    case 'settings':
      return <Settings />;
    case 'diagnostics':
      return <Diagnostics />;
    case 'about':
      return <About />;
    default: {
      const exhaustive: never = name;
      throw new Error(`Unknown route: ${String(exhaustive)}`);
    }
  }
}

/** Module-scope, not component state: the request must fire exactly once per app lifetime, not once per mount. */
let persistentStorageRequested = false;

const BREAK_REMINDER_MS = CONFIG.health.breakReminderMin * 60 * 1000;

export function App(): JSX.Element {
  const [settingsAreReady, setSettingsAreReady] = useState(false);
  const [storageWarningDismissed, setStorageWarningDismissed] = useState(false);
  const [showBreakReminder, setShowBreakReminder] = useState(false);

  const runningSince = useRef<number | null>(null);
  const accumulatedRunningMs = useRef(0);

  useEffect(() => {
    initTheme();
    bindDesktopBackKey();
    registerServiceWorker({
      onNeedRefresh: (update) => {
        showToast('Update ready.', { actionLabel: 'Reload', onAction: () => void update() });
      },
      onOfflineReady: () => {
        showToast('Pitch Lab is ready to work offline.', { durationMs: 3000 });
      },
    });
  }, []);

  useEffect(() => {
    let active = true;
    void settingsReady.then(() => {
      if (active) setSettingsAreReady(true);
    });
    return () => {
      active = false;
    };
  }, []);

  // Persistent storage: once, right after the first successful engine start (a real user gesture already happened).
  useEffect(() => {
    if (engineState.value === 'running' && !persistentStorageRequested) {
      persistentStorageRequested = true;
      void requestPersistentStorage();
    }
  }, [engineState.value]);

  // Break reminder: accumulate actual running time (paused while stopped), independent of wall-clock since mount.
  useEffect(() => {
    if (engineState.value === 'running') {
      if (runningSince.current === null) runningSince.current = Date.now();
    } else if (runningSince.current !== null) {
      accumulatedRunningMs.current += Date.now() - runningSince.current;
      runningSince.current = null;
    }
  }, [engineState.value]);

  useEffect(() => {
    const id = setInterval(() => {
      const extra = runningSince.current !== null ? Date.now() - runningSince.current : 0;
      if (accumulatedRunningMs.current + extra >= BREAK_REMINDER_MS) {
        setShowBreakReminder(true);
      }
    }, 10_000);
    return () => clearInterval(id);
  }, []);

  function dismissBreakReminder(): void {
    setShowBreakReminder(false);
    accumulatedRunningMs.current = 0;
    runningSince.current = engineState.value === 'running' ? Date.now() : null;
  }

  return (
    <>
      {settingsAreReady && !storagePersistent.value && !storageWarningDismissed ? (
        <Banner
          kind="warn"
          message="This browser would not grant persistent storage — your settings and calibration may not survive."
          actionLabel="Dismiss"
          onAction={() => setStorageWarningDismissed(true)}
        />
      ) : null}

      {showBreakReminder ? (
        <Banner
          kind="info"
          message={`You've been singing for a while. A short break helps your voice.`}
          actionLabel="Dismiss"
          onAction={dismissBreakReminder}
        />
      ) : null}

      <div key={route.value.name} class="pl-fade-rise" style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
        <CurrentScreen />
      </div>

      <ToastRegion />
    </>
  );
}
