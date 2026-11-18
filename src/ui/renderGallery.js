import { getLocaleTag, t } from '../i18n.js';
import { resolvePhotoTimestamp } from '../state/store.js';
import { loadPhotoIntoElement, quantizeThumbSize } from '../storage/imageLoader.js';
import { escapeAttr, escapeHtml, icon, starSectorIcon } from './icons.js';
import { openCompare } from './renderCompare.js';

const PAGE_CHUNK = 80;

const visiblePhotosIdSigCache = new WeakMap();
const monthFormatterCache = new Map();

function getPhotoTimestampValue(file) {
  return resolvePhotoTimestamp(file);
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
      starHtml = `<span class="photo-star-badge">${starSectorIcon(meta.avgRating, 12)}<span>${avgText}</span></span>`;
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

function computeCardThumbTarget(cssBoxMaxPx) {
  const dpr =
    typeof window !== 'undefined' ? Math.min(2.25, Math.max(1, window.devicePixelRatio || 1)) : 1;
  return quantizeThumbSize(Math.round((Number(cssBoxMaxPx) || 260) * dpr));
}

function acquirePhotoCard(
  file,
  store,
  styleAttr = '',
  isWaterfall = false,
  patchMeta = true,
  cssBoxMaxPx = 280
) {
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
    card._requestedThumbSize = 0;
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

  // Upgrade thumbnail tier only on committed renders (patchMeta === true), never mid-slider drag
  const desiredSize = patchMeta
    ? Math.max(card._requestedThumbSize || 480, computeCardThumbTarget(cssBoxMaxPx))
    : card._requestedThumbSize || 480;

  const authSig = `${file.id}|${file.thumbnailLink || ''}|${Boolean(store.state.accessToken)}|${Boolean(store.state.apiKey)}`;
  const loadKey = `${authSig}|${desiredSize}`;
  if (card._imgEl && (card._loadedKey !== loadKey || (patchMeta && desiredSize > card._requestedThumbSize))) {
    card._loadedKey = loadKey;
    card._requestedThumbSize = desiredSize;
    loadPhotoIntoElement(card._imgEl, file, {
      size: desiredSize,
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
let scrollSettleCallback = null;

export function setGalleryScrollSettleCallback(fn) {
  scrollSettleCallback = typeof fn === 'function' ? fn : null;
}

export function getCurrentPageSmartTargets(scrollContainer, store, visiblePhotos) {
  if (!store || !Array.isArray(visiblePhotos) || visiblePhotos.length === 0) {
    return { ratedPageItems: [], restPageItems: [] };
  }
  const limit = Math.min(renderedLimit, visiblePhotos.length);
  const pageSlice = visiblePhotos.slice(0, limit);
  const maxScroll = scrollContainer
    ? Math.max(1, scrollContainer.scrollHeight - scrollContainer.clientHeight)
    : 1;
  const ratio = scrollContainer ? Math.min(1, Math.max(0, scrollContainer.scrollTop / maxScroll)) : 0;
  const approxCenterIdx = Math.round(ratio * Math.max(0, pageSlice.length - 1));

  const ratedCandidates = [];
  const restCandidates = [];
  for (let i = 0; i < pageSlice.length; i += 1) {
    const file = pageSlice[i];
    if (!file || file.isDemo || (file.mimeType && file.mimeType.startsWith('video/'))) continue;
    const meta = store.getAggregatedItemMeta(file.id);
    const dist = Math.abs(i - approxCenterIdx);
    if (meta.ratingCount > 0 || meta.favoriteCount > 0) {
      ratedCandidates.push({
        file,
        dist,
        fav: meta.favoriteCount > 0 ? 1 : 0,
        avg: meta.avgRating || 0,
      });
    } else {
      restCandidates.push({ file, dist });
    }
  }

  ratedCandidates.sort((a, b) => {
    const bucketA = Math.floor(a.dist / 12);
    const bucketB = Math.floor(b.dist / 12);
    if (bucketA !== bucketB) return bucketA - bucketB;
    if (b.fav !== a.fav) return b.fav - a.fav;
    if (b.avg !== a.avg) return b.avg - a.avg;
    return a.dist - b.dist;
  });

  restCandidates.sort((a, b) => a.dist - b.dist);

  return {
    ratedPageItems: ratedCandidates.map((c) => c.file),
    restPageItems: restCandidates.map((c) => c.file),
  };
}

export function getCurrentPageRatedPhotos(scrollContainer, store, visiblePhotos) {
  return getCurrentPageSmartTargets(scrollContainer, store, visiblePhotos).ratedPageItems;
}

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
  const schemaTags = state.tagSchema?.tags || {};

  const chips = [];
  if (state.quickView === 'favorites') {
    chips.push({ label: t('sidebar.favorites'), clear: 'quickView' });
  } else if (state.quickView === 'unrated') {
    chips.push({ label: t('gallery.chipUnrated'), clear: 'quickView' });
  }
  if (state.mediaFilter === 'photo') {
    chips.push({ label: t('gallery.chipMediaPhoto'), clear: 'mediaFilter' });
  } else if (state.mediaFilter === 'video') {
    chips.push({ label: t('gallery.chipMediaVideo'), clear: 'mediaFilter' });
  }
  if (state.aspectFilter === 'landscape') {
    chips.push({ label: t('gallery.chipLandscape'), clear: 'aspectFilter' });
  } else if (state.aspectFilter === 'portrait') {
    chips.push({ label: t('gallery.chipPortrait'), clear: 'aspectFilter' });
  } else if (state.aspectFilter === 'square') {
    chips.push({ label: t('gallery.chipSquare'), clear: 'aspectFilter' });
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
    chips.push({ label: `${prefix} ≥ ${state.minRating}`, clear: 'minRating' });
  }
  for (const tid of state.selectedTagIds) {
    const tag = schemaTags[tid];
    if (tag) chips.push({ label: t('gallery.chipTag', { name: tag.name }), clear: `tag:${tid}` });
  }
  if (state.searchQuery.trim()) {
    chips.push({ label: t('gallery.chipSearch', { q: state.searchQuery.trim() }), clear: 'search' });
  }

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
    visiblePhotos.length,
    chips.map((c) => `${c.clear}:${c.label}`).join(','),
  ].join('|');

  if (subbarSig === lastSubbarSignature && subbarEl.childElementCount > 0) {
    return;
  }
  lastSubbarSignature = subbarSig;

  subbarEl.innerHTML = `
    <div class="gallery-subbar-pill">
      ${chips
        .map(
          (c) => `
          <button type="button" class="filter-chip" data-clear-filter="${escapeAttr(c.clear)}">
            <span>${escapeHtml(c.label)}</span>
            ${icon('x', 11)}
          </button>
        `
        )
        .join('')}
      <button type="button" class="filter-chip filter-chip-reset" data-clear-filter="all">
        <span>${escapeHtml(t('gallery.clearFilters'))}</span>
      </button>
    </div>
  `;
}

export function renderBatchBar(batchBarEl, store, visiblePhotos) {
  if (!batchBarEl) return;
  const count = store.state.selectedPhotoIds.size;
  if (count === 0 && mobileSelectMode) {
    // Keep checkbox mode only if explicitly entered; batch bar floats only when >= 1 selected
  }
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
    <div class="batch-glass-pill">
      <span class="batch-count-pill">${escapeHtml(t('gallery.batchSelected', { count }))}</span>
      <button type="button" class="batch-pill-btn" data-batch="select-all" title="${escapeAttr(t('gallery.batchSelectAll', { count: visiblePhotos.length }))}">
        ${icon('checkCircle', 15)}
        <span class="hide-xs">${escapeHtml(t('sidebar.allStars'))}</span>
      </button>
      <span class="batch-pill-sep" aria-hidden="true"></span>
      <div class="batch-stars-group" role="group" aria-label="${escapeAttr(t('gallery.batchRateLabel'))}">
        ${[1, 2, 3, 4, 5]
          .map(
            (r) =>
              `<button type="button" class="batch-icon-btn" data-batch="rate" data-rating="${r}" title="${escapeAttr(t('inspector.batchRateTitle', { n: r }))}">${starSectorIcon(r, 15)}</button>`
          )
          .join('')}
        <button type="button" class="batch-icon-btn" data-batch="rate" data-rating="0" title="${escapeAttr(t('gallery.batchResetRate'))}">${icon('undo', 14)}</button>
      </div>
      <span class="batch-pill-sep" aria-hidden="true"></span>
      <button type="button" class="batch-icon-btn" data-batch="fav" title="${escapeAttr(t('gallery.batchFav'))}" aria-label="${escapeAttr(t('gallery.batchFav'))}">${icon('heart', 16)}</button>
      <button type="button" class="batch-icon-btn" data-batch="quick-tag" title="${escapeAttr(t('gallery.batchTag'))}" aria-label="${escapeAttr(t('gallery.batchTag'))}">${icon('tag', 16)}</button>
      ${
        count >= 2
          ? `<button type="button" class="batch-icon-btn" data-batch="compare" title="${escapeAttr(t('gallery.batchCompare'))}" aria-label="${escapeAttr(t('gallery.batchCompare'))}">${icon('compare', 16)}</button>`
          : ''
      }
      <button type="button" class="batch-icon-btn batch-close-btn" data-batch="clear" title="${escapeAttr(t('gallery.batchClearSelect'))}" aria-label="${escapeAttr(t('gallery.batchClearSelect'))}">${icon('x', 16)}</button>
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
    state.mediaFilter || 'all',
    state.aspectFilter || 'all',
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

function findSampleCardTimestamp(scrollContainer) {
  const rect = scrollContainer.getBoundingClientRect();
  if (!rect.width || !rect.height) return 0;
  const sampleY = rect.top + Math.min(130, Math.max(68, Math.round(rect.height * 0.24)));
  const sampleXs = [
    rect.left + Math.round(rect.width * 0.25),
    rect.left + Math.round(rect.width * 0.5),
    rect.left + Math.round(rect.width * 0.75),
  ];
  for (const sx of sampleXs) {
    if (typeof document.elementsFromPoint === 'function') {
      const stack = document.elementsFromPoint(sx, sampleY);
      for (const el of stack) {
        if (el.classList?.contains('photo-card') && el.dataset.ts) {
          const v = Number(el.dataset.ts);
          if (v > 0) return v;
        }
      }
    } else {
      const hit = document.elementFromPoint(sx, sampleY)?.closest('.photo-card[data-ts]');
      const v = hit ? Number(hit.dataset.ts || 0) : 0;
      if (v > 0) return v;
    }
  }
  return 0;
}

function updateFloatingScrollState(scrollContainer, store, fromActiveScroll = false) {
  const pillEl = scrollContainer._dlMonthPill;
  const backBtn = scrollContainer._dlBackTopBtn;
  if (!pillEl || !backBtn) return;

  const backLabel = t('gallery.backToTop');
  if (backBtn.title !== backLabel) {
    backBtn.title = backLabel;
    backBtn.setAttribute('aria-label', backLabel);
  }

  const showBackTop = scrollContainer.scrollTop > 320 && lastVisiblePhotos.length > 0;
  backBtn.classList.toggle('visible', showBackTop);
  document.getElementById('mobileNavBar')?.classList.toggle('has-back-top', showBackTop);

  const sortBy = store?.state?.sortBy || 'dateDesc';
  const isDateSort = sortBy === 'dateDesc' || sortBy === 'dateAsc';

  if (!showBackTop || !isDateSort) {
    clearTimeout(scrollContainer._dlPillHideTimer);
    pillEl.classList.remove('visible');
    return;
  }

  if (!fromActiveScroll && !pillEl.classList.contains('visible')) {
    return;
  }

  const ts = findSampleCardTimestamp(scrollContainer);
  if (ts > 0) {
    pillEl.textContent = formatMonthPillLabel(ts);
    if (fromActiveScroll) {
      pillEl.classList.add('visible');
      clearTimeout(scrollContainer._dlPillHideTimer);
      scrollContainer._dlPillHideTimer = setTimeout(() => {
        pillEl.classList.remove('visible');
      }, 950);
    }
  } else {
    pillEl.classList.remove('visible');
  }
}

function ensureGalleryFloatingUi(scrollContainer, store) {
  const host = scrollContainer.parentElement;
  if (!host) return;
  scrollContainer._dlStoreRef = store;
  if (scrollContainer._dlFloatingAttached) {
    updateFloatingScrollState(scrollContainer, store, false);
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
        const overlayOpen = Boolean(
          document.querySelector(
            '#headerMorePopover.is-open, #topHeader.search-expanded, #demoBanner:not(.hidden), #drawerBackdrop.visible'
          )
        );

        if (curTop <= 30 || delta < -5 || overlayOpen) {
          topHeaderEl?.classList.remove('is-hidden-scroll');
        } else if (curTop > 50 && delta > 4) {
          topHeaderEl?.classList.add('is-hidden-scroll');
        }

        updateFloatingScrollState(scrollContainer, scrollContainer._dlStoreRef, true);
        clearTimeout(scrollContainer._dlSettleTimer);
        scrollContainer._dlSettleTimer = setTimeout(() => {
          if (scrollSettleCallback) scrollSettleCallback();
        }, 280);
      });
    },
    { passive: true }
  );

  updateFloatingScrollState(scrollContainer, store, false);
}

function hideGalleryFloatingUi(scrollContainer) {
  if (!scrollContainer) return;
  clearTimeout(scrollContainer._dlPillHideTimer);
  scrollContainer._dlMonthPill?.classList.remove('visible');
  scrollContainer._dlBackTopBtn?.classList.remove('visible');
  document.getElementById('mobileNavBar')?.classList.remove('has-back-top');
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
          patchMeta,
          Math.max(cell.width, cell.height)
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
    const colEst = Math.max(1, Math.floor((containerWidth + gap) / (minCard + gap)));
    const approxCellW = Math.round(containerWidth / colEst);
    const nextCols = `repeat(auto-fill, minmax(${minCard}px, 1fr))`;
    if (wrapperEl.style.gridTemplateColumns !== nextCols) {
      wrapperEl.style.gridTemplateColumns = nextCols;
    }

    const cards = new Array(windowedPhotos.length);
    for (let i = 0; i < windowedPhotos.length; i += 1) {
      cards[i] = acquirePhotoCard(windowedPhotos[i], store, '', false, patchMeta, approxCellW);
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
          patchMeta,
          Math.max(cell.width, row.height)
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
          if (scrollSettleCallback) scrollSettleCallback();
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

  if (store.state.selectedPhotoIds.size === 0 && mobileSelectMode) {
    // Auto-exit multi-select once all selections are cleared
    mobileSelectMode = false;
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

  ensureGalleryFloatingUi(scrollContainer, store);
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

  applyGalleryGeometry(gridEl, scrollContainer, store, lastVisiblePhotos, targetHeight, true);
}

export function resetGallerySignature() {
  lastGridSignature = '';
  lastSubbarSignature = '';
  lastBatchSignature = '';
}

export function bindGalleryEvents(subbarEl, batchBarEl, gridEl, store) {
  if (subbarEl) {
    subbarEl.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-clear-filter]');
      if (!btn) return;
      const key = btn.dataset.clearFilter;
      if (key === 'all') {
        store.clearAllFilters();
      } else if (key === 'quickView') {
        store.setState({ quickView: 'all' });
      } else if (key === 'mediaFilter') {
        store.setState({ mediaFilter: 'all' });
      } else if (key === 'aspectFilter') {
        store.setState({ aspectFilter: 'all' });
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
        mobileSelectMode = true;
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
      } else if (act === 'compare') {
        openCompare(ids, store);
      }
    });
  }

  if (gridEl) {
    let longPressTimer = null;
    let touchStartX = 0;
    let touchStartY = 0;
    let suppressNextClickUntil = 0;
    let suppressedClickPhotoId = '';
    let pinchStartDist = 0;
    let pinchStartHeight = 210;
    let pinchLiveHeight = null;
    let wheelCommitTimer = null;

    // Desktop 2-second top-left hover timer for unobtrusive checkbox reveal
    let hoverPeekTimer = 0;
    let hoverCandidateCard = null;
    let revealedPeekCard = null;

    function clearHoverPeek(keepRevealed = false) {
      if (hoverPeekTimer) {
        clearTimeout(hoverPeekTimer);
        hoverPeekTimer = 0;
      }
      hoverCandidateCard = null;
      if (!keepRevealed && revealedPeekCard) {
        revealedPeekCard.classList.remove('is-select-peek');
        revealedPeekCard = null;
      }
    }

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
      const sizeBadge = document.querySelector('[data-more-size-px]');
      if (sizeBadge) sizeBadge.textContent = `${str}px`;
    }

    gridEl.addEventListener('mousemove', (e) => {
      if (isTouchViewport() || isGallerySelectModeActive(store)) {
        clearHoverPeek(false);
        return;
      }
      const card = e.target.closest('.photo-card[data-photo-id]');
      if (!card) {
        clearHoverPeek(false);
        return;
      }
      if (revealedPeekCard && revealedPeekCard !== card) {
        revealedPeekCard.classList.remove('is-select-peek');
        revealedPeekCard = null;
      }
      if (revealedPeekCard === card) {
        return;
      }

      const rect = card.getBoundingClientRect();
      const safeTopEdge = Math.max(rect.top, 56);
      const inTopLeft =
        e.clientX - rect.left <= Math.max(76, rect.width * 0.5) &&
        e.clientY - safeTopEdge <= Math.max(76, rect.height * 0.5);

      if (!inTopLeft) {
        if (hoverCandidateCard === card) {
          clearHoverPeek(false);
        }
        return;
      }

      if (hoverCandidateCard !== card) {
        clearHoverPeek(false);
        hoverCandidateCard = card;
        hoverPeekTimer = setTimeout(() => {
          hoverPeekTimer = 0;
          if (hoverCandidateCard === card && card.isConnected) {
            const curRect = card.getBoundingClientRect();
            card.style.setProperty(
              '--select-btn-top',
              curRect.top < 54 ? `${Math.round(58 - curRect.top)}px` : '7px'
            );
            revealedPeekCard = card;
            card.classList.add('is-select-peek');
          }
        }, 2000);
      }
    });

    gridEl.addEventListener('mouseleave', () => {
      clearHoverPeek(false);
    });

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
          suppressedClickPhotoId = photoId;
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
        suppressedClickPhotoId = '__all__';
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
        }, 140);
      },
      { passive: false }
    );

    gridEl.addEventListener('click', (e) => {
      if (e.target.closest('[data-clear-empty]')) {
        store.clearAllFilters();
        return;
      }
      const selectBtn = e.target.closest('[data-action="toggle-select"]');
      const card = e.target.closest('.photo-card[data-photo-id]');
      if (!card) return;
      const photoId = card.dataset.photoId;
      if (
        Date.now() < suppressNextClickUntil &&
        (suppressedClickPhotoId === '__all__' || suppressedClickPhotoId === photoId)
      ) {
        suppressNextClickUntil = 0;
        suppressedClickPhotoId = '';
        return;
      }

      if (selectBtn) {
        e.stopPropagation();
        clearHoverPeek(false);
        mobileSelectMode = true;
        store.toggleSelectCheckbox(photoId);
        return;
      }

      if (isGallerySelectModeActive(store)) {
        if (e.shiftKey && store.state.lastClickedPhotoId) {
          store.selectPhoto(photoId, { ctrl: true, shift: true });
        } else {
          store.toggleSelectCheckbox(photoId);
        }
        return;
      }

      if (isTouchViewport()) {
        store.openLightbox(photoId);
        return;
      }

      if (e.ctrlKey || e.metaKey || e.shiftKey) {
        mobileSelectMode = true;
        store.selectPhoto(photoId, {
          ctrl: true,
          shift: e.shiftKey,
        });
        return;
      }

      if (store.state.inspectorOpen) {
        store.selectPhoto(photoId, { ctrl: false, shift: false });
        return;
      }

      store.openLightbox(photoId);
    });

    gridEl.addEventListener('dblclick', (e) => {
      const card = e.target.closest('.photo-card[data-photo-id]');
      if (!card) return;
      if (e.target.closest('[data-action="toggle-select"]')) return;
      store.openLightbox(card.dataset.photoId);
    });
  }
}
