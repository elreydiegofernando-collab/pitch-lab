import { describe, expect, it, vi } from 'vitest';
import { loadProgressLine, progressLine } from './profile-progress';
import { passWorld, snapshotOf } from './test-fixtures';

describe('progressLine', () => {
  it('starts a new singer at the Range finder', () => {
    expect(progressLine(snapshotOf([]))).toBe('Up next: Range finder (Foundations)');
  });

  it('follows the frontier through a world', () => {
    expect(progressLine(snapshotOf(passWorld('foundations', 'foundations.13')))).toBe('Up next: Two notes, one step apart (Foundations)');
  });

  it('moves on to the next world once a Boss Recital is passed', () => {
    expect(progressLine(snapshotOf(passWorld('foundations')))).toMatch(/\(Vibrato\)$/);
  });
});

describe('loadProgressLine', () => {
  it('reads another profile\'s own log and computes its line the way the session does', async () => {
    const attempts = passWorld('foundations', 'foundations.02', { profileId: 'other' });
    const listByProfile = vi.fn(async () => attempts);
    const line = await loadProgressLine({ attempts: { listByProfile } } as never, 'other');
    expect(listByProfile).toHaveBeenCalledWith('other');
    expect(line).toBe('Up next: Hold it (Foundations)');
  });
});
