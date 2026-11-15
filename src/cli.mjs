#!/usr/bin/env node
/* exor-cart — put a Magic: The Gathering decklist into your exorgames.com cart.

   node src/cli.mjs login                 sign in once, cookies are saved
   node src/cli.mjs add deck.txt          resolve every card and add to cart
   node src/cli.mjs add deck.txt --dry-run    show the plan, cart untouched
   node src/cli.mjs cart                  show what is in the cart now
   node src/cli.mjs search "Sol Ring"     look up in-stock printings and prices
   node src/cli.mjs clear                 empty the cart
*/

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { nameCandidates, parseDeck } from './parse.mjs';
import {
  CONDITIONS,
  allocate,
  describePick,
  money,
  rankOffers,
  resolveCondition,
} from './pick.mjs';
import {
  SITE,
  HttpError,
  addToCart,
  clearCart,
  cookieHeader,
  getCart,
  lookupStock,
  requestJson,
  suggestProducts,
} from './store.mjs';
import { loadAuth, mergeCookies, parseCookieHeader, saveAuth, verifySession } from './auth.mjs';

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code) => (s) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const bold = paint('1');
const dim = paint('2');
const red = paint('31');
const green = paint('32');
const yellow = paint('33');
const cyan = paint('36');

/* ---------------- argument parsing ---------------- */

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      if (eq > -1) {
        flags[arg.slice(2, eq)] = arg.slice(eq + 1);
      } else {
        const key = arg.slice(2);
        const next = argv[i + 1];
        if (next && !next.startsWith('-')) {
          flags[key] = next;
          i++;
        } else {
          flags[key] = true;
        }
      }
    } else if (arg.startsWith('-') && arg.length > 1) {
      flags[arg.slice(1)] = true;
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}

function usage() {
  console.log(`${bold('exor-cart')} — decklist to exorgames.com cart

${bold('Commands')}
  login                     open a browser, sign in, save the session
  add <list>                resolve the list and add every in-stock card
  cart                      show the current cart
  search <card name>        in-stock printings, conditions and prices
  clear                     empty the cart

${bold('add options')}
  --dry-run                 print the plan, do not touch the cart
  --replace                 empty the cart before adding
  --condition=NM|LP|MP|HP|DMG   worst condition you accept (default LP)
  --max-price=2.50          per-copy price ceiling
  --foil=no|yes|only        foil policy (default no)
  --set="Modern Horizons"   only buy printings from a matching set
  --same-printing           keep each line to one printing instead of
                            filling the playset from several
  --allow-duplicates        add the list again even if these cards are
                            already in the cart (re-runs skip them by default)
  --json                    machine-readable result
  --strict                  non-zero exit if any card is missing or short

${bold('login options')}
  --save                    prompt and store the password in the system keyring
  --manual                  open the browser and sign in by hand (2FA, captcha)
  --forget                  delete the stored keyring credentials
  --browser=chrome|firefox  which browser the helper should drive
  --cookie "cart=…; …"      paste cookies instead of signing in
`);
}

/* ---------------- session ---------------- */

/* A cart lives in a cookie: Shopify hands out the cart token on the first cart
   call, so every response's cookies are replayed into the next request and
   written back to disk. Without this a second run would silently act on a
   brand-new empty cart. */
function sessionFrom(auth) {
  const session = {
    cookies: [...(auth.cookies ?? [])],
    header: '',
    async call(fn) {
      session.header = cookieHeader(session.cookies);
      const res = await fn(session.header);
      if (res?.setCookies?.length) {
        session.cookies = mergeCookies(session.cookies, res.setCookies);
        await saveAuth(session.cookies, auth.source ?? 'refreshed');
      }
      return res;
    },
  };
  return session;
}

/* ---------------- output helpers ---------------- */

function hr(width = 78, say = console.log) {
  say(dim('─'.repeat(width)));
}

function cartSummary(cart, say = console.log) {
  const items = cart?.items ?? [];
  if (!items.length) {
    say(dim('Cart is empty.'));
    return;
  }
  for (const item of items) {
    const price = Number(item.final_price ?? item.price ?? 0) / 100;
    const line = (Number(item.final_line_price ?? item.line_price ?? 0) / 100).toFixed(2);
    say(
      `  ${String(item.quantity).padStart(2)}× ${item.product_title} ${dim(`— ${item.variant_title ?? ''}`)}` +
        `  ${money(price)} ea  ${bold(`$${line}`)}`,
    );
  }
  const total = Number(cart.total_price ?? 0) / 100;
  say(`\n  ${bold(`${cart.item_count} items`)}  subtotal ${bold(money(total))} ${dim('(before shipping/tax)')}`);
}

/* ---------------- commands ---------------- */

async function cmdLogin(flags) {
  if (typeof flags.cookie === 'string') {
    const cookies = parseCookieHeader(flags.cookie);
    if (!cookies.length) throw new Error('That cookie string has no name=value pairs in it.');
    await saveAuth(cookies, 'cookie header');
    const { cart, customer } = await verifySession({ cookies });
    console.log(green('Session saved.'));
    console.log(`  cookies : ${cookies.map((c) => c.name).join(', ')}`);
    console.log(`  account : ${customer ? bold(customer) : yellow('not recognised — the cart actions still work, but check you pasted the right cookies')}`);
    console.log(`  cart    : ${cart?.item_count ?? 0} items already in it`);
    return;
  }

  // Signing in is delegated to the Selenium helper: it drives a real browser so
  // 2FA and captchas work, and reads the password from the OS keyring.
  const helper = path.resolve('tools/login.py');
  if (!existsSync(helper)) throw new Error(`Sign-in helper is missing: ${helper}`);

  const args = [helper];
  if (flags.manual) args.push('--manual');
  if (flags.save) args.push('--save');
  if (flags.forget) args.push('--forget');
  if (flags['keep-open']) args.push('--keep-open');
  if (typeof flags.browser === 'string') args.push('--browser', flags.browser);

  const result = spawnSync(process.env.PYTHON ?? 'python3', args, { stdio: 'inherit' });
  if (result.error) {
    throw new Error(
      `Could not run the sign-in helper (is python3 installed?): ${result.error.message}`,
    );
  }
  if (flags.forget) return;
  if (result.status !== 0) throw new Error('Sign-in did not complete — see the messages above.');

  const auth = await loadAuth();
  if (!auth) throw new Error('Sign-in reported success but no session file was written.');

  console.log(green('\nSession saved to .exor-auth.json'));
  const { cart, customer } = await verifySession(auth);
  console.log(`  account : ${customer ? bold(customer) : yellow('not recognised (looks like a guest session)')}`);
  console.log(`  cart    : ${cart?.item_count ?? 0} items already in it`);
}

async function requireAuth() {
  const auth = await loadAuth();
  if (!auth) {
    throw new Error(
      'No saved session. Run `node src/cli.mjs login` first (or `login --cookie "…"`).\n' +
        'The cart belongs to a browser session, so the tool needs your signed-in cookies.',
    );
  }
  return auth;
}

async function cmdSearch(positional, flags) {
  const query = positional.join(' ').trim();
  if (!query) throw new Error('Usage: exor-cart search "Sol Ring"');
  const limit = Number(flags.limit ?? 12);
  const stock = await lookupStock([query]);
  const card = [...stock.values()][0];

  if (!card) {
    console.log(yellow(`No in-stock single matches "${query}" by exact name.`));
    const products = await suggestProducts(query, 5).catch(() => []);
    if (products.length) {
      console.log(dim('\nCatalogue matches (set shown in brackets on the product page):'));
      for (const p of products) {
        console.log(`  ${p.available ? green('in stock') : red('sold out')}  ${p.title}  ${dim(`$${p.priceMin}–$${p.priceMax}`)}`);
        console.log(`            ${dim(p.url)}`);
      }
    }
    return;
  }

  const offers = rankOffers(card, { minCondition: 'Damaged', foil: 'any' }).slice(0, limit);
  console.log(`${bold(card.name)} — ${offers.length} in-stock printings\n`);
  console.log(dim('  condition        qty   price   set'));
  for (const o of offers) {
    const cond = `${o.condition}${o.foil ? ' Foil' : ''}`.padEnd(16);
    console.log(`  ${cond} ${String(o.qty).padStart(3)}  ${money(o.price).padStart(7)}   ${o.set}`);
  }
  console.log(`\n  ${dim('variant ids are used by `add`; prices are live at lookup time.')}`);
}

async function cmdCart(flags) {
  const auth = await requireAuth();
  const session = sessionFrom(auth);
  const { data: cart } = await session.call((c) => getCart(c));
  if (flags.json) {
    console.log(JSON.stringify(cart, null, 2));
    return;
  }
  console.log(bold('Cart on exorgames.com'));
  hr();
  cartSummary(cart);
  if (cart?.item_count) {
    console.log(dim(`\n  checkout: ${SITE}/cart`));
  }
}

async function cmdClear(flags) {
  const auth = await requireAuth();
  const session = sessionFrom(auth);
  const { data: before } = await session.call((c) => getCart(c));
  if (!before?.item_count) {
    console.log(dim('Cart was already empty.'));
    return;
  }
  if (!flags.yes) {
    console.log(`This removes ${before.item_count} item(s) from your cart. Re-run with --yes to confirm.`);
    return;
  }
  await session.call((c) => clearCart(c));
  console.log(green(`Cleared ${before.item_count} item(s) from the cart.`));
}

async function cmdAdd(positional, flags) {
  const file = positional[0];
  if (!file) throw new Error('Usage: exor-cart add <decklist.txt> [--dry-run] [--condition=LP] …');

  const raw = file === '-' ? await readStdin() : await readFile(path.resolve(file), 'utf8');
  const lines = parseDeck(raw);
  if (!lines.length) throw new Error(`No cards found in ${file}.`);

  const minCondition = resolveCondition(flags.condition);
  const foilGlobal = normalizeFoil(flags.foil);
  const samePrinting = flags['same-printing'] === true;
  const maxPrice = flags['max-price'] != null ? Number(flags['max-price']) : null;
  if (maxPrice != null && !Number.isFinite(maxPrice)) throw new Error('--max-price must be a number');
  const set = typeof flags.set === 'string' ? flags.set : null;

  // With --json the report is the only thing written to stdout.
  const say = flags.json ? () => {} : console.log;

  const auth = await requireAuth();
  const session = sessionFrom(auth);

  say(bold(`\n${lines.length} card line(s) → exorgames.com`));
  say(dim(`  condition ≥ ${minCondition} · foil ${foilGlobal}${maxPrice != null ? ` · ≤ ${money(maxPrice)}/copy` : ''}${set ? ` · set ~ "${set}"` : ''}${flags['dry-run'] ? ' · DRY RUN' : ''}\n`));

  const lookupNames = [];
  for (const line of lines) lookupNames.push(...nameCandidates(line.name));
  const stock = await lookupStock(lookupNames);

  const plan = [];
  for (const line of lines) {
    let card = null;
    for (const candidate of nameCandidates(line.name)) {
      card = stock.get(candidate.toLowerCase());
      if (card) break;
    }

    const foilMode = line.foil ? 'prefer' : foilGlobal;
    const baseOptions = { minCondition, maxPrice, set };

    if (!card) {
      plan.push({ line, card: null, result: { picks: [], filled: 0, short: line.qty, cost: 0, available: 0 } });
      continue;
    }

    let offers = rankOffers(card, { ...baseOptions, foil: foilMode });
    let result = allocate(offers, line.qty, { samePrinting });

    // A foil-marked line falls back to non-foil rather than buying nothing.
    if (result.filled === 0 && foilMode === 'prefer') {
      offers = rankOffers(card, { ...baseOptions, foil: 'any' });
      result = allocate(offers, line.qty, { samePrinting });
    }
    // Exact-name lookup can miss when only another printing is stocked under a
    // slightly different catalogue title; report what the store does have.
    plan.push({ line, card, result, offers });
  }

  printPlan(plan, say);

  const addable = plan.filter((p) => p.result.filled > 0);
  const missing = plan.filter((p) => !p.card);
  const short = plan.filter((p) => p.card && p.result.short > 0);
  const plannedCost = plan.reduce((sum, p) => sum + p.result.cost, 0);
  const plannedQty = plan.reduce((sum, p) => sum + p.result.filled, 0);

  if (!addable.length) {
    say(yellow('\nNothing in this list is in stock under the current filters — cart unchanged.'));
    if (flags.json) console.log(JSON.stringify({ added: [], missing: missing.map((p) => p.line.name), cart: null }, null, 2));
    if (flags.strict) process.exitCode = 1;
    return;
  }

  if (flags['dry-run']) {
    say(`\n${bold('Dry run')}: would add ${plannedQty} card(s) for ${bold(money(plannedCost))}. Cart untouched.`);
    if (flags.json) {
      console.log(JSON.stringify({ dryRun: true, plannedQty, plannedCost, plan: serializePlan(plan) }, null, 2));
    }
    if (flags.strict && (missing.length || short.length)) process.exitCode = 1;
    return;
  }

  if (flags.replace) {
    await session.call((c) => clearCart(c));
    say(dim('\nCart emptied (--replace).'));
  }

  // Read the live cart first: it may already hold copies of these variants
  // (a manual add, or an earlier run of this tool), and adding past the shelf
  // count is not something the store will stop us from doing.
  const { data: before } = await session.call((c) => getCart(c));
  const haveByVariant = new Map();
  const haveByLine = new Map();
  for (const item of before?.items ?? []) {
    const variant = Number(item.variant_id);
    haveByVariant.set(variant, (haveByVariant.get(variant) ?? 0) + Number(item.quantity));
    const tag = item.properties?._exor;
    if (tag) haveByLine.set(tag, (haveByLine.get(tag) ?? 0) + Number(item.quantity));
  }

  // Every line carries a hidden `_exor` property, so a second run of the same
  // list knows what it already bought and tops up only the difference instead
  // of doubling the deck.
  const items = [];
  const alreadyThere = [];
  for (const entry of addable) {
    const key = lineKey(entry.line.name);
    let budget = flags['allow-duplicates'] ? entry.line.qty : entry.line.qty - (haveByLine.get(key) ?? 0);
    if (budget <= 0) {
      alreadyThere.push(entry.line.name);
      continue;
    }
    for (const pick of entry.result.picks) {
      if (budget <= 0) break;
      const room = pick.qty - (haveByVariant.get(pick.variantId) ?? 0);
      const take = Math.min(pick.take, room, budget);
      if (take <= 0) continue;
      items.push({ id: pick.variantId, quantity: take, properties: { _exor: key } });
      budget -= take;
    }
  }

  if (!items.length) {
    say(dim('\nEvery in-stock copy in this list is already in the cart. Nothing to do.'));
  } else {
    const added = await addWithFallback(items, session);
    say(green(`\nAdded ${added.qty} card(s) for ${money(added.cost)}.`));
    if (alreadyThere.length) {
      say(dim(`  ${alreadyThere.length} line(s) already in the cart, left as-is (see --allow-duplicates): ${alreadyThere.join(', ')}`));
    }
    if (added.failed.length) {
      say(red(`  ${added.failed.length} item(s) could not be added (sold out between lookup and cart):`));
      for (const f of added.failed) say(`    ${f}`);
    }
  }

  const { data: after } = await session.call((c) => getCart(c));
  say(bold('\nCart now'));
  hr(78, say);
  cartSummary(after, say);
  say(dim(`\n  checkout: ${SITE}/cart`));

  if (missing.length) {
    say(yellow(`\nNot in stock (${missing.length}): ${missing.map((p) => p.line.name).join(', ')}`));
  }
  if (short.length) {
    say(yellow(`\nCould not fill every copy (${short.length}):`));
    for (const p of short) {
      say(`  ${p.line.name} — wanted ${p.line.qty}, got ${p.result.filled}, ${p.result.available} on the shelf`);
    }
  }

  if (flags.json) {
    console.log(
      JSON.stringify(
        {
          added: items,
          cart: { item_count: after?.item_count ?? 0, total: Number(after?.total_price ?? 0) / 100 },
          missing: missing.map((p) => p.line.name),
          short: short.map((p) => ({ name: p.line.name, wanted: p.line.qty, got: p.result.filled })),
        },
        null,
        2,
      ),
    );
  }
  if (flags.strict && (missing.length || short.length)) process.exitCode = 1;
}

/* One batch add, exactly like the theme's own "Add to Cart" button. If the
   batch is rejected (a copy sold out between lookup and click rejects the whole
   request), retry item by item so the rest still land. */
async function addWithFallback(items, session) {
  let qty = 0;
  let cents = 0;
  const failed = [];

  const tally = (list) => {
    for (const it of list ?? []) {
      qty += Number(it.quantity ?? 0);
      cents += Number(it.final_line_price ?? it.line_price ?? 0);
    }
  };

  try {
    const { data } = await session.call((c) => addToCart(items, c));
    tally(data?.items ?? []);
  } catch (err) {
    if (items.length === 1) {
      failed.push(`${items[0].id} (${err.message})`);
    } else {
      for (const item of items) {
        try {
          const { data } = await session.call((c) => addToCart([item], c));
          tally(data?.items ?? []);
        } catch (itemError) {
          failed.push(`${item.id} ×${item.quantity} (${itemError.message})`);
        }
      }
    }
  }

  return { qty, cost: cents / 100, failed };
}

/* Stable per-card tag used to recognise this tool's own cart lines. */
function lineKey(name) {
  return String(name).trim().toLowerCase().replace(/\s+/g, ' ');
}

function fit(value, width) {
  const s = String(value ?? '');
  return (s.length > width ? `${s.slice(0, width - 1)}…` : s).padEnd(width);
}

function printPlan(plan, say = console.log) {
  say(dim('  qty  card                                   printing · condition          each     line'));
  for (const entry of plan) {
    const { line, result } = entry;
    if (!entry.card) {
      say(`  ${red(String(line.qty).padStart(3))}  ${fit(line.name, 38)} ${red('not in stock')}`);
      continue;
    }
    if (!result.picks.length) {
      const why = result.available ? 'no printing passes the filters' : 'out of stock';
      say(`  ${red(String(line.qty).padStart(3))}  ${fit(line.name, 38)} ${red(why)}`);
      continue;
    }
    let first = true;
    for (const pick of result.picks) {
      const prefix = first ? String(line.qty).padStart(3) : '    ';
      const label = fit(describePick(pick), 34);
      say(
        `  ${cyan(prefix)}  ${fit(first ? line.name : '  ↳ same card', 38)} ${label} ` +
          `${money(pick.price).padStart(7)}  ${bold(money(pick.price * pick.take)).padStart(8)} ${dim(`×${pick.take}`)}`,
      );
      first = false;
    }
    if (result.short > 0) {
      say(`       ${yellow(`only ${result.filled} of ${line.qty} available`)}`);
    }
  }
}

function serializePlan(plan) {
  return plan.map((entry) => ({
    name: entry.line.name,
    wanted: entry.line.qty,
    filled: entry.result.filled,
    short: entry.result.short,
    cost: Number(entry.result.cost.toFixed(2)),
    picks: entry.result.picks.map((p) => ({
      variantId: p.variantId,
      condition: p.condition,
      foil: p.foil,
      set: p.set,
      price: p.price,
      qty: p.take,
    })),
  }));
}

function normalizeFoil(value) {
  if (value == null || value === true) return 'no';
  const v = String(value).toLowerCase();
  if (['no', 'false', 'nonfoil', 'non-foil'].includes(v)) return 'no';
  if (['yes', 'true', 'any', 'prefer'].includes(v)) return 'any';
  if (['only', 'foil'].includes(v)) return 'only';
  throw new Error(`Unknown --foil value "${value}". Use no, yes, or only.`);
}

function readStdin() {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

/* ---------------- entry point ---------------- */

async function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const command = positional.shift();
  if (flags.help || flags.h || !command) {
    usage();
    return;
  }

  switch (command) {
    case 'login':
      await cmdLogin(flags);
      break;
    case 'add':
      await cmdAdd(positional, flags);
      break;
    case 'cart':
      await cmdCart(flags);
      break;
    case 'search':
      await cmdSearch(positional, flags);
      break;
    case 'clear':
      await cmdClear(flags);
      break;
    default:
      usage();
      throw new Error(`Unknown command "${command}"`);
  }
}

const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (invokedDirectly) {
  main().catch((err) => {
    if (err instanceof HttpError) {
      console.error(red(`\nStore error: ${err.message}`));
      if (err.status === 429) console.error(dim('The store is rate-limiting requests — wait a minute and try again.'));
    } else {
      console.error(red(`\n${err.message}`));
    }
    process.exitCode = 1;
  });
}
