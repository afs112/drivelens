import { t } from '../i18n.js';
import { loadPhotoIntoElement } from '../storage/imageLoader.js';
import { escapeAttr, escapeHtml, icon } from './icons.js';

function getItemAspectRatio(file) {
  const w = Number(file.imageMediaMetadata?.width || file.videoMediaMetadata?.width || 0);
  const h = Number(file.imageMediaMetadata?.height || file.videoMediaMetadata?.height || 0);
  if (w > 0 && h > 0) {
    return Math.max(0.45, Math.min(2.6, w / h));
  }
  return 1.5;
}

export function computeJustifiedRows(items, containerWidth, targetHeight = 210, gap = 8) {
  if (!items || items.length === 0) return [];
  const safeWidth = Math.max(260, containerWidth);
  const rows = [];
  let current = [];
  let sumRatios = 0;

  for (const item of items) {
    const ratio = getItemAspectRatio(item);
    current.push({ item, ratio });
    sumRatios += ratio;

    const naturalRowWidth = sumRatios * targetHeight + gap * (current.length - 1);
    if (naturalRowWidth >= safeWidth) {
      const exactHeight = (safeWidth - gap * (current.length - 1)) / sumRatios;
      rows.push({
        height: Math.round(exactHeight),
        items: current.map((c) => ({
          item: c.item,
          width: Math.max(60, Math.floor(c.ratio * exactHeight)),
        })),
      });
      current = [];
      sumRatios = 0;
    }
  }

  if (current.length > 0) {
    const naturalHeight = (safeWidth - gap * (current.length - 1)) / sumRatios;
    const rowHeight = Math.round(Math.min(naturalHeight, targetHeight * 1.15));
    rows.push({
      height: rowHeight,
      items: current.map((c) => ({
        item: c.item,
        width: Math.max(60, Math.round(c.ratio * rowHeight)),
      })),
    });
  }

  return rows;
}

function formatDuration(ms) {
  if (!ms) return '';
  const totalSec = Math.round(Number(ms) / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = String(totalSec % 60).padStart(2, '0');
  return `${min}:${sec}`;
}

function buildOverlayHtml(file, store) {
  const meta = store.getAggregatedItemMeta(file.id);
  const schemaTags = store.state.tagSchema?.tags || {};

  let starHtml = '';
  if (meta.avgRating > 0) {
    const avgText = Number.isInteger(meta.avgRating)
      ? `${meta.avgRating}.0`
      : meta.avgRating.toFixed(1);
    const myPart = meta.myRating > 0
      ? `<span style="opacity:0.75;font-weight:400">${escapeHtml(t('gallery.meBadge', { n: meta.myRating }))}</span>`
      : '';
    starHtml = `<span class="photo-star-badge">${icon('starFilled', 12)}<span>${avgText}</span>${myPart}</span>`;
  } else {
    starHtml = `<span style="opacity:0.45;font-size:10.5px">${escapeHtml(file.name.slice(0, 14))}</span>`;
  }

  const heartHtml =
    meta.favoriteCount > 0
      ? `<span class="photo-heart-badge">${icon('heartFilled', 12)}${meta.favoriteCount > 1 ? `<span>${meta.favoriteCount}</span>` : ''}</span>`
      : '';

  const dotsHtml = meta.activeTagIds
    .slice(0, 5)
    .map((tid) => {
      const tag = schemaTags[tid];
      if (!tag) return '';
      return `<span class="photo-tag-dot" style="background:var(--tag-${escapeAttr(tag.color || 'blue')})" title="${escapeAttr(tag.name)}"></span>`;
    })
    .join('');

  return `
    <div class="photo-overlay-left">${starHtml}${heartHtml}</div>
    <div class="photo-overlay-right"><span class="photo-tag-dots">${dotsHtml}</span></div>
  `;
}

function createPhotoCardElement(file, store, styleAttr = '') {
  const isSelected = store.state.selectedPhotoIds.has(file.id);
  const isFocused = store.state.focusedPhotoId === file.id;
  const isVideo = file.mimeType && file.mimeType.startsWith('video/');
  const dur = isVideo ? formatDuration(file.videoMediaMetadata?.durationMillis) : '';

  const card = document.createElement('div');
  card.className = `photo-card ${isSelected ? 'is-selected' : ''} ${isFocused ? 'is-focused' : ''}`;
  card.dataset.photoId = file.id;
  if (styleAttr) card.setAttribute('style', styleAttr);

  card.innerHTML = `
    <div class="photo-skeleton"></div>
    <button type="button" class="photo-select-btn" data-action="toggle-select" title="${escapeAttr(t('gallery.toggleSelect'))}">
      ${icon('check', 13)}
    </button>
    ${isVideo ? `<span class="photo-video-badge">${icon('video', 11)}<span>${dur || escapeHtml(t('gallery.video'))}</span></span>` : ''}
    <img alt="${escapeAttr(file.name)}" decoding="async" />
    <div class="photo-overlay">${buildOverlayHtml(file, store)}</div>
  `;

  const imgEl = card.querySelector('img');
  loadPhotoIntoElement(imgEl, file, {
    size: 600,
    getAccessToken: () => store.state.accessToken,
    getApiKey: () => store.state.apiKey,
  });

  return card;
}

export function renderGallerySubbar(subbarEl, store, visiblePhotos) {
  if (!subbarEl) return;
  const state = store.state;
  const activeFolder = state.folders.find((f) => f.id === state.activeFolderId);
  const schemaTags = state.tagSchema?.tags || {};

  const chips = [];
  if (state.quickView === 'favorites') {
    chips.push({ label: t('gallery.chipFavorites'), clear: 'quickView' });
  } else if (state.quickView === 'unrated') {
    chips.push({ label: t('gallery.chipUnrated'), clear: 'quickView' });
  }
  if (state.ratingScope === 'member' && state.memberFilterId) {
    const member = store.getMembersSummary().find((m) => m.id === state.memberFilterId);
    chips.push({
      label: t('gallery.chipMember', { name: member?.name || state.memberFilterId }),
      clear: 'member',
    });
  }
  if (state.minRating > 0) {
    const prefix =
      state.ratingScope === 'mine'
        ? t('gallery.prefixMine')
        : state.ratingScope === 'member'
          ? t('gallery.prefixMember')
          : t('gallery.prefixAvg');
    chips.push({ label: `${prefix} ≥ ${state.minRating}★`, clear: 'minRating' });
  }
  for (const tid of state.selectedTagIds) {
    const tag = schemaTags[tid];
    if (tag) chips.push({ label: t('gallery.chipTag', { name: tag.name }), clear: `tag:${tid}` });
  }
  if (state.searchQuery.trim()) {
    chips.push({ label: t('gallery.chipSearch', { q: state.searchQuery.trim() }), clear: 'search' });
  }

  subbarEl.innerHTML = `
    <div class="gallery-subbar-left">
      <span class="breadcrumb-text">${escapeHtml(activeFolder?.name || t('gallery.allPhotos'))}</span>
      <span class="photo-count-badge">${escapeHtml(t('gallery.itemCount', { count: visiblePhotos.length }))}</span>
      ${
        chips.length > 0
          ? `<div class="active-filters-bar">
              ${chips
                .map(
                  (c) =>
                    `<button type="button" class="filter-chip" data-clear-filter="${escapeAttr(c.clear)}">${escapeHtml(c.label)} ${icon('x', 11)}</button>`
                )
                .join('')}
              <button type="button" class="btn btn-ghost btn-sm" data-clear-filter="all">${escapeHtml(t('gallery.clearFilters'))}</button>
            </div>`
          : ''
      }
    </div>
    <div class="gallery-subbar-right">
      <select class="select-sm" id="sortBySelect" title="${escapeAttr(t('gallery.sortTitle'))}">
        <option value="dateDesc" ${state.sortBy === 'dateDesc' ? 'selected' : ''}>${escapeHtml(t('gallery.sortDateDesc'))}</option>
        <option value="dateAsc" ${state.sortBy === 'dateAsc' ? 'selected' : ''}>${escapeHtml(t('gallery.sortDateAsc'))}</option>
        <option value="ratingDesc" ${state.sortBy === 'ratingDesc' ? 'selected' : ''}>${escapeHtml(t('gallery.sortRatingDesc'))}</option>
        <option value="nameAsc" ${state.sortBy === 'nameAsc' ? 'selected' : ''}>${escapeHtml(t('gallery.sortNameAsc'))}</option>
        <option value="sizeDesc" ${state.sortBy === 'sizeDesc' ? 'selected' : ''}>${escapeHtml(t('gallery.sortSizeDesc'))}</option>
      </select>
    </div>
  `;
}

export function renderBatchBar(batchBarEl, store, visiblePhotos) {
  if (!batchBarEl) return;
  const count = store.state.selectedPhotoIds.size;
  if (count === 0) {
    batchBarEl.classList.add('hidden');
    batchBarEl.innerHTML = '';
    return;
  }

  batchBarEl.classList.remove('hidden');
  batchBarEl.innerHTML = `
    <div class="batch-bar-left">
      <strong style="color:var(--accent)">${escapeHtml(t('gallery.batchSelected', { count }))}</strong>
      <button type="button" class="btn btn-sm" data-batch="select-all">${escapeHtml(t('gallery.batchSelectAll', { count: visiblePhotos.length }))}</button>
      <button type="button" class="btn btn-sm btn-ghost" data-batch="clear">${escapeHtml(t('gallery.batchClearSelect'))}</button>
    </div>
    <div class="batch-bar-right">
      <span style="font-size:11.5px;color:var(--text-secondary)">${escapeHtml(t('gallery.batchRateLabel'))}</span>
      ${[1, 2, 3, 4, 5]
        .map(
          (r) =>
            `<button type="button" class="btn btn-sm" data-batch="rate" data-rating="${r}">${r}★</button>`
        )
        .join('')}
      <button type="button" class="btn btn-sm btn-ghost" data-batch="rate" data-rating="0">${escapeHtml(t('gallery.batchResetRate'))}</button>
      <button type="button" class="btn btn-sm" data-batch="fav">${icon('heart', 12)} ${escapeHtml(t('gallery.batchFav'))}</button>
      <button type="button" class="btn btn-sm btn-primary" data-batch="quick-tag">${icon('tag', 12)} ${escapeHtml(t('gallery.batchTag'))}</button>
    </div>
  `;
}

let lastGridSignature = '';

export function renderGalleryGrid(gridEl, scrollContainer, store, visiblePhotos) {
  if (!gridEl || !scrollContainer) return;

  if (store.state.loading) {
    lastGridSignature = '__loading__';
    gridEl.innerHTML = `
      <div class="empty-state">
        <div class="spin" style="color:var(--accent)">${icon('refresh', 28)}</div>
        <div style="font-size:14px;color:var(--text-primary)">${escapeHtml(store.state.loadingText || t('gallery.loadingAlbum'))}</div>
      </div>
    `;
    return;
  }

  if (visiblePhotos.length === 0) {
    lastGridSignature = '__empty__';
    gridEl.innerHTML = `
      <div class="empty-state">
        ${icon('image', 36)}
        <div style="font-size:14px;color:var(--text-primary)">${escapeHtml(t('gallery.emptyTitle'))}</div>
        <div style="font-size:12px">${escapeHtml(t('gallery.emptyHint'))}</div>
        <button type="button" class="btn btn-primary" data-clear-empty="true">${escapeHtml(t('gallery.resetAllFilters'))}</button>
      </div>
    `;
    return;
  }

  const { layoutMode, rowHeight, lang } = store.state;
  const containerWidth = Math.max(300, scrollContainer.clientWidth - 36);
  const sig = `${lang}|${layoutMode}|${rowHeight}|${Math.round(containerWidth)}|${visiblePhotos.map((p) => p.id).join(',')}`;

  // Fast path: patch selection, focus & overlays in-place without flashing thumbnails
  if (sig === lastGridSignature) {
    const byId = new Map(visiblePhotos.map((p) => [p.id, p]));
    const cards = gridEl.querySelectorAll('.photo-card[data-photo-id]');
    for (const card of cards) {
      const pid = card.dataset.photoId;
      const file = byId.get(pid);
      if (!file) continue;
      card.classList.toggle('is-selected', store.state.selectedPhotoIds.has(pid));
      card.classList.toggle('is-focused', store.state.focusedPhotoId === pid);
      const overlay = card.querySelector('.photo-overlay');
      if (overlay) {
        overlay.innerHTML = buildOverlayHtml(file, store);
      }
    }
    return;
  }

  lastGridSignature = sig;
  gridEl.innerHTML = '';

  if (layoutMode === 'grid') {
    const grid = document.createElement('div');
    grid.className = 'square-gallery';
    const minCard = Math.max(130, rowHeight - 20);
    grid.style.gridTemplateColumns = `repeat(auto-fill, minmax(${minCard}px, 1fr))`;

    const frag = document.createDocumentFragment();
    for (const file of visiblePhotos) {
      frag.appendChild(createPhotoCardElement(file, store));
    }
    grid.appendChild(frag);
    gridEl.appendChild(grid);
    return;
  }

  // Justified row layout
  const rows = computeJustifiedRows(visiblePhotos, containerWidth, rowHeight, 8);
  const wrapper = document.createElement('div');
  wrapper.className = 'justified-gallery';
  const frag = document.createDocumentFragment();

  for (const row of rows) {
    const rowEl = document.createElement('div');
    rowEl.className = 'justified-row';
    rowEl.style.height = `${row.height}px`;
    for (const cell of row.items) {
      rowEl.appendChild(
        createPhotoCardElement(
          cell.item,
          store,
          `width:${cell.width}px;height:${row.height}px;`
        )
      );
    }
    frag.appendChild(rowEl);
  }

  wrapper.appendChild(frag);
  gridEl.appendChild(wrapper);
}

export function resetGallerySignature() {
  lastGridSignature = '';
}

export function bindGalleryEvents(subbarEl, batchBarEl, gridEl, store) {
  if (subbarEl) {
    subbarEl.addEventListener('change', (e) => {
      if (e.target.id === 'sortBySelect') {
        store.setState({ sortBy: e.target.value });
      }
    });

    subbarEl.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-clear-filter]');
      if (!btn) return;
      const key = btn.dataset.clearFilter;
      if (key === 'all') {
        store.clearAllFilters();
      } else if (key === 'quickView') {
        store.setState({ quickView: 'all' });
      } else if (key === 'member') {
        store.setState({ ratingScope: 'avg', memberFilterId: null });
      } else if (key === 'minRating') {
        store.setState({ minRating: 0 });
      } else if (key === 'search') {
        store.setState({ searchQuery: '' });
      } else if (key.startsWith('tag:')) {
        store.toggleTagFilter(key.slice(4));
      }
    });
  }

  if (batchBarEl) {
    batchBarEl.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-batch]');
      if (!btn) return;
      const act = btn.dataset.batch;
      const ids = Array.from(store.state.selectedPhotoIds);

      if (act === 'select-all') {
        store.selectAllVisible();
      } else if (act === 'clear') {
        store.clearSelection();
      } else if (act === 'rate') {
        store.setRating(ids, Number(btn.dataset.rating || 0));
      } else if (act === 'fav') {
        store.toggleFavorite(ids, true);
      } else if (act === 'quick-tag') {
        store.openModal('quickTag', { photoIds: ids });
      }
    });
  }

  if (gridEl) {
    gridEl.addEventListener('click', (e) => {
      if (e.target.closest('[data-clear-empty]')) {
        store.clearAllFilters();
        return;
      }
      const selectBtn = e.target.closest('[data-action="toggle-select"]');
      const card = e.target.closest('.photo-card[data-photo-id]');
      if (!card) return;
      const photoId = card.dataset.photoId;

      if (selectBtn) {
        e.stopPropagation();
        store.toggleSelectCheckbox(photoId);
        return;
      }

      store.selectPhoto(photoId, {
        ctrl: e.ctrlKey || e.metaKey,
        shift: e.shiftKey,
      });
    });

    gridEl.addEventListener('dblclick', (e) => {
      const card = e.target.closest('.photo-card[data-photo-id]');
      if (!card) return;
      if (e.target.closest('[data-action="toggle-select"]')) return;
      store.openLightbox(card.dataset.photoId);
    });
  }
}
