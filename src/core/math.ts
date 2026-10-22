/** Tiny numeric helpers shared by every module. Pure; NaN passes through unchanged (every comparison with NaN is false). */

/** `x` limited to [lo, hi]. */
export function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

/** `x` limited to [0, 1]. */
export function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}
