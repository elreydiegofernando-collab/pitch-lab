/**
 * The Continue card (docs/DESIGN.md 13.1): the next number on the set list. A 4 px rule in the current world's hue, the
 * label "NEXT UP · 04", the level title, its goal, the tally lights, and a full-width 64 px amber Continue button that
 * opens the Level screen. When every level is passed it says so and links to the dashboard.
 */
import type { JSX } from 'preact';
import { getExercise, WORLDS } from '../../exercises';
import { LEVEL_REFS, continueLevel } from '../../progress';
import { navigate } from '../../router';
import { isUnlocked, snapshot } from '../../state/session';
import { Button } from '../components/Button';
import { TallyLights } from '../components/TallyLights';
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

export function ContinueCard(): JSX.Element {
  const snap = snapshot.value;
  const level = continueLevel(snap, WORLDS);
  const found = level ? locateLevel(WORLDS, level.id) : undefined;
  if (!level || !found) return <AllPassed />;

  const { world, number } = found;
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
        variant="primary"
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
