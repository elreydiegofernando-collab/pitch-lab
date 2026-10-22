/**
 * Dashboard: Momentum, level-map completion, a 30-day trend per unlocked skill, the range over time, personal bests
 * and practice minutes (SPEC §12, DESIGN.md §13.10). Everything is derived from the attempt log and the progress
 * snapshot (src/ui/progress/dashboard-model.ts); locked skills are not shown at all.
 */
import { useMemo } from 'preact/hooks';
import type { JSX } from 'preact';
import { TrendingUp } from 'lucide-preact';
import { back } from '../../router';
import { WORLDS } from '../../exercises';
import { requirementHint, worldRequirementHint } from '../../progress';
import { activeProfile, attemptLog, isUnlocked, snapshot } from '../../state/session';
import { settings } from '../../state/settings';
import { AppBar } from '../components/AppBar';
import { Locked } from '../components/Locked';
import { buildDashboard } from '../progress/dashboard-model';
import { BestsCard, LevelsCard, MomentumCard, PracticeCard, RangeCard, SkillsCard } from '../progress/dashboard-sections';

export function Dashboard(): JSX.Element {
  const attempts = attemptLog.value;
  const snap = snapshot.value;
  const open = isUnlocked('dashboard');
  const model = useMemo(
    () => (open ? buildDashboard({ attempts, snapshot: snap, worlds: WORLDS, now: Date.now(), utcOffsetMinutes: -new Date().getTimezoneOffset() }) : null),
    [open, attempts, snap],
  );

  return (
    <div class="pl-screen" data-testid="dashboard-screen">
      <AppBar title="Progress" routeIcon={TrendingUp} onBack={() => back()} />
      <div class="pl-scroll">
        <div class="pl-page pl-dash">
          {model === null ? (
            <Locked title="Progress dashboard" hint={requirementHint('dashboard')} />
          ) : (
            <>
              <MomentumCard view={model.momentum} />
              <LevelsCard completion={model.completion} lockedHint={model.nextLocked ? worldRequirementHint(model.nextLocked.id, snap, WORLDS) : null} />
              <SkillsCard trends={model.skills} todayIndex={model.todayIndex} />
              <RangeCard points={model.range} range={activeProfile.value?.range ?? null} notation={settings.value.notation} />
              <BestsCard bests={model.bests} lockedHint={requirementHint('records')} />
              <PracticeCard weeks={model.practice} />
            </>
          )}
        </div>
      </div>
    </div>
  );
}
