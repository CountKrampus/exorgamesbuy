/* Network layer for exorgames.com.

   Two hosts are involved:

   - exorgames.com  : the Shopify storefront. /cart.js and /cart/add.js are
     the same endpoints the theme's own buttons call, so a request carries the
     shopper's session exactly like a click would. The storefront rate-limits
     hard (HTTP 429 on /products/*.js), so every call here retries with
     backoff and the tool never walks the catalogue.

   - exor-binder.nevski.workers.dev : the store's own bulk stock lookup,
     the one their public Deck Builder page uses. It answers "which in-stock
     printings exist for these card names" in one shot, which keeps the load
     off the storefront. It resolves at most a handful of names per request,
     so lookups are chunked small and misses are retried individually.
*/

export const SITE = 'https://exorgames.com';
export const LOOKUP = 'https://exor-binder.nevski.workers.dev';

const UA = 'exor-cart/1.0 (+personal shopping helper)';
const DEFAULT_TIMEOUT = 30_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class HttpError extends Error {
  constructor(message, { status, url, body } = {}) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.url = url;
    this.body = body;
  }
}

/* One JSON request with retry on 429/5xx. Returns { data, cookies } where
   cookies are the Set-Cookie values, so the caller can follow a refreshed
   cart token. */
export async function requestJson(url, options = {}) {
  const {
    method = 'GET',
    body,
    cookie,
    headers = {},
    timeout = DEFAULT_TIMEOUT,
    retries = 4,
  } = options;

  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const res = await fetch(url, {
        method,
        body,
        signal: controller.signal,
        headers: {
          'User-Agent': UA,
          Accept: 'application/json',
          ...(body ? { 'Content-Type': 'application/json' } : {}),
          ...(cookie ? { Cookie: cookie } : {}),
          ...headers,
        },
      });

      const setCookies = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];

      if (res.status === 429 || res.status >= 500) {
        const retryAfter = Number.parseFloat(res.headers.get('retry-after') ?? '');
        const wait = Number.isFinite(retryAfter) ? retryAfter * 1000 : Math.min(1500 * 2 ** attempt, 15_000);
        lastError = new HttpError(`HTTP ${res.status} from ${url}`, { status: res.status, url });
        if (attempt < retries) {
          await sleep(wait);
          continue;
        }
        throw lastError;
      }

      const text = await res.text();
      let data = null;
      if (text) {
        try {
          data = JSON.parse(text);
        } catch {
          throw new HttpError(`Expected JSON from ${url} but got ${text.slice(0, 120)}`, {
            status: res.status,
            url,
            body: text.slice(0, 500),
          });
        }
      }

      if (!res.ok) {
        throw new HttpError(`HTTP ${res.status} from ${url}: ${text.slice(0, 200)}`, {
          status: res.status,
          url,
          body: data,
        });
      }

      return { data, setCookies };
    } catch (err) {
      lastError = err;
      const retryable = err.name === 'AbortError' || err instanceof TypeError;
      if (!retryable || attempt >= retries) throw err;
      await sleep(Math.min(1000 * 2 ** attempt, 10_000));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError;
}

/* ---------- stock lookup ---------- */

const LOOKUP_CHUNK = 4;

function resultKey(name) {
  return String(name ?? '').trim().toLowerCase();
}

/* Returns Map<lowercased name, card> where card.offers is the list of
   in-stock printings: { variantId, qty, price, condition, foil, set, url }. */
export async function lookupStock(names, { onProgress, concurrency = 2 } = {}) {
  const unique = [...new Set(names.filter(Boolean))];
  const found = new Map();
  const chunks = [];
  for (let i = 0; i < unique.length; i += LOOKUP_CHUNK) chunks.push(unique.slice(i, i + LOOKUP_CHUNK));

  let done = 0;
  const queue = [...chunks];
  async function worker() {
    for (;;) {
      const chunk = queue.shift();
      if (!chunk) return;
      const url =
        `${LOOKUP}/instock.json?max=${Math.max(chunk.length, 4)}` +
        `&names=${encodeURIComponent(chunk.join('|'))}`;
      try {
        const { data } = await requestJson(url, { timeout: 40_000 });
        for (const card of data?.cards ?? []) {
          if (card?.name) found.set(resultKey(card.name), card);
        }
      } catch (err) {
        onProgress?.(`  lookup failed for ${chunk.join(', ')}: ${err.message}`);
      }
      done += chunk.length;
      onProgress?.(`  checked ${Math.min(done, unique.length)}/${unique.length} card names`);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length || 1) }, worker));

  // Retry the misses one name at a time: the endpoint returns a partial page,
  // so a name can be missing from a batch even though it is in stock.
  const missing = unique.filter((n) => !found.has(resultKey(n)));
  for (const name of missing) {
    const url = `${LOOKUP}/instock.json?max=1&names=${encodeURIComponent(name)}`;
    try {
      const { data } = await requestJson(url, { timeout: 30_000, retries: 2 });
      for (const card of data?.cards ?? []) {
        if (card?.name) found.set(resultKey(card.name), card);
      }
    } catch {
      /* treated as not in stock */
    }
  }

  return found;
}

/* Storefront search, used by `search` and as a hint when a name is missing
   from the stock lookup (catalogue titles carry the set in brackets). */
export async function suggestProducts(query, limit = 6) {
  const url =
    `${SITE}/search/suggest.json?q=${encodeURIComponent(query)}` +
    `&resources[type]=product&resources[limit]=${limit}`;
  const { data } = await requestJson(url, { retries: 3 });
  return (data?.resources?.results?.products ?? []).map((p) => ({
    title: p.title,
    handle: p.handle,
    available: Boolean(p.available),
    priceMin: p.price_min,
    priceMax: p.price_max,
    url: `${SITE}/products/${p.handle}`,
  }));
}

/* ---------- cart ---------- */

/* Returns the whole response: Shopify issues the cart token as a cookie, and
   the caller has to replay it or the next call lands in a different cart. */
export async function getCart(cookie) {
  return requestJson(`${SITE}/cart.js`, { cookie });
}

export async function addToCart(items, cookie) {
  return requestJson(`${SITE}/cart/add.js`, {
    method: 'POST',
    body: JSON.stringify({ items }),
    cookie,
    retries: 2,
  });
}

export async function changeCartLine(lineKey, quantity, cookie) {
  return requestJson(`${SITE}/cart/change.js`, {
    method: 'POST',
    body: JSON.stringify({ id: lineKey, quantity }),
    cookie,
  });
}

export async function clearCart(cookie) {
  return requestJson(`${SITE}/cart/clear.js`, { method: 'POST', body: JSON.stringify({}), cookie });
}

/* ---------- cookies ---------- */

export function cookieHeader(cookies) {
  return (cookies ?? [])
    .filter((c) => c && c.name && typeof c.value === 'string')
    .map((c) => `${c.name}=${c.value}`)
    .join('; ');
}

/* Pulls the Cart JS cookie out of a Set-Cookie list so a fresh cart token is
   never lost when Shopify rotates it. */
export function mergeCookies(cookies, setCookies = []) {
  const byName = new Map((cookies ?? []).map((c) => [c.name, { ...c }]));
  for (const raw of setCookies) {
    const [pair] = raw.split(';');
    const idx = pair.indexOf('=');
    if (idx <= 0) continue;
    const name = pair.slice(0, idx).trim();
    const value = pair.slice(idx + 1).trim();
    const existing = byName.get(name) ?? { name, domain: '.exorgames.com', path: '/' };
    byName.set(name, { ...existing, name, value });
  }
  return [...byName.values()];
}
