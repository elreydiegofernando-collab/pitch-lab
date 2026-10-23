/**
 * The phrase scrubber (DESIGN.md §13.9), which is also the song's progress strip: "Whole song", then one pill per
 * phrase with its best full-speed score from the log as a number, a check glyph once the phrase is learned (a
 * full-speed take at the pass score, song/practice.ts), tinted on (learned) or off (sung, not yet learned). The number
 * and the glyph carry the meaning; the tint only repeats it. Phrases joined into one selection are all marked selected.
 * It scrolls sideways inside its own row, so the page never does, and keeps the selected (or playing) phrase in view.
 */
import { useEffect, useRef } from 'preact/hooks';
import type { JSX } from 'preact';
import type { ReadonlySignal } from '@preact/signals';
import { Check } from 'lucide-preact';
import { onePhrase, type PhraseRow, type SongSelection } from '../../runtime/song-session';
import type { PhraseProgress } from '../../song/practice';
import type { LyricCursor } from './cursor';

export interface PhraseScrubberProps {
  rows: readonly PhraseRow[];
  selection: SongSelection;
  /** Each phrase's progress from the log, by Song.phrases index (spoken phrases have none). */
  progress: ReadonlyMap<number, PhraseProgress>;
  cursor: ReadonlySignal<LyricCursor | null>;
  disabled: boolean;
  onSelect(selection: SongSelection): void;
}

/** "Phrase 3, O holy night, learned, best 82%". */
export function pillLabel(row: PhraseRow, progress: PhraseProgress | undefined): string {
  const parts = [`Phrase ${row.index + 1}`];
  if (row.text) parts.push(row.text);
  if (row.pitchedIndex === null) parts.push('spoken, not scored');
  else if (!progress || progress.best === null) parts.push('not sung at full speed yet');
  else parts.push(progress.learned ? 'learned' : 'not learned yet', `best ${Math.round(progress.best * 100)}%`);
  return parts.join(', ');
}

function selects(selection: SongSelection, index: number): boolean {
  return selection !== null && index >= selection.from && index < selection.to;
}

export function PhraseScrubber(props: PhraseScrubberProps): JSX.Element {
  const { rows, selection, progress, disabled, onSelect } = props;
  const playing = props.cursor.value?.phrase ?? null;
  const rowRef = useRef<HTMLDivElement>(null);
  const focus = playing ?? (selection === null ? null : selection.from);

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
        const p = progress.get(row.index);
        const best = p?.best ?? null;
        const tone = p?.learned ? ' pl-song-pill--on' : best !== null ? ' pl-song-pill--off' : '';
        return (
          <button
            key={row.index}
            type="button"
            class={`pl-song-pill${tone}`}
            data-phrase={row.index}
            aria-pressed={selects(selection, row.index)}
            aria-label={pillLabel(row, p)}
            disabled={disabled}
            onClick={() => onSelect(onePhrase(row.index))}
          >
            <span class="pl-song-pill__num pl-tabular">
              {p?.learned ? <Check class="pl-song-pill__learned" size={12} strokeWidth={3} aria-hidden="true" /> : null}
              {row.index + 1}
            </span>
            <span class="pl-song-pill__score pl-tabular">{row.pitchedIndex === null ? '–' : best === null ? '··' : Math.round(best * 100)}</span>
            {playing === row.index ? <span class="pl-song-pill__now" aria-hidden="true" /> : null}
          </button>
        );
      })}
    </div>
  );
}
