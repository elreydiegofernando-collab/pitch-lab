/**
 * After a song take (DESIGN.md §13.9): the overall score in the ring, the verdict as words and a glyph, then the
 * phrase-by-phrase breakdown (phrase text, a score bar and its %, the share in tune), the coaching for the take (the
 * report's CoachCard, §13.5: where it went wrong by syllable and time, more help with each miss in a row on the same
 * phrases, "since last time", and its moves), and the actions: Retry and Next phrase, exactly one of them amber (Next
 * after a pass, Retry after a miss). The coaching card's buttons stay secondary. Save problems are said plainly, never
 * hidden behind a score.
 */
import type { JSX } from 'preact';
import { CircleCheck, Play, RotateCcw, Square } from 'lucide-preact';
import type { CoachMove } from '../../coaching/types';
import type { SongSelection, SongTakeResult } from '../../runtime/song-session';
import { Banner } from '../components/Banner';
import { Button } from '../components/Button';
import { ScoreRing } from '../components/ScoreRing';
import { Sheet } from '../components/Sheet';
import { CoachCard } from '../practice/CoachCard';
import { formatPercent, formatShift } from './format';

/** The sheet's way on: after a pass, the learning path's next step ("Full speed", "Next phrase"); after a miss, the next phrase. */
export interface TakeForward {
  label: string;
  /** The label and what it sets up, for screen readers ("Next phrase (Phrase 2, slowly: …)"); the label when absent. */
  ariaLabel?: string;
  /** Closes the sheet and sets the step up; the singer starts it. */
  onClick(): void;
}

export interface TakeSheetProps {
  result: SongTakeResult | null;
  open: boolean;
  /** The way on; null after a take with nowhere to go (the whole song sung through, or a joined miss): "Done". */
  forward: TakeForward | null;
  takePlaying: boolean;
  onClose(): void;
  /** Sing the same selection again (straight from the tap: it starts the take). */
  onRetry(): void;
  onPlayTake(): void;
  /** The coaching card's "Listen slowly": the phrase the problem is in, slowed down; null hides it. */
  listen?: { slow: boolean; playing: boolean; onClick: () => void } | null;
  /** "Practise phrase N alone", "Practise <level>" and "Send to Claude" from the coaching card. */
  onMove?: (move: CoachMove) => void;
}

/** "Whole song", "Phrase 3", "Phrases 3 and 4", "Phrases 3 to 5". */
export function selectionTitle(selection: SongSelection): string {
  if (selection === null) return 'Whole song';
  const { from, to } = selection;
  if (to - from <= 1) return `Phrase ${from + 1}`;
  return to - from === 2 ? `Phrases ${from + 1} and ${to}` : `Phrases ${from + 1} to ${to}`;
}

export function TakeSheet(props: TakeSheetProps): JSX.Element | null {
  const { result, open, forward, takePlaying, onClose, onRetry, onPlayTake, listen = null, onMove } = props;
  if (!result) return null;
  const selection = result.selection;
  const single = selection !== null && selection.to - selection.from === 1;
  const context: string[] = [];
  if (result.speed !== 1) context.push(`${Math.round(result.speed * 100)}% speed`);
  if (result.shift !== 0) context.push(`key ${formatShift(result.shift)}`);

  // Exactly one amber button: the way on after a pass, Retry after a miss (or when there is nowhere to go).
  const retry = (
    <Button variant={result.passed && forward !== null ? 'secondary' : 'primary'} icon={RotateCcw} onClick={onRetry}>
      {selection === null ? 'Sing again' : single ? 'Retry phrase' : 'Sing them again'}
    </Button>
  );
  const onward =
    forward === null ? (
      <Button variant="ghost" onClick={onClose}>
        Done
      </Button>
    ) : (
      <Button variant={result.passed ? 'primary' : 'secondary'} onClick={forward.onClick} aria-label={forward.ariaLabel}>
        {forward.label}
      </Button>
    );

  return (
    <Sheet open={open} title={selectionTitle(selection)} onClose={onClose}>
      <div class="pl-song-result" data-testid="song-result">
        <ScoreRing value={result.score} size={112} label={`Score ${formatPercent(result.score)}`} class={result.passed ? 'pl-song-result__ring--on' : 'pl-song-result__ring--off'}>
          <span class="pl-readout-l">{formatPercent(result.score)}</span>
        </ScoreRing>
        <div class="pl-song-result__summary">
          {result.passed ? (
            <p class="pl-song-result__verdict pl-song-result__verdict--on">
              <CircleCheck size={20} strokeWidth={2} aria-hidden="true" />
              Passed
            </p>
          ) : (
            <p class="pl-song-result__verdict">
              <RotateCcw size={20} strokeWidth={2} aria-hidden="true" />
              Not yet
            </p>
          )}
          <p class="pl-body-s pl-muted pl-tabular">{Math.round(result.inTolerancePct)}% of the time in tune</p>
          {context.length > 0 ? <p class="pl-body-s pl-muted">Sung at {context.join(', ')}</p> : null}
        </div>
      </div>

      <ol class="pl-song-breakdown">
        {result.phrases.map((p) => (
          <li key={p.phraseIndex} class="pl-song-breakdown__row">
            <span class="pl-song-breakdown__text">
              <span class="pl-song-breakdown__num pl-tabular">{p.phraseIndex + 1}</span>
              {p.text || `Phrase ${p.phraseIndex + 1}`}
            </span>
            <span class="pl-song-breakdown__bar" aria-hidden="true">
              <span class="pl-song-breakdown__fill" style={{ transform: `scaleX(${p.score.pitchScore})` }} />
            </span>
            <span class="pl-song-breakdown__value pl-data pl-tabular">{formatPercent(p.score.pitchScore)}</span>
            <span class="pl-song-breakdown__tol pl-body-s pl-muted pl-tabular">{Math.round(p.score.inTolerancePct)}% in tune</span>
          </li>
        ))}
      </ol>
      {result.unfinished > 0 ? (
        <p class="pl-body-s pl-muted">
          Stopped early: {result.unfinished} phrase{result.unfinished === 1 ? ' was' : 's were'} not judged.
        </p>
      ) : null}

      {result.coaching ? <CoachCard coaching={result.coaching} listen={listen} onMove={onMove} /> : null}

      {result.attemptError ? <Banner kind="error" message={result.attemptError} /> : null}
      {result.saveError ? <Banner kind="warn" message={result.saveError} /> : null}

      <div class="pl-song-result__actions">
        {result.audio ? (
          <Button variant="ghost" icon={takePlaying ? Square : Play} onClick={onPlayTake}>
            {takePlaying ? 'Stop' : 'Play take'}
          </Button>
        ) : null}
        {retry}
        {onward}
      </div>
    </Sheet>
  );
}
