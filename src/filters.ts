import type { Link } from './types';
import type { GraphIndex } from './data';
import type { State } from './store';
import { isPast } from './format';

/** Is the entity's kind shown? The selected entity always stays visible. */
export function entityVisible(index: GraphIndex, id: string, s: State): boolean {
  if (id === s.selected) return true;
  const e = index.byId.get(id);
  return !!e && s.kinds.has(e.kind);
}

/** A link is visible when its category is on, it passes the past filter and both ends are shown. */
export function linkVisible(index: GraphIndex, l: Link, s: State): boolean {
  return (
    s.categories.has(l.category) &&
    (s.includePast || !isPast(l)) &&
    entityVisible(index, l.a, s) &&
    entityVisible(index, l.b, s)
  );
}

export function visibleLinks(index: GraphIndex, links: Link[], s: State): Link[] {
  return links.filter((l) => linkVisible(index, l, s));
}
