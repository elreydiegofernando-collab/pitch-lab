/**
 * LiveStatus: the Live screen's progressive status chips (SPEC §12: "settling…", "vibrato 5.8 Hz ±38¢"). A chip exists only
 * once the skill behind it is earned (SPEC §11.1), so a singer who has passed nothing sees note, cents, Hz and dB and no
 * chips at all. The row reserves its height, so a reading arriving never moves the canvas.
 */
import type { JSX } from 'preact';
import type { ReadonlySignal } from '@preact/signals';
import { Activity, Check, Info, Timer } from 'lucide-preact';
import type { LiveFeatures, LiveReadings } from './live-analysis';

export interface LiveStatusProps {
  readings: ReadonlySignal<LiveReadings>;
  features: Pick<LiveFeatures, 'onset' | 'vibrato'>;
}

export function LiveStatus(props: LiveStatusProps): JSX.Element | null {
  const { features } = props;
  if (!features.onset && !features.vibrato) return null;
  const { onset, vibrato } = props.readings.value;

  return (
    <ul class="pl-live-status" aria-label="Live readings">
      {features.onset ? (
        <li class="pl-pchip" data-testid="live-onset">
          <Timer size={16} strokeWidth={2} aria-hidden="true" />
          {onset === null ? (
            <span class="pl-muted">Settle –</span>
          ) : onset.state === 'settling' ? (
            <span>Settling…</span>
          ) : (
            <span class="pl-tabular">
              {onset.settleMs === null ? 'Not settled' : `Settle ${Math.round(onset.settleMs)} ms`} · Scoop {Math.round(onset.scoopCents)}¢
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
                Vibrato {vibrato.rateHz.toFixed(1)} Hz ±{Math.round(vibrato.extentCents ?? 0)}¢
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
