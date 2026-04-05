import express from 'express';
import { readFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { shopifyGraphQL } from '../lib/shopify.js';
import { publishers } from '../lib/publishers/index.js';

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

export default router;
