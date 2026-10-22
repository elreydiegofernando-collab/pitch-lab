// @vitest-environment happy-dom
/** About & voice care: the voice-health note (SPEC §12), the privacy promise and the credits, incl. the bundled songs'. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'preact/test-utils';
import { render } from 'preact';
import type { KVStore } from '../../storage/kv-types';

vi.mock('../../storage/kv', () => ({
  openKV: async (): Promise<KVStore> => ({ persistent: true, get: async () => undefined, set: async () => {}, delete: async () => {}, keys: async () => [] }),
}));

import { CONFIG } from '../../config';
import { songIndex, type SongEntry } from '../../state/songs';
import { About } from './About';

let container: HTMLElement;

async function mount(): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  await act(() => {
    render(<About />, container);
  });
}
const text = (): string => container.textContent ?? '';

function entry(over: Partial<SongEntry> & { id: string; title: string }): SongEntry {
  return {
    artist: 'Traditional',
    source: 'bundled',
    bundled: true,
    licence: 'Public domain. Chart by the Pitch Lab project (MIT licence).',
    difficulty: { requiredWorld: 'foundations', reasons: [] } as unknown as SongEntry['difficulty'],
    recordId: null,
    ...over,
  };
}

afterEach(async () => {
  await act(() => {
    render(null, container);
  });
  container.remove();
  songIndex.value = new Map();
});

describe('About: voice care', () => {
  it('covers warming up, water, pain and hoarseness, rest, not straining, the break reminder and the disclaimer', async () => {
    await mount();
    const note = container.querySelector('[data-testid="voice-care-note"]')!.textContent ?? '';
    expect(note).toMatch(/warm up/i);
    expect(note).toMatch(/drink water/i);
    expect(note).toMatch(/never sing through pain or hoarseness/i);
    expect(note).toMatch(/rest/i);
    expect(note).toMatch(/don.t strain for range/i);
    expect(note).toContain(`after about ${CONFIG.health.breakReminderMin} minutes of singing`);
    expect(note).toContain('This is not medical advice.');
  });
});

describe('About: privacy', () => {
  it('promises that audio never leaves the device unless exported, and names the two exports', async () => {
    await mount();
    expect(text()).toContain('Your voice audio never leaves this device unless you export it.');
    expect(text()).toContain('no analytics calls');
    expect(text()).toContain("a take's WAV file");
    expect(text()).toContain('a backup of your progress');
  });
});

describe('About: credits', () => {
  it('credits the open-source pieces', async () => {
    await mount();
    expect(text()).toContain('SIL Open Font License 1.1');
    expect(text()).toContain('lucide-preact');
    expect(text()).toContain('@tonejs/midi');
  });

  it('credits each bundled public-domain song with its own licence note, and leaves imports out', async () => {
    songIndex.value = new Map([
      ['amazing-grace', entry({ id: 'amazing-grace', title: 'Amazing Grace', licence: 'Public domain. Words: John Newton, 1779. Chart by the Pitch Lab project (MIT licence).' })],
      ['ave-maria', entry({ id: 'ave-maria', title: 'Ave Maria', artist: 'Franz Schubert' })],
      ['mine', entry({ id: 'mine', title: 'My Own Song', bundled: false, source: 'midi', licence: null, recordId: 'r1' })],
    ]);
    await mount();
    const credits = container.querySelector('[data-testid="song-credits"]')!.textContent ?? '';
    expect(credits).toContain('Show the credits for 2 songs');
    expect(credits).toContain('Amazing Grace');
    expect(credits).toContain('John Newton, 1779');
    expect(credits).toContain('Ave Maria');
    expect(credits).toContain('Franz Schubert');
    expect(credits).not.toContain('My Own Song');
  });

  it('says the song credits appear once the library has loaded, rather than showing an empty list', async () => {
    await mount();
    expect(container.querySelector('[data-testid="song-credits"]')).toBeNull();
    expect(text()).toContain('once the song library has loaded');
  });

  it('shows the version', async () => {
    await mount();
    expect(text()).toMatch(/Pitch Lab v\d+\.\d+\.\d+/);
  });
});
