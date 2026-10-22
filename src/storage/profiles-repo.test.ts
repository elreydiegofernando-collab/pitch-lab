import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { openDb, type PitchLabDb } from './db';
import { isHlc } from './hlc';
import { isConstraintError } from './idb';
import {
  MAX_PROFILE_NAME_LENGTH,
  cleanProfileName,
  createProfile,
  deleteProfile,
  getActiveProfile,
  getActiveProfileId,
  getProfile,
  isValidVocalRange,
  isVoiceType,
  listProfiles,
  renameProfile,
  restoreProfile,
  setActiveProfileId,
  setVocalRange,
  setVoiceType,
  updateProfile,
} from './profiles-repo';
import { freshName } from './test-helpers';

/** A db whose wall clock ticks one millisecond per reading, so creation order is unambiguous. */
function freshDb(): Promise<PitchLabDb> {
  let t = 1_800_000_000_000;
  return openDb(freshName('profiles'), { now: () => ++t });
}

const RANGE = { comfortable: { low: 48, high: 60 }, extended: { low: 43, high: 65 }, measuredAt: '2026-01-01T00:00:00.000Z' };

describe('helpers', () => {
  it('cleanProfileName trims, collapses whitespace, truncates, and rejects emptiness', () => {
    expect(cleanProfileName('  Don   Juan \n')).toBe('Don Juan');
    expect(cleanProfileName('x'.repeat(200))).toHaveLength(MAX_PROFILE_NAME_LENGTH);
    expect(() => cleanProfileName('')).toThrow(TypeError);
    expect(() => cleanProfileName('   ')).toThrow(TypeError);
    expect(() => cleanProfileName(undefined)).toThrow(TypeError);
    expect(() => cleanProfileName(42)).toThrow(TypeError);
  });

  it('isVoiceType / isValidVocalRange', () => {
    for (const v of ['tenor', 'baritone', 'other', 'unknown']) expect(isVoiceType(v)).toBe(true);
    expect(isVoiceType('soprano')).toBe(false);
    expect(isVoiceType(undefined)).toBe(false);

    expect(isValidVocalRange(RANGE)).toBe(true);
    expect(isValidVocalRange({ ...RANGE, comfortable: { low: 60, high: 48 } })).toBe(false); // low > high
    expect(isValidVocalRange({ ...RANGE, extended: { low: NaN, high: 65 } })).toBe(false);
    expect(isValidVocalRange({ ...RANGE, measuredAt: 5 })).toBe(false);
    expect(isValidVocalRange(null)).toBe(false);
    expect(isValidVocalRange({})).toBe(false);
  });
});

describe('createProfile', () => {
  it('creates a profile that scopes itself (profileId === id), with sensible defaults', async () => {
    const db = await freshDb();
    const profile = await createProfile(db, { name: 'Tenor' });
    expect(profile.profileId).toBe(profile.id);
    expect(profile.name).toBe('Tenor');
    expect(profile.voiceType).toBe('unknown');
    expect(profile.range).toBeNull();
    expect(profile.deletedAt).toBeNull();
    expect(profile.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(isHlc(profile.updatedAt)).toBe(true);
    await expect(getProfile(db, profile.id)).resolves.toEqual(profile);
  });

  it('accepts an explicit voice type and range, storing its own copy of the range', async () => {
    const db = await freshDb();
    const range = { ...RANGE, comfortable: { ...RANGE.comfortable }, extended: { ...RANGE.extended } };
    const p = await createProfile(db, { name: 'T', voiceType: 'tenor', range });
    expect(p.voiceType).toBe('tenor');
    expect(p.range).toEqual(RANGE);
    range.comfortable.low = 1; // later mutation of the caller's object must not leak in
    expect((await getProfile(db, p.id))?.range?.comfortable.low).toBe(48);
  });

  it('cleans the name', async () => {
    const db = await freshDb();
    expect((await createProfile(db, { name: '  Ben  ' })).name).toBe('Ben');
  });

  it('rejects an empty name, an unknown voice type and an invalid range - storing nothing', async () => {
    const db = await freshDb();
    await expect(createProfile(db, { name: '  ' })).rejects.toThrow(TypeError);
    await expect(createProfile(db, { name: 'x', voiceType: 'soprano' as never })).rejects.toThrow(TypeError);
    await expect(createProfile(db, { name: 'x', range: { ...RANGE, comfortable: { low: 70, high: 40 } } })).rejects.toThrow(TypeError);
    expect(await listProfiles(db, { includeDeleted: true })).toEqual([]);
  });

  it('honours an explicit id (used only by the migration), but never overwrites an existing profile', async () => {
    const db = await freshDb();
    const p = await createProfile(db, { id: 'fixed-id', name: 'First' });
    expect(p.id).toBe('fixed-id');
    const err = await createProfile(db, { id: 'fixed-id', name: 'Second' }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(isConstraintError(err)).toBe(true);
    expect((await getProfile(db, 'fixed-id'))?.name).toBe('First');
  });
});

describe('updateProfile / renameProfile / setVocalRange / setVoiceType', () => {
  it('renames a profile and bumps updatedAt (never createdAt or id)', async () => {
    const db = await freshDb();
    const p = await createProfile(db, { name: 'Old' });
    const renamed = await renameProfile(db, p.id, 'New');
    expect(renamed.name).toBe('New');
    expect(renamed.updatedAt > p.updatedAt).toBe(true);
    expect(renamed.createdAt).toBe(p.createdAt);
    expect(renamed.id).toBe(p.id);
    await expect(getProfile(db, p.id)).resolves.toEqual(renamed);
  });

  it('sets, then clears, a vocal range', async () => {
    const db = await freshDb();
    const p = await createProfile(db, { name: 'T' });
    const withRange = await setVocalRange(db, p.id, RANGE);
    expect(withRange.range).toEqual(RANGE);
    const cleared = await setVocalRange(db, p.id, null);
    expect(cleared.range).toBeNull();
  });

  it('sets the voice type', async () => {
    const db = await freshDb();
    const p = await createProfile(db, { name: 'T' });
    expect((await setVoiceType(db, p.id, 'baritone')).voiceType).toBe('baritone');
  });

  it('a patch changes only the fields it names; range undefined means "not provided"', async () => {
    const db = await freshDb();
    const p = await createProfile(db, { name: 'T', voiceType: 'tenor', range: RANGE });
    const updated = await updateProfile(db, p.id, { name: 'U', range: undefined });
    expect(updated).toMatchObject({ name: 'U', voiceType: 'tenor', range: RANGE });
    const several = await updateProfile(db, p.id, { name: 'V', voiceType: 'other', range: null });
    expect(several).toMatchObject({ name: 'V', voiceType: 'other', range: null });
  });

  it('rejects a profile that does not exist, and a soft-deleted one', async () => {
    const db = await freshDb();
    await expect(renameProfile(db, 'nope', 'x')).rejects.toThrow(/no such profile/);
    const p = await createProfile(db, { name: 'T' });
    await deleteProfile(db, p.id);
    await expect(renameProfile(db, p.id, 'x')).rejects.toThrow(/no such profile/);
    await expect(setVocalRange(db, p.id, RANGE)).rejects.toThrow(/no such profile/);
  });

  it('rejects invalid values and leaves the record untouched', async () => {
    const db = await freshDb();
    const p = await createProfile(db, { name: 'Keep', range: RANGE });
    await expect(renameProfile(db, p.id, '   ')).rejects.toThrow(TypeError);
    await expect(setVoiceType(db, p.id, 'soprano' as never)).rejects.toThrow(TypeError);
    await expect(setVocalRange(db, p.id, { nonsense: true } as never)).rejects.toThrow(TypeError);
    await expect(getProfile(db, p.id)).resolves.toEqual(p);
  });

  it('concurrent updates to different fields never overwrite each other', async () => {
    const db = await freshDb();
    const p = await createProfile(db, { name: 'Start' });
    await Promise.all([renameProfile(db, p.id, 'Renamed'), setVocalRange(db, p.id, RANGE), setVoiceType(db, p.id, 'tenor')]);
    await expect(getProfile(db, p.id)).resolves.toMatchObject({ name: 'Renamed', range: RANGE, voiceType: 'tenor' });
  });
});

describe('soft delete and restore', () => {
  it('deleteProfile tombstones the row rather than removing it', async () => {
    const db = await freshDb();
    const p = await createProfile(db, { name: 'T' });
    await deleteProfile(db, p.id);
    const tombstone = await getProfile(db, p.id, { includeDeleted: true });
    expect(tombstone).toBeDefined();
    expect(tombstone!.deletedAt).not.toBeNull();
    expect(tombstone!.updatedAt > p.updatedAt).toBe(true); // a delete is a write, and must out-sort the live copy in a merge
  });

  it('a soft-deleted profile is hidden from get and list unless asked for', async () => {
    const db = await freshDb();
    const kept = await createProfile(db, { name: 'Kept' });
    const gone = await createProfile(db, { name: 'Gone' });
    await deleteProfile(db, gone.id);

    await expect(getProfile(db, gone.id)).resolves.toBeUndefined();
    expect((await listProfiles(db)).map((p) => p.id)).toEqual([kept.id]);
    expect((await listProfiles(db, { includeDeleted: true })).map((p) => p.id)).toEqual([kept.id, gone.id]);
    await expect(getProfile(db, gone.id, { includeDeleted: true })).resolves.toBeDefined();
  });

  it('deleting the active profile clears the selection; deleting another does not', async () => {
    const db = await freshDb();
    const a = await createProfile(db, { name: 'A' });
    const b = await createProfile(db, { name: 'B' });
    await setActiveProfileId(db, a.id);
    await deleteProfile(db, b.id);
    await expect(getActiveProfileId(db)).resolves.toBe(a.id);
    await deleteProfile(db, a.id);
    await expect(getActiveProfileId(db)).resolves.toBeUndefined();
  });

  it('deleting an already-deleted or a missing profile is a harmless no-op', async () => {
    const db = await freshDb();
    const p = await createProfile(db, { name: 'T' });
    await deleteProfile(db, p.id);
    const first = await getProfile(db, p.id, { includeDeleted: true });
    await deleteProfile(db, p.id);
    await expect(getProfile(db, p.id, { includeDeleted: true })).resolves.toEqual(first);
    await expect(deleteProfile(db, 'never-existed')).resolves.toBeUndefined();
  });

  it('restoreProfile undoes a delete, with a newer updatedAt', async () => {
    const db = await freshDb();
    const p = await createProfile(db, { name: 'T' });
    await deleteProfile(db, p.id);
    const tombstone = (await getProfile(db, p.id, { includeDeleted: true }))!;
    const restored = await restoreProfile(db, p.id);
    expect(restored.deletedAt).toBeNull();
    expect(restored.updatedAt > tombstone.updatedAt).toBe(true);
    await expect(getProfile(db, p.id)).resolves.toEqual(restored);
    expect((await listProfiles(db)).map((x) => x.id)).toEqual([p.id]);
  });

  it('restoring a live profile returns it unchanged; restoring a missing one rejects', async () => {
    const db = await freshDb();
    const p = await createProfile(db, { name: 'T' });
    await expect(restoreProfile(db, p.id)).resolves.toEqual(p);
    await expect(restoreProfile(db, 'nope')).rejects.toThrow(/no such profile/);
  });
});

describe('active profile selection', () => {
  it('is undefined until explicitly set', async () => {
    const db = await freshDb();
    await expect(getActiveProfileId(db)).resolves.toBeUndefined();
  });

  it('persists the chosen profile id (visible from a fresh connection)', async () => {
    const name = freshName('profiles');
    const db = await openDb(name);
    const p = await createProfile(db, { name: 'T' });
    await setActiveProfileId(db, p.id);
    const reopened = await openDb(name);
    await expect(getActiveProfileId(reopened)).resolves.toBe(p.id);
  });

  it('rejects selecting a profile that does not exist or is deleted', async () => {
    const db = await freshDb();
    await expect(setActiveProfileId(db, 'nope')).rejects.toThrow(/no such profile/);
    const p = await createProfile(db, { name: 'T' });
    await deleteProfile(db, p.id);
    await expect(setActiveProfileId(db, p.id)).rejects.toThrow(/no such profile/);
  });

  it('getActiveProfile returns the remembered profile', async () => {
    const db = await freshDb();
    await createProfile(db, { name: 'A' });
    const b = await createProfile(db, { name: 'B' });
    await setActiveProfileId(db, b.id);
    await expect(getActiveProfile(db)).resolves.toEqual(b);
  });

  it('getActiveProfile falls back to the first live profile - and remembers it - when the remembered one is gone', async () => {
    const db = await freshDb();
    const a = await createProfile(db, { name: 'A' });
    const b = await createProfile(db, { name: 'B' });
    // nothing remembered yet
    await expect(getActiveProfile(db)).resolves.toEqual(a);
    await expect(getActiveProfileId(db)).resolves.toBe(a.id);
    // remembered one deleted behind its back (e.g. restored a backup with a tombstone for it)
    await db.store('meta').put(b.id, 'activeProfileId');
    await deleteProfile(db, b.id);
    await db.store('meta').put(b.id, 'activeProfileId'); // stale pointer survives
    await expect(getActiveProfile(db)).resolves.toEqual(a);
    await expect(getActiveProfileId(db)).resolves.toBe(a.id);
  });

  it('getActiveProfile is undefined when no live profile exists', async () => {
    const db = await freshDb();
    await expect(getActiveProfile(db)).resolves.toBeUndefined();
    const p = await createProfile(db, { name: 'T' });
    await deleteProfile(db, p.id);
    await expect(getActiveProfile(db)).resolves.toBeUndefined();
  });
});

describe('listProfiles ordering', () => {
  it('lists in creation order, and a rename or range save never reshuffles it', async () => {
    const db = await freshDb();
    const first = await createProfile(db, { name: 'First' });
    const second = await createProfile(db, { name: 'Second' });
    const third = await createProfile(db, { name: 'Third' });
    expect((await listProfiles(db)).map((p) => p.id)).toEqual([first.id, second.id, third.id]);

    await renameProfile(db, first.id, 'Renamed');
    await setVocalRange(db, second.id, RANGE);
    expect((await listProfiles(db)).map((p) => p.id)).toEqual([first.id, second.id, third.id]);
  });

  it('profiles created in the same millisecond still list in the order they were created', async () => {
    const db = await openDb(freshName('profiles'), { now: () => 1_800_000_000_000 });
    const created: string[] = [];
    for (let i = 0; i < 8; i++) created.push((await createProfile(db, { name: `P${i}` })).id);
    expect((await listProfiles(db)).map((p) => p.id)).toEqual(created);
    expect((await listProfiles(db)).map((p) => p.id)).toEqual(created); // and the same again
  });
});
