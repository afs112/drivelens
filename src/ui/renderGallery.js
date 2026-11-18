import { getLocaleTag, t } from '../i18n.js';
import { loadPhotoIntoElement } from '../storage/imageLoader.js';
import { escapeAttr, escapeHtml, icon } from './icons.js';

const GALLERY_THUMB_SIZE = 480;
const PAGE_CHUNK = 80;

const cardTimestampCache = new WeakMap();
const visiblePhotosIdSigCache = new WeakMap();
const monthFormatterCache = new Map();

function getPhotoTimestampValue(file) {
  if (!file || typeof file !== 'object') return 0;
  const raw = file.imageMediaMetadata?.time || file.createdTime || file.modifiedTime || '';
  if (!raw) return 0;
  const cached = cardTimestampCache.get(file);
  if (cached && cached.raw === raw) return cached.ts;
  const normalized = /^\d{4}:\d{2}:\d{2}\s/.test(raw)
    ? raw.replace(/^(\d{4}):(\d{2}):(\d{2})\s/, '$1-$2-$3T')
    : raw;
  const parsed = Date.parse(normalized);
  const ts = Number.isNaN(parsed) ? 0 : parsed;
  cardTimestampCache.set(file, { raw, ts });
  return ts;
}

function getPhotosIdSig(visiblePhotos) {
  if (!visiblePhotos || visiblePhotos.length === 0) return '0';
  let sig = visiblePhotosIdSigCache.get(visiblePhotos);
  if (sig === undefined) {
    sig = visiblePhotos.map((p) => p.id).join(',');
    visiblePhotosIdSigCache.set(visiblePhotos, sig);
  }
  return sig;
}

function formatMonthPillLabel(ts) {
  const locale = getLocaleTag();
  let fmt = monthFormatterCache.get(locale);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat(locale, { year: 'numeric', month: 'short' });
    monthFormatterCache.set(locale, fmt);
  }
  return fmt.format(new Date(ts));
}

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

export function computeWaterfallColumns(
  items,
  containerWidth,
  targetSize = 210,
  gap = 3,
  isMobile = false
) {
  if (!items || items.length === 0) return [];
  const safeWidth = Math.max(220, containerWidth);
  const clampedSize = Math.max(130, Math.min(320, Number(targetSize) || 210));
  let colCount;
  if (isMobile) {
    if (safeWidth < 260 || clampedSize >= 275) colCount = 1;
    else if (clampedSize >= 190) colCount = 2;
    else if (clampedSize >= 152) colCount = 3;
    else colCount = 4;
  } else {
    const tNorm = (clampedSize - 130) / 190;
    const desiredColWidth = Math.round(135 + tNorm * 340);
    colCount = Math.max(
      2,
      Math.min(9, Math.round((safeWidth + gap) / (desiredColWidth + gap)))
    );
  }
  const colWidth = Math.max(80, Math.floor((safeWidth - gap * (colCount - 1)) / colCount));
  const columns = Array.from({ length: colCount }, () => []);
  const colHeights = new Array(colCount).fill(0);

  for (const item of items) {
    let minIdx = 0;
    for (let i = 1; i < colCount; i += 1) {
      if (colHeights[i] < colHeights[minIdx]) {
        minIdx = i;
      }
    }
    const ratio = getItemAspectRatio(item);
    const height = Math.max(88, Math.round(colWidth / ratio));
    columns[minIdx].push({ item, width: colWidth, height });
    colHeights[minIdx] += height + gap;
  }

  return columns;
}

function formatDuration(ms) {
  if (!ms) return '';
  const totalSec = Math.round(Number(ms) / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = String(totalSec % 60).padStart(2, '0');
  return `${min}:${sec}`;
}

function buildOverlayData(file, store) {
  const meta = store.getAggregatedItemMeta(file.id);
  const schemaTags = store.state.tagSchema?.tags || {};
  const hasPersistent =
    meta.avgRating > 0 || meta.favoriteCount > 0 || meta.activeTagIds.length > 0;

  if (hasPersistent) {
    let starHtml = '';
    if (meta.avgRating > 0) {
      const avgText = Number.isInteger(meta.avgRating)
        ? `${meta.avgRating}.0`
        : meta.avgRating.toFixed(1);
      starHtml = `<span class="photo-star-badge">${icon('starFilled', 11)}<span>${avgText}</span></span>`;
    }

    const heartHtml =
      meta.favoriteCount > 0
        ? `<span class="photo-heart-badge">${icon('heartFilled', 11)}${meta.favoriteCount > 1 ? `<span>${meta.favoriteCount}</span>` : ''}</span>`
        : '';

    const tagParts = [];
    const dotsHtml = meta.activeTagIds
      .slice(0, 5)
      .map((tid) => {
        const tag = schemaTags[tid];
        if (!tag) return '';
        tagParts.push(`${tid}:${tag.color || 'blue'}:${tag.name}`);
        return `<span class="photo-tag-dot" style="background:var(--tag-${escapeAttr(tag.color || 'blue')})" title="${escapeAttr(tag.name)}"></span>`;
      })
      .join('');

    const html = `
    <div class="photo-overlay-left">${starHtml}${heartHtml}</div>
    <div class="photo-overlay-right"><span class="photo-tag-dots">${dotsHtml}</span></div>
  `;
    return {
      mode: 'persistent',
      sig: `p|${meta.avgRating}|${meta.favoriteCount}|${tagParts.join(',')}`,
      html,
    };
  }

  // Hover-only subtle EXIF line for unrated/untagged cards (never show filenames by default)
  const exif = file.imageMediaMetadata || {};
  const parts = [];
  if (exif.cameraModel) parts.push(String(exif.cameraModel).trim());
  if (exif.focalLength) parts.push(`${exif.focalLength}mm`);
  if (exif.aperture) parts.push(`f/${exif.aperture}`);
  if (exif.isoSpeed) parts.push(`ISO ${exif.isoSpeed}`);
  const exifText = parts.filter(Boolean).join(' · ');

  if (exifText) {
    return {
      mode: 'hover',
      sig: `h|${exifText}`,
      html: `<span class="photo-overlay-exif">${escapeHtml(exifText)}</span>`,
    };
  }

  return {
    mode: 'empty',
    sig: 'empty',
    html: '',
  };
}

function patchCardMeta(card, file, store, selectTitle) {
  const isSelected = store.state.selectedPhotoIds.has(file.id);
  const isFocused = store.state.focusedPhotoId === file.id;

  if (card._selected !== isSelected) {
    card.classList.toggle('is-selected', isSelected);
    card._selected = isSelected;
  }
  if (card._focused !== isFocused) {
    card.classList.toggle('is-focused', isFocused);
    card._focused = isFocused;
  }
  if (card._selectBtn && card._selectTitle !== selectTitle) {
    card._selectBtn.title = selectTitle;
    card._selectTitle = selectTitle;
  }

  const overlayEl = card._overlayEl;
  if (overlayEl) {
    const ov = buildOverlayData(file, store);
    if (card._overlayMode !== ov.mode) {
      overlayEl.className = `photo-overlay ${
        ov.mode === 'hover' ? 'is-hover-only' : ov.mode === 'empty' ? 'is-empty' : ''
      }`;
      card._overlayMode = ov.mode;
    }
    if (card._overlaySig !== ov.sig) {
      overlayEl.innerHTML = ov.html;
      card._overlaySig = ov.sig;
    }
  }
}

function acquirePhotoCard(file, store, styleAttr = '', isWaterfall = false, patchMeta = true) {
  let card = cardPool.get(file.id);
  if (!card) {
    const isVideo = file.mimeType && file.mimeType.startsWith('video/');
    const dur = isVideo ? formatDuration(file.videoMediaMetadata?.durationMillis) : '';

    card = document.createElement('div');
    card.className = 'photo-card';
    card.dataset.photoId = file.id;
    card.innerHTML = `
      <div class="photo-skeleton"></div>
      <button type="button" class="photo-select-btn" data-action="toggle-select" title="${escapeAttr(t('gallery.toggleSelect'))}">
        ${icon('check', 13)}
      </button>
      ${isVideo ? `<span class="photo-video-badge">${icon('video', 11)}<span>${dur || escapeHtml(t('gallery.video'))}</span></span>` : ''}
      <img alt="${escapeAttr(file.name)}" decoding="async" />
      <div class="photo-overlay is-empty"></div>
    `;

    card._imgEl = card.querySelector('img');
    card._overlayEl = card.querySelector('.photo-overlay');
    card._selectBtn = card.querySelector('.photo-select-btn');
    card._selectTitle = card._selectBtn?.title || '';
    card._styleAttr = null;
    card._loadedKey = '';
    card._selected = false;
    card._focused = false;
    card._overlayMode = 'empty';
    card._overlaySig = '';
    card._waterfall = false;

    cardPool.set(file.id, card);
  }

  const tsStr = String(getPhotoTimestampValue(file));
  if (card.dataset.ts !== tsStr) {
    card.dataset.ts = tsStr;
  }

  if (card._styleAttr !== styleAttr) {
    card.style.cssText = styleAttr;
    card._styleAttr = styleAttr;
  }

  if (card._waterfall !== isWaterfall) {
    card.classList.toggle('waterfall-card', isWaterfall);
    card._waterfall = isWaterfall;
  }

  const loadKey = `${file.id}|${file.thumbnailLink || ''}|${Boolean(store.state.accessToken)}|${Boolean(store.state.apiKey)}`;
  if (card._loadedKey !== loadKey && card._imgEl) {
    card._loadedKey = loadKey;
    loadPhotoIntoElement(card._imgEl, file, {
      size: GALLERY_THUMB_SIZE,
      getAccessToken: () => store.state.accessToken,
      getApiKey: () => store.state.apiKey,
    });
  }

  if (patchMeta) {
    patchCardMeta(card, file, store, t('gallery.toggleSelect'));
  }

  return card;
}

const cardPool = new Map();
const rowPool = [];
const colPool = [];

let pooledAlbumKey = '';
let lastSubbarSignature = '';
let lastBatchSignature = '';
let lastGridSignature = '';
let lastFilterKey = '';
let renderedLimit = PAGE_CHUNK;
let lastVisiblePhotos = [];
let lastContainerWidth = 0;
let lastIsMobile = false;
let lastRenderedMode = '';
let sentinelEl = null;
let loadMoreObserver = null;
let previewRafId = 0;
let pendingPreviewHeight = null;
let mobileSelectMode = false;

export function isGallerySelectModeActive(store) {
  return Boolean(mobileSelectMode || store?.state?.selectedPhotoIds?.size > 0);
}

export function toggleGallerySelectMode(store) {
  if (!store) return;
  if (isGallerySelectModeActive(store)) {
    mobileSelectMode = false;
    if (store.state.selectedPhotoIds.size > 0) {
      store.clearSelection();
    } else {
      store.emit();
    }
  } else {
    mobileSelectMode = true;
    store.emit();
  }
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

  // Maximize photo space: collapse subbar to 0px unless active filters exist
  if (chips.length === 0) {
    if (lastSubbarSignature !== '__hidden__') {
      lastSubbarSignature = '__hidden__';
      subbarEl.classList.add('hidden');
      subbarEl.innerHTML = '';
    }
    return;
  }

  subbarEl.classList.remove('hidden');
  const subbarSig = [
    state.lang,
    activeFolder?.id || '',
    activeFolder?.name || '',
    visiblePhotos.length,
    chips.map((c) => `${c.clear}:${c.label}`).join(','),
  ].join('|');

  if (subbarSig === lastSubbarSignature && subbarEl.childElementCount > 0) {
    return;
  }
  lastSubbarSignature = subbarSig;

  subbarEl.innerHTML = `
    <div class="gallery-subbar-left">
      <span class="breadcrumb-text">${escapeHtml(activeFolder?.name || t('gallery.allPhotos'))}</span>
      <span class="photo-count-badge">${escapeHtml(t('gallery.itemCount', { count: visiblePhotos.length }))}</span>
      <div class="active-filters-bar">
        ${chips
          .map(
            (c) =>
              `<button type="button" class="filter-chip" data-clear-filter="${escapeAttr(c.clear)}">${escapeHtml(c.label)} ${icon('x', 11)}</button>`
          )
          .join('')}
        <button type="button" class="btn btn-ghost btn-sm" data-clear-filter="all">${escapeHtml(t('gallery.clearFilters'))}</button>
      </div>
    </div>
  `;
}

export function renderBatchBar(batchBarEl, store, visiblePhotos) {
  if (!batchBarEl) return;
  const count = store.state.selectedPhotoIds.size;
  const batchSig = count === 0 ? '0' : `${store.state.lang}|${count}|${visiblePhotos.length}`;
  if (batchSig === lastBatchSignature && (count === 0 || batchBarEl.childElementCount > 0)) {
    return;
  }
  lastBatchSignature = batchSig;

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

function isTouchViewport() {
  return window.innerWidth <= 860 || Boolean(window.matchMedia?.('(pointer: coarse)').matches);
}

function syncContainerChildren(containerEl, nextChildren) {
  const existing = containerEl.children;
  let same = existing.length === nextChildren.length;
  if (same) {
    for (let i = 0; i < existing.length; i += 1) {
      if (existing[i] !== nextChildren[i]) {
        same = false;
        break;
      }
    }
  }
  if (same) return;
  const frag = document.createDocumentFragment();
  for (let i = 0; i < nextChildren.length; i += 1) {
    frag.appendChild(nextChildren[i]);
  }
  containerEl.replaceChildren(frag);
}

function teardownLoadMoreObserver() {
  if (loadMoreObserver) {
    loadMoreObserver.disconnect();
    loadMoreObserver = null;
  }
}

function buildFilterKey(state) {
  const tags =
    state.selectedTagIds && state.selectedTagIds.size > 0
      ? Array.from(state.selectedTagIds).sort().join(',')
      : '';
  return [
    state.lang,
    state.mode,
    state.folderId || '',
    state.activeFolderId || '',
    state.includeSubfolders ? 1 : 0,
    state.quickView,
    state.ratingScope,
    state.minRating,
    state.memberFilterId || '',
    tags,
    state.tagMatchMode,
    state.searchQuery,
    state.sortBy,
  ].join('|');
}

function buildGridSignature(state, isMobile, rowHeight, roundedWidth, visiblePhotos, limit) {
  return `${state.lang}|${isMobile ? 'm' : 'd'}|${state.layoutMode}|${rowHeight}|${roundedWidth}|${limit}|${visiblePhotos.length}|${getPhotosIdSig(visiblePhotos)}`;
}

function updateFloatingScrollState(scrollContainer) {
  const pillEl = scrollContainer._dlMonthPill;
  const backBtn = scrollContainer._dlBackTopBtn;
  if (!pillEl || !backBtn) return;

  const backLabel = t('gallery.backToTop');
  if (backBtn.title !== backLabel) {
    backBtn.title = backLabel;
    backBtn.setAttribute('aria-label', backLabel);
  }

  const show = scrollContainer.scrollTop > 320 && lastVisiblePhotos.length > 0;
  backBtn.classList.toggle('visible', show);
  if (!show) {
    pillEl.classList.remove('visible');
    return;
  }

  const rect = scrollContainer.getBoundingClientRect();
  const sampleX = rect.left + Math.max(40, Math.round(rect.width * 0.22));
  const hitCard =
    document.elementFromPoint(sampleX, rect.top + 48)?.closest('.photo-card[data-ts]') ||
    document.elementFromPoint(sampleX, rect.top + 68)?.closest('.photo-card[data-ts]');
  const ts = hitCard ? Number(hitCard.dataset.ts || 0) : 0;
  if (ts > 0) {
    pillEl.textContent = formatMonthPillLabel(ts);
    pillEl.classList.add('visible');
  } else {
    pillEl.classList.remove('visible');
  }
}

function ensureGalleryFloatingUi(scrollContainer) {
  const host = scrollContainer.parentElement;
  if (!host) return;
  if (scrollContainer._dlFloatingAttached) {
    updateFloatingScrollState(scrollContainer);
    return;
  }

  const pillEl = document.createElement('div');
  pillEl.className = 'gallery-month-pill';
  pillEl.setAttribute('aria-hidden', 'true');

  const backBtn = document.createElement('button');
  backBtn.type = 'button';
  backBtn.className = 'gallery-back-top';
  backBtn.innerHTML = icon('arrowUp', 16);
  backBtn.title = t('gallery.backToTop');
  backBtn.setAttribute('aria-label', t('gallery.backToTop'));
  backBtn.addEventListener('click', () => {
    scrollContainer.scrollTo({ top: 0, behavior: 'smooth' });
  });

  host.appendChild(pillEl);
  host.appendChild(backBtn);

  scrollContainer._dlMonthPill = pillEl;
  scrollContainer._dlBackTopBtn = backBtn;
  scrollContainer._dlFloatingAttached = true;

  let scrollRafId = 0;
  let lastScrollTop = scrollContainer.scrollTop || 0;
  scrollContainer.addEventListener(
    'scroll',
    () => {
      if (scrollRafId) return;
      scrollRafId = requestAnimationFrame(() => {
        scrollRafId = 0;
        const curTop = scrollContainer.scrollTop;
        const delta = curTop - lastScrollTop;
        lastScrollTop = curTop;

        const topHeaderEl = document.getElementById('topHeader');
        const mobileNav = document.getElementById('mobileNavBar');
        const overlayOpen =
          Boolean(document.querySelector(
            '#headerMorePopover.is-open, #topHeader.mobile-search-open, #demoBanner:not(.hidden), #drawerBackdrop.visible'
          ));

        if (curTop <= 30 || delta < -5 || overlayOpen) {
          topHeaderEl?.classList.remove('is-hidden-scroll');
          mobileNav?.classList.remove('is-condensed');
        } else if (curTop > 50 && delta > 4) {
          topHeaderEl?.classList.add('is-hidden-scroll');
          mobileNav?.classList.add('is-condensed');
        }

        updateFloatingScrollState(scrollContainer);
      });
    },
    { passive: true }
  );

  updateFloatingScrollState(scrollContainer);
}

function hideGalleryFloatingUi(scrollContainer) {
  if (!scrollContainer) return;
  scrollContainer._dlMonthPill?.classList.remove('visible');
  scrollContainer._dlBackTopBtn?.classList.remove('visible');
}

function applyGalleryGeometry(gridEl, scrollContainer, store, visiblePhotos, targetHeight, patchMeta) {
  const state = store.state;
  const { layoutMode, lang } = state;
  const isMobile = scrollContainer.clientWidth <= 600;
  const containerWidth = Math.max(240, gridEl.clientWidth);
  const roundedWidth = Math.round(containerWidth);
  const gap = window.innerWidth <= 860 ? 2 : 3;
  const effectiveRowHeight = isMobile
    ? Math.round(Math.max(105, targetHeight * 0.62))
    : targetHeight;

  const limit = Math.min(renderedLimit, visiblePhotos.length);
  const windowedPhotos =
    limit < visiblePhotos.length ? visiblePhotos.slice(0, limit) : visiblePhotos;

  let wrapperEl = null;

  if (layoutMode === 'waterfall') {
    const columns = computeWaterfallColumns(
      windowedPhotos,
      containerWidth,
      targetHeight,
      gap,
      isMobile
    );
    const existingWrapper =
      lastRenderedMode === 'waterfall' &&
      gridEl.firstElementChild?.classList.contains('waterfall-gallery')
        ? gridEl.firstElementChild
        : null;
    wrapperEl = existingWrapper || document.createElement('div');
    wrapperEl.className = 'waterfall-gallery';

    const colNodes = [];
    for (let i = 0; i < columns.length; i += 1) {
      let colEl = colPool[i];
      if (!colEl) {
        colEl = document.createElement('div');
        colEl.className = 'waterfall-column';
        colPool[i] = colEl;
      }
      const colItems = columns[i];
      const colCards = new Array(colItems.length);
      for (let j = 0; j < colItems.length; j += 1) {
        const cell = colItems[j];
        colCards[j] = acquirePhotoCard(
          cell.item,
          store,
          `width:100%;height:${cell.height}px;`,
          true,
          patchMeta
        );
      }
      syncContainerChildren(colEl, colCards);
      colNodes.push(colEl);
    }
    syncContainerChildren(wrapperEl, colNodes);
  } else if (layoutMode === 'grid') {
    const existingWrapper =
      lastRenderedMode === 'grid' &&
      gridEl.firstElementChild?.classList.contains('square-gallery')
        ? gridEl.firstElementChild
        : null;
    wrapperEl = existingWrapper || document.createElement('div');
    wrapperEl.className = 'square-gallery';
    const minCard = isMobile
      ? Math.max(98, Math.round(targetHeight * 0.5))
      : Math.max(130, targetHeight - 20);
    const nextCols = `repeat(auto-fill, minmax(${minCard}px, 1fr))`;
    if (wrapperEl.style.gridTemplateColumns !== nextCols) {
      wrapperEl.style.gridTemplateColumns = nextCols;
    }

    const cards = new Array(windowedPhotos.length);
    for (let i = 0; i < windowedPhotos.length; i += 1) {
      cards[i] = acquirePhotoCard(windowedPhotos[i], store, '', false, patchMeta);
    }
    syncContainerChildren(wrapperEl, cards);
  } else {
    const rows = computeJustifiedRows(windowedPhotos, containerWidth, effectiveRowHeight, gap);
    const existingWrapper =
      lastRenderedMode === 'justified' &&
      gridEl.firstElementChild?.classList.contains('justified-gallery')
        ? gridEl.firstElementChild
        : null;
    wrapperEl = existingWrapper || document.createElement('div');
    wrapperEl.className = 'justified-gallery';

    const rowNodes = [];
    for (let i = 0; i < rows.length; i += 1) {
      let rowEl = rowPool[i];
      if (!rowEl) {
        rowEl = document.createElement('div');
        rowEl.className = 'justified-row';
        rowPool[i] = rowEl;
      }
      const row = rows[i];
      const nextHeightPx = `${row.height}px`;
      if (rowEl.style.height !== nextHeightPx) {
        rowEl.style.height = nextHeightPx;
      }
      const rowCards = new Array(row.items.length);
      for (let j = 0; j < row.items.length; j += 1) {
        const cell = row.items[j];
        rowCards[j] = acquirePhotoCard(
          cell.item,
          store,
          `width:${cell.width}px;height:${row.height}px;`,
          false,
          patchMeta
        );
      }
      syncContainerChildren(rowEl, rowCards);
      rowNodes.push(rowEl);
    }
    syncContainerChildren(wrapperEl, rowNodes);
  }

  lastRenderedMode = layoutMode;
  lastContainerWidth = roundedWidth;
  lastIsMobile = isMobile;
  lastGridSignature = buildGridSignature(
    { ...state, lang },
    isMobile,
    targetHeight,
    roundedWidth,
    visiblePhotos,
    renderedLimit
  );

  const hasMore = visiblePhotos.length > limit;
  if (hasMore) {
    if (!sentinelEl) {
      sentinelEl = document.createElement('div');
      sentinelEl.className = 'gallery-load-sentinel';
      sentinelEl.setAttribute('aria-hidden', 'true');
    }
    syncContainerChildren(gridEl, [wrapperEl, sentinelEl]);
    teardownLoadMoreObserver();
    if (typeof IntersectionObserver !== 'undefined') {
      loadMoreObserver = new IntersectionObserver(
        (entries) => {
          if (!entries.some((entry) => entry.isIntersecting)) return;
          if (renderedLimit >= lastVisiblePhotos.length) return;
          renderedLimit = Math.min(lastVisiblePhotos.length, renderedLimit + PAGE_CHUNK);
          renderGalleryGrid(gridEl, scrollContainer, store, lastVisiblePhotos);
        },
        { root: scrollContainer, rootMargin: '600px 0px', threshold: 0 }
      );
      loadMoreObserver.observe(sentinelEl);
    }
  } else {
    teardownLoadMoreObserver();
    syncContainerChildren(gridEl, [wrapperEl]);
  }
}

export function renderGalleryGrid(gridEl, scrollContainer, store, visiblePhotos) {
  if (!gridEl || !scrollContainer) return;

  const albumKey = `${store.state.mode}:${store.state.folderId || 'demo'}`;
  if (albumKey !== pooledAlbumKey) {
    pooledAlbumKey = albumKey;
    cardPool.clear();
    rowPool.length = 0;
    colPool.length = 0;
    lastRenderedMode = '';
    lastGridSignature = '';
  }

  const selectActive = mobileSelectMode || store.state.selectedPhotoIds.size > 0;
  gridEl.classList.toggle('gallery-select-active', selectActive);

  if (store.state.loading) {
    teardownLoadMoreObserver();
    lastVisiblePhotos = [];
    lastRenderedMode = '';
    lastGridSignature = '__loading__';
    gridEl.innerHTML = `
      <div class="empty-state">
        <div class="spin" style="color:var(--accent)">${icon('refresh', 28)}</div>
        <div style="font-size:14px;color:var(--text-primary)">${escapeHtml(store.state.loadingText || t('gallery.loadingAlbum'))}</div>
      </div>
    `;
    hideGalleryFloatingUi(scrollContainer);
    return;
  }

  if (visiblePhotos.length === 0) {
    teardownLoadMoreObserver();
    lastVisiblePhotos = [];
    lastRenderedMode = '';
    lastGridSignature = '__empty__';
    gridEl.innerHTML = `
      <div class="empty-state">
        ${icon('image', 36)}
        <div style="font-size:14px;color:var(--text-primary)">${escapeHtml(t('gallery.emptyTitle'))}</div>
        <div style="font-size:12px">${escapeHtml(t('gallery.emptyHint'))}</div>
        <button type="button" class="btn btn-primary" data-clear-empty="true">${escapeHtml(t('gallery.resetAllFilters'))}</button>
      </div>
    `;
    hideGalleryFloatingUi(scrollContainer);
    return;
  }

  ensureGalleryFloatingUi(scrollContainer);
  lastVisiblePhotos = visiblePhotos;

  const filterKey = buildFilterKey(store.state);
  if (filterKey !== lastFilterKey) {
    lastFilterKey = filterKey;
    renderedLimit = PAGE_CHUNK;
  } else {
    renderedLimit = Math.min(
      Math.max(renderedLimit, PAGE_CHUNK),
      Math.max(PAGE_CHUNK, visiblePhotos.length)
    );
  }

  const { rowHeight } = store.state;
  const isMobile = scrollContainer.clientWidth <= 600;
  const containerWidth = Math.max(240, gridEl.clientWidth);
  const roundedWidth = Math.round(containerWidth);
  const sig = buildGridSignature(
    store.state,
    isMobile,
    rowHeight,
    roundedWidth,
    visiblePhotos,
    renderedLimit
  );

  // Fast path: patch selection, focus & overlays in-place without recalculating layout
  if (sig === lastGridSignature && lastRenderedMode) {
    const selectTitle = t('gallery.toggleSelect');
    const limit = Math.min(renderedLimit, visiblePhotos.length);
    for (let i = 0; i < limit; i += 1) {
      const file = visiblePhotos[i];
      const card = cardPool.get(file.id);
      if (card) {
        patchCardMeta(card, file, store, selectTitle);
      }
    }
    return;
  }

  applyGalleryGeometry(gridEl, scrollContainer, store, visiblePhotos, rowHeight, true);
}

export function previewGalleryRowHeight(gridEl, scrollContainer, store, nextHeight) {
  if (!gridEl || !scrollContainer || !store) return;
  const clamped = Math.max(130, Math.min(320, Math.round(Number(nextHeight) || 210)));
  pendingPreviewHeight = clamped;
  if (previewRafId) return;
  previewRafId = requestAnimationFrame(() => {
    previewRafId = 0;
    if (pendingPreviewHeight === null) return;
    const heightToApply = pendingPreviewHeight;
    pendingPreviewHeight = null;
    if (store.state.loading || lastVisiblePhotos.length === 0) return;
    applyGalleryGeometry(gridEl, scrollContainer, store, lastVisiblePhotos, heightToApply, false);
  });
}

export function relayoutGalleryOnResize(gridEl, scrollContainer, store) {
  if (!gridEl || !scrollContainer || !store) return;
  if (store.state.loading || lastVisiblePhotos.length === 0) return;

  const isMobile = scrollContainer.clientWidth <= 600;
  const containerWidth = Math.max(240, gridEl.clientWidth);
  const roundedWidth = Math.round(containerWidth);
  if (roundedWidth === lastContainerWidth && isMobile === lastIsMobile) return;

  const targetHeight = Math.max(130, Math.min(320, Number(store.state.rowHeight || 210)));

  // CSS Grid tracks reflow natively on container width changes
  if (
    store.state.layoutMode === 'grid' &&
    lastRenderedMode === 'grid' &&
    isMobile === lastIsMobile
  ) {
    lastContainerWidth = roundedWidth;
    lastGridSignature = buildGridSignature(
      store.state,
      isMobile,
      targetHeight,
      roundedWidth,
      lastVisiblePhotos,
      renderedLimit
    );
    return;
  }

  applyGalleryGeometry(gridEl, scrollContainer, store, lastVisiblePhotos, targetHeight, false);
}

export function resetGallerySignature() {
  lastGridSignature = '';
  lastSubbarSignature = '';
  lastBatchSignature = '';
}

export function bindGalleryEvents(subbarEl, batchBarEl, gridEl, store) {
  if (subbarEl) {
    subbarEl.addEventListener('change', (e) => {
      if (e.target.id === 'sortBySelect') {
        store.setSortBy(e.target.value);
      }
    });

    subbarEl.addEventListener('click', (e) => {
      const selectModeBtn = e.target.closest('[data-subbar="toggle-select-mode"]');
      if (selectModeBtn) {
        toggleGallerySelectMode(store);
        return;
      }

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
        mobileSelectMode = false;
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
    let longPressTimer = null;
    let touchStartX = 0;
    let touchStartY = 0;
    let suppressNextClickUntil = 0;
    let pinchStartDist = 0;
    let pinchStartHeight = 210;
    let pinchLiveHeight = null;
    let wheelCommitTimer = null;

    function clearLongPress() {
      if (longPressTimer) {
        clearTimeout(longPressTimer);
        longPressTimer = null;
      }
    }

    function syncRangeSliders(val) {
      const str = String(val);
      const topSlider = document.getElementById('rowHeightRange');
      if (topSlider && topSlider.value !== str) topSlider.value = str;
      const sideSlider = document.getElementById('sidebarRowHeightRange');
      if (sideSlider && sideSlider.value !== str) sideSlider.value = str;
    }

    gridEl.addEventListener(
      'touchstart',
      (e) => {
        if (e.touches.length === 2) {
          clearLongPress();
          pinchStartDist = Math.hypot(
            e.touches[1].clientX - e.touches[0].clientX,
            e.touches[1].clientY - e.touches[0].clientY
          );
          pinchStartHeight = store.state.rowHeight || 210;
          pinchLiveHeight = null;
          return;
        }
        if (e.touches.length !== 1) {
          clearLongPress();
          return;
        }
        if (e.target.closest('[data-action="toggle-select"]')) return;
        const card = e.target.closest('.photo-card[data-photo-id]');
        if (!card) return;
        const photoId = card.dataset.photoId;
        const touch = e.touches[0];
        touchStartX = touch.clientX;
        touchStartY = touch.clientY;
        clearLongPress();
        longPressTimer = setTimeout(() => {
          longPressTimer = null;
          mobileSelectMode = true;
          suppressNextClickUntil = Date.now() + 450;
          store.toggleSelectCheckbox(photoId);
          navigator.vibrate?.(12);
        }, 420);
      },
      { passive: true }
    );

    gridEl.addEventListener(
      'touchmove',
      (e) => {
        if (e.touches.length === 2 && pinchStartDist > 0) {
          e.preventDefault();
          const dist = Math.hypot(
            e.touches[1].clientX - e.touches[0].clientX,
            e.touches[1].clientY - e.touches[0].clientY
          );
          const nextH = Math.max(
            130,
            Math.min(320, Math.round(pinchStartHeight * (dist / pinchStartDist)))
          );
          pinchLiveHeight = nextH;
          syncRangeSliders(nextH);
          previewGalleryRowHeight(gridEl, document.getElementById('galleryScroll'), store, nextH);
          return;
        }
        if (!longPressTimer || e.touches.length !== 1) return;
        const touch = e.touches[0];
        if (
          Math.abs(touch.clientX - touchStartX) > 10 ||
          Math.abs(touch.clientY - touchStartY) > 10
        ) {
          clearLongPress();
        }
      },
      { passive: false }
    );

    function finishPinchOrTouch(e) {
      clearLongPress();
      if (pinchLiveHeight !== null && (!e.touches || e.touches.length < 2)) {
        const commitH = pinchLiveHeight;
        pinchLiveHeight = null;
        pinchStartDist = 0;
        suppressNextClickUntil = Date.now() + 350;
        store.setRowHeight(commitH);
      } else if (!e.touches || e.touches.length < 2) {
        pinchStartDist = 0;
      }
    }

    gridEl.addEventListener('touchend', finishPinchOrTouch, { passive: true });
    gridEl.addEventListener('touchcancel', finishPinchOrTouch, { passive: true });

    gridEl.addEventListener(
      'wheel',
      (e) => {
        if (!(e.ctrlKey || e.metaKey)) return;
        e.preventDefault();
        const base =
          pendingPreviewHeight !== null ? pendingPreviewHeight : store.state.rowHeight || 210;
        const nextH = Math.max(130, Math.min(320, Math.round(base + (e.deltaY < 0 ? 18 : -18))));
        syncRangeSliders(nextH);
        previewGalleryRowHeight(gridEl, document.getElementById('galleryScroll'), store, nextH);
        clearTimeout(wheelCommitTimer);
        wheelCommitTimer = setTimeout(() => {
          store.setRowHeight(nextH);
        }, 120);
      },
      { passive: false }
    );

    gridEl.addEventListener('click', (e) => {
      if (Date.now() < suppressNextClickUntil) return;
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

      if (isTouchViewport() || mobileSelectMode) {
        if (mobileSelectMode || store.state.selectedPhotoIds.size > 0) {
          store.toggleSelectCheckbox(photoId);
        } else {
          store.openLightbox(photoId);
        }
        return;
      }

      if (
        !e.ctrlKey &&
        !e.metaKey &&
        !e.shiftKey &&
        store.state.selectedPhotoIds.size === 0 &&
        !store.state.inspectorOpen
      ) {
        store.openLightbox(photoId);
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
