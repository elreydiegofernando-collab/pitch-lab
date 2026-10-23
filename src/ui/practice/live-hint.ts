/**
 * The live hint's rules (owner, 2026-10-23: "I don't need the note playing along while I'm singing. I need to know the
 * note before I sing it."). While a take runs, one short plain line says what to do right now. The app plays the note
 * first (a Listen step), so then the line is "listen..."; in a rest it is "breathe"; at a sung step with no voice yet it
 * is "sing now"; and once the singer is on the note, what the voice is doing against it decides between "a little
 * higher", "a little lower", "on it", "steady, good" and "a bit wobbly: soften and keep the air even".
 *
 * Pure and DOM-free. The hot path is `push`: one frame into preallocated typed arrays (no allocation, no frame object
 * kept, ~94 times a second). `read` runs a few times a second and allocates nothing either, because its scratch arrays
 * are preallocated too (docs/ARCHITECTURE.md "Performance rules"). The in-tune zone is the one the canvas draws (the
 * level's tolerance), judged against the same take clock as the bars: take time = frame.t - origin (the mapping of
 * PitchView and the take recorder).
 *
 * What it does not judge, so it never coaches against the exercise: the Range finder (the singer goes where the voice
 * goes), glides and slides (their line is a shape, not a pitch), notes too short to read a hint from, and, for steady
 * and wobbly, exercises that ask for vibrato and the wide zone of the first lessons (before Hold it steady teaches those
 * words). Everything below marked PROVISIONAL has no research norm behind it: tune it on real voices.
 */
import { CONFIG } from '../../config';
import type { PitchFrame } from '../../core/types';
import type { RealizedExercise } from '../../exercises/transpose';
import type { ExerciseDef } from '../../exercises/types';

// ---------------------------------------------------------------- what the hint can say

/** 'none' = nothing to say (the hint fades out). */
export type HintKind =
  | 'none'
  | 'listen'
  | 'breathe'
  | 'sing'
  | 'higher'
  | 'lower'
  | 'much-higher'
  | 'much-lower'
  | 'on-it'
  | 'steady'
  | 'wobbly';

/** Quiet = wait, go = your turn, adjust = change something, good = keep doing that. The tone picks the hue, never alone. */
export type HintTone = 'quiet' | 'go' | 'adjust' | 'good';

/** Which glyph goes with the words (the component maps these to icons). Never colour alone: every hint has both. */
export type HintGlyph = 'ear' | 'wind' | 'mic' | 'up' | 'down' | 'target' | 'check' | 'waves';

export interface HintInfo {
  /** Plain words: no cents, Hz or jargon (src/coaching/plain.ts JARGON). */
  text: string;
  glyph: HintGlyph;
  tone: HintTone;
}

export const HINTS: Readonly<Record<Exclude<HintKind, 'none'>, HintInfo>> = {
  listen: { text: 'listen...', glyph: 'ear', tone: 'quiet' },
  breathe: { text: 'breathe', glyph: 'wind', tone: 'quiet' },
  sing: { text: 'sing now', glyph: 'mic', tone: 'go' },
  // "Higher" means sing higher: the voice is flat. "A lot" is a whole step or more off the note.
  higher: { text: 'a little higher', glyph: 'up', tone: 'adjust' },
  lower: { text: 'a little lower', glyph: 'down', tone: 'adjust' },
  'much-higher': { text: 'a lot higher', glyph: 'up', tone: 'adjust' },
  'much-lower': { text: 'a lot lower', glyph: 'down', tone: 'adjust' },
  'on-it': { text: 'on it', glyph: 'target', tone: 'good' },
  steady: { text: 'steady, good', glyph: 'check', tone: 'good' },
  wobbly: { text: 'a bit wobbly: soften and keep the air even', glyph: 'waves', tone: 'adjust' },
};

/** The words, glyph and tone of a hint; null for 'none'. */
export function hintInfo(kind: HintKind): HintInfo | null {
  return kind === 'none' ? null : HINTS[kind];
}

// ---------------------------------------------------------------- tuning (PROVISIONAL)

/** How often the component reads the tracker: a few times a second. The DOM is written only when the hint changes. */
export const HINT_TICK_MS = 200;

/** Frames the ring holds: 2.7 s at the engine's ~94 a second (a power of two, so the index wraps with a mask). */
const CAPACITY = 256;
const MASK = CAPACITY - 1;
const FRAME_RATE = 1 / CONFIG.audio.hopSeconds;
/** A read looks back this far for the current run of voice: the settle and the steady window, and a little more. */
const LOOKBACK_SEC = 2;

/** Silence this long in a sung step means the singer is not singing (a breath or a detector dropout is shorter). */
const VOICE_GAP_SEC = 0.3;
/** A gap in the voicing longer than this ends a run of voice: the note started again. */
const RUN_GAP_SEC = 0.12;

/** A sung step is read from this long after it starts: coming in from the note before is not a mistake to correct. */
const STEP_GRACE_SEC = 0.3;
/** Higher / lower skips this much of the start of a run (the voice finding the note), then reads the last DIRECTION_SEC. */
const DIRECTION_SETTLE_SEC = 0.2;
const DIRECTION_SEC = 0.4;
/** Steady and wobbly skip longer (a beginner's approach to the note takes up to half a second) and read the last STEADY_SEC. */
const STEADY_SETTLE_SEC = 0.35;
const STEADY_SEC = 1;
/** Fewest voiced frames a verdict is read from (about 85 ms of voice). */
const MIN_FRAMES = 8;
/** "Wobbly" needs this much settled voice to read a swing from; "steady" needs about a second, as the hint says. */
const WOBBLE_MIN_SPAN_SEC = 0.8;
const STEADY_MIN_SPAN_SEC = 0.95;
/** Steady also needs the voice present for this share of that second: a voice full of holes is not steady. */
const STEADY_COVERAGE = 0.75;

/**
 * How far the pitch scatters, in cents of standard deviation. "Steady" is under the coach's own "steady" mark (plain.ts
 * steadiness: under 15) over the whole last second; "wobbly" is 20 or more, about where the coach stops saying "a little
 * wavery" (from 15) and says "wavery", so what the singer is told live is what the report says after. Between the two it
 * is "on it": inside the zone, and no claim about steadiness.
 *
 * Wobbly measures only the frames inside the zone. A singer who corrects, from sharp onto the note, has a second that
 * is half one pitch and half another, which is a big scatter and no wobble: the frames outside the zone (the mistake
 * being corrected) are left out, and what is left is judged. Steady measures all of them, so it waits for the correction
 * to leave the window.
 */
const STEADY_SIGMA_CENTS = 14;
const WOBBLE_SIGMA_CENTS = 20;
/** The in-zone frames of the window need this many to be measured, and each half of it this many for the share. */
const MIN_HALF_FRAMES = 4;
/**
 * The share of the last second spent inside the zone. On a wide zone the scatter decides; on a tight one (studio, +-10)
 * a voice that crosses the edge every few frames looks wobbly on the canvas (blue, orange, blue) whatever its scatter:
 * wobbly is under WOBBLE_SHARE in both halves of the second (one half that sits inside is a correction, not a swing),
 * steady is at least STEADY_SHARE overall.
 */
const STEADY_SHARE = 0.85;
const WOBBLE_SHARE = 0.6;
/** A frame this far from the window's middle is a detector glitch (an octave jump, a pop), not singing: left out of the spread. */
const GLITCH_CENTS = 300;
/** From this far off the note (a whole step) the hint says "a lot" higher or lower, not "a little" (the gauge: "Too low"). */
const FAR_CENTS = CONFIG.display.farOffCents;
/** A change between two verdicts must hold this long before it shows, so the line does not flicker at the edge of the zone. */
const PERSIST_SEC = 0.35;

/** Phase hints (sing now, breathe) are shown for steps at least this long: shorter ones cannot be read. */
export const MIN_PHASE_STEP_SEC = 0.6;
/**
 * Higher / lower / on it is judged on held notes at least this long. A verdict needs about 0.4 s of the note before it
 * can speak (the voice coming in, then the grace and the settle), and it has to stay up long enough to be read: on a
 * quicker note (the 0.9 s notes of a scale, the one-second first note of a two-note chunk) the line would flash on and
 * off with every note, which is noise, not help, when the singer is busy landing the notes. Those are about timing, and
 * the canvas and the report carry them.
 */
export const MIN_JUDGED_STEP_SEC = 1.2;
/** Steady / wobbly is judged on holds at least this long. */
export const MIN_STEADY_STEP_SEC = 2;

// ---------------------------------------------------------------- the plan: what each step of the exercise asks

/** One step of the exercise as the hint sees it (take-relative seconds, from the downbeat). */
export interface HintStep {
  role: 'sing' | 'listen' | 'rest';
  start: number;
  end: number;
  /** The note a held step asks for (MIDI); NaN for a rest, and unused for a step that is not judged. */
  midi: number;
  /** Phase hints (sing now, breathe) show here: the step lasts long enough to read one. */
  phase: boolean;
  /** Higher / lower / on it show here: a held note of the exercise, long enough, whose pitch is the point. */
  judged: boolean;
  /** Steady / wobbly show here too: judged, long enough, and the exercise does not ask for vibrato. */
  steady: boolean;
}

export interface HintPlan {
  /** The in-tune zone, +- cents: the one the canvas draws for this level. */
  toleranceCents: number;
  /** In time order. */
  steps: readonly HintStep[];
  /** Spans where the app is playing a note: the starting pitch of the count-in, Listen steps, a new key's first note. */
  tones: ReadonlyArray<{ start: number; end: number }>;
}

function overlaps(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart < bEnd && aEnd > bStart;
}

/** What a plan is made from: a prepared run has both (PreparedRun.def and .realized), and a test can hand-write the slice. */
export interface HintSource {
  def: Pick<ExerciseDef, 'kind' | 'tolerance' | 'analyzers'>;
  realized: Pick<RealizedExercise, 'steps' | 'reference' | 'vibratoPlan'>;
}

/**
 * The plan for one exercise as realized for the singer. Pure, built once per take. A step is judged only where the
 * hint can be right: a held note (never a glide or a slide, whose line is a shape), not in the Range finder, and long
 * enough to read a hint in; steady and wobbly are left out of exercises that ask for vibrato. The held notes of an
 * inflection exercise (the landing of a scoop, the note before a fall) are judged like any other: their own pitch is
 * what the exercise scores there, and the moving steps are glides.
 *
 * Steady and wobbly are also left out on the wide (easy) in-tune zone: that is the first Foundations lessons, before Hold
 * it steady teaches the words "steady" and "wobble" and narrows the zone so a wobble shows. A hint never uses a music
 * word the singer has not been taught (src/lessons); there it says only higher, lower or on it.
 */
export function planHints(def: HintSource['def'], realized: HintSource['realized']): HintPlan {
  const free = def.kind === 'range-finder';
  const vibratoExercise = def.analyzers.includes('vibrato') || def.analyzers.includes('pulse') || def.analyzers.includes('switch');
  const noSteadiness = vibratoExercise || def.tolerance === 'easy';
  const vibratoWindows = realized.vibratoPlan.filter((w) => w.vibrato);
  const steps = realized.steps.map((s): HintStep => {
    const length = s.end - s.start;
    const held = s.role === 'sing' && s.midi !== undefined && s.toMidi === undefined;
    const judged = held && !free && length >= MIN_JUDGED_STEP_SEC;
    const steady =
      judged && !noSteadiness && length >= MIN_STEADY_STEP_SEC && !vibratoWindows.some((w) => overlaps(s.start, s.end, w.start, w.end));
    return { role: s.role, start: s.start, end: s.end, midi: s.midi ?? NaN, phase: length >= MIN_PHASE_STEP_SEC, judged, steady };
  });
  return {
    toleranceCents: CONFIG.tolerance[def.tolerance],
    steps,
    tones: realized.reference.map((n) => ({ start: n.start, end: n.end })),
  };
}

// ---------------------------------------------------------------- the tracker

export interface HintTracker {
  /** Take in the newest engine frame (the engine's onFrame listener). Array writes only: no allocation, no frame kept. */
  readonly push: (frame: PitchFrame) => void;
  /** Frames taken in so far: a reader that sees it stand still knows the engine has stopped delivering. */
  readonly framesSeen: number;
  /**
   * The hint to show now, from the frames so far: `nowT` is engine input-timeline seconds (default: the newest frame's
   * time; silent frames count, so the clock runs while the singer is quiet). A change from one verdict to another shows
   * only once it has held PERSIST_SEC; phase hints and the first verdict of a step show at once.
   */
  read(nowT?: number): HintKind;
}

/** What a read of a sung step finds: a hint, or 'pending' (voice has started, too little of it to judge yet). */
type Verdict = HintKind | 'pending';

/** The verdicts about the voice (the ones that wait to replace each other). */
function isVoiceVerdict(kind: Verdict): boolean {
  return (
    kind === 'higher' ||
    kind === 'lower' ||
    kind === 'much-higher' ||
    kind === 'much-lower' ||
    kind === 'on-it' ||
    kind === 'steady' ||
    kind === 'wobbly'
  );
}

/**
 * A tracker for one take: `origin` is the runner's origin (engine time of take time 0). Create one per take, feed it
 * with `push` from engine.onFrame, and call `read` on a timer.
 */
export function createHintTracker(plan: HintPlan, origin: number): HintTracker {
  const ts = new Float64Array(CAPACITY);
  const midis = new Float64Array(CAPACITY);
  const voiced = new Uint8Array(CAPACITY);
  // Scratch for a read of a sung step: the errors (cents from the note) of the run of voice, newest first, and a sorted copy.
  const errs = new Float64Array(CAPACITY);
  const errT = new Float64Array(CAPACITY);
  const sorted = new Float64Array(CAPACITY);
  const { steps, tones } = plan;
  const tolerance = plan.toleranceCents;

  let head = 0;
  let size = 0;
  let latestT = -Infinity;
  let seen = 0;
  // Where the last read found itself: the step it fell in (-1 in the count-in, a gap or the tail), and the cursor that walks them.
  let cursor = 0;
  let currentStep = -1;
  // What is shown, and what is waiting to replace it.
  let shown: HintKind = 'none';
  let candidate: HintKind = 'none';
  let candidateSince = 0;
  let lastStep = -2;

  function clearRing(): void {
    head = 0;
    size = 0;
    latestT = -Infinity;
  }

  const push = (frame: PitchFrame): void => {
    if (!Number.isFinite(frame.t)) return; // a frame with no time cannot be placed in the take
    if (frame.t < latestT) clearRing(); // the engine restarted on a fresh clock
    ts[head] = frame.t;
    midis[head] = frame.midi;
    voiced[head] = frame.voiced && Number.isFinite(frame.midi) ? 1 : 0;
    head = (head + 1) & MASK;
    if (size < CAPACITY) size++;
    latestT = frame.t;
    seen++;
  };

  /** Median of the first `count` values of `errs`, by insertion into `sorted` (a window is under a hundred values). */
  function medianOfErrors(count: number): number {
    for (let i = 0; i < count; i++) {
      const v = errs[i];
      let j = i - 1;
      while (j >= 0 && sorted[j] > v) {
        sorted[j + 1] = sorted[j];
        j--;
      }
      sorted[j + 1] = v;
    }
    const mid = count >> 1;
    return (count & 1) === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  }

  /** Index of the step that covers take time `takeT`, or -1 (before the first step, in a gap, or past the last). */
  function stepIndexAt(takeT: number): number {
    const n = steps.length;
    if (n === 0 || takeT < steps[0].start || takeT >= steps[n - 1].end) return -1;
    while (cursor < n - 1 && takeT >= steps[cursor].end) cursor++;
    while (cursor > 0 && takeT < steps[cursor].start) cursor--;
    return takeT >= steps[cursor].start && takeT < steps[cursor].end ? cursor : -1;
  }

  function toneAt(takeT: number): boolean {
    for (let i = 0; i < tones.length; i++) if (takeT >= tones[i].start && takeT < tones[i].end) return true;
    return false;
  }

  /**
   * What the last second (the first `inWindow` errors, newest first, `span` seconds long) says about steadiness:
   * 'wobbly', 'steady', or null for no claim either way. `aim` is where the voice has just been against the note.
   */
  function readSteadiness(inWindow: number, span: number, aim: number): 'wobbly' | 'steady' | null {
    const centre = medianOfErrors(inWindow);
    // The second in two halves (the newer is [0, half)): for how much of each is spent inside the zone.
    const half = inWindow >> 1;
    let kept = 0;
    let sum = 0;
    let inside = 0;
    let insideSum = 0;
    let newKept = 0;
    let newInside = 0;
    let oldKept = 0;
    let oldInside = 0;
    for (let j = 0; j < inWindow; j++) {
      const e = errs[j];
      if (Math.abs(e - centre) > GLITCH_CENTS) continue;
      const within = Math.abs(e) <= tolerance;
      kept++;
      sum += e;
      if (within) {
        inside++;
        insideSum += e;
      }
      if (j < half) {
        newKept++;
        if (within) newInside++;
      } else {
        oldKept++;
        if (within) oldInside++;
      }
    }
    if (kept < MIN_FRAMES || newKept < MIN_HALF_FRAMES || oldKept < MIN_HALF_FRAMES) return null;
    const mean = sum / kept;
    const insideMean = inside > 0 ? insideSum / inside : 0;
    let squares = 0;
    let insideSquares = 0;
    for (let j = 0; j < inWindow; j++) {
      const e = errs[j];
      if (Math.abs(e - centre) > GLITCH_CENTS) continue;
      squares += (e - mean) * (e - mean);
      if (Math.abs(e) <= tolerance) insideSquares += (e - insideMean) * (e - insideMean);
    }
    const sigma = Math.sqrt(squares / kept);
    const insideSigma = inside >= MIN_FRAMES ? Math.sqrt(insideSquares / inside) : 0;
    // Inside on average but swinging: wobbly, whichever side the last few frames happen to sit on.
    if (Math.abs(centre) <= tolerance && (insideSigma >= WOBBLE_SIGMA_CENTS || Math.max(newInside / newKept, oldInside / oldKept) < WOBBLE_SHARE)) {
      return 'wobbly';
    }
    if (
      Math.abs(aim) <= tolerance &&
      span >= STEADY_MIN_SPAN_SEC &&
      kept >= STEADY_COVERAGE * span * FRAME_RATE &&
      sigma <= STEADY_SIGMA_CENTS &&
      inside / kept >= STEADY_SHARE
    ) {
      return 'steady';
    }
    return null;
  }

  /** What the voice is doing in a sung step. */
  function readSing(step: HintStep, nowT: number): Verdict {
    const stepStart = origin + step.start;
    // Walk back over the frames of this step: the newest voiced one, where its run of voice began, and (when the step is
    // judged) the error of every voiced frame in that run against the step's note.
    let lastVoicedT = -Infinity;
    let prevT = Infinity;
    let runStart = Infinity;
    let count = 0;
    for (let k = 0; k < size; k++) {
      const i = (head - 1 - k) & MASK;
      const t = ts[i];
      if (t < stepStart || nowT - t > LOOKBACK_SEC) break;
      if (t > nowT || voiced[i] === 0) continue;
      if (lastVoicedT === -Infinity) lastVoicedT = t;
      else if (prevT - t > RUN_GAP_SEC) break;
      prevT = t;
      runStart = t;
      if (step.judged) {
        errs[count] = (midis[i] - step.midi) * 100;
        errT[count] = t;
        count++;
      }
    }
    if (lastVoicedT === -Infinity || nowT - lastVoicedT > VOICE_GAP_SEC) return 'sing';
    if (!step.judged) return 'none';

    // The last DIRECTION_SEC of the run, once its first moments are past: where the voice is against the note.
    const settled = stepStart + STEP_GRACE_SEC;
    const directionFrom = Math.max(runStart + DIRECTION_SETTLE_SEC, settled, nowT - DIRECTION_SEC);
    let recent = 0;
    while (recent < count && errT[recent] >= directionFrom) recent++;
    if (recent < MIN_FRAMES) return 'pending';
    const aim = medianOfErrors(recent);

    // The last second of it, for the spread: only on holds long enough to be asked to be steady.
    if (step.steady) {
      const steadyFrom = Math.max(runStart + STEADY_SETTLE_SEC, settled, nowT - STEADY_SEC);
      let inWindow = 0;
      while (inWindow < count && errT[inWindow] >= steadyFrom) inWindow++;
      const span = inWindow > 0 ? errT[0] - errT[inWindow - 1] : 0;
      if (inWindow >= MIN_FRAMES && span >= WOBBLE_MIN_SPAN_SEC) {
        const claim = readSteadiness(inWindow, span, aim);
        if (claim !== null) return claim;
      }
    }

    if (Math.abs(aim) <= tolerance) return 'on-it';
    // Flat (negative error) means sing higher.
    if (Math.abs(aim) >= FAR_CENTS) return aim < 0 ? 'much-higher' : 'much-lower';
    return aim < 0 ? 'higher' : 'lower';
  }

  /** The verdict for `nowT` before the hysteresis; it leaves the step it fell in in `currentStep`. */
  function readRaw(nowT: number): Verdict {
    const takeT = nowT - origin;
    currentStep = takeT < 0 ? -1 : stepIndexAt(takeT);
    if (toneAt(takeT)) return 'listen'; // the app is playing a note: listen, whatever the step says
    if (currentStep < 0) return 'none'; // the count-in, or the tail after the last step
    const step = steps[currentStep];
    if (step.role === 'listen') return 'listen';
    if (!step.phase) return 'none';
    return step.role === 'rest' ? 'breathe' : readSing(step, nowT);
  }

  /** The hysteresis: phase hints and the first verdict of a step show at once, a change between verdicts waits to hold. */
  function settle(raw: Verdict, nowT: number): HintKind {
    if (currentStep !== lastStep) {
      lastStep = currentStep;
      shown = 'none';
      candidate = 'none';
    }
    if (raw === 'pending') {
      // Voice has just started (or just come back): keep what is shown for this step, else say nothing.
      if (!isVoiceVerdict(shown)) shown = 'none';
      return shown;
    }
    if (!isVoiceVerdict(raw) || !isVoiceVerdict(shown)) {
      shown = raw;
      candidate = raw;
      return shown;
    }
    if (raw === shown) {
      candidate = raw;
      return shown;
    }
    if (candidate !== raw) {
      candidate = raw;
      candidateSince = nowT;
    }
    if (nowT - candidateSince >= PERSIST_SEC) shown = raw;
    return shown;
  }

  return {
    push,
    get framesSeen(): number {
      return seen;
    },
    read(nowT: number = latestT): HintKind {
      if (!Number.isFinite(nowT)) return 'none';
      return settle(readRaw(nowT), nowT);
    },
  };
}
