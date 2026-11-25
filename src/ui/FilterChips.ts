import type { EntityKind, LinkCategory } from '../types';
import type { GraphIndex } from '../data';
import type { Store } from '../store';
import { CATEGORIES } from '../config';
import { ALL_KINDS, KINDS } from '../kinds';
import { h, icon, ICONS, isCompact } from '../dom';
import { ChipGroup } from './ChipGroup';
import { KindIcon } from './KindIcon';

export interface FilterPanel {
  /** the panel with both chip groups (bottom-left on desktop, a popover sheet on phones) */
  el: HTMLDivElement;
  /** compact-layout "Filters" button that opens the panel (hidden on desktop) */
  button: HTMLButtonElement;
  close(): void;
}

/** Entity-type + connection-type chip groups and the "include past connections" toggle. */
export function FilterChips(store: Store, index: GraphIndex): FilterPanel {
  const kinds = ChipGroup<EntityKind>({
    label: 'Entity type',
    ariaLabel: 'Entity type filters',
    items: KINDS.filter((k) => index.kindCount.get(k.id)).map((k) => ({
      id: k.id,
      label: k.plural,
      icon: KindIcon(k.id, 11),
      count: index.kindCount.get(k.id) ?? 0,
    })),
    isOn: (k) => store.state.kinds.has(k),
    toggle: (k) => store.toggleKind(k),
    solo: (k) => store.set({ kinds: new Set([k]) }),
    setAll: (on) => store.set({ kinds: new Set(on ? ALL_KINDS : []) }),
  });
  const cats = ChipGroup<LinkCategory>({
    label: 'Connection type',
    ariaLabel: 'Connection type filters',
    items: CATEGORIES.map((c) => ({ id: c.id, label: c.label, token: c.token, count: index.categoryCount.get(c.id) ?? 0 })),
    isOn: (c) => store.state.categories.has(c),
    toggle: (c) => store.toggleCategory(c),
    solo: (c) => store.set({ categories: new Set([c]) }),
    setAll: (on) => store.set({ categories: new Set(on ? CATEGORIES.map((c) => c.id) : []) }),
  });
  const past = h(
    'button.chip.toggle',
    { type: 'button', 'aria-pressed': 'true', onclick: () => store.set({ includePast: !store.state.includePast }) },
    'Include past connections',
  );
  const close = () => setOpen(false);
  const el = h(
    'div.filters',
    { id: 'filters', role: 'region', 'aria-label': 'Filters' },
    h(
      'div.filters-h',
      null,
      h('span.eyebrow', null, 'Filters'),
      h('button.icon-btn.bare.close', { type: 'button', 'aria-label': 'Close filters', onclick: close }, icon(ICONS.close, 16)),
    ),
    kinds.el,
    cats.el,
    h('div.chip-row', null, past),
  );
  const badge = h('span.badge', { hidden: true });
  const button = h(
    'button.chip.filters-btn',
    {
      type: 'button',
      'aria-expanded': 'false',
      'aria-controls': 'filters',
      onclick: () => setOpen(!el.classList.contains('open')),
    },
    icon(ICONS.filter, 14),
    'Filters',
    badge,
  );
  function setOpen(open: boolean): void {
    el.classList.toggle('open', open);
    button.setAttribute('aria-expanded', String(open));
  }
  // tap outside / Esc closes the compact popover
  document.addEventListener('pointerdown', (e) => {
    if (!isCompact() || !el.classList.contains('open')) return;
    const t = e.target as Node;
    if (!el.contains(t) && !button.contains(t)) close();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && el.classList.contains('open')) {
      close();
      button.focus();
    }
  });

  const sync = () => {
    kinds.sync();
    cats.sync();
    past.setAttribute('aria-pressed', String(store.state.includePast));
    const off =
      ALL_KINDS.length - store.state.kinds.size + (CATEGORIES.length - store.state.categories.size) + Number(!store.state.includePast);
    badge.hidden = off === 0;
    badge.textContent = `${off} off`;
    button.classList.toggle('active', off > 0);
  };
  store.subscribe((_, ch) => {
    if (ch.has('categories') || ch.has('includePast') || ch.has('kinds')) sync();
  });
  sync();
  return { el, button, close };
}
