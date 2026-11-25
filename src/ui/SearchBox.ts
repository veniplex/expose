import type { Entity } from '../types';
import type { GraphIndex } from '../data';
import type { Store } from '../store';
import { kindLabel } from '../kinds';
import { h, icon, ICONS } from '../dom';
import { search } from '../search';
import { KindIcon } from './KindIcon';

/**
 * Combobox search over entity names. ↑/↓ move, Enter selects, Esc closes/clears,
 * "/" anywhere focuses the field.
 */
export class SearchBox {
  readonly el: HTMLDivElement;
  readonly input: HTMLInputElement;
  private list: HTMLUListElement;
  private results: Entity[] = [];
  private active = -1;

  constructor(
    private index: GraphIndex,
    private store: Store,
    private onSelect: (id: string) => void,
  ) {
    this.input = h('input', {
      id: 'q',
      type: 'search',
      placeholder: 'Search a person, company, fund…',
      autocomplete: 'off',
      autocapitalize: 'off',
      spellcheck: 'false',
      enterkeyhint: 'search',
      role: 'combobox',
      'aria-autocomplete': 'list',
      'aria-expanded': 'false',
      'aria-controls': 'search-results',
      'aria-label': 'Search a person, company, fund, party, government, media outlet or organisation',
    });
    this.list = h('ul.search-results.panel', { id: 'search-results', role: 'listbox', hidden: true, 'aria-label': 'Search results' });
    this.el = h(
      'div.search',
      { role: 'search' },
      h('label.search-field.panel.clipped', { for: 'q' }, icon(ICONS.search, 16), this.input, h('kbd', { 'aria-hidden': 'true' }, '/')),
      this.list,
    );

    this.input.addEventListener('input', () => this.run());
    this.input.addEventListener('focus', () => {
      if (this.input.value) this.run();
    });
    this.input.addEventListener('keydown', (e) => this.key(e));
    this.input.addEventListener('blur', () => setTimeout(() => this.close(), 150));
    // keep results above the on-screen keyboard
    window.visualViewport?.addEventListener('resize', () => this.fit());
    document.addEventListener('keydown', (e) => {
      if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement;
      if (t.closest('input, textarea, [contenteditable="true"]')) return;
      e.preventDefault();
      this.input.focus();
      this.input.select();
    });
  }

  private run(): void {
    this.results = search(this.index, this.input.value, 8, (e) => !this.store.state.kinds.has(e.kind));
    this.active = this.results.length ? 0 : -1;
    this.render();
  }

  private render(): void {
    const q = this.input.value.trim();
    if (!q) return this.close();
    this.list.replaceChildren(
      ...(this.results.length
        ? this.results.map((e, i) =>
            h(
              'li.result',
              {
                class: this.store.state.kinds.has(e.kind) ? null : 'hidden-kind',
                id: `opt-${i}`,
                role: 'option',
                'aria-selected': String(i === this.active),
                onpointerdown: (ev: Event) => ev.preventDefault(), // keep focus until click fires
                onclick: () => this.choose(i),
              },
              KindIcon(e.kind),
              h('span.name', null, ...highlight(e.name, q)),
              h('span.deg', null, h('b', null, String(this.index.degree.get(e.id) ?? 0)), (this.index.degree.get(e.id) ?? 0) === 1 ? ' link' : ' links'),
              h(
                'span.sub',
                null,
                `${kindLabel(e.kind)}${e.place ? ' · ' + e.place : ''}`,
                this.store.state.kinds.has(e.kind) ? null : h('span.tag', { title: 'This type is hidden by the filters; choosing it shows the type again' }, 'hidden'),
              ),
            ),
          )
        : [h('li.empty', { role: 'option', 'aria-disabled': 'true' }, 'No match in the dataset')]),
    );
    this.list.hidden = false;
    this.input.setAttribute('aria-expanded', 'true');
    this.input.setAttribute('aria-activedescendant', this.active >= 0 ? `opt-${this.active}` : '');
    this.fit();
  }

  private fit(): void {
    if (this.list.hidden) return;
    const vv = window.visualViewport;
    const bottom = this.input.getBoundingClientRect().bottom;
    const avail = (vv ? vv.height + vv.offsetTop : window.innerHeight) - bottom - 20;
    this.list.style.setProperty('--results-max', `${Math.max(140, avail)}px`);
  }

  private key(e: KeyboardEvent): void {
    const n = this.results.length;
    if (e.key === 'ArrowDown' && n) {
      e.preventDefault();
      if (this.list.hidden) return this.run();
      this.move((this.active + 1) % n);
    } else if (e.key === 'ArrowUp' && n) {
      e.preventDefault();
      this.move((this.active - 1 + n) % n);
    } else if (e.key === 'Enter') {
      if (this.active >= 0) {
        e.preventDefault();
        this.choose(this.active);
      }
    } else if (e.key === 'Escape') {
      if (!this.list.hidden) this.close();
      else if (this.input.value) this.input.value = '';
      else this.input.blur();
    }
  }

  private move(i: number): void {
    this.active = i;
    [...this.list.children].forEach((c, j) => c.setAttribute('aria-selected', String(j === i)));
    this.list.children[i]?.scrollIntoView({ block: 'nearest' });
    this.input.setAttribute('aria-activedescendant', `opt-${i}`);
  }

  private choose(i: number): void {
    const e = this.results[i];
    if (!e) return;
    this.close();
    this.input.value = '';
    this.input.blur();
    this.onSelect(e.id);
  }

  close(): void {
    this.list.hidden = true;
    this.input.setAttribute('aria-expanded', 'false');
    this.input.removeAttribute('aria-activedescendant');
  }
}

/** Wrap the first case/diacritics-insensitive match of q in <mark>. */
function highlight(name: string, q: string): (string | HTMLElement)[] {
  const fold = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  // map folded index -> original index (folding only removes combining marks)
  const map: number[] = [];
  let folded = '';
  for (let i = 0; i < name.length; i++) {
    const f = fold(name[i]);
    for (let k = 0; k < f.length; k++) map.push(i);
    folded += f;
  }
  const at = folded.indexOf(fold(q));
  if (at < 0 || !q) return [name];
  const s = map[at];
  const e = (map[at + fold(q).length - 1] ?? name.length - 1) + 1;
  return [name.slice(0, s), h('mark', null, name.slice(s, e)), name.slice(e)];
}
