/**
 * The world map's data (docs/DESIGN.md 13.2): every world in catalog order with its nodes, requirement lines and
 * audition row, derived from one progress snapshot. Pure: all gating answers come from src/progress (the single
 * gate), so a locked node can only ever be a static line.
 */
import type { LevelDef, WorldDef } from '../../exercises/types';
import {
  auditionRequirementHint,
  currentLevelOf,
  isAuditionAvailable,
  isFeatureUnlocked,
  isLevelOpenable,
  isWorldUnlocked,
  levelRequirementHint,
  levelStatus,
  requirementHint,
  worldRequirementHint,
  type LevelStatus,
  type Mastery,
  type ProgressSnapshot,
} from '../../progress';
import { buildTests, reachLabel, testsLeft } from './audition-model';
import { orderedLevels } from './levels';

export interface NodeModel {
  level: LevelDef;
  /** 1-based place in the world; the Boss Recital is last. */
  number: number;
  boss: boolean;
  state: LevelStatus;
  /** The registry opens it (isLevelOpenable): only such a node is a button. */
  openable: boolean;
  /** Best score 0..1; null when the level was never scored. */
  best: number | null;
  mastery: Mastery;
  attempts: number;
  viaAudition: boolean;
  /** The requirement line of a locked node; null otherwise. */
  hint: string | null;
  /** The cable is lit between this node and the one before it / after it (lit up to where the singer is). */
  litAbove: boolean;
  litBelow: boolean;
}

export type AuditionRowModel =
  /** `tests` still have something to open; `reach` says how far ("Pitch match – Legato lines"). */
  | { kind: 'available'; tests: number; reach: string | null }
  | { kind: 'locked'; hint: string };

export interface WorldModel {
  world: WorldDef;
  /** 1-based place among all worlds ("02"). */
  number: number;
  /** A world with a level ladder; Song Stage has none (it is a row to the song library). */
  ladder: boolean;
  open: boolean;
  nodes: NodeModel[];
  /** Level titles in order (a closed world lists them without nodes). */
  titles: string[];
  passed: number;
  total: number;
  /** How to open a closed world; null when it is open. */
  hint: string | null;
  /** The placement-audition row of an open world; null when it has none or nothing is left to open. */
  audition: AuditionRowModel | null;
  /** The level in progress; null when closed or finished. */
  current: LevelDef | null;
}

function auditionRow(world: WorldDef, snapshot: ProgressSnapshot, worlds: readonly WorldDef[]): AuditionRowModel | null {
  if (!world.audition) return null;
  if (isAuditionAvailable(world.id, snapshot, worlds)) {
    const tests = buildTests(world, snapshot, worlds);
    return { kind: 'available', tests: testsLeft(tests), reach: reachLabel(tests) };
  }
  const hint = auditionRequirementHint(world.id, snapshot, worlds);
  return hint ? { kind: 'locked', hint } : null;
}

function buildNodes(world: WorldDef, snapshot: ProgressSnapshot, worlds: readonly WorldDef[]): NodeModel[] {
  const levels = orderedLevels(world);
  const states = levels.map((l) => levelStatus(l.id, snapshot));
  return levels.map((level, i) => {
    const progress = snapshot.levels[level.id];
    const state = states[i];
    return {
      level,
      number: i + 1,
      boss: level.kind === 'boss',
      state,
      openable: isLevelOpenable(level.id, snapshot),
      best: progress && progress.bestScore > 0 ? progress.bestScore : null,
      mastery: progress?.mastery ?? 0,
      attempts: progress?.attempts ?? 0,
      viaAudition: progress?.viaAudition ?? false,
      hint: state === 'locked' ? levelRequirementHint(level.id, snapshot, worlds) : null,
      litAbove: i > 0 && state !== 'locked',
      litBelow: i < levels.length - 1 && states[i + 1] !== 'locked',
    };
  });
}

function buildWorld(world: WorldDef, number: number, snapshot: ProgressSnapshot, worlds: readonly WorldDef[]): WorldModel {
  const ladder = world.levels.length > 0;
  // Song Stage opens with the same registry feature the route guard checks.
  const open = ladder ? isWorldUnlocked(world.id, snapshot) : isFeatureUnlocked('song-stage', snapshot);
  const nodes = ladder && open ? buildNodes(world, snapshot, worlds) : [];
  return {
    world,
    number,
    ladder,
    open,
    nodes,
    titles: orderedLevels(world).map((l) => l.title),
    passed: nodes.filter((n) => n.state === 'passed').length,
    total: world.levels.length,
    hint: open ? null : ladder ? worldRequirementHint(world.id, snapshot, worlds) : requirementHint('song-stage'),
    audition: open ? auditionRow(world, snapshot, worlds) : null,
    current: open ? currentLevelOf(world.id, snapshot, worlds) : null,
  };
}

/** Every world of the catalog, in order, as the map shows it. */
export function buildMapModel(snapshot: ProgressSnapshot, worlds: readonly WorldDef[]): WorldModel[] {
  return worlds.map((world, i) => buildWorld(world, i + 1, snapshot, worlds));
}
