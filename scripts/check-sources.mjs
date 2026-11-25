#!/usr/bin/env node
/**
 * Re-verifies every source URL in data/curated.json.
 *   node scripts/check-sources.mjs [--graph]
 * - Each URL must answer HTTP 200 (redirects followed).
 * - If a source carries an optional "expect" string, the response body must contain it
 *   (case-insensitive). "expect" is only used here; build-data.mjs strips it from the graph.
 * - With --graph, also checks the source URLs of public/data/graph.json that are not
 *   Wikidata statement anchors (those are generated, not hand-written).
 * Zero dependencies. Exit code 1 if any URL fails.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const UA = process.env.EXPOSE_UA || 'Mozilla/5.0 (compatible; expose-data-builder/1.0)';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const curated = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/curated.json'), 'utf8'));
const urls = new Map(); // url -> {expect:Set, where:[]}
const note = (u, expect, where) => {
  const e = urls.get(u) || { expect: new Set(), where: [] };
  if (expect) e.expect.add(expect);
  e.where.push(where);
  urls.set(u, e);
};
curated.forEach((c, i) => {
  if (!c.sources?.length) console.error(`curated[${i}] ${c.a} -> ${c.b}: no sources`);
  for (const s of c.sources || []) note(s.url, s.expect, `${c.a} -> ${c.b}`);
});
if (process.argv.includes('--graph')) {
  const g = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/data/graph.json'), 'utf8'));
  for (const l of g.links) for (const s of l.sources) if (!s.url.includes('wikidata.org/wiki/')) note(s.url, null, l.id);
}

let bad = 0;
let n = 0;
for (const [url, info] of urls) {
  n++;
  let status = 0;
  let body = '';
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, { redirect: 'follow', headers: { 'User-Agent': UA, Accept: 'text/html,*/*' }, signal: AbortSignal.timeout(30000) });
      status = res.status;
      if (status === 200 && info.expect.size) body = (await res.text()).toLowerCase();
      if (status === 429 || status >= 500) {
        await sleep(2000 * (attempt + 1));
        continue;
      }
      break;
    } catch {
      status = 0;
      await sleep(1500);
    }
  }
  let ok = status === 200;
  let why = '';
  if (ok) for (const e of info.expect) if (!body.includes(e.toLowerCase())) (ok = false), (why = ` (missing text "${e}")`);
  if (!ok) bad++;
  console.log(`${ok ? 'OK ' : 'BAD'} ${status} ${url}${why}${ok ? '' : '  <- ' + info.where.slice(0, 3).join('; ')}`);
  await sleep(150);
}
console.log(`\n${n} unique URLs checked, ${bad} failing`);
process.exit(bad ? 1 : 0);
