/**
 * Setup: a 5-step stepper for headphones, microphone, a sound check, a timing check (the latency calibration) and tips.
 * In plain words (owner, 2026-10-23: "you're using a lot of technical terms in the app that I don't know"): no "route",
 * "latency", "loopback" or milliseconds; the delay the timing check finds is said as a length of time in words.
 */
import { useEffect, useRef, useState } from 'preact/hooks';
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
import { back } from '../../router';
import { count, durationWords, sentence } from '../../coaching/plain';
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
import { useReleaseMicOnLeave } from '../practice/use-mic-release';

const A3_MIDI = parseNote('A3');
const STEP_NAMES = ['Headphones', 'Microphone', 'Audio check', 'Timing check', 'Tips'] as const;
const ROUTE_OPTIONS = [
  { value: 'wired' as const, label: 'Wired', icon: Headphones },
  { value: 'bluetooth' as const, label: 'Bluetooth', icon: Bluetooth },
  { value: 'speaker' as const, label: 'Speaker', icon: Speaker },
];
/** The calibration methods by what the singer does (the stored value is still 'loopback' for the one that holds the phone close). */
const METHOD_OPTIONS = [
  { value: 'loopback' as const, label: 'Hold close' },
  { value: 'sing' as const, label: 'Sing' },
  { value: 'tap' as const, label: 'Tap' },
];
const METHOD_HINTS: Record<CalibrationMethod, string> = {
  loopback: 'Recommended: hold the phone’s speaker (or one earbud) right up to the microphone and stay quiet.',
  sing: 'Sing a quick “ta” right on each click.',
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
        <Banner kind="warn" message="Bluetooth and AirPods add a short delay, and their microphone is not good for singing.">
          <p class="pl-body-s pl-muted">
            Pitch Lab will still ask you to use your phone’s or laptop’s own microphone: the next step picks it.
          </p>
        </Banner>
      ) : null}
      {isWindows() ? (
        <Banner kind="info" message="On Windows, turn off microphone effects so the app hears your real voice.">
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
      <p class="pl-body">Choose the microphone Pitch Lab should listen to.</p>
      {engineState.value === 'idle' ? (
        <Button variant="primary" icon={Mic} loading={micBusy} onClick={handleGrantMic}>
          Allow microphone access
        </Button>
      ) : null}
      {inputs.length === 0 ? (
        <EmptyState icon={Mic} title="No microphones yet" message="Allow microphone access to see yours." />
      ) : (
        <div class="pl-list">
          {inputs.map((d) => (
            <ListRow
              key={d.deviceId}
              icon={Mic}
              title={d.label || 'Microphone'}
              subtitle={isLikelyBluetoothLabel(d.label) ? 'Bluetooth: not good for singing' : undefined}
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
  const [toneBusy, setToneBusy] = useState(false);
  const [toneError, setToneError] = useState<string | null>(null);
  const pending = useRef<(() => void) | null>(null);

  // Leaving the step (or Setup) while the mic is still opening: stop waiting for it.
  useEffect(() => () => pending.current?.(), []);

  function playTone(): void {
    try {
      getSynth().playNote({ midi: A3_MIDI, duration: 2, timbre: settings.value.referenceTimbre, gain: settings.value.referenceVolume });
    } catch {
      setToneError('Sound could not start. Tap Play a test sound again; if it keeps failing, use Reset audio.');
    }
  }

  /**
   * iOS only sends audio to the earpiece, or ducks it, while the mic is on, so the tone is played with the mic running.
   * A mic that is off opens first thing in this tap (the iOS gesture rule); the tone plays once it runs.
   */
  function handlePlayTestTone(): void {
    pending.current?.();
    pending.current = null;
    setToneError(null);
    setToneBusy(true);
    pending.current = openMicThen(
      getEngine(),
      () => {
        pending.current = null;
        setToneBusy(false);
        playTone();
      },
      (code) => {
        pending.current = null;
        setToneBusy(false);
        setToneError(micProblem(code, 'Play a test sound'));
      },
    );
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
        Play a short sound and tell us where you heard it. While the microphone is on, an iPhone sometimes sends the sound
        to the tiny earpiece, or turns it way down. This check catches that.
      </p>
      {engineState.value !== 'running' ? (
        <p class="pl-body-s pl-muted" data-testid="tone-mic-note">
          Play a test sound turns the microphone on first.
        </p>
      ) : null}
      <Button variant="secondary" icon={Volume2} loading={toneBusy} onClick={handlePlayTestTone}>
        Play a test sound
      </Button>
      {toneError ? <Banner kind="error" message={toneError} /> : null}
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
        <Banner kind="warn" message="The sound went to the wrong place or got very quiet. That is a known iPhone quirk, and Reset audio usually fixes it.">
          <Button variant="secondary" icon={RotateCcw} loading={resetBusy} onClick={handleResetAudio}>
            Reset audio
          </Button>
        </Banner>
      ) : check ? (
        <Banner kind="info" message="Good: the sound is going where it should." />
      ) : null}
    </div>
  );
}

/** The mic's state in a sentence, for a step that could not open it; `retry` names the button to tap again. */
function micProblem(code: string | undefined, retry: string): string {
  switch (code) {
    case 'permission-denied':
      return `Microphone blocked. On iPhone open Settings › Safari › Microphone and choose Allow; in Chrome or Edge allow it from the site icon in the address bar. Then tap ${retry} again.`;
    case 'no-microphone':
      return `No microphone was found. Connect one or pick another input in the Microphone step, then tap ${retry} again.`;
    case 'mic-in-use':
      return `Another app is using the microphone. Close it, then tap ${retry} again.`;
    default:
      return `The microphone did not start. Tap ${retry} again; if it keeps failing, use Reset audio in the Audio check step.`;
  }
}

/**
 * Open the mic for a calibration from inside the tap (the iOS gesture rule), then call `onRunning` once the engine
 * reports 'running' (its worklet wired, so transient detection works), or `onFailed` when it stops trying. Returns a
 * cancel function. A mic that is already running calls `onRunning` at once.
 */
function openMicThen(engine: ReturnType<typeof getEngine>, onRunning: () => void, onFailed: (code: string | undefined) => void): () => void {
  if (engine.state === 'running') {
    onRunning();
    return () => undefined;
  }
  // First thing in the tap: start, or resume (a route change resets inside resume()).
  let opening: Promise<void> | null = null;
  if (engine.state === 'idle' || engine.state === 'error') opening = engine.start();
  else if (engine.state === 'interrupted' || engine.state === 'suspended') opening = engine.resume();
  let done = false;
  const finish = (): void => {
    if (done) return;
    if (engine.state === 'running') {
      done = true;
      off();
      onRunning();
    } else if (engine.state === 'error' || engine.state === 'idle' || engine.state === 'interrupted') {
      done = true;
      off();
      onFailed(engine.error?.code);
    }
  };
  const off = engine.onState(() => finish());
  const settle = (): void => {
    // 'suspended' while the context resumes, or 'starting' while a prompt is up: keep waiting for the next state.
    if (!done && engine.state !== 'starting' && engine.state !== 'suspended') finish();
  };
  opening?.then(settle, settle);
  return () => {
    done = true;
    off();
  };
}

function StepLatency(): JSX.Element {
  const [method, setMethod] = useState<CalibrationMethod>('loopback');
  const [session, setSession] = useState<CalibrationSession | null>(null);
  const [progress, setProgress] = useState<CalibrationProgress | null>(null);
  const [result, setResult] = useState<OffsetEstimate | null>(null);
  const [running, setRunning] = useState(false);
  const [micError, setMicError] = useState<string | null>(null);
  const pending = useRef<(() => void) | null>(null);
  const current = useRef<CalibrationSession | null>(null);

  // Leaving the step (or Setup) mid-run: stop issuing clicks, and stop waiting for the mic.
  useEffect(
    () => () => {
      pending.current?.();
      current.current?.cancel();
    },
    [],
  );

  /** The click train itself: the synth is made here, once the mic (when one is needed) is running. */
  function begin(chosen: CalibrationMethod): void {
    const engine = getEngine();
    let synth: ReturnType<typeof getSynth>;
    try {
      synth = getSynth();
    } catch {
      setRunning(false);
      setMicError('Sound could not start. Tap Run again; if it keeps failing, use Reset audio in the Audio check step.');
      return;
    }
    const next = startCalibration(chosen, { engine, synth });
    current.current = next;
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

  function handleRun(): void {
    pending.current?.();
    pending.current = null;
    current.current?.cancel();
    setMicError(null);
    const chosen = method;
    // Tap needs no mic. Loopback and Sing listen for the clicks on the mic: it opens first thing in this tap, and the
    // synth (which would put the audio session back to playback while the mic is still opening) only once it runs.
    if (chosen === 'tap') {
      begin(chosen);
      return;
    }
    setResult(null);
    setProgress(null);
    setRunning(true);
    pending.current = openMicThen(
      getEngine(),
      () => {
        pending.current = null;
        begin(chosen);
      },
      (code) => {
        pending.current = null;
        setRunning(false);
        setMicError(micProblem(code, 'Run'));
      },
    );
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
        <Banner kind="info" message="Your headphones or speaker changed. It is worth running the timing check again." />
      ) : null}
      <p class="pl-body">
        Your phone takes a moment to play a sound and a moment to hear it. This measures that tiny delay, so songs
        can line up with your voice.
      </p>
      <Segmented aria-label="Timing check method" options={METHOD_OPTIONS} value={method} onChange={setMethod} />
      <p class="pl-body-s pl-muted">{METHOD_HINTS[method]}</p>
      {method !== 'tap' && engineState.value !== 'running' ? (
        <p class="pl-body-s pl-muted" data-testid="calibration-mic-note">
          Run turns the microphone on to hear the clicks.
        </p>
      ) : null}

      <Button variant="primary" loading={running} onClick={handleRun}>
        Run
      </Button>
      {micError ? <Banner kind="error" message={micError} /> : null}

      {progress ? (
        <p class="pl-body-s pl-muted pl-tabular" data-testid="timing-progress">
          Click {progress.clicksPlayed} of {progress.clicksTotal} &middot; heard {progress.eventsDetected}
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
          <span class="pl-display-m" data-testid="timing-delay">
            {sentence(durationWords(result.offsetMs / 1000))}
          </span>
          <span class="pl-body-s pl-muted">
            That is how long your phone takes to play a sound and hear it. Heard {count(result.matched, 'click')}.
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
      <Banner kind="info" message="The Ring/Silent switch won’t mute Pitch Lab, so you will always hear the notes." />
    </div>
  );
}

export function Setup(): JSX.Element {
  const [step, setStep] = useState(1);
  useReleaseMicOnLeave(getEngine());

  const next = (): void => {
    // Step 1 shows Wired selected when no route was ever chosen: going on from it chooses Wired, so what is stored (and
    // what the calibration is filed under, and what takes and song mode treat as headphones) is what was shown.
    if (step === 1 && deviceSettings.value.route === 'unknown') updateDeviceSettings({ route: 'wired' });
    setStep((s) => Math.min(STEP_NAMES.length, s + 1));
  };

  return (
    <div class="pl-screen" data-testid="setup-screen">
      <AppBar title="Setup" routeIcon={SlidersHorizontal} onBack={() => back()} />
      <div class="pl-scroll">
        <div class="pl-page">
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
              <Button variant="primary" onClick={next}>
                Next
              </Button>
            ) : (
              <Button variant="primary" onClick={() => back()}>
                Done
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
