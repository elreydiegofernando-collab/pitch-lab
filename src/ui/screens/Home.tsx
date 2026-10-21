/** Home: the root screen. Launch point for Live, Setup, Settings, Diagnostics and About; the first-run headphone guide lives here too. */
import { useEffect, useState } from 'preact/hooks';
import type { JSX } from 'preact';
import { Gauge, Heart, Mic, Settings as SettingsIcon, SlidersHorizontal, Waves } from 'lucide-preact';
import { navigate } from '../../router';
import { getEngine } from '../../audio/engine';
import { isIOS, isStandalone } from '../../audio/platform';
import { deviceSettings, settingsReady, updateDeviceSettings } from '../../state/settings';
import { Banner } from '../components/Banner';
import { Button } from '../components/Button';
import { Card } from '../components/Card';
import { Sheet } from '../components/Sheet';

function startSingingAndGoLive(): void {
  // Direct, synchronous call inside the gesture (iOS rule, docs/ARCHITECTURE.md). Errors surface
  // through engineState/engineError (mirrored in src/state/engine-store.ts) on the Live screen.
  getEngine()
    .start()
    .catch(() => {});
  navigate('live');
}

function needsSetupAttention(): boolean {
  const d = deviceSettings.value;
  const hasCalibrationForRoute = d.route !== 'unknown' && d.latency[d.route] !== undefined;
  return !d.headphoneGuideSeen || !hasCalibrationForRoute;
}

export function Home(): JSX.Element {
  const [settingsAreReady, setSettingsAreReady] = useState(false);
  const [firstRunDismissed, setFirstRunDismissed] = useState(false);
  const [showAddToHomeScreen] = useState(() => isIOS() && !isStandalone());

  useEffect(() => {
    let active = true;
    void settingsReady.then(() => {
      if (active) setSettingsAreReady(true);
    });
    return () => {
      active = false;
    };
  }, []);

  function dismissFirstRun(): void {
    updateDeviceSettings({ headphoneGuideSeen: true });
    setFirstRunDismissed(true);
  }

  const showFirstRun = settingsAreReady && !deviceSettings.value.headphoneGuideSeen && !firstRunDismissed;

  return (
    <div class="pl-screen" data-testid="home-screen">
      <div class="pl-scroll">
        <div class="pl-page pl-fade-rise pl-safe-top">
          <header class="pl-stack">
            <h1 class="pl-display-l">Pitch Lab</h1>
            <p class="pl-body pl-muted pl-prose">
              Real-time pitch feedback that trains what makes singing sound polished, not just in tune.
            </p>
          </header>

          <Button variant="primary" icon={Mic} block onClick={startSingingAndGoLive}>
            Start singing
          </Button>

          {showAddToHomeScreen ? (
            <Banner kind="info" message="Add Pitch Lab to your Home Screen for full-screen, offline use.">
              <p class="pl-body-s pl-muted">Tap Share, then "Add to Home Screen".</p>
            </Banner>
          ) : null}

          <div class="pl-stack">
            <Card icon={Waves} title="Live pitch" subtitle="Free-sing monitor with the trace" onClick={() => navigate('live')} />
            <Card
              icon={SlidersHorizontal}
              title="Setup & calibration"
              subtitle="Headphones, mic, latency"
              dot={needsSetupAttention()}
              onClick={() => navigate('setup')}
            />
            <Card icon={SettingsIcon} title="Settings" subtitle="Vibrato style, detector, reference sound" onClick={() => navigate('settings')} />
            <Card icon={Gauge} title="Diagnostics" subtitle="Audio path, latency, storage" onClick={() => navigate('diagnostics')} />
            <Card icon={Heart} title="About & voice care" subtitle="Privacy, warm-up, credits" onClick={() => navigate('about')} />
          </div>

          <Card muted chevron={false} title="Training path" subtitle="Levels unlock in the next build" />
        </div>
      </div>

      <Sheet open={showFirstRun} title="Before you start" onClose={dismissFirstRun}>
        <p class="pl-body">
          Wired headphones are recommended: the reference tones won't bleed into the mic while you sing.
        </p>
        <p class="pl-body-s pl-muted">
          Bluetooth and AirPods add about 120-300 ms of delay and their mic is narrowband. Pitch Lab will ask
          you to use the phone or laptop mic even when your headphones are connected.
        </p>
        <p class="pl-body-s pl-muted">
          Warm up before long sessions, and stop if anything feels strained &mdash; this app does not replace medical
          advice.
        </p>
        <div class="pl-row-flex">
          <Button
            variant="ghost"
            onClick={() => {
              dismissFirstRun();
            }}
          >
            Later
          </Button>
          <Button
            variant="primary"
            icon={SlidersHorizontal}
            onClick={() => {
              dismissFirstRun();
              navigate('setup');
            }}
          >
            Set up now
          </Button>
        </div>
      </Sheet>
    </div>
  );
}
