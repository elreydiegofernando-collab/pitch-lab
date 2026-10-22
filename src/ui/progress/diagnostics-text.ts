/**
 * Plain-language lines for Diagnostics' storage rows: where recordings live and what the startup check did.
 * Pure. A skipped check is a normal outcome on a degraded launch (it deliberately touches nothing it cannot
 * see), so it is worded as information with its reason, never as a failure.
 */
import type { OpfsBackend, ReconcileReport, ReconcileSkipReason } from '../../storage';
import { plural } from './format';

export const BACKEND_LABEL: Readonly<Record<OpfsBackend, string>> = {
  opfs: 'Private file system (OPFS)',
  'idb-blob': 'IndexedDB blobs',
  memory: 'Memory only (lost on close)',
};

const SKIP_TEXT: Readonly<Record<ReconcileSkipReason, string>> = {
  'db-not-durable': 'The database is not being saved on this launch, so the check left everything alone.',
  'binaries-not-durable': 'Recordings are not being saved on this launch, so the check left everything alone.',
  'backend-changed': 'Recordings were saved by a different storage backend than this launch can read. The check left them alone and will run normally once they are readable.',
};

export function skipText(reason: ReconcileSkipReason): string {
  return SKIP_TEXT[reason] ?? 'The check left everything alone.';
}

/** The row's value and its detail line for this launch's reconcile report (null = it has not run yet). */
export function describeReconcile(report: ReconcileReport | null): { value: string; detail: string | null } {
  if (!report) return { value: 'Not run yet', detail: 'It runs once per launch, shortly after the first screen.' };
  if (report.skipped) return { value: `Skipped: ${report.skipped}`, detail: skipText(report.skipped) };
  const parts = [
    `${plural(report.orphanFilesRemoved, 'stray file')} removed`,
    `${plural(report.danglingTakes, 'take')} that lost audio`,
    `${plural(report.danglingSongs, 'song')} that lost a backing track`,
  ];
  return { value: 'Done', detail: parts.join(' · ') };
}
