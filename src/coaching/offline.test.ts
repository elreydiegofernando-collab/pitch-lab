/**
 * The offline coaching analysis (offline.ts, scripts/coach.mjs) on synthesized takes: a clean Sirens take and one with a
 * crack and stair-stepped slides give the right verdicts and spots; the ASCII graph has the right shape; a WAV
 * synthesized with dsp/test-signals.ts round-trips through the production Framer and detector; a backup (numbers only)
 * is read for where the singer is; and the CLI reads a coaching file end to end.
 *
 * The engine (coach.ts) is built in parallel by another builder, so the cases that need its answers hand in a fake engine,
 * and the one that runs the real engine accepts "not built yet" (and checks the answer when it is built).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { encodeWav } from '../audio/wav';
import { centsFromNearest, hzToMidi, midiToHz } from '../core/music';
import { targetMidiAt } from '../analysis/track';
import type { CrackEvent, MetricKey } from '../analysis/types';
import type { PitchFrame } from '../core/types';
import { notesContour, synthesize } from '../dsp/test-signals';
import { analyzeTake } from '../exercises/analyze';
import { EXERCISES, getExercise, levelForExercise } from '../exercises/catalog';
import { evaluate } from '../exercises/evaluate';
import { GOOD_SINGER, POOR_SINGER, singTake, unvoiced, type SingerModel } from '../exercises/test-singer';
import { realize, type RealizedExercise } from '../exercises/transpose';
import type { ExerciseDef } from '../exercises/types';
import { buildAttempt } from '../progress/attempt';
import type { AttemptRecord, BackupFile, ProfileRecord } from '../storage/schema';
import { bytesToBase64, decodeTrack, encodeTrack } from '../storage/track-codec';
import {
  CoachInputError,
  REAL_ENGINE,
  analyzeInputs,
  clock,
  compareTakes,
  diagnoseCoachingFile,
  formatDiagnosis,
  inferTonic,
  noteLabel,
  readCoachInput,
  realizeAtTonic,
  renderPitchGraph,
  trackFromSamples,
  type CoachEngine,
  type CoachInput,
} from './offline';
import type { CoachingFile, TakeProblem } from './types';

// The src tsconfig carries no Node types (the app is browser code), so the few Node modules this test needs are loaded the
// way styles.test.ts loads fs: dynamically, with just the signatures used.
const fs = (await import(/* @vite-ignore */ `node:${'fs'}`)) as {
  mkdirSync(path: string, opts: { recursive: boolean }): void;
  mkdtempSync(prefix: string): string;
  rmSync(path: string, opts: { recursive: boolean; force: boolean }): void;
  writeFileSync(path: string, data: string | Uint8Array): void;
  readFileSync(path: string, encoding: 'utf8'): string;
};
const os = (await import(/* @vite-ignore */ `node:${'os'}`)) as { tmpdir(): string };
const path = (await import(/* @vite-ignore */ `node:${'path'}`)) as { join(...parts: string[]): string };
const url = (await import(/* @vite-ignore */ `node:${'url'}`)) as { fileURLToPath(u: URL): string };
const childProcess = (await import(/* @vite-ignore */ `node:${'child_process'}`)) as {
  execFileSync(
    file: string,
    args: string[],
    opts: { cwd: string; encoding: 'utf8'; timeout: number; stdio: string[]; env?: Record<string, string | undefined> },
  ): string;
};
const proc = (globalThis as unknown as { process: { execPath: string; env: Record<string, string | undefined> } }).process;

const ROOT = url.fileURLToPath(new URL('../../', import.meta.url));
const SIRENS = getExercise('foundations.siren.1') as ExerciseDef;
const SUSTAIN = getExercise('foundations.sustain.1') as ExerciseDef;
const PITCH_MATCH = getExercise('foundations.pitch-match.1') as ExerciseDef;
const T0 = Date.UTC(2026, 9, 22, 18, 0);

// ---------------------------------------------------------------- fixtures

interface SirenFaults {
  /** Indexes of the glides (in take order) sung as stairs. */
  stairGlides?: number[];
  /** Steps a second, and the share of each step that is a flat plateau. */
  stairRate?: number;
  plateau?: number;
  /** Voice flips: the pitch jumps up for `len` seconds from `t`. */
  cracks?: Array<{ t: number; semis?: number; len?: number }>;
}

/** The test singer's Sirens take with faults put in (its glides are straight ramps, so stairs and flips are added here). */
function sirenTake(realized: RealizedExercise, faults: SirenFaults = {}): PitchFrame[] {
  const base = singTake(realized, GOOD_SINGER);
  const glides = realized.notes.filter((n) => n.toMidi !== undefined);
  const rate = faults.stairRate ?? 3;
  const plateau = faults.plateau ?? 0.8;
  return base.map((f) => {
    if (!f.voiced) return f;
    let m = f.midi;
    glides.forEach((g, gi) => {
      if (!faults.stairGlides?.includes(gi) || f.t < g.start || f.t >= g.end) return;
      const to = g.toMidi as number;
      const u = (f.t - g.start) / (g.end - g.start);
      const steps = Math.max(2, Math.round(rate * (g.end - g.start)));
      const k = Math.floor(u * steps);
      const within = u * steps - k;
      const stair = (k + Math.min(1, Math.max(0, (within - plateau) / (1 - plateau)))) / steps;
      m += g.midi + (to - g.midi) * stair - (g.midi + (to - g.midi) * u);
    });
    for (const c of faults.cracks ?? []) if (f.t >= c.t && f.t < c.t + (c.len ?? 0.07)) m += c.semis ?? 4;
    return { ...f, midi: m, f0Hz: midiToHz(m), centsFromNearest: centsFromNearest(m) };
  });
}

/** The crack-and-stairs take the tests lean on: every slide stair-stepped, and the voice flips once at 8.5 s. */
const CRACK_AND_STAIRS: SirenFaults = { stairGlides: [0, 1, 2, 3, 4, 5], cracks: [{ t: 8.5 }] };

interface FixtureTake {
  id: string;
  /** Minutes after the first take of the fixture. */
  minutes: number;
  track: PitchFrame[];
  realized: RealizedExercise;
}

/**
 * The attempt the app would have written for the take. The saved pitch line is 32-bit floats, so the numbers come from the
 * line as saved: on perfectly gridded synthetic frames a sub-microsemitone change can flip a frame across a window edge.
 */
function attemptOf(def: ExerciseDef, level: { id: string | null; kind?: 'level' | 'boss' }, t: FixtureTake, vibratoStyle: 'pop' | 'classical' = 'pop'): AttemptRecord {
  const analysis = analyzeTake(def, t.realized, decodeTrack(encodeTrack(t.track)), { vibratoStyle });
  const evaluation = evaluate(def, analysis.metrics, analysis);
  const at = new Date(T0 + t.minutes * 60_000).toISOString();
  const fields = buildAttempt({
    profileId: 'p1',
    def,
    source: level.id === null ? { type: 'audition' } : { type: 'level', level: { id: level.id, kind: level.kind ?? 'level', exerciseId: def.id } },
    realized: t.realized,
    evaluation,
    metrics: analysis.metrics,
  });
  return { ...fields, id: t.id, createdAt: at, updatedAt: at, deletedAt: null };
}

/** A coaching file as "Send to Claude" writes it; `takes` are newest first. */
function coachingFileOf(def: ExerciseDef, level: { id: string | null; title: string; kind?: 'level' | 'boss' }, takes: FixtureTake[]): CoachingFile {
  return {
    app: 'pitch-lab',
    kind: 'coaching',
    version: 1,
    exportedAt: new Date(T0 + 60 * 60_000).toISOString(),
    appVersion: '0.1.0',
    level: { id: level.id, title: level.title, worldId: def.worldId },
    exercise: JSON.parse(JSON.stringify(def)) as ExerciseDef,
    profile: { name: 'Test Singer', voiceType: 'baritone', range: null },
    settings: { vibratoStyle: 'pop', notation: 'sharps', keepTakeAudio: false },
    device: { route: 'wired', latencyMs: 40, userAgent: 'vitest' },
    takes: takes.map((t) => ({
      attempt: attemptOf(def, level, t),
      realized: { tonicMidi: t.realized.tonicMidi, bpm: t.realized.bpm, countInSec: t.realized.countInSec, totalSec: t.realized.totalSec, notes: t.realized.notes },
      track: encodeTrack(t.track),
      audioWavBase64: null,
    })),
  };
}

const SIRENS_LEVEL = { id: 'foundations.05', title: 'Sirens & glides' };
const sirensRealized = (): RealizedExercise => realize(SIRENS, null, 'baritone');

/** A coaching file read the way the CLI reads it: serialized, then sniffed and checked. */
function readBack(file: CoachingFile, name = 'sample.json'): CoachInput {
  return readCoachInput(new TextEncoder().encode(JSON.stringify(file)), name);
}

/** A Sirens coaching file; `specs` are the takes oldest first, the file lists them newest first. */
function sirensFile(specs: SirenFaults[]): CoachingFile {
  const realized = sirensRealized();
  const takes = specs.map((spec, i): FixtureTake => ({ id: `att-${i + 1}`, minutes: i * 3, track: sirenTake(realized, spec), realized }));
  return coachingFileOf(SIRENS, SIRENS_LEVEL, takes.reverse());
}

/** An engine that answers with fixed text, and remembers what it was asked. */
function fakeEngine(): CoachEngine & { asked: Array<{ cracks: number; tipId: string }> } {
  const asked: Array<{ cracks: number; tipId: string }> = [];
  const problem: TakeProblem = {
    tipId: 'glide.stairs',
    metric: 'glide.smoothness',
    what: 'Your slides moved in steps instead of one smooth line.',
    spots: [
      { t: 11, label: '0:11, the slide down from C4 to C3' },
      { t: 7, label: 'the slide up from C3 to C4' },
    ],
  };
  return {
    asked,
    locateProblem: (input) => {
      asked.push({ cracks: input.analysis.details.cracks.length, tipId: input.tip.id });
      return problem;
    },
    coachTake: (outcome) => ({
      depth: 1,
      missesInARow: outcome.attempt.passed ? 0 : 1,
      passed: outcome.attempt.passed,
      problem,
      tip: 'Make each slide one smooth line.',
      why: null,
      steps: [],
      easier: null,
      progress: [],
      moves: [],
    }),
    missesInARow: (_id, log) => {
      let n = 0;
      for (let i = log.length - 1; i >= 0 && !log[i].passed; i--) n++;
      return n;
    },
  };
}

// ---------------------------------------------------------------- the graph

describe('renderPitchGraph', () => {
  const frame = (t: number, midi: number): PitchFrame => ({ t, f0Hz: midiToHz(midi), midi, centsFromNearest: centsFromNearest(midi), confidence: 0.95, rmsDb: -20, voiced: true });
  const flat = (from: number, to: number, midi: number): PitchFrame[] => {
    const out: PitchFrame[] = [];
    for (let t = from; t < to; t += 1 / 93.75) out.push(frame(t, midi));
    return out;
  };
  /** The plot part of the row for `midi` (everything after the note label and the bar). */
  const plot = (g: ReturnType<typeof renderPitchGraph>, midi: number): string => g.lines[g.highMidi - midi].slice(g.labelWidth);

  it('puts time across and notes down: one row a half step, one column a slice of time', () => {
    const g = renderPitchGraph({ notes: [{ midi: 60, start: 0, end: 2 }], track: [], cracks: [], totalSec: 2 }, { width: 40 });
    expect(g.cols).toBe(40);
    expect(g.binSec).toBeCloseTo(0.05, 9);
    expect([g.lowMidi, g.highMidi, g.rowStep]).toEqual([59, 61, 1]);
    expect(g.lines.slice(0, 3).map((l) => l.slice(0, g.labelWidth))).toEqual([' C#4 |', '  C4 |', '  B3 |']);
    // the target is a bar of "=" the whole width of its note, on its own row only
    expect(plot(g, 60)).toBe('='.repeat(40));
    expect(plot(g, 61)).toBe('');
    expect(plot(g, 59)).toBe('');
  });

  it('draws the sung line as "*" over the bar, and a crack as "x" over the line', () => {
    const track = [...flat(0, 2, 60), frame(1.001, 62)]; // one stray frame two half steps up: off the graph
    track.sort((a, b) => a.t - b.t);
    const crack: CrackEvent = { t: 1.0, kind: 'jump', cents: 200, durationMs: 20 };
    const g = renderPitchGraph({ notes: [{ midi: 60, start: 0, end: 2 }], track, cracks: [crack], totalSec: 2 }, { width: 40 });
    const row = plot(g, 60);
    expect(row).not.toContain('=');
    expect(row.replace('x', '*')).toBe('*'.repeat(40));
    expect(row[20]).toBe('x');
    expect(g.marks).toHaveLength(1);
    expect(g.marks[0]).toMatchObject({ t: 1.0, col: 20, row: 1 });
    expect(g.marks[0].midi).toBeCloseTo(60, 6);
    expect(g.clipped).toBe(1);
    const text = g.lines.join('\n');
    expect(text).toContain('1 voiced frame sits outside the pitch range shown');
    expect(text).toContain('cracks at 0:01.0 (C4)');
  });

  it('shows where the singer was not: the bar stays where nothing was sung', () => {
    const g = renderPitchGraph({ notes: [{ midi: 60, start: 0, end: 2 }], track: flat(0, 1, 60), cracks: [], totalSec: 2 }, { width: 40 });
    expect(plot(g, 60)).toBe('*'.repeat(20) + '='.repeat(20));
  });

  it('climbs with a glide: the bar of a rising glide starts low on the left and ends high on the right', () => {
    const g = renderPitchGraph({ notes: [{ midi: 60, toMidi: 72, start: 0, end: 4 }], track: [], cracks: [], totalSec: 4 }, { width: 48 });
    expect([g.lowMidi, g.highMidi]).toEqual([59, 73]);
    const firstCol = (midi: number): number => plot(g, midi).indexOf('=');
    expect(firstCol(60)).toBeLessThan(4);
    expect(firstCol(72)).toBeGreaterThan(40);
    for (let m = 60; m < 72; m++) expect(firstCol(m + 1)).toBeGreaterThan(firstCol(m));
    // every row from 60 to 72 holds some of the bar: a slope, not dots
    for (let m = 60; m <= 72; m++) expect(plot(g, m)).toContain('=');
  });

  it('labels the time axis and the rows, and names the scale', () => {
    const g = renderPitchGraph({ notes: [{ midi: 60, start: 0, end: 20 }], track: [], cracks: [], totalSec: 20 }, { width: 100, notation: 'flats' });
    const text = g.lines.join('\n');
    expect(text).toMatch(/^ *0s +2s +4s +6s .* 18s +20s$/m);
    expect(text).toContain('1 column = 0.2 s, 1 row = a half step');
    expect(g.lines[0].startsWith(' Db4 |')).toBe(true);
    expect(g.lines[1].startsWith('  C4 |')).toBe(true);
    expect(g.lines[2].startsWith('  B3 |')).toBe(true);
    // the axis line sits under the bars: its corner under the "|", its ticks under their labels
    const axis = g.lines.find((l) => /^ *\+-/.test(l)) as string;
    expect(axis.indexOf('+')).toBe(g.labelWidth - 1);
    expect(axis[g.labelWidth + 10]).toBe('+');
  });

  it('keeps a tall range readable by letting rows share half steps', () => {
    const g = renderPitchGraph({ notes: [{ midi: 40, toMidi: 88, start: 0, end: 4 }], track: [], cracks: [], totalSec: 4 }, { width: 40, maxRows: 20 });
    expect(g.rowStep).toBeGreaterThan(1);
    expect(g.lines.filter((l) => /^ *[A-G][#b]?\d \|/.test(l)).length).toBeLessThanOrEqual(20);
    expect(g.lines.join('\n')).toContain(`1 row = ${g.rowStep} half steps`);
  });

  it('draws an empty frame when there is nothing to draw', () => {
    const g = renderPitchGraph({ notes: [], track: [], cracks: [], totalSec: 0 });
    const rows = g.lines.filter((l) => /^ *[A-G][#b]?\d \|/.test(l));
    expect(rows.length).toBe(5);
    expect(rows.every((l) => l.slice(g.labelWidth) === '')).toBe(true);
  });
});

// ---------------------------------------------------------------- small helpers

describe('note names and clocks', () => {
  it('writes plain ASCII note names in either notation', () => {
    expect(noteLabel(61)).toBe('C#4');
    expect(noteLabel(61, 'flats')).toBe('Db4');
    expect(noteLabel(57)).toBe('A3');
    expect(noteLabel(NaN)).toBe('-');
  });

  it('writes take time as m:ss.s and never "0:60.0"', () => {
    expect(clock(4.2)).toBe('0:04.2');
    expect(clock(65.04)).toBe('1:05.0');
    expect(clock(59.97)).toBe('1:00.0');
    expect(clock(-0.3)).toBe('-0:00.3');
  });
});

// ---------------------------------------------------------------- reading files

describe('reading files', () => {
  const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

  it('refuses a file that is not JSON or a WAV, and says so', () => {
    expect(() => readCoachInput(enc('hello there'), 'notes.txt')).toThrow(CoachInputError);
    expect(() => readCoachInput(enc('hello there'), 'notes.txt')).toThrow(/notes\.txt: not a Pitch Lab file \(it is neither a WAV nor valid JSON\)/);
  });

  it('refuses JSON that is neither a coaching file nor a backup', () => {
    expect(() => readCoachInput(enc('{"a":1}'), 'x.json')).toThrow(/x\.json: not a Pitch Lab coaching file or backup/);
    expect(() => readCoachInput(enc('[1,2]'), 'x.json')).toThrow(CoachInputError);
  });

  it('refuses a damaged WAV', () => {
    const bad = new Uint8Array(40);
    bad.set(enc('RIFF'), 0);
    bad.set(enc('WAVE'), 8);
    expect(() => readCoachInput(bad, 'take.wav')).toThrow(/take\.wav: not a readable WAV file/);
  });

  it('refuses a coaching file from a newer app, one with no takes, and one with a broken exercise', () => {
    const file = sirensFile([{}]);
    expect(() => readBack({ ...file, version: 2 as never })).toThrow(/made by a newer app \(coaching file version 2\)/);
    expect(() => readBack({ ...file, takes: [] })).toThrow(/the file holds no takes/);
    const unknown = { metric: 'no.such.metric' as MetricKey, weight: 1, best: 1, worst: 0 };
    expect(() => readBack({ ...file, exercise: { ...file.exercise, scoring: [unknown] } })).toThrow(/unusable scoring list/);
    expect(() => readBack({ ...file, takes: [{ ...file.takes[0], track: { frameRate: 1 } as never }] })).toThrow(/take 1 has a damaged pitch line/);
  });

  it('refuses a backup from a newer app, and keeps what it can read of a damaged one', () => {
    const backup = (over: Record<string, unknown>): Uint8Array =>
      enc(JSON.stringify({ format: 'pitch-lab-backup', version: 1, exportedAt: '2026-10-22T18:00:00Z', profiles: [], attempts: [], settings: {}, ...over }));
    expect(() => readCoachInput(backup({ version: 2 }), 'b.json')).toThrow(/made by a newer app \(backup version 2\)/);
    expect(() => readCoachInput(backup({ attempts: 'nope' }), 'b.json')).toThrow(/missing its profiles or attempts list/);
    const input = readCoachInput(backup({ profiles: [{ id: 'p1', name: 'Sam' }, 7], attempts: [{ id: 'a' }, null] }), 'b.json');
    expect(input.kind).toBe('backup');
    if (input.kind === 'backup') {
      expect(input.backup.profiles.map((p) => p.name)).toEqual(['Sam']);
      expect(input.backup.warnings.join(' ')).toMatch(/skipped a profile row/);
      expect(input.backup.warnings.join(' ')).toMatch(/skipped 2 attempt rows/);
    }
  });

  it('recognizes a WAV by its content, whatever it is called', () => {
    const wav = encodeWav(new Float32Array([0, 0.5, -0.5, 0.25]), 44100);
    const input = readCoachInput(new Uint8Array(wav), 'whatever.bin');
    expect(input.kind).toBe('wav');
    if (input.kind === 'wav') {
      expect(input.wav.sampleRate).toBe(44100);
      expect(Array.from(input.wav.samples).map((x) => Math.round(x * 100) / 100)).toEqual([0, 0.5, -0.5, 0.25]);
    }
  });

  it('reads a coaching file as it was written', () => {
    const input = readBack(sirensFile([{}, CRACK_AND_STAIRS]));
    expect(input.kind).toBe('coaching');
    if (input.kind === 'coaching') {
      expect(input.file.takes).toHaveLength(2);
      expect(input.file.exercise.id).toBe(SIRENS.id);
      expect(input.file.settings.notation).toBe('sharps');
    }
  });
});

// ---------------------------------------------------------------- a clean take

describe('a clean Sirens take', () => {
  const file = sirensFile([{}]);
  const d = diagnoseCoachingFile(file, { engine: fakeEngine() });
  const take = d.takes[0];

  it('passes, agrees with what the app recorded, and meets every gate', () => {
    expect(take.source).toBe('track');
    expect(take.verdict.passed).toBe(true);
    expect(take.verdict.score).toBeGreaterThan(0.9);
    expect(take.verdict.app?.passed).toBe(true);
    expect(take.verdict.agrees).toBe(true);
    expect(take.gates.map((g) => g.met)).toEqual([true, true, true, true]);
    expect(take.gates[0].label).toBe('Overall score');
    expect(take.verdict.failedGates).toEqual([]);
    expect(take.checks).toEqual([]);
  });

  it('finds nothing to flag: no cracks, no stairs, no bad figures, no x on the graph', () => {
    expect(take.cracks).toEqual([]);
    expect(take.figures.filter((f) => f.bad)).toEqual([]);
    expect(take.figures.filter((f) => f.kind === 'glide')).toHaveLength(6);
    expect(take.insights.join(' ')).not.toMatch(/break|stair/i);
    expect(take.graph?.marks).toEqual([]);
    expect(take.graph?.lines.some((l) => /\|.*x/.test(l))).toBe(false);
  });

  it('reads as a pass in the text, with the gates and nothing to compare', () => {
    const text = formatDiagnosis(d);
    expect(text).toContain('PASS');
    expect(text).toContain('Every gate is met.');
    expect(text).toContain('Pitch graph (time across, notes down):');
    expect(text).not.toMatch(/MISS/);
    expect(text).not.toContain('ACROSS THE TAKES');
    expect(d.streak).toEqual({ misses: 0, depth: 1, atLeast: false });
  });

  it('prints plain ASCII only', () => {
    expect(formatDiagnosis(d)).toMatch(/^[\x00-\x7F]*$/);
  });
});

// ---------------------------------------------------------------- a crack and stairs

describe('a Sirens take with a crack and stair-stepped slides', () => {
  const file = sirensFile([CRACK_AND_STAIRS]);
  const engine = fakeEngine();
  const d = diagnoseCoachingFile(file, { engine });
  const take = d.takes[0];

  it('misses, because the smoothness gate fails, and says by how much', () => {
    expect(take.verdict.passed).toBe(false);
    expect(take.verdict.agrees).toBe(true);
    expect(take.verdict.score).toBeLessThan(SIRENS.pass.score);
    const smooth = take.gates.find((g) => g.metric === 'glide.smoothness');
    expect(smooth?.met).toBe(false);
    expect(smooth?.missBy).toMatch(/pts$/);
    expect(take.gates.find((g) => g.metric === 'glide.cracks')?.met).toBe(true);
    expect(take.verdict.why.join(' ')).toMatch(/Gates not met: Smoothness/);
    expect(take.verdict.why.join(' ')).toMatch(/Biggest score losses: Smoothness/);
  });

  it('puts the cost of the score where it is: smoothness first, and the costs add up', () => {
    expect(take.terms[0].metric).toBe('glide.smoothness');
    const lost = take.terms.reduce((s, t) => s + t.lost, 0);
    expect(1 - lost).toBeCloseTo(take.verdict.score, 6);
  });

  it('locates the crack at the right time, on the right note', () => {
    expect(take.cracks).toHaveLength(1);
    const crack = take.cracks[0];
    expect(crack.kind).toBe('jump');
    expect(crack.t).toBeGreaterThan(8.4);
    expect(crack.t).toBeLessThan(8.55);
    expect(crack.cents).toBeGreaterThan(350);
    // 8.5 s is half way up the 48 -> 60 siren: F#3, the pitch the voice was on when it broke
    expect(crack.nearMidi).toBeGreaterThan(53);
    expect(crack.nearMidi).toBeLessThan(55.5);
    const fig = take.figures.find((f) => f.kind === 'crack');
    expect(fig?.bad).toBe(true);
    expect(fig?.t).toBeCloseTo(crack.t, 6);
    expect(fig?.text).toMatch(/^at 0:08\.[45] near F#?3: a jump of \d+ cents/);
  });

  it('flags every glide that moved in steps, with its time span and its notes', () => {
    const glides = take.figures.filter((f) => f.kind === 'glide');
    expect(glides).toHaveLength(6);
    const stepped = glides.filter((f) => f.bad && /stair steps [1-9]/.test(f.text));
    expect(stepped.length).toBeGreaterThanOrEqual(4);
    expect(glides[2].label).toBe('Glide 3 C3 to C4');
    expect(glides[2].text).toMatch(/^0:07\.0-0:10\.0 smooth \d+%, stair steps \d+/);
    expect(take.insights.join(' ')).toMatch(/Stair steps on \d of 6 glides/);
    expect(take.insights.join(' ')).toMatch(/1 break: F#?3/);
  });

  it('draws the crack as an x on the graph, where it happened', () => {
    const g = take.graph;
    expect(g).not.toBeNull();
    if (!g) return;
    expect(g.marks).toHaveLength(1);
    const mark = g.marks[0];
    expect(mark.row).not.toBeNull();
    expect(g.lines[mark.row as number][g.labelWidth + mark.col]).toBe('x');
    expect(Math.abs(mark.t - 8.5)).toBeLessThan(0.1);
    expect(g.lines.join('\n')).toMatch(/cracks at 0:08\.[45] \(F#?3\)/);
    expect(g.lines.some((l) => l.includes('='))).toBe(true);
  });

  it('asks the engine for the located problem, with the analysis it needs, and prints its answer', () => {
    expect(engine.asked.length).toBeGreaterThan(0);
    expect(engine.asked[0]).toEqual({ cracks: 1, tipId: take.tip?.id });
    expect(take.engine.problem?.tipId).toBe('glide.stairs');
    expect(take.engine.coaching?.passed).toBe(false);
    const text = formatDiagnosis(d);
    expect(text).toContain('MISS');
    expect(text).toContain('Located problem (engine, coaching/coach.ts):');
    expect(text).toContain('  glide.stairs on glide.smoothness:\n    Your slides moved in steps instead of one smooth line.\n');
    // a spot whose label already leads with its time is printed as it is; one that does not gets its time added
    expect(text).toContain('  where, worst first:\n    - 0:11, the slide down from C4 to C3\n    - the slide up from C3 to C4 (0:07.0)\n');
    expect(text).toContain('What the app tells the singer (coachTake): depth 1, 1 miss in a row:');
    expect(text).toContain('Make each slide one smooth line.');
    expect(text).toContain('Smoothness (gate)');
    expect(d.engine).toEqual({ status: 'ok', message: null });
  });

  it('runs the real engine too: it answers, or says it is not built yet', () => {
    const real = diagnoseCoachingFile(file, { engine: REAL_ENGINE });
    const t = real.takes[0];
    if (real.engine.status === 'not-built') {
      expect(t.engine.problem).toBeNull();
      expect(t.engine.notBuilt).toBe(true);
      expect(formatDiagnosis(real)).toContain('the coaching engine is not built yet');
      return;
    }
    expect(real.engine.status).toBe('ok');
    expect(t.engine.problem).not.toBeNull();
    expect(t.engine.problem?.tipId).toBe(t.tip?.id);
    expect((t.engine.problem?.spots.length ?? 0) <= 4).toBe(true);
    expect(t.engine.coaching?.missesInARow).toBe(1);
    expect(t.engine.coaching?.passed).toBe(false);
  });

  it('does not stop at an engine that throws: the diagnosis still comes out, with the reason', () => {
    const broken: CoachEngine = {
      ...fakeEngine(),
      locateProblem: () => {
        throw new Error('locateProblem: not built yet');
      },
      coachTake: () => {
        throw new Error('boom');
      },
    };
    const r = diagnoseCoachingFile(file, { engine: broken });
    expect(r.takes[0].verdict.passed).toBe(false);
    expect(r.takes[0].engine.problem).toBeNull();
    expect(r.engine.status).toBe('not-built');
    const text = formatDiagnosis(r);
    expect(text).toContain('not available: the coaching engine is not built yet in this checkout.');
    expect(text).toContain('MISS');
  });
});

// ---------------------------------------------------------------- the rules a take is judged by besides its numbers

describe('the rules a take is judged by besides its numbers', () => {
  it('refuses a take the app folded into a narrow saved range, as the app did', () => {
    const narrow = { comfortable: { low: 48, high: 54 }, extended: { low: 47, high: 55 }, measuredAt: 'now' };
    const folded = realize(SIRENS, narrow, 'baritone');
    expect(folded.fit).toBe('folded');
    const file = coachingFileOf(SIRENS, SIRENS_LEVEL, [{ id: 'f1', minutes: 0, track: singTake(folded, GOOD_SINGER), realized: folded }]);
    const [d] = analyzeInputs([readBack(file)], { engine: fakeEngine() });
    const t = d.takes[0];
    expect(t.verdict.notJudged).toBe('folded');
    expect(t.verdict.passed).toBe(false);
    expect(t.verdict.agrees).toBe(true);
    expect(t.notes.join(' ')).toMatch(/the app folded it into a narrow saved range/);
    expect(t.verdict.why.join(' ')).toMatch(/Not judged: the exercise did not fit the saved range/);
    expect(formatDiagnosis(d)).toContain('NOT JUDGED');
  });

  it('says a take the app recorded as a miss, though its numbers pass, may have been stopped early', () => {
    const file = sirensFile([{}]);
    file.takes[0].attempt = { ...file.takes[0].attempt, passed: false, mastery: 0 };
    const t = diagnoseCoachingFile(file, { engine: fakeEngine() }).takes[0];
    expect(t.verdict.passed).toBe(true);
    expect(t.verdict.agrees).toBe(false);
    expect(t.checks.join(' ')).toMatch(/Differs: the app recorded a miss at \d+%; this analysis says pass at \d+%\. The take may have been stopped early/);
    expect(formatDiagnosis(diagnoseCoachingFile(file, { engine: fakeEngine() }))).toContain('(DIFFERS: see below)');
  });

  it('calls a take that sits on the pass line borderline when the app and this analysis split on it', () => {
    // four voice flips: the score is above the pass mark, but the breaks gate (at most 3.8) is missed by a hair
    const file = sirensFile([{ cracks: [{ t: 8.5 }, { t: 12.4 }, { t: 15.6 }, { t: 17.9 }] }]);
    const t0 = diagnoseCoachingFile(file, { engine: fakeEngine() }).takes[0];
    expect(t0.verdict.passed).toBe(false);
    expect(t0.gates.find((g) => g.metric === 'glide.cracks')).toMatchObject({ met: false, nearMiss: true });
    // the same numbers, recorded as a pass (as a build with the gate at 4 would): it could tip either way
    file.takes[0].attempt = { ...file.takes[0].attempt, passed: true, mastery: 1, score: t0.verdict.score + 0.01 };
    const t = diagnoseCoachingFile(file, { engine: fakeEngine() }).takes[0];
    expect(t.verdict.passed).toBe(false);
    expect(t.verdict.agrees).toBe(false);
    expect(t.checks.join(' ')).toMatch(/^Borderline: the app recorded a pass at \d+%; this analysis says miss at \d+%/);
  });

  it('says when notes went unsung, and where the singing stopped', () => {
    const realized = sirensRealized();
    const track = unvoiced(sirenTake(realized), 12, 30);
    const file = coachingFileOf(SIRENS, SIRENS_LEVEL, [{ id: 'u1', minutes: 0, track, realized }]);
    const t = diagnoseCoachingFile(file, { engine: fakeEngine() }).takes[0];
    expect(t.verdict.unsung?.total).toBe(realized.notes.length);
    expect(t.verdict.unsung?.reached).toBeLessThan(realized.notes.length);
    expect(t.verdict.passed).toBe(false);
    expect(t.verdict.agrees).toBe(true);
    expect(t.verdict.why.join(' ')).toMatch(/Left notes unsung \(\d of 9 sung\)/);
    expect(t.insights.join(' ')).toMatch(/Only \d of 9 notes were sung: the singing stopped around 0:1\d\.\d/);
    expect(t.figures[0]).toMatchObject({ kind: 'reach', bad: true });
  });

  it('says that a lower rung of a Runs ladder cannot pass the level, however well it goes', () => {
    const def = EXERCISES.find((e) => (e.tempoLadder?.length ?? 0) > 1) as ExerciseDef;
    const rung = (def.tempoLadder as number[])[0];
    expect(rung).toBeLessThan(def.tempoBpm);
    const realized = realize(def, null, 'tenor', { bpm: rung });
    const level = levelForExercise(def.id) as NonNullable<ReturnType<typeof levelForExercise>>;
    const file = coachingFileOf(def, level, [{ id: 'r1', minutes: 0, track: singTake(realized, good(def)), realized }]);
    const [d] = analyzeInputs([readBack(file)], { engine: fakeEngine() });
    const t = d.takes[0];
    expect(t.bpm).toBe(rung);
    expect(t.verdict.belowPassTempo).toBe(true);
    expect(t.verdict.passed).toBe(false);
    expect(t.verdict.agrees).toBe(true);
    expect(t.verdict.why.join(' ')).toContain(`Sung at ${rung} bpm, below the level's pass tempo of ${def.tempoBpm} bpm`);
  });
});

// ---------------------------------------------------------------- every exercise of the catalog

const good = (def: ExerciseDef): SingerModel => ({ ...GOOD_SINGER, vibratoEverywhere: def.analyzers.includes('vibrato') });
const levelOf = (def: ExerciseDef): { id: string | null; title: string; kind?: 'level' | 'boss' } => {
  const level = levelForExercise(def.id);
  return level ? { id: level.id, title: level.title, kind: level.kind } : { id: null, title: def.title };
};
const WORLD_IDS = [...new Set(EXERCISES.map((e) => e.worldId))];

describe.each(WORLD_IDS)('every exercise of the %s world', (worldId) => {
  const defs = EXERCISES.filter((e) => e.worldId === worldId);

  it('is diagnosed from a clean take and from a poor one, with the verdict the app recorded', () => {
    for (const def of defs) {
      for (const [who, singer] of [['clean', good(def)], ['poor', POOR_SINGER]] as const) {
        const at = `${def.id} (${who})`;
        const realized = realize(def, null, 'tenor');
        const file = coachingFileOf(def, levelOf(def), [{ id: 'a1', minutes: 0, track: singTake(realized, singer), realized }]);
        const [d] = analyzeInputs([readBack(file)], { engine: fakeEngine() });
        const t = d.takes[0];
        expect(t.verdict.agrees, at).toBe(true);
        if (who === 'clean') expect(t.verdict.passed, at).toBe(true);
        expect(t.gates.length, at).toBe(1 + (def.pass.gates?.length ?? 0));
        expect(t.terms.length, at).toBe(def.scoring.length);
        expect(t.graph?.lines.length, at).toBeGreaterThan(5);
        const text = formatDiagnosis(d);
        expect(text, at).toMatch(/^[\x00-\x7F]*$/);
        expect(text, at).not.toMatch(/undefined|NaN|\[object|Infinity/);
        expect(text, at).toContain(`TAKE 1 (newest) of 1`);
      }
    }
  }, 120_000);
});

describe('the real engine over the whole catalog', () => {
  it('answers, or says why not, for every exercise, and never takes the diagnosis down', () => {
    const trouble: string[] = [];
    for (const def of EXERCISES) {
      const realized = realize(def, null, 'tenor');
      for (const singer of [good(def), POOR_SINGER]) {
        const file = coachingFileOf(def, levelOf(def), [{ id: 'a1', minutes: 0, track: singTake(realized, singer), realized }]);
        const [d] = analyzeInputs([readBack(file)], {});
        if (d.engine.status === 'error') trouble.push(`${def.id}: ${d.engine.message}`);
        expect(['ok', 'not-built', 'error']).toContain(d.engine.status);
        expect(d.takes[0].verdict.passed).toBe(d.takes[0].verdict.app?.passed);
      }
    }
    // Reported, not asserted: an engine that throws is the engine builder's to fix, and the diagnosis says so on its own.
    if (trouble.length > 0) console.info(`real engine errors:\n${trouble.join('\n')}`);
  }, 240_000);
});

// ---------------------------------------------------------------- a backup (numbers only)

function backupAttempt(over: Partial<AttemptRecord> & { id: string; minutes: number }): AttemptRecord {
  const { minutes, ...rest } = over;
  const at = new Date(T0 + minutes * 60_000).toISOString();
  return {
    profileId: 'p1',
    createdAt: at,
    updatedAt: at,
    deletedAt: null,
    exerciseId: SIRENS.id,
    levelId: 'foundations.05',
    kind: 'practice',
    score: 0.5,
    passed: false,
    mastery: 0,
    metrics: {},
    durationSec: 21,
    tonicMidi: 48,
    tempoBpm: 60,
    takeId: null,
    ...rest,
  };
}

const PROFILE: ProfileRecord = {
  id: 'p1',
  profileId: 'p1',
  createdAt: new Date(T0).toISOString(),
  updatedAt: new Date(T0).toISOString(),
  deletedAt: null,
  name: 'Test Singer',
  voiceType: 'baritone',
  range: null,
};

function backupFile(attempts: AttemptRecord[], profiles: ProfileRecord[] = [PROFILE]): BackupFile {
  return {
    format: 'pitch-lab-backup',
    version: 1,
    exportedAt: new Date(T0 + 120 * 60_000).toISOString(),
    profiles,
    attempts,
    settings: { schemaVersion: 1, profiles: { p1: { vibratoStyle: 'pop', notation: 'flats' } } },
  };
}

function backupInput(attempts: AttemptRecord[], profiles: ProfileRecord[] = [PROFILE]): CoachInput {
  return readCoachInput(new TextEncoder().encode(JSON.stringify(backupFile(attempts, profiles))), 'pitch-lab-backup-2026-10-22.json');
}

describe('across the takes', () => {
  /** Oldest first: three takes that all stair-step, with 3, 2 and 1 voice flips. */
  const specs: SirenFaults[] = [
    { stairGlides: [0, 1, 2, 3, 4, 5], cracks: [{ t: 8.5 }, { t: 12.4 }, { t: 15.6 }] },
    { stairGlides: [0, 1, 2, 3, 4, 5], cracks: [{ t: 8.5 }, { t: 12.4 }] },
    { stairGlides: [0, 1, 2, 3, 4, 5], cracks: [{ t: 8.5 }] },
  ];
  const d = diagnoseCoachingFile(sirensFile(specs), { engine: fakeEngine() });

  it('lists the takes newest first, and compares them oldest to newest, as the app recorded them', () => {
    expect(d.takes.map((t) => t.index)).toEqual([1, 2, 3]);
    expect(d.takes.map((t) => t.attemptId)).toEqual(['att-3', 'att-2', 'att-1']);
    expect(d.comparison?.rows.map((r) => r.index)).toEqual([3, 2, 1]);
    expect(d.comparison?.rows.every((r) => !r.passed)).toBe(true);
    // every take in the file missed, and the file holds no more: the streak is at least this long
    expect(d.streak).toEqual({ misses: 3, depth: 3, atLeast: true });
  });

  it('says what improves and what repeats', () => {
    const cmp = d.comparison;
    expect(cmp).not.toBeNull();
    if (!cmp) return;
    expect(cmp.improved.join(' ')).toMatch(/Breaks: 3 -> 2 -> 1/);
    expect(cmp.repeats.join(' ')).toMatch(/Smoothness missed its gate in 3 of 3 takes/);
    expect(cmp.repeats.join(' ')).toMatch(/coach picked the same problem \(glide\.stairs\) in 3 of 3 takes/);
    expect(cmp.repeats.join(' ')).toMatch(/same trouble spots keep coming back: .*glide C3>C4 \(3 of 3 takes\)/);
    expect(cmp.worsened).toEqual([]);
    const smooth = cmp.metrics.find((m) => m.metric === 'glide.smoothness');
    expect(smooth?.gateMisses).toBe(3);
    expect(smooth?.verdict).toBe('same');
    expect(cmp.metrics.find((m) => m.metric === 'glide.cracks')?.verdict).toBe('better');
  });

  it('relates a repeated miss to the PROVISIONAL checklist row, and says whether it reads as the singer', () => {
    const hint = d.comparison?.hints.find((h) => h.startsWith('Smoothness'));
    expect(hint).toBeDefined();
    expect(hint).toMatch(/Checklist P7 Sirens, stairs and breaks/);
    expect(hint).toMatch(/the singing, not the app|mostly the singing/);
    expect(hint).toMatch(/it has not moved over the takes \(\d+(\.\d+)?% -> \d+(\.\d+)?% -> \d+(\.\d+)?%\)/);
    const text = formatDiagnosis(d);
    expect(text).toContain('ACROSS THE TAKES (oldest to newest; take 1 is the newest)');
    expect(text).toContain('Improving:');
    expect(text).toContain('The singer or the app?');
    expect(text.indexOf('TAKE 1 (newest) of 3')).toBeLessThan(text.indexOf('TAKE 3 of 3'));
  });

  it('lays the judged measures out take by take, with the gate and how often it was missed', () => {
    const text = formatDiagnosis(d);
    expect(text).toContain('The measures the level judges, take by take:');
    expect(text).toMatch(/\n {4}measure +take 3 +take 2 +take 1 +trend +gate\n/);
    expect(text).toMatch(/\n {4}Smoothness +\d+(\.\d+)?% +\d+(\.\d+)?% +\d+(\.\d+)?% +same +>= 25% \(missed in 3 of 3\)\n/);
    expect(text).toMatch(/\n {4}Breaks +3 +2 +1 +better +<= 3\.8 \(missed in 0 of 3\)\n/);
    expect(text).toMatch(/\n {4}Arrival +\d+(\.\d+)? cents/);
    expect(d.comparison?.metrics.find((m) => m.metric === 'glide.cracks')).toMatchObject({ gate: '<= 3.8', gateMisses: 0 });
  });

  it('shows one take in detail when asked, and still compares them all', () => {
    const text = formatDiagnosis(d, { take: 2 });
    expect(text).toContain('TAKE 2 of 3');
    expect(text).not.toContain('TAKE 1 (newest) of 3');
    expect(text).not.toContain('TAKE 3 of 3');
    expect(text).toContain('ACROSS THE TAKES');
    expect(formatDiagnosis(d, { take: 9 })).toContain('(no take 9: the file has 3)');
  });

  it('calls a miss by a hair a near miss, and blames the threshold only when every miss is one', () => {
    // three takes that all fall just short of the smoothness gate (0.25)
    const attempts = [0.24, 0.24, 0.235].map((s, i) =>
      backupAttempt({ id: `n${i}`, minutes: i * 3, metrics: { 'glide.smoothness': s, 'glide.endAbsCents': 15, 'glide.cracks': 0 }, score: 0.55 }),
    );
    const r = analyzeInputs([backupInput(attempts)], {})[0];
    const smooth = r.takes[0].gates.find((g) => g.metric === 'glide.smoothness');
    expect(smooth?.met).toBe(false);
    expect(smooth?.nearMiss).toBe(true);
    const hint = r.comparison?.hints.find((h) => h.startsWith('Smoothness'));
    expect(hint).toMatch(/every miss is a near miss/);
    expect(hint).toMatch(/suspect the threshold as much as the singing/);
  });

  it('compareTakes copes with one take and with takes that could not measure a metric', () => {
    expect(compareTakes(SIRENS, [d.takes[0]]).rows).toHaveLength(1);
    const blank = { ...d.takes[0], metrics: {}, gates: d.takes[0].gates.map((g) => ({ ...g, value: null, met: null as boolean | null })) };
    const cmp = compareTakes(SIRENS, [blank, d.takes[1]]);
    expect(cmp.metrics.every((m) => m.values[1] === null)).toBe(true);
  });
});

describe('a backup', () => {
  const sirens = [0.45, 0.5, 0.52, 0.55, 0.5, 0.48, 0.51].map((score, i) =>
    backupAttempt({ id: `s${i}`, minutes: i * 4, score, metrics: { 'glide.smoothness': 0.1 + i * 0.02, 'glide.endAbsCents': 30, 'glide.cracks': 2 } }),
  );
  const pitch = [
    backupAttempt({
      id: 'p1a',
      minutes: 100,
      exerciseId: PITCH_MATCH.id,
      levelId: 'foundations.02',
      score: 0.8,
      passed: true,
      mastery: 1,
      metrics: { 'accuracy.inTolerancePct': 80, 'accuracy.medianAbsCents': 15, 'onset.settleMs': 200 },
    }),
  ];
  const song = [backupAttempt({ id: 'song1', minutes: 110, exerciseId: 'song.twinkle', levelId: null, kind: 'song', score: 0.7, passed: true })];

  it('looks at the exercise of the newest attempt by default, and says where the singer is', () => {
    const [d] = analyzeInputs([backupInput([...sirens, ...pitch])], {});
    expect(d.source).toBe('backup');
    expect(d.exercise.id).toBe(PITCH_MATCH.id);
    expect(d.takes).toHaveLength(1);
    expect(d.overview?.profile.name).toBe('Test Singer');
    expect(d.overview?.attempts).toBe(8);
    expect(d.overview?.exercises.map((e) => e.exerciseId)).toEqual([PITCH_MATCH.id, SIRENS.id]);
    expect(d.overview?.exercises[1]).toMatchObject({ attempts: 7, passes: 0, missesInARow: 7 });
    expect(d.overview?.worlds[0]).toMatchObject({ worldId: 'foundations' });
  });

  it('takes the exercise from a flag (an id, a level, or a title) and lists the last six attempts of it', () => {
    for (const exercise of ['foundations.siren.1', 'foundations.05', 'sirens']) {
      const [d] = analyzeInputs([backupInput([...sirens, ...pitch, ...song])], { exercise });
      expect(d.exercise.id).toBe(SIRENS.id);
      expect(d.takes).toHaveLength(6);
      expect(d.takes.map((t) => t.attemptId)).toEqual(['s6', 's5', 's4', 's3', 's2', 's1']);
      expect(d.takes.every((t) => t.source === 'metrics')).toBe(true);
    }
    expect(() => analyzeInputs([backupInput(sirens)], { exercise: 'no such thing' })).toThrow(/no exercise matches "no such thing"/);
    expect(() => analyzeInputs([backupInput(sirens)], { exercise: 'foundations.' })).toThrow(/matches \d+ exercises/);
    expect(() => analyzeInputs([backupInput(sirens)], { exercise: 'foundations.sustain.1' })).toThrow(/has no attempts of Sustain I/);
  });

  it('reads the numbers it has: the gates against their targets, the costliest term, the streak and the trend', () => {
    const [d] = analyzeInputs([backupInput(sirens)], {});
    const t = d.takes[0];
    expect(t.verdict.passed).toBe(false);
    expect(t.verdict.app).toEqual({ passed: false, score: 0.51 });
    expect(t.gates.find((g) => g.metric === 'glide.smoothness')).toMatchObject({ met: false, shown: '22%', targetShown: '25%' });
    expect(t.terms[0].metric).toBe('glide.smoothness');
    expect(t.notes.join(' ')).toMatch(/No pitch line for this take/);
    expect(t.graph).toBeNull();
    expect(d.streak).toEqual({ misses: 7, depth: 4, atLeast: false });
    expect(d.comparison?.improved.join(' ')).toMatch(/Smoothness/);
    const text = formatDiagnosis(d);
    expect(text).toContain('WHERE TEST SINGER IS');
    expect(text).toContain('7 misses in a row');
    expect(text).toContain('<- looked at below');
    expect(text).toMatch(/^[\x00-\x7F]*$/);
  });

  it('flags a re-score that disagrees with the saved score: the thresholds moved', () => {
    const odd = backupAttempt({ id: 'odd', minutes: 1, score: 0.95, passed: true, mastery: 3, metrics: { 'glide.smoothness': 0.1, 'glide.endAbsCents': 30, 'glide.cracks': 2 } });
    const [d] = analyzeInputs([backupInput([odd])], {});
    expect(d.takes[0].checks.join(' ')).toMatch(/Re-scoring the saved numbers against today's catalog gives \d+%, not the 95% the app saved/);
  });

  it('picks the profile by name, and refuses one that is not there', () => {
    const other: ProfileRecord = { ...PROFILE, id: 'p2', profileId: 'p2', name: 'Sam' };
    const input = backupInput([...sirens, backupAttempt({ id: 'sam1', minutes: 200, profileId: 'p2', score: 0.3 })], [PROFILE, other]);
    const [byDefault] = analyzeInputs([input], {});
    expect(byDefault.overview?.profile.name).toBe('Sam'); // sang most recently
    const [chosen] = analyzeInputs([input], { profile: 'test singer' });
    expect(chosen.overview?.profile.name).toBe('Test Singer');
    expect(chosen.overview?.otherProfiles).toEqual(['Sam']);
    expect(() => analyzeInputs([input], { profile: 'Nobody' })).toThrow(/no profile matches "Nobody" \(the backup has: Test Singer, Sam\)/);
  });

  it('is told when there is nothing it can read about', () => {
    expect(() => analyzeInputs([backupInput([])], {})).toThrow(/has no attempts in the backup/);
    expect(() => analyzeInputs([backupInput(song)], {})).toThrow(/none of Test Singer's attempts is of an exercise/);
    expect(() => analyzeInputs([], {})).toThrow(/no file to read/);
  });

  it('coaches from the saved numbers when the engine can, and says so when it cannot', () => {
    const withCoach: CoachEngine = {
      ...fakeEngine(),
      coachFrom: (src) => ({
        depth: 4,
        missesInARow: 3,
        passed: src.passed,
        problem: { tipId: 'glide.stairs', metric: 'glide.smoothness', what: 'From the numbers alone: the slides were stepped.', spots: [] },
        tip: 'Tip from numbers.',
        why: 'Why from numbers.',
        steps: ['Step one.'],
        easier: 'An easier way in.',
        progress: [],
        moves: [{ kind: 'send-to-claude' }],
      }),
    };
    const [d] = analyzeInputs([backupInput(sirens)], { engine: withCoach });
    const text = formatDiagnosis(d);
    expect(d.takes[0].engine.coaching?.depth).toBe(4);
    expect(text).toContain('From the numbers alone: the slides were stepped.');
    expect(text).toContain('where: not placed: there is no pitch line for this take');
    expect(text).toContain('buttons: Send to Claude');
    expect(d.engine.status).toBe('ok');
    // without coachFrom the content ladder (when it exists) stands in
    const [bare] = analyzeInputs([backupInput(sirens)], { engine: fakeEngine() });
    expect(bare.takes[0].engine.coaching).toBeNull();
    expect(bare.engine.status).toBe('unused');
  });
});

// ---------------------------------------------------------------- audio

/** Take audio for `realized`: the notes sung on pitch (a harmonic tone), starting `lateSec` after each note starts. */
function singAudio(realized: RealizedExercise, o: { lateSec?: number; sampleRate?: number } = {}): Float32Array {
  const sampleRate = o.sampleRate ?? 48000;
  const f0 = notesContour(realized.notes.map((n) => ({ midi: n.midi, start: n.start + (o.lateSec ?? 0), end: n.end })));
  return synthesize({ sampleRate, duration: realized.totalSec + 0.4, f0, amp: 0.3 });
}

const wavBase64 = (samples: Float32Array): string => bytesToBase64(new Uint8Array(encodeWav(samples, 48000)));

describe('audio', () => {
  it('rebuilds the pitch line with the production framer and detector, take-relative', () => {
    const tone = synthesize({ sampleRate: 48000, duration: 1.5, f0: 220, amp: 0.3 });
    const track = trackFromSamples(tone, 48000);
    // the live take keeps 0.5 s before the downbeat: the first frame is a window's half-length in, less that
    expect(track[0].t).toBeCloseTo(1024 / 48000 - 0.5, 6);
    const voiced = track.filter((f) => f.voiced && f.t > 0.05 && f.t < 1.4);
    expect(voiced.length).toBeGreaterThan(100);
    for (const f of voiced) expect(Math.abs(f.midi - hzToMidi(220))).toBeLessThan(0.03);
    // before the downbeat there is only the silent pre-roll
    expect(track.filter((f) => f.t < -0.05).every((f) => !f.voiced)).toBe(true);
  });

  it('puts each note where it was sung in take time', () => {
    const realized = realizeAtTonic(SUSTAIN, 53, 60);
    const track = trackFromSamples(singAudio(realized), 48000);
    for (const n of realized.notes) {
      const inNote = track.filter((f) => f.voiced && f.t > n.start + 0.3 && f.t < n.end - 0.1);
      expect(inNote.length).toBeGreaterThan(100);
      for (const f of inNote) expect(Math.abs(f.midi - n.midi)).toBeLessThan(0.05);
    }
    const first = track.find((f) => f.voiced);
    expect(first?.t).toBeGreaterThan(-0.01);
    expect(first?.t).toBeLessThan(0.1);
  });

  it('works at 44.1 kHz too', () => {
    const realized = realizeAtTonic(SUSTAIN, 53, 60);
    const track = trackFromSamples(singAudio(realized, { sampleRate: 44100 }), 44100);
    const inNote = track.filter((f) => f.voiced && f.t > 0.3 && f.t < 3.5);
    expect(inNote.length).toBeGreaterThan(100);
    expect(Math.abs(inNote[inNote.length >> 1].midi - 53)).toBeLessThan(0.05);
  });

  const wavInput = (samples: Float32Array, name = 'pitch-lab-take-2026-10-22.wav'): CoachInput => readCoachInput(new Uint8Array(encodeWav(samples, 48000)), name);

  it('analyzes a WAV against the named exercise and passes a clean take', () => {
    const realized = realizeAtTonic(SUSTAIN, 53, 60);
    const [d] = analyzeInputs([wavInput(singAudio(realized))], { exercise: 'foundations.sustain.1', tonic: 'F3' });
    const t = d.takes[0];
    expect(d.source).toBe('wav');
    expect(t.source).toBe('audio');
    expect(t.tonicMidi).toBe(53);
    expect(t.bpm).toBe(60);
    expect(t.verdict.passed).toBe(true);
    expect(t.verdict.app).toBeNull();
    expect(t.figures.filter((f) => f.kind === 'accuracy')).toHaveLength(3);
    expect(t.figures.filter((f) => f.bad)).toEqual([]);
    expect(t.graph?.lines.join('\n')).toContain('*');
    const text = formatDiagnosis(d);
    expect(text).toContain('pitch line rebuilt from audio');
    expect(text).toContain('PASS');
  });

  it('finds a break in a siren WAV where it was made, through the real framer and detector', () => {
    const realized = realizeAtTonic(SIRENS, 48, 60);
    const siren = (dropout: { at: number; sec: number } | null): Float32Array => {
      const f0 = (t: number): number => {
        if (dropout && t >= dropout.at && t < dropout.at + dropout.sec) return NaN; // the voice cuts out
        const n = realized.notes.find((x) => t >= x.start && t < x.end);
        return n ? midiToHz(targetMidiAt(n, t)) : NaN;
      };
      return synthesize({ sampleRate: 48000, duration: realized.totalSec + 0.4, f0, amp: 0.3 });
    };
    const read = (audio: Float32Array) => analyzeInputs([wavInput(audio)], { exercise: 'foundations.siren.1', tonic: 'C3' })[0].takes[0];
    const clean = read(siren(null));
    expect(clean.verdict.passed).toBe(true);
    expect(clean.cracks).toEqual([]);
    const broken = read(siren({ at: 8.5, sec: 0.09 }));
    // the siren from 0:07 to 0:10 climbs C3 to C4: at 8.5 s it is on F#3
    expect(broken.cracks).toHaveLength(1);
    expect(broken.cracks[0].kind).toBe('dropout');
    expect(Math.abs(broken.cracks[0].t - 8.5)).toBeLessThan(0.1);
    expect(broken.cracks[0].durationMs).toBeGreaterThan(50);
    expect(broken.cracks[0].near).toBe('F#3');
    const mark = broken.graph?.marks[0];
    expect(mark?.row).not.toBeNull();
    expect(broken.graph?.lines[mark?.row as number][(broken.graph?.labelWidth ?? 0) + (mark?.col ?? 0)]).toBe('x');
    expect(broken.figures.find((f) => f.kind === 'crack')?.text).toMatch(/^at 0:08\.5 near F#3: the voice dropped out for \d+(\.\d+)? ms/);
    expect(broken.insights.join(' ')).toMatch(/1 break: F#3/);
  });

  it('works out which key a WAV was sung in when nothing says', () => {
    const realized = realizeAtTonic(SUSTAIN, 53, 60);
    const wav = singAudio(realized);
    expect(inferTonic(SUSTAIN, trackFromSamples(wav, 48000), 60)).toBe(53);
    const [d] = analyzeInputs([wavInput(wav)], { exercise: 'foundations.sustain.1' });
    expect(d.takes[0].tonicMidi).toBe(53);
    expect(d.takes[0].notes.join(' ')).toMatch(/The tonic \(F3\) was inferred from the audio/);
    expect(d.takes[0].verdict.passed).toBe(true);
  });

  it('sees a singer who comes in late, and says by how much', () => {
    const realized = realizeAtTonic(SUSTAIN, 53, 60);
    const [d] = analyzeInputs([wavInput(singAudio(realized, { lateSec: 1.0 }))], { exercise: 'foundations.sustain.1', tonic: 53 });
    const t = d.takes[0];
    expect(t.insights.join(' ')).toMatch(/Came in late on 3 of 3 notes \(median (0\.9\d|1(\.\d+)?) s after the note started\)/);
    // 1.0 s late, give or take the half frame the detector's window centre adds
    expect(t.figures.filter((f) => f.kind === 'accuracy').every((f) => /came in (0\.9\d|1(\.\d+)?) s late/.test(f.text))).toBe(true);
    expect(t.figures.filter((f) => f.kind === 'accuracy').every((f) => /bias 0 cents/.test(f.text))).toBe(true);
  });

  it('needs to be told the exercise when nothing else does, and says what to give', () => {
    const realized = realizeAtTonic(SUSTAIN, 53, 60);
    expect(() => analyzeInputs([wavInput(singAudio(realized))], {})).toThrow(/a WAV alone does not say which exercise it is: add --exercise/);
    expect(() => analyzeInputs([wavInput(singAudio(realized))], { exercise: 'foundations.sustain.1', tonic: 'H9' })).toThrow(/"H9" is not a tonic/);
    expect(() => analyzeInputs([wavInput(new Float32Array(48000))], { exercise: 'foundations.sustain.1' })).toThrow(/could not tell which key the WAV was sung in/);
  });

  it('matches a WAV to a backup attempt by the day in its name and its length, or by a flag', () => {
    const realized = realizeAtTonic(SUSTAIN, 53, 60);
    const wav = wavInput(singAudio(realized), 'pitch-lab-take-2026-10-22.wav');
    const at = (minutes: number): string => new Date(T0 + minutes * 60_000).toISOString();
    const mk = (id: string, minutes: number, exerciseId: string): AttemptRecord =>
      backupAttempt({
        id,
        minutes,
        exerciseId,
        tonicMidi: 53,
        tempoBpm: 60,
        score: 0.8,
        passed: true,
        mastery: 1,
        metrics: { 'accuracy.inTolerancePct': 90, 'accuracy.sdCents': 10, 'accuracy.medianAbsCents': 12, 'accuracy.absDriftCentsPerSec': 1 },
      });
    const attempts = [mk('older', 10, SUSTAIN.id), mk('other', 20, PITCH_MATCH.id), mk('newer', 30, SUSTAIN.id), mk('newest-pm', 40, PITCH_MATCH.id)];
    const input = backupInput(attempts);
    const [byLength] = analyzeInputs([input, wav], {});
    expect(byLength.takes[0].attemptId).toBe('newer');
    expect(byLength.takes[0].notes.join(' ')).toMatch(/matched to the backup's attempt newer .* the WAV's length/);
    expect(byLength.takes[0].notes.join(' ')).toMatch(/2 attempts fit equally well, so the newest was used/);
    const [named] = analyzeInputs([input, wav], { attempt: 'older' });
    expect(named.takes[0].attemptId).toBe('older');
    const [nearest] = analyzeInputs([input, wav], { at: at(12) });
    expect(nearest.takes[0].attemptId).toBe('older');
    expect(() => analyzeInputs([input, wav], { attempt: 'nope' })).toThrow(/no attempt starts with "nope"/);
    // the attempt gives the tonic and tempo, and the earlier attempts of that exercise are compared in
    expect(byLength.takes[0].tonicMidi).toBe(53);
    expect(byLength.takes.map((t) => t.attemptId)).toEqual(['newer', 'older']);
    expect(byLength.takes[1].source).toBe('metrics');
    expect(byLength.comparison?.rows).toHaveLength(2);
  });
});

// ---------------------------------------------------------------- audio inside a coaching file

describe('a coaching file that carries audio', () => {
  const sustainLevel = { id: 'foundations.03', title: 'Sustain I' };

  it('checks the saved pitch line against one rebuilt from its audio', () => {
    const realized = realizeAtTonic(SUSTAIN, 53, 60);
    const audio = singAudio(realized);
    const file = coachingFileOf(SUSTAIN, sustainLevel, [{ id: 'a1', minutes: 0, track: trackFromSamples(audio, 48000), realized }]);
    file.takes[0].audioWavBase64 = wavBase64(audio);
    const t = diagnoseCoachingFile(file, { engine: fakeEngine() }).takes[0];
    expect(t.source).toBe('track');
    expect(t.trackCheck).not.toBeNull();
    expect(t.trackCheck?.bothVoiced).toBeGreaterThan(500);
    expect(t.trackCheck?.medianAbsCents).toBeLessThan(1);
    expect(t.trackCheck?.octaveDisagreements).toBe(0);
    expect(t.checks.join(' ')).toMatch(/Audio check: the pitch line rebuilt from the audio has \d+ voiced frames against \d+ saved/);
    expect(t.checks.join(' ')).toContain('They agree.');
  });

  it('says when the audio is not the take, or the live detector heard it differently', () => {
    const file = sirensFile([{}]);
    const wav = readCoachInput(new Uint8Array(encodeWav(singAudio(realizeAtTonic(SUSTAIN, 53, 60)), 48000)), 'pitch-lab-take-2026-10-22.wav');
    const [d] = analyzeInputs([readBack(file), wav], { engine: fakeEngine() });
    expect(d.takes[0].checks.join(' ')).toMatch(/They disagree: the live detector may not have been MPM/);
    // A file that names its detector leaves only the other explanation.
    const named = sirensFile([{}]);
    named.settings = { ...named.settings, detector: 'yin' };
    const [n] = analyzeInputs([readBack(named), wav], { engine: fakeEngine() });
    expect(n.takes[0].checks.join(' ')).toMatch(/They disagree: the audio was rebuilt with the detector the take was sung with \(YIN\), so this audio is probably not that take/);
  });

  it('rebuilds the audio with the detector the file names (Settings: YIN)', () => {
    const realized = realizeAtTonic(SUSTAIN, 53, 60);
    const audio = singAudio(realized);
    const file = coachingFileOf(SUSTAIN, sustainLevel, [{ id: 'a1', minutes: 0, track: trackFromSamples(audio, 48000, { detector: 'yin' }), realized }]);
    file.settings = { ...file.settings, detector: 'yin' };
    file.takes[0].audioWavBase64 = wavBase64(audio);
    const input = readBack(file);
    expect(input.kind === 'coaching' && input.file.settings.detector).toBe('yin');
    const t = analyzeInputs([input], { engine: fakeEngine() })[0].takes[0];
    // The same detector on the same audio: the same pitch line, but for the saved line's 32-bit rounding.
    expect(t.trackCheck?.rebuiltVoicedFrames).toBe(t.trackCheck?.savedVoicedFrames);
    expect(t.trackCheck?.bothVoiced).toBe(t.trackCheck?.savedVoicedFrames);
    expect(t.trackCheck?.medianAbsCents).toBeLessThan(0.001);
    expect(t.trackCheck?.octaveDisagreements).toBe(0);
    expect(t.checks.join(' ')).toContain('They agree.');
  });

  it('uses the audio when the file has no pitch line for the take', () => {
    const realized = realizeAtTonic(SUSTAIN, 53, 60);
    const audio = singAudio(realized);
    const file = coachingFileOf(SUSTAIN, sustainLevel, [{ id: 'a1', minutes: 0, track: trackFromSamples(audio, 48000), realized }]);
    file.takes[0].track = null;
    file.takes[0].audioWavBase64 = wavBase64(audio);
    const t = diagnoseCoachingFile(file, { engine: fakeEngine() }).takes[0];
    expect(t.source).toBe('audio');
    expect(t.verdict.passed).toBe(true);
  });

  it('falls back to the saved numbers when a take has neither, and says what to ask for', () => {
    const file = sirensFile([CRACK_AND_STAIRS]);
    file.takes[0].track = null;
    const t = diagnoseCoachingFile(file, { engine: fakeEngine() }).takes[0];
    expect(t.source).toBe('metrics');
    expect(t.notes.join(' ')).toMatch(/No pitch line for this take/);
    expect(t.verdict.passed).toBe(false);
  });

  it('puts a WAV given beside a coaching file on its newest take (or the one named)', () => {
    const realized = realizeAtTonic(SUSTAIN, 53, 60);
    const audio = singAudio(realized);
    const file = coachingFileOf(SUSTAIN, sustainLevel, [
      { id: 'a2', minutes: 10, track: trackFromSamples(audio, 48000), realized },
      { id: 'a1', minutes: 0, track: trackFromSamples(audio, 48000), realized },
    ]);
    const wav = readCoachInput(new Uint8Array(encodeWav(audio, 48000)), 'pitch-lab-take-2026-10-22.wav');
    const [first] = analyzeInputs([readBack(file), wav], { engine: fakeEngine() });
    expect(first.takes[0].trackCheck).not.toBeNull();
    expect(first.takes[1].trackCheck).toBeNull();
    const [second] = analyzeInputs([readBack(file), wav], { engine: fakeEngine(), take: 2 });
    expect(second.takes[0].trackCheck).toBeNull();
    expect(second.takes[1].trackCheck).not.toBeNull();
  });
});

// ---------------------------------------------------------------- the file the app writes

describe('the file the app writes', () => {
  it('is the file this tool reads: export.ts buildCoachingFileFrom, serialized as the share sheet takes it', async () => {
    const { buildCoachingFileFrom, coachingBlob, coachingFileName } = await import('./export');
    const realized = sirensRealized();
    const specs: SirenFaults[] = [{}, CRACK_AND_STAIRS, CRACK_AND_STAIRS]; // oldest first
    const fixtures = specs.map((spec, i): FixtureTake => ({ id: `att-${i + 1}`, minutes: i * 3, track: sirenTake(realized, spec), realized }));
    // the newest take has no saved pitch line (its recording did not save): the file carries its numbers only
    const attempts = fixtures.map((t, i) => ({ ...attemptOf(SIRENS, SIRENS_LEVEL, t), takeId: i < 2 ? `take-${i}` : null }));
    const takes = new Map(
      fixtures.slice(0, 2).map((t, i) => [
        `take-${i}`,
        { id: `take-${i}`, profileId: 'p1', createdAt: attempts[i].createdAt, updatedAt: attempts[i].createdAt, deletedAt: null, exerciseId: SIRENS.id, track: encodeTrack(t.track), audioRef: null, sampleRate: 48000, latencyMs: 40 },
      ]),
    );
    const file = await buildCoachingFileFrom(
      SIRENS.id,
      { includeAudio: false },
      {
        storage: {
          profiles: { active: async () => ({ ...PROFILE, range: null }) },
          attempts: { listByExercise: async (profileId, exerciseId) => attempts.filter((a) => a.profileId === profileId && a.exerciseId === exerciseId) },
          takes: { get: async (id) => takes.get(id), audio: async () => undefined },
        },
        settings: { vibratoStyle: 'pop', notation: 'flats', keepTakeAudio: false },
        device: { route: 'wired', latencyMs: 40, userAgent: 'vitest' },
        now: new Date(T0 + 60 * 60_000),
        appVersion: '0.1.0+index-test',
      },
    );
    const name = coachingFileName(file);
    expect(name).toMatch(/^pitch-lab-coach-foundations-05-\d{4}-\d\d-\d\d-\d{4}\.json$/);
    const [d] = analyzeInputs([readCoachInput(new TextEncoder().encode(await coachingBlob(file).text()), name)], { engine: fakeEngine() });
    expect(d.title).toBe('Sirens & glides (foundations.05)');
    expect(d.appVersion).toBe('0.1.0+index-test');
    expect(d.singer?.notation).toBe('flats');
    expect(d.takes.map((t) => t.attemptId)).toEqual(['att-3', 'att-2', 'att-1']);
    expect(d.takes.map((t) => t.source)).toEqual(['metrics', 'track', 'track']);
    expect(d.takes.slice(1).every((t) => t.verdict.agrees === true)).toBe(true);
    expect(d.takes[1].verdict.passed).toBe(false);
    expect(d.takes[2].verdict.passed).toBe(true);
    expect(d.comparison?.rows).toHaveLength(3);
    expect(formatDiagnosis(d)).toContain('saved numbers only');
  });
});

// ---------------------------------------------------------------- the lines to read first

describe('the summary', () => {
  it('leads with the newest take, the coach, the streak, the trend and the singer-or-app read', () => {
    const d = diagnoseCoachingFile(sirensFile([CRACK_AND_STAIRS, CRACK_AND_STAIRS, CRACK_AND_STAIRS]), { engine: fakeEngine() });
    expect(d.summary[0]).toMatch(/^The newest take \(.*\): MISS at \d+(\.\d+)?% against a 60% pass mark; gates not met: Smoothness\.$/);
    expect(d.summary[1]).toBe("The coach's pick, glide.stairs: Your slides moved in steps instead of one smooth line.");
    expect(d.summary[2]).toBe('At least 3 misses in a row, so coaching depth 3 of 4.');
    expect(d.summary[3]).toMatch(/^Across the 3 takes the score is (flat|going up|going down) \(/);
    expect(d.summary.join(' ')).toMatch(/The singer or the app\? Smoothness:/);
    const text = formatDiagnosis(d);
    expect(text.indexOf('In short:')).toBeGreaterThan(text.indexOf('Engine:'));
    expect(text.indexOf('In short:')).toBeLessThan(text.indexOf('TAKE 1 (newest)'));
  });

  it('is short for a clean take: no coach, no trend', () => {
    const d = diagnoseCoachingFile(sirensFile([{}]), { engine: fakeEngine() });
    expect(d.summary).toHaveLength(3);
    expect(d.summary[0]).toMatch(/: PASS at \d+(\.\d+)?% against a 60% pass mark\.$/);
  });

  it('names the rule table when the engine is not there to name the problem', () => {
    const broken: CoachEngine = { ...fakeEngine(), locateProblem: () => { throw new Error('not built yet'); } };
    const d = diagnoseCoachingFile(sirensFile([CRACK_AND_STAIRS]), { engine: broken });
    expect(d.summary[1]).toMatch(/^The rule table's pick: glide\.\w+\.$/);
  });
});

// ---------------------------------------------------------------- misses in a row

describe('misses in a row and the log beyond the file', () => {
  it('uses the whole log from a backup given beside the coaching file', () => {
    const file = sirensFile([CRACK_AND_STAIRS, CRACK_AND_STAIRS]);
    const older = [4, 3, 2, 1].map((i) => backupAttempt({ id: `old${i}`, minutes: -10 * i, score: 0.4, metrics: {} }));
    const inFile = file.takes.map((t) => t.attempt).reverse();
    const [d] = analyzeInputs([readBack(file), backupInput([...older, ...inFile])], { engine: fakeEngine() });
    expect(d.streak).toEqual({ misses: 6, depth: 4, atLeast: false });
    const [alone] = analyzeInputs([readBack(file)], { engine: fakeEngine() });
    expect(alone.streak).toEqual({ misses: 2, depth: 2, atLeast: true });
    expect(formatDiagnosis(alone)).toContain('at least 2 misses in a row');
  });
});

// ---------------------------------------------------------------- the CLI

describe('scripts/coach.mjs', () => {
  let dir = '';
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pitch-lab-coach-test-'));
  });
  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const run = (args: string[], env?: Record<string, string>): { status: number; out: string; err: string } => {
    try {
      const out = childProcess.execFileSync(proc.execPath, [path.join(ROOT, 'scripts/coach.mjs'), ...args], {
        cwd: ROOT,
        encoding: 'utf8',
        timeout: 90_000,
        stdio: ['ignore', 'pipe', 'pipe'],
        ...(env ? { env: { ...proc.env, ...env } } : {}),
      });
      return { status: 0, out, err: '' };
    } catch (e) {
      const x = e as { status?: number; stdout?: string; stderr?: string };
      return { status: x.status ?? -1, out: x.stdout ?? '', err: x.stderr ?? '' };
    }
  };
  const write = (name: string, content: string | Uint8Array): string => {
    const p = path.join(dir, name);
    fs.writeFileSync(p, content);
    return p;
  };

  it('reads a coaching file end to end, and exits 0', () => {
    const file = write('pitch-lab-coach-foundations-05-2026-10-22-1405.json', JSON.stringify(sirensFile([{}, CRACK_AND_STAIRS])));
    const r = run([file]);
    expect(r.status).toBe(0);
    expect(r.out).toContain('PITCH LAB COACHING READ: Sirens & glides (foundations.05)');
    expect(r.out).toContain('TAKE 1 (newest) of 2');
    expect(r.out).toContain('MISS');
    expect(r.out).toContain('Pitch graph (time across, notes down):');
    expect(r.out).toContain('ACROSS THE TAKES');
  }, 90_000);

  it('prints JSON for --json, one take for --take, and refuses nothing it can read', () => {
    const file = write('two.json', JSON.stringify(sirensFile([{}, CRACK_AND_STAIRS])));
    const json = run([file, '--json', '--take', '2']);
    expect(json.status).toBe(0);
    const parsed = JSON.parse(json.out) as Array<{ source: string; takes: Array<{ index: number; verdict: { passed: boolean } }>; comparison: { rows: unknown[] } }>;
    expect(parsed[0].source).toBe('coaching');
    expect(parsed[0].takes.map((t) => t.index)).toEqual([2]);
    expect(parsed[0].takes[0].verdict.passed).toBe(true);
    expect(parsed[0].comparison.rows).toHaveLength(2);
    const text = run([file, '--take=1']);
    expect(text.out).toContain('TAKE 1 (newest) of 2');
    expect(text.out).not.toContain('TAKE 2 of 2');
  }, 90_000);

  it('exits non-zero with a clear message on a bad file, a missing file and bad usage', () => {
    const junk = write('junk.json', 'this is not json');
    const bad = run([junk]);
    expect(bad.status).toBe(1);
    expect(bad.err).toContain('coach: junk.json: not a Pitch Lab file (it is neither a WAV nor valid JSON)');
    expect(bad.out).toBe('');
    const missing = run([path.join(dir, 'nope.json')]);
    expect(missing.status).toBe(1);
    expect(missing.err).toMatch(/nope\.json: cannot read the file \(ENOENT\)/);
    expect(run([]).status).toBe(2);
    expect(run(['--bogus']).err).toContain('unknown option --bogus');
    expect(run(['--help']).out).toContain('node scripts/coach.mjs <file...>');
    const alone = run([write('x.wav', new Uint8Array(encodeWav(new Float32Array(4800), 48000)))]);
    expect(alone.status).toBe(1);
    expect(alone.err).toContain('a WAV alone does not say which exercise it is');
  }, 90_000);

  it('lists the newest pitch-lab files in a folder', () => {
    const folder = path.join(dir, 'drive');
    fs.mkdirSync(path.join(folder, 'sub'), { recursive: true });
    fs.writeFileSync(path.join(folder, 'pitch-lab-coach-a-2026-10-22-1405.json'), '{}');
    fs.writeFileSync(path.join(folder, 'sub', 'pitch-lab-take-2026-10-22.wav'), 'x');
    fs.writeFileSync(path.join(folder, 'notes.txt'), 'x');
    const r = run(['--list', folder]);
    expect(r.status).toBe(0);
    expect(r.out).toContain('Newest first');
    expect(r.out).toContain('pitch-lab-coach-a-2026-10-22-1405.json');
    expect(r.out).toContain('pitch-lab-take-2026-10-22.wav');
    expect(r.out).not.toContain('notes.txt');
    expect(run(['--list', path.join(dir, 'empty')]).out).toContain('No pitch-lab-coach-*.json');
  }, 90_000);

  it('finds every OneDrive folder in the home folder, whatever its organisation name, and Downloads', () => {
    // No account or organisation name is written into the script (review R2): it reads the home folder.
    const home = path.join(dir, 'home');
    fs.mkdirSync(path.join(home, 'OneDrive - Example School'), { recursive: true });
    fs.mkdirSync(path.join(home, 'Downloads'), { recursive: true });
    fs.mkdirSync(path.join(home, 'Documents'), { recursive: true });
    fs.writeFileSync(path.join(home, 'OneDrive - Example School', 'pitch-lab-coach-b-2026-10-22-1410.json'), '{}');
    fs.writeFileSync(path.join(home, 'Downloads', 'pitch-lab-backup-2026-10-22.json'), '{}');
    fs.writeFileSync(path.join(home, 'Documents', 'pitch-lab-take-2026-10-22.wav'), 'x');
    const r = run(['--list'], { HOME: home, USERPROFILE: home, OneDrive: '', OneDriveConsumer: '', OneDriveCommercial: '' });
    expect(r.status).toBe(0);
    expect(r.out).toContain('OneDrive - Example School/pitch-lab-coach-b-2026-10-22-1410.json');
    expect(r.out).toContain('Downloads/pitch-lab-backup-2026-10-22.json');
    expect(r.out).not.toContain('Documents');
    const script = fs.readFileSync(path.join(ROOT, 'scripts/coach.mjs'), 'utf8');
    expect(script).not.toMatch(/OneDrive - [A-Z]/);
  }, 90_000);
});

// ---------------------------------------------------------------- a sample for the docs (only when asked for)

describe('samples', () => {
  it.runIf(proc.env.COACH_SAMPLE_DIR !== undefined)('writes a sample coaching file, backup and WAV into COACH_SAMPLE_DIR', () => {
    const out = proc.env.COACH_SAMPLE_DIR as string;
    fs.mkdirSync(out, { recursive: true });
    // three takes, oldest first: stairs and three flips, stairs and two flips, then stairs and the one flip
    const file = sirensFile([
      { stairGlides: [0, 1, 2, 3, 4, 5], cracks: [{ t: 8.5 }, { t: 12.4 }, { t: 15.6 }] },
      { stairGlides: [0, 1, 2, 3, 4, 5], cracks: [{ t: 8.5 }, { t: 12.4 }] },
      CRACK_AND_STAIRS,
    ]);
    fs.writeFileSync(path.join(out, 'pitch-lab-coach-foundations-05-2026-10-22-1405.json'), JSON.stringify(file));
    const realized = realizeAtTonic(SUSTAIN, 53, 60);
    fs.writeFileSync(path.join(out, 'pitch-lab-take-2026-10-22.wav'), new Uint8Array(encodeWav(singAudio(realized), 48000)));
    const attempts = [0.45, 0.5, 0.52, 0.55, 0.5].map((score, i) =>
      backupAttempt({ id: `s${i}`, minutes: i * 4, score, metrics: { 'glide.smoothness': 0.1 + i * 0.03, 'glide.endAbsCents': 30, 'glide.cracks': 2 } }),
    );
    fs.writeFileSync(path.join(out, 'pitch-lab-backup-2026-10-22.json'), JSON.stringify(backupFile(attempts)));
  });
});
