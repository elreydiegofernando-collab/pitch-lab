/**
 * One level on the setlist path (docs/DESIGN.md 13.2): a ScoreRing node on the cable, its title and a status line.
 * Only an openable node (current or passed) is a button; a locked one is static text with its requirement line
 * (SPEC 11.1: shown, never a control).
 *
 * A level with a lesson (src/lessons) reads as a lesson (docs/DESIGN.md 13.3): its lesson title, "Lesson 5" to a screen
 * reader, and on the current one where the practice is ("Up next · Practice 2 of 4", "Ready for the check").
 */
import type { JSX } from 'preact';
import { ChevronRight } from 'lucide-preact';
import { getExercise } from '../../exercises';
import type { WorldDef } from '../../exercises/types';
import { lessonFor } from '../../lessons';
import type { LessonDef } from '../../lessons/types';
import { LEVEL_REFS } from '../../progress';
import { navigate } from '../../router';
import { attemptLog, snapshot } from '../../state/session';
import { Locked } from '../components/Locked';
import { ScoreRing } from '../components/ScoreRing';
import { TallyLights } from '../components/TallyLights';
import { lessonLabel, lessonTitle, practiceLine, readLesson, readProgress } from '../lesson/model';
import { DOT, percent, tierLabel } from './format';
import type { NodeModel } from './map-model';

/** The Range finder measures the voice rather than grading it: once passed it reads "Range saved", with no score or lights. */
function isMeasuring(node: NodeModel): boolean {
  return node.level.id === LEVEL_REFS.rangeFinder;
}

/** A lesson's name on its node: its title, a Boss Recital titled just that named in full (lessonTitle). */
function lessonName(node: NodeModel, world: Pick<WorldDef, 'title'>, lesson: Pick<LessonDef, 'title'>): string {
  const title = lessonTitle(lesson, node.level, world);
  return node.boss && !/boss recital/i.test(title) ? `${title}, the ${world.title} Boss Recital` : title;
}

/**
 * What a screen reader hears for an openable node. A lesson is "Lesson 5: Two notes, one step apart", and the current
 * one says where its practice is (`practice`, e.g. "Practice 2 of 4").
 */
export function nodeLabel(node: NodeModel, world: Pick<WorldDef, 'title'>, lesson?: Pick<LessonDef, 'title'>, practice?: string | null): string {
  const name = lesson
    ? `${lessonLabel(node.number)}: ${lessonName(node, world, lesson)}`
    : node.boss
      ? `${world.title} Boss Recital`
      : `Level ${node.number}: ${node.level.title}`;
  if (node.state === 'current') return `${name}. Up next.${practice ? ` ${practice}.` : ''}`;
  if (isMeasuring(node)) return `${name}. Range saved.`;
  if (node.viaAudition) return `${name}. Passed by audition.`;
  const tier = node.mastery >= 2 ? `, ${tierLabel(node.mastery)}` : '';
  return `${name}. Passed${node.best !== null ? `, best ${percent(node.best)}` : ''}${tier}.`;
}

/**
 * The node's title: a lesson's title, else the level's. A Boss Recital (its kicker already says so) shows its world, or its
 * lesson's own title when that is more than "Boss Recital".
 */
function nodeTitle(node: NodeModel, world: Pick<WorldDef, 'title'>, lesson: Pick<LessonDef, 'title'> | undefined): string {
  if (!node.boss) return lesson ? lesson.title : node.level.title;
  const title = lesson ? lessonTitle(lesson, node.level, world) : null;
  return title !== null && !/boss recital/i.test(title) ? title : world.title;
}

/** The ring shows the best score; a passed level with no recorded score still reads as a closed ring. */
function ringValue(node: NodeModel): number | null {
  if (node.state === 'locked') return null;
  if (isMeasuring(node)) return node.state === 'passed' ? 1 : null;
  return node.state === 'passed' ? (node.best ?? 1) : node.best;
}

function Status(props: { node: NodeModel; practice: string | null }): JSX.Element {
  const { node, practice } = props;
  if (node.state === 'locked') {
    return <Locked compact hint={node.hint ?? 'Pass the earlier levels to unlock.'} />;
  }
  if (node.state === 'current') {
    // A lesson says where its practice is; a classic level its best score so far.
    return (
      <span class="wl-node__status">
        <span class="wl-node__now">Up next</span>{' '}
        {practice !== null ? (
          <span class="pl-tabular" data-testid="node-practice">{`${DOT} ${practice}`}</span>
        ) : node.best !== null && !isMeasuring(node) ? (
          <span class="pl-tabular">{`${DOT} best ${percent(node.best)}`}</span>
        ) : null}
      </span>
    );
  }
  if (isMeasuring(node)) {
    return (
      <span class="wl-node__status">
        <span>Range saved</span>
      </span>
    );
  }
  const text = node.viaAudition
    ? 'Passed by audition'
    : node.best !== null
      ? `Best ${percent(node.best)} ${DOT} ${tierLabel(node.mastery)}`
      : 'Passed';
  return (
    <span class="wl-node__status">
      <span class="pl-tabular">{text}</span>
      <TallyLights lit={node.mastery} />
    </span>
  );
}

export interface LevelNodeProps {
  node: NodeModel;
  world: WorldDef;
  /** This node just opened (a take's unlock list): it powers on once. */
  poweredOn: boolean;
}

export function LevelNode(props: LevelNodeProps): JSX.Element {
  const { node, world, poweredOn } = props;
  const { level, state, boss } = node;
  const lesson = lessonFor(level.id);
  // Practice progress is read for the current lesson only: the one the singer is working on.
  let practice: string | null = null;
  if (lesson && state === 'current') {
    const snap = snapshot.value;
    const check = getExercise(level.exerciseId);
    const read = check ? readLesson(lesson, check, attemptLog.value, snap) : { progress: readProgress(lesson, attemptLog.value, snap), tries: 0, review: null };
    practice = practiceLine(read.progress, read.tries, read.review);
  }
  const classes = [
    'wl-node',
    `wl-node--${state}`,
    boss ? 'wl-node--boss' : '',
    lesson ? 'wl-node--lesson' : '',
    node.litAbove ? 'wl-node--lit-above' : '',
    node.litBelow ? 'wl-node--lit-below' : '',
    poweredOn ? 'wl-node--power-on' : '',
  ]
    .filter(Boolean)
    .join(' ');

  const ring = (
    <span class="wl-node__slot">
      <span class="wl-node__ring">
        <ScoreRing value={ringValue(node)} size={boss ? 64 : 56}>
          <span class="wl-node__num">{node.number}</span>
        </ScoreRing>
        <span class="wl-node__glow" aria-hidden="true" />
      </span>
    </span>
  );
  const text = (
    <span class="wl-node__text">
      {boss ? <span class="pl-label wl-node__kicker">Boss Recital</span> : null}
      <span class="wl-node__title">{nodeTitle(node, world, lesson)}</span>
      <Status node={node} practice={practice} />
    </span>
  );

  if (!node.openable) {
    return (
      <li class={classes} data-testid={`node-${level.id}`} data-state={state}>
        <div class="wl-node__row">
          {ring}
          {text}
        </div>
      </li>
    );
  }
  return (
    <li class={classes} data-testid={`node-${level.id}`} data-state={state} data-scroll-target={state === 'current' ? 'current' : undefined}>
      <button
        type="button"
        class="wl-node__row"
        aria-label={nodeLabel(node, world, lesson, practice)}
        aria-current={state === 'current' ? 'step' : undefined}
        onClick={() => navigate('level', { levelId: level.id })}
      >
        {ring}
        {text}
        <ChevronRight class="wl-chev" size={20} aria-hidden="true" />
      </button>
    </li>
  );
}
