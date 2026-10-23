/**
 * What each vibrato style sounds like, in plain words (owner, 2026-10-23: no Hz or cents in anything a singer reads).
 * The zones behind them are CONFIG.vibrato.styles (pop is narrower, classical wider, both at the same speed), and the
 * speed is said as the coach says it (coaching/plain.ts wobbleZone), so it follows the config. Settings and the Vibrato
 * meter use the same line.
 */
import { wobbleZone } from '../coaching/plain';
import type { VibratoStyle } from '../core/types';

const STYLE_WORDS: Readonly<Record<VibratoStyle, string>> = {
  pop: 'A light, narrow vibrato, like many pop and R&B singers use.',
  classical: 'A fuller, wider vibrato, like opera and choir singers use.',
};

/** "A light, narrow vibrato, like many pop and R&B singers use. Both go about five to seven wobbles a second." An out-of-set style (a stale saved setting) reads as pop, as the analyzer's own default does. */
export function vibratoStyleWords(style: VibratoStyle): string {
  const words = Object.prototype.hasOwnProperty.call(STYLE_WORDS, style) ? STYLE_WORDS[style] : STYLE_WORDS.pop;
  return `${words} Both go about ${wobbleZone()}.`;
}
