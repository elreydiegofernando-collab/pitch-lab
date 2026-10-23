/**
 * Home, the hub (docs/DESIGN.md 13.1): one tap to keep going. The Continue card is the next number on the set list;
 * below it the Momentum chip (once the dashboard is earned), the training destinations (a locked one stays in place as a
 * static `Locked` line, SPEC 11.1) and the utilities. First run, per profile: the voice-care note, then the headphone and
 * Setup prompt, then the voice check-up card (src/ui/worlds/CheckupCard.tsx), which sits above Continue on a profile that
 * has sung nothing and just under it otherwise.
 */
import { useCallback, useEffect, useState } from 'preact/hooks';
import type { JSX } from 'preact';
import {
  AudioWaveform,
  ChartLine,
  Dumbbell,
  Gauge,
  HardDrive,
  Heart,
  ListMusic,
  Route as RouteIcon,
  Settings as SettingsIcon,
  SlidersHorizontal,
  Users,
  Waves,
} from 'lucide-preact';
import { navigate } from '../../router';
import { isIOS, isStandalone } from '../../audio/platform';
import { requirementHint, type FeatureId } from '../../progress';
import { bootPhase, isUnlocked } from '../../state/session';
import { deviceSettings, settings, settingsReady, updateDeviceSettings, updateSettings } from '../../state/settings';
import { AppBar } from '../components/AppBar';
import { Banner } from '../components/Banner';
import type { Icon } from '../components/icon';
import { useHomeCard } from '../checkup/home-card';
import { BootFailed, BootSkeleton } from '../worlds/BootStates';
import { CheckupCard } from '../worlds/CheckupCard';
import { ContinueCard } from '../worlds/ContinueCard';
import { DestinationRow } from '../worlds/DestinationRow';
import { HeadphoneSheet, VoiceCareSheet } from '../worlds/FirstRunSheets';
import { MomentumChip } from '../worlds/MomentumChip';
import { ProfileChip } from '../worlds/ProfileChip';

interface Destination {
  key: string;
  icon: Icon;
  title: string;
  subtitle: string;
  open: () => void;
  /** The registry feature that gates it; absent for a destination that is open from the start. */
  feature?: FeatureId;
}

const TRAINING: readonly Destination[] = [
  { key: 'map', icon: RouteIcon, title: 'World map', subtitle: 'Levels, worlds and placement auditions', open: () => navigate('map') },
  {
    key: 'workout',
    icon: Dumbbell,
    title: 'Daily workout',
    subtitle: 'A plan built from your progress',
    open: () => navigate('workout'),
    feature: 'daily-workout',
  },
  {
    key: 'songs',
    icon: ListMusic,
    title: 'Song Stage',
    subtitle: 'Sing real melodies, phrase by phrase',
    open: () => navigate('songs'),
    feature: 'song-stage',
  },
  {
    key: 'vibrato-meter',
    icon: AudioWaveform,
    title: 'Vibrato meter',
    subtitle: 'Rate, extent and centring, live',
    open: () => navigate('vibrato-meter'),
    feature: 'tool.vibrato-meter',
  },
  { key: 'live', icon: Waves, title: 'Live pitch', subtitle: 'Free-sing monitor with the trace', open: () => navigate('live') },
  {
    key: 'dashboard',
    icon: ChartLine,
    title: 'Progress dashboard',
    subtitle: 'Momentum, skills and range over time',
    open: () => navigate('dashboard'),
    feature: 'dashboard',
  },
];

const UTILITIES: readonly Destination[] = [
  { key: 'setup', icon: SlidersHorizontal, title: 'Setup & calibration', subtitle: 'Headphones, microphone, timing check', open: () => navigate('setup') },
  { key: 'settings', icon: SettingsIcon, title: 'Settings', subtitle: 'Theme, reference sound, notation', open: () => navigate('settings') },
  { key: 'profiles', icon: Users, title: 'Profiles', subtitle: 'Switch singer or add one', open: () => navigate('profiles') },
  { key: 'data', icon: HardDrive, title: 'Data & backup', subtitle: 'Backups, saved takes, storage', open: () => navigate('data') },
  { key: 'diagnostics', icon: Gauge, title: 'Diagnostics', subtitle: 'Sound, timing and storage checks', open: () => navigate('diagnostics') },
  { key: 'about', icon: Heart, title: 'About & voice care', subtitle: 'Privacy, voice care, credits', open: () => navigate('about') },
];

/** True until a latency calibration exists for the current output route. */
function needsCalibration(): boolean {
  const d = deviceSettings.value;
  return d.route === 'unknown' || d.latency[d.route] === undefined;
}

function needsSetupAttention(): boolean {
  return !deviceSettings.value.headphoneGuideSeen || needsCalibration();
}

function acknowledgeVoiceCare(): void {
  updateSettings({ voiceCareSeen: true });
}

function TrainingList(): JSX.Element {
  return (
    <div class="pl-list" data-testid="training-list">
      {TRAINING.map((d) => {
        const locked = d.feature !== undefined && !isUnlocked(d.feature);
        return (
          <DestinationRow
            key={d.key}
            icon={d.icon}
            title={d.title}
            subtitle={d.subtitle}
            testId={`dest-${d.key}`}
            onOpen={locked ? undefined : d.open}
            lockedHint={locked && d.feature ? requirementHint(d.feature) : undefined}
          />
        );
      })}
    </div>
  );
}

function UtilityList(): JSX.Element {
  const calibrate = needsCalibration();
  return (
    <div class="pl-list" data-testid="utility-list">
      {UTILITIES.map((d) => {
        const attention = d.key === 'setup' && needsSetupAttention();
        return (
          <DestinationRow
            key={d.key}
            icon={d.icon}
            title={d.title}
            subtitle={d.key === 'setup' && calibrate ? 'Run the timing check so your takes line up' : d.subtitle}
            testId={`util-${d.key}`}
            onOpen={d.open}
            attention={attention}
          />
        );
      })}
    </div>
  );
}

export function Home(): JSX.Element {
  const phase = bootPhase.value;
  const checkup = useHomeCard();
  const [settingsAreReady, setSettingsAreReady] = useState(false);
  const [headphonesDismissed, setHeadphonesDismissed] = useState(false);
  const [showAddToHomeScreen] = useState(() => isIOS() && !isStandalone());

  useEffect(() => {
    let active = true;
    settingsReady
      .then(() => {
        if (active) setSettingsAreReady(true);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);

  const dismissHeadphones = useCallback(() => {
    updateDeviceSettings({ headphoneGuideSeen: true });
    setHeadphonesDismissed(true);
  }, []);
  const setupNow = useCallback(() => {
    dismissHeadphones();
    navigate('setup');
  }, [dismissHeadphones]);

  // Decide on the first-run sheets only once this profile's settings are loaded, so a returning singer never sees a flash.
  const known = phase === 'ready' && settingsAreReady;
  const voiceCareSeen = settings.value.voiceCareSeen;
  const showVoiceCare = known && !voiceCareSeen;
  const showHeadphones = known && voiceCareSeen && !deviceSettings.value.headphoneGuideSeen && !headphonesDismissed;

  return (
    <div class="pl-screen wl-scope" data-testid="home-screen">
      <AppBar title="Pitch Lab" root trailing={<ProfileChip />} />
      <div class="pl-scroll">
        <div class="pl-page wl-page" aria-busy={phase === 'booting' ? 'true' : undefined}>
          {phase === 'booting' ? <BootSkeleton kind="home" /> : null}
          {phase === 'failed' ? <BootFailed /> : null}
          {phase === 'ready' ? (
            <>
              {/* A new profile starts with the voice check-up (or finishes one it left part way): that card comes first, and
                  Continue steps back to a secondary button. Every other state of the card sits just under Continue. */}
              {checkup.above ? <CheckupCard card={checkup} /> : null}
              <ContinueCard quiet={checkup.above} />
              {checkup.above ? null : <CheckupCard card={checkup} />}
              {isUnlocked('dashboard') ? <MomentumChip /> : null}
              {showAddToHomeScreen ? (
                <Banner kind="info" message="Add Pitch Lab to your Home Screen for full-screen, offline use.">
                  <p class="pl-body-s pl-muted">Tap Share, then "Add to Home Screen".</p>
                </Banner>
              ) : null}
              <section class="wl-section" aria-labelledby="home-training">
                <h2 class="pl-label wl-section__label" id="home-training">
                  Training
                </h2>
                <TrainingList />
              </section>
            </>
          ) : null}
          <section class="wl-section" aria-labelledby="home-utilities">
            <h2 class="pl-label wl-section__label" id="home-utilities">
              Utilities
            </h2>
            <UtilityList />
          </section>
        </div>
      </div>

      <VoiceCareSheet open={showVoiceCare} onClose={acknowledgeVoiceCare} />
      <HeadphoneSheet open={showHeadphones} onLater={dismissHeadphones} onSetup={setupNow} />
    </div>
  );
}
