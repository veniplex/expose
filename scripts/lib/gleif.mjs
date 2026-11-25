/**
 * GLEIF (Global LEI Foundation, CC0). For LEIs of included entities, read the direct and ultimate accounting-consolidation
 * parent from the bulk lei-records endpoint (the record's relationship links carry the parent LEI).
 */
import { cachedJSON, chunk, httpJSON } from './net.mjs';

const API = 'https://api.gleif.org/api/v1';

const leiFromLink = (u) => {
  const m = /\/lei-records\/([A-Z0-9]{20})(?:\/|$)/.exec(u || '');
  return m ? m[1] : null;
};

/** @returns Map childLEI -> {name, direct: LEI|null, ultimate: LEI|null} */
export async function fetchParents(leis) {
  const out = new Map();
  for (const batch of chunk([...new Set(leis)].sort(), 100)) {
    const url = `${API}/lei-records?filter%5Blei%5D=${batch.join(',')}&page%5Bsize%5D=100`;
    const rows = await cachedJSON(
      url,
      (j) =>
        (j?.data || []).map((d) => ({
          lei: d.id,
          name: d.attributes?.entity?.legalName?.name || null,
          direct: leiFromLink(d.relationships?.['direct-parent']?.links?.['lei-record']),
          ultimate: leiFromLink(d.relationships?.['ultimate-parent']?.links?.['lei-record']),
        })),
      { minDelay: 500 }
    );
    for (const r of rows) out.set(r.lei, r);
  }
  return out;
}

export const gleifSource = (name, lei) => ({ publisher: 'GLEIF', title: `${name} – LEI record`, url: `https://search.gleif.org/#/record/${lei}` });
export { httpJSON };
