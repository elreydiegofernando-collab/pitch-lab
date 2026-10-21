/** Settings: vibrato style, detector, reference sound, notation, theme, reduced motion, note names. No difficulty/tolerance setting lives here — that comes from the level (docs/DESIGN.md, settings-types.ts). */
import type { JSX } from 'preact';
import { Settings as SettingsIcon, Volume2 } from 'lucide-preact';
import { back } from '../../router';
import { getEngine } from '../../audio/engine';
import { getSynth } from '../../state/audio';
import { refreshEngineInfo } from '../../state/engine-store';
import { settings, updateSettings } from '../../state/settings';
import type { Settings as SettingsShape } from '../../state/settings-types';
import { CONFIG } from '../../config';
import { parseNote, type Notation } from '../../core/music';
import type { DetectorKind } from '../../dsp/detector-types';
import type { Timbre } from '../../audio/synth-types';
import type { VibratoStyle } from '../../core/types';
import { AppBar } from '../components/AppBar';
import { Button } from '../components/Button';
import { ListRow } from '../components/ListRow';
import { Segmented } from '../components/Segmented';
import { Slider } from '../components/Slider';
import { Toggle } from '../components/Toggle';

const A3_MIDI = parseNote('A3');

const VIBRATO_OPTIONS = [
  { value: 'pop' as const, label: 'Pop / R&B' },
  { value: 'classical' as const, label: 'Classical' },
];
const DETECTOR_OPTIONS = [
  { value: 'mpm' as const, label: 'MPM' },
  { value: 'yin' as const, label: 'YIN' },
];
const TIMBRE_OPTIONS = [
  { value: 'piano' as const, label: 'Piano' },
  { value: 'soft' as const, label: 'Soft' },
  { value: 'sine' as const, label: 'Sine' },
];
const NOTATION_OPTIONS = [
  { value: 'sharps' as const, label: 'Sharps ♯' },
  { value: 'flats' as const, label: 'Flats ♭' },
];
const THEME_OPTIONS = [
  { value: 'system' as const, label: 'System' },
  { value: 'dark' as const, label: 'Dark' },
  { value: 'light' as const, label: 'Light' },
];
const MOTION_OPTIONS = [
  { value: 'system' as const, label: 'System' },
  { value: 'on' as const, label: 'On' },
  { value: 'off' as const, label: 'Off' },
];

function updateDetector(kind: DetectorKind): void {
  updateSettings({ detector: kind });
  getEngine().setDetector(kind);
  refreshEngineInfo();
}

function playSample(): void {
  const synth = getSynth();
  synth.playNote({
    midi: A3_MIDI,
    duration: 1,
    timbre: settings.value.referenceTimbre,
    gain: settings.value.referenceVolume,
  });
}

export function Settings(): JSX.Element {
  const s = settings.value;
  const vibratoZone = CONFIG.vibrato.styles[s.vibratoStyle];

  return (
    <div class="pl-screen" data-testid="settings-screen">
      <AppBar title="Settings" routeIcon={SettingsIcon} onBack={() => back()} />
      <div class="pl-scroll">
        <div class="pl-page pl-fade-rise">
          <section class="pl-stack">
            <span class="pl-label">Vibrato style</span>
            <Segmented
              aria-label="Vibrato style"
              options={VIBRATO_OPTIONS}
              value={s.vibratoStyle}
              onChange={(v: VibratoStyle) => updateSettings({ vibratoStyle: v })}
            />
            <p class="pl-body-s pl-muted pl-tabular">
              {vibratoZone.rateHz[0]}-{vibratoZone.rateHz[1]} Hz, extent &plusmn;{vibratoZone.extentCents[0]}-
              {vibratoZone.extentCents[1]}&cent;
            </p>
          </section>

          <section class="pl-stack">
            <span class="pl-label">Pitch detector</span>
            <Segmented aria-label="Pitch detector" options={DETECTOR_OPTIONS} value={s.detector} onChange={updateDetector} />
          </section>

          <section class="pl-stack">
            <span class="pl-label">Reference sound</span>
            <Segmented
              aria-label="Reference sound timbre"
              options={TIMBRE_OPTIONS}
              value={s.referenceTimbre}
              onChange={(v: Timbre) => updateSettings({ referenceTimbre: v })}
            />
            <Slider
              aria-label="Reference volume"
              value={s.referenceVolume}
              onChange={(v) => updateSettings({ referenceVolume: v })}
            />
            <Button variant="secondary" icon={Volume2} onClick={playSample}>
              Play sample
            </Button>
          </section>

          <section class="pl-stack">
            <span class="pl-label">Notation</span>
            <Segmented
              aria-label="Sharp/flat notation"
              options={NOTATION_OPTIONS}
              value={s.notation}
              onChange={(v: Notation) => updateSettings({ notation: v })}
            />
          </section>

          <section class="pl-stack">
            <span class="pl-label">Theme</span>
            <Segmented
              aria-label="Theme"
              options={THEME_OPTIONS}
              value={s.theme}
              onChange={(v: SettingsShape['theme']) => updateSettings({ theme: v })}
            />
          </section>

          <section class="pl-stack">
            <span class="pl-label">Reduced motion</span>
            <Segmented
              aria-label="Reduced motion"
              options={MOTION_OPTIONS}
              value={s.reducedMotion}
              onChange={(v: SettingsShape['reducedMotion']) => updateSettings({ reducedMotion: v })}
            />
          </section>

          <div class="pl-list">
            <ListRow
              title="Note names"
              subtitle="Show note names on the pitch trace"
              trailing={
                <Toggle
                  checked={s.showNoteNames}
                  onChange={(v) => updateSettings({ showNoteNames: v })}
                  aria-label="Show note names"
                />
              }
            />
          </div>
        </div>
      </div>
    </div>
  );
}
