import { downloadOriginalFile } from '../api/gdrive.js';
import { t } from '../i18n.js';
import {
  fetchAuthorizedMediaBlobUrl,
  getInstantCachedSrc,
  hasCachedHdSrc,
  loadPhotoIntoElement,
  subscribeHdStatus,
} from '../storage/imageLoader.js';
import { escapeAttr, escapeHtml, icon, starSectorIcon } from './icons.js';

let activeLightboxPhotoId = null;
let activeLightboxLang = '';
let lightboxChromeHidden = true;
let lastPhotoIndex = -1;
let pendingSwipeOffsetPx = null;
let isClosingAnimated = false;

let liveZoom = 1;
let panX = 0;
let panY = 0;
let isDragging = false;
let isPinching = false;
let isTouchPanning = false;
let dragStartX = 0;
let dragStartY = 0;
let transformRafId = 0;

const slideCache = new Map();
const slideProgressById = new Map();
let hdHideTimer = 0;
let activeLightboxContainer = null;
let activeStoreRef = null;
let resizeBound = false;

function trimSlideCache(keepIds) {
  if (slideCache.size <= 7) return;
  for (const key of slideCache.keys()) {
    if (!keepIds.has(key)) {
      slideCache.delete(key);
      slideProgressById.delete(key);
      if (slideCache.size <= 7) break;
    }
  }
}

function clearAllSlideLoads() {
  clearTimeout(hdHideTimer);
  hdHideTimer = 0;
  if (transformRafId) {
    cancelAnimationFrame(transformRafId);
    transformRafId = 0;
  }
  slideProgressById.clear();
  slideCache.clear();
}

function updateHdFloatIndicator(container, visible, progress = 0) {
  const floatEl = container?.querySelector('[data-lb-hd-float]');
  if (!floatEl) return;
  const clamped = Math.max(0, Math.min(1, Number(progress) || 0));
  floatEl.style.setProperty('--hd-progress', clamped.toFixed(3));
  floatEl.setAttribute('aria-valuenow', String(Math.round(clamped * 100)));
  floatEl.classList.toggle('is-visible', Boolean(visible));
  floatEl.setAttribute('aria-hidden', String(!visible));
}

subscribeHdStatus(({ itemId, status, progress, src, fromMemory }) => {
  if (status === 'loading' || status === 'queued') {
    slideProgressById.set(itemId, progress);
  } else {
    slideProgressById.delete(itemId);
  }

  const slide = slideCache.get(itemId);
  if (slide && status === 'ready' && src && slide._imgEl) {
    slide._imgEl.referrerPolicy = 'no-referrer';
    slide._imgEl.dataset.hdLoaded = 'true';
    slide._imgEl.dataset.loadedSize = '3840';
    slide._imgEl.src = src;
    slide._imgEl.classList.add('is-loaded');
    slide._hdReady = true;
  }

  if (!activeLightboxContainer || activeStoreRef?.state?.lightboxPhotoId !== itemId) {
    return;
  }

  if (status === 'queued' || status === 'loading') {
    clearTimeout(hdHideTimer);
    updateHdFloatIndicator(activeLightboxContainer, true, Math.max(0.06, progress));
  } else if (status === 'ready') {
    clearTimeout(hdHideTimer);
    if (fromMemory) {
      updateHdFloatIndicator(activeLightboxContainer, false, 1);
    } else {
      updateHdFloatIndicator(activeLightboxContainer, true, 1);
      hdHideTimer = setTimeout(() => {
        hdHideTimer = 0;
        if (activeLightboxContainer && activeStoreRef?.state?.lightboxPhotoId === itemId) {
          updateHdFloatIndicator(activeLightboxContainer, false, 1);
        }
      }, 180);
    }
  } else {
    clearTimeout(hdHideTimer);
    updateHdFloatIndicator(activeLightboxContainer, false, 0);
  }
});

function getTouchDistance(t1, t2) {
  return Math.hypot(t2.clientX - t1.clientX, t2.clientY - t1.clientY);
}

function getCssEscape(val) {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') {
    return CSS.escape(val);
  }
  return String(val).replace(/["\\]/g, '\\$&');
}

function resolveItemIntrinsicSize(item, fallbackImg = null) {
  const metaW = Number(item?.imageMediaMetadata?.width || item?.videoMediaMetadata?.width || 0);
  const metaH = Number(item?.imageMediaMetadata?.height || item?.videoMediaMetadata?.height || 0);
  if (metaW > 0 && metaH > 0) {
    return { width: metaW, height: metaH, hasExactMeta: true };
  }
  if (fallbackImg && fallbackImg.naturalWidth > 0 && fallbackImg.naturalHeight > 0) {
    return {
      width: fallbackImg.naturalWidth,
      height: fallbackImg.naturalHeight,
      hasExactMeta: false,
    };
  }
  const cardImg = item?.id
    ? document.querySelector(`.photo-card[data-photo-id="${getCssEscape(item.id)}"] img`)
    : null;
  if (cardImg && cardImg.naturalWidth > 0 && cardImg.naturalHeight > 0) {
    return { width: cardImg.naturalWidth, height: cardImg.naturalHeight, hasExactMeta: false };
  }
  return { width: 1600, height: 1067, hasExactMeta: false };
}

function computeFittedMediaBox(container, item, imgEl = null) {
  const stage = container?.querySelector('.lightbox-stage');
  const stageW = stage?.clientWidth || window.innerWidth || 1280;
  const stageH = stage?.clientHeight || window.innerHeight || 800;
  const padX = stageW <= 640 ? 8 : 24;
  const padY = stageW <= 640 ? 12 : 20;
  const availW = Math.max(120, stageW - padX * 2);
  const availH = Math.max(120, stageH - padY * 2);

  const { width, height, hasExactMeta } = resolveItemIntrinsicSize(item, imgEl);
  const ratio = width > 0 && height > 0 ? width / height : 1.5;

  const maxW = hasExactMeta && width >= 320 ? Math.min(availW, width) : availW;
  const maxH = hasExactMeta && height >= 320 ? Math.min(availH, height) : availH;

  let boxW = maxW;
  let boxH = boxW / ratio;
  if (boxH > maxH) {
    boxH = maxH;
    boxW = boxH * ratio;
  }

  return {
    width: Math.max(80, Math.round(boxW)),
    height: Math.max(80, Math.round(boxH)),
    stageW,
    stageH,
  };
}

function applySlideMediaBox(container, slide) {
  const imgEl = slide?._imgEl;
  const item = slide?._itemRef;
  if (!imgEl || !item) return null;
  const box = computeFittedMediaBox(container, item, imgEl);
  const nextW = `${box.width}px`;
  const nextH = `${box.height}px`;
  if (imgEl.style.width !== nextW) imgEl.style.width = nextW;
  if (imgEl.style.height !== nextH) imgEl.style.height = nextH;
  slide._fittedBox = box;
  return box;
}

function applyImageTransformNow(container) {
  transformRafId = 0;
  if (!container) return;
  const curSlide = activeLightboxPhotoId ? slideCache.get(activeLightboxPhotoId) : null;
  const img = curSlide?._imgEl || container.querySelector('.lightbox-img');
  if (!img) return;
  const interacting = isDragging || isPinching || isTouchPanning;
  img.style.transition = interacting ? 'none' : 'transform 140ms cubic-bezier(0.22, 1, 0.36, 1)';
  if (liveZoom <= 1) {
    panX = 0;
    panY = 0;
    img.style.cursor = 'grab';
    img.style.transform = 'translate3d(0px, 0px, 0) scale(1)';
  } else {
    img.style.cursor = isDragging ? 'grabbing' : 'grab';
    img.style.transform = `translate3d(${Math.round(panX * 2) / 2}px, ${Math.round(panY * 2) / 2}px, 0) scale(${liveZoom})`;
  }
}

function scheduleImageTransform(container, immediate = false) {
  if (immediate) {
    if (transformRafId) {
      cancelAnimationFrame(transformRafId);
      transformRafId = 0;
    }
    applyImageTransformNow(container);
    return;
  }
  if (transformRafId) return;
  transformRafId = requestAnimationFrame(() => applyImageTransformNow(container));
}

function setLiveZoom(container, store, nextZoom, immediate = false) {
  const clamped = Math.max(1, Math.min(3, Number(nextZoom.toFixed(2))));
  liveZoom = clamped;
  if (store?.state) {
    store.state.lightboxZoom = clamped;
  }
  if (clamped <= 1) {
    panX = 0;
    panY = 0;
  }
  const zoomLabel = container?.querySelector('[data-lb-zoom-label]');
  if (zoomLabel) {
    zoomLabel.textContent = `${Math.round(clamped * 100)}%`;
  }
  scheduleImageTransform(container, immediate);
}

function computeFlipFromGridCard(container, fileId, targetBoxWidth = 0) {
  const stage = container.querySelector('.lightbox-stage');
  const card = document.querySelector(`.photo-card[data-photo-id="${getCssEscape(fileId)}"]`);
  if (!stage || !card) return null;
  const stageRect = stage.getBoundingClientRect();
  const cardRect = card.getBoundingClientRect();
  if (!stageRect.width || !cardRect.width) return null;

  // Only animate to card position if the card actually overlaps the visible viewport
  const vh = window.innerHeight || stageRect.height;
  if (cardRect.bottom < -20 || cardRect.top > vh + 20) {
    return null;
  }

  const dx = Math.round(cardRect.left + cardRect.width / 2 - (stageRect.left + stageRect.width / 2));
  const dy = Math.round(cardRect.top + cardRect.height / 2 - (stageRect.top + stageRect.height / 2));
  const refW = targetBoxWidth > 0 ? targetBoxWidth : stageRect.width * 0.86;
  const scale = Math.max(0.16, Math.min(0.94, cardRect.width / refW));
  return { dx, dy, scale: Number(scale.toFixed(3)) };
}

function acquireSlideElement(item, role, state, store) {
  const isCurrent = role === 'current';
  const isVideo = Boolean(item.mimeType && item.mimeType.startsWith('video/'));

  if (isVideo && !item.isDemo && isCurrent) {
    const slide = document.createElement('div');
    slide.className = `lightbox-slide is-${role}`;
    slide.dataset.photoId = item.id;
    slide.innerHTML =
      state.authType === 'apikey' && !state.accessToken
        ? `<div class="lightbox-media-wrap"><iframe class="lightbox-video" style="width:85vw;height:72vh;border:0" src="https://drive.google.com/file/d/${encodeURIComponent(item.id)}/preview" allow="autoplay; fullscreen" allowfullscreen></iframe></div>`
        : `<div class="lightbox-media-wrap"><video class="lightbox-video" controls autoplay playsinline></video></div>`;

    const videoEl = slide.querySelector('video.lightbox-video');
    if (videoEl && state.accessToken) {
      fetchAuthorizedMediaBlobUrl(item.id, state.accessToken)
        .then((blobUrl) => {
          if (videoEl.isConnected) videoEl.src = blobUrl;
        })
        .catch(() => store.toast(t('lightbox.videoLoadError'), 'error'));
    }
    return slide;
  }

  let slide = slideCache.get(item.id);
  if (!slide) {
    slide = document.createElement('div');
    slide.className = 'lightbox-slide';
    slide.dataset.photoId = item.id;
    if (isVideo && item.isDemo) {
      slide.innerHTML = `
        <div class="lightbox-media-wrap">
          <div style="position:relative;max-width:100%;max-height:100%;display:flex;flex-direction:column;align-items:center;gap:10px">
            <img class="lightbox-adj-img" alt="${escapeAttr(item.name)}" draggable="false" />
            <div class="sync-pill">${escapeHtml(t('lightbox.demoVideoNotice'))}</div>
          </div>
        </div>
      `;
    } else {
      slide.innerHTML = `
        <div class="lightbox-media-wrap">
          <img class="lightbox-adj-img" alt="${escapeAttr(item.name)}" draggable="false" />
        </div>
      `;
    }
    slide._imgEl = slide.querySelector('img');
    slide._previewRequested = false;
    slide._hdReady = false;
    slideCache.set(item.id, slide);
  }

  slide.className = `lightbox-slide is-${role}`;
  slide.style.transition = '';
  slide.style.transform = '';
  slide.style.opacity = '';

  const imgEl = slide._imgEl;
  if (imgEl) {
    imgEl.classList.toggle('lightbox-img', isCurrent);
    imgEl.classList.toggle('lightbox-adj-img', !isCurrent);
    if (!isCurrent) {
      imgEl.style.transform = '';
      imgEl.style.transition = '';
    }
  }
  slide._itemRef = item;

  return slide;
}

function ensureSlidePreview(slide, store) {
  const imgEl = slide?._imgEl;
  const item = slide?._itemRef;
  if (!imgEl || !item || !imgEl.isConnected) return;

  const memHd = hasCachedHdSrc(item);
  if (memHd) {
    if (imgEl.getAttribute('src') !== memHd) {
      imgEl.referrerPolicy = 'no-referrer';
      imgEl.src = memHd;
    }
    imgEl.dataset.hdLoaded = 'true';
    imgEl.dataset.loadedSize = '3840';
    imgEl.classList.add('is-loaded');
    slide._hdReady = true;
    return;
  }

  const instant = getInstantCachedSrc(item);
  if (instant && !imgEl.getAttribute('src')) {
    imgEl.referrerPolicy = 'no-referrer';
    imgEl.src = instant;
    imgEl.classList.add('is-loaded');
  }

  if (!slide._previewRequested && !slide._hdReady) {
    slide._previewRequested = true;
    loadPhotoIntoElement(imgEl, item, {
      size: 800,
      eager: true,
      getAccessToken: () => store.state.accessToken,
      getApiKey: () => store.state.apiKey,
    });
  }
}

function syncCurrentSlideHdIndicator(container, item) {
  clearTimeout(hdHideTimer);
  const isVideo = Boolean(item?.mimeType && item.mimeType.startsWith('video/'));
  if (!item || item.isDemo || isVideo || hasCachedHdSrc(item)) {
    updateHdFloatIndicator(container, false, 1);
    return;
  }
  const activeProg = slideProgressById.get(item.id);
  updateHdFloatIndicator(container, true, activeProg !== undefined ? Math.max(0.06, activeProg) : 0.06);
}

function renderLazyFilmstrip(container, store, visiblePhotos, activeFileId, activeIdx) {
  if (lightboxChromeHidden) return;
  const stripEl = container.querySelector('.lightbox-filmstrip');
  if (!stripEl) return;

  const total = visiblePhotos.length;
  const WINDOW_HALF = 18;
  const start = Math.max(0, (activeIdx >= 0 ? activeIdx : 0) - WINDOW_HALF);
  const end = Math.min(total, start + WINDOW_HALF * 2);
  const winKey = `${total}:${start}:${end}`;

  if (stripEl.dataset.winKey !== winKey) {
    stripEl.dataset.winKey = winKey;
    const slice = visiblePhotos.slice(start, end);
    stripEl.innerHTML = slice
      .map(
        (p) => `
        <button type="button" class="filmstrip-thumb ${p.id === activeFileId ? 'active' : ''}" data-lb="jump" data-photo-id="${escapeAttr(p.id)}" title="${escapeAttr(p.name)}">
          <img alt="" data-film-id="${escapeAttr(p.id)}" />
        </button>
      `
      )
      .join('');
    const byId = new Map(slice.map((p) => [p.id, p]));
    for (const simg of stripEl.querySelectorAll('img[data-film-id]')) {
      const p = byId.get(simg.dataset.filmId);
      if (p) {
        loadPhotoIntoElement(simg, p, {
          size: 240,
          getAccessToken: () => store.state.accessToken,
          getApiKey: () => store.state.apiKey,
        });
      }
    }
  } else {
    for (const th of stripEl.querySelectorAll('.filmstrip-thumb')) {
      th.classList.toggle('active', th.dataset.photoId === activeFileId);
    }
  }

  const activeThumb = stripEl.querySelector('.filmstrip-thumb.active');
  if (activeThumb && stripEl.clientWidth > 0) {
    const targetLeft =
      activeThumb.offsetLeft - (stripEl.clientWidth - activeThumb.offsetWidth) * 0.5;
    stripEl.scrollLeft = Math.max(0, Math.round(targetLeft));
  }
}

function buildLightboxRatingOptions() {
  return [1, 2, 3, 4, 5]
    .map(
      (n) => `
      <button type="button" class="btn btn-sm" data-lb="rate" data-rating="${n}"
        aria-pressed="false" aria-label="${escapeAttr(t('lightbox.rateTitle', { n }))}">
        ${starSectorIcon(n, 16)}<span>${n}</span>
      </button>
    `
    )
    .join('');
}

function buildLightboxTools() {
  return `
    <div class="lightbox-action-bar lightbox-glass-pill">
      <button type="button" class="btn btn-sm btn-icon" data-lb="toggle-rating" data-lb-popover
        aria-label="${escapeAttr(t('lightbox.ratingTitle'))}" aria-controls="lightboxRating" aria-expanded="false">
        <span class="lightbox-rating-star" data-lb-star-icon aria-hidden="true">${starSectorIcon(0, 18)}</span>
      </button>
      <button
        type="button"
        class="btn btn-sm btn-icon"
        data-lb="toggle-fav"
        aria-label="${escapeAttr(t('inspector.favorite'))}"
        aria-pressed="false"
        title="${escapeAttr(t('lightbox.favTitle'))}"
      >${icon('heart', 18)}</button>
      <button type="button" class="btn btn-sm btn-icon" data-lb="quick-tag" aria-label="${escapeAttr(t('lightbox.addTagBtn'))}" title="${escapeAttr(t('lightbox.addTagBtn'))}">${icon('tag', 18)}</button>
    </div>
    <section id="lightboxRating" class="lightbox-popover lightbox-rating-menu lightbox-glass-pill hidden" aria-labelledby="lightboxRatingTitle">
      <h2 id="lightboxRatingTitle">${escapeHtml(t('lightbox.ratingTitle'))}</h2>
      <div class="lightbox-rating-options">${buildLightboxRatingOptions()}</div>
      <button type="button" class="btn btn-sm lightbox-popover-action" data-lb="rate" data-rating="0" disabled>
        ${icon('undo', 15)}<span>${escapeHtml(t('lightbox.clearRating'))}</span>
      </button>
    </section>
  `;
}

function buildLightboxShell(container, zoom) {
  container.innerHTML = `
    <div class="lightbox chrome-hidden">
      <div
        class="lightbox-hd-float"
        data-lb-hd-float
        role="progressbar"
        aria-label="${escapeAttr(t('lightbox.loadingHd'))}"
        aria-valuemin="0"
        aria-valuemax="100"
        aria-valuenow="0"
        aria-hidden="true"
      >
        <svg class="lightbox-hd-ring" width="22" height="22" viewBox="0 0 24 24" aria-hidden="true">
          <circle class="lightbox-hd-ring-track" cx="12" cy="12" r="9" />
          <circle class="lightbox-hd-ring-bar" cx="12" cy="12" r="9" />
        </svg>
      </div>
      <div class="lightbox-topbar">
        <div style="display:flex;align-items:center;gap:8px;min-width:0;">
          <button type="button" class="btn btn-sm btn-icon lightbox-glass-pill" data-lb="close" title="${escapeAttr(t('lightbox.close'))}" aria-label="${escapeAttr(t('lightbox.back'))}">
            ${icon('chevronLeft', 20)}
          </button>
          <span class="photo-count-badge lightbox-glass-pill" data-lb-counter>1 / 1</span>
          <span class="hide-xs lightbox-filename" data-lb-filename></span>
        </div>
        <div class="lightbox-glass-pill lightbox-right-actions">
          <span data-lb-zoom-controls style="display:inline-flex;align-items:center;gap:3px">
            <button type="button" class="btn btn-sm btn-ghost btn-icon hide-xs" data-lb="zoom-out" title="${escapeAttr(t('lightbox.zoomOut'))}">${icon('zoomOut', 14)}</button>
            <button type="button" class="btn btn-sm btn-ghost" data-lb="zoom-reset" data-lb-zoom-label>${Math.round(zoom * 100)}%</button>
            <button type="button" class="btn btn-sm btn-ghost btn-icon hide-xs" data-lb="zoom-in" title="${escapeAttr(t('lightbox.zoomIn'))}">${icon('zoomIn', 14)}</button>
          </span>
          <button type="button" class="btn btn-sm btn-ghost btn-icon" data-lb="toggle-info" data-lb-popover aria-controls="lightboxInfo" aria-expanded="false" title="${escapeAttr(t('lightbox.toggleInfoTitle'))}" aria-label="${escapeAttr(t('lightbox.info'))}">${icon('info', 14)}</button>
          <button type="button" class="btn btn-sm btn-ghost btn-icon" data-lb="download" title="${escapeAttr(t('lightbox.download'))}" aria-label="${escapeAttr(t('lightbox.download'))}">${icon('download', 14)}</button>
        </div>
        <section id="lightboxInfo" class="lightbox-popover lightbox-info lightbox-glass-pill hidden" aria-labelledby="lightboxInfoTitle">
          <h2 id="lightboxInfoTitle">${escapeHtml(t('mobile.inspectorTitle'))}</h2>
          <div class="lightbox-info-rating">
            ${starSectorIcon(5, 15)}<span data-lb-average></span>
          </div>
          <div class="lightbox-info-tags">
            <h3>${escapeHtml(t('lightbox.tags'))}</h3>
            <div class="lightbox-tag-list" data-lb-tags></div>
          </div>
          <button type="button" class="btn btn-sm lightbox-popover-action lightbox-full-details" data-lb="open-inspector">
            <span>${escapeHtml(t('lightbox.fullDetails'))}</span>${icon('chevronRight', 14)}
          </button>
        </section>
      </div>

      <div class="lightbox-stage">
        <button type="button" class="lightbox-nav prev" data-lb="prev" title="${escapeAttr(t('lightbox.prev'))}">${icon('chevronLeft', 24)}</button>
        <div class="lightbox-track" data-lb-track></div>
        <button type="button" class="lightbox-nav next" data-lb="next" title="${escapeAttr(t('lightbox.next'))}">${icon('chevronRight', 24)}</button>
      </div>

      <div class="lightbox-bottom">
        <div class="lightbox-hud">${buildLightboxTools()}</div>
        <div class="lightbox-filmstrip"></div>
      </div>
    </div>
  `;
}

export function renderLightbox(container, store, visiblePhotos) {
  if (!container) return;
  activeLightboxContainer = container;
  activeStoreRef = store;
  const state = store.state;
  const photoId = state.lightboxPhotoId;

  if (!photoId) {
    activeLightboxContainer = null;
    activeLightboxPhotoId = null;
    activeLightboxLang = '';
    lightboxChromeHidden = true;
    lastPhotoIndex = -1;
    pendingSwipeOffsetPx = null;
    isClosingAnimated = false;
    liveZoom = 1;
    panX = 0;
    panY = 0;
    isDragging = false;
    isPinching = false;
    isTouchPanning = false;
    clearAllSlideLoads();
    container.classList.add('hidden');
    container.innerHTML = '';
    return;
  }

  const file = state.files.find((f) => f.id === photoId);
  if (!file) {
    store.closeLightbox();
    return;
  }

  container.classList.remove('hidden');

  const idx = visiblePhotos.findIndex((p) => p.id === photoId);
  const total = visiblePhotos.length;
  const meta = store.getAggregatedItemMeta(file.id);
  const schemaTags = state.tagSchema?.tags || {};
  const isVideo = Boolean(file.mimeType && file.mimeType.startsWith('video/'));

  const wasClosed = activeLightboxPhotoId === null;
  if (wasClosed) {
    lightboxChromeHidden = true;
    liveZoom = state.lightboxZoom || 1;
  }

  if (!container.querySelector('.lightbox') || activeLightboxLang !== state.lang) {
    buildLightboxShell(container, liveZoom);
    activeLightboxLang = state.lang;
  }

  const rootEl = container.querySelector('.lightbox');
  if (rootEl) {
    rootEl.classList.toggle('chrome-hidden', lightboxChromeHidden);
  }

  const isSamePhoto = activeLightboxPhotoId === file.id;
  if (!isSamePhoto) {
    liveZoom = state.lightboxZoom || 1;
  }

  const tagsHtml = meta.activeTagIds
    .map((tid) => {
      const tdef = schemaTags[tid];
      if (!tdef) return '';
      return `
        <span class="tag-chip tag-color-${escapeAttr(tdef.color || 'blue')}">
          <span class="tag-dot tag-color-${escapeAttr(tdef.color || 'blue')}"></span>
          <span class="lightbox-tag-name" title="${escapeAttr(tdef.name)}">${escapeHtml(tdef.name)}</span>
          <button type="button" class="tag-chip-remove" data-lb="remove-tag" data-tag-id="${escapeAttr(tid)}" aria-label="${escapeAttr(t('inspector.removeTag'))}">${icon('x', 12)}</button>
        </span>
      `;
    })
    .join('');

  const avgText =
    meta.avgRating > 0
      ? t('lightbox.avgSummary', { avg: meta.avgRating.toFixed(1), count: meta.ratingCount })
      : t('lightbox.unrated');

  const zoomLabel = container.querySelector('[data-lb-zoom-label]');
  if (zoomLabel) zoomLabel.textContent = `${Math.round(liveZoom * 100)}%`;

  const zoomControls = container.querySelector('[data-lb-zoom-controls]');
  if (zoomControls) zoomControls.classList.toggle('hidden', isVideo);

  const ratingBtn = container.querySelector('[data-lb="toggle-rating"]');
  const ratingIconWrap = container.querySelector('[data-lb-star-icon]');
  const ratingLabel = t('lightbox.ratingValue', { n: meta.myRating });
  if (ratingBtn) {
    ratingBtn.setAttribute('aria-label', ratingLabel);
    ratingBtn.title = ratingLabel;
    ratingBtn.classList.toggle('has-rating', meta.myRating > 0);
  }
  if (ratingIconWrap && ratingIconWrap.dataset.rating !== String(meta.myRating)) {
    ratingIconWrap.dataset.rating = String(meta.myRating);
    ratingIconWrap.innerHTML = starSectorIcon(meta.myRating, 18);
  }

  for (const option of container.querySelectorAll('.lightbox-rating-options [data-rating]')) {
    option.setAttribute('aria-pressed', String(Number(option.dataset.rating) === meta.myRating));
  }
  container.querySelector('[data-lb="rate"][data-rating="0"]').disabled = meta.myRating === 0;
  const favoriteBtn = container.querySelector('[data-lb="toggle-fav"]');
  if (favoriteBtn.getAttribute('aria-pressed') !== String(meta.myFavorite)) {
    favoriteBtn.setAttribute('aria-pressed', String(meta.myFavorite));
    favoriteBtn.innerHTML = icon(meta.myFavorite ? 'heartFilled' : 'heart', 18);
  }
  container.querySelector('[data-lb-average]').textContent = avgText;
  container.querySelector('[data-lb-tags]').innerHTML =
    tagsHtml || `<span class="lightbox-tags-empty">${escapeHtml(t('lightbox.noTags'))}</span>`;

  if (isSamePhoto) {
    renderLazyFilmstrip(container, store, visiblePhotos, file.id, idx);
    scheduleImageTransform(container, true);
    return;
  }

  const prevIndex = lastPhotoIndex;
  activeLightboxPhotoId = file.id;
  lastPhotoIndex = idx;
  panX = 0;
  panY = 0;

  const counterEl = container.querySelector('[data-lb-counter]');
  if (counterEl) {
    counterEl.textContent = idx >= 0 ? `${idx + 1} / ${total}` : t('lightbox.preview');
  }
  const filenameEl = container.querySelector('[data-lb-filename]');
  if (filenameEl) {
    filenameEl.textContent = file.name || '';
  }

  const prevBtn = container.querySelector('[data-lb="prev"]');
  const nextBtn = container.querySelector('[data-lb="next"]');
  if (prevBtn) prevBtn.disabled = idx <= 0;
  if (nextBtn) nextBtn.disabled = idx >= total - 1 || idx === -1;

  const trackEl = container.querySelector('[data-lb-track]');
  const prevItem = idx > 0 ? visiblePhotos[idx - 1] : null;
  const nextItem = idx >= 0 && idx < total - 1 ? visiblePhotos[idx + 1] : null;
  const lookaheadNext = idx >= 0 && idx + 2 < total ? visiblePhotos[idx + 2] : null;

  if (trackEl) {
    const prevSlideEl = prevItem ? acquireSlideElement(prevItem, 'prev', state, store) : null;
    const curSlideEl = acquireSlideElement(file, 'current', state, store);
    const nextSlideEl = nextItem ? acquireSlideElement(nextItem, 'next', state, store) : null;
    const slides = [prevSlideEl, curSlideEl, nextSlideEl].filter(Boolean);

    trackEl.style.transition = 'none';
    trackEl.style.transform = 'translate3d(0px, 0px, 0px)';
    trackEl.replaceChildren(...slides);

    let currentBox = null;
    for (const sl of slides) {
      const box = applySlideMediaBox(container, sl);
      if (sl === curSlideEl) currentBox = box;
      ensureSlidePreview(sl, store);
    }
    syncCurrentSlideHdIndicator(container, file);

    const keepIds = new Set(
      [
        prevItem?.id,
        file.id,
        nextItem?.id,
        lookaheadNext?.id,
        idx >= 0 && idx + 3 < total ? visiblePhotos[idx + 3]?.id : null,
      ].filter(Boolean)
    );
    trimSlideCache(keepIds);

    if (wasClosed) {
      const curSlide = curSlideEl;
      const flip = computeFlipFromGridCard(container, file.id, currentBox?.width || 0);
      if (rootEl && curSlide) {
        rootEl.style.transition = 'none';
        rootEl.style.opacity = '0';
        curSlide.style.transition = 'none';
        curSlide.style.transform = flip
          ? `translate3d(${flip.dx}px, ${flip.dy}px, 0) scale(${flip.scale})`
          : 'translate3d(0px, 10px, 0) scale(0.92)';
        void curSlide.offsetWidth;
        rootEl.style.transition = 'opacity 200ms cubic-bezier(0.32, 0.72, 0, 1)';
        rootEl.style.opacity = '1';
        curSlide.style.transition = 'transform 230ms cubic-bezier(0.32, 0.72, 0, 1)';
        curSlide.style.transform = 'translate3d(0px, 0px, 0) scale(1)';
      }
    } else if (pendingSwipeOffsetPx !== null || (prevIndex !== -1 && idx !== -1 && prevIndex !== idx)) {
      const stageW = container.querySelector('.lightbox-stage')?.clientWidth || window.innerWidth;
      const stepDir = idx > prevIndex ? 1 : -1;
      const startX =
        pendingSwipeOffsetPx !== null
          ? pendingSwipeOffsetPx
          : stepDir * Math.min(stageW + 16, 440);
      pendingSwipeOffsetPx = null;
      trackEl.style.transition = 'none';
      trackEl.style.transform = `translate3d(${Math.round(startX)}px, 0px, 0px)`;
      void trackEl.offsetWidth;
      trackEl.style.transition = 'transform 200ms cubic-bezier(0.32, 0.72, 0, 1)';
      trackEl.style.transform = 'translate3d(0px, 0px, 0px)';
    }
  }

  pendingSwipeOffsetPx = null;
  renderLazyFilmstrip(container, store, visiblePhotos, file.id, idx);
}

export function closeLightboxWithAnimation(container, store) {
  if (!store?.state?.lightboxPhotoId) return;
  if (!container) {
    store.closeLightbox();
    return;
  }
  if (isClosingAnimated) return;
  if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
    store.closeLightbox();
    return;
  }
  const rootEl = container.querySelector('.lightbox');
  const curSlide = container.querySelector('.lightbox-slide.is-current');
  const pid = store.state.lightboxPhotoId;
  if (!rootEl || !curSlide) {
    store.closeLightbox();
    return;
  }

  const cachedSlide = pid ? slideCache.get(pid) : null;
  const targetW = cachedSlide?._fittedBox?.width || 0;
  const flip = pid ? computeFlipFromGridCard(container, pid, targetW) : null;

  isClosingAnimated = true;
  rootEl.classList.add('chrome-hidden');
  rootEl.style.transition = 'opacity 180ms cubic-bezier(0.32, 0.72, 0, 1)';
  rootEl.style.opacity = '0';
  curSlide.style.transition = 'transform 185ms cubic-bezier(0.32, 0.72, 0, 1)';
  curSlide.style.transform = flip
    ? `translate3d(${flip.dx}px, ${flip.dy}px, 0) scale(${flip.scale})`
    : 'translate3d(0px, 12px, 0) scale(0.91)';

  setTimeout(() => {
    isClosingAnimated = false;
    store.closeLightbox();
  }, 185);
}

export function dismissLightboxPopover(container) {
  const trigger = container?.querySelector('[data-lb-popover][aria-expanded="true"]');
  if (!trigger) return false;
  const panel = document.getElementById(trigger.getAttribute('aria-controls'));
  if (panel?.contains(document.activeElement)) trigger.focus({ preventScroll: true });
  trigger.setAttribute('aria-expanded', 'false');
  panel?.classList.add('hidden');
  return true;
}

function toggleLightboxPopover(container, trigger, store) {
  if (!trigger) return;
  const wasOpen = trigger.getAttribute('aria-expanded') === 'true';
  dismissLightboxPopover(container);
  if (wasOpen) return;

  lightboxChromeHidden = false;
  container.querySelector('.lightbox')?.classList.remove('chrome-hidden');
  if (store && activeLightboxPhotoId) {
    const visible = store.getVisiblePhotos();
    const idx = visible.findIndex((p) => p.id === activeLightboxPhotoId);
    renderLazyFilmstrip(container, store, visible, activeLightboxPhotoId, idx);
  }
  trigger.setAttribute('aria-expanded', 'true');
  document.getElementById(trigger.getAttribute('aria-controls'))?.classList.remove('hidden');
}

export function toggleLightboxInfo(container) {
  toggleLightboxPopover(
    container,
    container.querySelector('[data-lb="toggle-info"]'),
    activeStoreRef
  );
}

export function bindLightboxEvents(container, store) {
  if (!container) return;

  if (!resizeBound && typeof window !== 'undefined') {
    resizeBound = true;
    let resizeRaf = 0;
    window.addEventListener('resize', () => {
      if (!activeLightboxContainer || !activeLightboxPhotoId) return;
      cancelAnimationFrame(resizeRaf);
      resizeRaf = requestAnimationFrame(() => {
        if (!activeLightboxContainer) return;
        for (const sl of activeLightboxContainer.querySelectorAll('.lightbox-slide')) {
          const cached = slideCache.get(sl.dataset.photoId);
          if (cached) applySlideMediaBox(activeLightboxContainer, cached);
        }
      });
    });
  }

  let pinchStartDist = 0;
  let pinchStartZoom = 1;
  let swipeStartX = 0;
  let swipeStartY = 0;
  let swipeStartTime = 0;
  let panStartX = 0;
  let panStartY = 0;
  let touchMoved = false;
  let gestureAxis = null;
  let lastDragDx = 0;
  let lastDragDy = 0;
  let lastTapTime = 0;
  let lastTapX = 0;
  let lastTapY = 0;
  let suppressNextDblClickUntil = 0;
  let suppressWrapClickUntil = 0;
  let singleTapTimer = 0;
  let didDragPan = false;
  let mouseSwipeDragging = false;
  let mouseSwipeAxis = null;
  let mouseLastDx = 0;
  let trackMoveRafId = 0;
  let pendingTrackDx = 0;

  function setInteracting(active) {
    container.querySelector('.lightbox')?.classList.toggle('is-interacting', active);
  }

  function scheduleTrackTranslate(dx) {
    pendingTrackDx = dx;
    if (trackMoveRafId) return;
    trackMoveRafId = requestAnimationFrame(() => {
      trackMoveRafId = 0;
      const trackEl = container.querySelector('[data-lb-track]');
      if (trackEl) {
        trackEl.style.transition = 'none';
        trackEl.style.transform = `translate3d(${Math.round(pendingTrackDx)}px, 0px, 0px)`;
      }
    });
  }

  function toggleChrome() {
    if (dismissLightboxPopover(container)) return;
    lightboxChromeHidden = !lightboxChromeHidden;
    container.querySelector('.lightbox')?.classList.toggle('chrome-hidden', lightboxChromeHidden);
    if (!lightboxChromeHidden && activeLightboxPhotoId) {
      const visible = store.getVisiblePhotos();
      const idx = visible.findIndex((p) => p.id === activeLightboxPhotoId);
      renderLazyFilmstrip(container, store, visible, activeLightboxPhotoId, idx);
    }
  }

  function stepWithSwipe(delta, dragDx = 0) {
    if (trackMoveRafId) {
      cancelAnimationFrame(trackMoveRafId);
      trackMoveRafId = 0;
    }
    const visible = store.getVisiblePhotos();
    const curIdx = visible.findIndex((p) => p.id === store.state.lightboxPhotoId);
    const targetIdx = curIdx + delta;
    if (curIdx === -1 || targetIdx < 0 || targetIdx >= visible.length) {
      const trackEl = container.querySelector('[data-lb-track]');
      if (trackEl) {
        trackEl.style.transition = 'transform 200ms cubic-bezier(0.32, 0.72, 0, 1)';
        trackEl.style.transform = 'translate3d(0px, 0px, 0px)';
      }
      return false;
    }
    const stageW = container.querySelector('.lightbox-stage')?.clientWidth || window.innerWidth;
    pendingSwipeOffsetPx = delta * (stageW + 16) + dragDx;
    store.stepPhoto(delta);
    return true;
  }

  container.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-lb]');
    if (
      !e.target.closest('.lightbox-popover, [data-lb-popover]') &&
      dismissLightboxPopover(container) &&
      !btn
    ) {
      return;
    }
    if (btn) {
      clearTimeout(singleTapTimer);
      singleTapTimer = 0;
      const act = btn.dataset.lb;
      const pid = store.state.lightboxPhotoId;
      if (act === 'close') closeLightboxWithAnimation(container, store);
      else if (act === 'prev') store.stepPhoto(-1);
      else if (act === 'next') store.stepPhoto(1);
      else if (act === 'jump') store.openLightbox(btn.dataset.photoId);
      else if (act === 'rate' && pid) {
        const r = Number(btn.dataset.rating || 0);
        dismissLightboxPopover(container);
        if (r !== store.getAggregatedItemMeta(pid).myRating) store.setRating([pid], r);
      } else if (act === 'toggle-fav' && pid) {
        store.toggleFavorite([pid]);
      } else if (act === 'remove-tag' && pid) {
        store.toggleTagOnPhotos([pid], btn.dataset.tagId, false);
      } else if (act === 'quick-tag' && pid) {
        store.openModal('quickTag', { photoIds: [pid] });
      } else if (act === 'toggle-info' || act === 'toggle-rating') {
        toggleLightboxPopover(container, btn, store);
      } else if (act === 'open-inspector') {
        store.setState({ inspectorOpen: true, sidebarOpen: false });
        store.closeLightbox();
      } else if (act === 'download' && pid) {
        const file = store.state.files.find((f) => f.id === pid);
        if (file) {
          downloadOriginalFile(file, store.state.accessToken, store.state.apiKey).catch((err) =>
            store.toast(err?.message || t('inspector.downloadFailed'), 'error')
          );
        }
      } else if (act === 'zoom-in') {
        setLiveZoom(container, store, liveZoom + 0.5, true);
      } else if (act === 'zoom-out') {
        setLiveZoom(container, store, liveZoom - 0.5, true);
      } else if (act === 'zoom-reset') {
        setLiveZoom(container, store, liveZoom > 1 ? 1 : 2, true);
      }
      return;
    }

    if (Date.now() < suppressWrapClickUntil || didDragPan) return;
    const clickedStageMedia =
      Boolean(e.target.closest('.lightbox-media-wrap, .lightbox-track')) &&
      !e.target.closest('button, a, video, iframe, .lightbox-popover');
    if (clickedStageMedia && Date.now() >= suppressNextDblClickUntil) {
      clearTimeout(singleTapTimer);
      singleTapTimer = setTimeout(() => {
        singleTapTimer = 0;
        toggleChrome();
      }, 250);
    }
  });

  container.addEventListener('dblclick', (e) => {
    clearTimeout(singleTapTimer);
    singleTapTimer = 0;
    if (Date.now() < suppressNextDblClickUntil) return;
    if (e.target.classList.contains('lightbox-img')) {
      setLiveZoom(container, store, liveZoom > 1 ? 1 : 2, true);
    }
  });

  let wheelIdleTimer = 0;
  container.addEventListener(
    'wheel',
    (e) => {
      if (!store.state.lightboxPhotoId) return;
      if (!e.target.closest('.lightbox-stage')) return;
      if (e.target.closest('video, iframe')) return;
      e.preventDefault();
      setInteracting(true);
      clearTimeout(wheelIdleTimer);
      wheelIdleTimer = setTimeout(() => setInteracting(false), 160);

      const step = e.deltaY < 0 ? 0.25 : -0.25;
      const next = Math.max(1, Math.min(3, Number((liveZoom + step).toFixed(2))));
      if (next !== liveZoom) {
        setLiveZoom(container, store, next, false);
      }
    },
    { passive: false }
  );

  container.addEventListener('mousedown', (e) => {
    if (e.button !== 0 || !store.state.lightboxPhotoId) return;
    if (
      !e.target.closest('.lightbox-stage') ||
      e.target.closest('.lightbox-nav, button, video, iframe')
    ) {
      return;
    }
    didDragPan = false;
    swipeStartX = e.clientX;
    swipeStartY = e.clientY;
    swipeStartTime = performance.now();
    setInteracting(true);
    if (liveZoom > 1) {
      isDragging = true;
      dragStartX = e.clientX - panX;
      dragStartY = e.clientY - panY;
      scheduleImageTransform(container, true);
    } else {
      mouseSwipeDragging = true;
      mouseSwipeAxis = null;
      mouseLastDx = 0;
    }
  });

  window.addEventListener('mousemove', (e) => {
    if (isDragging) {
      if (
        Math.abs(e.clientX - (panX + dragStartX)) > 3 ||
        Math.abs(e.clientY - (panY + dragStartY)) > 3
      ) {
        didDragPan = true;
      }
      panX = e.clientX - dragStartX;
      panY = e.clientY - dragStartY;
      scheduleImageTransform(container, false);
      return;
    }
    if (!mouseSwipeDragging) return;
    const dx = e.clientX - swipeStartX;
    const dy = e.clientY - swipeStartY;
    if (!mouseSwipeAxis && (Math.abs(dx) > 6 || Math.abs(dy) > 6)) {
      didDragPan = true;
      mouseSwipeAxis = Math.abs(dx) >= Math.abs(dy) ? 'x' : 'y';
    }
    if (mouseSwipeAxis === 'x') {
      const visible = store.getVisiblePhotos();
      const idx = visible.findIndex((p) => p.id === store.state.lightboxPhotoId);
      let effDx = dx;
      if ((idx <= 0 && dx > 0) || (idx >= visible.length - 1 && dx < 0)) {
        effDx = dx * 0.32;
      }
      mouseLastDx = effDx;
      scheduleTrackTranslate(effDx);
    }
  });

  window.addEventListener('mouseup', () => {
    if (isDragging) {
      isDragging = false;
      setInteracting(false);
      scheduleImageTransform(container, true);
      return;
    }
    if (!mouseSwipeDragging) return;
    mouseSwipeDragging = false;
    setInteracting(false);
    if (mouseSwipeAxis === 'x') {
      const vx = mouseLastDx / Math.max(16, performance.now() - swipeStartTime);
      suppressWrapClickUntil = Date.now() + 250;
      if (mouseLastDx < -52 || vx < -0.45) {
        stepWithSwipe(1, mouseLastDx);
      } else if (mouseLastDx > 52 || vx > 0.45) {
        stepWithSwipe(-1, mouseLastDx);
      } else {
        if (trackMoveRafId) {
          cancelAnimationFrame(trackMoveRafId);
          trackMoveRafId = 0;
        }
        const trackEl = container.querySelector('[data-lb-track]');
        if (trackEl) {
          trackEl.style.transition = 'transform 200ms cubic-bezier(0.32, 0.72, 0, 1)';
          trackEl.style.transform = 'translate3d(0px, 0px, 0px)';
        }
      }
    }
    mouseSwipeAxis = null;
  });

  container.addEventListener(
    'touchstart',
    (e) => {
      if (!store.state.lightboxPhotoId) return;
      if (!e.target.closest('.lightbox-stage') || e.target.closest('.lightbox-nav, button')) {
        return;
      }
      setInteracting(true);
      if (e.touches.length === 2) {
        isPinching = true;
        isTouchPanning = false;
        touchMoved = true;
        gestureAxis = null;
        pinchStartDist = getTouchDistance(e.touches[0], e.touches[1]);
        pinchStartZoom = liveZoom || 1;
      } else if (e.touches.length === 1) {
        isPinching = false;
        isTouchPanning = false;
        touchMoved = false;
        gestureAxis = null;
        lastDragDx = 0;
        lastDragDy = 0;
        swipeStartX = e.touches[0].clientX;
        swipeStartY = e.touches[0].clientY;
        swipeStartTime = performance.now();
        panStartX = panX;
        panStartY = panY;
      }
    },
    { passive: true }
  );

  container.addEventListener(
    'touchmove',
    (e) => {
      if (!store.state.lightboxPhotoId) return;
      if (!e.target.closest('.lightbox-stage') || e.target.closest('.lightbox-nav, button')) {
        return;
      }
      if (e.touches.length === 2) {
        if (!isPinching) {
          isPinching = true;
          pinchStartDist = getTouchDistance(e.touches[0], e.touches[1]);
          pinchStartZoom = liveZoom || 1;
        }
        e.preventDefault();
        touchMoved = true;
        if (pinchStartDist > 0) {
          const dist = getTouchDistance(e.touches[0], e.touches[1]);
          const nextZoom = Math.max(1, Math.min(3, pinchStartZoom * (dist / pinchStartDist)));
          setLiveZoom(container, store, nextZoom, false);
        }
        return;
      }

      if (e.touches.length === 1 && !isPinching) {
        const dx = e.touches[0].clientX - swipeStartX;
        const dy = e.touches[0].clientY - swipeStartY;

        if (Math.abs(dx) > 6 || Math.abs(dy) > 6) {
          touchMoved = true;
          if (!gestureAxis) {
            gestureAxis = Math.abs(dx) >= Math.abs(dy) ? 'x' : 'y';
          }
        }

        if (liveZoom > 1) {
          e.preventDefault();
          isTouchPanning = true;
          panX = panStartX + dx;
          panY = panStartY + dy;
          scheduleImageTransform(container, false);
          return;
        }

        if (gestureAxis === 'x') {
          e.preventDefault();
          const visible = store.getVisiblePhotos();
          const idx = visible.findIndex((p) => p.id === store.state.lightboxPhotoId);
          let effDx = dx;
          if ((idx <= 0 && dx > 0) || (idx >= visible.length - 1 && dx < 0)) {
            effDx = dx * 0.32;
          }
          lastDragDx = effDx;
          scheduleTrackTranslate(effDx);
        } else if (gestureAxis === 'y' && dy > 0) {
          e.preventDefault();
          lastDragDy = dy;
          const curSlide = container.querySelector('.lightbox-slide.is-current');
          const rootEl = container.querySelector('.lightbox');
          if (curSlide) {
            curSlide.style.transition = 'none';
            curSlide.style.transform = `translate3d(${Math.round(dx * 0.28)}px, ${Math.round(dy)}px, 0) scale(${Math.max(0.76, 1 - dy / 900).toFixed(3)})`;
          }
          if (rootEl) {
            rootEl.style.background = `rgba(5, 7, 10, ${Math.max(0.2, 0.96 - dy / 420).toFixed(2)})`;
          }
        }
      }
    },
    { passive: false }
  );

  container.addEventListener(
    'touchend',
    (e) => {
      if (!store.state.lightboxPhotoId) return;
      if (isPinching) {
        if (e.touches.length < 2) {
          isPinching = false;
          isTouchPanning = false;
          setInteracting(false);
          suppressWrapClickUntil = Date.now() + 350;
          if (e.touches.length === 1) {
            swipeStartX = e.touches[0].clientX;
            swipeStartY = e.touches[0].clientY;
            panStartX = panX;
            panStartY = panY;
            touchMoved = true;
          }
          setLiveZoom(container, store, liveZoom, true);
          lastTapTime = 0;
        }
        return;
      }

      isTouchPanning = false;
      setInteracting(false);
      if (!e.target.closest('.lightbox-stage') || e.target.closest('.lightbox-nav, button')) {
        return;
      }
      if (e.changedTouches.length === 0) return;

      const touch = e.changedTouches[0];
      const dy = touch.clientY - swipeStartY;
      const now = Date.now();

      if (liveZoom > 1) {
        scheduleImageTransform(container, true);
      }

      const isMediaTarget =
        Boolean(e.target.closest('.lightbox-media-wrap, .lightbox-track')) &&
        !e.target.closest('button, a, video, iframe, .lightbox-popover');

      if (!touchMoved && isMediaTarget && dismissLightboxPopover(container)) {
        clearTimeout(singleTapTimer);
        singleTapTimer = 0;
        lastTapTime = 0;
        suppressWrapClickUntil = now + 350;
        return;
      }

      if (
        !touchMoved &&
        isMediaTarget &&
        now - lastTapTime < 280 &&
        Math.hypot(touch.clientX - lastTapX, touch.clientY - lastTapY) < 24
      ) {
        clearTimeout(singleTapTimer);
        singleTapTimer = 0;
        lastTapTime = 0;
        suppressNextDblClickUntil = now + 400;
        suppressWrapClickUntil = now + 400;
        setLiveZoom(container, store, liveZoom > 1 ? 1 : 2, true);
        return;
      }

      if (!touchMoved && isMediaTarget) {
        lastTapTime = now;
        lastTapX = touch.clientX;
        lastTapY = touch.clientY;
        suppressNextDblClickUntil = now + 350;
        suppressWrapClickUntil = now + 350;
        clearTimeout(singleTapTimer);
        singleTapTimer = setTimeout(() => {
          singleTapTimer = 0;
          toggleChrome();
        }, 270);
        return;
      }
      lastTapTime = 0;

      if (liveZoom <= 1 && touchMoved) {
        suppressWrapClickUntil = now + 350;
        if (gestureAxis === 'x') {
          const vx = lastDragDx / Math.max(16, performance.now() - swipeStartTime);
          if (lastDragDx < -46 || vx < -0.4) {
            stepWithSwipe(1, lastDragDx);
          } else if (lastDragDx > 46 || vx > 0.4) {
            stepWithSwipe(-1, lastDragDx);
          } else {
            if (trackMoveRafId) {
              cancelAnimationFrame(trackMoveRafId);
              trackMoveRafId = 0;
            }
            const trackEl = container.querySelector('[data-lb-track]');
            if (trackEl) {
              trackEl.style.transition = 'transform 200ms cubic-bezier(0.32, 0.72, 0, 1)';
              trackEl.style.transform = 'translate3d(0px, 0px, 0px)';
            }
          }
        } else if (gestureAxis === 'y') {
          const rootEl = container.querySelector('.lightbox');
          if (lastDragDy > 75 || dy > 80) {
            closeLightboxWithAnimation(container, store);
          } else {
            const curSlide = container.querySelector('.lightbox-slide.is-current');
            if (curSlide) {
              curSlide.style.transition = 'transform 200ms cubic-bezier(0.32, 0.72, 0, 1)';
              curSlide.style.transform = 'translate3d(0px, 0px, 0) scale(1)';
            }
            if (rootEl) rootEl.style.background = '';
          }
        }
      }
      gestureAxis = null;
    },
    { passive: true }
  );

  container.addEventListener(
    'touchcancel',
    () => {
      isPinching = false;
      isTouchPanning = false;
      gestureAxis = null;
      setInteracting(false);
      if (trackMoveRafId) {
        cancelAnimationFrame(trackMoveRafId);
        trackMoveRafId = 0;
      }
      const trackEl = container.querySelector('[data-lb-track]');
      if (trackEl) {
        trackEl.style.transition = 'transform 180ms ease';
        trackEl.style.transform = 'translate3d(0px, 0px, 0px)';
      }
      const curSlide = container.querySelector('.lightbox-slide.is-current');
      if (curSlide) {
        curSlide.style.transform = '';
      }
      scheduleImageTransform(container, true);
    },
    { passive: true }
  );
}
