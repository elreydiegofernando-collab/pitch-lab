/**
 * Live analysis for the Live screen and the Vibrato meter: crack markers, how the last note started, and the vibrato of
 * the last couple of seconds. Everything is progressive (SPEC §11.1): a feature that is not switched on costs nothing,
 * not even a frame subscription. When one is on, the per-frame work is one ring write and a few comparisons; the
 * analyzers run about four times a second on a window pulled out of the ring (docs/ARCHITECTURE.md "Performance rules":
 * no allocation per frame, analysis throttled to a few Hz).
 */
import { signal, type ReadonlySignal } from '@preact/signals';
import { detectCracks } from '../../analysis/cracks';
import type { AudioEngine } from '../../audio/engine-types';
import type { PitchFrame, VibratoStyle } from '../../core/types';
import { createFrameRing } from './frame-ring';
import { readOnset, readVibrato, sameOnset, sameVibrato, type OnsetReading, type VibratoReading } from './live-readings';

export interface LiveFeatures {
  cracks: boolean;
  onset: boolean;
  vibrato: boolean;
}

export interface LiveVibrato extends VibratoReading {
  /** The voice has stopped: this is the last thing measured, shown dimmed. */
  stale: boolean;
}

export interface LiveReadings {
  onset: OnsetReading | null;
  vibrato: LiveVibrato | null;
}

export interface LiveSettings {
  features: LiveFeatures;
  vibratoStyle: VibratoStyle;
  /** In-tune band for the onset analysis and the vibrato centring flags (the Live default). */
  toleranceCents: number;
  /** The note the singer picked to aim at; null reads the note each onset lands on. */
  targetMidi: number | null;
}

export interface LiveHooks {
  /** A new crack, on the engine's input timeline (what PitchView.addMarker takes). */
  onCrack(t: number): void;
  /** A note's start was measured, on the same timeline. */
  onOnset(t: number): void;
}

export interface LiveAnalysis {
  readonly readings: ReadonlySignal<LiveReadings>;
  configure(settings: LiveSettings): void;
  dispose(): void;
}

/** About eight seconds of frames at the engine's rate. */
const RING_FRAMES = 800;
export const TICK_MS = 250;
const CRACK_WINDOW_SEC = 6;
const VIBRATO_WINDOW_SEC = 2.5;
/** A note starts after this much silence. */
const ONSET_SILENCE_SEC = 0.15;
/** The window handed to the onset analysis starts a little before the onset (the analyzer looks back). */
const ONSET_LEAD_SEC = 0.3;
/** A vibrato reading is shown dimmed once nothing new has been measured for this long. */
export const STALE_AFTER_SEC = 1.5;

const NO_FEATURES: LiveFeatures = { cracks: false, onset: false, vibrato: false };

export function createLiveAnalysis(engine: Pick<AudioEngine, 'onFrame'>, hooks: LiveHooks, tickMs: number = TICK_MS): LiveAnalysis {
  const ring = createFrameRing(RING_FRAMES);
  const readings = signal<LiveReadings>({ onset: null, vibrato: null });
  let cfg: LiveSettings = { features: NO_FEATURES, vibratoStyle: 'pop', toleranceCents: 25, targetMidi: null };
  let unsubscribe: (() => void) | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;

  let lastVoicedT = -Infinity;
  /** Start of the note being tracked, and whether its onset has been read yet. */
  let onsetT = NaN;
  let onsetRead = true;
  let lastCrackT = -Infinity;
  let lastTickT = -Infinity;
  let lastVibratoAt = -Infinity;
  let vibrato: LiveVibrato | null = null;
  let onset: OnsetReading | null = null;

  function publish(): void {
    const current = readings.value;
    const nextVibrato = cfg.features.vibrato ? vibrato : null;
    const nextOnset = cfg.features.onset ? onset : null;
    const vibratoChanged = !sameVibrato(current.vibrato, nextVibrato) || current.vibrato?.stale !== nextVibrato?.stale;
    if (vibratoChanged || !sameOnset(current.onset, nextOnset)) readings.value = { onset: nextOnset, vibrato: nextVibrato };
  }

  function resetState(): void {
    ring.clear();
    lastVoicedT = -Infinity;
    onsetT = NaN;
    onsetRead = true;
    lastCrackT = -Infinity;
    lastTickT = -Infinity;
    lastVibratoAt = -Infinity;
    vibrato = null;
    onset = null;
    publish();
  }

  function onFrame(f: PitchFrame): void {
    if (f.t < ring.latestT) resetState(); // the engine restarted on a fresh clock
    ring.push(f);
    if (!f.voiced) return;
    if (f.t - lastVoicedT > ONSET_SILENCE_SEC) {
      onsetT = f.t;
      onsetRead = false;
    }
    lastVoicedT = f.t;
  }

  function findCracks(latest: number): void {
    for (const crack of detectCracks(ring.since(latest - CRACK_WINDOW_SEC))) {
      if (crack.t > lastCrackT) {
        lastCrackT = crack.t;
        hooks.onCrack(crack.t);
      }
    }
  }

  function measureVibrato(latest: number): void {
    const reading = readVibrato(ring.since(latest - VIBRATO_WINDOW_SEC), cfg);
    if (reading) {
      lastVibratoAt = latest;
      vibrato = { ...reading, stale: false };
    } else if (vibrato && !vibrato.stale && latest - lastVibratoAt > STALE_AFTER_SEC) {
      vibrato = { ...vibrato, stale: true };
    }
  }

  function measureOnset(latest: number): void {
    if (onsetRead || Number.isNaN(onsetT)) return;
    const ended = latest - lastVoicedT > ONSET_SILENCE_SEC;
    const reading = readOnset(ring.since(onsetT - ONSET_LEAD_SEC), onsetT, cfg.targetMidi, cfg, ended);
    if (reading === null) {
      onsetRead = true; // too short to read
      return;
    }
    onset = reading;
    if (reading.state === 'settled') {
      onsetRead = true;
      hooks.onOnset(reading.onsetT);
    }
  }

  function tick(): void {
    const latest = ring.latestT;
    if (ring.count === 0 || latest === lastTickT) return;
    lastTickT = latest;
    if (cfg.features.cracks) findCracks(latest);
    if (cfg.features.vibrato) measureVibrato(latest);
    if (cfg.features.onset) measureOnset(latest);
    publish();
  }

  const wanted = (): boolean => cfg.features.cracks || cfg.features.onset || cfg.features.vibrato;

  function stop(): void {
    unsubscribe?.();
    unsubscribe = null;
    if (timer !== null) clearInterval(timer);
    timer = null;
    resetState();
  }

  return {
    readings,
    configure(next: LiveSettings): void {
      cfg = next;
      if (wanted()) {
        if (unsubscribe === null) {
          unsubscribe = engine.onFrame(onFrame);
          timer = setInterval(tick, tickMs);
        }
        publish();
      } else {
        stop();
      }
    },
    dispose: stop,
  };
}
