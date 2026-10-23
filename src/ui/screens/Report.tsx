/**
 * Report: the take, from the runner's last outcome (docs/DESIGN.md §13.5). The verdict as a glyph and words, the score
 * ring counting up (and, after a pass, the three tally lights in sequence), what the take unlocked, the metric tiles,
 * the replay of the trace against the targets, the coaching (CoachCard: where it slipped, marked on the replay from its
 * spot chips, with more help the more misses in a row) and playback of the take. Its next steps come from
 * afterTakeActions and open with replace, so Back from the next screen skips the report. Nothing here is colour-only.
 * A task of the voice check-up is measured, never graded: its plain task title, a calm verdict ("Sung", or why it
 * measured nothing) and no score ring.
 */
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { JSX } from 'preact';
import { MicOff } from 'lucide-preact';
import { back, previousRoute, replace, sameRoute } from '../../router';
import { CONFIG } from '../../config';
import { isTaskMeasured } from '../../checkup/summary';
import { coachTake, tipOnly } from '../../coaching/coach';
import type { CoachMove } from '../../coaching/types';
import { canPassAtTempo, rangeFromMeasurement } from '../../exercises';
import { finishCheckup } from '../../runtime/checkup';
import { afterTakeActions } from '../../runtime/flow';
import { lastOutcome } from '../../runtime/runner';
import type { AfterTakeAction, ExerciseRunner, TakeOutcome } from '../../runtime/types';
import { finishWorkout } from '../../runtime/workout';
import { activeProfile, attemptLog } from '../../state/session';
import { settings } from '../../state/settings';
import { AppBar } from '../components/AppBar';
import { Banner } from '../components/Banner';
import { CoachCard, hasSlowDemo } from '../practice/CoachCard';
import { PlaybackControls } from '../practice/PlaybackControls';
import { RangeCard } from '../practice/RangeCard';
import { ReportBar } from '../practice/ReportBar';
import { singTitle } from '../practice/copy';
import { MetricTiles, VerdictLine, notJudgedLine, unmeasuredLine, type UnmeasuredReason, type Verdict } from '../practice/ReportParts';
import { prefersReducedMotion } from '../practice/motion';
import { tryCreateRunner } from '../practice/runner-handle';
import { ScoreReveal } from '../practice/ScoreReveal';
import { SendToClaudeSheet } from '../practice/SendToClaudeSheet';
import { TraceReplay } from '../practice/TraceReplay';
import { Unavailable } from '../practice/Unavailable';
import { UnlockedStrip } from '../practice/UnlockedStrip';

interface Judgement {
  kind: Verdict;
  word: string;
  /** The take passed the level: the one celebratory moment, and the unlock strip. */
  celebrate: boolean;
}

/** A warm-up or cool-down of the daily workout: completion-based, it carries no level and no tally. */
function isRoutineTake(outcome: TakeOutcome): boolean {
  return outcome.prepared.target.kind === 'workout' && outcome.prepared.level === null;
}

/** The Range finder measures the voice rather than grading it: its report leads with the range, not a score. */
function isRangeFinder(outcome: TakeOutcome): boolean {
  return outcome.prepared.def.kind === 'range-finder';
}

/** A task of the voice check-up: a check-up, not a test, so its report gives no score and no grade. */
function isCheckupTask(outcome: TakeOutcome): boolean {
  return outcome.prepared.target.kind === 'checkup';
}

/**
 * Why a check-up task's take measured nothing (silent, stopped early, or not all of it heard: checkup/summary.ts reads
 * it the same way), or null when it measured something. A folded take is said as for any other take.
 */
function unmeasuredReason(outcome: TakeOutcome): UnmeasuredReason | null {
  const { prepared, evaluation, analysis, attempt } = outcome;
  if (prepared.target.kind !== 'checkup' || evaluation.notJudged === 'folded') return null;
  if (analysis.tipContext.noVoice) return 'silent';
  if (evaluation.notJudged === 'stopped') return 'stopped';
  return isTaskMeasured(prepared.checkup?.taskIndex ?? prepared.target.taskIndex, attempt) ? null : 'quiet';
}

/**
 * True when this take can light a level's tally lights (progress/engine.ts): a level, workout-level or record take at the
 * level's pass tempo. An audition test, a check-up task, a routine and a lower rung of a tempo ladder light none.
 */
function showsTally(outcome: TakeOutcome): boolean {
  const { prepared } = outcome;
  if (prepared.target.kind === 'audition' || prepared.target.kind === 'checkup' || prepared.level === null) return false;
  return canPassAtTempo(prepared.def, prepared.bpm);
}

/**
 * A check-up task's verdict, never a grade: "Sung" for a take that measured its task (a miss is no failure: the check-up
 * goes on and its results say how it went), "Passed" for a test that passed (it can open levels, as in the audition),
 * "Range saved", and for a take that measured nothing "Nothing came through" or "Not measured" (the report offers it again).
 */
function judgeCheckupTask(outcome: TakeOutcome): Judgement {
  const { evaluation, attempt } = outcome;
  if (evaluation.notJudged === 'folded') return { kind: 'not-judged', word: 'Not judged', celebrate: false };
  const unmeasured = unmeasuredReason(outcome);
  if (unmeasured === 'silent') return { kind: 'not-yet', word: 'Nothing came through', celebrate: false };
  if (unmeasured) return { kind: 'not-judged', word: 'Not measured', celebrate: false };
  if (attempt.passed) return { kind: 'passed', word: isRangeFinder(outcome) && outcome.rangeSaved ? 'Range saved' : 'Passed', celebrate: true };
  return { kind: 'done', word: 'Sung', celebrate: false };
}

/**
 * How the take went. The attempt is the log's truth (a lower rung of a tempo ladder is practice, never a level pass), the
 * evaluation is how the take did against the pass rule at the tempo it was sung: a rung can be passed without the level.
 * A take stopped part way was not judged; a routine is completion (Done), never a pass with a celebration; a check-up
 * task is measured, never graded (judgeCheckupTask).
 */
function judge(outcome: TakeOutcome): Judgement {
  const { evaluation, attempt, prepared, analysis } = outcome;
  if (isCheckupTask(outcome)) return judgeCheckupTask(outcome);
  if (evaluation.notJudged) return { kind: 'not-judged', word: 'Not judged', celebrate: false };
  if (isRoutineTake(outcome)) {
    if (analysis.tipContext.noVoice) return { kind: 'not-yet', word: 'Nothing came through', celebrate: false };
    if (evaluation.unsung) return { kind: 'not-yet', word: 'Not finished', celebrate: false };
    return { kind: 'done', word: 'Done', celebrate: false };
  }
  // "Range saved" only when it was: a pass whose range would not save says so in its banner, and is a plain pass.
  if (attempt.passed) return { kind: 'passed', word: isRangeFinder(outcome) && outcome.rangeSaved ? 'Range saved' : 'Passed', celebrate: true };
  if (evaluation.passed) return { kind: 'passed', word: `Passed at ${prepared.bpm} bpm`, celebrate: false };
  return { kind: 'not-yet', word: 'Not yet', celebrate: false };
}

/**
 * What was sung, in a line: "Sustain I", a check-up task by its plain title ("Slide up and down", as the Sing screen named
 * it, never the audition's exercise title), or for a ladder "Run 3 · sung at 72 bpm", with the tempo the level passes at
 * when lower.
 */
function captionOf(outcome: TakeOutcome): string {
  const { prepared } = outcome;
  if (isRangeFinder(outcome) && outcome.attempt.passed && outcome.rangeSaved) return 'Every exercise now fits your voice.';
  if (isCheckupTask(outcome)) return singTitle(prepared);
  const name = prepared.level && prepared.level.kind !== 'boss' ? prepared.level.title : prepared.def.title;
  if (!prepared.ladder) return name;
  const sung = `${name} · sung at ${prepared.bpm} bpm`;
  return prepared.bpm < prepared.def.tempoBpm ? `${sung} · the level passes at ${prepared.def.tempoBpm} bpm` : sung;
}

export function Report(): JSX.Element {
  const outcome = lastOutcome.value;
  if (!outcome) return <Unavailable title="Take report" message="There's no take to show yet. Sing one from a level." />;
  return <ReportView key={outcome.id} outcome={outcome} />;
}

function ReportView(props: { outcome: TakeOutcome }): JSX.Element {
  const { outcome } = props;
  const { prepared, analysis, take, evaluation } = outcome;
  const def = prepared.def;
  const verdict = judge(outcome);
  const checkupTask = isCheckupTask(outcome);
  const unmeasured = unmeasuredReason(outcome);
  const reasonLine = unmeasured ? unmeasuredLine(unmeasured) : evaluation.notJudged ? notJudgedLine(evaluation.notJudged, prepared.target.kind === 'audition') : null;
  const notation = settings.value.notation;
  const actions = useMemo(() => afterTakeActions(outcome), [outcome]);
  const runs = analysis.details.runs;
  const runNotes = useMemo(() => runs.flatMap((run) => run.notes), [runs]);
  const climbed = outcome.nextBpm !== null && outcome.nextBpm > prepared.bpm;
  const savedRange = outcome.rangeSaved
    ? (activeProfile.value?.range ??
      rangeFromMeasurement(analysis.details.range?.lowestMidi ?? null, analysis.details.range?.highestMidi ?? null, outcome.attempt.createdAt))
    : null;

  // The coaching: this take against the log it was written into (the session's, which already holds it). Should it ever
  // fail, the take's own tip still shows: the report never goes blank over its coaching.
  const log = attemptLog.value;
  const vibratoStyle = settings.value.vibratoStyle;
  const coaching = useMemo(() => {
    try {
      return coachTake(outcome, log, { notation, vibratoStyle });
    } catch {
      return tipOnly(outcome.tip, evaluation.passed);
    }
  }, [outcome, log, notation, vibratoStyle, evaluation.passed]);
  const [spot, setSpot] = useState<number | null>(null);
  const mark = spot !== null ? (coaching.problem.spots[spot] ?? null) : null;
  const replayRef = useRef<HTMLDivElement>(null);
  const selectSpot = (index: number | null): void => {
    setSpot(index);
    // The replay sits above the card: bring the marked moment into view.
    if (index !== null) replayRef.current?.scrollIntoView?.({ block: 'nearest', behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
  };

  // "Listen slowly" plays the level's demo again. Its runner is made on the first tap (inside the gesture, for iOS
  // audio) and disposed on leaving; an audition test or a routine has no level to play.
  const listenRef = useRef<ExerciseRunner | null>(null);
  const [listener, setListener] = useState<ExerciseRunner | null>(null);
  const [listenFailure, setListenFailure] = useState<string | null>(null);
  useEffect(() => () => listenRef.current?.dispose(), []);
  const listenLevel = prepared.level;
  const handleListen = (): void => {
    if (!listenLevel) return;
    let current = listenRef.current;
    if (!current) {
      const handle = tryCreateRunner({ kind: 'level', levelId: listenLevel.id });
      if (!handle.runner) {
        setListenFailure(handle.failure);
        return;
      }
      current = handle.runner;
      listenRef.current = current;
      setListener(current);
    }
    current.listen();
  };
  const listenError = listenFailure ?? listener?.error.value?.message ?? null;
  const [sendOpen, setSendOpen] = useState(false);
  const onMove = (move: CoachMove): void => {
    if (move.kind === 'practise-level') replace('level', { levelId: move.levelId });
    else if (move.kind === 'send-to-claude') setSendOpen(true);
  };

  const act = (action: AfterTakeAction): void => {
    // "Finish workout" ends the workout first, so the Workout screen opens on its summary (finishWorkout is idempotent)
    // rather than on the list of items, where the singer would have to end it a second time. "See your results" ends the
    // check-up the same way (finishCheckup: the last task's take usually has already), so its screen opens on the results.
    if (action.kind === 'finish-workout') finishWorkout();
    if (action.kind === 'checkup-results') finishCheckup();
    // "Back to level" / "Finish workout" / "See your results" when that very screen sits right beneath the report (the
    // take was started from it): go back to it. Replacing the report with it would stack a second copy, and the next
    // Back would seem to do nothing. Every other action replaces the report (a new entry: the audition's "See your
    // placement" relies on that).
    const beneath = previousRoute.peek();
    const returns = action.kind === 'level' || action.kind === 'finish-workout' || action.kind === 'checkup-results';
    if (returns && beneath && sameRoute(beneath, action.route)) {
      back();
      return;
    }
    replace(action.route.name, action.route.params);
  };

  // The verdict is the news: move focus to it when the report opens (the Sing screen it replaced had the focus), so a
  // screen reader reads it out. A live region created together with its message is often skipped.
  const mainRef = useRef<HTMLElement>(null);
  useEffect(() => {
    mainRef.current?.querySelector<HTMLElement>('[data-testid="verdict"]')?.focus({ preventScroll: true });
  }, []);

  return (
    <div class="pl-screen pl-report" data-testid="report-screen">
      <AppBar title="Take report" onBack={() => back()} />

      <div class="pl-scroll">
        <main class="pl-page" ref={mainRef}>
          <VerdictLine
            verdict={verdict.kind}
            word={verdict.word}
            caption={captionOf(outcome)}
            ladderLine={climbed ? `Next take at ${outcome.nextBpm} bpm` : null}
            reasonLine={reasonLine}
          />

          {/* No score ring for the Range finder (it measures) or a check-up task (a check-up, not a test). */}
          {isRangeFinder(outcome) || checkupTask ? null : (
            <ScoreReveal
              score={evaluation.score}
              tally={outcome.attempt.mastery}
              showTally={showsTally(outcome)}
              celebrate={verdict.celebrate}
              tone={verdict.kind === 'passed' ? 'accent' : verdict.kind === 'not-judged' ? 'muted' : 'neutral'}
            />
          )}

          {outcome.saveError ? <Banner kind="warn" message={outcome.saveError} /> : null}
          {savedRange ? <RangeCard range={savedRange} notation={notation} /> : null}
          {verdict.celebrate ? <UnlockedStrip events={outcome.unlocked} ownLevelId={prepared.level?.id ?? null} /> : null}
          {/* A saved range already says what the Range finder measured; its tile is for a take that fell short. */}
          {verdict.kind !== 'not-judged' && !savedRange ? <MetricTiles tiles={outcome.tiles} /> : null}

          <div ref={replayRef} class="pl-report__replay">
            <TraceReplay
              notes={prepared.realized.notes}
              totalSec={prepared.realized.totalSec}
              toleranceCents={CONFIG.tolerance[def.tolerance]}
              track={take.track}
              cracks={analysis.details.cracks}
              runs={runs}
              notation={notation}
              mark={mark}
            />
          </div>

          <CoachCard
            coaching={coaching}
            selectedSpot={spot}
            onSelectSpot={selectSpot}
            listen={listenLevel ? { slow: hasSlowDemo(def), playing: listener?.phase.value === 'listening', onClick: handleListen } : null}
            onMove={onMove}
          />
          {listenError ? <Banner kind="error" message={listenError} /> : null}

          {take.audio ? (
            <PlaybackControls audio={take.audio} targetNotes={runNotes} timbre={def.demo.timbre} gain={settings.value.referenceVolume} />
          ) : (
            <p class="pl-body-s pl-muted pl-report__no-audio">
              <MicOff size={16} strokeWidth={2} aria-hidden="true" />
              {settings.value.keepTakeAudio ? "This take's audio wasn't captured." : 'Take audio is off. Turn on “Keep take audio” in Settings to hear takes back.'}
            </p>
          )}
        </main>
      </div>

      <ReportBar actions={actions} onAct={act} />
      <SendToClaudeSheet open={sendOpen} onClose={() => setSendOpen(false)} exerciseId={def.id} />
    </div>
  );
}
