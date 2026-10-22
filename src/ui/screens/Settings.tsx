/**
 * Settings: vibrato style (once the Vibrato world is unlocked), detector, reference sound, notation, theme,
 * reduced motion, note names, whether to keep take audio, and the doors to Profiles and Data & backup. No
 * difficulty or tolerance setting lives here: that comes from the level (docs/DESIGN.md, settings-types.ts), and
 * anything that belongs to a skill the singer has not earned yet is shown locked (SPEC §11.1).
 */
import type { JSX } from 'preact';
import { ChevronRight, Database, Settings as SettingsIcon, Users, Volume2 } from 'lucide-preact';
import { back, navigate } from '../../router';
import { getEngine } from '../../audio/engine';
import { getSynth } from '../../state/audio';
import { refreshEngineInfo } from '../../state/engine-store';
import { activeProfile, isUnlocked } from '../../state/session';
import { settings, updateSettings } from '../../state/settings';
import type { Settings as SettingsShape } from '../../state/settings-types';
import { requirementHint } from '../../progress';
import { CONFIG } from '../../config';
import { parseNote, type Notation } from '../../core/music';
import type { DetectorKind } from '../../dsp/detector-types';
import type { Timbre } from '../../audio/synth-types';
import type { VibratoStyle } from '../../core/types';
import { AppBar } from '../components/AppBar';
import { Button } from '../components/Button';
import { ListRow } from '../components/ListRow';
import { Locked } from '../components/Locked';
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
  const vibratoOpen = isUnlocked('setting.vibratoStyle');

  return (
    <div class="pl-screen" data-testid="settings-screen">
      <AppBar title="Settings" routeIcon={SettingsIcon} onBack={() => back()} />
      <div class="pl-scroll">
        <div class="pl-page">
          <section class="pl-stack">
            <span class="pl-label">Vibrato style</span>
            {vibratoOpen ? (
              <>
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
              </>
            ) : (
              <Locked hint={requirementHint('setting.vibratoStyle')} />
            )}
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

          <section class="pl-stack">
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
              <ListRow
                title="Keep take audio"
                subtitle="Save the sound of each take on this device, so you can play it back and slow it down"
                trailing={
                  <Toggle
                    checked={s.keepTakeAudio}
                    onChange={(v) => updateSettings({ keepTakeAudio: v })}
                    aria-label="Keep take audio"
                  />
                }
              />
            </div>
            <p class="pl-body-s pl-muted pl-prose" data-testid="audio-privacy">
              Your voice audio never leaves this device unless you export it: Export WAV in Data &amp; backup, or Send to Claude with Include audio turned on.
            </p>
          </section>

          <section class="pl-stack">
            <span class="pl-label">Singers and data</span>
            <div class="pl-list">
              <ListRow
                icon={Users}
                title="Profiles"
                subtitle="Switch singer, rename or delete"
                value={activeProfile.value?.name}
                trailing={<ChevronRight class="pl-row__icon" size={20} aria-hidden="true" />}
                onClick={() => navigate('profiles')}
              />
              <ListRow
                icon={Database}
                title="Data & backup"
                subtitle="Backup, recordings, delete all data"
                trailing={<ChevronRight class="pl-row__icon" size={20} aria-hidden="true" />}
                onClick={() => navigate('data')}
              />
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
