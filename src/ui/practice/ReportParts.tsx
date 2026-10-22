/**
 * The plain parts of the take report (docs/DESIGN.md §13.5): the verdict line, the metric tiles and the coaching tip.
 * Pass or miss is always a glyph plus words ("Passed", "Not yet", "Not judged"), a miss is never alarm copy, and a tile
 * says met or unmet with a glyph and text as well as its colour.
 */
import type { JSX } from 'preact';
import { Check, CircleCheck, Info, Lightbulb, Minus, RotateCcw } from 'lucide-preact';
import type { ReportTile } from '../../exercises/evaluate';
import type { PickedTip } from '../../exercises/tips';
import { Card } from '../components/Card';

export type Verdict = 'passed' | 'not-yet' | 'not-judged';

export interface VerdictLineProps {
  verdict: Verdict;
  /** The words next to the glyph: "Passed", "Passed at 45 bpm" (a lower rung of a tempo ladder), "Not yet", "Not judged". */
  word: string;
  /** What was sung, e.g. "Sustain I", with the tempo when it matters ("Run 3 · sung at 72 bpm"). */
  caption: string;
  /** Ladder: "Next take at 104 bpm", shown when the tempo climbed. */
  ladderLine: string | null;
}

export function VerdictLine(props: VerdictLineProps): JSX.Element {
  const { verdict } = props;
  const Glyph = verdict === 'passed' ? CircleCheck : verdict === 'not-yet' ? RotateCcw : Info;
  return (
    <header class={`pl-verdict pl-verdict--${verdict}`}>
      <div class="pl-verdict__line" role="status">
        <Glyph size={28} strokeWidth={2} aria-hidden="true" />
        <h2 class="pl-display-m" data-testid="verdict">
          {props.word}
        </h2>
      </div>
      <p class="pl-body-s pl-muted">{props.caption}</p>
      {verdict === 'not-judged' ? <p class="pl-body-s">Not judged: this exercise doesn’t fit your saved range.</p> : null}
      {props.ladderLine ? (
        <p class="pl-body-s pl-verdict__ladder" data-testid="ladder-line">
          {props.ladderLine}
        </p>
      ) : null}
    </header>
  );
}

const OP_SYMBOL: Record<ReportTile['op'], string> = { '>=': '≥', '<=': '≤' };

export function MetricTiles(props: { tiles: readonly ReportTile[] }): JSX.Element | null {
  if (props.tiles.length === 0) return null;
  return (
    <ul class="pl-tiles" aria-label="How the take measured up">
      {props.tiles.map((t) => {
        const status = t.met === null ? 'not measured' : t.met ? 'target met' : 'target not met';
        return (
          <li key={t.metric} class={`pl-tile${t.met ? ' pl-tile--met' : ''}`} data-testid={`tile-${t.metric}`}>
            <span class="pl-label">{t.label}</span>
            <span class="pl-data pl-tabular pl-tile__value">{t.display}</span>
            <span class="pl-tile__foot">
              <span class="pl-tile__target pl-tabular">
                <span class="pl-visually-hidden">Target </span>
                {OP_SYMBOL[t.op]} {t.targetDisplay}
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

export function TipCard(props: { tip: PickedTip }): JSX.Element {
  return (
    <Card icon={Lightbulb} title="Coaching tip" class="pl-tip">
      <p class="pl-body" data-testid="tip">
        {props.tip.text}
      </p>
    </Card>
  );
}
