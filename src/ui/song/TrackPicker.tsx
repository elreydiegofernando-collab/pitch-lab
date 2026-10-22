/**
 * Step 2 of a MIDI import (DESIGN.md §13.8): which track is the melody. Every track with notes is listed with its
 * name, note count and range and a short preview; the best-scoring one (scoreMidiTracks) is preselected. Purchased
 * karaoke files often carry a dozen tracks and a drum channel: the drums are listed, but cannot be chosen.
 */
import type { JSX } from 'preact';
import { Play, Square } from 'lucide-preact';
import type { Notation } from '../../core/music';
import type { MidiTrackCandidate } from '../../song/midi';
import { count, factLine, formatRange } from './format';

export interface TrackPickerProps {
  candidates: readonly MidiTrackCandidate[];
  /** The track the song is built from now. */
  selected: number;
  /** The best-scoring candidate's track index (candidates are sorted best first). */
  best: number;
  notation: Notation;
  /** The track whose preview is playing, or null. */
  previewing: number | null;
  onSelect(trackIndex: number): void;
  onPreview(trackIndex: number): void;
}

function trackName(c: MidiTrackCandidate): string {
  return c.name.trim() || c.instrument.trim() || `Track ${c.index + 1}`;
}

export function TrackPicker(props: TrackPickerProps): JSX.Element {
  const { candidates, selected, best, notation, previewing, onSelect, onPreview } = props;
  return (
    <fieldset class="pl-song-tracks">
      <legend class="pl-visually-hidden">Melody track</legend>
      {candidates.map((c) => {
        const name = trackName(c);
        const id = `melody-track-${c.index}`;
        const facts = [count(c.noteCount, 'note')];
        if (c.percussion) facts.push('drums: no melody');
        else facts.push(formatRange(c.lowestMidi, c.highestMidi, notation));
        if (c.index === best && !c.percussion) facts.push('best match');
        const playing = previewing === c.index;
        return (
          <div key={c.index} class={['pl-song-track', c.index === selected ? 'pl-song-track--selected' : ''].filter(Boolean).join(' ')}>
            <input
              type="radio"
              id={id}
              class="pl-song-track__radio"
              name="melody-track"
              value={String(c.index)}
              checked={c.index === selected}
              disabled={c.percussion}
              onChange={() => onSelect(c.index)}
            />
            <label for={id} class="pl-song-track__label">
              <span class="pl-song-track__name">{name}</span>
              <span class="pl-song-track__facts pl-tabular">{factLine(facts)}</span>
            </label>
            <button
              type="button"
              class="pl-icon-btn"
              disabled={c.percussion}
              aria-label={playing ? `Stop the preview of ${name}` : `Preview 6 seconds of ${name}`}
              onClick={() => onPreview(c.index)}
            >
              {playing ? <Square size={20} strokeWidth={2} aria-hidden="true" /> : <Play size={20} strokeWidth={2} aria-hidden="true" />}
            </button>
          </div>
        );
      })}
    </fieldset>
  );
}
