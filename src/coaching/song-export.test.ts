/**
 * "Send to Claude" from a song: the file holds the song as charted and its last eight takes, newest first, each with the
 * phrases it covered, its key and speed and its saved pitch line, and audio only when the singer asked for it.
 */
import { describe, expect, it } from 'vitest';
import { makeTrack } from '../analysis/fixtures';
import { SONG_PASS_SCORE, type PitchedSpan } from '../song/practice';
import type { Song } from '../song/types';
import { parseUltraStar } from '../song/ultrastar';
import type { AttemptRecord, ProfileRecord, TakeRecord } from '../storage/schema';
import { base64ToBytes, encodeTrack } from '../storage/track-codec';
import { SONG_COACHING_FILE_TAKES, buildSongCoachingFileFrom, songCoachingBlob, songCoachingFileName, type SongCoachingFileSources } from './song-export';
import { COACHING_FILE_VERSION } from './types';

const SONG: Song = parseUltraStar(
  `#TITLE:O Holy Night
#ARTIST:Adolphe Adam
#BPM:60
#GAP:0
: 0 4 0  O
: 4 4 2  ho
: 8 4 4 ly
: 12 8 5  night
- 22
: 24 4 7  The
: 28 8 5  stars
E
`,
  { id: 'o-holy-night', source: 'bundled' },
).song;

const PROFILE: ProfileRecord = {
  id: 'p1',
  profileId: 'p1',
  createdAt: '2026-10-21T09:00:00.000Z',
  updatedAt: '1',
  deletedAt: null,
  name: 'Daniel',
  voiceType: 'tenor',
  range: { comfortable: { low: 52, high: 69 }, extended: { low: 45, high: 72 }, measuredAt: '2026-10-21T09:00:00.000Z' },
};

const stored = encodeTrack(makeTrack({ duration: 2, midi: () => 60 }));
const WAV = new Uint8Array([82, 73, 70, 70, 9, 8, 7]);
let seq = 0;

function take(phrase: PitchedSpan | null, extra: Partial<AttemptRecord> = {}): AttemptRecord {
  seq += 1;
  const at = new Date(Date.parse('2026-10-22T12:00:00Z') + seq * 60_000).toISOString();
  return {
    id: `a${seq}`,
    profileId: 'p1',
    createdAt: at,
    updatedAt: at,
    deletedAt: null,
    exerciseId: `song.${SONG.id}`,
    levelId: null,
    kind: 'song',
    score: 0.6,
    passed: 0.6 >= SONG_PASS_SCORE,
    mastery: 0,
    metrics: { 'song.phraseScore': 0.6, 'song.inTolerancePct': 55 },
    durationSec: 4,
    tonicMidi: 60,
    tempoBpm: null,
    takeId: `take-${seq}`,
    songId: SONG.id,
    phrase,
    songShift: 2,
    songSpeed: 0.75,
    ...extra,
  };
}

function record(id: string, audio: boolean): TakeRecord {
  return { id, profileId: 'p1', createdAt: '2026-10-22T12:00:00.000Z', updatedAt: '1', deletedAt: null, exerciseId: `song.${SONG.id}`, track: stored, audioRef: audio ? `takes/${id}.wav` : null, sampleRate: 48000, latencyMs: 131 };
}

/** Ten takes (some with audio, the newest without a saved recording), one older take without its phrases, one deleted. */
function log(): AttemptRecord[] {
  const rows: AttemptRecord[] = [take({ from: 0, to: 1 }, { songSpeed: undefined, phrase: undefined, takeId: 'old' })];
  for (let i = 0; i < 9; i++) rows.push(take(i % 3 === 0 ? null : { from: i % 2, to: (i % 2) + 1 }));
  rows.push(take({ from: 0, to: 2 }, { deletedAt: '2026-10-22T13:00:00.000Z' }));
  rows.push(take({ from: 1, to: 2 }, { takeId: null, songSpeed: 1, songShift: 0 }));
  return rows;
}

function sources(rows: AttemptRecord[]): SongCoachingFileSources & { audioReads: string[] } {
  const audioReads: string[] = [];
  return {
    audioReads,
    storage: {
      profiles: { active: async () => PROFILE },
      attempts: { listByExercise: async (profileId, exerciseId) => rows.filter((a) => a.profileId === profileId && a.exerciseId === exerciseId) },
      takes: {
        get: async (id) => (id.startsWith('take-') ? record(id, Number(id.slice(5)) % 2 === 0) : undefined),
        audio: async (t) => {
          audioReads.push(t.audioRef ?? '');
          return new Blob([WAV], { type: 'audio/wav' });
        },
      },
    },
    settings: { notation: 'flats' },
    device: { route: 'wired', latencyMs: 90, userAgent: 'test' },
    now: new Date('2026-10-22T14:05:00.000Z'),
    appVersion: '0.1.0',
  };
}

describe('buildSongCoachingFileFrom', () => {
  it('holds the song and its last eight takes, newest first, with their phrases, key and speed, and no audio unless asked', async () => {
    const rows = log();
    const src = sources(rows);
    const file = await buildSongCoachingFileFrom(SONG, { includeAudio: false }, src);
    expect(file).toMatchObject({ app: 'pitch-lab', kind: 'song-coaching', version: COACHING_FILE_VERSION, exportedAt: '2026-10-22T14:05:00.000Z', appVersion: '0.1.0' });
    expect(file.song).toEqual(SONG);
    const live = rows.filter((a) => a.deletedAt === null && a.songSpeed !== undefined);
    expect(file.takes).toHaveLength(SONG_COACHING_FILE_TAKES);
    expect(file.takes.map((t) => t.attempt.id)).toEqual(live.slice(-SONG_COACHING_FILE_TAKES).reverse().map((a) => a.id));
    expect(file.takes[0]).toMatchObject({ phrase: { from: 1, to: 2 }, shift: 0, speed: 1, track: null, audioWavBase64: null });
    expect(file.takes[1]).toMatchObject({ phrase: { from: 0, to: 1 }, shift: 2, speed: 0.75, track: stored });
    expect(file.takes.find((t) => t.phrase === null)).toMatchObject({ shift: 2, speed: 0.75, track: stored }); // a whole-song take
    expect(file.takes.every((t) => t.audioWavBase64 === null)).toBe(true);
    expect(src.audioReads).toEqual([]);
  });

  it('adds each kept recording as base64 WAV only when Include audio is on', async () => {
    const src = sources(log());
    const file = await buildSongCoachingFileFrom(SONG, { includeAudio: true }, src);
    const withAudio = file.takes.filter((t) => t.audioWavBase64 !== null);
    expect(withAudio.length).toBeGreaterThan(0);
    for (const t of withAudio) expect([...base64ToBytes(t.audioWavBase64!)]).toEqual([...WAV]);
    expect(src.audioReads.every((ref) => ref.endsWith('.wav'))).toBe(true);
    expect(file.takes.some((t) => t.track !== null && t.audioWavBase64 === null)).toBe(true);
  });

  it('names the singer, the notation and the device, the newest saved take’s latency winning', async () => {
    const file = await buildSongCoachingFileFrom(SONG, { includeAudio: false }, sources(log()));
    expect(file.profile).toEqual({ name: 'Daniel', voiceType: 'tenor', range: PROFILE.range });
    expect(file.settings).toEqual({ notation: 'flats' });
    // The detector the takes were sung with travels too, so the tool rebuilds their audio with the same one.
    const yin = await buildSongCoachingFileFrom(SONG, { includeAudio: false }, { ...sources(log()), settings: { notation: 'flats', detector: 'yin' } });
    expect(yin.settings).toEqual({ notation: 'flats', detector: 'yin' });
    // The newest take kept no recording, so the calibration stands; without it, the newest saved take's own wins.
    expect(file.device).toEqual({ route: 'wired', latencyMs: 90, userAgent: 'test' });
    const saved = await buildSongCoachingFileFrom(SONG, { includeAudio: false }, sources(log().slice(0, -1)));
    expect(saved.device.latencyMs).toBe(131);
    const none = await buildSongCoachingFileFrom(SONG, { includeAudio: false }, sources([]));
    expect(none.takes).toEqual([]);
    expect(none.device.latencyMs).toBe(90);
  });
});

describe('song coaching file name and contents', () => {
  it('names the file after the song and the local time', async () => {
    const file = await buildSongCoachingFileFrom(SONG, { includeAudio: false }, sources(log()));
    const at = new Date(file.exportedAt);
    const p = (n: number) => String(n).padStart(2, '0');
    expect(songCoachingFileName(file)).toBe(`pitch-lab-coach-song-o-holy-night-${at.getFullYear()}-${p(at.getMonth() + 1)}-${p(at.getDate())}-${p(at.getHours())}${p(at.getMinutes())}.json`);
    expect(songCoachingFileName({ ...file, song: { ...SONG, title: '¡Ave María!' } })).toMatch(/^pitch-lab-coach-song-ave-maria-\d{4}-\d\d-\d\d-\d{4}\.json$/);
    expect(songCoachingFileName({ ...file, song: { ...SONG, title: '星', id: 'abc123' } })).toMatch(/^pitch-lab-coach-song-abc123-/);
  });

  it('is JSON that reads back as it was made', async () => {
    const file = await buildSongCoachingFileFrom(SONG, { includeAudio: false }, sources(log()));
    const blob = songCoachingBlob(file);
    expect(blob.type).toBe('application/json');
    expect(JSON.parse(await blob.text())).toEqual(JSON.parse(JSON.stringify(file)));
  });
});
