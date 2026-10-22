/**
 * Plain-text formatters shared by the progress screens: sizes, durations, dates, names. Pure.
 * Dates are shown in the viewer's locale and zone; a "YYYY-MM-DD" day key is a calendar day and never shifts.
 */
import type { ProfileRecord, VocalRange } from '../../storage/schema';
import { noteName, type Notation } from '../../core/music';

const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB'] as const;

/** "512 B", "3.4 KB", "12.3 MB", "120 MB", "1.2 GB". Null, NaN or negative input gives "––". */
export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return '––';
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  let value = bytes / 1024;
  let unit = 1;
  // Step up a unit when the one-decimal reading would be "1024.0".
  while (unit < BYTE_UNITS.length - 1 && Math.round(value * 10) / 10 >= 1024) {
    value /= 1024;
    unit += 1;
  }
  const text = value >= 100 ? String(Math.round(value)) : value.toFixed(1);
  return `${text} ${BYTE_UNITS[unit]}`;
}

/** "42 min", "1 h 05 min", "<1 min", "0 min". */
export function formatMinutes(minutes: number): string {
  if (!Number.isFinite(minutes) || minutes <= 0) return '0 min';
  if (minutes < 1) return '<1 min';
  const total = Math.round(minutes);
  if (total < 60) return `${total} min`;
  const hours = Math.floor(total / 60);
  const rest = total % 60;
  return rest === 0 ? `${hours} h` : `${hours} h ${String(rest).padStart(2, '0')} min`;
}

/** "1:05" from a number of seconds (a take's length). */
export function formatClock(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const whole = Math.round(seconds);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
}

const DAY_FORMAT = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });
const DATE_FORMAT = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
const DATE_TIME_FORMAT = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

/** "Oct 21" from a "YYYY-MM-DD" day key; anything else comes back unchanged. */
export function formatDayKey(key: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
  if (!m) return key;
  return DAY_FORMAT.format(new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))));
}

/** "Oct 21, 2026" from an ISO time; "Unknown date" when it does not parse. */
export function formatDate(iso: string): string {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? DATE_FORMAT.format(new Date(ms)) : 'Unknown date';
}

/** "Oct 21, 3:42 PM" from an ISO time; "Unknown date" when it does not parse. */
export function formatDateTime(iso: string): string {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? DATE_TIME_FORMAT.format(new Date(ms)) : 'Unknown date';
}

/** "YYYY-MM-DD" of an ISO time in the viewer's own zone (a take sung at 8 PM belongs to that evening, not to tomorrow in UTC). */
export function localDateStamp(iso: string | Date): string {
  const d = typeof iso === 'string' ? new Date(iso) : iso;
  if (!Number.isFinite(d.getTime())) return 'unknown-date';
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * A Date whose UTC calendar day is the viewer's local one. `backup.fileName(when)` names the file by the UTC day,
 * so hand it this and an evening backup is dated that evening.
 */
export function asLocalDay(when: Date = new Date()): Date {
  return new Date(when.getTime() - when.getTimezoneOffset() * 60_000);
}

/** "1 profile", "2 profiles". */
export function plural(count: number, singular: string, pluralForm: string = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

/** The message of a thrown value, for showing next to the thing that failed. */
export function errorText(err: unknown): string {
  const text = err instanceof Error ? err.message : typeof err === 'string' ? err : '';
  return text || 'Something went wrong.';
}

const VOICE_LABELS: Readonly<Record<ProfileRecord['voiceType'], string>> = {
  tenor: 'Tenor',
  baritone: 'Baritone',
  other: 'Other',
  unknown: 'Not sure',
};

export function voiceTypeLabel(voiceType: ProfileRecord['voiceType']): string {
  return VOICE_LABELS[voiceType] ?? VOICE_LABELS.unknown;
}

/** "C3–A4" for a saved range's comfortable band; "Range not measured" before the Range finder is passed. */
export function rangeLabel(range: VocalRange | null, notation: Notation): string {
  if (!range) return 'Range not measured';
  return `${noteName(range.comfortable.low, notation)}–${noteName(range.comfortable.high, notation)}`;
}

/** Collapses runs of whitespace and trims: how typed confirmations are compared. */
export function squash(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}
