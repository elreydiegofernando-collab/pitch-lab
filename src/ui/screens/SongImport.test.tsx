// @vitest-environment happy-dom
/**
 * Importing a purchased-karaoke-style MIDI file: three tracks (piano chords, the lead vocal, drums on channel 10).
 * The track picker preselects the best candidate (the melody), lists the drums but never lets them be chosen, and the
 * rating appears before Save. Importing itself is earned: the screen fails closed without the unlock.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render } from 'preact';
import * as F from '../../song/midi-fixtures';

const unlocked = vi.hoisted(() => ({ value: true }));

vi.mock('../../state/session', async () => {
  const { signal } = await import('@preact/signals');
  const { computeSnapshot } = await import('../../progress');
  const { WORLDS } = await import('../../exercises');
  return {
    snapshot: signal(computeSnapshot('p1', WORLDS, [], Date.parse('2026-10-22T12:00:00Z'))),
    isUnlocked: () => unlocked.value,
    activeProfile: signal(null),
    appStorage: signal(null),
    recordAttempt: async () => undefined,
  };
});
vi.mock('../../state/settings', async () => {
  const { signal } = await import('@preact/signals');
  const types = await import('../../state/settings-types');
  return { settings: signal(types.DEFAULT_SETTINGS), deviceSettings: signal(types.DEFAULT_DEVICE_SETTINGS) };
});
vi.mock('../../state/songs', () => ({ loadSongs: async () => undefined }));
vi.mock('../../audio/engine', () => ({ getEngine: () => undefined }));
vi.mock('../../state/audio', () => ({ getSynth: () => undefined, resetAudio: async () => undefined }));

import { SongImport } from './SongImport';

const PPQ = 480;

/** Piano chords, then the lead vocal (a stepwise tune), then drums on channel 10 (index 9). */
function karaokeMidi(): Uint8Array {
  const chords: F.TrackEvent[] = [F.trackName(0, 'Piano')];
  for (let k = 0; k < 16; k++) for (const n of [48, 52, 55]) chords.push(...F.noteEvents(0, n, k * PPQ, PPQ));
  const melody: F.TrackEvent[] = [F.trackName(0, 'Lead Vocal')];
  const tune = [60, 62, 64, 65, 67, 65, 64, 62, 60, 64, 67, 72, 71, 69, 67, 65, 64, 62, 60, 62, 64, 62, 60, 60];
  tune.forEach((n, i) => melody.push(...F.noteEvents(1, n, i * (PPQ / 2), PPQ / 2 - 10)));
  const drums: F.TrackEvent[] = [F.trackName(0, 'Drums')];
  for (let k = 0; k < 32; k++) drums.push(...F.noteEvents(9, k % 2 ? 38 : 36, k * (PPQ / 2), 60));
  return F.smf([[F.trackName(0, 'Karaoke Night'), F.tempoEvent(0, 120)], chords, melody, drums], { ppq: PPQ });
}

async function until<T>(read: () => T | null | undefined): Promise<T> {
  for (let i = 0; i < 200; i++) {
    const v = read();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('timed out waiting for the screen');
}

function show(): HTMLElement {
  const container = document.createElement('div');
  document.body.append(container);
  render(<SongImport />, container);
  return container;
}

function pick(container: HTMLElement, file: File): void {
  const input = container.querySelector<HTMLInputElement>('[data-testid="song-file-input"]');
  if (!input) throw new Error('no file input');
  Object.defineProperty(input, 'files', { value: [file], configurable: true });
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

afterEach(() => {
  document.body.innerHTML = '';
  unlocked.value = true;
});

describe('Song import', () => {
  it('preselects the best MIDI track, lists the drums but never lets them be chosen, and rates the song', async () => {
    const c = show();
    expect(c.textContent).toContain('Your files stay on this device.');
    pick(c, new File([new Uint8Array(karaokeMidi())], 'karaoke-night.mid', { type: 'audio/midi' }));

    const radios = await until(() => {
      const all = [...c.querySelectorAll<HTMLInputElement>('input[name="melody-track"]')];
      return all.length > 0 ? all : null;
    });
    expect(radios).toHaveLength(3);
    const labelOf = (r: HTMLInputElement): string => c.querySelector(`label[for="${r.id}"]`)?.textContent ?? '';
    const checked = radios.filter((r) => r.checked);
    expect(checked).toHaveLength(1);
    expect(labelOf(checked[0])).toContain('Lead Vocal');
    expect(labelOf(checked[0])).toContain('best match');
    expect(labelOf(checked[0])).toContain('24 notes');
    const drums = radios.find((r) => labelOf(r).includes('Drums'))!;
    expect(drums.disabled).toBe(true);
    expect(labelOf(drums)).toContain('drums: no melody');
    expect(radios.find((r) => labelOf(r).includes('Piano'))!.disabled).toBe(false);

    expect(c.querySelector('[data-testid="song-rating"]')).not.toBeNull();
    expect(c.querySelector<HTMLInputElement>('#song-title')?.value).toBe('Karaoke Night');
    expect(c.querySelector('[data-testid="song-save"]')).not.toBeNull();
  });

  it('says plainly when a file is not a chart, next to the picker', async () => {
    const c = show();
    pick(c, new File(['just some notes about a song'], 'notes.txt', { type: 'text/plain' }));
    const error = await until(() => c.querySelector('[role="alert"]'));
    expect(error.textContent).toMatch(/isn't a chart Pitch Lab can read/);
    expect(c.querySelector('[data-testid="song-save"]')).toBeNull();
  });

  it('fails closed until importing is earned', () => {
    unlocked.value = false;
    const c = show();
    expect(c.querySelector('[data-testid="song-file-input"]')).toBeNull();
    expect(c.textContent).toContain('Pass the Foundations Boss Recital to import your own songs.');
  });
});
