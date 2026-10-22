/**
 * After a song take (DESIGN.md §13.9): the overall score in the ring, the verdict as words and a glyph, then the
 * phrase-by-phrase breakdown (phrase text, a score bar and its %, the share in tune), and the actions: Retry phrase
 * and Next phrase, exactly one of them amber (Next after a pass, Retry after a miss). Save problems are said plainly,
 * never hidden behind a score.
 */
import type { JSX } from 'preact';
import { CircleCheck, Play, RotateCcw, Square } from 'lucide-preact';
import type { SongSelection, SongTakeResult } from '../../runtime/song-session';
import { Banner } from '../components/Banner';
import { Button } from '../components/Button';
import { ScoreRing } from '../components/ScoreRing';
import { Sheet } from '../components/Sheet';
import { formatPercent, formatShift } from './format';

export interface TakeSheetProps {
  result: SongTakeResult | null;
  open: boolean;
  /**
   * Where Next goes: the next phrase with pitches to score, or null (the whole song) after the last one; undefined
   * after a whole-song take, which has no Next.
   */
  next: SongSelection | undefined;
  takePlaying: boolean;
  onClose(): void;
  /** Sing the same selection again (straight from the tap: it starts the take). */
  onRetry(): void;
  /** Select the next phrase (or the whole song after the last one). */
  onNext(next: SongSelection): void;
  onPlayTake(): void;
}

function title(selection: SongSelection): string {
  return selection === null ? 'Whole song' : `Phrase ${selection + 1}`;
}

export function TakeSheet(props: TakeSheetProps): JSX.Element | null {
  const { result, open, next, takePlaying, onClose, onRetry, onNext, onPlayTake } = props;
  if (!result) return null;
  const phrase = result.selection;
  const context: string[] = [];
  if (result.speed !== 1) context.push(`${Math.round(result.speed * 100)}% speed`);
  if (result.shift !== 0) context.push(`key ${formatShift(result.shift)}`);

  const retry = (
    <Button variant={result.passed && next !== undefined ? 'secondary' : 'primary'} icon={RotateCcw} onClick={onRetry}>
      {phrase === null ? 'Sing again' : 'Retry phrase'}
    </Button>
  );
  const forward =
    next === undefined ? (
      <Button variant="ghost" onClick={onClose}>
        Done
      </Button>
    ) : (
      <Button variant={result.passed ? 'primary' : 'secondary'} onClick={() => onNext(next)}>
        {next === null ? 'Whole song' : 'Next phrase'}
      </Button>
    );

  return (
    <Sheet open={open} title={title(phrase)} onClose={onClose}>
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
      {result.attemptError ? <Banner kind="error" message={result.attemptError} /> : null}
      {result.saveError ? <Banner kind="warn" message={result.saveError} /> : null}

      <div class="pl-song-result__actions">
        {result.audio ? (
          <Button variant="ghost" icon={takePlaying ? Square : Play} onClick={onPlayTake}>
            {takePlaying ? 'Stop' : 'Play take'}
          </Button>
        ) : null}
        {retry}
        {forward}
      </div>
    </Sheet>
  );
}
