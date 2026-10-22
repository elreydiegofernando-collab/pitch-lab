import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import {
  ATTEMPT_KINDS,
  addAttempt,
  getAttempt,
  listAttemptsByExercise,
  listAttemptsByProfile,
  normalizeAttemptFields,
  sanitizeMetrics,
  type NewAttempt,
} from './attempts-repo';
import { openDb } from './db';
import { isHlc } from './hlc';
import type { AttemptRecord } from './schema';
import { attemptInput, freshName } from './test-helpers';

function freshDb() {
  return openDb(freshName('attempts'));
}

describe('addAttempt', () => {
  it('appends a record with a generated id, createdAt, HLC updatedAt and no tombstone', async () => {
    const db = await freshDb();
    const a = await addAttempt(db, attemptInput('p1'));
    expect(a.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(a.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
    expect(isHlc(a.updatedAt)).toBe(true);
    expect(a.deletedAt).toBeNull();
    await expect(getAttempt(db, a.id)).resolves.toEqual(a);
  });

  it('stamps createdAt from the db clock', async () => {
    const db = await openDb(freshName('attempts'), { now: () => Date.UTC(2031, 4, 6, 7, 8, 9, 10) });
    const a = await addAttempt(db, attemptInput('p1'));
    expect(a.createdAt).toBe('2031-05-06T07:08:09.010Z');
  });

  it('two attempts never collide on id even when appended back to back', async () => {
    const db = await freshDb();
    const ids = new Set<string>();
    for (let i = 0; i < 50; i++) ids.add((await addAttempt(db, attemptInput('p1'))).id);
    expect(ids.size).toBe(50);
  });

  it('is committed to disk by the time it resolves: a second connection sees it at once', async () => {
    const name = freshName('attempts');
    const writer = await openDb(name);
    const reader = await openDb(name);
    const a = await addAttempt(writer, attemptInput('p1', { score: 0.42 }));
    await expect(getAttempt(reader, a.id)).resolves.toMatchObject({ score: 0.42 });
  });

  it('stores only the record fields (nothing extra the caller happened to pass)', async () => {
    const db = await freshDb();
    const sneaky = { ...attemptInput('p1'), audio: 'raw samples', extra: 1 } as NewAttempt;
    const a = await addAttempt(db, sneaky);
    expect(Object.keys(a).sort()).toEqual(
      ['createdAt', 'deletedAt', 'durationSec', 'exerciseId', 'id', 'kind', 'levelId', 'mastery', 'metrics', 'passed', 'profileId', 'score', 'takeId', 'tempoBpm', 'tonicMidi', 'updatedAt'].sort(),
    );
  });

  it('keeps songId when given (string or null) and omits it otherwise', async () => {
    const db = await freshDb();
    expect((await addAttempt(db, attemptInput('p1', { songId: 'song-1' }))).songId).toBe('song-1');
    expect((await addAttempt(db, attemptInput('p1', { songId: null }))).songId).toBeNull();
    expect('songId' in (await addAttempt(db, attemptInput('p1')))).toBe(false);
  });

  it('copies metrics: changing the caller object afterwards does not change the stored row', async () => {
    const db = await freshDb();
    const input = attemptInput('p1', { metrics: { 'accuracy.inTolerancePct': 80 } });
    const a = await addAttempt(db, input);
    input.metrics['accuracy.inTolerancePct'] = 1;
    a.metrics['accuracy.inTolerancePct'] = 2;
    expect((await getAttempt(db, a.id))?.metrics).toEqual({ 'accuracy.inTolerancePct': 80 });
  });
});

describe('input validation (a corrupt row must never reach the log)', () => {
  const bad: Array<[string, unknown]> = [
    ['no profileId', { ...attemptInput('p1'), profileId: '' }],
    ['non-string profileId', { ...attemptInput('p1'), profileId: 7 }],
    ['no exerciseId', { ...attemptInput('p1'), exerciseId: undefined }],
    ['over-long id', { ...attemptInput('p1'), exerciseId: 'x'.repeat(500) }],
    ['unknown kind', { ...attemptInput('p1'), kind: 'karaoke' }],
    ['NaN score', { ...attemptInput('p1'), score: NaN }],
    ['string score', { ...attemptInput('p1'), score: '0.9' }],
    ['non-boolean passed', { ...attemptInput('p1'), passed: 1 }],
    ['mastery 4', { ...attemptInput('p1'), mastery: 4 }],
    ['string mastery', { ...attemptInput('p1'), mastery: '1' }],
    ['non-finite duration', { ...attemptInput('p1'), durationSec: Infinity }],
    ['null', null],
    ['a string', 'attempt'],
  ];

  it.each(bad)('rejects %s, storing nothing', async (_label, input) => {
    const db = await freshDb();
    await expect(addAttempt(db, input as NewAttempt)).rejects.toThrow(TypeError);
    await expect(db.store('attempts').count()).resolves.toBe(0);
  });

  it('accepts every documented attempt kind', async () => {
    const db = await freshDb();
    for (const kind of ATTEMPT_KINDS) await addAttempt(db, attemptInput('p1', { kind }));
    await expect(db.store('attempts').count()).resolves.toBe(ATTEMPT_KINDS.length);
  });

  it('clamps and normalises instead of rejecting numeric slop', () => {
    const f = normalizeAttemptFields({ ...attemptInput('p1'), score: 1.7, durationSec: -3, tonicMidi: NaN, tempoBpm: Infinity, takeId: '', levelId: undefined });
    expect(f.score).toBe(1);
    expect(f.durationSec).toBe(0);
    expect(f.tonicMidi).toBeNull();
    expect(f.tempoBpm).toBeNull();
    expect(f.takeId).toBeNull();
    expect(f.levelId).toBeNull();
    expect(normalizeAttemptFields({ ...attemptInput('p1'), score: -0.5 }).score).toBe(0);
  });
});

describe('sanitizeMetrics', () => {
  it('keeps finite numbers under well-formed metric keys', () => {
    expect(sanitizeMetrics({ 'accuracy.inTolerancePct': 80, 'vibrato.rateHz': 5.5, 'run.score': 0 })).toEqual({
      'accuracy.inTolerancePct': 80,
      'vibrato.rateHz': 5.5,
      'run.score': 0,
    });
  });

  it('drops NaN, Infinity and non-numbers (none survive a JSON backup)', () => {
    expect(sanitizeMetrics({ 'a.b': NaN, 'c.d': Infinity, 'e.f': -Infinity, 'g.h': '5', 'i.j': null, 'k.l': 3 })).toEqual({ 'k.l': 3 });
  });

  it('drops malformed and dangerous keys', () => {
    const poisoned = JSON.parse('{"__proto__": 1, "constructor": 2, "nodot": 3, "has space.x": 4, "ok.key": 5}') as Record<string, unknown>;
    const clean = sanitizeMetrics(poisoned);
    expect(clean).toEqual({ 'ok.key': 5 });
    expect(Object.getPrototypeOf(clean)).toBe(Object.prototype);
  });

  it('caps the number of keys', () => {
    const many: Record<string, number> = {};
    for (let i = 0; i < 200; i++) many[`group.m${i}`] = i;
    expect(Object.keys(sanitizeMetrics(many))).toHaveLength(64);
  });

  it('returns an empty object for anything that is not a plain object', () => {
    for (const v of [null, undefined, 5, 'x', [], [1, 2]]) expect(sanitizeMetrics(v)).toEqual({});
  });
});

describe('append-only enforcement', () => {
  it('exposes no way to update or delete an attempt', async () => {
    const mod = await import('./attempts-repo');
    const names = Object.keys(mod);
    expect(names).toEqual(expect.arrayContaining(['addAttempt', 'getAttempt', 'listAttemptsByProfile', 'listAttemptsByExercise']));
    expect(names.some((n) => /update|delete|remove|mutate|edit|set[A-Z]/i.test(n))).toBe(false);
  });

  it('the underlying store rejects writing a second row at the same id', async () => {
    const db = await freshDb();
    const a = await addAttempt(db, attemptInput('p1'));
    await expect(db.store<unknown>('attempts').add({ ...a, score: 0 }, a.id)).rejects.toBeDefined();
    await expect(getAttempt(db, a.id)).resolves.toMatchObject({ score: a.score });
  });

  it('records handed out are copies: mutating one never changes the log', async () => {
    const db = await freshDb();
    const a = await addAttempt(db, attemptInput('p1', { score: 0.5 }));
    const read = (await getAttempt(db, a.id))!;
    read.score = 0;
    read.passed = false;
    (await listAttemptsByProfile(db, 'p1'))[0].score = 0;
    await expect(getAttempt(db, a.id)).resolves.toMatchObject({ score: 0.5, passed: true });
  });
});

describe('listAttemptsByProfile / listAttemptsByExercise', () => {
  it('lists only the given profile, oldest first', async () => {
    const db = await freshDb();
    const a1 = await addAttempt(db, attemptInput('p1'));
    const a2 = await addAttempt(db, attemptInput('p1'));
    await addAttempt(db, attemptInput('p2'));
    expect((await listAttemptsByProfile(db, 'p1')).map((a) => a.id)).toEqual([a1.id, a2.id]);
    await expect(listAttemptsByProfile(db, 'nobody')).resolves.toEqual([]);
  });

  it('filters by exercise within a profile', async () => {
    const db = await freshDb();
    const sustain1 = await addAttempt(db, attemptInput('p1', { exerciseId: 'sustain' }));
    const sustain2 = await addAttempt(db, attemptInput('p1', { exerciseId: 'sustain' }));
    await addAttempt(db, attemptInput('p1', { exerciseId: 'siren' }));
    await addAttempt(db, attemptInput('p2', { exerciseId: 'sustain' })); // another profile, same exercise
    expect((await listAttemptsByExercise(db, 'p1', 'sustain')).map((a) => a.id)).toEqual([sustain1.id, sustain2.id]);
    await expect(listAttemptsByExercise(db, 'p1', 'nothing')).resolves.toEqual([]);
  });

  it('preserves append order even when every call lands in the same wall-clock millisecond', async () => {
    const db = await openDb(freshName('attempts'), { now: () => 1_800_000_000_000 });
    const appended: AttemptRecord[] = [];
    for (let i = 0; i < 25; i++) appended.push(await addAttempt(db, attemptInput('p1')));
    expect((await listAttemptsByProfile(db, 'p1')).map((a) => a.id)).toEqual(appended.map((a) => a.id));
  });

  it('preserves append order when the wall clock steps BACKWARD mid-session', async () => {
    let t = 1_800_000_100_000;
    const db = await openDb(freshName('attempts'), { now: () => (t -= 250) }); // every reading is earlier than the last
    const appended: AttemptRecord[] = [];
    for (let i = 0; i < 12; i++) appended.push(await addAttempt(db, attemptInput('p1')));
    // createdAt really did go backward...
    expect(appended[11].createdAt < appended[0].createdAt).toBe(true);
    // ...but the log still replays in the order the attempts were made.
    expect((await listAttemptsByProfile(db, 'p1')).map((a) => a.id)).toEqual(appended.map((a) => a.id));
    expect((await listAttemptsByExercise(db, 'p1', 'foundations.sustain.1')).map((a) => a.id)).toEqual(appended.map((a) => a.id));
  });

  it('many concurrent appends all land, in the order they were called', async () => {
    const db = await freshDb();
    const added = await Promise.all(Array.from({ length: 60 }, (_, i) => addAttempt(db, attemptInput('p1', { score: i / 100 }))));
    const listed = await listAttemptsByProfile(db, 'p1');
    expect(listed.map((a) => a.id)).toEqual(added.map((a) => a.id));
    expect(listed.map((a) => a.score)).toEqual(added.map((a) => a.score));
  });

  it('handles a large log', async () => {
    const db = await freshDb();
    const entries: Array<[string, AttemptRecord]> = [];
    for (let i = 0; i < 3000; i++) {
      const id = `bulk-${String(i).padStart(5, '0')}`;
      entries.push([id, { ...attemptInput('p1'), id, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: db.nextTimestamp(), deletedAt: null }]);
    }
    await db.store<AttemptRecord>('attempts').addMissing(entries);
    const list = await listAttemptsByProfile(db, 'p1');
    expect(list).toHaveLength(3000);
    expect(list.map((a) => a.id)).toEqual(entries.map(([id]) => id));
  });

  describe('tombstoned rows (none are written locally, but a merge may bring some)', () => {
    async function seeded() {
      const db = await freshDb();
      const live = await addAttempt(db, attemptInput('p1'));
      const dead: AttemptRecord = { ...live, id: 'dead-1', updatedAt: db.nextTimestamp(), deletedAt: '2026-02-02T00:00:00.000Z' };
      await db.store<AttemptRecord>('attempts').add(dead, dead.id);
      return { db, live, dead };
    }

    it('are hidden by default', async () => {
      const { db, live } = await seeded();
      expect((await listAttemptsByProfile(db, 'p1')).map((a) => a.id)).toEqual([live.id]);
      expect((await listAttemptsByExercise(db, 'p1', live.exerciseId)).map((a) => a.id)).toEqual([live.id]);
      await expect(getAttempt(db, 'dead-1')).resolves.toBeUndefined();
    });

    it('can be included on request', async () => {
      const { db, live, dead } = await seeded();
      expect((await listAttemptsByProfile(db, 'p1', { includeDeleted: true })).map((a) => a.id)).toEqual([live.id, dead.id]);
      expect((await listAttemptsByExercise(db, 'p1', live.exerciseId, { includeDeleted: true })).map((a) => a.id)).toEqual([live.id, dead.id]);
      await expect(getAttempt(db, 'dead-1', { includeDeleted: true })).resolves.toMatchObject({ id: 'dead-1' });
    });
  });
});
