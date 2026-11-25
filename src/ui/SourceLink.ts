import type { Source } from '../types';
import { h } from '../dom';

/** Numbered external source link; always opens in a new tab without opener access. */
export function SourceLink(src: Source, n: number): HTMLAnchorElement {
  let host = '';
  try {
    host = new URL(src.url).hostname.replace(/^www\./, '');
  } catch {
    /* keep empty */
  }
  return h(
    'a.src',
    { href: src.url, target: '_blank', rel: 'noopener noreferrer', title: `${src.title} — ${src.url}` },
    h('span.n', null, `[${n}]`),
    h('span.t', null, src.title || host),
    h('span.p', null, `${src.publisher || host} ↗`),
  );
}
