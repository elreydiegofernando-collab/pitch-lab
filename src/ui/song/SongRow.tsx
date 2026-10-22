/**
 * One song in the Song Stage setlist (DESIGN.md §13.7): number, title, artist, range, length, the world it needs,
 * where it came from, and the strongest reason it is rated that way. An open song is one button; a locked one is
 * static text with its requirement line (SPEC §11.1: shown, never openable).
 */
import type { JSX } from 'preact';
import { ChevronRight } from 'lucide-preact';
import type { Notation } from '../../core/music';
import type { WorldId } from '../../exercises/types';
import type { SongEntry } from '../../state/songs';
import { Locked } from '../components/Locked';
import { factLine, formatClock, formatRange, setlistNumber, worldOf } from './format';

/** The required world as a chip: its accent dot (DESIGN.md §10 world hue) and its name. */
export function WorldChip(props: { worldId: WorldId }): JSX.Element {
  const world = worldOf(props.worldId);
  return (
    <span class="pl-song-chip pl-song-chip--world">
      <span class="pl-song-chip__dot" style={{ background: world ? `var(${world.accent})` : 'var(--text-lo)' }} aria-hidden="true" />
      {world?.title ?? props.worldId}
    </span>
  );
}

export interface SongRowProps {
  entry: SongEntry;
  /** 1-based place in the setlist. */
  number: number;
  /** Null when the song is open; otherwise the requirement line (songRequirementHint). */
  lockedHint: string | null;
  notation: Notation;
  onOpen: () => void;
}

export function SongRow(props: SongRowProps): JSX.Element {
  const { entry, number, lockedHint, notation, onOpen } = props;
  const facts = [formatRange(entry.difficulty.lowestMidi, entry.difficulty.highestMidi, notation)];
  if (entry.durationSec !== undefined) facts.push(formatClock(entry.durationSec));
  // A button holds phrasing content only; the locked row is a plain block and may hold the Locked line.
  const Main = lockedHint === null ? 'span' : 'div';
  const body = (
    <>
      <span class="pl-song-row__num pl-tabular" aria-hidden="true">
        {setlistNumber(number)}
      </span>
      <Main class="pl-song-row__main">
        <span class="pl-song-row__title">{entry.title}</span>
        {entry.artist ? <span class="pl-song-row__artist">{entry.artist}</span> : null}
        <span class="pl-song-row__facts">
          <span class="pl-tabular">{factLine(facts)}</span>
          <WorldChip worldId={entry.difficulty.requiredWorld} />
          <span class="pl-song-chip">{entry.bundled ? 'Public domain' : 'Yours'}</span>
        </span>
        {entry.caption ? <span class="pl-song-row__caption">{entry.caption}</span> : null}
        {lockedHint !== null ? <Locked compact hint={lockedHint} class="pl-song-row__locked" /> : null}
      </Main>
      {lockedHint === null ? <ChevronRight class="pl-song-row__chevron" size={20} aria-hidden="true" /> : null}
    </>
  );
  if (lockedHint !== null) {
    return (
      <div class="pl-song-row pl-song-row--locked" data-testid="song-row-locked">
        {body}
      </div>
    );
  }
  return (
    <button type="button" class="pl-song-row" onClick={onOpen} data-testid="song-row">
      {body}
    </button>
  );
}
