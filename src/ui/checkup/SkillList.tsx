/**
 * The skills a check-up rated, one row each: the skill's plain name, its rating as a word AND a glyph (never colour
 * alone, never a grade), and the engine's one plain sentence about it. A skill that could not be measured says so
 * calmly. Order is the battery's own, so two check-ups read the same way.
 */
import type { JSX } from 'preact';
import { CircleCheck, CircleDashed, CircleDot, Target } from 'lucide-preact';
import type { SkillRating, SkillResult } from '../../checkup/types';
import type { Icon } from '../components/icon';
import { RATING_WORD, orderedSkills, skillLabel } from './model';

const RATING_GLYPH: Readonly<Record<SkillRating, Icon>> = {
  solid: CircleCheck,
  'getting-there': CircleDot,
  focus: Target,
  'not-measured': CircleDashed,
};

export function RatingMark(props: { rating: SkillRating }): JSX.Element {
  const { rating } = props;
  const Glyph = RATING_GLYPH[rating] ?? CircleDashed;
  return (
    <span class={`ck-rating ck-rating--${rating}`} data-testid="checkup-rating">
      <Glyph size={18} strokeWidth={2.25} aria-hidden="true" />
      {RATING_WORD[rating] ?? RATING_WORD['not-measured']}
    </span>
  );
}

export function SkillList(props: { skills: readonly SkillResult[] }): JSX.Element {
  return (
    <ul class="ck-skills" data-testid="checkup-skills">
      {orderedSkills(props.skills).map((s) => (
        <li key={s.skill} class="ck-skill" data-skill={s.skill} data-rating={s.rating} data-testid={`checkup-skill-${s.skill}`}>
          <span class="ck-skill__head">
            <span class="ck-skill__name">{skillLabel(s.skill)}</span>
            <RatingMark rating={s.rating} />
          </span>
          {s.what ? <span class="pl-body-s pl-muted ck-skill__what">{s.what}</span> : null}
        </li>
      ))}
    </ul>
  );
}
