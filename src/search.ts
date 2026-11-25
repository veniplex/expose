import type { Entity } from './types';
import type { GraphIndex } from './data';

/** Lower-case, strip diacritics and punctuation, collapse whitespace. */
export function normalize(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** true when the letters of `q` appear in order within `s` (loose fuzzy match). */
function subsequence(q: string, s: string): boolean {
  let i = 0;
  for (let j = 0; j < s.length && i < q.length; j++) if (s[j] === q[i]) i++;
  return i === q.length;
}

/**
 * Rank entities for a query: exact > prefix > token-prefix > all-tokens > substring > fuzzy,
 * ties broken by influence. `demote(e)` true pushes an entity down (e.g. its type is hidden),
 * but it still matches.
 */
export function search(
  index: GraphIndex,
  query: string,
  limit = 8,
  demote: (e: Entity) => boolean = () => false,
): Entity[] {
  const q = normalize(query);
  if (!q) return [];
  const qTokens = q.split(' ');
  const scored: { e: Entity; s: number }[] = [];
  const score = (key: string): number => {
    const tokens = key.split(' ');
    if (key === q) return 100;
    if (key.startsWith(q)) return 80;
    if (tokens.some((t) => t.startsWith(q))) return 65;
    if (qTokens.length > 1 && qTokens.every((qt) => tokens.some((t) => t.startsWith(qt)))) return 55;
    if (key.includes(q)) return 40;
    if (q.length >= 3 && subsequence(q.replace(/ /g, ''), key.replace(/ /g, ''))) return 10;
    return 0;
  };
  index.entities.forEach((e, i) => {
    let s = score(index.searchKeys[i]);
    // Aliases (former names etc.) match slightly weaker than the name; no fuzzy matching on them.
    for (const a of e.aliases ?? []) {
      const as = score(normalize(a));
      if (as >= 40) s = Math.max(s, as - 5);
    }
    if (s) scored.push({ e, s: s + 9 * (index.influence.get(e.id) ?? 0) - (demote(e) ? 30 : 0) });
  });
  scored.sort((a, b) => b.s - a.s || a.e.name.localeCompare(b.e.name));
  return scored.slice(0, limit).map((x) => x.e);
}
