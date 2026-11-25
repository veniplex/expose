/** Shared data contract between the data pipeline (scripts/) and the web app (src/). */

export type EntityKind = 'person' | 'company' | 'organization' | 'government' | 'fund';

/** The five filter groups shown in the UI. */
export type LinkCategory = 'ownership' | 'leadership' | 'founder' | 'investment' | 'politics';

export interface Source {
  /** Short human label, e.g. "Wikipedia", "Wikidata", "Reuters". */
  publisher: string;
  /** Title of the page or article. */
  title: string;
  url: string;
}

export interface Entity {
  /** Stable id. Wikidata QID where available (e.g. "Q317521"). */
  id: string;
  name: string;
  kind: EntityKind;
  /** One-line neutral description. */
  description: string;
  /** Where the entity is pinned on the globe (HQ for organisations, main base for people). */
  lat: number;
  lon: number;
  /** Human readable place, e.g. "Austin, Texas". */
  place: string;
  /** ISO 3166-1 alpha-2 country code of the pin, if known. */
  country?: string;
  wikipedia?: string;
  wikidata?: string;
  /** Thumbnail URL (Wikimedia Commons), optional. */
  image?: string;
}

export interface Link {
  id: string;
  /** Entity id of the acting side (e.g. the person / the owner / the parent). */
  a: string;
  /** Entity id of the other side (e.g. the company). */
  b: string;
  category: LinkCategory;
  /** Short role text read from a's perspective, e.g. "CEO", "Founder", "Owner", "Member of party". */
  label: string;
  /** Same relation read from b's perspective, e.g. "CEO is", "Founded by", "Owned by". */
  inverseLabel: string;
  /** Start / end year when known. No `until` means ongoing or unknown. */
  since?: number;
  until?: number;
  /** One or two neutral sentences explaining the connection. Optional for auto-imported links. */
  note?: string;
  /** At least one source is mandatory. */
  sources: Source[];
  /** "wikidata" for auto-imported, "curated" for hand-maintained entries. */
  origin: 'wikidata' | 'curated';
}

export interface Graph {
  generatedAt: string;
  entities: Entity[];
  links: Link[];
}
