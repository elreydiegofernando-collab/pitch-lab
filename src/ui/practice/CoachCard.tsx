/**
 * CoachCard: the take report's coaching (docs/DESIGN.md §13.5, item 6), and the Level screen's "Last time". What went
 * wrong and where (spot chips that mark the moment on the replay), the tip, then more help the more misses in a row:
 * why it happens (depth 2), a numbered walk-through (depth 3), a gentler way in and the moves (depth 4), and "since
 * last time". Calm and plain: no alarm colours, every button secondary (the screen's own action stays the one amber
 * primary), and nothing said by colour alone.
 */
import type { JSX } from 'preact';
import { ArrowRight, Coffee, Equal, Headphones, Lightbulb, MapPin, Repeat, Send, Square, TrendingDown, TrendingUp } from 'lucide-preact';
import { REST_MISSES } from '../../coaching/coach';
import { ordinal, sentence } from '../../coaching/plain';
import type { CoachMove, Coaching, ProgressLine } from '../../coaching/types';
import type { ExerciseDef } from '../../exercises/types';
import { Button } from '../components/Button';

/** True when the exercise's Listen demo plays a slow pass first (a slow demo or a tempo ladder): the move reads "Listen slowly". */
export function hasSlowDemo(def: Pick<ExerciseDef, 'demo' | 'tempoLadder'>): boolean {
  return def.demo.slowFirst === true || (def.tempoLadder?.length ?? 0) > 0;
}

/** "Third try in a row, so here is a step-by-step.": why the card shows more than the tip (depth 2 and up, misses only). */
export function depthLine(coaching: Pick<Coaching, 'depth' | 'missesInARow' | 'passed'>): string | null {
  if (coaching.passed || coaching.depth < 2) return null;
  const more = coaching.depth === 2 ? 'why it happens' : coaching.depth === 3 ? 'a step-by-step' : 'a gentler way in';
  return `${sentence(ordinal(coaching.missesInARow))} try in a row, so here is ${more}.`;
}

/** The voice-care note for a rest move: after a long run of misses, or many takes in a short time. */
export function restLine(coaching: Pick<Coaching, 'missesInARow'>): string {
  const why = coaching.missesInARow >= REST_MISSES ? 'That is a lot of tries in a row.' : 'You have sung a lot in the last few minutes.';
  return `${why} Rest your voice for a few minutes and sip some water. Stop if anything hurts, scratches or goes hoarse.`;
}

export interface CoachCardProps {
  coaching: Coaching;
  /** The card's title: "Coaching" on the report, "Last time" on the Level screen. */
  title?: string;
  /** The spot marked on the replay (its index), or null. */
  selectedSpot?: number | null;
  /** Tap a spot to mark it on the replay, again to clear it. Without it (no replay on screen) the spots are a plain list. */
  onSelectSpot?: (index: number | null) => void;
  /** The listen move's button; null hides it (no demo to play here). */
  listen?: { slow: boolean; playing: boolean; onClick: () => void } | null;
  /** "Practise <level>" and "Send to Claude". */
  onMove?: (move: CoachMove) => void;
}

function ProgressRow(props: { line: ProgressLine }): JSX.Element {
  const { line } = props;
  const state = line.better === true ? 'better' : line.better === false ? 'worse' : 'same';
  const Glyph = line.better === true ? TrendingUp : line.better === false ? TrendingDown : Equal;
  const word = line.better === true ? 'better' : line.better === false ? 'not as good' : 'about the same';
  return (
    <li class={`pl-coach__line pl-coach__line--${state}`} data-testid="coach-progress-line">
      <span class="pl-coach__line-label">{line.label}</span>
      <span class="pl-coach__line-values">
        <span class="pl-visually-hidden">Last time </span>
        <span>{line.before}</span>
        <ArrowRight size={16} strokeWidth={2} aria-hidden="true" />
        <span class="pl-visually-hidden">, this time </span>
        <span class="pl-coach__line-now">{line.now}</span>
      </span>
      <span class="pl-coach__line-mark">
        <Glyph size={16} strokeWidth={2} aria-hidden="true" />
        {word}
      </span>
    </li>
  );
}

export function CoachCard(props: CoachCardProps): JSX.Element {
  const { coaching, title = 'Coaching', selectedSpot = null, onSelectSpot, listen, onMove } = props;
  const { problem } = coaching;
  const lead = depthLine(coaching);
  const rest = coaching.moves.some((m) => m.kind === 'rest');
  const buttons = coaching.moves.filter((m) => m.kind !== 'rest' && (m.kind !== 'listen-slow' || listen));

  return (
    <section class="pl-card pl-coach" aria-label={title} data-testid="coach-card" data-depth={coaching.depth}>
      <header class="pl-coach__head">
        <span class="pl-card__icon" aria-hidden="true">
          <Lightbulb size={22} strokeWidth={2} />
        </span>
        <div class="pl-coach__titles">
          <h3 class="pl-card__title">{title}</h3>
          {lead ? (
            <p class="pl-body-s pl-muted" data-testid="coach-depth">
              {lead}
            </p>
          ) : null}
        </div>
      </header>

      {problem.what ? (
        <p class="pl-body pl-prose" data-testid="coach-what">
          {problem.what}
        </p>
      ) : null}

      {problem.spots.length > 0 ? (
        <div class="pl-coach__where">
          {onSelectSpot ? <p class="pl-body-s pl-muted">Tap one to mark it on the replay above.</p> : null}
          <ul class="pl-coach__spots" aria-label="Where it happened">
            {problem.spots.map((s, i) => (
              <li key={`${s.t}-${s.label}`}>
                {onSelectSpot ? (
                  <button
                    type="button"
                    class="pl-coach__spot"
                    aria-pressed={selectedSpot === i}
                    data-testid="coach-spot"
                    onClick={() => onSelectSpot(selectedSpot === i ? null : i)}
                  >
                    <MapPin size={16} strokeWidth={2} aria-hidden="true" />
                    {s.label}
                  </button>
                ) : (
                  <span class="pl-coach__spot pl-coach__spot--static" data-testid="coach-spot">
                    <MapPin size={16} strokeWidth={2} aria-hidden="true" />
                    {s.label}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div class="pl-coach__part">
        <h4 class="pl-label">{coaching.passed ? 'Next' : 'Try this'}</h4>
        <p class="pl-body pl-prose" data-testid="tip">
          {coaching.tip}
        </p>
      </div>

      {coaching.why ? (
        <div class="pl-coach__part">
          <h4 class="pl-label">Why it happens</h4>
          <p class="pl-body pl-prose" data-testid="coach-why">
            {coaching.why}
          </p>
        </div>
      ) : null}

      {coaching.steps.length > 0 ? (
        <div class="pl-coach__part">
          <h4 class="pl-label">Step by step</h4>
          <ol class="pl-coach__steps" data-testid="coach-steps">
            {coaching.steps.map((step, i) => (
              <li key={step}>
                <span class="pl-coach__step-n pl-tabular" aria-hidden="true">
                  {i + 1}
                </span>
                <span class="pl-prose">{step}</span>
              </li>
            ))}
          </ol>
        </div>
      ) : null}

      {coaching.easier ? (
        <div class="pl-coach__part">
          <h4 class="pl-label">An easier way in</h4>
          <p class="pl-body pl-prose" data-testid="coach-easier">
            {coaching.easier}
          </p>
        </div>
      ) : null}

      {coaching.progress.length > 0 ? (
        <div class="pl-coach__part">
          <h4 class="pl-label">Since last time</h4>
          <ul class="pl-coach__progress" data-testid="coach-progress">
            {coaching.progress.map((line) => (
              <ProgressRow key={line.label} line={line} />
            ))}
          </ul>
        </div>
      ) : null}

      {rest ? (
        <p class="pl-coach__rest pl-body-s" data-testid="coach-rest">
          <Coffee size={18} strokeWidth={2} aria-hidden="true" />
          <span class="pl-prose">{restLine(coaching)}</span>
        </p>
      ) : null}

      {buttons.length > 0 ? (
        <div class="pl-coach__moves" data-testid="coach-moves">
          {buttons.map((move) => {
            if (move.kind === 'listen-slow' && listen) {
              return (
                <Button key="listen" variant="secondary" icon={listen.playing ? Square : Headphones} onClick={listen.onClick} data-testid="coach-listen">
                  {listen.playing ? 'Stop' : listen.slow ? 'Listen slowly' : 'Listen again'}
                </Button>
              );
            }
            if (move.kind === 'practise-level') {
              return (
                <Button key={`practise-${move.levelId}`} variant="secondary" icon={Repeat} onClick={() => onMove?.(move)} data-testid="coach-practise">
                  Practise {move.title}
                </Button>
              );
            }
            if (move.kind === 'send-to-claude') {
              return (
                <Button key="send" variant="ghost" icon={Send} onClick={() => onMove?.(move)} data-testid="coach-send">
                  Send to Claude
                </Button>
              );
            }
            return null;
          })}
        </div>
      ) : null}
    </section>
  );
}
