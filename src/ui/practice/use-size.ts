/** The size of an element in CSS pixels, kept current by a ResizeObserver (rotation, a sheet opening, a window resize). */
import { useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { RefObject } from 'preact';

export interface ElementSize {
  w: number;
  h: number;
}

export function useElementSize<T extends HTMLElement>(): [RefObject<T | null>, ElementSize] {
  const ref = useRef<T>(null);
  const [size, setSize] = useState<ElementSize>({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const measure = (): void => {
      const rect = el.getBoundingClientRect();
      const w = Math.round(rect.width);
      const h = Math.round(rect.height);
      setSize((prev) => (prev.w === w && prev.h === h ? prev : { w, h }));
    };
    measure();
    if (typeof ResizeObserver !== 'function') return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return [ref, size];
}
