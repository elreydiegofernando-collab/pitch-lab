import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { addAttempt } from './attempts-repo';
import { openDb } from './db';
import { newId } from './ids';
import { openOpfs, type OpfsStore } from './opfs';
import {
  DEFAULT_TAKE_RETENTION,
  deleteTake,
  deleteTakesByProfile,
  getTake,
  getTakeAudio,
  listTakesByProfile,
  resolveTakeRetention,
  saveTake,
  takeAudioPath,
  type SaveTakeInput,
  type TakeRetention,
} from './takes-repo';
import type { TakeRecord } from './schema';
import {
  FlakyOpfs,
  attemptInput,
  dbWithFailingStore,
  emptyTrack,
  freshName,
  installNoOpfs,
  installOpfsMock,
  lockFilesEndingWith,
  overrideMethod,
  quotaError,
} from './test-helpers';

afterEach(() => {
  vi.unstubAllGlobals();
});

async function setup() {
  installNoOpfs(); // the idb-blob backend: enough to exercise the repo, and it has real size accounting
  const db = await openDb(freshName('takes'));
  const opfs = await openOpfs({ fallbackDbName: freshName('bin') });
  return { db, opfs };
}

function input(overrides: Partial<SaveTakeInput> = {}): SaveTakeInput {
  return { profileId: 'p1', exerciseId: 'sustain', track: emptyTrack(), sampleRate: 48000, latencyMs: 20, ...overrides };
}

/** n bytes of audio. */
const audio = (n: number, fill = 'a') => new Blob([fill.repeat(n)]);

const retention = (r: Partial<TakeRetention>) => ({ retention: r });

describe('saveTake', () => {
  it('saves a track-only take (no audio) with audioRef null and writes no binary', async () => {
    const { db, opfs } = await setup();
    const take = await saveTake(db, opfs, input());
    expect(take.audioRef).toBeNull();
    expect(take.deletedAt).toBeNull();
    expect(take.sampleRate).toBe(48000);
    expect(take.latencyMs).toBe(20);
    await expect(getTake(db, take.id)).resolves.toEqual(take);
    await expect(getTakeAudio(opfs, take)).resolves.toBeUndefined();
    expect(await opfs.list()).toEqual([]);
  });

  it.each([
    ['a Blob', () => new Blob(['wav-bytes'])],
    ['an ArrayBuffer', () => new TextEncoder().encode('wav-bytes').buffer],
    ['a Uint8Array', () => new TextEncoder().encode('wav-bytes')],
  ])('writes audio given as %s to the binary store and records its path as audioRef', async (_label, make) => {
    const { db, opfs } = await setup();
    const take = await saveTake(db, opfs, input({ audio: make() as Blob }));
    expect(take.audioRef).toBe(takeAudioPath(take.id));
    expect(take.audioRef).toBe(`takes/${take.id}.wav`);
    expect(await (await getTakeAudio(opfs, take))?.text()).toBe('wav-bytes');
  });

  it('treats zero-length audio as no audio', async () => {
    const { db, opfs } = await setup();
    const take = await saveTake(db, opfs, input({ audio: new Blob([]) }));
    expect(take.audioRef).toBeNull();
    expect(await opfs.list()).toEqual([]);
  });

  it('normalises sampleRate to null when it is not a number', async () => {
    const { db, opfs } = await setup();
    expect((await saveTake(db, opfs, input({ sampleRate: null }))).sampleRate).toBeNull();
    expect((await saveTake(db, opfs, input({ sampleRate: NaN }))).sampleRate).toBeNull();
  });

  const invalid: Array<[string, Partial<SaveTakeInput>]> = [
    ['an empty profileId', { profileId: '' }],
    ['an empty exerciseId', { exerciseId: '' }],
    ['a track that is not a stored track', { track: { nope: true } as never }],
    ['a track with a non-positive frame rate', { track: { ...emptyTrack(), frameRate: 0 } }],
    ['a non-finite latency', { latencyMs: NaN }],
  ];
  it.each(invalid)('rejects %s, writing neither a record nor a binary', async (_label, overrides) => {
    const { db, opfs } = await setup();
    await expect(saveTake(db, opfs, input({ ...overrides, audio: audio(10) }))).rejects.toThrow(TypeError);
    await expect(db.store('takes').count()).resolves.toBe(0);
    expect(await opfs.list()).toEqual([]);
  });

  it('removes the binary again if the record cannot be written (no orphan audio)', async () => {
    const { db, opfs } = await setup();
    const broken = dbWithFailingStore(db, 'takes', 'add', new Error('disk full'));
    await expect(saveTake(broken, opfs, input({ audio: audio(10) }))).rejects.toThrow('disk full');
    expect(await opfs.list()).toEqual([]);
  });

  it('writes the binary BEFORE the record (a crash in between leaves an orphan file, never a dangling reference)', async () => {
    const { db, opfs } = await setup();
    const order: string[] = [];
    const spyOpfs = overrideMethod(opfs, 'write', async (path: string, data: Blob) => {
      order.push('binary');
      return opfs.write(path, data);
    });
    const spyDb = overrideMethod(db, 'store', (name: string) => {
      const store = db.store(name as never);
      return name === 'takes'
        ? overrideMethod(store, 'add', async (value: unknown, key: string) => {
            order.push('record');
            return (store as { add(v: unknown, k: string): Promise<void> }).add(value, key);
          })
        : store;
    });
    await saveTake(spyDb, spyOpfs, input({ audio: audio(10) }));
    expect(order).toEqual(['binary', 'record']);
  });
});

describe('saveTake with a pre-allocated id (attempt first, take second)', () => {
  it('uses the given id, so an attempt that already references it stays valid', async () => {
    const { db, opfs } = await setup();
    const id = newId();
    const attempt = await addAttempt(db, attemptInput('p1', { takeId: id })); // durable first
    const take = await saveTake(db, opfs, input({ id, audio: audio(8) })); // the slower write follows
    expect(take.id).toBe(id);
    expect(take.audioRef).toBe(`takes/${id}.wav`);
    expect(attempt.takeId).toBe(take.id);
    await expect(getTake(db, id)).resolves.toEqual(take);
  });

  it('rejects an id that is already taken - without touching the existing take or its audio', async () => {
    const { db, opfs } = await setup();
    const first = await saveTake(db, opfs, input({ audio: audio(8, 'a') }));
    await expect(saveTake(db, opfs, input({ id: first.id, audio: audio(8, 'b') }))).rejects.toThrow(/already exists/);
    expect(await (await getTakeAudio(opfs, first))?.text()).toBe('a'.repeat(8)); // not overwritten
    await expect(getTake(db, first.id)).resolves.toEqual(first);
  });

  it.each([[''], ['a/b'], ['../x'], ['has space'], ['x'.repeat(200)], [42 as unknown as string]])('rejects the unusable id %j', async (bad) => {
    const { db, opfs } = await setup();
    await expect(saveTake(db, opfs, input({ id: bad, audio: audio(3) }))).rejects.toThrow(TypeError);
    expect(await opfs.list()).toEqual([]);
    await expect(db.store('takes').count()).resolves.toBe(0);
  });
});

describe('listTakesByProfile', () => {
  it('lists a profile\'s takes oldest first, in exact save order, even within one millisecond', async () => {
    const { db, opfs } = await setup();
    const frozen = await openDb(freshName('takes'), { now: () => 1_800_000_000_000 });
    const saved: TakeRecord[] = [];
    for (let i = 0; i < 10; i++) saved.push(await saveTake(frozen, opfs, input(), retention({ maxTakesPerProfile: Infinity })));
    expect((await listTakesByProfile(frozen, 'p1')).map((t) => t.id)).toEqual(saved.map((t) => t.id));
    void db;
  });

  it('scopes to the profile', async () => {
    const { db, opfs } = await setup();
    const a = await saveTake(db, opfs, input({ profileId: 'p1' }));
    await saveTake(db, opfs, input({ profileId: 'p2' }));
    expect((await listTakesByProfile(db, 'p1')).map((t) => t.id)).toEqual([a.id]);
  });
});

describe('deleteTake / deleteTakesByProfile', () => {
  it('removes both the record and its binary', async () => {
    const { db, opfs } = await setup();
    const take = await saveTake(db, opfs, input({ audio: audio(5) }));
    await deleteTake(db, opfs, take.id);
    await expect(getTake(db, take.id)).resolves.toBeUndefined();
    await expect(opfs.read(take.audioRef!)).resolves.toBeUndefined();
  });

  it('deleting a take with no audio, or one that does not exist, is a no-op for the binary store', async () => {
    const { db, opfs } = await setup();
    const keeper = await saveTake(db, opfs, input({ audio: audio(5) }));
    const take = await saveTake(db, opfs, input());
    await expect(deleteTake(db, opfs, take.id)).resolves.toBeUndefined();
    await expect(deleteTake(db, opfs, 'never-existed')).resolves.toBeUndefined();
    await expect(opfs.read(keeper.audioRef!)).resolves.toBeDefined();
  });

  it("deletes the audio even if the record delete then fails (the audio is the sensitive part)", async () => {
    const { db, opfs } = await setup();
    const take = await saveTake(db, opfs, input({ audio: audio(5) }));
    const broken = dbWithFailingStore(db, 'takes', 'delete', new Error('boom'));
    await expect(deleteTake(broken, opfs, take.id)).rejects.toThrow('boom');
    await expect(opfs.read(take.audioRef!)).resolves.toBeUndefined();
  });

  it('deleteTakesByProfile removes one profile\'s takes and audio, and reports how many', async () => {
    const { db, opfs } = await setup();
    const mine1 = await saveTake(db, opfs, input({ profileId: 'p1', audio: audio(3) }));
    await saveTake(db, opfs, input({ profileId: 'p1' }));
    const theirs = await saveTake(db, opfs, input({ profileId: 'p2', audio: audio(3) }));
    await expect(deleteTakesByProfile(db, opfs, 'p1')).resolves.toBe(2);
    await expect(listTakesByProfile(db, 'p1')).resolves.toEqual([]);
    await expect(opfs.read(mine1.audioRef!)).resolves.toBeUndefined();
    await expect(getTake(db, theirs.id)).resolves.toBeDefined();
    await expect(opfs.read(theirs.audioRef!)).resolves.toBeDefined();
    await expect(deleteTakesByProfile(db, opfs, 'p1')).resolves.toBe(0);
  });
});

describe('retention: per-profile take cap', () => {
  it('keeps at most maxTakesPerProfile takes, evicting the oldest first, record and audio together', async () => {
    const { db, opfs } = await setup();
    const saved: TakeRecord[] = [];
    for (let i = 0; i < 5; i++) saved.push(await saveTake(db, opfs, input({ audio: audio(4, String(i)) }), retention({ maxTakesPerProfile: 3 })));
    expect((await listTakesByProfile(db, 'p1')).map((t) => t.id)).toEqual([saved[2].id, saved[3].id, saved[4].id]);
    await expect(getTake(db, saved[0].id)).resolves.toBeUndefined();
    await expect(getTake(db, saved[1].id)).resolves.toBeUndefined();
    expect((await opfs.list()).sort()).toEqual(saved.slice(2).map((t) => t.audioRef!).sort());
  });

  it('does not evict across different profiles', async () => {
    const { db, opfs } = await setup();
    await saveTake(db, opfs, input({ profileId: 'p1' }), retention({ maxTakesPerProfile: 1 }));
    await saveTake(db, opfs, input({ profileId: 'p2' }), retention({ maxTakesPerProfile: 1 }));
    expect(await listTakesByProfile(db, 'p1')).toHaveLength(1);
    expect(await listTakesByProfile(db, 'p2')).toHaveLength(1);
  });

  it('Infinity disables the cap', async () => {
    const { db, opfs } = await setup();
    for (let i = 0; i < 6; i++) await saveTake(db, opfs, input(), retention({ maxTakesPerProfile: Infinity }));
    expect(await listTakesByProfile(db, 'p1')).toHaveLength(6);
  });

  it('applies the default cap when none is given', async () => {
    const { db, opfs } = await setup();
    const cap = DEFAULT_TAKE_RETENTION.maxTakesPerProfile;
    for (let i = 0; i < cap + 3; i++) await saveTake(db, opfs, input());
    expect(await listTakesByProfile(db, 'p1')).toHaveLength(cap);
  });

  it('the take just saved always survives, even with a cap of 1', async () => {
    const { db, opfs } = await setup();
    await saveTake(db, opfs, input(), retention({ maxTakesPerProfile: 1 }));
    const latest = await saveTake(db, opfs, input({ audio: audio(2) }), retention({ maxTakesPerProfile: 1 }));
    expect((await listTakesByProfile(db, 'p1')).map((t) => t.id)).toEqual([latest.id]);
  });
});

describe('retention: audio byte budget', () => {
  it('strips the audio of the oldest takes (their record and pitch track stay) until under budget', async () => {
    const { db, opfs } = await setup();
    const opts = retention({ maxTakesPerProfile: Infinity, maxAudioBytes: 100 });
    const t1 = await saveTake(db, opfs, input({ audio: audio(40) }), opts);
    const t2 = await saveTake(db, opfs, input({ audio: audio(40) }), opts);
    const t3 = await saveTake(db, opfs, input({ audio: audio(40) }), opts); // 120 > 100: t1's audio goes

    await expect(getTake(db, t1.id)).resolves.toMatchObject({ audioRef: null, track: t1.track });
    await expect(getTake(db, t2.id)).resolves.toMatchObject({ audioRef: t2.audioRef });
    await expect(getTake(db, t3.id)).resolves.toMatchObject({ audioRef: t3.audioRef });
    expect((await opfs.list()).sort()).toEqual([t2.audioRef, t3.audioRef].sort());
    await expect(opfs.totalBytes()).resolves.toBe(80);
  });

  it('counts audio across profiles, evicting the globally oldest', async () => {
    const { db, opfs } = await setup();
    const opts = retention({ maxTakesPerProfile: Infinity, maxAudioBytes: 100 });
    const a = await saveTake(db, opfs, input({ profileId: 'pA', audio: audio(60) }), opts);
    const b = await saveTake(db, opfs, input({ profileId: 'pB', audio: audio(60) }), opts);
    await expect(getTake(db, a.id)).resolves.toMatchObject({ audioRef: null });
    await expect(getTake(db, b.id)).resolves.toMatchObject({ audioRef: b.audioRef });
  });

  it('never strips the take just saved, even if it alone exceeds the budget', async () => {
    const { db, opfs } = await setup();
    const old = await saveTake(db, opfs, input({ audio: audio(10) }), retention({ maxAudioBytes: 50 }));
    const big = await saveTake(db, opfs, input({ audio: audio(80) }), retention({ maxAudioBytes: 50 }));
    await expect(getTake(db, big.id)).resolves.toMatchObject({ audioRef: big.audioRef });
    await expect(getTake(db, old.id)).resolves.toMatchObject({ audioRef: null });
  });

  it('Infinity disables the budget', async () => {
    const { db, opfs } = await setup();
    const opts = retention({ maxTakesPerProfile: Infinity, maxAudioBytes: Infinity });
    for (let i = 0; i < 4; i++) await saveTake(db, opfs, input({ audio: audio(1000) }), opts);
    await expect(opfs.totalBytes()).resolves.toBe(4000);
  });

  it('a stripped take no longer has audio to read', async () => {
    const { db, opfs } = await setup();
    const opts = retention({ maxAudioBytes: 10 });
    const first = await saveTake(db, opfs, input({ audio: audio(8) }), opts);
    await saveTake(db, opfs, input({ audio: audio(8) }), opts);
    const stripped = (await getTake(db, first.id))!;
    expect(stripped.audioRef).toBeNull();
    await expect(getTakeAudio(opfs, stripped)).resolves.toBeUndefined();
  });

  it('stripping audio does not reorder takes (they still evict oldest-first)', async () => {
    const { db, opfs } = await setup();
    const opts = retention({ maxTakesPerProfile: 3, maxAudioBytes: 50 });
    const saved: TakeRecord[] = [];
    for (let i = 0; i < 3; i++) saved.push(await saveTake(db, opfs, input({ audio: audio(30) }), opts));
    // saved[0] and saved[1] have been stripped by now; saving a 4th must evict saved[0] outright, not saved[2]
    const fourth = await saveTake(db, opfs, input({ audio: audio(30) }), opts);
    expect((await listTakesByProfile(db, 'p1')).map((t) => t.id)).toEqual([saved[1].id, saved[2].id, fourth.id]);
  });
});

describe('retention settings', () => {
  it('resolveTakeRetention fills defaults and ignores nonsense', () => {
    expect(resolveTakeRetention()).toEqual(DEFAULT_TAKE_RETENTION);
    expect(resolveTakeRetention({ maxTakesPerProfile: 7.9, maxAudioBytes: 1234 })).toEqual({ maxTakesPerProfile: 7, maxAudioBytes: 1234 });
    for (const bad of [0, -3, NaN, '5' as unknown as number]) {
      expect(resolveTakeRetention({ maxTakesPerProfile: bad, maxAudioBytes: bad })).toEqual(DEFAULT_TAKE_RETENTION);
    }
    expect(resolveTakeRetention({ maxTakesPerProfile: Infinity, maxAudioBytes: Infinity })).toEqual({ maxTakesPerProfile: Infinity, maxAudioBytes: Infinity });
    expect(resolveTakeRetention({ maxTakesPerProfile: 0.4 }).maxTakesPerProfile).toBe(1); // a positive cap is never rounded down to "keep nothing"
    expect(resolveTakeRetention({ maxTakesPerProfile: 1.5 }).maxTakesPerProfile).toBe(1);
  });

  it('the default object is frozen', () => {
    expect(Object.isFrozen(DEFAULT_TAKE_RETENTION)).toBe(true);
  });
});

describe('a full device never costs the singer a take or an attempt', () => {
  it('quota on the audio write: evicts the oldest audio, retries, and keeps the new audio', async () => {
    const { db, opfs: real } = await setup();
    const opfs: OpfsStore = new FlakyOpfs(real, []);
    const old = await saveTake(db, opfs, input({ audio: audio(20) }));

    (opfs as FlakyOpfs).writePlan = [quotaError()]; // the very next write hits "disk full"
    const fresh = await saveTake(db, opfs, input({ audio: audio(20, 'b') }));

    expect(fresh.audioRef).toBe(takeAudioPath(fresh.id));
    expect(await (await getTakeAudio(opfs, fresh))?.text()).toBe('b'.repeat(20));
    await expect(getTake(db, old.id)).resolves.toMatchObject({ audioRef: null, track: old.track }); // freed for the new one
  });

  it('keeps evicting, oldest first, until the write fits', async () => {
    const { db, opfs: real } = await setup();
    const opfs = new FlakyOpfs(real, []);
    const opts = retention({ maxTakesPerProfile: Infinity, maxAudioBytes: Infinity });
    const t1 = await saveTake(db, opfs, input({ audio: audio(5) }), opts);
    const t2 = await saveTake(db, opfs, input({ audio: audio(5) }), opts);
    const t3 = await saveTake(db, opfs, input({ audio: audio(5) }), opts);

    opfs.writePlan = [quotaError(), quotaError()];
    const fresh = await saveTake(db, opfs, input({ audio: audio(5, 'z') }), opts);
    expect(fresh.audioRef).not.toBeNull();
    await expect(getTake(db, t1.id)).resolves.toMatchObject({ audioRef: null });
    await expect(getTake(db, t2.id)).resolves.toMatchObject({ audioRef: null });
    await expect(getTake(db, t3.id)).resolves.toMatchObject({ audioRef: t3.audioRef });
  });

  it('still full with nothing left to evict: the take is saved WITHOUT audio', async () => {
    const { db, opfs: real } = await setup();
    const opfs = new FlakyOpfs(real, [quotaError(), quotaError(), quotaError(), quotaError(), quotaError()]);
    const take = await saveTake(db, opfs, input({ audio: audio(20) }));
    expect(take.audioRef).toBeNull();
    await expect(getTake(db, take.id)).resolves.toEqual(take);
    expect(await real.list()).toEqual([]);
  });

  it('gives up after a bounded number of attempts rather than wiping every recording: exactly 4 writes and 3 evictions', async () => {
    const { db, opfs: real } = await setup();
    const opfs = new FlakyOpfs(real, []);
    const opts = retention({ maxTakesPerProfile: Infinity, maxAudioBytes: Infinity });
    for (let i = 0; i < 8; i++) await saveTake(db, opfs, input({ audio: audio(5) }), opts);
    const writesBefore = opfs.writes;
    opfs.writePlan = Array.from({ length: 20 }, () => quotaError()); // the device never has room
    const take = await saveTake(db, opfs, input({ audio: audio(5) }), opts);
    expect(take.audioRef).toBeNull();
    expect(opfs.writes - writesBefore).toBe(4); // the attempts the constant allows, not one more
    const withAudio = (await listTakesByProfile(db, 'p1')).filter((t) => t.audioRef);
    expect(withAudio).toHaveLength(5); // 8 - 3: an eviction between attempts, never one after the last write
  });

  it('a single quota error sacrifices exactly one recording', async () => {
    const { db, opfs: real } = await setup();
    const opfs = new FlakyOpfs(real, []);
    const opts = retention({ maxTakesPerProfile: Infinity, maxAudioBytes: Infinity });
    for (let i = 0; i < 3; i++) await saveTake(db, opfs, input({ audio: audio(5) }), opts);
    opfs.writePlan = [quotaError()];
    const fresh = await saveTake(db, opfs, input({ audio: audio(5) }), opts);
    expect(fresh.audioRef).not.toBeNull();
    expect((await listTakesByProfile(db, 'p1')).filter((t) => t.audioRef)).toHaveLength(3); // 3 old - 1 evicted + the new one
  });

  it('any other audio failure: saved without audio, and no other recording is touched', async () => {
    const { db, opfs: real } = await setup();
    const opfs = new FlakyOpfs(real, []);
    const old = await saveTake(db, opfs, input({ audio: audio(20) }));
    opfs.writePlan = [new Error('OPFS exploded')];
    const take = await saveTake(db, opfs, input({ audio: audio(20) }));
    expect(take.audioRef).toBeNull();
    await expect(getTake(db, old.id)).resolves.toMatchObject({ audioRef: old.audioRef });
  });

  it('a retention failure never fails a save that already succeeded', async () => {
    const { db, opfs: real } = await setup();
    const first = await saveTake(db, real, input({ audio: audio(5) }), retention({ maxTakesPerProfile: 1 }));
    const opfs = overrideMethod(real, 'delete', async () => {
      throw new Error('cannot delete');
    });
    const second = await saveTake(db, opfs, input({ audio: audio(5) }), retention({ maxTakesPerProfile: 1 }));
    await expect(getTake(db, second.id)).resolves.toBeDefined();
    void first;
  });
});

describe('overlapping saves of one pre-allocated id (a double tap, or a retry while the first is in flight)', () => {
  it('the second is refused before it can touch the shared audio path; the first keeps its audio', async () => {
    const { db, opfs } = await setup();
    const id = newId();
    const results = await Promise.allSettled([
      saveTake(db, opfs, input({ id, audio: audio(8, 'a') })),
      saveTake(db, opfs, input({ id, audio: audio(8, 'b') })),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
    const winner = (results.find((r) => r.status === 'fulfilled') as PromiseFulfilledResult<TakeRecord>).value;
    expect(String((results.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason)).toMatch(/already being saved/);

    expect(winner.audioRef).toBe(takeAudioPath(id));
    expect(await opfs.list()).toEqual([winner.audioRef]); // exactly the winner's file
    expect(await (await getTakeAudio(opfs, winner))?.text()).toBe('a'.repeat(8)); // the first call won, and its audio is intact
    await expect(getTake(db, id)).resolves.toEqual(winner);
  });

  it('the id is free again once a save has failed, and a finished save reports "already exists", not "already being saved"', async () => {
    const { db, opfs } = await setup();
    const id = newId();
    const broken = dbWithFailingStore(db, 'takes', 'add', new Error('disk full'));
    await expect(saveTake(broken, opfs, input({ id, audio: audio(4) }))).rejects.toThrow('disk full');
    expect(await opfs.list()).toEqual([]); // the failed save cleaned up its own file

    const retry = await saveTake(db, opfs, input({ id, audio: audio(4) }));
    expect(retry.id).toBe(id);
    await expect(saveTake(db, opfs, input({ id }))).rejects.toThrow(/already exists/);
  });

  it('a rejected duplicate (the id already exists) releases the claim too', async () => {
    const { db, opfs } = await setup();
    const first = await saveTake(db, opfs, input({ audio: audio(3) }));
    for (let i = 0; i < 2; i++) await expect(saveTake(db, opfs, input({ id: first.id, audio: audio(3) }))).rejects.toThrow(/already exists/);
  });

  it('different databases never block each other', async () => {
    const a = await setup();
    const b = await setup();
    const id = newId();
    const results = await Promise.allSettled([saveTake(a.db, a.opfs, input({ id, audio: audio(3) })), saveTake(b.db, b.opfs, input({ id, audio: audio(3) }))]);
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
  });

  it('a ConstraintError from another writer never removes the winner\'s audio', async () => {
    const { db, opfs } = await setup();
    const id = newId();
    // Another tab's save wins the record in the instant between our exists-check and our add (it wrote this very path).
    const raced = overrideMethod(db, 'store', (name: string) => {
      const store = db.store(name as never);
      return name !== 'takes'
        ? store
        : overrideMethod(store, 'add', async (value: TakeRecord, key: string) => {
            await store.put({ ...value, audioRef: takeAudioPath(id) }, key);
            throw new DOMException('Key already exists', 'ConstraintError');
          });
    });
    await expect(saveTake(raced, opfs, input({ id, audio: audio(6, 'x') }))).rejects.toMatchObject({ name: 'ConstraintError' });
    expect(await opfs.list()).toEqual([takeAudioPath(id)]); // the winner's audio is intact
    expect((await getTake(db, id))?.audioRef).toBe(takeAudioPath(id));
  });

  it('if it cannot be told who owns the file after a failed add, the file is kept (reconcile sweeps an orphan; a lost recording is gone for good)', async () => {
    const { db, opfs } = await setup();
    const id = newId();
    let gets = 0;
    const flaky = overrideMethod(db, 'store', (name: string) => {
      const store = db.store(name as never);
      if (name !== 'takes') return store;
      const failingAdd = overrideMethod(store, 'add', async () => {
        throw new Error('disk full');
      });
      return overrideMethod(failingAdd, 'get', async (key: string) => {
        gets += 1;
        if (gets > 1) throw new Error('read hiccup'); // the exists-check passed; the ownership check cannot read
        return store.get(key);
      });
    });
    await expect(saveTake(flaky, opfs, input({ id, audio: audio(4) }))).rejects.toThrow('disk full');
    expect(await opfs.list()).toEqual([takeAudioPath(id)]);
  });
});

describe('deleting audio is verified: a privacy delete never silently leaves the file behind', () => {
  async function setupOpfs() {
    const mock = installOpfsMock();
    const db = await openDb(freshName('takes'));
    const opfs = await openOpfs({ fallbackDbName: freshName('bin') });
    return { mock, db, opfs };
  }

  it('deleteTake rejects, keeping the record, when the audio file will not go - and a retry finishes the job', async () => {
    const { mock, db, opfs } = await setupOpfs();
    const take = await saveTake(db, opfs, input({ audio: audio(5) }));
    mock.control.onRemove = lockFilesEndingWith('.wav');

    await expect(deleteTake(db, opfs, take.id)).rejects.toThrow(/could not be deleted/);
    await expect(getTake(db, take.id)).resolves.toMatchObject({ audioRef: take.audioRef }); // still there to retry
    expect(await opfs.list()).toEqual([take.audioRef]);

    mock.control.onRemove = null;
    await deleteTake(db, opfs, take.id);
    await expect(getTake(db, take.id)).resolves.toBeUndefined();
    expect(await opfs.list()).toEqual([]);
  });

  it('deleteTakesByProfile tries every take, then reports the one that would not go', async () => {
    const { mock, db, opfs } = await setupOpfs();
    const a = await saveTake(db, opfs, input({ audio: audio(3) }));
    const b = await saveTake(db, opfs, input({ audio: audio(3) }));
    const c = await saveTake(db, opfs, input({ audio: audio(3) }));
    mock.control.onRemove = lockFilesEndingWith(`${a.id}.wav`);

    await expect(deleteTakesByProfile(db, opfs, 'p1')).rejects.toThrow(/could not be deleted/);
    await expect(getTake(db, a.id)).resolves.toBeDefined();
    await expect(getTake(db, b.id)).resolves.toBeUndefined(); // the others were still deleted
    await expect(getTake(db, c.id)).resolves.toBeUndefined();

    mock.control.onRemove = null;
    await expect(deleteTakesByProfile(db, opfs, 'p1')).resolves.toBe(1);
    expect(await opfs.list()).toEqual([]);
  });

  it('a failing delete while making room ends the eviction: the new take is saved WITHOUT audio, the old one untouched', async () => {
    const { db, opfs: real } = await setup();
    const flaky = new FlakyOpfs(real, []);
    const old = await saveTake(db, flaky, input({ audio: audio(20) }));
    flaky.writePlan = [quotaError(), quotaError()];
    const stuck = overrideMethod(flaky, 'delete', async () => {
      throw new Error('locked');
    });

    const fresh = await saveTake(db, stuck, input({ audio: audio(20, 'b') }));
    expect(fresh.audioRef).toBeNull();
    await expect(getTake(db, fresh.id)).resolves.toEqual(fresh); // the take itself is never lost to its audio
    await expect(getTake(db, old.id)).resolves.toMatchObject({ audioRef: old.audioRef });
    expect(await real.list()).toEqual([old.audioRef]);
  });

  it('a delete that silently does nothing is not mistaken for freed space', async () => {
    const { db, opfs: real } = await setup();
    const flaky = new FlakyOpfs(real, []);
    const old = await saveTake(db, flaky, input({ audio: audio(20) }));
    const writesBefore = flaky.writes;
    flaky.writePlan = [quotaError(), quotaError(), quotaError()];
    const inert = overrideMethod(flaky, 'delete', async () => {});

    const fresh = await saveTake(db, inert, input({ audio: audio(20, 'b') }));
    expect(fresh.audioRef).toBeNull();
    expect(flaky.writes - writesBefore).toBe(1); // one failed write; nothing was freed, so no pointless retries
    await expect(getTake(db, old.id)).resolves.toMatchObject({ audioRef: old.audioRef }); // its record still matches its file
  });

  it('retention: a take that will not delete does not keep the rest from being trimmed, and is retried by the next save', async () => {
    const { mock, db, opfs } = await setupOpfs();
    const opts = retention({ maxTakesPerProfile: 2, maxAudioBytes: Infinity });
    const a = await saveTake(db, opfs, input({ audio: audio(3) }), opts);
    const b = await saveTake(db, opfs, input({ audio: audio(3) }), opts);
    mock.control.onRemove = lockFilesEndingWith(`${a.id}.wav`);
    const c = await saveTake(db, opfs, input({ audio: audio(3) }), opts); // over the cap: a is the oldest, and stuck
    const d = await saveTake(db, opfs, input({ audio: audio(3) }), opts);

    expect((await listTakesByProfile(db, 'p1')).map((t) => t.id)).toEqual([a.id, c.id, d.id]); // b was trimmed past the stuck a
    await expect(getTake(db, b.id)).resolves.toBeUndefined();

    mock.control.onRemove = null;
    const e = await saveTake(db, opfs, input({ audio: audio(3) }), opts);
    expect((await listTakesByProfile(db, 'p1')).map((t) => t.id)).toEqual([d.id, e.id]);
  });

  it('budget retention: a take whose audio will not go is skipped and the next oldest is stripped instead', async () => {
    const { mock, db, opfs } = await setupOpfs();
    const opts = retention({ maxTakesPerProfile: Infinity, maxAudioBytes: 100 });
    const a = await saveTake(db, opfs, input({ audio: audio(60) }), opts);
    const b = await saveTake(db, opfs, input({ audio: audio(30) }), opts);
    mock.control.onRemove = lockFilesEndingWith(`${a.id}.wav`);
    await saveTake(db, opfs, input({ audio: audio(60) }), opts); // 150 > 100

    await expect(getTake(db, a.id)).resolves.toMatchObject({ audioRef: a.audioRef }); // stuck: left exactly as it is
    await expect(getTake(db, b.id)).resolves.toMatchObject({ audioRef: null }); // stripped instead
  });
});

describe('the default retention', () => {
  it('is 20 takes per profile and 200 MiB of audio', () => {
    expect(DEFAULT_TAKE_RETENTION).toEqual({ maxTakesPerProfile: 20, maxAudioBytes: 200 * 1024 * 1024 });
    expect(DEFAULT_TAKE_RETENTION.maxAudioBytes).toBe(209_715_200);
  });

  it('keeps the audio of four default-sized takes (about 288 KB each: 3 s of 48 kHz 16-bit mono)', async () => {
    const { db, opfs } = await setup();
    const saved: TakeRecord[] = [];
    for (let i = 0; i < 4; i++) saved.push(await saveTake(db, opfs, input({ audio: audio(288_000, String(i)) }))); // no retention override: the defaults apply
    for (const take of saved) {
      const stored = await getTake(db, take.id);
      expect(stored?.audioRef).toBe(take.audioRef);
      expect(stored?.audioRef).not.toBeNull();
    }
    await expect(opfs.totalBytes()).resolves.toBe(4 * 288_000);
  });
});
