// @vitest-environment happy-dom
/**
 * Profiles: the list, switching, creating, renaming, and deleting behind a typed name. The session's async
 * operations are replaced by spies (they are the runtime builder's); the signals and the progress maths are real.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'preact/test-utils';
import { render } from 'preact';
import type { KVStore } from '../../storage/kv-types';

vi.mock('../../storage/kv', () => ({
  openKV: async (): Promise<KVStore> => ({ persistent: true, get: async () => undefined, set: async () => {}, delete: async () => {}, keys: async () => [] }),
}));
vi.mock('../../state/session', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../state/session')>();
  return {
    ...actual,
    switchProfile: vi.fn(),
    createProfile: vi.fn(),
    renameProfile: vi.fn(),
    setProfileVoiceType: vi.fn(),
    deleteProfile: vi.fn(),
  };
});

import { resetRouterForTests } from '../../router';
import * as session from '../../state/session';
import { toasts } from '../../state/toast';
import type { AppStorage } from '../../storage';
import type { ProfileRecord } from '../../storage/schema';
import { passWorld, profileRecord, snapshotOf } from '../progress/test-fixtures';
import { Profiles } from './Profiles';

const me = profileRecord({ id: 'p1', name: 'Daniel Reyes', voiceType: 'tenor', range: { comfortable: { low: 48, high: 69 }, extended: { low: 45, high: 72 }, measuredAt: '2026-10-01T10:00:00.000Z' } });
const sam = profileRecord({ id: 'p2', name: 'Sam', voiceType: 'unknown' });

let container: HTMLElement;

async function mount(list: ProfileRecord[] = [me, sam]): Promise<void> {
  session.profiles.value = list;
  session.activeProfile.value = list[0];
  session.snapshot.value = snapshotOf(passWorld('foundations', 'foundations.13', { profileId: 'p1' }), Date.now(), 'p1');
  session.appStorage.value = {
    attempts: { listByProfile: async (id: string) => (id === 'p2' ? passWorld('foundations', 'foundations.02', { profileId: 'p2' }) : []) },
  } as unknown as AppStorage;
  container = document.createElement('div');
  document.body.appendChild(container);
  await act(() => {
    render(<Profiles />, container);
  });
  await flush();
}

const text = (root: ParentNode = container): string => root.textContent ?? '';
const dialog = (): HTMLElement => container.querySelector('[role="dialog"]') as HTMLElement;
const buttonIn = (root: ParentNode, label: string): HTMLButtonElement => {
  const found = Array.from(root.querySelectorAll<HTMLButtonElement>('button')).find((b) => b.textContent?.trim() === label || b.getAttribute('aria-label') === label);
  if (!found) throw new Error(`no button "${label}" in ${text(root).slice(0, 200)}`);
  return found;
};
async function click(el: HTMLElement): Promise<void> {
  await act(() => {
    el.click();
  });
}
async function type(el: HTMLInputElement, value: string): Promise<void> {
  await act(() => {
    el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
/** Let pending promises settle (a macrotask), then the render they trigger. */
async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

beforeEach(() => {
  resetRouterForTests();
  toasts.value = [];
  vi.mocked(session.switchProfile).mockResolvedValue(undefined);
  vi.mocked(session.createProfile).mockImplementation(async (input) => profileRecord({ id: 'p3', name: input.name, voiceType: input.voiceType ?? 'unknown' }));
  vi.mocked(session.renameProfile).mockResolvedValue(undefined);
  vi.mocked(session.setProfileVoiceType).mockResolvedValue(undefined);
  vi.mocked(session.deleteProfile).mockResolvedValue(undefined);
});

afterEach(async () => {
  await act(() => {
    render(null, container);
  });
  container.remove();
  vi.clearAllMocks();
  session.profiles.value = [];
  session.activeProfile.value = null;
  session.appStorage.value = null;
});

describe('Profiles: the list', () => {
  it('shows initials, name, voice type, range and where each singer is up to', async () => {
    await mount();
    const rows = Array.from(container.querySelectorAll('.pl-profiles-item'));
    expect(rows).toHaveLength(2);
    expect(rows[0].querySelector('.pl-profiles-avatar')!.textContent).toBe('DR');
    expect(text(rows[0])).toContain('Daniel Reyes');
    expect(text(rows[0])).toContain('Tenor');
    expect(text(rows[0])).toContain('C3–A4');
    expect(text(rows[0])).toContain('Up next: Two notes, one step apart (Foundations)'); // the active profile reads the live snapshot
    expect(text(rows[1])).toContain('Sam');
    expect(text(rows[1])).toContain('Not sure');
    expect(text(rows[1])).toContain('Range not measured');
    expect(text(rows[1])).toContain('Up next: Hold it (Foundations)'); // another profile, from its own stored log
  });

  it('marks the active profile with a check and makes it a non-button', async () => {
    await mount();
    const rows = Array.from(container.querySelectorAll('.pl-profiles-item'));
    expect(rows[0].querySelector('.pl-profiles-main')!.tagName).toBe('DIV');
    expect(rows[0].querySelector('.pl-profiles-check')).not.toBeNull();
    expect(text(rows[0])).toContain('Active profile');
    expect(rows[1].querySelector('.pl-profiles-main')!.tagName).toBe('BUTTON');
    expect(rows[1].querySelector('.pl-profiles-check')).toBeNull();
  });
});

describe('Profiles: storage that could not open', () => {
  it('shows why there are no profiles instead of inviting a create that cannot work', async () => {
    session.bootPhase.value = 'failed';
    session.bootError.value = 'Pitch Lab could not open the data saved on this device. (blocked)';
    try {
      await mount([]);
      expect(text()).toContain('could not open the data saved on this device. (blocked)');
      expect(text()).not.toContain('No profiles yet');
    } finally {
      session.bootPhase.value = 'booting';
      session.bootError.value = null;
    }
  });
});

describe('Profiles: switching', () => {
  it('tapping another singer switches to them', async () => {
    await mount();
    await click(buttonIn(container, 'Sing as Sam'));
    expect(session.switchProfile).toHaveBeenCalledWith('p2');
  });

  it('says so when the switch fails, and lets the singer try again', async () => {
    vi.mocked(session.switchProfile).mockRejectedValue(new Error('the database is busy'));
    await mount();
    await click(buttonIn(container, 'Sing as Sam'));
    await flush();
    expect(text()).toContain('Could not switch to Sam. the database is busy');
    expect(buttonIn(container, 'Sing as Sam').disabled).toBe(false);
  });
});

describe('Profiles: new profile', () => {
  it('needs a name, then creates the profile with its voice type and switches to it', async () => {
    await mount();
    await click(buttonIn(container, 'New profile'));
    const sheet = dialog();
    const create = buttonIn(sheet, 'Create profile');
    expect(create.disabled).toBe(true);
    await type(sheet.querySelector<HTMLInputElement>('#new-profile-name')!, '  Sam  Jr ');
    expect(create.disabled).toBe(false);
    await click(buttonIn(sheet, 'Baritone'));
    await click(create);
    await flush();
    expect(session.createProfile).toHaveBeenCalledWith({ name: 'Sam Jr', voiceType: 'baritone' });
    expect(session.switchProfile).toHaveBeenCalledWith('p3');
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });

  it('can create without switching', async () => {
    await mount();
    await click(buttonIn(container, 'New profile'));
    const sheet = dialog();
    await type(sheet.querySelector<HTMLInputElement>('#new-profile-name')!, 'Alex');
    await click(sheet.querySelector<HTMLButtonElement>('[role="switch"]')!);
    await click(buttonIn(sheet, 'Create profile'));
    await flush();
    expect(session.createProfile).toHaveBeenCalledTimes(1);
    expect(session.switchProfile).not.toHaveBeenCalled();
  });

  it('shows why a profile could not be created and keeps the sheet open', async () => {
    vi.mocked(session.createProfile).mockRejectedValue(new Error('the database is full'));
    await mount();
    await click(buttonIn(container, 'New profile'));
    const sheet = dialog();
    await type(sheet.querySelector<HTMLInputElement>('#new-profile-name')!, 'Alex');
    await click(buttonIn(sheet, 'Create profile'));
    await flush();
    expect(text(dialog())).toContain('Could not create the profile. the database is full');
  });
});

describe('Profiles: rename and voice type', () => {
  it('saves only what changed', async () => {
    await mount();
    await click(buttonIn(container, 'Edit Sam'));
    const sheet = dialog();
    const save = buttonIn(sheet, 'Save');
    expect(save.disabled).toBe(true); // nothing changed yet
    await type(sheet.querySelector<HTMLInputElement>('#edit-profile-name')!, 'Samuel');
    await click(buttonIn(sheet, 'Tenor'));
    expect(save.disabled).toBe(false);
    await click(save);
    await flush();
    expect(session.renameProfile).toHaveBeenCalledWith('p2', 'Samuel');
    expect(session.setProfileVoiceType).toHaveBeenCalledWith('p2', 'tenor');
  });

  it('does not rename when only the voice type changed', async () => {
    await mount();
    await click(buttonIn(container, 'Edit Sam'));
    const sheet = dialog();
    await click(buttonIn(sheet, 'Baritone'));
    await click(buttonIn(sheet, 'Save'));
    await flush();
    expect(session.renameProfile).not.toHaveBeenCalled();
    expect(session.setProfileVoiceType).toHaveBeenCalledWith('p2', 'baritone');
  });
});

describe('Profiles: delete needs the typed name', () => {
  async function openDelete(name: string): Promise<HTMLElement> {
    await click(buttonIn(container, `Edit ${name}`));
    await click(buttonIn(dialog(), 'Delete this profile'));
    return dialog();
  }

  it('keeps Delete off until the name is typed, ignoring case and stray spaces', async () => {
    await mount();
    const sheet = await openDelete('Daniel Reyes');
    const del = buttonIn(sheet, 'Delete profile');
    expect(del.disabled).toBe(true);
    const input = sheet.querySelector<HTMLInputElement>('#delete-profile-name')!;
    await type(input, 'Daniel');
    expect(del.disabled).toBe(true);
    await type(input, 'daniel   reyes ');
    expect(del.disabled).toBe(false);
    await type(input, 'Daniel Reye');
    expect(del.disabled).toBe(true);
    expect(session.deleteProfile).not.toHaveBeenCalled();
  });

  it('deletes with the recordings by default, and can be told to keep them', async () => {
    await mount();
    let sheet = await openDelete('Sam');
    expect(text(sheet)).toContain('Also delete recordings');
    expect(sheet.querySelector('[role="switch"]')!.getAttribute('aria-checked')).toBe('true');
    await type(sheet.querySelector<HTMLInputElement>('#delete-profile-name')!, 'Sam');
    await click(buttonIn(sheet, 'Delete profile'));
    await flush();
    expect(session.deleteProfile).toHaveBeenCalledWith('p2', { removeRecordings: true });
    expect(toasts.value.map((t) => t.message)).toContain('Sam deleted.');

    // Again, this time keeping the recordings.
    await act(() => {
      render(null, container);
    });
    toasts.value = [];
    await mount();
    sheet = await openDelete('Sam');
    await click(sheet.querySelector<HTMLButtonElement>('[role="switch"]')!);
    await type(sheet.querySelector<HTMLInputElement>('#delete-profile-name')!, 'sam');
    await click(buttonIn(sheet, 'Delete profile'));
    await flush();
    expect(session.deleteProfile).toHaveBeenLastCalledWith('p2', { removeRecordings: false });
  });

  it('shows a failed delete as failed: the profile is kept, nothing is called "deleted"', async () => {
    vi.mocked(session.deleteProfile).mockRejectedValue(new Error('takes/abc.wav would not delete'));
    await mount();
    const sheet = await openDelete('Sam');
    await type(sheet.querySelector<HTMLInputElement>('#delete-profile-name')!, 'Sam');
    await click(buttonIn(sheet, 'Delete profile'));
    await flush();
    const after = dialog();
    expect(after).not.toBeNull();
    expect(text(after)).toContain('Sam was not deleted.');
    expect(text(after)).toContain('takes/abc.wav would not delete');
    expect(text(after)).toContain('The profile was kept');
    expect(toasts.value.map((t) => t.message)).not.toContain('Sam deleted.');
    // The singer can try again.
    expect(buttonIn(after, 'Delete profile').disabled).toBe(false);
  });

  it('warns that the last profile is replaced by an empty one', async () => {
    await mount([me]);
    const sheet = await openDelete('Daniel Reyes');
    expect(text(sheet)).toContain('only profile');
  });
});
