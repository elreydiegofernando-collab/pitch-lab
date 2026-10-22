import { useEffect, useRef } from 'preact/hooks';

/** A ref that reads true while the component is mounted: guards a state update that comes back after an await. */
export function useMounted(): { readonly current: boolean } {
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  return mounted;
}
