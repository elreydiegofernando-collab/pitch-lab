/**
 * The Unlocked strip of the take report (docs/DESIGN.md §13.5): a LockOpen glyph and what this take opened. The pass
 * itself is the verdict's business and a higher tally is the lights', so this lists only what became available: the
 * next level, a world, a tool or readout, the songs, and the levels an audition test skipped.
 */
import type { JSX } from 'preact';
import { LockOpen } from 'lucide-preact';
import type { UnlockEvent } from '../../runtime/types';

export interface UnlockLine {
  /** Stable key. */
  id: string;
  /** Small caption: what kind of thing opened. */
  kind: 'Level' | 'Passed' | 'World' | 'Feature' | 'Songs';
  text: string;
}

/** More titles than this collapse into "first to last". */
const MAX_LISTED = 3;

function listTitles(titles: readonly string[]): string {
  if (titles.length <= MAX_LISTED) return titles.join(', ');
  return `${titles[0]} to ${titles[titles.length - 1]} (${titles.length} levels)`;
}

/**
 * What to list for a take's unlock events, in their display order. `ownLevelId` is the level the take was sung for: its
 * own "passed" event is left out (the verdict says it), but levels an audition test passed on the way are listed.
 */
export function unlockLines(events: readonly UnlockEvent[], ownLevelId: string | null): UnlockLine[] {
  const passed: string[] = [];
  const opened: string[] = [];
  const lines: UnlockLine[] = [];
  let passedAt = -1;
  let openedAt = -1;
  for (const e of events) {
    switch (e.kind) {
      case 'level-passed':
        if (e.levelId !== ownLevelId) {
          if (passedAt < 0) passedAt = lines.push({ id: 'passed', kind: 'Passed', text: '' }) - 1;
          passed.push(e.title);
        }
        break;
      case 'level-opened':
        if (openedAt < 0) openedAt = lines.push({ id: 'opened', kind: 'Level', text: '' }) - 1;
        opened.push(e.title);
        break;
      case 'world-opened':
        lines.push({ id: `world:${e.worldId}`, kind: 'World', text: e.title });
        break;
      case 'feature':
        lines.push({ id: `feature:${e.featureId}`, kind: 'Feature', text: e.title });
        break;
      case 'songs':
        lines.push({ id: `songs:${e.requiredWorld}`, kind: 'Songs', text: `${e.count} ${e.count === 1 ? 'song' : 'songs'} now open` });
        break;
      case 'mastery':
        break;
    }
  }
  if (passedAt >= 0) lines[passedAt].text = listTitles(passed);
  if (openedAt >= 0) lines[openedAt].text = listTitles(opened);
  return lines;
}

export function UnlockedStrip(props: { events: readonly UnlockEvent[]; ownLevelId: string | null }): JSX.Element | null {
  const lines = unlockLines(props.events, props.ownLevelId);
  if (lines.length === 0) return null;
  return (
    <section class="pl-unlocked" aria-label="Unlocked" data-testid="unlocked-strip">
      <div class="pl-unlocked__head">
        <LockOpen size={18} strokeWidth={2} aria-hidden="true" />
        <h2 class="pl-label">Unlocked</h2>
      </div>
      <ul class="pl-unlocked__list">
        {lines.map((l, i) => (
          <li key={l.id} class="pl-unlocked__item">
            {/* The kind is named once per run of the same kind; later rows keep its column but not its ink. */}
            <span class={`pl-label pl-unlocked__kind${i > 0 && lines[i - 1].kind === l.kind ? ' pl-unlocked__kind--again' : ''}`}>{l.kind}</span>
            <span class="pl-unlocked__text">{l.text}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
