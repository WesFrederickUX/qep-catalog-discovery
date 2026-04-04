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

    // Build parent→children map and render tree
    const childMap = {};
    for (const cat of _categories) {
      const pid = cat.parentId ?? '__root__';
      if (!childMap[pid]) childMap[pid] = [];
      childMap[pid].push(cat);
    }
    const treeRoot = document.createElement('div');
    treeRoot.className = 'cd-tree-root';
    for (const cat of (childMap['__root__'] ?? [])) {
      treeRoot.appendChild(buildTreeNode(cat, childMap));
    }
    list.appendChild(treeRoot);

    document.getElementById('load-btn').disabled = false;
  } catch (err) {
    list.innerHTML = `<div class="cd-list-msg">Failed to load categories: ${err.message}</div>`;
  }
}

// ── Category tree ─────────────────────────────────────────────────────────

function buildTreeNode(cat, childMap) {
  const children   = childMap[cat.catId] ?? [];
  const hasChildren = children.length > 0;

  const node = document.createElement('div');
  node.className = 'cd-tree-node';
  node.dataset.catId = String(cat.catId);

  const row = document.createElement('div');
  row.className = 'cd-tree-row';

  // Toggle arrow — level 0 starts expanded, deeper levels start collapsed
  const toggle = document.createElement('span');
  toggle.className = 'cd-tree-toggle';
  if (hasChildren) {
    toggle.textContent = '▶';
    node.classList.add('collapsed');
    toggle.addEventListener('click', e => {
      e.stopPropagation();
      const nowCollapsed = node.classList.toggle('collapsed');
      toggle.textContent = nowCollapsed ? '▶' : '▼';
    });
  }

  const id = 'cat-' + cat.catId;
  const cb = document.createElement('input');
  cb.type    = 'checkbox';
  cb.id      = id;
  cb.value   = cat.catUri;
  cb.addEventListener('change', () => {
    cascadeCheck(node, cb.checked);
    updateAncestors(node);
    syncSelectAll();
  });

  const label = document.createElement('label');
  label.htmlFor    = id;
  label.textContent = cat.description;

  row.appendChild(toggle);
  row.appendChild(cb);
  row.appendChild(label);
  node.appendChild(row);

  if (hasChildren) {
    const childContainer = document.createElement('div');
    childContainer.className = 'cd-tree-children';
    for (const child of children) {
      childContainer.appendChild(buildTreeNode(child, childMap));
    }
    node.appendChild(childContainer);
  }

  return node;
}

// Check/uncheck all checkboxes within a node (including the node itself)
function cascadeCheck(node, checked) {
  for (const cb of node.querySelectorAll('input[type="checkbox"]')) {
    cb.checked = checked;
  }
}

// Walk up the tree: a parent is checked iff all its direct-child checkboxes are checked
function updateAncestors(node) {
  let current = node.parentElement?.closest('.cd-tree-node');
  while (current) {
    const parentCb  = current.querySelector(':scope > .cd-tree-row input[type="checkbox"]');
    const childCbs  = [...current.querySelectorAll(':scope > .cd-tree-children input[type="checkbox"]')];
    if (parentCb && childCbs.length) {
      parentCb.checked = childCbs.every(c => c.checked);
    }
    current = current.parentElement?.closest('.cd-tree-node');
  }
}

function syncSelectAll() {
  const allCbs   = [...document.querySelectorAll('#category-list .cd-tree-node input[type="checkbox"]')];
  const selectAll = document.querySelector('#cat-select-all');
  if (selectAll) selectAll.checked = allCbs.length > 0 && allCbs.every(cb => cb.checked);
}

function onSelectAllCategories(e) {
  for (const cb of document.querySelectorAll('#category-list .cd-tree-node input[type="checkbox"]')) {
    cb.checked = e.target.checked;
  }
}

function getCheckedCatUris() {
  return [...document.querySelectorAll('#category-list .cd-tree-node input:checked')]
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

  let _total = null;

  es.addEventListener('total', e => {
    _total = JSON.parse(e.data).total;
    console.log('[catalog] total event received:', _total);
    document.getElementById('loading-text').textContent =
      `Loading catalog… 0 of ~${_total} titles found`;
  });

  es.addEventListener('title', e => {
    const title = JSON.parse(e.data);
    _allTitles.push(title);
    _buffer.push(title);
    if (_buffer.length >= 50) flushBuffer();
    const suffix = _total != null ? ` of ~${_total}` : '';
    document.getElementById('loading-text').textContent =
      `Loading catalog… ${_allTitles.length}${suffix} titles found`;
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

const _detailCache = new Map();

function buildTitleRow(t) {
  const wrap = document.createElement('div');
  wrap.className = 'title-row-wrap' + (t.inStore ? ' in-store' : '');
  wrap.dataset.search = `${t.title} ${(t.authors ?? []).join(' ')}`.toLowerCase();

  const price  = t.price != null ? `$${parseFloat(t.price).toFixed(2)}` : '—';
  const author = (t.authors ?? []).join(', ') || '—';
  const format = [t.formatName, t.imprint].filter(Boolean).join(' · ');

  // Metadata chips: grade, age, language, subjects
  const chips = [];
  if (t.grade)    chips.push(t.grade);
  if (t.ageRange) chips.push(t.ageRange);
  if (t.language && t.language !== 'E') chips.push(t.language);
  for (const s of (t.subjects ?? []).slice(0, 3)) chips.push(s);
  const chipsHtml = chips.map(c => `<span class="title-chip">${esc(c)}</span>`).join('');

  const row = document.createElement('div');
  row.className = 'title-row';
  row.innerHTML = `
    <div class="title-row-cover">
      <img src="${esc(t.coverUrl)}" alt="" loading="lazy"
           onerror="this.style.visibility='hidden'">
    </div>
    <div class="title-row-main">
      <div class="title-row-title">${esc(t.title)}</div>
      <div class="title-row-author">${esc(author)}</div>
      ${format ? `<div class="title-row-format">${esc(format)}</div>` : ''}
      ${chipsHtml ? `<div class="title-chips">${chipsHtml}</div>` : ''}
    </div>
    <div class="title-row-isbn">${esc(t.isbn ?? '—')}</div>
    <div class="title-row-price">
      ${t.inStore ? '<span class="in-store-badge">In Store</span>' : price}
    </div>
    <div class="title-row-expand-btn" title="Expand">▶</div>
  `;

  // Expandable detail panel (injected below the row)
  const detail = document.createElement('div');
  detail.className = 'title-row-detail hidden';

  row.addEventListener('click', () => toggleTitleDetail(t, row, detail));

  wrap.appendChild(row);
  wrap.appendChild(detail);
  return wrap;
}

async function toggleTitleDetail(t, row, detail) {
  const isOpen = !detail.classList.contains('hidden');
  const btn = row.querySelector('.title-row-expand-btn');

  console.log('[catalog] row clicked — isbn:', t.isbn, '| currently open:', isOpen);

  if (isOpen) {
    detail.classList.add('hidden');
    btn.textContent = '▶';
    return;
  }

  detail.classList.remove('hidden');
  btn.textContent = '▼';
  console.log('[catalog] detail panel visible, hidden class present:', detail.classList.contains('hidden'));

  // Already fetched — just show cached content
  if (_detailCache.has(t.isbn)) {
    console.log('[catalog] using cached detail for', t.isbn);
    renderDetailPanel(detail, _detailCache.get(t.isbn));
    console.log('[catalog] detail panel innerHTML length (cached):', detail.innerHTML.length);
    return;
  }

  detail.innerHTML = '<div class="title-detail-loading">Loading…</div>';

  try {
    const res = await fetch(`/api/catalog/title/${encodeURIComponent(t.isbn)}`);
    console.log('[catalog] detail fetch status:', res.status);
    if (!res.ok) throw new Error(await res.text());
    const full = await res.json();
    console.log('[catalog] title detail received:', full);
    _detailCache.set(t.isbn, full);
    renderDetailPanel(detail, full);
    console.log('[catalog] detail panel innerHTML length (rendered):', detail.innerHTML.length);
  } catch (err) {
    console.error('[catalog] detail fetch error:', err);
    detail.innerHTML = `<div class="title-detail-loading" style="color:red">Failed to load detail: ${esc(err.message)}</div>`;
  }
}

function renderDetailPanel(panel, t) {
  const price  = t.price != null ? `$${parseFloat(t.price).toFixed(2)}` : '—';
  const author = (t.authors ?? []).join(', ') || '—';

  const allChips = [];
  if (t.formatName) allChips.push(t.formatName);
  if (t.imprint)    allChips.push(t.imprint);
  if (t.grade)      allChips.push(t.grade);
  if (t.ageRange)   allChips.push(t.ageRange);
  if (t.language && t.language !== 'E') allChips.push(t.language);
  if (t.pages)      allChips.push(`${t.pages} pages`);
  if (t.onSaleDate) allChips.push(t.onSaleDate);
  for (const s of (t.subjects ?? [])) allChips.push(s);
  const chipsHtml = allChips.map(c => `<span class="title-chip">${esc(c)}</span>`).join('');

  // Primary description: flapcopy → keynote → excerpt → fallback description
  const primaryDesc = t.flapcopy || t.keynote || t.excerpt || t.description || '';

  const jacketHtml = t.jacketquotes
    ? `<blockquote class="title-detail-quote">${t.jacketquotes}</blockquote>`
    : '';

  const bioHtml = t.authorbio ? `
    <details class="title-detail-bio">
      <summary>About the Author</summary>
      <div>${t.authorbio}</div>
    </details>` : '';

  panel.innerHTML = `
    <div class="title-detail-inner">
      <div class="title-detail-cover">
        <img src="${esc(t.coverUrl)}" alt="">
      </div>
      <div class="title-detail-body">
        <div class="title-detail-heading">
          <span class="title-detail-name">${esc(t.title)}</span>
          <span class="title-detail-price">${price}</span>
        </div>
        <div class="title-detail-author">${esc(author)}</div>
        ${t.seriesName ? `<div class="title-detail-series">${esc(t.seriesName)}</div>` : ''}
        ${chipsHtml ? `<div class="title-chips title-chips-detail">${chipsHtml}</div>` : ''}
        ${primaryDesc ? `<div class="title-detail-desc">${primaryDesc}</div>` : ''}
        ${jacketHtml}
        ${bioHtml}
        <div class="title-detail-isbn">ISBN: ${esc(t.isbn ?? '—')}</div>
      </div>
    </div>
  `;
}

// ── Filter ────────────────────────────────────────────────────────────────

function filterResults() {
  const q    = document.getElementById('cd-search').value.toLowerCase().trim();
  const rows = document.querySelectorAll('#title-list .title-row-wrap');
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
