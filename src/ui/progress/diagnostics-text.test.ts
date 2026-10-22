import { describe, expect, it } from 'vitest';
import { BACKEND_LABEL, describeReconcile, skipText } from './diagnostics-text';

describe('describeReconcile', () => {
  it('says when the startup check has not run yet', () => {
    const r = describeReconcile(null);
    expect(r.value).toBe('Not run yet');
    expect(r.detail).toContain('once per launch');
  });

  it('shows the skip reason code and explains it in plain words', () => {
    const r = describeReconcile({ orphanFilesRemoved: 0, danglingTakes: 0, danglingSongs: 0, skipped: 'db-not-durable' });
    expect(r.value).toBe('Skipped: db-not-durable');
    expect(r.detail).toContain('left everything alone');
  });

  it('explains every skip reason', () => {
    for (const reason of ['db-not-durable', 'binaries-not-durable', 'backend-changed'] as const) {
      expect(skipText(reason).length).toBeGreaterThan(20);
    }
  });

  it('counts what a normal pass repaired', () => {
    const r = describeReconcile({ orphanFilesRemoved: 2, danglingTakes: 1, danglingSongs: 0 });
    expect(r.value).toBe('Done');
    expect(r.detail).toBe('2 stray files removed · 1 take that lost audio · 0 songs that lost a backing track');
  });
});

describe('BACKEND_LABEL', () => {
  it('names every binary backend', () => {
    expect(Object.keys(BACKEND_LABEL).sort()).toEqual(['idb-blob', 'memory', 'opfs']);
  });
});
