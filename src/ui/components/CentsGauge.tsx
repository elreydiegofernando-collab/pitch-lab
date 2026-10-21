/**
 * CentsGauge: a +/-50c horizontal scale with the tolerance band shaded and a
 * needle. Per docs/ARCHITECTURE.md's performance rules, this never takes a
 * live `cents` prop: ReadoutCluster's single rAF-throttled subscriber calls
 * `update()` on the imperative handle, writing `transform`/`textContent`
 * straight to refs so 94 Hz frames never touch Preact state or re-render.
 */
import { useImperativeHandle, useRef } from 'preact/hooks';
import type { JSX, Ref } from 'preact';
import { ArrowDown, ArrowUp } from 'lucide-preact';

export interface CentsGaugeHandle {
  /** `cents` outside roughly [-50, 50] is clamped for the needle position but shown unclamped as text. NaN (unvoiced) parks the needle at centre and hides it. */
  update(cents: number, inTolerance: boolean): void;
}

export interface CentsGaugeProps {
  /** +/- cents of the shaded tolerance band. */
  toleranceCents?: number;
  ref?: Ref<CentsGaugeHandle>;
  /** data-testid for the numeric cents readout (Live screen: "live-cents"). */
  testId?: string;
}

const SPAN_CENTS = 50;

export function CentsGauge(props: CentsGaugeProps): JSX.Element {
  const { toleranceCents = 25, testId } = props;
  const needleRef = useRef<HTMLDivElement>(null);
  const readoutRef = useRef<HTMLSpanElement>(null);
  const textRef = useRef<HTMLSpanElement>(null);
  const upRef = useRef<HTMLSpanElement>(null);
  const downRef = useRef<HTMLSpanElement>(null);

  useImperativeHandle(
    props.ref ?? null,
    () => ({
      update(cents: number, inTolerance: boolean) {
        const needle = needleRef.current;
        const readout = readoutRef.current;
        const text = textRef.current;
        if (!needle || !readout || !text) return;
        const voiced = Number.isFinite(cents);
        const clamped = voiced ? Math.max(-SPAN_CENTS, Math.min(SPAN_CENTS, cents)) : 0;
        const color = !voiced ? 'var(--text-mid)' : inTolerance ? 'var(--on)' : 'var(--off)';

        needle.style.transform = `translateX(${(clamped / SPAN_CENTS) * 50}%)`;
        needle.style.opacity = voiced ? '1' : '0';
        needle.style.background = color;

        readout.style.color = color;
        text.textContent = voiced ? `${cents > 0 ? '+' : ''}${Math.round(cents)}¢` : '––';
        if (upRef.current) upRef.current.style.display = voiced && cents > 0.5 ? 'inline-block' : 'none';
        if (downRef.current) downRef.current.style.display = voiced && cents < -0.5 ? 'inline-block' : 'none';
      },
    }),
    []
  );

  const bandPct = Math.min(100, (Math.abs(toleranceCents) / SPAN_CENTS) * 100);

  return (
    <div class="pl-cents-gauge">
      <div class="pl-cents-gauge__track" role="img" aria-label={`Pitch within plus or minus ${toleranceCents} cents of the target`}>
        <div
          class="pl-cents-gauge__band"
          aria-hidden="true"
          style={{ left: `${50 - bandPct / 2}%`, width: `${bandPct}%` }}
        />
        <div class="pl-cents-gauge__center" aria-hidden="true" />
        <div ref={needleRef} class="pl-cents-gauge__needle" aria-hidden="true" />
      </div>
      <div class="pl-cents-gauge__foot">
        <span class="pl-label">Cents</span>
        <span ref={readoutRef} class="pl-cents-gauge__readout">
          <span ref={upRef} aria-hidden="true" style={{ display: 'none' }}>
            <ArrowUp size={14} strokeWidth={2.5} />
          </span>
          <span ref={downRef} aria-hidden="true" style={{ display: 'none' }}>
            <ArrowDown size={14} strokeWidth={2.5} />
          </span>
          <span ref={textRef} class="pl-tabular" data-testid={testId}>
            {'––'}
          </span>
        </span>
      </div>
    </div>
  );
}
