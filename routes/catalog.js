import express from 'express';
import { readFile } from 'fs/promises';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { shopifyGraphQL, getAllAuthors, createAuthor } from '../lib/shopify.js';
import { publishers } from '../lib/publishers/index.js';
import { estimateWeight } from '../lib/weight-calculator.js';

const router = express.Router();
const __dirname = dirname(fileURLToPath(import.meta.url));
const DISCOUNTS_FILE = join(__dirname, '../data/discounts.json');

// ── In-memory caches ──────────────────────────────────────────────────────

let _categoryCache = null;      // { PRH: [...] }
let _shopifyIsbns  = null;      // Set<string>
let _shopifyIsbnsLoading = false;

// ── GET /api/catalog/categories ───────────────────────────────────────────

router.get('/categories', async (req, res) => {
  const pub = req.query.publisher ?? 'PRH';
  const module = publishers[pub];
  if (!module) return res.status(400).json({ error: `Unknown publisher: ${pub}` });

  try {
    if (!_categoryCache) _categoryCache = {};
    if (!_categoryCache[pub]) {
      console.log(`[catalog] Fetching categories for ${pub}…`);
      _categoryCache[pub] = await module.fetchCategories();
      console.log(`[catalog] Loaded ${_categoryCache[pub].length} categories for ${pub}`);
    }
    res.json(_categoryCache[pub]);
  } catch (err) {
    console.error('[catalog] categories error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/catalog/shopify-isbns ────────────────────────────────────────

router.get('/shopify-isbns', async (req, res) => {
  try {
    const isbns = await getShopifyIsbnSet();
    res.json([...isbns]);
  } catch (err) {
    console.error('[catalog] shopify-isbns error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

async function getShopifyIsbnSet() {
  if (_shopifyIsbns) return _shopifyIsbns;

  console.log('[catalog] Building Shopify ISBN cache…');
  const isbns = new Set();
  let cursor  = null;
  let hasNext = true;

  const gql = `
    query($cursor: String) {
      products(first: 250, after: $cursor) {
        nodes {
          variants(first: 5) {
            nodes { barcode }
          }
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  `;

  while (hasNext) {
    const result = await shopifyGraphQL(gql, { cursor });
    const { nodes, pageInfo } = result.data.products;

    for (const product of nodes) {
      for (const variant of product.variants.nodes) {
        if (variant.barcode) isbns.add(variant.barcode.trim());
      }
    }

    hasNext = pageInfo.hasNextPage;
    cursor  = pageInfo.endCursor;
    if (hasNext) await new Promise(r => setTimeout(r, 200));
  }

  _shopifyIsbns = isbns;
  console.log(`[catalog] Shopify ISBN cache built: ${isbns.size} ISBNs`);
  return isbns;
}

// ── GET /api/catalog/titles  (SSE) ────────────────────────────────────────

router.get('/titles', async (req, res) => {
  const { publisher = 'PRH', catUri, format, comingSoon, keyword } = req.query;
  const module = publishers[publisher];
  if (!module) { res.status(400).json({ error: `Unknown publisher: ${publisher}` }); return; }
  if (!catUri && !comingSoon) { res.status(400).json({ error: 'catUri or comingSoon is required' }); return; }

  // SSE setup
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  let closed = false;
  req.on('close', () => { closed = true; });

  try {
    // Ensure Shopify ISBN cache is ready before streaming
    const shopifyIsbns = await getShopifyIsbnSet();

    const filters = { catUri, format, comingSoon, keyword };
    let start    = 0;
    let found    = 0;
    let excluded = 0;
    let fetched  = 0;

    let firstPage = true;

    while (!closed) {
      const { titles, total } = await module.fetchTitles(filters, start);

      if (firstPage) {
        firstPage = false;
        if (!closed) {
          res.write(`event: total\ndata: ${JSON.stringify({ total })}\n\n`);
          // Flush so the total event reaches the client before any title events
          if (typeof res.flush === 'function') res.flush();
          else res.socket?.write('');
        }
      }

      if (!titles.length) break;

      for (const title of titles) {
        if (closed) break;
        fetched++;

        const inStore = !!(title.isbn && shopifyIsbns.has(title.isbn));
        if (inStore) excluded++;

        if (!inStore) found++;

        res.write(`event: title\ndata: ${JSON.stringify({ ...title, inStore })}\n\n`);

        // Send progress every 10 titles
        if (found % 10 === 0) {
          res.write(`event: progress\ndata: ${JSON.stringify({ found, excluded })}\n\n`);
        }
      }

      if (titles.length < 250) break;
      start += 250;

      if (!closed) await new Promise(r => setTimeout(r, 200));
    }

    if (!closed) {
      res.write(`event: progress\ndata: ${JSON.stringify({ found, excluded })}\n\n`);
      res.write(`event: done\ndata: ${JSON.stringify({ found, excluded })}\n\n`);
    }
  } catch (err) {
    console.error('[catalog] titles SSE error:', err.message);
    if (!closed) res.write(`event: error\ndata: ${JSON.stringify({ error: err.message })}\n\n`);
  } finally {
    res.end();
  }
});

// ── GET /api/catalog/title/:isbn  (full PRH title detail) ─────────────────

router.get('/title/:isbn', async (req, res) => {
  const { isbn } = req.params;
  const pub = req.query.publisher ?? 'PRH';
  const module = publishers[pub];
  if (!module) return res.status(400).json({ error: `Unknown publisher: ${pub}` });

  try {
    const detail = await module.fetchTitleDetail(isbn);
    console.log(`[catalog] title detail ${isbn} — flapcopy: "${(detail.flapcopy ?? '').slice(0, 200)}"`);
    res.json(detail);
  } catch (err) {
    console.error('[catalog] title detail error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/catalog/discounts ────────────────────────────────────────────

router.get('/discounts', async (_req, res) => {
  try {
    const data = await readFile(DISCOUNTS_FILE, 'utf-8');
    res.json(JSON.parse(data));
  } catch (err) {
    console.error('[catalog] discounts error:', err.message);
    res.json({});
  }
});

// ── POST /api/catalog/add-to-shopify ─────────────────────────────────────

// ── Metaobject GID helpers ────────────────────────────────────────────────

const GIDS_FILE = join(__dirname, '../data/metaobject-gids.json');
let _gids = null;

function getGids() {
  if (_gids) return _gids;
  try { _gids = JSON.parse(readFileSync(GIDS_FILE, 'utf-8')); }
  catch { _gids = {}; }
  return _gids;
}

function isValidGid(gid) {
  return gid && typeof gid === 'string' && gid.startsWith('gid://shopify/Metaobject/');
}

function normalizeBinding(formatName) {
  const f = (formatName ?? '').toLowerCase();
  if (f.includes('hardcover') || f.includes('board book')) return 'hardcover';
  return 'paperback';
}

function prhLanguageText(code) {
  if (!code || code === 'E') return 'English';
  if (code === 'S' || code === 'SP') return 'Spanish';
  return 'English';
}

function prhLanguageGid(code) {
  const G = getGids();
  const gid = (code === 'S' || code === 'SP') ? G.language?.spanish : G.language?.english;
  return isValidGid(gid) ? gid : null;
}

function getBindingGid(formatName) {
  const G = getGids();
  const gid = normalizeBinding(formatName) === 'hardcover'
    ? G.coverType?.hardcover
    : G.coverType?.paperback;
  return isValidGid(gid) ? gid : null;
}

function getGenreGids(subjects, ageRange, grade) {
  const G = getGids();
  const text = [...(subjects ?? []), ageRange ?? '', grade ?? ''].join(' ').toLowerCase();
  const gids = [];
  if (/children|juvenile|picture|young reader|kids|preschool/i.test(text)) {
    const gid = G.genre?.children;
    if (isValidGid(gid)) gids.push(gid);
  }
  if (/education|teach|classroom|curriculum|instruction|school/i.test(text)) {
    const gid = G.genre?.education;
    if (isValidGid(gid)) gids.push(gid);
  }
  if (!gids.length) {
    const gid = G.genre?.children;
    if (isValidGid(gid)) gids.push(gid);
  }
  return gids;
}

function getGradeLevelGids(grade, ageRange) {
  const G = getGids();
  const text = (grade ?? '') + ' ' + (ageRange ?? '');
  const gradeMap = [
    { key: 'k2',  re: /\bk-?[1-3]\b|grade[s]? [1-3]\b|kindergarten|early elementary/i },
    { key: '35',  re: /\b3-5\b|grade[s]? [45]\b|third|fourth|fifth|upper elem/i },
    { key: '68',  re: /\b6-8\b|grade[s]? [678]\b|middle school|junior high/i },
    { key: '912', re: /\b9-12\b|grade[s]? (9|10|11|12)\b|high school/i },
    { key: 'k12', re: /\bk-12\b|all grades/i },
  ];
  const gids = [];
  for (const { key, re } of gradeMap) {
    if (re.test(text)) {
      const gid = G.gradeLevel?.[key];
      if (isValidGid(gid) && !gids.includes(gid)) gids.push(gid);
    }
  }
  return gids;
}

function getAudienceGid(ageRange, grade) {
  const G = getGids();
  if (ageRange || grade) {
    const kids = G.targetAudience?.kids;
    if (isValidGid(kids)) return kids;
    const all  = G.targetAudience?.allAges;
    if (isValidGid(all))  return all;
  }
  const adults = G.targetAudience?.adults;
  return isValidGid(adults) ? adults : null;
}

function parseTrim(trim) {
  if (!trim) return null;
  const parts = trim.split(/\s*x\s*/i);
  if (parts.length < 2) return null;
  const width  = parseFraction(parts[0].trim());
  const height = parseFraction(parts[1].trim());
  if (!width && !height) return null;
  return { width, height };
}

function parseFraction(str) {
  if (!str) return null;
  const parts = str.split('-');
  let whole = parseFloat(parts[0]) || 0;
  if (parts[1]) {
    const frac = parts[1].split('/');
    if (frac.length === 2) whole += parseInt(frac[0]) / parseInt(frac[1]);
  }
  return whole || null;
}

function formatPubDate(dateStr) {
  if (!dateStr) return null;
  if (/^\d{8}$/.test(dateStr))          return `${dateStr.slice(0,4)}-${dateStr.slice(4,6)}-${dateStr.slice(6,8)}`;
  if (/^\d{4}-\d{2}-\d{2}/.test(dateStr)) return dateStr.slice(0, 10);
  return null;
}

function extractYear(dateStr) {
  if (!dateStr) return null;
  if (/^\d{8}$/.test(dateStr)) return parseInt(dateStr.slice(0, 4));
  const m = dateStr.match(/^(\d{4})/);
  return m ? parseInt(m[1]) : null;
}

function stripHtml(html) {
  if (!html) return '';
  return html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function formatBioAsRichText(plainText) {
  if (!plainText) return null;
  const paragraphs = plainText.split(/\n\n+/).filter(p => p.trim());
  if (!paragraphs.length) return null;
  return JSON.stringify({
    type: 'root',
    children: paragraphs.map(p => ({
      type: 'paragraph',
      children: [{ type: 'text', value: p.trim() }],
    })),
  });
}

// Split a PRH author string that may be comma-separated into individual names.
// Handles "First Last, First Last" but avoids splitting "Last, First" (single author).
function splitAuthors(rawList) {
  const names = [];
  for (const entry of rawList) {
    const parts = entry.split(',').map(s => s.trim()).filter(Boolean);
    if (parts.length <= 1) {
      // Single name or already split
      if (entry.trim()) names.push(entry.trim());
    } else {
      // Heuristic: if splitting produces parts that each look like full names
      // (i.e. each part has a space in it), treat as multiple authors.
      // Otherwise keep as-is (e.g. "Smith, John" is one author in Last, First format).
      const allLookLikeFullNames = parts.every(p => p.includes(' '));
      if (allLookLikeFullNames) {
        names.push(...parts);
      } else {
        names.push(entry.trim());
      }
    }
  }
  return names;
}

// ── Author cache ──────────────────────────────────────────────────────────

let _authorCache     = null;
let _authorCacheTime = 0;

async function findOrCreateAuthorGid(name, bioRichText = null) {
  const now = Date.now();
  if (!_authorCache || now - _authorCacheTime > 300_000) {
    _authorCache     = await getAllAuthors();
    _authorCacheTime = now;
  }

  const norm = n => n.toLowerCase().replace(/[^a-z ]/g, '').replace(/\s+/g, ' ').trim();
  const key  = norm(name);

  const found = _authorCache.find(a => {
    const f = a.fields?.find(f => f.key === 'author');
    return f && norm(f.value) === key;
  });
  if (found) return found.id;

  const created = await createAuthor(name, bioRichText);
  _authorCache = null; // invalidate cache
  return created?.id ?? null;
}

// ── Endpoint ──────────────────────────────────────────────────────────────

router.post('/add-to-shopify', async (req, res) => {
  const {
    isbn, title, authors, price, compareAtPrice, discount,
    pages, onsale, language, formatName, imprint,
    seoFriendlyUrl, coverUrl, flapcopy: flapcopyFromClient,
    authorbio: authorbioFromClient,
    trim, subjects, ageRange, grade,
  } = req.body;

  if (!isbn || !title) return res.status(400).json({ error: 'isbn and title are required' });

  try {
    // 1. Fetch flapcopy + authorbio from PRH /content endpoint if not supplied by client
    let description = flapcopyFromClient || '';
    let authorbioRaw = authorbioFromClient || '';
    if (!description || !authorbioRaw) {
      try {
        const detail = await publishers['PRH'].fetchTitleDetail(isbn);
        if (!description) description = detail.flapcopy || detail.keynote || detail.excerpt || '';
        if (!authorbioRaw) authorbioRaw = detail.authorbio || '';
      } catch (e) {
        console.warn('[add-to-shopify] PRH content fetch failed:', e.message);
      }
    }

    // Strip HTML from authorbio and format as Shopify rich text
    const bioRichText = formatBioAsRichText(stripHtml(authorbioRaw));

    // 2. Weight estimation — always pass "Penguin Random House" so trade formula is used
    const binding     = normalizeBinding(formatName);
    const weightGrams = estimateWeight(pages ?? null, binding, 'Penguin Random House') ?? 0;

    // 3. Parse trim → dimensions
    const dims = parseTrim(trim);

    // 4. Author metaobjects — split comma-separated names, find or create each
    const rawAuthors = Array.isArray(authors) ? authors : [];
    const authorList = splitAuthors(rawAuthors);
    const authorGids = [];
    for (const name of authorList) {
      if (!name?.trim()) continue;
      try {
        const gid = await findOrCreateAuthorGid(name.trim(), bioRichText);
        if (gid) authorGids.push(gid);
      } catch (e) {
        console.warn(`[add-to-shopify] author "${name}" skipped:`, e.message);
      }
    }

    // 5. Metafield GIDs
    const langGid      = prhLanguageGid(language);
    const bindingGid   = getBindingGid(formatName);
    const genreGids    = getGenreGids(subjects, ageRange, grade);
    const gradeLvlGids = getGradeLevelGids(grade, ageRange);
    const audienceGid  = getAudienceGid(ageRange, grade);

    // 6. Build metafields array
    const metafields = [];

    if (authorGids.length) {
      metafields.push({ namespace: 'custom',        key: 'authors',    value: JSON.stringify(authorGids),        type: 'list.metaobject_reference' });
    }
    if (authorList.length) {
      metafields.push({ namespace: 'app-ibp-book',  key: 'authors',    value: JSON.stringify(authorList),        type: 'list.single_line_text_field' });
    }
    if (bindingGid) {
      metafields.push({ namespace: 'shopify',        key: 'book-cover-type', value: JSON.stringify([bindingGid]), type: 'list.metaobject_reference' });
    }
    if (langGid) {
      metafields.push({ namespace: 'shopify',        key: 'language-version', value: JSON.stringify([langGid]),  type: 'list.metaobject_reference' });
    }
    if (genreGids.length) {
      metafields.push({ namespace: 'shopify',        key: 'genre',      value: JSON.stringify(genreGids),        type: 'list.metaobject_reference' });
    }
    if (gradeLvlGids.length) {
      metafields.push({ namespace: 'custom',         key: 'grade_levels', value: JSON.stringify(gradeLvlGids),   type: 'list.metaobject_reference' });
    }
    if (audienceGid) {
      metafields.push({ namespace: 'shopify',        key: 'target-audience', value: JSON.stringify([audienceGid]), type: 'list.metaobject_reference' });
    }
    if (pages) {
      metafields.push({ namespace: 'app-ibp-book',  key: 'pages',      value: String(pages),                    type: 'number_integer' });
    }
    const pubDate = formatPubDate(onsale);
    if (pubDate) {
      metafields.push({ namespace: 'app-ibp-book',  key: 'publication_date',  value: pubDate,                   type: 'date' });
    }
    const pubYear = extractYear(onsale);
    if (pubYear) {
      metafields.push({ namespace: 'app-ibp-book',  key: 'publication_year',  value: String(pubYear),           type: 'number_integer' });
    }
    metafields.push({ namespace: 'app-ibp-book',    key: 'language',   value: prhLanguageText(language),        type: 'single_line_text_field' });
    if (binding) {
      const bindingDisplay = binding.charAt(0).toUpperCase() + binding.slice(1);
      metafields.push({ namespace: 'app-ibp-book',  key: 'binding',    value: bindingDisplay,                   type: 'single_line_text_field' });
    }
    if (dims) {
      const dimList = [];
      if (dims.width)  dimList.push({ value: dims.width,  unit: 'in' });
      if (dims.height) dimList.push({ value: dims.height, unit: 'in' });
      if (dimList.length) {
        metafields.push({ namespace: 'app-ibp-book', key: 'dimensions', value: JSON.stringify(dimList),         type: 'list.dimension' });
      }
    }
    metafields.push({ namespace: 'app-ibp-book',    key: 'condition',  value: 'New',                            type: 'single_line_text_field' });
    if (discount != null && discount !== '') {
      metafields.push({ namespace: 'custom',         key: 'discount',   value: String(parseFloat(discount)),    type: 'number_decimal' });
    }
    if (seoFriendlyUrl) {
      const fullUrl = seoFriendlyUrl.startsWith('http')
        ? seoFriendlyUrl
        : `https://www.penguinrandomhouse.com${seoFriendlyUrl}`;
      metafields.push({ namespace: 'custom',         key: 'price_source_url', value: fullUrl,                  type: 'url' });
    }

    // 7. Build variant — net price as selling price, retail as compareAtPrice
    const netPrice     = price != null      ? parseFloat(price).toFixed(2)        : null;
    const compareStr   = compareAtPrice != null ? parseFloat(compareAtPrice).toFixed(2) : null;
    const priceStr     = netPrice ?? compareStr ?? '0.00';

    const variant = {
      barcode: isbn,
      sku:     isbn,
      price:   priceStr,
      inventoryPolicy: 'CONTINUE',
      optionValues: [{ optionName: 'Title', name: 'Default Title' }],
      inventoryItem: {
        tracked: false,
        measurement: { weight: { value: weightGrams, unit: 'GRAMS' } },
      },
      metafields: [
        { namespace: 'mm-google-shopping', key: 'condition', value: 'New', type: 'single_line_text_field' },
      ],
    };
    if (compareStr) variant.compareAtPrice = compareStr;

    // 8. Build productSet input
    // category (Print Books taxonomy node) is required for shopify.* namespace metafields
    // (book-cover-type, language-version, genre, target-audience). Without it Shopify
    // returns "Owner subtype does not match the metafield definition's constraints".
    const printBooksCategory = getGids().category?.printBooks ?? null;

    const productInput = {
      title,
      descriptionHtml: description,
      vendor:      imprint || 'Penguin Random House',
      productType: 'Book',
      status:      'ACTIVE',
      productOptions: [{ name: 'Title', values: [{ name: 'Default Title' }] }],
      variants:    [variant],
      metafields,
    };

    if (printBooksCategory) productInput.category = printBooksCategory;

    if (coverUrl) {
      productInput.files = [{ originalSource: coverUrl, alt: `${title} book cover`, contentType: 'IMAGE' }];
    }

    // 9. Create product via productSet mutation
    const mutation = `
      mutation ProductSet($input: ProductSetInput!, $synchronous: Boolean!) {
        productSet(input: $input, synchronous: $synchronous) {
          product {
            id
            title
            handle
            variants(first: 1) { nodes { id } }
          }
          userErrors { field message code }
        }
      }
    `;

    console.log('[add-to-shopify] creating product:', title, isbn);
    const result = await shopifyGraphQL(mutation, { input: productInput, synchronous: true });

    const userErrors = result.data?.productSet?.userErrors ?? [];
    if (userErrors.length) {
      const msg = userErrors.map(e => `${Array.isArray(e.field) ? e.field.join('.') : e.field}: ${e.message}`).join('; ');
      throw new Error(`Shopify error: ${msg}`);
    }

    const product   = result.data?.productSet?.product;
    const productId = product?.id?.split('/').pop();

    // Invalidate the Shopify ISBN cache so this ISBN shows as in-store going forward
    _shopifyIsbns = null;

    res.json({
      success:    true,
      productId:  product?.id,
      productUrl: `https://${process.env.SHOPIFY_STORE}/admin/products/${productId}`,
    });
  } catch (err) {
    console.error('[add-to-shopify] error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

export default router;
