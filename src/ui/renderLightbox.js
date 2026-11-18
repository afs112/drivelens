import { downloadOriginalFile } from '../api/gdrive.js';
import { t } from '../i18n.js';
import { fetchAuthorizedMediaBlobUrl, loadPhotoIntoElement } from '../storage/imageLoader.js';
import { escapeAttr, escapeHtml, icon } from './icons.js';

let activeLightboxPhotoId = null;
let activeLightboxLang = '';
let panX = 0;
let panY = 0;
let isDragging = false;
let isPinching = false;
let isTouchPanning = false;
let dragStartX = 0;
let dragStartY = 0;

function getTouchDistance(t1, t2) {
  return Math.hypot(t2.clientX - t1.clientX, t2.clientY - t1.clientY);
}

function applyImageTransform(container, zoom) {
  const img = container.querySelector('.lightbox-img');
  if (!img) return;
  img.style.transition = isDragging || isPinching || isTouchPanning ? 'none' : '';
  if (zoom <= 1) {
    panX = 0;
    panY = 0;
    img.style.cursor = 'zoom-in';
    img.style.transform = 'translate3d(0px, 0px, 0) scale(1)';
  } else {
    img.style.cursor = isDragging ? 'grabbing' : 'grab';
    img.style.transform = `translate3d(${panX}px, ${panY}px, 0) scale(${zoom})`;
  }
}

export function renderLightbox(container, store, visiblePhotos) {
  if (!container) return;
  const state = store.state;
  const photoId = state.lightboxPhotoId;

  if (!photoId) {
    activeLightboxPhotoId = null;
    activeLightboxLang = '';
    panX = 0;
    panY = 0;
    isDragging = false;
    isPinching = false;
    isTouchPanning = false;
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
  const isVideo = file.mimeType && file.mimeType.startsWith('video/');
  const zoom = state.lightboxZoom || 1;

  const isSamePhoto =
    activeLightboxPhotoId === file.id &&
    activeLightboxLang === state.lang &&
    container.querySelector('.lightbox-topbar');

  const starsHtml = [1, 2, 3, 4, 5]
    .map(
      (r) => `
      <button
        type="button"
        class="star-btn ${meta.myRating >= r ? 'filled' : ''}"
        data-lb="rate"
        data-rating="${r}"
        title="${escapeAttr(t('lightbox.rateTitle', { n: r }))}"
      >${icon(meta.myRating >= r ? 'starFilled' : 'star', 19)}</button>
    `
    )
    .join('');

  const tagsHtml = meta.activeTagIds
    .map((tid) => {
      const tdef = schemaTags[tid];
      if (!tdef) return '';
      return `
        <span class="tag-chip tag-color-${escapeAttr(tdef.color || 'blue')}">
          <span class="tag-dot tag-color-${escapeAttr(tdef.color || 'blue')}"></span>
          <span>${escapeHtml(tdef.name)}</span>
          <span class="tag-chip-remove" data-lb="remove-tag" data-tag-id="${escapeAttr(tid)}">${icon('x', 11)}</span>
        </span>
      `;
    })
    .join('');

  const avgText =
    meta.avgRating > 0
      ? t('lightbox.avgSummary', { avg: meta.avgRating.toFixed(1), count: meta.ratingCount })
      : t('lightbox.unrated');

  if (isSamePhoto) {
    // Patch HUD and zoom without reloading main image
    const zoomLabel = container.querySelector('[data-lb-zoom-label]');
    if (zoomLabel) zoomLabel.textContent = `${Math.round(zoom * 100)}%`;

    const hudEl = container.querySelector('.lightbox-hud');
    if (hudEl) {
      hudEl.innerHTML = buildLightboxHudHtml({ meta, starsHtml, tagsHtml, avgText });
    }

    const thumbs = container.querySelectorAll('.filmstrip-thumb');
    for (const th of thumbs) {
      const active = th.dataset.photoId === file.id;
      th.classList.toggle('active', active);
      if (active) th.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' });
    }

    applyImageTransform(container, zoom);
    return;
  }

  activeLightboxPhotoId = file.id;
  activeLightboxLang = state.lang;
  panX = 0;
  panY = 0;

  container.innerHTML = `
    <div class="lightbox">
      <img class="lightbox-ambient-bg" alt="" aria-hidden="true" />
      <div class="lightbox-topbar">
        <div style="display:flex;align-items:center;gap:8px;min-width:0;flex:1">
          <span class="photo-count-badge">${idx >= 0 ? `${idx + 1} / ${total}` : escapeHtml(t('lightbox.preview'))}</span>
          <span style="font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(file.name)}</span>
        </div>
        <div style="display:flex;align-items:center;gap:6px">
          ${
            !isVideo
              ? `
            <button type="button" class="btn btn-sm btn-icon" data-lb="zoom-out" title="${escapeAttr(t('lightbox.zoomOut'))}">${icon('zoomOut', 14)}</button>
            <button type="button" class="btn btn-sm" data-lb="zoom-reset" data-lb-zoom-label>${Math.round(zoom * 100)}%</button>
            <button type="button" class="btn btn-sm btn-icon" data-lb="zoom-in" title="${escapeAttr(t('lightbox.zoomIn'))}">${icon('zoomIn', 14)}</button>
          `
              : ''
          }
          <button type="button" class="btn btn-sm" data-lb="toggle-inspector" title="${escapeAttr(t('lightbox.toggleInspectorTitle'))}">${icon('info', 14)} <span class="hide-sm">${escapeHtml(t('lightbox.info'))}</span></button>
          <button type="button" class="btn btn-sm" data-lb="download" title="${escapeAttr(t('lightbox.download'))}">${icon('download', 14)} <span class="hide-sm">${escapeHtml(t('lightbox.download'))}</span></button>
          <button type="button" class="btn btn-sm btn-icon" data-lb="close" title="${escapeAttr(t('lightbox.close'))}">${icon('x', 16)}</button>
        </div>
      </div>

      <div class="lightbox-stage">
        <button type="button" class="lightbox-nav prev" data-lb="prev" ${idx <= 0 ? 'disabled' : ''} title="${escapeAttr(t('lightbox.prev'))}">${icon('chevronLeft', 24)}</button>
        <div class="lightbox-media-wrap">
          ${
            isVideo
              ? file.isDemo
                ? `<div style="position:relative;max-width:100%;max-height:100%;display:flex;flex-direction:column;align-items:center;gap:10px">
                     <img class="lightbox-img" alt="${escapeAttr(file.name)}" />
                     <div class="sync-pill">${escapeHtml(t('lightbox.demoVideoNotice'))}</div>
                   </div>`
                : state.authType === 'apikey' && !state.accessToken
                  ? `<iframe class="lightbox-video" style="width:85vw;height:72vh;border:0" src="https://drive.google.com/file/d/${encodeURIComponent(file.id)}/preview" allow="autoplay; fullscreen" allowfullscreen></iframe>`
                  : `<video class="lightbox-video" controls autoplay playsinline></video>`
              : `<img class="lightbox-img" alt="${escapeAttr(file.name)}" draggable="false" />`
          }
        </div>
        <button type="button" class="lightbox-nav next" data-lb="next" ${idx >= total - 1 || idx === -1 ? 'disabled' : ''} title="${escapeAttr(t('lightbox.next'))}">${icon('chevronRight', 24)}</button>
      </div>

      <div class="lightbox-bottom">
        <div class="lightbox-hud">
          ${buildLightboxHudHtml({ meta, starsHtml, tagsHtml, avgText })}
        </div>
        <div class="lightbox-filmstrip">
          ${visiblePhotos
            .map(
              (p) => `
            <button type="button" class="filmstrip-thumb ${p.id === file.id ? 'active' : ''}" data-lb="jump" data-photo-id="${escapeAttr(p.id)}" title="${escapeAttr(p.name)}">
              <img alt="" data-film-id="${escapeAttr(p.id)}" />
            </button>
          `
            )
            .join('')}
        </div>
      </div>
    </div>
  `;

  // Load main high-res photo or video
  if (isVideo && !file.isDemo) {
    const videoEl = container.querySelector('.lightbox-video');
    if (videoEl && videoEl.tagName === 'VIDEO' && state.accessToken) {
      fetchAuthorizedMediaBlobUrl(file.id, state.accessToken)
        .then((blobUrl) => {
          if (videoEl.isConnected) videoEl.src = blobUrl;
        })
        .catch(() => store.toast(t('lightbox.videoLoadError'), 'error'));
    }
  } else {
    const mainImg = container.querySelector('.lightbox-img');
    if (mainImg) {
      loadPhotoIntoElement(mainImg, file, {
        size: 2048,
        eager: true,
        getAccessToken: () => store.state.accessToken,
        getApiKey: () => store.state.apiKey,
      });
    }
  }

  const ambientEl = container.querySelector('.lightbox-ambient-bg');
  if (ambientEl) {
    loadPhotoIntoElement(ambientEl, file, {
      size: 240,
      eager: true,
      getAccessToken: () => store.state.accessToken,
      getApiKey: () => store.state.apiKey,
    });
  }

  // Load filmstrip thumbnails lazily
  const byId = new Map(visiblePhotos.map((p) => [p.id, p]));
  const stripImgs = container.querySelectorAll('.filmstrip-thumb img[data-film-id]');
  for (const simg of stripImgs) {
    const p = byId.get(simg.dataset.filmId);
    if (p) {
      loadPhotoIntoElement(simg, p, {
        size: 220,
        getAccessToken: () => store.state.accessToken,
        getApiKey: () => store.state.apiKey,
      });
    }
  }

  const activeThumb = container.querySelector('.filmstrip-thumb.active');
  if (activeThumb) {
    activeThumb.scrollIntoView({ inline: 'center', block: 'nearest' });
  }
}

function buildLightboxHudHtml({ meta, starsHtml, tagsHtml, avgText }) {
  return `
    <div class="lightbox-hud-group">
      <div class="star-input">${starsHtml}</div>
      ${
        meta.myRating > 0
          ? `<button type="button" class="btn btn-ghost btn-sm" data-lb="rate" data-rating="0">${escapeHtml(t('inspector.clearRate'))}</button>`
          : ''
      }
      <button
        type="button"
        class="btn btn-sm ${meta.myFavorite ? 'is-active' : ''}"
        style="${meta.myFavorite ? 'color:var(--heart-rose);border-color:rgba(244,63,94,0.5);background:var(--heart-soft)' : ''}"
        data-lb="toggle-fav"
        title="${escapeAttr(t('lightbox.favTitle'))}"
      >${icon(meta.myFavorite ? 'heartFilled' : 'heart', 14)} ${escapeHtml(meta.myFavorite ? t('inspector.favorited') : t('inspector.favorite'))}</button>
      <span style="font-size:12px;color:var(--star-gold)">${escapeHtml(avgText)}</span>
    </div>
    <div class="lightbox-hud-group">
      ${tagsHtml}
      <button type="button" class="btn btn-sm" data-lb="quick-tag">${icon('tag', 13)} ${escapeHtml(t('lightbox.addTagBtn'))}</button>
    </div>
  `;
}

export function bindLightboxEvents(container, store) {
  if (!container) return;

  let pinchStartDist = 0;
  let pinchStartZoom = 1;
  let swipeStartX = 0;
  let swipeStartY = 0;
  let panStartX = 0;
  let panStartY = 0;
  let touchMoved = false;
  let lastTapTime = 0;
  let lastTapX = 0;
  let lastTapY = 0;
  let suppressNextDblClickUntil = 0;
  let suppressWrapClickUntil = 0;

  container.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-lb]');
    if (btn) {
      const act = btn.dataset.lb;
      const pid = store.state.lightboxPhotoId;
      if (act === 'close') store.closeLightbox();
      else if (act === 'prev') store.stepPhoto(-1);
      else if (act === 'next') store.stepPhoto(1);
      else if (act === 'jump') store.openLightbox(btn.dataset.photoId);
      else if (act === 'rate' && pid) {
        const r = Number(btn.dataset.rating || 0);
        const cur = store.getAggregatedItemMeta(pid).myRating;
        store.setRating([pid], r === cur ? 0 : r);
      } else if (act === 'toggle-fav' && pid) {
        store.toggleFavorite([pid]);
      } else if (act === 'remove-tag' && pid) {
        store.toggleTagOnPhotos([pid], btn.dataset.tagId, false);
      } else if (act === 'quick-tag' && pid) {
        store.openModal('quickTag', { photoIds: [pid] });
      } else if (act === 'toggle-inspector') {
        store.setState({ inspectorOpen: !store.state.inspectorOpen });
        store.closeLightbox();
      } else if (act === 'download' && pid) {
        const file = store.state.files.find((f) => f.id === pid);
        if (file) {
          downloadOriginalFile(file, store.state.accessToken, store.state.apiKey).catch((err) =>
            store.toast(err?.message || t('inspector.downloadFailed'), 'error')
          );
        }
      } else if (act === 'zoom-in') {
        const next = Math.min(3, Number((store.state.lightboxZoom + 0.5).toFixed(2)));
        store.setState({ lightboxZoom: next });
      } else if (act === 'zoom-out') {
        const next = Math.max(1, Number((store.state.lightboxZoom - 0.5).toFixed(2)));
        store.setState({ lightboxZoom: next });
      } else if (act === 'zoom-reset') {
        store.setState({ lightboxZoom: store.state.lightboxZoom > 1 ? 1 : 2 });
      }
      return;
    }

    if (Date.now() < suppressWrapClickUntil) return;
    if (e.target.classList.contains('lightbox-media-wrap')) {
      store.closeLightbox();
    }
  });

  container.addEventListener('dblclick', (e) => {
    if (Date.now() < suppressNextDblClickUntil) return;
    if (e.target.classList.contains('lightbox-img')) {
      store.setState({ lightboxZoom: store.state.lightboxZoom > 1 ? 1 : 2 });
    }
  });

  container.addEventListener('mousedown', (e) => {
    if (!e.target.classList.contains('lightbox-img')) return;
    if (store.state.lightboxZoom <= 1) return;
    isDragging = true;
    dragStartX = e.clientX - panX;
    dragStartY = e.clientY - panY;
    applyImageTransform(container, store.state.lightboxZoom);
  });

  window.addEventListener('mousemove', (e) => {
    if (!isDragging) return;
    panX = e.clientX - dragStartX;
    panY = e.clientY - dragStartY;
    applyImageTransform(container, store.state.lightboxZoom);
  });

  window.addEventListener('mouseup', () => {
    if (!isDragging) return;
    isDragging = false;
    applyImageTransform(container, store.state.lightboxZoom);
  });

  container.addEventListener(
    'touchstart',
    (e) => {
      if (!store.state.lightboxPhotoId) return;
      if (!e.target.closest('.lightbox-stage') || e.target.closest('.lightbox-nav, button')) {
        return;
      }
      if (e.touches.length === 2) {
        isPinching = true;
        isTouchPanning = false;
        touchMoved = true;
        pinchStartDist = getTouchDistance(e.touches[0], e.touches[1]);
        pinchStartZoom = store.state.lightboxZoom || 1;
      } else if (e.touches.length === 1) {
        isPinching = false;
        isTouchPanning = false;
        touchMoved = false;
        swipeStartX = e.touches[0].clientX;
        swipeStartY = e.touches[0].clientY;
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
          pinchStartZoom = store.state.lightboxZoom || 1;
        }
        e.preventDefault();
        touchMoved = true;
        if (pinchStartDist > 0) {
          const dist = getTouchDistance(e.touches[0], e.touches[1]);
          const nextZoom = Math.max(1, Math.min(3, pinchStartZoom * (dist / pinchStartDist)));
          store.state.lightboxZoom = nextZoom;
          const zoomLabel = container.querySelector('[data-lb-zoom-label]');
          if (zoomLabel) zoomLabel.textContent = `${Math.round(nextZoom * 100)}%`;
          applyImageTransform(container, nextZoom);
        }
      } else if (e.touches.length === 1 && !isPinching) {
        const dx = e.touches[0].clientX - swipeStartX;
        const dy = e.touches[0].clientY - swipeStartY;
        if (Math.abs(dx) > 6 || Math.abs(dy) > 6) {
          touchMoved = true;
        }
        if ((store.state.lightboxZoom || 1) > 1) {
          e.preventDefault();
          isTouchPanning = true;
          panX = panStartX + dx;
          panY = panStartY + dy;
          applyImageTransform(container, store.state.lightboxZoom);
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
          suppressWrapClickUntil = Date.now() + 350;
          const finalZoom = Math.max(
            1,
            Math.min(3, Number((store.state.lightboxZoom || 1).toFixed(2)))
          );
          if (e.touches.length === 1) {
            swipeStartX = e.touches[0].clientX;
            swipeStartY = e.touches[0].clientY;
            panStartX = panX;
            panStartY = panY;
            touchMoved = true;
          }
          store.setState({ lightboxZoom: finalZoom });
          lastTapTime = 0;
        }
        return;
      }

      isTouchPanning = false;
      if (!e.target.closest('.lightbox-stage') || e.target.closest('.lightbox-nav, button')) {
        return;
      }
      if (e.changedTouches.length === 0) return;

      const touch = e.changedTouches[0];
      const dx = touch.clientX - swipeStartX;
      const dy = touch.clientY - swipeStartY;
      const now = Date.now();
      const curZoom = store.state.lightboxZoom || 1;

      if (curZoom > 1) {
        applyImageTransform(container, curZoom);
      }

      if (
        !touchMoved &&
        e.target.classList.contains('lightbox-img') &&
        now - lastTapTime < 280 &&
        Math.hypot(touch.clientX - lastTapX, touch.clientY - lastTapY) < 24
      ) {
        lastTapTime = 0;
        suppressNextDblClickUntil = now + 400;
        store.setState({ lightboxZoom: curZoom > 1 ? 1 : 2 });
        return;
      }

      if (!touchMoved && e.target.classList.contains('lightbox-img')) {
        lastTapTime = now;
        lastTapX = touch.clientX;
        lastTapY = touch.clientY;
      } else {
        lastTapTime = 0;
      }

      if (curZoom <= 1 && touchMoved) {
        if (Math.abs(dx) > 48 && Math.abs(dx) > Math.abs(dy) * 1.3) {
          suppressWrapClickUntil = now + 350;
          store.stepPhoto(dx < 0 ? 1 : -1);
        } else if (dy > 85 && dy > Math.abs(dx) * 1.4) {
          suppressWrapClickUntil = now + 350;
          store.closeLightbox();
        }
      }
    },
    { passive: true }
  );

  container.addEventListener(
    'touchcancel',
    () => {
      isPinching = false;
      isTouchPanning = false;
      applyImageTransform(container, store.state.lightboxZoom || 1);
    },
    { passive: true }
  );
}
