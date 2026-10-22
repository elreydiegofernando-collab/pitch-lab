import { describe, expect, it, vi } from 'vitest';
import { saveFile, type SaveEnv } from './save-file';

const blob = new Blob(['{"format":"pitch-lab-backup"}'], { type: 'application/json' });

function env(over: Partial<SaveEnv> = {}): SaveEnv {
  return {
    preferShare: false,
    canShare: () => true,
    share: vi.fn(async () => {}),
    download: vi.fn(),
    ...over,
  };
}

function domError(name: string): Error {
  const e = new Error(name);
  e.name = name;
  return e;
}

describe('saveFile', () => {
  it('downloads where there is no share sheet to prefer', async () => {
    const e = env();
    await expect(saveFile(blob, 'pitch-lab-backup-2026-10-21.json', e)).resolves.toBe('downloaded');
    expect(e.download).toHaveBeenCalledWith(blob, 'pitch-lab-backup-2026-10-21.json');
    expect(e.share).not.toHaveBeenCalled();
  });

  it('hands the file to the share sheet on an iPhone, named and typed', async () => {
    const share = vi.fn(async () => {});
    const e = env({ preferShare: true, share });
    await expect(saveFile(blob, 'backup.json', e)).resolves.toBe('shared');
    const file = (share.mock.calls[0] as unknown as [File])[0];
    expect(file.name).toBe('backup.json');
    expect(file.type).toBe('application/json');
    expect(e.download).not.toHaveBeenCalled();
  });

  it('reports a dismissed share sheet as cancelled and does not download behind the singer\'s back', async () => {
    const e = env({ preferShare: true, share: vi.fn(async () => Promise.reject(domError('AbortError'))) });
    await expect(saveFile(blob, 'backup.json', e)).resolves.toBe('cancelled');
    expect(e.download).not.toHaveBeenCalled();
  });

  it('asks for a fresh tap, and does not download, when the share sheet wants one', async () => {
    const e = env({ preferShare: true, share: vi.fn(async () => Promise.reject(domError('NotAllowedError'))) });
    await expect(saveFile(blob, 'backup.json', e)).resolves.toBe('needs-tap');
    expect(e.download).not.toHaveBeenCalled();
  });

  it('downloads when the share sheet refuses even from a tap', async () => {
    const e = env({ preferShare: true, share: vi.fn(async () => Promise.reject(domError('NotAllowedError'))) });
    await expect(saveFile(blob, 'backup.json', e, { fromTap: true })).resolves.toBe('downloaded');
    expect(e.download).toHaveBeenCalledTimes(1);
  });

  it('downloads when the share sheet fails for any other reason', async () => {
    const e = env({ preferShare: true, share: vi.fn(async () => Promise.reject(domError('TypeError'))) });
    await expect(saveFile(blob, 'backup.json', e)).resolves.toBe('downloaded');
    expect(e.download).toHaveBeenCalledTimes(1);
  });

  it('offers a JSON backup as plain text when the browser will not share the JSON type', async () => {
    const share = vi.fn(async () => {});
    const e = env({ preferShare: true, share, canShare: (file) => file.type !== 'application/json' });
    await expect(saveFile(blob, 'backup.json', e)).resolves.toBe('shared');
    const file = (share.mock.calls[0] as unknown as [File])[0];
    expect(file.name).toBe('backup.json');
    expect(file.type).toBe('text/plain');
    expect(await file.text()).toBe('{"format":"pitch-lab-backup"}');
  });

  it('downloads when the browser cannot share files at all', async () => {
    const e = env({ preferShare: true, canShare: () => false });
    await expect(saveFile(blob, 'backup.json', e)).resolves.toBe('downloaded');
    expect(e.share).not.toHaveBeenCalled();
  });

  it('rejects only when the download itself throws', async () => {
    const e = env({
      download: () => {
        throw new Error('blocked');
      },
    });
    await expect(saveFile(blob, 'backup.json', e)).rejects.toThrow('blocked');
  });
});
