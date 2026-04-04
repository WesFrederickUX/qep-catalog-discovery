import express from 'express';
import { shopifyGraphQL } from '../lib/shopify.js';
import { publishers } from '../lib/publishers/index.js';

const router = express.Router();

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
  const { publisher = 'PRH', catUri, format, ageRange, comingSoon, keyword, priceMin, priceMax } = req.query;
  const module = publishers[publisher];
  if (!module) { res.status(400).json({ error: `Unknown publisher: ${publisher}` }); return; }
  if (!catUri)  { res.status(400).json({ error: 'catUri is required' }); return; }

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

    const filters = { catUri, format, ageRange, comingSoon, keyword };
    let start    = 0;
    let found    = 0;
    let excluded = 0;
    let fetched  = 0;

    while (!closed) {
      const { titles, total } = await module.fetchTitles(filters, start);

      if (!titles.length) break;

      for (const title of titles) {
        if (closed) break;
        fetched++;

        // Skip ISBNs already in Shopify
        if (title.isbn && shopifyIsbns.has(title.isbn)) {
          excluded++;
          continue;
        }

        // Optional price filter
        if (priceMin && title.price !== null && title.price < parseFloat(priceMin)) continue;
        if (priceMax && title.price !== null && title.price > parseFloat(priceMax)) continue;

        found++;
        res.write(`event: title\ndata: ${JSON.stringify(title)}\n\n`);

        // Send progress every 10 titles
        if (found % 10 === 0) {
          res.write(`event: progress\ndata: ${JSON.stringify({ found, excluded })}\n\n`);
        }
      }

      // Check if more pages exist
      if (start + 25 >= total || titles.length < 25) break;
      start += 25;

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

export default router;
