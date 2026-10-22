/**
 * What Home and the map show while the session boots (skeleton blocks sized to the final content, so nothing jumps) and
 * when it failed (a plain error and a Reload button). docs/DESIGN.md 13.0.
 */
import type { JSX } from 'preact';
import { bootError } from '../../state/session';
import { Banner } from '../components/Banner';

export function BootSkeleton(props: { kind: 'home' | 'map' }): JSX.Element {
  return (
    <div class={`wl-skeleton wl-skeleton--${props.kind}`} role="status" aria-live="polite" data-testid="boot-skeleton">
      <span class="pl-visually-hidden">Loading your progress</span>
      {props.kind === 'home' ? (
        <>
          <div class="wl-skel wl-skel--continue" />
          <div class="wl-skel wl-skel--list" />
        </>
      ) : (
        <>
          <div class="wl-skel wl-skel--head" />
          <div class="wl-skel wl-skel--nodes" />
          <div class="wl-skel wl-skel--head" />
        </>
      )}
    </div>
  );
}

function reloadApp(): void {
  window.location.reload();
}

export function BootFailed(): JSX.Element {
  const reason = bootError.value;
  return (
    <div data-testid="boot-failed">
      <Banner
        kind="error"
        message={reason ?? "Pitch Lab couldn't open its saved data."}
        actionLabel="Reload"
        onAction={reloadApp}
      >
        <p class="pl-body-s pl-muted">Reload to try again. If it keeps happening, Diagnostics shows what failed.</p>
      </Banner>
    </div>
  );
}
