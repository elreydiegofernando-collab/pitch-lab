/**
 * Offline coaching analysis: reads the files the owner sends from the phone and writes the diagnosis Claude reads in chat
 * ("this is the lesson I'm at: look at my last takes and tell me why I'm not getting it", owner, 2026-10-22).
 * scripts/coach.mjs loads this module through Vite's SSR loader; docs/COACHING.md is the workflow. Pure: no file access.
 *
 * Inputs (readCoachInput sniffs them):
 *  - a coaching file ("Send to Claude", coaching/types.ts CoachingFile): the exercise, the targets and the saved pitch line of
 *    up to 5 takes, newest first. Re-analyzed exactly as the app did, with the real analyzers (exercises/analyze.ts);
 *  - a backup (storage/backup.ts): the numbers only (metrics per attempt, no pitch line), so the diagnosis says what the app
 *    measured, never where in the take it happened;
 *  - a WAV (Data & backup, Export WAV): sample 0 is take time 0 (audio/take-recorder.ts alignRecording), so the pitch line is
 *    rebuilt with the production Framer and detector, then analyzed against the exercise (named by the coaching file, by the
 *    backup's matching attempt, or by a flag).
 *
 * Each take gets: what the exercise asks, pass or miss and why (score against the pass mark, every gate against its target,
 * what cost the most score), the located problem and the coaching card from the engine (coaching/coach.ts), per-figure
 * detail of what the analyzers found, an ASCII pitch graph, and a comparison across the takes (what improves, what repeats,
 * and which PROVISIONAL threshold of docs/MANUAL-TEST-CHECKLIST.md a repeated miss touches: "the singer" or "the app being
 * too strict"). The numbers are in engineering units (cents, ms, Hz) because the reader is Claude; what Claude tells the
 * singer must follow the plain-language rules (docs/COACHING.md).
 */
import { CONFIG, hopSizeFor } from '../config';
import { Framer } from '../audio/framer';
import { TAKE_PRE_ROLL_SEC, type TakeAudio, type TakeResult } from '../audio/take-recorder';
import { parseWav } from '../audio/wav';
import { scoreExercise, valueScore } from '../analysis/score';
import { cleanOctaveSpikes, framesInWindow, median, percentile, targetMidiAt } from '../analysis/track';
import type { CrackEvent, MetricKey, Metrics } from '../analysis/types';
import type { Notation } from '../core/music';
import type { PitchFrame, PitchTrack, TargetNote, VibratoStyle } from '../core/types';
import { centsOff, parseNote } from '../core/music';
import type { DetectorKind } from '../dsp/detector-types';
import { createDetector } from '../dsp/detector';
import { analyzeTake, type TakeAnalysis } from '../exercises/analyze';
import { EXERCISES, WORLDS, getExercise, getLevel, getWorld, levelForExercise } from '../exercises/catalog';
import { evaluate, notesNeeded, passRequirements, reportTiles, type Evaluation } from '../exercises/evaluate';
import { canPassAtTempo, ladderOf, nextTempo } from '../exercises/ladder';
import { FOLLOWS_CUE_SCORE } from '../exercises/loudness';
import { METRIC_INFO } from '../exercises/metrics';
import { pickTip, type PickedTip } from '../exercises/tips';
import { materialSpan, realize, type RealizedExercise } from '../exercises/transpose';
import type { ExerciseDef, LevelDef } from '../exercises/types';
import { computeSnapshot } from '../progress/engine';
import type { ProgressSnapshot } from '../progress/types';
import { withRoutines } from '../progress/routines';
import type { PreparedRun, RunTarget, TakeOutcome } from '../runtime/types';
import type { AttemptRecord, ProfileRecord, VocalRange } from '../storage/schema';
import { base64ToBytes, decodeTrack, isStoredTrack } from '../storage/track-codec';
import * as coachModule from './coach';
import { coachTake, depthFor, locateProblem, missesInARow } from './coach';
import { ladderFor } from './content/index';
import { COACHING_FILE_VERSION, type CoachDepth, type CoachMove, type Coaching, type CoachingFile, type ProgressLine, type TakeProblem } from './types';

// ---------------------------------------------------------------- small helpers

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isDetector = (v: unknown): v is DetectorKind => v === 'mpm' || v === 'yin';
const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const pad = (s: string, n: number): string => (s.length >= n ? s : s + ' '.repeat(n - s.length));
const lpad = (s: string, n: number): string => (s.length >= n ? s : ' '.repeat(n - s.length) + s);
const clampInt = (x: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, Math.round(x)));

/** A file this tool cannot use: the CLI prints the message and exits non-zero. */
export class CoachInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CoachInputError';
  }
}

const SHARP_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'] as const;
const FLAT_NAMES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'] as const;

/** "F#3" / "Gb3": the plain-ASCII note name (the app's own noteName uses the real sharp and flat glyphs). */
export function noteLabel(midi: number, notation: Notation = 'sharps'): string {
  if (!Number.isFinite(midi)) return '-';
  const m = Math.round(midi);
  const names = notation === 'flats' ? FLAT_NAMES : SHARP_NAMES;
  return `${names[((m % 12) + 12) % 12]}${Math.floor(m / 12) - 1}`;
}

/** "0:04.2": take time as minutes, seconds and tenths. */
export function clock(t: number): string {
  if (!Number.isFinite(t)) return '-';
  const tenths = Math.round(Math.abs(t) * 10);
  const m = Math.floor(tenths / 600);
  const s = (tenths % 600) / 10;
  return `${t < 0 && tenths > 0 ? '-' : ''}${m}:${s.toFixed(1).padStart(4, '0')}`;
}

/** A readable number: 3.8, 52, 0.31, 240. */
function fmtNum(x: number): string {
  if (!Number.isFinite(x)) return '-';
  const a = Math.abs(x);
  return String(Number(x.toFixed(a >= 100 ? 0 : a >= 10 ? 1 : 2)));
}

/** "+12", "-3", and a plain "0" for anything that rounds to nothing. */
function signed(x: number): string {
  const mag = fmtNum(Math.abs(x));
  return mag === '0' ? '0' : `${x >= 0 ? '+' : '-'}${mag}`;
}
const pct = (x: number | null | undefined): string => (x === null || x === undefined || !Number.isFinite(x) ? '-' : `${Math.round(x * 100)}%`);

function unitSuffix(unit: string): string {
  switch (unit) {
    case '':
      return '';
    case '%':
      return '%';
    case '\u00A2': // the cent sign METRIC_INFO uses
      return ' cents';
    case '\u00A2/s':
      return ' cents/s';
    case '\u00A2/dB':
      return ' cents/dB';
    default:
      return ` ${unit}`;
  }
}

/** A metric's value with its unit, in plain ASCII ("18 cents", "62%", "5.8 Hz"). */
function fmtMetric(metric: MetricKey, value: number): string {
  const info = METRIC_INFO[metric];
  return `${fmtNum(value * info.scale)}${unitSuffix(info.unit)}`;
}

/** A distance on a metric's scale ("7 pts" for a rate, "12 cents", "0.4 Hz"). */
function fmtDelta(metric: MetricKey, delta: number): string {
  const info = METRIC_INFO[metric];
  return `${fmtNum(Math.abs(delta) * info.scale)}${info.unit === '%' ? ' pts' : unitSuffix(info.unit)}`;
}

/** The viewer's local "2026-10-22 14:05" for an ISO time; the text itself when it does not parse. */
function localStamp(iso: string | null | undefined): string {
  if (!iso) return 'unknown time';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p2 = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
}

/** Typographic characters the app's own text uses, and what each is written as in plain ASCII (cents get their name). */
const FOLDS: ReadonlyArray<readonly [RegExp, string]> = [
  [/[\u2018\u2019\u201B]/g, "'"],
  [/[\u201C\u201D]/g, '"'],
  [/[\u2013\u2014]/g, '-'],
  [/\u2026/g, '...'],
  [/\u2265/g, '>='],
  [/\u2264/g, '<='],
  [/\s?\u00A2/g, ' cents'],
  [/\u266F/g, '#'],
  [/\u266D/g, 'b'],
  [/\u00D7/g, 'x'],
  [/\u2192/g, '->'],
  [/\u00B1/g, '+/-'],
  [/[\u00B7\u2022]/g, '-'],
  [/\u00A0/g, ' '],
];

/** The combining accents NFD splits off a letter ("e" and an acute accent), so "Jose" comes out for the same name with the accent. */
const COMBINING_MARKS = new RegExp(`[${String.fromCharCode(0x300)}-${String.fromCharCode(0x36f)}]`, 'g');

/** The text as plain ASCII, so a console in any code page prints it as written. */
function fold(text: string): string {
  let out = text;
  for (const [re, to] of FOLDS) out = out.replace(re, to);
  return out.normalize('NFD').replace(COMBINING_MARKS, '').replace(/[^\x00-\x7F]/g, '?');
}

/** Unique-ish key of an attempt for ordering: when it was created, then its clock stamp, then its id. */
function byAge(a: AttemptRecord, b: AttemptRecord): number {
  return a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.updatedAt < b.updatedAt ? -1 : a.updatedAt > b.updatedAt ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

const lookupExercise = withRoutines(getExercise);

// ---------------------------------------------------------------- reading files

export interface WavSamples {
  samples: Float32Array;
  sampleRate: number;
}

/** A backup as this tool reads it: live attempts and profiles only, every row checked (storage/backup.ts is the writer). */
export interface ParsedBackup {
  exportedAt: string;
  profiles: ProfileRecord[];
  /** Live attempts of every profile, oldest first. */
  attempts: AttemptRecord[];
  /** Per-profile settings the backup carried (only the ones this tool uses). */
  settings: Record<string, { vibratoStyle?: VibratoStyle; notation?: Notation; detector?: DetectorKind }>;
  warnings: string[];
}

export type CoachInput =
  | { kind: 'coaching'; name: string; file: CoachingFile }
  | { kind: 'backup'; name: string; backup: ParsedBackup }
  | { kind: 'wav'; name: string; wav: WavSamples };

/** The same text storage/backup.ts writes (BACKUP_FORMAT, BACKUP_VERSION): that module pulls in the database, this one must not. */
const BACKUP_FORMAT = 'pitch-lab-backup';
const BACKUP_VERSION = 1;

const ATTEMPT_KINDS: ReadonlySet<string> = new Set(['practice', 'audition', 'boss', 'record', 'song', 'workout']);

function sanitizeMetrics(raw: unknown): Metrics {
  const out: Metrics = {};
  if (!isObj(raw)) return out;
  for (const key of Object.keys(METRIC_INFO) as MetricKey[]) {
    const v = raw[key];
    if (isNum(v)) out[key] = v;
  }
  return out;
}

/** One attempt row checked and filled in; null when it cannot be used. */
function toAttempt(raw: unknown): AttemptRecord | null {
  if (!isObj(raw)) return null;
  if (typeof raw.id !== 'string' || typeof raw.exerciseId !== 'string' || !isNum(raw.score) || typeof raw.passed !== 'boolean') return null;
  const createdAt = typeof raw.createdAt === 'string' ? raw.createdAt : '';
  const mastery = raw.mastery === 1 || raw.mastery === 2 || raw.mastery === 3 ? raw.mastery : 0;
  const attempt: AttemptRecord = {
    id: raw.id,
    profileId: typeof raw.profileId === 'string' ? raw.profileId : 'unknown',
    createdAt,
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : createdAt,
    deletedAt: typeof raw.deletedAt === 'string' ? raw.deletedAt : null,
    exerciseId: raw.exerciseId,
    levelId: typeof raw.levelId === 'string' ? raw.levelId : null,
    kind: typeof raw.kind === 'string' && ATTEMPT_KINDS.has(raw.kind) ? (raw.kind as AttemptRecord['kind']) : 'practice',
    score: raw.score,
    passed: raw.passed,
    mastery,
    metrics: sanitizeMetrics(raw.metrics),
    durationSec: isNum(raw.durationSec) ? raw.durationSec : 0,
    tonicMidi: isNum(raw.tonicMidi) ? raw.tonicMidi : null,
    tempoBpm: isNum(raw.tempoBpm) ? raw.tempoBpm : null,
    takeId: typeof raw.takeId === 'string' ? raw.takeId : null,
  };
  if (typeof raw.songId === 'string') attempt.songId = raw.songId;
  return attempt;
}

function parseExercise(raw: unknown, bad: (why: string) => never): ExerciseDef {
  if (!isObj(raw)) return bad('the "exercise" block is missing');
  const need = (ok: boolean, what: string): void => {
    if (!ok) bad(`the exercise block ${what}`);
  };
  const knownMetric = (m: unknown): boolean => typeof m === 'string' && Object.hasOwn(METRIC_INFO, m);
  need(typeof raw.id === 'string' && raw.id.length > 0, 'has no id');
  need(typeof raw.title === 'string', 'has no title');
  need(Array.isArray(raw.pattern) && raw.pattern.every((s) => isObj(s) && isNum(s.beats)), 'has no usable pattern');
  need(isNum(raw.tempoBpm) && raw.tempoBpm > 0, 'has no tempo');
  need(isNum(raw.countInBeats), 'has no count-in');
  need(typeof raw.tonicPlacement === 'string', 'has no tonic placement');
  need(Array.isArray(raw.analyzers), 'has no analyzers list');
  need(
    Array.isArray(raw.scoring) && raw.scoring.every((t) => isObj(t) && knownMetric(t.metric) && isNum(t.weight) && isNum(t.best) && isNum(t.worst)),
    'has an unusable scoring list (an unknown metric: a file from a newer app?)',
  );
  need(
    isObj(raw.pass) &&
      isNum(raw.pass.score) &&
      (raw.pass.gates === undefined ||
        (Array.isArray(raw.pass.gates) && raw.pass.gates.every((g) => isObj(g) && knownMetric(g.metric) && (g.op === '>=' || g.op === '<=') && isNum(g.value)))),
    'has an unusable pass rule',
  );
  need(typeof raw.tolerance === 'string' && Object.hasOwn(CONFIG.tolerance, raw.tolerance), 'has an unknown tolerance');
  need(isObj(raw.tiers) && isNum(raw.tiers.solid) && isNum(raw.tiers.studio), 'has no mastery tiers');
  return raw as unknown as ExerciseDef;
}

/** Checks a coaching file (coaching/types.ts) and fills the optional blocks; throws CoachInputError saying what is wrong. */
export function parseCoachingFile(raw: unknown, name = 'the coaching file'): CoachingFile {
  const bad = (why: string): never => {
    throw new CoachInputError(`${name}: ${why}`);
  };
  if (!isObj(raw)) return bad('not a JSON object');
  if (raw.app !== 'pitch-lab' || raw.kind !== 'coaching') return bad('not a Pitch Lab coaching file (it needs "app": "pitch-lab" and "kind": "coaching")');
  const version = raw.version;
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) return bad(`unusable coaching file version ${String(version)}`);
  if (version > COACHING_FILE_VERSION) {
    return bad(`made by a newer app (coaching file version ${version}); this tool reads up to version ${COACHING_FILE_VERSION}, so update the repo and try again`);
  }
  const exercise = parseExercise(raw.exercise, bad);
  if (!Array.isArray(raw.takes) || raw.takes.length === 0) return bad('the file holds no takes');
  const takes: CoachingFile['takes'] = raw.takes.map((t, i) => {
    const n = i + 1;
    if (!isObj(t)) return bad(`take ${n} is not an object`);
    const attempt = toAttempt(t.attempt);
    if (!attempt) return bad(`take ${n} has no usable attempt record`);
    const rz = t.realized;
    if (
      !isObj(rz) ||
      !isNum(rz.tonicMidi) ||
      !isNum(rz.bpm) ||
      !Array.isArray(rz.notes) ||
      !rz.notes.every((x) => isObj(x) && isNum(x.midi) && isNum(x.start) && isNum(x.end))
    ) {
      return bad(`take ${n} has no usable "realized" block (tonic, tempo and target notes)`);
    }
    if (t.track !== null && t.track !== undefined && !isStoredTrack(t.track)) return bad(`take ${n} has a damaged pitch line`);
    if (t.audioWavBase64 !== null && t.audioWavBase64 !== undefined && typeof t.audioWavBase64 !== 'string') return bad(`take ${n} has damaged audio`);
    return {
      attempt,
      realized: {
        tonicMidi: rz.tonicMidi,
        bpm: rz.bpm,
        countInSec: isNum(rz.countInSec) ? rz.countInSec : 0,
        totalSec: isNum(rz.totalSec) ? rz.totalSec : 0,
        notes: rz.notes as TargetNote[],
      },
      track: t.track ?? null,
      audioWavBase64: typeof t.audioWavBase64 === 'string' ? t.audioWavBase64 : null,
    };
  });
  const level = isObj(raw.level) ? raw.level : {};
  const profile = isObj(raw.profile) ? raw.profile : {};
  const settings = isObj(raw.settings) ? raw.settings : {};
  const device = isObj(raw.device) ? raw.device : {};
  const range = profile.range;
  return {
    app: 'pitch-lab',
    kind: 'coaching',
    version: COACHING_FILE_VERSION,
    exportedAt: typeof raw.exportedAt === 'string' ? raw.exportedAt : '',
    appVersion: typeof raw.appVersion === 'string' ? raw.appVersion : 'unknown',
    level: {
      id: typeof level.id === 'string' ? level.id : null,
      title: typeof level.title === 'string' ? level.title : exercise.title,
      worldId: typeof level.worldId === 'string' ? level.worldId : exercise.worldId,
    },
    exercise,
    profile: {
      name: typeof profile.name === 'string' ? profile.name : 'the singer',
      voiceType: typeof profile.voiceType === 'string' ? profile.voiceType : 'unknown',
      range: isObj(range) && isObj(range.comfortable) && isObj(range.extended) ? (range as unknown as VocalRange) : null,
    },
    settings: {
      vibratoStyle: settings.vibratoStyle === 'classical' ? 'classical' : 'pop',
      notation: settings.notation === 'flats' ? 'flats' : 'sharps',
      keepTakeAudio: settings.keepTakeAudio === true,
      ...(isDetector(settings.detector) ? { detector: settings.detector } : {}),
    },
    device: {
      route: typeof device.route === 'string' ? device.route : 'unknown',
      latencyMs: isNum(device.latencyMs) ? device.latencyMs : null,
      userAgent: typeof device.userAgent === 'string' ? device.userAgent : '',
    },
    takes,
  };
}

/** Checks a backup (storage/backup.ts): only the rows this tool can read are kept, and what was dropped is listed in `warnings`. */
export function parseBackupFile(raw: unknown, name = 'the backup'): ParsedBackup {
  const bad = (why: string): never => {
    throw new CoachInputError(`${name}: ${why}`);
  };
  if (!isObj(raw) || raw.format !== BACKUP_FORMAT) return bad('not a pitch-lab-backup file');
  const version = raw.version;
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) return bad(`unusable backup version ${String(version)}`);
  if (version > BACKUP_VERSION) return bad(`made by a newer app (backup version ${version}); this tool reads up to version ${BACKUP_VERSION}`);
  if (!Array.isArray(raw.profiles) || !Array.isArray(raw.attempts)) return bad('the backup is missing its profiles or attempts list');
  const warnings: string[] = [];

  const profiles: ProfileRecord[] = [];
  for (const p of raw.profiles) {
    if (!isObj(p) || typeof p.id !== 'string' || typeof p.name !== 'string') {
      warnings.push('skipped a profile row that is not readable');
      continue;
    }
    if (typeof p.deletedAt === 'string') continue;
    const range = p.range;
    profiles.push({
      id: p.id,
      profileId: p.id,
      createdAt: typeof p.createdAt === 'string' ? p.createdAt : '',
      updatedAt: typeof p.updatedAt === 'string' ? p.updatedAt : '',
      deletedAt: null,
      name: p.name,
      voiceType: p.voiceType === 'tenor' || p.voiceType === 'baritone' || p.voiceType === 'other' ? p.voiceType : 'unknown',
      range: isObj(range) && isObj(range.comfortable) && isObj(range.extended) ? (range as unknown as VocalRange) : null,
    });
  }

  const attempts: AttemptRecord[] = [];
  let dropped = 0;
  for (const a of raw.attempts) {
    const attempt = toAttempt(a);
    if (!attempt) {
      dropped++;
      continue;
    }
    if (attempt.deletedAt !== null) continue;
    attempts.push(attempt);
  }
  if (dropped > 0) warnings.push(`skipped ${dropped} attempt row${dropped === 1 ? '' : 's'} that could not be read`);
  attempts.sort(byAge);

  const settings: ParsedBackup['settings'] = {};
  const stored = isObj(raw.settings) && isObj(raw.settings.profiles) ? raw.settings.profiles : {};
  for (const [id, s] of Object.entries(stored)) {
    if (!isObj(s)) continue;
    settings[id] = {
      ...(s.vibratoStyle === 'pop' || s.vibratoStyle === 'classical' ? { vibratoStyle: s.vibratoStyle } : {}),
      ...(s.notation === 'sharps' || s.notation === 'flats' ? { notation: s.notation } : {}),
      ...(isDetector(s.detector) ? { detector: s.detector } : {}),
    };
  }
  return { exportedAt: typeof raw.exportedAt === 'string' ? raw.exportedAt : '', profiles, attempts, settings, warnings };
}

function asciiAt(bytes: Uint8Array, at: number, n: number): string {
  let s = '';
  for (let i = 0; i < n && at + i < bytes.length; i++) s += String.fromCharCode(bytes[at + i]);
  return s;
}

/** Recognises a WAV, a coaching file or a backup by its content (never its name); throws CoachInputError for anything else. */
export function readCoachInput(bytes: Uint8Array, name = 'the file'): CoachInput {
  if (bytes.length >= 12 && asciiAt(bytes, 0, 4) === 'RIFF' && asciiAt(bytes, 8, 4) === 'WAVE') {
    try {
      const parsed = parseWav(bytes);
      if (parsed.frames < 1) throw new Error('it holds no audio');
      return { kind: 'wav', name, wav: { samples: parsed.samples, sampleRate: parsed.sampleRate } };
    } catch (e) {
      throw new CoachInputError(`${name}: not a readable WAV file (${errMsg(e)})`);
    }
  }
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder('utf-8').decode(bytes).replace(/^\uFEFF/, ''));
  } catch {
    throw new CoachInputError(`${name}: not a Pitch Lab file (it is neither a WAV nor valid JSON)`);
  }
  if (isObj(raw) && raw.kind === 'coaching') return { kind: 'coaching', name, file: parseCoachingFile(raw, name) };
  if (isObj(raw) && raw.format === BACKUP_FORMAT) return { kind: 'backup', name, backup: parseBackupFile(raw, name) };
  throw new CoachInputError(`${name}: not a Pitch Lab coaching file or backup (no "kind": "coaching" and no "format": "${BACKUP_FORMAT}")`);
}

// ---------------------------------------------------------------- the exercise as it was sung

/**
 * The exercise laid out on `tonicMidi` at `bpm`, as realize() did for the take. realize() places the tonic inside a saved range,
 * so the range handed to it is exactly the material's own span: the only tonic that fits is the one asked for.
 */
export function realizeAtTonic(def: ExerciseDef, tonicMidi: number, bpm?: number): RealizedExercise {
  const { lo, hi } = materialSpan(def);
  const band = { low: tonicMidi + lo, high: tonicMidi + hi };
  return realize(def, { comfortable: { ...band }, extended: { ...band }, measuredAt: '' }, 'unknown', { bpm });
}

function sameNotes(a: readonly TargetNote[], b: readonly TargetNote[]): boolean {
  return (
    a.length === b.length &&
    a.every((n, i) => {
      const m = b[i];
      return Math.abs(n.midi - m.midi) < 1e-6 && Math.abs(n.start - m.start) < 1e-6 && Math.abs(n.end - m.end) < 1e-6 && Math.abs((n.toMidi ?? n.midi) - (m.toMidi ?? m.midi)) < 1e-6;
    })
  );
}

/**
 * The realization a take was sung against, rebuilt from what the file saved (tonic, tempo, and the targets when it has them).
 * When the saved targets differ in pitch from the exercise at that tonic, the app had folded the exercise into a narrow saved
 * range: the saved pitches are put back, so the take is analyzed (and refused) as the app did.
 */
export function rebuildRealized(
  def: ExerciseDef,
  saved: { tonicMidi: number; bpm: number; notes?: readonly TargetNote[] },
): { realized: RealizedExercise; note: string | null } {
  const base = realizeAtTonic(def, saved.tonicMidi, saved.bpm);
  const sung = saved.notes;
  if (!sung || sameNotes(base.notes, sung)) return { realized: base, note: null };
  if (base.notes.length === sung.length && base.notes.every((n, i) => Math.abs(n.start - sung[i].start) < 1e-3 && Math.abs(n.end - sung[i].end) < 1e-3)) {
    let k = 0;
    const steps = base.steps.map((s) => {
      if (s.role !== 'sing') return s;
      const n = sung[k++];
      const out = { ...s, midi: n.midi };
      if (n.toMidi !== undefined) out.toMidi = n.toMidi;
      else delete out.toMidi;
      return out;
    });
    return {
      realized: { ...base, steps, notes: sung.map((n) => ({ ...n })), fit: 'folded' },
      note: 'the targets in the file differ in pitch from the exercise at this tonic: the app folded it into a narrow saved range, so a take like this is never judged',
    };
  }
  return { realized: base, note: 'the targets in the file do not match the exercise definition in the file; the exercise as defined was used' };
}

/** The tonic that best explains a pitch line: the one whose targets the sung pitches sit nearest, or null when none is close. */
export function inferTonic(def: ExerciseDef, track: PitchTrack, bpm?: number): number | null {
  const clean = cleanOctaveSpikes(track).filter((f) => f.voiced && Number.isFinite(f.midi));
  if (clean.length < 20) return null;
  let best: { tonic: number; err: number } | null = null;
  for (let tonic = 36; tonic <= 84; tonic++) {
    const notes = realizeAtTonic(def, tonic, bpm).notes;
    const errs: number[] = [];
    let k = 0;
    for (const f of clean) {
      while (k < notes.length && notes[k].end <= f.t) k++;
      if (k >= notes.length) break;
      if (f.t < notes[k].start) continue;
      errs.push(Math.abs(f.midi - targetMidiAt(notes[k], f.t)));
    }
    if (errs.length < 10) continue;
    const err = median(errs);
    if (best === null || err < best.err) best = { tonic, err };
  }
  return best !== null && best.err <= 3 ? best.tonic : null;
}

/** The tempo (a Runs ladder rung) whose material length matches a WAV's length, else the exercise's own tempo. */
export function inferBpm(def: ExerciseDef, wavSec: number): number {
  let best = def.tempoBpm;
  let bestGap = Infinity;
  for (const bpm of ladderOf(def)) {
    const gap = Math.abs(realizeAtTonic(def, 60, bpm).totalSec + TAKE_TAIL_SEC - wavSec);
    if (gap < bestGap) {
      best = bpm;
      bestGap = gap;
    }
  }
  return best;
}

/** The runner records this long past the end of the material (runtime/runner.ts TAKE_TAIL_SEC), so a WAV is that much longer than it. */
const TAKE_TAIL_SEC = 0.4;
/** The worklet hands the framer one render quantum at a time. */
const BLOCK = 128;

// ---------------------------------------------------------------- audio to pitch line

/**
 * What the app's framer and detector make of take audio. A take's WAV starts at take time 0 (the compensated downbeat), so the
 * audio is given the same silent pre-roll the live take had (TAKE_PRE_ROLL_SEC) and frame times are shifted back by it: the
 * track is take-relative, like the one the app saves. A note sung before the downbeat is clipped in the WAV, and so is missing here.
 */
export function trackFromSamples(samples: Float32Array, sampleRate: number, opts: { preRollSec?: number; detector?: DetectorKind } = {}): PitchFrame[] {
  const preRoll = Math.max(0, opts.preRollSec ?? TAKE_PRE_ROLL_SEC);
  const padSamples = Math.round(preRoll * sampleRate);
  const audio = new Float32Array(padSamples + samples.length);
  audio.set(samples, padSamples);
  const { windowSize, minHz, maxHz, mpmK, yinThreshold, minConfidence, minRmsDb, rmsFloorDb } = CONFIG.audio;
  const detector = createDetector(opts.detector ?? CONFIG.audio.detector, { sampleRate, windowSize, minHz, maxHz, mpmK, yinThreshold });
  const framer = new Framer({ sampleRate, windowSize, hopSize: hopSizeFor(sampleRate), minHz, maxHz, minConfidence, minRmsDb, rmsFloorDb, detector });
  const frames: PitchFrame[] = [];
  for (let i = 0; i < audio.length; i += BLOCK) {
    framer.push(audio.subarray(i, Math.min(audio.length, i + BLOCK)), i, (f) => frames.push({ ...f, t: f.t - preRoll }));
  }
  return frames;
}

/** How a pitch line rebuilt from audio compares with the one the app saved for the same take (frames matched by nearest time). */
export interface TrackCheck {
  savedVoicedFrames: number;
  rebuiltVoicedFrames: number;
  /** Frames voiced in both. */
  bothVoiced: number;
  /** Median |pitch difference| over the frames voiced in both, cents. */
  medianAbsCents: number | null;
  /** Frames voiced in both whose pitches are an octave or more apart. */
  octaveDisagreements: number;
}

export function compareTracks(saved: PitchTrack, rebuilt: PitchTrack): TrackCheck {
  const sv = saved.filter((f) => f.voiced && Number.isFinite(f.midi));
  const rv = rebuilt.filter((f) => f.voiced && Number.isFinite(f.midi));
  const diffs: number[] = [];
  let octave = 0;
  let k = 0;
  for (const f of rv) {
    while (k + 1 < sv.length && Math.abs(sv[k + 1].t - f.t) <= Math.abs(sv[k].t - f.t)) k++;
    if (sv.length === 0 || Math.abs(sv[k].t - f.t) > 0.006) continue;
    const c = Math.abs(centsOff(f.midi, sv[k].midi));
    diffs.push(c);
    if (c >= 1100) octave++;
  }
  return {
    savedVoicedFrames: sv.length,
    rebuiltVoicedFrames: rv.length,
    bothVoiced: diffs.length,
    medianAbsCents: diffs.length > 0 ? median(diffs) : null,
    octaveDisagreements: octave,
  };
}

// ---------------------------------------------------------------- the ASCII pitch graph

export interface GraphInput {
  /** The targets (glides carry toMidi), take-relative seconds. */
  notes: readonly TargetNote[];
  /** The pitch line the analyzers saw. */
  track: PitchTrack;
  cracks: readonly CrackEvent[];
  totalSec: number;
}

export interface GraphOptions {
  /** Plot columns (default 96). */
  width?: number;
  notation?: Notation;
  /** Most rows before two or more half steps share a row (default 40). */
  maxRows?: number;
}

export interface PitchGraph {
  /** The rows, the time axis and the legend, ready to print. */
  lines: string[];
  startSec: number;
  endSec: number;
  /** Seconds per column. */
  binSec: number;
  cols: number;
  lowMidi: number;
  highMidi: number;
  /** Half steps per row (1 unless the span is very tall). */
  rowStep: number;
  /** Characters before the first plot column (the note label and the bar). */
  labelWidth: number;
  /** Where each crack was drawn (row null when no pitch was found near it). */
  marks: Array<{ t: number; col: number; row: number | null; midi: number | null }>;
  /** Voiced frames left off the graph because they sit outside its pitch range. */
  clipped: number;
}

const TICKS_SEC = [0.5, 1, 2, 5, 10, 15, 20, 30, 60];
/** A take that runs on past the material shows this much of it at most. */
const GRAPH_TAIL_MAX_SEC = 0.6;

/**
 * The take as a picture: time across, notes down, the targets as "=" bars, the sung line as "*", cracks as "x" (x beats *, and *
 * beats =, so a bar shows where the singer was not). One row is a half step, so a note sung 40 cents sharp still sits on its bar:
 * the figures list has the cents.
 */
export function renderPitchGraph(input: GraphInput, opts: GraphOptions = {}): PitchGraph {
  const cols = clampInt(opts.width ?? 96, 24, 240);
  const notation = opts.notation ?? 'sharps';
  const maxRows = clampInt(opts.maxRows ?? 40, 8, 200);
  const startSec = 0;
  const sungFrames = input.track.filter((f) => f.voiced && Number.isFinite(f.midi) && f.t >= startSec);

  let endSec = Math.max(input.totalSec, ...input.notes.map((n) => n.end), 0.5);
  const lastVoiced = sungFrames.length > 0 ? sungFrames[sungFrames.length - 1].t : 0;
  if (lastVoiced > endSec) endSec = Math.min(lastVoiced + 0.05, endSec + GRAPH_TAIL_MAX_SEC);
  const binSec = (endSec - startSec) / cols;
  const colOf = (t: number): number => Math.min(cols - 1, Math.max(0, Math.floor((t - startSec) / binSec + 1e-9)));

  // The pitch range: every target, widened to take in nearly all of what was sung (a stray frame never makes the picture tall).
  const targetMidis = input.notes.flatMap((n) => [n.midi, n.toMidi ?? n.midi]);
  const sungMidis = sungFrames.filter((f) => f.t < endSec).map((f) => f.midi);
  let lo = targetMidis.length > 0 ? Math.min(...targetMidis) : sungMidis.length > 0 ? Math.floor(percentile(sungMidis, 0.02)) : 59;
  let hi = targetMidis.length > 0 ? Math.max(...targetMidis) : sungMidis.length > 0 ? Math.ceil(percentile(sungMidis, 0.98)) : 61;
  if (sungMidis.length > 0) {
    lo = Math.min(lo, Math.floor(percentile(sungMidis, 0.02)));
    hi = Math.max(hi, Math.ceil(percentile(sungMidis, 0.98)));
  }
  lo = Math.round(lo) - 1;
  hi = Math.round(hi) + 1;
  const rowStep = Math.max(1, Math.ceil((hi - lo + 1) / maxRows));
  const rows = Math.ceil((hi - lo + 1) / rowStep);
  const rowOf = (m: number): number | null => {
    const k = Math.round(m);
    return k < lo || k > hi ? null : Math.floor((hi - k) / rowStep);
  };
  const grid: string[][] = Array.from({ length: rows }, () => new Array<string>(cols).fill(' '));
  const put = (r: number | null, c: number, ch: string): void => {
    if (r === null || r < 0 || r >= rows) return;
    const cur = grid[r][c];
    if (ch === 'x' || cur === ' ' || (ch === '*' && cur === '=')) grid[r][c] = ch;
  };

  // Targets: every column a note touches, and every row it passes through in that column (a glide is a slope, not dots).
  for (const n of input.notes) {
    const b0 = colOf(n.start);
    const b1 = Math.max(b0, Math.min(cols - 1, Math.ceil((n.end - startSec) / binSec - 1e-9) - 1));
    for (let b = b0; b <= b1; b++) {
      const t0 = Math.max(n.start, startSec + b * binSec);
      const t1 = Math.max(t0, Math.min(n.end, startSec + (b + 1) * binSec));
      const ra = rowOf(targetMidiAt(n, t0));
      const rb = rowOf(targetMidiAt(n, t1));
      if (ra === null || rb === null) continue;
      for (let r = Math.min(ra, rb); r <= Math.max(ra, rb); r++) put(r, b, '=');
    }
  }

  // The sung line: every voiced frame.
  let clipped = 0;
  for (const f of sungFrames) {
    if (f.t >= endSec) continue;
    const r = rowOf(f.midi);
    if (r === null) clipped++;
    else put(r, colOf(f.t), '*');
  }

  // Cracks, at the pitch the voice was on when it broke (the last voiced frame before it; else the next; else the target).
  const marks: PitchGraph['marks'] = [];
  for (const c of input.cracks) {
    let midi: number | null = null;
    for (let i = sungFrames.length - 1; i >= 0; i--) {
      if (sungFrames[i].t <= c.t + 1e-6) {
        if (c.t - sungFrames[i].t <= 0.25) midi = sungFrames[i].midi;
        break;
      }
    }
    if (midi === null) {
      const next = sungFrames.find((f) => f.t > c.t);
      if (next && next.t - c.t <= 0.25) midi = next.midi;
    }
    if (midi === null) {
      const note = input.notes.find((n) => c.t >= n.start && c.t < n.end);
      if (note) midi = targetMidiAt(note, c.t);
    }
    const col = colOf(c.t);
    const row = midi === null ? null : rowOf(midi);
    marks.push({ t: c.t, col, row, midi });
    put(row, col, 'x');
  }

  // Each row: the note label (four characters), a space and the bar, then the plot.
  const labelWidth = 6;
  const lines: string[] = [];
  for (let r = 0; r < rows; r++) {
    const top = hi - r * rowStep;
    lines.push(`${lpad(noteLabel(top, notation), labelWidth - 2)} |${grid[r].join('').replace(/\s+$/, '')}`);
  }

  // The time axis: a tick every few seconds, labelled.
  const tickSec = TICKS_SEC.find((t) => t >= binSec * 7) ?? 60;
  const axis = new Array<string>(cols).fill('-');
  const labels = new Array<string>(cols + 8).fill(' ');
  for (let t = 0; t <= endSec + 1e-9; t += tickSec) {
    const c = Math.min(cols - 1, Math.round((t - startSec) / binSec));
    if (c > 0) axis[c] = '+'; // the corner of the axes stands for time 0
    const text = `${Number.isInteger(t) ? String(t) : t.toFixed(1)}s`;
    if (labels.slice(c, c + text.length + 1).every((ch) => ch === ' ')) for (let i = 0; i < text.length; i++) labels[c + i] = text[i];
  }
  const gutter = ' '.repeat(labelWidth);
  lines.push(`${gutter.slice(1)}+${axis.join('')}`);
  lines.push(`${gutter}${labels.join('').replace(/\s+$/, '')}`);
  const scale = `1 column = ${fmtNum(binSec)} s, 1 row = ${rowStep === 1 ? 'a half step' : `${rowStep} half steps`}`;
  lines.push(`${gutter}= target   * sung   x crack      (${scale})`);
  if (marks.length > 0) lines.push(`${gutter}cracks at ${marks.map((m) => `${clock(m.t)}${m.midi === null ? '' : ` (${noteLabel(m.midi, notation)})`}`).join(', ')}`);
  if (clipped > 0) lines.push(`${gutter}${clipped} voiced frame${clipped === 1 ? ' sits' : 's sit'} outside the pitch range shown`);
  return { lines, startSec, endSec, binSec, cols, lowMidi: lo, highMidi: hi, rowStep, labelWidth, marks, clipped };
}

// ---------------------------------------------------------------- the diagnosis of one take

/** One line of "Score and gates": the overall score against the pass mark, or a gated metric against its target. */
export interface GateLine {
  /** Null for the overall score. */
  metric: MetricKey | null;
  label: string;
  value: number | null;
  op: '>=' | '<=';
  target: number;
  /** Null when the take could not measure it (a gate on an unmeasured metric fails). */
  met: boolean | null;
  shown: string;
  targetShown: string;
  /** How far short, in the metric's units ("7 pts", "12 cents"); null when met or unmeasured. */
  missBy: string | null;
  /** Missed by no more than a tenth of the metric's score band (or of the target): the threshold may be to blame as much as the singing. */
  nearMiss: boolean;
}

/** One scoring term: the metric, its share of the score, and how many points of the score it cost. */
export interface TermLine {
  metric: MetricKey;
  label: string;
  /** Share of the total weight, 0..1. */
  weightShare: number;
  value: number | null;
  shown: string;
  /** 0..1 for this term alone. */
  termScore: number;
  /** Points of the final score (0..1) this term cost. */
  lost: number;
  band: string;
}

export type FigureKind = 'reach' | 'accuracy' | 'onset' | 'glide' | 'crack' | 'transition' | 'inflection' | 'run' | 'vibrato' | 'switch' | 'pulse' | 'dynamics' | 'range';

/** One thing an analyzer found in the take, in one line, and whether it counts against the take. */
export interface Figure {
  kind: FigureKind;
  label: string;
  t: number | null;
  end: number | null;
  midi: number | null;
  bad: boolean;
  text: string;
  /** What repeats across takes: the figure kind and the note it sits on ("accuracy:G3"); null for one-off figures. */
  key: string | null;
}

export interface Verdict {
  /** This analysis: the evaluation, and the level's own rules on top (a lower tempo rung, a folded take). */
  passed: boolean;
  score: number;
  passMark: number;
  mastery: number;
  notJudged: 'folded' | 'stopped' | null;
  /** Set when too few notes were sung to pass. */
  unsung: { reached: number; total: number } | null;
  /** Sung below the level's pass tempo (a Runs ladder rung): such a take is practice, never a pass. */
  belowPassTempo: boolean;
  failedGates: number[];
  /** What the app wrote in the log at the time; null for a bare WAV. */
  app: { passed: boolean; score: number } | null;
  /** Null without an app verdict to compare with. */
  agrees: boolean | null;
  /** The reading, one sentence each. */
  why: string[];
}

export interface EngineOutput {
  problem: TakeProblem | null;
  coaching: Coaching | null;
  /** Why the engine could not answer ("not built yet", or its error). */
  problemError: string | null;
  coachingError: string | null;
  notBuilt: boolean;
}

export interface TakeDiagnosis {
  /** 1 = newest. */
  index: number;
  attemptId: string | null;
  at: string | null;
  /** 'track' = the pitch line the app saved; 'audio' = rebuilt from WAV samples; 'metrics' = only the numbers the app saved. */
  source: 'track' | 'audio' | 'metrics';
  tonicMidi: number | null;
  bpm: number | null;
  totalSec: number | null;
  voicedSec: number | null;
  verdict: Verdict;
  gates: GateLine[];
  /** Costliest first. */
  terms: TermLine[];
  metrics: Metrics;
  /** The one tip the app's rule table picks for the numbers. */
  tip: { id: string; text: string } | null;
  engine: EngineOutput;
  /** The ladder text for the tip (what the singer reads at each depth), when the engine's own card is not available. */
  ladder: { depth: CoachDepth; tip: string; why: string | null; steps: readonly string[]; easier: string | null } | null;
  figures: Figure[];
  /** What the analysis noticed across the figures ("sharp on 5 of 7 notes"). */
  insights: string[];
  /** Cracks as the analyzer found them, with the note they sit on. */
  cracks: Array<{ t: number; kind: CrackEvent['kind']; cents: number | null; durationMs: number; nearMidi: number | null; near: string | null }>;
  graph: PitchGraph | null;
  /** Consistency checks (the app's saved numbers against this analysis; a rebuilt pitch line against the saved one). */
  checks: string[];
  /** Caveats about how this take was read. */
  notes: string[];
  /** Cross-check of a pitch line rebuilt from audio against the saved one, when both exist. */
  trackCheck: TrackCheck | null;
}

const termOf = (def: ExerciseDef, metric: MetricKey) => def.scoring.find((t) => t.metric === metric);

/** The overall score and every gate against their targets. */
export function gateLines(def: ExerciseDef, metrics: Metrics, score: number): GateLine[] {
  const lines: GateLine[] = [];
  const mark = def.pass.score;
  const scoreMet = score >= mark - 1e-9;
  lines.push({
    metric: null,
    label: 'Overall score',
    value: score,
    op: '>=',
    target: mark,
    met: scoreMet,
    shown: `${fmtNum(score * 100)}%`,
    targetShown: `${fmtNum(mark * 100)}%`,
    missBy: scoreMet ? null : `${fmtNum((mark - score) * 100)} pts`,
    nearMiss: !scoreMet && mark - score <= 0.05,
  });
  for (const g of def.pass.gates ?? []) {
    const raw = metrics[g.metric];
    const value = isNum(raw) ? raw : null;
    const met = value === null ? null : g.op === '>=' ? value >= g.value : value <= g.value;
    const miss = value === null ? null : g.op === '>=' ? g.value - value : value - g.value;
    const term = termOf(def, g.metric);
    const scale = term ? Math.abs(term.best - term.worst) : Math.abs(g.value);
    lines.push({
      metric: g.metric,
      label: METRIC_INFO[g.metric].label,
      value,
      op: g.op,
      target: g.value,
      met,
      shown: value === null ? 'not measured' : fmtMetric(g.metric, value),
      targetShown: fmtMetric(g.metric, g.value),
      missBy: met === false && miss !== null ? fmtDelta(g.metric, miss) : null,
      nearMiss: met === false && miss !== null && scale > 0 && miss <= 0.1 * scale,
    });
  }
  return lines;
}

/** Every scoring term with the points it cost, costliest first (the sum of `lost` is 1 minus the score). */
export function termLines(def: ExerciseDef, metrics: Metrics): TermLine[] {
  const total = def.scoring.reduce((a, t) => a + t.weight, 0) || 1;
  return def.scoring
    .map((t): TermLine => {
      const raw = metrics[t.metric];
      const value = isNum(raw) ? raw : null;
      const s = value === null ? 0 : valueScore(value, t.best, t.worst);
      return {
        metric: t.metric,
        label: METRIC_INFO[t.metric].label,
        weightShare: t.weight / total,
        value,
        shown: value === null ? 'not measured' : fmtMetric(t.metric, value),
        termScore: s,
        lost: ((1 - s) * t.weight) / total,
        band: `${fmtMetric(t.metric, t.best)} (full marks) to ${fmtMetric(t.metric, t.worst)} (none)`,
      };
    })
    .sort((a, b) => b.lost - a.lost);
}

const tolOf = (def: ExerciseDef): number => CONFIG.tolerance[def.tolerance] ?? CONFIG.tolerance.default;

/** The pitch the voice was on at `t`: the last voiced frame at or before it (within 0.25 s), else the next. */
function pitchNear(track: PitchTrack, t: number): number | null {
  let before: PitchFrame | null = null;
  let after: PitchFrame | null = null;
  for (const f of track) {
    if (!f.voiced || !Number.isFinite(f.midi)) continue;
    if (f.t <= t + 1e-6) before = f;
    else {
      after = f;
      break;
    }
  }
  if (before && t - before.t <= 0.25) return before.midi;
  if (after && after.t - t <= 0.25) return after.midi;
  return before?.midi ?? after?.midi ?? null;
}

/** Seconds after a note started that the first voiced frame of it came (0 when it was sung from the start); null when never voiced. */
function lateStart(track: PitchTrack, note: TargetNote): number | null {
  const first = framesInWindow(track, note.start, note.end).find((f) => f.voiced);
  return first ? Math.max(0, first.t - note.start) : null;
}

/** A number with its unit, or "-" when the analyzer could not measure it. */
const num = (x: number | null | undefined, unit = ''): string => (x === null || x === undefined ? '-' : `${fmtNum(x)}${unit}`);
/** The same with its sign ("+12 cents"). */
const sgn = (x: number | null | undefined, unit = ''): string => (x === null || x === undefined ? '-' : `${signed(x)}${unit}`);

/** Every item the analyzers found in the take, in take order within each kind. */
export function figuresOf(def: ExerciseDef, analysis: TakeAnalysis, clean: PitchTrack, notation: Notation): Figure[] {
  const out: Figure[] = [];
  const d = analysis.details;
  const tol = tolOf(def);
  const judgesInTune = def.scoring.some((t) => t.metric === 'accuracy.inTolerancePct') || (def.pass.gates ?? []).some((g) => g.metric === 'accuracy.inTolerancePct');
  const nm = (m: number): string => noteLabel(m, notation);
  const span = (n: { start: number; end: number }): string => `${clock(n.start)}-${clock(n.end)}`;
  const push = (f: Omit<Figure, 'key'> & { key?: string | null }): void => void out.push({ ...f, key: f.key ?? null });
  /** The "key" of a figure that counts against the take: what repeats across takes (kind and note). */
  const keyIf = (bad: boolean, kind: string, what: string | null): string | null => (bad && what !== null ? `${kind}:${what}` : null);

  const r = analysis.reach;
  if (r.total > 0 && r.reached < r.total) {
    push({
      kind: 'reach', label: 'Notes sung', t: r.lastReachedEnd ?? null, end: null, midi: null, bad: true,
      text: `sang ${r.reached} of ${r.total} target notes${r.lastReachedEnd ? `; the last note sung ends at ${clock(r.lastReachedEnd)}` : ''}`,
    });
  }

  d.accuracy.forEach(({ note, result: a }, i) => {
    const label = `Note ${i + 1} ${nm(note.midi)}`;
    const at = { t: note.start, end: note.end, midi: note.midi };
    if (!(a.voicedSec > 0) || !Number.isFinite(a.biasCents)) {
      push({ kind: 'accuracy', label, ...at, bad: true, text: `${span(note)} never sung (no voiced audio inside it)`, key: `accuracy:${nm(note.midi)}` });
      return;
    }
    const late = lateStart(clean, note);
    const bits = [`bias ${sgn(a.biasCents, ' cents')}`, `in tune ${num(a.inTolerancePct, '%')}`, `spread ${num(a.sdCents, ' cents')}`];
    if (a.driftCentsPerSec !== null) bits.push(`drift ${sgn(a.driftCentsPerSec, ' cents/s')}`);
    bits.push(`covered ${pct(a.coverage)}`);
    if (late !== null && late > 0.25) bits.push(`came in ${fmtNum(late)} s late`);
    // Coverage and time in tune only count against a note on an exercise that judges time in tune (a staccato note is short on purpose).
    const bad = Math.abs(a.biasCents) > tol || (judgesInTune && (a.coverage < 0.65 || a.inTolerancePct < 50));
    push({ kind: 'accuracy', label, ...at, bad, text: `${span(note)} ${bits.join(', ')}`, key: keyIf(bad, 'accuracy', nm(note.midi)) });
  });

  d.onset.forEach(({ note, result: o }, i) => {
    const bits = [
      o.onsetT === null ? 'voice never came in' : `voice in at ${clock(o.onsetT)} (${sgn(o.onsetT - note.start)} s from the note's start)`,
      o.settleMs === null ? 'never settled in the band' : `settled in ${num(o.settleMs, ' ms')}`,
      `scoop ${num(o.scoopCents, ' cents')}`,
      `overshoot ${num(o.overshootCents, ' cents')}`,
      `onset ${o.onsetType}${o.riseMs !== null ? ` (rise ${num(o.riseMs, ' ms')})` : ''}`,
      o.crisp ? 'crisp' : 'NOT crisp',
    ];
    push({
      kind: 'onset', label: `Attack ${i + 1} ${nm(note.midi)}`, t: note.start, end: note.end, midi: note.midi, bad: !o.crisp,
      text: bits.join(', '), key: keyIf(!o.crisp, 'onset', nm(note.midi)),
    });
  });

  d.glides.forEach(({ note, result: g }, i) => {
    const to = note.toMidi ?? note.midi;
    const bits = [
      `smooth ${pct(g.smoothness)}`,
      `stair steps ${g.stairSteps}`,
      g.durationMs === null ? 'no glide found' : `took ${fmtNum(g.durationMs / 1000)} s`,
      `start error ${sgn(g.startErrorCents, ' cents')}`,
      `end error ${sgn(g.endErrorCents, ' cents')}`,
      `cracks ${g.cracks.length}`,
    ];
    if (!g.monotonic) bits.push('went backwards at times');
    const bad = g.cracks.length > 0 || g.smoothness < 0.4 || g.stairSteps > 0 || g.durationMs === null || (g.endErrorCents !== null && Math.abs(g.endErrorCents) > tol);
    push({
      kind: 'glide', label: `Glide ${i + 1} ${nm(note.midi)} to ${nm(to)}`, t: note.start, end: note.end, midi: note.midi, bad,
      text: `${span(note)} ${bits.join(', ')}`, key: keyIf(bad, 'glide', `${nm(note.midi)}>${nm(to)}`),
    });
  });

  d.cracks.forEach((c, i) => {
    const near = pitchNear(clean, c.t);
    const what =
      c.kind === 'jump'
        ? `a jump of ${num(c.cents ?? 0, ' cents')} within ${num(c.durationMs, ' ms')}`
        : `the voice dropped out for ${num(c.durationMs, ' ms')}${c.cents !== undefined ? ` and came back ${num(c.cents, ' cents')} away` : ''}`;
    push({
      kind: 'crack', label: `Crack ${i + 1}`, t: c.t, end: null, midi: near, bad: true,
      text: `at ${clock(c.t)}${near === null ? '' : ` near ${nm(near)}`}: ${what}`, key: keyIf(true, 'crack', near === null ? null : nm(near)),
    });
  });

  d.transitions.forEach(({ notes, result }) => {
    for (const tr of result.transitions) {
      const a = notes[tr.fromIndex];
      const b = notes[tr.toIndex];
      if (!a || !b) continue;
      const leap = Math.round(b.midi - a.midi);
      const bits = [
        `${Math.abs(leap)} half steps ${leap >= 0 ? 'up' : 'down'}`,
        tr.durationMs === null ? 'never settled' : `settled in ${num(tr.durationMs, ' ms')}`,
        `overshoot ${num(tr.overshootCents, ' cents')}`,
        tr.clean ? 'clean' : 'NOT clean',
      ];
      push({
        kind: 'transition', label: `Change ${nm(a.midi)} to ${nm(b.midi)}`, t: b.start, end: b.end, midi: b.midi, bad: !tr.clean,
        text: `at ${clock(b.start)} (${bits.join(', ')})`, key: keyIf(!tr.clean, 'transition', `${nm(a.midi)}>${nm(b.midi)}`),
      });
    }
  });

  d.inflections.forEach(({ kind, targets, result: x }) => {
    const bits = [x.detected ? 'detected' : 'NOT detected'];
    if (x.sizeCents !== null) bits.push(`size ${num(x.sizeCents, ' cents')}`);
    if (x.timeMs !== null) bits.push(`time ${num(x.timeMs, ' ms')}`);
    if (x.landingAbsCents !== null) bits.push(`landing ${num(x.landingAbsCents, ' cents')} off`);
    bits.push(`shape score ${pct(x.score)}`);
    const mid = targets[targets.length - 1]?.midi ?? null;
    push({
      kind: 'inflection', label: `${kind[0].toUpperCase()}${kind.slice(1)}`, t: targets[0]?.start ?? null, end: null, midi: mid, bad: x.score < 0.7,
      text: `at ${clock(targets[0]?.start ?? 0)}: ${bits.join(', ')}${x.notes.length > 0 ? ` (${x.notes.join('; ')})` : ''}`,
      key: keyIf(x.score < 0.7, 'inflection', mid === null ? null : `${kind}:${nm(mid)}`),
    });
  });

  d.runs.forEach(({ result }, ri) => {
    for (const n of result.notes) {
      const bad = n.verdict !== 'defined';
      push({
        kind: 'run', label: `Run ${ri + 1} note ${n.index + 1} ${nm(n.targetMidi)}`, t: null, end: null, midi: n.targetMidi, bad,
        text: `${n.verdict}: reached ${num(n.reachedMs, ' ms')}, error ${sgn(n.medianErrorCents, ' cents')}, definition ${pct(n.definition)}, timing ${sgn(n.timingErrorMs, ' ms')}`,
        key: keyIf(bad, 'run', nm(n.targetMidi)),
      });
    }
  });

  d.vibrato.forEach(({ note, result: v }, i) => {
    const bad = !v.present || !v.inZone;
    const text = v.present
      ? [
          `${span(note)} rate ${num(v.rateHz, ' Hz')}`,
          `extent +/-${num(v.extentCents, ' cents')}`,
          `regularity ${pct(v.regularity)}`,
          `centre ${sgn(v.centeringCents, ' cents')}`,
          `${v.inZone ? 'in' : 'OUT of'} the zone${v.flags.length > 0 ? ` [${v.flags.join(', ')}]` : ''}`,
        ].join(', ')
      : `${span(note)} no vibrato found${v.extentCents !== null ? ` (the tone wobbled +/-${num(v.extentCents, ' cents')})` : ''}`;
    push({ kind: 'vibrato', label: `Vibrato ${i + 1} ${nm(note.midi)}`, t: note.start, end: note.end, midi: note.midi, bad, text, key: keyIf(bad, 'vibrato', nm(note.midi)) });
  });

  if (d.switch) {
    for (const b of d.switch.boundaries) {
      const bits = [b.latencyMs === null ? 'the voice never switched' : `switched ${sgn(b.latencyMs, ' ms')} from the cue`];
      if (b.reattacked) bits.push('the note was re-attacked');
      bits.push(b.clean ? 'clean' : 'NOT clean');
      push({
        kind: 'switch', label: `Switch to ${b.toVibrato ? 'vibrato' : 'straight'}`, t: b.t, end: null, midi: null, bad: !b.clean,
        text: `cue at ${clock(b.t)}: ${bits.join(', ')}`, key: keyIf(!b.clean, 'switch', b.toVibrato ? 'vibrato' : 'straight'),
      });
    }
  }

  d.pulses.forEach(({ notes, rateHz, result: p }, i) => {
    const bad = p.measuredRateHz === null || (p.rateErrorHz !== null && Math.abs(p.rateErrorHz) > 0.4) || (p.regularity !== null && p.regularity < 0.6);
    const bits = [
      `target ${num(rateHz, '/s')}`,
      `measured ${p.measuredRateHz === null ? 'none found' : num(p.measuredRateHz, '/s')} (error ${sgn(p.rateErrorHz, ' Hz')})`,
      `regularity ${pct(p.regularity)}`,
      `${p.pulseCount} pulses`,
      `swing ${num(p.swingCents, ' cents')}`,
    ];
    push({
      kind: 'pulse', label: `Pulses ${i + 1}`, t: notes[0]?.start ?? null, end: null, midi: notes[0]?.midi ?? null, bad,
      text: bits.join(', '), key: keyIf(bad, 'pulse', notes[0] ? nm(notes[0].midi) : null),
    });
  });

  d.dynamics.forEach(({ note, shape, shapeScore, result: x }, i) => {
    const against = shapeScore !== null && shapeScore < FOLLOWS_CUE_SCORE;
    const bad = x.verdict !== 'steady' || x.rangeDb < CONFIG.dynamics.minRangeDb || against;
    const bits = [`asked ${shape ?? 'steps or none'}`, `range ${num(x.rangeDb, ' dB')}`, `pitch slope ${sgn(x.slopeCentsPerDb, ' cents/dB')}`, `verdict ${x.verdict}`];
    if (x.symmetry !== null) bits.push(`symmetry ${pct(x.symmetry)}`);
    if (shapeScore !== null) bits.push(`followed the cue ${pct(shapeScore)}`);
    push({
      kind: 'dynamics', label: `Hold ${i + 1} ${nm(note.midi)}`, t: note.start, end: note.end, midi: note.midi, bad,
      text: `${span(note)} ${bits.join(', ')}`, key: keyIf(bad, 'dynamics', nm(note.midi)),
    });
  });

  if (d.range) {
    const { lowestMidi: low, highestMidi: high } = d.range;
    const text =
      low === null || high === null
        ? 'no note was held long enough to measure'
        : `lowest ${nm(low)}, highest ${nm(high)}: ${high - low} half steps across ${d.range.heldNotes.length} held notes`;
    push({ kind: 'range', label: 'Range held', t: null, end: null, midi: null, bad: false, text });
  }
  return out;
}

/** What the figures add up to, as sentences. */
function insightsOf(analysis: TakeAnalysis, clean: PitchTrack, expectedSungSec: number, notation: Notation): string[] {
  const out: string[] = [];
  const d = analysis.details;
  const acc = d.accuracy.filter((a) => a.result.voicedSec > 0 && Number.isFinite(a.result.biasCents));
  if (acc.length >= 3) {
    const sharp = acc.filter((a) => a.result.biasCents > 10).length;
    const flat = acc.filter((a) => a.result.biasCents < -10).length;
    const med = median(acc.map((a) => a.result.biasCents));
    if (sharp >= 0.7 * acc.length) out.push(`Sharp on ${sharp} of ${acc.length} held notes (median ${signed(med)} cents): a steady lean, not scatter.`);
    else if (flat >= 0.7 * acc.length) out.push(`Flat on ${flat} of ${acc.length} held notes (median ${signed(med)} cents): a steady lean, not scatter.`);
    const mids = new Set(acc.map((a) => a.note.midi));
    if (acc.length >= 5 && mids.size >= 3) {
      const xs = acc.map((a) => a.note.midi);
      const ys = acc.map((a) => a.result.biasCents);
      const mx = xs.reduce((s, v) => s + v, 0) / xs.length;
      const my = ys.reduce((s, v) => s + v, 0) / ys.length;
      let sxy = 0;
      let sxx = 0;
      let syy = 0;
      for (let i = 0; i < xs.length; i++) {
        sxy += (xs[i] - mx) * (ys[i] - my);
        sxx += (xs[i] - mx) ** 2;
        syy += (ys[i] - my) ** 2;
      }
      const slope = sxx > 0 ? sxy / sxx : 0;
      const r2 = sxx > 0 && syy > 0 ? (sxy * sxy) / (sxx * syy) : 0;
      if (Math.abs(slope) >= 4 && r2 >= 0.4) {
        out.push(`The error follows the pitch: about ${fmtNum(Math.abs(slope))} cents more ${slope < 0 ? 'flat' : 'sharp'} for every half step higher (r2 ${fmtNum(r2)}).`);
      }
    }
  }
  const drifts = acc.filter((a) => a.result.driftCentsPerSec !== null).map((a) => a.result.driftCentsPerSec as number);
  if (drifts.length >= 2) {
    const sag = drifts.filter((x) => x < -2).length;
    const creep = drifts.filter((x) => x > 2).length;
    if (sag >= 0.7 * drifts.length) out.push(`Sagged flat during ${sag} of ${drifts.length} long holds (median ${signed(median(drifts))} cents/s): the usual cause is the breath running low, which the app cannot see.`);
    else if (creep >= 0.7 * drifts.length) out.push(`Crept sharp during ${creep} of ${drifts.length} long holds (median ${signed(median(drifts))} cents/s).`);
  }
  const lates = d.accuracy.map((a) => lateStart(clean, a.note)).filter((x): x is number => x !== null);
  const late = lates.filter((x) => x > 0.3);
  if (lates.length >= 3 && late.length >= 0.4 * lates.length) {
    out.push(`Came in late on ${late.length} of ${lates.length} notes (median ${fmtNum(median(late))} s after the note started); the app forgives up to ${CONFIG.accuracy.lateStartAllowanceSec} s.`);
  }
  const scoops = d.onset.filter((o) => o.result.onsetT !== null && o.result.scoopCents >= CONFIG.onset.crispMaxScoopCents);
  if (d.onset.length >= 2 && scoops.length >= 0.5 * d.onset.length) {
    out.push(`Scooped into ${scoops.length} of ${d.onset.length} attacks (median ${fmtNum(median(scoops.map((o) => o.result.scoopCents)))} cents below the note at the start).`);
  }
  if (d.cracks.length > 0) {
    const byNote = new Map<string, number>();
    for (const c of d.cracks) {
      const near = pitchNear(clean, c.t);
      const key = near === null ? 'an unknown note' : noteLabel(near, notation);
      byNote.set(key, (byNote.get(key) ?? 0) + 1);
    }
    out.push(`${d.cracks.length} break${d.cracks.length === 1 ? '' : 's'}: ${[...byNote].map(([k, n]) => `${k}${n > 1 ? ` x${n}` : ''}`).join(', ')}.`);
  }
  const stair = d.glides.filter((g) => g.result.stairSteps > 0);
  if (stair.length > 0) out.push(`Stair steps on ${stair.length} of ${d.glides.length} glides (${stair.reduce((s, g) => s + g.result.stairSteps, 0)} plateaus of at least ${CONFIG.transitions.stairPlateauMs} ms): the slide moved in steps.`);
  const r = analysis.reach;
  if (r.total > 0 && r.reached < r.total) out.push(`Only ${r.reached} of ${r.total} notes were sung${r.lastReachedEnd ? `: the singing stopped around ${clock(r.lastReachedEnd)}` : ''}.`);
  if (expectedSungSec > 2 && analysis.voicedSec < 0.5 * expectedSungSec) {
    out.push(`Voiced audio is ${fmtNum(analysis.voicedSec)} s of about ${fmtNum(expectedSungSec)} s of singing asked: very quiet singing, a low mic level or the voicing gate (checklist P1) can cause that.`);
  }
  return out;
}

// ---------------------------------------------------------------- the engine (coaching/coach.ts)

/**
 * coach.ts's coachFrom, which coaches a take from its saved numbers alone (a backup's attempts have no pitch line): not a
 * contract signature, so it is looked up at run time and a take without a pitch line falls back to the content ladder.
 */
export type CoachFromFn = (
  src: {
    def: ExerciseDef;
    attempt: AttemptRecord;
    tip: PickedTip;
    passed: boolean;
    metrics: Metrics;
    analysis: null;
    realized: Pick<RealizedExercise, 'notes' | 'totalSec' | 'tonicMidi'>;
    track?: null;
  },
  log: readonly AttemptRecord[],
  ctx: { notation?: Notation; vibratoStyle?: VibratoStyle; isLevelPassed: (levelId: string) => boolean; now?: number },
) => Coaching;

/** The engine calls the diagnosis uses; a test hands in fakes. */
export interface CoachEngine {
  locateProblem: typeof locateProblem;
  coachTake: typeof coachTake;
  missesInARow: typeof missesInARow;
  coachFrom?: CoachFromFn;
}

export const REAL_ENGINE: CoachEngine = {
  locateProblem,
  coachTake,
  missesInARow,
  coachFrom: (coachModule as unknown as { coachFrom?: CoachFromFn }).coachFrom,
};

type Tried<T> = { ok: true; value: T } | { ok: false; error: string; notBuilt: boolean };

function attemptCall<T>(fn: () => T): Tried<T> {
  try {
    return { ok: true, value: fn() };
  } catch (e) {
    const error = errMsg(e);
    return { ok: false, error, notBuilt: /not built yet/i.test(error) };
  }
}

function emptySnapshot(profileId: string, at: string): ProgressSnapshot {
  return { profileId, computedAt: at, levels: {}, worldsUnlocked: ['foundations'], features: [], momentum: 0, lastPracticeDay: null, records: {} };
}

function snapshotOf(profileId: string, log: readonly AttemptRecord[], at: string): ProgressSnapshot {
  const r = attemptCall(() => computeSnapshot(profileId, WORLDS, log, at, { getExercise: lookupExercise }));
  return r.ok ? r.value : emptySnapshot(profileId, at);
}

function targetOf(attempt: AttemptRecord, def: ExerciseDef): RunTarget {
  if (attempt.kind === 'audition') return { kind: 'audition', worldId: def.worldId };
  if (attempt.kind === 'workout' && attempt.levelId === null) return { kind: 'workout', itemIndex: 0 };
  if (attempt.kind === 'record' && attempt.levelId !== null) return { kind: 'record', levelId: attempt.levelId };
  return { kind: 'level', levelId: attempt.levelId ?? '' };
}

// ---------------------------------------------------------------- one take

interface TakeCtx {
  def: ExerciseDef;
  level: LevelDef | null;
  notation: Notation;
  vibratoStyle: VibratoStyle;
  /** The detector the takes were sung with, when the file or backup says (audio is rebuilt with it); null: unknown. */
  detector: DetectorKind | null;
  engine: CoachEngine;
  width: number;
  profile: { id: string; name: string; voiceType: string; range: VocalRange | null };
  now: Date;
}

interface TakeSource {
  index: number;
  attempt: AttemptRecord | null;
  saved: { tonicMidi: number; bpm: number; notes?: readonly TargetNote[] } | null;
  track: PitchFrame[] | null;
  audio: WavSamples | null;
  /** The profile's attempts up to and including this take, oldest first. */
  log: readonly AttemptRecord[];
  latencyMs: number | null;
}

const NO_ENGINE: EngineOutput = { problem: null, coaching: null, problemError: null, coachingError: null, notBuilt: false };

/** Which detector rebuilt a take's audio, for the analyst: the take's own when the file or backup names it. */
function detectorWords(ctx: Pick<TakeCtx, 'detector'>): string {
  return ctx.detector
    ? `with ${ctx.detector.toUpperCase()}, the detector the take was sung with`
    : `with ${CONFIG.audio.detector.toUpperCase()}; the file does not say which detector the take was sung with`;
}

/** Misses in a row, counting back from the newest of `attempts` (newest first) to the first pass. */
function countMisses(newestFirst: ReadonlyArray<{ passed: boolean }>): number {
  let n = 0;
  for (const a of newestFirst) {
    if (a.passed) break;
    n++;
  }
  return n;
}

/** Misses in a row on one exercise in a log (oldest first, exercises mixed): this tool's own count, for when the engine's is not to hand. */
function missesOn(exerciseId: string, log: readonly AttemptRecord[]): number {
  return countMisses([...log].reverse().filter((a) => a.exerciseId === exerciseId));
}

function ladderCard(tipId: string, depth: CoachDepth): TakeDiagnosis['ladder'] {
  const l = ladderFor(tipId);
  if (!l) return null;
  return { depth, tip: l.tip, why: depth >= 2 ? l.why : null, steps: depth >= 3 ? l.steps : [], easier: depth >= 4 ? l.easier : null };
}

const METRIC_DIFF_REL = 0.02;
const METRIC_DIFF_ABS = 0.02;
/** The app's score and this analysis agree when the verdict is the same and the scores are within this (3 points). */
const AGREE_SCORE_GAP = 0.03;

/** The metrics that differ between what the app saved and what this analysis measured (beyond float rounding). */
function metricDiffs(saved: Metrics, now: Metrics): string[] {
  const out: string[] = [];
  for (const key of Object.keys(METRIC_INFO) as MetricKey[]) {
    const a = saved[key];
    const b = now[key];
    if (a === undefined && b === undefined) continue;
    if (a === undefined || b === undefined) {
      out.push(`${METRIC_INFO[key].label}: app ${a === undefined ? 'did not measure it' : fmtMetric(key, a)}, now ${b === undefined ? 'not measured' : fmtMetric(key, b)}`);
      continue;
    }
    const tol = Math.max(METRIC_DIFF_ABS * Math.max(1, Math.abs(a)), METRIC_DIFF_REL * Math.abs(a));
    if (Math.abs(a - b) > tol) out.push(`${METRIC_INFO[key].label}: app ${fmtMetric(key, a)}, now ${fmtMetric(key, b)}`);
  }
  return out;
}

function verdictWhy(
  def: ExerciseDef,
  v: Pick<Verdict, 'score' | 'passMark' | 'notJudged' | 'unsung' | 'belowPassTempo' | 'failedGates' | 'passed'>,
  gates: GateLine[],
  terms: TermLine[],
  bpm: number | null,
): string[] {
  const why: string[] = [];
  if (v.notJudged === 'folded') why.push('Not judged: the exercise did not fit the saved range, so notes were folded by octaves. A take like that never passes.');
  if (v.notJudged === 'stopped') why.push('Not judged: the take was stopped before the end of the material. It is practice only.');
  if (v.unsung) {
    const needed = notesNeeded(def, v.unsung.total);
    why.push(`Left notes unsung (${v.unsung.reached} of ${v.unsung.total} sung): a take passes only when ${needed >= v.unsung.total ? 'every note is' : `at least ${needed} are`} sung.`);
  }
  if (v.belowPassTempo) why.push(`Sung at ${bpm} bpm, below the level's pass tempo of ${def.tempoBpm} bpm: that take is practice and cannot pass the level, however well it goes.`);
  const scoreLine = gates[0];
  why.push(
    scoreLine.met
      ? `Score ${scoreLine.shown} meets the ${scoreLine.targetShown} pass mark.`
      : `Score ${scoreLine.shown} is ${scoreLine.missBy} under the ${scoreLine.targetShown} pass mark.`,
  );
  const failed = gates.slice(1).filter((g) => g.met !== true);
  if (failed.length > 0) {
    why.push(`Gates not met: ${failed.map((g) => `${g.label} ${g.shown} (needs ${g.op} ${g.targetShown}${g.met === null ? ', it could not be measured' : g.nearMiss ? ', a near miss' : ''})`).join('; ')}.`);
  } else if (gates.length > 1) {
    why.push('Every gate is met.');
  }
  const costly = terms.filter((t) => t.lost >= 0.03).slice(0, 3);
  if (costly.length > 0) why.push(`Biggest score losses: ${costly.map((t) => `${t.label} (-${fmtNum(t.lost * 100)} pts, ${t.shown})`).join(', ')}.`);
  return why;
}

/** One take, from its pitch line (saved, or rebuilt from audio) or, when there is none, from the numbers the app saved. */
function diagnoseTake(ctx: TakeCtx, src: TakeSource): TakeDiagnosis {
  const { def } = ctx;
  const attempt = src.attempt;
  const notes: string[] = [];
  const checks: string[] = [];

  let track = src.track;
  let source: TakeDiagnosis['source'] = 'track';
  let rebuilt: PitchFrame[] | null = null;
  if (src.audio) rebuilt = trackFromSamples(src.audio.samples, src.audio.sampleRate, { detector: ctx.detector ?? undefined });
  if (!track || track.length === 0) {
    track = rebuilt;
    source = 'audio';
  }
  const saved = src.saved ?? (attempt && attempt.tonicMidi !== null ? { tonicMidi: attempt.tonicMidi, bpm: attempt.tempoBpm ?? def.tempoBpm } : null);
  if (!track || track.length === 0 || !saved) return diagnoseFromMetrics(ctx, src, notes);

  const { realized, note } = rebuildRealized(def, saved);
  if (note) notes.push(note);
  const analysis = analyzeTake(def, realized, track, { vibratoStyle: ctx.vibratoStyle });
  const evaluation: Evaluation = evaluate(def, analysis.metrics, analysis);
  const belowPassTempo = !canPassAtTempo(def, realized.bpm);
  const passed = evaluation.passed && !belowPassTempo && realized.fit !== 'folded';
  const gates = gateLines(def, analysis.metrics, evaluation.score);
  const terms = termLines(def, analysis.metrics);
  const tip = pickTip(analysis.metrics, def, analysis.tipContext);
  const clean = cleanOctaveSpikes(track);
  const figures = figuresOf(def, analysis, clean, ctx.notation);
  const expectedSung = realized.notes.reduce((s, n) => s + (n.end - n.start), 0);
  const insights = insightsOf(analysis, clean, expectedSung, ctx.notation);
  const graph = renderPitchGraph({ notes: realized.notes, track: clean, cracks: analysis.details.cracks, totalSec: realized.totalSec }, { width: ctx.width, notation: ctx.notation });
  const cracks = analysis.details.cracks.map((c) => {
    const near = pitchNear(clean, c.t);
    return { t: c.t, kind: c.kind, cents: c.cents ?? null, durationMs: c.durationMs, nearMidi: near, near: near === null ? null : noteLabel(near, ctx.notation) };
  });

  const mastery = passed ? evaluation.mastery : 0;
  const base: Omit<Verdict, 'why' | 'app' | 'agrees'> = {
    passed,
    score: evaluation.score,
    passMark: def.pass.score,
    mastery,
    notJudged: evaluation.notJudged ?? (realized.fit === 'folded' ? 'folded' : null),
    unsung: evaluation.unsung ? { reached: evaluation.unsung.reached, total: evaluation.unsung.total } : null,
    belowPassTempo,
    failedGates: evaluation.failedGates,
  };
  const app = attempt ? { passed: attempt.passed, score: attempt.score } : null;
  const gap = app ? Math.abs(app.score - evaluation.score) : 0;
  const agrees = app ? app.passed === passed && gap <= AGREE_SCORE_GAP : null;
  const verdict: Verdict = { ...base, app, agrees, why: verdictWhy(def, base, gates, terms, realized.bpm) };

  // Consistency: the app's own record of this take against what the analyzers say now.
  if (app && agrees === false) {
    const them = `the app recorded a ${app.passed ? 'pass' : 'miss'} at ${pct(app.score)}; this analysis says ${passed ? 'pass' : 'miss'} at ${pct(evaluation.score)}`;
    const nearLine = Math.abs(evaluation.score - def.pass.score) <= AGREE_SCORE_GAP || gates.some((g) => g.nearMiss);
    if (app.passed !== passed && gap <= AGREE_SCORE_GAP && nearLine) {
      checks.push(`Borderline: ${them}. The scores are within ${fmtNum(AGREE_SCORE_GAP * 100)} points and the take sits on the pass line, and the saved pitch line is stored in 32-bit floats, so a take this close can tip either way.`);
    } else if (!app.passed && passed) {
      checks.push(`Differs: ${them}. The take may have been stopped early (practice only), or another app build scored it.`);
    } else if (app.passed && !passed) {
      checks.push(`Differs: ${them}. Another app build, with other thresholds, probably scored it (the file's app version is in the header).`);
    } else if (source === 'audio') {
      checks.push(`Differs: ${them}. The pitch line was rebuilt from the audio (${detectorWords(ctx)}), or another app build scored it.`);
    } else {
      checks.push(`Differs: ${them}. Another app build, with other thresholds, probably scored it (the file's app version is in the header).`);
    }
  }
  if (attempt) {
    const diffs = metricDiffs(attempt.metrics, analysis.metrics);
    if (diffs.length > 0) {
      const why = source === 'audio' ? ' (the pitch line was rebuilt from audio, so small differences from the live detector are expected)' : '';
      checks.push(`Metrics that differ from the app's saved numbers${why}: ${diffs.slice(0, 6).join('; ')}${diffs.length > 6 ? `; and ${diffs.length - 6} more` : ''}.`);
    }
  }
  let trackCheck: TrackCheck | null = null;
  if (source === 'track' && rebuilt) {
    trackCheck = compareTracks(track, rebuilt);
    const t = trackCheck;
    const apart = t.bothVoiced < 0.8 * Math.min(t.savedVoicedFrames, t.rebuiltVoicedFrames) || (t.medianAbsCents ?? 0) > 10 || t.octaveDisagreements >= 3;
    checks.push(
      `Audio check: the pitch line rebuilt from the audio has ${t.rebuiltVoicedFrames} voiced frames against ${t.savedVoicedFrames} saved; on the ${t.bothVoiced} frames voiced in both, the median difference is ${num(t.medianAbsCents, ' cents')} with ${t.octaveDisagreements} octave disagreements.${apart ? ` They disagree: ${ctx.detector ? `the audio was rebuilt with the detector the take was sung with (${ctx.detector.toUpperCase()}), so this audio is probably not that take` : `the live detector may not have been ${CONFIG.audio.detector.toUpperCase()} (the file does not say), or this audio is not that take`}.` : ' They agree.'}`,
    );
  }

  const engine = runEngine(ctx, src, { realized, analysis, evaluation, tip, track, passed, mastery });
  const streak = engine.coaching?.missesInARow ?? missesOn(def.id, src.log);
  const ladder = engine.coaching ? null : ladderCard(tip.id, depthFor(streak));

  return {
    index: src.index,
    attemptId: attempt?.id ?? null,
    at: attempt?.createdAt || null,
    source,
    tonicMidi: realized.tonicMidi,
    bpm: realized.bpm,
    totalSec: realized.totalSec,
    voicedSec: analysis.voicedSec,
    verdict,
    gates,
    terms,
    metrics: analysis.metrics,
    tip: { id: tip.id, text: tip.text },
    engine,
    ladder,
    figures,
    insights,
    cracks,
    graph,
    checks,
    notes,
    trackCheck,
  };
}

/** The engine's located problem and coaching card for a take (a TakeOutcome is rebuilt from the pieces, as the runner builds it). */
function runEngine(
  ctx: TakeCtx,
  src: TakeSource,
  p: {
    realized: RealizedExercise;
    analysis: TakeAnalysis;
    evaluation: Evaluation;
    tip: PickedTip;
    track: PitchFrame[];
    passed: boolean;
    mastery: number;
  },
): EngineOutput {
  const { def } = ctx;
  const out: EngineOutput = { ...NO_ENGINE };
  const located = attemptCall(() =>
    ctx.engine.locateProblem({ def, realized: p.realized, analysis: p.analysis, tip: p.tip, notation: ctx.notation, track: p.track, vibratoStyle: ctx.vibratoStyle }),
  );
  if (located.ok) out.problem = located.value;
  else {
    out.problemError = located.error;
    out.notBuilt = located.notBuilt;
  }

  const at = src.attempt?.createdAt || ctx.now.toISOString();
  const attempt: AttemptRecord = src.attempt ?? {
    id: `wav-${src.index}`,
    profileId: ctx.profile.id,
    createdAt: at,
    updatedAt: at,
    deletedAt: null,
    exerciseId: def.id,
    levelId: ctx.level?.id ?? null,
    kind: 'practice',
    score: p.evaluation.score,
    passed: p.passed,
    mastery: p.mastery as AttemptRecord['mastery'],
    metrics: p.analysis.metrics,
    durationSec: p.realized.countInSec + p.realized.totalSec,
    tonicMidi: p.realized.tonicMidi,
    tempoBpm: p.realized.bpm,
    takeId: null,
  };
  const log = src.log.some((a) => a.id === attempt.id) ? src.log : [...src.log, attempt];
  const ladderRungs = ladderOf(def);
  const audio: TakeAudio | null = src.audio ? { samples: src.audio.samples, sampleRate: src.audio.sampleRate, t0: 0 } : null;
  const prepared: PreparedRun = {
    target: targetOf(attempt, def),
    def,
    level: ctx.level,
    world: getWorld(def.worldId) ?? null,
    realized: p.realized,
    bpm: p.realized.bpm,
    ladder: def.tempoLadder && def.tempoLadder.length > 0 ? { rungs: ladderRungs, index: Math.max(0, ladderRungs.findIndex((r) => Math.abs(r - p.realized.bpm) < 1e-9)) } : null,
    passLines: passRequirements(def),
    usingDefaultRange: ctx.profile.range === null,
    audition: null,
    workout: null,
  };
  const take: TakeResult = {
    track: p.track,
    audio,
    latencyMs: src.latencyMs ?? 0,
    downbeat: 0,
    frameRate: p.track.length > 1 ? 1 / Math.max(1e-6, median(p.track.slice(1).map((f, i) => f.t - p.track[i].t))) : 1 / CONFIG.audio.hopSeconds,
  };
  const outcome: TakeOutcome = {
    id: attempt.id,
    prepared,
    take,
    analysis: p.analysis,
    evaluation: p.evaluation,
    tiles: reportTiles(def, p.analysis.metrics),
    tip: p.tip,
    attempt,
    savedTake: null,
    saveError: null,
    nextBpm: def.tempoLadder ? nextTempo(def, p.realized.bpm, p.analysis.metrics, p.analysis) : null,
    rangeSaved: false,
    before: snapshotOf(ctx.profile.id, log.slice(0, -1), at),
    after: snapshotOf(ctx.profile.id, log, at),
    unlocked: [],
  };
  const card = attemptCall(() => ctx.engine.coachTake(outcome, log, { notation: ctx.notation, vibratoStyle: ctx.vibratoStyle }));
  if (card.ok) out.coaching = card.value;
  else {
    out.coachingError = card.error;
    out.notBuilt = out.notBuilt || card.notBuilt;
  }
  return out;
}

/** The coaching card for a take with no pitch line, from its saved numbers (coach.ts coachFrom), when the engine offers it. */
function engineFromMetrics(ctx: TakeCtx, src: TakeSource, tip: PickedTip, metrics: Metrics): EngineOutput {
  const out: EngineOutput = { ...NO_ENGINE };
  const attempt = src.attempt;
  const coachFrom = ctx.engine.coachFrom;
  if (!attempt || !coachFrom) return out;
  const { def } = ctx;
  const realized = realizeAtTonic(def, attempt.tonicMidi ?? 60, attempt.tempoBpm ?? undefined);
  const lowerRung = def.tempoLadder !== undefined && def.tempoLadder.length > 0 && !canPassAtTempo(def, attempt.tempoBpm);
  const passed = attempt.passed || (lowerRung && evaluate(def, metrics).passed);
  const log = src.log.some((a) => a.id === attempt.id) ? src.log : [...src.log, attempt];
  const snap = snapshotOf(ctx.profile.id, log, attempt.createdAt || ctx.now.toISOString());
  const card = attemptCall(() =>
    coachFrom({ def, attempt, tip, passed, metrics, analysis: null, realized, track: null }, log, {
      notation: ctx.notation,
      vibratoStyle: ctx.vibratoStyle,
      isLevelPassed: (id) => snap.levels[id]?.status === 'passed',
    }),
  );
  if (card.ok) {
    out.coaching = card.value;
    out.problem = card.value.problem;
  } else {
    out.coachingError = card.error;
    out.notBuilt = card.notBuilt;
  }
  return out;
}

/** A take with no pitch line: what the app saved (score, pass, metrics), re-scored against the exercise as it is now. */
function diagnoseFromMetrics(ctx: TakeCtx, src: TakeSource, notes: string[]): TakeDiagnosis {
  const { def } = ctx;
  const attempt = src.attempt;
  const metrics = attempt?.metrics ?? {};
  const sc = scoreExercise(def, metrics);
  const gates = gateLines(def, metrics, attempt ? attempt.score : sc.score);
  const terms = termLines(def, metrics);
  const tip = pickTip(metrics, def);
  const checks: string[] = [];
  notes.push('No pitch line for this take: the numbers are what the app saved. Ask for a "Send to Claude" coaching file (or the take WAV) to see where in the take it went wrong.');
  if (attempt && Math.abs(sc.score - attempt.score) > 0.01) {
    checks.push(`Re-scoring the saved numbers against today's catalog gives ${pct(sc.score)}, not the ${pct(attempt.score)} the app saved: the thresholds changed since this take.`);
  }
  const score = attempt ? attempt.score : sc.score;
  const passed = attempt ? attempt.passed : sc.passed;
  const belowPassTempo = attempt?.tempoBpm != null && !canPassAtTempo(def, attempt.tempoBpm);
  const base: Omit<Verdict, 'why' | 'app' | 'agrees'> = {
    passed,
    score,
    passMark: def.pass.score,
    mastery: attempt?.mastery ?? 0,
    notJudged: null,
    unsung: null,
    belowPassTempo,
    failedGates: sc.failedGates,
  };
  const verdict: Verdict = {
    ...base,
    app: attempt ? { passed: attempt.passed, score: attempt.score } : null,
    agrees: null,
    why: verdictWhy(def, base, gates, terms, attempt?.tempoBpm ?? null),
  };
  const engine = engineFromMetrics(ctx, src, tip, metrics);
  const streak = engine.coaching?.missesInARow ?? missesOn(def.id, src.log);
  return {
    index: src.index,
    attemptId: attempt?.id ?? null,
    at: attempt?.createdAt || null,
    source: 'metrics',
    tonicMidi: attempt?.tonicMidi ?? null,
    bpm: attempt?.tempoBpm ?? null,
    totalSec: null,
    voicedSec: null,
    verdict,
    gates,
    terms,
    metrics,
    tip: { id: tip.id, text: tip.text },
    engine,
    ladder: engine.coaching ? null : ladderCard(tip.id, depthFor(streak)),
    figures: [],
    insights: [],
    cracks: [],
    graph: null,
    checks,
    notes,
    trackCheck: null,
  };
}

// ---------------------------------------------------------------- across takes

/** The PROVISIONAL thresholds of docs/MANUAL-TEST-CHECKLIST.md (rows P1-P17), by the metrics each one judges. */
const PROVISIONAL: ReadonlyArray<{ id: string; title: string; where: string; prefixes: readonly string[] }> = [
  { id: 'P5', title: 'Switching and bloom', where: 'analysis/switch.ts tolerances', prefixes: ['vibrato.switch', 'vibrato.bloom'] },
  { id: 'P4', title: 'Vibrato zone and flags', where: 'CONFIG.vibrato; analysis/vibrato.ts', prefixes: ['vibrato.'] },
  { id: 'P2', title: 'Late start', where: 'CONFIG.accuracy.lateStartAllowanceSec', prefixes: ['accuracy.'] },
  { id: 'P3', title: 'Onsets', where: 'CONFIG.onset; analysis/onset.ts', prefixes: ['onset.'] },
  { id: 'P6', title: 'Pulses and oscillation', where: 'analysis/pulse.ts', prefixes: ['pulse.'] },
  { id: 'P7', title: 'Sirens, stairs and breaks', where: 'CONFIG.transitions; analysis/glide.ts', prefixes: ['glide.'] },
  { id: 'P8', title: 'Leaps and legato', where: 'analysis/transitions.ts; analysis/dtw.ts', prefixes: ['transition.'] },
  { id: 'P9', title: 'Inflections', where: 'analysis/inflections.ts', prefixes: ['inflection.'] },
  { id: 'P10', title: 'Smeared or defined runs', where: 'CONFIG.runs; analysis/runs.ts', prefixes: ['run.'] },
  { id: 'P11', title: 'Dynamics', where: 'CONFIG.dynamics; analysis/dynamics.ts', prefixes: ['dynamics.'] },
  { id: 'P12', title: 'Range', where: 'CONFIG.range', prefixes: ['range.'] },
];

function provisionalFor(metric: MetricKey): (typeof PROVISIONAL)[number] | undefined {
  return PROVISIONAL.find((p) => p.prefixes.some((pre) => metric.startsWith(pre)));
}

export interface MetricTrend {
  metric: MetricKey;
  label: string;
  /** Oldest to newest; null where the take could not measure it. */
  values: Array<number | null>;
  shown: string[];
  verdict: 'better' | 'worse' | 'same' | 'unknown';
  /** The level's gate on it ("<= 3.8"), when it has one, and in how many of the takes it was not met. */
  gate: string | null;
  gateMisses: number;
}

export interface Comparison {
  /** Oldest first. */
  rows: Array<{ index: number; at: string | null; passed: boolean; score: number; failedGates: string[]; tipId: string | null; source: TakeDiagnosis['source'] }>;
  scoreTrend: 'better' | 'worse' | 'same' | 'unknown';
  metrics: MetricTrend[];
  improved: string[];
  worsened: string[];
  repeats: string[];
  /** For the analyst: which PROVISIONAL threshold a repeated miss touches, and whether it looks like the singer or the app. */
  hints: string[];
}

/** Least-squares change from the first to the last take (slope x (n - 1)); null with fewer than two measured points. */
function fittedChange(values: ReadonlyArray<number | null>): number | null {
  const pts = values.map((v, i) => [i, v] as const).filter((p): p is readonly [number, number] => p[1] !== null);
  if (pts.length < 2) return null;
  const mx = pts.reduce((s, p) => s + p[0], 0) / pts.length;
  const my = pts.reduce((s, p) => s + p[1], 0) / pts.length;
  let sxy = 0;
  let sxx = 0;
  for (const [x, y] of pts) {
    sxy += (x - mx) * (y - my);
    sxx += (x - mx) ** 2;
  }
  return sxx > 0 ? (sxy / sxx) * (values.length - 1) : null;
}

/** What improves and what repeats across the takes (any number; newest first in, oldest first out). */
export function compareTakes(def: ExerciseDef, takesNewestFirst: readonly TakeDiagnosis[]): Comparison {
  const takes = [...takesNewestFirst].reverse();
  const n = takes.length;
  const rows = takes.map((t) => ({
    index: t.index,
    at: t.at,
    passed: t.verdict.app?.passed ?? t.verdict.passed,
    score: t.verdict.app?.score ?? t.verdict.score,
    failedGates: t.gates.slice(1).filter((g) => g.met !== true).map((g) => g.label),
    tipId: t.tip?.id ?? null,
    source: t.source,
  }));

  const judged: MetricKey[] = [];
  for (const g of def.pass.gates ?? []) if (!judged.includes(g.metric)) judged.push(g.metric);
  for (const t of def.scoring) if (!judged.includes(t.metric)) judged.push(t.metric);

  const trends: MetricTrend[] = [];
  const improved: string[] = [];
  const worsened: string[] = [];
  for (const metric of judged) {
    const values = takes.map((t) => (isNum(t.metrics[metric]) ? (t.metrics[metric] as number) : null));
    const info = METRIC_INFO[metric];
    const term = termOf(def, metric);
    const gate = (def.pass.gates ?? []).find((g) => g.metric === metric);
    const scale = term ? Math.abs(term.best - term.worst) : gate ? Math.abs(gate.value) : Math.max(1e-9, ...values.map((v) => Math.abs(v ?? 0)));
    const change = fittedChange(values);
    let verdict: MetricTrend['verdict'] = 'unknown';
    if (change !== null && info.direction !== 'target') {
      const better = info.direction === 'higher' ? change : -change;
      verdict = Math.abs(change) < 0.08 * scale ? 'same' : better > 0 ? 'better' : 'worse';
    }
    const missesGate = (t: TakeDiagnosis): boolean => t.gates.some((g) => g.metric === metric && g.met !== true);
    const gateMisses = gate ? takes.filter(missesGate).length : 0;
    const shown = values.map((v) => (v === null ? '-' : fmtMetric(metric, v)));
    trends.push({ metric, label: info.label, values, shown, verdict, gate: gate ? `${gate.op} ${fmtMetric(metric, gate.value)}` : null, gateMisses });
    const arrow = shown.join(' -> ');
    if (verdict === 'better') improved.push(`${info.label}: ${arrow}`);
    if (verdict === 'worse') worsened.push(`${info.label}: ${arrow}`);
  }

  const scores = rows.map((r) => r.score);
  const scoreChange = fittedChange(scores);
  const scoreTrend: Comparison['scoreTrend'] = scoreChange === null ? 'unknown' : Math.abs(scoreChange) < 0.04 ? 'same' : scoreChange > 0 ? 'better' : 'worse';

  const repeats: string[] = [];
  const hints: string[] = [];
  for (const g of def.pass.gates ?? []) {
    const lines = takes.map((t) => t.gates.find((x) => x.metric === g.metric));
    const misses = lines.filter((l): l is GateLine => !!l && l.met !== true);
    if (misses.length === 0 || (n > 1 && misses.length < 2)) continue;
    const shown = lines.map((l) => (l ? l.shown : '-')).join(', ');
    const label = METRIC_INFO[g.metric].label;
    repeats.push(`${label} missed its gate in ${misses.length} of ${n} take${n === 1 ? '' : 's'} (${shown}; needs ${g.op} ${fmtMetric(g.metric, g.value)}).`);
    const prov = provisionalFor(g.metric);
    const near = misses.filter((m) => m.nearMiss).length;
    const clear = misses.filter((m) => !m.nearMiss && m.met === false).length;
    let read: string;
    if (near === misses.length) read = 'every miss is a near miss (within a tenth of the score band): suspect the threshold as much as the singing';
    else if (clear >= 1 && near === 0) read = 'the misses are clear ones: that reads as the singing, not the app';
    else read = 'some near misses and some clear ones: mostly the singing, with the threshold close';
    const trend = trends.find((x) => x.metric === g.metric);
    if (trend?.verdict === 'better') read += `; it is improving (${trend.shown.join(' -> ')})`;
    else if (trend?.verdict === 'worse') read += `; it is getting worse (${trend.shown.join(' -> ')})`;
    else if (trend?.verdict === 'same' && n >= 3) read += `; it has not moved over the takes (${trend.shown.join(' -> ')})`;
    const unmeasured = misses.filter((m) => m.met === null).length;
    if (unmeasured > 0) read += `; ${unmeasured} take${unmeasured === 1 ? '' : 's'} could not measure it at all (check that the audio and the voicing gate, P1, let the notes through)`;
    hints.push(`${label}: ${read}.${prov ? ` Checklist ${prov.id} ${prov.title} (${prov.where}) is the row to compare against.` : ''}`);
  }

  const tipCounts = new Map<string, number>();
  for (const r of rows) if (r.tipId && r.tipId !== 'general.polish') tipCounts.set(r.tipId, (tipCounts.get(r.tipId) ?? 0) + 1);
  for (const [id, count] of tipCounts) if (count >= 2) repeats.push(`The coach picked the same problem (${id}) in ${count} of ${n} takes.`);

  const spotCounts = new Map<string, { count: number; label: string }>();
  for (const t of takes) {
    for (const key of new Set(t.figures.filter((f) => f.bad && f.key).map((f) => f.key as string))) {
      const [kind, ...rest] = key.split(':');
      spotCounts.set(key, { count: (spotCounts.get(key)?.count ?? 0) + 1, label: `${kind} ${rest.join(':')}` });
    }
  }
  const spots = [...spotCounts.values()].filter((s) => s.count >= 2).sort((a, b) => b.count - a.count).slice(0, 6);
  if (spots.length > 0) repeats.push(`The same trouble spots keep coming back: ${spots.map((s) => `${s.label} (${s.count} of ${n} takes)`).join(', ')}.`);

  const nearScore = rows.filter((r) => !r.passed && r.score < def.pass.score && def.pass.score - r.score <= 0.05).length;
  if (nearScore >= 2) hints.push(`The score fell within 5 points of the pass mark on ${nearScore} of ${n} takes: checklist P13 (score bands) is worth a look before blaming the singer.`);
  const unsungTakes = takes.filter((t) => t.verdict.unsung).length;
  if (unsungTakes > 0) hints.push(`${unsungTakes} of ${n} takes left notes unsung: checklist P17 (note reach) covers the rule that refuses those.`);
  return { rows, scoreTrend, metrics: trends, improved, worsened, repeats, hints };
}

// ---------------------------------------------------------------- whole files

export interface FileDiagnosis {
  source: 'coaching' | 'backup' | 'wav';
  /** The file name the diagnosis came from. */
  name: string;
  title: string;
  exportedAt: string | null;
  appVersion: string | null;
  singer: { name: string; voiceType: string; range: VocalRange | null; vibratoStyle: VibratoStyle; notation: Notation } | null;
  exercise: {
    id: string;
    title: string;
    goal: string;
    kind: string;
    worldId: string;
    levelId: string | null;
    levelTitle: string | null;
    steps: readonly string[];
    passPlain: string | null;
    tolerance: string;
    toleranceCents: number;
    passMark: number;
    gates: string[];
    tempoBpm: number;
  };
  /** Newest first. */
  takes: TakeDiagnosis[];
  comparison: Comparison | null;
  /** Misses in a row up to the newest take; `atLeast` when the log is cut off at the takes in the file. */
  streak: { misses: number; depth: CoachDepth; atLeast: boolean };
  engine: { status: 'ok' | 'not-built' | 'error' | 'unused'; message: string | null };
  /** What the backup says about where the singer is (backups only). */
  overview: BackupOverview | null;
  /** The few lines to read first: the newest take, the coach's pick, the streak, the trend, singer or app. */
  summary: string[];
  notes: string[];
}

export interface BackupOverview {
  profile: { id: string; name: string; voiceType: string; range: VocalRange | null };
  attempts: number;
  firstAt: string | null;
  lastAt: string | null;
  worlds: Array<{ worldId: string; title: string; passed: number; total: number; current: string | null }>;
  exercises: Array<{ exerciseId: string; title: string; attempts: number; passes: number; best: number; last: number; missesInARow: number }>;
  focus: string;
  otherProfiles: string[];
}

export interface DiagnoseOptions {
  engine?: CoachEngine;
  /** Plot columns of the pitch graph. */
  width?: number;
  /** The profile's whole attempt log (from a backup), oldest first: the streak and progress then see past the takes in the file. */
  log?: readonly AttemptRecord[];
  /** WAV samples for one take of a coaching file (1 = newest), rebuilt with the production framer and cross-checked against the saved pitch line. */
  audio?: { take: number; wav: WavSamples };
  now?: Date;
}

function exerciseBlock(def: ExerciseDef, level: { id: string | null; title: string | null }): FileDiagnosis['exercise'] {
  const gates = (def.pass.gates ?? []).map((g) => `${METRIC_INFO[g.metric].label} ${g.op} ${fmtMetric(g.metric, g.value)}`);
  return {
    id: def.id,
    title: def.title,
    goal: def.goal ?? '',
    kind: def.kind,
    worldId: def.worldId,
    levelId: level.id,
    levelTitle: level.title,
    steps: def.steps ?? [],
    passPlain: def.passPlain ?? null,
    tolerance: def.tolerance,
    toleranceCents: tolOf(def),
    passMark: def.pass.score,
    gates,
    tempoBpm: def.tempoBpm,
  };
}

function engineStatus(takes: readonly TakeDiagnosis[]): FileDiagnosis['engine'] {
  const tried = takes.filter((t) => t.source !== 'metrics' || t.engine.coaching || t.engine.coachingError);
  if (tried.length === 0) return { status: 'unused', message: 'no take had a pitch line to locate a problem in, and the engine cannot coach from saved numbers here' };
  if (tried.some((t) => t.engine.notBuilt)) return { status: 'not-built', message: 'coaching/coach.ts still throws "not built yet": the located problem and the coaching card are missing here' };
  const failed = tried.find((t) => t.engine.problemError || t.engine.coachingError);
  if (failed) return { status: 'error', message: failed.engine.problemError ?? failed.engine.coachingError };
  return { status: 'ok', message: null };
}

function streakOf(takes: readonly TakeDiagnosis[], full: boolean): FileDiagnosis['streak'] {
  const misses = countMisses(takes.map((t) => ({ passed: t.verdict.app?.passed ?? t.verdict.passed })));
  return { misses, depth: depthFor(misses), atLeast: !full && misses === takes.length };
}

/** The few lines to read first: the newest take, the coach's pick, the streak, the trend and the singer-or-app read. */
function summarize(takes: readonly TakeDiagnosis[], cmp: Comparison | null, streak: FileDiagnosis['streak']): string[] {
  const t = takes[0];
  const v = t.verdict;
  const out: string[] = [];
  const unmet = t.gates.slice(1).filter((g) => g.met !== true).map((g) => g.label);
  const verdict = v.notJudged ? 'not judged' : v.passed ? 'PASS' : 'MISS';
  const when = t.at ? ` (${localStamp(t.at)})` : '';
  out.push(`The newest take${when}: ${verdict} at ${fmtNum(v.score * 100)}% against a ${fmtNum(v.passMark * 100)}% pass mark${unmet.length > 0 ? `; gates not met: ${unmet.join(', ')}` : ''}.`);
  const p = t.engine.problem;
  if (p && p.tipId !== 'general.polish') out.push(`The coach's pick, ${p.tipId}: ${p.what}`);
  else if (!p && !v.passed && t.tip) out.push(`The rule table's pick: ${t.tip.id}.`);
  if (takes.some((x) => x.verdict.app)) {
    out.push(`${streak.atLeast ? 'At least ' : ''}${streak.misses === 1 ? '1 miss' : `${streak.misses} misses`} in a row, so coaching depth ${streak.depth} of 4.`);
  }
  if (cmp) {
    const scores = cmp.rows.map((r) => `${fmtNum(r.score * 100)}%`).join(' -> ');
    const improving = cmp.improved.length > 0 ? ` Improving: ${cmp.improved.map((s) => s.split(':')[0]).join(', ')}.` : '';
    const repeating = cmp.repeats.length > 0 ? ` ${cmp.repeats[0]}` : '';
    out.push(`Across the ${takes.length} takes the score is ${SCORE_TREND_WORDS[cmp.scoreTrend]} (${scores}).${improving}${repeating}`);
    if (cmp.hints.length > 0) out.push(`The singer or the app? ${cmp.hints[0]}`);
  }
  return out;
}

/** The FileDiagnosis around its takes: the comparison, the engine's status and the summary come from them. */
function assemble(parts: Omit<FileDiagnosis, 'comparison' | 'engine' | 'summary'> & { def: ExerciseDef }): FileDiagnosis {
  const { def, ...rest } = parts;
  const comparison = parts.takes.length > 1 ? compareTakes(def, parts.takes) : null;
  return { ...rest, comparison, engine: engineStatus(parts.takes), summary: summarize(parts.takes, comparison, parts.streak) };
}

/** The diagnosis of a coaching file: every take re-analyzed from its saved pitch line, then compared. */
export function diagnoseCoachingFile(file: CoachingFile, opts: DiagnoseOptions = {}, name = 'coaching file'): FileDiagnosis {
  const def = file.exercise;
  const now = opts.now ?? new Date();
  const level = (file.level.id ? getLevel(file.level.id) : undefined) ?? null;
  const fileLog = [...file.takes].reverse().map((t) => t.attempt);
  const newest = file.takes[0].attempt;
  const profileId = newest.profileId;
  // The log as of the newest take in the file: its own takes, plus (from a backup) the history before them.
  const inFile = new Set(fileLog.map((a) => a.id));
  const history = (opts.log ?? []).filter((a) => a.profileId === profileId && !inFile.has(a.id) && byAge(a, newest) <= 0);
  const fullLog = [...history, ...fileLog].sort(byAge);
  const ctx: TakeCtx = {
    def,
    level,
    notation: file.settings.notation,
    vibratoStyle: file.settings.vibratoStyle,
    detector: file.settings.detector ?? null,
    engine: opts.engine ?? REAL_ENGINE,
    width: opts.width ?? 96,
    profile: { id: profileId, name: file.profile.name, voiceType: file.profile.voiceType, range: file.profile.range },
    now,
  };
  const takes = file.takes.map((t, i): TakeDiagnosis => {
    const index = i + 1;
    const log = fullLog.slice(0, fullLog.findIndex((a) => a.id === t.attempt.id) + 1);
    let audio: WavSamples | null = null;
    const notes: string[] = [];
    if (opts.audio && opts.audio.take === index) audio = opts.audio.wav;
    else if (t.audioWavBase64) {
      const parsed = attemptCall(() => parseWav(base64ToBytes(t.audioWavBase64 as string)));
      if (parsed.ok) audio = { samples: parsed.value.samples, sampleRate: parsed.value.sampleRate };
      else notes.push(`the audio in the file could not be read (${parsed.error})`);
    }
    let track: PitchFrame[] | null = null;
    if (t.track) {
      track = decodeTrack(t.track);
      if (track.length === 0) notes.push('the saved pitch line could not be decoded');
    }
    const d = diagnoseTake(ctx, {
      index,
      attempt: t.attempt,
      saved: { tonicMidi: t.realized.tonicMidi, bpm: t.realized.bpm, notes: t.realized.notes },
      track,
      audio,
      log,
      latencyMs: file.device.latencyMs,
    });
    d.notes.unshift(...notes);
    return d;
  });
  const full = history.length > 0;
  const streak = streakOf(takes, full);
  const engineMisses = attemptCall(() => ctx.engine.missesInARow(def.id, fullLog));
  if (engineMisses.ok && Number.isFinite(engineMisses.value)) {
    streak.misses = engineMisses.value;
    streak.depth = depthFor(engineMisses.value);
    streak.atLeast = !full && engineMisses.value >= file.takes.length;
  }
  return assemble({
    def,
    source: 'coaching',
    name,
    title: `${file.level.title}${file.level.id ? ` (${file.level.id})` : ''}`,
    exportedAt: file.exportedAt || null,
    appVersion: file.appVersion,
    singer: { name: file.profile.name, voiceType: file.profile.voiceType, range: file.profile.range, vibratoStyle: file.settings.vibratoStyle, notation: file.settings.notation },
    exercise: exerciseBlock(def, { id: file.level.id, title: file.level.title }),
    takes,
    streak,
    overview: null,
    notes: [],
  });
}

/** Finds the exercise a flag names: an exercise id, a level id ("foundations.05"), or part of a title ("sirens"). */
export function resolveExercise(query: string): ExerciseDef {
  const q = query.trim().toLowerCase();
  const exact = lookupExercise(query.trim());
  if (exact) return exact;
  const level = getLevel(query.trim());
  if (level) {
    const def = getExercise(level.exerciseId);
    if (def) return def;
  }
  const hits = EXERCISES.filter((e) => e.id.toLowerCase().includes(q) || e.title.toLowerCase().includes(q));
  if (hits.length === 1) return hits[0];
  if (hits.length === 0) throw new CoachInputError(`no exercise matches "${query}" (try an exercise id like foundations.siren.1, a level id like foundations.05, or part of a title)`);
  throw new CoachInputError(`"${query}" matches ${hits.length} exercises: ${hits.slice(0, 6).map((e) => e.id).join(', ')}${hits.length > 6 ? ', ...' : ''}; name one`);
}

const dayKey = (iso: string): string => localStamp(iso).slice(0, 10);

/** The profile a backup analysis is about: the one named by the flag, else the one that sang most recently. */
function pickProfile(backup: ParsedBackup, query?: string): ProfileRecord {
  if (backup.profiles.length === 0) throw new CoachInputError('the backup holds no live profile');
  if (query) {
    const q = query.trim().toLowerCase();
    const hit = backup.profiles.find((p) => p.id.toLowerCase() === q || p.name.toLowerCase() === q) ?? backup.profiles.find((p) => p.name.toLowerCase().includes(q));
    if (!hit) throw new CoachInputError(`no profile matches "${query}" (the backup has: ${backup.profiles.map((p) => p.name).join(', ')})`);
    return hit;
  }
  const newest = [...backup.attempts].reverse().find((a) => backup.profiles.some((p) => p.id === a.profileId));
  return backup.profiles.find((p) => p.id === newest?.profileId) ?? backup.profiles[0];
}

function settingsOf(backup: ParsedBackup, profileId: string): { vibratoStyle: VibratoStyle; notation: Notation; detector: DetectorKind | null } {
  const s = backup.settings[profileId] ?? {};
  return { vibratoStyle: s.vibratoStyle ?? 'pop', notation: s.notation ?? 'sharps', detector: s.detector ?? null };
}

/** How many recent attempts of the focus exercise a backup diagnosis lists. */
const BACKUP_TAKES = 6;

export interface BackupOptions extends DiagnoseOptions {
  /** A profile name or id. */
  profile?: string;
  /** The exercise to look at: an exercise id, a level id or part of a title (default: the newest attempt's). */
  exercise?: string;
}

/** The diagnosis of a backup: where the singer is, and the recent attempts of one exercise, from the numbers the app saved. */
export function diagnoseBackup(backup: ParsedBackup, opts: BackupOptions = {}, name = 'backup'): FileDiagnosis {
  const profile = pickProfile(backup, opts.profile);
  const mine = backup.attempts.filter((a) => a.profileId === profile.id);
  const now = opts.now ?? new Date();
  const exportedAt = backup.exportedAt || now.toISOString();
  if (mine.length === 0) throw new CoachInputError(`${profile.name} has no attempts in the backup`);
  const known = mine.filter((a) => lookupExercise(a.exerciseId));
  if (known.length === 0) throw new CoachInputError(`none of ${profile.name}'s attempts is of an exercise this version of Pitch Lab knows`);

  const def = opts.exercise ? resolveExercise(opts.exercise) : (lookupExercise(known[known.length - 1].exerciseId) as ExerciseDef);
  const ofExercise = mine.filter((a) => a.exerciseId === def.id);
  if (ofExercise.length === 0) throw new CoachInputError(`${profile.name} has no attempts of ${def.title} (${def.id}) in the backup`);
  const level = levelForExercise(def.id) ?? null;
  const { vibratoStyle, notation, detector } = settingsOf(backup, profile.id);
  const ctx: TakeCtx = {
    def,
    level,
    notation,
    vibratoStyle,
    detector,
    engine: opts.engine ?? REAL_ENGINE,
    width: opts.width ?? 96,
    profile: { id: profile.id, name: profile.name, voiceType: profile.voiceType, range: profile.range },
    now,
  };
  const recent = ofExercise.slice(-BACKUP_TAKES).reverse();
  const takes = recent.map((a, i) => {
    const at = mine.findIndex((x) => x.id === a.id);
    return diagnoseTake(ctx, { index: i + 1, attempt: a, saved: null, track: null, audio: null, log: mine.slice(0, at + 1), latencyMs: null });
  });

  const snap = snapshotOf(profile.id, mine, exportedAt);
  const worlds: BackupOverview['worlds'] = [];
  for (const w of WORLDS) {
    if (!snap.worldsUnlocked.includes(w.id) || w.levels.length === 0) continue;
    const cur = w.levels.find((l) => snap.levels[l.id]?.status === 'current');
    worlds.push({
      worldId: w.id,
      title: w.title,
      passed: w.levels.filter((l) => snap.levels[l.id]?.status === 'passed').length,
      total: w.levels.length,
      current: cur ? `${String(cur.index).padStart(2, '0')} ${cur.title}` : null,
    });
  }
  const byExercise = new Map<string, AttemptRecord[]>();
  for (const a of known) byExercise.set(a.exerciseId, [...(byExercise.get(a.exerciseId) ?? []), a]);
  const exercises = [...byExercise.entries()]
    .map(([id, list]) => ({
      exerciseId: id,
      title: (lookupExercise(id) as ExerciseDef).title,
      attempts: list.length,
      passes: list.filter((a) => a.passed).length,
      best: Math.max(...list.map((a) => a.score)),
      last: list[list.length - 1].score,
      missesInARow: countMisses([...list].reverse()),
      lastAt: list[list.length - 1].createdAt,
    }))
    .sort((a, b) => (a.lastAt < b.lastAt ? 1 : -1))
    .slice(0, 12)
    .map(({ lastAt: _lastAt, ...rest }) => rest);
  const overview: BackupOverview = {
    profile: { id: profile.id, name: profile.name, voiceType: profile.voiceType, range: profile.range },
    attempts: mine.length,
    firstAt: mine[0].createdAt || null,
    lastAt: mine[mine.length - 1].createdAt || null,
    worlds,
    exercises,
    focus: def.id,
    otherProfiles: backup.profiles.filter((p) => p.id !== profile.id).map((p) => p.name),
  };
  // The streak counts every attempt of the exercise, not just the few listed (the engine's own count when it answers).
  const misses = attemptCall(() => ctx.engine.missesInARow(def.id, mine));
  const streakMisses = misses.ok && Number.isFinite(misses.value) ? misses.value : countMisses([...ofExercise].reverse());
  const streak: FileDiagnosis['streak'] = { misses: streakMisses, depth: depthFor(streakMisses), atLeast: false };
  return assemble({
    def,
    source: 'backup',
    name,
    title: `${profile.name}: ${def.title}`,
    exportedAt: backup.exportedAt || null,
    appVersion: null,
    singer: { name: profile.name, voiceType: profile.voiceType, range: profile.range, vibratoStyle, notation },
    exercise: exerciseBlock(def, { id: level?.id ?? null, title: level?.title ?? null }),
    takes,
    streak,
    overview,
    notes: backup.warnings,
  });
}

export interface WavOptions extends BackupOptions {
  /** The exercise's tonic, as MIDI or a note name ("A3"): needed when no backup attempt names it and it cannot be inferred. */
  tonic?: string | number;
  bpm?: number;
  /** Pick the backup attempt with this id (a prefix is enough). */
  attempt?: string;
  /** Pick the backup attempt nearest this time. */
  at?: string | number | Date;
}

function parseTonic(tonic: string | number): number {
  if (typeof tonic === 'number') return tonic;
  const t = tonic.trim();
  const m = /^-?\d+(\.\d+)?$/.test(t) ? Number(t) : parseNote(t);
  if (!Number.isFinite(m)) throw new CoachInputError(`"${tonic}" is not a tonic: give a MIDI number (57) or a note name (A3)`);
  return m;
}

/** Which backup attempt a WAV is: the one asked for, else the nearest in time, else by the day in the file name and the length. */
function matchAttempt(backup: ParsedBackup, profileId: string, wav: WavSamples, fileName: string, o: WavOptions): { attempt: AttemptRecord; how: string } {
  let pool = backup.attempts.filter((a) => a.profileId === profileId && a.kind !== 'song' && lookupExercise(a.exerciseId));
  if (o.exercise) {
    const def = resolveExercise(o.exercise);
    pool = pool.filter((a) => a.exerciseId === def.id);
  }
  if (pool.length === 0) throw new CoachInputError('the backup holds no attempt this WAV could belong to');
  if (o.attempt) {
    const hit = pool.filter((a) => a.id.startsWith(o.attempt as string));
    if (hit.length !== 1) throw new CoachInputError(`${hit.length === 0 ? 'no attempt starts' : `${hit.length} attempts start`} with "${o.attempt}"`);
    return { attempt: hit[0], how: `named by --attempt ${o.attempt}` };
  }
  const wavSec = wav.samples.length / wav.sampleRate;
  /** How long the WAV of this attempt's take should be: the material plus the tail the runner records. */
  const takeSec = (a: AttemptRecord): number => {
    const def = lookupExercise(a.exerciseId) as ExerciseDef;
    return realizeAtTonic(def, a.tonicMidi ?? 60, a.tempoBpm ?? undefined).totalSec + TAKE_TAIL_SEC;
  };
  const gapSec = (a: AttemptRecord): number => Math.abs(takeSec(a) - wavSec);
  if (o.at !== undefined) {
    const t = o.at instanceof Date ? o.at.getTime() : typeof o.at === 'number' ? o.at : Date.parse(o.at);
    if (!Number.isFinite(t)) throw new CoachInputError(`"${String(o.at)}" is not a time (try "2026-10-22 14:05")`);
    const near = [...pool].sort((a, b) => Math.abs(Date.parse(a.createdAt) - t) - Math.abs(Date.parse(b.createdAt) - t))[0];
    return { attempt: near, how: `the attempt nearest ${localStamp(new Date(t).toISOString())} (--at)` };
  }
  const named = /(\d{4}-\d{2}-\d{2})/.exec(fileName)?.[1];
  const sameDay = named ? pool.filter((a) => a.createdAt && dayKey(a.createdAt) === named) : [];
  const candidates = sameDay.length > 0 ? sameDay : pool.slice(-10);
  const scored = candidates.map((a) => ({ a, gap: gapSec(a) })).sort((x, y) => x.gap - y.gap || (x.a.createdAt < y.a.createdAt ? 1 : -1));
  const close = scored.filter((s) => s.gap <= 0.2);
  const chosen = (close.length > 0 ? close : scored)[0];
  const ties = close.length;
  const dayNote = sameDay.length > 0 ? `the file name's day (${named})` : 'the 10 newest attempts';
  const how =
    close.length > 0
      ? `${dayNote} and the WAV's length (${fmtNum(wavSec)} s)${ties > 1 ? `; ${ties} attempts fit equally well, so the newest was used: name one with --attempt or --at` : ''}`
      : `${dayNote}; none has this WAV's length (${fmtNum(wavSec)} s), so the nearest was used (its take is ${fmtNum(takeSec(chosen.a))} s): if it is the wrong lesson, name it with --exercise, --attempt or --at`;
  return { attempt: chosen.a, how };
}

/** The diagnosis of one WAV take: its pitch line rebuilt from the audio, against the exercise from a backup's attempt or a flag. */
export function diagnoseWav(wav: WavSamples, opts: WavOptions & { backup?: ParsedBackup; fileName?: string } = {}, name = 'take WAV'): FileDiagnosis {
  const now = opts.now ?? new Date();
  const notes: string[] = [];
  let attempt: AttemptRecord | null = null;
  let def: ExerciseDef;
  let profile: { id: string; name: string; voiceType: string; range: VocalRange | null };
  let prior: AttemptRecord[] = [];
  let settings: { vibratoStyle: VibratoStyle; notation: Notation; detector: DetectorKind | null } = { vibratoStyle: 'pop', notation: 'sharps', detector: null };
  if (opts.backup) {
    const p = pickProfile(opts.backup, opts.profile);
    const m = matchAttempt(opts.backup, p.id, wav, opts.fileName ?? name, opts);
    attempt = m.attempt;
    def = lookupExercise(attempt.exerciseId) as ExerciseDef;
    profile = { id: p.id, name: p.name, voiceType: p.voiceType, range: p.range };
    settings = settingsOf(opts.backup, p.id);
    notes.push(`This WAV was matched to the backup's attempt ${attempt.id} of ${localStamp(attempt.createdAt)} by ${m.how}.`);
    prior = opts.backup.attempts.filter((a) => a.profileId === p.id && a.exerciseId === def.id && a.id !== attempt?.id && byAge(a, attempt as AttemptRecord) < 0);
  } else {
    if (!opts.exercise) throw new CoachInputError('a WAV alone does not say which exercise it is: add --exercise (an exercise id, a level id such as foundations.05, or part of a title) or give a backup or coaching file with it');
    def = resolveExercise(opts.exercise);
    profile = { id: 'wav', name: 'the singer', voiceType: 'unknown', range: null };
  }

  const wavSec = wav.samples.length / wav.sampleRate;
  const bpm = opts.bpm ?? attempt?.tempoBpm ?? inferBpm(def, wavSec);
  const track = trackFromSamples(wav.samples, wav.sampleRate, { detector: settings.detector ?? undefined });
  let tonic: number | null = opts.tonic !== undefined ? parseTonic(opts.tonic) : (attempt?.tonicMidi ?? null);
  if (tonic === null) {
    tonic = inferTonic(def, track, bpm);
    if (tonic === null) throw new CoachInputError('could not tell which key the WAV was sung in: give the tonic with --tonic (a note name like A3, or a MIDI number)');
    notes.push(`The tonic (${noteLabel(tonic, settings.notation)}) was inferred from the audio, give or take a half step: pass --tonic to fix it.`);
  }
  const level = levelForExercise(def.id) ?? null;
  const ctx: TakeCtx = {
    def,
    level,
    notation: settings.notation,
    vibratoStyle: settings.vibratoStyle,
    detector: settings.detector,
    engine: opts.engine ?? REAL_ENGINE,
    width: opts.width ?? 96,
    profile,
    now,
  };
  const log = attempt ? (opts.backup as ParsedBackup).attempts.filter((a) => a.profileId === profile.id && byAge(a, attempt as AttemptRecord) <= 0) : [];
  const first = diagnoseTake(ctx, { index: 1, attempt, saved: { tonicMidi: tonic, bpm }, track: null, audio: wav, log, latencyMs: null });
  first.source = 'audio';
  first.notes.unshift(...notes);
  const older = prior.slice(-4).reverse().map((a, i) =>
    diagnoseTake(ctx, { index: i + 2, attempt: a, saved: null, track: null, audio: null, log: log.filter((x) => byAge(x, a) <= 0), latencyMs: null }),
  );
  const takes = [first, ...older];
  return assemble({
    def,
    source: 'wav',
    name,
    title: def.title,
    exportedAt: null,
    appVersion: null,
    singer: opts.backup ? { name: profile.name, voiceType: profile.voiceType, range: profile.range, vibratoStyle: settings.vibratoStyle, notation: settings.notation } : null,
    exercise: exerciseBlock(def, { id: level?.id ?? null, title: level?.title ?? null }),
    takes,
    streak: streakOf(takes, true),
    overview: null,
    notes: [],
  });
}

export interface CoachRunOptions extends WavOptions {
  /** Show only this take in detail (1 = newest); the comparison still covers them all. Used by formatDiagnosis. */
  take?: number;
}

/**
 * Turns what was given on the command line into diagnoses. A coaching file is analyzed from its own pitch lines (a backup given
 * with it supplies the full log, a WAV given with it is matched to its newest take, or to --take); else a backup is read (with
 * each WAV matched to one of its attempts); else a WAV alone needs --exercise.
 */
export function analyzeInputs(inputs: readonly CoachInput[], opts: CoachRunOptions = {}): FileDiagnosis[] {
  const coaching = inputs.filter((i): i is Extract<CoachInput, { kind: 'coaching' }> => i.kind === 'coaching');
  const backups = inputs.filter((i): i is Extract<CoachInput, { kind: 'backup' }> => i.kind === 'backup');
  const wavs = inputs.filter((i): i is Extract<CoachInput, { kind: 'wav' }> => i.kind === 'wav');
  if (inputs.length === 0) throw new CoachInputError('no file to read');
  const out: FileDiagnosis[] = [];
  const backup = backups[0]?.backup;
  if (coaching.length > 0) {
    coaching.forEach((c, i) => {
      const wav = i === 0 ? wavs[0] : undefined;
      const diagnosis = diagnoseCoachingFile(
        c.file,
        { ...opts, log: backup?.attempts, audio: wav ? { take: opts.take ?? 1, wav: wav.wav } : undefined },
        c.name,
      );
      if (backup && backup.attempts.every((a) => a.profileId !== c.file.takes[0].attempt.profileId)) {
        diagnosis.notes.push(`The backup has no attempts for this coaching file's profile, so the streak uses the takes in the file only.`);
      }
      out.push(diagnosis);
    });
    if (wavs.length > 1) out[0].notes.push(`Only the first WAV was used (${wavs[0].name}); give each further WAV its own run.`);
    return out;
  }
  if (wavs.length > 0) {
    for (const w of wavs) out.push(diagnoseWav(w.wav, { ...opts, backup, fileName: w.name }, w.name));
    return out;
  }
  for (const b of backups) out.push(diagnoseBackup(b.backup, opts, b.name));
  return out;
}

/// ---------------------------------------------------------------- the text

const RULE = 78;
const rule = (text: string, ch = '='): string => `${ch.repeat(3)} ${text} ${ch.repeat(Math.max(3, RULE - text.length - 5))}`;
const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;
const percent = (x: number): string => `${fmtNum(x * 100)}%`;

/** `text` in lines of at most `width` columns: `first` leads the first line, and the lines after it sit under the text. */
function wrap(text: string, width: number, first: string): string[] {
  const indent = ' '.repeat(first.length);
  const lines: string[] = [];
  let cur = first;
  let empty = true;
  for (const w of text.split(/\s+/).filter(Boolean)) {
    if (!empty && cur.length + 1 + w.length > width) {
      lines.push(cur);
      cur = indent + w;
    } else {
      cur += (empty ? '' : ' ') + w;
    }
    empty = false;
  }
  if (!empty) lines.push(cur);
  return lines;
}

function rangeText(r: VocalRange | null, notation: Notation): string {
  if (!r) return 'no saved range (the voice type default was used)';
  const span = (x: { low: number; high: number }): string => `${noteLabel(x.low, notation)}-${noteLabel(x.high, notation)}`;
  return `comfortable ${span(r.comfortable)}, extended ${span(r.extended)}`;
}

const SCORE_TREND_WORDS: Record<Comparison['scoreTrend'], string> = { better: 'going up', worse: 'going down', same: 'flat', unknown: 'too few takes to say' };

const SOURCE_NAMES: Record<TakeDiagnosis['source'], string> = {
  track: 'the saved pitch line',
  audio: 'a pitch line rebuilt from audio',
  metrics: 'the saved numbers only',
};

const FIGURE_TITLES: Record<FigureKind, string> = {
  reach: 'Notes sung',
  accuracy: 'Held notes (accuracy)',
  onset: 'Attacks (onset)',
  glide: 'Glides',
  crack: 'Cracks and breaks',
  transition: 'Note changes',
  inflection: 'Ornaments',
  run: 'Runs',
  vibrato: 'Vibrato',
  switch: 'Vibrato switches',
  pulse: 'Pulses',
  dynamics: 'Loudness holds',
  range: 'Range',
};
const FIGURE_ORDER: FigureKind[] = ['reach', 'accuracy', 'onset', 'glide', 'crack', 'transition', 'inflection', 'run', 'vibrato', 'switch', 'pulse', 'dynamics', 'range'];
/** More figures of one kind than this are listed as the flagged ones only. */
const FIGURES_SHOWN = 12;

const MOVE_NAMES = { 'listen-slow': 'Listen slowly', rest: 'Rest', 'send-to-claude': 'Send to Claude' } as const;

/** What the singer read as a coaching card: the engine's (coachTake), or, without it, the content ladder at the take's depth. */
interface CardView {
  depth: CoachDepth;
  misses: number | null;
  tip: string;
  why: string | null;
  steps: readonly string[];
  easier: string | null;
  progress: readonly ProgressLine[];
  moves: readonly CoachMove[];
}

function cardOf(t: TakeDiagnosis): CardView | null {
  const c = t.engine.coaching;
  if (c) return { depth: c.depth, misses: c.missesInARow, tip: c.tip, why: c.why, steps: c.steps, easier: c.easier, progress: c.progress, moves: c.moves };
  const l = t.ladder;
  return l ? { depth: l.depth, misses: null, tip: l.tip, why: l.why, steps: l.steps, easier: l.easier, progress: [], moves: [] } : null;
}

function progressLine(p: ProgressLine): string {
  const trend = p.better === true ? ' (better)' : p.better === false ? ' (worse)' : '';
  return `  since last take: ${p.label}: ${p.before} -> ${p.now}${trend}`;
}

/** The coaching card the singer read for the take: in full for the first take shown, and as one line for the rest. */
function formatCard(L: string[], t: TakeDiagnosis, full: boolean): void {
  const card = cardOf(t);
  if (!card) return;
  const misses = card.misses === null ? '' : `, ${plural(card.misses, 'miss', 'misses')} in a row`;
  if (!full) {
    L.push(`What the app told the singer: depth ${card.depth}${misses}, tip ${t.engine.problem?.tipId ?? t.tip?.id ?? '-'} (the full card is under the first take shown).`);
    for (const p of card.progress) L.push(progressLine(p));
    return;
  }
  const what = t.engine.coaching ? 'What the app tells the singer (coachTake)' : `What the singer would read for ${t.tip?.id ?? 'this tip'} (the content ladder; the engine's own card is missing here)`;
  L.push(`${what}: depth ${card.depth}${misses}:`);
  L.push(...wrap(card.tip, 100, '  tip:    '));
  if (card.why) L.push(...wrap(card.why, 100, '  why:    '));
  card.steps.forEach((s, i) => L.push(...wrap(s, 100, `  step ${i + 1}: `)));
  if (card.easier) L.push(...wrap(card.easier, 100, '  easier: '));
  for (const p of card.progress) L.push(progressLine(p));
  if (card.moves.length > 0) {
    L.push(`  buttons: ${card.moves.map((m) => (m.kind === 'practise-level' ? `Practise ${m.title}` : MOVE_NAMES[m.kind])).join(' | ')}`);
  }
}

function formatFigures(L: string[], t: TakeDiagnosis): void {
  if (t.figures.length === 0) return;
  L.push('Figures (what each analyzer found; "!!" counts against the take):');
  for (const kind of FIGURE_ORDER) {
    const list = t.figures.filter((f) => f.kind === kind);
    if (list.length === 0) continue;
    const flagged = list.filter((f) => f.bad);
    const shown = list.length <= FIGURES_SHOWN ? list : flagged.slice(0, FIGURES_SHOWN);
    L.push(`  ${FIGURE_TITLES[kind]}:`);
    for (const f of shown) L.push(...wrap(`${f.label}: ${f.text}`, 110, `   ${f.bad ? '!!' : '  '} `));
    const hidden: string[] = [];
    if (list.length > FIGURES_SHOWN && flagged.length > shown.length) hidden.push(`${flagged.length - shown.length} more flagged`);
    if (list.length > FIGURES_SHOWN && list.length > flagged.length) hidden.push(`${list.length - flagged.length} that were fine`);
    if (hidden.length > 0) L.push(`      (${hidden.join(' and ')} not listed; the JSON has every figure)`);
  }
}

function formatTake(d: FileDiagnosis, t: TakeDiagnosis, total: number, full: boolean): string[] {
  const L: string[] = [];
  const v = t.verdict;
  const word = v.notJudged ? 'NOT JUDGED' : v.passed ? 'PASS' : 'MISS';
  const when = t.at ? localStamp(t.at) : 'time unknown';
  L.push(rule(`TAKE ${t.index}${t.index === 1 ? ' (newest)' : ''} of ${total}: ${when}: ${word} ${percent(v.score)} (pass mark ${percent(v.passMark)}): ${SOURCE_NAMES[t.source]}`, '-'));
  const sung: string[] = [];
  if (t.bpm !== null) sung.push(`${fmtNum(t.bpm)} bpm`);
  if (t.tonicMidi !== null) sung.push(`tonic ${noteLabel(t.tonicMidi, d.singer?.notation ?? 'sharps')} (midi ${t.tonicMidi})`);
  if (t.totalSec !== null) sung.push(`${fmtNum(t.totalSec)} s of material`);
  if (t.voicedSec !== null) sung.push(`${fmtNum(t.voicedSec)} s voiced`);
  if (t.attemptId) sung.push(`attempt ${t.attemptId.slice(0, 8)}`);
  if (sung.length > 0) L.push(`Sung:     ${sung.join(', ')}`);

  L.push('Verdict:');
  for (const line of v.why) L.push(...wrap(line, 100, '  - '));
  if (v.app) {
    const same = v.agrees === true ? ' (the same as this analysis)' : v.agrees === false ? ' (DIFFERS: see below)' : '';
    L.push(`  - The app recorded: ${v.app.passed ? 'pass' : 'miss'} at ${pct(v.app.score)}${same}.`);
  }
  for (const c of t.checks) L.push(...wrap(c, 100, '  - '));
  for (const n of t.notes) L.push(...wrap(n, 100, '  * '));

  L.push('Score and gates:');
  const labelWidth = Math.max(...t.gates.map((g) => (g.metric === null ? g.label : `${g.label} (gate)`).length));
  for (const g of t.gates) {
    const label = pad(g.metric === null ? g.label : `${g.label} (gate)`, labelWidth);
    const res = g.met === null ? 'NOT MEASURED' : g.met ? 'ok' : `MISS by ${g.missBy}${g.nearMiss ? ' (near miss)' : ''}`;
    L.push(`  ${label}  ${pad(g.shown, 14)} needs ${g.op} ${pad(g.targetShown, 14)} ${res}`);
  }
  L.push('Score terms (weight, value, score on the term, points of the final score it cost; costliest first):');
  for (const m of t.terms) {
    const weight = `w ${lpad(fmtNum(m.weightShare * 100), 3)}%`;
    L.push(`  ${pad(m.label, 18)} ${weight}  ${pad(m.shown, 14)} term ${lpad(fmtNum(m.termScore * 100), 3)}%  cost ${lpad(fmtNum(m.lost * 100), 3)} pts   [${m.band}]`);
  }

  L.push('Located problem (engine, coaching/coach.ts):');
  const p = t.engine.problem;
  if (p) {
    L.push(`  ${p.tipId}${p.metric ? ` on ${p.metric}` : ''}:`);
    L.push(...wrap(p.what, 100, '    '));
    // A spot's label usually leads with its time ("0:04, near E4"); add the time only when it does not.
    const where = p.spots.map((s) => (/\d+:\d\d/.test(s.label) ? s.label : `${s.label} (${clock(s.t)})`));
    if (where.length > 0) {
      L.push('  where, worst first:');
      for (const w of where) L.push(...wrap(w, 100, '    - '));
    } else if (!v.passed) {
      L.push(`  where: ${t.source === 'metrics' ? 'not placed: there is no pitch line for this take' : 'the analysis could not place it in the take'}`);
    }
  } else {
    const why = t.source === 'metrics' ? 'a take with no pitch line cannot be located' : t.engine.notBuilt ? 'the coaching engine is not built yet in this checkout' : (t.engine.problemError ?? 'no answer');
    L.push(`  not available: ${why}.`);
    // Without the engine the rule table's own pick is the only word on what the problem was.
    if (t.tip) L.push(...wrap(`the app's rule table picks ${t.tip.id}: "${t.tip.text}" (units: for the analyst only)`, 100, '  '));
  }

  formatCard(L, t, full);
  if (t.insights.length > 0) {
    L.push('What the analysis noticed:');
    for (const i of t.insights) L.push(...wrap(i, 100, '  - '));
  }
  formatFigures(L, t);
  if (t.graph) {
    L.push('Pitch graph (time across, notes down):');
    for (const line of t.graph.lines) L.push(`  ${line}`);
  }
  return L;
}

function formatComparison(d: FileDiagnosis): string[] {
  const cmp = d.comparison;
  if (!cmp) return [];
  const L: string[] = [rule('ACROSS THE TAKES (oldest to newest; take 1 is the newest)')];
  L.push('  take  when              result  score  failed gates                       coach picked');
  for (const r of cmp.rows) {
    const when = pad(r.at ? localStamp(r.at) : 'unknown', 16);
    L.push(`  ${lpad(String(r.index), 4)}  ${when}  ${pad(r.passed ? 'pass' : 'miss', 6)}  ${lpad(fmtNum(r.score * 100), 4)}%  ${pad(r.failedGates.join(', ') || '-', 33)}  ${r.tipId ?? '-'}`);
  }
  L.push(`  Score: ${cmp.rows.map((r) => percent(r.score)).join(' -> ')} (${SCORE_TREND_WORDS[cmp.scoreTrend]}; pass mark ${percent(d.exercise.passMark)}).`);
  L.push('  The measures the level judges, take by take:');
  L.push(`    ${pad('measure', 18)}${cmp.rows.map((r) => lpad(`take ${r.index}`, 12)).join('')}  trend    gate`);
  for (const m of cmp.metrics) {
    const gate = m.gate ? `${m.gate} (missed in ${m.gateMisses} of ${cmp.rows.length})` : '';
    L.push(`    ${pad(m.label, 18)}${m.shown.map((s) => lpad(s, 12)).join('')}  ${pad(m.verdict === 'unknown' ? '-' : m.verdict, 8)} ${gate}`.trimEnd());
  }
  const groups: Array<[string, string[]]> = [['Improving', cmp.improved], ['Getting worse', cmp.worsened], ['Repeating', cmp.repeats]];
  for (const [title, items] of groups) {
    if (items.length === 0) continue;
    L.push(`  ${title}:`);
    for (const s of items) L.push(...wrap(s, 100, '    - '));
  }
  if (cmp.improved.length === 0 && cmp.worsened.length === 0 && cmp.repeats.length === 0) L.push('  Nothing stands out: no metric moved, and no miss repeats.');
  if (cmp.hints.length > 0) {
    L.push('  The singer or the app? (relate repeated misses to the PROVISIONAL rows of docs/MANUAL-TEST-CHECKLIST.md):');
    for (const s of cmp.hints) L.push(...wrap(s, 100, '    - '));
  }
  return L;
}

function formatOverview(o: BackupOverview, notation: Notation): string[] {
  const L: string[] = [rule(`WHERE ${o.profile.name.toUpperCase()} IS`)];
  L.push(`  ${o.profile.name}, ${o.profile.voiceType}; ${rangeText(o.profile.range, notation)}.`);
  const day = (iso: string | null): string => (iso ? localStamp(iso).slice(0, 10) : '?');
  const others = o.otherProfiles.length > 0 ? ` Other profiles in the backup: ${o.otherProfiles.join(', ')}.` : '';
  L.push(`  ${o.attempts} attempts from ${day(o.firstAt)} to ${day(o.lastAt)}.${others}`);
  for (const w of o.worlds) L.push(`  ${pad(w.title, 14)} ${w.passed} of ${w.total} levels passed${w.current ? `; up next: ${w.current}` : ''}`);
  L.push('  Recent exercises, newest first (attempts, passes, best, last, misses in a row):');
  for (const e of o.exercises) {
    const counts = `${lpad(String(e.attempts), 3)} attempts  ${lpad(String(e.passes), 3)} passes`;
    const scores = `best ${lpad(fmtNum(e.best * 100), 3)}%  last ${lpad(fmtNum(e.last * 100), 3)}%`;
    L.push(`    ${pad(e.title, 24)} ${counts}  ${scores}  ${e.missesInARow} in a row${e.exerciseId === o.focus ? '   <- looked at below' : ''}`);
  }
  return L;
}

/** The diagnosis as text for Claude to read: ASCII only, in engineering units (cents, ms, Hz). */
export function formatDiagnosis(d: FileDiagnosis, opts: { take?: number } = {}): string {
  const L: string[] = [];
  L.push(rule(`PITCH LAB COACHING READ: ${d.title}`));
  const kind = d.source === 'coaching' ? 'coaching file' : d.source === 'backup' ? 'backup' : 'take WAV';
  L.push(`Source:   ${kind} "${d.name}"${d.exportedAt ? `, exported ${localStamp(d.exportedAt)}` : ''}${d.appVersion ? `, app ${d.appVersion}` : ''}`);
  if (d.singer) {
    const s = d.singer;
    L.push(`Singer:   ${s.name}, ${s.voiceType}; ${rangeText(s.range, s.notation)}; vibrato style ${s.vibratoStyle}; notes written with ${s.notation}`);
  }
  const ex = d.exercise;
  L.push(`Level:    ${ex.levelTitle ?? ex.title}${ex.levelId ? ` (${ex.levelId})` : ''}, ${ex.worldId}; exercise ${ex.id}, ${fmtNum(ex.tempoBpm)} bpm`);
  L.push(...wrap(ex.goal, 100, 'Asks:     '));
  if (ex.passPlain) L.push(...wrap(ex.passPlain, 100, 'To pass:  '));
  const rulePlain = `score >= ${percent(ex.passMark)}${ex.gates.length > 0 ? ` and ${ex.gates.join(', ')}` : ''}; in tune means within +/-${ex.toleranceCents} cents (${ex.tolerance} tier)`;
  L.push(...wrap(rulePlain, 100, 'Pass rule: '));
  if (ex.steps.length > 0) L.push(...wrap(ex.steps.map((s, i) => `${i + 1}. ${s}`).join(' '), 100, 'The steps the singer reads: '));
  const bySource = new Map<TakeDiagnosis['source'], number>();
  for (const t of d.takes) bySource.set(t.source, (bySource.get(t.source) ?? 0) + 1);
  L.push(`Takes:    ${d.takes.length}, newest first (${[...bySource].map(([k, n]) => `${n} from ${SOURCE_NAMES[k]}`).join(', ')})`);
  if (d.takes.some((t) => t.verdict.app)) {
    const s = d.streak;
    L.push(`Streak:   ${s.atLeast ? 'at least ' : ''}${plural(s.misses, 'miss', 'misses')} in a row on this exercise, so the app is at coaching depth ${s.depth} of 4`);
  }
  L.push(`Engine:   ${d.engine.status === 'ok' ? 'coaching/coach.ts answered for every take' : d.engine.status === 'unused' ? d.engine.message : `${d.engine.status}: ${d.engine.message}`}`);
  for (const n of d.notes) L.push(...wrap(n, 100, 'Note:     '));
  L.push('', 'In short:');
  for (const s of d.summary) L.push(...wrap(s, 100, '  - '));
  L.push('');
  if (d.overview) {
    L.push(...formatOverview(d.overview, d.singer?.notation ?? 'sharps'), '');
  }
  const picked = opts.take !== undefined ? d.takes.filter((t) => t.index === opts.take) : d.takes;
  if (picked.length === 0) L.push(`(no take ${opts.take}: the file has ${d.takes.length})`, '');
  picked.forEach((t, i) => L.push(...formatTake(d, t, d.takes.length, i === 0), ''));
  L.push(...formatComparison(d));
  return `${fold(L.join('\n').replace(/\n+$/, ''))}\n`;
}
