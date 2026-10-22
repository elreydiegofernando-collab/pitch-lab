import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { CONFIG } from '../config';
import { DEFAULT_SETTINGS, type Settings } from '../state/settings-types';
import { addAttempt, getAttempt, listAttemptsByProfile } from './attempts-repo';
import {
  BACKUP_FORMAT,
  BACKUP_VERSION,
  backupFileName,
  exportBackup,
  exportBackupJson,
  importBackup,
  sanitizeSettings,
  type ImportReport,
} from './backup';
import { META_KEYS, openDb, type PitchLabDb } from './db';
import { formatHlc } from './hlc';
import { profileSettingsKey } from './keys';
import {
  createProfile,
  deleteProfile,
  getActiveProfileId,
  getProfile,
  listProfiles,
  renameProfile,
  restoreProfile,
  setActiveProfileId,
  setVocalRange,
} from './profiles-repo';
import { SYNCABLE, type AttemptRecord, type BackupFile, type ProfileRecord } from './schema';
import { MemoryKV, attemptInput, dbWithFailingStore, freshName, overrideMethod } from './test-helpers';

const T0 = 1_800_000_000_000;

/** A device: its own database, and a wall clock that ticks one millisecond per reading. */
function device(startMs = T0, label = 'dev'): Promise<PitchLabDb> {
  let t = startMs;
  return openDb(freshName(label), { now: () => ++t });
}

/** A backup envelope. Rows are typed loosely on purpose: tests feed it hand-built, sometimes malformed, rows. */
function envelope(overrides: Partial<Record<keyof BackupFile, unknown>> = {}): BackupFile {
  return { format: BACKUP_FORMAT, version: BACKUP_VERSION, exportedAt: '2026-10-21T00:00:00.000Z', profiles: [], attempts: [], settings: null, ...overrides } as BackupFile;
}

/** A well-formed attempt row as another device would have exported it. */
function remoteAttempt(profileId: string, stamp: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: `remote-${Math.random().toString(36).slice(2, 10)}`,
    profileId,
    createdAt: '2026-10-20T12:00:00.000Z',
    updatedAt: stamp,
    deletedAt: null,
    exerciseId: 'foundations.sustain.1',
    levelId: null,
    kind: 'practice',
    score: 0.8,
    passed: true,
    mastery: 1,
    metrics: { 'accuracy.inTolerancePct': 80 },
    durationSec: 4,
    tonicMidi: 60,
    tempoBpm: null,
    takeId: null,
    ...overrides,
  };
}

function cleanReport(report: ImportReport): void {
  expect(report.errors).toEqual([]);
  expect(report.ok).toBe(true);
  expect(report.profilesRejected).toBe(0);
  expect(report.attemptsRejected).toBe(0);
}

describe('exportBackup', () => {
  it('describes itself, and includes every profile and the attempts of the live ones', async () => {
    const db = await device();
    const p1 = await createProfile(db, { name: 'Tenor', voiceType: 'tenor' });
    const p2 = await createProfile(db, { name: 'Beginner' });
    const a1 = await addAttempt(db, attemptInput(p1.id));
    const a2 = await addAttempt(db, attemptInput(p2.id));

    const file = await exportBackup(db);
    expect(file.format).toBe('pitch-lab-backup');
    expect(file.version).toBe(1);
    expect(file.exportedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(file.profiles.map((p) => p.id)).toEqual([p1.id, p2.id]);
    expect(file.attempts.map((a) => a.id).sort()).toEqual([a1.id, a2.id].sort());
    expect(file.profiles[0]).toEqual(p1);
  });

  it('exports a soft-deleted profile as a tombstone, but not its attempts', async () => {
    const db = await device();
    const live = await createProfile(db, { name: 'Live' });
    const dead = await createProfile(db, { name: 'Dead' });
    await addAttempt(db, attemptInput(live.id));
    await addAttempt(db, attemptInput(dead.id));
    await deleteProfile(db, dead.id);

    const file = await exportBackup(db);
    expect(file.profiles.map((p) => [p.id, p.deletedAt !== null])).toEqual([
      [live.id, false],
      [dead.id, true],
    ]);
    expect(file.attempts.every((a) => a.profileId === live.id)).toBe(true);
  });

  it('can be scoped to chosen profiles (deduped; unknown ids skipped), deleted ones included when asked for by id', async () => {
    const db = await device();
    const p1 = await createProfile(db, { name: 'A' });
    const p2 = await createProfile(db, { name: 'B' });
    const p3 = await createProfile(db, { name: 'C' });
    await addAttempt(db, attemptInput(p1.id));
    await addAttempt(db, attemptInput(p2.id));
    await addAttempt(db, attemptInput(p3.id));
    await deleteProfile(db, p3.id);

    const one = await exportBackup(db, [p1.id, p1.id, 'no-such-profile']);
    expect(one.profiles.map((p) => p.id)).toEqual([p1.id]);
    expect(one.attempts.every((a) => a.profileId === p1.id)).toBe(true);
    expect(one.attempts).toHaveLength(1);

    const explicit = await exportBackup(db, [p3.id]);
    expect(explicit.profiles[0].deletedAt).not.toBeNull();
    expect(explicit.attempts).toHaveLength(1); // asked for by id: its history comes too
  });

  it('never exports anything audio-derived: takeId is null and only SYNCABLE fields survive', async () => {
    const db = await device();
    const p = await createProfile(db, { name: 'T' });
    const a = await addAttempt(db, attemptInput(p.id, { takeId: 'take-123', songId: 'song-9' }));
    // A row with fields the allowlist does not know about (e.g. written by a future build).
    await db.store('attempts').put({ ...a, id: 'sneaky', audio: 'raw samples', audioRef: 'takes/x.wav', pitchTrack: 'AAAA' }, 'sneaky');

    const file = await exportBackup(db);
    expect(file.attempts.length).toBe(2);
    for (const attempt of file.attempts) {
      expect(attempt.takeId).toBeNull();
      expect(Object.keys(attempt).every((k) => k === 'takeId' || SYNCABLE.attempts.includes(k))).toBe(true);
    }
    for (const profile of file.profiles) expect(Object.keys(profile).every((k) => SYNCABLE.profiles.includes(k))).toBe(true);
    const text = JSON.stringify(file);
    for (const forbidden of ['audioRef', 'backingRef', '"track"', 'raw samples', 'take-123', 'pitchTrack']) expect(text).not.toContain(forbidden);
    expect(file.attempts.find((x) => x.id === a.id)?.songId).toBe('song-9'); // songId IS syncable
  });

  it('includes the settings of the live profiles when given the KV store (and only those)', async () => {
    const db = await device();
    const kv = new MemoryKV();
    const live = await createProfile(db, { name: 'Live' });
    const dead = await createProfile(db, { name: 'Dead' });
    const plain = await createProfile(db, { name: 'NoSettings' });
    await deleteProfile(db, dead.id);
    await kv.set(profileSettingsKey(live.id), { theme: 'dark' });
    await kv.set(profileSettingsKey(dead.id), { theme: 'light' });
    await kv.set('device:settings', { route: 'wired' }); // belongs to the device: never exported

    const file = await exportBackup(db, undefined, kv);
    expect(file.settings).toEqual({ schemaVersion: 1, profiles: { [live.id]: { theme: 'dark' } } });
    expect((file.settings as { profiles: Record<string, unknown> }).profiles[plain.id]).toBeUndefined();
    expect(JSON.stringify(file)).not.toContain('wired');

    expect((await exportBackup(db)).settings).toEqual({ schemaVersion: 1, profiles: {} });
  });

  it('is plain JSON: it survives stringify/parse unchanged', async () => {
    const db = await device();
    const p = await createProfile(db, { name: 'T', range: { comfortable: { low: 48, high: 60 }, extended: { low: 43, high: 65 }, measuredAt: '2026-01-01T00:00:00.000Z' } });
    await addAttempt(db, attemptInput(p.id, { metrics: { 'vibrato.rateHz': 5.5 }, songId: null }));
    const file = await exportBackup(db);
    expect(JSON.parse(JSON.stringify(file))).toEqual(file);
    expect(JSON.parse(await exportBackupJson(db))).toMatchObject({ format: BACKUP_FORMAT, profiles: [{ id: p.id }] });
  });

  it('backupFileName is a dated .json name', () => {
    expect(backupFileName(new Date('2026-10-21T23:59:59Z'))).toBe('pitch-lab-backup-2026-10-21.json');
    expect(backupFileName()).toMatch(/^pitch-lab-backup-\d{4}-\d{2}-\d{2}\.json$/);
  });
});

describe('round trip', () => {
  it('export from one device and import into a fresh one recreates the same profiles and attempts', async () => {
    const source = await device();
    const p = await createProfile(source, {
      name: 'Tenor',
      voiceType: 'tenor',
      range: { comfortable: { low: 48, high: 60 }, extended: { low: 43, high: 65 }, measuredAt: '2026-01-01T00:00:00.000Z' },
    });
    const attempts: AttemptRecord[] = [];
    for (let i = 0; i < 5; i++) attempts.push(await addAttempt(source, attemptInput(p.id, { score: i / 10, metrics: { 'accuracy.inTolerancePct': i * 10 } })));
    const file = await exportBackup(source);

    const dest = await device(T0 + 1_000_000, 'dest');
    const report = await importBackup(dest, file);
    cleanReport(report);
    expect(report).toMatchObject({ profilesAdded: 1, attemptsAdded: 5, profilesUpdated: 0, profilesSkipped: 0, attemptsSkipped: 0 });

    await expect(getProfile(dest, p.id)).resolves.toEqual(p);
    for (const a of attempts) await expect(getAttempt(dest, a.id)).resolves.toEqual(a);
    expect((await listAttemptsByProfile(dest, p.id)).map((a) => a.id)).toEqual(attempts.map((a) => a.id)); // same replay order
  });

  it('works from JSON text, which is how a file arrives', async () => {
    const source = await device();
    const p = await createProfile(source, { name: 'T' });
    const a = await addAttempt(source, attemptInput(p.id));
    const text = await exportBackupJson(source);

    const dest = await device(T0, 'dest');
    cleanReport(await importBackup(dest, text));
    await expect(getAttempt(dest, a.id)).resolves.toEqual(a);
  });

  it('importing the same file twice is a harmless no-op the second time', async () => {
    const source = await device();
    const p = await createProfile(source, { name: 'Tenor' });
    await addAttempt(source, attemptInput(p.id));
    await addAttempt(source, attemptInput(p.id));
    const file = await exportBackup(source);

    const dest = await device(T0, 'dest');
    await importBackup(dest, file);
    const second = await importBackup(dest, file);
    cleanReport(second);
    expect(second).toMatchObject({ profilesAdded: 0, profilesUpdated: 0, profilesSkipped: 1, attemptsAdded: 0, attemptsSkipped: 2 });
    expect(await listProfiles(dest, { includeDeleted: true })).toHaveLength(1);
    expect(await listAttemptsByProfile(dest, p.id)).toHaveLength(2);
  });

  it('importing a device\'s own export back into itself changes nothing', async () => {
    const db = await device();
    const p = await createProfile(db, { name: 'T' });
    const a = await addAttempt(db, attemptInput(p.id));
    const report = await importBackup(db, await exportBackup(db));
    cleanReport(report);
    expect(report).toMatchObject({ profilesAdded: 0, profilesUpdated: 0, attemptsAdded: 0 });
    await expect(getProfile(db, p.id)).resolves.toEqual(p);
    await expect(getAttempt(db, a.id)).resolves.toEqual(a);
  });

  it('a tombstone round-trips: the deleted profile stays deleted on the other device, and is not reported as an added profile', async () => {
    const source = await device();
    const p = await createProfile(source, { name: 'Gone' });
    await deleteProfile(source, p.id);
    const dest = await device(T0, 'dest');
    const report = await importBackup(dest, await exportBackup(source));
    cleanReport(report);
    expect(report).toMatchObject({ profilesAdded: 0, profilesSkipped: 1, profilesDeleted: 0 });
    expect(await getProfile(dest, p.id)).toBeUndefined();
    expect((await getProfile(dest, p.id, { includeDeleted: true }))?.deletedAt).not.toBeNull();
  });

  it('a tombstone for a profile this device never had is kept, so an older live copy can never resurrect it', async () => {
    const a = await device(T0, 'a');
    const p = await createProfile(a, { name: 'Phoenix' });
    const liveFile = await exportBackup(a);
    await deleteProfile(a, p.id);
    const tombstoneFile = await exportBackup(a);

    const b = await device(T0, 'b'); // never saw the profile
    await importBackup(b, tombstoneFile); // the delete arrives first...
    const late = await importBackup(b, liveFile); // ...then a stale backup that still has it alive
    expect(late).toMatchObject({ profilesAdded: 0, profilesUpdated: 0, profilesSkipped: 1 });
    expect(await getProfile(b, p.id)).toBeUndefined();
  });
});

describe('merge conflicts', () => {
  it('a newer profile update wins over an older local copy', async () => {
    const dest = await device();
    const p = await createProfile(dest, { name: 'Original' });
    const incoming = envelope({ profiles: [{ ...p, name: 'Renamed Elsewhere', updatedAt: dest.nextTimestamp() }] });
    const report = await importBackup(dest, incoming);
    expect(report.profilesUpdated).toBe(1);
    await expect(getProfile(dest, p.id)).resolves.toMatchObject({ name: 'Renamed Elsewhere' });
  });

  it('an older incoming profile never overwrites a newer local copy', async () => {
    const dest = await device();
    const p = await createProfile(dest, { name: 'Original' });
    const renamed = await renameProfile(dest, p.id, 'Local Rename');
    const report = await importBackup(dest, envelope({ profiles: [p] })); // the pre-rename copy
    expect(report.profilesSkipped).toBe(1);
    await expect(getProfile(dest, p.id)).resolves.toEqual(renamed);
  });

  it('an equal timestamp changes nothing', async () => {
    const dest = await device();
    const p = await createProfile(dest, { name: 'Same' });
    const report = await importBackup(dest, envelope({ profiles: [{ ...p, name: 'Tampered' }] }));
    expect(report.profilesSkipped).toBe(1);
    await expect(getProfile(dest, p.id)).resolves.toMatchObject({ name: 'Same' });
  });

  it('a newer tombstone wins over a live local copy', async () => {
    const dest = await device();
    const p = await createProfile(dest, { name: 'Original' });
    const tombstone = { ...p, deletedAt: '2026-10-21T00:00:00.000Z', updatedAt: dest.nextTimestamp() };
    const report = await importBackup(dest, envelope({ profiles: [tombstone] }));
    expect(report).toMatchObject({ profilesUpdated: 1, profilesDeleted: 1, profilesRestored: 0 }); // the singer should be told
    expect(await getProfile(dest, p.id)).toBeUndefined();
    expect((await listProfiles(dest)).map((x) => x.id)).not.toContain(p.id);
  });

  it('an older tombstone loses to a newer local edit (a restore after the delete sticks)', async () => {
    const dest = await device();
    const p = await createProfile(dest, { name: 'Original' });
    await deleteProfile(dest, p.id);
    const staleTombstone = (await getProfile(dest, p.id, { includeDeleted: true }))!;
    await restoreProfile(dest, p.id);

    const report = await importBackup(dest, envelope({ profiles: [staleTombstone] }));
    expect(report.profilesSkipped).toBe(1);
    await expect(getProfile(dest, p.id)).resolves.toMatchObject({ deletedAt: null });
  });

  it('a newer live copy resurrects a profile that an older tombstone had deleted', async () => {
    const a = await device(T0, 'a');
    const p = await createProfile(a, { name: 'Phoenix' });
    await deleteProfile(a, p.id);
    const tombstoneFile = await exportBackup(a);
    await restoreProfile(a, p.id);
    const liveFile = await exportBackup(a);

    const b = await device(T0, 'b');
    await importBackup(b, tombstoneFile);
    expect(await getProfile(b, p.id)).toBeUndefined();
    const report = await importBackup(b, liveFile);
    expect(report).toMatchObject({ profilesUpdated: 1, profilesRestored: 1, profilesDeleted: 0 });
    expect(await getProfile(b, p.id)).toMatchObject({ name: 'Phoenix', deletedAt: null });
  });

  it('attempts are deduped by id: one already present is left untouched even if the incoming copy differs and looks newer', async () => {
    const dest = await device();
    const p = await createProfile(dest, { name: 'T' });
    const local = await addAttempt(dest, attemptInput(p.id));
    const conflicting = { ...local, score: 0, passed: false, mastery: 0, updatedAt: dest.nextTimestamp(), deletedAt: '2026-10-21T00:00:00.000Z' };
    const report = await importBackup(dest, envelope({ attempts: [conflicting] }));
    expect(report).toMatchObject({ attemptsSkipped: 1, attemptsAdded: 0 });
    await expect(getAttempt(dest, local.id)).resolves.toEqual(local); // the log is append-only: never rewritten by an import
  });

  it('a duplicate id inside the file itself counts once', async () => {
    const dest = await device();
    const p = await createProfile(dest, { name: 'T' });
    const row = remoteAttempt(p.id, dest.nextTimestamp(), { id: 'dup-1' });
    const report = await importBackup(dest, envelope({ attempts: [row, { ...row, score: 0.1 }] }));
    expect(report).toMatchObject({ attemptsAdded: 1, attemptsSkipped: 1 });
    expect((await getAttempt(dest, 'dup-1'))?.score).toBe(0.8);
  });

  it('a brand-new attempt id from another device is simply added, and merges into the right profile', async () => {
    const dest = await device();
    const p = await createProfile(dest, { name: 'T' });
    const row = remoteAttempt(p.id, formatHlc({ wallMs: T0 + 5000, counter: 0, deviceId: 'remote00' }), { id: 'remote-attempt-1' });
    const report = await importBackup(dest, envelope({ attempts: [row] }));
    expect(report.attemptsAdded).toBe(1);
    expect((await listAttemptsByProfile(dest, p.id)).map((a) => a.id)).toEqual(['remote-attempt-1']);
  });

  it('a tombstoned attempt from another device is stored hidden (and kept out of the log)', async () => {
    const dest = await device();
    const p = await createProfile(dest, { name: 'T' });
    const row = remoteAttempt(p.id, dest.nextTimestamp(), { id: 'dead-attempt', deletedAt: '2026-10-21T00:00:00.000Z' });
    await importBackup(dest, envelope({ attempts: [row] }));
    expect(await listAttemptsByProfile(dest, p.id)).toEqual([]);
    expect((await getAttempt(dest, 'dead-attempt', { includeDeleted: true }))?.deletedAt).not.toBeNull();
  });

  it("merging a remote timestamp means this device's next local write sorts after it - even after a restart with a bad clock", async () => {
    const name = freshName('dev');
    const dest = await openDb(name, { now: () => T0 });
    const p = await createProfile(dest, { name: 'T' });
    // another device whose clock runs a day ahead (well inside the allowed skew)
    const remoteStamp = formatHlc({ wallMs: T0 + 86_400_000, counter: 7, deviceId: 'remote00' });
    await importBackup(dest, envelope({ attempts: [remoteAttempt(p.id, remoteStamp, { id: 'r1' })] }));

    const sameSession = await addAttempt(dest, attemptInput(p.id));
    expect(sameSession.updatedAt > remoteStamp).toBe(true);

    const relaunched = await openDb(name, { now: () => 5 }); // killed and restarted; the wall clock is wrong
    const afterRestart = await addAttempt(relaunched, attemptInput(p.id));
    expect(afterRestart.updatedAt > remoteStamp).toBe(true);
    expect(afterRestart.updatedAt > sameSession.updatedAt).toBe(true);
  });

  it('two devices that diverged offline converge on the same state after exchanging backups', async () => {
    const a = await device(T0, 'a');
    const shared = await createProfile(a, { name: 'Shared' });
    const aFile0 = await exportBackup(a);
    const b = await device(T0 + 50, 'b');
    await importBackup(b, aFile0);

    // offline: each adds attempts and renames the shared profile
    const aAttempts = [await addAttempt(a, attemptInput(shared.id, { exerciseId: 'ex.a' })), await addAttempt(a, attemptInput(shared.id, { exerciseId: 'ex.a' }))];
    await renameProfile(a, shared.id, 'Named on A');
    const bAttempt = await addAttempt(b, attemptInput(shared.id, { exerciseId: 'ex.b' }));
    await renameProfile(b, shared.id, 'Named on B'); // later in wall-clock time than A's rename

    const aFile = await exportBackup(a);
    const bFile = await exportBackup(b);
    cleanReport(await importBackup(a, bFile));
    cleanReport(await importBackup(b, aFile));

    const expectedIds = [...aAttempts.map((x) => x.id), bAttempt.id].sort();
    for (const db of [a, b]) {
      expect((await listAttemptsByProfile(db, shared.id)).map((x) => x.id).sort()).toEqual(expectedIds);
    }
    const nameOnA = (await getProfile(a, shared.id))!.name;
    const nameOnB = (await getProfile(b, shared.id))!.name;
    expect(nameOnA).toBe(nameOnB); // last write wins, identically on both sides
    expect(nameOnA).toBe('Named on B');
    expect((await getProfile(a, shared.id))!.updatedAt).toBe((await getProfile(b, shared.id))!.updatedAt);
    // and both replay the combined log in the same order
    expect((await listAttemptsByProfile(a, shared.id)).map((x) => x.id)).toEqual((await listAttemptsByProfile(b, shared.id)).map((x) => x.id));
  });
});

describe('importBackup never throws on garbage', () => {
  it.each<[string, unknown]>([
    ['null', null],
    ['undefined', undefined],
    ['a number', 42],
    ['an array', []],
    ['a boolean', true],
    ['an object with the wrong format tag', { format: 'something-else', version: 1, profiles: [], attempts: [] }],
    ['an empty object', {}],
  ])('rejects %s with an error in the report', async (_label, junk) => {
    const dest = await device();
    const report = await importBackup(dest, junk);
    expect(report.ok).toBe(false);
    expect(report.errors).toEqual(['not a recognised pitch-lab-backup file']);
    expect(report).toMatchObject({ profilesAdded: 0, attemptsAdded: 0 });
  });

  it('rejects text that is not JSON', async () => {
    const dest = await device();
    for (const text of ['', 'not json', '{"format": "pitch-lab-backup", ']) {
      const report = await importBackup(dest, text);
      expect(report.ok).toBe(false);
      expect(report.errors).toEqual(['the file is not valid JSON']);
    }
  });

  it.each<[string, unknown, RegExp]>([
    ['version 0', 0, /unsupported backup version/],
    ['a fractional version', 1.5, /unsupported backup version/],
    ['a string version', '1', /unsupported backup version/],
    ['a missing version', undefined, /unsupported backup version/],
    ['a newer version', 2, /newer version of Pitch Lab/],
  ])('refuses %s', async (_label, version, message) => {
    const dest = await device();
    const report = await importBackup(dest, { format: BACKUP_FORMAT, version, profiles: [], attempts: [] });
    expect(report.ok).toBe(false);
    expect(report.errors[0]).toMatch(message);
  });

  it('refuses an envelope without its lists', async () => {
    const dest = await device();
    for (const file of [{ format: BACKUP_FORMAT, version: 1 }, { format: BACKUP_FORMAT, version: 1, profiles: [] }, { format: BACKUP_FORMAT, version: 1, profiles: 'x', attempts: [] }]) {
      const report = await importBackup(dest, file);
      expect(report.ok).toBe(false);
      expect(report.errors[0]).toMatch(/missing its profiles or attempts/);
    }
  });

  it('skips malformed rows one by one but still imports the good ones in the same file', async () => {
    const src = await device();
    const good = await createProfile(src, { name: 'Good' });
    const goodAttempt = await addAttempt(src, attemptInput(good.id));

    const dest = await device(T0, 'dest');
    const file = envelope({
      profiles: [good, { id: 'bad', updatedAt: 'x', name: 'n' }, 'not-even-an-object', null, { ...good, id: 'no-name', name: '' }] as unknown as ProfileRecord[],
      attempts: [goodAttempt, { id: 'bad-attempt' }, 7, remoteAttempt(good.id, dest.nextTimestamp(), { id: 'bad-score', score: 'high' })] as unknown as AttemptRecord[],
    });
    const report = await importBackup(dest, file);
    expect(report.ok).toBe(true);
    expect(report).toMatchObject({ profilesAdded: 1, profilesRejected: 4, attemptsAdded: 1, attemptsRejected: 3 });
    expect(report.errors.length).toBe(7);
    await expect(getProfile(dest, good.id)).resolves.toEqual(good);
    await expect(getAttempt(dest, goodAttempt.id)).resolves.toEqual(goodAttempt);
    expect(await listProfiles(dest, { includeDeleted: true })).toHaveLength(1);
  });

  it('describes what is wrong with each rejected row', async () => {
    const dest = await device();
    const p = await createProfile(dest, { name: 'T' });
    const stamp = dest.nextTimestamp();
    const report = await importBackup(
      dest,
      envelope({
        profiles: [{ id: 'iso-stamp', updatedAt: '2026-10-21T00:00:00.000Z', createdAt: '2026-10-21T00:00:00.000Z', name: 'n' }] as unknown as ProfileRecord[],
        attempts: [
          remoteAttempt(p.id, stamp, { id: 'a1', kind: 'karaoke' }),
          remoteAttempt('ghost-profile', stamp, { id: 'a2' }),
          remoteAttempt(p.id, stamp, { id: 'a3', createdAt: 'yesterday-ish' }),
          remoteAttempt(p.id, 'zzzzzzzzz-zzzzz-zzzzzzzz', { id: 'a4' }),
        ] as unknown as AttemptRecord[],
      }),
    );
    expect(report.errors).toEqual([
      'profile iso-stamp: malformed updatedAt',
      'attempt a1: attempts-repo: unknown attempt kind: karaoke',
      'attempt a2: belongs to an unknown profile',
      'attempt a3: malformed createdAt',
      'attempt a4: updatedAt is implausibly far in the future',
    ]);
  });

  it('rejects ids that are unsafe as database keys, and cannot pollute Object.prototype', async () => {
    const dest = await device();
    const p = await createProfile(dest, { name: 'T' });
    const stamp = dest.nextTimestamp();
    const evil = JSON.parse(
      `{"format":"pitch-lab-backup","version":1,"exportedAt":"x","settings":{"profiles":{"__proto__":{"polluted":true}}},
        "profiles":[{"id":"__proto__","name":"x","updatedAt":"${stamp}","createdAt":"2026-01-01T00:00:00.000Z","__proto__":{"polluted":true}}],
        "attempts":[{"id":"has space","profileId":"${p.id}"},{"id":"${'x'.repeat(200)}","profileId":"${p.id}"},{"id":"../etc","profileId":"${p.id}"}]}`,
    ) as unknown;
    const report = await importBackup(dest, evil, { kv: new MemoryKV() });
    expect(report.profilesRejected).toBe(1);
    expect(report.attemptsRejected).toBe(3);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('a storage layer that fails mid-import is reported, not thrown, and the profiles still land', async () => {
    const src = await device();
    const p = await createProfile(src, { name: 'T' });
    await addAttempt(src, attemptInput(p.id));
    await addAttempt(src, attemptInput(p.id));
    const file = await exportBackup(src);

    const dest = await device(T0, 'dest');
    const broken = dbWithFailingStore(dest, 'attempts', 'addMissing', new Error('disk full'));
    const report = await importBackup(broken, file);
    expect(report.ok).toBe(true);
    expect(report.profilesAdded).toBe(1);
    expect(report.attemptsAdded).toBe(0);
    expect(report.attemptsRejected).toBe(2);
    expect(report.errors).toEqual(['a batch of 2 attempts could not be stored: disk full']);
    await expect(getProfile(dest, p.id)).resolves.toBeDefined();
  });

  it('a profile write that fails is counted as rejected, and the import carries on', async () => {
    const src = await device();
    const p1 = await createProfile(src, { name: 'One' });
    await createProfile(src, { name: 'Two' });
    const file = await exportBackup(src);
    const dest = await device(T0, 'dest');
    const broken = dbWithFailingStore(dest, 'profiles', 'update', new Error('locked'));
    const report = await importBackup(broken, file);
    expect(report.ok).toBe(true);
    expect(report.profilesRejected).toBe(2);
    expect(report.errors[0]).toBe(`profile ${p1.id}: locked`);
  });

  it('caps the error list but keeps the counts exact', async () => {
    const dest = await device();
    const p = await createProfile(dest, { name: 'T' });
    const attempts = Array.from({ length: 200 }, (_, i) => ({ id: `junk-${i}` })) as unknown as AttemptRecord[];
    const report = await importBackup(dest, envelope({ attempts }));
    expect(report.attemptsRejected).toBe(200);
    expect(report.errors).toHaveLength(51);
    expect(report.errors[50]).toBe('...and 150 more');
    void p;
  });
});

describe('sanitising what comes in', () => {
  it('normalises each field it keeps, and drops what is unsafe', async () => {
    const dest = await device();
    const stamp = dest.nextTimestamp();
    const report = await importBackup(
      dest,
      envelope({
        profiles: [
          {
            id: 'prof-1',
            profileId: 'something-else',
            createdAt: '2026-03-04T05:06:07Z',
            updatedAt: stamp,
            deletedAt: null,
            name: `  ${'N'.repeat(100)}  `,
            voiceType: 'soprano',
            range: { comfortable: { low: 70, high: 40 }, extended: { low: 1, high: 2 }, measuredAt: 'x' },
          },
        ] as unknown as ProfileRecord[],
        attempts: [
          remoteAttempt('prof-1', stamp, {
            id: 'att-1',
            score: 7,
            durationSec: -4,
            takeId: 'a-take-from-another-device',
            metrics: { 'accuracy.inTolerancePct': 90, 'bad.nan': null, __proto__x: 1, 'ok.value': Infinity, 'run.score': 0.5 },
            tonicMidi: 'sixty',
            levelId: undefined,
            extraneous: 'dropped',
          }),
        ] as unknown as AttemptRecord[],
      }),
    );
    cleanReport(report);

    const profile = (await getProfile(dest, 'prof-1'))!;
    expect(profile.profileId).toBe('prof-1'); // a profile scopes itself, whatever the file says
    expect(profile.createdAt).toBe('2026-03-04T05:06:07.000Z'); // canonical ISO
    expect(profile.name).toHaveLength(60);
    expect(profile.voiceType).toBe('unknown');
    expect(profile.range).toBeNull();

    const attempt = (await getAttempt(dest, 'att-1'))!;
    expect(attempt.score).toBe(1);
    expect(attempt.durationSec).toBe(0);
    expect(attempt.takeId).toBeNull(); // takes are local-only
    expect(attempt.metrics).toEqual({ 'accuracy.inTolerancePct': 90, 'run.score': 0.5 });
    expect(attempt.tonicMidi).toBeNull();
    expect(attempt.levelId).toBeNull();
    expect('extraneous' in attempt).toBe(false);
  });

  it('keeps a valid vocal range', async () => {
    const dest = await device();
    const range = { comfortable: { low: 48, high: 60 }, extended: { low: 43, high: 65 }, measuredAt: '2026-01-01T00:00:00.000Z' };
    await importBackup(dest, envelope({ profiles: [{ id: 'p', profileId: 'p', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: dest.nextTimestamp(), deletedAt: null, name: 'R', voiceType: 'tenor', range }] }));
    expect((await getProfile(dest, 'p'))?.range).toEqual(range);
  });
});

describe('the clock cannot be poisoned by a damaged or hostile file', () => {
  it('rejects timestamps implausibly far in the future instead of pinning the local clock there', async () => {
    const dest = await device();
    const p = await createProfile(dest, { name: 'T' });
    const farFuture = formatHlc({ wallMs: 9_999_999_999_999, counter: 0, deviceId: 'remote00' }); // the year 2286
    const absurd = formatHlc({ wallMs: Math.pow(36, 9) - 1, counter: 0, deviceId: 'remote00' });
    const report = await importBackup(dest, envelope({ attempts: [remoteAttempt(p.id, farFuture, { id: 'f1' }), remoteAttempt(p.id, absurd, { id: 'f2' })] }));
    expect(report.attemptsRejected).toBe(2);
    expect(report.attemptsAdded).toBe(0);

    const next = await addAttempt(dest, attemptInput(p.id));
    expect(next.updatedAt < farFuture).toBe(true); // the clock still tracks real time
  });

  it('accepts a timestamp from a device whose clock is merely a bit ahead', async () => {
    const dest = await device();
    const p = await createProfile(dest, { name: 'T' });
    const ahead = formatHlc({ wallMs: T0 + 30 * 86_400_000, counter: 0, deviceId: 'remote00' });
    const report = await importBackup(dest, envelope({ attempts: [remoteAttempt(p.id, ahead, { id: 'ok1' })] }));
    expect(report.attemptsAdded).toBe(1);
  });
});

describe('large imports', () => {
  it('imports many attempts in bounded transactions, counting every one exactly', async () => {
    const dest = await device();
    const p = await createProfile(dest, { name: 'T' });
    const stamp = dest.nextTimestamp();
    const rows = Array.from({ length: 1230 }, (_, i) => remoteAttempt(p.id, stamp, { id: `bulk-${i}` }));
    rows.push(rows[0]); // one duplicate

    let batches = 0;
    const counting = overrideMethod(dest, 'store', (name: string) => {
      const store = dest.store(name as never);
      return name === 'attempts'
        ? overrideMethod(store, 'addMissing', async (entries: never) => {
            batches += 1;
            return (store as { addMissing(e: never): Promise<unknown> }).addMissing(entries);
          })
        : store;
    });
    const report = await importBackup(counting, envelope({ attempts: rows as unknown as AttemptRecord[] }));
    cleanReport(report);
    expect(report.attemptsAdded).toBe(1230);
    expect(report.attemptsSkipped).toBe(1);
    expect(batches).toBe(3); // 500 + 500 + 231
    expect(await listAttemptsByProfile(dest, p.id)).toHaveLength(1230);
  });
});

describe('settings restore', () => {
  const stored = { ...DEFAULT_SETTINGS, theme: 'dark', vibratoStyle: 'classical' };

  async function fileWithSettings(settings: unknown) {
    const src = await device(T0, 'src');
    const p = await createProfile(src, { name: 'Tenor' });
    const file = await exportBackup(src);
    return { p, file: { ...file, settings: { schemaVersion: 1, profiles: { [p.id]: settings } } } as BackupFile };
  }

  it('restores the settings of a profile the import ADDED', async () => {
    const dest = await device();
    const kv = new MemoryKV();
    const { p, file } = await fileWithSettings(stored);
    const report = await importBackup(dest, file, { kv });
    expect(report.settingsRestored).toBe(1);
    expect(await kv.get(profileSettingsKey(p.id))).toEqual(stored);
  });

  it('round-trips through a real export: settings travel with the profile', async () => {
    const src = await device(T0, 'src');
    const srcKv = new MemoryKV();
    const p = await createProfile(src, { name: 'Tenor' });
    await srcKv.set(profileSettingsKey(p.id), stored);
    const file = await exportBackup(src, undefined, srcKv);

    const dest = await device(T0, 'dest');
    const destKv = new MemoryKV();
    await importBackup(dest, file, { kv: destKv });
    expect(await destKv.get(profileSettingsKey(p.id))).toEqual(stored);
  });

  it('never overwrites settings the device already has', async () => {
    const dest = await device();
    const kv = new MemoryKV();
    const { p, file } = await fileWithSettings(stored);
    await kv.set(profileSettingsKey(p.id), { theme: 'light' });
    const report = await importBackup(dest, file, { kv });
    expect(report.settingsRestored).toBe(0);
    expect(await kv.get(profileSettingsKey(p.id))).toEqual({ theme: 'light' });
  });

  it('does not touch the settings of a profile that already existed locally', async () => {
    const src = await device(T0, 'src');
    const p = await createProfile(src, { name: 'Tenor' });
    const file = { ...(await exportBackup(src)), settings: { schemaVersion: 1, profiles: { [p.id]: stored } } } as BackupFile;
    const dest = await device(T0, 'dest');
    await importBackup(dest, file); // first import adds the profile
    const kv = new MemoryKV();
    const report = await importBackup(dest, file, { kv }); // second finds it already there
    expect(report.profilesAdded).toBe(0);
    expect(report.settingsRestored).toBe(0);
    expect(await kv.keys()).toEqual([]);
  });

  it('keeps only the keys Settings defines, with values of the right type', async () => {
    const dest = await device();
    const kv = new MemoryKV();
    const { p, file } = await fileWithSettings({ theme: 'light', referenceVolume: 'loud', notation: 'flats', schemaVersion: 1, evil: 'x', __proto__: { polluted: true } });
    await importBackup(dest, file, { kv });
    expect(await kv.get(profileSettingsKey(p.id))).toEqual({ theme: 'light', notation: 'flats', schemaVersion: 1 });
  });

  describe('every restored value is one the app can use (a corrupt file or a newer build must not crash the Settings screen)', () => {
    async function restored(settings: unknown) {
      const dest = await device();
      const kv = new MemoryKV();
      const { p, file } = await fileWithSettings(settings);
      const report = await importBackup(dest, file, { kv });
      return { report, stored: await kv.get<Record<string, unknown>>(profileSettingsKey(p.id)) };
    }

    const bad: Array<[key: string, value: unknown, label: string]> = [
      ['vibratoStyle', 'gospel', 'an unknown style'],
      ['vibratoStyle', 'constructor', 'an inherited property name'],
      ['vibratoStyle', '__proto__', 'the prototype key'],
      ['vibratoStyle', 'toString', 'another inherited name'],
      ['vibratoStyle', 3, 'a number'],
      ['vibratoStyle', null, 'null'],
      ['detector', 'crepe', 'an unknown detector'],
      ['detector', 'hasOwnProperty', 'an inherited property name'],
      ['detector', 7, 'a number'],
      ['referenceTimbre', 'banjo', 'an unknown timbre'],
      ['referenceTimbre', {}, 'an object'],
      ['notation', 'solfege', 'an unknown notation'],
      ['notation', ['sharps'], 'an array'],
      ['theme', 'neon', 'an unknown theme'],
      ['theme', '', 'an empty string'],
      ['reducedMotion', 'sometimes', 'an unknown value'],
      ['reducedMotion', true, 'a boolean'],
      ['showNoteNames', 'yes', 'a string'],
      ['showNoteNames', 1, 'a number'],
      ['showNoteNames', null, 'null'],
      ['referenceVolume', 'loud', 'a string'],
      ['referenceVolume', NaN, 'NaN'],
      ['referenceVolume', Infinity, 'Infinity'],
      ['referenceVolume', -Infinity, '-Infinity'],
      ['referenceVolume', null, 'null'],
    ];

    it.each(bad)('drops %s alone when it is %o (%s)... the other valid settings still import', async (key, value) => {
      const { report, stored } = await restored({ theme: 'dark', notation: 'flats', [key]: value });
      const others: Record<string, unknown> = { theme: 'dark', notation: 'flats' };
      delete others[key];
      expect(stored).toEqual({ schemaVersion: 1, ...others });
      expect(report.settingsRestored).toBe(1);
    });

    it('keeps every allowed value of every enumerated setting', async () => {
      const allowed: Record<string, string[]> = {
        vibratoStyle: Object.keys(CONFIG.vibrato.styles),
        detector: ['mpm', 'yin'],
        referenceTimbre: ['piano', 'sine', 'soft'],
        notation: ['sharps', 'flats'],
        theme: ['system', 'dark', 'light'],
        reducedMotion: ['system', 'on', 'off'],
      };
      for (const [key, values] of Object.entries(allowed)) {
        for (const value of values) expect((await restored({ [key]: value })).stored).toEqual({ schemaVersion: 1, [key]: value });
      }
    });

    it('keeps both values of showNoteNames', async () => {
      expect((await restored({ showNoteNames: true })).stored).toEqual({ schemaVersion: 1, showNoteNames: true });
      expect((await restored({ showNoteNames: false })).stored).toEqual({ schemaVersion: 1, showNoteNames: false });
    });

    it('clamps referenceVolume into 0..1 instead of storing a value the audio code would blow up on', async () => {
      for (const [given, kept] of [[1e9, 1], [-5, 0], [0.25, 0.25], [0, 0], [1, 1]] as const) {
        expect((await restored({ referenceVolume: given })).stored).toEqual({ schemaVersion: 1, referenceVolume: kept });
      }
    });

    it('always writes schemaVersion 1, whatever the file says or leaves out', async () => {
      for (const given of [{ schemaVersion: 7, theme: 'dark' }, { schemaVersion: '1', theme: 'dark' }, { theme: 'dark' }]) {
        expect((await restored(given)).stored).toEqual({ schemaVersion: 1, theme: 'dark' });
      }
    });

    it('a backup from a newer build keeps what this build understands and drops the rest', async () => {
      const { report, stored } = await restored({
        schemaVersion: 1,
        vibratoStyle: 'gospel', // styles, timbres and detectors the newer build added
        referenceTimbre: 'banjo',
        detector: 'crepe',
        theme: 'dark',
        notation: 'flats',
        referenceVolume: 0.4,
        showNoteNames: false,
        reducedMotion: 'on',
        futureSetting: 'x',
      });
      expect(report.settingsRestored).toBe(1);
      expect(stored).toEqual({ schemaVersion: 1, theme: 'dark', notation: 'flats', referenceVolume: 0.4, showNoteNames: false, reducedMotion: 'on' });
    });

    it('stores nothing when no setting is usable', async () => {
      const { report, stored } = await restored({ vibratoStyle: 'gospel', detector: 'crepe', schemaVersion: 1 });
      expect(report.settingsRestored).toBe(0);
      expect(stored).toBeUndefined();
    });

    it('sanitizeSettings is reusable for reading settings back: it never returns a key the app cannot use', () => {
      expect(sanitizeSettings({ vibratoStyle: 'gospel', theme: 'dark', evil: 1 })).toEqual({ schemaVersion: 1, theme: 'dark' });
      expect(sanitizeSettings({ ...DEFAULT_SETTINGS })).toEqual(DEFAULT_SETTINGS);
      for (const nothing of [null, undefined, 'dark', 5, [], {}, { vibratoStyle: 'gospel' }]) expect(sanitizeSettings(nothing)).toBeNull();
    });

    it('the settings the app builds from a restored blob never index the vibrato table with an unknown style (the crash this guards)', async () => {
      for (const given of [{ vibratoStyle: 'gospel', theme: 'dark' }, { vibratoStyle: 'constructor', detector: 'mpm' }, { vibratoStyle: 'pop' }]) {
        const { stored } = await restored(given);
        const merged: Settings = { ...DEFAULT_SETTINGS, ...(stored as Partial<Settings>) }; // how the settings screen builds them
        expect(CONFIG.vibrato.styles[merged.vibratoStyle].rateHz).toHaveLength(2);
      }
    });
  });

  it('ignores a settings blob that is not an object or has nothing usable', async () => {
    for (const blob of ['dark', 5, null, [], {}, { unknownKey: 1 }]) {
      const dest = await device();
      const kv = new MemoryKV();
      const { p, file } = await fileWithSettings(blob);
      const report = await importBackup(dest, file, { kv });
      expect(report.settingsRestored).toBe(0);
      expect(await kv.get(profileSettingsKey(p.id))).toBeUndefined();
    }
  });

  it('does nothing without a KV store, or for a deleted profile', async () => {
    const { p, file } = await fileWithSettings(stored);
    const dest = await device();
    expect((await importBackup(dest, file)).settingsRestored).toBe(0);

    const src = await device(T0, 'src2');
    const dead = await createProfile(src, { name: 'Dead' });
    await deleteProfile(src, dead.id);
    const deadFile = { ...(await exportBackup(src)), settings: { schemaVersion: 1, profiles: { [dead.id]: stored } } } as BackupFile;
    const kv = new MemoryKV();
    expect((await importBackup(await device(T0, 'dest2'), deadFile, { kv })).settingsRestored).toBe(0);
    void p;
  });

  it('a settings store that fails is reported without failing the import', async () => {
    const dest = await device();
    const kv = new MemoryKV();
    kv.failing.add('set');
    const { p, file } = await fileWithSettings(stored);
    const report = await importBackup(dest, file, { kv });
    expect(report.ok).toBe(true);
    expect(report.profilesAdded).toBe(1);
    expect(report.settingsRestored).toBe(0);
    expect(report.errors).toEqual([`settings of profile ${p.id} could not be stored: kv set failed`]);
  });
});

describe('retireEmptyDefaultProfile (restoring onto a fresh device)', () => {
  async function restoredFile() {
    const src = await device(T0, 'src');
    const a = await createProfile(src, { name: 'Tenor', voiceType: 'tenor' });
    const b = await createProfile(src, { name: 'Beginner' });
    await addAttempt(src, attemptInput(a.id));
    return { a, b, file: await exportBackup(src) };
  }

  it('soft-deletes the untouched default "Me" and makes a restored profile active', async () => {
    const { a, b, file } = await restoredFile();
    const dest = await device(T0 + 99, 'dest');
    const me = await createProfile(dest, { name: 'Me' });
    await setActiveProfileId(dest, me.id);

    const report = await importBackup(dest, file, { retireEmptyDefaultProfile: true });
    cleanReport(report);
    expect(report.retiredDefaultProfileId).toBe(me.id);
    expect((await listProfiles(dest)).map((p) => p.id)).toEqual([a.id, b.id]);
    expect((await getProfile(dest, me.id, { includeDeleted: true }))?.deletedAt).not.toBeNull();
    expect(await getActiveProfileId(dest)).toBe(a.id);
  });

  it('is off unless asked for', async () => {
    const { file } = await restoredFile();
    const dest = await device(T0, 'dest');
    const me = await createProfile(dest, { name: 'Me' });
    const report = await importBackup(dest, file);
    expect(report.retiredDefaultProfileId).toBeNull();
    expect(await getProfile(dest, me.id)).toBeDefined();
  });

  it.each<[string, (db: PitchLabDb, me: ProfileRecord) => Promise<unknown>]>([
    ['has been renamed', (db, me) => renameProfile(db, me.id, 'Don')],
    ['has a vocal range', (db, me) => setVocalRange(db, me.id, { comfortable: { low: 48, high: 60 }, extended: { low: 43, high: 65 }, measuredAt: '2026-01-01T00:00:00.000Z' })],
    ['has attempts', (db, me) => addAttempt(db, attemptInput(me.id))],
  ])('keeps a default profile that %s', async (_label, touch) => {
    const { file } = await restoredFile();
    const dest = await device(T0, 'dest');
    const me = await createProfile(dest, { name: 'Me' });
    await touch(dest, me);
    const report = await importBackup(dest, file, { retireEmptyDefaultProfile: true });
    expect(report.retiredDefaultProfileId).toBeNull();
    expect(await getProfile(dest, me.id)).toBeDefined();
  });

  it('keeps everything when there is more than one profile already, or the import adds nothing', async () => {
    const { file } = await restoredFile();
    const crowded = await device(T0, 'dest1');
    await createProfile(crowded, { name: 'Me' });
    await createProfile(crowded, { name: 'Other' });
    expect((await importBackup(crowded, file, { retireEmptyDefaultProfile: true })).retiredDefaultProfileId).toBeNull();

    const repeat = await device(T0, 'dest2');
    await importBackup(repeat, file);
    const me = await createProfile(repeat, { name: 'Me' });
    const second = await importBackup(repeat, file, { retireEmptyDefaultProfile: true }); // adds nothing new
    expect(second.retiredDefaultProfileId).toBeNull();
    expect(await getProfile(repeat, me.id)).toBeDefined();
  });

  it('leaves the active profile alone when it was not the one retired', async () => {
    const { file } = await restoredFile();
    const dest = await device(T0, 'dest');
    const me = await createProfile(dest, { name: 'Me' });
    await deleteProfile(dest, me.id); // already gone; the only live profile is none... so nothing to retire
    const report = await importBackup(dest, file, { retireEmptyDefaultProfile: true });
    expect(report.retiredDefaultProfileId).toBeNull();
    expect(await getActiveProfileId(dest)).toBeUndefined();
  });
});

describe('meta bookkeeping', () => {
  it('leaves the persisted clock at or beyond everything it imported', async () => {
    const name = freshName('dev');
    const dest = await openDb(name, { now: () => T0 });
    const p = await createProfile(dest, { name: 'T' });
    const stamps = [3, 2, 1].map((n) => formatHlc({ wallMs: T0 + n * 1000, counter: n, deviceId: 'remote00' }));
    await importBackup(dest, envelope({ attempts: stamps.map((s, i) => remoteAttempt(p.id, s, { id: `s${i}` })) as unknown as AttemptRecord[] }));
    const state = await dest.store<{ wallMs: number; counter: number }>('meta').get(META_KEYS.hlcState);
    expect(state!.wallMs).toBeGreaterThanOrEqual(T0 + 3000);
  });
});
