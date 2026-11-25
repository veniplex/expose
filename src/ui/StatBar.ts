import type { GraphIndex } from '../data';
import { h } from '../dom';

/** Header counters: entities / connections / sources. */
export function StatBar(index: GraphIndex): HTMLDivElement {
  const stat = (n: number, label: string) => h('span', null, h('b', null, n.toLocaleString('en-US')), ` ${label}`);
  return h(
    'div.stats',
    { 'aria-label': 'Dataset size' },
    stat(index.entities.length, 'entities'),
    stat(index.links.length, 'connections'),
    stat(index.sourceCount, 'sources'),
  );
}
