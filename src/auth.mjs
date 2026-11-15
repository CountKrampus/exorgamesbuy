/* Saving and loading the shopper's session.

   The cart on exorgames.com lives in a cookie, so the only thing needed to act
   as the logged-in shopper is that cookie set. Signing in is delegated to
   tools/login.py, which drives a real non-headless browser through Selenium and
   takes the password from the OS keyring — nothing here ever sees the password.

   Two ways in:

     login                 run the Selenium helper, which signs in and saves the
                           cookies for every later run
     login --cookie "..."  paste a Cookie header copied from your browser's
                           DevTools when you'd rather not install anything

   The session file is chmod 600 and git-ignored: treat it like a password and
   re-run `login` when it expires. */

import { chmod, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { SITE, mergeCookies, requestJson } from './store.mjs';

export const AUTH_PATH = path.resolve('.exor-auth.json');

export async function loadAuth() {
  let raw;
  try {
    raw = await readFile(AUTH_PATH, 'utf8');
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed.cookies) || parsed.cookies.length === 0) return null;
    return parsed;
  } catch {
    return null;
  }
}

export async function saveAuth(cookies, source) {
  const payload = {
    savedAt: new Date().toISOString(),
    source,
    cookies,
  };
  await writeFile(AUTH_PATH, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
  try {
    await chmod(AUTH_PATH, 0o600);
  } catch {
    /* best effort on filesystems without POSIX modes */
  }
  return payload;
}

export function parseCookieHeader(header) {
  return String(header ?? '')
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const idx = part.indexOf('=');
      if (idx <= 0) return null;
      return {
        name: part.slice(0, idx).trim(),
        value: part.slice(idx + 1).trim(),
        domain: '.exorgames.com',
        path: '/',
      };
    })
    .filter(Boolean);
}

/* Confirms the saved cookies reach the store and reports who they belong to
   (if anyone), so a stale session is caught before a cart run. */
export async function verifySession(auth) {
  const cookie = auth.cookies.map((c) => `${c.name}=${c.value}`).join('; ');
  const cart = await requestJson(`${SITE}/cart.js`, { cookie });
  let customer = null;
  try {
    const res = await fetch(`${SITE}/account`, {
      headers: { Cookie: cookie, 'User-Agent': 'exor-cart/1.0' },
      redirect: 'manual',
    });
    // A logged-in session is served the account dashboard (which always links
    // to /account/logout); a guest gets a 302 to the sign-in form.
    if (res.status === 200) {
      const html = await res.text();
      if (/\/account\/logout/i.test(html)) customer = 'signed in';
    }
  } catch {
    /* account check is best effort — the cart call above is the real proof */
  }
  return { cart: cart.data, customer, cookie };
}

export { mergeCookies };
