import type { EntityKind, LinkCategory } from './types';
import { CATEGORIES } from './config';
import { ALL_KINDS } from './kinds';

export interface State {
  /** selected entity id (mirrors the URL hash #/e/<id>) */
  selected: string | null;
  /** expanded connection row (row key, see rowKey()) — its arc is highlighted */
  expanded: string | null;
  /** entity under the pointer on the globe, or hovered in a list */
  hoverEntity: string | null;
  /** connection row under the pointer (row key) */
  hoverRow: string | null;
  categories: Set<LinkCategory>;
  includePast: boolean;
  /** entity kinds shown on the globe and in lists */
  kinds: Set<EntityKind>;
}

type Listener = (s: State, changed: Set<keyof State>) => void;

const ALL_CATS = CATEGORIES.map((c) => c.id);
const STORAGE_KEY = 'expose.filters.v1';

interface FilterState {
  categories: Set<LinkCategory>;
  includePast: boolean;
  kinds: Set<EntityKind>;
}

/** "?types=person,fund&links=ownership&past=0" — only non-default parts are written. */
function encodeFilters(f: FilterState): string {
  const q: string[] = [];
  if (f.kinds.size !== ALL_KINDS.length) q.push(`types=${ALL_KINDS.filter((k) => f.kinds.has(k)).join(',') || 'none'}`);
  if (f.categories.size !== ALL_CATS.length)
    q.push(`links=${ALL_CATS.filter((c) => f.categories.has(c)).join(',') || 'none'}`);
  if (!f.includePast) q.push('past=0');
  return q.length ? `?${q.join('&')}` : '';
}

/** Parse a filter query; returns null when it carries no filter keys at all. */
function decodeFilters(query: string): FilterState | null {
  const p = new URLSearchParams(query);
  if (!p.has('types') && !p.has('links') && !p.has('past')) return null;
  const list = <T extends string>(key: string, all: T[]): Set<T> => {
    const v = p.get(key);
    if (v === null) return new Set(all);
    return new Set(v.split(',').filter((x): x is T => (all as string[]).includes(x)));
  };
  return { kinds: list('types', ALL_KINDS), categories: list('links', ALL_CATS), includePast: p.get('past') !== '0' };
}

function loadStored(): FilterState | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? decodeFilters(raw) : null;
  } catch {
    return null;
  }
}

function saveStored(f: FilterState): void {
  try {
    const q = encodeFilters(f);
    if (q) localStorage.setItem(STORAGE_KEY, q.slice(1));
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* storage unavailable (private mode, blocked) — the URL still carries the filters */
  }
}

const sameSet = <T>(a: Set<T>, b: Set<T>) => a.size === b.size && [...a].every((x) => b.has(x));

/**
 * Minimal observable store with URL-hash sync: `#/e/<id>` for the selection plus an optional
 * filter query (`#/e/<id>?types=…&links=…&past=0`). Filters are also kept in localStorage.
 */
export class Store {
  state: State = {
    selected: null,
    expanded: null,
    hoverEntity: null,
    hoverRow: null,
    categories: new Set(ALL_CATS),
    includePast: true,
    kinds: new Set(ALL_KINDS),
  };
  private listeners: Listener[] = [];
  private isValid: (id: string) => boolean = () => true;

  subscribe(fn: Listener): void {
    this.listeners.push(fn);
  }

  set(patch: Partial<State>): void {
    const changed = new Set<keyof State>();
    for (const k of Object.keys(patch) as (keyof State)[]) {
      if (this.state[k] !== patch[k]) changed.add(k);
    }
    if (!changed.size) return;
    this.state = { ...this.state, ...patch };
    if (changed.has('categories') || changed.has('includePast') || changed.has('kinds')) this.persistFilters();
    for (const fn of this.listeners) fn(this.state, changed);
  }

  toggleCategory(c: LinkCategory): void {
    const next = new Set(this.state.categories);
    if (next.has(c)) next.delete(c);
    else next.add(c);
    this.set({ categories: next });
  }

  toggleKind(k: EntityKind): void {
    const next = new Set(this.state.kinds);
    if (next.has(k)) next.delete(k);
    else next.add(k);
    this.set({ kinds: next });
  }

  /** Make sure kind `k` is shown (e.g. after picking a hidden-type entity in search). */
  ensureKind(k: EntityKind): void {
    if (!this.state.kinds.has(k)) this.toggleKind(k);
  }

  /** Navigate to an entity (pushes a history entry). `null` returns to the overview. */
  select(id: string | null): void {
    const hash = (id ? `#/e/${encodeURIComponent(id)}` : '#/') + encodeFilters(this.state);
    if (location.hash !== hash) location.hash = hash;
    else this.applyHash();
  }

  /** Start listening to hash changes; applies the current hash (and stored filters) immediately. */
  initRouting(isValid: (id: string) => boolean): void {
    this.isValid = isValid;
    window.addEventListener('hashchange', () => this.applyHash());
    const fromHash = decodeFilters(location.hash.split('?')[1] ?? '');
    const initial = fromHash ?? loadStored();
    if (initial) this.set(initial);
    this.applyHash();
  }

  private persistFilters(): void {
    saveStored(this.state);
    // keep the URL shareable without adding history entries
    const [path] = location.hash.split('?');
    const next = (path || '#/') + encodeFilters(this.state);
    if (next !== location.hash && (location.hash || encodeFilters(this.state))) {
      try {
        history.replaceState(history.state, '', next);
      } catch {
        /* ignore (sandboxed iframes) */
      }
    }
  }

  private applyHash(): void {
    const [path, query = ''] = location.hash.split('?');
    const m = /^#\/e\/(.+)$/.exec(path);
    const id = m ? decodeURIComponent(m[1]) : null;
    const selected = id && this.isValid(id) ? id : null;
    const patch: Partial<State> = {};
    if (selected !== this.state.selected) Object.assign(patch, { selected, expanded: null, hoverRow: null });
    const f = decodeFilters(query);
    if (f) {
      if (!sameSet(f.kinds, this.state.kinds)) patch.kinds = f.kinds;
      if (!sameSet(f.categories, this.state.categories)) patch.categories = f.categories;
      if (f.includePast !== this.state.includePast) patch.includePast = f.includePast;
    }
    this.set(patch);
    // a link without a filter query (e.g. the brand link "#/") keeps the current filters
    if (!f) this.persistFilters();
  }
}
