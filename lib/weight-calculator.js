/**
 * Book weight estimation based on page count and binding type
 *
 * Formulas calibrated from actual QEP book measurements
 */

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load publisher lists
let publisherData = {};
try {
  const dataPath = join(__dirname, '../data/metaobject-gids.json');
  publisherData = JSON.parse(readFileSync(dataPath, 'utf-8'));
} catch (e) {
  console.warn('Could not load metaobject-gids.json:', e.message);
}

/**
 * Check if a publisher is a trade publisher (lighter paper stock)
 */
export function isTradePublisher(publisher) {
  if (!publisher) return false;
  const p = publisher.toLowerCase();
  const tradePublishers = publisherData.publishers?.trade || [];
  return tradePublishers.some(tp => p.includes(tp.toLowerCase()));
}

/**
 * Check if a publisher is an educational publisher (heavier paper stock)
 */
export function isEducationalPublisher(publisher) {
  if (!publisher) return false;
  const p = publisher.toLowerCase();
  const eduPublishers = publisherData.publishers?.educational || [];
  return eduPublishers.some(ep => p.includes(ep.toLowerCase()));
}

/**
 * Check if a publisher is a children's book publisher
 */
export function isChildrensPublisher(publisher) {
  if (!publisher) return false;
  const p = publisher.toLowerCase();
  const childPublishers = publisherData.publishers?.children || [];
  return childPublishers.some(cp => p.includes(cp.toLowerCase()));
}

/**
 * Estimate book weight in grams from page count and binding type
 *
 * Formulas:
 * - Educational paperback: 2.72g per page (heavier stock)
 * - Trade paperback: 1.28g per page (lighter stock)
 * - Educational hardcover: 1.09g per page + 136g (cover weight)
 * - Trade hardcover picture book (< 64 pages): 295-400g based on pages
 *
 * @param {number} pageCount - Number of pages
 * @param {string} binding - 'paperback' or 'hardcover'
 * @param {string} publisher - Publisher name for paper stock detection
 * @returns {number} Estimated weight in grams
 */
export function estimateWeight(pageCount, binding = 'paperback', publisher = '') {
  if (!pageCount || pageCount <= 0) {
    return null;
  }

  const isTrade = isTradePublisher(publisher);
  const isHardcover = binding?.toLowerCase() === 'hardcover';

  if (isTrade) {
    // Trade publishers use lighter paper
    if (isHardcover && pageCount <= 64) {
      // Picture book hardcover - use standard ranges
      if (pageCount <= 32) return 295;
      if (pageCount <= 48) return 340;
      return 400;
    }
    // Trade paperback: 1.28g per page
    return Math.round(pageCount * 1.28);
  }

  // Educational publishers use heavier paper
  if (isHardcover) {
    // Hardcover: 1.09g per page + 136g cover
    return Math.round(pageCount * 1.09 + 136);
  }

  // Educational paperback: 2.72g per page
  return Math.round(pageCount * 2.72);
}

/**
 * Estimate weight from a book object
 */
export function estimateWeightFromBook(book) {
  return estimateWeight(book.pageCount, book.binding, book.publisher);
}

/**
 * Convert grams to ounces
 */
export function gramsToOunces(grams) {
  return Math.round(grams / 28.3495 * 10) / 10;
}

/**
 * Convert grams to pounds
 */
export function gramsToPounds(grams) {
  return Math.round(grams / 453.592 * 100) / 100;
}
