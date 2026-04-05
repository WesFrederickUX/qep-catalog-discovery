// Shopify GraphQL Admin API client — adapted from qep-isbn-lookup/lib/shopify.js

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

// ── Author metaobject helpers ─────────────────────────────────────────────

export async function getAllAuthors() {
  const authors = [];
  let cursor = null;

  const query = `
    query GetAuthors($cursor: String) {
      metaobjects(type: "author", first: 100, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          handle
          fields { key value }
        }
      }
    }
  `;

  do {
    const result = await shopifyGraphQL(query, { cursor });
    const data = result.data?.metaobjects;
    if (data?.nodes) authors.push(...data.nodes);
    cursor = data?.pageInfo?.hasNextPage ? data.pageInfo.endCursor : null;
  } while (cursor);

  return authors;
}

export async function createAuthor(name, bio = null) {
  const handle = name
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .substring(0, 100);

  const mutation = `
    mutation CreateAuthor($metaobject: MetaobjectCreateInput!) {
      metaobjectCreate(metaobject: $metaobject) {
        metaobject { id handle }
        userErrors { field message }
      }
    }
  `;

  const fields = [{ key: 'author', value: name }];
  if (bio) fields.push({ key: 'bio', value: bio });

  const result = await shopifyGraphQL(mutation, {
    metaobject: {
      type: 'author',
      handle,
      fields,
      capabilities: { publishable: { status: 'ACTIVE' } },
    },
  });

  if (result.data?.metaobjectCreate?.userErrors?.length > 0) {
    throw new Error(result.data.metaobjectCreate.userErrors.map(e => e.message).join(', '));
  }

  return result.data?.metaobjectCreate?.metaobject ?? null;
}
