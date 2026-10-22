/**
 * The session: storage, the active profile, its attempt log and its progress snapshot, as signals.
 *
 * WAVE 2 CONTRACT STUB. The exported names and signatures below are the contract every Wave 2 builder codes
 * against (docs/ARCHITECTURE.md "Wave 2"); the runtime builder replaces the bodies and keeps the signatures.
 * Needed signature changes are reported to the orchestrator, never made silently.
 *
 * Rules the implementation keeps (ARCHITECTURE "Wave 2 must-dos"):
 * - `getStorage()` once per page; `bootSession()` is idempotent.
 * - Recompute the snapshot from the stored log after EVERY new attempt (never patch a cached one), with
 *   `{ getExercise: withRoutines(getExercise), utcOffsetMinutes }` (local calendar days).
 * - Settings move to the active profile's key in the same change (src/state/settings.ts), sanitized on read.
 * - `storage.reconcile()` once per launch, after the first screen, fire and forget.
 * - The route guard is installed once the snapshot is known; the router is revalidated after a profile switch,
 *   a backup import or Delete all data.
 */
import { signal } from '@preact/signals';
import type { AppStorage } from '../storage';
import type { ReconcileReport } from '../storage/maintenance';
import type { AttemptRecord, ProfileRecord, VocalRange } from '../storage/schema';
import type { AttemptFields } from '../progress/attempt';
import type { FeatureId, ProgressSnapshot } from '../progress/types';
import { computeSnapshot, isFeatureUnlocked } from '../progress';
import { WORLDS } from '../exercises';
import type { VoiceType } from '../exercises/transpose';

export type BootPhase = 'booting' | 'ready' | 'failed';

export const bootPhase = signal<BootPhase>('booting');
/** Plain-language reason when booting failed (shown on Home with a Reload button). */
export const bootError = signal<string | null>(null);
export const appStorage = signal<AppStorage | null>(null);
/** AppStorage.persistent: false means nothing will survive a reload (a non-dismissable warning). */
export const storageDurable = signal<boolean>(true);
/** Live profiles, creation order. */
export const profiles = signal<readonly ProfileRecord[]>([]);
export const activeProfile = signal<ProfileRecord | null>(null);
/** The active profile's attempt log, oldest first. */
export const attemptLog = signal<readonly AttemptRecord[]>([]);
/** The active profile's progress. Before boot: the empty-log snapshot (nothing past the start is open). */
export const snapshot = signal<ProgressSnapshot>(computeSnapshot('', WORLDS, [], Date.now()));
/** This launch's storage.reconcile() report (Diagnostics), null until it ran. */
export const reconcileReport = signal<ReconcileReport | null>(null);

/** Open storage, load the active profile, its settings, log and snapshot, install the route guard. Idempotent; never rejects. */
export function bootSession(): Promise<void> {
  bootPhase.value = 'ready';
  return Promise.resolve();
}

/** Resolves once boot finished (ready or failed). */
export function whenSessionReady(): Promise<void> {
  return bootSession();
}

/** Is a registry feature unlocked for the active profile? (Reads `snapshot`, so components re-render on change.) */
export function isUnlocked(id: FeatureId): boolean {
  return isFeatureUnlocked(id, snapshot.value);
}

/**
 * Append one attempt (built with buildAttempt/buildSongAttempt) for the ACTIVE profile, then reload the log and
 * recompute the snapshot. Resolves once the row is durable.
 */
export function recordAttempt(fields: AttemptFields): Promise<{ attempt: AttemptRecord; before: ProgressSnapshot; after: ProgressSnapshot }> {
  void fields;
  return Promise.reject(new Error('recordAttempt: not built yet (Wave 2 runtime)'));
}

/** Save the active profile's range. Only from a PASSED Range finder take (ARCHITECTURE must-dos). */
export function saveProfileRange(range: VocalRange): Promise<void> {
  void range;
  return Promise.reject(new Error('saveProfileRange: not built yet (Wave 2 runtime)'));
}

/** Make another profile active: settings, log, snapshot and songs reload; the router resets to Home. */
export function switchProfile(id: string): Promise<void> {
  void id;
  return Promise.reject(new Error('switchProfile: not built yet (Wave 2 runtime)'));
}

export function createProfile(input: { name: string; voiceType?: VoiceType }): Promise<ProfileRecord> {
  void input;
  return Promise.reject(new Error('createProfile: not built yet (Wave 2 runtime)'));
}

export function renameProfile(id: string, name: string): Promise<void> {
  void id;
  void name;
  return Promise.reject(new Error('renameProfile: not built yet (Wave 2 runtime)'));
}

export function setProfileVoiceType(id: string, voiceType: VoiceType): Promise<void> {
  void id;
  void voiceType;
  return Promise.reject(new Error('setProfileVoiceType: not built yet (Wave 2 runtime)'));
}

/** Rejects (keeping the profile) when a recording will not delete: show the error, never a false "Deleted". */
export function deleteProfile(id: string, opts: { removeRecordings: boolean }): Promise<void> {
  void id;
  void opts;
  return Promise.reject(new Error('deleteProfile: not built yet (Wave 2 runtime)'));
}

/** Reload everything from storage (after a backup import or Delete all data) and revalidate the router. */
export function reloadSession(): Promise<void> {
  return Promise.resolve();
}
