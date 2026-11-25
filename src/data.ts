import type { Entity, EntityKind, Graph, Link, LinkCategory } from './types';
import { CATEGORIES } from './config';
import { KIND_BY_ID } from './kinds';
import { normalize } from './search';

export interface GraphIndex {
  graph: Graph;
  /** true when the bundled sample fixture is shown because graph.json is missing. */
  isSample: boolean;
  entities: Entity[];
  links: Link[];
  byId: Map<string, Entity>;
  linkById: Map<string, Link>;
  /** links touching an entity */
  linksOf: Map<string, Link[]>;
  degree: Map<string, number>;
  maxDegree: number;
  /**
   * Influence 0..1 per entity: `Entity.influence` from the pipeline, or (old data) the
   * log-normalised degree as a fallback.
   */
  influence: Map<string, number>;
  /** true when influence comes from the data (false: degree fallback for at least one entity) */
  influenceFromData: boolean;
  /** entities sorted by influence (desc), then degree */
  ranked: Entity[];
  /** number of entities per kind */
  kindCount: Map<EntityKind, number>;
  /** number of links per category */
  categoryCount: Map<LinkCategory, number>;
  sourceCount: number;
  /** normalized search keys, parallel to `entities` */
  searchKeys: string[];
}

/**
 * Fetch ./data/graph.json (relative to the page), falling back to the sample fixture.
 * Streams the body so the boot screen can show real download progress, and yields to the
 * browser between download, parse and indexing so the UI keeps painting.
 */
export async function loadGraph(onProgress?: (p: number, label?: string) => void): Promise<GraphIndex> {
  const nextFrame = () => new Promise<void>((r) => requestAnimationFrame(() => setTimeout(r, 0)));
  const tryFetch = async (url: string): Promise<Graph | null> => {
    try {
      const res = await fetch(url, { cache: 'no-cache' });
      if (!res.ok) return null;
      let text: string;
      const total = Number(res.headers.get('content-length')) || 0;
      // content-length is the compressed size when served with gzip/brotli; only trust it uncompressed
      const encoded = !!res.headers.get('content-encoding');
      if (res.body && typeof TextDecoderStream !== 'undefined') {
        const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
        const parts: string[] = [];
        let got = 0;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          parts.push(value);
          got += value.length;
          // unknown total: approach 1 asymptotically (~4 MB scale)
          const f = total && !encoded ? Math.min(1, got / total) : 1 - Math.exp(-got / 1.5e6);
          onProgress?.(0.1 + 0.55 * f);
        }
        text = parts.join('');
      } else text = await res.text();
      onProgress?.(0.68, 'DECODING DOSSIERS…');
      await nextFrame();
      const g = JSON.parse(text) as Graph;
      return Array.isArray(g?.entities) && Array.isArray(g?.links) ? g : null;
    } catch {
      return null;
    }
  };
  onProgress?.(0.08);
  let graph = await tryFetch('./data/graph.json');
  let isSample = false;
  if (!graph) {
    graph = await tryFetch('./data/graph.sample.json');
    isSample = true;
  }
  if (!graph) throw new Error('No graph data could be loaded.');
  onProgress?.(0.78, 'INDEXING NETWORK…');
  await nextFrame();
  return indexGraph(graph, isSample);
}

export function indexGraph(graph: Graph, isSample = false): GraphIndex {
  const byId = new Map<string, Entity>();
  for (const e of graph.entities) {
    if (!e || !e.id || byId.has(e.id)) continue;
    // unknown kinds from newer/older pipelines are shown as organisations
    if (!KIND_BY_ID[e.kind]) e.kind = 'organization';
    byId.set(e.id, e);
  }
  const entities = [...byId.values()];
  // Keep only links whose both ends exist and that carry at least one source.
  const links = graph.links.filter(
    (l) => l && byId.has(l.a) && byId.has(l.b) && l.a !== l.b && Array.isArray(l.sources),
  );
  const linkById = new Map(links.map((l) => [l.id, l]));
  const linksOf = new Map<string, Link[]>(entities.map((e) => [e.id, []]));
  for (const l of links) {
    linksOf.get(l.a)!.push(l);
    linksOf.get(l.b)!.push(l);
  }
  const degree = new Map<string, number>();
  let maxDegree = 1;
  for (const e of entities) {
    // degree = number of distinct counterparts
    const set = new Set(linksOf.get(e.id)!.map((l) => (l.a === e.id ? l.b : l.a)));
    degree.set(e.id, set.size);
    maxDegree = Math.max(maxDegree, set.size);
  }
  const logMax = Math.log1p(maxDegree);
  const influence = new Map<string, number>();
  let influenceFromData = true;
  for (const e of entities) {
    const v = e.influence;
    if (typeof v === 'number' && Number.isFinite(v)) influence.set(e.id, Math.max(0, Math.min(1, v)));
    else {
      influenceFromData = false;
      influence.set(e.id, Math.log1p(degree.get(e.id)!) / logMax);
    }
  }
  const ranked = [...entities].sort(
    (x, y) =>
      influence.get(y.id)! - influence.get(x.id)! || degree.get(y.id)! - degree.get(x.id)! || x.name.localeCompare(y.name),
  );
  const kindCount = new Map<EntityKind, number>();
  for (const e of entities) kindCount.set(e.kind, (kindCount.get(e.kind) ?? 0) + 1);
  const categoryCount = new Map<LinkCategory, number>();
  for (const l of links) categoryCount.set(l.category, (categoryCount.get(l.category) ?? 0) + 1);
  const urls = new Set<string>();
  for (const l of links) for (const s of l.sources) if (s?.url) urls.add(s.url);
  return {
    graph,
    isSample,
    entities,
    links,
    byId,
    linkById,
    linksOf,
    degree,
    maxDegree,
    influence,
    influenceFromData,
    ranked,
    kindCount,
    categoryCount,
    sourceCount: urls.size,
    searchKeys: entities.map((e) => normalize(e.name)),
  };
}

/** The counterpart of `id` in link `l`. */
export const other = (l: { a: string; b: string }, id: string): string => (l.a === id ? l.b : l.a);

/** Relation label read from the perspective of entity `id`. */
export const relationFor = (l: Link, id: string): string => (l.a === id ? l.label : l.inverseLabel);

/**
 * A dossier row: all links between the selected entity and one counterpart within one category
 * (e.g. "Neuralink — Director · Employee"). Key format: "<category>|<counterpartId>".
 */
export interface Row {
  key: string;
  category: LinkCategory;
  counterpart: string;
  links: Link[];
}

export const rowKey = (category: LinkCategory, counterpart: string): string => `${category}|${counterpart}`;

export function parseRowKey(key: string): { category: LinkCategory; counterpart: string } {
  const i = key.indexOf('|');
  return { category: key.slice(0, i) as LinkCategory, counterpart: key.slice(i + 1) };
}

/** Group links of entity `id` into rows (category order, then counterpart). */
export function rowsFor(id: string, links: Link[]): Row[] {
  const map = new Map<string, Row>();
  for (const l of links) {
    const cp = other(l, id);
    const key = rowKey(l.category, cp);
    let r = map.get(key);
    if (!r) map.set(key, (r = { key, category: l.category, counterpart: cp, links: [] }));
    r.links.push(l);
  }
  return [...map.values()];
}

const CAT_RANK = Object.fromEntries(CATEGORIES.map((c, i) => [c.id, i])) as Record<LinkCategory, number>;

/** One drawable edge per entity pair; colour = most significant category among its links. */
export interface Edge {
  key: string;
  a: string;
  b: string;
  category: LinkCategory;
}

export function edgesFrom(links: Link[]): Edge[] {
  const map = new Map<string, Edge>();
  for (const l of links) {
    const key = l.a < l.b ? `${l.a}~${l.b}` : `${l.b}~${l.a}`;
    const e = map.get(key);
    if (!e) map.set(key, { key, a: l.a, b: l.b, category: l.category });
    else if (CAT_RANK[l.category] < CAT_RANK[e.category]) e.category = l.category;
  }
  return [...map.values()];
}
