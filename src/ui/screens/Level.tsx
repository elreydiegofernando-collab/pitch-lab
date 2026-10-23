/**
 * Level: one level before singing (docs/DESIGN.md §13.3). A level with a lesson (src/lessons: Learn, Practise, Check)
 * opens as the lesson screen (src/ui/lesson/LessonScreen.tsx). A level without one (the later worlds, until they are
 * converted) keeps the classic screen below: the goal in a sentence, the pass lines, the tolerance and tempo chips, the
 * best score with its tally lights, then Listen / Sing / More in the thumb zone. A Boss Recital gets a stage header and
 * lists the sections of its one continuous take. A passed level offers "Sing again" for the next tally light and, once
 * Personal records open, "Chase a record"; until then that is shown locked, never hidden. When the latest take of the
 * level missed, "Last time" brings its coaching here, before the next try; More always offers "Send to Claude".
 * Everything here is gated by src/progress: a level that is not open shows its requirement and no way in.
 */
import { useEffect, useRef, useState } from 'preact/hooks';
import type { JSX } from 'preact';
import { Target, Trophy } from 'lucide-preact';
import { back, navigate, route } from '../../router';
import { CONFIG } from '../../config';
import { lastTakeMissed, latestTake, type LastTimeSources } from '../../coaching/last-time';
import type { CoachMove } from '../../coaching/types';
import { METRIC_INFO, WORLDS, formatMetric, getExercise, getLevel, getWorld, passRequirements } from '../../exercises';
import type { MetricKey } from '../../analysis/types';
import type { ExerciseDef, LevelDef, WorldDef } from '../../exercises/types';
import { lessonFor } from '../../lessons';
import { LEVEL_REFS, isLevelOpenable, isRecordAttemptAllowed, levelRequirementHint, recordsForExercise, requirementHint } from '../../progress';
import { paramsForTarget } from '../../runtime/targets';
import type { ExerciseRunner } from '../../runtime/types';
import { activeProfile, appStorage, attemptLog, isUnlocked, snapshot } from '../../state/session';
import { AppBar } from '../components/AppBar';
import { Banner } from '../components/Banner';
import { Button } from '../components/Button';
import { Locked } from '../components/Locked';
import { TallyLights } from '../components/TallyLights';
import { hasSlowDemo } from '../practice/CoachCard';
import { LastTimeCard } from '../practice/LastTimeCard';
import { MoreSheet } from '../practice/MoreSheet';
import { PracticeBar } from '../practice/PracticeBar';
import { SendToClaudeSheet } from '../practice/SendToClaudeSheet';
import { Unavailable } from '../practice/Unavailable';
import { bossChain, levelNumber, percent, tempoLabel, toleranceLabel } from '../practice/copy';
import { rangeLabel } from '../practice/RangeCard';
import { tryCreateRunner } from '../practice/runner-handle';
import { LessonScreen } from '../lesson/LessonScreen';
import { settings } from '../../state/settings';

/** "the Foundations Boss Recital" or "Sustain II": how a level is named in a requirement line. */
function levelName(world: WorldDef | undefined, level: LevelDef): string {
  return level.kind === 'boss' && world ? `the ${world.title} Boss Recital` : level.title;
}

export function Level(): JSX.Element {
  const r = route.value;
  const level = r.name === 'level' ? getLevel(r.params.levelId) : undefined;
  const def = level ? getExercise(level.exerciseId) : undefined;
  if (!level || !def) return <Unavailable title="Level" message="This level isn't in the catalog. Go back to the map and choose another." />;
  const lesson = lessonFor(level.id);
  return lesson ? <LessonScreen key={level.id} level={level} def={def} lesson={lesson} /> : <LevelView key={level.id} level={level} def={def} />;
}

function LevelView(props: { level: LevelDef; def: ExerciseDef }): JSX.Element {
  const { level, def } = props;
  const world = getWorld(level.worldId);
  const snap = snapshot.value;
  const profile = activeProfile.value;
  const progress = snap.levels[level.id];
  const boss = level.kind === 'boss';
  const open = isLevelOpenable(level.id, snap);
  const passed = progress?.status === 'passed';

  // The demo's runner is made on the first Listen. The ref is what the handler trusts (two quick taps must not make two
  // runners); the state only re-renders the button when there is one to follow.
  const runnerRef = useRef<ExerciseRunner | null>(null);
  const [runner, setRunner] = useState<ExerciseRunner | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [moreOpen, setMoreOpen] = useState(false);
  const [sendOpen, setSendOpen] = useState(false);
  useEffect(() => () => runnerRef.current?.dispose(), []);

  const listening = runner?.phase.value === 'listening';
  const runError = runner?.error.value ?? null;

  function handleListen(): void {
    // Straight from the click: the demo needs the AudioContext started inside the gesture.
    let current = runnerRef.current;
    if (!current) {
      const handle = tryCreateRunner({ kind: 'level', levelId: level.id });
      if (!handle.runner) {
        setFailure(handle.failure);
        return;
      }
      current = handle.runner;
      runnerRef.current = current;
      setRunner(current);
    }
    current.listen();
  }

  const openSing = (): void => {
    navigate('sing', paramsForTarget({ kind: 'level', levelId: level.id }));
  };
  const chaseRecord = (): void => {
    navigate('sing', paramsForTarget({ kind: 'record', levelId: level.id }));
  };

  const tempo = tempoLabel(def);
  // The Range finder measures the voice rather than grading it: no tolerance, no score, no tally lights.
  const measuring = level.id === LEVEL_REFS.rangeFinder;
  // The in-tune window only means something where pitch accuracy is judged.
  const showsTolerance = def.analyzers.some((a) => a !== 'range');
  const passLines = def.passPlain ? [def.passPlain] : passRequirements(def).map((line) => line.text);
  const recordAllowed = isUnlocked('records') && isRecordAttemptAllowed(def.id, snap, WORLDS);
  const recordHint = isUnlocked('records') ? `Pass ${levelName(world, level)} to chase personal records on it.` : requirementHint('records');
  const records = passed && isUnlocked('records') ? recordsForExercise(snap, def.id).filter((rec) => rec.metric in METRIC_INFO) : [];
  const noSavedRange = profile !== null && profile.range === null && level.id !== LEVEL_REFS.rangeFinder;
  // "Best" is a score at the level's own tempo (progress/engine.ts): a Runs level sung only on its lower rungs has none yet.
  const ladderOnly = progress !== undefined && progress.attempts > 0 && progress.bestScore === 0 && (def.tempoLadder?.length ?? 0) > 0;
  const attempted = progress !== undefined && progress.attempts > 0 && !ladderOnly;
  const chain = boss ? bossChain(def) : [];

  // "Last time": the latest take of this exercise missed, so its coaching comes here before the next try.
  const log = attemptLog.value;
  const latest = open ? latestTake(def.id, log) : null;
  const lastTime: LastTimeSources | null =
    latest && lastTakeMissed(def, log)
      ? {
          def,
          log,
          profile: profile ?? { range: null, voiceType: 'unknown' },
          takes: appStorage.value?.takes ?? null,
          notation: settings.value.notation,
          vibratoStyle: settings.value.vibratoStyle,
          isLevelPassed: (id) => snap.levels[id]?.status === 'passed',
          now: Date.now(),
        }
      : null;
  const onMove = (move: CoachMove): void => {
    if (move.kind === 'practise-level') navigate('level', { levelId: move.levelId });
    else if (move.kind === 'send-to-claude') setSendOpen(true);
  };

  return (
    <div class="pl-screen pl-level" data-testid="level-screen" style={{ '--level-accent': `var(${world?.accent ?? '--tally'})` }}>
      <AppBar title={world?.title ?? 'Level'} onBack={() => back()} />

      <div class="pl-scroll">
        <main class="pl-page">
          <header class={`pl-level__head${boss ? ' pl-level__head--boss' : ''}`}>
            <p class="pl-label pl-level__label" data-testid="level-label">
              {boss ? (
                <>
                  Boss Recital <span class="pl-level__label-soft">· one continuous take</span>
                </>
              ) : (
                `Level ${levelNumber(world, level)}`
              )}
            </p>
            <h2 class="pl-display-l">{boss ? def.title : level.title}</h2>
            <p class="pl-body pl-prose">{def.goal}</p>
            {!boss && def.steps && def.steps.length > 0 ? (
              <>
                <h3 class="pl-label pl-level__howto">How it goes</h3>
                <ol class="pl-level__chain" aria-label="How it goes, step by step" data-testid="level-steps">
                  {def.steps.map((text, i) => (
                    <li key={text}>
                      <span class="pl-level__step pl-tabular" aria-hidden="true">
                        {i + 1}
                      </span>
                      <span class="pl-prose">{text}</span>
                    </li>
                  ))}
                </ol>
              </>
            ) : null}
            {boss && chain.length > 0 ? (
              <ol class="pl-level__chain" aria-label="The sections of this take, in order">
                {chain.map((cue, i) => (
                  <li key={cue}>
                    <span class="pl-level__step pl-tabular" aria-hidden="true">
                      {i + 1}
                    </span>
                    <span>{cue}</span>
                  </li>
                ))}
              </ol>
            ) : null}
          </header>

          {!open ? <Locked hint={levelRequirementHint(level.id, snap, WORLDS) ?? 'Not available yet.'} /> : null}

          {lastTime && latest ? (
            <LastTimeCard
              sources={lastTime}
              latestId={latest.id}
              listen={{ slow: hasSlowDemo(def), playing: listening, onClick: handleListen }}
              onMove={onMove}
            />
          ) : null}

          {open && noSavedRange ? <Banner kind="info" message="Using a default range until you pass the Range finder." /> : null}
          {failure ? <Banner kind="error" message={failure} /> : null}
          {runError ? <Banner kind="error" message={runError.message} /> : null}

          {open ? (
            <>
              <section class="pl-level__section" aria-label="To pass">
                <h3 class="pl-label">To pass</h3>
                <ul class={`pl-level__pass${def.passPlain ? ' pl-level__pass--plain' : ''}`}>
                  {passLines.map((text) => (
                    <li key={text}>
                      <Target size={18} strokeWidth={2} aria-hidden="true" />
                      <span class={def.passPlain ? 'pl-prose' : 'pl-tabular'}>{text}</span>
                    </li>
                  ))}
                </ul>
              </section>

              {showsTolerance || tempo ? (
                <ul class="pl-level__chips" aria-label="How this level is judged">
                  {showsTolerance ? (
                    <li class="pl-pchip" aria-label={`In tune within plus or minus ${CONFIG.tolerance[def.tolerance]} cents`}>
                      {toleranceLabel(def)}
                    </li>
                  ) : null}
                  {tempo ? <li class="pl-pchip">{tempo}</li> : null}
                </ul>
              ) : null}

              {measuring ? (
                <section class="pl-level__section pl-level__best" aria-label="Your range">
                  <div class="pl-level__best-row">
                    <span class="pl-label">Your range</span>
                    {profile?.range ? (
                      <span class="pl-display-m pl-tabular" data-testid="saved-range">
                        {rangeLabel(profile.range.comfortable.low, profile.range.comfortable.high, settings.value.notation)}
                      </span>
                    ) : (
                      <span class="pl-body pl-muted" data-testid="saved-range">
                        Not measured yet
                      </span>
                    )}
                  </div>
                  <p class="pl-body-s pl-muted pl-prose">
                    {profile?.range
                      ? 'The notes your exercises use. Sing this again any time your voice feels different.'
                      : 'Sing it once, and every exercise will fit your voice.'}
                  </p>
                </section>
              ) : (
              <section class="pl-level__section pl-level__best" aria-label="Your best">
                <div class="pl-level__best-row">
                  <span class="pl-label">Best</span>
                  {attempted ? (
                    <span class="pl-readout-l pl-tabular" data-testid="best-score">
                      {percent(progress.bestScore)}
                    </span>
                  ) : (
                    <span class="pl-body pl-muted" data-testid="best-score">
                      {ladderOnly ? `Not sung at ${def.tempoBpm} bpm yet` : 'Not sung yet'}
                    </span>
                  )}
                  <TallyLights lit={progress?.mastery ?? 0} />
                </div>
                <p class="pl-body-s pl-muted">
                  {progress?.viaAudition && !attempted
                    ? 'Passed by audition. Sing it for a score and a tally.'
                    : `Lights at ${percent(def.pass.score)}, ${percent(def.tiers.solid)} and ${percent(def.tiers.studio)}.`}
                </p>
              </section>
              )}

              {records.length > 0 ? (
                <section class="pl-level__section" aria-label="Personal bests">
                  <h3 class="pl-label">Personal bests</h3>
                  <ul class="pl-level__records">
                    {records.slice(0, 4).map((rec) => (
                      <li key={rec.metric}>
                        <span>{METRIC_INFO[rec.metric as MetricKey].label}</span>
                        <span class="pl-data pl-tabular">{formatMetric(rec.metric as MetricKey, rec.value)}</span>
                      </li>
                    ))}
                  </ul>
                </section>
              ) : null}

              {level.id === LEVEL_REFS.rangeFinder ? null : recordAllowed ? (
                // The Range finder measures the voice: it has no records to chase (a wider span would be a strained one).
                <Button variant="secondary" icon={Trophy} block onClick={chaseRecord} data-testid="chase-record">
                  Chase a record
                </Button>
              ) : (
                <Locked title="Chase a record" hint={recordHint} />
              )}
            </>
          ) : null}
        </main>
      </div>

      {open ? (
        <PracticeBar
          listen={{ label: listening ? 'Stop' : 'Listen', onClick: handleListen }}
          primary={{ kind: 'sing', label: passed ? 'Sing again' : 'Sing', onClick: openSing }}
          more={{ onClick: () => setMoreOpen(true) }}
        />
      ) : null}
      <MoreSheet open={moreOpen} onClose={() => setMoreOpen(false)} onSendToClaude={() => setSendOpen(true)} />
      <SendToClaudeSheet open={sendOpen} onClose={() => setSendOpen(false)} exerciseId={def.id} />
    </div>
  );
}
