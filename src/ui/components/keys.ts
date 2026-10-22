/**
 * The desktop shortcuts of the thumb-zone bars (PracticeBar, BottomBar on Live, SongBar): Space is the primary action
 * and L is Listen (DESIGN.md §6). Both helpers say when a key is NOT the bar's to take, so every bar behaves alike: a
 * keyboard user who tabs to a control and presses Space gets that control, never a take or the mic.
 */

const SPACE_ACTIVATED_ROLES: ReadonlySet<string> = new Set(['button', 'switch', 'radio', 'checkbox', 'tab', 'menuitem', 'option', 'link']);

/** Shortcuts must not steal typing, a range slider, or anything inside an open sheet. */
export function ignoresShortcuts(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT') return true;
  return target.closest('[role="dialog"]') !== null;
}

/** Space already means "activate" on these (a button, a link, a radio, a switch...): leave it to the browser. */
export function activatedBySpace(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.tagName === 'BUTTON' || target.tagName === 'SUMMARY' || (target.tagName === 'A' && target.hasAttribute('href'))) return true;
  const role = target.getAttribute('role');
  return role !== null && SPACE_ACTIVATED_ROLES.has(role);
}

/** A key with a modifier is the browser's or the system's, never a bar shortcut. */
export function hasModifier(e: Pick<KeyboardEvent, 'ctrlKey' | 'metaKey' | 'altKey'>): boolean {
  return e.ctrlKey || e.metaKey || e.altKey;
}
