/**
 * Profiles (SPEC §12, DESIGN.md §13.12): several singers on one device, each with their own range, progress,
 * history and settings. Tap a row to switch; the pencil edits (name, voice type) or deletes. Every action goes
 * through the session (src/state/session.ts) and shows its real result.
 */
import { useCallback, useEffect, useState } from 'preact/hooks';
import type { JSX } from 'preact';
import { Check, Pencil, Plus, Users } from 'lucide-preact';
import { back } from '../../router';
import { activeProfile, appStorage, bootError, bootPhase, profiles, snapshot, switchProfile } from '../../state/session';
import { settings } from '../../state/settings';
import type { ProfileRecord } from '../../storage/schema';
import { AppBar } from '../components/AppBar';
import { Banner } from '../components/Banner';
import { Button } from '../components/Button';
import { EmptyState } from '../components/EmptyState';
import { errorText, rangeLabel, voiceTypeLabel } from '../progress/format';
import { DeleteProfileSheet, EditProfileSheet, NewProfileSheet } from '../progress/ProfileSheets';
import { ProfileAvatar } from '../progress/ProfileAvatar';
import { loadProgressLine, progressLine } from '../progress/profile-progress';
import { useMounted } from '../progress/use-mounted';

type SheetState = { kind: 'none' } | { kind: 'new' } | { kind: 'edit'; id: string } | { kind: 'delete'; id: string };

/** "Up next" lines for the profiles that are not active, loaded from their own stored logs. */
function useProgressLines(list: readonly ProfileRecord[], activeId: string | null): Record<string, string> {
  const storage = appStorage.value;
  const [lines, setLines] = useState<Record<string, string>>({});
  const key = list.map((p) => p.id).join(',');
  useEffect(() => {
    if (!storage) return undefined;
    let live = true;
    for (const p of list) {
      if (p.id === activeId) continue;
      loadProgressLine(storage, p.id)
        .then((line) => {
          if (live) setLines((prev) => ({ ...prev, [p.id]: line }));
        })
        .catch(() => {});
    }
    return () => {
      live = false;
    };
  }, [storage, key, activeId]);
  return lines;
}

export function Profiles(): JSX.Element {
  const list = profiles.value;
  const active = activeProfile.value;
  const notation = settings.value.notation;
  const mounted = useMounted();
  const lines = useProgressLines(list, active?.id ?? null);
  const [sheet, setSheet] = useState<SheetState>({ kind: 'none' });
  const [switchingId, setSwitchingId] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const closeSheet = useCallback(() => setSheet({ kind: 'none' }), []);
  const editing = sheet.kind === 'edit' ? (list.find((p) => p.id === sheet.id) ?? null) : null;
  const deleting = sheet.kind === 'delete' ? (list.find((p) => p.id === sheet.id) ?? null) : null;

  async function handleSwitch(p: ProfileRecord): Promise<void> {
    if (switchingId !== null || p.id === active?.id) return;
    setProblem(null);
    setSwitchingId(p.id);
    try {
      await switchProfile(p.id);
    } catch (err) {
      if (mounted.current) setProblem(`Could not switch to ${p.name}. ${errorText(err)}`);
    } finally {
      if (mounted.current) setSwitchingId(null);
    }
  }

  return (
    <div class="pl-screen" data-testid="profiles-screen">
      <AppBar title="Profiles" routeIcon={Users} onBack={() => back()} />
      <div class="pl-scroll">
        <div class="pl-page">
          <p class="pl-body-s pl-muted pl-prose">
            Each singer has their own range, progress and settings. Tap a profile to sing as them. Latency calibration is shared on this device.
          </p>

          {list.length === 0 && bootPhase.value === 'failed' ? (
            <Banner kind="error" message={bootError.value ?? 'Pitch Lab could not open the data saved on this device.'} />
          ) : list.length === 0 ? (
            <EmptyState icon={Users} title="No profiles yet" message="Create one to start singing." />
          ) : (
            <ul class="pl-list">
              {list.map((p) => {
                const isActive = p.id === active?.id;
                const line = isActive ? progressLine(snapshot.value) : lines[p.id];
                const text = (
                  <>
                    <ProfileAvatar name={p.name} />
                    <span class="pl-profiles-text">
                      <span class="pl-profiles-name">{p.name}</span>
                      <span class="pl-body-s pl-muted">
                        {voiceTypeLabel(p.voiceType)} &middot; {rangeLabel(p.range, notation)}
                      </span>
                      <span class="pl-body-s pl-lo">{line ?? ' '}</span>
                    </span>
                  </>
                );
                return (
                  <li key={p.id} class="pl-profiles-item">
                    {isActive ? (
                      <div class="pl-profiles-main" aria-current="true">
                        {text}
                        <Check class="pl-profiles-check" size={22} strokeWidth={2.5} aria-hidden="true" />
                        <span class="pl-visually-hidden">Active profile</span>
                      </div>
                    ) : (
                      <button type="button" class="pl-profiles-main" disabled={switchingId !== null} aria-label={`Sing as ${p.name}`} onClick={() => void handleSwitch(p)}>
                        {text}
                        {switchingId === p.id ? <span class="pl-btn__spinner pl-profiles-spinner" aria-hidden="true" /> : null}
                      </button>
                    )}
                    <button type="button" class="pl-icon-btn" aria-label={`Edit ${p.name}`} disabled={switchingId !== null} onClick={() => setSheet({ kind: 'edit', id: p.id })}>
                      <Pencil size={20} strokeWidth={2} aria-hidden="true" />
                    </button>
                  </li>
                );
              })}
            </ul>
          )}

          {problem ? <Banner kind="error" message={problem} /> : null}

          <Button variant="secondary" icon={Plus} block disabled={switchingId !== null} onClick={() => setSheet({ kind: 'new' })}>
            New profile
          </Button>
        </div>
      </div>

      <NewProfileSheet open={sheet.kind === 'new'} onClose={closeSheet} onProblem={setProblem} />
      <EditProfileSheet profile={editing} onClose={closeSheet} onDelete={(p) => setSheet({ kind: 'delete', id: p.id })} />
      <DeleteProfileSheet profile={deleting} isOnly={list.length === 1} onClose={closeSheet} />
    </div>
  );
}
