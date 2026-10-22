/** The vibrato target zone of a style (SPEC §8.3, CONFIG.vibrato.styles), as the PitchView band and as words for the meter. */
import { CONFIG } from '../../config';
import type { VibratoStyle } from '../../core/types';

export interface ZoneInfo {
  style: VibratoStyle;
  /** "Pop" or "Classical". */
  name: string;
  rateHz: readonly [number, number];
  extentCents: readonly [number, number];
}

const NAMES: Record<VibratoStyle, string> = { pop: 'Pop', classical: 'Classical' };

/** An out-of-set style (a stale saved setting) falls back to pop, as the analyzer's own default does. */
export function zoneInfo(style: VibratoStyle): ZoneInfo {
  const known = Object.prototype.hasOwnProperty.call(CONFIG.vibrato.styles, style) ? style : 'pop';
  const z = CONFIG.vibrato.styles[known];
  return { style: known, name: NAMES[known], rateHz: z.rateHz, extentCents: z.extentCents };
}

/** The band PitchView.setVibratoZone draws around the note being sung. */
export function viewZone(style: VibratoStyle): { minExtentCents: number; maxExtentCents: number } {
  const z = zoneInfo(style);
  return { minExtentCents: z.extentCents[0], maxExtentCents: z.extentCents[1] };
}

/** "5–7 Hz". */
export function rateRangeLabel(z: ZoneInfo): string {
  return `${z.rateHz[0]}–${z.rateHz[1]} Hz`;
}

/** "±20–60¢". */
export function extentRangeLabel(z: ZoneInfo): string {
  return `±${z.extentCents[0]}–${z.extentCents[1]}¢`;
}
