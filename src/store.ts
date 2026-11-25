import type { LinkCategory } from './types';
import { CATEGORIES } from './config';

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
}

type Listener = (s: State, changed: Set<keyof State>) => void;

/** Minimal observable store with URL-hash sync for the selection. */
export class Store {
  state: State = {
    selected: null,
    expanded: null,
    hoverEntity: null,
    hoverRow: null,
    categories: new Set(CATEGORIES.map((c) => c.id)),
    includePast: true,
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
    for (const fn of this.listeners) fn(this.state, changed);
  }

  toggleCategory(c: LinkCategory): void {
    const next = new Set(this.state.categories);
    if (next.has(c)) next.delete(c);
    else next.add(c);
    this.set({ categories: next });
  }

  /** Navigate to an entity (pushes a history entry). `null` returns to the overview. */
  select(id: string | null): void {
    const hash = id ? `#/e/${encodeURIComponent(id)}` : '#/';
    if (location.hash !== hash) location.hash = hash;
    else this.applyHash();
  }

  /** Start listening to hash changes; applies the current hash immediately. */
  initRouting(isValid: (id: string) => boolean): void {
    this.isValid = isValid;
    window.addEventListener('hashchange', () => this.applyHash());
    this.applyHash();
  }

  private applyHash(): void {
    const m = /^#\/e\/(.+)$/.exec(location.hash);
    const id = m ? decodeURIComponent(m[1]) : null;
    const selected = id && this.isValid(id) ? id : null;
    if (selected !== this.state.selected) this.set({ selected, expanded: null, hoverRow: null });
  }
}
