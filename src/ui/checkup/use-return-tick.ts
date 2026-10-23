/**
 * A counter that moves each time the app comes back into view (the page becomes visible again, or the window regains
 * focus). A home-screen app can stay open for days, so "is a re-check due" and "how long ago" are re-read on return
 * rather than frozen at the day the screen first rendered (the Momentum chip does the same).
 */
import { useEffect, useState } from 'preact/hooks';

export function useReturnTick(): number {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const onReturn = (): void => {
      if (document.visibilityState !== 'hidden') setTick((n) => n + 1);
    };
    document.addEventListener('visibilitychange', onReturn);
    window.addEventListener('focus', onReturn);
    return () => {
      document.removeEventListener('visibilitychange', onReturn);
      window.removeEventListener('focus', onReturn);
    };
  }, []);
  return tick;
}
