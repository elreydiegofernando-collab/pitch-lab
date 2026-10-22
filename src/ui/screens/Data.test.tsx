// @vitest-environment happy-dom
/**
 * Data & backup against a fake AppStorage: the storage card, export and import of a backup, the recordings list
 * (play, export WAV, delete) and Delete all data. The point of these tests is honesty: a delete that rejects is
 * shown as failed, buttons stay off while something runs, and nothing is called "deleted" that is not.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'preact/test-utils';
import { render } from 'preact';
import type { KVStore } from '../../storage/kv-types';

vi.mock('../../storage/kv', () => ({
  openKV: async (): Promise<KVStore> => ({ persistent: true, get: async () => undefined, set: async () => {}, delete: async () => {}, keys: async () => [] }),
}));
vi.mock('../../state/session', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../state/session')>();
  return { ...actual, reloadSession: vi.fn(), isUnlocked: vi.fn() };
});
const { ensureContext } = vi.hoisted(() => ({ ensureContext: vi.fn(() => ({ marker: 'ctx' })) }));
vi.mock('../../audio/engine', () => ({ getEngine: () => ({ ensureContext }) }));
vi.mock('../progress/save-file', () => ({
  saveFile: vi.fn(),
  defaultSaveEnv: () => ({ preferShare: true, canShare: () => true, share: async () => {}, download: () => {} }),
}));
vi.mock('../progress/playback', () => ({ playWav: vi.fn() }));


import { requirementHint } from '../../progress';
import { resetRouterForTests, route, routeOf } from '../../router';
import * as session from '../../state/session';
import { toasts } from '../../state/toast';
import type { AppStorage, ImportReport, StorageUsage } from '../../storage';
import type { TakeRecord } from '../../storage/schema';
import { playWav } from '../progress/playback';
import { saveFile } from '../progress/save-file';
import { profileRecord, takeRecord } from '../progress/test-fixtures';
import { Data } from './Data';

const USAGE: StorageUsage = {
  persistent: true,
  dbFallbackReason: null,
  binaryBackend: 'opfs',
  attemptCount: 120,
  takeCount: 3,
  binaryBytes: 5 * 1024 * 1024,
  origin: { usage: 10 * 1024 * 1024, quota: 2 * 1024 ** 3 },
};

const REPORT: ImportReport = {
  ok: true,
  profilesAdded: 1,
  profilesUpdated: 0,
  profilesDeleted: 0,
  profilesRestored: 0,
  profilesSkipped: 0,
  profilesRejected: 0,
  attemptsAdded: 42,
  attemptsSkipped: 0,
  attemptsRejected: 0,
  settingsRestored: 1,
  retiredDefaultProfileId: null,
  errors: [],
};

// Oldest first, as storage.takes.listByProfile returns them.
const TAKES: TakeRecord[] = [
  takeRecord({ id: 't-old', exerciseId: 'foundations.sustain.1', createdAt: '2026-10-19T15:00:00.000Z', updatedAt: '2026-10-19T15:00:00.000Z' }),
  takeRecord({ id: 't-mid', exerciseId: 'foundations.siren.1', createdAt: '2026-10-20T15:00:00.000Z', updatedAt: '2026-10-20T15:00:00.000Z', audioRef: null }),
  takeRecord({ id: 't-new', exerciseId: 'foundations.staccato.1', createdAt: '2026-10-21T15:00:00.000Z', updatedAt: '2026-10-21T15:00:00.000Z' }),
];

interface Fake {
  storage: AppStorage;
  usage: ReturnType<typeof vi.fn>;
  listByProfile: ReturnType<typeof vi.fn>;
  audio: ReturnType<typeof vi.fn>;
  deleteTake: ReturnType<typeof vi.fn>;
  exportJson: ReturnType<typeof vi.fn>;
  importBackup: ReturnType<typeof vi.fn>;
  deleteAllData: ReturnType<typeof vi.fn>;
}

function fakeStorage(over: { usage?: StorageUsage } = {}): Fake {
  const usage = vi.fn(async () => over.usage ?? USAGE);
  const listByProfile = vi.fn(async () => [...TAKES]);
  const audio = vi.fn(async () => new Blob([new Uint8Array([1, 2, 3, 4])], { type: '' }));
  const deleteTake = vi.fn(async () => {});
  const exportJson = vi.fn(async () => '{"format":"pitch-lab-backup","version":1}');
  const importBackup = vi.fn(async () => REPORT);
  const deleteAllData = vi.fn(async () => {});
  const kv: KVStore = { persistent: true, get: async () => undefined, set: async () => {}, delete: async () => {}, keys: async () => [] };
  const storage = {
    kv,
    usage,
    deleteAllData,
    backup: { exportJson, fileName: vi.fn(() => 'pitch-lab-backup-2026-10-21.json'), import: importBackup },
    takes: { retention: { maxTakesPerProfile: 20, maxAudioBytes: 1e9 }, listByProfile, audio, delete: deleteTake },
  } as unknown as AppStorage;
  return { storage, usage, listByProfile, audio, deleteTake, exportJson, importBackup, deleteAllData };
}

let container: HTMLElement;
let fake: Fake;
let realIsUnlocked: typeof session.isUnlocked;

beforeAll(async () => {
  realIsUnlocked = (await vi.importActual<typeof import('../../state/session')>('../../state/session')).isUnlocked;
});

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}
async function mount(f: Fake | null = fake): Promise<void> {
  session.appStorage.value = f ? f.storage : null;
  session.activeProfile.value = profileRecord({ id: 'p1', name: 'Daniel' });
  container = document.createElement('div');
  document.body.appendChild(container);
  await act(() => {
    render(<Data />, container);
  });
  await settle();
}
const text = (root: ParentNode = container): string => root.textContent ?? '';
const rows = (): HTMLElement[] => Array.from(container.querySelectorAll<HTMLElement>('[data-testid="recording-row"]'));
function buttonIn(root: ParentNode, label: string): HTMLButtonElement {
  const found = Array.from(root.querySelectorAll<HTMLButtonElement>('button')).find((b) => b.textContent?.trim() === label || b.getAttribute('aria-label') === label);
  if (!found) throw new Error(`no button "${label}" in ${text(root).slice(0, 240)}`);
  return found;
}
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

beforeEach(() => {
  vi.mocked(session.isUnlocked).mockImplementation(realIsUnlocked);
  fake = fakeStorage();
  resetRouterForTests([routeOf('home'), routeOf('data')]);
  toasts.value = [];
  vi.mocked(session.reloadSession).mockResolvedValue(undefined);
  vi.mocked(saveFile).mockResolvedValue('downloaded');
});

afterEach(async () => {
  await act(() => {
    render(null, container);
  });
  container.remove();
  vi.clearAllMocks();
  session.appStorage.value = null;
  session.activeProfile.value = null;
});

describe('Data: storage that could not open', () => {
  it('says why, rather than "still opening", and offers nothing it cannot do', async () => {
    session.bootPhase.value = 'failed';
    session.bootError.value = 'Pitch Lab could not open the data saved on this device. (blocked)';
    try {
      await mount(null);
      expect(text()).toContain('could not open the data saved on this device. (blocked)');
      expect(text()).not.toContain('still opening');
      expect(buttonIn(container, 'Export backup').disabled).toBe(true);
      expect(buttonIn(container, 'Import backup').disabled).toBe(true);
      expect(buttonIn(container, 'Delete all data').disabled).toBe(true);
    } finally {
      session.bootPhase.value = 'booting';
      session.bootError.value = null;
    }
  });

  it('says it is still opening while boot is in progress', async () => {
    await mount(null);
    expect(text()).toContain('Storage is still opening');
  });
});

describe('Data: storage', () => {
  it('shows that the data is saved, and how much of it there is', async () => {
    await mount();
    expect(text(container.querySelector('[data-testid="storage-durable"]')!)).toContain('Saved on this device');
    const card = text(container.querySelector('[data-testid="storage-card"]')!);
    expect(card).toContain('120');
    expect(card).toContain('5.0 MB');
    expect(card).toContain('10.0 MB of 2.0 GB');
  });

  it('warns, with the reason, when this launch is not saving anything', async () => {
    await mount(fakeStorage({ usage: { ...USAGE, persistent: false, dbFallbackReason: 'IndexedDB is blocked in private browsing' } }));
    const status = container.querySelector('[data-testid="storage-durable"]')!;
    expect(text(status)).toContain('Not saved between visits');
    expect(text(container.querySelector('[data-testid="storage-card"]')!)).toContain('IndexedDB is blocked in private browsing');
  });

  it('says the browser does not report its quota rather than guessing', async () => {
    await mount(fakeStorage({ usage: { ...USAGE, origin: { usage: null, quota: null } } }));
    expect(text()).toContain('Not reported by this browser');
  });
});

describe('Data: exports go through the unlock registry', () => {
  it('shows the requirement, and no export control, while Backup and export is locked', async () => {
    vi.mocked(session.isUnlocked).mockImplementation((id) => (id === 'export' ? false : realIsUnlocked(id)));
    await mount();
    expect(text()).toContain(requirementHint('export'));
    const labels = Array.from(container.querySelectorAll('button')).map((b) => b.getAttribute('aria-label') ?? b.textContent?.trim());
    expect(labels).not.toContain('Export backup');
    expect(labels.some((l) => l?.startsWith('Export WAV'))).toBe(false);
    // Importing and playing are not exports.
    expect(labels).toContain('Import backup');
  });
});

describe('Data: when the share sheet needs a fresh tap (iPhone)', () => {
  it('parks the backup behind a Share button and hands it over straight from that tap', async () => {
    vi.mocked(saveFile).mockResolvedValueOnce('needs-tap');
    await mount();
    await click(buttonIn(container, 'Export backup'));
    await settle();
    expect(text()).toContain('Your backup is ready.');
    expect(text()).not.toContain('Started the download');
    expect(saveFile).toHaveBeenCalledTimes(1);

    vi.mocked(saveFile).mockResolvedValueOnce('shared');
    const share = buttonIn(container, 'Share backup');
    // No await between the tap and the call: the share sheet gets its fresh gesture.
    share.click();
    expect(saveFile).toHaveBeenCalledTimes(2);
    const [blob, name, env, options] = vi.mocked(saveFile).mock.calls[1];
    expect((blob as Blob).type).toBe('application/json');
    expect(name).toBe('pitch-lab-backup-2026-10-21.json');
    expect(env).toBeUndefined();
    expect(options).toEqual({ fromTap: true });
    await settle();
    expect(text()).toContain('Shared pitch-lab-backup-2026-10-21.json.');
    expect(text()).not.toContain('Your backup is ready.');
  });

  it('keeps the Share button when the sheet is dismissed, and can download instead', async () => {
    vi.mocked(saveFile).mockResolvedValueOnce('needs-tap');
    await mount();
    await click(buttonIn(container, 'Export backup'));
    await settle();

    vi.mocked(saveFile).mockResolvedValueOnce('cancelled');
    await click(buttonIn(container, 'Share backup'));
    await settle();
    expect(text()).toContain('Your backup is ready.');

    vi.mocked(saveFile).mockResolvedValueOnce('downloaded');
    await click(buttonIn(container, 'Download instead'));
    await settle();
    const env = vi.mocked(saveFile).mock.calls[2][2] as { preferShare: boolean };
    expect(env.preferShare).toBe(false);
    expect(text()).toContain('Started the download of pitch-lab-backup-2026-10-21.json');
    expect(text()).not.toContain('Your backup is ready.');
  });

  it("does the same for a take's WAV", async () => {
    vi.mocked(saveFile).mockResolvedValueOnce('needs-tap');
    await mount();
    await click(buttonIn(rows()[0], 'Export WAV of Crispness'));
    await settle();
    expect(text()).toContain('Your WAV is ready.');
    vi.mocked(saveFile).mockResolvedValueOnce('shared');
    await click(buttonIn(container, 'Share WAV'));
    await settle();
    const name = vi.mocked(saveFile).mock.calls[1][1];
    expect(name).toMatch(/^pitch-lab-take-\d{4}-\d{2}-\d{2}\.wav$/);
    expect(text()).toContain(`Shared ${name}.`);
  });

  it('reports a hand-over that threw', async () => {
    vi.mocked(saveFile).mockResolvedValueOnce('needs-tap');
    await mount();
    await click(buttonIn(container, 'Export backup'));
    await settle();
    vi.mocked(saveFile).mockRejectedValueOnce(new Error('blocked by the browser'));
    await click(buttonIn(container, 'Download instead'));
    await settle();
    expect(text()).toContain('Could not hand over pitch-lab-backup-2026-10-21.json. blocked by the browser');
  });
});

describe('Data: backup', () => {
  it('exports every profile as a JSON file, named by the singer\'s own day', async () => {
    await mount();
    await click(buttonIn(container, 'Export backup'));
    await settle();
    expect(fake.exportJson).toHaveBeenCalledTimes(1);
    expect(saveFile).toHaveBeenCalledTimes(1);
    const [blob, name] = vi.mocked(saveFile).mock.calls[0];
    expect((blob as Blob).type).toBe('application/json');
    expect(name).toBe('pitch-lab-backup-2026-10-21.json');
    expect(text()).toContain('Started the download of pitch-lab-backup-2026-10-21.json');
  });

  it('says nothing about a share sheet the singer dismissed', async () => {
    vi.mocked(saveFile).mockResolvedValue('cancelled');
    await mount();
    await click(buttonIn(container, 'Export backup'));
    await settle();
    expect(text()).not.toContain('Started the download');
    expect(text()).not.toContain('Shared');
  });

  it('shows an export that failed', async () => {
    fake.exportJson.mockRejectedValue(new Error('the database is closed'));
    await mount();
    await click(buttonIn(container, 'Export backup'));
    await settle();
    expect(text()).toContain('Could not export the backup. the database is closed');
  });

  async function chooseFile(contents: string, name = 'backup.json'): Promise<void> {
    const input = container.querySelector<HTMLInputElement>('[data-testid="import-file"]')!;
    const file = new File([contents], name, { type: 'application/json' });
    Object.defineProperty(input, 'files', { value: [file], configurable: true });
    await act(async () => {
      input.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await settle();
  }

  it('imports a file, reports it in plain words, then reloads the session', async () => {
    await mount();
    await chooseFile('{"format":"pitch-lab-backup","version":1,"profiles":[],"attempts":[]}');
    expect(fake.importBackup).toHaveBeenCalledTimes(1);
    const [fileText, options] = fake.importBackup.mock.calls[0] as [string, { kv: KVStore; retireEmptyDefaultProfile: boolean }];
    expect(fileText).toContain('pitch-lab-backup');
    expect(options.kv).toBe(fake.storage.kv);
    expect(options.retireEmptyDefaultProfile).toBe(true);
    const report = container.querySelector('[data-testid="import-report"]')!;
    expect(text(report)).toContain('Backup imported.');
    expect(text(report)).toContain('Added 1 profile.');
    expect(text(report)).toContain('Added 42 attempts');
    expect(session.reloadSession).toHaveBeenCalledTimes(1);
  });

  it('asks for an explicit restore (a deleted profile the file holds comes back)', async () => {
    await mount();
    await chooseFile('{"format":"pitch-lab-backup","version":1,"profiles":[],"attempts":[]}');
    const [, options] = fake.importBackup.mock.calls[0] as [string, { restoreDeleted?: boolean }];
    expect(options.restoreDeleted).toBe(true);
  });

  it('an import that changed nothing leaves the session (and a setting changed a moment ago) alone: no reload', async () => {
    fake.importBackup.mockResolvedValue({ ...REPORT, profilesAdded: 0, attemptsAdded: 0, settingsRestored: 0, retiredDefaultProfileId: null, attemptsSkipped: 3 });
    await mount();
    await chooseFile('{"format":"pitch-lab-backup","version":1,"profiles":[],"attempts":[]}');
    expect(text(container.querySelector('[data-testid="import-report"]')!)).toContain('Nothing new in that backup.');
    expect(session.reloadSession).not.toHaveBeenCalled();
  });

  it('writes a setting changed a moment before the import, under its own profile, before the file is read in', async () => {
    const settings = await import('../../state/settings');
    const order: string[] = [];
    const flush = vi.spyOn(settings, 'flushSettings');
    flush.mockImplementation(async () => {
      order.push('flush');
    });
    fake.importBackup.mockImplementation(async () => {
      order.push('import');
      return REPORT;
    });
    await mount();
    await chooseFile('{"format":"pitch-lab-backup","version":1,"profiles":[],"attempts":[]}');
    expect(order.slice(0, 2)).toEqual(['flush', 'import']);
    flush.mockRestore();
  });

  it('says so when the backup was merged but the session could not reload, without calling it a failed import', async () => {
    vi.mocked(session.reloadSession).mockRejectedValue(new Error('the database is busy'));
    await mount();
    await chooseFile('{"format":"pitch-lab-backup","version":1,"profiles":[],"attempts":[]}');
    expect(text(container.querySelector('[data-testid="import-report"]')!)).toContain('Backup imported.');
    expect(text()).toContain('The backup was merged, but Pitch Lab could not reload what is stored. the database is busy');
    expect(text()).not.toContain('Could not import the backup.');
  });

  it('shows a file that is not a backup as not imported', async () => {
    fake.importBackup.mockResolvedValue({ ...REPORT, ok: false, profilesAdded: 0, attemptsAdded: 0, settingsRestored: 0, errors: ['not a recognised pitch-lab-backup file'] });
    await mount();
    await chooseFile('hello');
    const report = container.querySelector('[data-testid="import-report"]')!;
    expect(text(report)).toContain('That file was not imported.');
    expect(text(report)).toContain('not a recognised pitch-lab-backup file');
    expect(report.getAttribute('role')).toBe('alert');
  });

  it('refuses a file too large to be a backup without reading it', async () => {
    await mount();
    const input = container.querySelector<HTMLInputElement>('[data-testid="import-file"]')!;
    const huge = { size: 200 * 1024 * 1024, text: vi.fn() };
    Object.defineProperty(input, 'files', { value: [huge], configurable: true });
    await act(async () => {
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await settle();
    expect(text()).toContain('too large to be a Pitch Lab backup');
    expect(huge.text).not.toHaveBeenCalled();
    expect(fake.importBackup).not.toHaveBeenCalled();
  });
});

describe('Data: recordings', () => {
  it('lists the takes newest first with title, date, length and an audio badge', async () => {
    await mount();
    const list = rows();
    expect(list).toHaveLength(3);
    expect(text(list[0])).toContain('Crispness');
    expect(text(list[1])).toContain('Sirens & glides');
    expect(text(list[2])).toContain('Sustain I');
    expect(text(list[0])).toContain('0:02'); // 188 frames at 93.75 per second
    expect(text(list[0])).toContain('Audio');
    expect(text(list[1])).toContain('Pitch trace only');
    expect(text(container.querySelector('#data-recordings')!.parentElement!)).toContain('Exporting is the only way audio leaves this device.');
  });

  it('has nothing to play or export for a take with no audio', async () => {
    await mount();
    const noAudio = rows()[1];
    expect(buttonIn(noAudio, 'Play Sirens & glides').disabled).toBe(true);
    expect(buttonIn(noAudio, 'Export WAV of Sirens & glides').disabled).toBe(true);
    expect(buttonIn(noAudio, 'Delete Sirens & glides').disabled).toBe(false);
  });

  it('exports the stored WAV as pitch-lab-take-<date>.wav, the only way audio leaves', async () => {
    await mount();
    await click(buttonIn(rows()[0], 'Export WAV of Crispness'));
    await settle();
    expect(fake.audio).toHaveBeenCalledWith(expect.objectContaining({ id: 't-new' }));
    const [blob, name] = vi.mocked(saveFile).mock.calls[0];
    expect((blob as Blob).type).toBe('audio/wav');
    expect(name).toMatch(/^pitch-lab-take-\d{4}-\d{2}-\d{2}\.wav$/);
    expect(text()).toContain('Started the download of pitch-lab-take-');
  });

  it('starts playback inside the tap, before the audio is read back (the iOS gesture rule)', async () => {
    let release: (b: Blob) => void = () => {};
    fake.audio.mockImplementation(() => new Promise<Blob>((resolve) => (release = resolve)));
    const stop = vi.fn();
    vi.mocked(playWav).mockResolvedValue({ stop });
    await mount();
    await click(buttonIn(rows()[0], 'Play Crispness'));
    expect(ensureContext).toHaveBeenCalledTimes(1); // already created and resumed, with the audio not yet loaded
    expect(playWav).not.toHaveBeenCalled();
    await act(async () => {
      release(new Blob([new Uint8Array([1])]));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(playWav).toHaveBeenCalledTimes(1);
    expect(buttonIn(rows()[0], 'Stop Crispness')).toBeTruthy();
    await click(buttonIn(rows()[0], 'Stop Crispness'));
    expect(stop).toHaveBeenCalled();
  });

  it('asks before deleting, and "Keep it" changes nothing', async () => {
    await mount();
    await click(buttonIn(rows()[0], 'Delete Crispness'));
    expect(text(rows()[0])).toContain('Delete this recording');
    expect(fake.deleteTake).not.toHaveBeenCalled();
    await click(buttonIn(rows()[0], 'Keep it'));
    expect(rows()).toHaveLength(3);
    expect(fake.deleteTake).not.toHaveBeenCalled();
  });

  it('deletes a take, drops its row and refreshes the storage figures', async () => {
    await mount();
    expect(fake.usage).toHaveBeenCalledTimes(1);
    await click(buttonIn(rows()[0], 'Delete Crispness'));
    await click(buttonIn(rows()[0], 'Delete this recording'));
    await settle();
    expect(fake.deleteTake).toHaveBeenCalledWith('t-new');
    expect(rows()).toHaveLength(2);
    expect(text()).not.toContain('Crispness');
    expect(fake.usage).toHaveBeenCalledTimes(2);
  });

  it('shows a failed delete as failed: the take stays, with the reason, and can be tried again', async () => {
    fake.deleteTake.mockRejectedValue(new Error('takes/t-new.wav would not delete'));
    await mount();
    await click(buttonIn(rows()[0], 'Delete Crispness'));
    await click(buttonIn(rows()[0], 'Delete this recording'));
    await settle();
    expect(rows()).toHaveLength(3);
    const failed = rows()[0];
    expect(text(failed)).toContain('This recording was not deleted.');
    expect(text(failed)).toContain('takes/t-new.wav would not delete');
    expect(text(failed)).toContain('It is still saved');
    expect(fake.usage).toHaveBeenCalledTimes(1); // nothing changed, so nothing was refreshed
    // Every button is back, so the singer can retry.
    expect(buttonIn(failed, 'Delete this recording').disabled).toBe(false);
  });

  it('turns every row\'s buttons off while a delete is running', async () => {
    let finish: () => void = () => {};
    fake.deleteTake.mockImplementation(() => new Promise<void>((resolve) => (finish = resolve)));
    await mount();
    await click(buttonIn(rows()[0], 'Delete Crispness'));
    await click(buttonIn(rows()[0], 'Delete this recording'));
    const during = Array.from(container.querySelectorAll<HTMLButtonElement>('[data-testid="recording-row"] .pl-data-take__actions button'));
    expect(during.length).toBeGreaterThan(0);
    expect(during.every((b) => b.disabled)).toBe(true);
    // A second delete cannot start.
    await click(buttonIn(rows()[2], 'Delete Sustain I'));
    expect(fake.deleteTake).toHaveBeenCalledTimes(1);
    await act(async () => {
      finish();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(rows()).toHaveLength(2);
  });

  it('says there are no recordings when there are none', async () => {
    fake.listByProfile.mockResolvedValue([]);
    await mount();
    expect(text()).toContain('No recordings yet');
  });

  it('never tells a singer to turn on Keep take audio while it is on (the default), only while it is off', async () => {
    const { settings } = await import('../../state/settings');
    const { DEFAULT_SETTINGS } = await import('../../state/settings-types');
    fake.listByProfile.mockResolvedValue([]);
    settings.value = { ...DEFAULT_SETTINGS, keepTakeAudio: true };
    await mount();
    expect(text()).toContain('with their sound');
    expect(text()).not.toContain('Turn on Keep take audio');
    await act(() => {
      render(null, container);
    });
    container.remove();
    settings.value = { ...DEFAULT_SETTINGS, keepTakeAudio: false };
    await mount();
    expect(text()).toContain('Turn on Keep take audio in Settings');
    settings.value = DEFAULT_SETTINGS;
  });

  it('shows a list that could not be read as an error, not as empty', async () => {
    fake.listByProfile.mockRejectedValue(new Error('the take store is unreadable'));
    await mount();
    expect(text()).toContain('Could not read your recordings. the take store is unreadable');
    expect(text()).not.toContain('No recordings yet');
  });
});

describe('Data: Delete all data', () => {
  async function openSheet(): Promise<HTMLElement> {
    await click(buttonIn(container, 'Delete all data'));
    return container.querySelector('[role="dialog"]') as HTMLElement;
  }

  it('keeps the button off until DELETE is typed', async () => {
    await mount();
    const sheet = await openSheet();
    const go = buttonIn(sheet, 'Delete everything');
    expect(go.disabled).toBe(true);
    const input = sheet.querySelector<HTMLInputElement>('#delete-all-confirm')!;
    await type(input, 'DELET');
    expect(go.disabled).toBe(true);
    await type(input, 'delete');
    expect(go.disabled).toBe(false);
    expect(fake.deleteAllData).not.toHaveBeenCalled();
  });

  it('wipes, reloads the session and returns Home', async () => {
    const order: string[] = [];
    fake.deleteAllData.mockImplementation(async () => {
      order.push('wipe');
    });
    vi.mocked(session.reloadSession).mockImplementation(async () => {
      order.push('reload');
    });
    await mount();
    const sheet = await openSheet();
    await type(sheet.querySelector<HTMLInputElement>('#delete-all-confirm')!, 'DELETE');
    await click(buttonIn(sheet, 'Delete everything'));
    await settle();
    expect(order).toEqual(['wipe', 'reload']);
    // Pending profile settings are dropped, not written behind the wipe: their profile is gone.
    expect(session.reloadSession).toHaveBeenCalledWith({ pendingSettings: 'discard' });
    expect(route.value.name).toBe('home');
    expect(toasts.value.map((t) => t.message)).toContain('All data deleted.');
  });

  it('says what is kept: the device calibration and audio setup, not "all settings"', async () => {
    await mount();
    expect(text()).toContain('This device’s latency calibration and audio setup are kept.');
    const sheet = await openSheet();
    expect(text(sheet)).not.toContain('all settings');
    expect(sheet.querySelector('[data-testid="delete-all-kept"]')?.textContent).toContain('latency calibration and audio setup');
  });

  it('reports an incomplete wipe as incomplete: not "deleted", still on the screen, session resynced', async () => {
    fake.deleteAllData.mockRejectedValue(new Error('wipeAllData incomplete - 1 recording file(s) could not be deleted'));
    await mount();
    const sheet = await openSheet();
    await type(sheet.querySelector<HTMLInputElement>('#delete-all-confirm')!, 'DELETE');
    await click(buttonIn(sheet, 'Delete everything'));
    await settle();
    const open = container.querySelector('[role="dialog"]') as HTMLElement;
    expect(text(open)).toContain('Not everything was deleted.');
    expect(text(open)).toContain('1 recording file(s) could not be deleted');
    expect(toasts.value.map((t) => t.message)).not.toContain('All data deleted.');
    expect(route.value.name).toBe('data');
    expect(session.reloadSession).toHaveBeenCalledTimes(1); // what was cleared stays cleared, so the app must show that
    expect(buttonIn(open, 'Delete everything').disabled).toBe(false); // and the singer can retry
  });
});
