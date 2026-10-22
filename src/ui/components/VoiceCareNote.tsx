/**
 * VoiceCareNote: the voice-health note (SPEC §12) in one wording, for Home's first-run sheet and About & voice care:
 * warm up, hydrate, never sing through pain or hoarseness, rest, don't strain for range, the break reminder, and that
 * this is not medical advice.
 */
import type { JSX } from 'preact';
import { Droplets, Flame, HeartPulse, Moon, TrendingUp } from 'lucide-preact';
import { CONFIG } from '../../config';
import type { Icon } from './icon';

const CARE: ReadonlyArray<{ icon: Icon; text: string }> = [
  { icon: Flame, text: 'Warm up first: easy sirens and hums before anything demanding.' },
  { icon: Droplets, text: 'Drink water before and during a session.' },
  { icon: HeartPulse, text: 'Never sing through pain or hoarseness. Stop, and rest until your voice feels normal again.' },
  { icon: Moon, text: 'Rest between long sessions. Your voice recovers while you are quiet.' },
  { icon: TrendingUp, text: "Don't strain for range. Reach for high and low notes a little at a time; if it takes force, it is too far for today." },
];

export function VoiceCareNote(): JSX.Element {
  return (
    <div class="pl-stack" data-testid="voice-care-note">
      <ul class="pl-care" data-testid="voice-care-list">
        {CARE.map(({ icon: CareIcon, text }) => (
          <li key={text} class="pl-care__item">
            <CareIcon class="pl-care__icon" size={20} strokeWidth={2} aria-hidden="true" />
            <span class="pl-body pl-prose">{text}</span>
          </li>
        ))}
      </ul>
      <p class="pl-body-s pl-muted pl-prose">
        Pitch Lab suggests a short break after about {CONFIG.health.breakReminderMin} minutes of singing. If pain or hoarseness lasts, see a doctor.
      </p>
      <p class="pl-body-s pl-muted pl-prose">This is not medical advice.</p>
    </div>
  );
}
