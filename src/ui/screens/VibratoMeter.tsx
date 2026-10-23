/**
 * Vibrato meter: free singing with the target zone shaded on the trace (docs/DESIGN.md §13.14, SPEC §9.2). Three big
 * readouts (rate, extent, centring) each say where they sit against the style's zone, and wobble, bleat and straight
 * show as chips. The numbers come from a sliding window of the last couple of seconds, analysed a few times a second by
 * the same analyzer that scores a take. Listen plays a tone with vibrato at the middle of the zone, so the goal can be
 * heard. The tool opens with the Vibrato world; the screen checks that itself as well as the router. The style choice in
 * More is in plain words (owner, 2026-10-23: no Hz or cents in anything a singer reads), with vibrato a word to tap.
 */
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { JSX } from 'preact';
import { Activity } from 'lucide-preact';
import { back } from '../../router';
import { styleZoneVibrato } from '../../audio/demos';
import type { ScheduledHandle } from '../../audio/synth-types';
import { getEngine } from '../../audio/engine';
import { CONFIG } from '../../config';
import { parseNote } from '../../core/music';
import { getSynth } from '../../state/audio';
import { engineState } from '../../state/engine-store';
import { activePitchView } from '../../state/pitch-view-registry';
import { isUnlocked } from '../../state/session';
import { settings, updateSettings } from '../../state/settings';
import { requirementHint } from '../../progress';
import { vibratoStyleWords } from '../../teach/vibrato-words';
import { AppBar } from '../components/AppBar';
import { Locked } from '../components/Locked';
import { Segmented } from '../components/Segmented';
import { Term } from '../teach/Term';
import { PitchViewHost } from '../pitch-view/PitchViewHost';
import { EngineIssue } from '../practice/EngineIssue';
import { MoreSheet } from '../practice/MoreSheet';
import { PracticeBar } from '../practice/PracticeBar';
import { VibratoReadouts } from '../practice/VibratoReadouts';
import type { LiveFeatures, LiveHooks } from '../practice/live-analysis';
import { viewReducedMotion } from '../practice/motion';
import { useLiveAnalysis } from '../practice/use-live-analysis';
import { useReleaseMicOnLeave } from '../practice/use-mic-release';
import { viewZone, zoneInfo } from '../practice/vibrato-zone';

const METER_FEATURES: LiveFeatures = { cracks: false, onset: false, vibrato: true };
const NO_MARKERS: LiveHooks = { onCrack: () => {}, onOnset: () => {} };
const A3 = parseNote('A3');
/** The demo tone lasts about as long as it takes to hear a few cycles settle. */
const DEMO_SEC = 3.2;
const DEMO_BLOOM_SEC = 0.5;

export function VibratoMeter(): JSX.Element {
  if (!isUnlocked('tool.vibrato-meter')) {
    return (
      <div class="pl-screen" data-testid="vibrato-meter-locked">
        <AppBar title="Vibrato meter" onBack={() => back()} />
        <main class="pl-page">
          <Locked title="Vibrato meter" hint={requirementHint('tool.vibrato-meter')} />
        </main>
      </div>
    );
  }
  return <MeterView />;
}

function MeterView(): JSX.Element {
  const engine = getEngine();
  const style = settings.value.vibratoStyle;
  const zone = zoneInfo(style);
  const readings = useLiveAnalysis({
    engine,
    features: METER_FEATURES,
    vibratoStyle: zone.style,
    toleranceCents: CONFIG.tolerance.default,
    targetMidi: null,
    hooks: NO_MARKERS,
  });

  const [moreOpen, setMoreOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const lastSungMidi = useRef(A3);
  const demo = useRef<ScheduledHandle | null>(null);
  const running = engineState.value === 'running';
  useReleaseMicOnLeave(engine);

  // The demo tone sounds on the note you last sang, so it is in your own range.
  useEffect(
    () =>
      engine.onFrame((frame) => {
        if (frame.voiced) lastSungMidi.current = Math.round(frame.midi);
      }),
    [engine],
  );

  function handleListen(): void {
    // Direct call inside the gesture: getSynth() calls engine.ensureContext() as its first statement.
    const synth = getSynth();
    demo.current?.stop();
    demo.current = synth.playNote({
      midi: lastSungMidi.current,
      duration: DEMO_SEC,
      timbre: 'soft',
      gain: settings.value.referenceVolume,
      vibrato: { ...styleZoneVibrato(zone.style), delaySec: DEMO_BLOOM_SEC, fadeInSec: DEMO_BLOOM_SEC },
    });
  }

  function handleToggle(): void {
    const pending = engineState.value === 'running' ? engine.stop() : engine.start();
    setBusy(true);
    pending.catch(() => {}).finally(() => setBusy(false));
  }

  const bandZone = useMemo(() => viewZone(zone.style), [zone.style]);
  const motion = viewReducedMotion(settings.value.reducedMotion);
  const viewOptions = useMemo(
    () => ({ notation: settings.value.notation, showNoteNames: settings.value.showNoteNames, reducedMotion: motion, autoRange: true }),
    [settings.value.notation, settings.value.showNoteNames, motion],
  );

  return (
    <div class="pl-screen pl-meter" data-testid="vibrato-meter-screen">
      <AppBar title="Vibrato meter" routeIcon={Activity} engineState={engineState.value} onBack={() => back()} />

      <div class="pl-live-body">
        <div class="pl-live-body__readouts pl-safe-x">
          <VibratoReadouts reading={readings.value.vibrato} zone={zone} toleranceCents={CONFIG.tolerance.default} />
          <EngineIssue engine={engine} />
        </div>

        <div class="pl-live-body__canvas">
          <PitchViewHost
            engine={engine}
            toleranceCents={CONFIG.tolerance.default}
            vibratoZone={bandZone}
            options={viewOptions}
            onView={(v) => {
              activePitchView.value = v;
            }}
          />
        </div>

        <div class="pl-live-body__bottombar">
          <PracticeBar
            listen={{ label: 'Listen', onClick: handleListen }}
            primary={{ kind: running ? 'stop' : 'sing', label: running ? 'Stop' : 'Sing', onClick: handleToggle, disabled: busy || engineState.value === 'starting' }}
            more={{ onClick: () => setMoreOpen(true) }}
          />
        </div>
      </div>

      <MoreSheet open={moreOpen} onClose={() => setMoreOpen(false)} showReset>
        {isUnlocked('setting.vibratoStyle') ? (
          <div class="pl-stack">
            <span class="pl-label">
              <Term id="vibrato">Vibrato</Term> style
            </span>
            <Segmented
              aria-label="Vibrato style"
              value={zone.style}
              options={[
                { value: 'pop', label: 'Pop' },
                { value: 'classical', label: 'Classical' },
              ]}
              onChange={(value) => updateSettings({ vibratoStyle: value })}
            />
            <p class="pl-body-s pl-muted pl-prose" data-testid="meter-style-words">
              {vibratoStyleWords(zone.style)} The shaded band on your pitch line follows it.
            </p>
          </div>
        ) : (
          <Locked title="Vibrato style" hint={requirementHint('setting.vibratoStyle')} />
        )}
      </MoreSheet>
    </div>
  );
}
