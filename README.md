# exor-cart

Puts a Magic: The Gathering decklist into your **logged-in exorgames.com cart** in one
command: it finds the cheapest in-stock printing of every card, respects the
condition/price limits you set, splits a line across printings when the shelf is thin,
and adds the result with the same `/cart/add.js` call the store's own buttons use.

```
login → add deck.txt → exorgames.com/cart → pay
```

## Setup

Node 20+ for the cart tool, plus Python 3 for the one-time sign-in helper. The cart
itself has no dependencies.

```bash
pip install -r tools/requirements.txt   # selenium + keyring, for `login` only
```

## Sign in once

`login` drives a **real, non-headless browser** through Selenium and takes the password
from your **OS keyring** — macOS Keychain, GNOME Secret Service / KWallet, or the Windows
Credential Locker — so it is never stored in the repo and never re-typed.

```bash
python3 tools/login.py --save     # prompt once, save to the keyring, sign in
# or just let the CLI drive it:
node src/cli.mjs login            # uses the keyring entry from then on
```

The store uses the classic Shopify customer form (email + password), so the helper fills
it and waits for your account page. For 2FA, a captcha, or a code-by-email step, use the
manual path, which opens the window and waits for you to finish:

```bash
node src/cli.mjs login --manual        # or --manual --browser=firefox
```

Other login flags: `--forget` (delete the keyring entry), `--browser=chrome|firefox`,
`--keep-open`. If you have no keyring backend, the helper says so and you can supply
`EXOR_EMAIL` / `EXOR_PASSWORD` instead — or skip browsers entirely and paste cookies from
your browser's DevTools → Application → Cookies:

```bash
node src/cli.mjs login --cookie "cart=…; _secure_session_id=…; secure_customer_sig=…"
```

Either way the tool prints which account and cart it landed on, so a stale or guest
session is obvious before you buy anything.

## Add cards

Write one card per line — quantities optional, set tags fine, sideboard markers fine:

```
4 Lightning Bolt
4 Counterspell
2 Wrath of God
1 Sol Ring
1 Delver of Secrets // Insectile Aberration
3 Llanowar Elves (M19) 314
SB: 2 Duress
```

```bash
node src/cli.mjs add my-deck.txt --dry-run     # show the plan, cart untouched
node src/cli.mjs add my-deck.txt               # do it
```

### Options

| Flag | What it does |
| --- | --- |
| `--dry-run` | Print the picks and total; change nothing. |
| `--condition=NM\|LP\|MP\|HP\|DMG` | Worst condition you accept (default `LP`). |
| `--max-price=2.50` | Per-copy ceiling; cards above it are skipped. |
| `--foil=no\|yes\|only` | Foil policy (default `no`). A line ending in `*F*` also asks for foil. |
| `--set="Modern Horizons"` | Only buy printings whose set name matches. |
| `--same-printing` | Keep each line to one printing instead of filling a playset from several sets. |
| `--replace` | Empty the cart before adding. |
| `--allow-duplicates` | Add the list again even if those cards are already in the cart. |
| `--strict` | Exit non-zero if any card is missing or short. |
| `--json` | Machine-readable result (pairs well with `--dry-run`). |

Re-running the same list is safe: each added line carries a hidden `_exor` property, so a
second run tops up only what's missing instead of doubling your deck.

## Other commands

```bash
node src/cli.mjs cart                    # what's in the cart, with line prices and subtotal
node src/cli.mjs search "Sol Ring"       # every in-stock printing, condition, quantity, price
node src/cli.mjs clear --yes             # empty the cart
```

## How it works

- **Lookup** uses the store's own bulk stock endpoint
  (`exor-binder.nevski.workers.dev/instock.json`) — the same endpoint behind their public
  [Deck Builder](https://exorgames.com/pages/deck-builder) page. It returns *sellable*
  stock: printings with variant IDs, shelf counts, conditions and prices, which is the
  buying direction. Requests are chunked four names at a time and misses are retried
  individually. Nothing here scrapes their deck-builder UI, so however that page is used
  elsewhere doesn't affect this.
- **Cart writes** go to `exorgames.com/cart/add.js`, the endpoint the theme's own
  buttons call, with your saved cookies. Shopify issues the cart token as a cookie, so
  every response's cookies are replayed into the next call and saved back — otherwise a
  second run would land in a different, empty cart.
- **Buying only.** This drives the storefront cart, so it answers "what does Exor
  charge me for these cards". Selling to Exor is a separate system — a BinderPOS/
  SortSwift buylist app, plus a bulk-lot product for mailed-in lots — with its own
  sign-in and its own cash/store-credit pricing. A list of cards you're *selling* will
  price as purchases here, which is not what you want; that needs its own integration.
- **Stock caps**: copies are capped at the shelf count minus what's already in the cart,
  and a rejected batch is retried item by item so one sold-out card doesn't sink the
  rest.
- It does not touch checkout, payment, or your address book. You review and pay on the
  store's own checkout page.

## Notes and limits

- Set tags like `(2X2)` are stripped, not matched — the stock lookup is by card name, and
  the store's own deck builder ignores set codes the same way.
- Double-faced cards need their full printed name (`A // B`); the tool also tries the
  front face alone.
- A handful of cards are absent from the bulk index even when a printing is on the shelf
  (promo/sketch variants especially). They're reported as `not in stock` with the
  catalogue's own search hits.
- `.exor-auth.json` is a live session token (0600, git-ignored). Keep it off git and
  re-run `login` if it stops working. Your password itself lives only in the OS keyring.
