/**
 * ReportBar: the report's next steps in the thumb zone (docs/DESIGN.md §13.5), from afterTakeActions. Exactly one is the
 * amber primary, full width and 64 px tall; the rest sit under it as secondary buttons. If the list arrives with no
 * primary, or with several, the first becomes the one and the others are demoted, so the screen can never show two.
 */
import type { JSX } from 'preact';
import { ArrowRight, Check, ChevronLeft, ClipboardCheck, Map as MapIcon, RotateCcw, Target } from 'lucide-preact';
import type { AfterTakeAction } from '../../runtime/types';
import { Button } from '../components/Button';
import type { Icon } from '../components/icon';

const ACTION_ICON: Record<AfterTakeAction['kind'], Icon> = {
  retry: RotateCcw,
  'next-level': ArrowRight,
  'next-test': ArrowRight,
  'audition-results': ArrowRight,
  'next-take': ArrowRight,
  'next-item': ArrowRight,
  'finish-workout': Check,
  'next-task': ArrowRight,
  'checkup-results': ClipboardCheck,
  // A lesson's practice: the same step again, the next step, the check (the level's pass lines: their Target glyph), back.
  'next-try': RotateCcw,
  'next-step': ArrowRight,
  'take-check': Target,
  lesson: ChevronLeft,
  level: ChevronLeft,
  map: MapIcon,
};

/** The primary action, and the others in their given order. */
export function splitActions(actions: readonly AfterTakeAction[]): { primary: AfterTakeAction | null; others: AfterTakeAction[] } {
  const primary = actions.find((a) => a.primary) ?? actions[0] ?? null;
  return { primary, others: actions.filter((a) => a !== primary) };
}

export interface ReportBarProps {
  actions: readonly AfterTakeAction[];
  onAct: (action: AfterTakeAction) => void;
}

export function ReportBar(props: ReportBarProps): JSX.Element | null {
  const { primary, others } = splitActions(props.actions);
  if (!primary) return null;
  return (
    <nav class="pl-bottombar pl-report-bar" aria-label="Next steps">
      <Button variant="primary" block icon={ACTION_ICON[primary.kind]} class="pl-report-bar__primary" onClick={() => props.onAct(primary)} data-testid="report-primary">
        {primary.label}
      </Button>
      {others.length > 0 ? (
        <div class="pl-report-bar__others">
          {others.map((a) => (
            <Button key={a.kind} variant="secondary" icon={ACTION_ICON[a.kind]} block onClick={() => props.onAct(a)} data-testid={`report-${a.kind}`}>
              {a.label}
            </Button>
          ))}
        </div>
      ) : null}
    </nav>
  );
}
