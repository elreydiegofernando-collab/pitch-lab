/**
 * ProfileAvatar: a singer's initials in a round chip (DESIGN.md §13.0), the same initials as the app bar's profile chip.
 * Decorative: the name is always written beside it.
 */
import type { JSX } from 'preact';
import { initialsOf } from '../worlds/format';

export function ProfileAvatar(props: { name: string; size?: number }): JSX.Element {
  const { name, size = 40 } = props;
  return (
    <span class="pl-profiles-avatar" style={{ width: `${size}px`, height: `${size}px`, fontSize: `${Math.round(size * 0.46)}px` }} aria-hidden="true">
      {initialsOf(name)}
    </span>
  );
}
