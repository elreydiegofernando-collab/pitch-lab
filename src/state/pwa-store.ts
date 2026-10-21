/**
 * Signal mirror of the service worker's lifecycle (`src/pwa/register-sw.ts`),
 * subscribed once at module load — same pattern as `engineState`/`engineInfo`
 * in `src/state/engine-store.ts`. Screens read this signal instead of taking
 * a one-time `getSwStatus()` snapshot, so they re-render on a later
 * transition (e.g. a new deploy flipping `active` -> `waiting`) without
 * owning their own subscription.
 */
import { signal } from '@preact/signals';
import { getSwStatus, onStatusChange, type SwStatus } from '../pwa/register-sw';

export const swStatus = signal<SwStatus>(getSwStatus());

onStatusChange((status) => {
  swStatus.value = status;
});
