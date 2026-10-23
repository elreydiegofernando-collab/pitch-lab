/**
 * Home's voice check-up card (docs/DESIGN.md 13.1; src/ui/checkup/home-card.ts decides which one and where):
 *
 *   first     "Start with a 4-minute voice check-up": the prominent first step of a new profile, amber button
 *   take      "Take your voice check-up": for a profile that has sung but never took one
 *   continue  "Finish your voice check-up": one left part way
 *   recheck   "Time for a re-check": the last one is three weeks old or more
 *   latest    a quiet row to the latest results ("Last check-up · Oct 2", with its focus)
 *
 * The card only invites: it opens the check-up's own screen (its intro, where Start is), or the results. Only the first
 * step of a profile gets the amber button, so Home keeps one primary action at a time (docs/DESIGN.md 13.0).
 */
import type { JSX } from 'preact';
import { ChevronRight, ClipboardCheck } from 'lucide-preact';
import { CHECKUP_TASKS } from '../../checkup/types';
import { navigate } from '../../router';
import { Button } from '../components/Button';
import type { HomeCard } from '../checkup/home-card';
import { PITCH_SHORT, checkupLine, elapsedWords, nextTaskIndex, openCheckup } from '../checkup/model';
import { formatDate } from '../progress/format';
import { DOT } from './format';

interface Invitation {
  label: string;
  title: string;
  body: string;
  button: string;
  primary: boolean;
}

function invitationFor(card: HomeCard): Invitation | null {
  switch (card.kind) {
    case 'first':
      return { label: 'Start here', title: 'Start with a 4-minute voice check-up', body: PITCH_SHORT, button: 'Start the check-up', primary: true };
    case 'take':
      return {
        label: 'Voice check-up',
        title: 'Take your voice check-up',
        body: 'About four minutes, five short tasks. It shows what is already solid, what to focus on and where to pick up. Take it again every few weeks to see how far you have come.',
        button: 'Take the check-up',
        primary: false,
      };
    case 'continue': {
      const next = card.session ? (nextTaskIndex(card.session) ?? 0) : 0;
      return {
        label: 'Voice check-up',
        title: 'Finish your voice check-up',
        body: `Task ${next + 1} of ${CHECKUP_TASKS.length} is next. The tasks you have sung are saved.`,
        button: 'Continue the check-up',
        primary: true,
      };
    }
    case 'recheck':
      return {
        label: 'Voice check-up',
        title: 'Time for a re-check',
        body: `It has been ${elapsedWords(card.days)} since your last check-up. Sing the same five tasks to see how far you have come.`,
        button: 'Re-check',
        primary: false,
      };
    case 'latest':
      return null;
  }
}

export function CheckupCard(props: { card: HomeCard }): JSX.Element | null {
  const { card } = props;
  const invitation = invitationFor(card);

  if (!invitation) {
    const { latest } = card;
    if (!latest) return null;
    const focus = checkupLine(latest);
    const date = formatDate(latest.finishedAt);
    return (
      <button
        type="button"
        class="ck-card ck-card--row"
        data-testid="checkup-card"
        data-kind="latest"
        aria-label={`Last check-up, ${date}. ${focus}. Open the results.`}
        onClick={() => navigate('checkup-results', { checkupId: latest.checkupId })}
      >
        <span class="ck-card__icon" aria-hidden="true">
          <ClipboardCheck size={22} strokeWidth={2} />
        </span>
        <span class="ck-card__text">
          <span class="pl-label">Voice check-up</span>
          <span class="ck-card__row-title">{`Last check-up ${DOT} ${date}`}</span>
          <span class="pl-body-s pl-muted">{focus}</span>
        </span>
        <ChevronRight class="ck-chev" size={20} aria-hidden="true" />
      </button>
    );
  }

  return (
    <section class={`ck-card ck-card--${invitation.primary ? 'prominent' : 'standard'}`} data-testid="checkup-card" data-kind={card.kind} aria-labelledby="checkup-card-title">
      <span class="pl-label">{invitation.label}</span>
      <h2 class="ck-card__title" id="checkup-card-title">
        {invitation.title}
      </h2>
      <p class="pl-body-s pl-muted pl-prose">{invitation.body}</p>
      <Button variant={invitation.primary ? 'primary' : 'secondary'} block class={invitation.primary ? 'ck-cta' : undefined} onClick={openCheckup} data-testid="checkup-card-button">
        {invitation.button}
      </Button>
    </section>
  );
}
