import { t } from '../i18n.js';
import { loadPhotoIntoElement } from '../storage/imageLoader.js';
import { escapeAttr, escapeHtml, icon } from './icons.js';

let compareActive = false;
let compareIds = [];
let compareZoom = 1;
let panX = 0;
let panY = 0;
let isDragging = false;
let isPinching = false;
let isTouchPanning = false;
let dragStartX = 0;
let dragStartY = 0;
let activeCompareKey = '';
const boundContainers = new WeakSet();

function getTouchDistance(t1, t2) {
  return Math.hypot(t2.clientX - t1.clientX, t2.clientY - t1.clientY);
}

function formatShutter(sec) {
  const n = Number(sec || 0);
  if (!n) return '';
  if (n >= 1) return `${n}s`;
  return `1/${Math.round(1 / n)}s`;
}

function buildExifSpecLine(file) {
  const exif = file.imageMediaMetadata || {};
  const vid = file.videoMediaMetadata || {};
  const width = exif.width || vid.width || 0;
  const height = exif.height || vid.height || 0;

  let camera = '';
  if (exif.cameraMake && exif.cameraModel) {
    camera = exif.cameraModel.toLowerCase().startsWith(exif.cameraMake.toLowerCase())
      ? exif.cameraModel
      : `${exif.cameraMake} ${exif.cameraModel}`;
  } else {
    camera = exif.cameraModel || exif.cameraMake || '';
  }

  const focal = exif.focalLength ? `${exif.focalLength}mm` : '';
  const aperture = exif.aperture ? `f/${exif.aperture}` : '';
  const shutter = formatShutter(exif.exposureTime);
  const iso = exif.isoSpeed ? `ISO ${exif.isoSpeed}` : '';
  const resolution = width && height ? `${width}×${height}` : '';

  const parts = [camera, focal, aperture, shutter, iso, resolution].filter(Boolean);
  return parts.length > 0 ? parts.join(' · ') : t('compare.noExif');
}

function buildPaneHudHtml(file, store) {
  const meta = store.getAggregatedItemMeta(file.id);
  const schemaTags = store.state.tagSchema?.tags || {};

  const starsHtml = [1, 2, 3, 4, 5]
    .map(
      (r) => `
      <button
        type="button"
        class="star-btn ${meta.myRating >= r ? 'filled' : ''}"
        data-cmp="rate"
        data-photo-id="${escapeAttr(file.id)}"
        data-rating="${r}"
        title="${escapeAttr(t('compare.rateTitle', { n: r }))}"
      >${icon(meta.myRating >= r ? 'starFilled' : 'star', 16)}</button>
    `
    )
    .join('');

  const avgHtml =
    meta.avgRating > 0
      ? `<span class="compare-avg-badge">${escapeHtml(t('compare.avgBadge', { avg: meta.avgRating.toFixed(1) }))}</span>`
      : `<span class="compare-avg-empty">${escapeHtml(t('compare.unrated'))}</span>`;

  const tagsHtml = meta.activeTagIds
    .map((tid) => {
      const tag = schemaTags[tid];
      if (!tag) return '';
      return `
        <span class="tag-chip tag-color-${escapeAttr(tag.color || 'blue')}">
          <span class="tag-dot tag-color-${escapeAttr(tag.color || 'blue')}"></span>
          <span>${escapeHtml(tag.name)}</span>
          <span class="tag-chip-remove" data-cmp="remove-tag" data-photo-id="${escapeAttr(file.id)}" data-tag-id="${escapeAttr(tid)}" title="${escapeAttr(t('compare.removeTag'))}">${icon('x', 11)}</span>
        </span>
      `;
    })
    .join('');

  const exifLine = buildExifSpecLine(file);

  return `
    <div class="compare-hud-row">
      <div class="compare-hud-group">
        <div class="star-input">${starsHtml}</div>
        ${
          meta.myRating > 0
            ? `<button type="button" class="btn btn-ghost btn-sm compare-rate-clear" data-cmp="rate" data-photo-id="${escapeAttr(file.id)}" data-rating="0" title="${escapeAttr(t('inspector.clearMyRatingTitle'))}">${escapeHtml(t('compare.clearZero'))}</button>`
            : ''
        }
      </div>
      <div class="compare-hud-group">
        ${avgHtml}
        <button
          type="button"
          class="btn btn-sm compare-fav-btn ${meta.myFavorite ? 'is-favorited' : ''}"
          data-cmp="toggle-fav"
          data-photo-id="${escapeAttr(file.id)}"
          title="${escapeAttr(t(meta.myFavorite ? 'compare.unfavTitle' : 'compare.favTitle'))}"
        >${icon(meta.myFavorite ? 'heartFilled' : 'heart', 13)} <span>${escapeHtml(t(meta.myFavorite ? 'inspector.favorited' : 'inspector.favorite'))}</span>${meta.favoriteCount > 0 ? `<span class="compare-fav-count">${meta.favoriteCount}</span>` : ''}</button>
      </div>
    </div>
    <div class="compare-hud-tags">
      ${tagsHtml}
      <button type="button" class="btn btn-sm compare-tag-add-btn" data-cmp="quick-tag" data-photo-id="${escapeAttr(file.id)}">${icon('tag', 12)} ${escapeHtml(t('compare.addTagBtn'))}</button>
    </div>
    <div class="compare-exif-line" title="${escapeAttr(exifLine)}">${escapeHtml(exifLine)}</div>
  `;
}

function updateCompareZoomUI(container) {
  if (!container) return;
  const zoomLabel = container.querySelector('[data-cmp-zoom-label]');
  if (zoomLabel) {
    zoomLabel.textContent = `${Math.round(compareZoom * 100)}%`;
  }
  const zoomOutBtn = container.querySelector('[data-cmp="zoom-out"]');
  if (zoomOutBtn) zoomOutBtn.disabled = compareZoom <= 1;
  const zoomInBtn = container.querySelector('[data-cmp="zoom-in"]');
  if (zoomInBtn) zoomInBtn.disabled = compareZoom >= 3;
  const syncPill = container.querySelector('.compare-sync-pill');
  if (syncPill) syncPill.classList.toggle('is-zoomed', compareZoom > 1);
}

function applyCompareTransform(container) {
  if (!container) return;
  if (compareZoom <= 1) {
    panX = 0;
    panY = 0;
  }

  const stages = container.querySelectorAll('.compare-stage');
  for (const stage of stages) {
    stage.style.cursor = compareZoom <= 1 ? 'zoom-in' : isDragging ? 'grabbing' : 'grab';
  }

  const imgs = container.querySelectorAll('.compare-pane-img');
  for (const img of imgs) {
    img.style.transition = isDragging || isPinching || isTouchPanning ? 'none' : '';
    if (compareZoom <= 1) {
      img.style.transform = 'translate3d(0px, 0px, 0) scale(1)';
    } else {
      img.style.transform = `translate3d(${panX}px, ${panY}px, 0) scale(${compareZoom})`;
    }
  }
}

export function openCompare(photoIds, store) {
  if (!store) return false;
  const files = store.state.files || [];
  const validSet = new Set(files.map((f) => f.id));

  const rawIds =
    photoIds && typeof photoIds[Symbol.iterator] === 'function' ? Array.from(photoIds) : [];
  const nextIds = [];
  const seen = new Set();

  for (const id of rawIds) {
    if (id && validSet.has(id) && !seen.has(id)) {
      seen.add(id);
      nextIds.push(id);
    }
  }

  if (nextIds.length < 2) {
    const visible = typeof store.getVisiblePhotos === 'function' ? store.getVisiblePhotos() : [];
    const focusedId = store.state.focusedPhotoId;

    if (nextIds.length === 1) {
      const anchorId = nextIds[0];
      const idx = visible.findIndex((p) => p.id === anchorId);
      if (idx >= 0) {
        if (idx + 1 < visible.length) {
          nextIds.push(visible[idx + 1].id);
        } else if (idx - 1 >= 0) {
          nextIds.push(visible[idx - 1].id);
        }
      } else if (focusedId && focusedId !== anchorId && validSet.has(focusedId)) {
        nextIds.push(focusedId);
      } else {
        const alt = visible.find((p) => !seen.has(p.id));
        if (alt) nextIds.push(alt.id);
      }
    } else {
      const idx = focusedId ? visible.findIndex((p) => p.id === focusedId) : -1;
      if (idx >= 0) {
        if (idx + 1 < visible.length) {
          nextIds.push(visible[idx].id, visible[idx + 1].id);
        } else if (idx - 1 >= 0) {
          nextIds.push(visible[idx].id, visible[idx - 1].id);
        }
      } else if (visible.length >= 2) {
        nextIds.push(visible[0].id, visible[1].id);
      }
    }
  }

  if (nextIds.length < 2) {
    store.toast(t('compare.need2To4Toast'), 'info');
    return false;
  }

  let finalIds = nextIds;
  if (finalIds.length > 4) {
    finalIds = finalIds.slice(0, 4);
    store.toast(t('compare.max4Toast'), 'info');
  }

  compareActive = true;
  compareIds = finalIds;
  compareZoom = 1;
  panX = 0;
  panY = 0;
  isDragging = false;
  isPinching = false;
  isTouchPanning = false;
  activeCompareKey = '';

  store.emit();
  return true;
}

export function closeCompare(store) {
  compareActive = false;
  compareIds = [];
  compareZoom = 1;
  panX = 0;
  panY = 0;
  isDragging = false;
  isPinching = false;
  isTouchPanning = false;
  activeCompareKey = '';
  store?.emit();
}

export function isCompareOpen() {
  return Boolean(compareActive && compareIds.length >= 2);
}

export function renderCompare(container, store) {
  if (!container) return;

  const files = store?.state?.files || [];
  const fileById = new Map(files.map((f) => [f.id, f]));

  if (compareActive) {
    const validFiles = compareIds.map((id) => fileById.get(id)).filter(Boolean);
    if (validFiles.length < 2) {
      compareActive = false;
      compareIds = [];
    } else if (validFiles.length !== compareIds.length) {
      compareIds = validFiles.map((f) => f.id);
    }
  }

  if (!isCompareOpen()) {
    activeCompareKey = '';
    compareZoom = 1;
    panX = 0;
    panY = 0;
    isDragging = false;
    isPinching = false;
    isTouchPanning = false;
    container.classList.add('hidden');
    if (container.innerHTML !== '') {
      container.innerHTML = '';
    }
    return;
  }

  container.classList.remove('hidden');

  const compareFiles = compareIds.map((id) => fileById.get(id)).filter(Boolean);
  const nextKey = `${store.state.lang}|${compareFiles.map((f) => f.id).join(',')}`;

  // Fast path: patch HUDs and zoom/pan transforms in place without reloading images
  if (activeCompareKey === nextKey && container.querySelector('.compare-overlay')) {
    updateCompareZoomUI(container);
    const panes = container.querySelectorAll('.compare-pane[data-photo-id]');
    for (const pane of panes) {
      const file = fileById.get(pane.dataset.photoId);
      const hud = pane.querySelector('.compare-pane-hud');
      if (file && hud) {
        hud.innerHTML = buildPaneHudHtml(file, store);
      }
    }
    applyCompareTransform(container);
    return;
  }

  activeCompareKey = nextKey;

  const panesHtml = compareFiles
    .map((file, idx) => {
      const isVideo = file.mimeType && file.mimeType.startsWith('video/');
      return `
        <article class="compare-pane" data-photo-id="${escapeAttr(file.id)}">
          <header class="compare-pane-header">
            <div class="compare-pane-title-wrap">
              <span class="compare-pane-index">#${idx + 1}</span>
              <span class="compare-pane-filename" title="${escapeAttr(file.name)}">${escapeHtml(file.name)}</span>
              ${isVideo ? `<span class="compare-video-pill">${icon('video', 11)} ${escapeHtml(t('compare.video'))}</span>` : ''}
            </div>
            <div class="compare-pane-actions">
              <button
                type="button"
                class="btn btn-ghost btn-sm"
                data-cmp="open-lightbox"
                data-photo-id="${escapeAttr(file.id)}"
                title="${escapeAttr(t('compare.openLightboxTitle'))}"
              >${icon('externalLink', 13)} <span class="compare-btn-label">${escapeHtml(t('compare.fullView'))}</span></button>
              <button
                type="button"
                class="btn btn-ghost btn-sm btn-icon"
                data-cmp="drop-pane"
                data-photo-id="${escapeAttr(file.id)}"
                title="${escapeAttr(t('compare.dropPaneTitle'))}"
              >${icon('x', 14)}</button>
            </div>
          </header>
          <div class="compare-stage" data-photo-id="${escapeAttr(file.id)}" title="${escapeAttr(t('compare.stageTitle'))}">
            <div class="compare-stage-loader"><span class="spin">${icon('refresh', 20)}</span></div>
            <img class="compare-pane-img" data-photo-id="${escapeAttr(file.id)}" alt="${escapeAttr(file.name)}" draggable="false" />
          </div>
          <footer class="compare-pane-hud">
            ${buildPaneHudHtml(file, store)}
          </footer>
        </article>
      `;
    })
    .join('');

  container.innerHTML = `
    <section class="compare-overlay" role="dialog" aria-modal="true" aria-label="${escapeAttr(t('compare.dialogLabel'))}">
      <div class="compare-topbar">
        <div class="compare-topbar-left">
          <div class="compare-title">
            ${icon('grid', 16)}
            <span>${escapeHtml(t('compare.titleCount', { count: compareFiles.length }))}</span>
          </div>
          <span class="compare-sync-pill ${compareZoom > 1 ? 'is-zoomed' : ''}">
            ${icon('zoomIn', 13)}
            <span>${escapeHtml(t('compare.syncPill'))}</span>
          </span>
          <span class="compare-hint">${escapeHtml(t('compare.hint'))}</span>
        </div>
        <div class="compare-topbar-right">
          <div class="compare-zoom-controls">
            <button type="button" class="btn btn-sm btn-icon" data-cmp="zoom-out" title="${escapeAttr(t('compare.zoomOutTitle'))}" ${compareZoom <= 1 ? 'disabled' : ''}>${icon('zoomOut', 14)}</button>
            <button type="button" class="btn btn-sm compare-zoom-label" data-cmp="zoom-reset" data-cmp-zoom-label title="${escapeAttr(t('compare.zoomResetTitle'))}">${Math.round(compareZoom * 100)}%</button>
            <button type="button" class="btn btn-sm btn-icon" data-cmp="zoom-in" title="${escapeAttr(t('compare.zoomInTitle'))}" ${compareZoom >= 3 ? 'disabled' : ''}>${icon('zoomIn', 14)}</button>
          </div>
          <button type="button" class="btn btn-sm compare-close-btn" data-cmp="close" title="${escapeAttr(t('compare.exitTitle'))}">
            ${icon('x', 15)}
            <span>${escapeHtml(t('compare.exitBtn'))}</span>
            <kbd>Esc</kbd>
          </button>
        </div>
      </div>
      <div class="compare-grid compare-grid-${compareFiles.length}">
        ${panesHtml}
      </div>
    </section>
  `;

  const imgs = container.querySelectorAll('.compare-pane-img[data-photo-id]');
  for (const imgEl of imgs) {
    const file = fileById.get(imgEl.dataset.photoId);
    if (!file) continue;
    loadPhotoIntoElement(imgEl, file, {
      size: 1600,
      eager: true,
      getAccessToken: () => store.state.accessToken,
      getApiKey: () => store.state.apiKey,
      onLoaded: () => {
        imgEl.closest('.compare-stage')?.classList.add('has-img');
      },
    });
  }

  applyCompareTransform(container);
}

export function bindCompareEvents(container, store) {
  if (!container || boundContainers.has(container)) return;
  boundContainers.add(container);

  let pinchStartDist = 0;
  let pinchStartZoom = 1;
  let touchStartX = 0;
  let touchStartY = 0;
  let panStartX = 0;
  let panStartY = 0;
  let touchMoved = false;
  let lastTapTime = 0;
  let lastTapX = 0;
  let lastTapY = 0;
  let suppressNextDblClickUntil = 0;

  container.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-cmp]');
    if (!btn) return;

    const act = btn.dataset.cmp;
    const pid = btn.dataset.photoId || '';

    if (act === 'close') {
      closeCompare(store);
    } else if (act === 'zoom-in') {
      compareZoom = Math.min(3, Number((compareZoom + 0.5).toFixed(2)));
      updateCompareZoomUI(container);
      applyCompareTransform(container);
    } else if (act === 'zoom-out') {
      compareZoom = Math.max(1, Number((compareZoom - 0.5).toFixed(2)));
      if (compareZoom <= 1) {
        panX = 0;
        panY = 0;
      }
      updateCompareZoomUI(container);
      applyCompareTransform(container);
    } else if (act === 'zoom-reset') {
      compareZoom = compareZoom > 1 ? 1 : 2;
      panX = 0;
      panY = 0;
      updateCompareZoomUI(container);
      applyCompareTransform(container);
    } else if (act === 'rate' && pid) {
      const r = Number(btn.dataset.rating || 0);
      const cur = store.getAggregatedItemMeta(pid).myRating;
      store.setRating([pid], r === cur ? 0 : r);
    } else if (act === 'toggle-fav' && pid) {
      store.toggleFavorite([pid]);
    } else if (act === 'quick-tag' && pid) {
      store.openModal('quickTag', { photoIds: [pid] });
    } else if (act === 'remove-tag' && pid && btn.dataset.tagId) {
      store.toggleTagOnPhotos([pid], btn.dataset.tagId, false);
    } else if (act === 'drop-pane' && pid) {
      compareIds = compareIds.filter((id) => id !== pid);
      if (compareIds.length < 2) {
        closeCompare(store);
      } else {
        activeCompareKey = '';
        store.emit();
      }
    } else if (act === 'open-lightbox' && pid) {
      closeCompare(store);
      store.openLightbox(pid);
    }
  });

  container.addEventListener('dblclick', (e) => {
    if (Date.now() < suppressNextDblClickUntil) return;
    if (!isCompareOpen()) return;
    if (!e.target.closest('.compare-stage')) return;
    compareZoom = compareZoom > 1 ? 1 : 2;
    panX = 0;
    panY = 0;
    updateCompareZoomUI(container);
    applyCompareTransform(container);
  });

  container.addEventListener('mousedown', (e) => {
    if (e.button !== 0 || !isCompareOpen()) return;
    if (!e.target.closest('.compare-stage')) return;
    if (compareZoom <= 1) return;
    e.preventDefault();
    isDragging = true;
    dragStartX = e.clientX - panX;
    dragStartY = e.clientY - panY;
    applyCompareTransform(container);
  });

  container.addEventListener(
    'touchstart',
    (e) => {
      if (!isCompareOpen() || !e.target.closest('.compare-stage')) return;
      if (e.touches.length === 2) {
        isPinching = true;
        isTouchPanning = false;
        touchMoved = true;
        pinchStartDist = getTouchDistance(e.touches[0], e.touches[1]);
        pinchStartZoom = compareZoom;
      } else if (e.touches.length === 1) {
        isPinching = false;
        isTouchPanning = false;
        touchMoved = false;
        touchStartX = e.touches[0].clientX;
        touchStartY = e.touches[0].clientY;
        panStartX = panX;
        panStartY = panY;
      }
    },
    { passive: true }
  );

  container.addEventListener(
    'touchmove',
    (e) => {
      if (!isCompareOpen() || !e.target.closest('.compare-stage')) return;
      if (e.touches.length === 2) {
        if (!isPinching) {
          isPinching = true;
          pinchStartDist = getTouchDistance(e.touches[0], e.touches[1]);
          pinchStartZoom = compareZoom;
        }
        e.preventDefault();
        touchMoved = true;
        if (pinchStartDist > 0) {
          const dist = getTouchDistance(e.touches[0], e.touches[1]);
          compareZoom = Math.max(
            1,
            Math.min(3, Number((pinchStartZoom * (dist / pinchStartDist)).toFixed(2)))
          );
          if (compareZoom <= 1) {
            panX = 0;
            panY = 0;
          }
          updateCompareZoomUI(container);
          applyCompareTransform(container);
        }
      } else if (e.touches.length === 1 && !isPinching) {
        const dx = e.touches[0].clientX - touchStartX;
        const dy = e.touches[0].clientY - touchStartY;
        if (Math.abs(dx) > 6 || Math.abs(dy) > 6) {
          touchMoved = true;
        }
        if (compareZoom > 1) {
          e.preventDefault();
          isTouchPanning = true;
          panX = panStartX + dx;
          panY = panStartY + dy;
          applyCompareTransform(container);
        }
      }
    },
    { passive: false }
  );

  container.addEventListener(
    'touchend',
    (e) => {
      if (!isCompareOpen()) return;
      if (isPinching) {
        if (e.touches.length < 2) {
          isPinching = false;
          isTouchPanning = false;
          if (e.touches.length === 1) {
            touchStartX = e.touches[0].clientX;
            touchStartY = e.touches[0].clientY;
            panStartX = panX;
            panStartY = panY;
            touchMoved = true;
          }
          updateCompareZoomUI(container);
          applyCompareTransform(container);
          lastTapTime = 0;
        }
        return;
      }

      isTouchPanning = false;
      applyCompareTransform(container);

      if (!e.target.closest('.compare-stage') || e.changedTouches.length === 0) return;
      const touch = e.changedTouches[0];
      const now = Date.now();

      if (
        !touchMoved &&
        now - lastTapTime < 280 &&
        Math.hypot(touch.clientX - lastTapX, touch.clientY - lastTapY) < 24
      ) {
        lastTapTime = 0;
        suppressNextDblClickUntil = now + 400;
        compareZoom = compareZoom > 1 ? 1 : 2;
        panX = 0;
        panY = 0;
        updateCompareZoomUI(container);
        applyCompareTransform(container);
        return;
      }

      if (!touchMoved) {
        lastTapTime = now;
        lastTapX = touch.clientX;
        lastTapY = touch.clientY;
      } else {
        lastTapTime = 0;
      }
    },
    { passive: true }
  );

  container.addEventListener(
    'touchcancel',
    () => {
      isPinching = false;
      isTouchPanning = false;
      applyCompareTransform(container);
    },
    { passive: true }
  );

  container.addEventListener(
    'wheel',
    (e) => {
      if (!isCompareOpen()) return;
      if (!e.target.closest('.compare-stage')) return;
      e.preventDefault();
      const step = e.deltaY < 0 ? 0.25 : -0.25;
      const next = Math.max(1, Math.min(3, Number((compareZoom + step).toFixed(2))));
      if (next === compareZoom) return;
      compareZoom = next;
      if (compareZoom <= 1) {
        panX = 0;
        panY = 0;
      }
      updateCompareZoomUI(container);
      applyCompareTransform(container);
    },
    { passive: false }
  );

  window.addEventListener('mousemove', (e) => {
    if (!isDragging || !isCompareOpen()) return;
    panX = e.clientX - dragStartX;
    panY = e.clientY - dragStartY;
    applyCompareTransform(container);
  });

  const endDrag = () => {
    if (!isDragging) return;
    isDragging = false;
    applyCompareTransform(container);
  };

  window.addEventListener('mouseup', endDrag);
  window.addEventListener('blur', endDrag);
}
