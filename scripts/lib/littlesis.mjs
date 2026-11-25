/**
 * LittleSis (https://littlesis.org, CC BY-SA 4.0): strict entity matching + import of neutral relationship types
 * between entities that are both already part of the graph.
 *
 * Matching (a wrong match on a real person is worse than a missing link):
 *   1. LittleSis search by our display name; candidates must agree on type (person <-> Person, everything else <-> Org)
 *      and have an equal normalised name (or our name equals one of the candidate's registered aliases).
 *   2. At most 3 candidates are considered. A candidate is corroborated when
 *        A) its blurb/summary contains a distinctive keyword from our description or from the names of entities we
 *           already connect it to, or
 *        C) it has a relationship with an entity that is already one of our Wikidata/curated neighbours, or
 *        B) it has >= 2 relationships to other matched candidates (persons) / >= 1 (organisations).
 *   3. Exactly one corroborated candidate -> match; none or several -> skipped. A LittleSis id may map to one entity only.
 */
import { cachedJSON, httpJSON, cached, pool, qs } from './net.mjs';
import { ownershipWording } from './wd.mjs';

const API = 'https://littlesis.org/api';
const OPTS = { minDelay: 130, allow404: true, retries: 5 };
const NOW_YEAR = new Date().getFullYear();

const STOP_TOKENS = new Set(
  'american british french german chinese russian indian japanese canadian australian italian spanish brazilian korean businessman businesswoman politician entrepreneur investor company corporation multinational billionaire founder executive chief officer president minister former current member party political united states international national group holdings technology financial services investment public private global worldwide largest world the and for with from that this which also has its was are who president chairman chairwoman director board senior vice'.split(' ')
);

const ORG_SUFFIX = new Set('inc incorporated corp corporation co company llc ltd limited plc ag sa nv se the lp llp holdings'.split(' '));

export function normName(s, org) {
  let t = String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();
  t = t.replace(/\([^)]*\)/g, ' ').replace(/&/g, ' and ').replace(/[^a-z0-9 ]+/g, ' ');
  let toks = t.split(/\s+/).filter(Boolean);
  if (org) toks = toks.filter((x) => !ORG_SUFFIX.has(x));
  else toks = toks.filter((x) => !/^(jr|sr|ii|iii|iv|mr|mrs|ms|dr|sir|dame|lord|lady|prof)$/.test(x) && x.length > 1);
  return toks.join(' ');
}

async function search(name) {
  return cachedJSON(
    `${API}/entities/search?${qs({ q: name })}`,
    (j) => (j?.data || []).map((d) => ({ id: d.attributes.id, name: d.attributes.name, ext: d.attributes.primary_ext, blurb: d.attributes.blurb || '', summary: (d.attributes.summary || '').slice(0, 600), aliases: (d.attributes.aliases || []).slice(0, 20) })),
    OPTS
  ).catch(() => null);
}

const KEEP_CATS = new Set([1, 3, 4, 5, 6, 7, 9, 10, 11]);
const slimRel = (d) => {
  const a = d.attributes;
  const ca = a.category_attributes || {};
  return { id: a.id, e1: a.entity1_id, e2: a.entity2_id, c: a.category_id, d1: a.description1, d2: a.description2, s: a.start_date, e: a.end_date, cur: a.is_current, amt: a.amount, ccy: a.currency, desc: a.description, board: ca.is_board || undefined, exec: ca.is_executive || undefined, emp: ca.is_employee || undefined, pct: ca.percent_stake ?? undefined };
};

async function relPage(id, page, category) {
  const url = `${API}/entities/${id}/relationships?${qs({ page, ...(category ? { category_id: category } : {}) })}`;
  return cachedJSON(url, (j) => (j ? { pages: j.meta?.pageCount || 1, rels: (j.data || []).filter((d) => KEEP_CATS.has(d.attributes.category_id)).map(slimRel) } : { pages: 0, rels: [] }), OPTS);
}

/** All relevant relationships of an entity (capped; hubs are fetched per category). */
export async function relationships(id) {
  const first = await relPage(id, 1);
  if (!first) return [];
  const rels = [...first.rels];
  if (first.pages <= 10) {
    for (let p = 2; p <= first.pages; p++) rels.push(...((await relPage(id, p))?.rels || []));
    return rels;
  }
  // hub: ignore the unfiltered listing, fetch the informative categories separately
  const seen = new Set();
  const out = [];
  for (const [cat, maxPages] of [[1, 5], [10, 5], [3, 4], [4, 3], [11, 4], [7, 3], [9, 3], [6, 3], [5, 12]]) {
    const f = await relPage(id, 1, cat);
    for (let p = 1; p <= Math.min(f?.pages || 0, maxPages); p++) {
      const pg = p === 1 ? f : await relPage(id, p, cat);
      for (const r of pg?.rels || []) if (!seen.has(r.id)) (seen.add(r.id), out.push(r));
    }
  }
  return out;
}

const yearFrom = (s) => {
  const m = /^(\d{4})/.exec(s || '');
  const y = m ? parseInt(m[1], 10) : null;
  return y && y > 1000 ? y : null;
};
const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
const tidy = (s) => String(s || '').replace(/\s+/g, ' ').trim();

function money(amount, ccy) {
  if (!(amount > 0)) return null;
  const sym = !ccy || ccy === 'usd' || ccy === 'USD' ? '$' : null;
  const f = amount >= 1e9 ? `${(amount / 1e9).toFixed(1).replace(/\.0$/, '')}B` : amount >= 1e6 ? `${(amount / 1e6).toFixed(1).replace(/\.0$/, '')}M` : amount >= 1e4 ? `${Math.round(amount / 1e3)}K` : String(Math.round(amount)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return sym ? `$${f}` : `${f} ${String(ccy).toUpperCase()}`;
}

/** Convert one LittleSis relationship between our entities A (= LS entity1) and B (= LS entity2). */
export function convert(rel, A, B) {
  const since = yearFrom(rel.s);
  let until = yearFrom(rel.e);
  if (until && until > NOW_YEAR) until = null;
  const ended = rel.cur === false && until == null ? true : undefined;
  const base = { since, until, ended };
  const mk = (a, b, category, label, inverseLabel, fam) => ({ a: a.id, b: b.id, category, label, inverseLabel, fam, ...base });
  const d1 = tidy(rel.d1);
  const d2 = tidy(rel.d2);
  switch (rel.c) {
    case 1: {
      if (A.kind !== 'person') return null;
      const t = d1.toLowerCase();
      if (/\bfound(er|ed)\b|co-?found/.test(t)) return mk(A, B, 'founder', 'Founder', 'Founded by', 'Founder');
      let label, fam;
      if (/^(group |co-?)?(ceo|chief executive)/.test(t) || /\bchief executive officer\b/.test(t) && !/vice|deputy|former/.test(t)) [label, fam] = ['CEO', 'CEO'];
      else if (/^(co-?)?(chair|chairman|chairwoman|chairperson)\b/.test(t) && !/vice/.test(t)) [label, fam] = ['Chair', 'Chair'];
      else if (rel.board) [label, fam] = ['Board member', 'Board member'];
      else if (d1 && d1.length <= 48) [label, fam] = [cap(d1), 'Pos:' + t];
      else if (rel.exec) [label, fam] = ['Executive', 'Pos:executive'];
      else if (rel.emp) [label, fam] = ['Employee', 'Employee'];
      else [label, fam] = ['Position holder', 'Pos:other'];
      const inv = label === 'CEO' ? 'CEO is' : label === 'Chair' ? 'Chaired by' : label === 'Employee' ? 'Employer' : `${label} is`;
      return mk(A, B, 'leadership', label, inv, fam);
    }
    case 3:
      if (B.kind === 'party') return mk(A, B, 'politics', 'Party member', 'Has member', 'Party member');
      return mk(A, B, 'politics', 'Member of', 'Has member', 'Member of');
    case 4: {
      const t = d1.toLowerCase();
      const t2 = d2.toLowerCase();
      if (/\b(husband|wife|spouse)\b/.test(t) || /\b(husband|wife|spouse)\b/.test(t2)) return { ...mk(...(A.id < B.id ? [A, B] : [B, A]), 'politics', 'Spouse', 'Spouse', 'Spouse'), ...base };
      if (/^(son|daughter|child|stepson|stepdaughter)$/.test(t)) return mk(B, A, 'politics', 'Parent of', 'Child of', 'parent');
      if (/^(father|mother|parent|stepfather|stepmother)$/.test(t)) return mk(A, B, 'politics', 'Parent of', 'Child of', 'parent');
      if (/^(brother|sister|sibling|half-brother|half-sister)$/.test(t)) return mk(...(A.id < B.id ? [A, B] : [B, A]), 'politics', 'Sibling', 'Sibling', 'Sibling');
      if (!t) return null; // unspecified family tie: not informative enough
      return mk(A, B, 'politics', `${cap(t)} of`, d2 ? `${cap(t2)} of` : 'Relative of', 'Fam:' + t);
    }
    case 5: {
      const m = money(rel.amt, rel.ccy);
      return { ...mk(A, B, 'politics', m ? `Donor (${m} total)` : 'Donor', 'Received donations from', 'Donor'), amount: rel.amt > 0 ? rel.amt : undefined };
    }
    case 6:
      return mk(...(A.id < B.id ? [A, B] : [B, A]), 'investment', 'Business partner', 'Business partner', 'Business partner');
    case 7:
      return mk(A, B, 'politics', 'Lobbies', 'Lobbied by', 'Lobbies');
    case 9:
      return mk(...(A.id < B.id ? [A, B] : [B, A]), 'investment', 'Professional associate', 'Professional associate', 'Professional associate');
    case 10: {
      const w = ownershipWording(typeof rel.pct === 'number' ? rel.pct : null, A.kind === 'fund');
      return mk(A, B, w.cat, w.label, w.inv, w.fam);
    }
    case 11:
      return mk(B, A, 'ownership', 'Parent', 'Subsidiary of', 'own');
    default:
      return null;
  }
}

/**
 * @param ents  [{id, name, kind, description, aliases, wpTitle}]
 * @param neighbours Map<qid, Set<qid>>  entities already connected in our graph (corroboration)
 * @param log   logger
 * @returns {matches: {qid: lsId}, links: [...]}
 */
export async function importLittleSis(ents, neighbours, log) {
  const byQid = new Map(ents.map((e) => [e.id, e]));
  // ---- phase 1: search
  const cand = new Map(); // qid -> [candidate]
  let searched = 0;
  await pool(ents, 3, async (e) => {
    const org = e.kind !== 'person';
    const names = new Set([normName(e.name, org)]);
    if (e.wpTitle) names.add(normName(e.wpTitle, org));
    for (const a of (e.aliases || []).slice(0, 4)) if (org || a.trim().split(/\s+/).length >= 2) names.add(normName(a, org));
    names.delete('');
    const primary = normName(e.name, org);
    const res = await search(e.name);
    if (++searched % 300 === 0) log(`  littlesis search ${searched}/${ents.length}`);
    if (!res) return;
    const hits = res.filter((c) => (org ? c.ext === 'Org' : c.ext === 'Person') && (names.has(normName(c.name, org)) || c.aliases.some((x) => normName(x, org) === primary)));
    if (hits.length && hits.length <= 3) cand.set(e.id, hits);
  });
  log(`  littlesis: ${cand.size} entities with candidate(s)`);
  // ---- phase 2: relationships of candidates
  const allIds = new Map(); // lsId -> {qid}
  for (const [qid, hits] of cand) for (const h of hits) allIds.set(h.id, qid);
  const relsOf = new Map();
  const todo = [...allIds.keys()];
  let done = 0;
  await pool(todo, 3, async (id) => {
    try {
      relsOf.set(id, await relationships(id));
    } catch (e) {
      relsOf.set(id, null);
    }
    if (++done % 200 === 0) log(`  littlesis relationships ${done}/${todo.length}`);
  });
  // ---- phase 3: corroboration
  const keywords = (e) => {
    const toks = new Set();
    const add = (s) => String(s || '').toLowerCase().match(/[a-z][a-z0-9-]{4,}/g)?.forEach((t) => !STOP_TOKENS.has(t) && toks.add(t));
    add(e.description);
    for (const n of neighbours.get(e.id) || []) add(byQid.get(n)?.name);
    return toks;
  };
  const matches = new Map(); // qid -> lsId
  for (const [qid, hits] of cand) {
    const e = byQid.get(qid);
    const kw = keywords(e);
    const okHits = [];
    for (const h of hits) {
      const rels = relsOf.get(h.id);
      if (!rels) continue;
      const text = (h.blurb + ' ' + h.summary).toLowerCase();
      const A = [...kw].some((k) => new RegExp(`\\b${k}\\b`).test(text));
      let B = 0;
      let C = 0;
      for (const r of rels) {
        const other = r.e1 === h.id ? r.e2 : r.e1;
        const oq = allIds.get(other);
        if (oq && oq !== qid) {
          B++;
          if (neighbours.get(qid)?.has(oq)) C++;
        }
      }
      const need = e.kind === 'person' ? 2 : 1;
      if (A || C >= 1 || B >= need) okHits.push(h);
    }
    if (okHits.length === 1) matches.set(qid, okHits[0].id);
  }
  // a LittleSis id may serve one entity only
  const rev = new Map();
  for (const [q, id] of matches) rev.set(id, [...(rev.get(id) || []), q]);
  for (const [id, qs_] of rev) if (qs_.length > 1) qs_.forEach((q) => matches.delete(q));
  log(`  littlesis: ${matches.size} matched entities`);
  // ---- phase 4: links where both ends are matched
  const lsToQid = new Map([...matches].map(([q, id]) => [id, q]));
  const links = [];
  const seen = new Set();
  for (const [qid, id] of matches) {
    for (const r of relsOf.get(id) || []) {
      if (seen.has(r.id)) continue;
      const q1 = lsToQid.get(r.e1);
      const q2 = lsToQid.get(r.e2);
      if (!q1 || !q2 || q1 === q2) continue;
      seen.add(r.id);
      const A = byQid.get(q1);
      const B = byQid.get(q2);
      const l = convert(r, A, B);
      if (!l) continue;
      const a = byQid.get(l.a);
      const b = byQid.get(l.b);
      const note = tidy(rel_note(r));
      links.push({
        ...l,
        note: note && note.length <= 240 ? note : undefined,
        sources: [{ publisher: 'LittleSis', title: `${a.name} – ${b.name} (LittleSis)`, url: `https://littlesis.org/relationships/${r.id}` }],
        lsId: r.id,
      });
    }
  }
  const out = {};
  for (const [q, id] of matches) out[q] = id;
  return { matches: out, links };
}

const rel_note = (r) => (r.desc ? r.desc.replace(/\s+,/g, ',') : '');
export { httpJSON, cached };
