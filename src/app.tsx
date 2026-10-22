/**
 * App: applies the theme, boots the session (storage, active profile, progress, the route guard) without holding
 * anything up (Home shows the boot and failed states; utilities work throughout), switches screens on route change
 * (200ms fade/rise, none under reduced motion — see styles/base.css; each screen opens at its top), mounts the global toast region
 * (service-worker updates, refused navigations), writes pending settings when the page is hidden, requests
 * persistent storage after the first successful engine start, and shows a break reminder after
 * CONFIG.health.breakReminderMin of actual singing time.
 *
 * Wave 2: the route switch below is the contract's screen table (docs/ARCHITECTURE.md "Wave 2"); the runtime
 * builder owns the rest of this file.
 */
import { useEffect, useRef, useState } from 'preact/hooks';
import type { JSX } from 'preact';
import { bindDesktopBackKey, refusal, route } from './router';
import { initTheme } from './state/theme';
import { bootSession, storageDurable } from './state/session';
import { flushSettings } from './state/settings';
import { engineState } from './state/engine-store';
import { showToast } from './state/toast';
import { registerServiceWorker } from './pwa/register-sw';
import { requestPersistentStorage } from './pwa/persist';
import { CONFIG } from './config';
import { Banner } from './ui/components/Banner';
import { ToastRegion } from './ui/components/Toast';
import { About } from './ui/screens/About';
import { Audition } from './ui/screens/Audition';
import { Dashboard } from './ui/screens/Dashboard';
import { Data } from './ui/screens/Data';
import { Diagnostics } from './ui/screens/Diagnostics';
import { Home } from './ui/screens/Home';
import { Level } from './ui/screens/Level';
import { Live } from './ui/screens/Live';
import { Map } from './ui/screens/Map';
import { Profiles } from './ui/screens/Profiles';
import { Report } from './ui/screens/Report';
import { Settings } from './ui/screens/Settings';
import { Setup } from './ui/screens/Setup';
import { Sing } from './ui/screens/Sing';
import { SongImport } from './ui/screens/SongImport';
import { SongPlayer } from './ui/screens/SongPlayer';
import { Songs } from './ui/screens/Songs';
import { VibratoMeter } from './ui/screens/VibratoMeter';
import { Workout } from './ui/screens/Workout';

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
    case 'profiles':
      return <Profiles />;
    case 'data':
      return <Data />;
    case 'map':
      return <Map />;
    case 'level':
      return <Level />;
    case 'sing':
      return <Sing />;
    case 'report':
      return <Report />;
    case 'audition':
      return <Audition />;
    case 'vibrato-meter':
      return <VibratoMeter />;
    case 'dashboard':
      return <Dashboard />;
    case 'workout':
      return <Workout />;
    case 'songs':
      return <Songs />;
    case 'song-import':
      return <SongImport />;
    case 'song':
      return <SongPlayer />;
    default: {
      const exhaustive: never = name;
      throw new Error(`Unknown route: ${String(exhaustive)}`);
    }
  }
}

/** A stable key per screen instance: a new level, target or song remounts the screen. */
function screenKey(): string {
  const r = route.value;
  return `${r.name}:${JSON.stringify(r.params)}`;
}

/**
 * A new screen opens at its top. The document is what scrolls, so without this a screen would open at the scroll
 * offset of the one before it (tap Settings at the bottom of Home, land halfway down Settings). It runs as the screen's
 * wrapper mounts, before any effect of the screen, so a screen that scrolls itself on open (the map) still does.
 */
function openAtTop(el: HTMLDivElement | null): void {
  if (el && typeof window !== 'undefined') window.scrollTo(0, 0);
}

/** Module-scope, not component state: the request must fire exactly once per app lifetime, not once per mount. */
let persistentStorageRequested = false;

const BREAK_REMINDER_MS = CONFIG.health.breakReminderMin * 60 * 1000;

export function App(): JSX.Element {
  const [showBreakReminder, setShowBreakReminder] = useState(false);

  const runningSince = useRef<number | null>(null);
  const accumulatedRunningMs = useRef(0);

  useEffect(() => {
    initTheme();
    bindDesktopBackKey();
    void bootSession();
    // iOS can kill a backgrounded home-screen app: a setting changed just before leaving is written on the way out.
    const flushWhenHidden = (): void => {
      if (document.visibilityState === 'hidden') void flushSettings();
    };
    const flushOnPageHide = (): void => void flushSettings();
    document.addEventListener('visibilitychange', flushWhenHidden);
    window.addEventListener('pagehide', flushOnPageHide);
    registerServiceWorker({
      onNeedRefresh: (update) => {
        showToast('Update ready.', { actionLabel: 'Reload', onAction: () => void update() });
      },
      onOfflineReady: () => {
        showToast('Pitch Lab is ready to work offline.', { durationMs: 3000 });
      },
    });
    return () => {
      document.removeEventListener('visibilitychange', flushWhenHidden);
      window.removeEventListener('pagehide', flushOnPageHide);
    };
  }, []);

  // A refused navigation (a locked item, SPEC §11.1): say what unlocks it.
  useEffect(() => {
    const r = refusal.value;
    if (r) showToast(r.hint, { durationMs: 4000 });
  }, [refusal.value]);

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
      {!storageDurable.value ? (
        // Not dismissable (ARCHITECTURE "Wave 2 must-dos"): on this launch nothing will survive a reload.
        <Banner kind="warn" message="This browser is not saving your data on this visit. Progress and takes will be lost when you close Pitch Lab." />
      ) : null}

      {showBreakReminder ? (
        <Banner
          kind="info"
          message={`You've been singing for a while. A short break helps your voice.`}
          actionLabel="Dismiss"
          onAction={dismissBreakReminder}
        />
      ) : null}

      <div key={screenKey()} ref={openAtTop} class="pl-fade-rise" style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
        <CurrentScreen />
      </div>

      <ToastRegion />
    </>
  );
}
