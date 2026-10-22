/**
 * "Send to Claude": the coaching file holds the last five takes of the exercise, newest first, each with its saved
 * pitch line and the targets it was sung against, and audio only when the singer asked for it.
 */
import { describe, expect, it } from 'vitest';
import { getExercise, realize } from '../exercises';
import type { AttemptRecord, ProfileRecord, TakeRecord } from '../storage/schema';
import { base64ToBytes, encodeTrack } from '../storage/track-codec';
import { appVersion, buildCoachingFileFrom, coachingBlob, coachingFileName, COACHING_FILE_TAKES, type CoachingFileSources } from './export';
import { attemptOf, sing, TEST_PROFILE, TEST_RANGE } from './test-takes';
import { COACHING_FILE_VERSION } from './types';

const PROFILE: ProfileRecord = {
  id: TEST_PROFILE,
  profileId: TEST_PROFILE,
  createdAt: '2026-10-21T09:00:00.000Z',
  updatedAt: '2026-10-21T09:00:00.000Z',
  deletedAt: null,
  name: 'Daniel',
  voiceType: 'tenor',
  range: TEST_RANGE,
};

const take = sing('foundations.05', { breaks: [2.2] });
const stored = encodeTrack(take.track);
const WAV = new Uint8Array([82, 73, 70, 70, 1, 2, 3, 4, 5]);

function record(id: string, audio: boolean): TakeRecord {
  return {
    id,
    profileId: TEST_PROFILE,
    createdAt: '2026-10-22T12:00:00.000Z',
    updatedAt: '2026-10-22T12:00:00.000Z',
    deletedAt: null,
    exerciseId: take.def.id,
    track: stored,
    audioRef: audio ? `takes/${id}.wav` : null,
    sampleRate: 48000,
    latencyMs: 142,
  };
}

/** Seven takes of Sirens (the newest without a saved take), one of another exercise, and one deleted. */
function log(): AttemptRecord[] {
  const rows: AttemptRecord[] = [];
  for (let i = 0; i < 6; i++) rows.push(attemptOf(take, { takeId: `take-${i}`, tonicMidi: take.realized.tonicMidi - (i === 5 ? 2 : 0) }));
  rows.splice(3, 0, attemptOf(null, { exerciseId: 'foundations.sustain.1', takeId: 'other' }));
  rows.push(attemptOf(take, { takeId: 'gone', deletedAt: '2026-10-22T13:00:00.000Z' }));
  rows.push(attemptOf(take, { takeId: null }));
  return rows;
}

function sources(rows: AttemptRecord[], over: Partial<CoachingFileSources> = {}): CoachingFileSources & { audioReads: string[] } {
  const audioReads: string[] = [];
  const takes = new Map<string, TakeRecord>();
  for (let i = 0; i < 6; i++) takes.set(`take-${i}`, record(`take-${i}`, i % 2 === 0));
  return {
    audioReads,
    storage: {
      profiles: { active: async () => PROFILE },
      attempts: { listByExercise: async (profileId, exerciseId) => rows.filter((a) => a.profileId === profileId && a.exerciseId === exerciseId) },
      takes: {
        get: async (id) => takes.get(id),
        audio: async (t) => {
          audioReads.push(t.audioRef ?? '');
          return new Blob([WAV], { type: 'audio/wav' });
        },
      },
    },
    settings: { vibratoStyle: 'pop', notation: 'flats', keepTakeAudio: true },
    device: { route: 'wired', latencyMs: 90, userAgent: 'test' },
    now: new Date('2026-10-22T14:05:00.000Z'),
    appVersion: '0.1.0',
    ...over,
  };
}

describe('buildCoachingFileFrom', () => {
  it('holds the last five takes of the exercise, newest first, without audio unless asked', async () => {
    const rows = log();
    const src = sources(rows);
    const file = await buildCoachingFileFrom(take.def.id, { includeAudio: false }, src);
    expect(file).toMatchObject({ app: 'pitch-lab', kind: 'coaching', version: COACHING_FILE_VERSION, exportedAt: '2026-10-22T14:05:00.000Z', appVersion: '0.1.0' });
    const live = rows.filter((a) => a.exerciseId === take.def.id && a.deletedAt === null);
    expect(file.takes).toHaveLength(COACHING_FILE_TAKES);
    expect(file.takes.map((t) => t.attempt.id)).toEqual(live.slice(-COACHING_FILE_TAKES).reverse().map((a) => a.id));
    expect(file.takes.every((t) => t.audioWavBase64 === null)).toBe(true);
    expect(src.audioReads).toEqual([]);
  });

  it('carries each saved pitch line as stored, and null for a take that was not saved', async () => {
    const file = await buildCoachingFileFrom(take.def.id, { includeAudio: false }, sources(log()));
    expect(file.takes[0].attempt.takeId).toBeNull();
    expect(file.takes[0].track).toBeNull();
    for (const t of file.takes.slice(1)) expect(t.track).toEqual(stored);
  });

  it('carries the targets each take was sung against: its tempo and its key', async () => {
    const file = await buildCoachingFileFrom(take.def.id, { includeAudio: false }, sources(log()));
    const shifted = file.takes.find((t) => t.attempt.tonicMidi === take.realized.tonicMidi - 2)!;
    expect(shifted.realized.tonicMidi).toBe(take.realized.tonicMidi - 2);
    expect(shifted.realized.notes.map((n) => n.midi)).toEqual(take.realized.notes.map((n) => n.midi - 2));
    const same = file.takes.find((t) => t.attempt.tonicMidi === take.realized.tonicMidi && t.track !== null)!;
    const now = realize(take.def, TEST_RANGE, 'tenor', { bpm: same.attempt.tempoBpm ?? undefined });
    expect(same.realized).toEqual({ tonicMidi: now.tonicMidi, bpm: now.bpm, countInSec: now.countInSec, totalSec: now.totalSec, notes: now.notes });
  });

  it('adds each saved recording as base64 WAV only when Include audio is on', async () => {
    const src = sources(log());
    const file = await buildCoachingFileFrom(take.def.id, { includeAudio: true }, src);
    const withAudio = file.takes.filter((t) => t.audioWavBase64 !== null);
    expect(withAudio.length).toBeGreaterThan(0);
    for (const t of withAudio) expect([...base64ToBytes(t.audioWavBase64!)]).toEqual([...WAV]);
    // Only takes whose audio was kept are read.
    expect(src.audioReads.every((ref) => ref.endsWith('.wav'))).toBe(true);
    expect(file.takes.filter((t) => t.track !== null && t.audioWavBase64 === null).length).toBeGreaterThan(0);
  });

  it('names the level, the singer, the settings and the device', async () => {
    const file = await buildCoachingFileFrom(take.def.id, { includeAudio: false }, sources(log()));
    expect(file.level).toEqual({ id: 'foundations.05', title: 'Sirens & glides', worldId: 'foundations' });
    expect(file.exercise).toEqual(take.def);
    expect(file.profile).toEqual({ name: 'Daniel', voiceType: 'tenor', range: TEST_RANGE });
    expect(file.settings).toEqual({ vibratoStyle: 'pop', notation: 'flats', keepTakeAudio: true });
    // The detector the takes were sung with travels too, so the tool rebuilds their audio with the same one.
    const yin = await buildCoachingFileFrom(take.def.id, { includeAudio: false }, sources(log(), { settings: { vibratoStyle: 'pop', notation: 'flats', keepTakeAudio: true, detector: 'yin' } }));
    expect(yin.settings.detector).toBe('yin');
    // The newest saved take's own latency compensation wins over the calibration.
    expect(file.device).toEqual({ route: 'wired', latencyMs: 90, userAgent: 'test' });
    const rows = log().slice(0, -1);
    expect((await buildCoachingFileFrom(take.def.id, { includeAudio: false }, sources(rows))).device.latencyMs).toBe(142);
  });

  it('names an audition test by its own title, with no level', async () => {
    const audition = getExercise('foundations.audition.2')!;
    const file = await buildCoachingFileFrom(audition.id, { includeAudio: false }, sources([attemptOf(null, { exerciseId: audition.id, kind: 'audition' })]));
    expect(file.level).toEqual({ id: null, title: audition.title, worldId: 'foundations' });
    expect(file.takes).toHaveLength(1);
  });

  it('refuses an exercise that is not in the catalog, in plain words', async () => {
    await expect(buildCoachingFileFrom('no.such.exercise', { includeAudio: false }, sources([]))).rejects.toThrow('not in the catalog');
  });
});

describe('coaching file name and contents', () => {
  it('names the file after the level and the local time', async () => {
    const file = await buildCoachingFileFrom(take.def.id, { includeAudio: false }, sources(log()));
    const at = new Date(file.exportedAt);
    const p = (n: number) => String(n).padStart(2, '0');
    expect(coachingFileName(file)).toBe(`pitch-lab-coach-foundations-05-${at.getFullYear()}-${p(at.getMonth() + 1)}-${p(at.getDate())}-${p(at.getHours())}${p(at.getMinutes())}.json`);
    expect(coachingFileName({ ...file, level: { ...file.level, id: null } })).toMatch(/^pitch-lab-coach-foundations-siren-1-\d{4}-\d\d-\d\d-\d{4}\.json$/);
  });

  it('is JSON the script can read back', async () => {
    const file = await buildCoachingFileFrom(take.def.id, { includeAudio: false }, sources(log()));
    const blob = coachingBlob(file);
    expect(blob.type).toBe('application/json');
    expect(JSON.parse(await blob.text())).toEqual(JSON.parse(JSON.stringify(file)));
  });

  it('stamps the app version, with the bundle’s hashed chunk when it has one', () => {
    expect(appVersion('file:///src/coaching/export.ts')).toMatch(/^\d+\.\d+\.\d+$/);
    expect(appVersion('https://example.github.io/pitch-lab/assets/index-B3f9_xQ2.js')).toMatch(/^\d+\.\d+\.\d+\+index-B3f9_xQ2$/);
    expect(appVersion('https://example.github.io/pitch-lab/assets/index-Bx-9_aZ2.js?v=1')).toMatch(/^\d+\.\d+\.\d+\+index-Bx-9_aZ2$/);
  });
});
