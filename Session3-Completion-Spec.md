# Session 3 Completion Spec
**Date: April 5, 2026**
**Status: Add to Shopify is working but missing several fields**

## Context
The /api/catalog/add-to-shopify endpoint is functional — books are being created in Shopify successfully. However the following fields are missing or broken and need to be fixed.

---

## Outstanding Issues

### 1. Weight not being sent
The weight-calculator.js was copied and the endpoint imports it, but the estimated weight in grams is not making it into the Shopify productSet mutation variant weight field. Check that estimateWeightFromBook() is being called and the result is passed to the variant's `weightUnit` and `weight` fields in the mutation.

### 2. Subjects metafield missing
The `custom.subjects` metafield is not being populated. The subjects array comes from the PRH title's `subjects` field (array of `{ code, description }` objects). These need to be mapped to Shopify subject GIDs using `mapCategoriesToSubjects()` from qep-isbn-lookup. Check ~/qep-isbn-lookup/routes/api.js for how subjects are mapped and the GIDs filtered via `filterValidGids()`.

### 3. Page count not being sent
`app-ibp-book.pages` metafield is missing. The PRH `pages` field is available on the title object. This should be a `number_integer` metafield. Confirm it is in the metafields array before the productSet mutation is called.

### 4. Publishing channels not set
New products are not being published to the correct sales channels. The productSet mutation needs to include publications for:
- Online Store
- Shop
- Point of Sale
- Google & YouTube

Check ~/qep-isbn-lookup/routes/api.js for how it handles publications/sales channel IDs in the productSet mutation and replicate exactly.

### 5. Collections not assigned
Books are not being added to the correct Shopify collections. Check ~/qep-isbn-lookup/routes/api.js for how it determines and assigns collections after product creation, and replicate that logic in the catalog add-to-shopify endpoint.

### 6. Tags not being set
Product tags are not being populated. Check ~/qep-isbn-lookup/routes/api.js for what tags are generated and how — likely based on categories, format, and publisher — and replicate in the catalog endpoint.

### 7. Metafield owner subtype error (FIXED THIS SESSION)
metafields 2-5 were failing with "Owner subtype does not match" — this was fixed by correctly splitting metafields between product-level and variant-level in the productSet mutation. Confirm fix is still working after adding the missing fields above.

---

## How to Fix

For each issue above, the pattern is:
1. Check ~/qep-isbn-lookup/routes/api.js for the exact implementation
2. Replicate in ~/qep-catalog-discovery/routes/catalog.js in the add-to-shopify endpoint
3. Test by adding a book and checking Shopify admin for the field

Do NOT reinvent — copy the exact logic from qep-isbn-lookup.

---

## Test Checklist
After fixes, add a test book and verify in Shopify admin:
- [ ] Weight is populated on the variant
- [ ] custom.subjects metafield has values
- [ ] app-ibp-book.pages has page count
- [ ] Product is published to Online Store, Shop, POS, Google & YouTube
- [ ] Product is assigned to correct collections
- [ ] Product tags are populated
- [ ] price_source_url is set (PRH URL)
- [ ] Author metaobject is linked
- [ ] compareAtPrice = PRH list price
- [ ] Variant price = discounted net price
- [ ] Cover image attached
- [ ] body_html = flapcopy description
