/**
 * Sync-ready local data model (Phase 3; ROADMAP v2 prep). Rules:
 *  - every record: client-generated UUID, profileId, HLC `updatedAt`, soft delete `deletedAt`;
 *  - attempts are APPEND-ONLY (one row per attempt); progress is derived from them;
 *  - large binaries (take audio, backing tracks) live in OPFS, referenced by path;
 *  - SYNCABLE lists the only fields a future v2 sync may send (nothing audio-derived).
 * Audio never leaves the device unless the singer exports it (Export WAV, or Send to Claude with Include audio on); it
 * may be stored locally for playback (owner can delete).
 */
import type { Metrics } from '../analysis/types';
import type { Mastery } from '../progress/types';
import type { Song } from '../song/types';

export interface RecordBase {
  id: string; //              crypto.randomUUID()
  profileId: string;
  createdAt: string; //       ISO
  /** Hybrid logical clock: `${wallMs base36 padded}-${counter base36 padded}-${deviceId}`; lexicographically ordered. */
  updatedAt: string;
  deletedAt: string | null;
}

export interface VocalRange {
  comfortable: { low: number; high: number }; // MIDI
  extended: { low: number; high: number };
  measuredAt: string;
}

export interface ProfileRecord extends Omit<RecordBase, 'profileId'> {
  profileId: string; //       === id (a profile scopes itself)
  name: string;
  voiceType: 'tenor' | 'baritone' | 'other' | 'unknown';
  range: VocalRange | null;
}

export interface AttemptRecord extends RecordBase {
  exerciseId: string;
  levelId: string | null;
  kind: 'practice' | 'audition' | 'boss' | 'record' | 'song' | 'workout';
  score: number; //           0..1
  passed: boolean;
  mastery: Mastery;
  metrics: Metrics;
  durationSec: number;
  tonicMidi: number | null;
  /** The tempo actually sung (a Runs ladder rung), not the exercise's pass tempo. */
  tempoBpm: number | null;
  /**
   * The saved take (local audio and pitch track), if kept. A backup carries it as null; the take leaves the device only
   * in an explicit export (Export WAV; Send to Claude's coaching file: its pitch line, and its audio with Include audio on).
   */
  takeId: string | null;
  songId?: string | null;
  /**
   * The voice check-up session this take belonged to (src/checkup): every task of one check-up shares the id, so a
   * check-up is read back from the log alone. Null or absent for any other take.
   */
  checkupId?: string | null;
  /**
   * A song take's phrases: [from, to) indices into the song's phrases as sung (pitchedView), e.g. { from: 2, to: 3 } for
   * phrase 3 alone. Null or absent for a whole-song take and for every non-song take.
   */
  phrase?: { from: number; to: number } | null;
  /** A song take's transposition in half steps from the chart's own key (0 = as written). Null or absent otherwise. */
  songShift?: number | null;
  /** A song take's playback speed (0.5, 0.75 or 1). Null or absent otherwise. */
  songSpeed?: number | null;
}

export interface TakeRecord extends RecordBase {
  exerciseId: string;
  /** Compact raw pitch track (take-relative, latency-compensated), Float32 arrays base64-encoded. */
  track: { frameRate: number; t0: number; midi: string; rmsDb: string; confidence: string; voiced: string };
  /** OPFS path of the take audio (WAV) or null if not kept. */
  audioRef: string | null;
  sampleRate: number | null;
  latencyMs: number;
}

export interface SongRecord extends RecordBase {
  song: Song;
}

/** Fields a v2 sync may transmit, per store. Anything not listed never leaves the device. */
export const SYNCABLE: Readonly<Record<string, readonly string[]>> = {
  profiles: ['id', 'profileId', 'createdAt', 'updatedAt', 'deletedAt', 'name', 'voiceType', 'range'],
  attempts: ['id', 'profileId', 'createdAt', 'updatedAt', 'deletedAt', 'exerciseId', 'levelId', 'kind', 'score', 'passed', 'mastery', 'metrics', 'durationSec', 'tonicMidi', 'tempoBpm', 'songId', 'checkupId', 'phrase', 'songShift', 'songSpeed'],
  // takes, songs (may contain user-imported content) and binaries are local-only in v2.
};

/** JSON backup format (export/import). */
export interface BackupFile {
  format: 'pitch-lab-backup';
  version: 1;
  exportedAt: string;
  profiles: ProfileRecord[];
  attempts: AttemptRecord[];
  /** { schemaVersion: 1, profiles: { [profileId]: Settings } } (storage/backup.ts BackupSettings); device settings (latency, route) are not included. */
  settings: unknown;
}
