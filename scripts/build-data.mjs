#!/usr/bin/env node
/**
 * EXPOSE data pipeline.
 *
 *   node scripts/build-data.mjs [--quick | --full] [--strict] [--refresh]
 *
 * Inputs   data/seed.json      hand-picked entities (English Wikipedia titles; `kind` overrides inference)
 *          data/curated.json   hand-curated links with sources (highest precedence)
 *          data/imports/*.json snapshots of the last --full run (LittleSis, GLEIF)
 * Sources  Wikipedia + Wikidata (API and SPARQL), GLEIF (CC0), LittleSis (CC BY-SA). Built-in fetch only.
 * Output   public/data/graph.json (contract: src/types.ts -> Graph), written atomically after validation.
 *
 * Modes
 *   --quick  (default; used by the Vercel build) Wikidata discovery + expansion, then the committed GLEIF / LittleSis
 *            snapshots are merged. Uncached it finishes in a few minutes.
 *   --full   additionally re-fetches GLEIF and LittleSis live (slow: LittleSis is rate limited) and refreshes the
 *            snapshots in data/imports/. Run it locally / in CI, commit the snapshots.
 *   --strict fail (exit 1) on network errors / unresolved titles / missing coordinates instead of tolerating them.
 *            Without it, a network failure (or a drastically shrunken result) with an existing graph.json leaves
 *            that file untouched and exits 0.
 *   --refresh ignore the on-disk HTTP cache (scripts/.cache, 24h TTL).
 *
 * Pipeline
 *   1 seed titles -> QIDs; 2 SPARQL discovery (countries + current heads of state/government, billionaires, largest
 *   companies, parties, media, funds, central banks / IGOs / think tanks); 3 one-hop expansion (CEO, chair, founders,
 *   owners, parents, subsidiaries, family, party of core entities); 4 bridge nodes (items connecting >= 2 included
 *   entities, ranked by sitelinks); 5 kind inference from P31/P279* classes; 6 coordinates; 7 links from Wikidata
 *   statements, then GLEIF parents, LittleSis relationships, then curated links (curated > wikidata > gleif > littlesis
 *   for the same pair + category); 8 validation, influence score, atomic write.
 *
 * INFLUENCE (Entity.influence, 0..1). Every component is a percentile rank (ties averaged), so each is spread
 * uniformly over 0..1:
 *     N = rank of ln(1 + Wikipedia/Wikimedia sitelinks)                       notability
 *     D = rank of ln(1 + degree in the final graph)                           connectedness
 *     W = rank, within its group, of the log of a size measure                wealth / size, if known:
 *           persons        net worth P2218 (USD)
 *           organisations  max(market cap P2226, revenue P2139, total assets P2403) in USD
 *           governments    nominal GDP P2131 (else population P1082)
 *     raw = 0.55 N + 0.20 D + 0.25 W        (without W:  (0.55 N + 0.20 D) / 0.75, i.e. no penalty for unknown size)
 *     influence = 0.5 * rank of raw over all entities + 0.5 * rank of raw within its group (person / government /
 *                 party / other organisations), 3 decimals; so every group spreads over the whole 0..1 range while
 *                 the global order still matters.
 *
 * Env: EXPOSE_UA overrides the User-Agent string.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ROOT, NetworkError, cachedJSON, qs, chunk } from './lib/net.mjs';
import {
  WP_API, REL, REL_ORDER, SUBCITY_CLASSES, CATEGORIES, KINDS, fetchEntities, statements, usdValue, plainValue,
  sitelinkCounts, classFlags, inferKind, discover, reverseNeighbours, qidsByLei, ownershipWording,
} from './lib/wd.mjs';
import { fetchParents, gleifSource } from './lib/gleif.mjs';
import { importLittleSis } from './lib/littlesis.mjs';

const SEED_FILE = path.join(ROOT, 'data/seed.json');
const CURATED_FILE = path.join(ROOT, 'data/curated.json');
const ALIAS_FILE = path.join(ROOT, 'data/place-aliases.json');
const SNAP_DIR = path.join(ROOT, 'data/imports');
const OUT_FILE = path.join(ROOT, 'public/data/graph.json');

const STRICT = process.argv.includes('--strict');
const FULL = process.argv.includes('--full');
const MAX_ENTITIES = 2500;
const MAX_SOURCES = 4;
const LS_MAX = Number(process.env.EXPOSE_LS_MAX) || 2000; // LittleSis matching covers the most notable entities first
const t0 = Date.now();
const log = (...a) => console.log(`[${String(Math.round((Date.now() - t0) / 1000)).padStart(4)}s]`, ...a);

const sha = (s) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 10);
const norm = (t) => t.replace(/_/g, ' ').trim().toLowerCase();
const round = (n) => Math.round(n * 10000) / 10000;
const cap1 = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
function wpUrl(title) {
  return 'https://en.wikipedia.org/wiki/' + encodeURIComponent(title.replace(/ /g, '_')).replace(/%3A/g, ':').replace(/%2C/g, ',');
}
function hostOf(u) {
  try {
    const x = new URL(u);
    return /^https?:$/.test(x.protocol) ? x.hostname.replace(/^www\./, '') : null;
  } catch {
    return null;
  }
}
const readJSON = (f, d) => {
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch {
    return d;
  }
};

// ---------------------------------------------------------------- Wikipedia titles

async function resolveTitles(seed) {
  const map = new Map(); // seed title -> {qid, wpTitle}
  for (const batch of chunk(seed.map((s) => s.title), 50)) {
    const url = `${WP_API}?${qs({ action: 'query', format: 'json', redirects: '1', converttitles: '1', prop: 'pageprops', ppprop: 'wikibase_item', titles: batch.join('|') })}`;
    const j = await cachedJSON(url, (r) => r.query || {}, { minDelay: 200 });
    const hop = new Map();
    for (const n of j.normalized || []) hop.set(n.from, n.to);
    for (const r of j.redirects || []) hop.set(r.from, r.to);
    const byTitle = new Map(Object.values(j.pages || {}).map((p) => [p.title, p]));
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

// ---------------------------------------------------------------- geo

async function resolveGeo(entities) {
  const candsByQid = new Map();
  const need = new Set();
  for (const e of entities) {
    const pids = e.kind === 'person' ? ['P551', 'P937', 'P19'] : ['P159'];
    const cands = [];
    for (const pid of pids) for (const st of statements(e.data, pid).slice(0, 2)) cands.push({ pid, qid: st.v, coord: st.q.coord || null });
    candsByQid.set(e.qid, cands);
    for (const c of cands) if (typeof c.qid === 'string') need.add(c.qid);
    for (const pid of ['P17', 'P495', 'P27', 'P36']) for (const st of statements(e.data, pid).slice(0, 2)) if (typeof st.v === 'string') need.add(st.v);
  }
  const items = await fetchEntities([...need], { light: true });
  const fetchMissing = async (pids) => {
    const more = new Set();
    for (const it of items.values()) for (const pid of pids) for (const st of statements(it, pid).slice(0, 2)) if (typeof st.v === 'string' && !items.has(st.v)) more.add(st.v);
    for (const [k, v] of await fetchEntities([...more], { light: true })) items.set(k, v);
  };
  await fetchMissing(['P17', 'P36']); // countries + capitals of the places
  await fetchMissing(['P36']); // capitals of countries fetched above

  const isSubcity = (it) => (it.claims?.P31 || []).some((st) => SUBCITY_CLASSES.has(st.v));
  for (let round_ = 0; round_ < 3; round_++) {
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
    for (const [k, v] of await fetchEntities([...up], { light: true })) items.set(k, v);
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
    const v = statements(items.get(countryQid), 'P297')[0]?.v;
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

// ---------------------------------------------------------------- expansion helpers

/** Current holders of a (single-valued) role: no end date and, if a preferred statement exists, only preferred ones. */
function currentTargets(data, pid) {
  let sts = (data.claims[pid] || []).filter((s) => typeof s.v === 'string');
  if (sts.some((s) => s.rank === 'preferred')) sts = sts.filter((s) => s.rank === 'preferred');
  return sts.filter((s) => s.q.end == null).map((s) => s.v);
}
const allTargets = (data, pid) => (data.claims[pid] || []).filter((s) => typeof s.v === 'string' && s.q.end == null).map((s) => s.v);

const BRIDGE_PROPS = ['P127', 'P749', 'P355', 'P112', 'P169', 'P488', 'P3320', 'P1830', 'P26', 'P40', 'P22', 'P25', 'P3373', 'P6', 'P35', 'P102'];

// ---------------------------------------------------------------- main

async function main() {
  const seed = readJSON(SEED_FILE, []);
  const curated = readJSON(CURATED_FILE, []);
  const warnings = [];
  const warn = (m) => {
    warnings.push(m);
    console.warn('WARN ' + m);
  };
  log(`mode: ${FULL ? 'full' : 'quick'}; seed: ${seed.length} entries, curated: ${curated.length} links`);

  // ------------------------------------------------ 1. seed
  log('Resolving seed titles via Wikipedia...');
  const resolved = await resolveTitles(seed);
  /** qid -> {qid, seed?, hint, prio, wpTitle?} */
  const reg = new Map();
  const titleIndex = new Map();
  const unresolved = [];
  for (const s of seed) {
    if (!KINDS.has(s.kind)) throw new Error(`Seed "${s.title}": bad kind ${s.kind}`);
    const r = resolved.get(s.title);
    if (!r) {
      unresolved.push(s.title);
      continue;
    }
    if (reg.has(r.qid)) {
      warn(`Seed titles "${reg.get(r.qid).seed.title}" and "${s.title}" resolve to the same item ${r.qid}; keeping first`);
      titleIndex.set(norm(s.title), r.qid);
      continue;
    }
    reg.set(r.qid, { qid: r.qid, seed: s, hint: s.kind, prio: 0, wpTitle: r.wpTitle });
    titleIndex.set(norm(s.title), r.qid);
    titleIndex.set(norm(r.wpTitle), r.qid);
  }
  if (unresolved.length) {
    console.warn(`Unresolved seed titles (${unresolved.length}): ${unresolved.join(' | ')}`);
    if (STRICT) throw new Error('Unresolved seed titles in --strict mode');
  }

  // ------------------------------------------------ 2. discovery
  log('Discovering entities via Wikidata SPARQL...');
  const D = await discover(log);
  const addCore = (rows, hint, prio, limit = Infinity) => {
    let n = 0;
    for (const r of rows) {
      if (n >= limit) break;
      if (reg.has(r.id)) continue;
      reg.set(r.id, { qid: r.id, hint, prio, s: r.s });
      n++;
    }
  };
  addCore(D.countries, 'government', 1);
  addCore(D.leaders, 'person', 1);
  addCore(D.billionaires, 'person', 2, 330);
  const coAll = new Map();
  for (const k of ['co_P2139', 'co_P2403', 'co_P2226', 'mcap']) for (const r of D[k]) if (!coAll.has(r.id)) coAll.set(r.id, r);
  const mcapIds = new Set(D.mcap.map((r) => r.id));
  addCore(D.mcap.slice(0, 150), 'company', 3);
  addCore([...coAll.values()].filter((r) => !mcapIds.has(r.id)).sort((x, y) => y.s - x.s), 'company', 3, 330);
  addCore(D.parties_gov, 'party', 4, 100);
  addCore(D.parties, 'party', 4, 80);
  addCore(D.media, 'media', 5);
  addCore(D.funds, 'fund', 5);
  addCore(D.orgs, 'organization', 5);
  log(`registry after discovery: ${reg.size}`);

  // ------------------------------------------------ 3. fetch + one-hop expansion
  log('Fetching Wikidata items...');
  const items = await fetchEntities([...reg.keys()]);
  const dropNoData = () => {
    for (const [q, e] of [...reg]) {
      const d = items.get(q);
      if (!d) {
        if (e.seed) warn(`No Wikidata item data for ${e.seed.title} (${q})`);
        reg.delete(q);
      } else if (!e.seed && !d.wikipedia) reg.delete(q); // auto entities need an English Wikipedia article
    }
  };
  dropNoData();
  for (const [q, e] of reg) if (items.get(q).id !== q) {
    // redirected / merged item: keep the canonical id
    if (!reg.has(items.get(q).id)) reg.set(items.get(q).id, { ...e, qid: items.get(q).id });
    reg.delete(q);
  }
  log(`  core entities with data: ${reg.size}`);

  log('Expanding one hop (CEOs, chairs, founders, owners, parents, subsidiaries, family, parties)...');
  {
    const cand = new Map(); // qid -> {min sitelinks, via}
    const want = (q, min, cls = 1) => {
      if (reg.has(q)) return;
      const c = cand.get(q) || { min: Infinity, n: 0 };
      c.min = Math.min(c.min, min);
      cand.set(q, c);
    };
    const subsOf = new Map();
    for (const [q, e] of reg) {
      const d = items.get(q);
      for (const t of currentTargets(d, 'P169')) want(t, 10);
      for (const t of currentTargets(d, 'P488')) want(t, 10);
      for (const t of allTargets(d, 'P112')) want(t, 10);
      for (const t of allTargets(d, 'P127')) want(t, 20);
      for (const t of allTargets(d, 'P749')) want(t, 20);
      const subs = allTargets(d, 'P355').filter((t) => !reg.has(t));
      if (subs.length) subsOf.set(q, subs);
      if (e.hint === 'person') {
        for (const pid of ['P26', 'P40', 'P22', 'P25']) for (const t of allTargets(d, pid)) want(t, 40);
        for (const t of currentTargets(d, 'P102')) want(t, 25);
      }
    }
    const subAll = [...new Set([...subsOf.values()].flat())];
    const sl = await sitelinkCounts([...cand.keys(), ...subAll]);
    const picked = [];
    for (const [q, c] of cand) {
      const s = sl.get(q) || 0;
      if (s >= c.min) picked.push({ id: q, s });
    }
    for (const subs of subsOf.values()) {
      for (const t of subs.map((id) => ({ id, s: sl.get(id) || 0 })).filter((x) => x.s >= 25).sort((x, y) => y.s - x.s).slice(0, 8)) picked.push(t);
    }
    const uniq = [...new Map(picked.map((p) => [p.id, p])).values()].sort((x, y) => y.s - x.s).slice(0, 900);
    for (const p of uniq) reg.set(p.id, { qid: p.id, hint: null, prio: 20, s: p.s });
    for (const [k, v] of await fetchEntities(uniq.map((p) => p.id))) items.set(k, v);
    dropNoData();
    log(`  after one-hop expansion: ${reg.size}`);
  }

  log('Finding bridge nodes (items connecting >= 2 included entities)...');
  {
    const count = new Map(); // qid -> Set(included)
    const hit = (x, t) => {
      if (reg.has(x) || x === t) return;
      const s = count.get(x) || new Set();
      s.add(t);
      count.set(x, s);
    };
    for (const [q] of reg) {
      const d = items.get(q);
      for (const pid of BRIDGE_PROPS) for (const st of d.claims[pid] || []) if (typeof st.v === 'string') hit(st.v, q);
    }
    try {
      for (const r of await reverseNeighbours([...reg.keys()], 25)) hit(r.x, r.t);
    } catch (e) {
      warn('reverse bridge lookup failed: ' + e.message);
    }
    const multi = [...count].filter(([, s]) => s.size >= 2).map(([q]) => q);
    const sl = await sitelinkCounts(multi);
    let ranked = multi.map((q) => ({ id: q, s: sl.get(q) || 0, n: count.get(q).size })).filter((x) => x.s >= 20).sort((x, y) => y.s - x.s).slice(0, 450);
    const newItems = await fetchEntities(ranked.map((x) => x.id));
    for (const [k, v] of newItems) items.set(k, v);
    const nonPerson = ranked.filter((x) => items.get(x.id) && !(items.get(x.id).claims.P31 || []).some((s) => s.v === 'Q5')).map((x) => x.id);
    const fl = await classFlags(nonPerson);
    let added = 0;
    for (const x of ranked) {
      const d = items.get(x.id);
      if (!d || !d.wikipedia) continue;
      const person = (d.claims.P31 || []).some((s) => s.v === 'Q5');
      if (!person && ![...(fl.get(x.id) || [])].length) continue; // neither a person nor an organisation-like item
      reg.set(x.id, { qid: x.id, hint: null, prio: 30, s: x.s });
      added++;
      if (added >= 350) break;
    }
    log(`  bridge nodes added: ${added} (candidates ${multi.length})`);
  }

  // ------------------------------------------------ 4. cap, kinds, sitelinks
  {
    const sl = await sitelinkCounts([...reg.keys()]);
    for (const [q, e] of reg) e.s = sl.get(q) ?? e.s ?? 0;
    if (reg.size > MAX_ENTITIES) {
      const order = [...reg.values()].filter((e) => !e.seed).sort((x, y) => x.prio - y.prio || y.s - x.s);
      const keep = MAX_ENTITIES - [...reg.values()].filter((e) => e.seed).length;
      for (const e of order.slice(keep)) reg.delete(e.qid);
      log(`  capped to ${reg.size} entities`);
    }
  }

  // ------------------------------------------------ 5. GLEIF (entity set may grow by notable parents)
  const idOfLei = new Map(); // LEI -> qid
  const leisOf = (q) => (items.get(q)?.claims?.P1278 || []).map((s) => s.v).filter((v) => typeof v === 'string' && /^[A-Z0-9]{20}$/.test(v));
  let gleifRaw = null; // [{child: qid, parent: qid, kind, childLei, parentLei, childName}]
  if (FULL) {
    log('GLEIF: fetching parent relationships...');
    try {
      const leis = [];
      for (const q of reg.keys()) for (const l of leisOf(q)) (leis.push(l), idOfLei.set(l, q));
      const parents = await fetchParents(leis);
      const unknown = new Set();
      for (const r of parents.values()) for (const l of [r.direct, r.ultimate]) if (l && !idOfLei.has(l)) unknown.add(l);
      const byLei = await qidsByLei([...unknown]);
      const add = [...byLei.values()].filter((x) => x.s >= 30 && !reg.has(x.qid));
      if (add.length) {
        for (const [k, v] of await fetchEntities(add.map((x) => x.qid))) items.set(k, v);
        for (const x of add) {
          const d = items.get(x.qid);
          if (d?.wikipedia) reg.set(x.qid, { qid: x.qid, hint: 'company', prio: 25, s: x.s });
        }
        for (const x of add) if (reg.has(x.qid)) for (const l of leisOf(x.qid)) idOfLei.set(l, x.qid);
      }
      for (const [l, v] of byLei) if (reg.has(v.qid)) idOfLei.set(l, v.qid);
      gleifRaw = [];
      for (const r of parents.values()) {
        const child = idOfLei.get(r.lei);
        if (!child) continue;
        for (const [kind, pl] of [['direct', r.direct], ['ultimate', r.ultimate]]) {
          const parent = pl && idOfLei.get(pl);
          if (parent && parent !== child && reg.has(parent)) gleifRaw.push({ child, parent, kind, childLei: r.lei, parentLei: pl });
        }
      }
      log(`  GLEIF: ${parents.size} records, ${gleifRaw.length} parent links among included entities, ${add.length} parent candidates added`);
    } catch (e) {
      warn('GLEIF failed, using snapshot: ' + e.message);
      gleifRaw = null;
    }
  }

  // ------------------------------------------------ 6. kinds
  log('Inferring kinds...');
  const nonPersonIds = [...reg.keys()].filter((q) => !(items.get(q).claims.P31 || []).some((s) => s.v === 'Q5'));
  const flags = await classFlags(nonPersonIds);
  const ents = [];
  const kindMismatch = [];
  let notOrg = 0;
  for (const e of [...reg.values()]) {
    e.data = items.get(e.qid);
    // auto-discovered items must be a person or classify as an organisation-like item; class items (P279) are never entities
    if (!e.seed && !(e.data.claims.P31 || []).some((s) => s.v === 'Q5') && (!(flags.get(e.qid)?.size) || e.data.claims.P279 || (flags.get(e.qid).has('place') && !flags.get(e.qid).has('govt') && !flags.get(e.qid).has('party')))) {
      reg.delete(e.qid);
      notOrg++;
      continue;
    }
    e.kind = e.seed ? e.seed.kind : inferKind(e.data, flags.get(e.qid), e.hint);
    if (e.seed) {
      const inf = inferKind(e.data, flags.get(e.qid), null);
      if (inf !== e.seed.kind) kindMismatch.push(`${e.seed.title}: seed=${e.seed.kind} inferred=${inf}`);
    }
    ents.push(e);
  }
  log(`  dropped ${notOrg} non-person items without an organisation-like class`);
  const inSet = new Map(ents.map((e) => [e.qid, e]));
  for (const e of ents) if (e.data.id !== e.qid) inSet.set(e.data.id, e);

  // ------------------------------------------------ 7. coordinates + entities
  log(`Resolving coordinates for ${ents.length} entities...`);
  const geo = await resolveGeo(ents);
  const aliasesMap = readJSON(ALIAS_FILE, {});
  const entities = [];
  const noCoords = [];
  const approx = [];
  for (const e of ents) {
    const s = e.seed || {};
    const label = e.data.label || e.wpTitle;
    if (!label) continue;
    let g = geo.get(e.qid);
    if (Number.isFinite(s.lat) && Number.isFinite(s.lon)) g = { ...(g || {}), lat: s.lat, lon: s.lon, approx: false, place: s.place ?? g?.place };
    if (g?.approx) approx.push({ name: s.name || label, kind: e.kind, place: g.place });
    if (!g || !Number.isFinite(g.lat)) {
      noCoords.push(s.title || label);
      continue;
    }
    const img = statements(e.data, 'P18')[0]?.v;
    const name = s.name || label;
    const ent = {
      id: e.qid,
      name,
      kind: e.kind,
      description: s.description || cap1(e.data.description) || '',
      lat: round(g.lat),
      lon: round(g.lon),
      place: s.place || aliasesMap[g.place] || g.place || '',
      country: s.country || g.country,
      wikipedia: e.data.wikipedia || e.wpTitle ? wpUrl(e.data.wikipedia || e.wpTitle) : undefined,
      wikidata: `https://www.wikidata.org/wiki/${e.qid}`,
      aliases: buildAliases(name, [...(s.aliases || []), ...(e.data.aliases || []), label, e.wpTitle]),
      image: typeof img === 'string' ? `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(img.replace(/ /g, '_'))}?width=160` : undefined,
    };
    for (const k of ['country', 'wikipedia', 'image']) if (!ent[k]) delete ent[k];
    if (!ent.aliases.length) delete ent.aliases;
    entities.push(ent);
  }
  if (noCoords.length) {
    console.warn(`Entities without coordinates (dropped): ${noCoords.length}${noCoords.length < 40 ? ': ' + noCoords.join(' | ') : ''}`);
    if (STRICT) throw new Error('Missing coordinates in --strict mode');
  }
  const entIds = new Set(entities.map((e) => e.id));
  const entById = new Map(entities.map((e) => [e.id, e]));

  // ------------------------------------------------ 8. links
  const links = [];
  const linkIndex = new Map(); // a|b|cat|fam -> [link]
  const compatible = (x, y) => x == null || y == null || x === y;
  function addLink(l, fam) {
    const key = `${l.a}|${l.b}|${l.category}|${fam}`;
    const list = linkIndex.get(key) || [];
    // a lower-precedence source (GLEIF, LittleSis) corroborates an existing link of another origin whatever its dates
    const other = l.origin !== 'wikidata' ? list.find((ex) => ex.origin !== l.origin && compatible(ex.since, l.since)) || list.find((ex) => ex.origin !== l.origin) : null;
    for (const ex of other ? [other] : list) {
      if (other || compatible(ex.since, l.since)) {
        // mirrored / duplicate statement or another source: merge, first (higher precedence) wins
        if (l.upgrade && ex.category === 'ownership' && ex.origin !== 'curated' && /^(Shareholder|Owner or shareholder)/.test(ex.label)) {
          // GLEIF's consolidating parent is a controlling holder: more precise than a bare / minority shareholder statement
          ex.label = 'Parent';
          ex.inverseLabel = 'Subsidiary of';
          ex.note = l.note;
        }
        if (!other) {
          if (ex.since == null) ex.since = l.since;
          if (ex.until == null) ex.until = l.until;
        }
        if (!ex.note && l.note) ex.note = l.note;
        if (ex.label === 'Parent' && l.label !== 'Parent') {
          ex.label = l.label;
          ex.inverseLabel = l.inverseLabel;
        }
        for (const src of l.sources) if (!ex.sources.some((x) => x.url === src.url)) ex.sources.push(src);
        return ex;
      }
    }
    links.push(l);
    list.push(l);
    linkIndex.set(key, list);
    return l;
  }

  let endedFlagged = 0;
  let skippedGovMembership = 0;
  for (const e of ents) {
    if (!entIds.has(e.qid)) continue;
    const S = e.qid;
    const subj = entById.get(S);
    for (const pid of REL_ORDER) {
      const rel = REL[pid];
      let sts = (e.data.claims[pid] || []).filter((st) => typeof st.v === 'string');
      if (rel.single && sts.some((st) => st.rank === 'preferred')) {
        // a preferred-rank (current) holder exists: drop stale open-ended non-preferred holders
        sts = sts.filter((st) => st.rank === 'preferred' || st.q.end != null);
      }
      for (const st of sts) {
        const T = inSet.get(st.v)?.qid;
        if (!T || T === S || !entIds.has(T)) continue;
        // Memberships of countries in intergovernmental bodies would add hundreds of near-identical arcs: for
        // non-seeded governments only the (hand-picked) seeded bodies such as the UN, NATO or the WTO are kept.
        if (pid === 'P463' && subj.kind === 'government' && !reg.get(S).seed && !reg.get(T).seed) {
          skippedGovMembership++;
          continue;
        }
        let a, b, label = rel.label, inv = rel.inv, cat = rel.cat, fam = rel.fam || rel.label;
        if (rel.a === 'T') [a, b] = [T, S];
        else if (rel.a === 'S') [a, b] = [S, T];
        else [a, b] = S < T ? [S, T] : [T, S];
        if (rel.pct) {
          const w = ownershipWording(typeof st.q.pct === 'number' ? st.q.pct : null, entById.get(a).kind === 'fund');
          [label, inv, cat, fam] = [w.label, w.inv, w.cat, w.fam];
        }
        const since = st.q.start ?? (pid === 'P112' ? statements(e.data, 'P571')[0]?.v?.y ?? null : null);
        let until = null;
        let ended;
        if (st.q.end != null) {
          if (typeof st.q.end === 'number') until = st.q.end;
          else {
            ended = true; // ended in an unknown year
            endedFlagged++;
          }
        }
        let note;
        if (rel.pct && typeof st.q.pct === 'number' && st.q.pct > 0 && st.q.pct <= 100) {
          const pct = Math.round((st.q.pct <= 1 ? st.q.pct * 100 : st.q.pct) * 100) / 100;
          note = `Stake recorded on Wikidata: ${pct}%.`;
        }
        const sources = [{ publisher: 'Wikidata', title: `${subj.name} – ${rel.pl}`, url: `https://www.wikidata.org/wiki/${S}#${pid}` }];
        if (subj.wikipedia) sources.push({ publisher: 'Wikipedia', title: subj.name, url: subj.wikipedia });
        for (const u of st.refs.slice(0, 2)) {
          const host = hostOf(u);
          if (host && u.length < 300) sources.push({ publisher: host, title: `Reference cited on Wikidata (${host})`, url: u });
        }
        addLink({ id: 'w_' + sha([a, b, cat, label, since ?? '', pid].join('|')), a, b, category: cat, label, inverseLabel: inv, since, until, ended, note, sources, origin: 'wikidata' }, fam);
      }
    }
  }
  const wdLinkCount = links.length;
  log(`Wikidata links: ${wdLinkCount} (ended-unknown flagged ${endedFlagged}, gov memberships skipped ${skippedGovMembership})`);

  // ---- GLEIF (live in --full, snapshot otherwise)
  const gleifSnapFile = path.join(SNAP_DIR, 'gleif.json');
  let gleifSnap = readJSON(gleifSnapFile, { links: [] });
  if (gleifRaw) {
    gleifSnap = {
      generatedAt: new Date().toISOString(),
      links: gleifRaw.map((r) => ({ child: r.child, parent: r.parent, kind: r.kind, childLei: r.childLei, parentLei: r.parentLei })),
    };
    fs.mkdirSync(SNAP_DIR, { recursive: true });
    fs.writeFileSync(gleifSnapFile, JSON.stringify(gleifSnap, null, 0) + '\n');
  }
  let gleifAdded = 0;
  {
    const direct = new Set(gleifSnap.links.filter((r) => r.kind === 'direct').map((r) => r.child + '|' + r.parent));
    const directParents = new Map();
    for (const r of gleifSnap.links) if (r.kind === 'direct') directParents.set(r.child, [...(directParents.get(r.child) || []), r.parent]);
    for (const r of gleifSnap.links) {
      if (!entIds.has(r.child) || !entIds.has(r.parent)) continue;
      // an ultimate-parent link is redundant when the chain via an included direct parent is present
      if (r.kind === 'ultimate' && (direct.has(r.child + '|' + r.parent) || (directParents.get(r.child) || []).some((p) => entIds.has(p)))) continue;
      const ch = entById.get(r.child);
      const src = gleifSource(ch.name, r.childLei);
      const ult = r.kind === 'ultimate';
      const before = links.length;
      addLink(
        { id: 'g_' + sha([r.parent, r.child, r.kind].join('|')), a: r.parent, b: r.child, category: 'ownership', label: ult ? 'Ultimate parent' : 'Parent', inverseLabel: ult ? 'Ultimate subsidiary of' : 'Subsidiary of', note: `GLEIF lists ${entById.get(r.parent).name} as the ${ult ? 'ultimate' : 'direct'} accounting-consolidation parent of ${ch.name}.`, sources: [src], origin: 'gleif', upgrade: !ult },
        'own'
      );
      if (links.length > before) gleifAdded++;
    }
  }
  log(`GLEIF links added (new pairs): ${gleifAdded}`);

  // ---- LittleSis (live in --full, snapshot otherwise)
  const lsSnapFile = path.join(SNAP_DIR, 'littlesis.json');
  let lsSnap = readJSON(lsSnapFile, { matches: {}, links: [] });
  if (FULL) {
    log('LittleSis: matching entities and importing relationships (slow)...');
    try {
      const nb = new Map();
      for (const l of links) {
        for (const [x, y] of [[l.a, l.b], [l.b, l.a]]) nb.set(x, (nb.get(x) || new Set()).add(y));
      }
      const lsEnts = entities
        .map((e) => ({ id: e.id, name: e.name, kind: e.kind, description: e.description, aliases: e.aliases, wpTitle: e.wikipedia ? decodeURIComponent(e.wikipedia.split('/wiki/')[1] || '').replace(/_/g, ' ') : '', s: reg.get(e.id)?.s || 0 }))
        .sort((x, y) => y.s - x.s)
        .slice(0, LS_MAX);
      const res = await importLittleSis(lsEnts, nb, log);
      lsSnap = { generatedAt: new Date().toISOString(), matches: res.matches, links: res.links };
      fs.mkdirSync(SNAP_DIR, { recursive: true });
      fs.writeFileSync(lsSnapFile, JSON.stringify(lsSnap) + '\n');
    } catch (e) {
      warn('LittleSis failed, using snapshot: ' + e.message);
    }
  }
  let lsAdded = 0;
  for (const r of lsSnap.links) {
    if (!entIds.has(r.a) || !entIds.has(r.b) || r.a === r.b) continue;
    // Skip relationship types too vague to explain a connection, and small one-off donations.
    if (r.label === 'Business relationship' || r.label === 'Professional associate') continue;
    if (r.label.startsWith('Donor') && !(r.amount >= 10000)) continue;
    const before = links.length;
    addLink(
      { id: 'l_' + sha([r.a, r.b, r.category, r.label, r.since ?? '', r.lsId].join('|')), a: r.a, b: r.b, category: r.category, label: r.label, inverseLabel: r.inverseLabel, since: r.since ?? null, until: r.until ?? null, ended: r.ended || undefined, note: r.note, sources: r.sources, origin: 'littlesis' },
      r.fam
    );
    if (links.length > before) lsAdded++;
  }
  log(`LittleSis links added (new pairs): ${lsAdded} of ${lsSnap.links.length} in snapshot`);

  // ---- curated
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
      a, b, category: c.category, label: c.label, inverseLabel: c.inverseLabel, since: c.since, until: c.until, note: c.note,
      sources: c.sources.map(({ publisher, title, url }) => ({ publisher, title, url })),
      origin: 'curated',
    };
    curatedLinks.push(l);
  });
  const ABSORB = new Set(['founder', 'ownership', 'investment']);
  const absorb = (cl, w) => {
    for (const s of w.sources) if (!cl.sources.some((x) => x.url === s.url)) cl.sources.push(s);
    if (cl.since == null && w.since != null) cl.since = w.since;
    if (cl.until == null && w.until != null) cl.until = w.until;
    links.splice(links.indexOf(w), 1);
  };
  for (const cl of curatedLinks) {
    // A curated founder/ownership/investment link supersedes automatic links with the same endpoints and category
    // (their sources are kept, curated labels and dates win).
    if (ABSORB.has(cl.category)) {
      const family = cl.category === 'founder' ? ['founder'] : ['ownership', 'investment'];
      for (const w of links.filter((x) => x.origin !== 'curated' && x.a === cl.a && x.b === cl.b && family.includes(x.category))) absorb(cl, w);
    }
    if (cl.category === 'leadership') {
      const kw = (t) => new Set(['ceo', 'chair', 'director', 'board', 'governor'].filter((k) => t.toLowerCase().includes(k)));
      const mine = kw(cl.label);
      for (const w of links.filter((x) => x.origin !== 'curated' && x.a === cl.a && x.b === cl.b && x.category === 'leadership')) {
        if ([...kw(w.label)].some((k) => mine.has(k))) absorb(cl, w);
      }
    }
    if (links.some((x) => x.id === cl.id)) {
      warn(`duplicate curated link ${cl.a} -> ${cl.b} (${cl.label})`);
      continue;
    }
    links.push(cl);
    curatedAdded++;
  }

  // ---- drop redundant role links: "Employee" is implied by any leadership/founder link between the same pair,
  // "Board member" by CEO/Chair/Director.
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
      if (l.origin === 'curated') continue;
      const k = l.a + '|' + l.b;
      if (l.label === 'Employee' && (pairLead.has(k) || pairFounder.has(k) || pairBoard.has(k))) links.splice(i, 1);
      else if (l.label === 'Board member' && pairLead.has(k)) links.splice(i, 1);
    }
    log(`Dropped ${before - links.length} redundant Employee/Board-member links`);
  }

  // tidy: optional keys omitted rather than null, sources capped (provenance of every origin kept first)
  const SRC_RANK = (s) => (s.publisher === 'GLEIF' || s.publisher === 'LittleSis' ? 0 : s.publisher === 'Wikidata' ? 1 : s.publisher === 'Wikipedia' ? 2 : 3);
  for (const l of links) {
    delete l.upgrade;
    for (const k of ['since', 'until', 'note', 'ended']) if (l[k] == null || l[k] === false) delete l[k];
    if (l.until != null && l.since != null && l.until < l.since) {
      l.until = undefined; // inconsistent source dates: keep the fact that it ended, drop the unreliable year
      l.ended = true;
      delete l.until;
    }
    if (l.ended && l.until != null) delete l.ended;
    if (l.origin !== 'curated') l.sources = l.sources.map((s, i) => [s, i]).sort((x, y) => SRC_RANK(x[0]) - SRC_RANK(y[0]) || x[1] - y[1]).map((x) => x[0]);
    l.sources = l.sources.slice(0, MAX_SOURCES);
  }

  // ------------------------------------------------ 9. validate + prune
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

  const degree = new Map();
  for (const l of links) {
    degree.set(l.a, (degree.get(l.a) || 0) + 1);
    degree.set(l.b, (degree.get(l.b) || 0) + 1);
  }
  const orphans = entities.filter((e) => !degree.has(e.id));
  log(`Dropping ${orphans.length} entities with zero links`);
  const finalEntities = entities.filter((e) => degree.has(e.id));

  // ------------------------------------------------ 10. influence
  computeInfluence(finalEntities, degree, (q) => reg.get(q), items);
  finalEntities.sort((x, y) => x.name.localeCompare(y.name));
  const finalLinks = links.sort((x, y) => x.id.localeCompare(y.id));
  const graph = { generatedAt: new Date().toISOString(), entities: finalEntities, links: finalLinks };

  // final structural check (no nulls, coordinates for all)
  for (const e of finalEntities) {
    if (!Number.isFinite(e.lat) || !Number.isFinite(e.lon) || !e.name || !e.kind) throw new Error(`entity ${e.id}: missing coordinates/name/kind`);
    if (!(e.influence >= 0 && e.influence <= 1)) throw new Error(`entity ${e.id}: bad influence`);
  }
  const json = JSON.stringify(graph);
  if (/:null[,}]/.test(json)) throw new Error('null values in graph');

  // safety net: never replace a good graph with a drastically smaller one (e.g. SPARQL outage)
  const prev = readJSON(OUT_FILE, null);
  if (prev?.entities?.length && finalEntities.length < prev.entities.length * 0.6) {
    const msg = `new graph has ${finalEntities.length} entities vs ${prev.entities.length} before; keeping the existing file`;
    if (STRICT) throw new Error(msg);
    console.warn('WARNING: ' + msg);
    process.exit(0);
  }
  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  const tmp = OUT_FILE + '.tmp';
  fs.writeFileSync(tmp, json);
  JSON.parse(fs.readFileSync(tmp, 'utf8')); // re-read to be sure the file on disk is valid
  fs.renameSync(tmp, OUT_FILE);

  // ------------------------------------------------ summary
  const count = (arr, f) => arr.reduce((m, x) => ((m[f(x)] = (m[f(x)] || 0) + 1), m), {});
  console.log('\n=== Summary ===');
  console.log(`entities: ${finalEntities.length}`, count(finalEntities, (e) => e.kind));
  console.log(`links: ${finalLinks.length}`, count(finalLinks, (l) => l.category));
  console.log('by origin:', count(finalLinks, (l) => l.origin), `(curated added ${curatedAdded})`);
  console.log(`unresolved titles: ${unresolved.length}, no coords: ${noCoords.length}, orphans dropped: ${orphans.length}, country-fallback pins: ${approx.length}`, count(approx, (a) => a.kind));
  if (kindMismatch.length) console.log(`seed kind != inferred (${kindMismatch.length}):\n  ` + kindMismatch.join('\n  '));
  if (process.env.EXPOSE_VERBOSE && approx.length) console.log('country-fallback pins:\n  ' + approx.map((a) => `${a.name} (${a.kind}) -> ${a.place}`).join('\n  '));
  console.log('top by influence:', [...finalEntities].sort((x, y) => y.influence - x.influence).slice(0, 15).map((e) => `${e.name} ${e.influence}`).join(' | '));
  console.log(`warnings: ${warnings.length}`);
  console.log(`wrote ${path.relative(ROOT, OUT_FILE)} (${(fs.statSync(OUT_FILE).size / 1024).toFixed(0)} KB) in ${Math.round((Date.now() - t0) / 1000)}s`);
}

// ---------------------------------------------------------------- influence

function rankNormalise(values) {
  // percentile rank in 0..1 with ties averaged
  const idx = values.map((v, i) => [v, i]).sort((x, y) => x[0] - y[0]);
  const out = new Array(values.length);
  const n = values.length;
  for (let i = 0; i < n; ) {
    let j = i;
    while (j + 1 < n && idx[j + 1][0] === idx[i][0]) j++;
    const r = (i + j) / 2 / Math.max(1, n - 1);
    for (let k = i; k <= j; k++) out[idx[k][1]] = r;
    i = j + 1;
  }
  return out;
}

function computeInfluence(entities, degree, regOf, items) {
  const n = entities.length;
  const N = rankNormalise(entities.map((e) => Math.log1p(regOf(e.id)?.s ?? 0)));
  const Dg = rankNormalise(entities.map((e) => Math.log1p(degree.get(e.id) || 0)));
  const size = entities.map((e) => {
    const d = items.get(e.id);
    if (!d) return null;
    let v = null;
    if (e.kind === 'person') v = usdValue(d, 'P2218');
    else if (e.kind === 'government') v = usdValue(d, 'P2131') ?? (plainValue(d, 'P1082') ? plainValue(d, 'P1082') * 5000 : null); // population fallback: ~USD 5k GDP per head
    else v = Math.max(usdValue(d, 'P2226') ?? 0, usdValue(d, 'P2139') ?? 0, usdValue(d, 'P2403') ?? 0) || null;
    return v && v > 0 ? Math.log10(v) : null;
  });
  const W = new Array(n).fill(null);
  for (const group of ['person', 'government', 'org']) {
    const idxs = entities.map((e, i) => i).filter((i) => size[i] != null && (group === 'org' ? !['person', 'government'].includes(entities[i].kind) : entities[i].kind === group));
    const r = rankNormalise(idxs.map((i) => size[i]));
    idxs.forEach((i, k) => (W[i] = r[k]));
  }
  const raw = entities.map((e, i) => (W[i] != null ? 0.55 * N[i] + 0.2 * Dg[i] + 0.25 * W[i] : (0.55 * N[i] + 0.2 * Dg[i]) / 0.75));
  const R = rankNormalise(raw);
  // groups are ranked on their own too, so that people, countries, parties and organisations each get a spread
  const grp = (e) => (e.kind === 'person' ? 'person' : e.kind === 'government' ? 'gov' : e.kind === 'party' ? 'party' : 'org');
  const Rg = new Array(n);
  for (const g of ['person', 'gov', 'party', 'org']) {
    const idxs = entities.map((e, i) => i).filter((i) => grp(entities[i]) === g);
    const r = rankNormalise(idxs.map((i) => raw[i]));
    idxs.forEach((i, k) => (Rg[i] = r[k]));
  }
  entities.forEach((e, i) => (e.influence = Math.round((0.5 * R[i] + 0.5 * Rg[i]) * 1000) / 1000));
}

main().catch((e) => {
  if (e instanceof NetworkError && !STRICT && fs.existsSync(OUT_FILE)) {
    console.warn(`WARNING: network failure (${e.message}). Keeping existing ${path.relative(ROOT, OUT_FILE)} untouched.`);
    process.exit(0);
  }
  console.error(e.stack || e.message);
  process.exit(1);
});
