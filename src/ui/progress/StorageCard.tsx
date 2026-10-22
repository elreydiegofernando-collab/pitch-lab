/** StorageCard: is the data being kept, and how much of it there is (Data screen, DESIGN.md §13.13). */
import type { JSX } from 'preact';
import { CircleCheck, TriangleAlert } from 'lucide-preact';
import type { StorageUsage } from '../../storage';
import { Banner } from '../components/Banner';
import { formatBytes } from './format';

export function StorageCard(props: { usage: StorageUsage | null; error: string | null }): JSX.Element {
  const { usage, error } = props;
  if (error) return <Banner kind="error" message={`Could not read the storage figures. ${error}`} />;
  if (!usage) return <div class="pl-card pl-data-skeleton pl-data-skeleton--storage" aria-hidden="true" data-testid="storage-loading" />;

  const origin = usage.origin.usage !== null && usage.origin.quota !== null ? `${formatBytes(usage.origin.usage)} of ${formatBytes(usage.origin.quota)}` : 'Not reported by this browser';
  return (
    <section class="pl-card pl-data-card" aria-labelledby="data-storage" data-testid="storage-card">
      <h2 class="pl-label" id="data-storage">
        Storage
      </h2>
      {usage.persistent ? (
        <p class="pl-data-status" data-testid="storage-durable">
          <CircleCheck size={22} strokeWidth={2} aria-hidden="true" />
          Saved on this device
        </p>
      ) : (
        <>
          <p class="pl-data-status pl-data-status--warn" data-testid="storage-durable">
            <TriangleAlert size={22} strokeWidth={2} aria-hidden="true" />
            Not saved between visits
          </p>
          <p class="pl-body-s pl-muted pl-prose">
            This browser is holding Pitch Lab's data in memory on this visit, so closing the app loses it. Export a backup before you leave.
            {usage.dbFallbackReason ? ` Reason: ${usage.dbFallbackReason}` : ''}
          </p>
        </>
      )}
      <dl class="pl-data-stats pl-tabular">
        <div>
          <dt class="pl-label">Attempts</dt>
          <dd class="pl-display-m">{usage.attemptCount}</dd>
        </div>
        <div>
          <dt class="pl-label">Recordings</dt>
          <dd class="pl-display-m">{usage.takeCount}</dd>
        </div>
        <div>
          <dt class="pl-label">Audio</dt>
          <dd class="pl-display-m">{formatBytes(usage.binaryBytes)}</dd>
        </div>
        <div>
          <dt class="pl-label">Browser storage</dt>
          <dd class="pl-body">{origin}</dd>
        </div>
      </dl>
    </section>
  );
}
