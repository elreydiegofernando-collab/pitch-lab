/**
 * Shared prop type for a lucide-preact icon component, used wherever a
 * component accepts "an icon" rather than fixed markup. lucide-preact does
 * not export its own icon-component type, so this names the subset of
 * `LucideProps` every call site here actually uses.
 */
import type { ComponentType } from 'preact';

export interface IconProps {
  size?: number | string;
  strokeWidth?: number | string;
  class?: string;
  'aria-hidden'?: boolean | 'true' | 'false';
}

export type Icon = ComponentType<IconProps>;
