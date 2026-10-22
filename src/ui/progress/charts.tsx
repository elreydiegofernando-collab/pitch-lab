/**
 * Inline-SVG charts for the dashboard (DESIGN.md §13.0, §13.10). No chart library: each chart is a handful of
 * shapes drawn from the same data its "Show as table" view lists. Colour is never the only cue: a rest day is a
 * hollow bar and a sung day a solid one, the two practice weeks are told apart by position and caption, and the
 * newest point always wears the amber tally dot.
 */
import { useState } from 'preact/hooks';
import type { ComponentChildren, JSX } from 'preact';
import { ChartColumn, Table } from 'lucide-preact';
import type { MomentumPoint } from '../../progress';
import type { RangePoint } from './dashboard-model';
import { formatDayKey } from './format';

// ---------------------------------------------------------------- the table alternative

export interface ChartTableData {
  /** Read by screen readers only. */
  caption: string;
  columns: readonly string[];
  /** The first cell of a row is its header. */
  rows: ReadonlyArray<readonly string[]>;
}

function ChartTable(props: { data: ChartTableData }): JSX.Element {
  const { caption, columns, rows } = props.data;
  return (
    <div class="pl-dash-table-wrap">
      <table class="pl-dash-table pl-tabular">
        <caption class="pl-visually-hidden">{caption}</caption>
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c} scope="col">
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i}>
              {row.map((cell, j) =>
                j === 0 ? (
                  <th key={j} scope="row">
                    {cell}
                  </th>
                ) : (
                  <td key={j}>{cell}</td>
                ),
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** A chart with its "Show as table" toggle: one tap swaps the picture for the numbers behind it. */
export function ChartFrame(props: { chart: ComponentChildren; table: ChartTableData; class?: string }): JSX.Element {
  const [asTable, setAsTable] = useState(false);
  const ToggleIcon = asTable ? ChartColumn : Table;
  return (
    <div class={['pl-dash-chart', props.class ?? ''].filter(Boolean).join(' ')}>
      <div class="pl-dash-chart__view">{asTable ? <ChartTable data={props.table} /> : props.chart}</div>
      <button type="button" class="pl-btn pl-btn--ghost pl-dash-toggle" onClick={() => setAsTable(!asTable)}>
        <ToggleIcon size={20} strokeWidth={2} aria-hidden="true" />
        {asTable ? 'Show chart' : 'Show as table'}
      </button>
    </div>
  );
}

// ---------------------------------------------------------------- momentum: 30 daily bars

const MOMENTUM_W = 300;
const MOMENTUM_H = 76;

/** One bar a day for the last 30 days: solid on a day you sang, hollow on a rest day, with the tally dot on today. */
export function MomentumBars(props: { slots: ReadonlyArray<MomentumPoint | null>; label: string }): JSX.Element {
  const { slots, label } = props;
  const n = Math.max(1, slots.length);
  const gap = 3;
  const bar = (MOMENTUM_W - gap * (n - 1)) / n;
  const base = MOMENTUM_H - 3;
  const room = MOMENTUM_H - 18;
  const heightOf = (p: MomentumPoint): number => Math.max(2, (Math.min(100, Math.max(0, p.momentum)) / 100) * room);
  const last = slots.length > 0 ? slots[slots.length - 1] : null;
  return (
    <svg class="pl-dash-bars" viewBox={`0 0 ${MOMENTUM_W} ${MOMENTUM_H}`} role="img" aria-label={label} focusable="false">
      <line class="pl-dash-baseline" x1={0} x2={MOMENTUM_W} y1={base + 1.5} y2={base + 1.5} />
      {slots.map((slot, i) => {
        const x = i * (bar + gap);
        if (!slot) return <rect key={i} class="pl-dash-bar--none" x={x} y={base - 2} width={bar} height={2} rx={1} />;
        const h = heightOf(slot);
        return (
          <rect
            key={i}
            class={slot.minutes > 0 ? 'pl-dash-bar--sung' : 'pl-dash-bar--rest'}
            x={x}
            y={base - h}
            width={bar}
            height={h}
            rx={1.5}
          />
        );
      })}
      {last ? <circle class="pl-dash-today" cx={(slots.length - 1) * (bar + gap) + bar / 2} cy={base - heightOf(last) - 6} r={3} /> : null}
    </svg>
  );
}

// ---------------------------------------------------------------- practice minutes: 14 days in two weeks

const PRACTICE_W = 300;
const PRACTICE_H = 64;

/** Fourteen daily bars in two groups of seven (the week before, then the last 7 days), on one shared scale. */
export function PracticeBars(props: { days: ReadonlyArray<{ dayKey: string; minutes: number }>; label: string }): JSX.Element {
  const { days, label } = props;
  const n = Math.max(1, days.length);
  const half = Math.floor(n / 2);
  const gap = 4;
  const groupGap = 14;
  const bar = (PRACTICE_W - gap * (n - 2) - groupGap) / n;
  const base = PRACTICE_H - 3;
  const room = PRACTICE_H - 8;
  const top = Math.max(10, ...days.map((d) => d.minutes));
  return (
    <svg class="pl-dash-bars" viewBox={`0 0 ${PRACTICE_W} ${PRACTICE_H}`} role="img" aria-label={label} focusable="false">
      <line class="pl-dash-baseline" x1={0} x2={PRACTICE_W} y1={base + 1.5} y2={base + 1.5} />
      {days.map((d, i) => {
        const x = i * (bar + gap) + (i >= half ? groupGap - gap : 0);
        const h = d.minutes > 0 ? Math.max(2, (d.minutes / top) * room) : 2;
        const cls = d.minutes > 0 ? (i >= half ? 'pl-dash-pbar--recent' : 'pl-dash-pbar--before') : 'pl-dash-pbar--none';
        return <rect key={d.dayKey} class={cls} x={x} y={base - h} width={bar} height={h} rx={1.5} />;
      })}
    </svg>
  );
}

// ---------------------------------------------------------------- a skill's 30-day sparkline

/** A 120x32 sparkline (DESIGN.md §13.10): x and y are 0..1, y from the top (best) down. The last point wears the tally dot. */
export function Sparkline(props: { points: ReadonlyArray<{ x: number; y: number }>; width?: number; height?: number }): JSX.Element {
  const { points, width = 120, height = 32 } = props;
  const pad = 4;
  const px = (x: number): number => pad + x * (width - 2 * pad);
  const py = (y: number): number => pad + y * (height - 2 * pad);
  const last = points.length > 0 ? points[points.length - 1] : null;
  return (
    <svg class="pl-dash-spark" width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true" focusable="false">
      {points.length === 0 ? <line class="pl-dash-spark__empty" x1={pad} x2={width - pad} y1={height / 2} y2={height / 2} /> : null}
      {points.length > 1 ? <polyline class="pl-dash-spark__line" points={points.map((p) => `${px(p.x).toFixed(1)},${py(p.y).toFixed(1)}`).join(' ')} /> : null}
      {last ? <circle class="pl-dash-spark__dot" cx={px(last.x)} cy={py(last.y)} r={3} /> : null}
    </svg>
  );
}

// ---------------------------------------------------------------- range over time

const RANGE_W = 300;
const RANGE_H = 128;

/** The Range finder's measured span (semitones) by date: a line through the days it was measured. */
export function RangeChart(props: { points: ReadonlyArray<RangePoint>; label: string }): JSX.Element {
  const { points, label } = props;
  const left = 28;
  const right = 10;
  const top = 10;
  const bottom = 8;
  const spans = points.map((p) => p.span);
  const lo = Math.max(0, Math.floor((Math.min(...spans) - 1) / 4) * 4);
  const hi = Math.max(lo + 8, Math.ceil((Math.max(...spans) + 1) / 4) * 4);
  const ticks: number[] = [];
  for (let t = lo; t <= hi; t += 4) ticks.push(t);
  const y = (v: number): number => top + (1 - (v - lo) / (hi - lo)) * (RANGE_H - top - bottom);
  const d0 = points[0].dayIndex;
  const d1 = points[points.length - 1].dayIndex;
  const x = (day: number): number => (d1 === d0 ? left + (RANGE_W - left - right) / 2 : left + ((day - d0) / (d1 - d0)) * (RANGE_W - left - right));
  const last = points[points.length - 1];
  return (
    <svg class="pl-dash-range" viewBox={`0 0 ${RANGE_W} ${RANGE_H}`} role="img" aria-label={label} focusable="false">
      {ticks.map((t) => (
        <g key={t}>
          <line class="pl-dash-grid" x1={left} x2={RANGE_W - right} y1={y(t)} y2={y(t)} />
          <text class="pl-dash-tick" x={left - 6} y={y(t) + 4} text-anchor="end">
            {t}
          </text>
        </g>
      ))}
      {points.length > 1 ? <polyline class="pl-dash-range__line" points={points.map((p) => `${x(p.dayIndex).toFixed(1)},${y(p.span).toFixed(1)}`).join(' ')} /> : null}
      {points.map((p) => (
        <circle key={p.dayIndex} class={p === last ? 'pl-dash-range__dot pl-dash-range__dot--now' : 'pl-dash-range__dot'} cx={x(p.dayIndex)} cy={y(p.span)} r={p === last ? 4 : 3} />
      ))}
    </svg>
  );
}

/** The two dates under a time chart, left and right. */
export function DateAxis(props: { from: string; to: string }): JSX.Element {
  return (
    <div class="pl-dash-axis">
      <span>{formatDayKey(props.from)}</span>
      <span>{formatDayKey(props.to)}</span>
    </div>
  );
}
