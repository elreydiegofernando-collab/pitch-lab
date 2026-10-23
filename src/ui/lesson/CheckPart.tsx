/**
 * Check, the last part of a lesson (docs/DESIGN.md 13.3): the level's own exercise, whose pass passes the level (and
 * only it can: practice never does). What it asks in plain words, its in-tune zone, how it went so far, and "Last time"
 * after a missed check. Before every practice step is done the check is closed (practice first: lessons/progress.ts
 * isCheckOpen); once they are, the bar's amber button takes it; after a missed check practice leads again, and the check is a quiet
 * "Take the check again" here. A passed lesson shows its best and tally lights. Personal records on
 * the check are shown locked until the lesson is passed and records open (SPEC 11.1: never hidden).
 */
import type { ComponentChildren, JSX } from 'preact';
import { CircleCheck, Trophy } from 'lucide-preact';
import { ladderOf } from '../../exercises/ladder';
import type { ExerciseDef } from '../../exercises/types';
import type { LevelProgress } from '../../progress/types';
import type { TermId } from '../../teach/glossary';
import { Button } from '../components/Button';
import { Locked } from '../components/Locked';
import { TallyLights } from '../components/TallyLights';
import { Term } from '../teach/Term';
import { ZONE_WORDS } from './model';
import { linkTerms } from './terms';

/** "86%" for a 0..1 score. */
function percent(score: number): string {
  return `${Math.round(Math.max(0, Math.min(1, score)) * 100)}%`;
}

/** The in-tune zone chip, in plain words: "In-tune zone: wide", "medium" or "narrow" (never cents). */
export function ZoneChip(props: { tolerance: ExerciseDef['tolerance'] }): JSX.Element {
  return (
    <li class="pl-pchip pl-zone-chip" data-testid="zone-chip">
      <span>
        <Term id="in-tune-zone">In-tune zone</Term>: {ZONE_WORDS[props.tolerance]}
      </span>
    </li>
  );
}

/** The tempo in plain words, never a number: a ladder starts slow and speeds up; a metronome keeps the beat. */
function TempoChip(props: { def: Pick<ExerciseDef, 'tempoBpm' | 'tempoLadder' | 'metronome'> }): JSX.Element | null {
  if (ladderOf(props.def).length > 1) {
    return (
      <li class="pl-pchip pl-pchip--neutral" data-testid="tempo-chip">
        Starts slow, and speeds up each time you pass
      </li>
    );
  }
  if (!props.def.metronome) return null;
  return (
    <li class="pl-pchip pl-pchip--neutral" data-testid="tempo-chip">
      <span>
        A click keeps the <Term id="beat" />
      </span>
    </li>
  );
}

export type RecordMove = { allowed: true; onClick: () => void } | { allowed: false; hint: string };

export interface CheckPartProps {
  def: ExerciseDef;
  /** Every practice step is done (the check is the next move) / the level is passed. */
  ready: boolean;
  passed: boolean;
  /** The latest check missed and practice comes first again (model.ts reviewStep): the check is offered here, quietly. */
  afterMiss?: boolean;
  /** The level in the snapshot: its best score, tally lights and attempts. */
  level: LevelProgress | undefined;
  /** The Range finder measures, it does not grade: the saved range ("C3–A4"), or null before one is saved. */
  measuring: { range: string | null } | null;
  /** "Last time": the coaching of the latest check take, when it missed. */
  lastTime?: ComponentChildren;
  /** Take the check now, before practice is done. */
  onSkip: () => void;
  /** Personal records on the check: the way in, or the line saying what opens it; null for the Range finder (no records). */
  record: RecordMove | null;
  headingId: string;
}

function Status(props: Pick<CheckPartProps, 'passed' | 'level' | 'measuring'>): JSX.Element {
  const { passed, level, measuring } = props;
  if (measuring) {
    return (
      <div class="pl-check__status" data-testid="check-status">
        <span class="pl-label">Your range</span>
        {measuring.range ? (
          <span class="pl-display-m pl-tabular" data-testid="saved-range">
            {measuring.range}
          </span>
        ) : (
          <span class="pl-body pl-muted" data-testid="saved-range">
            Not measured yet
          </span>
        )}
      </div>
    );
  }
  const attempts = level?.attempts ?? 0;
  const best = level && level.bestScore > 0 ? level.bestScore : null;
  if (passed) {
    const byAudition = level?.viaAudition === true && attempts === 0;
    return (
      <div class="pl-check__status pl-check__status--passed" data-testid="check-status">
        <CircleCheck size={22} strokeWidth={2} aria-hidden="true" />
        <span class="pl-data">{byAudition ? 'Passed by audition' : best !== null ? `Passed · best ${percent(best)}` : 'Passed'}</span>
        <TallyLights lit={level?.mastery ?? 0} />
      </div>
    );
  }
  return (
    <div class="pl-check__status" data-testid="check-status">
      <span class="pl-body pl-muted">{best !== null ? `Best so far ${percent(best)}` : attempts > 0 ? 'Not passed yet' : 'Not taken yet'}</span>
    </div>
  );
}

export function CheckPart(props: CheckPartProps): JSX.Element {
  const { def, ready, passed, afterMiss = false, measuring, lastTime, onSkip, record, headingId } = props;
  const seen = new Set<TermId>();
  // The in-tune zone only means something where pitch is judged (the Range finder measures the voice instead).
  const showsZone = def.analyzers.some((a) => a !== 'range');
  return (
    <>
      <h3 class="pl-part__heading" id={headingId}>
        <span class="pl-part__title">Check</span>
      </h3>
      <p class="pl-body pl-prose" data-testid="check-goal">
        {linkTerms(def.goal, seen)}
      </p>
      {def.passPlain ? (
        <p class="pl-body-s pl-prose" data-testid="check-pass">
          <span class="pl-check__lead">To pass: </span>
          {linkTerms(def.passPlain, seen)}
        </p>
      ) : (
        <p class="pl-body-s pl-muted pl-prose">Pass it to finish the lesson.</p>
      )}
      {showsZone || def.metronome || ladderOf(def).length > 1 ? (
        <ul class="pl-level__chips" aria-label="How the check is judged">
          {showsZone ? <ZoneChip tolerance={def.tolerance} /> : null}
          <TempoChip def={def} />
        </ul>
      ) : null}
      <Status passed={passed} level={props.level} measuring={measuring} />
      {lastTime}
      {passed ? null : afterMiss ? (
        <div class="pl-check__skip">
          <Button variant="ghost" onClick={onSkip} data-testid="skip-to-check">
            Take the check again
          </Button>
          <p class="pl-body-s pl-muted pl-prose">Practise the step marked Now first: it trains what the check missed. You can take the check again any time.</p>
        </div>
      ) : ready ? (
        <p class="pl-body-s pl-check__ready" data-testid="check-ready">
          Every practice step is done: you are ready for the check.
        </p>
      ) : measuring ? (
        // The Range finder measures rather than grades: open from the start, practice is a gentle way in (isCheckOpen).
        <div class="pl-check__skip">
          <Button variant="ghost" onClick={onSkip} data-testid="skip-to-check">
            Measure your range now
          </Button>
          <p class="pl-body-s pl-muted pl-prose">Practice first is a gentle start, but you can measure your range any time.</p>
        </div>
      ) : (
        // Practice first, then the check (owner, 2026-10-23: a test alone "doesn't train me to do better"): it opens once
        // every practice step is done. The runner and the route guard enforce it too (lessons/progress.ts isCheckOpen).
        <p class="pl-body-s pl-muted pl-prose" data-testid="check-closed">
          The check opens when every practice step is done.
        </p>
      )}
      {record ? (
        record.allowed ? (
          <Button variant="secondary" icon={Trophy} block onClick={record.onClick} data-testid="chase-record">
            Chase a record
          </Button>
        ) : (
          <Locked title="Chase a record" hint={record.hint} />
        )
      ) : null}
    </>
  );
}
