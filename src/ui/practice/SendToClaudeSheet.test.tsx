// @vitest-environment happy-dom
/**
 * Send to Claude: the file is made when the sheet opens (and again when Include audio changes, off by default), and the
 * Share tap hands it over straight away, inside the tap, as the iPhone share sheet requires.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render } from 'preact';
import { act } from 'preact/test-utils';
import type { CoachingFile } from '../../coaching/types';
import { getExercise } from '../../exercises';
import type { SaveOutcome } from '../progress/save-file';
import { SEND_TO_CLAUDE_TEXT, SendToClaudeSheet, type SendToClaudeSheetProps } from './SendToClaudeSheet';

const sirens = getExercise('foundations.siren.1')!;

function file(takes: number): CoachingFile {
  return {
    app: 'pitch-lab',
    kind: 'coaching',
    version: 1,
    exportedAt: '2026-10-22T14:05:00.000Z',
    appVersion: '0.1.0',
    level: { id: 'foundations.05', title: 'Sirens & glides', worldId: 'foundations' },
    exercise: sirens,
    profile: { name: 'Daniel', voiceType: 'tenor', range: null },
    settings: { vibratoStyle: 'pop', notation: 'sharps', keepTakeAudio: true },
    device: { route: 'wired', latencyMs: null, userAgent: 'test' },
    takes: Array.from({ length: takes }, () => ({
      attempt: {} as CoachingFile['takes'][number]['attempt'],
      realized: { tonicMidi: 50, bpm: 60, countInSec: 2, totalSec: 19, notes: [] },
      track: null,
      audioWavBase64: null,
    })),
  };
}

let container: HTMLElement;

async function show(props: Partial<SendToClaudeSheetProps> = {}): Promise<SendToClaudeSheetProps> {
  const full: SendToClaudeSheetProps = {
    open: true,
    onClose: vi.fn(),
    exerciseId: sirens.id,
    build: vi.fn(async () => file(3)),
    save: vi.fn(async (): Promise<SaveOutcome> => 'shared'),
    ...props,
  };
  container = document.createElement('div');
  document.body.appendChild(container);
  await act(() => {
    render(<SendToClaudeSheet {...full} />, container);
  });
  await flush();
  return full;
}

const flush = () => act(async () => void (await new Promise((r) => setTimeout(r, 0))));
const q = <T extends Element = HTMLElement>(sel: string): T | null => container.querySelector<T>(sel);

afterEach(async () => {
  if (!container) return;
  await act(() => {
    render(null, container);
  });
  container.remove();
  container = undefined as never;
});

describe('SendToClaudeSheet', () => {
  it('says what the file holds, in the owner’s words, and makes it without audio when it opens', async () => {
    const props = await show();
    expect(q('[data-testid="send-text"]')?.textContent).toBe(SEND_TO_CLAUDE_TEXT);
    expect(SEND_TO_CLAUDE_TEXT).toContain('No audio unless you tick Include audio.');
    expect(props.build).toHaveBeenCalledWith(sirens.id, { includeAudio: false });
    expect(q('[role="switch"]')?.getAttribute('aria-checked')).toBe('false');
    expect(q('[data-testid="send-status"]')?.textContent).toBe('3 takes ready.');
    expect(q<HTMLButtonElement>('[data-testid="send-share"]')!.disabled).toBe(false);
  });

  it('shows that it is working while the file is made', async () => {
    let finish: (f: CoachingFile) => void = () => undefined;
    await show({ build: vi.fn(() => new Promise<CoachingFile>((resolve) => (finish = resolve))) });
    expect(q('[data-testid="send-status"]')?.textContent).toBe('Getting your takes ready…');
    expect(q<HTMLButtonElement>('[data-testid="send-share"]')!.disabled).toBe(true);
    finish(file(1));
    await flush();
    expect(q('[data-testid="send-status"]')?.textContent).toBe('1 take ready.');
  });

  it('makes the file again with audio when Include audio is ticked', async () => {
    const props = await show();
    await act(() => {
      q<HTMLButtonElement>('[role="switch"]')!.click();
    });
    await flush();
    expect(props.build).toHaveBeenLastCalledWith(sirens.id, { includeAudio: true });
    expect(q('[data-testid="send-status"]')?.textContent).toBe('3 takes ready, with audio.');
  });

  it('hands the file over straight from the Share tap, marked as coming from a tap', async () => {
    const props = await show();
    q<HTMLButtonElement>('[data-testid="send-share"]')!.click();
    // Synchronously, inside the tap: no await between the click and the save.
    expect(props.save).toHaveBeenCalledTimes(1);
    const [blob, name, opts] = vi.mocked(props.save!).mock.calls[0];
    expect(name).toMatch(/^pitch-lab-coach-foundations-05-\d{4}-\d\d-\d\d-\d{4}\.json$/);
    expect(opts).toEqual({ fromTap: true });
    expect(JSON.parse(await blob.text())).toMatchObject({ app: 'pitch-lab', kind: 'coaching' });
    await flush();
    expect(container.textContent).toContain('Now tell Claude in chat which lesson it is.');
  });

  it('says where a download went, and says nothing when the share sheet is dismissed', async () => {
    await show({ save: vi.fn(async (): Promise<SaveOutcome> => 'downloaded') });
    q<HTMLButtonElement>('[data-testid="send-share"]')!.click();
    await flush();
    expect(container.textContent).toContain('Look in your Downloads');
    await act(() => {
      render(null, container);
    });
    container.remove();
    await show({ save: vi.fn(async (): Promise<SaveOutcome> => 'cancelled') });
    q<HTMLButtonElement>('[data-testid="send-share"]')!.click();
    await flush();
    expect(q('.pl-banner')).toBeNull();
  });

  it('has nothing to share before the exercise has been sung', async () => {
    await show({ build: vi.fn(async () => file(0)) });
    expect(q('[data-testid="send-status"]')?.textContent).toBe('There are no takes of this exercise yet. Sing it once, then come back here.');
    expect(q<HTMLButtonElement>('[data-testid="send-share"]')!.disabled).toBe(true);
  });

  it('says plainly when the file could not be made', async () => {
    await show({ build: vi.fn(async () => Promise.reject(new Error('Storage is not available.'))) });
    expect(q('.pl-banner--error')?.textContent).toContain('The file could not be made. Storage is not available.');
  });

  it('starts without audio every time it opens', async () => {
    const props = await show();
    await act(() => {
      q<HTMLButtonElement>('[role="switch"]')!.click();
    });
    await flush();
    await act(() => {
      render(<SendToClaudeSheet {...props} open={false} />, container);
    });
    await act(() => {
      render(<SendToClaudeSheet {...props} open />, container);
    });
    await flush();
    expect(q('[role="switch"]')?.getAttribute('aria-checked')).toBe('false');
    expect(props.build).toHaveBeenLastCalledWith(sirens.id, { includeAudio: false });
  });
});
