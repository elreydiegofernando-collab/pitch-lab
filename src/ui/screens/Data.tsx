/**
 * Data & backup (SPEC §12, DESIGN.md §13.13): is the data being kept, a JSON backup out and in, the saved
 * recordings (play, export WAV, delete) and Delete all data. Storage is reached through the session's
 * `appStorage` (src/state/session.ts); every delete reports its real result.
 */
import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import type { JSX } from 'preact';
import { Database } from 'lucide-preact';
import { back } from '../../router';
import { requirementHint } from '../../progress';
import { activeProfile, appStorage, bootError, bootPhase, isUnlocked } from '../../state/session';
import type { StorageUsage } from '../../storage';
import { AppBar } from '../components/AppBar';
import { Banner } from '../components/Banner';
import { BackupCard } from '../progress/BackupCard';
import { DangerZone } from '../progress/DangerZone';
import { errorText } from '../progress/format';
import { Recordings } from '../progress/Recordings';
import { StorageCard } from '../progress/StorageCard';

export function Data(): JSX.Element {
  const storage = appStorage.value;
  const profile = activeProfile.value;
  const exportOpen = isUnlocked('export');
  const exportHint = requirementHint('export');
  const [usage, setUsage] = useState<StorageUsage | null>(null);
  const [usageError, setUsageError] = useState<string | null>(null);
  const request = useRef(0);

  const refreshUsage = useCallback(() => {
    if (!storage) return;
    const mine = ++request.current;
    storage
      .usage()
      .then((u) => {
        if (mine === request.current) {
          setUsage(u);
          setUsageError(null);
        }
      })
      .catch((err: unknown) => {
        if (mine === request.current) setUsageError(errorText(err));
      });
  }, [storage]);

  useEffect(() => {
    refreshUsage();
    return () => {
      request.current += 1;
    };
  }, [refreshUsage, profile?.id]);

  return (
    <div class="pl-screen" data-testid="data-screen">
      <AppBar title="Data & backup" routeIcon={Database} onBack={() => back()} />
      <div class="pl-scroll">
        <div class="pl-page">
          {storage === null ? (
            bootPhase.value === 'failed' ? (
              <Banner kind="error" message={bootError.value ?? 'Pitch Lab could not open the data saved on this device.'} />
            ) : (
              <Banner kind="warn" message="Storage is still opening. Give it a moment, then come back to this screen." />
            )
          ) : null}
          <StorageCard usage={usage} error={usageError} />
          <BackupCard storage={storage} onChanged={refreshUsage} exportHint={exportOpen ? null : exportHint} />
          <Recordings storage={storage} profileId={profile?.id ?? null} onChanged={refreshUsage} exportHint={exportOpen ? null : exportHint} />
          <DangerZone storage={storage} />
        </div>
      </div>
    </div>
  );
}
