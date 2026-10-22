/**
 * The lyrics under the piano roll (DESIGN.md §13.9): the phrase being sung at 20 px with a tally underline that walks
 * the syllables (the screen's one memorable thing), and the next phrase dimmed. Sung syllables read brighter than
 * the ones still to come. The underline is one bar moved with a transform (DESIGN.md §9: transform and opacity
 * only; instant under reduced motion), measured once per syllable change, never per frame.
 */
import { Fragment } from 'preact';
import { useLayoutEffect, useRef } from 'preact/hooks';
import type { JSX } from 'preact';
import type { ReadonlySignal } from '@preact/signals';
import type { PhraseRow, SongSelection } from '../../runtime/song-session';
import type { LyricCursor } from './cursor';

/** The underline's width before scaling, px (scaleX = syllable width / this). */
const BAR_BASE_PX = 100;

function phraseLabel(row: PhraseRow): string {
  return row.text || `Phrase ${row.index + 1}`;
}

export interface LyricsStripProps {
  rows: readonly PhraseRow[];
  cursor: ReadonlySignal<LyricCursor | null>;
  /** Shown when nothing plays: the selected phrase (the first one for the whole song). */
  selection: SongSelection;
}

export function LyricsStrip(props: LyricsStripProps): JSX.Element {
  const { rows } = props;
  const c = props.cursor.value;
  const index = c ? c.phrase : (props.selection ?? 0);
  const row = rows[index];
  const next = rows[index + 1];
  const lineRef = useRef<HTMLParagraphElement>(null);
  const barRef = useRef<HTMLSpanElement>(null);
  const note = c?.note ?? null;

  useLayoutEffect(() => {
    const bar = barRef.current;
    const target = note === null ? null : lineRef.current?.querySelector<HTMLElement>(`[data-note="${note}"]`);
    if (!bar) return;
    if (!target) {
      bar.style.opacity = '0';
      return;
    }
    bar.style.opacity = '1';
    bar.style.transform = `translate(${target.offsetLeft}px, ${target.offsetTop + target.offsetHeight}px) scaleX(${target.offsetWidth / BAR_BASE_PX})`;
  }, [index, note]);

  return (
    <div class="pl-song-lyrics" data-testid="song-lyrics">
      <p ref={lineRef} class="pl-song-lyrics__now">
        {row && row.syllables.length > 0 ? (
          row.syllables.map((s) => {
            const lead = /^\s*/.exec(s.text)?.[0] ?? '';
            const state = note === null ? '' : s.note < note ? ' pl-song-syl--sung' : s.note === note ? ' pl-song-syl--now' : ' pl-song-syl--next';
            return (
              <Fragment key={s.note}>
                {lead}
                <span data-note={s.note} class={`pl-song-syl${state}`}>
                  {s.text.slice(lead.length)}
                </span>
              </Fragment>
            );
          })
        ) : (
          <span class="pl-lo">{row ? phraseLabel(row) : ' '}</span>
        )}
        <span ref={barRef} class="pl-song-lyrics__bar" aria-hidden="true" />
      </p>
      <p class="pl-song-lyrics__next">{next ? phraseLabel(next) : ' '}</p>
    </div>
  );
}
