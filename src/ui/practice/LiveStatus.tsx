/**
 * LiveStatus: the Live screen's progressive status chips (SPEC §12: how each note starts, the vibrato). A chip exists only
 * once the skill behind it is earned (SPEC §11.1), so a singer who has passed nothing sees no chips at all. The row
 * reserves its height, so a reading arriving never moves the canvas.
 *
 * Plain words (owner, 2026-10-23: no units the singer has to decode): "Found the note in about a quarter of a second, no
 * scoop", "Vibrato: about six wobbles a second", in the coach's own words (coaching/plain.ts). The numbers with their
 * units come only with `details`, the Live screen's Details toggle, as the readouts above do.
 */
import type { JSX } from 'preact';
import type { ReadonlySignal } from '@preact/signals';
import { Activity, Check, Info, Timer } from 'lucide-preact';
import * as P from '../../coaching/plain';
import type { LiveFeatures, LiveReadings } from './live-analysis';
import type { OnsetReading } from './live-readings';

export interface LiveStatusProps {
  readings: ReadonlySignal<LiveReadings>;
  features: Pick<LiveFeatures, 'onset' | 'vibrato'>;
  /** Also show the numbers behind the words (the Live screen's Details). Off by default. */
  details?: boolean;
}

/** How a note started, in words: how quickly the voice found it, and whether it slid up into it. */
export function onsetWords(onset: Pick<OnsetReading, 'settleMs' | 'scoopCents'>): string {
  const scoop = Math.abs(onset.scoopCents);
  const slid = scoop < 10 ? 'no scoop' : `scooped up ${P.pitchDistance(scoop)}`;
  return onset.settleMs === null ? `Did not find the note, ${slid}` : `Found the note in ${P.durationWords(onset.settleMs / 1000)}, ${slid}`;
}

/** The vibrato, in words: how fast it wobbles. */
export function vibratoWords(rateHz: number): string {
  return `Vibrato: ${P.wobbles(rateHz)}`;
}

export function LiveStatus(props: LiveStatusProps): JSX.Element | null {
  const { features, details = false } = props;
  if (!features.onset && !features.vibrato) return null;
  const { onset, vibrato } = props.readings.value;

  return (
    <ul class="pl-live-status" aria-label="Live readings">
      {features.onset ? (
        <li class="pl-pchip" data-testid="live-onset">
          <Timer size={16} strokeWidth={2} aria-hidden="true" />
          {onset === null ? (
            <span class="pl-muted">How it starts –</span>
          ) : onset.state === 'settling' ? (
            <span>Finding the note…</span>
          ) : (
            <span class="pl-tabular">
              {onsetWords(onset)}
              {details ? ` (${onset.settleMs === null ? '–' : `${Math.round(onset.settleMs)} ms`} · ${Math.round(onset.scoopCents)}¢)` : ''}
            </span>
          )}
        </li>
      ) : null}
      {features.vibrato ? (
        <li class={`pl-pchip${vibrato?.stale ? ' pl-pchip--stale' : ''}`} data-testid="live-vibrato">
          {vibrato === null ? (
            <>
              <Activity size={16} strokeWidth={2} aria-hidden="true" />
              <span class="pl-muted">Vibrato –</span>
            </>
          ) : vibrato.present && vibrato.rateHz !== null ? (
            <>
              <Activity size={16} strokeWidth={2} aria-hidden="true" />
              <span class="pl-tabular">
                {vibratoWords(vibrato.rateHz)}
                {details ? ` (${vibrato.rateHz.toFixed(1)} Hz ±${Math.round(vibrato.extentCents ?? 0)}¢)` : ''}
              </span>
              {vibrato.inZone ? (
                <>
                  <Check size={16} strokeWidth={2.5} aria-hidden="true" class="pl-live-status__ok" />
                  <span class="pl-visually-hidden">in the zone</span>
                </>
              ) : null}
            </>
          ) : (
            <>
              <Info size={16} strokeWidth={2} aria-hidden="true" />
              <span>Straight tone</span>
            </>
          )}
        </li>
      ) : null}
    </ul>
  );
}
