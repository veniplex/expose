import type { EntityKind, LinkCategory, LinkOrigin } from './types';
import { KINDS } from './kinds';

/** GitHub repository (owner/name) used for "report an error" links. */
export const REPOSITORY = 'veniplex/expose';
export const REPO_URL = `https://github.com/${REPOSITORY}`;

export interface CategoryMeta {
  id: LinkCategory;
  label: string;
  /** CSS custom property holding the colour. */
  token: string;
}

/** Display order of the five connection categories. */
export const CATEGORIES: CategoryMeta[] = [
  { id: 'ownership', label: 'Ownership', token: '--r-own' },
  { id: 'leadership', label: 'Leadership', token: '--r-lead' },
  { id: 'founder', label: 'Founder', token: '--r-found' },
  { id: 'investment', label: 'Investment', token: '--r-invest' },
  { id: 'politics', label: 'Politics & people', token: '--r-pol' },
];

export const CATEGORY_BY_ID = Object.fromEntries(CATEGORIES.map((c) => [c.id, c])) as Record<
  LinkCategory,
  CategoryMeta
>;

/** Display label per kind (single source: src/kinds.ts). */
export const KIND_LABEL: Record<EntityKind, string> = Object.fromEntries(KINDS.map((k) => [k.id, k.label])) as Record<
  EntityKind,
  string
>;

/** How an imported link's origin is credited in the expanded dossier row ("via …"). */
export const ORIGIN_LABEL: Record<LinkOrigin, string> = {
  wikidata: 'Wikidata',
  curated: 'curated',
  littlesis: 'LittleSis',
  gleif: 'GLEIF',
  sec: 'SEC EDGAR',
};
