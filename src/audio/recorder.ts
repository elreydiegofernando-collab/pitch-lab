/**
 * Assembles the worklet's `record-chunk` messages (src/audio/protocol.ts)
 * into one contiguous `Recording` (src/audio/engine-types.ts). Chunks carry
 * the AudioContext sample-frame index of their first sample, so they are
 * sorted into order and any gap (a dropped render quantum, or a brief
 * interruption while recording) is left zero-filled rather than causing a
 * click or a time-base error.
 *
 * Not a hot path (chunks arrive at the hop rate, on the main thread), so
 * `add()` may allocate a small record per chunk; `finish()` does the one
 * larger allocation for the merged buffer.
 */
import type { Recording } from './engine-types';

interface Chunk {
  frame0: number;
  samples: Float32Array;
}

export class RecordingAssembler {
  private readonly chunks: Chunk[] = [];

  add(frame0: number, samples: Float32Array): void {
    this.chunks.push({ frame0, samples });
  }

  /** Merges all added chunks into one Recording at `sampleRate`. Empty input yields an empty Recording. */
  finish(sampleRate: number): Recording {
    if (this.chunks.length === 0) {
      return { samples: new Float32Array(0), sampleRate, startTime: 0 };
    }

    const sorted = [...this.chunks].sort((a, b) => a.frame0 - b.frame0);
    const startFrame = sorted[0].frame0;
    let endFrame = startFrame;
    for (const chunk of sorted) {
      const chunkEnd = chunk.frame0 + chunk.samples.length;
      if (chunkEnd > endFrame) endFrame = chunkEnd;
    }

    const out = new Float32Array(endFrame - startFrame); // zero-filled: gaps stay silent
    for (const chunk of sorted) {
      out.set(chunk.samples, chunk.frame0 - startFrame);
    }

    return { samples: out, sampleRate, startTime: startFrame / sampleRate };
  }
}
