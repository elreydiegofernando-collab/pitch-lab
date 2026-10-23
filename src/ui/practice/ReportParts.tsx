/**
 * The plain parts of the take report (docs/DESIGN.md §13.5): the verdict line and the metric tiles (the coaching is
 * CoachCard.tsx). Pass or miss is always a glyph plus words ("Passed", "Not yet", "Not judged"), a miss is never alarm
 * copy, and a tile says met or unmet with a glyph and text as well as its colour. A tile is in plain words (owner,
 * 2026-10-23: "in tune 72% of the time" rather than "828c"): the reading as the coach would say it, the goal as a
 * sentence, and a label that is a music word can be tapped to learn it (src/teach/plain-metrics.ts).
 */
import type { JSX } from 'preact';
import { Check, CircleCheck, Info, Minus, RotateCcw } from 'lucide-preact';
import { sentence } from '../../coaching/plain';
import type { NotJudgedReason, ReportTile } from '../../exercises/evaluate';
import { metricTerm, plainGoal, plainValue } from '../../teach/plain-metrics';
import { Term } from '../teach/Term';
import '../../styles/teach.css';

export type Verdict = 'passed' | 'not-yet' | 'not-judged' | 'done';

/** Why a take was not judged, in a sentence (DESIGN §11: plain, never alarm copy). */
export function notJudgedLine(reason: NotJudgedReason | undefined, audition = false): string {
  if (reason === 'stopped') return audition ? 'Stopped early: practice only, not judged as a test.' : 'Stopped early: practice only, not judged for the level.';
  return 'Not judged: this exercise doesn’t fit your saved range.';
}

/** Why a take of a voice check-up task measured nothing. */
export type UnmeasuredReason = 'stopped' | 'quiet' | 'silent';

/** A check-up task that measured nothing, and why, in a sentence: a check-up measures, it never judges. */
export function unmeasuredLine(reason: UnmeasuredReason): string {
  switch (reason) {
    case 'stopped':
      return 'Stopped early, so this task was not measured.';
    case 'quiet':
      return 'Not all of this task was heard, so it was not measured.';
    case 'silent':
      return 'Nothing came through the microphone, so this task was not measured.';
  }
}

export interface VerdictLineProps {
  verdict: Verdict;
  /** The words next to the glyph: "Passed", "Passed at 45 bpm" (a lower rung of a tempo ladder), "Not yet", "Not judged", "Done". */
  word: string;
  /** What was sung, e.g. "Sustain I", with the tempo when it matters ("Run 3 · sung at 72 bpm"). */
  caption: string;
  /** Ladder: "Next take at 104 bpm", shown when the tempo climbed. */
  ladderLine: string | null;
  /** Why a 'not-judged' take was not judged (notJudgedLine); the folded-range sentence when omitted. */
  reasonLine?: string | null;
}

export function VerdictLine(props: VerdictLineProps): JSX.Element {
  const { verdict } = props;
  const Glyph = verdict === 'passed' ? CircleCheck : verdict === 'not-yet' ? RotateCcw : verdict === 'done' ? Check : Info;
  const reason = props.reasonLine ?? (verdict === 'not-judged' ? notJudgedLine(undefined) : null);
  return (
    <header class={`pl-verdict pl-verdict--${verdict}`}>
      <div class="pl-verdict__line">
        <Glyph size={28} strokeWidth={2} aria-hidden="true" />
        <h2 class="pl-display-m" data-testid="verdict" tabIndex={-1}>
          {props.word}
        </h2>
      </div>
      <p class="pl-body-s pl-muted">{props.caption}</p>
      {reason ? (
        <p class="pl-body-s" data-testid="verdict-reason">
          {reason}
        </p>
      ) : null}
      {props.ladderLine ? (
        <p class="pl-body-s pl-verdict__ladder" data-testid="ladder-line">
          {props.ladderLine}
        </p>
      ) : null}
    </header>
  );
}

export function MetricTiles(props: { tiles: readonly ReportTile[] }): JSX.Element | null {
  if (props.tiles.length === 0) return null;
  return (
    <ul class="pl-tiles" aria-label="How the take measured up">
      {props.tiles.map((t) => {
        const status = t.met === null ? 'not measured' : t.met ? 'goal met' : 'goal not met';
        const term = metricTerm(t.metric);
        return (
          <li key={t.metric} class={`pl-tile${t.met ? ' pl-tile--met' : ''}`} data-testid={`tile-${t.metric}`}>
            <span class="pl-label">{term ? <Term id={term}>{t.label}</Term> : t.label}</span>
            <span class={`pl-data pl-tile__value pl-tile__value--plain${t.value === null ? ' pl-muted' : ''}`} data-testid={`tile-${t.metric}-value`}>
              {t.value === null ? 'Not measured' : sentence(plainValue(t.metric, t.value))}
            </span>
            <span class="pl-tile__foot">
              <span class="pl-tile__target" data-testid={`tile-${t.metric}-goal`}>
                Goal: {plainGoal(t.metric, t.op, t.target)}
              </span>
              <span class="pl-tile__mark">
                {t.met ? <Check size={18} strokeWidth={2.5} aria-hidden="true" /> : <Minus size={18} strokeWidth={2.5} aria-hidden="true" />}
                <span class="pl-visually-hidden">{status}</span>
              </span>
            </span>
          </li>
        );
      })}
    </ul>
  );
}
