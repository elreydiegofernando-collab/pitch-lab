/**
 * The Vibrato meter's readouts (docs/DESIGN.md §13.14): three big numbers (rate, extent, centring), each with the style's
 * zone in words and a glyph that says in the zone, above it, below it, or not measured, plus the wobble / bleat /
 * straight chips. Straight tone is neutral information (Info glyph, never an alarm colour); wobble and bleat use the
 * alert colour with a glyph and words. The last reading stays up, dimmed, once the voice has stopped.
 */
import type { JSX } from 'preact';
import { ArrowDown, ArrowUp, Check, Info, Minus, Waves, Zap } from 'lucide-preact';
import type { VibratoFlag } from '../../analysis/types';
import type { LiveVibrato } from './live-analysis';
import { extentRangeLabel, rateRangeLabel, type ZoneInfo } from './vibrato-zone';

type ZoneState = 'in' | 'above' | 'below' | 'none';

/** Where a value sits against a [low, high] band; 'none' for no value. */
function zoneState(value: number | null, low: number, high: number): ZoneState {
  if (value === null || !Number.isFinite(value)) return 'none';
  return value < low ? 'below' : value > high ? 'above' : 'in';
}

const STATE_WORDS: Record<ZoneState, string> = { in: 'in the zone', above: 'above the zone', below: 'below the zone', none: 'not measured' };

function ZoneGlyph(props: { state: ZoneState; sharpFlat?: boolean }): JSX.Element {
  const { state } = props;
  const size = 20;
  // For centring, "above" is sharp and "below" is flat.
  const words = props.sharpFlat ? { in: 'centred', above: 'sharp', below: 'flat', none: 'not measured' }[state] : STATE_WORDS[state];
  return (
    <span class={`pl-meter__glyph pl-meter__glyph--${state}`}>
      {state === 'in' ? <Check size={size} strokeWidth={2.5} aria-hidden="true" /> : null}
      {state === 'above' ? <ArrowUp size={size} strokeWidth={2.5} aria-hidden="true" /> : null}
      {state === 'below' ? <ArrowDown size={size} strokeWidth={2.5} aria-hidden="true" /> : null}
      {state === 'none' ? <Minus size={size} strokeWidth={2.5} aria-hidden="true" /> : null}
      <span class="pl-visually-hidden">{words}</span>
    </span>
  );
}

const MINUS = '−';
/** "+12", "−7", and a plain "0" (never "−0"). */
const signed = (v: number): string => {
  const r = Math.round(v);
  return r === 0 ? '0' : `${r < 0 ? MINUS : '+'}${Math.abs(r)}`;
};

interface ReadoutProps {
  id: string;
  label: string;
  value: string;
  unit: string;
  /** The zone in words: a name ("Pop") and a range that never breaks across lines ("5–7 Hz"). */
  zoneName: string;
  zoneRange: string;
  state: ZoneState;
  sharpFlat?: boolean;
}

function Readout(props: ReadoutProps): JSX.Element {
  return (
    <div class="pl-meter__readout" data-testid={`meter-${props.id}`} data-state={props.state}>
      <span class="pl-label">{props.label}</span>
      <span class="pl-meter__value">
        <span class="pl-readout-l pl-tabular" data-testid={`meter-${props.id}-value`}>
          {props.value}
        </span>
        <span class="pl-meter__unit">{props.unit}</span>
      </span>
      <span class="pl-meter__zone pl-body-s">
        <ZoneGlyph state={props.state} sharpFlat={props.sharpFlat} />
        <span>
          {props.zoneName} <span class="pl-meter__range">{props.zoneRange}</span>
        </span>
      </span>
    </div>
  );
}

function Flag(props: { flag: Extract<VibratoFlag, 'wobble' | 'bleat' | 'straight'> }): JSX.Element {
  if (props.flag === 'straight') {
    return (
      <li class="pl-pchip pl-pchip--neutral" data-testid="flag-straight">
        <Info size={16} strokeWidth={2} aria-hidden="true" />
        Straight tone
      </li>
    );
  }
  const wobble = props.flag === 'wobble';
  return (
    <li class="pl-pchip pl-pchip--alert" data-testid={`flag-${props.flag}`}>
      {wobble ? <Waves size={16} strokeWidth={2} aria-hidden="true" /> : <Zap size={16} strokeWidth={2} aria-hidden="true" />}
      {wobble ? 'Wobble: slow or wide' : 'Bleat: too fast'}
    </li>
  );
}

const SHOWN_FLAGS: ReadonlyArray<'wobble' | 'bleat' | 'straight'> = ['wobble', 'bleat', 'straight'];

export interface VibratoReadoutsProps {
  reading: LiveVibrato | null;
  zone: ZoneInfo;
  /** The in-tune band for the centring readout. */
  toleranceCents: number;
}

export function VibratoReadouts(props: VibratoReadoutsProps): JSX.Element {
  const { reading, zone, toleranceCents } = props;
  const rate = reading?.present ? reading.rateHz : null;
  const extent = reading?.extentCents ?? null;
  const centring = reading?.centeringCents ?? null;
  const centringState: ZoneState = centring === null ? 'none' : zoneState(centring, -toleranceCents, toleranceCents);
  const flags = SHOWN_FLAGS.filter((f) => reading?.flags.includes(f));
  return (
    <div class={`pl-meter__cluster${reading?.stale ? ' pl-meter__cluster--stale' : ''}`}>
      <div class="pl-meter__readouts">
        <Readout
          id="rate"
          label="Rate"
          value={rate === null ? '–' : rate.toFixed(1)}
          unit="Hz"
          zoneName={zone.name}
          zoneRange={rateRangeLabel(zone)}
          state={zoneState(rate, zone.rateHz[0], zone.rateHz[1])}
        />
        <Readout
          id="extent"
          label="Extent"
          value={extent === null ? '–' : `±${Math.round(extent)}`}
          unit="¢"
          zoneName={zone.name}
          zoneRange={extentRangeLabel(zone)}
          state={zoneState(extent, zone.extentCents[0], zone.extentCents[1])}
        />
        <Readout
          id="centring"
          label="Centring"
          value={centring === null ? '–' : signed(centring)}
          unit="¢"
          zoneName="Within"
          zoneRange={`±${toleranceCents}¢`}
          state={centringState}
          sharpFlat
        />
      </div>
      <ul class="pl-meter__flags" aria-label="What the meter heard" aria-live="polite">
        {flags.map((f) => (
          <Flag key={f} flag={f} />
        ))}
      </ul>
    </div>
  );
}
