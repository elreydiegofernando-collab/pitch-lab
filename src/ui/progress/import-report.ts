/**
 * An ImportReport (storage/backup.ts) in plain words. The importer never throws: it counts what it merged,
 * skipped and rejected, and this says so without leaving the singer to decode the numbers. Pure.
 */
import type { ImportReport } from '../../storage';
import { plural } from './format';

export interface ImportSummary {
  /** 'ok' merged cleanly, 'warn' merged but skipped some rows, 'error' the file was not a usable backup. */
  tone: 'ok' | 'warn' | 'error';
  headline: string;
  lines: string[];
  /** The importer's own messages about rows it could not read (capped by the importer). */
  details: string[];
}

export function describeImport(r: ImportReport): ImportSummary {
  if (!r.ok) {
    // `ok` is also false when the importer stopped on an unexpected error after merging some rows.
    const merged = r.profilesAdded + r.profilesUpdated + r.attemptsAdded + r.settingsRestored > 0;
    return {
      tone: 'error',
      headline: 'That file was not imported.',
      lines: [
        r.errors[0] ?? 'It is not a Pitch Lab backup.',
        merged ? 'The import stopped partway, so some of it may have been merged.' : 'Nothing on this device changed.',
      ],
      details: r.errors.slice(1),
    };
  }

  const lines: string[] = [];
  if (r.profilesAdded > 0) lines.push(`Added ${plural(r.profilesAdded, 'profile')}.`);
  const plainUpdates = r.profilesUpdated - r.profilesDeleted - r.profilesRestored;
  if (plainUpdates > 0) lines.push(`Updated ${plural(plainUpdates, 'profile')} with newer details.`);
  if (r.profilesDeleted > 0) lines.push(`The backup deleted ${plural(r.profilesDeleted, 'profile')}.`);
  if (r.profilesRestored > 0) lines.push(`The backup brought back ${plural(r.profilesRestored, 'deleted profile')}.`);
  if (r.attemptsAdded > 0) lines.push(`Added ${plural(r.attemptsAdded, 'attempt')} to the practice history.`);
  if (r.attemptsSkipped > 0) lines.push(`Skipped ${plural(r.attemptsSkipped, 'attempt')} that were already here.`);
  if (r.settingsRestored > 0) lines.push(`Restored the settings of ${plural(r.settingsRestored, 'profile')}.`);
  if (r.retiredDefaultProfileId !== null) lines.push('Replaced the empty starter profile.');

  const changed = r.profilesAdded + r.profilesUpdated + r.attemptsAdded + r.settingsRestored > 0;
  const rejected = r.profilesRejected + r.attemptsRejected;
  if (rejected > 0) {
    const parts: string[] = [];
    if (r.profilesRejected > 0) parts.push(plural(r.profilesRejected, 'profile'));
    if (r.attemptsRejected > 0) parts.push(plural(r.attemptsRejected, 'attempt'));
    lines.push(`Could not read ${parts.join(' and ')}, so ${rejected === 1 ? 'it was' : 'they were'} left out.`);
  }

  if (!changed && rejected === 0) {
    return {
      tone: 'ok',
      headline: 'Nothing new in that backup.',
      lines: lines.length > 0 ? lines : ['Everything in it was already on this device.'],
      details: [],
    };
  }
  return {
    tone: rejected > 0 ? 'warn' : 'ok',
    headline: changed ? 'Backup imported.' : 'Backup read, but nothing could be imported.',
    lines,
    details: r.errors,
  };
}
