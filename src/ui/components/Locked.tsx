/**
 * Locked: how a locked item is shown (SPEC §11.1, DESIGN.md §13). Visible, dimmed, with a lock glyph and the one
 * requirement line ("Pass Sustain II to unlock."). It is static text, not a control: no tap target, no pressed
 * state, so a locked item can never be opened from here.
 */
import type { JSX } from 'preact';
import { Lock } from 'lucide-preact';

export interface LockedProps {
  /** The requirement line from the unlock registry (requirementHint, levelRequirementHint, ...). */
  hint: string;
  /** What is locked ("Vibrato meter"). Omit when the surrounding row already names it. */
  title?: string;
  /** Inline variant for list rows and captions (no padding, single line). */
  compact?: boolean;
  class?: string;
}

export function Locked(props: LockedProps): JSX.Element {
  const { hint, title, compact = false, class: className } = props;
  return (
    <div
      class={['pl-locked', compact ? 'pl-locked--compact' : '', className ?? ''].filter(Boolean).join(' ')}
      aria-disabled="true"
    >
      <Lock size={16} strokeWidth={2} aria-hidden="true" class="pl-locked__icon" />
      <span class="pl-locked__text">
        <span class="pl-visually-hidden">Locked. </span>
        {title ? <span class="pl-locked__title">{title}</span> : null}
        <span class="pl-locked__hint">{hint}</span>
      </span>
    </div>
  );
}
