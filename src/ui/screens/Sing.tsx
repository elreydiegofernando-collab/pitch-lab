/**
 * Sing: the take (docs/DESIGN.md §13.4). The Live layout with the exercise on the canvas: target bars whose height is the
 * level's tolerance band, the vibrato zone where the exercise scores vibrato, a count-in counter, the cue pill, a 2 px
 * progress hairline and one context chip (tempo rung, audition test, workout item). One runner per visit; Listen, Sing
 * and Stop call it straight from the click or key event, which keeps iOS audio start inside the gesture. When the runner
 * is done the report replaces this screen, so Back from the report returns to the level.
 */
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { JSX } from 'preact';
import { back, replace, route } from '../../router';
import { getEngine } from '../../audio/engine';
import { CONFIG } from '../../config';
import { targetFromParams, targetKey } from '../../runtime/targets';
import type { RunError, RunTarget } from '../../runtime/types';
import { engineState } from '../../state/engine-store';
import { activePitchView } from '../../state/pitch-view-registry';
import { settings } from '../../state/settings';
import { AppBar } from '../components/AppBar';
import { Banner } from '../components/Banner';
import { Button } from '../components/Button';
import { ReadoutCluster } from '../components/ReadoutCluster';
import { PitchViewHost } from '../pitch-view/PitchViewHost';
import type { PitchView } from '../pitch-view/types';
import { MoreSheet } from '../practice/MoreSheet';
import { PracticeBar } from '../practice/PracticeBar';
import { TraceReplay } from '../practice/TraceReplay';
import { Unavailable } from '../practice/Unavailable';
import { contextChip, singTitle } from '../practice/copy';
import { viewReducedMotion } from '../practice/motion';
import { fitPitchWindow } from '../practice/replay-geometry';
import { tryCreateRunner } from '../practice/runner-handle';
import { singControls } from '../practice/sing-controls';
import { ContextChip, CountInOverlay, CuePill, ProgressHairline } from '../practice/sing-overlays';
import { viewZone } from '../practice/vibrato-zone';

/** Width of the live view's note-name column: the preview keeps clear of it. */
const NAME_GUTTER_PX = 40;
/** The Range finder asks the singer past its guide bars, so the view keeps a fifth of room beyond them to see the trace go. */
const RANGE_FINDER_MARGIN = 7;

function RunErrorBanner(props: { error: RunError }): JSX.Element {
  const stuck = props.error.code === 'locked' || props.error.code === 'unknown';
  return (
    <Banner kind="error" message={props.error.message}>
      {stuck ? (
        <Button variant="secondary" onClick={() => back()}>
          Go back
        </Button>
      ) : null}
    </Banner>
  );
}

export function Sing(): JSX.Element {
  const r = route.value;
  const target = r.name === 'sing' ? targetFromParams(r.params) : null;
  if (!target) return <Unavailable title="Sing" message="This take can't be opened. Go back and choose it again." />;
  return <SingTake key={targetKey(target)} target={target} />;
}

function SingTake(props: { target: RunTarget }): JSX.Element {
  const engine = getEngine();
  const [handle] = useState(() => tryCreateRunner(props.target));
  const runner = handle.runner;
  const viewRef = useRef<PitchView | null>(null);
  const [moreOpen, setMoreOpen] = useState(false);

  useEffect(() => () => runner?.dispose(), [runner]);

  const phase = runner?.phase.value ?? 'error';
  const prepared = runner?.prepared.value ?? null;
  const origin = runner?.origin.value ?? null;
  const countIn = runner?.countIn.value ?? null;
  const cue = runner?.cue.value ?? null;
  const error = runner?.error.value ?? null;

  // The report replaces this screen once the attempt is written, so Back from it returns to the level.
  useEffect(() => {
    if (phase === 'done') replace('report');
  }, [phase]);

  // The canvas freezes while the take is scored, and starts clean for a new take.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    if (phase === 'analyzing' || phase === 'done') view.stop();
    else {
      if (phase === 'starting') view.clear();
      view.start();
    }
  }, [phase]);

  const tolerance = prepared ? CONFIG.tolerance[prepared.def.tolerance] : CONFIG.tolerance.default;
  const notes = prepared?.realized.notes;
  const rangeFinder = prepared?.def.kind === 'range-finder';
  const pitchWindow = useMemo(() => (notes ? fitPitchWindow(notes, [], rangeFinder ? { margin: RANGE_FINDER_MARGIN } : {}) : null), [notes, rangeFinder]);
  const scoresVibrato = prepared?.def.analyzers.includes('vibrato') ?? false;
  const style = settings.value.vibratoStyle;
  const zone = useMemo(() => (scoresVibrato ? viewZone(style) : null), [scoresVibrato, style]);
  const motion = viewReducedMotion(settings.value.reducedMotion);
  const notation = settings.value.notation;
  const showNoteNames = settings.value.showNoteNames;
  const viewOptions = useMemo(
    () => ({ notation, showNoteNames, reducedMotion: motion, autoRange: pitchWindow === null, ...(pitchWindow ? { lowMidi: pitchWindow.low, highMidi: pitchWindow.high } : {}) }),
    [notation, showNoteNames, motion, pitchWindow],
  );

  const controls = singControls(phase, prepared !== null, error);
  const taking = phase === 'count-in' || phase === 'singing';
  const showPreview = prepared !== null && origin === null && (phase === 'idle' || phase === 'listening' || phase === 'error');

  /**
   * Esc stops a playing demo; otherwise it is Back (DESIGN §13.4). Leaving discards a count-in or a take in progress
   * (the runner's dispose: nothing is written), so Esc never submits half a take the way the Stop button does.
   */
  function handleEscape(): boolean {
    if (runner?.phase.peek() !== 'listening') return false;
    runner.listen();
    return true;
  }

  if (!runner) return <Unavailable title="Sing" message={handle.failure ?? "This take can't be opened."} />;

  return (
    <div class={`pl-screen pl-sing${phase === 'analyzing' ? ' pl-sing--scoring' : ''}`} data-testid="sing-screen" data-phase={phase}>
      <AppBar title={prepared ? singTitle(prepared) : 'Sing'} engineState={engineState.value} onBack={() => back()} />

      <div class="pl-live-body">
        <div class="pl-live-body__readouts pl-safe-x">
          <ReadoutCluster engine={engine} toleranceCents={tolerance} notation={notation} />
          {error ? <RunErrorBanner error={error} /> : null}
        </div>

        <div class="pl-live-body__canvas pl-sing__canvas">
          <PitchViewHost
            engine={engine}
            targets={origin !== null ? notes : undefined}
            targetOrigin={origin ?? 0}
            toleranceCents={tolerance}
            vibratoZone={zone}
            options={viewOptions}
            onView={(v) => {
              viewRef.current = v;
              activePitchView.value = v;
            }}
          />
          {showPreview && prepared ? (
            <div class="pl-sing__preview">
              <TraceReplay
                mode="preview"
                notes={prepared.realized.notes}
                totalSec={prepared.realized.totalSec}
                toleranceCents={tolerance}
                window={pitchWindow ?? undefined}
                padLeft={NAME_GUTTER_PX}
              />
            </div>
          ) : null}
          <ProgressHairline progress={runner.progress} />
          <div class="pl-sing__top">
            {taking ? <CuePill cue={cue} /> : null}
            <ContextChip text={prepared ? contextChip(prepared, props.target) : null} />
          </div>
          <CountInOverlay beat={countIn} beats={prepared?.def.countInBeats ?? 0} />
        </div>

        <div class="pl-live-body__bottombar">
          <PracticeBar
            listen={{ ...controls.listen, onClick: () => runner.listen() }}
            primary={{
              ...controls.primary,
              onClick: () => {
                if (phase === 'count-in' || phase === 'singing') runner.stop();
                else runner.sing();
              },
            }}
            more={{ onClick: () => setMoreOpen(true), disabled: controls.moreDisabled }}
            onEscape={handleEscape}
          />
        </div>
      </div>

      {/* No "Reset audio" here: it reopens the microphone, which the runner would no longer own. Setup & calibration has it. */}
      <MoreSheet open={moreOpen} onClose={() => setMoreOpen(false)} />
    </div>
  );
}
