/**
 * The profile chip: the singer's initials in a 32 px disc inside a 48 px target, in the app bar of the hub screens
 * (Home, World map). It opens Profiles (docs/DESIGN.md 13.0).
 */
import type { JSX } from 'preact';
import { navigate } from '../../router';
import { activeProfile, bootPhase } from '../../state/session';
import { initialsOf } from './format';

export function ProfileChip(): JSX.Element | null {
  const phase = bootPhase.value;
  const profile = activeProfile.value;
  if (phase === 'failed') return null;
  if (!profile) {
    // Booting: hold the place so the app bar does not shift when the profile arrives.
    return (
      <span class="wl-chip" aria-hidden="true">
        <span class="wl-chip__disc" />
      </span>
    );
  }
  return (
    <button
      type="button"
      class="wl-chip"
      data-testid="profile-chip"
      aria-label={`Profile: ${profile.name}. Switch or manage profiles`}
      onClick={() => navigate('profiles')}
    >
      <span class="wl-chip__disc" aria-hidden="true">
        {initialsOf(profile.name)}
      </span>
    </button>
  );
}
