import type { Link } from './types';

/** "since 2008", "2015 – 2018", "until 2018", "" */
export function years(l: Pick<Link, 'since' | 'until'>): string {
  if (l.since && l.until) return l.since === l.until ? String(l.since) : `${l.since} – ${l.until}`;
  if (l.since) return `since ${l.since}`;
  if (l.until) return `until ${l.until}`;
  return '';
}

export const isPast = (l: Link): boolean => l.until !== undefined && l.until !== null;

export function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toISOString().slice(0, 10);
}

export const plural = (n: number, one: string, many = one + 's'): string =>
  `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;
