/**
 * The lesson screen (docs/DESIGN.md 13.3; owner, 2026-10-23: "What about the training? What about the teaching?"). A
 * level with a lesson (src/lessons) opens here instead of the classic level screen: the header (Lesson N, the title,
 * the outcome), then the lesson as a three-part set list on one cable, Learn, Practise and Check, with the amber tally
 * on the part the singer is at, and the bar: Listen, the one amber move, More.
 *
 * The amber move practises the current step until every step is done, then takes the check; a passed lesson sings its
 * check again. A missed check sends the singer back to practice: the step that trains what was missed is marked Now and
 * the amber move practises it until a good try is sung (the check stays on its part, one tap away). Practice never
 * passes or opens anything (its tries are logged with no level); only the check passes the
 * level, and it opens only once the practice is done (lessons/progress.ts isCheckOpen). Listen plays what the amber move will
 * have you sing; the Learn page's demo plays the lesson's simplest try. Everything is gated by src/progress: a lesson
 * that is not open shows its requirement and no way in.
 */
import { useMemo, useState } from 'preact/hooks';
import type { ComponentChildren, JSX } from 'preact';
import { Check } from 'lucide-preact';
import { lastTakeMissed, latestTake, type LastTimeSources } from '../../coaching/last-time';
import type { CoachMove } from '../../coaching/types';
import { WORLDS, getWorld } from '../../exercises';
import type { ExerciseDef, LevelDef } from '../../exercises/types';
import type { LessonDef } from '../../lessons/types';
import { isLevelOpenable, isRecordAttemptAllowed, levelRequirementHint, requirementHint } from '../../progress';
import { back, navigate } from '../../router';
import { paramsForTarget } from '../../runtime/targets';
import type { RunTarget } from '../../runtime/types';
import { activeProfile, appStorage, attemptLog, isUnlocked, snapshot } from '../../state/session';
import { settings } from '../../state/settings';
import { AppBar } from '../components/AppBar';
import { Banner } from '../components/Banner';
import { Locked } from '../components/Locked';
import { hasSlowDemo } from '../practice/CoachCard';
import { LastTimeCard } from '../practice/LastTimeCard';
import { MoreSheet } from '../practice/MoreSheet';
import { PracticeBar } from '../practice/PracticeBar';
import { rangeLabel } from '../practice/RangeCard';
import { SendToClaudeSheet } from '../practice/SendToClaudeSheet';
import { CheckPart, type RecordMove } from './CheckPart';
import { LearnPart } from './LearnPart';
import { PracticePart } from './PracticePart';
import { lessonLabel, lessonNumber, lessonStage, lessonTitle, nowStep, primaryMove, readProgress, reviewStep, triesSoFar, type LessonStage } from './model';
import { linkTerms } from './terms';
import { useDemos } from './use-demos';

export interface LessonScreenProps {
  level: LevelDef;
  /** The level's own exercise: the lesson's check. */
  def: ExerciseDef;
  lesson: LessonDef;
}

type PartState = 'done' | 'now' | 'next';
type Part = 'learn' | 'practise' | 'check';

const PART_ORDER: Readonly<Record<Part, number>> = { learn: 0, practise: 1, check: 2 };
const STAGE_PART: Readonly<Record<Exclude<LessonStage, 'passed'>, Part>> = { learn: 'learn', practise: 'practise', check: 'check' };

/**
 * Each part before the singer's is done, theirs is now, the rest come next. A passed lesson has no "now", and marks done
 * only what was done: Learn once anything was tried, Practise once every step has its good tries (a level passed before
 * its lesson existed, or by an audition, has not practised), the Check.
 */
function partState(part: Part, stage: LessonStage, done: { tried: boolean; practised: boolean }): PartState {
  if (stage === 'passed') return part === 'check' || (part === 'learn' ? done.tried : done.practised) ? 'done' : 'next';
  const at = PART_ORDER[STAGE_PART[stage]];
  const own = PART_ORDER[part];
  return own < at ? 'done' : own === at ? 'now' : 'next';
}

const STATE_WORDS: Readonly<Record<PartState, string>> = { done: 'Done', now: 'Now', next: 'Next' };

const PART_NAMES: Readonly<Record<Part, string>> = { learn: 'Learn', practise: 'Practise', check: 'Check' };

/**
 * One part of the lesson on the cable: its mark (its number, a check once done, and "Now" under the part the singer is
 * at) and its content.
 */
function PartItem(props: { part: Part; stage: LessonStage; done: { tried: boolean; practised: boolean }; children: ComponentChildren }): JSX.Element {
  const { part, stage } = props;
  const state = partState(part, stage, props.done);
  return (
    <li class={`pl-part pl-part--${state}`} data-testid={`part-${part}`} data-state={state} aria-current={state === 'now' ? 'step' : undefined}>
      <div class="pl-part__mark">
        <span class="pl-part__dot" aria-hidden="true">
          {state === 'done' ? <Check size={18} strokeWidth={2.5} /> : PART_ORDER[part] + 1}
        </span>
        {state === 'now' ? <span class="pl-part__now">Now</span> : <span class="pl-visually-hidden">{STATE_WORDS[state]}</span>}
      </div>
      <section class="pl-part__body" aria-label={PART_NAMES[part]}>
        {props.children}
      </section>
    </li>
  );
}

export function LessonScreen(props: LessonScreenProps): JSX.Element {
  const { level, def, lesson } = props;
  const world = getWorld(level.worldId);
  const snap = snapshot.value;
  const log = attemptLog.value;
  const profile = activeProfile.value;
  const open = isLevelOpenable(level.id, snap);
  const boss = level.kind === 'boss';
  const n = lessonNumber(world, level);

  const progress = useMemo(() => readProgress(lesson, log, snap), [lesson, log, snap]);
  // After a missed check, the step that trains what was missed comes first (until a good try is sung there or anywhere).
  const review = useMemo(() => (progress.passed ? null : reviewStep(lesson, def, log)), [lesson, def, log, progress.passed]);
  const tries = triesSoFar(progress, log, def.id);
  const stage = lessonStage(progress, tries, review);
  const move = primaryMove(lesson, progress, review);
  const done = { tried: tries > 0, practised: progress.ready };

  // Learn opens by itself the first time (none of this lesson's own tries yet); after that it waits, folded.
  const [learnOpen, setLearnOpen] = useState(tries === 0);
  const [moreOpen, setMoreOpen] = useState(false);
  const [sendOpen, setSendOpen] = useState(false);
  const demos = useDemos();

  const check: RunTarget = { kind: 'level', levelId: level.id };
  // The Learn page plays the lesson's simplest try: its first practice step (the check when it has none).
  const learnDemo: RunTarget = lesson.practice.length > 0 ? { kind: 'drill', levelId: level.id, step: 0 } : check;
  const sing = (target: RunTarget): void => {
    navigate('sing', paramsForTarget(target));
  };

  // The Range finder measures the voice rather than grading it: no score, no tally lights, no records.
  const measuring = def.kind === 'range-finder';
  const noSavedRange = open && profile !== null && profile.range === null && !measuring;
  const notation = settings.value.notation;
  const recordsOpen = isUnlocked('records');
  const record: RecordMove | null = measuring
    ? null
    : recordsOpen && isRecordAttemptAllowed(def.id, snap, WORLDS)
      ? { allowed: true, onClick: () => navigate('sing', paramsForTarget({ kind: 'record', levelId: level.id })) }
      : { allowed: false, hint: recordsOpen ? 'Pass this lesson’s check to chase personal records on it.' : requirementHint('records') };

  // "Last time": the latest take of the check missed, so its coaching sits with the check, before the next try.
  const latest = open ? latestTake(def.id, log) : null;
  const lastTime: LastTimeSources | null =
    latest && lastTakeMissed(def, log)
      ? {
          def,
          log,
          profile: profile ?? { range: null, voiceType: 'unknown' },
          takes: appStorage.value?.takes ?? null,
          notation,
          vibratoStyle: settings.value.vibratoStyle,
          isLevelPassed: (id) => snap.levels[id]?.status === 'passed',
          now: Date.now(),
        }
      : null;
  const onMove = (m: CoachMove): void => {
    if (m.kind === 'practise-level') navigate('level', { levelId: m.levelId });
    else if (m.kind === 'send-to-claude') setSendOpen(true);
  };

  const label = boss ? `${lessonLabel(n)} · Boss Recital` : lessonLabel(n);

  return (
    <div class="pl-screen pl-level pl-lesson" data-testid="level-screen" data-lesson={lesson.levelId} style={{ '--level-accent': `var(${world?.accent ?? '--tally'})` }}>
      <AppBar title={world?.title ?? 'Lesson'} onBack={() => back()} />

      <div class="pl-scroll">
        <main class="pl-page">
          <header class={`pl-level__head${boss ? ' pl-level__head--boss' : ''}`}>
            <p class="pl-label pl-level__label" data-testid="level-label">
              {label}
            </p>
            <h2 class="pl-display-l" data-testid="lesson-title">
              {lessonTitle(lesson, level, world)}
            </h2>
            <p class="pl-body pl-prose" data-testid="lesson-outcome">
              {linkTerms(lesson.outcome, new Set())}
            </p>
          </header>

          {!open ? <Locked hint={levelRequirementHint(level.id, snap, WORLDS) ?? 'Not available yet.'} /> : null}
          {noSavedRange ? <Banner kind="info" message="Using a default range until you pass the Range finder." /> : null}
          {demos.error ? <Banner kind="error" message={demos.error} /> : null}

          {open ? (
            <ol class="pl-lesson-set" aria-label="This lesson, in three parts" data-stage={stage}>
              <PartItem part="learn" stage={stage} done={done}>
                <LearnPart
                  learn={lesson.learn}
                  open={learnOpen}
                  onToggle={() => setLearnOpen((v) => !v)}
                  demo={{ playing: demos.playing(learnDemo), onClick: () => demos.toggle(learnDemo) }}
                  headingId="lesson-part-learn"
                />
              </PartItem>
              <PartItem part="practise" stage={stage} done={done}>
                <PracticePart
                  lesson={lesson}
                  progress={progress}
                  now={nowStep(progress, review)}
                  started={stage !== 'learn'}
                  onPractise={(step) => sing({ kind: 'drill', levelId: level.id, step })}
                  headingId="lesson-part-practise"
                />
              </PartItem>
              <PartItem part="check" stage={stage} done={done}>
                <CheckPart
                  def={def}
                  ready={progress.ready}
                  passed={progress.passed}
                  afterMiss={review !== null}
                  level={snap.levels[level.id]}
                  measuring={
                    measuring ? { range: profile?.range ? rangeLabel(profile.range.comfortable.low, profile.range.comfortable.high, notation) : null } : null
                  }
                  lastTime={
                    lastTime && latest ? (
                      <LastTimeCard
                        sources={lastTime}
                        latestId={latest.id}
                        listen={{ slow: hasSlowDemo(def), playing: demos.playing(check), onClick: () => demos.toggle(check) }}
                        onMove={onMove}
                      />
                    ) : null
                  }
                  onSkip={() => sing(check)}
                  record={record}
                  headingId="lesson-part-check"
                />
              </PartItem>
            </ol>
          ) : null}
        </main>
      </div>

      {open ? (
        <PracticeBar
          listen={{ label: demos.playing(move.target) ? 'Stop' : 'Listen', onClick: () => demos.toggle(move.target) }}
          primary={{ kind: 'sing', label: move.label, onClick: () => sing(move.target) }}
          more={{ onClick: () => setMoreOpen(true) }}
        />
      ) : null}
      <MoreSheet open={moreOpen} onClose={() => setMoreOpen(false)} onSendToClaude={() => setSendOpen(true)} />
      <SendToClaudeSheet open={sendOpen} onClose={() => setSendOpen(false)} exerciseId={def.id} />
    </div>
  );
}
