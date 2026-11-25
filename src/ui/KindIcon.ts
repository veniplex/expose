import type { EntityKind } from '../types';
import { KIND_LABEL, KIND_SHAPE } from '../config';
import { h } from '../dom';

/** The small marker glyph used on the globe for a kind (circle / square / diamond). */
export function KindIcon(kind: EntityKind): HTMLSpanElement {
  return h('span.kind-ico', { 'data-shape': KIND_SHAPE[kind] ?? 2, title: KIND_LABEL[kind] ?? kind, 'aria-hidden': 'true' });
}
