import type { Entity, Link, Source } from '../types';
import type { Row } from '../data';
import { CATEGORY_BY_ID, ORIGIN_LABEL } from '../config';
import { kindLabel } from '../kinds';
import { KindIcon } from './KindIcon';
import { h, icon, ICONS } from '../dom';
import { years, isPast } from '../format';
import { relationFor } from '../data';
import { SourceLink } from './SourceLink';

export interface ConnectionItemProps {
  row: Row;
  /** the entity whose dossier is open */
  self: string;
  counterpart: Entity;
  expanded: boolean;
  onToggle(row: Row): void;
  onGo(id: string): void;
  onHover(row: Row | null): void;
}

/** Years summary for a row: earliest start, and an end only if every relation has ended. */
export function rowYears(links: Link[]): string {
  const since = links.map((l) => l.since).filter((y): y is number => typeof y === 'number');
  const ongoing = links.some((l) => !isPast(l));
  const ends = links.map((l) => l.until).filter((y): y is number => typeof y === 'number');
  // all ended; show the latest known end year (none known: "ended" is shown by the row tag)
  const until = ongoing || !ends.length ? undefined : Math.max(...ends);
  return years({ since: since.length ? Math.min(...since) : undefined, until });
}

/**
 * One row in the dossier: counterpart, relation(s) read from the selected entity's perspective,
 * years and category colour bar. Expanding reveals notes, numbered sources and "Go to".
 */
export function ConnectionItem(p: ConnectionItemProps): HTMLDivElement {
  const { row, counterpart: cp } = p;
  const links = row.links;
  const past = links.every(isPast);
  const bodyId = `cb-${row.key.replace(/[^\w-]/g, '_')}`;
  const yr = rowYears(links);
  const labels = [...new Set(links.map((l) => relationFor(l, p.self)).filter(Boolean))];

  // de-duplicated numbered sources across the row's links
  const sources: Source[] = [];
  const seen = new Set<string>();
  for (const l of links)
    for (const s of l.sources)
      if (s?.url && !seen.has(s.url)) {
        seen.add(s.url);
        sources.push(s);
      }

  const head = h(
    'button.conn-h',
    {
      type: 'button',
      'aria-expanded': String(p.expanded),
      'aria-controls': bodyId,
      onclick: () => p.onToggle(row),
    },
    h('span.row', null, h('span.name', null, KindIcon(cp.kind, 10), cp.name), yr ? h('span.yr', null, yr) : null),
    h('span.rel', null, labels.join(' · '), past ? h('span.tag', null, 'past') : null),
  );

  const details = links.map((l) => {
    const y = years(l);
    const showLine = links.length > 1 || (y && y !== yr);
    return h(
      'div.rel-detail',
      null,
      showLine ? h('p.rel-line', null, relationFor(l, p.self), y ? ` · ${y}` : '', isPast(l) ? ' · ended' : '') : null,
      l.note ? h('p.why', null, l.note) : null,
    );
  });
  // credit imported origins ("via Wikidata, LittleSis"); hand-curated rows need no credit line
  const origins = [...new Set(links.map((l) => l.origin).filter((o) => o && o !== 'curated'))];
  const via = origins.length ? ` · via ${origins.map((o) => ORIGIN_LABEL[o] ?? o).join(', ')}` : '';
  const body = h(
    'div.conn-body',
    { id: bodyId, hidden: !p.expanded },
    details,
    h(
      'p.cp',
      null,
      `${kindLabel(cp.kind)}${cp.place ? ' · ' + cp.place : ''} · ${CATEGORY_BY_ID[row.category]?.label ?? row.category}${via}`,
    ),
    h(
      'ol.src-list',
      { 'aria-label': 'Sources' },
      sources.map((s, i) => h('li', null, SourceLink(s, i + 1))),
    ),
    h(
      'div.conn-actions',
      null,
      h('span.eyebrow', null, `${sources.length} source${sources.length === 1 ? '' : 's'}`),
      h(
        'button.goto',
        { type: 'button', onclick: () => p.onGo(cp.id), 'aria-label': `Go to ${cp.name}` },
        'Go to',
        icon(ICONS.arrow, 14),
      ),
    ),
  );
  const el = h(
    'div.conn',
    {
      class: (p.expanded ? 'on' : '') + (past ? ' past' : ''),
      style: `--c: var(${CATEGORY_BY_ID[row.category]?.token ?? '--ice'})`,
      'data-row': row.key,
      role: 'listitem',
    },
    head,
    body,
  );
  el.addEventListener('pointerenter', (e) => {
    if (e.pointerType === 'mouse') p.onHover(row);
  });
  el.addEventListener('pointerleave', (e) => {
    if (e.pointerType === 'mouse') p.onHover(null);
  });
  return el;
}
