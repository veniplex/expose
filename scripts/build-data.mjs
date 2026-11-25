#!/usr/bin/env node
/**
 * EXPOSE data pipeline.
 *
 *   node scripts/build-data.mjs [--strict] [--refresh]
 *
 * Reads  data/seed.json      (entities, identified by English Wikipedia titles)
 *        data/curated.json   (hand-curated links with sources)
 * Pulls  Wikipedia + Wikidata public APIs (built-in fetch only, zero dependencies)
 * Writes public/data/graph.json  (contract: src/types.ts -> Graph)
 *
 * Flags
 *   --strict   fail (exit 1) on network errors / unresolved titles / missing coordinates
 *              instead of tolerating them. Without it, a network failure with an existing
 *              graph.json leaves that file untouched and exits 0.
 *   --refresh  ignore the on-disk HTTP cache (scripts/.cache, 24h TTL).
 *
 * Env: EXPOSE_UA overrides the User-Agent string.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SEED_FILE = path.join(ROOT, 'data/seed.json');
const CURATED_FILE = path.join(ROOT, 'data/curated.json');
const OUT_FILE = path.join(ROOT, 'public/data/graph.json');
const CACHE_DIR = path.join(ROOT, 'scripts/.cache');
const ALIAS_FILE = path.join(ROOT, 'data/place-aliases.json');

const STRICT = process.argv.includes('--strict');
const REFRESH = process.argv.includes('--refresh');
// Wikimedia throttles bare custom UAs coming from shared egress IPs, so the UA keeps a
// browser-compatible prefix. It carries no personal information.
const UA = process.env.EXPOSE_UA || 'Mozilla/5.0 (compatible; expose-data-builder/1.0)';
const WP_API = 'https://en.wikipedia.org/w/api.php';
const WD_API = 'https://www.wikidata.org/w/api.php';
const CACHE_TTL_MS = 24 * 3600 * 1000;
const DELAY_MS = 250;

class NetworkError extends Error {}

// ---------------------------------------------------------------- HTTP + cache

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let lastRequestAt = 0;

async function httpJSON(url) {
  let lastErr;
  for (let attempt = 0; attempt < 6; attempt++) {
    const wait = lastRequestAt + DELAY_MS - Date.now();
    if (wait > 0) await sleep(wait);
    lastRequestAt = Date.now();
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
      if (res.status === 429 || res.status >= 500) {
        const ra = Number(res.headers.get('retry-after'));
        const backoff = ra > 0 ? ra * 1000 : 1500 * 2 ** attempt;
        lastErr = new Error(`HTTP ${res.status}`);
        await sleep(Math.min(backoff, 30000));
        continue;
      }
      if (!res.ok) throw new NetworkError(`HTTP ${res.status} for ${url.slice(0, 120)}`);
      const text = await res.text();
      try {
        return JSON.parse(text);
      } catch {
        lastErr = new Error('invalid JSON');
        await sleep(1500 * 2 ** attempt);
      }
    } catch (e) {
      if (e instanceof NetworkError) throw e;
      lastErr = e;
      await sleep(1500 * 2 ** attempt);
    }
  }
  throw new NetworkError(`Request failed after retries: ${lastErr?.message} (${url.slice(0, 120)})`);
}

/** Fetch JSON, run `transform` on it (to slim it down) and cache the transformed result. */
async function cachedJSON(url, transform = (x) => x) {
  const key = crypto.createHash('sha1').update(url).digest('hex');
  const file = path.join(CACHE_DIR, key + '.json');
  if (!REFRESH) {
    try {
      const st = fs.statSync(file);
      if (Date.now() - st.mtimeMs < CACHE_TTL_MS) return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      /* miss */
    }
  }
  const data = transform(await httpJSON(url));
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(path.join(CACHE_DIR, '.gitignore'), '*\n');
    fs.writeFileSync(file, JSON.stringify(data));
  } catch {
    /* cache is best effort */
  }
  return data;
}

const qs = (o) => new URLSearchParams(o).toString();
const chunk = (arr, n) => Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, i * n + n));

// ---------------------------------------------------------------- Wikidata helpers

/** Relations extracted from Wikidata. `a` says which side is the acting side: 'T' = statement target, 'S' = statement subject. */
const REL = {
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
const REL_ORDER = ['P127', 'P1830', 'P749', 'P355', 'P112', 'P169', 'P488', 'P1037', 'P3320', 'P108', 'P102', 'P463', 'P26', 'P40', 'P22', 'P25', 'P3373', 'P6', 'P35', 'P1327'];
const KEEP_PROPS = new Set([...Object.keys(REL), 'P159', 'P551', 'P937', 'P19', 'P17', 'P495', 'P27', 'P36', 'P625', 'P18', 'P571', 'P297', 'P131', 'P31']);
// P31 classes of "place" items that are buildings/venues/neighbourhoods rather than cities: the pin keeps their
// coordinates but the displayed place walks up P131 (located in) to a city-level item.
const SUBCITY_CLASSES = new Set(['Q41176', 'Q3947', 'Q16560', 'Q11303', 'Q1021645', 'Q11755880', 'Q811979', 'Q1497364', 'Q483110', 'Q24354', 'Q33506', 'Q123705', 'Q188509', 'Q2983893', 'Q79007', 'Q4989906', 'Q57821', 'Q1137809', 'Q180673', 'Q2065736']);
const CATEGORIES = new Set(['ownership', 'leadership', 'founder', 'investment', 'politics']);
const KINDS = new Set(['person', 'company', 'organization', 'government', 'fund']);

function yearOf(v) {
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
  const refs = [];
  for (const r of st.references || []) for (const s of r.snaks?.P854 || []) {
    const u = slimValue(s);
    if (typeof u === 'string') refs.push(u);
  }
  return { rank: st.rank, v: slimValue(st.mainsnak), q, refs };
}

function slimEntity(e) {
  const claims = {};
  for (const [pid, sts] of Object.entries(e.claims || {})) {
    if (!KEEP_PROPS.has(pid)) continue;
    claims[pid] = sts.filter((s) => s.rank !== 'deprecated').map(slimStatement);
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

async function fetchEntities(ids) {
  const out = new Map();
  for (const batch of chunk([...new Set(ids)], 25)) {
    const url = `${WD_API}?${qs({ action: 'wbgetentities', format: 'json', ids: batch.join('|'), props: 'labels|descriptions|aliases|claims|sitelinks', languages: 'en|mul', sitefilter: 'enwiki' })}`;
    const slim = await cachedJSON(url, (j) => {
      const m = {};
      for (const [k, e] of Object.entries(j.entities || {})) if (!e.missing) m[k] = slimEntity(e);
      return m;
    });
    for (const [k, e] of Object.entries(slim)) {
      out.set(k, e);
      out.set(e.id, e);
    }
  }
  return out;
}

/** statements of a property, best first: preferred rank, no end date, latest start. */
function statements(ent, pid) {
  const list = (ent?.claims?.[pid] || []).filter((s) => s.v != null);
  return [...list].sort((x, y) => score(y) - score(x));
  function score(s) {
    return (s.rank === 'preferred' ? 1000 : 0) + (s.q.end == null ? 500 : 0) + (s.q.start || 0) / 10000;
  }
}

// ---------------------------------------------------------------- main pipeline

async function resolveTitles(seed) {
  const titles = seed.map((s) => s.title);
  const map = new Map(); // seed title -> {qid, wpTitle}
  for (const batch of chunk(titles, 50)) {
    const url = `${WP_API}?${qs({ action: 'query', format: 'json', redirects: '1', converttitles: '1', prop: 'pageprops', ppprop: 'wikibase_item', titles: batch.join('|') })}`;
    const j = await cachedJSON(url, (r) => r.query || {});
    const hop = new Map();
    for (const n of j.normalized || []) hop.set(n.from, n.to);
    for (const r of j.redirects || []) hop.set(r.from, r.to);
    const pages = Object.values(j.pages || {});
    const byTitle = new Map(pages.map((p) => [p.title, p]));
    for (const t of batch) {
      let cur = t;
      for (let i = 0; i < 5 && hop.has(cur); i++) cur = hop.get(cur);
      const page = byTitle.get(cur);
      const qid = page?.pageprops?.wikibase_item;
      if (qid) map.set(t, { qid, wpTitle: page.title });
    }
  }
  return map;
}

function bestCoordSource(ent, isPerson) {
  const pids = isPerson ? ['P551', 'P937', 'P19'] : ['P159'];
  const cands = [];
  for (const pid of pids) for (const st of statements(ent, pid).slice(0, 2)) cands.push({ pid, qid: st.v, coord: st.q.coord || null });
  return cands;
}

async function resolveGeo(entities) {
  // Phase A: candidate place items per entity
  const candsByQid = new Map();
  const need = new Set();
  for (const e of entities) {
    const cands = bestCoordSource(e.data, e.kind === 'person');
    candsByQid.set(e.qid, cands);
    for (const c of cands) if (typeof c.qid === 'string') need.add(c.qid);
    for (const pid of ['P17', 'P495', 'P27', 'P36']) for (const st of statements(e.data, pid).slice(0, 2)) if (typeof st.v === 'string') need.add(st.v);
  }
  const items = await fetchEntities([...need]);
  // Phase B: countries + capitals of the places
  const need2 = new Set();
  for (const it of items.values()) for (const pid of ['P17', 'P36']) for (const st of statements(it, pid).slice(0, 2)) if (typeof st.v === 'string' && !items.has(st.v)) need2.add(st.v);
  for (const [k, v] of await fetchEntities([...need2])) items.set(k, v);
  // Phase C: capitals of countries fetched in phase B
  const need3 = new Set();
  for (const it of items.values()) for (const st of statements(it, 'P36').slice(0, 2)) if (typeof st.v === 'string' && !items.has(st.v)) need3.add(st.v);
  for (const [k, v] of await fetchEntities([...need3])) items.set(k, v);

  // Walk up P131 for building/venue/neighbourhood-type places to get a city-level display name.
  for (let round = 0; round < 3; round++) {
    const up = new Set();
    for (const c of [...candsByQid.values()].flat()) {
      let it = items.get(c.qid);
      for (let d = 0; it && isSubcity(it) && d < 4; d++) {
        const parent = statements(it, 'P131')[0]?.v;
        if (typeof parent !== 'string') break;
        if (!items.has(parent)) up.add(parent);
        it = items.get(parent);
      }
    }
    if (!up.size) break;
    for (const [k, v] of await fetchEntities([...up])) items.set(k, v);
  }
  function isSubcity(it) {
    return (it.claims?.P31 || []).some((st) => SUBCITY_CLASSES.has(st.v));
  }
  function cityLabel(it) {
    let cur = it;
    for (let d = 0; cur && isSubcity(cur) && d < 4; d++) {
      const parent = items.get(statements(cur, 'P131')[0]?.v);
      if (!parent) break;
      cur = parent;
    }
    return cur?.label ?? it.label;
  }
  const coordOf = (it) => {
    const st = statements(it, 'P625')[0];
    return st && st.v && typeof st.v === 'object' ? st.v : null;
  };
  const alpha2 = (countryQid) => {
    const c = items.get(countryQid);
    const v = statements(c, 'P297')[0]?.v;
    return typeof v === 'string' ? v : undefined;
  };
  const countryOfItem = (it) => {
    for (const st of statements(it, 'P17').slice(0, 1)) if (typeof st.v === 'string') return alpha2(st.v);
    return undefined;
  };
  const capitalGeo = (countryQid) => {
    const c = items.get(countryQid);
    if (!c) return null;
    for (const st of statements(c, 'P36').slice(0, 2)) {
      const cap = items.get(st.v);
      const co = cap && coordOf(cap);
      if (co) return { lat: co.lat, lon: co.lon, place: cap.label, country: alpha2(countryQid) };
    }
    const co = coordOf(c);
    return co ? { lat: co.lat, lon: co.lon, place: c.label, country: alpha2(countryQid) } : null;
  };

  const geo = new Map();
  for (const e of entities) {
    let g = null;
    const own = e.data;
    if (e.kind === 'government') {
      const ownCountry = statements(own, 'P297')[0]?.v;
      for (const st of statements(own, 'P36').slice(0, 2)) {
        const cap = items.get(st.v);
        const co = cap && coordOf(cap);
        if (co) {
          g = { lat: co.lat, lon: co.lon, place: cap.label, country: typeof ownCountry === 'string' ? ownCountry : countryOfItem(cap) };
          break;
        }
      }
      if (!g) {
        const co = coordOf(own);
        if (co) g = { lat: co.lat, lon: co.lon, place: own.label, country: typeof ownCountry === 'string' ? ownCountry : undefined };
      }
    }
    if (!g) {
      for (const c of candsByQid.get(e.qid) || []) {
        const it = items.get(c.qid);
        if (!it) continue;
        const co = c.coord || coordOf(it);
        if (co) {
          g = { lat: co.lat, lon: co.lon, place: cityLabel(it), country: countryOfItem(it) };
          break;
        }
      }
    }
    if (!g && e.kind !== 'person') {
      const co = coordOf(own);
      if (co) g = { lat: co.lat, lon: co.lon, place: own.label };
    }
    if (!g) {
      const pids = e.kind === 'person' ? ['P27'] : ['P17', 'P495'];
      for (const pid of pids) {
        for (const st of statements(own, pid).slice(0, 2)) {
          const cg = typeof st.v === 'string' && capitalGeo(st.v);
          if (cg) {
            g = { ...cg, approx: true };
            break;
          }
        }
        if (g) break;
      }
    }
    if (g && !g.country) {
      for (const pid of ['P17', 'P495', 'P27']) {
        const v = statements(own, pid)[0]?.v;
        if (typeof v === 'string' && alpha2(v)) {
          g.country = alpha2(v);
          break;
        }
      }
    }
    geo.set(e.qid, g);
  }
  return geo;
}

function wpUrl(title) {
  return 'https://en.wikipedia.org/wiki/' + encodeURIComponent(title.replace(/ /g, '_')).replace(/%3A/g, ':').replace(/%2C/g, ',');
}
function cap1(s) {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}
function hostOf(u) {
  try {
    const x = new URL(u);
    if (!/^https?:$/.test(x.protocol)) return null;
    return x.hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}
const sha = (s) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 10);
const norm = (t) => t.replace(/_/g, ' ').trim().toLowerCase();

async function main() {
  const seed = JSON.parse(fs.readFileSync(SEED_FILE, 'utf8'));
  const curated = fs.existsSync(CURATED_FILE) ? JSON.parse(fs.readFileSync(CURATED_FILE, 'utf8')) : [];
  const warnings = [];
  const warn = (m) => {
    warnings.push(m);
    console.warn('WARN ' + m);
  };

  console.log(`Seed: ${seed.length} entries, curated: ${curated.length} links`);
  console.log('Resolving titles via Wikipedia...');
  const resolved = await resolveTitles(seed);

  const byQid = new Map(); // qid -> {qid, seed, kind, wpTitle}
  const titleIndex = new Map(); // normalised title -> qid
  const unresolved = [];
  for (const s of seed) {
    if (!KINDS.has(s.kind)) throw new Error(`Seed "${s.title}": bad kind ${s.kind}`);
    const r = resolved.get(s.title);
    if (!r) {
      unresolved.push(s.title);
      continue;
    }
    if (byQid.has(r.qid)) {
      warn(`Seed titles "${byQid.get(r.qid).seed.title}" and "${s.title}" resolve to the same item ${r.qid}; keeping first`);
      titleIndex.set(norm(s.title), r.qid);
      continue;
    }
    byQid.set(r.qid, { qid: r.qid, seed: s, kind: s.kind, wpTitle: r.wpTitle });
    titleIndex.set(norm(s.title), r.qid);
    titleIndex.set(norm(r.wpTitle), r.qid);
  }
  if (unresolved.length) {
    console.warn(`Unresolved seed titles (${unresolved.length}): ${unresolved.join(' | ')}`);
    if (STRICT) throw new Error('Unresolved seed titles in --strict mode');
  }

  console.log(`Fetching ${byQid.size} Wikidata items...`);
  const items = await fetchEntities([...byQid.keys()]);
  const ents = [];
  for (const e of byQid.values()) {
    const data = items.get(e.qid);
    if (!data) {
      warn(`No Wikidata item data for ${e.seed.title} (${e.qid})`);
      continue;
    }
    e.data = data;
    ents.push(e);
  }
  const inSeed = new Map(ents.map((e) => [e.qid, e])); // canonical id handling
  for (const e of ents) if (e.data.id !== e.qid) inSeed.set(e.data.id, e);

  console.log('Resolving coordinates...');
  const geo = await resolveGeo(ents);

  // ------------------------------------------------ entities
  const aliases = fs.existsSync(ALIAS_FILE) ? JSON.parse(fs.readFileSync(ALIAS_FILE, 'utf8')) : {};
  const entities = [];
  const noCoords = [];
  const approx = [];
  for (const e of ents) {
    const s = e.seed;
    let g = geo.get(e.qid);
    if (Number.isFinite(s.lat) && Number.isFinite(s.lon)) g = { ...(g || {}), lat: s.lat, lon: s.lon, approx: false, place: s.place ?? g?.place };
    if (g?.approx) approx.push(`${s.title} -> ${g.place} (country fallback)`);
    if (!g || !Number.isFinite(g.lat)) {
      noCoords.push(s.title);
      continue;
    }
    const img = statements(e.data, 'P18')[0]?.v;
    const ent = {
      id: e.qid,
      name: s.name || e.data.label || e.wpTitle,
      kind: e.kind,
      description: s.description || cap1(e.data.description) || '',
      lat: round(g.lat),
      lon: round(g.lon),
      place: s.place || aliases[g.place] || g.place || '',
      country: s.country || g.country,
      wikipedia: wpUrl(e.data.wikipedia || e.wpTitle),
      wikidata: `https://www.wikidata.org/wiki/${e.qid}`,
      aliases: buildAliases(s.name || e.data.label || e.wpTitle, [...(s.aliases || []), ...(e.data.aliases || []), e.data.label, e.wpTitle]),
      image: typeof img === 'string' ? `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(img.replace(/ /g, '_'))}?width=160` : undefined,
    };
    if (!ent.country) delete ent.country;
    if (!ent.aliases.length) delete ent.aliases;
    if (!ent.image) delete ent.image;
    entities.push(ent);
  }
  if (noCoords.length) {
    console.warn(`Entities without coordinates (add lat/lon overrides in seed.json): ${noCoords.join(' | ')}`);
    if (STRICT) throw new Error('Missing coordinates in --strict mode');
  }
  const entIds = new Set(entities.map((e) => e.id));
  const entById = new Map(entities.map((e) => [e.id, e]));

  // ------------------------------------------------ links
  let endedUnknown = 0;
  const links = [];
  const linkIndex = new Map(); // a|b|cat|fam -> [link]

  const compatible = (x, y) => x == null || y == null || x === y;
  function addLink(l, fam) {
    const key = `${l.a}|${l.b}|${l.category}|${fam}`;
    const list = linkIndex.get(key) || [];
    for (const ex of list) {
      if (compatible(ex.since, l.since)) {
        // mirrored / duplicate statement: merge
        if (ex.since == null) ex.since = l.since;
        if (ex.until == null) ex.until = l.until;
        if (!ex.note && l.note) ex.note = l.note;
        if (ex.label === 'Parent' && l.label !== 'Parent') {
          ex.label = l.label;
          ex.inverseLabel = l.inverseLabel;
        }
        for (const src of l.sources) if (!ex.sources.some((x) => x.url === src.url)) ex.sources.push(src);
        return ex;
      }
    }
    if (l.since == null) delete l.since;
    if (l.until == null) delete l.until;
    if (!l.note) delete l.note;
    links.push(l);
    list.push(l);
    linkIndex.set(key, list);
    return l;
  }

  for (const e of ents) {
    if (!entIds.has(e.qid)) continue;
    const S = e.qid;
    const subjName = entById.get(S).name;
    for (const pid of REL_ORDER) {
      const rel = REL[pid];
      let sts = (e.data.claims[pid] || []).filter((st) => typeof st.v === 'string');
      if (rel.single && sts.some((st) => st.rank === 'preferred')) {
        // a preferred-rank (current) holder exists: drop stale open-ended non-preferred holders
        sts = sts.filter((st) => st.rank === 'preferred' || st.q.end != null);
      }
      for (const st of sts) {
        const T = inSeed.get(st.v)?.qid;
        if (!T || T === S || !entIds.has(T)) continue;
        let a, b, label = rel.label, inv = rel.inv, cat = rel.cat, fam = rel.fam || rel.label;
        if (rel.a === 'T') [a, b] = [T, S];
        else if (rel.a === 'S') [a, b] = [S, T];
        else [a, b] = S < T ? [S, T] : [T, S];
        // Ended in an unknown year: the contract cannot express "ended, year unknown", and omitting `until`
        // would show a former role as current, so such statements are skipped.
        if (st.q.end === 'unknown') {
          endedUnknown++;
          continue;
        }
        // Ownership wording follows the recorded proportion (P1107). Stakes held by funds are investments.
        if (rel.pct) {
          let pctv = typeof st.q.pct === 'number' && st.q.pct > 0 ? st.q.pct : null;
          if (pctv != null && pctv > 1 && pctv <= 100) pctv /= 100;
          const isFund = entById.get(a).kind === 'fund';
          const fmt = (v) => `${Math.round(v * 1000) / 10}%`;
          if (pctv != null && pctv >= 0.999) [label, inv] = ['Owner', 'Owned by'];
          else if (pctv != null && pctv >= 0.5) [label, inv] = ['Majority owner', 'Majority-owned by'];
          else if (pctv != null) [label, inv] = [`Shareholder (${fmt(pctv)})`, `Has shareholder (${fmt(pctv)})`];
          else if (isFund) [label, inv] = ['Shareholder', 'Has shareholder'];
          else [label, inv] = ['Owner or shareholder', 'Owned (in part) by'];
          cat = isFund ? 'investment' : 'ownership';
          fam = isFund ? 'sh' : 'own';
        }
        const since = st.q.start ?? (pid === 'P112' ? statements(e.data, 'P571')[0]?.v?.y ?? null : null);
        let until = null;
        if (st.q.end != null) until = typeof st.q.end === 'number' ? st.q.end : null;
        // A role that ended in an unknown year is still marked as ended via the note.
        let note;
        if (rel.pct && typeof st.q.pct === 'number' && st.q.pct > 0 && st.q.pct <= 100) {
          const pct = Math.round((st.q.pct <= 1 ? st.q.pct * 100 : st.q.pct) * 100) / 100;
          note = `Stake recorded on Wikidata: ${pct}%.`;
        }
        const sources = [
          { publisher: 'Wikidata', title: `${subjName} – ${rel.pl}`, url: `https://www.wikidata.org/wiki/${S}#${pid}` },
          { publisher: 'Wikipedia', title: subjName, url: entById.get(S).wikipedia },
        ];
        for (const u of st.refs.slice(0, 2)) {
          const host = hostOf(u);
          if (host && u.length < 300) sources.push({ publisher: host, title: `Reference cited on Wikidata (${host})`, url: u });
        }
        addLink(
          {
            id: 'w_' + sha([a, b, cat, label, since ?? '', pid].join('|')),
            a,
            b,
            category: cat,
            label,
            inverseLabel: inv,
            since,
            until,
            note,
            sources,
            origin: 'wikidata',
          },
          fam
        );
      }
    }
  }
  const wdLinkCount = links.length;
  if (endedUnknown) console.log(`Skipped ${endedUnknown} statements that ended in an unknown year`);

  // ------------------------------------------------ curated
  let curatedAdded = 0;
  const curatedLinks = [];
  curated.forEach((c, i) => {
    const a = titleIndex.get(norm(c.a || ''));
    const b = titleIndex.get(norm(c.b || ''));
    const tag = `curated[${i}] ${c.a} -> ${c.b}`;
    if (!a || !b || !entIds.has(a) || !entIds.has(b)) return warn(`${tag}: endpoint not in seed/graph`);
    if (a === b) return warn(`${tag}: self link`);
    if (!CATEGORIES.has(c.category)) return warn(`${tag}: bad category`);
    if (!Array.isArray(c.sources) || !c.sources.length) return warn(`${tag}: no sources`);
    const l = {
      id: 'c_' + sha([a, b, c.category, c.label, c.since ?? ''].join('|')),
      a,
      b,
      category: c.category,
      label: c.label,
      inverseLabel: c.inverseLabel,
      since: c.since,
      until: c.until,
      note: c.note,
      sources: c.sources.map(({ publisher, title, url }) => ({ publisher, title, url })),
      origin: 'curated',
    };
    for (const k of ['since', 'until', 'note']) if (l[k] == null) delete l[k];
    curatedLinks.push(l);
  });
  const ABSORB = new Set(['founder', 'ownership', 'investment']);
  for (const cl of curatedLinks) {
    // A curated founder/ownership/investment link supersedes automatic links with the same endpoints and category
    // (their sources are kept, curated labels and dates win).
    if (ABSORB.has(cl.category)) {
      const family = cl.category === 'founder' ? ['founder'] : ['ownership', 'investment'];
      for (const w of links.filter((x) => x.origin === 'wikidata' && x.a === cl.a && x.b === cl.b && family.includes(x.category))) {
        for (const s of w.sources) if (!cl.sources.some((x) => x.url === s.url)) cl.sources.push(s);
        if (cl.since == null && w.since != null) cl.since = w.since;
        if (cl.until == null && w.until != null) cl.until = w.until;
        links.splice(links.indexOf(w), 1);
      }
    }
    if (cl.category === 'leadership') {
      const kw = (t) => new Set(['ceo', 'chair', 'director', 'board', 'governor'].filter((k) => t.toLowerCase().includes(k)));
      const mine = kw(cl.label);
      for (const w of links.filter((x) => x.origin === 'wikidata' && x.a === cl.a && x.b === cl.b && x.category === 'leadership')) {
        if (![...kw(w.label)].some((k) => mine.has(k))) continue;
        for (const s of w.sources) if (!cl.sources.some((x) => x.url === s.url)) cl.sources.push(s);
        if (cl.since == null && w.since != null) cl.since = w.since;
        if (cl.until == null && w.until != null) cl.until = w.until;
        links.splice(links.indexOf(w), 1);
      }
    }
    if (links.some((x) => x.id === cl.id)) {
      warn(`duplicate curated link ${cl.a} -> ${cl.b} (${cl.label})`);
      continue;
    }
    links.push(cl);
    curatedAdded++;
  }

  // ------------------------------------------------ drop redundant role links
  // "Employee" is implied by any leadership/founder link between the same pair; "Board member" by CEO/Chair/Director.
  {
    const pairLead = new Set();
    const pairFounder = new Set();
    const pairBoard = new Set();
    for (const l of links) {
      const k = l.a + '|' + l.b;
      if (l.category === 'founder') pairFounder.add(k);
      if (l.label === 'Board member') pairBoard.add(k);
      if (l.category === 'leadership' && l.label !== 'Employee' && l.label !== 'Board member') pairLead.add(k);
    }
    const before = links.length;
    for (let i = links.length - 1; i >= 0; i--) {
      const l = links[i];
      if (l.origin !== 'wikidata') continue;
      const k = l.a + '|' + l.b;
      if (l.label === 'Employee' && (pairLead.has(k) || pairFounder.has(k) || pairBoard.has(k))) links.splice(i, 1);
      else if (l.label === 'Board member' && pairLead.has(k)) links.splice(i, 1);
    }
    console.log(`Dropped ${before - links.length} redundant Employee/Board-member links`);
  }

  // ------------------------------------------------ validate + prune
  const errors = [];
  const ids = new Set();
  for (const l of links) {
    if (ids.has(l.id)) errors.push(`duplicate link id ${l.id}`);
    ids.add(l.id);
    if (!entIds.has(l.a) || !entIds.has(l.b)) errors.push(`link ${l.id}: unknown endpoint`);
    if (l.a === l.b) errors.push(`link ${l.id}: self link`);
    if (!CATEGORIES.has(l.category)) errors.push(`link ${l.id}: bad category`);
    if (!l.label || !l.inverseLabel) errors.push(`link ${l.id}: missing label`);
    if (!l.sources?.length) errors.push(`link ${l.id}: no sources`);
    for (const s of l.sources || []) if (!s.publisher || !s.title || !/^https?:\/\//.test(s.url || '')) errors.push(`link ${l.id}: malformed source`);
  }
  if (errors.length) throw new Error('Validation failed:\n' + errors.slice(0, 30).join('\n'));

  const linked = new Set();
  for (const l of links) {
    linked.add(l.a);
    linked.add(l.b);
  }
  const orphans = entities.filter((e) => !linked.has(e.id));
  if (orphans.length) console.warn(`Dropping ${orphans.length} entities with zero links: ${orphans.map((o) => o.name).join(' | ')}`);
  const finalEntities = entities.filter((e) => linked.has(e.id)).sort((x, y) => x.name.localeCompare(y.name));
  const finalLinks = links.sort((x, y) => x.id.localeCompare(y.id));

  const graph = { generatedAt: new Date().toISOString(), entities: finalEntities, links: finalLinks };
  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  fs.writeFileSync(OUT_FILE, JSON.stringify(graph));

  // ------------------------------------------------ summary
  const count = (arr, f) => arr.reduce((m, x) => ((m[f(x)] = (m[f(x)] || 0) + 1), m), {});
  console.log('\n=== Summary ===');
  console.log(`entities kept: ${finalEntities.length} / ${seed.length} seeded`, count(finalEntities, (e) => e.kind));
  console.log(`links: ${finalLinks.length} (wikidata ${wdLinkCount}, curated ${curatedAdded})`, count(finalLinks, (l) => l.category));
  console.log(`unresolved titles: ${unresolved.length}, no coords: ${noCoords.length}, orphans dropped: ${orphans.length}, country-fallback pins: ${approx.length}`);
  if (approx.length) console.log('Country-fallback pins (consider overrides):\n  ' + approx.join('\n  '));
  console.log(`warnings: ${warnings.length}`);
  console.log(`wrote ${path.relative(ROOT, OUT_FILE)} (${(fs.statSync(OUT_FILE).size / 1024).toFixed(0)} KB)`);
}

/** Up to 6 distinct alternative names (never the display name itself), seed-supplied former names first. */
function buildAliases(name, cands) {
  const seen = new Set([name.toLowerCase()]);
  const out = [];
  for (const c of cands) {
    if (!c || typeof c !== 'string') continue;
    const k = c.toLowerCase();
    if (seen.has(k) || c.length > 60) continue;
    seen.add(k);
    out.push(c);
    if (out.length >= 6) break;
  }
  return out;
}

function round(n) {
  return Math.round(n * 10000) / 10000;
}

main().catch((e) => {
  if (e instanceof NetworkError && !STRICT && fs.existsSync(OUT_FILE)) {
    console.warn(`WARNING: network failure (${e.message}). Keeping existing ${path.relative(ROOT, OUT_FILE)} untouched.`);
    process.exit(0);
  }
  console.error(e.stack || e.message);
  process.exit(1);
});
