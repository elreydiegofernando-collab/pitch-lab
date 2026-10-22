// @vitest-environment happy-dom
/**
 * The profile sheets keep what is typed the moment they open: their fields are reset before the opened sheet is first
 * painted (a layout effect), never by an effect that lands after the singer's first keystrokes.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render } from 'preact';
import { act } from 'preact/test-utils';

vi.mock('../../state/session', () => ({
  createProfile: vi.fn(),
  deleteProfile: vi.fn(),
  renameProfile: vi.fn(),
  setProfileVoiceType: vi.fn(),
  switchProfile: vi.fn(),
}));

import { profileRecord } from './test-fixtures';
import { DeleteProfileSheet, EditProfileSheet, NewProfileSheet } from './ProfileSheets';

let container: HTMLElement;

afterEach(async () => {
  await act(() => {
    render(null, container);
  });
  container.remove();
});

/** Type into a field the way a keystroke does (no act: the sheet's own after-paint effects must get their chance). */
function typeNow(input: HTMLInputElement, value: string): void {
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

/** Let everything scheduled settle: re-renders, and effects that run after paint. */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 150));
  });
}

async function mountClosed(node: preact.ComponentChild): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  await act(() => {
    render(node, container);
  });
}

const sam = profileRecord({ id: 'p2', name: 'Sam', voiceType: 'unknown' });

describe('profile sheets keep the first keystrokes', () => {
  it('New profile: a name typed as the sheet opens stays', async () => {
    const props = { onClose: () => undefined, onProblem: () => undefined };
    await mountClosed(<NewProfileSheet open={false} {...props} />);
    render(<NewProfileSheet open {...props} />, container); // opens: no act, as in the browser
    typeNow(container.querySelector<HTMLInputElement>('#new-profile-name')!, 'Ana');
    await settle();
    expect(container.querySelector<HTMLInputElement>('#new-profile-name')!.value).toBe('Ana');
    const create = [...container.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.includes('Create profile'))!;
    expect(create.disabled).toBe(false);
  });

  it('Edit profile: opens with the profile\'s own name painted, and an edit made at once stays', async () => {
    const props = { onClose: () => undefined, onDelete: () => undefined };
    await mountClosed(<EditProfileSheet profile={null} {...props} />);
    render(<EditProfileSheet profile={sam} {...props} />, container);
    // The render the reset queued runs in a microtask, before the browser paints (effects come only after the paint).
    await Promise.resolve();
    await Promise.resolve();
    const field = container.querySelector<HTMLInputElement>('#edit-profile-name')!;
    expect(field.value).toBe('Sam'); // already there in the first frame
    typeNow(field, 'Samuel');
    await settle();
    expect(container.querySelector<HTMLInputElement>('#edit-profile-name')!.value).toBe('Samuel');
  });

  it('Delete profile: the confirmation typed as the sheet opens stays, and enables Delete', async () => {
    const props = { isOnly: false, onClose: () => undefined };
    await mountClosed(<DeleteProfileSheet profile={null} {...props} />);
    render(<DeleteProfileSheet profile={sam} {...props} />, container);
    typeNow(container.querySelector<HTMLInputElement>('[data-testid="delete-profile-confirm"]')!, 'Sam');
    await settle();
    expect(container.querySelector<HTMLInputElement>('[data-testid="delete-profile-confirm"]')!.value).toBe('Sam');
    const del = [...container.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim() === 'Delete profile')!;
    expect(del.disabled).toBe(false);
  });

  it('Delete profile: says "This profile", never "Me and their progress", and names the imported songs it erases', async () => {
    const me = profileRecord({ id: 'p1', name: 'Me', voiceType: 'unknown' });
    await mountClosed(<DeleteProfileSheet profile={me} isOnly={false} onClose={() => undefined} />);
    expect(container.textContent).toContain('This profile and its progress will no longer appear in Pitch Lab on this device.');
    expect(container.textContent).not.toContain('Me and their progress');
    expect(container.textContent).toContain('the songs it imported');
  });
});
