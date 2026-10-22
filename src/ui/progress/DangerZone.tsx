/**
 * DangerZone (Data screen, DESIGN.md §13.13): Delete all data, behind a sheet where DELETE is typed. It reports
 * the real result. If anything could not be deleted the call rejects, the app reloads from what is really left,
 * and the singer is told it was not all deleted; only a clean wipe says "deleted".
 */
import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import type { JSX } from 'preact';
import { Trash2 } from 'lucide-preact';
import { resetTo } from '../../router';
import { reloadSession } from '../../state/session';
import { showToast } from '../../state/toast';
import type { AppStorage } from '../../storage';
import { Banner } from '../components/Banner';
import { Button } from '../components/Button';
import { Sheet } from '../components/Sheet';
import { errorText, squash } from './format';
import { TextField } from './TextField';
import { useMounted } from './use-mounted';

/** The word to type. Compared ignoring case: the point is a deliberate act, not typing in capitals. */
const CONFIRM_WORD = 'DELETE';

function confirmed(typed: string): boolean {
  return squash(typed).toUpperCase() === CONFIRM_WORD;
}

export function DangerZone(props: { storage: AppStorage | null }): JSX.Element {
  const { storage } = props;
  const mounted = useMounted();
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busyRef = useRef(busy);
  busyRef.current = busy;

  useEffect(() => {
    if (!open) return;
    setTyped('');
    setBusy(false);
    setError(null);
  }, [open]);

  const close = useCallback(() => {
    if (!busyRef.current) setOpen(false);
  }, []);

  async function wipe(e: Event): Promise<void> {
    e.preventDefault();
    if (!storage || busy || !confirmed(typed)) return;
    setBusy(true);
    setError(null);
    let failure: unknown = null;
    let wiped = true;
    try {
      await storage.deleteAllData();
    } catch (err) {
      wiped = false;
      failure = err;
    }
    // Whatever the wipe managed, the app must now show what is really stored (a partial wipe stays partial).
    let reloadFailure: unknown = null;
    try {
      await reloadSession({ pendingSettings: 'discard' }); // the profiles they were made for are gone
    } catch (err) {
      reloadFailure = err;
    }
    if (!wiped) {
      if (mounted.current) {
        setError(`Not everything was deleted. ${errorText(failure)} What was removed stays removed. Try again to finish.`);
        setBusy(false);
      }
      return;
    }
    if (reloadFailure !== null) {
      if (mounted.current) {
        setError(`Everything was deleted, but Pitch Lab could not reload. ${errorText(reloadFailure)} Close the app and open it again.`);
        setBusy(false);
      }
      return;
    }
    resetTo('home');
    showToast('All data deleted.', { durationMs: 4000 });
  }

  return (
    <section class="pl-card pl-data-card pl-data-card--danger" aria-labelledby="data-danger">
      <h2 class="pl-label" id="data-danger">
        Danger zone
      </h2>
      <p class="pl-body-s pl-muted pl-prose">
        Delete every profile with its history, recordings, imported songs and settings from this device. This device’s latency calibration and audio setup are kept. Backups you exported are not touched.
      </p>
      <Button variant="danger" icon={Trash2} block disabled={!storage} onClick={() => setOpen(true)}>
        Delete all data
      </Button>

      <Sheet open={open} title="Delete all data?" onClose={close}>
        <form class="pl-stack pl-profiles-form" onSubmit={wipe}>
          <p class="pl-body pl-prose">
            This erases every profile, your whole practice history, every saved recording and imported song, and each profile’s settings. It cannot be undone.
          </p>
          <p class="pl-body-s pl-muted pl-prose" data-testid="delete-all-kept">
            Kept: this device’s latency calibration and audio setup (headphones, microphone), so you do not have to calibrate again.
          </p>
          <TextField id="delete-all-confirm" label={`Type ${CONFIRM_WORD} to confirm`} value={typed} onInput={setTyped} literal disabled={busy} data-testid="delete-all-confirm" />
          {error ? <Banner kind="error" message={error} /> : null}
          <Button type="submit" variant="danger" class="pl-danger-solid" icon={Trash2} block loading={busy} disabled={!confirmed(typed)}>
            Delete everything
          </Button>
          <Button variant="ghost" block disabled={busy} onClick={close}>
            Cancel
          </Button>
        </form>
      </Sheet>
    </section>
  );
}
