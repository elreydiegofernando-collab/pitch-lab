/**
 * A hand-built Pitch Lab backup: one singer whose log passes Foundations up to its Boss Recital, in the file format
 * Export backup writes (src/storage/schema.ts BackupFile, version 1). It stands for a backup made on another device,
 * so the level and exercise ids are written out literally, exactly as such a file carries them (they are persisted ids
 * the catalog promises never to rename), instead of being read from the catalog the app is about to interpret them with.
 */

export interface PassedLevel {
  levelId: string;
  exerciseId: string;
  kind: 'practice' | 'boss';
}

/** Foundations in the order it is sung, ending on its Boss Recital. */
export const FOUNDATIONS_RUN: readonly PassedLevel[] = [
  { levelId: 'foundations.01', exerciseId: 'foundations.range-finder.1', kind: 'practice' },
  { levelId: 'foundations.02', exerciseId: 'foundations.pitch-match.1', kind: 'practice' },
  { levelId: 'foundations.03', exerciseId: 'foundations.sustain.1', kind: 'practice' },
  { levelId: 'foundations.04', exerciseId: 'foundations.sustain.2', kind: 'practice' },
  { levelId: 'foundations.05', exerciseId: 'foundations.siren.1', kind: 'practice' },
  { levelId: 'foundations.06', exerciseId: 'foundations.staccato.1', kind: 'practice' },
  { levelId: 'foundations.07', exerciseId: 'foundations.intervals.1', kind: 'practice' },
  { levelId: 'foundations.08', exerciseId: 'foundations.intervals.2', kind: 'practice' },
  { levelId: 'foundations.09', exerciseId: 'foundations.legato.1', kind: 'practice' },
  { levelId: 'foundations.boss', exerciseId: 'foundations.boss-recital', kind: 'boss' },
];

export interface CraftedBackup {
  /** The file's text, ready to hand to the import picker. */
  json: string;
  profileId: string;
  profileName: string;
  attempts: number;
}

export interface CraftOptions {
  profileId: string;
  name: string;
  voiceType?: 'tenor' | 'baritone' | 'other' | 'unknown';
  /** The levels passed, in the order they were sung. */
  passed: readonly PassedLevel[];
  /** "Now", ms (default Date.now()). Every record is stamped just before it. */
  now?: number;
}

const DEVICE = 'e2ecraft'; // the HLC's tie-break field: 8 characters of [0-9a-z]

/** The hybrid logical clock string the importer expects: 9 base-36 characters of wall time, 5 of counter, 8 of device. */
function hlc(wallMs: number, counter = 0): string {
  return `${wallMs.toString(36).padStart(9, '0')}-${counter.toString(36).padStart(5, '0')}-${DEVICE}`;
}

export function craftBackup(opts: CraftOptions): CraftedBackup {
  const now = opts.now ?? Date.now();
  const voiceType = opts.voiceType ?? 'tenor';
  const stamp = (secondsAgo: number): { createdAt: string; updatedAt: string } => ({
    createdAt: new Date(now - secondsAgo * 1000).toISOString(),
    updatedAt: hlc(now - secondsAgo * 1000),
  });

  const profile = {
    id: opts.profileId,
    profileId: opts.profileId,
    ...stamp(opts.passed.length * 60 + 120),
    deletedAt: null,
    name: opts.name,
    voiceType,
    range: {
      comfortable: { low: 48, high: 64 },
      extended: { low: 45, high: 67 },
      measuredAt: new Date(now - (opts.passed.length * 60 + 60) * 1000).toISOString(),
    },
  };

  const attempts = opts.passed.map((level, i) => ({
    id: `e2e-${opts.profileId}-${String(i + 1).padStart(2, '0')}`,
    profileId: opts.profileId,
    ...stamp((opts.passed.length - i) * 60), // a minute apart, oldest first: the order they were sung in
    deletedAt: null,
    exerciseId: level.exerciseId,
    levelId: level.levelId,
    kind: level.kind,
    score: 0.9,
    passed: true,
    mastery: 2,
    metrics: {},
    durationSec: 24,
    tonicMidi: 55,
    tempoBpm: null,
    takeId: null,
  }));

  const file = {
    format: 'pitch-lab-backup',
    version: 1,
    exportedAt: new Date(now).toISOString(),
    profiles: [profile],
    attempts,
    settings: { schemaVersion: 1, profiles: { [opts.profileId]: { schemaVersion: 1, voiceCareSeen: true } } },
  };
  return { json: JSON.stringify(file), profileId: opts.profileId, profileName: opts.name, attempts: attempts.length };
}
