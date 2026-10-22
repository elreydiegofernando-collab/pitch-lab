/** Formatting for the Song Stage screens (DESIGN.md §13.0 numbers: "86%", "1:40", "F3–A4", "+2"). */
import { noteName, type Notation } from '../../core/music';
import { WORLDS } from '../../exercises';
import type { WorldDef, WorldId } from '../../exercises/types';

/** "1:40" */
export function formatClock(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** "F3–A4" (one note when both ends are the same). */
export function formatRange(low: number, high: number, notation: Notation): string {
  const lo = noteName(Math.round(low), notation);
  return Math.round(low) === Math.round(high) ? lo : `${lo}–${noteName(Math.round(high), notation)}`;
}

/** "86%" from 0..1. */
export function formatPercent(fraction: number): string {
  return `${Math.round(Math.max(0, Math.min(1, fraction)) * 100)}%`;
}

/** "+2", "0", "−3" (a true minus sign). */
export function formatShift(semis: number): string {
  if (semis === 0) return '0';
  return semis > 0 ? `+${semis}` : `−${-semis}`;
}

/** "Up 2 semitones" for screen readers. */
export function describeShift(semis: number): string {
  if (semis === 0) return 'Original key';
  const n = Math.abs(semis);
  return `${semis > 0 ? 'Up' : 'Down'} ${n} semitone${n === 1 ? '' : 's'}`;
}

/** Facts on one line, "F3–A4 · 1:40", spaced so the dot reads as a separator in any font. */
export function factLine(parts: readonly string[]): string {
  return parts.join(' · ');
}

/** "1 phrase", "6 phrases". */
export function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}

/** Two-digit setlist number: "01". */
export function setlistNumber(n: number): string {
  return String(n).padStart(2, '0');
}

export function worldOf(id: WorldId): WorldDef | undefined {
  return WORLDS.find((w) => w.id === id);
}

/** The world's place in the unlock order (unknown worlds last). */
export function worldRank(id: WorldId): number {
  const i = WORLDS.findIndex((w) => w.id === id);
  return i < 0 ? WORLDS.length : i;
}
