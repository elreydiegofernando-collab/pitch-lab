import { describe, expect, it, vi } from 'vitest';
import type { TakeAudio } from '../../audio/take-recorder';
import type { ReferenceSynth } from '../../audio/synth-types';
import type { TargetNote } from '../../core/types';
import { SLOW_RATE, createTakePlayer, type PlaybackEnv } from './playback';

const SR = 16000;

function sine(seconds: number, hz = 220): TakeAudio {
  const samples = new Float32Array(Math.round(seconds * SR));
  for (let i = 0; i < samples.length; i++) samples[i] = 0.4 * Math.sin((2 * Math.PI * hz * i) / SR);
  return { samples, sampleRate: SR, t0: 0 };
}

class FakeSource {
  buffer: unknown = null;
  onended: (() => void) | null = null;
  connect = vi.fn();
  start = vi.fn();
  stop = vi.fn();
}

function fakeEnv() {
  const sources: FakeSource[] = [];
  const buffers: Array<{ channels: number; length: number; sampleRate: number; data: Float32Array }> = [];
  const melody = { startAt: 0, endAt: 0, stop: vi.fn() };
  const synth = { playSequence: vi.fn(() => melody) } as unknown as ReferenceSynth;
  const ctx = {
    currentTime: 10,
    createBuffer: vi.fn((channels: number, length: number, sampleRate: number) => {
      const data = new Float32Array(length);
      buffers.push({ channels, length, sampleRate, data });
      return { getChannelData: () => data, length, sampleRate };
    }),
    createBufferSource: vi.fn(() => {
      const s = new FakeSource();
      sources.push(s);
      return s;
    }),
  };
  const destination = {} as AudioNode;
  const env: PlaybackEnv = { acquire: vi.fn(() => ({ ctx: ctx as unknown as BaseAudioContext, destination })), synth: () => synth };
  return { env, sources, buffers, synth, melody, destination };
}

const settle = async (): Promise<void> => {
  for (let i = 0; i < 400; i++) await Promise.resolve();
};
const noWait = (): Promise<void> => Promise.resolve();

const NOTES: TargetNote[] = [
  { midi: 60, start: 0.1, end: 0.3 },
  { midi: 62, start: 0.3, end: 0.5 },
];

describe('createTakePlayer', () => {
  it('computes the half-speed copy once, in the background, and says when it is ready', async () => {
    const f = fakeEnv();
    const player = createTakePlayer({ audio: sine(1), targetNotes: [], timbre: 'piano', gain: 0.7, env: f.env, yieldToMain: noWait });
    expect(player.slowReady.value).toBe(false);
    await settle();
    expect(player.slowReady.value).toBe(true);
    player.play('slow');
    // Half speed is twice as long, at the take's own sample rate.
    expect(f.buffers[0].length).toBe(Math.round(SR / SLOW_RATE));
    expect(f.buffers[0].sampleRate).toBe(SR);
    expect(f.buffers[0].channels).toBe(1);
  });

  it('does not offer slow playback before the copy is ready', () => {
    const f = fakeEnv();
    const player = createTakePlayer({ audio: sine(1), targetNotes: NOTES, timbre: 'piano', gain: 0.7, env: f.env, yieldToMain: noWait });
    player.play('slow');
    player.play('slow-target');
    expect(f.env.acquire).not.toHaveBeenCalled();
    expect(player.playing.value).toBeNull();
  });

  it('plays the take at speed straight away, from the tap, on the device clock', () => {
    const f = fakeEnv();
    const audio = sine(0.5);
    const player = createTakePlayer({ audio, targetNotes: [], timbre: 'piano', gain: 0.7, env: f.env, yieldToMain: noWait });
    player.play('normal');
    expect(f.env.acquire).toHaveBeenCalledTimes(1);
    expect(f.buffers[0].length).toBe(audio.samples.length);
    expect(Array.from(f.buffers[0].data.slice(0, 50))).toEqual(Array.from(audio.samples.slice(0, 50)));
    expect(f.sources[0].connect).toHaveBeenCalledWith(f.destination);
    expect(f.sources[0].start).toHaveBeenCalledTimes(1);
    expect(f.sources[0].start.mock.calls[0][0]).toBeGreaterThan(10);
    expect(player.playing.value).toBe('normal');
    f.sources[0].onended?.();
    expect(player.playing.value).toBeNull();
  });

  it('plays the target melody on the synth at the slowed tempo, on the same start time', async () => {
    const f = fakeEnv();
    const player = createTakePlayer({ audio: sine(1), targetNotes: NOTES, timbre: 'soft', gain: 0.6, env: f.env, yieldToMain: noWait });
    await settle();
    player.play('slow-target');
    expect(player.playing.value).toBe('slow-target');
    const startAt = f.sources[0].start.mock.calls[0][0] as number;
    expect(f.synth.playSequence).toHaveBeenCalledTimes(1);
    const [notes, opts] = (f.synth.playSequence as ReturnType<typeof vi.fn>).mock.calls[0] as [Array<{ midi: number; start: number; duration: number }>, { startAt: number; timbre: string; gain: number }];
    expect(notes.map((n) => n.midi)).toEqual([60, 62]);
    // Half speed: every time doubles.
    expect(notes[0].start).toBeCloseTo(0.2, 9);
    expect(notes[0].duration).toBeCloseTo(0.4, 9);
    expect(notes[1].start).toBeCloseTo(0.6, 9);
    expect(notes[1].duration).toBeCloseTo(0.4, 9);
    expect(opts).toEqual({ startAt, timbre: 'soft', gain: 0.6 });
  });

  it('never plays a melody for the other modes', async () => {
    const f = fakeEnv();
    const player = createTakePlayer({ audio: sine(1), targetNotes: NOTES, timbre: 'piano', gain: 0.7, env: f.env, yieldToMain: noWait });
    await settle();
    player.play('normal');
    player.play('slow');
    expect(f.synth.playSequence).not.toHaveBeenCalled();
  });

  it('stops what is playing when something else starts, and when asked', async () => {
    const f = fakeEnv();
    const player = createTakePlayer({ audio: sine(1), targetNotes: NOTES, timbre: 'piano', gain: 0.7, env: f.env, yieldToMain: noWait });
    await settle();
    player.play('slow-target');
    player.play('normal');
    expect(f.sources[0].stop).toHaveBeenCalledTimes(1);
    expect(f.melody.stop).toHaveBeenCalledTimes(1);
    expect(player.playing.value).toBe('normal');
    // A late "ended" from the stopped source must not clear the new playback.
    f.sources[0].onended?.();
    expect(player.playing.value).toBe('normal');
    player.stop();
    expect(f.sources[1].stop).toHaveBeenCalledTimes(1);
    expect(player.playing.value).toBeNull();
  });

  it('says so, plainly, when playback cannot start', () => {
    const f = fakeEnv();
    (f.env.acquire as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error('no output');
    });
    const player = createTakePlayer({ audio: sine(0.5), targetNotes: [], timbre: 'piano', gain: 0.7, env: f.env, yieldToMain: noWait });
    player.play('normal');
    expect(player.playing.value).toBeNull();
    expect(player.error.value).toMatch(/didn.t start/);
    player.play('normal');
    expect(player.error.value).toMatch(/didn.t start/);
  });

  it('survives a take with no audio samples', async () => {
    const f = fakeEnv();
    const empty: TakeAudio = { samples: new Float32Array(0), sampleRate: SR, t0: 0 };
    const player = createTakePlayer({ audio: empty, targetNotes: [], timbre: 'piano', gain: 0.7, env: f.env, yieldToMain: noWait });
    await settle();
    expect(player.slowReady.value).toBe(false);
    player.play('normal');
    expect(f.env.acquire).not.toHaveBeenCalled();
  });

  it('drops the slow copy and stops everything on dispose, and cancels a stretch still running', async () => {
    const f = fakeEnv();
    const player = createTakePlayer({ audio: sine(1), targetNotes: [], timbre: 'piano', gain: 0.7, env: f.env, yieldToMain: noWait });
    player.play('normal');
    player.dispose();
    expect(f.sources[0].stop).toHaveBeenCalled();
    await settle();
    expect(player.slowReady.value).toBe(false);
    player.play('slow');
    expect(f.sources).toHaveLength(1);
  });
});
