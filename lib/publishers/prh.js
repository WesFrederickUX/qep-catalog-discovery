// lib/publishers/prh.js
// Penguin Random House catalog API module

export const name = 'Penguin Random House';
export const key  = 'PRH';

const PRH_BASE = 'https://api.penguinrandomhouse.com/resources/v2/title';
const DOMAIN   = 'PRH.US';

function apiKey() {
  return process.env.PRH_API_KEY;
}

async function prhFetch(path, params = {}, timeoutMs = 30000) {
  const url = new URL(`${PRH_BASE}${path}`);
  url.searchParams.set('api_key', apiKey());
  let catUriRaw = null;
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue;
    if (k === 'catUri') { catUriRaw = v; continue; }
    url.searchParams.set(k, v);
  }
  // Append catUri without encoding the slash — PRH rejects %2F
  const urlStr = catUriRaw
    ? `${url.toString()}&catUri=${catUriRaw}`
    : url.toString();
  console.log('[PRH] GET', urlStr);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(urlStr, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) {
      const body = await res.text();
      console.error(`[PRH] ${res.status} for ${path} — body: ${body.slice(0, 500)}`);
      throw new Error(`PRH API error ${res.status} for ${path}`);
    }
    return res.json();
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

/**
 * Fetch the full CN category hierarchy and return a flat list.
 * Uses /title/domains/PRH.US/categories/views/hierarchy with depth=2.
 * Response: data.categories[0].children → top-level categories, each may have children.
 */
export async function fetchCategories() {
  const json = await prhFetch(`/domains/${DOMAIN}/categories/views/hierarchy`, {
    catSetId:            'CN',
    depth:               10,
    suppressRecordCount: 'true',
  });

  const root = json?.data?.categories?.[0]?.children ?? [];

  function walk(nodes, parentId = null, level = 0) {
    const result = [];
    for (const node of nodes) {
      if (!node.catUri) continue;
      result.push({
        catId:       node.catId,
        description: node.catDesc,
        catUri:      node.catUri,
        parentId,
        level,
      });
      if (Array.isArray(node.children) && node.children.length) {
        result.push(...walk(node.children, node.catId, level + 1));
      }
    }
    return result;
  }

  const all = walk(root);
  console.log(`[PRH] loaded ${all.length} categories`);
  return all;
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
    rows: 250,
    start,
    catUri:          filters.catUri,
    format:          filters.format,
    showComingSoon:  filters.comingSoon,
    keyword:         filters.keyword,
  };

  if (params.showComingSoon) console.log('[PRH] fetchTitles params:', JSON.stringify(params));
  const json = await prhFetch(`/domains/${DOMAIN}/titles`, params);

  // Response shape: json.data.titles (array), json.data.totalCount
  const raw   = json?.data?.titles ?? [];
  const total = json?.recordCount ?? 0;

  const titles = raw.map(t => ({
    isbn:        t.isbnStr ?? String(t.isbn),
    title:       t.title,
    authors:     normalizeAuthors(t),
    price:       extractPrice(t),
    formatCode:  t.format?.code ?? null,
    formatName:  t.format?.description ?? null,
    ageRange:    t.age?.description ?? null,
    grade:       t.educationGrade?.description ?? t.grade?.description ?? null,
    language:    t.language ?? null,
    subjects:    (t.subjects ?? []).map(s => s.description).filter(Boolean),
    imprint:     t.imprint?.description ?? t.consumerImprint ?? null,
    onSaleDate:  t.onsale ?? null,
    coverUrl:       `https://images.penguinrandomhouse.com/cover/${t.isbnStr ?? t.isbn}`,
    description:    t.flapCopy ?? t.description ?? '',
    seriesName:     t.subseries ?? t.propertyName ?? null,
    pages:          t.pages ?? null,
    seoFriendlyUrl: t.seoFriendlyUrl ?? null,
    trim:           t.trimSize ?? t.trim ?? null,
  }));

  return { titles, total };
}

function stripHtml(str) {
  if (!str) return '';
  return str
    .replace(/<[^>]*>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/**
 * Fetch full detail for a single title by ISBN.
 * Calls the title detail and content endpoints in parallel.
 */
export async function fetchTitleDetail(isbn) {
  const [detailResult, contentResult] = await Promise.allSettled([
    prhFetch(`/domains/${DOMAIN}/titles/${isbn}`, { embed: 'flapCopy' }),
    prhFetch(`/domains/${DOMAIN}/titles/${isbn}/content`),
  ]);

  if (detailResult.status === 'rejected') throw detailResult.reason;
  if (contentResult.status === 'rejected') {
    console.error('[PRH] content fetch failed:', contentResult.reason?.message);
  }

  const detailJson  = detailResult.value;
  const contentJson = contentResult.status === 'fulfilled' ? contentResult.value : {};

  const t = detailJson?.data?.titles?.[0]
    ?? (Array.isArray(detailJson?.data) ? detailJson.data[0] : detailJson?.data)
    ?? {};

  // Content endpoint returns data.content as a plain object keyed by content type
  const content = contentJson?.data?.content ?? {};

  return {
    isbn:         t.isbnStr ?? String(t.isbn ?? isbn),
    title:        t.title,
    authors:      normalizeAuthors(t),
    price:        extractPrice(t),
    formatCode:   t.format?.code ?? null,
    formatName:   t.format?.description ?? null,
    ageRange:     t.age?.description ?? null,
    grade:        t.educationGrade?.description ?? t.grade?.description ?? null,
    language:     t.language ?? null,
    subjects:     (t.subjects ?? []).map(s => s.description).filter(Boolean),
    imprint:      t.imprint?.description ?? t.consumerImprint ?? null,
    onSaleDate:   t.onsale ?? null,
    coverUrl:     `https://images.penguinrandomhouse.com/cover/${t.isbnStr ?? t.isbn ?? isbn}`,
    description:  t.flapCopy ?? t.description ?? '',
    seriesName:   t.subseries ?? t.propertyName ?? null,
    pages:        t.pages ?? null,
    flapcopy:     content.flapcopy ?? '',
    keynote:      content.keynote ?? '',
    jacketquotes: content.jacketquotes ?? '',
    authorbio:    content.authorbio ?? '',
    excerpt:      content.excerpt ?? '',
  };
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
