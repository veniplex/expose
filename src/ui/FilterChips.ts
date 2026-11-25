import type { Store } from '../store';
import { CATEGORIES } from '../config';
import { h } from '../dom';
import { KindIcon } from './KindIcon';

/** Category toggles + "include past connections" + marker legend. */
export function FilterChips(store: Store): HTMLDivElement {
  const chips = CATEGORIES.map((c) =>
    h(
      'button.chip',
      {
        type: 'button',
        'aria-pressed': 'true',
        style: `--c: var(${c.token})`,
        onclick: () => store.toggleCategory(c.id),
      },
      c.label,
    ),
  );
  const past = h(
    'button.chip.toggle',
    { type: 'button', 'aria-pressed': 'true', onclick: () => store.set({ includePast: !store.state.includePast }) },
    'Include past connections',
  );
  const el = h(
    'div.filters',
    { role: 'group', 'aria-label': 'Connection type filters' },
    h('span.eyebrow', null, 'Connection type'),
    chips,
    past,
    h(
      'div.legend',
      { 'aria-hidden': 'true' },
      h('span', null, KindIcon('person'), 'Person'),
      h('span', null, KindIcon('company'), 'Company · fund'),
      h('span', null, KindIcon('government'), 'Institution'),
    ),
  );
  const sync = () => {
    CATEGORIES.forEach((c, i) => chips[i].setAttribute('aria-pressed', String(store.state.categories.has(c.id))));
    past.setAttribute('aria-pressed', String(store.state.includePast));
  };
  store.subscribe((_, ch) => {
    if (ch.has('categories') || ch.has('includePast')) sync();
  });
  sync();
  return el;
}
