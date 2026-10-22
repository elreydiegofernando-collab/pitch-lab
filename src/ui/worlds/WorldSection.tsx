/**
 * One world on the setlist path (docs/DESIGN.md 13.2): the header ("02 VIBRATO", its summary, a 2 px rule in the world's
 * hue), then, when the world is open, its placement-audition row and the cable of level nodes; when it is closed, a
 * dimmed compact list of its level titles and ONE `Locked` line. Song Stage has no nodes, only a row to the library.
 */
import type { JSX } from 'preact';
import { Locked } from '../components/Locked';
import { AuditionRow } from './AuditionRow';
import { LevelNode } from './LevelNode';
import { SongStageRow } from './SongStageRow';
import { hueStyle, pad2 } from './format';
import type { WorldModel } from './map-model';

export interface WorldSectionProps {
  model: WorldModel;
  /** Level ids that just opened (a take's unlock list) and power on once. */
  poweredOn: ReadonlySet<string>;
}

export function WorldSection(props: WorldSectionProps): JSX.Element {
  const { model, poweredOn } = props;
  const { world, open, ladder } = model;
  const titleId = `world-${world.id}-title`;
  return (
    <section
      class={['wl-world', open ? '' : 'wl-world--closed'].filter(Boolean).join(' ')}
      style={hueStyle(world)}
      data-testid={`world-${world.id}`}
      data-world-id={world.id}
      data-open={open ? 'true' : 'false'}
      aria-labelledby={titleId}
    >
      <header class="wl-world__head">
        <div class="wl-world__row">
          <h2 class="wl-world__title" id={titleId}>
            <span class="wl-world__num pl-tabular">{pad2(model.number)}</span>
            <span>{world.title}</span>
          </h2>
          {open && ladder ? (
            <span class="pl-label wl-world__count pl-tabular">
              {`${model.passed} of ${model.total}`}
              <span class="pl-visually-hidden"> levels passed</span>
            </span>
          ) : null}
        </div>
        <p class="pl-body-s pl-muted pl-prose wl-world__summary">{world.summary}</p>
      </header>
      <div class="wl-world__rule" aria-hidden="true" />

      {!ladder ? <SongStageRow model={model} /> : null}

      {ladder && open ? (
        <>
          {model.audition ? <AuditionRow row={model.audition} world={world} /> : null}
          <ol class="wl-cable" aria-label={`${world.title} levels`}>
            {model.nodes.map((node) => (
              <LevelNode key={node.level.id} node={node} world={world} poweredOn={poweredOn.has(node.level.id)} />
            ))}
          </ol>
        </>
      ) : null}

      {ladder && !open ? (
        <>
          <ul class="wl-titles" aria-label={`${world.title} levels`} data-testid={`world-${world.id}-titles`}>
            {model.titles.map((title, i) => (
              <li key={i}>{title}</li>
            ))}
          </ul>
          <Locked hint={model.hint ?? 'Not available yet.'} />
        </>
      ) : null}
    </section>
  );
}
