/**
 * The progress dashboard's sections (DESIGN.md §13.10). Each takes plain data from dashboard-model.ts and draws
 * it; nothing here reads a signal or the clock. Every chart sits in a ChartFrame, so it always has its table.
 */
import { useState } from 'preact/hooks';
import type { JSX } from 'preact';
import { ArrowDown, ArrowUp, ChevronDown, ChevronRight, Minus } from 'lucide-preact';
import { METRIC_INFO, WORLDS, formatMetric } from '../../exercises';
import { noteName, type Notation } from '../../core/music';
import { navigate } from '../../router';
import type { VocalRange } from '../../storage/schema';
import { Locked } from '../components/Locked';
import { TallyLights } from '../components/TallyLights';
import {
  completionText,
  type BestRow,
  type MomentumView,
  type PracticeWeeks,
  type RangePoint,
  type WorldCompletion,
} from './dashboard-model';
import { ChartFrame, DateAxis, MomentumBars, PracticeBars, RangeChart, Sparkline } from './charts';
import { formatDate, formatDayKey, formatMinutes, plural } from './format';
import { isLowerBetter, sparkCoords, type SkillTrend } from './skills';

function Heading(props: { id: string; children: string }): JSX.Element {
  return (
    <h2 class="pl-label pl-dash-heading" id={props.id}>
      {props.children}
    </h2>
  );
}

/** A change, as a glyph plus words (never colour): the arrow says which way, the sentence says how much and against when. */
function Change(props: { delta: number; unit: string; against: string }): JSX.Element {
  const { delta, unit, against } = props;
  const Glyph = delta > 0 ? ArrowUp : delta < 0 ? ArrowDown : Minus;
  const words = delta > 0 ? `Up ${delta}${unit} from ${against}` : delta < 0 ? `Down ${Math.abs(delta)}${unit} from ${against}` : `Same as ${against}`;
  return (
    <span class="pl-dash-change pl-body-s pl-muted pl-tabular">
      <Glyph size={16} strokeWidth={2} aria-hidden="true" />
      {words}
    </span>
  );
}

// ---------------------------------------------------------------- momentum

export function MomentumCard(props: { view: MomentumView }): JSX.Element {
  const { view } = props;
  const value = Math.round(view.value);
  const known = view.slots.filter((s): s is NonNullable<typeof s> => s !== null);
  const label = `Momentum over the last 30 days. Today ${value} out of 100.`;
  const rows = [...known].reverse().map((p) => [formatDayKey(p.day), String(Math.round(p.momentum)), p.minutes > 0 ? formatMinutes(p.minutes) : 'Rest day']);
  return (
    <section class="pl-card pl-dash-card" aria-labelledby="dash-momentum" data-testid="dash-momentum">
      <Heading id="dash-momentum">Momentum</Heading>
      <div class="pl-dash-momentum__head">
        <span class="pl-readout-l pl-tabular" data-testid="momentum-value">
          {value}
        </span>
        {view.deltaWeek !== null ? <Change delta={view.deltaWeek} unit="" against="a week ago" /> : null}
      </div>
      <p class="pl-body-s pl-muted pl-prose">
        {known.length === 0 ? 'Momentum starts building with your first sung level.' : 'Rest days keep it. It never drops to zero.'}
      </p>
      <ChartFrame
        chart={
          <>
            <MomentumBars slots={view.slots} label={label} />
            <ul class="pl-dash-legend" aria-label="How to read the bars">
              <li>
                <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
                  <rect class="pl-dash-bar--sung" x="1" y="1" width="10" height="10" rx="2" />
                </svg>
                A day you sang
              </li>
              <li>
                <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
                  <rect class="pl-dash-bar--rest" x="1" y="1" width="10" height="10" rx="2" />
                </svg>
                A rest day
              </li>
            </ul>
          </>
        }
        table={{ caption: 'Momentum by day, newest first', columns: ['Day', 'Momentum', 'Sung'], rows }}
      />
    </section>
  );
}

// ---------------------------------------------------------------- level map completion

export function LevelsCard(props: { completion: readonly WorldCompletion[]; lockedHint: string | null }): JSX.Element {
  const { completion, lockedHint } = props;
  return (
    <section class="pl-card pl-dash-card" aria-labelledby="dash-levels" data-testid="dash-levels">
      <Heading id="dash-levels">Level map</Heading>
      <ul class="pl-dash-worlds">
        {completion.map((c) => {
          const number = String(WORLDS.findIndex((w) => w.id === c.world.id) + 1).padStart(2, '0');
          const text = completionText(c);
          return (
            <li key={c.world.id}>
              <button
                type="button"
                class="pl-dash-world"
                data-world={c.world.id}
                style={{ '--accent': `var(${c.world.accent})` }}
                aria-label={`${c.world.title}: ${text}. Open on the world map.`}
                onClick={() => navigate('map', { worldId: c.world.id })}
              >
                <span class="pl-dash-world__head">
                  <span class="pl-dash-world__num pl-tabular" aria-hidden="true">
                    {number}
                  </span>
                  <span class="pl-dash-world__name">{c.world.title}</span>
                  <ChevronRight class="pl-dash-world__chev" size={20} aria-hidden="true" />
                </span>
                <span class="pl-body-s pl-muted pl-tabular">{text}</span>
                {/* The bar repeats what the button's own label says, so it is hidden from assistive technology. */}
                <span class="pl-dash-meter" aria-hidden="true">
                  <span class="pl-dash-meter__fill" style={{ width: `${(c.passed / Math.max(1, c.total)) * 100}%` }} />
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      {lockedHint ? <Locked compact hint={lockedHint} /> : null}
    </section>
  );
}

// ---------------------------------------------------------------- skills

function SkillRow(props: { trend: SkillTrend; todayIndex: number }): JSX.Element {
  const { trend, todayIndex } = props;
  const { skill, points, latest } = trend;
  const [open, setOpen] = useState(false);
  const info = METRIC_INFO[skill.metric];
  const latestText = latest ? formatMetric(skill.metric, latest.value) : 'No takes yet';
  const caption = latest ? `${info.label}${isLowerBetter(skill) ? ', lower is better' : ''}` : 'No takes in 30 days';
  const panelId = `dash-skill-${skill.id}`;
  const recent = points.slice(-10).reverse();
  return (
    <li class="pl-dash-skill">
      <button
        type="button"
        class="pl-dash-skill__head"
        aria-expanded={open}
        aria-controls={panelId}
        aria-label={`${skill.label}: ${latest ? `${info.label} ${latestText}` : 'no takes in the last 30 days'}. ${open ? 'Hide the table' : 'Show as table'}.`}
        onClick={() => setOpen(!open)}
      >
        <span class="pl-dash-skill__name">
          <span class="pl-dash-skill__label">{skill.label}</span>
          <span class="pl-body-s pl-lo">{caption}</span>
        </span>
        <Sparkline points={sparkCoords(trend, todayIndex)} />
        <span class="pl-data pl-tabular pl-dash-skill__value">{latest ? latestText : '––'}</span>
        <ChevronDown class={`pl-dash-skill__chev${open ? ' pl-dash-skill__chev--open' : ''}`} size={20} aria-hidden="true" />
      </button>
      <div id={panelId} class="pl-dash-skill__panel" hidden={!open}>
        {open && recent.length === 0 ? (
          <p class="pl-body-s pl-muted">Nothing measured in the last 30 days. Sing a level that trains this skill to start the line.</p>
        ) : null}
        {open && recent.length > 0 ? (
          <table class="pl-dash-table pl-tabular">
            <caption class="pl-visually-hidden">{`${skill.label}: the last ${plural(recent.length, 'day')} measured, newest first`}</caption>
            <thead>
              <tr>
                <th scope="col">Day</th>
                <th scope="col">{info.label}</th>
                <th scope="col">Takes</th>
              </tr>
            </thead>
            <tbody>
              {recent.map((p) => (
                <tr key={p.dayKey}>
                  <th scope="row">{formatDayKey(p.dayKey)}</th>
                  <td>{formatMetric(skill.metric, p.value)}</td>
                  <td>{p.takes}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
      </div>
    </li>
  );
}

export function SkillsCard(props: { trends: readonly SkillTrend[]; todayIndex: number }): JSX.Element {
  return (
    <section class="pl-card pl-dash-card" aria-labelledby="dash-skills" data-testid="dash-skills">
      <Heading id="dash-skills">Skills</Heading>
      <p class="pl-body-s pl-muted pl-prose">The last 30 days. A rising line always means better. Tap a skill for its last 10 values.</p>
      <ul class="pl-dash-skills">
        {props.trends.map((t) => (
          <SkillRow key={t.skill.id} trend={t} todayIndex={props.todayIndex} />
        ))}
      </ul>
    </section>
  );
}

// ---------------------------------------------------------------- range

function noteRange(low: number, high: number, notation: Notation): string {
  return `${noteName(low, notation)} to ${noteName(high, notation)}`;
}

export function RangeCard(props: { points: readonly RangePoint[]; range: VocalRange | null; notation: Notation }): JSX.Element {
  const { points, range, notation } = props;
  const first = points[0];
  const last = points[points.length - 1];
  const label = `Range span over time: ${points.map((p) => `${p.span} semitones on ${formatDayKey(p.dayKey)}`).join(', ')}.`;
  return (
    <section class="pl-card pl-dash-card" aria-labelledby="dash-range" data-testid="dash-range">
      <Heading id="dash-range">Range</Heading>
      {range ? (
        <dl class="pl-dash-range-now pl-tabular">
          <div>
            <dt class="pl-label">Comfortable</dt>
            <dd class="pl-display-m">{noteRange(range.comfortable.low, range.comfortable.high, notation)}</dd>
          </div>
          <div>
            <dt class="pl-label">Extended</dt>
            <dd class="pl-display-m">{noteRange(range.extended.low, range.extended.high, notation)}</dd>
          </div>
        </dl>
      ) : (
        <p class="pl-body-s pl-muted">Your range is not measured yet. The Range finder saves it.</p>
      )}
      {range ? <p class="pl-body-s pl-lo">Measured {formatDate(range.measuredAt)}</p> : null}
      {points.length > 0 ? (
        <>
          <p class="pl-body-s pl-muted pl-prose">How wide the notes you held cleanly reached each time the Range finder was sung, in semitones.</p>
          <ChartFrame
            chart={
              <>
                <RangeChart points={points} label={label} />
                <DateAxis from={first.dayKey} to={last.dayKey} />
              </>
            }
            table={{
              caption: 'Range finder span by day, newest first',
              columns: ['Day', 'Span'],
              rows: [...points].reverse().map((p) => [formatDayKey(p.dayKey), `${Math.round(p.span)} semitones`]),
            }}
          />
        </>
      ) : null}
    </section>
  );
}

// ---------------------------------------------------------------- personal bests

const BESTS_SHOWN = 6;

export function BestsCard(props: { bests: readonly BestRow[] | null; lockedHint: string }): JSX.Element {
  const { bests, lockedHint } = props;
  const [all, setAll] = useState(false);
  const shown = bests && !all ? bests.slice(0, BESTS_SHOWN) : (bests ?? []);
  return (
    <section class="pl-card pl-dash-card" aria-labelledby="dash-bests" data-testid="dash-bests">
      <Heading id="dash-bests">Personal bests</Heading>
      {bests === null ? (
        <Locked compact hint={lockedHint} />
      ) : bests.length === 0 ? (
        <p class="pl-body-s pl-muted">Pass a level and its best marks land here.</p>
      ) : (
        <>
          <ul class="pl-dash-bests">
            {shown.map((b) => (
              <li key={b.level.id} class="pl-dash-best">
                <span class="pl-dash-best__head">
                  <span class="pl-dash-best__title">{b.level.title}</span>
                  <span class="pl-data pl-tabular">{Math.round(b.bestScore * 100)}%</span>
                </span>
                <span class="pl-dash-best__meta">
                  <span class="pl-body-s pl-muted">
                    {b.world.title} &middot; improved {formatDate(b.latestAt)}
                  </span>
                  <TallyLights lit={b.mastery} />
                </span>
                <span class="pl-body-s pl-lo pl-tabular">{b.metrics.map((m) => `${m.label} ${m.text}`).join(' · ')}</span>
              </li>
            ))}
          </ul>
          {bests.length > BESTS_SHOWN ? (
            <button type="button" class="pl-btn pl-btn--ghost" aria-expanded={all} onClick={() => setAll(!all)}>
              {all ? 'Show fewer' : `Show all ${bests.length}`}
            </button>
          ) : null}
        </>
      )}
    </section>
  );
}

// ---------------------------------------------------------------- practice minutes

export function PracticeCard(props: { weeks: PracticeWeeks }): JSX.Element {
  const { weeks } = props;
  const delta = Math.round(weeks.recent) - Math.round(weeks.before);
  const label = `Minutes sung each day for the last 14 days. Last 7 days ${formatMinutes(weeks.recent)}, the week before ${formatMinutes(weeks.before)}.`;
  return (
    <section class="pl-card pl-dash-card" aria-labelledby="dash-practice" data-testid="dash-practice">
      <Heading id="dash-practice">Practice time</Heading>
      <dl class="pl-dash-weeks pl-tabular">
        <div>
          <dt class="pl-label">Last 7 days</dt>
          <dd class="pl-display-m" data-testid="practice-recent">
            {formatMinutes(weeks.recent)}
          </dd>
        </div>
        <div>
          <dt class="pl-label">Week before</dt>
          <dd class="pl-display-m" data-testid="practice-before">
            {formatMinutes(weeks.before)}
          </dd>
        </div>
      </dl>
      <Change delta={delta} unit=" min" against="the week before" />
      <ChartFrame
        chart={
          <>
            <PracticeBars days={weeks.days} label={label} />
            <div class="pl-dash-axis" aria-hidden="true">
              <span>Week before</span>
              <span>Last 7 days</span>
            </div>
          </>
        }
        table={{
          caption: 'Minutes sung by day, newest first',
          columns: ['Day', 'Minutes'],
          rows: [...weeks.days].reverse().map((d) => [formatDayKey(d.dayKey), d.minutes > 0 ? formatMinutes(d.minutes) : 'Rest day']),
        }}
      />
    </section>
  );
}
