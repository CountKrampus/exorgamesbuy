/* Decklist parsing. Mirrors the conventions the store's own Deck Builder
   accepts, so a list that works on exorgames.com/pages/deck-builder works
   here unchanged:

     4 Lightning Bolt        4x Lightning Bolt       Lightning Bolt x4
     4 Lightning Bolt (2X2) 117
     4 Lightning Bolt [MGA] 117 *F*
     SB: 2 Duress            // comment              # comment
     Deck / Sideboard / Commander section headers

   Set tags are stripped, not matched: the store's stock lookup is by bare
   card name. A trailing *F* marks the line foil-preferred. */

const SECTION_HEADER =
  /^(deck|sideboard|side board|commander|companion|maybeboard|maybe board|tokens?|lands?|creatures?|spells?|artifacts?|enchantments?|planeswalkers?|instants?|sorceries)\s*:?\s*(\(\d+\))?\s*$/i;

const MAX_LINES = 200;
const MAX_QTY = 99;

export function parseDeck(text) {
  const lines = String(text ?? '')
    .replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, '')
    .split(/\r?\n/)
    .slice(0, MAX_LINES);

  const order = [];
  const index = new Map();

  for (const raw of lines) {
    let line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith('//')) continue;
    if (SECTION_HEADER.test(line)) continue;
    line = line.replace(/^sb:\s*/i, '');

    let qty = 1;
    let name = line;
    let m;

    if ((m = /^(\d{1,3})[xX](\S.*)$/.exec(line))) {
      qty = Number.parseInt(m[1], 10) || 1;
      name = m[2];
    } else if ((m = /^(\d{1,3})\s*[xX]?\s+(.+)$/.exec(line))) {
      qty = Number.parseInt(m[1], 10) || 1;
      name = m[2];
    } else if ((m = /^(.+?)\s+[xX](\d{1,3})$/.exec(line))) {
      name = m[1];
      qty = Number.parseInt(m[2], 10) || 1;
    }

    const foilToken = /\*\s*f\s*\*/i.test(name);

    name = name
      .replace(/\s*\([^)]*\)\s*[0-9A-Za-z-]*\s*$/, '')
      .replace(/\s*\*[^*]*\*\s*$/, '')
      .replace(/\s*\[[^\]]*\]\s*$/, '')
      .replace(/\s*<[^>]*>\s*$/, '')
      .replace(/\s+#.*$/, '')
      .replace(/\s{2,}/g, ' ')
      .trim();

    if (name.length < 2) continue;
    qty = Math.min(Math.max(qty, 1), MAX_QTY);

    const key = name.toLowerCase();
    const existing = index.get(key);
    if (existing) {
      existing.qty += qty;
      existing.qty = Math.min(existing.qty, MAX_QTY);
      existing.foil = existing.foil || foilToken;
    } else {
      const entry = { name, qty, foil: foilToken };
      index.set(key, entry);
      order.push(entry);
    }
  }

  return order;
}

/* Lookup tries the printed name first, then the front face of a double-faced
   card ("A // B" -> "A"), then the full pair name if the line was shortened. */
export function nameCandidates(name) {
  const out = [];
  const push = (v) => {
    const t = String(v ?? '').trim();
    if (t.length >= 2 && !out.some((x) => x.toLowerCase() === t.toLowerCase())) out.push(t);
  };
  push(name);
  if (name.includes('//')) push(name.split('//')[0]);
  return out;
}
