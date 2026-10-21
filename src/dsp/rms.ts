/** RMS level helper shared by the detectors and the frame output. */

/**
 * RMS level of `window` in dBFS (full scale = amplitude 1), clamped at
 * `floorDb` so perfect digital silence reports a finite number instead of
 * `-Infinity`. Allocation-free.
 */
export function rmsDb(window: Float32Array, floorDb: number): number {
  let sumSq = 0;
  for (let i = 0; i < window.length; i++) {
    const s = window[i];
    sumSq += s * s;
  }
  const rms = Math.sqrt(sumSq / window.length);
  if (!(rms > 0)) return floorDb;
  const db = 20 * Math.log10(rms);
  return db < floorDb ? floorDb : db;
}
