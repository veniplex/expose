import type { Entity } from '../types';
import type { GraphIndex } from '../data';
import type { State, Store } from '../store';
import { CATEGORIES, KIND_LABEL, REPO_URL } from '../config';
import { h, icon, ICONS } from '../dom';
import { formatDate, isPast, plural } from '../format';
import { other, rowsFor, type Row } from '../data';
import { ConnectionItem } from './ConnectionItem';

export interface DossierCallbacks {
  openAbout(): void;
  /** called after the content changed (e.g. so the bottom sheet can adjust) */
  rendered?(kind: 'intro' | 'entity'): void;
}

/** The right-hand dossier: intro briefing when nothing is selected, entity file otherwise. */
export class Dossier {
  readonly el: HTMLElement;
  readonly grip: HTMLButtonElement;
  private view: HTMLDivElement;
  private listEl: HTMLDivElement | null = null;
  private renderedFor: string | null | undefined = undefined;

  constructor(
    private index: GraphIndex,
    private store: Store,
    private cb: DossierCallbacks,
  ) {
    this.grip = h('button.sheet-grip', { type: 'button', 'aria-label': 'Resize panel' });
    this.view = h('div.d-view');
    this.el = h('aside.dossier.panel.bracket', { 'aria-label': 'Dossier', 'aria-live': 'polite' }, this.grip, this.view);
    store.subscribe((s, ch) => {
      if (ch.has('selected')) this.render(s);
      else if (ch.has('categories') || ch.has('includePast')) this.renderList(s);
      else if (ch.has('expanded')) this.syncExpanded(s);
    });
    this.render(store.state);
  }

  private render(s: State): void {
    if (s.selected === this.renderedFor) return;
    this.renderedFor = s.selected;
    const e = s.selected ? this.index.byId.get(s.selected) : undefined;
    if (e) this.renderEntity(e, s);
    else this.renderIntro();
    this.cb.rendered?.(e ? 'entity' : 'intro');
  }

  private footer(entity?: Entity): HTMLDivElement {
    const issue = new URL(`${REPO_URL}/issues/new`);
    issue.searchParams.set('title', entity ? `Data error: ${entity.name} (${entity.id})` : 'Data error');
    issue.searchParams.set(
      'body',
      entity
        ? `Entity: ${entity.name} (${entity.id})\nPage: ${location.href}\n\nWhat is wrong, and which public source shows the correct information?\n`
        : 'What is wrong, and which public source shows the correct information?\n',
    );
    return h(
      'div.d-foot',
      null,
      h('span', null, `Data generated ${formatDate(this.index.graph.generatedAt)}${this.index.isSample ? ' · SAMPLE DATA' : ''}`),
      h('span', null, 'Sources: Wikidata, Wikipedia and cited publications'),
      h('button.text-btn', { type: 'button', onclick: () => this.cb.openAbout() }, 'About & method'),
      h('a.text-btn', { href: issue.toString(), target: '_blank', rel: 'noopener noreferrer' }, 'Report an error'),
    );
  }

  private renderIntro(): void {
    const top = this.index.ranked.slice(0, 10);
    const head = h(
      'div.d-head.intro',
      null,
      h('span.eyebrow', null, `Briefing · ${plural(this.index.entities.length, 'entity', 'entities')}`),
      h('h2', null, 'Who is connected to whom'),
      h(
        'p',
        null,
        'EXPOSE maps documented relationships between powerful people, companies, funds and governments. Every connection links to the public sources it rests on.',
      ),
    );
    const list = h(
      'div.d-list',
      null,
      h(
        'ol.steps',
        null,
        h('li', null, h('b', null, '01'), h('span', null, 'Search a name — press / anywhere.')),
        h('li', null, h('b', null, '02'), h('span', null, 'Or pick a marker on the globe.')),
        h('li', null, h('b', null, '03'), h('span', null, 'Open a connection to read why it exists, check its sources, then hop on.')),
      ),
      h('div.eyebrow.section-h', null, 'Most connected'),
      h(
        'div',
        { role: 'list' },
        top.map((e, i) =>
          h(
            'button.rank',
            {
              type: 'button',
              role: 'listitem',
              onclick: () => this.store.select(e.id),
              onpointerenter: (ev: Event) => (ev as PointerEvent).pointerType === 'mouse' && this.store.set({ hoverEntity: e.id }),
              onpointerleave: () => this.store.state.hoverEntity === e.id && this.store.set({ hoverEntity: null }),
            },
            h('span.i', null, String(i + 1).padStart(2, '0')),
            h(
              'span',
              null,
              h('span.name', null, e.name),
              h('span.sub', null, `${KIND_LABEL[e.kind] ?? e.kind}${e.place ? ' · ' + e.place : ''}`),
            ),
            h('span.deg', { 'aria-label': `${this.index.degree.get(e.id)} connections` }, String(this.index.degree.get(e.id) ?? 0)),
          ),
        ),
      ),
      h(
        'p.notice',
        null,
        'A connection records a relationship documented in public sources. It is not an accusation of wrongdoing.',
        this.index.isSample ? ' You are looking at a small sample dataset.' : '',
      ),
    );
    this.listEl = null;
    this.view.replaceChildren(head, list, this.footer());
  }

  private renderEntity(e: Entity, s: State): void {
    const all = this.index.linksOf.get(e.id) ?? [];
    const countries = new Set(
      all.map((l) => this.index.byId.get(other(l, e.id))?.country).filter((c): c is string => !!c),
    );
    const img = e.image
      ? h('img.thumb', {
          src: e.image,
          alt: '',
          loading: 'lazy',
          decoding: 'async',
          referrerpolicy: 'no-referrer',
          width: 64,
          height: 64,
        })
      : null;
    img?.addEventListener('error', () => img.remove());
    const head = h(
      'div.d-head',
      null,
      h('span.eyebrow', null, `${KIND_LABEL[e.kind] ?? e.kind}${e.place ? ' · ' + e.place : ''}`),
      h(
        'button.icon-btn.bare.close',
        { type: 'button', 'aria-label': 'Close dossier', title: 'Close (Esc)', onclick: () => this.store.select(null) },
        icon(ICONS.close, 16),
      ),
      h('div.d-title', null, h('div', null, h('h1', null, e.name), e.description ? h('p', null, e.description) : null), img),
      h(
        'div.meta',
        null,
        h('span', null, h('b', null, String(this.index.degree.get(e.id) ?? 0)), this.index.degree.get(e.id) === 1 ? ' connection' : ' connections'),
        countries.size ? h('span', null, h('b', null, String(countries.size)), countries.size === 1 ? ' country' : ' countries') : null,
        e.wikipedia ? h('a', { href: e.wikipedia, target: '_blank', rel: 'noopener noreferrer' }, 'Wikipedia ↗') : null,
        e.wikidata ? h('a', { href: e.wikidata, target: '_blank', rel: 'noopener noreferrer' }, 'Wikidata ↗') : null,
      ),
    );
    this.listEl = h('div.d-list', { role: 'list', 'aria-label': `Connections of ${e.name}` });
    this.view.replaceChildren(head, this.listEl, this.footer(e));
    this.renderList(s);
  }

  /** (Re)build the grouped connection list under the active filters. */
  private renderList(s: State): void {
    const id = s.selected;
    if (!id || !this.listEl) return;
    const all = this.index.linksOf.get(id) ?? [];
    const rows = rowsFor(id, all);
    const latest = (r: Row) => Math.max(0, ...r.links.map((l) => l.until ?? l.since ?? 0));
    const ended = (r: Row) => r.links.every(isPast);
    rows.sort(
      (x, y) =>
        Number(ended(x)) - Number(ended(y)) ||
        latest(y) - latest(x) ||
        (this.index.degree.get(y.counterpart) ?? 0) - (this.index.degree.get(x.counterpart) ?? 0) ||
        x.counterpart.localeCompare(y.counterpart),
    );
    const nodes: HTMLElement[] = [];
    let hiddenPast = 0;
    let hiddenCat = 0;
    for (const c of CATEGORIES) {
      const inCat = rows.filter((r) => r.category === c.id);
      if (!inCat.length) continue;
      if (!s.categories.has(c.id)) {
        hiddenCat += inCat.length;
        continue;
      }
      const shown: Row[] = [];
      for (const r of inCat) {
        const links = s.includePast ? r.links : r.links.filter((l) => !isPast(l));
        if (links.length) shown.push({ ...r, links });
        else hiddenPast++;
      }
      if (!shown.length) continue;
      nodes.push(
        h('div.group-h.eyebrow', { style: `--c: var(${c.token})`, role: 'presentation' }, c.label, h('span.n', null, String(shown.length))),
      );
      for (const r of shown) {
        const cp = this.index.byId.get(r.counterpart);
        if (!cp) continue;
        nodes.push(
          ConnectionItem({
            row: r,
            self: id,
            counterpart: cp,
            expanded: s.expanded === r.key,
            onToggle: (row) => this.store.set({ expanded: this.store.state.expanded === row.key ? null : row.key }),
            onGo: (target) => this.store.select(target),
            onHover: (row) => this.store.set({ hoverRow: row ? row.key : null, hoverEntity: row ? row.counterpart : null }),
          }),
        );
      }
    }
    if (!nodes.length) nodes.push(h('p.notice', null, all.length ? 'No connections match the active filters.' : 'No connections recorded yet.'));
    if (hiddenPast)
      nodes.push(
        h(
          'p.notice',
          null,
          `${plural(hiddenPast, 'past connection')} hidden. `,
          h('button.text-btn', { type: 'button', onclick: () => this.store.set({ includePast: true }) }, 'Show them'),
        ),
      );
    if (hiddenCat) nodes.push(h('p.notice', null, `${plural(hiddenCat, 'connection')} hidden by type filters.`));
    this.listEl.replaceChildren(...nodes);
  }

  private syncExpanded(s: State): void {
    if (!this.listEl) return;
    for (const row of this.listEl.querySelectorAll<HTMLElement>('.conn')) {
      const on = row.dataset.row === s.expanded;
      row.classList.toggle('on', on);
      row.querySelector('.conn-h')?.setAttribute('aria-expanded', String(on));
      const body = row.querySelector<HTMLElement>('.conn-body');
      if (body) body.hidden = !on;
      if (on) requestAnimationFrame(() => row.scrollIntoView({ block: 'nearest', behavior: 'smooth' }));
    }
  }

  /** Scroll the list to the top (used when a new entity opens). */
  resetScroll(): void {
    this.listEl?.scrollTo({ top: 0 });
    this.view.scrollTo({ top: 0 });
  }

  /** helper for the bottom sheet: height of the always-visible header part */
  peekHeight(): number {
    const head = this.view.querySelector<HTMLElement>('.d-head');
    const title = head?.querySelector<HTMLElement>('h1, h2');
    if (!head || !title) return 140;
    // grip + eyebrow + title (the description is allowed to be cut off in peek)
    return this.grip.offsetHeight + title.offsetTop + title.offsetHeight + 12;
  }
}

