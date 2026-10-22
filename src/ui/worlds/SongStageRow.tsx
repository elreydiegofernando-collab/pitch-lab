/**
 * Song Stage on the map (docs/DESIGN.md 13.2): the last section has no nodes, just a row to the song library with how
 * many songs are open, or the `Locked` line until Song Stage unlocks. Songs open with the Boss Recital of the world their
 * difficulty needs (SPEC 11.2).
 */
import type { JSX } from 'preact';
import { ChevronRight, ListMusic } from 'lucide-preact';
import { WORLDS } from '../../exercises';
import { navigate } from '../../router';
import { snapshot } from '../../state/session';
import { songIndex, songsLoaded } from '../../state/songs';
import { Locked } from '../components/Locked';
import { DOT, plural } from './format';
import type { WorldModel } from './map-model';
import { songCounts } from './song-counts';

export function SongStageRow(props: { model: WorldModel }): JSX.Element {
  const { model } = props;
  if (!model.open) {
    return (
      <div class="wl-linkrow wl-linkrow--locked" data-testid="song-stage-row" data-locked="true">
        <Locked hint={model.hint ?? 'Not available yet.'} />
      </div>
    );
  }
  const counts = songCounts(songIndex.value.values(), snapshot.value, WORLDS);
  const caption = !songsLoaded.value
    ? 'Loading the library…'
    : counts.open + counts.locked === 0
      ? 'No songs yet'
      : `${plural(counts.open, 'song')} open ${DOT} ${counts.locked} locked`;
  return (
    <button type="button" class="wl-linkrow" data-testid="song-stage-row" onClick={() => navigate('songs')}>
      <ListMusic class="wl-linkrow__icon" size={22} strokeWidth={2} aria-hidden="true" />
      <span class="wl-linkrow__text">
        <span class="wl-linkrow__title">Song library</span>
        <span class="pl-body-s pl-muted pl-tabular">{caption}</span>
      </span>
      <ChevronRight class="wl-chev" size={20} aria-hidden="true" />
    </button>
  );
}
