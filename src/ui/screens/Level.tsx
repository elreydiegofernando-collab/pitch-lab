/**
 * Level: one level before singing (docs/DESIGN.md §13.3). The goal in a sentence, the pass lines, the tolerance and tempo
 * chips, the best score with its tally lights, then Listen / Sing / More in the thumb zone. A Boss Recital gets a stage
 * header and lists the sections of its one continuous take. A passed level offers "Sing again" for the next tally light
 * and, once Personal records open, "Chase a record"; until then that is shown locked, never hidden. Everything here is
 * gated by src/progress: a level that is not open shows its requirement and no way in.
 */
import { useEffect, useRef, useState } from 'preact/hooks';
import type { JSX } from 'preact';
import { Target, Trophy } from 'lucide-preact';
import { back, navigate, route } from '../../router';
import { CONFIG } from '../../config';
import { METRIC_INFO, WORLDS, formatMetric, getExercise, getLevel, getWorld, passRequirements } from '../../exercises';
import type { MetricKey } from '../../analysis/types';
import type { ExerciseDef, LevelDef, WorldDef } from '../../exercises/types';
import { LEVEL_REFS, isLevelOpenable, isRecordAttemptAllowed, levelRequirementHint, recordsForExercise, requirementHint } from '../../progress';
import { paramsForTarget } from '../../runtime/targets';
import type { ExerciseRunner } from '../../runtime/types';
import { activeProfile, isUnlocked, snapshot } from '../../state/session';
import { AppBar } from '../components/AppBar';
import { Banner } from '../components/Banner';
import { Button } from '../components/Button';
import { Locked } from '../components/Locked';
import { TallyLights } from '../components/TallyLights';
import { MoreSheet } from '../practice/MoreSheet';
import { PracticeBar } from '../practice/PracticeBar';
import { Unavailable } from '../practice/Unavailable';
import { bossChain, levelNumber, percent, tempoLabel, toleranceLabel } from '../practice/copy';
import { tryCreateRunner } from '../practice/runner-handle';

/** "the Foundations Boss Recital" or "Sustain II": how a level is named in a requirement line. */
function levelName(world: WorldDef | undefined, level: LevelDef): string {
  return level.kind === 'boss' && world ? `the ${world.title} Boss Recital` : level.title;
}

export function Level(): JSX.Element {
  const r = route.value;
  const level = r.name === 'level' ? getLevel(r.params.levelId) : undefined;
  const def = level ? getExercise(level.exerciseId) : undefined;
  if (!level || !def) return <Unavailable title="Level" message="This level isn't in the catalog. Go back to the map and choose another." />;
  return <LevelView level={level} def={def} />;
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
  const recordAllowed = isUnlocked('records') && isRecordAttemptAllowed(def.id, snap, WORLDS);
  const recordHint = isUnlocked('records') ? `Pass ${levelName(world, level)} to chase personal records on it.` : requirementHint('records');
  const records = passed && isUnlocked('records') ? recordsForExercise(snap, def.id).filter((rec) => rec.metric in METRIC_INFO) : [];
  const noSavedRange = profile !== null && profile.range === null && level.id !== LEVEL_REFS.rangeFinder;
  const attempted = progress !== undefined && progress.attempts > 0;
  const chain = boss ? bossChain(def) : [];

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

          {open && noSavedRange ? <Banner kind="info" message="Using a default range until you pass the Range finder." /> : null}
          {failure ? <Banner kind="error" message={failure} /> : null}
          {runError ? <Banner kind="error" message={runError.message} /> : null}

          {open ? (
            <>
              <section class="pl-level__section" aria-label="To pass">
                <h3 class="pl-label">To pass</h3>
                <ul class="pl-level__pass">
                  {passRequirements(def).map((line) => (
                    <li key={line.text}>
                      <Target size={18} strokeWidth={2} aria-hidden="true" />
                      <span class="pl-tabular">{line.text}</span>
                    </li>
                  ))}
                </ul>
              </section>

              <ul class="pl-level__chips" aria-label="How this level is judged">
                <li class="pl-pchip" aria-label={`In tune within plus or minus ${CONFIG.tolerance[def.tolerance]} cents`}>
                  {toleranceLabel(def)}
                </li>
                {tempo ? <li class="pl-pchip">{tempo}</li> : null}
              </ul>

              <section class="pl-level__section pl-level__best" aria-label="Your best">
                <div class="pl-level__best-row">
                  <span class="pl-label">Best</span>
                  {attempted ? (
                    <span class="pl-readout-l pl-tabular" data-testid="best-score">
                      {percent(progress.bestScore)}
                    </span>
                  ) : (
                    <span class="pl-body pl-muted" data-testid="best-score">
                      Not sung yet
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

              {recordAllowed ? (
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
      <MoreSheet open={moreOpen} onClose={() => setMoreOpen(false)} />
    </div>
  );
}
