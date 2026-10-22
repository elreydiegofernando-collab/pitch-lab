/**
 * Analysis plan: which analyzer runs on which part of a realized exercise.
 * Only the exercise knows what its pattern MEANS (an attack from silence, a
 * pulse train, a turn figure, a swell), so this module turns realized steps
 * into the exact inputs each analyzer's contract expects (src/analysis/*).
 * analyze.ts executes it; realize() also exposes its vibratoPlan, inflections
 * and pulseHz. Pure; no analyzer imports.
 *
 * Vocabulary:
 *  - phrase: sung steps back to back, with no rest or Listen step between.
 *    A rest between phrases is a breath, so it never counts as a break.
 *  - hold: consecutive plain (non-glide) steps on one pitch inside a phrase,
 *    merged into one sustained TargetNote (a pulse train, a switch drill or
 *    soft/loud steps is ONE physical note).
 *  - attack: a hold that starts a phrase, i.e. a voice onset from silence.
 *    Connected note changes are transitions, never onsets (the onset analyzer
 *    would read the previous note as a huge scoop).
 */
import type { InflectionKind } from '../analysis/types';
import type { VibratoCue } from '../analysis/switch';
import type { TargetNote } from '../core/types';
import { DYNAMIC_CUES, INFLECTION_CUES, VIBRATO_CUES, loudnessContourOf, type DynamicShape, type LoudnessContour } from './cues';
import type { RealizedStep } from './transpose';

/**
 * Plan knobs (PROPOSED CONFIG.exercises; no CONFIG section owns them yet).
 * Structural: they decide what is long enough to measure, not how good it is.
 */
export const PLAN = {
  /** Holds shorter than this leave too little audio after CONFIG.accuracy.holdStartSkipMs for accuracy. */
  accuracyMinHoldSec: 0.4,
  /** Shortest hold analyzed as an attack (settle needs CONFIG.onset.settleHoldMs plus time to get there). */
  attackMinSec: 0.3,
  /** How far before a note analysis/onset.ts searches for the voice onset (its private look-back). */
  onsetLookbackSec: 0.5,
  /** Free-vibrato notes need at least this long (two cycles at the slowest zone rate, plus margin). */
  vibratoMinNoteSec: 1,
  /** A pulse train is at least this many repeated steps on one pitch (cued on the first only); an alternation at least this many notes. */
  pulseMinSteps: 4,
  /** A run is at least this many distinct consecutive notes. */
  runMinNotes: 3,
  /** A dynamics hold needs at least this long to grow or fade. */
  dynamicsMinHoldSec: 2,
} as const;

const EPS = 1e-6;

export interface PlannedPhrase {
  start: number;
  end: number;
  /** The phrase's sung steps, back to back in time. */
  steps: readonly RealizedStep[];
}

export interface PlannedHold {
  note: TargetNote;
  steps: readonly RealizedStep[];
  /** Index into AnalysisPlan.phrases. */
  phrase: number;
}

export interface AnalysisPlan {
  phrases: PlannedPhrase[];
  holds: PlannedHold[];
  /** analyzeAccuracy, one per hold of at least PLAN.accuracyMinHoldSec. */
  accuracy: TargetNote[];
  /** analyzeOnset per attack, on the track from `from` (the middle of the silence before it). */
  attacks: Array<{ note: TargetNote; from: number }>;
  /** analyzeGlide, one per glide step. */
  glides: TargetNote[];
  /** analyzeInflection(track, kind, targets) in analysis/inflections.ts's TARGETS convention (with its optional extras). */
  inflections: Array<{ kind: InflectionKind; targets: TargetNote[] }>;
  /** analyzeSwitch(track, vibratoPlan): wanted vibrato over the take; contiguous same-state windows merged. */
  vibratoPlan: VibratoCue[];
  /** analyzeVibrato, one per note: each held note's vibrato-cued window when the exercise has vibrato cues, else holds of PLAN.vibratoMinNoteSec+. */
  vibrato: TargetNote[];
  /** analyzePulse(track, notes, rateHz): pulse trains (one held pitch) and alternations (two pitches), rate in cycles per second. */
  pulses: Array<{ notes: TargetNote[]; rateHz: number }>;
  /** analyzeRun, one per sequence of PLAN.runMinNotes+ distinct consecutive notes. */
  runs: TargetNote[][];
  /** analyzeTransitions, one per sequence of 2+ connected holds (no glide between). */
  transitions: TargetNote[][];
  /**
   * analyzeDynamics, one per hold of PLAN.dynamicsMinHoldSec+, with what its first loudness cue asked for: `shape`
   * names a crescendo, decrescendo or swell (null for soft/loud steps), `contour` is the level path to follow
   * (exercises/loudness.ts), steps included; null when no cue on the hold names one.
   */
  dynamics: Array<{ note: TargetNote; shape: DynamicShape | null; contour: LoudnessContour | null }>;
  /** detectCracks per span of continuous singing (one per phrase). */
  crackSpans: Array<{ start: number; end: number }>;
  /** Malformed semantic figures (validate.ts reports these as errors). */
  issues: string[];
}

const dur = (n: { start: number; end: number }) => n.end - n.start;

function stepNote(s: RealizedStep): TargetNote {
  const n: TargetNote = { midi: s.midi!, start: s.start, end: s.end };
  if (s.toMidi !== undefined) n.toMidi = s.toMidi;
  return n;
}

/** Build the analysis plan from realized steps (RealizedExercise.steps). */
export function planAnalysis(realized: { readonly steps: readonly RealizedStep[] }): AnalysisPlan {
  const all = realized.steps;
  const issues: string[] = [];

  // ---- phrases
  const phrases: PlannedPhrase[] = [];
  let cur: RealizedStep[] = [];
  const flushPhrase = () => {
    if (cur.length > 0) phrases.push({ start: cur[0].start, end: cur[cur.length - 1].end, steps: cur });
    cur = [];
  };
  for (const s of all) {
    if (s.role !== 'sing') {
      flushPhrase();
      continue;
    }
    if (cur.length > 0 && Math.abs(s.start - cur[cur.length - 1].end) > EPS) flushPhrase();
    cur.push(s);
  }
  flushPhrase();

  // ---- holds, and the hold sequences used by runs, transitions and alternations
  const holds: PlannedHold[] = [];
  const holdByStep = new Map<RealizedStep, PlannedHold>();
  const sequences: PlannedHold[][] = [];
  for (let p = 0; p < phrases.length; p++) {
    const steps = phrases[p].steps;
    let seq: PlannedHold[] = [];
    let i = 0;
    while (i < steps.length) {
      const s = steps[i];
      if (s.toMidi !== undefined) {
        if (seq.length > 0) sequences.push(seq);
        seq = [];
        i++;
        continue;
      }
      let j = i + 1;
      while (j < steps.length && steps[j].toMidi === undefined && steps[j].midi === s.midi) j++;
      const h: PlannedHold = { note: { midi: s.midi!, start: s.start, end: steps[j - 1].end }, steps: steps.slice(i, j), phrase: p };
      holds.push(h);
      for (const st of h.steps) holdByStep.set(st, h);
      seq.push(h);
      i = j;
    }
    if (seq.length > 0) sequences.push(seq);
  }

  // ---- accuracy, attacks
  const accuracy = holds.filter((h) => dur(h.note) >= PLAN.accuracyMinHoldSec - EPS).map((h) => h.note);
  const attacks: AnalysisPlan['attacks'] = [];
  let lastSoundEnd: number | null = null;
  for (const s of all) {
    if (s.role === 'rest') continue;
    if (s.role === 'sing') {
      const h = holdByStep.get(s);
      const opensPhrase = phrases[h?.phrase ?? -1]?.steps[0] === s;
      if (h && opensPhrase && h.steps[0] === s && dur(h.note) >= PLAN.attackMinSec - EPS) {
        const from = lastSoundEnd === null ? h.note.start - PLAN.onsetLookbackSec : (lastSoundEnd + h.note.start) / 2;
        attacks.push({ note: h.note, from });
      }
    }
    lastSoundEnd = s.end;
  }

  // ---- glides
  const glides = all.filter((s) => s.role === 'sing' && s.toMidi !== undefined).map(stepNote);

  // ---- inflections (analysis/inflections.ts TARGETS, with the optional context it reads)
  const inflections: AnalysisPlan['inflections'] = [];
  const holdNoteAt = (t: number, midi: number | undefined): TargetNote | undefined => {
    const h = holds.find((x) => Math.abs(x.note.start - t) < EPS && x.note.midi === midi);
    return h?.note;
  };
  for (let k = 0; k < all.length; k++) {
    const s = all[k];
    if (s.role !== 'sing' || s.cue === undefined) continue;
    const kind = INFLECTION_CUES.get(s.cue);
    if (!kind) continue;
    const next = (n: number): RealizedStep | undefined => {
      for (let m = 1; m <= n; m++) {
        const x = all[k + m];
        if (!x || x.role !== 'sing' || Math.abs(x.start - all[k + m - 1].end) > EPS) return undefined;
      }
      return all[k + n];
    };
    const where = `step ${s.index} (rep ${s.rep}) "${s.cue}"`;
    const plain = (x: RealizedStep | undefined): x is RealizedStep => !!x && x.toMidi === undefined;
    const landing = (g: RealizedStep) => (g.toMidi !== undefined ? holdNoteAt(g.end, g.toMidi) : undefined);
    if (kind === 'scoop') {
      if (s.toMidi !== undefined && s.toMidi > s.midi!) {
        const after = landing(s);
        inflections.push({ kind, targets: after ? [stepNote(s), after] : [stepNote(s)] });
      } else issues.push(`${where}: a scoop must be a glide that rises into the note`);
    } else if (kind === 'fall') {
      const g = next(1);
      if (plain(s) && g && g.toMidi !== undefined && g.midi === s.midi && g.toMidi < g.midi!) {
        inflections.push({ kind, targets: [{ midi: s.midi!, start: s.start, end: s.end }, stepNote(g)] });
      } else issues.push(`${where}: a fall is a held note followed by a downward glide from the same pitch`);
    } else if (kind === 'slide') {
      const g = next(1);
      if (plain(s) && g && g.toMidi !== undefined && g.midi === s.midi && g.toMidi !== g.midi) {
        const after = landing(g);
        const before: TargetNote = { midi: s.midi!, start: s.start, end: s.end };
        inflections.push({ kind, targets: after ? [before, stepNote(g), after] : [before, stepNote(g)] });
      } else issues.push(`${where}: a slide is a held note followed by a glide from the same pitch`);
    } else if (kind === 'turn') {
      const [a, b, c, d] = [next(1), next(2), next(3), next(4)];
      if (plain(s) && plain(a) && plain(b) && plain(c) && plain(d) && b.midi === s.midi && d.midi === s.midi && a.midi !== s.midi && c.midi !== s.midi) {
        const main: TargetNote = { midi: s.midi!, start: s.start, end: d.end };
        inflections.push({ kind, targets: [main, stepNote(a)] });
        inflections.push({ kind, targets: [main, stepNote(c)] });
      } else issues.push(`${where}: a turn is main, neighbour, main, other neighbour, main (five plain steps)`);
    } else if (kind === 'flip') {
      const up = next(1);
      if (plain(s) && plain(up) && up.midi! > s.midi!) inflections.push({ kind, targets: [stepNote(s), stepNote(up)] });
      else issues.push(`${where}: a flip is a held note followed directly by a higher one`);
    }
  }

  // ---- vibrato: per-hold cue windows -> the take-level plan (switch) and the vibrato notes
  const holdWindows: Array<{ hold: PlannedHold; windows: VibratoCue[] }> = [];
  for (const h of holds) {
    const windows: VibratoCue[] = [];
    let w: VibratoCue | null = null;
    for (const st of h.steps) {
      const v = st.cue !== undefined ? VIBRATO_CUES.get(st.cue) : undefined;
      if (v !== undefined) {
        if (w && w.vibrato === v) w.end = st.end;
        else {
          w = { start: st.start, end: st.end, vibrato: v };
          windows.push(w);
        }
      } else if (w) w.end = st.end;
    }
    if (windows.length > 0) holdWindows.push({ hold: h, windows });
  }
  const vibratoPlan: VibratoCue[] = [];
  for (const { windows } of holdWindows) {
    for (const w of windows) {
      const last = vibratoPlan[vibratoPlan.length - 1];
      if (last && last.vibrato === w.vibrato && Math.abs(last.end - w.start) < EPS) last.end = w.end;
      else vibratoPlan.push({ ...w });
    }
  }
  const vibrato: TargetNote[] = holdWindows.length > 0
    ? holdWindows.flatMap(({ hold, windows }) => windows.filter((w) => w.vibrato).map((w) => ({ midi: hold.note.midi, start: w.start, end: w.end })))
    : holds.filter((h) => dur(h.note) >= PLAN.vibratoMinNoteSec - EPS).map((h) => h.note);

  // ---- pulse trains (one pitch, one pulse per uncued repeated step) and alternations (two pitches, two notes per cycle)
  const pulses: AnalysisPlan['pulses'] = [];
  for (const h of holds) {
    if (h.steps.length >= PLAN.pulseMinSteps && h.steps.every((st, i) => i === 0 || st.cue === undefined)) {
      pulses.push({ notes: [h.note], rateHz: h.steps.length / dur(h.note) });
    }
  }
  for (const seq of sequences) {
    if (seq.length < PLAN.pulseMinSteps) continue;
    const a = seq[0].note.midi;
    const b = seq[1].note.midi;
    if (!seq.every((h, i) => h.note.midi === (i % 2 === 0 ? a : b) && h.steps.length === 1)) continue;
    const span = seq[seq.length - 1].note.end - seq[0].note.start;
    pulses.push({ notes: seq.map((h) => h.note), rateHz: seq.length / span / 2 });
  }
  pulses.sort((x, y) => x.notes[0].start - y.notes[0].start);

  // ---- runs, transitions, dynamics
  const notesOf = (q: PlannedHold[]) => q.map((h) => h.note);
  const runs = sequences.filter((q) => q.length >= PLAN.runMinNotes).map(notesOf);
  const transitions = sequences.filter((q) => q.length >= 2).map(notesOf);
  const dynamics = holds
    .filter((h) => dur(h.note) >= PLAN.dynamicsMinHoldSec - EPS)
    .map((h) => {
      for (const st of h.steps) {
        const contour = loudnessContourOf(st.cue);
        if (contour) return { note: h.note, shape: DYNAMIC_CUES.get(st.cue!) ?? null, contour };
      }
      return { note: h.note, shape: null, contour: null };
    });

  return {
    phrases,
    holds,
    accuracy,
    attacks,
    glides,
    inflections,
    vibratoPlan,
    vibrato,
    pulses,
    runs,
    transitions,
    dynamics,
    crackSpans: phrases.map((p) => ({ start: p.start, end: p.end })),
    issues,
  };
}
