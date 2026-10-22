import { describe, expect, it } from 'vitest';
import type { RunError, RunPhase } from '../../runtime/types';
import { isRetryable, singControls } from './sing-controls';

const MIC: RunError = { code: 'mic', message: 'blocked' };
const LOCKED: RunError = { code: 'locked', message: 'not yet' };

describe('singControls', () => {
  it('is Listen and Sing while idle, and Stop for the demo while it plays (Sing stays available)', () => {
    const idle = singControls('idle', true, null);
    expect(idle.listen).toEqual({ label: 'Listen', disabled: false });
    expect(idle.primary).toEqual({ kind: 'sing', label: 'Sing', disabled: false });
    expect(idle.moreDisabled).toBe(false);
    const demo = singControls('listening', true, null);
    expect(demo.listen).toEqual({ label: 'Stop', disabled: false });
    expect(demo.primary).toEqual({ kind: 'sing', label: 'Sing', disabled: false });
  });

  it('waits with "Starting…" while the microphone opens', () => {
    const c = singControls('starting', true, null);
    expect(c.primary).toEqual({ kind: 'busy', label: 'Starting…', disabled: true });
    expect(c.listen.disabled).toBe(true);
    expect(c.moreDisabled).toBe(true);
  });

  it('turns Sing into Stop through the count-in and the take, and locks the rest', () => {
    for (const phase of ['count-in', 'singing'] as const) {
      const c = singControls(phase, true, null);
      expect(c.primary).toEqual({ kind: 'stop', label: 'Stop', disabled: false });
      expect(c.listen.disabled).toBe(true);
      expect(c.moreDisabled).toBe(true);
    }
  });

  it('says "Scoring…" with a spinner while the take is judged', () => {
    for (const phase of ['analyzing', 'done'] as const) {
      const c = singControls(phase, true, null);
      expect(c.primary).toEqual({ kind: 'busy', label: 'Scoring…', disabled: true });
    }
  });

  it('offers "Try again" after a failure a second try can fix, and nothing after one it cannot', () => {
    expect(singControls('error', true, MIC).primary).toEqual({ kind: 'retry', label: 'Try again', disabled: false });
    expect(singControls('error', true, MIC).listen.disabled).toBe(false);
    expect(singControls('error', false, LOCKED).primary.disabled).toBe(true);
    expect(singControls('error', false, LOCKED).listen.disabled).toBe(true);
  });

  it('disables Sing and Listen until the exercise is prepared', () => {
    const c = singControls('idle', false, null);
    expect(c.primary.disabled).toBe(true);
    expect(c.listen.disabled).toBe(true);
  });

  it('only a stuck error (locked or unknown) is not retryable', () => {
    expect(isRetryable(null)).toBe(false);
    for (const code of ['mic', 'interrupted', 'save-failed', 'internal'] as const) expect(isRetryable({ code, message: '' })).toBe(true);
    for (const code of ['locked', 'unknown'] as const) expect(isRetryable({ code, message: '' })).toBe(false);
  });

  it('covers every phase', () => {
    const phases: RunPhase[] = ['idle', 'listening', 'starting', 'count-in', 'singing', 'analyzing', 'done', 'error'];
    for (const phase of phases) expect(singControls(phase, true, MIC).primary.label.length).toBeGreaterThan(0);
  });
});
