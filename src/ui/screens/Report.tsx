/**
 * Report: the take, from the runner's last outcome (docs/DESIGN.md §13.5). The verdict as a glyph and words, the score
 * ring counting up (and, after a pass, the three tally lights in sequence), what the take unlocked, the metric tiles,
 * the replay of the trace against the targets, the one coaching tip and playback of the take. Its next steps come from
 * afterTakeActions and open with replace, so Back from the next screen skips the report. Nothing here is colour-only.
 */
import { useMemo } from 'preact/hooks';
import type { JSX } from 'preact';
import { MicOff } from 'lucide-preact';
import { back, replace } from '../../router';
import { CONFIG } from '../../config';
import { rangeFromMeasurement } from '../../exercises';
import { afterTakeActions } from '../../runtime/flow';
import { lastOutcome } from '../../runtime/runner';
import type { AfterTakeAction, TakeOutcome } from '../../runtime/types';
import { activeProfile } from '../../state/session';
import { settings } from '../../state/settings';
import { AppBar } from '../components/AppBar';
import { Banner } from '../components/Banner';
import { PlaybackControls } from '../practice/PlaybackControls';
import { RangeCard } from '../practice/RangeCard';
import { ReportBar } from '../practice/ReportBar';
import { MetricTiles, TipCard, VerdictLine, type Verdict } from '../practice/ReportParts';
import { ScoreReveal } from '../practice/ScoreReveal';
import { TraceReplay } from '../practice/TraceReplay';
import { Unavailable } from '../practice/Unavailable';
import { UnlockedStrip } from '../practice/UnlockedStrip';

interface Judgement {
  kind: Verdict;
  word: string;
  /** The take passed the level: the one celebratory moment, and the unlock strip. */
  celebrate: boolean;
}

/**
 * How the take went. The attempt is the log's truth (a lower rung of a tempo ladder is practice, never a level pass), the
 * evaluation is how the take did against the pass rule at the tempo it was sung: a rung can be passed without the level.
 */
function judge(outcome: TakeOutcome): Judgement {
  const { evaluation, attempt, prepared } = outcome;
  if (evaluation.notJudged) return { kind: 'not-judged', word: 'Not judged', celebrate: false };
  if (attempt.passed) return { kind: 'passed', word: 'Passed', celebrate: true };
  if (evaluation.passed) return { kind: 'passed', word: `Passed at ${prepared.bpm} bpm`, celebrate: false };
  return { kind: 'not-yet', word: 'Not yet', celebrate: false };
}

/** What was sung, in a line: "Sustain I", or for a ladder "Run 3 · sung at 72 bpm", with the tempo the level passes at when lower. */
function captionOf(outcome: TakeOutcome): string {
  const { prepared } = outcome;
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
  const notation = settings.value.notation;
  const actions = useMemo(() => afterTakeActions(outcome), [outcome]);
  const runs = analysis.details.runs;
  const runNotes = useMemo(() => runs.flatMap((run) => run.notes), [runs]);
  const climbed = outcome.nextBpm !== null && outcome.nextBpm > prepared.bpm;
  const savedRange = outcome.rangeSaved
    ? (activeProfile.value?.range ??
      rangeFromMeasurement(analysis.details.range?.lowestMidi ?? null, analysis.details.range?.highestMidi ?? null, outcome.attempt.createdAt))
    : null;

  const act = (action: AfterTakeAction): void => {
    replace(action.route.name, action.route.params);
  };

  return (
    <div class="pl-screen pl-report" data-testid="report-screen">
      <AppBar title="Take report" onBack={() => back()} />

      <div class="pl-scroll">
        <main class="pl-page">
          <VerdictLine verdict={verdict.kind} word={verdict.word} caption={captionOf(outcome)} ladderLine={climbed ? `Next take at ${outcome.nextBpm} bpm` : null} />

          <ScoreReveal
            score={evaluation.score}
            tally={outcome.attempt.mastery}
            celebrate={verdict.celebrate}
            tone={verdict.kind === 'passed' ? 'accent' : verdict.kind === 'not-judged' ? 'muted' : 'neutral'}
          />

          {outcome.saveError ? <Banner kind="warn" message={outcome.saveError} /> : null}
          {savedRange ? <RangeCard range={savedRange} notation={notation} /> : null}
          {verdict.celebrate ? <UnlockedStrip events={outcome.unlocked} ownLevelId={prepared.level?.id ?? null} /> : null}
          {verdict.kind !== 'not-judged' ? <MetricTiles tiles={outcome.tiles} /> : null}

          <TraceReplay
            notes={prepared.realized.notes}
            totalSec={prepared.realized.totalSec}
            toleranceCents={CONFIG.tolerance[def.tolerance]}
            track={take.track}
            cracks={analysis.details.cracks}
            runs={runs}
            notation={notation}
          />

          <TipCard tip={outcome.tip} />

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
    </div>
  );
}
