/**
 * "Send to Claude" from a song: the song coaching file (src/coaching/types.ts SongCoachingFile), saved through the share
 * sheet like an exercise's (export.ts), so the owner can ask for a look in chat at how a song is going. It holds the song
 * as charted (notes, lyrics, phrases) and the last SONG_COACHING_FILE_TAKES takes of it from the active profile, newest
 * first: each attempt with the phrases it covered, its key and speed, its saved pitch line, and its audio only when the
 * singer ticks Include audio (audio leaves the device only on an explicit export, SPEC §4).
 *
 *   const file = await buildSongCoachingFile(song, { includeAudio: false });   // when the sheet opens
 *   saveFile(songCoachingBlob(file), songCoachingFileName(file), undefined, { fromTap: true });   // straight from the Share tap
 *
 * Reading a take against the song: its pitch line is on the take's own timeline (t = 0 at the start of the window it was
 * sung over, real seconds). That window starts one second before the first note of its phrases (the first note of the song
 * for a whole-song take) in the song as sung, which is the chart shifted `shift` half steps; song time = window start +
 * t x speed. Only takes that recorded their phrases are carried (older song takes cannot say what they covered).
 */
import { pitchedView } from '../song/pitched';
import { songTakes } from '../song/practice';
import type { Song } from '../song/types';
import { songExerciseId } from '../progress/attempt';
import { deviceSettings, settings } from '../state/settings';
import type { Settings } from '../state/settings-types';
import { getStorage, type AttemptsApi, type ProfilesApi, type TakesApi } from '../storage';
import { bytesToBase64 } from '../storage/track-codec';
import { appVersion } from './export';
import { COACHING_FILE_VERSION, type SongCoachingFile } from './types';

/** How many takes a song coaching file carries. */
export const SONG_COACHING_FILE_TAKES = 8;

/** What the file is built from (buildSongCoachingFile reads the app's own; tests hand in their own). */
export interface SongCoachingFileSources {
  storage: {
    profiles: Pick<ProfilesApi, 'active'>;
    attempts: Pick<AttemptsApi, 'listByExercise'>;
    takes: Pick<TakesApi, 'get' | 'audio'>;
  };
  /** The singer's settings; the detector, when given, goes into the file so its audio is rebuilt with the same one. */
  settings: Pick<Settings, 'notation'> & Partial<Pick<Settings, 'detector'>>;
  /** The output route, its calibrated latency (the newest take's own compensation wins) and the browser. */
  device: { route: string; latencyMs: number | null; userAgent: string };
  now?: Date;
  appVersion?: string;
}

/** Build the file from explicit sources (see SongCoachingFileSources). */
export async function buildSongCoachingFileFrom(song: Song, opts: { includeAudio: boolean }, src: SongCoachingFileSources): Promise<SongCoachingFile> {
  const profile = await src.storage.profiles.active();
  const rows = await src.storage.attempts.listByExercise(profile.id, songExerciseId(song.id));
  const recent = songTakes(song.id, rows, pitchedView(song).phrases.length).slice(-SONG_COACHING_FILE_TAKES).reverse();

  const takes: SongCoachingFile['takes'] = [];
  let latencyMs = src.device.latencyMs;
  for (const row of recent) {
    const { attempt } = row;
    const record = attempt.takeId ? await src.storage.takes.get(attempt.takeId) : undefined;
    if (record && takes.length === 0) latencyMs = record.latencyMs;
    let audioWavBase64: string | null = null;
    if (opts.includeAudio && record && record.audioRef !== null) {
      const blob = await src.storage.takes.audio(record);
      if (blob) audioWavBase64 = bytesToBase64(new Uint8Array(await blob.arrayBuffer()));
    }
    takes.push({ attempt, phrase: row.phrase, shift: row.shift, speed: row.speed, track: record ? record.track : null, audioWavBase64 });
  }

  return {
    app: 'pitch-lab',
    kind: 'song-coaching',
    version: COACHING_FILE_VERSION,
    exportedAt: (src.now ?? new Date()).toISOString(),
    appVersion: src.appVersion ?? appVersion(),
    song,
    profile: { name: profile.name, voiceType: profile.voiceType, range: profile.range },
    settings: { notation: src.settings.notation, ...(src.settings.detector !== undefined ? { detector: src.settings.detector } : {}) },
    device: { route: src.device.route, latencyMs, userAgent: src.device.userAgent },
    takes,
  };
}

/** Build the file from the active profile's log and saved takes (newest first, up to 8). Audio only when asked. */
export async function buildSongCoachingFile(song: Song, opts: { includeAudio: boolean }): Promise<SongCoachingFile> {
  const storage = await getStorage();
  const device = deviceSettings.value;
  return buildSongCoachingFileFrom(song, opts, {
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

function slug(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/, '');
}

/** "pitch-lab-coach-song-o-holy-night-2026-10-22-1405.json": the song's title (or id) and the local time it was exported. */
export function songCoachingFileName(file: SongCoachingFile): string {
  const name = slug(file.song.title) || slug(file.song.id) || 'song';
  const when = new Date(file.exportedAt);
  const at = Number.isFinite(when.getTime()) ? when : new Date();
  const stamp = `${at.getFullYear()}-${pad2(at.getMonth() + 1)}-${pad2(at.getDate())}-${pad2(at.getHours())}${pad2(at.getMinutes())}`;
  return `pitch-lab-coach-song-${name}-${stamp}.json`;
}

/** The file as the share sheet takes it: JSON, two-space indented so it reads in a text viewer. */
export function songCoachingBlob(file: SongCoachingFile): Blob {
  return new Blob([JSON.stringify(file, null, 2)], { type: 'application/json' });
}
