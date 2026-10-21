/**
 * The currently mounted PitchView instance (Live screen owns the only one in
 * Phase 1), set via PitchViewHost's `onView` callback. Lets Diagnostics and
 * the `?debug` hook (src/main.tsx) report render fps without a direct
 * reference to the Live screen.
 */
import { signal } from '@preact/signals';
import type { PitchView } from '../ui/pitch-view/types';

export const activePitchView = signal<PitchView | null>(null);
