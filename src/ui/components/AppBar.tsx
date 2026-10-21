/** AppBar: back button, title, and a status pill showing engine state + the current route's icon. */
import type { ComponentChildren, JSX } from 'preact';
import { ChevronLeft, Mic, MicOff, TriangleAlert } from 'lucide-preact';
import type { EngineState } from '../../audio/engine-types';
import type { Icon } from './icon';

export interface AppBarProps {
  title: string;
  routeIcon?: Icon;
  engineState?: EngineState;
  onBack?: () => void;
  trailing?: ComponentChildren;
  class?: string;
}

const STATE_LABEL: Record<EngineState, string> = {
  idle: 'Mic off',
  starting: 'Starting…',
  running: 'Listening',
  suspended: 'Paused',
  interrupted: 'Interrupted',
  error: 'Mic error',
};

function stateModifierClass(state: EngineState): string {
  if (state === 'running') return 'pl-status-pill--running';
  if (state === 'interrupted' || state === 'error') return 'pl-status-pill--interrupted';
  if (state === 'starting' || state === 'suspended') return 'pl-status-pill--starting';
  return '';
}

function StatusGlyph({ state }: { state: EngineState }): JSX.Element {
  if (state === 'running') return <Mic aria-hidden="true" />;
  if (state === 'interrupted' || state === 'error') return <TriangleAlert aria-hidden="true" />;
  return <MicOff aria-hidden="true" />;
}

export function AppBar(props: AppBarProps): JSX.Element {
  const { title, routeIcon: RouteIcon, engineState, onBack, trailing, class: className } = props;
  return (
    <header class={['pl-appbar', className ?? ''].filter(Boolean).join(' ')}>
      {onBack ? (
        <button type="button" class="pl-appbar__back" onClick={onBack} aria-label="Back">
          <ChevronLeft size={24} strokeWidth={2} aria-hidden="true" />
        </button>
      ) : (
        <span style={{ width: 'var(--target-min)', flexShrink: 0 }} aria-hidden="true" />
      )}
      {RouteIcon ? <RouteIcon size={20} strokeWidth={2} class="pl-muted" aria-hidden="true" /> : null}
      <h1 class="pl-appbar__title">{title}</h1>
      {engineState ? (
        <span
          class={['pl-status-pill', stateModifierClass(engineState)].filter(Boolean).join(' ')}
          data-testid="engine-state"
        >
          <StatusGlyph state={engineState} />
          {STATE_LABEL[engineState]}
        </span>
      ) : null}
      {trailing}
    </header>
  );
}
