/** Setup: a 5-step stepper for headphones/route, microphone, an audio-routing check, latency calibration, and tips. */
import { useEffect, useState } from 'preact/hooks';
import type { JSX } from 'preact';
import {
  Bluetooth,
  CircleCheck,
  Headphones,
  Mic,
  RotateCcw,
  SlidersHorizontal,
  Speaker,
  TriangleAlert,
  Volume2,
} from 'lucide-preact';
import { back, navigate } from '../../router';
import { getEngine } from '../../audio/engine';
import { isIOS, isLikelyBluetoothLabel, isStandalone, isWindows } from '../../audio/platform';
import { startCalibration } from '../../audio/latency';
import { getSynth, resetAudio } from '../../state/audio';
import { engineError, engineState } from '../../state/engine-store';
import { deviceSettings, setLatencyCalibration, settings, updateDeviceSettings } from '../../state/settings';
import { parseNote } from '../../core/music';
import type { OutputRoute } from '../../core/types';
import type {
  CalibrationMethod,
  CalibrationProgress,
  CalibrationSession,
  OffsetEstimate,
} from '../../audio/latency-types';
import { AppBar } from '../components/AppBar';
import { Banner } from '../components/Banner';
import { Button } from '../components/Button';
import { EmptyState } from '../components/EmptyState';
import { ListRow } from '../components/ListRow';
import { Segmented } from '../components/Segmented';

const A3_MIDI = parseNote('A3');
const STEP_NAMES = ['Headphones & route', 'Microphone', 'Audio check', 'Latency calibration', 'Tips'] as const;
const ROUTE_OPTIONS = [
  { value: 'wired' as const, label: 'Wired', icon: Headphones },
  { value: 'bluetooth' as const, label: 'Bluetooth', icon: Bluetooth },
  { value: 'speaker' as const, label: 'Speaker', icon: Speaker },
];
const METHOD_OPTIONS = [
  { value: 'loopback' as const, label: 'Loopback' },
  { value: 'sing' as const, label: 'Sing' },
  { value: 'tap' as const, label: 'Tap' },
];
const METHOD_HINTS: Record<CalibrationMethod, string> = {
  loopback: 'Recommended: hold the phone speaker (or one earbud) right at the mic and stay quiet otherwise.',
  sing: 'Sing a quick "ta" right on each click.',
  tap: 'Tap the pad below on each click. Quick, but less accurate than the other two methods.',
};

function StepHeadphones(): JSX.Element {
  const route = deviceSettings.value.route;
  return (
    <div class="pl-stack">
      <p class="pl-body">How will you listen while you sing?</p>
      <Segmented
        aria-label="Audio output route"
        options={ROUTE_OPTIONS}
        value={route === 'unknown' ? 'wired' : route}
        onChange={(v: OutputRoute) => updateDeviceSettings({ route: v })}
      />
      {route === 'bluetooth' ? (
        <Banner kind="warn" message="Bluetooth and AirPods add about 120-300 ms of delay, and their mic is narrowband.">
          <p class="pl-body-s pl-muted">
            Pitch Lab will still ask you to use your phone or laptop's built-in mic — see the next step.
          </p>
        </Banner>
      ) : null}
      {isWindows() ? (
        <Banner kind="info" message="Windows: turn off mic enhancements for accurate pitch.">
          <p class="pl-body-s pl-muted">
            Settings &rsaquo; System &rsaquo; Sound &rsaquo; your mic &rsaquo; Audio enhancements: Off.
            <br />
            Copilot+ PCs: Quick Settings &rsaquo; Studio Effects &rsaquo; Voice Focus: Off.
          </p>
        </Banner>
      ) : null}
    </div>
  );
}

function StepMicrophone(): JSX.Element {
  const [inputs, setInputs] = useState<MediaDeviceInfo[]>([]);
  const [micBusy, setMicBusy] = useState(false);

  useEffect(() => {
    let active = true;
    void getEngine()
      .listInputs()
      .then((list) => {
        if (active) setInputs(list);
      });
    return () => {
      active = false;
    };
  }, [engineState.value]);

  function handleGrantMic(): void {
    const promise = getEngine().start();
    setMicBusy(true);
    promise.catch(() => {}).finally(() => setMicBusy(false));
  }

  function selectInput(deviceId: string): void {
    getEngine().setPreferredInput(deviceId);
    updateDeviceSettings({ inputDeviceId: deviceId });
  }

  return (
    <div class="pl-stack">
      <p class="pl-body">Pick the mic Pitch Lab should listen to.</p>
      {engineState.value === 'idle' ? (
        <Button variant="primary" icon={Mic} loading={micBusy} onClick={handleGrantMic}>
          Allow microphone access
        </Button>
      ) : null}
      {inputs.length === 0 ? (
        <EmptyState icon={Mic} title="No inputs yet" message="Grant microphone access to see your devices." />
      ) : (
        <div class="pl-list">
          {inputs.map((d) => (
            <ListRow
              key={d.deviceId}
              icon={Mic}
              title={d.label || 'Microphone'}
              subtitle={isLikelyBluetoothLabel(d.label) ? 'Bluetooth — narrowband, avoid for singing' : undefined}
              selected={d.deviceId === deviceSettings.value.inputDeviceId}
              onClick={() => selectInput(d.deviceId)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function StepAudioCheck(): JSX.Element {
  const check = deviceSettings.value.sessionCheck;
  const [resetBusy, setResetBusy] = useState(false);

  function playTestTone(): void {
    const synth = getSynth();
    synth.playNote({ midi: A3_MIDI, duration: 2, timbre: settings.value.referenceTimbre, gain: settings.value.referenceVolume });
  }

  function recordCheck(result: 'normal' | 'earpiece' | 'quiet'): void {
    updateDeviceSettings({
      sessionCheck: {
        date: new Date().toISOString(),
        route: deviceSettings.value.route,
        earpiece: result === 'earpiece',
        ducked: result === 'quiet',
        userAgent: navigator.userAgent,
      },
    });
  }

  function handleResetAudio(): void {
    const promise = resetAudio();
    setResetBusy(true);
    promise.catch(() => {}).finally(() => setResetBusy(false));
  }

  const problem = check && (check.earpiece || check.ducked);

  return (
    <div class="pl-stack">
      <p class="pl-body">
        With the mic running, play a short tone and tell us where you actually heard it. This catches iOS
        routing audio to the earpiece or ducking its volume.
      </p>
      {engineState.value !== 'running' ? (
        <Banner kind="info" message="Start the mic first (Microphone step, or the Sing button on Live) so the audio session is active." />
      ) : null}
      <Button variant="secondary" icon={Volume2} onClick={playTestTone} disabled={engineState.value !== 'running'}>
        Play test tone (2s)
      </Button>
      <span class="pl-label">Where did you hear it?</span>
      <div class="pl-stack">
        <Button variant="secondary" block onClick={() => recordCheck('normal')}>
          Headphones/speaker, normal volume
        </Button>
        <Button variant="secondary" block onClick={() => recordCheck('earpiece')}>
          The earpiece (quiet, tinny)
        </Button>
        <Button variant="secondary" block onClick={() => recordCheck('quiet')}>
          Much quieter than expected
        </Button>
      </div>
      {problem ? (
        <Banner kind="warn" message="Audio got routed or ducked unexpectedly — a known iOS/WebKit quirk.">
          <Button variant="secondary" icon={RotateCcw} loading={resetBusy} onClick={handleResetAudio}>
            Reset audio
          </Button>
        </Banner>
      ) : check ? (
        <Banner kind="info" message="Good — audio is routing normally." />
      ) : null}
    </div>
  );
}

function StepLatency(): JSX.Element {
  const [method, setMethod] = useState<CalibrationMethod>('loopback');
  const [session, setSession] = useState<CalibrationSession | null>(null);
  const [progress, setProgress] = useState<CalibrationProgress | null>(null);
  const [result, setResult] = useState<OffsetEstimate | null>(null);
  const [running, setRunning] = useState(false);

  function handleRun(): void {
    const engine = getEngine();
    const synth = getSynth();
    const next = startCalibration(method, { engine, synth });
    setSession(next);
    setProgress(null);
    setResult(null);
    setRunning(true);
    const unsubscribe = next.onProgress(setProgress);
    next.result
      .then(setResult)
      .catch(() => {})
      .finally(() => {
        setRunning(false);
        unsubscribe();
      });
  }

  function handleSave(): void {
    if (!result) return;
    setLatencyCalibration(deviceSettings.value.route, {
      route: deviceSettings.value.route,
      method,
      roundTripMs: result.offsetMs,
      jitterMs: result.jitterMs,
      matched: result.matched,
      date: new Date().toISOString(),
    });
  }

  return (
    <div class="pl-stack">
      {engineError.value?.code === 'route-changed' ? (
        <Banner kind="info" message="Your audio route changed. Recalibrating latency for the new route is a good idea." />
      ) : null}
      <p class="pl-body">
        This measures the round trip from a scheduled sound to its arrival on the mic, so song mode can line
        your voice up with the music.
      </p>
      <Segmented aria-label="Calibration method" options={METHOD_OPTIONS} value={method} onChange={setMethod} />
      <p class="pl-body-s pl-muted">{METHOD_HINTS[method]}</p>

      <Button variant="primary" loading={running} onClick={handleRun}>
        Run
      </Button>

      {progress ? (
        <p class="pl-body-s pl-muted pl-tabular">
          {progress.clicksPlayed}/{progress.clicksTotal} clicks &middot; {progress.eventsDetected} detected
        </p>
      ) : null}

      {method === 'tap' && session && running ? (
        <button
          type="button"
          class="pl-tap-pad"
          onPointerDown={(e) => session.tap(e.timeStamp)}
          aria-label="Tap along with the clicks"
        >
          Tap here on each click
        </button>
      ) : null}

      {result ? (
        <div class="pl-card">
          <span class="pl-label">Result</span>
          <span class="pl-readout-l pl-tabular">{Math.round(result.offsetMs)} ms</span>
          <span class="pl-body-s pl-muted pl-tabular">
            &plusmn;{Math.round(result.jitterMs)} ms jitter &middot; {result.matched} matched
          </span>
          <div class="pl-row-flex">
            <span class="pl-body-s" style={{ display: 'flex', alignItems: 'center', gap: '4px', color: result.ok ? 'var(--on)' : 'var(--off)' }}>
              {result.ok ? <CircleCheck size={18} aria-hidden="true" /> : <TriangleAlert size={18} aria-hidden="true" />}
              {result.ok ? 'Good' : 'Not reliable yet'}
            </span>
            <Button variant="secondary" onClick={handleRun}>
              Retry
            </Button>
          </div>
          <Button variant="primary" block disabled={!result.ok} onClick={handleSave}>
            Save
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function StepTips(): JSX.Element {
  const wakeLockSupported = typeof navigator !== 'undefined' && 'wakeLock' in navigator;
  return (
    <div class="pl-stack">
      {wakeLockSupported ? (
        <Banner kind="info" message="Pitch Lab keeps the screen awake automatically while you're singing." />
      ) : (
        <Banner kind="info" message="For long sessions, turn off Auto-Lock: Settings › Display & Brightness › Auto-Lock › Never." />
      )}
      {isIOS() && !isStandalone() ? (
        <Banner kind="info" message="Add Pitch Lab to your Home Screen (Share › Add to Home Screen) for full-screen, offline use." />
      ) : null}
      <Banner kind="info" message="The Ring/Silent switch won't mute Pitch Lab — audio is routed for playback and recording." />
    </div>
  );
}

export function Setup(): JSX.Element {
  const [step, setStep] = useState(1);

  return (
    <div class="pl-screen" data-testid="setup-screen">
      <AppBar title="Setup" routeIcon={SlidersHorizontal} onBack={() => back()} />
      <div class="pl-scroll">
        <div class="pl-page pl-fade-rise">
          <span class="pl-label">
            Step {step} of {STEP_NAMES.length}: {STEP_NAMES[step - 1]}
          </span>

          {step === 1 ? <StepHeadphones /> : null}
          {step === 2 ? <StepMicrophone /> : null}
          {step === 3 ? <StepAudioCheck /> : null}
          {step === 4 ? <StepLatency /> : null}
          {step === 5 ? <StepTips /> : null}

          <div class="pl-row-flex">
            <Button variant="ghost" disabled={step === 1} onClick={() => setStep((s) => Math.max(1, s - 1))}>
              Back
            </Button>
            {step < STEP_NAMES.length ? (
              <Button variant="primary" onClick={() => setStep((s) => Math.min(STEP_NAMES.length, s + 1))}>
                Next
              </Button>
            ) : (
              <Button variant="primary" onClick={() => navigate('home')}>
                Done
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
