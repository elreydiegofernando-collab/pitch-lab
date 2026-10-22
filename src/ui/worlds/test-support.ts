/**
 * Test helpers for the world screens (imported by tests only): snapshots from the real catalog, doubles for the session
 * and settings signals (so screen tests need no storage, and do not depend on how those modules boot), and tiny DOM
 * helpers for happy-dom.
 */
import { signal } from '@preact/signals';
import { render } from 'preact';
import type { ComponentChild } from 'preact';
import { WORLDS } from '../../exercises';
import { computeSnapshot, isFeatureUnlocked, type FeatureId, type ProgressSnapshot } from '../../progress';
import type { WorldId } from '../../exercises/types';
import { P1, attempt, pass, passAudition, passThrough } from '../../progress/test-fixtures';
import { guardRoute } from '../../runtime/guard';
import { installRouteGuard } from '../../router';
import type { TakeOutcome, UnlockEvent } from '../../runtime/types';
import { DEFAULT_DEVICE_SETTINGS, DEFAULT_SETTINGS, type DeviceSettings, type Settings } from '../../state/settings-types';
import type { SongEntry } from '../../state/songs';
import type { AttemptRecord, ProfileRecord } from '../../storage/schema';

export { P1, attempt, pass, passAudition, passThrough };

/** A fixed "now" for every snapshot in the tests. */
export const NOW = new Date('2026-10-22T12:00:00.000Z');

/** The attempts that pass every level up to and including `levelId` (none for null: a fresh profile). */
export function attemptsThrough(levelId: string | null): AttemptRecord[] {
  return levelId ? passThrough(WORLDS, levelId) : [];
}

/** The real progression for a log: nothing passed (null), or every level up to `levelId`, plus any extra attempts. */
export function snapshotOf(levelId: string | null, extra: readonly AttemptRecord[] = []): ProgressSnapshot {
  return computeSnapshot(P1, WORLDS, [...attemptsThrough(levelId), ...extra], NOW);
}

export function profileRecord(name: string): ProfileRecord {
  return {
    id: 'profile-1',
    profileId: 'profile-1',
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    deletedAt: null,
    name,
    voiceType: 'tenor',
    range: null,
  };
}

/** A bundled song of the library, rated for `requiredWorld`. */
export function songEntry(id: string, requiredWorld: WorldId): SongEntry {
  return {
    id,
    title: id,
    artist: 'Traditional',
    source: 'bundled',
    bundled: true,
    licence: null,
    recordId: null,
    difficulty: {
      lowestMidi: 55,
      highestMidi: 67,
      rangeSemitones: 12,
      maxLeapSemitones: 4,
      notesPerSec: 2,
      melismaRate: 0,
      longNoteRatio: 0.2,
      requiredWorld,
    },
  };
}

/** What `vi.mock('../../state/session', ...)` returns: the signals the world screens read, over the real registry. */
export function sessionDouble() {
  const snapshot = signal<ProgressSnapshot>(snapshotOf(null));
  return {
    bootPhase: signal<'booting' | 'ready' | 'failed'>('ready'),
    bootError: signal<string | null>(null),
    activeProfile: signal<ProfileRecord | null>(profileRecord('Daniel')),
    attemptLog: signal<readonly AttemptRecord[]>([]),
    snapshot,
    isUnlocked: (id: FeatureId): boolean => isFeatureUnlocked(id, snapshot.value),
  };
}

/** What `vi.mock('../../state/settings', ...)` returns for Home: already loaded, first run, nothing calibrated. */
export function settingsDouble() {
  const settings = signal<Settings>({ ...DEFAULT_SETTINGS });
  const deviceSettings = signal<DeviceSettings>({ ...DEFAULT_DEVICE_SETTINGS });
  return {
    settings,
    deviceSettings,
    settingsReady: Promise.resolve(),
    updateSettings: (patch: Partial<Settings>): void => {
      settings.value = { ...settings.value, ...patch };
    },
    updateDeviceSettings: (patch: Partial<DeviceSettings>): void => {
      deviceSettings.value = { ...deviceSettings.value, ...patch };
    },
  };
}

/**
 * Install the real route guard over `getSnapshot()` (read at every navigation), as the session does after boot.
 * `hasOutcome` says whether a take outcome exists for the report route (default: none).
 */
export function installGuardOver(getSnapshot: () => ProgressSnapshot, hasOutcome: () => boolean = () => false): void {
  installRouteGuard((route) =>
    guardRoute(route, {
      snapshot: getSnapshot(),
      worlds: WORLDS,
      songRequiredWorld: () => undefined,
      songsLoaded: true,
      hasOutcome: hasOutcome(),
      workoutItems: null,
    }),
  );
}

/** A finished take, as far as the world screens read one. */
export function fakeOutcome(opts: {
  id: string;
  target?: TakeOutcome['prepared']['target'];
  passed?: boolean;
  exerciseId?: string;
  unlocked?: UnlockEvent[];
}): TakeOutcome {
  return {
    id: opts.id,
    prepared: { target: opts.target ?? { kind: 'level', levelId: 'foundations.01' } },
    attempt: { passed: opts.passed ?? true, exerciseId: opts.exerciseId ?? 'foundations.sustain.1' },
    unlocked: opts.unlocked ?? [],
  } as unknown as TakeOutcome;
}

// ---------------------------------------------------------------- DOM

export interface Mounted {
  container: HTMLElement;
  unmount(): void;
}

/** Render into a fresh container attached to the document. */
export function mount(vnode: ComponentChild): Mounted {
  const container = document.createElement('div');
  document.body.appendChild(container);
  render(vnode, container);
  return {
    container,
    unmount() {
      render(null, container);
      container.remove();
    },
  };
}

/** Let queued renders (a microtask) and zero-delay timers run. */
export async function flush(): Promise<void> {
  for (let i = 0; i < 3; i++) await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

/** Preact runs effects after paint (rAF plus a timer), so poll for what an effect causes. */
export async function waitUntil(predicate: () => boolean, timeoutMs = 1500): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting for condition');
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}

export function byTestId<T extends Element = HTMLElement>(root: ParentNode, id: string): T | null {
  return root.querySelector<T>(`[data-testid="${id}"]`);
}

export function textOf(el: Element | null): string {
  return (el?.textContent ?? '').replace(/\s+/g, ' ').trim();
}
