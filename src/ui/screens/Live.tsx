/** Live: the free-sing pitch monitor. AppBar + readouts + the pitch trace + the thumb-zone action bar. */
import { useEffect, useRef, useState } from 'preact/hooks';
import type { JSX } from 'preact';
import { RotateCcw, SlidersHorizontal, Waves } from 'lucide-preact';
import { back, navigate } from '../../router';
import { getEngine } from '../../audio/engine';
import { isLikelyBluetoothLabel } from '../../audio/platform';
import { getSynth, resetAudio } from '../../state/audio';
import { engineError, engineInfo, engineState } from '../../state/engine-store';
import { activePitchView } from '../../state/pitch-view-registry';
import { settings } from '../../state/settings';
import { CONFIG } from '../../config';
import { noteName, octaveOf, parseNote, type Notation } from '../../core/music';
import type { TargetNote } from '../../core/types';
import type { EngineError, EngineErrorCode } from '../../audio/engine-types';
import { PitchViewHost } from '../pitch-view/PitchViewHost';
import { AppBar } from '../components/AppBar';
import { Banner } from '../components/Banner';
import { BottomBar } from '../components/BottomBar';
import { Button } from '../components/Button';
import { ListRow } from '../components/ListRow';
import { ReadoutCluster } from '../components/ReadoutCluster';
import { Sheet } from '../components/Sheet';

const NOTE_LOW = parseNote('E2');
const NOTE_HIGH = parseNote('C6');
const A3_MIDI = parseNote('A3');

function reasonMessage(error: EngineError | null): string {
  const byCode: Partial<Record<EngineErrorCode, string>> = {
    'permission-denied': 'Microphone access was blocked.',
    'mic-ended': 'The microphone stopped — this can happen after a while in the background on iOS.',
    'route-changed': 'Your audio route changed (headphones plugged in or out).',
    'session-interrupted': 'The audio session was interrupted — a call, Siri, or the lock screen.',
    'no-microphone': 'No microphone was found.',
    'mic-in-use': 'The microphone is being used by another app.',
    'insecure-context': 'This page needs HTTPS to use the microphone.',
    'no-mediadevices': 'This browser cannot access the microphone.',
    'worklet-unsupported': "This browser doesn't support the audio processing Pitch Lab needs.",
  };
  if (!error) return 'The microphone connection was lost.';
  return byCode[error.code] ?? error.message;
}

interface NotePickerProps {
  value: number | null;
  defaultNear: number;
  notation: Notation;
  onSelect: (midi: number) => void;
}

function NotePicker(props: NotePickerProps): JSX.Element {
  const { value, defaultNear, notation, onSelect } = props;
  const containerRef = useRef<HTMLDivElement>(null);

  const octaves: number[][] = [];
  for (let m = NOTE_LOW; m <= NOTE_HIGH; m++) {
    const oct = octaveOf(m);
    const bucket = octaves[octaves.length - 1];
    if (bucket && octaveOf(bucket[0]) === oct) bucket.push(m);
    else octaves.push([m]);
  }

  useEffect(() => {
    const target = value ?? defaultNear;
    const el = containerRef.current?.querySelector<HTMLElement>(`[data-midi="${target}"]`);
    el?.scrollIntoView({ block: 'nearest', inline: 'center' });
    // Intentionally run once on mount (sheet open), not on every selection.
  }, []);

  return (
    <div class="pl-stack" ref={containerRef}>
      {octaves.map((notes) => (
        <div class="pl-note-octave" key={notes[0]}>
          <span class="pl-label">Octave {octaveOf(notes[0])}</span>
          <div class="pl-note-row">
            {notes.map((m) => (
              <button
                key={m}
                type="button"
                class="pl-note-pill"
                data-midi={m}
                aria-pressed={m === value}
                onClick={() => onSelect(m)}
              >
                {noteName(m, notation, false)}
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

export function Live(): JSX.Element {
  const engine = getEngine();
  const [targetMidi, setTargetMidi] = useState<number | null>(null);
  const [moreOpen, setMoreOpen] = useState(false);
  const [singBusy, setSingBusy] = useState(false);
  const [resetBusy, setResetBusy] = useState(false);
  const lastSungMidiRef = useRef<number>(A3_MIDI);

  // Track the last voiced pitch purely for the note picker's default position — a ref write, no re-render.
  useEffect(() => {
    return engine.onFrame((frame) => {
      if (frame.voiced) lastSungMidiRef.current = Math.round(frame.midi);
    });
  }, [engine]);

  function handleListen(): void {
    // Direct call inside the gesture: getSynth() calls engine.ensureContext() as its first statement.
    const synth = getSynth();
    synth.playNote({
      midi: targetMidi ?? A3_MIDI,
      duration: 1.4,
      timbre: settings.value.referenceTimbre,
      gain: settings.value.referenceVolume,
    });
  }

  function handleToggleSing(): void {
    const promise = engineState.value === 'running' ? engine.stop() : engine.start();
    setSingBusy(true);
    promise.catch(() => {}).finally(() => setSingBusy(false));
  }

  function handleReconnect(): void {
    const promise = engineError.value?.code === 'route-changed' ? engine.reset() : engine.resume();
    promise.catch(() => {});
  }

  function handleResetAudio(): void {
    const promise = resetAudio();
    setResetBusy(true);
    promise.catch(() => {}).finally(() => setResetBusy(false));
  }

  const targets: readonly TargetNote[] | undefined =
    targetMidi === null ? undefined : [{ midi: targetMidi, start: -1e9, end: 1e9 }];

  const needsReconnect = engineState.value === 'interrupted' || engineState.value === 'error';

  return (
    <div class="pl-screen" data-testid="live-screen">
      <AppBar title="Live" routeIcon={Waves} engineState={engineState.value} onBack={() => back()} />

      <div class="pl-live-body">
        <div class="pl-live-body__readouts pl-safe-x">
          <ReadoutCluster engine={engine} toleranceCents={CONFIG.tolerance.default} notation={settings.value.notation} />

          {needsReconnect ? (
            <Banner kind={engineState.value === 'error' ? 'error' : 'warn'} message={reasonMessage(engineError.value)}>
              {engineError.value?.code === 'permission-denied' ? (
                <p class="pl-body-s pl-muted">
                  iPhone: Settings &rsaquo; Safari &rsaquo; Microphone (or the "aA" menu &rsaquo; Website Settings).
                  <br />
                  Chrome: tap the site-info icon in the address bar &rsaquo; Site settings &rsaquo; Microphone &rsaquo; Allow.
                </p>
              ) : null}
              <Button variant="primary" block onClick={handleReconnect}>
                Tap to reconnect
              </Button>
            </Banner>
          ) : null}

          {isLikelyBluetoothLabel(engineInfo.value.inputDeviceLabel ?? '') ? (
            <Banner kind="warn" message="Bluetooth mic detected: use the phone or laptop mic for accurate pitch." />
          ) : null}
        </div>

        <div class="pl-live-body__canvas">
          <PitchViewHost
            engine={engine}
            targets={targets}
            targetOrigin={0}
            toleranceCents={CONFIG.tolerance.default}
            options={{
              notation: settings.value.notation,
              reducedMotion: settings.value.reducedMotion === 'on',
              showNoteNames: settings.value.showNoteNames,
            }}
            onView={(v) => {
              activePitchView.value = v;
            }}
          />
        </div>

        <div class="pl-live-body__bottombar">
          <BottomBar
            onListen={handleListen}
            onToggleSing={handleToggleSing}
            singing={engineState.value === 'running'}
            singBusy={singBusy || engineState.value === 'starting'}
            onMore={() => setMoreOpen(true)}
          />
        </div>
      </div>

      <Sheet open={moreOpen} title="More" onClose={() => setMoreOpen(false)}>
        <div class="pl-stack">
          <span class="pl-label">Target note</span>
          <NotePicker
            value={targetMidi}
            defaultNear={lastSungMidiRef.current}
            notation={settings.value.notation}
            onSelect={setTargetMidi}
          />
          <Button variant="ghost" disabled={targetMidi === null} onClick={() => setTargetMidi(null)}>
            Clear target
          </Button>
        </div>

        <div class="pl-list">
          <ListRow title="Tolerance" value={`±${CONFIG.tolerance.default}¢ (default)`} />
        </div>
        <p class="pl-body-s pl-muted">Tolerance is set by the level you've reached, not a setting.</p>

        <Button variant="secondary" icon={RotateCcw} loading={resetBusy} onClick={handleResetAudio}>
          Reset audio
        </Button>

        <Button
          variant="ghost"
          icon={SlidersHorizontal}
          onClick={() => {
            setMoreOpen(false);
            navigate('setup');
          }}
        >
          Setup &amp; calibration
        </Button>
      </Sheet>
    </div>
  );
}
