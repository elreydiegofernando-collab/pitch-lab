/** Diagnostics: the audio path, latency, storage and service-worker state, plus three self-check actions. */
import { useEffect, useState } from 'preact/hooks';
import type { JSX } from 'preact';
import { Clipboard, Gauge, Mic, Target } from 'lucide-preact';
import { back } from '../../router';
import { getEngine } from '../../audio/engine';
import { isIOS, isStandalone } from '../../audio/platform';
import { getSynth } from '../../state/audio';
import { engineInfo, engineStats } from '../../state/engine-store';
import { activePitchView } from '../../state/pitch-view-registry';
import { appStorage, reconcileReport, storageDurable } from '../../state/session';
import { deviceSettings, settings } from '../../state/settings';
import { showToast } from '../../state/toast';
import { centsOff, noteName, parseNote } from '../../core/music';
import type { Recording } from '../../audio/engine-types';
import { getStorageInfo, requestPersistentStorage, type StorageInfo } from '../../pwa/persist';
import { swStatus } from '../../state/pwa-store';
import type { StorageUsage } from '../../storage';
import { AppBar } from '../components/AppBar';
import { Banner } from '../components/Banner';
import { Button } from '../components/Button';
import { ListRow } from '../components/ListRow';
import { useReleaseMicOnLeave } from '../practice/use-mic-release';
import { BACKEND_LABEL, describeReconcile } from '../progress/diagnostics-text';
import { formatBytes } from '../progress/format';

const A3_MIDI = parseNote('A3');
const TRACK_FLAGS = ['echoCancellation', 'noiseSuppression', 'autoGainControl'] as const;

function formatMs(seconds: number | null): string {
  return seconds === null ? '––' : `${Math.round(seconds * 1000)} ms`;
}

function formatTriState(value: boolean | null | undefined): string {
  return value === null || value === undefined ? 'Unknown' : value ? 'Yes' : 'No';
}

function playRecording(recording: Recording): void {
  const ctx = getEngine().context;
  if (!ctx) return;
  const buffer = ctx.createBuffer(1, recording.samples.length, recording.sampleRate);
  // Re-wrap into a fresh, concretely-typed Float32Array<ArrayBuffer>: recording.samples may be
  // backed by a transferred/sliced buffer that only structurally satisfies Float32Array<ArrayBufferLike>.
  buffer.copyToChannel(new Float32Array(recording.samples), 0);
  const source = new AudioBufferSourceNode(ctx, { buffer });
  source.connect(ctx.destination);
  source.start();
}

export function Diagnostics(): JSX.Element {
  const info = engineInfo.value;
  const stats = engineStats.value;

  const [storageInfo, setStorageInfo] = useState<StorageInfo | null>(null);
  const [usage, setUsage] = useState<StorageUsage | null>(null);
  const [micCheckBusy, setMicCheckBusy] = useState(false);
  const [selfTestBusy, setSelfTestBusy] = useState(false);
  const [selfTestResult, setSelfTestResult] = useState<string | null>(null);
  const storage = appStorage.value;
  useReleaseMicOnLeave(getEngine());

  useEffect(() => {
    let active = true;
    void getStorageInfo().then((result) => {
      if (active) setStorageInfo(result);
    });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!storage) return undefined;
    let active = true;
    storage
      .usage()
      .then((result) => {
        if (active) setUsage(result);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [storage]);

  function handleRequestPersist(): void {
    void requestPersistentStorage()
      .then(() => getStorageInfo())
      .then((result) => setStorageInfo(result));
  }

  function handleMicCheck(): void {
    const engine = getEngine();
    // Direct call first, per the gesture rule, when the mic isn't already open.
    const ready = engine.state === 'running' ? Promise.resolve() : engine.start();
    setMicCheckBusy(true);
    ready
      .then(() => {
        engine.startRecording();
        return new Promise<void>((resolve) => setTimeout(resolve, 3000));
      })
      .then(() => engine.stopRecording())
      .then((recording) => playRecording(recording))
      .catch(() => {})
      .finally(() => setMicCheckBusy(false));
  }

  function handlePitchSelfTest(): void {
    const synth = getSynth(); // direct call: ensureContext() happens inside this, first thing
    const engine = getEngine();
    const samples: number[] = [];
    const unsubscribe = engine.onFrame((frame) => {
      if (frame.voiced) samples.push(frame.midi);
    });
    synth.playNote({
      midi: A3_MIDI,
      duration: 2,
      timbre: settings.value.referenceTimbre,
      gain: settings.value.referenceVolume,
    });
    setSelfTestBusy(true);
    setSelfTestResult(null);
    setTimeout(() => {
      unsubscribe();
      setSelfTestBusy(false);
      if (samples.length === 0) {
        setSelfTestResult('No pitch detected. Make sure the mic is running (speaker route) and not muted.');
        return;
      }
      const sorted = [...samples].sort((a, b) => a - b);
      const median = sorted[Math.floor(sorted.length / 2)];
      const cents = centsOff(median, A3_MIDI);
      setSelfTestResult(
        `Median ${noteName(median, settings.value.notation)} (${cents >= 0 ? '+' : ''}${cents.toFixed(0)}¢ from A3), ${samples.length} voiced frames.`
      );
    }, 2200);
  }

  async function handleCopyDiagnostics(): Promise<void> {
    const payload = {
      timestamp: new Date().toISOString(),
      engine: info,
      stats,
      storage: storageInfo,
      pitchLabData: { durable: storageDurable.value, usage, reconcile: reconcileReport.value },
      serviceWorker: String(swStatus.value),
      device: {
        route: deviceSettings.value.route,
        inputDeviceId: deviceSettings.value.inputDeviceId,
        sessionCheck: deviceSettings.value.sessionCheck,
        latency: deviceSettings.value.latency,
      },
      settings: settings.value,
      isIOS: isIOS(),
      isStandalone: isStandalone(),
    };
    try {
      await navigator.clipboard.writeText(JSON.stringify(payload, null, 2));
      showToast('Diagnostics copied to clipboard.', { durationMs: 2500 });
    } catch {
      showToast('Could not copy diagnostics.', { durationMs: 2500 });
    }
  }

  const calibrations = Object.entries(deviceSettings.value.latency);
  const reconcile = describeReconcile(reconcileReport.value);

  return (
    <div class="pl-screen" data-testid="diagnostics-screen">
      <AppBar title="Diagnostics" routeIcon={Gauge} engineState={info.state} onBack={() => back()} />
      <div class="pl-scroll">
        <div class="pl-page">
          <div class="pl-list">
            <ListRow title="Sample rate" value={info.sampleRate ? `${info.sampleRate} Hz` : '––'} data-testid="diag-samplerate" />
            <ListRow title="Window / hop" value={`${info.windowSize} / ${info.hopSize ?? '––'}`} />
            <ListRow title="Detector" value={info.detector.toUpperCase()} />
            <ListRow title="Detector cost" value={info.detectorCostMs === null ? '––' : `${info.detectorCostMs.toFixed(2)} ms`} data-testid="diag-detector-cost" />
            <ListRow title="Frames / second" value={stats.framesPerSec.toFixed(1)} data-testid="diag-fps" />
            <ListRow
              title="Render fps"
              value={activePitchView.value ? activePitchView.value.fps.toFixed(0) : '–– (no pitch view mounted)'}
              data-testid="diag-render-fps"
            />
            <ListRow title="Dropped quanta" value={`${stats.droppedQuanta} (max ${stats.maxQuantum})`} />
            <ListRow title="Base / output latency" value={`${formatMs(info.baseLatency)} / ${formatMs(info.outputLatency)}`} />
            <ListRow title="Audio session" value={info.audioSessionType ?? '––'} data-testid="diag-audio-session" />
            <ListRow title="Input device" value={info.inputDeviceLabel ?? '––'} />
            <ListRow title="Platform" value={`${isIOS() ? 'iOS' : 'non-iOS'}${isStandalone() ? ', standalone' : ''}`} />
          </div>

          <section class="pl-stack" data-testid="diag-track-settings">
            <span class="pl-label">Applied track settings</span>
            {TRACK_FLAGS.map((key) => {
              const on = info.trackSettings?.[key] === true;
              return on ? (
                <Banner key={key} kind="warn" message={`${key} came back ON — this can distort pitch and dynamics.`} />
              ) : null;
            })}
            <pre class="pl-body-s pl-muted pl-tabular" style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
              {info.trackSettings ? JSON.stringify(info.trackSettings, null, 2) : 'Not available yet.'}
            </pre>
          </section>

          <div class="pl-list">
            <ListRow title="Storage persisted" value={formatTriState(storageInfo?.persisted)} data-testid="diag-persisted" />
            <ListRow title="Storage used" value={`${formatBytes(storageInfo?.usage)} / ${formatBytes(storageInfo?.quota)}`} />
            <ListRow title="Service worker" value={String(swStatus.value)} data-testid="diag-sw" />
          </div>
          {storageInfo?.persisted !== true ? (
            <Button variant="secondary" onClick={handleRequestPersist}>
              Request persistent storage
            </Button>
          ) : null}

          <section class="pl-stack" data-testid="diag-data">
            <span class="pl-label">Pitch Lab data</span>
            <div class="pl-list">
              <ListRow title="Saved on this device" value={storageDurable.value ? 'Yes' : 'No'} data-testid="diag-durable" />
              <ListRow
                title="Database"
                subtitle={usage?.dbFallbackReason ?? undefined}
                value={usage ? (usage.dbFallbackReason ? 'In memory' : 'IndexedDB') : '––'}
                data-testid="diag-db"
              />
              <ListRow title="Recordings stored in" value={usage ? BACKEND_LABEL[usage.binaryBackend] : '––'} data-testid="diag-binary-backend" />
              <ListRow title="Attempts / recordings" value={usage ? `${usage.attemptCount} / ${usage.takeCount}` : '––'} />
              <ListRow title="Recording audio" value={formatBytes(usage?.binaryBytes)} />
              <ListRow title="Startup check" subtitle={reconcile.detail ?? undefined} value={reconcile.value} data-testid="diag-reconcile" />
            </div>
          </section>

          <section class="pl-stack">
            <span class="pl-label">Calibrations per route</span>
            {calibrations.length === 0 ? (
              <p class="pl-body-s pl-muted">None saved yet — see Setup &rsaquo; Latency calibration.</p>
            ) : (
              <div class="pl-list">
                {calibrations.map(([route, cal]) => (
                  <ListRow
                    key={route}
                    title={route}
                    subtitle={`${cal.method}, saved ${cal.date.slice(0, 10)}`}
                    value={`${Math.round(cal.roundTripMs)} ± ${Math.round(cal.jitterMs)} ms`}
                  />
                ))}
              </div>
            )}
          </section>

          <section class="pl-stack">
            <span class="pl-label">Self-checks</span>
            <Button variant="secondary" icon={Mic} loading={micCheckBusy} onClick={handleMicCheck}>
              Mic check (record 3s, play back)
            </Button>
            <Button variant="secondary" icon={Target} loading={selfTestBusy} onClick={handlePitchSelfTest}>
              Pitch self-test (plays A3, speaker route)
            </Button>
            {selfTestResult ? <p class="pl-body-s pl-muted pl-tabular">{selfTestResult}</p> : null}
            <Button variant="secondary" icon={Clipboard} onClick={handleCopyDiagnostics}>
              Copy diagnostics (JSON, never audio)
            </Button>
          </section>
        </div>
      </div>
    </div>
  );
}
