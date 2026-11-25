/** Wikidata helpers: statement slimming, entity fetching, SPARQL discovery queries, class-based kind inference. */
import { cachedJSON, sparql, chunk, qs } from './net.mjs';

export const WP_API = 'https://en.wikipedia.org/w/api.php';
export const WD_API = 'https://www.wikidata.org/w/api.php';

/** Relations extracted from Wikidata. `a` says which side is the acting side: 'T' = statement target, 'S' = statement subject. */
export const REL = {
  P112: { pl: 'founded by', cat: 'founder', a: 'T', label: 'Founder', inv: 'Founded by' },
  P169: { pl: 'chief executive officer', cat: 'leadership', a: 'T', label: 'CEO', inv: 'CEO is', single: true },
  P488: { pl: 'chairperson', cat: 'leadership', a: 'T', label: 'Chair', inv: 'Chaired by', single: true },
  P1037: { pl: 'director / manager', cat: 'leadership', a: 'T', label: 'Director', inv: 'Directed by', single: true },
  P3320: { pl: 'board member', cat: 'leadership', a: 'T', label: 'Board member', inv: 'Board member is' },
  P127: { pl: 'owned by', cat: 'ownership', a: 'T', label: 'Owner', inv: 'Owned by', fam: 'own', pct: true },
  P1830: { pl: 'owner of', cat: 'ownership', a: 'S', label: 'Owner', inv: 'Owned by', fam: 'own', pct: true },
  P749: { pl: 'parent organization', cat: 'ownership', a: 'T', label: 'Parent', inv: 'Subsidiary of', fam: 'own' },
  P355: { pl: 'subsidiary', cat: 'ownership', a: 'S', label: 'Parent', inv: 'Subsidiary of', fam: 'own' },
  P108: { pl: 'employer', cat: 'leadership', a: 'S', label: 'Employee', inv: 'Employer' },
  P102: { pl: 'member of political party', cat: 'politics', a: 'S', label: 'Party member', inv: 'Has member' },
  P463: { pl: 'member of', cat: 'politics', a: 'S', label: 'Member of', inv: 'Has member' },
  P26: { pl: 'spouse', cat: 'politics', a: 'sym', label: 'Spouse', inv: 'Spouse' },
  P40: { pl: 'child', cat: 'politics', a: 'S', label: 'Parent of', inv: 'Child of', fam: 'parent' },
  P22: { pl: 'father', cat: 'politics', a: 'T', label: 'Parent of', inv: 'Child of', fam: 'parent' },
  P25: { pl: 'mother', cat: 'politics', a: 'T', label: 'Parent of', inv: 'Child of', fam: 'parent' },
  P3373: { pl: 'sibling', cat: 'politics', a: 'sym', label: 'Sibling', inv: 'Sibling' },
  P6: { pl: 'head of government', cat: 'politics', a: 'T', label: 'Head of government', inv: 'Head of government is', single: true },
  P35: { pl: 'head of state', cat: 'politics', a: 'T', label: 'Head of state', inv: 'Head of state is', single: true },
  P1327: { pl: 'partner in business or sport', cat: 'investment', a: 'sym', label: 'Business partner', inv: 'Business partner' },
};
export const REL_ORDER = ['P127', 'P1830', 'P749', 'P355', 'P112', 'P169', 'P488', 'P1037', 'P3320', 'P108', 'P102', 'P463', 'P26', 'P40', 'P22', 'P25', 'P3373', 'P6', 'P35', 'P1327'];
// Quantities used for the influence score (value + unit are kept).
export const METRIC_PROPS = ['P2218', 'P2139', 'P2226', 'P2403', 'P1082', 'P2131'];
export const KEEP_PROPS = new Set([...Object.keys(REL), ...METRIC_PROPS, 'P159', 'P551', 'P937', 'P19', 'P17', 'P495', 'P27', 'P36', 'P625', 'P18', 'P571', 'P297', 'P131', 'P31', 'P1278', 'P5531']);
// P31 classes of "place" items that are buildings/venues/neighbourhoods rather than cities: the pin keeps their
// coordinates but the displayed place walks up P131 (located in) to a city-level item.
export const SUBCITY_CLASSES = new Set(['Q41176', 'Q3947', 'Q16560', 'Q11303', 'Q1021645', 'Q11755880', 'Q811979', 'Q1497364', 'Q483110', 'Q24354', 'Q33506', 'Q123705', 'Q188509', 'Q2983893', 'Q79007', 'Q4989906', 'Q57821', 'Q1137809', 'Q180673', 'Q2065736']);
export const CATEGORIES = new Set(['ownership', 'leadership', 'founder', 'investment', 'politics']);
export const KINDS = new Set(['person', 'company', 'organization', 'government', 'fund', 'party', 'media']);

// Currency -> USD (rough, only used to rank entities against each other on a log scale).
const USD_RATE = { Q4917: 1, Q4916: 1.08, Q25224: 1.27, Q8146: 0.0067, Q39099: 0.14, Q80524: 0.012, Q25344: 1.12, Q1104069: 0.73, Q202040: 0.00075, Q173117: 0.19 };

export function yearOf(v) {
  if (!v || typeof v.time !== 'string') return null;
  if ((v.precision ?? 0) < 9) return null;
  const m = /^([+-])(\d+)-/.exec(v.time);
  if (!m || m[1] === '-') return null;
  const y = parseInt(m[2], 10);
  return y > 0 ? y : null;
}

function slimValue(snak) {
  if (!snak || snak.snaktype !== 'value' || !snak.datavalue) return null;
  const { type, value } = snak.datavalue;
  switch (type) {
    case 'wikibase-entityid':
      return value.id;
    case 'time':
      return { y: yearOf(value) };
    case 'globecoordinate':
      return { lat: value.latitude, lon: value.longitude };
    case 'quantity':
      return Number(value.amount);
    case 'string':
      return value;
    default:
      return null;
  }
}

function slimStatement(st) {
  const q = {};
  const qual = st.qualifiers || {};
  if (qual.P580?.[0]) q.start = slimValue(qual.P580[0])?.y ?? null;
  if (qual.P582?.[0]) q.end = slimValue(qual.P582[0]) ? (slimValue(qual.P582[0]).y ?? 'unknown') : null;
  if (qual.P625?.[0]) q.coord = slimValue(qual.P625[0]);
  if (qual.P1107?.[0]) q.pct = slimValue(qual.P1107[0]);
  if (qual.P585?.[0]) q.when = slimValue(qual.P585[0])?.y ?? null;
  const refs = [];
  for (const r of st.references || []) for (const s of r.snaks?.P854 || []) {
    const u = slimValue(s);
    if (typeof u === 'string') refs.push(u);
  }
  const out = { rank: st.rank, v: slimValue(st.mainsnak), q, refs };
  const dv = st.mainsnak?.datavalue;
  if (dv?.type === 'quantity' && typeof dv.value.unit === 'string') out.u = dv.value.unit.split('/').pop();
  return out;
}

function slimEntity(e) {
  const claims = {};
  for (const [pid, sts] of Object.entries(e.claims || {})) {
    if (!KEEP_PROPS.has(pid)) continue;
    claims[pid] = sts.filter((s) => s.rank !== 'deprecated').map(slimStatement);
    // quantity claims are only needed for ranking: keep the 4 most recent
    if (METRIC_PROPS.includes(pid)) claims[pid] = claims[pid].sort((x, y) => (y.q.when || 0) - (x.q.when || 0)).slice(0, 4);
  }
  return {
    id: e.id,
    label: e.labels?.en?.value ?? e.labels?.mul?.value ?? null,
    description: e.descriptions?.en?.value ?? null,
    aliases: (e.aliases?.en || []).map((x) => x.value).slice(0, 12),
    wikipedia: e.sitelinks?.enwiki?.title ?? null,
    claims,
  };
}

/** Fetch slimmed items (claims we care about) for QIDs. Missing items are omitted. */
export async function fetchEntities(ids) {
  const out = new Map();
  for (const batch of chunk([...new Set(ids)].sort(), 50)) {
    const url = `${WD_API}?${qs({ action: 'wbgetentities', format: 'json', ids: batch.join('|'), props: 'labels|descriptions|aliases|claims|sitelinks', languages: 'en|mul', sitefilter: 'enwiki' })}`;
    const slim = await cachedJSON(url, (j) => {
      const m = {};
      for (const [k, e] of Object.entries(j.entities || {})) if (!e.missing) m[k] = slimEntity(e);
      return m;
    }, { minDelay: 200 });
    for (const [k, e] of Object.entries(slim)) {
      out.set(k, e);
      out.set(e.id, e);
    }
  }
  return out;
}

/** statements of a property, best first: preferred rank, no end date, latest start. */
export function statements(ent, pid) {
  const list = (ent?.claims?.[pid] || []).filter((s) => s.v != null);
  return [...list].sort((x, y) => score(y) - score(x));
  function score(s) {
    return (s.rank === 'preferred' ? 1000 : 0) + (s.q.end == null ? 500 : 0) + (s.q.start || 0) / 10000;
  }
}

/** Latest value of a quantity property converted to USD (null when unknown / unconvertible). */
export function usdValue(ent, pid) {
  let best = null;
  for (const st of ent?.claims?.[pid] || []) {
    if (typeof st.v !== 'number' || !(st.v > 0)) continue;
    const rate = USD_RATE[st.u];
    if (!rate) continue;
    const key = (st.q.when || 0) * 10 + (st.rank === 'preferred' ? 5 : 0);
    if (!best || key > best.key) best = { key, usd: st.v * rate };
  }
  return best?.usd ?? null;
}
export function plainValue(ent, pid) {
  let best = null;
  for (const st of ent?.claims?.[pid] || []) {
    if (typeof st.v !== 'number' || !(st.v > 0)) continue;
    const key = (st.q.when || 0) * 10 + (st.rank === 'preferred' ? 5 : 0);
    if (!best || key > best.key) best = { key, v: st.v };
  }
  return best?.v ?? null;
}

// ---------------------------------------------------------------- SPARQL: sitelinks, classes, discovery

const values = (ids) => ids.map((i) => `wd:${i}`).join(' ');

/** qid -> number of Wikipedia/Wikimedia sitelinks (notability proxy). */
export async function sitelinkCounts(ids) {
  const out = new Map();
  for (const batch of chunk([...new Set(ids)].sort(), 400)) {
    const rows = await sparql(`SELECT ?x ?s WHERE { VALUES ?x { ${values(batch)} } ?x wikibase:sitelinks ?s }`);
    for (const r of rows) out.set(r.x, r.s);
  }
  return out;
}

/** Class flags used for kind inference. */
export const CLASS_FLAGS = {
  party: ['Q7278'],
  media: ['Q11032', 'Q192283', 'Q15265344', 'Q2001305', 'Q141683', 'Q1331793', 'Q1153191', 'Q41298', 'Q14350'],
  fund: ['Q1061648', 'Q4230006', 'Q5418962', 'Q105611', 'Q1752459', 'Q182103', 'Q5978114'],
  cbank: ['Q66344'],
  igo: ['Q245065', 'Q484652'],
  govt: ['Q3624078', 'Q6256', 'Q7188'],
  agency: ['Q327333'],
  company: ['Q4830453', 'Q783794', 'Q891723'],
  org: ['Q43229'],
};
const FLAG_OF = new Map(Object.entries(CLASS_FLAGS).flatMap(([f, qs_]) => qs_.map((q) => [q, f])));

/** qid -> Set of class flags (via P31/P279*). */
export async function classFlags(ids) {
  const out = new Map(ids.map((i) => [i, new Set()]));
  const classes = [...FLAG_OF.keys()];
  for (const batch of chunk([...new Set(ids)].sort(), 250)) {
    const rows = await sparql(`SELECT DISTINCT ?x ?c WHERE { VALUES ?x { ${values(batch)} } VALUES ?c { ${values(classes)} } ?x wdt:P31/wdt:P279* ?c }`);
    for (const r of rows) out.get(r.x)?.add(FLAG_OF.get(r.c));
  }
  return out;
}

/** Kind inference. Seed `kind` overrides are applied by the caller. */
export function inferKind(ent, flags, hint) {
  if ((ent.claims?.P31 || []).some((s) => s.v === 'Q5')) return 'person';
  const f = flags || new Set();
  if (f.has('party')) return 'party';
  if (f.has('media')) return 'media';
  if (f.has('fund')) return 'fund';
  if (f.has('cbank') || f.has('igo')) return 'organization';
  if (f.has('govt')) return 'government';
  if (f.has('company')) return 'company';
  if (f.has('agency')) return 'government';
  if (hint && hint !== 'person') return hint;
  return 'organization';
}

const NOT_DISSOLVED = (v) => `FILTER NOT EXISTS { ${v} wdt:P576 [] }`;

/**
 * Discovery queries. Each returns [{id, s}] ranked best-first. A failing query is reported and skipped
 * (the caller guards against a graph that shrinks drastically).
 */
export async function discover(log) {
  const sets = {};
  const run = async (name, q, limit) => {
    try {
      const rows = await sparql(q);
      sets[name] = rows.slice(0, limit);
      log(`  discovery ${name}: ${sets[name].length}`);
    } catch (e) {
      log(`  discovery ${name} FAILED: ${e.message}`);
      sets[name] = [];
    }
  };
  await run('countries', `SELECT ?id ?s WHERE { ?id wdt:P31 wd:Q3624078. ${NOT_DISSOLVED('?id')} ?id wikibase:sitelinks ?s } ORDER BY DESC(?s)`, 260);
  // current heads of state / government (no end-date qualifier)
  await run('leaders', `SELECT DISTINCT ?c ?id ?s WHERE { ?c wdt:P31 wd:Q3624078. ${NOT_DISSOLVED('?c')} { ?c p:P35 ?st. ?st ps:P35 ?id. FILTER NOT EXISTS { ?st pq:P582 [] } } UNION { ?c p:P6 ?st. ?st ps:P6 ?id. FILTER NOT EXISTS { ?st pq:P582 [] } } ?id wikibase:sitelinks ?s }`, 800);
  await run('billionaires', `SELECT ?id (MAX(?a) AS ?nw) ?s WHERE { ?id wdt:P31 wd:Q5; p:P2218/psv:P2218 ?v. ?v wikibase:quantityAmount ?a; wikibase:quantityUnit wd:Q4917. FILTER NOT EXISTS { ?id wdt:P570 [] } ?id wikibase:sitelinks ?s. FILTER(?s >= 10) } GROUP BY ?id ?s ORDER BY DESC(?nw) LIMIT 450`, 330);
  for (const p of ['P2139', 'P2403', 'P2226']) {
    await run('co_' + p, `SELECT ?id ?s WHERE { ?id wdt:${p} ?x. ${NOT_DISSOLVED('?id')} ?id wikibase:sitelinks ?s. FILTER(?s >= 35) } ORDER BY DESC(?s) LIMIT 600`, 600);
  }
  await run('mcap', `SELECT ?id (MAX(?a) AS ?amt) ?s WHERE { ?id p:P2226/psv:P2226 ?v. ?v wikibase:quantityAmount ?a; wikibase:quantityUnit wd:Q4917. ?id wikibase:sitelinks ?s. ${NOT_DISSOLVED('?id')} } GROUP BY ?id ?s ORDER BY DESC(?amt) LIMIT 200`, 200);
  await run('parties_gov', `SELECT DISTINCT ?id ?s WHERE { ?c wdt:P31 wd:Q3624078. ${NOT_DISSOLVED('?c')} ?c p:P6 ?st. ?st ps:P6 ?h. FILTER NOT EXISTS { ?st pq:P582 [] } ?h wdt:P102 ?id. ?id wdt:P31 wd:Q7278. ${NOT_DISSOLVED('?id')} ?id wikibase:sitelinks ?s }`, 200);
  await run('parties', `SELECT ?id ?s WHERE { ?id wdt:P31 wd:Q7278. ${NOT_DISSOLVED('?id')} ?id wikibase:sitelinks ?s. FILTER(?s >= 25) } ORDER BY DESC(?s) LIMIT 250`, 250);
  await run('media', `SELECT ?id ?s WHERE { VALUES ?cls { ${values(CLASS_FLAGS.media.filter((c) => c !== 'Q14350'))} } ?id wdt:P31 ?cls. ${NOT_DISSOLVED('?id')} ?id wikibase:sitelinks ?s. FILTER(?s >= 30) } ORDER BY DESC(?s) LIMIT 300`, 130);
  await run('funds', `SELECT ?id ?s WHERE { VALUES ?cls { ${values(CLASS_FLAGS.fund)} } ?id wdt:P31 ?cls. ${NOT_DISSOLVED('?id')} ?id wikibase:sitelinks ?s. FILTER(?s >= 15) } ORDER BY DESC(?s) LIMIT 300`, 90);
  await run('orgs', `SELECT ?id ?s WHERE { VALUES ?cls { wd:Q66344 wd:Q245065 wd:Q484652 wd:Q155271 } ?id wdt:P31 ?cls. ${NOT_DISSOLVED('?id')} ?id wikibase:sitelinks ?s. FILTER(?s >= 45) } ORDER BY DESC(?s) LIMIT 300`, 110);
  return sets;
}

/**
 * Reverse bridge lookup: items (not in `included`) that point to >= 1 of `targets` via strong structural
 * properties. Returns rows {x, t}.
 */
export async function reverseNeighbours(targets, minSitelinks = 25) {
  const rows = [];
  const props = ['P127', 'P749', 'P355', 'P112', 'P169', 'P488', 'P3320', 'P1830', 'P26', 'P40', 'P22', 'P25', 'P3373', 'P6', 'P35'];
  for (const batch of chunk(targets, 150)) {
    const part = await sparql(
      `SELECT DISTINCT ?x ?t WHERE { VALUES ?t { ${values(batch)} } VALUES ?p { ${props.map((p) => 'wdt:' + p).join(' ')} } ?x ?p ?t. ?x wikibase:sitelinks ?s. FILTER(?s >= ${minSitelinks}) } LIMIT 30000`
    );
    rows.push(...part);
  }
  return rows;
}

/** LEI -> {qid, s} for items carrying the given LEIs (P1278). */
export async function qidsByLei(leis) {
  const out = new Map();
  for (const batch of chunk([...new Set(leis)].sort(), 200)) {
    const lit = batch.map((l) => JSON.stringify(l)).join(' ');
    const rows = await sparql(`SELECT ?lei ?x ?s WHERE { VALUES ?lei { ${lit} } ?x wdt:P1278 ?lei. ?x wikibase:sitelinks ?s }`);
    for (const r of rows) if (!out.has(r.lei) || out.get(r.lei).s < r.s) out.set(r.lei, { qid: r.x, s: r.s });
  }
  return out;
}

/** Ownership wording follows the recorded proportion. Stakes held by funds are investments. */
export function ownershipWording(pctRaw, aIsFund) {
  let pct = typeof pctRaw === 'number' && pctRaw > 0 ? pctRaw : null;
  if (pct != null && pct > 1 && pct <= 100) pct /= 100;
  if (pct != null && pct > 1) pct = null;
  const fmt = (v) => `${Math.round(v * 1000) / 10}%`;
  let label, inv;
  if (pct != null && pct >= 0.999) [label, inv] = ['Owner', 'Owned by'];
  else if (pct != null && pct >= 0.5) [label, inv] = ['Majority owner', 'Majority-owned by'];
  else if (pct != null) [label, inv] = [`Shareholder (${fmt(pct)})`, `Has shareholder (${fmt(pct)})`];
  else if (aIsFund) [label, inv] = ['Shareholder', 'Has shareholder'];
  else [label, inv] = ['Owner or shareholder', 'Owned (in part) by'];
  return { label, inv, cat: aIsFund ? 'investment' : 'ownership', fam: aIsFund ? 'sh' : 'own' };
}
