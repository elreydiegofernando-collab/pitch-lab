/**
 * Scrolling the map to where the singer is (docs/DESIGN.md 13.2): the current node about 40% down the viewport, or a
 * world header just under the app bar. Smooth, and instant under reduced motion. The page itself normally scrolls
 * (the document), but a screen inside a scrolling container works too.
 */

/** The node sits this far down the viewport (0..1) when the map opens on it. */
export const NODE_ANCHOR = 0.4;

/** Reduced motion, as resolved by src/state/theme.ts onto <html> (setting or OS); the OS query is the fallback. */
export function prefersReducedMotion(): boolean {
  if (typeof document !== 'undefined') {
    const resolved = document.documentElement.dataset.reducedMotion;
    if (resolved === 'on') return true;
    if (resolved === 'off') return false;
  }
  return typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** The nearest ancestor that scrolls on its own; null when the document does. */
function scrollerOf(el: HTMLElement): HTMLElement | null {
  for (let p = el.parentElement; p && p !== document.body && p !== document.documentElement; p = p.parentElement) {
    const overflowY = getComputedStyle(p).overflowY;
    if ((overflowY === 'auto' || overflowY === 'scroll') && p.scrollHeight > p.clientHeight) return p;
  }
  return null;
}

function appBarHeight(): number {
  return document.querySelector('.pl-appbar')?.getBoundingClientRect().height ?? 0;
}

/** Scroll so that the element's vertical centre (`align: 'node'`) or its top edge (`'top'`) lands where the screen wants it. */
export function revealElement(el: HTMLElement, align: 'node' | 'top', smooth = !prefersReducedMotion()): void {
  const scroller = scrollerOf(el);
  const rect = el.getBoundingClientRect();
  const box = scroller ? scroller.getBoundingClientRect() : { top: 0, height: window.innerHeight };
  const current = scroller ? scroller.scrollTop : window.scrollY;
  const offsetInView = rect.top - box.top;
  const top =
    align === 'node'
      ? current + offsetInView + rect.height / 2 - box.height * NODE_ANCHOR
      : current + offsetInView - (scroller ? 0 : appBarHeight()) - 8;
  const options: ScrollToOptions = { top: Math.max(0, Math.round(top)), behavior: smooth ? 'smooth' : 'auto' };
  if (scroller) scroller.scrollTo(options);
  else window.scrollTo(options);
}

/**
 * Run `callback` once the page's fonts have settled. Laying text out is what makes the browser start loading a font, and
 * a font arriving moves everything below it, so a scroll worked out before that lands a little off. Immediately when the
 * fonts are loaded (the usual case inside the app), or the browser has no font set. Returns a function that cancels the
 * call, for a screen that went away first.
 */
export function afterFonts(callback: () => void): () => void {
  let live = true;
  const fonts = typeof document === 'undefined' ? undefined : document.fonts;
  if (fonts) document.body.getBoundingClientRect(); // lays the page out: that is what starts the loads
  if (fonts && fonts.status === 'loading') {
    void fonts.ready.then(() => {
      if (live) callback();
    });
  } else {
    callback();
  }
  return () => {
    live = false;
  };
}
