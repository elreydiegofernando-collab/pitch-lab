/**
 * Which voice check-up card Home shows, and where: a new profile starts with the check-up (above Continue), a profile
 * that has sung but never took one is invited, a half-finished one is picked up, a re-check is suggested after three
 * weeks, and otherwise the latest results are one tap away.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../state/session', async () => (await import('./test-support')).sessionModule());
vi.mock('../../state/settings', async () => (await import('./test-support')).settingsDouble());
vi.mock('../../runtime/checkup', async () => (await import('./test-support')).checkupRuntimeModule());
vi.mock('../../checkup/summary', async () => (await import('./test-support')).summaryModule());

import { recheckDue } from '../../checkup/summary';
import { homeCard } from './home-card';
import { sessionOf, summaryOf } from './test-support';

const NOW = Date.parse('2026-10-22T12:00:00.000Z');
const none = { summaries: [], session: null, hasSung: false, now: NOW } as const;

beforeEach(() => {
  vi.mocked(recheckDue).mockClear();
});

describe('homeCard', () => {
  it('starts a profile that has sung nothing with the check-up, above Continue', () => {
    expect(homeCard(none)).toEqual({ kind: 'first', latest: null, session: null, days: 0, above: true });
  });

  it('invites a profile that has sung but has no check-up, just under Continue', () => {
    expect(homeCard({ ...none, hasSung: true })).toEqual({ kind: 'take', latest: null, session: null, days: 0, above: false });
  });

  it('picks up a check-up left part way, above Continue like a new start', () => {
    const part = sessionOf(2);
    const card = homeCard({ ...none, hasSung: true, session: part });
    expect(card.kind).toBe('continue');
    expect(card.session).toBe(part);
    expect(card.above).toBe(true);
  });

  it('does not treat an empty, finished or fully sung session as part way', () => {
    expect(homeCard({ ...none, session: sessionOf(0) }).kind).toBe('first');
    expect(homeCard({ ...none, hasSung: true, session: sessionOf(5) }).kind).toBe('take');
    expect(homeCard({ ...none, hasSung: true, session: sessionOf(3, { finishedAt: '2026-10-22T14:05:00.000Z' }) }).kind).toBe('take');
  });

  it('suggests a re-check once the last check-up is three weeks old, saying how long it has been', () => {
    const old = summaryOf('old', { daysAgo: 24, now: NOW });
    const card = homeCard({ ...none, hasSung: true, summaries: [summaryOf('older', { daysAgo: 60, now: NOW }), old] });
    expect(card).toMatchObject({ kind: 'recheck', days: 24, above: false });
    expect(card.latest).toBe(old);
  });

  it('links to the latest results while a re-check is not due', () => {
    const recent = summaryOf('recent', { daysAgo: 5, now: NOW });
    const card = homeCard({ ...none, hasSung: true, summaries: [summaryOf('older', { daysAgo: 60, now: NOW }), recent] });
    expect(card).toMatchObject({ kind: 'latest', days: 5, above: false });
    expect(card.latest).toBe(recent);
  });

  it('puts a half-finished check-up before a re-check or the latest results', () => {
    const card = homeCard({ ...none, hasSung: true, summaries: [summaryOf('old', { daysAgo: 40, now: NOW })], session: sessionOf(1) });
    expect(card.kind).toBe('continue');
  });

  it('asks the engine when a re-check is due, and trusts a "no" it cannot give (a re-check is only a suggestion)', () => {
    vi.mocked(recheckDue).mockImplementationOnce(() => {
      throw new Error('cannot tell');
    });
    const card = homeCard({ ...none, hasSung: true, summaries: [summaryOf('old', { daysAgo: 90, now: NOW })] });
    expect(card.kind).toBe('latest');
  });
});
