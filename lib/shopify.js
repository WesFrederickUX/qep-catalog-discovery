// Shopify GraphQL Admin API client — copied from qep-isbn-lookup/lib/shopify.js

const SHOPIFY_API_VERSION = '2025-01';

export async function shopifyGraphQL(query, variables = {}) {
  const token = process.env.SHOPIFY_ACCESS_TOKEN;
  const store = process.env.SHOPIFY_STORE;

  if (!token) throw new Error('SHOPIFY_ACCESS_TOKEN is required');
  if (!store)  throw new Error('SHOPIFY_STORE is required');

  const response = await fetch(
    `https://${store}.myshopify.com/admin/api/${SHOPIFY_API_VERSION}/graphql.json`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': token,
      },
      body: JSON.stringify({ query, variables }),
    }
  );

  if (!response.ok) {
    throw new Error(`Shopify API error: ${response.status} ${response.statusText}`);
  }

  const result = await response.json();

  if (result.errors) {
    throw new Error(`GraphQL errors: ${JSON.stringify(result.errors)}`);
  }

  return result;
}
