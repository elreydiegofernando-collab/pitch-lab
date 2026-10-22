/**
 * BackupCard (Data screen, DESIGN.md §13.13): export every profile's progress and settings as one JSON file, or
 * import such a file. A backup carries no audio. The import merges (newer wins, nothing is lost) and its report
 * is shown in plain words before the session reloads from storage.
 */
import { useRef, useState } from 'preact/hooks';
import type { JSX } from 'preact';
import { Download, Upload } from 'lucide-preact';
import { reloadSession } from '../../state/session';
import { flushSettings } from '../../state/settings';
import type { AppStorage } from '../../storage';
import { Banner } from '../components/Banner';
import { Button } from '../components/Button';
import { Locked } from '../components/Locked';
import { asLocalDay, errorText } from './format';
import { HandoffView, useHandoff } from './handoff';
import { describeImport, importChanged, type ImportSummary } from './import-report';
import { ImportReportView } from './ImportReportView';
import { useMounted } from './use-mounted';

/** A real backup is a few hundred kilobytes; a file this big is not one, and reading it would stall a phone. */
const MAX_BACKUP_BYTES = 64 * 1024 * 1024;

/** `exportHint` is the registry's requirement line while Backup and export is locked (it is open from the start), else null. */
export function BackupCard(props: { storage: AppStorage | null; onChanged: () => void; exportHint: string | null }): JSX.Element {
  const { storage, onChanged, exportHint } = props;
  const mounted = useMounted();
  const fileInput = useRef<HTMLInputElement>(null);
  const [exporting, setExporting] = useState(false);
  const [importing, setImporting] = useState(false);
  const [notice, setNotice] = useState<{ kind: 'error'; text: string } | null>(null);
  const [report, setReport] = useState<ImportSummary | null>(null);
  const handoff = useHandoff();
  const busy = exporting || importing;

  async function handleExport(): Promise<void> {
    if (!storage || busy) return;
    setExporting(true);
    setNotice(null);
    setReport(null);
    handoff.reset();
    try {
      const json = await storage.backup.exportJson();
      await handoff.offer(new Blob([json], { type: 'application/json' }), storage.backup.fileName(asLocalDay()));
    } catch (err) {
      if (mounted.current) setNotice({ kind: 'error', text: `Could not export the backup. ${errorText(err)}` });
    } finally {
      if (mounted.current) setExporting(false);
    }
  }

  async function handleFile(e: Event): Promise<void> {
    const input = e.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    if (!file || !storage || busy) return;
    setImporting(true);
    setNotice(null);
    setReport(null);
    handoff.reset();
    try {
      if (file.size > MAX_BACKUP_BYTES) {
        setNotice({ kind: 'error', text: 'That file is too large to be a Pitch Lab backup. Nothing was imported.' });
        return;
      }
      const text = await file.text();
      // A setting changed a moment ago is written first, under its own profile: the import never overwrites a
      // profile's existing settings, and nothing then waits to be written across the reload.
      await flushSettings();
      // The singer chose this file: a profile deleted here that it holds alive comes back (restoreDeleted).
      const result = await storage.backup.import(text, { kv: storage.kv, retireEmptyDefaultProfile: true, restoreDeleted: true });
      if (mounted.current) setReport(describeImport(result));
      // Whatever the file did (even a partial merge), the app must show what is really stored now; a file that
      // changed nothing leaves the session as it is.
      if (importChanged(result)) {
        try {
          await reloadSession();
          onChanged();
        } catch (err) {
          if (mounted.current) setNotice({ kind: 'error', text: `The backup was merged, but Pitch Lab could not reload what is stored. ${errorText(err)} Close the app and open it again.` });
        }
      }
    } catch (err) {
      if (mounted.current) setNotice({ kind: 'error', text: `Could not import the backup. ${errorText(err)}` });
    } finally {
      input.value = '';
      if (mounted.current) setImporting(false);
    }
  }

  return (
    <section class="pl-card pl-data-card" aria-labelledby="data-backup">
      <h2 class="pl-label" id="data-backup">
        Backup
      </h2>
      <p class="pl-body-s pl-muted pl-prose">
        One file with every profile's progress, history and settings. It carries no audio. Importing merges it with what is here, and the newer change wins.
      </p>
      {exportHint === null ? (
        <Button variant="primary" icon={Download} block loading={exporting} disabled={!storage || importing} onClick={() => void handleExport()}>
          Export backup
        </Button>
      ) : (
        <Locked title="Export backup" hint={exportHint} />
      )}
      <Button variant="secondary" icon={Upload} block loading={importing} disabled={!storage || exporting} onClick={() => fileInput.current?.click()}>
        Import backup
      </Button>
      <input
        ref={fileInput}
        class="pl-visually-hidden"
        type="file"
        accept=".json,application/json"
        tabIndex={-1}
        aria-label="Choose a Pitch Lab backup file"
        data-testid="import-file"
        onChange={(e) => void handleFile(e)}
      />
      <HandoffView handoff={handoff} noun="backup" />
      {notice ? <Banner kind={notice.kind} message={notice.text} /> : null}
      {report ? <ImportReportView summary={report} /> : null}
    </section>
  );
}
