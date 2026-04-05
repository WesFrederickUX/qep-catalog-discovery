QEP Catalog Discovery Tool — Build Spec
Last updated: April 3, 2026 Status: Pre-build planning document
PURPOSE
A standalone web tool that pulls the Penguin Random House catalog via API, cross-
references against QEP’s existing Shopify inventory, and surfaces books QEP does not
currently carry. Staff can browse, evaluate, and add new titles to Shopify with one click.
Eventually integrates into the existing qep-isbn-lookup site as a new nav section, similar to
how the price monitor was added.
REPO & DEPLOYMENT
New standalone repo for now (name suggestion: qep-catalog-discovery )
Stack: Node.js / Express / ES Modules (same as qep-isbn-lookup)
Deploy on Render (auto-deploy on git push)
Integrate into WesFrederickUX/qep-isbn-lookup in a future session once stable
CREDENTIALS & KEYS (already in use on qep-isbn-lookup)
PRH_API_KEY=2n6trvt9a24jbqjadtb2hzh5
SHOPIFY_STORE=qep-books.myshopify.com
SHOPIFY_ACCESS_TOKEN=[existing token from qep-isbn-lookup .env]
EXISTING INFRASTRUCTURE TO REUSE FROM qep-isbn-
lookup
1. Shopify GraphQL helperFile: routes/api.js — function shopifyGraphQL(query, variables) Copy this function
verbatim. It handles authentication, error throwing on GraphQL errors, and returns
result.data.
async function shopifyGraphQL(query, variables = {}) {
const res = await fetch(`https://${process.env.SHOPIFY_STORE}/admin/api/2024-01/graphql.jso
method: 'POST',
headers: {
'Content-Type': 'application/json',
'X-Shopify-Access-Token': process.env.SHOPIFY_ACCESS_TOKEN,
},
body: JSON.stringify({ query, variables }),
});
const result = await res.json();
if (result.errors) throw new Error(`GraphQL errors: ${JSON.stringify(result.errors)}`);
return result;
}
2. SSE streaming pattern
File: routes/api.js — used in /api/price-monitor/all-products The pattern: set SSE
headers, stream event: product\ndata: {...}\n\n for each item, send event:
done\ndata: {}\n\n at end, handle req.on('close') for client disconnect.
res.setHeader('Content-Type', 'text/event-stream');
res.setHeader('Cache-Control', 'no-cache');
res.setHeader('Connection', 'keep-alive');
res.flushHeaders();
let closed = false;
req.on('close', () => { closed = true; });
// ... loop ...
res.write(`event: product\ndata: ${JSON.stringify(item)}\n\n`);
if (!closed) res.write(`event: done\ndata: {}\n\n`);
res.end();
3. Frontend SSE consumer pattern
File: public/price-monitor.js — function loadAllProducts() The pattern: open
EventSource , listen for product , done , and error events, buffer incoming rows into a
DocumentFragment for performance, flush every 50 items or 200ms.4. Sidebar + main grid layout
File: public/price-monitor.html and public/price-monitor.css The sidebar is a fixed-
width left panel with a scrollable checkbox list, a sticky “Select All” row, and a button below.
The main area is a full-width content panel. Reuse this layout verbatim.
5. Product creation (Add to Shopify)
File: routes/api.js — POST /api/products/create This endpoint accepts title metadata
and creates a Shopify product via GraphQL mutation. Reuse this endpoint directly or copy
its mutation logic. Key fields: title, vendor, variants (price, barcode/ISBN), images,
metafields.
6. PRH API call pattern
File: lib/prh-api.js Already authenticated with PRH_API_KEY . Base URL:
https://api.penguinrandomhouse.com/resources/v2/ Existing usage: single ISBN lookup.
For catalog discovery, extend to paginated title browsing.
PRH API ENDPOINTS TO USE
Base: https://api.penguinrandomhouse.com/resources/v2/ Auth: ?
api_key=2n6trvt9a24jbqjadtb2hzh5 appended to all requests
Endpoint Purpose
GET /domains/PRH.US/categories?catSetId=CN Fetch full consumer category
tree
GET /domains/PRH.US/titles?catUri=
{uri}&rows=25&start={n}
Browse titles by category
(paginated)
GET /domains/PRH.US/titles/{isbn} Individual title detail
Key filter params for title browse:
catUri — category URI e.g. /childrens-books , /education
format — HC, TR, MM, EL etc.
ageRange — e.g. 6-9 , Young Adult
comingSoon — true/falserows — results per page (max 25 recommended)
start — offset for pagination
Title response fields to capture:
isbn / isbn13
title
author (array)
price (list price)
formatCode / formatName
ageRange
imprint
onSaleDate
jacket (cover image URL)
description / flapCopy
seriesName
UI LAYOUT
Sidebar (left panel — same as price monitor)
Publisher dropdown at top (PRH selected by default; extensible for future publishers)
Category checkbox list — loaded from PRH /categories endpoint
Sticky “Select All” at top
Color coded by broad category type (optional)
Scrollable list
Load Catalog button below list
Filters below button:
Format checkboxes (Hardcover, Paperback, eBook, etc.)Age Range checkboxes
Coming Soon toggle
Price range (min/max inputs)
Search box (title / author text search)
Main Area (right panel)
Progress indicator while loading (“Loading catalog… 247 titles found”)
Stats bar: X titles shown, Y already in your store (excluded)
Bulk toolbar: “Add Selected to Shopify” button, select-all checkbox
Card grid (3-4 columns):
Each card:
Cover image (from PRH jacket URL)
Title
Author
Format + ISBN
List price
Imprint
Age range (if applicable)
Checkbox (top left corner)
“Add to Shopify” button (bottom of card)
Pagination: Prev / Next (same pattern as price monitor)
SERVER ENDPOINTS TO BUILD
GET /api/catalog/categories
Calls PRH /domains/PRH.US/categories?catSetId=CN&depth=2
Returns simplified flat list: [{ catId, description, catUri, parentId }]Cached in memory (categories don’t change often)
GET /api/catalog/titles (SSE)
Accepts: catUri , format , ageRange , comingSoon , keyword , priceMin , priceMax
Paginates through PRH API (rows=25, increment start)
For each title, checks ISBN against Shopify ISBN Set
Only streams titles NOT already in Shopify
Streams via SSE: event: title\ndata: {...}\n\n
Sends progress count: event: progress\ndata: {"found": N, "excluded": M}\n\n
Sends event: done when complete
GET /api/catalog/shopify-isbns
Fetches all variant barcodes from Shopify via GraphQL
Paginates through all products (250 per page)
Returns a flat array of ISBN strings
Cache this in memory per session — do NOT re-fetch on every title lookup
POST /api/catalog/add-to-shopify
Accepts: { isbn, title, authors, price, format, jacket, description, imprint,
ageRange }
Reuses existing product creation GraphQL mutation from qep-isbn-lookup
Sets vendor = “Penguin Random House”
Sets compareAtPrice = PRH list price
Sets barcode = ISBN
Attaches cover image
Returns: { success: true, productUrl: "..." } or error
EXTENSIBILITY — PUBLISHER MODULE PATTERNFrom day one, abstract the publisher data source so adding new publishers is easy:
// lib/publishers/prh.js
export async function fetchCategories() { ... }
export async function fetchTitles(filters, start) { ... }
export const name = 'Penguin Random House';
export const key = 'PRH';
// lib/publishers/index.js
import * as PRH from './prh.js';
export const publishers = { PRH };
// Future: import * as BLOOMSBURY from './bloomsbury.js';
The sidebar publisher dropdown maps to these modules. When a new publisher with an API
is added, create a new module file and add it to the index.
BUILD PHASES (across sessions)
SESSION 1 — Skeleton & Core Data
Goal: App runs, categories load in sidebar, PRH titles stream into a basic list.
Tasks:
1. Repo setup: npm init , Express, ES modules, .env , server.js
2. Copy shopifyGraphQL helper from qep-isbn-lookup
3. Build /api/catalog/shopify-isbns — fetch all Shopify ISBNs, return as array
4. Build PRH publisher module with fetchCategories() and fetchTitles()
5. Build /api/catalog/categories endpoint
6. Build /api/catalog/titles SSE endpoint (paginate PRH, cross-ref Shopify ISBNs,
stream results)
7. Basic HTML page: sidebar with category checkboxes, main area with raw title list (no
cards yet)
8. Wire up SSE consumer in frontend JS
9. Deploy to Render
Done when: You can select a category, click Load, and see a streaming list of PRH titles notin your store.
SESSION 2 — Card Grid & Filters
Goal: Results display as proper book cards with covers; filters work.
Tasks:
1. Replace raw list with card grid layout (CSS grid, 3-4 columns)
2. Each card: cover image, title, author, format, price, ISBN, age range
3. Sidebar filters: format checkboxes, age range checkboxes, coming soon toggle, price
range, text search
4. Filter logic: re-query PRH API with filter params OR filter client-side if all data is cached
5. Pagination: Prev/Next buttons
6. Stats bar: titles shown, excluded count
7. Progress indicator during load
Done when: Results look like a proper catalog browser with working filters.
SESSION 3 — Add to Shopify
Goal: One-click and bulk add to Shopify works with full field mapping.

Tasks:
1. “Add to Shopify” button on each card
2. Build /api/catalog/add-to-shopify endpoint (reuse qep-isbn-lookup product creation logic)
3. On success: mark card as “Added ✓”, disable button
4. Bulk checkbox selection on cards
5. “Add Selected to Shopify” bulk action button
6. After add: option to view product in Shopify admin

DISCOUNT FIELD:
- Each card must show an editable discount % field (same pattern as qep-isbn-lookup)
- Pull the default discount % from the same source as the ISBN lookup tool — do not hardcode
- User can modify the discount % per card before clicking Add to Shopify
- Calculate and display the net price based on retail price and discount %

price_source_url integration (2 changes required):
1. In the catalog discovery frontend, when calling /api/catalog/add-to-shopify, include priceSourceUrl in the request body — built from PRH seoFriendlyUrl field prepended with https://www.penguinrandomhouse.com
2. In routes/api.js in the existing qep-isbn-lookup product creation endpoint (around line 316 where metafields are built), add:
if (bookData.priceSourceUrl) {
  metafields.push({
    namespace: 'custom',
    key: 'price_source_url',
    value: bookData.priceSourceUrl,
    type: 'url'
  });
}
The if (bookData.priceSourceUrl) conditional ensures the normal ISBN lookup flow is unaffected. Do not remove this conditional.

AUTHOR METAOBJECT HANDLING:
- Before creating a product, check if the author already exists as a metaobject in Shopify by searching the existing authors metaobject list
- If the author does not exist, create a new author metaobject in Shopify with: name (from PRH author field), bio (from PRH content endpoint authorbio field, HTML stripped)
- If the author exists, use their existing GID
- The author GID is then passed as custom.authors metafield on the product
- Reuse the author lookup and creation logic from qep-isbn-lookup where possible
- PRH author field is a single string — if multiple authors, they may be comma-separated and need to be split

SHOPIFY FIELD MAPPING FROM PRH API:

Available from PRH list response (no extra API call):
- title → product title
- author → app-ibp-book.authors
- price → compareAtPrice
- isbn/isbnStr → variant barcode
- pages → app-ibp-book.pages
- onsale → app-ibp-book.publication_date and publication_year
- language → app-ibp-book.language and shopify.language-version GID
- format.description → app-ibp-book.binding and shopify.book-cover-type GID
- subjects → shopify.genre, custom.subjects (use existing mapping functions from qep-isbn-lookup)
- age/grade → custom.grade_levels, shopify.target-audience (use existing mapping functions)
- trim → app-ibp-book.dimensions (parse “5-1/16 x 7-3/4” format)
- imprint.description → vendor field
- seoFriendlyUrl → custom.price_source_url (prepend https://www.penguinrandomhouse.com)

Requires extra API call (/content endpoint — fetch on expand or at add time):
- flapcopy → product body_html/description

Reuse from qep-isbn-lookup:
- mapCategoriesToGenres() — genre GID mapping
- mapCategoriesToSubjects() — subject GID mapping
- mapToGradeLevels() — grade level GID mapping
- determineTargetAudience() — audience GID mapping
- filterValidGids() — GID validation
- getLanguageGid() — language GID mapping
- getCoverTypeGid() — cover type GID mapping
- Author metaobject lookup and creation logic

WEIGHT ESTIMATION:
- Copy lib/weight-calculator.js from qep-isbn-lookup to qep-catalog-discovery/lib/weight-calculator.js
- Use estimateWeight(pages, binding, publisher) to calculate weight for each book
- PRH books: pages from PRH pages field, binding from format.description (map "Trade Paperback" → "paperback", "Hardcover" → "hardcover"), publisher from imprint.description
- PRH is a trade publisher — the calculator will use lighter paper stock formulas
- Pass estimated weight in grams to Shopify variant weight field during product creation

app-ibp-book.condition is always “New”
custom.discount — user sets via editable discount field on each card before adding
cover image — from PRH _links rel=icon URL

Done when: Books can be added to Shopify individually and in bulk with all fields correctly populated.SESSION 4 — Polish & Integration Prep
Goal: Production-ready, ready to merge into qep-isbn-lookup.
Tasks:
1. Error handling (PRH API down, Shopify errors, etc.)
2. Loading states and empty states
3. “Already in store” indicator if user searches for a title manually
4. Publisher abstraction cleanup — confirm module pattern is solid for future publishers
5. Documentation of new endpoints
6. Merge plan into qep-isbn-lookup (new nav item, shared credentials)
Done when: Tool is stable enough to hand to staff for real use.
NOTES FOR CLAUDE CODE
Always read this spec file at the start of each session before writing any code
The SSE streaming pattern and Shopify GraphQL pattern are battle-tested — copy them
exactly from qep-isbn-lookup, do not reinvent
PRH API rate limits are not documented but be conservative — add 200ms delay
between paginated requests
PRH category catUri values to start with (based on QEP’s focus): /childrens-books ,
/education , /young-adult-nonfiction , /nonfiction
The Shopify ISBN cache MUST be built before streaming titles — do not check Shopify
per-title, that will hit rate limits
Cover images from PRH: base URL is
https://images.penguinrandomhouse.com/cover/{isbn} (jpg)
For Add to Shopify, match the field mapping used in qep-isbn-lookup’s existing product
creation endpoint exactly
The if (bookData.priceSourceUrl) conditional in the metafield push is intentional — it ensures the normal ISBN lookup flow is unaffected since it never sends a priceSourceUrl field. Do not remove this conditional.