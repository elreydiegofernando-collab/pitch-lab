/**
 * The session: storage, the active profile, its attempt log and its progress snapshot, as signals. It is the single
 * source of the active profile's state (docs/ARCHITECTURE.md "Wave 2"): screens read these signals and never open
 * storage themselves (the Data screen and the song builder go through `appStorage.value`), attempts are written only
 * through `recordAttempt`, and features are gated with `isUnlocked(id)`.
 *
 * Boot (`bootSession`, called by app.tsx): getStorage() once; the active profile and its settings, log and snapshot;
 * the song index (waited for, up to a cap, so a waiting #/song/<id> deep link is judged against it); then the route
 * guard (src/runtime/guard.ts, fed from the CURRENT signals at every navigation) and, once booted, one
 * storage.reconcile() into `reconcileReport`, fire and forget. A failed boot sets `bootPhase` 'failed' with a
 * plain-language `bootError` (Home shows it with a Reload button) and never throws.
 *
 * The snapshot is recomputed from the stored log after EVERY new attempt, never patched, with
 * `{ getExercise: withRoutines(getExercise), utcOffsetMinutes }` (local calendar days). Operations that change the
 * session run one at a time, so a take can never be written into a log that is being swapped for another profile's.
 */
import { batch, signal, untracked } from '@preact/signals';
import { WORLDS, getExercise } from '../exercises';
import type { VoiceType } from '../exercises/transpose';
import { computeSnapshot, isFeatureUnlocked, withRoutines } from '../progress';
import type { AttemptFields } from '../progress/attempt';
import type { FeatureId, ProgressSnapshot } from '../progress/types';
import { installRouteGuard, resetTo, revalidate, type Route } from '../router';
import { auditionRun } from '../runtime/audition-run';
import { guardRoute } from '../runtime/guard';
import { lastOutcome } from '../runtime/runner';
import type { GuardContext } from '../runtime/types';
import { abandonWorkout, activeWorkout } from '../runtime/workout';
import { getStorage, type AppStorage } from '../storage';
import type { ReconcileReport } from '../storage/maintenance';
import type { AttemptRecord, ProfileRecord, VocalRange } from '../storage/schema';
import { discardPendingSettings, flushSettings, loadSettings, settingsUnavailable } from './settings';
import { loadSongs, songIndex, songsLoaded } from './songs';

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

/** The progression of `profileId` at `now`, on local calendar days. */
function snapshotFor(profileId: string, log: readonly AttemptRecord[], now: number): ProgressSnapshot {
  return computeSnapshot(profileId, WORLDS, log, now, {
    getExercise: withRoutines(getExercise),
    utcOffsetMinutes: -new Date(now).getTimezoneOffset(),
  });
}

/** What the route guard judges with, read from the signals at the moment of the navigation. */
function guardContext(): GuardContext {
  const index = songIndex.value;
  const workout = activeWorkout.value;
  return {
    snapshot: snapshot.value,
    worlds: WORLDS,
    songRequiredWorld: (songId) => index.get(songId)?.difficulty.requiredWorld,
    songsLoaded: songsLoaded.value,
    hasOutcome: lastOutcome.value !== null,
    workoutItems: workout && workout.finishedAt === null ? workout.workout.items.length : null,
  };
}

/** Untracked: a navigation made during a render must not subscribe that component to the session. */
const routeGuard = (route: Route) => untracked(() => guardRoute(route, guardContext()));

// ---------------------------------------------------------------- boot

let booting: Promise<void> | null = null;

/** How long boot waits for the song index before it opens a waiting deep link anyway (a song link then lands on the library). */
const SONG_INDEX_WAIT_MS = 2000;

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** The song index (loadSongs never rejects), or the cap, whichever comes first. */
function songIndexOrCap(): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cap = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, SONG_INDEX_WAIT_MS);
  });
  return Promise.race([loadSongs(), cap]).finally(() => clearTimeout(timer));
}

/** Load the active profile (creating the default when none is live), its settings, log and snapshot. */
async function loadActive(storage: AppStorage): Promise<void> {
  const active = await storage.profiles.active();
  const [list, log] = await Promise.all([storage.profiles.list(), storage.attempts.listByProfile(active.id)]);
  await loadSettings({ kv: storage.kv, profileId: active.id, profileDurable: storage.db.persistent, persistent: storage.persistent });
  const next = snapshotFor(active.id, log, Date.now());
  batch(() => {
    profiles.value = list;
    activeProfile.value = active;
    attemptLog.value = log;
    snapshot.value = next;
  });
}

async function boot(): Promise<void> {
  bootPhase.value = 'booting';
  bootError.value = null;
  try {
    const storage = await getStorage();
    batch(() => {
      appStorage.value = storage;
      storageDurable.value = storage.persistent;
    });
    await loadActive(storage);
    // The guard judges a waiting #/song/<id> deep link against the song index, so the index loads first.
    await songIndexOrCap();
    bootPhase.value = 'ready';
    installRouteGuard(routeGuard);
    // Repairs after a crash or an eviction, off the critical path; it does nothing on a degraded launch.
    setTimeout(() => {
      storage.reconcile().then(
        (report) => {
          reconcileReport.value = report;
        },
        () => undefined,
      );
    }, 0);
  } catch (err) {
    batch(() => {
      storageDurable.value = false;
      bootError.value = `Pitch Lab could not open the data saved on this device. Close any other Pitch Lab tabs or windows, then tap Reload. (${describeError(err)})`;
      bootPhase.value = 'failed';
    });
    settingsUnavailable();
  }
}

/** Open storage, load the active profile, its settings, log and snapshot, install the route guard. Idempotent; never rejects. A failed boot is retried by the next call. */
export function bootSession(): Promise<void> {
  if (!booting || bootPhase.value === 'failed') booting = boot();
  return booting;
}

/** Resolves once boot finished (ready or failed); starts it when nothing has. */
export function whenSessionReady(): Promise<void> {
  return booting ?? bootSession();
}

/** Is a registry feature unlocked for the active profile? (Reads `snapshot`, so components re-render on change.) */
export function isUnlocked(id: FeatureId): boolean {
  return isFeatureUnlocked(id, snapshot.value);
}

// ---------------------------------------------------------------- operations (one at a time)

let queue: Promise<unknown> = Promise.resolve();

/** Run `op` after every operation queued before it, so the session never changes under a half-done write. */
function serial<T>(op: () => Promise<T>): Promise<T> {
  const run = queue.then(op, op);
  queue = run.catch(() => undefined);
  return run;
}

/** The open storage and the active profile, once boot succeeded. */
async function ready(): Promise<{ storage: AppStorage; profile: ProfileRecord }> {
  await bootSession();
  const storage = appStorage.value;
  const profile = activeProfile.value;
  if (bootPhase.value !== 'ready' || !storage || !profile) throw new Error(bootError.value ?? 'Your saved data is not available.');
  return { storage, profile };
}

/** A take's outcome, a running workout and an audition run belong to the profile (and the log) they were made with. */
function clearTakeState(): void {
  lastOutcome.value = null;
  auditionRun.value = null;
  abandonWorkout();
}

function withProfile(list: readonly ProfileRecord[], updated: ProfileRecord): ProfileRecord[] {
  return list.map((p) => (p.id === updated.id ? updated : p));
}

/** Put an updated profile record into the signals. */
function applyProfile(updated: ProfileRecord): void {
  batch(() => {
    profiles.value = withProfile(profiles.value, updated);
    if (activeProfile.value?.id === updated.id) activeProfile.value = updated;
  });
}

/**
 * Append one attempt (built with buildAttempt/buildSongAttempt) for the ACTIVE profile, then reload the log and
 * recompute the snapshot. Resolves once the row is durable, with the progress before and after it (both at the same
 * moment, so they differ only by this attempt). Rejects, writing nothing, for another profile's attempt.
 */
export function recordAttempt(fields: AttemptFields): Promise<{ attempt: AttemptRecord; before: ProgressSnapshot; after: ProgressSnapshot }> {
  return serial(async () => {
    const { storage, profile } = await ready();
    if (fields.profileId !== profile.id) throw new Error('This take belongs to a profile that is no longer active, so it was not saved.');
    const now = Date.now();
    const before = snapshotFor(profile.id, attemptLog.value, now);
    const attempt = await storage.attempts.add(fields);
    let log: readonly AttemptRecord[];
    try {
      log = await storage.attempts.listByProfile(profile.id);
    } catch {
      log = [...attemptLog.value, attempt]; // the row is durable; progress must still see it
    }
    const after = snapshotFor(profile.id, log, now);
    batch(() => {
      attemptLog.value = log;
      snapshot.value = after;
    });
    return { attempt, before, after };
  });
}

/** Save the active profile's range. Only from a PASSED Range finder take (ARCHITECTURE must-dos). */
export function saveProfileRange(range: VocalRange): Promise<void> {
  return serial(async () => {
    const { storage, profile } = await ready();
    applyProfile(await storage.profiles.setRange(profile.id, range));
  });
}

/** Make another profile active: settings, log, snapshot and songs reload; the router resets to Home. */
export function switchProfile(id: string): Promise<void> {
  return serial(async () => {
    const { storage, profile } = await ready();
    if (id === profile.id) return;
    if (!(await storage.profiles.get(id))) throw new Error('That profile no longer exists.');
    await flushSettings(); // the outgoing profile's last changes go under its own key
    await storage.profiles.setActive(id);
    clearTakeState();
    await loadActive(storage);
    void loadSongs();
    resetTo('home');
  });
}

/** A profile name, refused in plain words when it is blank (storage trims and shortens the rest). */
function requireName(name: string): string {
  if (name.trim() === '') throw new Error('Give the profile a name.');
  return name;
}

export function createProfile(input: { name: string; voiceType?: VoiceType }): Promise<ProfileRecord> {
  return serial(async () => {
    const { storage } = await ready();
    const created = await storage.profiles.create({ name: requireName(input.name), voiceType: input.voiceType });
    profiles.value = await storage.profiles.list();
    return created;
  });
}

export function renameProfile(id: string, name: string): Promise<void> {
  return serial(async () => {
    const { storage } = await ready();
    applyProfile(await storage.profiles.rename(id, requireName(name)));
  });
}

export function setProfileVoiceType(id: string, voiceType: VoiceType): Promise<void> {
  return serial(async () => {
    const { storage } = await ready();
    applyProfile(await storage.profiles.setVoiceType(id, voiceType));
  });
}

/** Rejects (keeping the profile) when a recording will not delete: show the error, never a false "Deleted". */
export function deleteProfile(id: string, opts: { removeRecordings: boolean }): Promise<void> {
  return serial(async () => {
    const { storage, profile } = await ready();
    const wasActive = id === profile.id;
    if (wasActive) await flushSettings(); // kept under its key, so a restored profile gets them back
    await storage.profiles.delete(id, { removeRecordings: opts.removeRecordings });
    if (!wasActive) {
      profiles.value = await storage.profiles.list();
      return;
    }
    // Storage made another live profile active (or a fresh default when this was the last one).
    clearTakeState();
    await loadActive(storage);
    void loadSongs();
    resetTo('home');
  });
}

/**
 * Reload everything from storage (after a backup import or Delete all data) and revalidate the router. Settings changed
 * in the last moments are written first, each under its own profile (an import never overwrites a profile's existing
 * settings, so they are still right); after Delete all data pass `pendingSettings: 'discard'`: their profile is gone,
 * and writing them would leave its settings behind the wipe.
 */
export function reloadSession(opts: { pendingSettings?: 'flush' | 'discard' } = {}): Promise<void> {
  return serial(async () => {
    const { storage } = await ready();
    if (opts.pendingSettings === 'discard') discardPendingSettings();
    else await flushSettings();
    clearTakeState();
    await loadActive(storage);
    void loadSongs();
    revalidate();
  });
}
