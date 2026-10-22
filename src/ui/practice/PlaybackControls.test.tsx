// @vitest-environment happy-dom
/** The three playback buttons, on a fake output: each is a toggle called straight from its click. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render } from 'preact';
import { act } from 'preact/test-utils';
import type { ReferenceSynth } from '../../audio/synth-types';
import type { TakeAudio } from '../../audio/take-recorder';
import type { TargetNote } from '../../core/types';
import { PlaybackControls } from './PlaybackControls';
import type { PlaybackEnv } from './playback';

const SR = 16000;
const AUDIO: TakeAudio = { samples: Float32Array.from({ length: SR / 2 }, (_, i) => 0.3 * Math.sin((2 * Math.PI * 220 * i) / SR)), sampleRate: SR, t0: 0 };
const NOTES: TargetNote[] = [{ midi: 60, start: 0.1, end: 0.3 }];

function fakeEnv() {
  const sources: Array<{ start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn>; connect: ReturnType<typeof vi.fn>; onended: (() => void) | null }> = [];
  const melody = { startAt: 0, endAt: 0, stop: vi.fn() };
  const playSequence = vi.fn(() => melody);
  const ctx = {
    currentTime: 1,
    createBuffer: (_c: number, length: number) => ({ getChannelData: () => new Float32Array(length) }),
    createBufferSource: () => {
      const s = { start: vi.fn(), stop: vi.fn(), connect: vi.fn(), onended: null as (() => void) | null, buffer: null as unknown };
      sources.push(s);
      return s;
    },
  };
  const env: PlaybackEnv = {
    acquire: vi.fn(() => ({ ctx: ctx as unknown as BaseAudioContext, destination: {} as AudioNode })),
    synth: () => ({ playSequence }) as unknown as ReferenceSynth,
  };
  return { env, sources, playSequence, melody };
}

let container: HTMLElement;

async function mount(env: PlaybackEnv, targetNotes: readonly TargetNote[] = []): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  await act(() => {
    render(<PlaybackControls audio={AUDIO} targetNotes={targetNotes} timbre="piano" gain={0.7} env={env} />, container);
  });
}

const q = <T extends Element = HTMLElement>(sel: string): T | null => container.querySelector<T>(sel);
const ready = (): Promise<void> => act(async () => void (await new Promise((r) => setTimeout(r, 60))));

afterEach(async () => {
  await act(() => {
    render(null, container);
  });
  container.remove();
});

describe('PlaybackControls', () => {
  it('plays the take from the click, shows Stop while it plays, and stops on a second click', async () => {
    const f = fakeEnv();
    await mount(f.env);
    const play = q<HTMLButtonElement>('[data-testid="play-take"]')!;
    play.click();
    expect(f.env.acquire).toHaveBeenCalledTimes(1);
    expect(f.sources).toHaveLength(1);
    await act(() => {});
    expect(q('[data-testid="play-take"]')!.textContent).toContain('Stop');
    q<HTMLButtonElement>('[data-testid="play-take"]')!.click();
    expect(f.sources[0].stop).toHaveBeenCalled();
    await act(() => {});
    expect(q('[data-testid="play-take"]')!.textContent).toContain('Play take');
  });

  it('makes the slow buttons wait, with a spinner, until the slowed copy is ready', async () => {
    const f = fakeEnv();
    await mount(f.env, NOTES);
    const slow = q<HTMLButtonElement>('[data-testid="play-slow"]')!;
    expect(slow.disabled).toBe(true);
    expect(slow.querySelector('.pl-btn__spinner')).not.toBeNull();
    expect(q<HTMLButtonElement>('[data-testid="play-slow-target"]')!.disabled).toBe(true);
    await ready();
    expect(q<HTMLButtonElement>('[data-testid="play-slow"]')!.disabled).toBe(false);
    expect(q('[data-testid="play-slow"]')!.querySelector('.pl-btn__spinner')).toBeNull();
  });

  it('plays the slowed take with the target melody alongside it', async () => {
    const f = fakeEnv();
    await mount(f.env, NOTES);
    await ready();
    q<HTMLButtonElement>('[data-testid="play-slow-target"]')!.click();
    expect(f.sources).toHaveLength(1);
    expect(f.playSequence).toHaveBeenCalledTimes(1);
    await act(() => {});
    expect(q('[data-testid="play-slow-target"]')!.textContent).toContain('Stop');
    expect(q('[data-testid="play-slow"]')!.textContent).toContain('Slow (0.5×)');
  });

  it('has no "Slow + target" without a melody', async () => {
    const f = fakeEnv();
    await mount(f.env);
    expect(q('[data-testid="play-slow-target"]')).toBeNull();
  });

  it('says plainly when playback cannot start', async () => {
    const f = fakeEnv();
    (f.env.acquire as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error('no output');
    });
    await mount(f.env);
    q<HTMLButtonElement>('[data-testid="play-take"]')!.click();
    await act(() => {});
    expect(q('[role="alert"]')?.textContent).toMatch(/didn.t start/);
    expect(q('[data-testid="play-take"]')!.textContent).toContain('Play take');
  });

  it('stops the sound when the report goes away', async () => {
    const f = fakeEnv();
    await mount(f.env, NOTES);
    q<HTMLButtonElement>('[data-testid="play-take"]')!.click();
    await act(() => {
      render(null, container);
    });
    expect(f.sources[0].stop).toHaveBeenCalled();
  });

  it('uses only secondary buttons: the report’s one amber button is its next step', async () => {
    const f = fakeEnv();
    await mount(f.env, NOTES);
    expect(container.querySelectorAll('.pl-btn--primary')).toHaveLength(0);
    expect(container.querySelectorAll('.pl-btn--secondary')).toHaveLength(3);
  });
});
