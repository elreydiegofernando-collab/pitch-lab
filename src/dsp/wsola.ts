/**
 * WSOLA time-stretch (Verhelst & Roelands 1993): changes the speed of a mono
 * recording WITHOUT changing its pitch. Used by "slow it down" playback of a
 * take (rate 0.5-1.0), so the singer can hear and see every note of a run.
 *
 * How it works. The output is laid out on a fixed grid of overlapping Hann
 * windows (hop H = N/2, so the windows sum to exactly 1: no gain correction).
 * Window k is a slice of the INPUT whose nominal start advances by only
 * `rate * H` per output hop (slower = smaller advance = material repeated).
 * Before each slice is overlap-added, it is nudged by up to +/-S samples to
 * the position whose waveform best continues the previous slice (normalised
 * cross-correlation against the previous slice's second half, i.e. the
 * "natural continuation"). That nudge keeps pitch periods phase-aligned across
 * every join, so the repeated material keeps its pitch and has no clicks.
 *
 * Speed. The correlation search is the whole cost, so it runs coarse-to-fine:
 * all +/-S candidates on a box-filtered copy decimated to ~4 kHz, then a few
 * full-rate candidates around the winner. Silent stretches skip the search.
 * 60 s of 48 kHz audio at 0.5x is ~6000 windows of ~12k multiply-adds.
 *
 * Allocation. Everything is allocated once in the constructor (output, the
 * decimated copy, four small scratch buffers); `process()` allocates nothing.
 * The input is read in place (never copied) and must not change until the
 * stretch is finished. It can run in slices (`process(maxFrames)`) so a UI
 * can yield between them. Pure: no DOM, no Web Audio.
 */

/** Supported speed range (output duration = input duration / rate). Quality falls off outside it. */
export const WSOLA_MIN_RATE = 0.25;
export const WSOLA_MAX_RATE = 2;

/**
 * Tuning defaults. These are DSP implementation constants, not analysis
 * thresholds, so they live here rather than in CONFIG (proposed home if the
 * owner wants them tunable: `CONFIG.playback.stretch`).
 */
export const WSOLA_DEFAULTS = {
  /** Window length. 40 ms spans >= 3 periods of the lowest singing pitch (E2, 12 ms) and stays shorter than a fast-run note. */
  frameMs: 40,
  /** Search radius. The 2x-radius span must cover one period of the lowest pitch so a phase-aligned candidate always exists. */
  seekMs: 10,
  /** Coarse-pass sample rate. 4 kHz keeps ~3.8 samples per period of C6 (1047 Hz); the full-rate refine fixes the rest. */
  coarseRateHz: 4000,
} as const;

export interface WsolaOptions {
  frameMs?: number;
  seekMs?: number;
  coarseRateHz?: number;
}

/** Candidates scoring within this of the best are "equally good": take the one nearest the nominal position (least timing drift). */
const NEAR_BEST_TOLERANCE = 0.01;
/** A reference slice quieter than this mean-square (~ -100 dBFS) has nothing to align to: skip the search. */
const SILENT_MEAN_SQUARE = 1e-10;
/** Added to the candidate energy so near-silent candidates cannot win by dividing by ~0. */
const ENERGY_EPSILON = 1e-9;
/** Window of the DC / rumble remover on the coarse copy, ms (see `removeLocalMean`). */
const DC_WINDOW_MS = 36;

/**
 * Subtract a centred moving average (half-width `half`) from buf[from .. from + n), in place. A DC offset or
 * sub-vocal rumble would otherwise dominate the correlation of a quiet take and make every alignment look alike.
 * The window is ~3 periods of the lowest singing pitch, so it removes under 3% of an 82 Hz fundamental.
 */
function removeLocalMean(buf: Float32Array, from: number, n: number, half: number): void {
  if (n === 0) return;
  const copy = buf.slice(from, from + n);
  let sum = 0;
  let lo = 0; //  window is copy[lo, hi)
  let hi = 0;
  for (let i = 0; i < n; i++) {
    const wantLo = Math.max(0, i - half);
    const wantHi = Math.min(n, i + half + 1);
    while (hi < wantHi) sum += copy[hi++];
    while (lo < wantLo) sum -= copy[lo++];
    buf[from + i] = copy[i] - sum / (hi - lo);
  }
}

/** Sum of a[ao+i] * b[bo+i], i < n (4 independent accumulators). */
function dot(a: Float32Array, ao: number, b: Float32Array, bo: number, n: number): number {
  let s0 = 0;
  let s1 = 0;
  let s2 = 0;
  let s3 = 0;
  const n4 = n & ~3;
  let i = 0;
  for (; i < n4; i += 4) {
    s0 += a[ao + i] * b[bo + i];
    s1 += a[ao + i + 1] * b[bo + i + 1];
    s2 += a[ao + i + 2] * b[bo + i + 2];
    s3 += a[ao + i + 3] * b[bo + i + 3];
  }
  for (; i < n; i++) s0 += a[ao + i] * b[bo + i];
  return s0 + s1 + s2 + s3;
}

/** Like `dot` over every second element (full-rate voice is oversampled, so half the samples carry the same alignment information). */
function dotEvery2(a: Float32Array, ao: number, b: Float32Array, bo: number, n: number): number {
  let s0 = 0;
  let s1 = 0;
  const lim = n - 3;
  let i = 0;
  for (; i < lim; i += 4) {
    s0 += a[ao + i] * b[bo + i];
    s1 += a[ao + i + 2] * b[bo + i + 2];
  }
  for (; i < n; i += 2) s0 += a[ao + i] * b[bo + i];
  return s0 + s1;
}

function energy(a: Float32Array, ao: number, n: number): number {
  let s = 0;
  for (let i = 0; i < n; i++) s += a[ao + i] * a[ao + i];
  return s;
}

export class WsolaStretcher {
  /** The speed actually used: the requested rate clamped to [WSOLA_MIN_RATE, WSOLA_MAX_RATE]. */
  readonly rate: number;
  /** Number of output samples the finished stretch will have: round(input.length / rate). */
  readonly outputLength: number;

  private readonly x: Float32Array;
  private readonly len: number;
  private readonly out: Float32Array;

  private readonly N: number; //   window length
  private readonly H: number; //   hop = overlap = N / 2
  private readonly S: number; //   search radius, samples
  private readonly D: number; //   coarse decimation factor
  private readonly Hd: number; //  overlap length on the coarse grid
  private readonly R: number; //   full-rate refinement radius
  private readonly frames: number;
  private readonly window: Float32Array;

  /** Box-filtered, decimated copy of the input with `padD` zeros either side (coarse index c lives at xd[c + padD]). */
  private readonly xd: Float32Array;
  private readonly padD: number;
  private readonly refD: Float32Array;
  private readonly scores: Float32Array;
  private readonly refBuf: Float32Array;
  private readonly candBuf: Float32Array;
  private readonly frameBuf: Float32Array;

  /** `view()` result: which array the last fetched region lives in (the input itself, or a zero-extended scratch copy). */
  private vbuf: Float32Array;

  private k = 0;
  private prevP = 0;

  constructor(input: Float32Array, sampleRate: number, rate: number, opts: WsolaOptions = {}) {
    if (!Number.isFinite(sampleRate) || sampleRate <= 0) throw new RangeError('WsolaStretcher: sampleRate must be positive');
    if (!Number.isFinite(rate) || rate <= 0) throw new RangeError('WsolaStretcher: rate must be positive');
    this.x = input;
    this.len = input.length;
    this.rate = Math.min(WSOLA_MAX_RATE, Math.max(WSOLA_MIN_RATE, rate));
    this.outputLength = Math.round(this.len / this.rate);
    this.out = new Float32Array(this.outputLength);

    const frameMs = opts.frameMs ?? WSOLA_DEFAULTS.frameMs;
    const seekMs = opts.seekMs ?? WSOLA_DEFAULTS.seekMs;
    const coarseHz = opts.coarseRateHz ?? WSOLA_DEFAULTS.coarseRateHz;
    this.N = Math.max(8, 2 * Math.round((frameMs / 1000) * sampleRate * 0.5));
    this.H = this.N >> 1;
    this.S = Math.max(1, Math.round((seekMs / 1000) * sampleRate));
    this.D = Math.max(1, Math.floor(sampleRate / coarseHz));
    this.Hd = Math.max(1, Math.floor(this.H / this.D));
    // The coarse winner sits within ~D/3 of the full-rate optimum. Measured against a brute-force full-rate search over
    // voice-like signals (vibrato, jitter, breath noise), this radius joins as cleanly as D/2 + 1 (join mismatch within 1%
    // and 1-8% of brute force's) for a fifth fewer refine candidates.
    this.R = Math.ceil(this.D / 3) + 1;
    this.frames = this.outputLength === 0 ? 0 : Math.floor((this.outputLength - 1) / this.H) + 2;

    const { N, H, D } = this;
    this.window = new Float32Array(N);
    for (let i = 0; i < N; i++) this.window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N); // periodic Hann: w[i] + w[i+N/2] = 1

    // Coarse copy: block means of D samples, with enough zero padding for every search window (and the reference) to stay in bounds.
    this.padD = Math.ceil((this.S + 2 * H) / D) + 4;
    const blocks = Math.ceil(this.len / D);
    this.xd = new Float32Array(blocks + 2 * this.padD + this.Hd + 4);
    const xd = this.xd;
    for (let j = 0; j < blocks; j++) {
      const start = j * D;
      const end = Math.min(start + D, this.len);
      let s = 0;
      for (let i = start; i < end; i++) s += input[i];
      xd[j + this.padD] = s / D;
    }
    removeLocalMean(xd, this.padD, blocks, Math.max(1, Math.round(((DC_WINDOW_MS / 1000) * (sampleRate / D)) / 2)));

    this.refD = new Float32Array(this.Hd);
    this.scores = new Float32Array(2 * Math.ceil(this.S / D) + 3);
    this.refBuf = new Float32Array(H);
    this.candBuf = new Float32Array(H + 2 * this.R + 2);
    this.frameBuf = new Float32Array(N);
    this.vbuf = input;
  }

  /** The stretched audio. Complete once `done` is true (before that, only the windows processed so far are in it). */
  get output(): Float32Array {
    return this.out;
  }

  get done(): boolean {
    return this.k >= this.frames;
  }

  /** 0..1 */
  get progress(): number {
    return this.frames === 0 ? 1 : Math.min(1, this.k / this.frames);
  }

  /** Process up to `maxFrames` windows (default: all of them). Returns true when the stretch is complete. */
  process(maxFrames: number = Infinity): boolean {
    const { H, N, rate, frames, out } = this;
    const outLen = this.outputLength;
    const w = this.window;
    let budget = maxFrames;
    while (this.k < frames && budget > 0) {
      const k = this.k;
      const nominal = Math.round(rate * k * H) - H;
      const p = k === 0 ? nominal : this.align(this.prevP + H, nominal);

      // Overlap-add window k at output position (k - 1) * H.
      const o0 = (k - 1) * H;
      const off = this.view(p, N, this.frameBuf);
      const src = this.vbuf;
      const iFrom = o0 < 0 ? -o0 : 0;
      const iTo = Math.min(N, outLen - o0);
      for (let i = iFrom; i < iTo; i++) out[o0 + i] += w[i] * src[off + i];

      this.prevP = p;
      this.k = k + 1;
      budget--;
    }
    return this.k >= frames;
  }

  /**
   * Zero-extended view of x[a .. a + n): returns an offset into `this.vbuf`,
   * which is the input itself when the whole region is inside it (no copy) and
   * otherwise `scratch` holding a zero-padded copy. Only the first and last
   * few windows ever take the copy path.
   */
  private view(a: number, n: number, scratch: Float32Array): number {
    if (a >= 0 && a + n <= this.len) {
      this.vbuf = this.x;
      return a;
    }
    const x = this.x;
    const lo = Math.max(0, a);
    const hi = Math.min(this.len, a + n);
    scratch.fill(0, 0, n);
    for (let i = lo; i < hi; i++) scratch[i - a] = x[i];
    this.vbuf = scratch;
    return 0;
  }

  /**
   * Input position near `nominal` (within +/- S) whose next H samples best
   * continue `ref`, the H samples starting at `refPos`: the previous window's
   * second half. Coarse search on the decimated copy, then a full-rate refine.
   */
  private align(refPos: number, nominal: number): number {
    const { H, D, Hd, S, R, padD, xd, refD, scores } = this;

    const refOff = this.view(refPos, H, this.refBuf);
    const ref = this.vbuf;
    if (energy(ref, refOff, H) < SILENT_MEAN_SQUARE * H) return nominal; // nothing to align to

    // Coarse reference: block means at the reference's exact phase.
    let refE = 0;
    for (let j = 0; j < Hd; j++) {
      let s = 0;
      const b = refOff + j * D;
      for (let m = 0; m < D; m++) s += ref[b + m];
      s /= D;
      refD[j] = s;
      refE += s * s;
    }
    const refNorm = 1 / Math.sqrt(refE + ENERGY_EPSILON * Hd);

    // Coarse candidates c: full-rate start c * D, within [nominal - S, nominal + S].
    const cLo = Math.ceil((nominal - S) / D);
    const cHi = Math.floor((nominal + S) / D);
    const count = cHi - cLo + 1;
    let e = energy(xd, cLo + padD, Hd);
    let best = -Infinity;
    for (let n = 0; n < count; n++) {
      const base = cLo + n + padD;
      const score = (dot(refD, 0, xd, base, Hd) * refNorm) / Math.sqrt(e + ENERGY_EPSILON * Hd);
      scores[n] = score;
      if (score > best) best = score;
      const drop = xd[base];
      const gain = xd[base + Hd];
      e += gain * gain - drop * drop;
      if (e < 0) e = 0;
    }
    // Among the near-best, the candidate closest to the nominal position.
    const centre = nominal / D - cLo;
    let pick = 0;
    let pickDist = Infinity;
    const floor = best - NEAR_BEST_TOLERANCE;
    for (let n = 0; n < count; n++) {
      if (scores[n] < floor) continue;
      const dist = Math.abs(n - centre);
      if (dist < pickDist) {
        pickDist = dist;
        pick = n;
      }
    }
    const coarsePos = (cLo + pick) * D;

    // Full-rate refine around the coarse winner. The correlation uses every second sample (ample for band-limited
    // voice); the candidate energy is the exact full-window running sum, which rescales every score by the same ~2x.
    const lo = coarsePos - R;
    const width = 2 * R + 1;
    const candOff = this.view(lo, H + width - 1, this.candBuf);
    const cand = this.vbuf;
    let ce = energy(cand, candOff, H);
    let bestScore = -Infinity;
    let bestPos = coarsePos;
    for (let j = 0; j < width; j++) {
      const score = dotEvery2(ref, refOff, cand, candOff + j, H) / Math.sqrt(ce + ENERGY_EPSILON * H);
      if (score > bestScore) {
        bestScore = score;
        bestPos = lo + j;
      }
      const drop = cand[candOff + j];
      const gain = cand[candOff + j + H];
      ce += gain * gain - drop * drop;
      if (ce < 0) ce = 0;
    }
    return bestPos;
  }
}

/**
 * Stretch `input` (mono) to `rate` times its speed, keeping its pitch.
 * `rate` 0.5 = half speed (twice as long). Clamped to
 * [WSOLA_MIN_RATE, WSOLA_MAX_RATE]. Returns a new Float32Array of
 * `round(input.length / rate)` samples; rate 1 returns a plain copy.
 * One-shot convenience over `WsolaStretcher`.
 */
export function timeStretch(input: Float32Array, sampleRate: number, rate: number, opts?: WsolaOptions): Float32Array {
  if (Math.abs(rate - 1) < 1e-9) return input.slice();
  const s = new WsolaStretcher(input, sampleRate, rate, opts);
  s.process();
  return s.output;
}
