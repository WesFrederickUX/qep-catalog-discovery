'use strict';

// ── State ─────────────────────────────────────────────────────────────────

let _allTitles  = [];   // full cached result from SSE stream
let _categories = [];   // flat category list from API
let _currentEs  = null; // active EventSource

// ── Init ──────────────────────────────────────────────────────────────────

async function init() {
  await loadCategories();
}

async function loadCategories() {
  const publisher = document.getElementById('publisher-select').value;
  const list = document.getElementById('category-list');

  try {
    const res = await fetch(`/api/catalog/categories?publisher=${encodeURIComponent(publisher)}`);
    if (!res.ok) throw new Error(await res.text());
    _categories = await res.json();

    list.innerHTML = '';

    if (!_categories.length) {
      list.innerHTML = '<div class="cd-list-msg">No categories found.</div>';
      return;
    }

    // Select All row
    const selectAllItem = document.createElement('div');
    selectAllItem.className = 'cd-category-item cd-category-select-all';
    selectAllItem.innerHTML = `<input type="checkbox" id="cat-select-all"><label for="cat-select-all">Select All</label>`;
    list.appendChild(selectAllItem);
    selectAllItem.querySelector('input').addEventListener('change', onSelectAllCategories);

    // Top-level categories first, then children
    const parents  = _categories.filter(c => !c.parentId);
    const children = _categories.filter(c =>  c.parentId);

    for (const cat of parents) {
      appendCategoryItem(list, cat, false);
      for (const child of children.filter(c => c.parentId === cat.catId)) {
        appendCategoryItem(list, child, true);
      }
    }

    document.getElementById('load-btn').disabled = false;
  } catch (err) {
    list.innerHTML = `<div class="cd-list-msg">Failed to load categories: ${err.message}</div>`;
  }
}

function appendCategoryItem(list, cat, isChild) {
  const id   = 'cat-' + cat.catId;
  const item = document.createElement('div');
  item.className = 'cd-category-item' + (isChild ? ' child' : '');
  item.dataset.catUri = cat.catUri;
  item.innerHTML = `<input type="checkbox" id="${id}" value="${esc(cat.catUri)}"><label for="${id}">${esc(cat.description)}</label>`;
  list.appendChild(item);
  item.querySelector('input').addEventListener('change', onCategoryChange);
}

function onSelectAllCategories(e) {
  const checkboxes = [...document.querySelectorAll('#category-list .cd-category-item:not(.cd-category-select-all) input[type="checkbox"]')];
  checkboxes.forEach(cb => { cb.checked = e.target.checked; });
}

function onCategoryChange() {
  const allCbs     = [...document.querySelectorAll('#category-list .cd-category-item:not(.cd-category-select-all) input[type="checkbox"]')];
  const allChecked = allCbs.length > 0 && allCbs.every(cb => cb.checked);
  const selectAll  = document.querySelector('#cat-select-all');
  if (selectAll) selectAll.checked = allChecked;
}

function getCheckedCatUris() {
  return [...document.querySelectorAll('#category-list .cd-category-item:not(.cd-category-select-all) input:checked')]
    .map(cb => cb.value)
    .filter(Boolean);
}

// ── Load catalog ──────────────────────────────────────────────────────────

function loadCatalog() {
  const catUris = getCheckedCatUris();
  if (!catUris.length) { alert('Please select at least one category.'); return; }

  if (_currentEs) { _currentEs.close(); _currentEs = null; }

  _allTitles = [];
  document.getElementById('title-list').innerHTML = '';
  document.getElementById('no-results').classList.add('hidden');

  showSection('loading-state');
  document.getElementById('loading-text').textContent = 'Loading catalog… 0 titles found';
  document.getElementById('stats-bar').textContent = '';

  const publisher   = document.getElementById('publisher-select').value;
  const format      = getCheckedFormats();
  const ageRange    = document.getElementById('age-range').value.trim();
  const comingSoon  = document.getElementById('coming-soon-toggle').checked || '';
  const priceMin    = document.getElementById('price-min').value;
  const priceMax    = document.getElementById('price-max').value;

  // For Session 1: stream the first checked catUri (multi-cat in Session 2)
  const catUri = catUris[0];

  const params = new URLSearchParams({ publisher, catUri });
  if (format)     params.set('format', format);
  if (ageRange)   params.set('ageRange', ageRange);
  if (comingSoon) params.set('comingSoon', 'true');
  if (priceMin)   params.set('priceMin', priceMin);
  if (priceMax)   params.set('priceMax', priceMax);

  const es = new EventSource(`/api/catalog/titles?${params}`);
  _currentEs = es;

  // Buffer for batched DOM insertions
  const _buffer = [];
  const _list   = document.getElementById('title-list');
  let _found    = 0;
  let _excluded = 0;

  function flushBuffer() {
    if (!_buffer.length) return;
    const frag = document.createDocumentFragment();
    for (const title of _buffer) frag.appendChild(buildTitleRow(title));
    _list.appendChild(frag);
    _buffer.length = 0;
  }

  const _flushTimer = setInterval(flushBuffer, 200);

  es.addEventListener('title', e => {
    const title = JSON.parse(e.data);
    _allTitles.push(title);
    _buffer.push(title);
    if (_buffer.length >= 50) flushBuffer();
    document.getElementById('loading-text').textContent =
      `Loading catalog… ${_allTitles.length} titles found`;
  });

  es.addEventListener('progress', e => {
    const { found, excluded } = JSON.parse(e.data);
    _found    = found;
    _excluded = excluded;
  });

  es.addEventListener('done', e => {
    clearInterval(_flushTimer);
    flushBuffer();
    es.close();
    _currentEs = null;

    const data = JSON.parse(e.data);
    _found    = data.found    ?? _allTitles.length;
    _excluded = data.excluded ?? _excluded;

    showSection('results-area');
    updateStatsBar(_found, _excluded);
    document.getElementById('filters-panel').classList.remove('hidden');
    if (!_allTitles.length) document.getElementById('no-results').classList.remove('hidden');
  });

  es.addEventListener('error', e => {
    clearInterval(_flushTimer);
    flushBuffer();
    es.close();
    _currentEs = null;
    let msg = 'Failed to load catalog.';
    try { msg = JSON.parse(e.data)?.error ?? msg; } catch {}
    showSection('results-area');
    document.getElementById('title-list').innerHTML =
      `<div class="cd-list-msg" style="padding:1rem;color:red">${msg}</div>`;
  });
}

// ── Title row builder ─────────────────────────────────────────────────────

function buildTitleRow(t) {
  const row = document.createElement('div');
  row.className = 'title-row';
  row.dataset.search = `${t.title} ${(t.authors ?? []).join(' ')}`.toLowerCase();

  const price  = t.price != null ? `$${parseFloat(t.price).toFixed(2)}` : '—';
  const author = (t.authors ?? []).join(', ') || '—';
  const format = [t.formatName, t.imprint].filter(Boolean).join(' · ');

  row.innerHTML = `
    <div class="title-row-cover">
      <img src="${esc(t.coverUrl)}" alt="" loading="lazy"
           onerror="this.style.visibility='hidden'">
    </div>
    <div class="title-row-main">
      <div class="title-row-title" title="${esc(t.title)}">${esc(t.title)}</div>
      <div class="title-row-author">${esc(author)}</div>
      ${format ? `<div class="title-row-format">${esc(format)}</div>` : ''}
    </div>
    <div class="title-row-isbn">${esc(t.isbn ?? '—')}</div>
    <div class="title-row-price">${price}</div>
    <div class="title-row-format">${esc(t.ageRange ?? '')}</div>
  `;

  return row;
}

// ── Filter ────────────────────────────────────────────────────────────────

function filterResults() {
  const q    = document.getElementById('cd-search').value.toLowerCase().trim();
  const rows = document.querySelectorAll('#title-list .title-row');
  rows.forEach(r => {
    r.style.display = (!q || r.dataset.search.includes(q)) ? '' : 'none';
  });
}

function getCheckedFormats() {
  return [...document.querySelectorAll('#format-checkboxes input:checked')]
    .map(cb => cb.value).join(',');
}

// ── UI helpers ────────────────────────────────────────────────────────────

function showSection(id) {
  ['empty-state', 'loading-state', 'results-area'].forEach(s => {
    document.getElementById(s)?.classList.toggle('hidden', s !== id);
  });
}

function updateStatsBar(found, excluded) {
  const bar = document.getElementById('stats-bar');
  bar.innerHTML = `<strong>${found}</strong> titles not in your store &nbsp;·&nbsp; <strong>${excluded}</strong> already carried`;
}

function esc(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── Boot ──────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', init);
