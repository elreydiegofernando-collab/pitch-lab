/**
 * The world map, a setlist path (docs/DESIGN.md 13.2): every world in order, its levels as ScoreRing nodes on one cable
 * that is lit up to where the singer is. Only openable nodes are buttons; locked ones are static lines with their
 * requirement (SPEC 11.1). It opens scrolled to the current node (or to `params.worldId`), and powers on, once, the
 * nodes the last take opened.
 *
 * (This module exports a component named `Map`, so it never uses the global Map: the logic lives in src/ui/worlds.)
 */
import { useLayoutEffect, useMemo, useRef } from 'preact/hooks';
import type { JSX } from 'preact';
import { Route as RouteIcon } from 'lucide-preact';
import { WORLDS } from '../../exercises';
import { back, canGoBack, route } from '../../router';
import { lastOutcome } from '../../runtime/runner';
import { bootPhase, snapshot } from '../../state/session';
import { AppBar } from '../components/AppBar';
import { BootFailed, BootSkeleton } from '../worlds/BootStates';
import { ProfileChip } from '../worlds/ProfileChip';
import { WorldSection } from '../worlds/WorldSection';
import { buildMapModel } from '../worlds/map-model';
import { takePowerOn } from '../worlds/power-on';
import { afterFonts, revealElement } from '../worlds/scroll';

const NONE: ReadonlySet<string> = new Set<string>();

export function Map(): JSX.Element {
  const current = route.value;
  const focusWorld = current.name === 'map' ? current.params.worldId : undefined;
  const phase = bootPhase.value;
  const snap = snapshot.value;
  const models = useMemo(() => buildMapModel(snap, WORLDS), [snap]);

  const rootRef = useRef<HTMLDivElement>(null);
  const scrolled = useRef(false);
  const poweredOn = useRef<ReadonlySet<string>>(NONE);
  const claimed = useRef(false);

  // The take that just opened something powers its nodes on, once per take (power-on.ts). Claimed on the first render
  // that shows the map, so a re-render, or coming back later, never replays it.
  if (phase === 'ready' && !claimed.current) {
    claimed.current = true;
    poweredOn.current = takePowerOn(lastOutcome.peek(), snapshot.peek(), WORLDS);
  }

  // Open on where the singer is: the world named in the route, else the current node. Once, after the fonts have settled
  // (a font arriving moves the content, and the scroll would land off).
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (phase !== 'ready' || scrolled.current || !root) return undefined;
    scrolled.current = true;
    return afterFonts(() => {
      const world = focusWorld ? Array.from(root.querySelectorAll<HTMLElement>('[data-world-id]')).find((el) => el.dataset.worldId === focusWorld) : undefined;
      if (world) {
        revealElement(world, 'top');
        return;
      }
      const node = root.querySelector<HTMLElement>('[data-scroll-target="current"]');
      if (node) revealElement(node, 'node');
    });
  }, [phase, focusWorld]);

  return (
    <div class="pl-screen wl-scope" data-testid="map-screen">
      <AppBar title="World map" routeIcon={RouteIcon} onBack={canGoBack.value ? () => back() : undefined} trailing={<ProfileChip />} />
      <div class="pl-scroll">
        <div class="pl-page wl-page" ref={rootRef} aria-busy={phase === 'booting' ? 'true' : undefined}>
          {phase === 'booting' ? <BootSkeleton kind="map" /> : null}
          {phase === 'failed' ? <BootFailed /> : null}
          {phase === 'ready' ? (
            <ol class="wl-worlds">
              {models.map((model) => (
                <li key={model.world.id}>
                  <WorldSection model={model} poweredOn={poweredOn.current} />
                </li>
              ))}
            </ol>
          ) : null}
        </div>
      </div>
    </div>
  );
}
