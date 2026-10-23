/**
 * LiveHint: the one plain line over the Sing canvas while the singer sings (docs/DESIGN.md §13.4): "listen...", "breathe",
 * "sing now", "a little higher", "on it", "steady, good", "a bit wobbly: soften and keep the air even". What it says, and
 * when, is src/ui/practice/live-hint.ts; this is the screen side, and it keeps to the hot-path rules
 * (docs/ARCHITECTURE.md): the only frame subscriber is the tracker's `push` (array writes), a timer reads it a few times a
 * second, and the DOM is written only when the hint changes, straight to refs. Preact renders this once and never at
 * frame rate. It does not take part in the take: no pointer events, and no live-region chatter (a screen reader reads it on
 * demand; speech must not leak into the microphone mid-take).
 *
 * It sits at the bottom of the canvas over the history, left of the now line (styles/live-hint.css), so it never hides the
 * note being sung. Words always come with a glyph (never colour alone). The line fades in and out with opacity only, and
 * not at all under reduced motion.
 */
import { useEffect, useMemo, useRef } from 'preact/hooks';
import type { JSX } from 'preact';
import { ArrowDown, ArrowUp, CircleCheck, Ear, Mic, Target, Waves, Wind } from 'lucide-preact';
import type { AudioEngine } from '../../audio/engine-types';
import type { Icon } from '../components/icon';
import { HINTS, HINT_TICK_MS, createHintTracker, planHints, type HintGlyph, type HintKind, type HintSource } from './live-hint';
import { prefersReducedMotion } from './motion';
import '../../styles/live-hint.css';

export interface LiveHintProps {
  /** Where frames come from (the engine; a fake in tests). */
  engine: Pick<AudioEngine, 'onFrame'>;
  /** The exercise being sung and where it was placed (a PreparedRun is one); null until the runner has prepared it. */
  prepared: HintSource | null;
  /** The runner's origin: engine time of take time 0. Null outside a take. */
  origin: number | null;
  /** Count-in or singing: the only times there is a hint. */
  active: boolean;
}

/** Ticks without a new frame after which the engine is taken to have stopped (about 0.6 s): say nothing rather than go stale. */
const QUIET_TICKS = 3;

const GLYPHS: ReadonlyArray<readonly [HintGlyph, Icon]> = [
  ['ear', Ear],
  ['wind', Wind],
  ['mic', Mic],
  ['up', ArrowUp],
  ['down', ArrowDown],
  ['target', Target],
  ['check', CircleCheck],
  ['waves', Waves],
];

/** Show `kind`. 'none' only fades the line out (the last words stay until it is gone). Called when the hint changes, never per frame. */
function paint(root: HTMLElement, text: HTMLElement, kind: HintKind): void {
  if (kind === 'none') {
    root.dataset.kind = 'none';
    return;
  }
  const info = HINTS[kind];
  text.textContent = info.text;
  root.dataset.glyph = info.glyph;
  root.dataset.tone = info.tone;
  root.dataset.kind = kind;
}

export function LiveHint(props: LiveHintProps): JSX.Element {
  const { engine, prepared, origin, active } = props;
  const rootRef = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLSpanElement>(null);
  const plan = useMemo(() => (prepared ? planHints(prepared.def, prepared.realized) : null), [prepared]);

  useEffect(() => {
    const root = rootRef.current;
    const text = textRef.current;
    if (!root || !text) return undefined;
    if (!active || origin === null || plan === null) {
      paint(root, text, 'none');
      return undefined;
    }
    root.dataset.motion = prefersReducedMotion() ? 'reduce' : 'full';
    const tracker = createHintTracker(plan, origin);
    const off = engine.onFrame(tracker.push);
    let shown: HintKind = 'none';
    let seen = 0;
    let quiet = 0;
    const timer = setInterval(() => {
      quiet = tracker.framesSeen === seen ? quiet + 1 : 0;
      seen = tracker.framesSeen;
      const next = quiet >= QUIET_TICKS ? 'none' : tracker.read();
      if (next === shown) return;
      shown = next;
      paint(root, text, next);
    }, HINT_TICK_MS);
    return () => {
      off();
      clearInterval(timer);
      paint(root, text, 'none');
    };
  }, [engine, plan, origin, active]);

  return (
    <div ref={rootRef} class="pl-live-hint" data-kind="none" data-testid="live-hint" role="status" aria-live="off">
      <div class="pl-live-hint__pill">
        {GLYPHS.map(([id, Glyph]) => (
          <span key={id} class="pl-live-hint__glyph" data-glyph={id}>
            <Glyph size={24} strokeWidth={2.25} aria-hidden="true" />
          </span>
        ))}
        <span ref={textRef} class="pl-live-hint__text" data-testid="live-hint-text" />
      </div>
    </div>
  );
}
