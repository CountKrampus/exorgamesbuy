/* Turning a card's in-stock printings into the copies that go in the cart.

   A card can have many in-stock printings at once (set, condition, foil), and
   each holds only as many copies as are on the shelf. A line for 4 copies may
   therefore be filled from several printings cheapest-first. */

export const CONDITIONS = ['Damaged', 'Heavily Played', 'Moderately Played', 'Lightly Played', 'Near Mint'];

const CONDITION_RANK = new Map(CONDITIONS.map((c, i) => [c.toLowerCase(), i]));

export const CONDITION_ALIASES = {
  dmg: 'Damaged',
  damaged: 'Damaged',
  hp: 'Heavily Played',
  'heavily played': 'Heavily Played',
  mp: 'Moderately Played',
  'moderately played': 'Moderately Played',
  lp: 'Lightly Played',
  'lightly played': 'Lightly Played',
  nm: 'Near Mint',
  'near mint': 'Near Mint',
};

export function resolveCondition(value, fallback = 'Lightly Played') {
  if (!value) return fallback;
  const hit = CONDITION_ALIASES[String(value).trim().toLowerCase()];
  if (!hit) {
    throw new Error(`Unknown condition "${value}". Use one of: NM, LP, MP, HP, DMG`);
  }
  return hit;
}

function rank(condition) {
  return CONDITION_RANK.get(String(condition ?? '').trim().toLowerCase()) ?? -1;
}

export function money(value) {
  const n = Number(value);
  return Number.isFinite(n) ? `$${n.toFixed(2)}` : '—';
}

/* Filters a card's offers down to the ones the shopper would accept and sorts
   them cheapest-first, preferring the better condition on a price tie. */
export function rankOffers(card, options = {}) {
  const {
    minCondition = 'Lightly Played',
    foil = 'no',
    maxPrice = null,
    set = null,
  } = options;

  const minRank = rank(minCondition);
  const setNeedle = set ? String(set).trim().toLowerCase() : null;
  const cap = maxPrice == null ? null : Number(maxPrice);

  const offers = (card?.offers ?? []).map((o) => ({
    variantId: Number(o.variantId),
    qty: Math.max(0, Number(o.qty) || 0),
    price: Number(o.price),
    condition: String(o.condition ?? ''),
    foil: Boolean(o.foil),
    set: String(o.set ?? ''),
    name: o.name ?? card?.name ?? '',
    url: o.url ?? '',
  }));

  return offers
    .filter((o) => o.variantId > 0 && o.qty > 0 && Number.isFinite(o.price))
    .filter((o) => (foil === 'no' ? !o.foil : foil === 'only' ? o.foil : true))
    .filter((o) => rank(o.condition) >= minRank)
    .filter((o) => (cap == null ? true : o.price <= cap))
    .filter((o) => (setNeedle ? o.set.toLowerCase().includes(setNeedle) : true))
    .sort((a, b) => a.price - b.price || rank(b.condition) - rank(a.condition) || b.qty - a.qty);
}

/* Fills `wanted` copies from the ranked offers, never exceeding shelf counts.
   By default copies come cheapest-first and a playset can end up split across
   several sets; with `samePrinting` a single printing has to cover the whole
   line, and the greedy fill is only used when none can. */
export function allocate(offers, wanted, { samePrinting = false } = {}) {
  const target = Math.max(0, Number(wanted) || 0);

  if (samePrinting) {
    const single = offers.find((o) => o.qty >= target);
    if (single) {
      return {
        picks: [{ ...single, take: target }],
        filled: target,
        short: 0,
        cost: target * single.price,
        available: offers.reduce((sum, o) => sum + o.qty, 0),
      };
    }
  }

  const picks = [];
  let remaining = target;
  for (const offer of offers) {
    if (remaining <= 0) break;
    const take = Math.min(remaining, offer.qty);
    if (take <= 0) continue;
    picks.push({ ...offer, take });
    remaining -= take;
  }
  const filled = picks.reduce((sum, p) => sum + p.take, 0);
  return {
    picks,
    filled,
    short: remaining,
    cost: picks.reduce((sum, p) => sum + p.take * p.price, 0),
    available: offers.reduce((sum, o) => sum + o.qty, 0),
  };
}

export function describePick(pick) {
  const bits = [pick.set || 'unknown set', pick.condition || 'unknown condition'];
  if (pick.foil) bits.push('foil');
  return bits.join(' · ');
}
