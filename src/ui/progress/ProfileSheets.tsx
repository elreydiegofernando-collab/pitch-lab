/**
 * The three sheets of the Profiles screen (DESIGN.md §13.12): create a profile, edit one (name and voice type),
 * delete one behind a typed-name confirmation. Every action reports its real result: a rejected delete says so,
 * keeps the profile, and never claims "Deleted".
 */
import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import type { JSX } from 'preact';
import { Plus, Trash2 } from 'lucide-preact';
import { navigate } from '../../router';
import {
  createProfile,
  deleteProfile,
  renameProfile,
  setProfileVoiceType,
  switchProfile,
} from '../../state/session';
import { showToast } from '../../state/toast';
import type { ProfileRecord } from '../../storage/schema';
import type { VoiceType } from '../../exercises/transpose';
import { Banner } from '../components/Banner';
import { Button } from '../components/Button';
import { ListRow } from '../components/ListRow';
import { Segmented } from '../components/Segmented';
import { Sheet } from '../components/Sheet';
import { Toggle } from '../components/Toggle';
import { errorText, squash } from './format';
import { TextField } from './TextField';
import { useMounted } from './use-mounted';

const VOICE_OPTIONS = [
  { value: 'tenor' as const, label: 'Tenor' },
  { value: 'baritone' as const, label: 'Baritone' },
  { value: 'other' as const, label: 'Other' },
  { value: 'unknown' as const, label: 'Not sure' },
];

/** The typed name matches the profile's, ignoring case and stray spaces. */
function nameMatches(typed: string, name: string): boolean {
  return squash(name) !== '' && squash(typed).toLowerCase() === squash(name).toLowerCase();
}

/**
 * A close handler that does nothing while an action runs (a half-finished save must not be dismissed from
 * under the singer), with a stable identity so the Sheet does not re-focus on every render.
 */
function useGuardedClose(onClose: () => void, busy: boolean): () => void {
  const busyRef = useRef(busy);
  busyRef.current = busy;
  return useCallback(() => {
    if (!busyRef.current) onClose();
  }, [onClose]);
}

// ---------------------------------------------------------------- new profile

export function NewProfileSheet(props: { open: boolean; onClose: () => void; onProblem: (message: string) => void }): JSX.Element {
  const { open, onClose, onProblem } = props;
  const mounted = useMounted();
  const [name, setName] = useState('');
  const [voice, setVoice] = useState<VoiceType>('unknown');
  const [switchNow, setSwitchNow] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const close = useGuardedClose(onClose, busy);

  useEffect(() => {
    if (!open) return;
    setName('');
    setVoice('unknown');
    setSwitchNow(true);
    setBusy(false);
    setError(null);
  }, [open]);

  const clean = squash(name);

  async function submit(e: Event): Promise<void> {
    e.preventDefault();
    if (busy || clean === '') return;
    setBusy(true);
    setError(null);
    try {
      const created = await createProfile({ name: clean, voiceType: voice });
      if (switchNow) {
        try {
          await switchProfile(created.id);
        } catch (err) {
          // The profile exists: close the sheet (creating it again would duplicate it) and say what failed.
          onProblem(`${created.name} was created, but switching to it failed. ${errorText(err)}`);
        }
      }
      onClose();
    } catch (err) {
      if (mounted.current) setError(`Could not create the profile. ${errorText(err)}`);
    } finally {
      if (mounted.current) setBusy(false);
    }
  }

  return (
    <Sheet open={open} title="New profile" onClose={close}>
      <form class="pl-stack pl-profiles-form" onSubmit={submit}>
        <p class="pl-body-s pl-muted pl-prose">Each singer has their own range, progress and settings. Latency calibration stays shared on this device.</p>
        <TextField id="new-profile-name" label="Name" value={name} onInput={setName} maxLength={60} placeholder="For example, Sam" disabled={busy} />
        <span class="pl-label">Voice type</span>
        <Segmented aria-label="Voice type" options={VOICE_OPTIONS} value={voice} onChange={setVoice} />
        <div class="pl-list">
          <ListRow
            title="Switch to this profile now"
            trailing={<Toggle checked={switchNow} onChange={setSwitchNow} aria-label="Switch to this profile now" disabled={busy} />}
          />
        </div>
        {error ? <Banner kind="error" message={error} /> : null}
        <Button type="submit" variant="primary" icon={Plus} block loading={busy} disabled={clean === ''}>
          Create profile
        </Button>
      </form>
    </Sheet>
  );
}

// ---------------------------------------------------------------- edit

export function EditProfileSheet(props: { profile: ProfileRecord | null; onClose: () => void; onDelete: (profile: ProfileRecord) => void }): JSX.Element {
  const { profile, onClose, onDelete } = props;
  const mounted = useMounted();
  const [name, setName] = useState('');
  const [voice, setVoice] = useState<VoiceType>('unknown');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const close = useGuardedClose(onClose, busy);
  const id = profile?.id ?? null;

  // Reset only when a different profile opens, not on every save that updates the record under it.
  useEffect(() => {
    if (!profile) return;
    setName(profile.name);
    setVoice(profile.voiceType);
    setBusy(false);
    setError(null);
  }, [id]);

  const clean = squash(name);
  const changed = profile !== null && (clean !== profile.name || voice !== profile.voiceType);

  async function save(e: Event): Promise<void> {
    e.preventDefault();
    if (!profile || busy || clean === '' || !changed) return;
    setBusy(true);
    setError(null);
    try {
      if (clean !== profile.name) await renameProfile(profile.id, clean);
      if (voice !== profile.voiceType) await setProfileVoiceType(profile.id, voice);
      showToast('Profile saved.', { durationMs: 2500 });
      onClose();
    } catch (err) {
      if (mounted.current) setError(`Could not save. ${errorText(err)}`);
    } finally {
      if (mounted.current) setBusy(false);
    }
  }

  return (
    <Sheet open={profile !== null} title="Edit profile" onClose={close}>
      {profile ? (
        <form class="pl-stack pl-profiles-form" onSubmit={save}>
          <TextField id="edit-profile-name" label="Name" value={name} onInput={setName} maxLength={60} disabled={busy} />
          <span class="pl-label">Voice type</span>
          <Segmented aria-label="Voice type" options={VOICE_OPTIONS} value={voice} onChange={setVoice} />
          {error ? <Banner kind="error" message={error} /> : null}
          <Button type="submit" variant="primary" block loading={busy} disabled={clean === '' || !changed}>
            Save
          </Button>
          <Button variant="danger" icon={Trash2} block disabled={busy} onClick={() => onDelete(profile)}>
            Delete this profile
          </Button>
        </form>
      ) : null}
    </Sheet>
  );
}

// ---------------------------------------------------------------- delete

export function DeleteProfileSheet(props: { profile: ProfileRecord | null; isOnly: boolean; onClose: () => void }): JSX.Element {
  const { profile, isOnly, onClose } = props;
  const mounted = useMounted();
  const [typed, setTyped] = useState('');
  const [removeRecordings, setRemoveRecordings] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const close = useGuardedClose(onClose, busy);
  const id = profile?.id ?? null;

  useEffect(() => {
    setTyped('');
    setRemoveRecordings(true);
    setBusy(false);
    setError(null);
  }, [id]);

  async function confirm(e: Event): Promise<void> {
    e.preventDefault();
    if (!profile || busy || !nameMatches(typed, profile.name)) return;
    setBusy(true);
    setError(null);
    try {
      await deleteProfile(profile.id, { removeRecordings });
      showToast(`${profile.name} deleted.`, { durationMs: 3000 });
      onClose();
    } catch (err) {
      // A recording that will not delete rejects and keeps the profile: say exactly that.
      if (mounted.current) {
        setError(`${profile.name} was not deleted. ${errorText(err)} The profile was kept; recordings that were already removed stay removed. Try again.`);
      }
    } finally {
      if (mounted.current) setBusy(false);
    }
  }

  return (
    <Sheet open={profile !== null} title={profile ? `Delete ${profile.name}?` : 'Delete profile'} onClose={close}>
      {profile ? (
        <form class="pl-stack pl-profiles-form" onSubmit={confirm}>
          <p class="pl-body pl-prose">{profile.name} and their progress will no longer appear in Pitch Lab on this device.</p>
          {isOnly ? <p class="pl-body-s pl-muted pl-prose">This is the only profile, so a new empty one named Me is created afterwards.</p> : null}
          <div class="pl-list">
            <ListRow
              title="Also delete recordings"
              subtitle="Their saved takes and audio are erased from this device."
              trailing={<Toggle checked={removeRecordings} onChange={setRemoveRecordings} aria-label="Also delete recordings" disabled={busy} />}
            />
          </div>
          <TextField
            id="delete-profile-name"
            label={`Type ${profile.name} to confirm`}
            value={typed}
            onInput={setTyped}
            literal
            disabled={busy}
            data-testid="delete-profile-confirm"
          />
          {error ? <Banner kind="error" message={error} /> : null}
          <Button type="submit" variant="danger" class="pl-danger-solid" icon={Trash2} block loading={busy} disabled={!nameMatches(typed, profile.name)}>
            Delete profile
          </Button>
          <Button variant="ghost" block disabled={busy} onClick={() => navigate('data')}>
            Export a backup first
          </Button>
        </form>
      ) : null}
    </Sheet>
  );
}
