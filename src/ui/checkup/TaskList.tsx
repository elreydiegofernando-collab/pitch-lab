/**
 * The check-up's five tasks as a numbered set list (the audition's look, docs/DESIGN.md 13.6): the number, the plain title
 * and what to do. On the intro there is no status; once the check-up is under way each task says whether it is sung,
 * next, or still to come, in words and a glyph (never colour alone).
 */
import type { JSX } from 'preact';
import { ArrowRight, Check, Minus } from 'lucide-preact';
import { CHECKUP_TASKS } from '../../checkup/types';
import type { TaskState } from './model';

const STATE_TEXT: Readonly<Record<TaskState, string>> = { done: 'Sung', next: 'Next', ahead: 'To come' };

function StateMark(props: { state: TaskState }): JSX.Element {
  const { state } = props;
  const Glyph = state === 'done' ? Check : state === 'next' ? ArrowRight : Minus;
  return (
    <span class="ck-task__state">
      <Glyph size={16} strokeWidth={2.25} aria-hidden="true" />
      {STATE_TEXT[state]}
    </span>
  );
}

export function TaskList(props: { states?: readonly TaskState[] }): JSX.Element {
  const { states } = props;
  return (
    <ol class="ck-tasks" data-testid="checkup-tasks">
      {CHECKUP_TASKS.map((task, i) => {
        const state = states?.[i];
        return (
          <li key={task.exerciseId} class={`ck-task${state ? ` ck-task--${state}` : ''}`} data-state={state} data-testid={`checkup-task-${i + 1}`}>
            <span class="ck-task__n pl-tabular" aria-hidden="true">
              {i + 1}
            </span>
            <span class="ck-task__title">{task.title}</span>
            {state ? <StateMark state={state} /> : null}
            <span class="pl-body-s pl-muted ck-task__ask">{task.ask}</span>
          </li>
        );
      })}
    </ol>
  );
}
