/**
 * The phrase scrubber (DESIGN.md §13.9): "Whole song", then one pill per phrase with its last score in this visit
 * as a number, tinted on (passed) or off (not yet). The number carries the meaning; the tint only repeats it. It
 * scrolls sideways inside its own row, so the page never does, and keeps the selected (or playing) phrase in view.
 */
import { useEffect, useRef } from 'preact/hooks';
import type { JSX } from 'preact';
import type { ReadonlySignal } from '@preact/signals';
import { SONG_PASS_SCORE, type PhraseRow, type SongSelection } from '../../runtime/song-session';
import type { LyricCursor } from './cursor';

export interface PhraseScrubberProps {
  rows: readonly PhraseRow[];
  selection: SongSelection;
  /** Last score (0..1) per Song.phrases index. */
  lastScores: ReadonlyMap<number, number>;
  cursor: ReadonlySignal<LyricCursor | null>;
  disabled: boolean;
  onSelect(selection: SongSelection): void;
}

function pillLabel(row: PhraseRow, score: number | undefined): string {
  const parts = [`Phrase ${row.index + 1}`];
  if (row.text) parts.push(row.text);
  if (row.pitchedIndex === null) parts.push('spoken, not scored');
  else if (score !== undefined) parts.push(`last score ${Math.round(score * 100)}%`);
  return parts.join(', ');
}

export function PhraseScrubber(props: PhraseScrubberProps): JSX.Element {
  const { rows, selection, lastScores, disabled, onSelect } = props;
  const playing = props.cursor.value?.phrase ?? null;
  const rowRef = useRef<HTMLDivElement>(null);
  const focus = playing ?? selection;

  useEffect(() => {
    const pill = rowRef.current?.querySelector<HTMLElement>(focus === null ? '[data-phrase="all"]' : `[data-phrase="${focus}"]`);
    pill?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }, [focus]);

  return (
    <div ref={rowRef} class="pl-song-scrubber" role="group" aria-label="Phrases" data-testid="phrase-scrubber">
      <button type="button" class="pl-song-pill pl-song-pill--all" data-phrase="all" aria-pressed={selection === null} disabled={disabled} onClick={() => onSelect(null)}>
        Whole song
      </button>
      {rows.map((row) => {
        const score = lastScores.get(row.index);
        const tone = score === undefined ? '' : score >= SONG_PASS_SCORE ? ' pl-song-pill--on' : ' pl-song-pill--off';
        return (
          <button
            key={row.index}
            type="button"
            class={`pl-song-pill${tone}`}
            data-phrase={row.index}
            aria-pressed={selection === row.index}
            aria-label={pillLabel(row, score)}
            disabled={disabled}
            onClick={() => onSelect(row.index)}
          >
            <span class="pl-song-pill__num pl-tabular">{row.index + 1}</span>
            <span class="pl-song-pill__score pl-tabular">{row.pitchedIndex === null ? '–' : score === undefined ? '··' : Math.round(score * 100)}</span>
            {playing === row.index ? <span class="pl-song-pill__now" aria-hidden="true" /> : null}
          </button>
        );
      })}
    </div>
  );
}
