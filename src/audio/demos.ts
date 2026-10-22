/**
 * Listen demos: `buildDemo` plays an exercise the way it should be sung, on
 * the AudioContext clock, so the singer hears the goal before trying it
 * (SPEC §9: every exercise has a Listen button; the vibrato demo is a tone
 * with vibrato at the target zone).
 *
 * A demo is the exercise's own reference audio (count-in clicks, the starting
 * pitch, "Listen" steps) plus a synthesized model performance of its target
 * notes. It is built in two stages so each can be tested alone:
 *
 *  1. `planDemoVoices` (pure): the realized notes become VOICES. Like the
 *     analysis plan (src/exercises/plan.ts), it groups notes into HOLDS (back
 *     to back on one pitch) and reads what each hold means from its cues:
 *     vibrato windows (straight / bloom / vibrato on), a pulse train, a dynamic
 *     shape or soft/loud steps. A hold-glide-hold chain (slide, scoop, fall,
 *     siren) becomes one voice. Everything else stays plain notes.
 *  2. `buildDemo` schedules the voices on the injected synth. Plain notes go
 *     out as one `playSequence`; sustained vibrato and pulses as `playNote`
 *     with a VibratoSpec (delaySec + fadeInSec blooms it on cue); a single
 *     hold-glide-hold as `playGlide`. The synth API cannot express an
 *     amplitude shape, a multi-segment glide or vibrato that switches off, so
 *     those few voices (swells, soft/loud steps, falls, up-and-down sirens,
 *     vibrato switching) are small oscillator + gain voices built here on the
 *     provided ctx/dest, with the synth's timbres and click-free envelopes.
 *
 * Intent comes from DATA, not from the exercise kind alone (cues, analyzers,
 * the demo spec), so Boss Recitals and auditions, which chain several skills,
 * demo each part correctly.
 */
import { CONFIG } from '../config';
import { clamp01 } from '../core/math';
import { midiToHz } from '../core/music';
import type { TargetNote, VibratoStyle } from '../core/types';
import { CUE, DYNAMIC_CUES, VIBRATO_CUES, type DynamicShape } from '../exercises/cues';
import { PLAN } from '../exercises/plan';
import type { ExerciseDef, ExerciseKind } from '../exercises/types';
import type {
  MetronomeHandle,
  ReferenceSynth,
  ScheduledHandle,
  SequenceNote,
  Timbre,
  VibratoSpec,
} from './synth-types';

// ---------------------------------------------------------------- demo-synthesis constants
// Presentation details of the demo voices, not analysis thresholds (those live in CONFIG).

/** Seconds over which vibrato fades in when it blooms on cue (CUE.bloom). */
export const BLOOM_FADE_IN_SEC = 0.3;
/** Seconds a vibrato switch takes (CUE.vibrato on, or any switch back to straight): quicker than a bloom. */
export const SWITCH_FADE_SEC = 0.1;
/** Free-vibrato demos only put vibrato on notes at least this long. */
export const MIN_VIBRATO_NOTE_SEC = 0.6;
/** Pitch pulses are rendered as a slow, wide sine wobble of +/- this many cents at the pulse rate. */
export const PULSE_DEMO_EXTENT_CENTS = 45;
/** A pulse train is at least this many steps on one pitch: the analysis plan's own minimum, so a demo and the scoring agree on what a pulse train is. */
export const MIN_PULSE_STEPS = PLAN.pulseMinSteps;
/** The quiet end of a swell / dynamic step, as a fraction of the loud end (about -18 dB: clearly softer, still audible). */
export const SWELL_SOFT_GAIN = 0.12;
/** How far a fall-off fades by the bottom of the fall. */
export const FALL_END_GAIN = 0.12;
/** Duration of the (click-free) level change between dynamic steps. */
export const STEP_RAMP_SEC = 0.06;
/** A slowFirst demo with no tempo ladder plays its first pass at this share of the tempo. */
export const SLOW_DEMO_FACTOR = 0.6;
/** Silence between a slow pass and the pass at tempo. */
export const PASS_GAP_SEC = 0.8;
/** Default demo level (the Settings reference-volume default). Pass `opts.gain` = the singer's reference volume. */
export const DEFAULT_DEMO_GAIN = 0.7;
/** Lead before the first sound when no `startAt` is given, so nothing is scheduled in the past. */
const START_LEAD_SEC = 0.05;
const DEFAULT_VIBRATO_STYLE: VibratoStyle = 'pop';

/** Same release and stop padding as synth.ts, so custom voices end exactly like synth voices. */
const RELEASE_SEC = 0.06;
const STOP_PAD_SEC = 0.01;
/** Attack of the custom voices per timbre (matches synth.ts ENVELOPES). */
const ATTACK_SEC: Record<Timbre, number> = { piano: 0.005, soft: 0.03, sine: 0.01 };
/** Partial tables (same as synth.ts) so a custom voice sounds like its synth sibling. Index 0 is DC and ignored. */
const PARTIALS: Record<Exclude<Timbre, 'sine'>, readonly number[]> = {
  piano: [0, 1, 0.6, 0.4, 0.25, 0.16, 0.1, 0.07, 0.05],
  soft: [0, 1, 0.3, 0.1],
};
/** Exponential ramps need a strictly positive target. */
const MIN_RAMP_GAIN = 1e-4;
const EPS = 1e-6;

// ---------------------------------------------------------------- types

/**
 * What a demo needs from `realize()` (src/exercises/transpose.ts); a
 * RealizedExercise satisfies it. Times are seconds from the downbeat (take
 * time 0). Intent (vibrato windows, dynamics, falls) is read from `cues`,
 * which holds one entry per cued step, at that step's start time.
 */
export interface DemoRealized {
  tonicMidi: number;
  /** Sung targets. Glides carry `toMidi`. */
  notes: readonly TargetNote[];
  cues: ReadonlyArray<{ t: number; text: string }>;
  /** Tones the synth plays but the singer does not sing: Listen steps, the starting pitch (start < 0 = during the count-in). */
  reference?: readonly TargetNote[];
  bpm?: number;
  countInSec?: number;
  /** From the downbeat to the end of the last step (trailing rests included). */
  totalSec?: number;
}

export interface DemoOptions {
  /** AudioContext time the demo begins sounding (the count-in, when there is one). Default: now + a short lead. */
  startAt?: number;
  /** Vibrato zone for `demo.vibrato === 'style'`. Default 'pop'. */
  vibratoStyle?: VibratoStyle;
  /** Linear 0..1 level of every demo voice (the singer's reference volume). Default DEFAULT_DEMO_GAIN. */
  gain?: number;
  /** Play a slow pass first, then the pass at tempo. Default `def.demo.slowFirst`. */
  slowFirst?: boolean;
  /** Tempo of the slow pass. Default: the bottom of the tempo ladder, else SLOW_DEMO_FACTOR of the tempo. */
  slowBpm?: number;
  /** Play only the first this-many seconds of the pattern (e.g. `firstPassSec(def, bpm)` for one repetition). */
  maxSec?: number;
}

type LevelCurve = 'set' | 'linear' | 'exp';
/** Gain breakpoint of a custom voice. `gain` is a fraction of the voice peak; `t` is seconds from the voice start. */
export interface LevelPoint {
  t: number;
  gain: number;
  curve: LevelCurve;
}

export type DemoVoice =
  /** Plain notes: one `synth.playSequence` for the whole pass. Reference tones are included (start may be < 0). */
  | { kind: 'sequence'; notes: SequenceNote[] }
  /** One sustained tone, optionally with vibrato (free vibrato, bloom, pulses): `synth.playNote`. */
  | { kind: 'note'; midi: number; start: number; duration: number; vibrato?: VibratoSpec }
  /** One hold-glide-hold: `synth.playGlide`. */
  | { kind: 'glide'; fromMidi: number; toMidi: number; start: number; holdBefore: number; glideDuration: number; holdAfter: number }
  /** A voice the synth API cannot express: a pitch path, an amplitude shape and/or switchable vibrato. */
  | {
      kind: 'shaped';
      start: number;
      duration: number;
      timbre: Timbre;
      /** Pitch anchors (seconds from the voice start, first at 0); exponential in Hz between them = linear in pitch. */
      pitch: Array<{ t: number; midi: number }>;
      /** Level at the end of the attack, then breakpoints. */
      initialGain: number;
      level: LevelPoint[];
      vibrato?: { rateHz: number; extentCents: number; depth: Array<{ t: number; frac: number }> };
    };

type Level = 'soft' | 'loud';

export interface SwellShape {
  /** Dynamic stops in time order. */
  points: Level[];
  /** true: ramps between the stops (crescendo, decrescendo, messa di voce); false: abrupt steps on equal parts of the note. */
  smooth: boolean;
}

/** The stops of each dynamic cue in src/exercises/cues.ts. */
const DYNAMIC_SHAPES: Record<DynamicShape, SwellShape> = {
  crescendo: { points: ['soft', 'loud'], smooth: true },
  decrescendo: { points: ['loud', 'soft'], smooth: true },
  swell: { points: ['soft', 'loud', 'soft'], smooth: true }, // messa di voce
};

// ---------------------------------------------------------------- per-kind traits (exhaustive on purpose)

interface KindTraits {
  /** Back-to-back same-pitch notes are a pulse train on one tone. (Analyzers containing 'pulse' also turn this on.) */
  pulses: boolean;
  /** Every descending hold-glide is a fall-off that fades as it drops. (Exercises that chain skills mark a fall with CUE.fall.) */
  falls: boolean;
}
const NONE: KindTraits = { pulses: false, falls: false };
/**
 * Typed as a Record over ExerciseKind so adding a kind to the contract is a
 * compile error here until its demo behaviour is decided. Everything else is
 * read from cues, analyzers and the demo spec; kinds whose demo needs nothing
 * special still appear, as NONE, on purpose.
 */
const KIND_TRAITS: Record<ExerciseKind, KindTraits> = {
  'range-finder': NONE,
  'pitch-match': NONE,
  sustain: NONE,
  siren: NONE,
  staccato: NONE,
  intervals: NONE,
  legato: NONE,
  'vibrato-meter': NONE,
  'pulse-builder': { ...NONE, pulses: true },
  oscillation: NONE, // alternates two pitches: discrete notes, not a wobble
  'straight-to-bloom': NONE,
  'vibrato-switch': NONE,
  scoop: NONE,
  fall: { ...NONE, falls: true },
  slide: NONE,
  turn: NONE,
  flip: NONE,
  run: NONE,
  swell: NONE, // shapes come from CUE.crescendo / decrescendo / swell and Soft / Loud steps
  'boss-recital': NONE,
  audition: NONE,
};

// ---------------------------------------------------------------- vibrato helpers

const mid = (r: readonly [number, number]): number => (r[0] + r[1]) / 2;

/** The vibrato zone midpoint of a style: what "vibrato at the target zone" sounds like. */
export function styleZoneVibrato(style: VibratoStyle): VibratoSpec {
  const z = CONFIG.vibrato.styles[style];
  return { rateHz: mid(z.rateHz), extentCents: mid(z.extentCents) };
}

/** VibratoSpec for a demo: 'style' -> the style zone midpoint; an explicit spec is copied; null/undefined -> null. */
export function resolveDemoVibrato(v: ExerciseDef['demo']['vibrato'], style: VibratoStyle): VibratoSpec | null {
  if (v === 'style') return styleZoneVibrato(style);
  return v ? { ...v } : null;
}

// ---------------------------------------------------------------- dynamics cues

const SOFT_WORDS = new Set(['soft', 'softly', 'quiet', 'quietly', 'whisper', 'hushed', 'piano', 'pianissimo', 'pp']);
const LOUD_WORDS = new Set(['loud', 'full', 'forte', 'strong', 'big']);
const GROW_WORDS = new Set(['grow', 'crescendo', 'swell', 'build', 'louder', 'increase']);
const FADE_WORDS = new Set(['fade', 'decrescendo', 'diminuendo', 'taper', 'softer', 'decrease']);

const wordsOf = (text: string): string[] => text.toLowerCase().match(/[a-z]+/g) ?? [];

/**
 * A step cue that names ONE level ("Soft", "Loud", "Whisper", "Full"), for
 * soft/loud step drills. A cue that mixes levels or contains a growth or fade
 * verb is a shape, not a level (see `parseSwellShape`). Null otherwise.
 */
export function levelOfCue(cue: string | undefined): Level | null {
  if (!cue) return null;
  let soft = false;
  let loud = false;
  for (const w of wordsOf(cue)) {
    if (GROW_WORDS.has(w) || FADE_WORDS.has(w)) return null;
    if (SOFT_WORDS.has(w)) soft = true;
    else if (LOUD_WORDS.has(w)) loud = true;
  }
  return soft !== loud ? (soft ? 'soft' : 'loud') : null;
}

/**
 * Read FREE-TEXT dynamics cue ("Soft, grow, then fade: pitch still") as a
 * shape, for exercise packs that do not use the CUE.crescendo / decrescendo /
 * swell constants. Level words are stops; a growth or fade verb joins stops
 * with a smooth ramp and implies the missing stop on its other side, so "Start
 * soft, grow to full" is soft->loud, "Fade to a whisper" is loud->soft and
 * "Soft, grow, then fade" is soft->loud->soft. Level words with no verb
 * between them are abrupt steps. Null when the cue names fewer than two stops.
 */
export function parseSwellShape(cue: string | undefined): SwellShape | null {
  if (!cue) return null;
  const points: Level[] = [];
  let target: Level | null = null; // the stop a pending verb is heading for
  let smooth = false;
  const push = (l: Level): void => {
    if (points[points.length - 1] !== l) points.push(l);
  };
  const settle = (): void => {
    if (target) {
      push(target);
      target = null;
    }
  };
  for (const w of wordsOf(cue)) {
    if (SOFT_WORDS.has(w) || LOUD_WORDS.has(w)) {
      const l: Level = SOFT_WORDS.has(w) ? 'soft' : 'loud';
      if (target === l) target = null;
      else settle();
      push(l);
    } else if (GROW_WORDS.has(w) || FADE_WORDS.has(w)) {
      settle();
      smooth = true;
      const from: Level = GROW_WORDS.has(w) ? 'soft' : 'loud';
      push(from);
      target = from === 'soft' ? 'loud' : 'soft';
    }
  }
  settle();
  return points.length >= 2 ? { points, smooth } : null;
}

const levelGain = (l: Level): number => (l === 'loud' ? 1 : SWELL_SOFT_GAIN);

/** Gain breakpoints for a swell over `dur` seconds (see SwellShape). */
function swellLevels(shape: SwellShape, dur: number): { initialGain: number; level: LevelPoint[] } {
  const n = shape.points.length;
  const level: LevelPoint[] = [];
  if (shape.smooth) {
    for (let i = 1; i < n; i++) level.push({ t: (dur * i) / (n - 1), gain: levelGain(shape.points[i]), curve: 'exp' });
  } else {
    const seg = dur / n;
    for (let i = 1; i < n; i++) {
      const half = Math.min(STEP_RAMP_SEC, seg) / 2;
      level.push({ t: seg * i - half, gain: levelGain(shape.points[i - 1]), curve: 'set' });
      level.push({ t: seg * i + half, gain: levelGain(shape.points[i]), curve: 'linear' });
    }
  }
  return { initialGain: levelGain(shape.points[0]), level };
}

// ---------------------------------------------------------------- planning (pure)

/** A realized layout with every field present; times in seconds from the downbeat of one pass. */
export interface DemoLayout {
  notes: TargetNote[];
  reference: TargetNote[];
  cues: Array<{ t: number; text: string }>;
  totalSec: number;
  countInSec: number;
}

/** A sung note with the cue that starts on it. */
interface Note {
  start: number;
  end: number;
  midi: number;
  toMidi: number | null;
  cue: string | undefined;
}

/** What a hold means, read from its cues (first match wins, in this order). */
type HoldRole = 'vibrato' | 'pulse' | 'dynamic' | 'free-vibrato' | 'plain';

interface Hold {
  type: 'hold';
  notes: Note[];
  start: number;
  end: number;
  midi: number;
  role: HoldRole;
}
interface Glide {
  type: 'glide';
  start: number;
  end: number;
  midi: number;
  toMidi: number;
}
type Unit = Hold | Glide;

/** How a dynamic hold sounds: one shape across the hold, or a level per step. */
type Dynamics =
  | { kind: 'shape'; shape: SwellShape; from: number }
  | { kind: 'steps'; steps: Array<{ start: number; end: number; level: Level }> };

const samePitch = (a: number, b: number): boolean => Math.abs(a - b) < 1e-9;
const touching = (aEnd: number, bStart: number): boolean => Math.abs(bStart - aEnd) < EPS;
const startPitch = (u: Unit): number => u.midi;
const endPitch = (u: Unit): number => (u.type === 'glide' ? u.toMidi : u.midi);

/**
 * Turn a layout into voices (see the file header). Pure: no synth, no clock.
 * Voice times are relative to the downbeat and may be negative (count-in).
 */
export function planDemoVoices(def: ExerciseDef, layout: DemoLayout, style: VibratoStyle): DemoVoice[] {
  const traits = KIND_TRAITS[def.kind];
  const timbre = def.demo.timbre; // custom voices use it too: they sustain at their level, whatever the timbre
  const spec = resolveDemoVibrato(def.demo.vibrato, style);
  const pulseMode = traits.pulses || def.analyzers.includes('pulse');
  const dynamicsMode = def.kind === 'swell' || def.analyzers.includes('dynamics');

  const plain: SequenceNote[] = [];
  const voices: DemoVoice[] = [];

  // Reference audio first: tones the synth plays and the singer listens to.
  for (const r of layout.reference) {
    if (r.end - r.start > EPS) plain.push({ midi: r.midi, start: r.start, duration: r.end - r.start });
  }

  const cueAt = (t: number): string | undefined => {
    let found: string | undefined;
    for (const c of layout.cues) if (Math.abs(c.t - t) < EPS) found = c.text;
    return found;
  };

  // ---- notes -> units: holds (back to back, one pitch) and glides
  const notes: Note[] = layout.notes
    .filter((n) => n.end - n.start > EPS)
    .sort((a, b) => a.start - b.start)
    .map((n) => ({ start: n.start, end: n.end, midi: n.midi, toMidi: n.toMidi === undefined ? null : n.toMidi, cue: cueAt(n.start) }));

  const dynamicsOf = (h: Hold): Dynamics | null => {
    for (const n of h.notes) {
      const shape = n.cue !== undefined ? DYNAMIC_CUES.get(n.cue) : undefined;
      if (shape) return { kind: 'shape', shape: DYNAMIC_SHAPES[shape], from: n.start };
    }
    let any = false;
    let level: Level = 'loud';
    const steps: Array<{ start: number; end: number; level: Level }> = [];
    for (const n of h.notes) {
      const l = levelOfCue(n.cue);
      if (l) {
        level = l;
        any = true;
      }
      steps.push({ start: n.start, end: n.end, level });
    }
    if (any) return { kind: 'steps', steps };
    const text = parseSwellShape(h.notes[0].cue);
    return text ? { kind: 'shape', shape: text, from: h.start } : null;
  };

  const roleOf = (h: Hold): HoldRole => {
    if (h.notes.some((n) => n.cue !== undefined && VIBRATO_CUES.has(n.cue))) return 'vibrato';
    if (pulseMode && h.notes.length >= MIN_PULSE_STEPS) return 'pulse';
    if (dynamicsMode && dynamicsOf(h) !== null) return 'dynamic';
    if (spec && h.end - h.start >= MIN_VIBRATO_NOTE_SEC) return 'free-vibrato';
    return 'plain';
  };

  const units: Unit[] = [];
  for (const n of notes) {
    if (n.toMidi !== null) {
      units.push({ type: 'glide', start: n.start, end: n.end, midi: n.midi, toMidi: n.toMidi });
      continue;
    }
    const last = units[units.length - 1];
    if (last && last.type === 'hold' && touching(last.end, n.start) && samePitch(last.midi, n.midi)) {
      last.notes.push(n);
      last.end = n.end;
    } else {
      units.push({ type: 'hold', notes: [n], start: n.start, end: n.end, midi: n.midi, role: 'plain' });
    }
  }
  for (const u of units) if (u.type === 'hold') u.role = roleOf(u);

  // ---- emitters
  const joined = (a: Unit, b: Unit): boolean => touching(a.end, b.start) && samePitch(endPitch(a), startPitch(b));

  const emitPlain = (h: Hold): void => {
    for (const n of h.notes) plain.push({ midi: n.midi, start: n.start, duration: n.end - n.start });
  };

  const emitVibratoHold = (h: Hold): void => {
    // Vibrato state per note: a vibrato cue sets it, and it holds over the following uncued notes of the hold.
    const states: Array<{ start: number; end: number; on: boolean; fadeIn: number }> = [];
    let on = false;
    let fadeIn = SWITCH_FADE_SEC;
    for (const n of h.notes) {
      const v = n.cue !== undefined ? VIBRATO_CUES.get(n.cue) : undefined;
      if (v !== undefined) {
        if (v && !on) fadeIn = n.cue === CUE.bloom ? BLOOM_FADE_IN_SEC : SWITCH_FADE_SEC;
        on = v;
      }
      const last = states[states.length - 1];
      if (last && last.on === on) last.end = n.end;
      else states.push({ start: n.start, end: n.end, on, fadeIn });
    }
    const vib = spec ?? styleZoneVibrato(style); // a bloom demo with no vibrato would be useless
    const dur = h.end - h.start;
    if (states.length === 1) {
      if (states[0].on) voices.push({ kind: 'note', midi: h.midi, start: h.start, duration: dur, vibrato: vib });
      else plain.push({ midi: h.midi, start: h.start, duration: dur });
      return;
    }
    if (states.length === 2 && !states[0].on) {
      // Straight, then vibrato on the cue, inside ONE tone: the synth's native delaySec + fadeInSec.
      voices.push({
        kind: 'note',
        midi: h.midi,
        start: h.start,
        duration: dur,
        vibrato: { ...vib, delaySec: states[0].end - h.start, fadeInSec: Math.min(states[1].fadeIn, states[1].end - states[1].start) },
      });
      return;
    }
    // Vibrato that switches off (or on again): one tone, with the vibrato depth switched on the cues.
    const depth: Array<{ t: number; frac: number }> = [{ t: 0, frac: states[0].on ? 1 : 0 }];
    for (let i = 1; i < states.length; i++) {
      const b = states[i].start - h.start;
      const fade = Math.min(states[i].on ? states[i].fadeIn : SWITCH_FADE_SEC, states[i].end - states[i].start);
      const from = states[i].on ? 0 : 1;
      depth.push({ t: b, frac: from }, { t: b + fade, frac: 1 - from });
    }
    voices.push({
      kind: 'shaped',
      start: h.start,
      duration: dur,
      timbre,
      pitch: [{ t: 0, midi: h.midi }],
      initialGain: 1,
      level: [],
      vibrato: { rateHz: vib.rateHz, extentCents: vib.extentCents, depth },
    });
  };

  const emitPulseHold = (h: Hold): void => {
    const span = h.end - h.start;
    voices.push({
      kind: 'note',
      midi: h.midi,
      start: h.start,
      duration: span,
      vibrato: { rateHz: h.notes.length / span, extentCents: PULSE_DEMO_EXTENT_CENTS },
    });
  };

  const emitDynamicHold = (h: Hold): void => {
    const dyn = dynamicsOf(h);
    if (!dyn) return emitPlain(h);
    if (dyn.kind === 'shape') {
      // The shape spans the hold from the cued note on (normally the whole hold).
      if (dyn.from - h.start > EPS) plain.push({ midi: h.midi, start: h.start, duration: dyn.from - h.start });
      const dur = h.end - dyn.from;
      const { initialGain, level } = swellLevels(dyn.shape, dur);
      voices.push({ kind: 'shaped', start: dyn.from, duration: dur, timbre, pitch: [{ t: 0, midi: h.midi }], initialGain, level });
      return;
    }
    // Soft/loud steps: ONE tone, abrupt (but click-free) level changes on the step boundaries.
    const level: LevelPoint[] = [];
    for (let i = 1; i < dyn.steps.length; i++) {
      const prev = dyn.steps[i - 1];
      const cur = dyn.steps[i];
      if (prev.level === cur.level) continue;
      const half = Math.min(STEP_RAMP_SEC, prev.end - prev.start, cur.end - cur.start) / 2;
      const b = cur.start - h.start;
      level.push({ t: b - half, gain: levelGain(prev.level), curve: 'set' }, { t: b + half, gain: levelGain(cur.level), curve: 'linear' });
    }
    voices.push({
      kind: 'shaped',
      start: h.start,
      duration: h.end - h.start,
      timbre,
      pitch: [{ t: 0, midi: h.midi }],
      initialGain: levelGain(dyn.steps[0].level),
      level,
    });
  };

  const emitHold = (h: Hold): void => {
    switch (h.role) {
      case 'vibrato':
        return emitVibratoHold(h);
      case 'pulse':
        return emitPulseHold(h);
      case 'dynamic':
        return emitDynamicHold(h);
      case 'free-vibrato':
        voices.push({ kind: 'note', midi: h.midi, start: h.start, duration: h.end - h.start, vibrato: { ...(spec as VibratoSpec) } });
        return;
      case 'plain':
        return emitPlain(h);
    }
  };

  const emitGlideChain = (chain: Unit[]): void => {
    const start = chain[0].start;
    const end = chain[chain.length - 1].end;
    const glides = chain.filter((u): u is Glide => u.type === 'glide');
    const g = glides[0];
    const first = chain[0];
    const isFall =
      glides.length === 1 &&
      g.toMidi < g.midi &&
      (traits.falls || (first.type === 'hold' && first.notes[0].cue === CUE.fall));

    if (glides.length === 1 && !isFall) {
      voices.push({
        kind: 'glide',
        fromMidi: g.midi,
        toMidi: g.toMidi,
        start,
        holdBefore: g.start - start,
        glideDuration: g.end - g.start,
        holdAfter: end - g.end,
      });
      return;
    }
    // A multi-segment path (an up-and-down siren) or a fall that fades: one oscillator following the whole path.
    const pitch: Array<{ t: number; midi: number }> = [{ t: 0, midi: first.midi }];
    for (const u of chain) pitch.push({ t: u.end - start, midi: endPitch(u) });
    const level: LevelPoint[] = isFall
      ? [
          { t: g.start - start, gain: 1, curve: 'set' },
          { t: g.end - start, gain: FALL_END_GAIN, curve: 'exp' },
        ]
      : [];
    voices.push({ kind: 'shaped', start, duration: end - start, timbre, pitch, initialGain: 1, level });
  };

  // ---- walk the units: glide chains (hold-glide-hold, glide-glide) become one voice, holds follow their role
  let u = 0;
  while (u < units.length) {
    const first = units[u];
    const second = units[u + 1];
    const chain: Unit[] = [];
    if (first.type === 'glide') chain.push(first);
    else if (first.role === 'plain' && second && second.type === 'glide' && joined(first, second)) chain.push(first, second);
    if (chain.length === 0) {
      emitHold(first as Hold);
      u++;
      continue;
    }
    u += chain.length;
    for (;;) {
      const next = units[u];
      if (!next || !joined(chain[chain.length - 1], next)) break;
      if (next.type === 'hold' && next.role !== 'plain') break; // a hold that carries vibrato or a shape is its own tone
      chain.push(next);
      u++;
    }
    emitGlideChain(chain);
  }

  if (plain.length > 0) voices.unshift({ kind: 'sequence', notes: plain.sort((a, b) => a.start - b.start) });
  return voices;
}

/**
 * Seconds of ONE repetition of the pattern at `bpm` (for `opts.maxSec`: demo
 * the idea once instead of every transposed repeat).
 */
export function firstPassSec(def: Pick<ExerciseDef, 'pattern'>, bpm: number): number {
  let beats = 0;
  for (const s of def.pattern) beats += s.beats;
  return (beats * 60) / bpm;
}

// ---------------------------------------------------------------- layout helpers

/** The layout a demo plays: `realized` with every optional field filled in. `bpm` defaults to the exercise's. */
export function demoLayout(def: ExerciseDef, r: DemoRealized, bpm: number = r.bpm ?? def.tempoBpm): DemoLayout {
  const countInSec = r.countInSec ?? (Math.max(0, def.countInBeats) * 60) / bpm;
  let end = 0;
  for (const n of r.notes) end = Math.max(end, n.end);
  for (const n of r.reference ?? []) end = Math.max(end, n.end);
  return {
    notes: r.notes.map((n) => ({ ...n })),
    reference: (r.reference ?? []).map((n) => ({ ...n })),
    cues: r.cues.map((c) => ({ ...c })),
    totalSec: r.totalSec ?? end,
    countInSec,
  };
}

/** Multiply every time by `s` (a slowed pass: s = tempo / slowTempo). */
function scaleLayout(l: DemoLayout, s: number): DemoLayout {
  if (s === 1) return l;
  const scaleNote = (n: TargetNote): TargetNote => ({ ...n, start: n.start * s, end: n.end * s });
  return {
    notes: l.notes.map(scaleNote),
    reference: l.reference.map(scaleNote),
    cues: l.cues.map((c) => ({ ...c, t: c.t * s })),
    totalSec: l.totalSec * s,
    countInSec: l.countInSec * s,
  };
}

/** Keep only what sounds before `maxSec`; a note or glide that straddles the cut is shortened (a glide stops partway). */
function truncateLayout(l: DemoLayout, maxSec: number): DemoLayout {
  const cut = (n: TargetNote): TargetNote | null => {
    if (n.start >= maxSec - EPS) return null;
    if (n.end <= maxSec) return n;
    const out: TargetNote = { ...n, end: maxSec };
    if (n.toMidi !== undefined) out.toMidi = n.midi + (n.toMidi - n.midi) * ((maxSec - n.start) / (n.end - n.start));
    return out;
  };
  const keep = (list: TargetNote[]): TargetNote[] => list.map(cut).filter((n): n is TargetNote => n !== null);
  return {
    notes: keep(l.notes),
    reference: keep(l.reference),
    cues: l.cues.filter((c) => c.t < maxSec),
    totalSec: Math.min(l.totalSec, maxSec),
    countInSec: l.countInSec,
  };
}

// ---------------------------------------------------------------- custom voice (swell / steps / fall / path / vibrato switch)

type ShapedVoice = Extract<DemoVoice, { kind: 'shaped' }>;

const waveCache = new WeakMap<BaseAudioContext, Map<Timbre, PeriodicWave>>();

function waveFor(ctx: BaseAudioContext, timbre: Exclude<Timbre, 'sine'>): PeriodicWave {
  let byTimbre = waveCache.get(ctx);
  if (!byTimbre) {
    byTimbre = new Map();
    waveCache.set(ctx, byTimbre);
  }
  let wave = byTimbre.get(timbre);
  if (!wave) {
    const real = new Float32Array(PARTIALS[timbre]);
    wave = ctx.createPeriodicWave(real, new Float32Array(real.length));
    byTimbre.set(timbre, wave);
  }
  return wave;
}

/**
 * One oscillator + gain voice on the given ctx/dest. Everything is scheduled
 * ahead on the AudioContext clock: pitch anchors (exponential ramps in Hz),
 * an attack, level breakpoints and the same 60 ms release as the synth;
 * optional vibrato is a sine LFO into `detune` whose depth follows `depth`.
 * `peak` is the level every `gain` fraction multiplies.
 */
function playShapedVoice(ctx: BaseAudioContext, dest: AudioNode, v: ShapedVoice, startAt: number, peak: number): ScheduledHandle {
  const osc = ctx.createOscillator();
  if (v.timbre === 'sine') osc.type = 'sine';
  else osc.setPeriodicWave(waveFor(ctx, v.timbre));

  // Pitch path.
  osc.frequency.setValueAtTime(midiToHz(v.pitch[0].midi), startAt + v.pitch[0].t);
  for (let i = 1; i < v.pitch.length; i++) {
    osc.frequency.exponentialRampToValueAtTime(midiToHz(v.pitch[i].midi), startAt + v.pitch[i].t);
  }

  // Level: 0 -> attack -> breakpoints -> hold -> release. Always anchored, never a bare discontinuity.
  const gain = ctx.createGain();
  const attack = Math.min(ATTACK_SEC[v.timbre], v.duration);
  const level = (frac: number): number => Math.max(MIN_RAMP_GAIN, peak * frac);
  gain.gain.setValueAtTime(0, startAt);
  let held = peak * v.initialGain;
  gain.gain.linearRampToValueAtTime(held, startAt + attack);
  for (const p of v.level) {
    if (p.t <= attack) continue; // inside the attack: the attack ramp already owns that stretch
    const at = startAt + Math.min(p.t, v.duration);
    held = p.curve === 'exp' ? level(p.gain) : peak * p.gain;
    if (p.curve === 'set') gain.gain.setValueAtTime(held, at);
    else if (p.curve === 'linear') gain.gain.linearRampToValueAtTime(held, at);
    else gain.gain.exponentialRampToValueAtTime(held, at);
  }
  const end = startAt + v.duration;
  gain.gain.setValueAtTime(held, end);
  gain.gain.linearRampToValueAtTime(0, end + RELEASE_SEC);
  osc.connect(gain).connect(dest);

  // Optional vibrato.
  let lfo: OscillatorNode | null = null;
  if (v.vibrato) {
    lfo = ctx.createOscillator();
    lfo.type = 'sine';
    lfo.frequency.value = v.vibrato.rateHz;
    const depth = ctx.createGain();
    const d = v.vibrato.depth;
    depth.gain.setValueAtTime(v.vibrato.extentCents * d[0].frac, startAt + d[0].t);
    for (let i = 1; i < d.length; i++) depth.gain.linearRampToValueAtTime(v.vibrato.extentCents * d[i].frac, startAt + d[i].t);
    lfo.connect(depth).connect(osc.detune);
    lfo.start(startAt);
  }

  const naturalEnd = end + RELEASE_SEC;
  osc.start(startAt);
  osc.stop(naturalEnd + STOP_PAD_SEC);
  lfo?.stop(naturalEnd + STOP_PAD_SEC);

  let finished = false;
  osc.addEventListener('ended', () => {
    finished = true;
  });
  return {
    startAt,
    endAt: naturalEnd,
    stop(): void {
      if (finished) return;
      finished = true;
      // Cut short: cancel the schedule and ramp to 0 from wherever the gain is right now (as synth.ts does).
      const now = ctx.currentTime;
      gain.gain.cancelScheduledValues(now);
      gain.gain.setValueAtTime(gain.gain.value, now);
      gain.gain.linearRampToValueAtTime(0, now + RELEASE_SEC);
      const stopAt = now + RELEASE_SEC + STOP_PAD_SEC;
      osc.stop(stopAt);
      lfo?.stop(stopAt);
    },
  };
}

// ---------------------------------------------------------------- the demo

/** Earliest start among a sequence's notes (a loop, not Math.min(...), so a very long pattern cannot overflow the call stack). */
function firstStart(notes: readonly SequenceNote[]): number {
  let first = Infinity;
  for (const n of notes) if (n.start < first) first = n.start;
  return first;
}

function voiceStart(v: DemoVoice): number {
  return v.kind === 'sequence' ? firstStart(v.notes) : v.start;
}

/**
 * Schedule the Listen demo of `realized` (built from `def`) and return one
 * handle for all of it. `startAt` (option) is when it begins sounding; the
 * downbeat (take time 0) falls `countIn` later when there is a count-in.
 * `handle.endAt` is the end of the last sound (with a metronome, the end of
 * the pattern, which the clicks run to); `handle.stop()` releases every voice
 * and the metronome. The metronome (when `def.metronome`) clicks the count-in
 * and then keeps time until the pattern ends.
 *
 * Needs a live AudioContext clock: the metronome is stopped by a timer at the
 * pattern's end.
 */
export function buildDemo(
  def: ExerciseDef,
  realized: DemoRealized,
  synth: ReferenceSynth,
  ctx: BaseAudioContext,
  dest: AudioNode,
  opts: DemoOptions = {},
): ScheduledHandle {
  const style = opts.vibratoStyle ?? DEFAULT_VIBRATO_STYLE;
  const peak = clamp01(opts.gain ?? DEFAULT_DEMO_GAIN);
  const bpm = realized.bpm ?? def.tempoBpm;
  const startAt = opts.startAt ?? ctx.currentTime + START_LEAD_SEC;

  let base = demoLayout(def, realized, bpm);
  if (opts.maxSec !== undefined && Number.isFinite(opts.maxSec)) base = truncateLayout(base, Math.max(0, opts.maxSec));

  const passes: Array<{ scale: number; bpm: number }> = [];
  if (opts.slowFirst ?? def.demo.slowFirst ?? false) {
    const slowBpm = opts.slowBpm ?? def.tempoLadder?.[0] ?? Math.round(bpm * SLOW_DEMO_FACTOR);
    if (slowBpm > 0 && slowBpm < bpm - 0.5) passes.push({ scale: bpm / slowBpm, bpm: slowBpm });
  }
  passes.push({ scale: 1, bpm });

  const handles: ScheduledHandle[] = [];
  const metronomes: MetronomeHandle[] = [];
  const timers: Array<ReturnType<typeof setTimeout>> = [];
  let firstSound = Infinity;
  let lastEnd = startAt;
  let cursor = startAt;

  for (const pass of passes) {
    const layout = scaleLayout(base, pass.scale);
    const voices = planDemoVoices(def, layout, style);

    // Lead-in: the count-in clicks, and any reference tone that starts before the downbeat.
    let earliest = 0;
    for (const v of voices) earliest = Math.min(earliest, voiceStart(v));
    const leadIn = Math.max(def.metronome ? layout.countInSec : 0, -earliest);
    const downbeat = cursor + leadIn;
    const passEnd = downbeat + layout.totalSec;
    firstSound = Math.min(firstSound, downbeat - leadIn);

    if (def.metronome) {
      const metro = synth.startMetronome(pass.bpm, { startAt: downbeat, countInBeats: Math.max(0, def.countInBeats) });
      metronomes.push(metro);
      const wait = Math.max(0, (passEnd - ctx.currentTime) * 1000);
      timers.push(setTimeout(() => metro.stop(), wait));
    }

    for (const v of voices) {
      let h: ScheduledHandle;
      switch (v.kind) {
        case 'sequence': {
          const first = firstStart(v.notes);
          h = synth.playSequence(
            v.notes.map((n) => ({ midi: n.midi, start: n.start - first, duration: n.duration })),
            { startAt: downbeat + first, timbre: def.demo.timbre, gain: peak },
          );
          break;
        }
        case 'note':
          h = synth.playNote({
            midi: v.midi,
            startAt: downbeat + v.start,
            duration: v.duration,
            gain: peak,
            timbre: def.demo.timbre,
            ...(v.vibrato ? { vibrato: v.vibrato } : {}),
          });
          break;
        case 'glide':
          h = synth.playGlide({
            fromMidi: v.fromMidi,
            toMidi: v.toMidi,
            startAt: downbeat + v.start,
            holdBefore: v.holdBefore,
            glideDuration: v.glideDuration,
            holdAfter: v.holdAfter,
            gain: peak,
            timbre: def.demo.timbre,
          });
          break;
        case 'shaped':
          h = playShapedVoice(ctx, dest, v, downbeat + v.start, peak);
          break;
      }
      handles.push(h);
      firstSound = Math.min(firstSound, h.startAt);
      if (Number.isFinite(h.endAt)) lastEnd = Math.max(lastEnd, h.endAt);
    }

    if (def.metronome) lastEnd = Math.max(lastEnd, passEnd); // the clicks run to the pattern's end, past its last note
    cursor = passEnd + PASS_GAP_SEC;
  }

  let stopped = false;
  return {
    startAt: Number.isFinite(firstSound) ? firstSound : startAt,
    endAt: lastEnd,
    stop(): void {
      if (stopped) return;
      stopped = true;
      for (const t of timers) clearTimeout(t);
      for (const m of metronomes) m.stop();
      for (const h of handles) h.stop();
    },
  };
}
