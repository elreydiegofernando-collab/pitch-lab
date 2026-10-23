/**
 * CentsGauge: how close the voice is to its note, in words and on a strip (owner, 2026-10-23: units like ¢ are replaced by
 * plain words). The in-tune zone is shaded, a needle rides the strip, and under it a glyph and three words say where the
 * voice is: "On it", "A little high" or "A little low". The distance as a number is there only on request (`numbers`, the
 * Live screen's Details). Per docs/ARCHITECTURE.md's performance rules, this never takes a live `cents` prop:
 * ReadoutCluster's single rAF-throttled subscriber calls `update()` on the imperative handle, writing `transform` and
 * `textContent` straight to refs so 94 Hz frames never touch Preact state or re-render.
 *
 * The needle follows every frame, but the words are held: a voice that wobbles across the edge of the zone would flip
 * them ten times a second, which reads as flicker, not as information. So given the frame's time, a change of words waits
 * until the new reading has lasted a moment (HOLD_SEC; longer to go quiet, so the gap between two syllables does not
 * blank them), while the first reading, and a voice coming back after silence, show at once.
 */
import { useImperativeHandle, useRef } from 'preact/hooks';
import type { JSX, Ref } from 'preact';
import { ArrowDown, ArrowUp, Check } from 'lucide-preact';
import { CONFIG } from '../../config';

export interface CentsGaugeHandle {
  /**
   * `cents` outside roughly [-50, 50] is clamped for the needle position but shown unclamped as a number. NaN (unvoiced)
   * parks the needle at centre and hides it. `t` is the frame's time in seconds: with it the words are held a moment
   * before they change (see the file comment); without it they change at once.
   */
  update(cents: number, inTolerance: boolean, t?: number): void;
}

export interface CentsGaugeProps {
  /** +/- cents of the shaded in-tune zone. */
  toleranceCents?: number;
  ref?: Ref<CentsGaugeHandle>;
  /** data-testid for the words readout ("On it", "A little high", "A little low"; Live screen: "live-pitch"). */
  testId?: string;
  /** Also show the distance from the note as a number at the right end, small (the Live screen's Details). */
  numbers?: boolean;
  /** data-testid for that number (Live screen: "live-cents"). */
  numbersTestId?: string;
}

const SPAN_CENTS = 50;

/** How long a new reading must last before the words change to it, in seconds of take time. */
export const HOLD_SEC = 0.15;
/** The same, to change to "no voice": longer, so a breath between syllables does not blank the words. */
export const HOLD_QUIET_SEC = 0.3;

/** Where the voice is against its note: 'none' = no voice to read (or nothing to measure it against). */
export type PitchSide = 'none' | 'on' | 'high' | 'low' | 'too-high' | 'too-low';

const WORDS: Readonly<Record<PitchSide, string>> = {
  none: '–',
  on: 'On it',
  high: 'A little high',
  low: 'A little low',
  'too-high': 'Too high',
  'too-low': 'Too low',
};

/**
 * What the gauge says for a reading: "On it" inside the in-tune zone, else "A little high" or "A little low", and from
 * CONFIG.display.farOffCents off (a whole step: only a reading against the note asked for gets that far) "Too high" or
 * "Too low", as the live hint says "a lot lower"; "–" with no voice.
 */
export function pitchWords(cents: number, inTolerance: boolean): { side: PitchSide; text: string } {
  const far = Math.abs(cents) >= CONFIG.display.farOffCents;
  const side: PitchSide = !Number.isFinite(cents) ? 'none' : inTolerance ? 'on' : cents > 0 ? (far ? 'too-high' : 'high') : far ? 'too-low' : 'low';
  return { side, text: WORDS[side] };
}

/**
 * The lane's transform for `cents`: the needle sits at the centre of a lane as wide as the track, so a percentage of the
 * LANE is a percentage of the track (a percentage on the 3 px needle itself moved it 1.5 px at full scale). +-50c puts
 * the needle on the track's edges. Transform-only, so it never triggers layout at 94 Hz.
 */
export function needleTransform(cents: number): string {
  const clamped = Number.isFinite(cents) ? Math.max(-SPAN_CENTS, Math.min(SPAN_CENTS, cents)) : 0;
  return `translateX(${(clamped / SPAN_CENTS) * 50}%)`;
}

const show = (el: HTMLElement | null, on: boolean): void => {
  if (el) el.style.display = on ? 'inline-block' : 'none';
};

export function CentsGauge(props: CentsGaugeProps): JSX.Element {
  const { toleranceCents = 25, testId, numbers = false, numbersTestId } = props;
  const laneRef = useRef<HTMLDivElement>(null);
  const needleRef = useRef<HTMLDivElement>(null);
  const readoutRef = useRef<HTMLSpanElement>(null);
  const textRef = useRef<HTMLSpanElement>(null);
  const onRef = useRef<HTMLSpanElement>(null);
  const upRef = useRef<HTMLSpanElement>(null);
  const downRef = useRef<HTMLSpanElement>(null);
  const numberRef = useRef<HTMLSpanElement>(null);
  /** The side the needle was last painted for (null before the first reading): its colour is rewritten only when it changes. */
  const needleSide = useRef<PitchSide | null>(null);
  /** The side the words show (null before the first reading). */
  const wordsSide = useRef<PitchSide | null>(null);
  /** A different reading waiting to last long enough to change the words, and since when (take time). */
  const waiting = useRef<{ side: PitchSide; since: number } | null>(null);

  useImperativeHandle(
    props.ref ?? null,
    () => ({
      update(cents: number, inTolerance: boolean, t?: number) {
        const lane = laneRef.current;
        const needle = needleRef.current;
        const readout = readoutRef.current;
        const text = textRef.current;
        if (!lane || !needle || !readout || !text) return;
        const { side: reading } = pitchWords(cents, inTolerance);

        // The needle: every frame.
        lane.style.transform = needleTransform(cents);
        if (reading !== needleSide.current) {
          needleSide.current = reading;
          needle.style.opacity = reading === 'none' ? '0' : '1';
          needle.style.background = reading === 'none' ? 'var(--text-mid)' : reading === 'on' ? 'var(--on)' : 'var(--off)';
        }

        // The words: the reading, once it has held (or at once: the first one, a voice after silence, or no clock).
        let side = wordsSide.current;
        if (side === null || side === 'none' || t === undefined || !Number.isFinite(t)) {
          side = reading;
          waiting.current = null;
        } else if (reading === side) {
          waiting.current = null;
        } else {
          // A clock that went backwards (a new take) restarts the wait rather than stalling it.
          if (waiting.current === null || waiting.current.side !== reading || t < waiting.current.since) waiting.current = { side: reading, since: t };
          // (A hair of tolerance: the two times are floats, and a wait of exactly HOLD_SEC counts as held.)
          if (t - waiting.current.since >= (reading === 'none' ? HOLD_QUIET_SEC : HOLD_SEC) - 1e-9) {
            side = reading;
            waiting.current = null;
          }
        }
        if (side !== wordsSide.current) {
          wordsSide.current = side;
          // The words are text: in the light theme the out-of-zone hue needs its text-safe variant (--off-text).
          readout.style.color = side === 'none' ? 'var(--text-mid)' : side === 'on' ? 'var(--on-text)' : 'var(--off-text)';
          readout.dataset.side = side;
          text.textContent = WORDS[side];
          show(onRef.current, side === 'on');
          show(upRef.current, side === 'high' || side === 'too-high');
          show(downRef.current, side === 'low' || side === 'too-low');
        }

        // The number, when asked for: the raw reading, every frame.
        if (numberRef.current) {
          const rounded = Math.round(cents);
          // A plain 0 when the voice is within half a cent of the note: never "+0" or "-0".
          numberRef.current.textContent = reading === 'none' ? '––' : `${rounded > 0 ? '+' : ''}${rounded}¢`;
        }
      },
    }),
    [],
  );

  const bandPct = Math.min(100, (Math.abs(toleranceCents) / SPAN_CENTS) * 100);

  return (
    <div class="pl-cents-gauge">
      <div class="pl-cents-gauge__track" role="img" aria-label="How close your voice is to the note. The shaded band is the in-tune zone.">
        <div
          class="pl-cents-gauge__band"
          aria-hidden="true"
          style={{ left: `${50 - bandPct / 2}%`, width: `${bandPct}%` }}
        />
        <div class="pl-cents-gauge__center" aria-hidden="true" />
        <div ref={laneRef} class="pl-cents-gauge__lane" aria-hidden="true">
          {/* No needle until there is a voice to show (the first reading writes its opacity). */}
          <div ref={needleRef} class="pl-cents-gauge__needle" style={{ opacity: 0 }} />
        </div>
      </div>
      <div class="pl-cents-gauge__foot">
        <span ref={readoutRef} class="pl-cents-gauge__readout" data-side="none">
          <span ref={onRef} aria-hidden="true" style={{ display: 'none' }}>
            <Check size={14} strokeWidth={2.5} />
          </span>
          <span ref={upRef} aria-hidden="true" style={{ display: 'none' }}>
            <ArrowUp size={14} strokeWidth={2.5} />
          </span>
          <span ref={downRef} aria-hidden="true" style={{ display: 'none' }}>
            <ArrowDown size={14} strokeWidth={2.5} />
          </span>
          <span ref={textRef} data-testid={testId}>
            {'–'}
          </span>
        </span>
        {numbers ? (
          <span ref={numberRef} class="pl-body-s pl-muted pl-tabular" data-testid={numbersTestId}>
            {'––'}
          </span>
        ) : null}
      </div>
    </div>
  );
}
