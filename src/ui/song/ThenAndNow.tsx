/**
 * "Then and now" (the song's progress screen): the first take of the song against the best whole-song take, each with
 * its score and its pitch line drawn over the notes it was sung against. Inline SVG, no chart library (DESIGN.md
 * §13.0): the notes are the bars, the line is blue where it sat inside the bar and orange where it strayed (the
 * Okabe-Ito pair, never colour alone: where the line sits against the bar says the same), with the lowest and highest
 * note names and the start and end times as axis labels. "Show as table" swaps the pictures for each phrase's score
 * then and now.
 */
import type { JSX } from 'preact';
import { noteName, type Notation } from '../../core/music';
import { CONFIG } from '../../config';
import { ChartFrame } from '../progress/charts';
import { formatClock, formatPercent } from './format';
import { drawnMidi, thenNowTable, type SongTakeView } from './then-now';

const W = 300;
const H = 132;
const PAD_L = 36;
const PAD_R = 6;
const PAD_T = 8;
const PAD_B = 22;
/** Points kept per horizontal unit of the drawing, at most (a whole song holds many thousands of frames). */
const POINTS_PER_UNIT = 2;

interface Run {
  inTune: boolean;
  points: string;
}

/** The pitch line as same-colour runs, broken at silences, thinned to what the drawing can show. */
function lineRuns(view: SongTakeView, x: (t: number) => number, y: (m: number) => number): Run[] {
  const track = view.track ?? [];
  const tol = CONFIG.tolerance.default / 100;
  const runs: Run[] = [];
  let pts: string[] = [];
  let inTune = false;
  let lastX = -Infinity;
  let lastT = -Infinity;
  for (const f of track) {
    if (f.t < view.start || f.t > view.end) continue;
    const sounding = f.voiced && Number.isFinite(f.midi);
    // A silence (or a gap in the frames) ends the line; it starts again with the voice.
    if (pts.length > 0 && (!sounding || f.t - lastT > 0.15)) {
      if (pts.length > 1) runs.push({ inTune, points: pts.join(' ') });
      pts = [];
    }
    if (!sounding) continue;
    lastT = f.t;
    const px = x(f.t);
    if (pts.length > 0 && px - lastX < 1 / POINTS_PER_UNIT) continue;
    lastX = px;
    const midi = drawnMidi(f, view.notes);
    const note = view.notes.find((n) => f.t >= n.start && f.t <= n.start + n.duration);
    const here = note !== undefined && Math.abs(midi - note.midi) <= tol;
    const pt = `${px.toFixed(1)},${y(midi).toFixed(1)}`;
    if (pts.length > 0 && here !== inTune) {
      // A change of colour: the new run starts where the old one ended, so the line stays joined.
      const joint = pts[pts.length - 1];
      if (pts.length > 1) runs.push({ inTune, points: pts.join(' ') });
      pts = [joint];
    }
    if (pts.length === 0 || here !== inTune) inTune = here;
    pts.push(pt);
  }
  if (pts.length > 1) runs.push({ inTune, points: pts.join(' ') });
  return runs;
}

/** One take: the notes as bars and the pitch line over them. */
export function TakeChart(props: { view: SongTakeView; notation: Notation; label: string }): JSX.Element {
  const { view, notation, label } = props;
  let lo = Infinity;
  let hi = -Infinity;
  for (const n of view.notes) {
    lo = Math.min(lo, n.midi);
    hi = Math.max(hi, n.midi);
  }
  if (!Number.isFinite(lo)) {
    lo = 60;
    hi = 72;
  }
  const bottom = lo - 2;
  const top = Math.max(hi + 2, bottom + 8);
  const span = Math.max(1e-6, view.end - view.start);
  const x = (t: number): number => PAD_L + ((t - view.start) / span) * (W - PAD_L - PAD_R);
  const y = (m: number): number => PAD_T + (1 - (Math.min(top, Math.max(bottom, m)) - bottom) / (top - bottom)) * (H - PAD_T - PAD_B);
  const band = Math.max(3, ((CONFIG.tolerance.default * 2) / 100 / (top - bottom)) * (H - PAD_T - PAD_B));
  const runs = lineRuns(view, x, y);
  return (
    <svg class="pl-song-chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={label} focusable="false">
      <line class="pl-song-chart__axis" x1={PAD_L} x2={W - PAD_R} y1={H - PAD_B + 0.5} y2={H - PAD_B + 0.5} />
      {view.notes.map((n, i) => (
        <rect
          key={i}
          class="pl-song-chart__note"
          x={x(n.start)}
          y={y(n.midi) - band / 2}
          width={Math.max(1.5, x(n.start + n.duration) - x(n.start))}
          height={band}
          rx={1.5}
        />
      ))}
      {runs.map((r, i) => (
        <polyline key={i} class={r.inTune ? 'pl-song-chart__line pl-song-chart__line--on' : 'pl-song-chart__line pl-song-chart__line--off'} points={r.points} />
      ))}
      <text class="pl-song-chart__tick" x={PAD_L - 4} y={y(hi) + 4} text-anchor="end">
        {noteName(Math.round(hi), notation)}
      </text>
      {hi !== lo ? (
        <text class="pl-song-chart__tick" x={PAD_L - 4} y={y(lo) + 4} text-anchor="end">
          {noteName(Math.round(lo), notation)}
        </text>
      ) : null}
      <text class="pl-song-chart__tick" x={PAD_L} y={H - 5}>
        {formatClock(Math.max(0, view.start))}
      </text>
      <text class="pl-song-chart__tick" x={W - PAD_R} y={H - 5} text-anchor="end">
        {formatClock(view.end)}
      </text>
    </svg>
  );
}

function TakeBlock(props: { view: SongTakeView; title: string; notation: Notation }): JSX.Element {
  const { view, title, notation } = props;
  return (
    <figure class="pl-song-then__take" data-testid="then-now-take">
      <figcaption class="pl-song-then__caption">
        <span class="pl-label">{title}</span>
        <span class="pl-song-then__score pl-tabular">{formatPercent(view.score)}</span>
        <span class="pl-body-s pl-muted">
          {view.label} · {view.when}
        </span>
      </figcaption>
      {view.track ? (
        <TakeChart view={view} notation={notation} label={`${title}: ${view.label}, ${formatPercent(view.score)}, its pitch line over the notes`} />
      ) : (
        <p class="pl-body-s pl-muted">The pitch line of this take was not kept.</p>
      )}
    </figure>
  );
}

export interface ThenAndNowProps {
  then: SongTakeView | null;
  now: SongTakeView | null;
  /** Each phrase's words (pitchedView(song).phrases order), for the table. */
  texts: readonly string[];
  notation: Notation;
}

export function ThenAndNow(props: ThenAndNowProps): JSX.Element {
  const { then, now, texts, notation } = props;
  if (!then) return <p class="pl-body-s pl-muted">Sing a phrase of this song, and your first take will show here.</p>;
  const same = now !== null && now.attempt.id === then.attempt.id;
  const charts = (
    <div class="pl-song-then">
      <TakeBlock view={then} title={same ? 'First and best' : 'Then'} notation={notation} />
      {now && !same ? <TakeBlock view={now} title="Now" notation={notation} /> : null}
    </div>
  );
  const table = thenNowTable(then, same ? null : now, texts);
  return (
    <div class="pl-stack">
      <ChartFrame chart={charts} table={{ caption: 'Each phrase’s score in your first take and your best whole-song take', columns: table.columns, rows: table.rows }} />
      {now === null ? <p class="pl-body-s pl-muted">Sing the whole song at full speed to see how far you have come.</p> : null}
      {same ? <p class="pl-body-s pl-muted">Your first take is still your best whole-song take.</p> : null}
    </div>
  );
}
