/**
 * GLEIF (Global LEI Foundation, CC0). For LEIs of included entities, the bulk lei-records endpoint tells which records
 * have a direct / ultimate accounting-consolidation parent (a relationship-record link); only those get a follow-up
 * request for the parent's LEI.
 */
import { cached, httpJSON, chunk, pool } from './net.mjs';

const cachedJSON = (url, transform, opts) => cached('gleif-v2:' + url, async () => transform(await httpJSON(url, opts)));

const API = 'https://api.gleif.org/api/v1';
const OPTS = { minDelay: 300, allow404: true, retries: 4 };

/** @returns Map childLEI -> {lei, name, direct: LEI|null, ultimate: LEI|null} */
export async function fetchParents(leis) {
  const recs = [];
  for (const batch of chunk([...new Set(leis)].sort(), 100)) {
    const url = `${API}/lei-records?filter%5Blei%5D=${batch.join(',')}&page%5Bsize%5D=100`;
    const rows = await cachedJSON(
      url,
      (j) =>
        (j?.data || []).map((d) => ({
          lei: d.id,
          name: d.attributes?.entity?.legalName?.name || null,
          hasDirect: !!d.relationships?.['direct-parent']?.links?.['relationship-record'],
          hasUltimate: !!d.relationships?.['ultimate-parent']?.links?.['relationship-record'],
        })),
      OPTS
    );
    recs.push(...rows);
  }
  const parentOf = (lei, kind) =>
    cachedJSON(`${API}/lei-records/${lei}/${kind}-parent`, (j) => j?.data?.id || null, OPTS).catch(() => null);
  const out = new Map(recs.map((r) => [r.lei, { lei: r.lei, name: r.name, direct: null, ultimate: null }]));
  const todo = [];
  for (const r of recs) {
    if (r.hasDirect) todo.push([r.lei, 'direct']);
    if (r.hasUltimate) todo.push([r.lei, 'ultimate']);
  }
  await pool(todo, 3, async ([lei, kind]) => {
    out.get(lei)[kind] = await parentOf(lei, kind);
  });
  return out;
}

export const gleifSource = (name, lei) => ({ publisher: 'GLEIF', title: `${name} – LEI record`, url: `https://search.gleif.org/#/record/${lei}` });
