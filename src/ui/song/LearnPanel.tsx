/**
 * "Learn this song" (owner, 2026-10-22: "I'd love to be able to practice on a song and get better at it"): the song
 * player's guide through the learning path (song/practice.ts). It shows the step to do now, "Step 4 of 17", and one
 * action that sets that step up (its phrases, speed and loop) and starts it: Listen for the first step, Sing for the
 * rest. The action is a secondary button, because the bar's Sing stays the screen's one amber primary; it sings
 * exactly what the bar would once the step is set up. A link opens the song's progress. The path is a suggestion: the
 * scrubber still picks any phrase.
 */
import type { JSX } from 'preact';
import { ChevronRight, Mic, Volume2 } from 'lucide-preact';
import type { PracticeStep, SongPractice } from '../../song/practice';
import { Button } from '../components/Button';

export interface LearnPanelProps {
  practice: SongPractice;
  /** The step shown (the path's current one, past Listen once the song was heard on this visit); null when all are done. */
  step: PracticeStep | null;
  /** Its index in practice.steps. */
  index: number;
  /** A take is starting or running: the action waits. */
  busy: boolean;
  /** Sing steps need the route's latency calibration (the banner above says so). */
  canSing: boolean;
  onStart(step: PracticeStep): void;
  onProgress(): void;
}

/** The action's words for a step: "Listen", "Sing it slowly", "Sing them together". */
export function stepAction(step: PracticeStep): string {
  switch (step.kind) {
    case 'listen':
      return 'Listen';
    case 'phrase-slow':
      return 'Sing it slowly';
    case 'phrase':
      return 'Sing it';
    case 'join':
      return 'Sing them together';
    case 'whole':
      return 'Sing the whole song';
  }
}

export function LearnPanel(props: LearnPanelProps): JSX.Element {
  const { practice, step, index, busy, canSing, onStart, onProgress } = props;
  const total = practice.steps.length;
  const learned = practice.phrases.filter((p) => p.learned).length;
  const listen = step?.kind === 'listen';
  return (
    <section class="pl-song-learn" aria-labelledby="song-learn-title" data-testid="learn-panel">
      <div class="pl-song-learn__head">
        <h2 id="song-learn-title" class="pl-label">
          Learn this song
        </h2>
        {step ? (
          <span class="pl-label pl-tabular" data-testid="learn-count">
            Step {index + 1} of {total}
          </span>
        ) : null}
      </div>
      {step ? (
        <>
          <p class="pl-song-learn__title" data-testid="learn-step">
            {step.title}
          </p>
          <div class="pl-song-learn__actions">
            <Button
              variant="secondary"
              icon={listen ? Volume2 : Mic}
              disabled={busy || (!listen && !canSing)}
              onClick={() => onStart(step)}
              data-testid="learn-start"
            >
              {stepAction(step)}
            </Button>
            <button type="button" class="pl-song-learn__link" onClick={onProgress} data-testid="learn-progress">
              Progress
              <ChevronRight size={18} strokeWidth={2} aria-hidden="true" />
            </button>
          </div>
        </>
      ) : (
        <div class="pl-song-learn__actions">
          <p class="pl-song-learn__title" data-testid="learn-step">
            You have learned the whole song.
          </p>
          <button type="button" class="pl-song-learn__link" onClick={onProgress} data-testid="learn-progress">
            Progress
            <ChevronRight size={18} strokeWidth={2} aria-hidden="true" />
          </button>
        </div>
      )}
      {practice.phrases.length > 0 ? (
        <p class="pl-body-s pl-muted pl-tabular" data-testid="learn-learned">
          {learned} of {practice.phrases.length} phrases learned
        </p>
      ) : null}
    </section>
  );
}
