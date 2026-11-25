/**
 * HTTP helpers shared by the data pipeline: polite per-host throttling, retry with backoff,
 * an on-disk JSON cache (scripts/.cache, git-ignored) and a SPARQL client for the Wikidata Query Service.
 * Zero dependencies (Node 22 built-in fetch).
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const CACHE_DIR = path.join(ROOT, 'scripts/.cache');
export const REFRESH = process.argv.includes('--refresh');
// Wikimedia throttles bare custom UAs coming from shared egress IPs, so the UA keeps a browser-compatible
// prefix. It carries no personal information.
export const UA = process.env.EXPOSE_UA || 'Mozilla/5.0 (compatible; expose-data-builder/1.0)';
export const CACHE_TTL_MS = 24 * 3600 * 1000;

export class NetworkError extends Error {}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const chunk = (arr, n) => Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, i * n + n));
export const qs = (o) => new URLSearchParams(o).toString();

/** Each host gets its own request slots, spaced `minDelay` ms apart, even with concurrent callers. */
const nextSlot = new Map();
async function gate(host, minDelay) {
  const now = Date.now();
  const at = Math.max(now, nextSlot.get(host) || 0);
  nextSlot.set(host, at + minDelay);
  if (at > now) await sleep(at - now);
}

/**
 * Fetch JSON with retries. Returns null on 404 when `allow404` is set.
 * opts: {method, body, headers, minDelay, retries, allow404, timeoutMs}
 */
export async function httpJSON(url, opts = {}) {
  const { method = 'GET', body, headers = {}, minDelay = 250, retries = 6, allow404 = false, timeoutMs = 60000 } = opts;
  const host = new URL(url).host;
  let lastErr;
  for (let attempt = 0; attempt < retries; attempt++) {
    await gate(host, minDelay);
    try {
      const res = await fetch(url, {
        method,
        body,
        headers: { 'User-Agent': UA, Accept: 'application/json', ...headers },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.status === 404 && allow404) return null;
      if (res.status === 429 || res.status >= 500) {
        const ra = Number(res.headers.get('retry-after'));
        const backoff = ra > 0 ? ra * 1000 : 1500 * 2 ** attempt;
        lastErr = new Error(`HTTP ${res.status}`);
        await sleep(Math.min(backoff, 45000));
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

const keyOf = (s) => crypto.createHash('sha1').update(s).digest('hex');

function readCache(file, ttl) {
  try {
    const st = fs.statSync(file);
    if (ttl == null || Date.now() - st.mtimeMs < ttl) return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    /* miss */
  }
  return undefined;
}

/**
 * Cache wrapper: returns the cached value for `key` if fresh, otherwise runs `producer()` and stores its result.
 * If the producer fails with a NetworkError and a stale cache entry exists, the stale entry is used.
 */
export async function cached(key, producer, { ttl = CACHE_TTL_MS } = {}) {
  const file = path.join(CACHE_DIR, keyOf(key) + '.json');
  if (!REFRESH) {
    const hit = readCache(file, ttl);
    if (hit !== undefined) return hit;
  }
  let data;
  try {
    data = await producer();
  } catch (e) {
    const stale = readCache(file, null);
    if (stale !== undefined && e instanceof NetworkError) {
      console.warn(`WARN using stale cache for ${key.slice(0, 80)} (${e.message})`);
      return stale;
    }
    throw e;
  }
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(path.join(CACHE_DIR, '.gitignore'), '*\n');
    fs.writeFileSync(file, JSON.stringify(data));
  } catch {
    /* cache is best effort */
  }
  return data;
}

export const cachedJSON = (url, transform = (x) => x, opts = {}) => cached(url, async () => transform(await httpJSON(url, opts)), opts);

// ---------------------------------------------------------------- SPARQL

const SPARQL = 'https://query.wikidata.org/sparql';
const lastSeg = (u) => (typeof u === 'string' && u.startsWith('http://www.wikidata.org/entity/') ? u.slice(31) : u);

/** Run a SPARQL query; returns rows as plain objects (entity URIs shortened to QIDs, numbers parsed). Cached. */
export async function sparql(query, { ttl = CACHE_TTL_MS } = {}) {
  return cached(
    'sparql:' + query,
    async () => {
      const j = await httpJSON(SPARQL, {
        method: 'POST',
        body: new URLSearchParams({ query }).toString(),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/sparql-results+json' },
        minDelay: 1200,
        retries: 5,
        timeoutMs: 80000,
      });
      return (j.results?.bindings || []).map((b) => {
        const o = {};
        for (const [k, v] of Object.entries(b)) {
          if (v.type === 'literal' && /#(integer|decimal|double|float)$/.test(v.datatype || '')) o[k] = Number(v.value);
          else o[k] = lastSeg(v.value);
        }
        return o;
      });
    },
    { ttl }
  );
}

/** Run `fn` over `items` with at most `n` concurrent workers. */
export async function pool(items, n, fn) {
  let i = 0;
  const out = new Array(items.length);
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) {
        const k = i++;
        out[k] = await fn(items[k], k);
      }
    })
  );
  return out;
}
