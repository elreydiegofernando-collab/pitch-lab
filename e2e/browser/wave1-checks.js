// Page-side checks for e2e/wave1-browser.e2e.test.ts. Plain ES module JavaScript, served to Chrome next to the Wave 1 bundle
// (so the test file's TypeScript is never serialized into the page). Each function returns plain data the test asserts on.
//
// Why a browser at all: the unit tests run in Node, with fake-indexeddb, a fake OPFS and a hand-rolled Web Audio evaluator.
// These checks drive the same modules through the real thing: IndexedDB + OPFS, and OfflineAudioContext.

const SR = 48000;

/** Finds the namespace of the bundle that exports `key` (the bundle re-exports flat, so this is just a lookup). */
function pick(wave1, key) {
  if (!(key in wave1)) throw new Error(`the Wave 1 bundle does not export ${key}`);
  return wave1[key];
}

/**
 * The storage facade on real IndexedDB and OPFS: save an attempt and a take with audio, read both back, reconcile, delete the
 * take, wipe everything, restore from a backup (twice, to check the import is idempotent). Run it on a fresh page after
 * `phase: 'seed'` to see what survives a relaunch.
 *
 * phase 'seed':   writes data and returns what it wrote plus a backup (JSON text).
 * phase 'verify': (on a NEW page of the same browser context) reads it back, then deletes, wipes and restores.
 */
export async function storageSmoke(wave1, phase, seeded) {
  const getStorage = pick(wave1, 'getStorage');
  const encodeTrack = pick(wave1, 'encodeTrack');
  const newId = pick(wave1, 'newId');
  const encodeWav = pick(wave1, 'encodeWav');
  const s = await getStorage();

  if (phase === 'seed') {
    const out = {};
    out.flags = { persistent: s.persistent, db: s.db.persistent, opfs: s.opfs.persistent, kv: s.kv.persistent, backend: s.opfs.backend };
    const me = await s.profiles.active();
    const frames = Array.from({ length: 188 }, (_, i) => ({ t: i / 93.75, f0Hz: 261.63, midi: 60, centsFromNearest: 0, confidence: 0.95, rmsDb: -20, voiced: true }));
    const samples = new Float32Array(SR);
    for (let i = 0; i < samples.length; i++) samples[i] = 0.3 * Math.sin((2 * Math.PI * 261.63 * i) / SR);
    const wav = encodeWav(samples, SR);
    const takeId = newId();
    const attempt = await s.attempts.add({
      profileId: me.id, exerciseId: 'foundations.sustain.1', levelId: 'foundations.03', kind: 'practice', score: 0.9, passed: true, mastery: 2,
      metrics: { 'accuracy.inTolerancePct': 90 }, durationSec: 16, tonicMidi: 57, tempoBpm: 60, takeId,
    });
    const take = await s.takes.save({ id: takeId, profileId: me.id, exerciseId: 'foundations.sustain.1', track: encodeTrack(frames), audio: wav, sampleRate: SR, latencyMs: 20 });
    const audioBack = await s.takes.audio(take);
    out.take = { audioRef: take.audioRef, wavBytes: wav.byteLength, audioBackBytes: audioBack ? audioBack.size : null };
    out.usage = await s.usage();
    out.reconcile = await s.reconcile();
    out.json = await s.backup.exportJson();
    out.attemptId = attempt.id;
    out.takeId = takeId;
    return out;
  }

  const out = {};
  const me = await s.profiles.active();
  const attempts = await s.attempts.listByProfile(me.id);
  out.afterRelaunch = { attempts: attempts.length, hasAttempt: attempts.some((a) => a.id === seeded.attemptId) };
  const take = await s.takes.get(seeded.takeId);
  const audio = take ? await s.takes.audio(take) : undefined;
  out.takeAfterRelaunch = { present: !!take, audioBytes: audio ? audio.size : null };
  out.reconcileAfterRelaunch = await s.reconcile();
  await s.takes.delete(seeded.takeId);
  out.afterDelete = { take: (await s.takes.get(seeded.takeId)) ?? null, binaryBytes: (await s.usage()).binaryBytes };
  await s.deleteAllData();
  const active = await s.profiles.active();
  out.afterWipe = { attempts: (await s.attempts.listByProfile(active.id)).length, usage: await s.usage() };
  out.import = await s.backup.import(seeded.json);
  const count = async () => {
    let n = 0;
    for (const p of await s.profiles.list()) n += (await s.attempts.listByProfile(p.id)).length;
    return n;
  };
  out.afterImport = { profiles: (await s.profiles.list()).length, attempts: await count() };
  out.secondImport = await s.backup.import(seeded.json);
  out.afterSecondImport = { attempts: await count() };
  return out;
}

/** Reads a rendered demo back through the production Framer + MPM detector, in 128-sample blocks like the worklet. */
function framesOf(wave1, samples) {
  const createDetector = pick(wave1, 'createDetector');
  const Framer = pick(wave1, 'Framer');
  const CONFIG = pick(wave1, 'CONFIG');
  const hopSizeFor = pick(wave1, 'hopSizeFor');
  const { windowSize, minHz, maxHz, mpmK, yinThreshold, minConfidence, minRmsDb, rmsFloorDb } = CONFIG.audio;
  const detector = createDetector('mpm', { sampleRate: SR, windowSize, minHz, maxHz, mpmK, yinThreshold });
  const framer = new Framer({ sampleRate: SR, windowSize, hopSize: hopSizeFor(SR), minHz, maxHz, minConfidence, minRmsDb, rmsFloorDb, detector });
  const out = [];
  for (let i = 0; i < samples.length; i += 128) framer.push(samples.subarray(i, Math.min(samples.length, i + 128)), i, (f) => out.push(f));
  return out;
}

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[s.length >> 1] : NaN;
};

/**
 * Every catalog exercise's Listen demo, built with the real synth into a real OfflineAudioContext and rendered by Chrome:
 * no exception, audible, not clipped, and every sustained note sounds at the pitch the exercise asks for (read back through
 * the detector). Plus the classical-style vibrato demos and the slow-first demos, which are only checked for rendering.
 * Returns { exercises, variants, pitchChecks, problems: string[] }.
 */
export async function demosSmoke(wave1) {
  const EXERCISES = pick(wave1, 'EXERCISES');
  const realize = pick(wave1, 'realize');
  const buildDemo = pick(wave1, 'buildDemo');
  const createSynth = pick(wave1, 'createSynth');

  const START = 0.1;
  const problems = [];
  let variants = 0;
  let pitchChecks = 0;
  for (const def of EXERCISES) {
    const list = [{ name: 'default', opts: { slowFirst: false } }];
    if (def.demo.vibrato === 'style') list.push({ name: 'classical', opts: { slowFirst: false, vibratoStyle: 'classical' } });
    if (def.tempoLadder || def.demo.slowFirst) list.push({ name: 'slow-first', opts: { slowFirst: true } });
    for (const v of list) {
      variants++;
      try {
        const realized = realize(def, null, 'tenor');
        const seconds = realized.countInSec + realized.totalSec + 4;
        const ctx = new OfflineAudioContext(1, Math.ceil(SR * (START + seconds * (v.name === 'slow-first' ? 2.5 : 1))), SR);
        const synth = createSynth(ctx, ctx.destination);
        const handle = buildDemo(def, realized, synth, ctx, ctx.destination, { startAt: START, gain: 0.5, ...v.opts });
        const samples = (await ctx.startRendering()).getChannelData(0);
        let peak = 0;
        for (let i = 0; i < samples.length; i++) {
          if (!Number.isFinite(samples[i])) throw new Error('non-finite sample');
          peak = Math.max(peak, Math.abs(samples[i]));
        }
        if (!(peak > 0.05)) problems.push(`${def.id} [${v.name}]: silent (peak ${peak.toFixed(4)})`);
        if (peak > 1.0001) problems.push(`${def.id} [${v.name}]: clipped (peak ${peak.toFixed(3)})`);
        if (typeof handle?.stop !== 'function') problems.push(`${def.id} [${v.name}]: the handle has no stop()`);
        if (v.name !== 'default') continue;
        // The downbeat sounds after the lead-in: the count-in clicks when the metronome is on, and any reference tone before the downbeat.
        const earliest = Math.min(0, ...(realized.reference ?? []).map((n) => n.start), ...realized.notes.map((n) => n.start));
        const downbeat = START + Math.max(def.metronome ? realized.countInSec : 0, -earliest);
        const fs = framesOf(wave1, samples);
        for (const n of realized.notes) {
          if (n.toMidi !== undefined || n.end - n.start < 1.2) continue;
          const inside = fs.filter((f) => f.voiced && f.t >= downbeat + n.start + 0.4 && f.t < downbeat + n.end - 0.25);
          if (inside.length < 10) {
            problems.push(`${def.id}: the note ${n.midi} at ${n.start.toFixed(2)} s has only ${inside.length} voiced frames`);
            continue;
          }
          pitchChecks++;
          const cents = (median(inside.map((f) => f.midi)) - n.midi) * 100;
          if (Math.abs(cents) > 60) problems.push(`${def.id}: the note ${n.midi} at ${n.start.toFixed(2)} s sounds ${cents.toFixed(0)} cents off`);
        }
      } catch (err) {
        problems.push(`${def.id} [${v.name}]: threw ${err?.name}: ${err?.message}`);
      }
    }
  }
  return { exercises: EXERCISES.length, variants, pitchChecks, problems };
}
