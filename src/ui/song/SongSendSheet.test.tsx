// @vitest-environment happy-dom
/**
 * Send to Claude for a song: the file is made when the sheet opens (and again when Include audio changes, off every
 * time it opens), and the Share tap hands it over straight away, inside the tap, as the iPhone share sheet requires.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render } from 'preact';
import { act } from 'preact/test-utils';
import type { SongCoachingFile } from '../../coaching/types';
import { parseUltraStar } from '../../song/ultrastar';
import type { SaveOutcome } from '../progress/save-file';
import { SEND_SONG_TEXT, SongSendSheet, type SongSendSheetProps } from './SongSendSheet';

const SONG = parseUltraStar(`#TITLE:O Holy Night\n#ARTIST:Adam\n#BPM:60\n#GAP:0\n: 0 4 0  O\n: 4 4 2  ho\nE\n`, { id: 'o-holy-night', source: 'bundled' }).song;

function file(takes: number): SongCoachingFile {
  return {
    app: 'pitch-lab',
    kind: 'song-coaching',
    version: 1,
    exportedAt: '2026-10-22T14:05:00.000Z',
    appVersion: '0.1.0',
    song: SONG,
    profile: { name: 'Daniel', voiceType: 'tenor', range: null },
    settings: { notation: 'sharps' },
    device: { route: 'wired', latencyMs: null, userAgent: 'test' },
    takes: Array.from({ length: takes }, () => ({
      attempt: {} as SongCoachingFile['takes'][number]['attempt'],
      phrase: { from: 0, to: 1 },
      shift: 0,
      speed: 1,
      track: null,
      audioWavBase64: null,
    })),
  };
}

let container: HTMLElement;
const flush = () => act(async () => void (await new Promise((r) => setTimeout(r, 0))));
const q = <T extends Element = HTMLElement>(sel: string): T | null => container.querySelector<T>(sel);

async function show(props: Partial<SongSendSheetProps> = {}): Promise<SongSendSheetProps> {
  const full: SongSendSheetProps = {
    open: true,
    onClose: vi.fn(),
    song: SONG,
    build: vi.fn(async () => file(4)),
    save: vi.fn(async (): Promise<SaveOutcome> => 'shared'),
    ...props,
  };
  container = document.createElement('div');
  document.body.appendChild(container);
  await act(() => {
    render(<SongSendSheet {...full} />, container);
  });
  await flush();
  return full;
}

afterEach(async () => {
  if (!container) return;
  await act(() => {
    render(null, container);
  });
  container.remove();
  container = undefined as never;
});

describe('SongSendSheet', () => {
  it('says what the file holds and makes it without audio when it opens', async () => {
    const props = await show();
    expect(q('[data-testid="send-text"]')?.textContent).toBe(SEND_SONG_TEXT);
    expect(SEND_SONG_TEXT).toContain('No audio unless you tick Include audio.');
    expect(props.build).toHaveBeenCalledWith(SONG, { includeAudio: false });
    expect(q('[data-testid="send-status"]')?.textContent).toBe('4 takes ready.');
  });

  it('makes it again with audio when Include audio is ticked, and starts without audio every time it opens', async () => {
    const props = await show();
    await act(() => {
      q<HTMLButtonElement>('[role="switch"]')!.click();
    });
    await flush();
    expect(props.build).toHaveBeenLastCalledWith(SONG, { includeAudio: true });
    expect(q('[data-testid="send-status"]')?.textContent).toBe('4 takes ready, with audio.');
    await act(() => {
      render(<SongSendSheet {...props} open={false} />, container);
    });
    await act(() => {
      render(<SongSendSheet {...props} open />, container);
    });
    await flush();
    expect(q('[role="switch"]')?.getAttribute('aria-checked')).toBe('false');
    expect(props.build).toHaveBeenLastCalledWith(SONG, { includeAudio: false });
  });

  it('hands the file over straight from the Share tap', async () => {
    const props = await show();
    q<HTMLButtonElement>('[data-testid="send-share"]')!.click();
    expect(props.save).toHaveBeenCalledTimes(1); // synchronously, inside the tap
    const [blob, name, opts] = vi.mocked(props.save!).mock.calls[0];
    expect(name).toMatch(/^pitch-lab-coach-song-o-holy-night-\d{4}-\d\d-\d\d-\d{4}\.json$/);
    expect(opts).toEqual({ fromTap: true });
    expect(JSON.parse(await blob.text())).toMatchObject({ app: 'pitch-lab', kind: 'song-coaching' });
    await flush();
    expect(container.textContent).toContain('Now tell Claude in chat which song it is.');
  });

  it('has nothing to share before the song has been sung, and says plainly when the file could not be made', async () => {
    await show({ build: vi.fn(async () => file(0)) });
    expect(q('[data-testid="send-status"]')?.textContent).toBe('There are no takes of this song yet. Sing a phrase of it once, then come back here.');
    expect(q<HTMLButtonElement>('[data-testid="send-share"]')!.disabled).toBe(true);
    await act(() => {
      render(null, container);
    });
    container.remove();
    await show({ build: vi.fn(async () => Promise.reject(new Error('Storage is not available.'))) });
    expect(q('.pl-banner--error')?.textContent).toContain('The file could not be made. Storage is not available.');
  });
});
