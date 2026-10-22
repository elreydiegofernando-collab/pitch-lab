/**
 * The rating of a song about to be imported (DESIGN.md §13.8 step 4): the world it needs (SPEC §11.2: it opens once
 * that world's Boss Recital is passed), every finding behind it with its own detail, and whether it is open for this
 * singer now. Shown before Save, so nobody imports a song expecting to sing it today and finds it locked.
 */
import type { JSX } from 'preact';
import { LockOpen } from 'lucide-preact';
import { WORLDS } from '../../exercises';
import { isSongUnlocked, songRequirementHint, type ProgressSnapshot } from '../../progress';
import { analyzeSong } from '../../song/difficulty';
import type { Song } from '../../song/types';
import { Locked } from '../components/Locked';
import { worldOf } from './format';
import { WorldChip } from './SongRow';

function sentence(detail: string): string {
  return detail.charAt(0).toUpperCase() + detail.slice(1);
}

export function RatingCard(props: { song: Song; snapshot: ProgressSnapshot }): JSX.Element {
  const { song, snapshot } = props;
  const rating = analyzeSong(song);
  const world = rating.difficulty.requiredWorld;
  const open = isSongUnlocked(world, snapshot, WORLDS);
  return (
    <div class="pl-song-rating" data-testid="song-rating">
      <div class="pl-song-rating__head">
        <span class="pl-label">Rated</span>
        <WorldChip worldId={world} />
      </div>
      {rating.reasons.length > 0 ? (
        <ul class="pl-song-rating__reasons">
          {rating.reasons.map((r) => (
            <li key={`${r.code}-${r.atSec ?? ''}`}>
              <span class="pl-song-rating__world">{worldOf(r.world)?.title ?? r.world}:</span> {sentence(r.detail)}
            </li>
          ))}
        </ul>
      ) : (
        <p class="pl-body-s pl-muted">Held notes, steps and leaps up to an octave: Foundations material.</p>
      )}
      {!rating.lyricsAvailable ? (
        <p class="pl-body-s pl-muted">This file has no lyrics, so long melismas can't be rated; fast passages still count.</p>
      ) : null}
      {open ? (
        <p class="pl-song-rating__open">
          <LockOpen size={16} strokeWidth={2} aria-hidden="true" />
          Open for you now.
        </p>
      ) : (
        <Locked hint={songRequirementHint(world, snapshot, WORLDS) ?? 'Not available yet.'} />
      )}
    </div>
  );
}
