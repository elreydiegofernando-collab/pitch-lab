/**
 * Pitch Lab tuning knobs: ONE file, so thresholds are easy to find and tune.
 *
 * Conventions
 *  - Cents are signed; positive = sharp.
 *  - Vibrato "extent" = HALF the median peak-to-trough distance (i.e. +/- cents).
 *  - Times are seconds unless the name ends in Ms.
 *  - Values marked PROVISIONAL have no multi-subject research norm behind them
 *    (see docs/RESEARCH.md); expect to tune them on real voices.
 *
 * Sources for defaults: docs/RESEARCH.md (Oct 2026 research sweep) and the
 * owner's spec (docs/SPEC.md). Where the two differ, the owner's number wins
 * and the research value is noted.
 */
import type { DetectorKind } from './dsp/detector-types';
import type { ToleranceLevel, VibratoStyle } from './core/types';

export const CONFIG = {
  /** Capture + pitch tracking (worklet). */
  audio: {
    /** Analysis window, samples (both 44.1 and 48 kHz). 2048 = 3.5-3.8 periods of E2: enough for the whole E2-C6 range. */
    windowSize: 2048,
    /** Hop as a duration so 44.1 kHz and 48 kHz both get ~94 frames/s (48k -> 512 samples, 44.1k -> 470). */
    hopSeconds: 512 / 48000,
    /** Lag-search bounds. E2 = 82.4 Hz, C6 = 1046.5 Hz; a little margin each side. Bounding maxHz also kills the
     *  documented ~3 kHz sibilant spikes of unbounded MPM. */
    minHz: 70,
    maxHz: 1100,
    detector: 'mpm' as DetectorKind,
    /** MPM key-maximum constant k. Literature band 0.8-1 (Tartini used 0.93). */
    mpmK: 0.9,
    /** YIN absolute threshold (de Cheveigné & Kawahara suggest 0.10-0.15). */
    yinThreshold: 0.15,
    /** Voicing gate: frames below either are unvoiced (silence, breaths, consonants). PROVISIONAL - tune on device. */
    minConfidence: 0.8,
    minRmsDb: -50,
    /** Floor used instead of -Infinity for digital silence. */
    rmsFloorDb: -100,
    /** Worklet stats message interval. */
    statsIntervalSec: 1,
  },

  /** Engine robustness (iOS). */
  engine: {
    /** Treat the mic as suspect after this long hidden (WebKit ends tracks ~30 s in background). */
    backgroundSuspectSec: 20,
    /** devicechange fires repeatedly with Bluetooth connected on some iOS versions. */
    deviceChangeDebounceMs: 1500,
    /** Main-thread detector micro-benchmark iterations at start. */
    benchmarkIterations: 60,
  },

  /** Live display (never used by analyzers). */
  display: {
    pastSeconds: 4.5,
    futureSeconds: 1.75,
    /** Now-line position as a fraction of canvas width. */
    nowLineFraction: 0.72,
    maxDevicePixelRatio: 2,
    /** Auto-range: visible span and how far the voice may go before re-centring. */
    autoRangeSemitones: 14,
    autoRangeMarginSemitones: 2,
    /** Display smoothing: median-of-3 (spike/octave-glitch rejection) then a One Euro filter on semitones.
     *  minCutoffHz must stay well above vibrato rates (5-7 Hz) or the meter would hide the wobble.
     *  Acceptance: 6 Hz +/-50 c vibrato keeps >= 80% displayed amplitude (the priority: the vibrato meter must
     *  show the real wobble); +/-5 c white jitter drops >= 1.8x (5 c is ~1 px on a phone, so this matters less).
     *  A first-order filter can't hit 80% and 2x at once. Measured sweep: 8 Hz 73%/2.1x, 10 Hz 79%/1.97x,
     *  12 Hz 82%/1.87x (chosen), 16 Hz 88%/1.73x. */
    smoothing: {
      median3: true,
      minCutoffHz: 12,
      beta: 0.01,
      derivativeCutoffHz: 1.5,
    },
    /** Below this measured frame rate (Low Power Mode caps rAF at 30), skip interpolation niceties. */
    lowFpsThreshold: 40,
  },

  /** In-tune tolerance tiers, +/- cents. Set by the LEVEL, not by the user.
   *  +/-25 matches the measured melodic mistuning threshold (Larrouy-Maestri 2018); +/-10 is an elite "studio" bar. */
  tolerance: {
    easy: 50,
    default: 25,
    studio: 10,
  } satisfies Record<ToleranceLevel, number>,

  /** 8.1 Accuracy & stability. */
  accuracy: {
    /** Ignore this much of each note's start when measuring the held portion (the onset analyzer owns it). */
    holdStartSkipMs: 150,
    /** Drift = slope of a line fit over the held portion; report per second. Needs at least this much held audio. */
    driftMinHoldSec: 1,
  },

  /** 8.2 Onset crispness. */
  onset: {
    /** Settle = pitch stays inside tolerance for this long. */
    settleHoldMs: 100,
    /** Scoop = lowest deviation below target in this window after voice onset. */
    scoopWindowMs: 150,
    /** Target settle time by tier. PROVISIONAL (one case study + pedagogy). */
    settleTargetMs: { easy: 400, default: 250, studio: 150 } satisfies Record<ToleranceLevel, number>,
    /** "Crisp" = settle under target, scoop and overshoot under these. PROVISIONAL. */
    crispMaxScoopCents: 30,
    crispMaxOvershootCents: 20,
    /** Onset type from the RMS rise time (onset -> steady-state mean level). Koike-style VRT bands.
     *  It's an acoustic estimate, not a clinical (EGG) classification: say so in the UI. */
    hardMaxRiseMs: 60,
    breathyMinRiseMs: 160,
  },

  /** 8.3 Vibrato. */
  vibrato: {
    /** Detrend window (moving average removed from the raw track). Spec 0.5-1 s; research suggests 0.6-0.8 s. */
    detrendWindowSec: 0.7,
    /** Need at least this many cycles and this much time before calling anything vibrato. */
    minCycles: 2,
    minDurationSec: 0.3,
    /** Target zones by style (owner's spec). Research agrees: rate is style-invariant, extent separates styles. */
    styles: {
      pop: { rateHz: [5, 7], extentCents: [20, 60] },
      classical: { rateHz: [5, 7], extentCents: [40, 100] },
    } satisfies Record<VibratoStyle, { rateHz: [number, number]; extentCents: [number, number] }>,
    /** Flags (owner's spec). Research puts bleat nearer 7-7.5 Hz and wobble < 4 Hz. */
    wobbleBelowHz: 4.5,
    wobbleAboveExtentCents: 120,
    bleatAboveHz: 8,
    /** Straight tone (NEUTRAL flag, never an error). Owner: ~10 c; research perceptual floor ~13-15 c half-extent. */
    straightBelowExtentCents: 10,
    /** Natural vibrato speeds up ~15% across a long tone: don't call that irregular. */
    rateRampAllowance: 0.15,
  },

  /** 8.4 Transitions & slides. */
  transitions: {
    /** Crack/break: jump > 200 c within < 30 ms ... */
    crackJumpCents: 200,
    crackWithinMs: 30,
    /** ... or a confidence dropout of at least this long in the middle of a glide. */
    dropoutMinMs: 20,
    /** Continuous change shorter than this is heard as a clean step, not a slide. */
    portamentoFloorMs: 20,
    /** Stair-step detection: a plateau this long inside a glide breaks "smooth". PROVISIONAL. */
    stairPlateauMs: 60,
  },

  /** 8.5 Runs & riffs. */
  runs: {
    /** "Reached" = at least 40 ms within +/-50 c. */
    reachedMinMs: 40,
    reachedTolCents: 50,
    /** DTW corridor around nominal note timing. */
    dtwBandMs: 150,
    /** Run score weights (sum 1). PROVISIONAL. */
    weights: { reached: 0.35, accuracy: 0.25, definition: 0.25, timing: 0.15 },
    /** Tempo auto-advances at this run score (owner's spec). */
    tempoAdvanceScore: 0.85,
    /** Notes-per-second ladder (pedagogy benchmark, not peer-reviewed). */
    tempoLadderNps: [3, 4.5, 6, 9, 12],
  },

  /** 8.6 Dynamics. Loudness is RELATIVE (uncalibrated mic): never an absolute dB target. */
  dynamics: {
    /** A swell must span at least this much relative level to count. PROVISIONAL. */
    minRangeDb: 10,
    /** |slope| of cents vs relative dB above which we flag "sharp when loud" / "flat when soft". PROVISIONAL. */
    maxDriftCentsPerDb: 1,
  },

  /** 8.7 Range. */
  range: {
    holdSec: 1,
  },

  /** Latency calibration. Loopback is primary (speaker/earbud -> mic). */
  latency: {
    /** Click spacing must exceed matchWindowMs[1] plus margin, so a missed echo can't be matched to the next click. */
    loopback: { clicks: 10, intervalSec: 0.7, thresholdDb: -35, refractorySec: 0.25, maxJitterMs: 5 },
    /** A sung "ta" is a softer transient than a speaker click: lower threshold, longer refractory. */
    sing: { clicks: 8, intervalSec: 0.9, thresholdDb: -45, refractorySec: 0.3, maxJitterMs: 30 },
    tap: { clicks: 8, intervalSec: 0.9, maxJitterMs: 40 },
    minMatches: 5,
    /** A detected event belongs to a click if it lands within this window after the click.
     *  Bluetooth round trips reach ~300-400 ms (original AirPods ~296 ms output alone). */
    matchWindowMs: [0, 500] as [number, number],
  },

  /** Song mode (Phase 6). */
  song: {
    phraseGapMs: 350,
    dtwBandMs: 200,
    octaveAgnostic: true,
  },

  health: {
    breakReminderMin: 30,
  },
} as const;

export type Config = typeof CONFIG;

/** Hop in samples for an actual context sample rate. */
export function hopSizeFor(sampleRate: number): number {
  return Math.round(sampleRate * CONFIG.audio.hopSeconds);
}
