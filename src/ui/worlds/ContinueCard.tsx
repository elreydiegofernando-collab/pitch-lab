/**
 * The Continue card (docs/DESIGN.md 13.1): the next number on the set list. A 4 px rule in the current world's hue, the
 * label "NEXT UP · 04", the level title, its goal, the tally lights, and a full-width 64 px amber Continue button that
 * opens the Level screen. When every level is passed it says so and links to the dashboard.
 *
 * A level with a lesson (src/lessons) reads as a lesson (docs/DESIGN.md 13.3): "Next up · Lesson 5", the lesson title
 * and what it teaches, and where its practice is ("Practice 2 of 4", "Ready for the check"), with the check's best so
 * far once it has one.
 */
import type { JSX } from 'preact';
import { getExercise, WORLDS } from '../../exercises';
import type { LevelDef, WorldDef } from '../../exercises/types';
import { lessonFor } from '../../lessons';
import type { LessonDef } from '../../lessons/types';
import { LEVEL_REFS, continueLevel } from '../../progress';
import { navigate } from '../../router';
import { attemptLog, isUnlocked, snapshot } from '../../state/session';
import { Button } from '../components/Button';
import { TallyLights } from '../components/TallyLights';
import { lessonLabel, lessonTitle, practiceLine, readLesson, readProgress } from '../lesson/model';
import { linkTerms } from '../lesson/terms';
import { DOT, hueStyle, pad2, percent } from './format';
import { locateLevel } from './levels';

function AllPassed(): JSX.Element {
  return (
    <section class="wl-continue" data-testid="continue-card" aria-labelledby="continue-title">
      <span class="pl-label">Set list complete</span>
      <h2 class="wl-continue__title" id="continue-title">
        Every level passed
      </h2>
      <p class="pl-body-s pl-muted pl-prose">Replay any level from the world map to light more of its tally lights.</p>
      {isUnlocked('dashboard') ? (
        <Button variant="secondary" block onClick={() => navigate('dashboard')} data-testid="continue-dashboard">
          Open the progress dashboard
        </Button>
      ) : null}
    </section>
  );
}

/** The practice steps as small marks (a filled one for each step done), beside the words that say the same. */
function StepMarks(props: { done: readonly boolean[] }): JSX.Element {
  return (
    <span class="pl-lesson-marks" aria-hidden="true">
      {props.done.map((d, i) => (
        <span key={i} class={`pl-lesson-marks__mark${d ? ' pl-lesson-marks__mark--done' : ''}`} />
      ))}
    </span>
  );
}

/** The card for the current lesson: its number and title, what it teaches, and where its practice is. */
function LessonCard(props: { level: LevelDef; lesson: LessonDef; world: WorldDef; number: number; quiet: boolean }): JSX.Element {
  const { level, lesson, world, number, quiet } = props;
  const snap = snapshot.value;
  const check = getExercise(level.exerciseId);
  const state = check ? readLesson(lesson, check, attemptLog.value, snap) : { progress: readProgress(lesson, attemptLog.value, snap), tries: 0, review: null };
  const { progress } = state;
  const line = practiceLine(progress, state.tries, state.review);
  const best = snap.levels[level.id]?.bestScore ?? 0;
  return (
    <section class="wl-continue" style={hueStyle(world)} data-testid="continue-card" data-world={world.id} data-lesson={lesson.levelId} aria-labelledby="continue-title">
      <div class="wl-continue__top">
        <span class="pl-label">{`Next up ${DOT} ${lessonLabel(number)}`}</span>
        <span class="pl-label wl-continue__world">{world.title}</span>
      </div>
      <h2 class="wl-continue__title" id="continue-title">
        {lessonTitle(lesson, level, world)}
      </h2>
      <p class="pl-body-s pl-muted pl-prose">{linkTerms(lesson.outcome, new Set())}</p>
      <div class="wl-continue__meta">
        {progress.steps.length > 0 ? <StepMarks done={progress.steps.map((s) => s.done)} /> : null}
        <span class="pl-body-s pl-tabular" data-testid="continue-practice">
          {line}
        </span>
        {best > 0 && level.id !== LEVEL_REFS.rangeFinder ? <span class="pl-body-s pl-muted pl-tabular">{`Best on the check ${percent(best)}`}</span> : null}
      </div>
      <Button variant={quiet ? 'secondary' : 'primary'} block class="wl-cta" onClick={() => navigate('level', { levelId: level.id })} data-testid="continue-button">
        Continue
      </Button>
    </section>
  );
}

/**
 * `quiet`: another card is the first step on Home right now (the voice check-up, src/ui/worlds/CheckupCard.tsx), so
 * Continue steps back to a secondary button and the screen keeps one amber button (docs/DESIGN.md 13.0).
 */
export function ContinueCard(props: { quiet?: boolean }): JSX.Element {
  const quiet = props.quiet === true;
  const snap = snapshot.value;
  const level = continueLevel(snap, WORLDS);
  const found = level ? locateLevel(WORLDS, level.id) : undefined;
  if (!level || !found) return <AllPassed />;

  const { world, number } = found;
  const lesson = lessonFor(level.id);
  if (lesson) return <LessonCard level={level} lesson={lesson} world={world} number={number} quiet={quiet} />;

  const exercise = getExercise(level.exerciseId);
  const progress = snap.levels[level.id];
  // A Boss Recital is titled by its exercise ("Foundations Boss Recital"): every boss level is just "Boss Recital".
  const title = level.kind === 'boss' ? (exercise?.title ?? level.title) : level.title;
  const best = progress && progress.bestScore > 0 ? progress.bestScore : null;

  return (
    <section class="wl-continue" style={hueStyle(world)} data-testid="continue-card" data-world={world.id} aria-labelledby="continue-title">
      <div class="wl-continue__top">
        <span class="pl-label">{`Next up ${DOT} ${pad2(number)}`}</span>
        <span class="pl-label wl-continue__world">{world.title}</span>
      </div>
      <h2 class="wl-continue__title" id="continue-title">
        {title}
      </h2>
      {exercise ? <p class="pl-body-s pl-muted pl-prose">{exercise.goal}</p> : null}
      {/* The Range finder measures the voice rather than grading it: no tally lights, no best score. */}
      {level.id === LEVEL_REFS.rangeFinder ? null : (
        <div class="wl-continue__meta">
          <TallyLights lit={progress?.mastery ?? 0} />
          {best !== null ? <span class="pl-body-s pl-muted pl-tabular">{`Best so far ${percent(best)}`}</span> : null}
        </div>
      )}
      <Button
        variant={quiet ? 'secondary' : 'primary'}
        block
        class="wl-cta"
        onClick={() => navigate('level', { levelId: level.id })}
        data-testid="continue-button"
      >
        Continue
      </Button>
    </section>
  );
}
