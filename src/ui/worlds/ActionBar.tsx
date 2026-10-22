/** The thumb-zone action bar of a screen with one primary action (docs/DESIGN.md 13.0): sticky at the bottom, safe-area aware. */
import type { ComponentChildren, JSX } from 'preact';

export function ActionBar(props: { children: ComponentChildren }): JSX.Element {
  return (
    <div class="wl-actionbar" data-testid="action-bar">
      <div class="wl-actionbar__inner">{props.children}</div>
    </div>
  );
}
