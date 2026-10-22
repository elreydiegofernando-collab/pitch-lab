/**
 * Live: the free-sing pitch monitor. AppBar + readouts + the pitch trace + the thumb-zone action bar.
 *
 * Progressive (SPEC §11.1): a new singer sees note, cents, Hz and dB and nothing else. Crack markers on the trace appear
 * after Sirens & glides, the settle and scoop readout after Crispness, and vibrato rate, extent and the zone after the
 * Foundations Boss Recital. Each one is analysed a few times a second on a window of recent frames (practice/
 * live-analysis.ts), never per frame, and costs nothing at all until it is earned. The More sheet lists the readouts
 * that are still locked with what unlocks them.
 */
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { JSX } from 'preact';
import { RotateCcw, SlidersHorizontal, Waves } from 'lucide-preact';
import { back, navigate } from '../../router';
import { getEngine } from '../../audio/engine';
import { getSynth, resetAudio } from '../../state/audio';
import { engineState } from '../../state/engine-store';
import { activePitchView } from '../../state/pitch-view-registry';
import { isUnlocked } from '../../state/session';
import { settings } from '../../state/settings';
import { CONFIG } from '../../config';
import { noteName, octaveOf, parseNote, type Notation } from '../../core/music';
import type { TargetNote } from '../../core/types';
import type { FeatureId } from '../../progress/types';
import { requirementHint } from '../../progress';
import { PitchViewHost } from '../pitch-view/PitchViewHost';
import type { PitchView } from '../pitch-view/types';
import { AppBar } from '../components/AppBar';
import { BottomBar } from '../components/BottomBar';
import { Button } from '../components/Button';
import { ListRow } from '../components/ListRow';
import { Locked } from '../components/Locked';
import { ReadoutCluster } from '../components/ReadoutCluster';
import { Sheet } from '../components/Sheet';
import { EngineIssue } from '../practice/EngineIssue';
import { LiveStatus } from '../practice/LiveStatus';
import { viewReducedMotion } from '../practice/motion';
import { useLiveAnalysis } from '../practice/use-live-analysis';
import { useReleaseMicOnLeave } from '../practice/use-mic-release';
import { viewZone } from '../practice/vibrato-zone';

const NOTE_LOW = parseNote('E2');
const NOTE_HIGH = parseNote('C6');
const A3_MIDI = parseNote('A3');

/** The readouts that are earned one by one, with the name each is listed under in More. */
const PROGRESSIVE_READOUTS: ReadonlyArray<{ id: FeatureId; title: string }> = [
  { id: 'live.cracks', title: 'Crack markers' },
  { id: 'live.onset', title: 'Settle and scoop' },
  { id: 'live.vibrato', title: 'Vibrato rate, extent and zone' },
];

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
  const viewRef = useRef<PitchView | null>(null);
  useReleaseMicOnLeave(engine);

  // Track the last voiced pitch purely for the note picker's default position — a ref write, no re-render.
  useEffect(() => {
    return engine.onFrame((frame) => {
      if (frame.voiced) lastSungMidiRef.current = Math.round(frame.midi);
    });
  }, [engine]);

  // What has been earned decides what is measured and drawn (SPEC §11.1); an unearned readout costs nothing.
  const features = { cracks: isUnlocked('live.cracks'), onset: isUnlocked('live.onset'), vibrato: isUnlocked('live.vibrato') };
  const style = settings.value.vibratoStyle;
  const readings = useLiveAnalysis({
    engine,
    features,
    vibratoStyle: style,
    toleranceCents: CONFIG.tolerance.default,
    targetMidi,
    hooks: {
      onCrack: (t) => viewRef.current?.addMarker(t, 'crack', 'crack'),
      onOnset: (t) => viewRef.current?.addMarker(t, 'onset'),
    },
  });
  const zone = useMemo(() => (features.vibrato ? viewZone(style) : null), [features.vibrato, style]);
  const motion = viewReducedMotion(settings.value.reducedMotion);
  const notation = settings.value.notation;
  const showNoteNames = settings.value.showNoteNames;
  const viewOptions = useMemo(() => ({ notation, reducedMotion: motion, showNoteNames, autoRange: true }), [notation, motion, showNoteNames]);

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

  function handleResetAudio(): void {
    const promise = resetAudio();
    setResetBusy(true);
    promise.catch(() => {}).finally(() => setResetBusy(false));
  }

  const targets: readonly TargetNote[] | undefined = useMemo(
    () => (targetMidi === null ? undefined : [{ midi: targetMidi, start: -1e9, end: 1e9 }]),
    [targetMidi],
  );

  return (
    <div class="pl-screen" data-testid="live-screen">
      <AppBar title="Live" routeIcon={Waves} engineState={engineState.value} onBack={() => back()} />

      <div class="pl-live-body">
        <div class="pl-live-body__readouts pl-safe-x">
          <ReadoutCluster engine={engine} toleranceCents={CONFIG.tolerance.default} notation={notation} />
          <LiveStatus readings={readings} features={features} />
          <EngineIssue engine={engine} />
        </div>

        <div class="pl-live-body__canvas">
          <PitchViewHost
            engine={engine}
            targets={targets}
            targetOrigin={0}
            toleranceCents={CONFIG.tolerance.default}
            vibratoZone={zone}
            options={viewOptions}
            onView={(v) => {
              viewRef.current = v;
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
        <div class="pl-stack" data-testid="live-readouts">
          <span class="pl-label">Readouts</span>
          <div class="pl-list">
            {PROGRESSIVE_READOUTS.map(({ id, title }) =>
              isUnlocked(id) ? (
                <ListRow key={id} title={title} value="On" />
              ) : (
                <div key={id} class="pl-row">
                  <Locked compact title={title} hint={requirementHint(id)} />
                </div>
              ),
            )}
          </div>
        </div>

        <div class="pl-stack">
          <span class="pl-label">Target note</span>
          <NotePicker
            value={targetMidi}
            defaultNear={lastSungMidiRef.current}
            notation={notation}
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
