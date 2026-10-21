import { describe, expect, it } from 'vitest';
import { RecordingAssembler } from './recorder';

describe('RecordingAssembler', () => {
  it('returns an empty Recording when nothing was added', () => {
    const rec = new RecordingAssembler().finish(48000);
    expect(rec.samples.length).toBe(0);
    expect(rec.sampleRate).toBe(48000);
    expect(rec.startTime).toBe(0);
  });

  it('concatenates contiguous chunks in order', () => {
    const a = new RecordingAssembler();
    a.add(0, new Float32Array([1, 2, 3]));
    a.add(3, new Float32Array([4, 5]));
    const rec = a.finish(48000);
    expect(Array.from(rec.samples)).toEqual([1, 2, 3, 4, 5]);
    expect(rec.startTime).toBe(0);
  });

  it('sorts chunks that arrive out of order', () => {
    const a = new RecordingAssembler();
    a.add(3, new Float32Array([4, 5]));
    a.add(0, new Float32Array([1, 2, 3]));
    const rec = a.finish(48000);
    expect(Array.from(rec.samples)).toEqual([1, 2, 3, 4, 5]);
  });

  it('zero-fills a gap between chunks', () => {
    const a = new RecordingAssembler();
    a.add(0, new Float32Array([1, 2]));
    a.add(5, new Float32Array([9, 9])); // samples 2..4 missing
    const rec = a.finish(48000);
    expect(Array.from(rec.samples)).toEqual([1, 2, 0, 0, 0, 9, 9]);
  });

  it('sets startTime from the first chunk\'s frame0 and the given sampleRate', () => {
    const a = new RecordingAssembler();
    a.add(4800, new Float32Array([1, 2]));
    const rec = a.finish(48000);
    expect(rec.startTime).toBeCloseTo(0.1, 10);
  });

  it('is unaffected by a frame0 == 0 chunk added after a later one', () => {
    const a = new RecordingAssembler();
    a.add(10, new Float32Array([1]));
    a.add(0, new Float32Array([2]));
    a.add(20, new Float32Array([3]));
    const rec = a.finish(44100);
    expect(Array.from(rec.samples)).toEqual([2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 3]);
    expect(rec.startTime).toBe(0);
  });
});
