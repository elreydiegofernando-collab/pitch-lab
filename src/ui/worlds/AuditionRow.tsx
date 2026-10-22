/**
 * The placement-audition row of an open world (docs/DESIGN.md 13.2): a button to the audition when it can be taken,
 * a static `Locked` line with its requirement when it cannot yet. The map hides the row when nothing is left to open.
 */
import type { JSX } from 'preact';
import { ChevronRight, SkipForward } from 'lucide-preact';
import type { WorldDef } from '../../exercises/types';
import { navigate } from '../../router';
import { Locked } from '../components/Locked';
import { plural, tieNumerals } from './format';
import type { AuditionRowModel } from './map-model';

export function AuditionRow(props: { row: AuditionRowModel; world: WorldDef }): JSX.Element {
  const { row, world } = props;
  if (row.kind === 'locked') {
    return (
      <div class="wl-linkrow wl-linkrow--locked" data-testid={`audition-row-${world.id}`} data-locked="true">
        <Locked title="Placement audition" hint={row.hint} />
      </div>
    );
  }
  return (
    <button
      type="button"
      class="wl-linkrow wl-linkrow--skip"
      data-testid={`audition-row-${world.id}`}
      onClick={() => navigate('audition', { worldId: world.id })}
    >
      <SkipForward class="wl-linkrow__icon" size={22} strokeWidth={2} aria-hidden="true" />
      <span class="wl-linkrow__text">
        <span class="wl-linkrow__title">Placement audition</span>
        <span class="pl-body-s pl-muted">{`Sing ${plural(row.tests, 'short test')} to skip ahead`}</span>
        {row.reach ? <span class="pl-body-s wl-linkrow__reach">{`Can open ${tieNumerals(row.reach)}`}</span> : null}
      </span>
      <ChevronRight class="wl-chev" size={20} aria-hidden="true" />
    </button>
  );
}
