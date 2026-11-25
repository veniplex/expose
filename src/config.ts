import type { EntityKind, LinkCategory } from './types';

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

export const KIND_LABEL: Record<EntityKind, string> = {
  person: 'Person',
  company: 'Company',
  organization: 'Organisation',
  government: 'Government',
  fund: 'Fund',
};

/** Marker shape per kind: 0 = circle (people), 1 = square (companies, funds), 2 = diamond (institutions). */
export const KIND_SHAPE: Record<EntityKind, number> = {
  person: 0,
  company: 1,
  fund: 1,
  organization: 2,
  government: 2,
};
