/**
 * "Last time" on the Level screen: when the latest take of the level missed, its coaching (coaching/last-time.ts), shown
 * BEFORE the next try. The saved take is read back and re-analyzed, so the card arrives a moment after the screen: a
 * skeleton the card's size holds its place meanwhile. The spots are a plain list here (there is no replay to mark).
 */
import { useEffect, useState } from 'preact/hooks';
import type { JSX } from 'preact';
import { lastTimeCoaching, type LastTimeSources } from '../../coaching/last-time';
import type { CoachMove, Coaching } from '../../coaching/types';
import { CoachCard, type CoachCardProps } from './CoachCard';

export interface LastTimeCardProps {
  /** Everything the coaching is read from; `latestId` says when to read it again. */
  sources: LastTimeSources;
  /** The id of the latest attempt of the exercise (the card reloads when it changes). */
  latestId: string;
  listen: CoachCardProps['listen'];
  onMove: (move: CoachMove) => void;
  /** Reads the coaching (default lastTimeCoaching; tests inject one). */
  load?: (sources: LastTimeSources) => Promise<Coaching | null>;
}

export function LastTimeCard(props: LastTimeCardProps): JSX.Element | null {
  const { sources, latestId, listen, onMove, load = lastTimeCoaching } = props;
  // undefined while loading, null when there is nothing to say.
  const [coaching, setCoaching] = useState<Coaching | null | undefined>(undefined);

  useEffect(() => {
    let live = true;
    setCoaching(undefined);
    load(sources).then(
      (c) => {
        if (live) setCoaching(c);
      },
      () => {
        if (live) setCoaching(null);
      },
    );
    return () => {
      live = false;
    };
    // Read once per latest take: the sources object is rebuilt on every render.
  }, [latestId, sources.def.id]);

  if (coaching === null) return null;
  if (coaching === undefined) {
    return (
      <section class="pl-card pl-coach pl-coach--loading" aria-label="Last time" aria-busy="true" data-testid="last-time-loading">
        <span class="pl-label">Last time</span>
        <div class="pl-coach__skeleton" aria-hidden="true" />
      </section>
    );
  }
  return (
    <div data-testid="last-time">
      <CoachCard coaching={coaching} title="Last time" listen={listen} onMove={onMove} />
    </div>
  );
}
