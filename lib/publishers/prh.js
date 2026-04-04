// lib/publishers/prh.js
// Penguin Random House catalog API module

export const name = 'Penguin Random House';
export const key  = 'PRH';

const PRH_BASE = 'https://api.penguinrandomhouse.com/resources/v2/title';
const DOMAIN   = 'PRH.US';

function apiKey() {
  return process.env.PRH_API_KEY;
}

async function prhFetch(path, params = {}) {
  const url = new URL(`${PRH_BASE}${path}`);
  url.searchParams.set('api_key', apiKey());
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v);
  }
  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`PRH API error ${res.status} for ${path}`);
  return res.json();
}

/**
 * Fetch the full consumer category tree (depth=2).
 * Returns a flat array of { catId, description, catUri, parentId }.
 */
export async function fetchCategories() {
  const json = await prhFetch(`/domains/${DOMAIN}/categories`, {
    catSetId: 'CN',
    depth: 2,
  });

  // Response shape: json.data.categories (array of category objects)
  const raw = json?.data?.categories ?? [];

  function flatten(nodes, parentId = null) {
    const result = [];
    for (const node of nodes) {
      result.push({
        catId:       node.catId,
        description: node.description,
        catUri:      node.catUri,
        parentId,
      });
      if (node.categories?.length) {
        result.push(...flatten(node.categories, node.catId));
      }
    }
    return result;
  }

  return flatten(raw);
}

/**
 * Fetch one page of titles for the given filters.
 * Returns { titles, total } where titles is an array of normalized title objects.
 *
 * @param {object} filters - { catUri, format, ageRange, comingSoon, keyword }
 * @param {number} start   - pagination offset
 */
export async function fetchTitles(filters = {}, start = 0) {
  const params = {
    rows: 25,
    start,
    catUri:     filters.catUri,
    format:     filters.format,
    ageRange:   filters.ageRange,
    comingSoon: filters.comingSoon,
    keyword:    filters.keyword,
  };

  const json = await prhFetch(`/domains/${DOMAIN}/titles`, params);

  // Response shape: json.data.titles (array), json.data.totalCount
  const raw   = json?.data?.titles ?? [];
  const total = json?.data?.totalCount ?? 0;

  const titles = raw.map(t => ({
    isbn:        t.isbnStr ?? String(t.isbn),
    title:       t.title,
    authors:     normalizeAuthors(t),
    price:       extractPrice(t),
    formatCode:  t.format?.code ?? null,
    formatName:  t.format?.description ?? null,
    ageRange:    t.age?.description ?? null,
    imprint:     t.imprint?.description ?? t.consumerImprint ?? null,
    onSaleDate:  t.onsale ?? null,
    coverUrl:    `https://images.penguinrandomhouse.com/cover/${t.isbnStr ?? t.isbn}`,
    description: t.flapCopy ?? t.description ?? '',
    seriesName:  t.subseries ?? t.propertyName ?? null,
  }));

  return { titles, total };
}

function normalizeAuthors(t) {
  if (typeof t.author === 'string' && t.author) return [t.author];
  if (Array.isArray(t.authors)) {
    return t.authors.map(a => a.display ?? a.name ?? String(a)).filter(Boolean);
  }
  return [];
}

function extractPrice(t) {
  // titles list may have priceDisplay or price array
  if (typeof t.priceDisplay === 'string') {
    const n = parseFloat(t.priceDisplay.replace(/[^0-9.]/g, ''));
    if (!isNaN(n)) return n;
  }
  if (Array.isArray(t.price)) {
    const usd = t.price.find(p => p.currencyCode === 'USD');
    if (usd?.amount) return parseFloat(usd.amount);
  }
  return null;
}
