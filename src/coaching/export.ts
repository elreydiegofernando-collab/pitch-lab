/**
 * "Send to Claude": the coaching file of one exercise (src/coaching/types.ts CoachingFile), saved through the share
 * sheet (OneDrive, Files, Mail) so the owner can ask for a look in chat. It holds the last COACHING_FILE_TAKES takes of
 * the exercise from the active profile, newest first: each attempt, the targets it was sung against (replay.ts), its
 * saved pitch line, and its audio only when the singer ticks Include audio (audio leaves the device only on an explicit
 * export, SPEC §4).
 *
 *   const file = await buildCoachingFile(def.id, { includeAudio: false });   // when the sheet opens
 *   saveFile(coachingBlob(file), coachingFileName(file), undefined, { fromTap: true });   // straight from the Share tap
 */
import { version as PACKAGE_VERSION } from '../../package.json';
import { getExercise, getLevel, levelForExercise } from '../exercises/catalog';
import type { ExerciseDef } from '../exercises/types';
import { withRoutines } from '../progress/routines';
import { deviceSettings, settings } from '../state/settings';
import type { Settings } from '../state/settings-types';
import { getStorage, type AttemptsApi, type ProfilesApi, type TakesApi } from '../storage';
import { bytesToBase64 } from '../storage/track-codec';
import { realizeAttempt } from './replay';
import { COACHING_FILE_VERSION, type CoachingFile } from './types';

/** How many takes a coaching file carries. */
export const COACHING_FILE_TAKES = 5;

/** What the file is built from (buildCoachingFile reads the app's own; tests hand in their own). */
export interface CoachingFileSources {
  storage: {
    profiles: Pick<ProfilesApi, 'active'>;
    attempts: Pick<AttemptsApi, 'listByExercise'>;
    takes: Pick<TakesApi, 'get' | 'audio'>;
  };
  /** The singer's settings; the detector, when given, goes into the file so its audio is rebuilt with the same one. */
  settings: Pick<Settings, 'vibratoStyle' | 'notation' | 'keepTakeAudio'> & Partial<Pick<Settings, 'detector'>>;
  /** The output route, its calibrated latency (the newest take's own compensation wins) and the browser. */
  device: { route: string; latencyMs: number | null; userAgent: string };
  now?: Date;
  appVersion?: string;
}

/**
 * The app build: package.json's version, plus the name of the hashed production chunk this module was loaded from
 * (".../assets/index-3fa9c2.js" -> "0.1.0+index-3fa9c2"), so the script can tell two builds of one version apart.
 */
export function appVersion(moduleUrl: string = import.meta.url): string {
  const build = /\/assets\/([^/?#]+)\.js(?:[?#].*)?$/.exec(moduleUrl)?.[1];
  return build ? `${PACKAGE_VERSION}+${build}` : PACKAGE_VERSION;
}

const lookup = withRoutines(getExercise);

/** The level an exercise is played as (a Boss Recital by its own title), or the exercise alone (an audition test, a routine). */
function levelOf(def: ExerciseDef, levelId: string | null): CoachingFile['level'] {
  const level = (levelId !== null ? getLevel(levelId) : undefined) ?? levelForExercise(def.id);
  if (!level) return { id: null, title: def.title, worldId: def.worldId };
  return { id: level.id, title: level.kind === 'boss' ? def.title : level.title, worldId: level.worldId };
}

/** Build the file from explicit sources (see CoachingFileSources). Rejects, in plain words, for an unknown exercise. */
export async function buildCoachingFileFrom(exerciseId: string, opts: { includeAudio: boolean }, src: CoachingFileSources): Promise<CoachingFile> {
  const def = lookup(exerciseId);
  if (!def) throw new Error('This exercise is not in the catalog, so there is nothing to send.');
  const profile = await src.storage.profiles.active();
  const rows = await src.storage.attempts.listByExercise(profile.id, exerciseId);
  const recent = rows.filter((a) => a.deletedAt === null).slice(-COACHING_FILE_TAKES).reverse();

  const takes: CoachingFile['takes'] = [];
  let latencyMs = src.device.latencyMs;
  for (const attempt of recent) {
    const record = attempt.takeId ? await src.storage.takes.get(attempt.takeId) : undefined;
    if (record && takes.length === 0) latencyMs = record.latencyMs;
    const r = realizeAttempt(def, attempt, profile.range, profile.voiceType);
    let audioWavBase64: string | null = null;
    if (opts.includeAudio && record && record.audioRef !== null) {
      const blob = await src.storage.takes.audio(record);
      if (blob) audioWavBase64 = bytesToBase64(new Uint8Array(await blob.arrayBuffer()));
    }
    takes.push({
      attempt,
      realized: { tonicMidi: r.tonicMidi, bpm: r.bpm, countInSec: r.countInSec, totalSec: r.totalSec, notes: r.notes },
      track: record ? record.track : null,
      audioWavBase64,
    });
  }

  return {
    app: 'pitch-lab',
    kind: 'coaching',
    version: COACHING_FILE_VERSION,
    exportedAt: (src.now ?? new Date()).toISOString(),
    appVersion: src.appVersion ?? appVersion(),
    level: levelOf(def, recent[0]?.levelId ?? null),
    exercise: def,
    profile: { name: profile.name, voiceType: profile.voiceType, range: profile.range },
    settings: {
      vibratoStyle: src.settings.vibratoStyle,
      notation: src.settings.notation,
      keepTakeAudio: src.settings.keepTakeAudio,
      ...(src.settings.detector !== undefined ? { detector: src.settings.detector } : {}),
    },
    device: { route: src.device.route, latencyMs, userAgent: src.device.userAgent },
    takes,
  };
}

/** Build the file from the active profile's log and saved takes (newest first, up to 5). Audio only when asked. */
export async function buildCoachingFile(exerciseId: string, opts: { includeAudio: boolean }): Promise<CoachingFile> {
  const storage = await getStorage();
  const device = deviceSettings.value;
  return buildCoachingFileFrom(exerciseId, opts, {
    storage,
    settings: settings.value,
    device: {
      route: device.route,
      latencyMs: device.latency[device.route]?.roundTripMs ?? null,
      userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : '',
    },
  });
}

const pad2 = (n: number): string => String(n).padStart(2, '0');

/** "pitch-lab-coach-foundations-05-2026-10-22-1405.json": the level (or exercise) and the local time it was exported. */
export function coachingFileName(file: CoachingFile): string {
  const slug = (file.level.id ?? file.exercise.id).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const when = new Date(file.exportedAt);
  const at = Number.isFinite(when.getTime()) ? when : new Date();
  const stamp = `${at.getFullYear()}-${pad2(at.getMonth() + 1)}-${pad2(at.getDate())}-${pad2(at.getHours())}${pad2(at.getMinutes())}`;
  return `pitch-lab-coach-${slug}-${stamp}.json`;
}

/** The file as the share sheet takes it: JSON, two-space indented so it reads in a text viewer. */
export function coachingBlob(file: CoachingFile): Blob {
  return new Blob([JSON.stringify(file, null, 2)], { type: 'application/json' });
}
