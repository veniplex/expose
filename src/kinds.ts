import type { EntityKind } from './types';

/**
 * The ONE definition of entity kinds: label, display order and glyph.
 * The same SVG path is used for the inline UI icon (KindIcon) and rasterised into the globe's
 * signed-distance-field marker atlas (globe/glyphAtlas.ts), so both always match.
 *
 * Glyphs live in a 24×24 box centred on the origin (viewBox "-12 -12 24 24"), are filled, and are
 * balanced to roughly the same visual area so size keeps meaning "influence", not "kind".
 * They differ by silhouette (not colour) so they stay distinguishable in monochrome at 8–10px.
 */
export interface KindMeta {
  id: EntityKind;
  label: string;
  plural: string;
  /** SVG path data, viewBox -12 -12 24 24, fill rule evenodd */
  path: string;
  /** cell index in the WebGL glyph atlas */
  atlas: number;
}

// star: 5 points, outer radius 11.6, inner 5.0, centred slightly low so it sits optically centred
const star = (() => {
  const pts: string[] = [];
  for (let i = 0; i < 10; i++) {
    const r = i % 2 ? 5.0 : 11.6;
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    pts.push(`${(Math.cos(a) * r).toFixed(2)} ${(Math.sin(a) * r + 0.9).toFixed(2)}`);
  }
  return `M${pts.join('L')}Z`;
})();

export const KINDS: KindMeta[] = [
  // ● disc
  { id: 'person', label: 'Person', plural: 'People', path: 'M8.2 0A8.2 8.2 0 1 1 -8.2 0A8.2 8.2 0 1 1 8.2 0Z', atlas: 0 },
  // ■ square
  { id: 'company', label: 'Company', plural: 'Companies', path: 'M-7.2 -7.2H7.2V7.2H-7.2Z', atlas: 1 },
  // ◆ diamond
  { id: 'fund', label: 'Fund', plural: 'Funds', path: 'M0 -10.2L10.2 0L0 10.2L-10.2 0Z', atlas: 2 },
  // ▲ triangle
  { id: 'party', label: 'Party', plural: 'Parties', path: 'M0 -10.8L11 8.2H-11Z', atlas: 3 },
  // ★ star
  { id: 'government', label: 'Government', plural: 'Governments', path: star, atlas: 4 },
  // ◎ ring (broadcast)
  {
    id: 'media',
    label: 'Media',
    plural: 'Media',
    path: 'M9.4 0A9.4 9.4 0 1 1 -9.4 0A9.4 9.4 0 1 1 9.4 0ZM4.6 0A4.6 4.6 0 1 0 -4.6 0A4.6 4.6 0 1 0 4.6 0Z',
    atlas: 5,
  },
  // ✚ cross
  {
    id: 'organization',
    label: 'Organisation',
    plural: 'Organisations',
    path: 'M-3.3 -10H3.3V-3.3H10V3.3H3.3V10H-3.3V3.3H-10V-3.3H-3.3Z',
    atlas: 6,
  },
];

export const KIND_BY_ID = Object.fromEntries(KINDS.map((k) => [k.id, k])) as Record<EntityKind, KindMeta>;

export const ALL_KINDS: EntityKind[] = KINDS.map((k) => k.id);

/** Meta for any kind string, falling back to "organization" for unknown values from old data. */
export const kindMeta = (k: string): KindMeta => KIND_BY_ID[k as EntityKind] ?? KIND_BY_ID.organization;

export const kindLabel = (k: string): string => KIND_BY_ID[k as EntityKind]?.label ?? k;
