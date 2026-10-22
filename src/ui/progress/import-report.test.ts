import { describe, expect, it } from 'vitest';
import type { ImportReport } from '../../storage';
import { describeImport } from './import-report';

function report(over: Partial<ImportReport> = {}): ImportReport {
  return {
    ok: true,
    profilesAdded: 0,
    profilesUpdated: 0,
    profilesDeleted: 0,
    profilesRestored: 0,
    profilesSkipped: 0,
    profilesRejected: 0,
    attemptsAdded: 0,
    attemptsSkipped: 0,
    attemptsRejected: 0,
    settingsRestored: 0,
    retiredDefaultProfileId: null,
    errors: [],
    ...over,
  };
}

describe('describeImport', () => {
  it('says plainly what a clean restore did', () => {
    const s = describeImport(report({ profilesAdded: 2, attemptsAdded: 120, attemptsSkipped: 3, settingsRestored: 2, retiredDefaultProfileId: 'p0' }));
    expect(s.tone).toBe('ok');
    expect(s.headline).toBe('Backup imported.');
    expect(s.lines).toEqual([
      'Added 2 profiles.',
      'Added 120 attempts to the practice history.',
      'Skipped 3 attempts that were already here.',
      'Restored the settings of 2 profiles.',
      'Replaced the empty starter profile.',
    ]);
    expect(s.details).toEqual([]);
  });

  it('says so when there was nothing new', () => {
    const s = describeImport(report({ attemptsSkipped: 40, profilesSkipped: 1 }));
    expect(s.tone).toBe('ok');
    expect(s.headline).toBe('Nothing new in that backup.');
    expect(s.lines).toEqual(['Skipped 40 attempts that were already here.']);
  });

  it('says so when it is an empty backup', () => {
    expect(describeImport(report()).lines).toEqual(['Everything in it was already on this device.']);
  });

  it('separates plain updates from deletions and restorations the backup carried', () => {
    const s = describeImport(report({ profilesUpdated: 4, profilesDeleted: 1, profilesRestored: 1 }));
    expect(s.lines).toEqual(['Updated 2 profiles with newer details.', 'The backup deleted 1 profile.', 'The backup brought back 1 deleted profile.']);
  });

  it('warns, with the importer\'s own messages, when some rows could not be read', () => {
    const s = describeImport(report({ attemptsAdded: 5, attemptsRejected: 2, profilesRejected: 1, errors: ['attempt a1: malformed createdAt', 'profile p9: missing name'] }));
    expect(s.tone).toBe('warn');
    expect(s.headline).toBe('Backup imported.');
    expect(s.lines).toContain('Could not read 1 profile and 2 attempts, so they were left out.');
    expect(s.details).toEqual(['attempt a1: malformed createdAt', 'profile p9: missing name']);
  });

  it('is an error, and says nothing changed, for a file that is not a backup', () => {
    const s = describeImport(report({ ok: false, errors: ['the file is not valid JSON'] }));
    expect(s.tone).toBe('error');
    expect(s.headline).toBe('That file was not imported.');
    expect(s.lines).toEqual(['the file is not valid JSON', 'Nothing on this device changed.']);
  });

  it('does not claim nothing changed when the importer stopped after merging some rows', () => {
    const s = describeImport(report({ ok: false, attemptsAdded: 10, errors: ['import stopped early: disk full'] }));
    expect(s.tone).toBe('error');
    expect(s.lines[1]).toBe('The import stopped partway, so some of it may have been merged.');
  });
});
