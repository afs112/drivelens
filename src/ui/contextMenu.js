import { buildDriveWebViewLink, downloadOriginalFile } from '../api/gdrive.js';
import { t } from '../i18n.js';
import { escapeAttr, escapeHtml, icon, starSectorIcon } from './icons.js';
import { openCompare } from './renderCompare.js';

let menuEl = null;
let activeSession = null;
let globalListenersAttached = false;

function findFileById(store, photoId) {
  if (!store || !photoId) return null;
  if (typeof store.getFileById === 'function') {
    const found = store.getFileById(photoId);
    if (found) return found;
  }
  const files = store.state?.files;
  if (!Array.isArray(files)) return null;
  return files.find((f) => f.id === photoId) || null;
}

function resolveComparePair(visiblePhotos, photoId) {
  if (!Array.isArray(visiblePhotos) || visiblePhotos.length < 2) return null;
  const idx = visiblePhotos.findIndex((p) => p.id === photoId);
  if (idx >= 0) {
    if (idx + 1 < visiblePhotos.length) {
      return [photoId, visiblePhotos[idx + 1].id];
    }
    if (idx - 1 >= 0) {
      return [photoId, visiblePhotos[idx - 1].id];
    }
  }
  const alt = visiblePhotos.find((p) => p.id !== photoId);
  return alt ? [photoId, alt.id] : null;
}

function handleOutsidePointerDown(e) {
  if (!isPhotoContextMenuOpen()) return;
  if (menuEl && menuEl.contains(e.target)) return;
  closePhotoContextMenu();
}

function handleGlobalScroll() {
  if (!isPhotoContextMenuOpen()) return;
  closePhotoContextMenu();
}

function handleGlobalResize() {
  if (!isPhotoContextMenuOpen()) return;
  closePhotoContextMenu();
}

function handleGlobalKeyDown(e) {
  if (!isPhotoContextMenuOpen()) return;
  if (e.key === 'Escape') {
    e.preventDefault();
    e.stopPropagation();
    closePhotoContextMenu();
    return;
  }
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    const items = Array.from(menuEl.querySelectorAll('.photo-ctx-item:not(:disabled)'));
    if (items.length === 0) return;
    e.preventDefault();
    const curIdx = items.indexOf(document.activeElement);
    const delta = e.key === 'ArrowDown' ? 1 : -1;
    const nextIdx =
      curIdx === -1 ? (delta > 0 ? 0 : items.length - 1) : (curIdx + delta + items.length) % items.length;
    items[nextIdx]?.focus();
  }
}

function attachGlobalListeners() {
  if (globalListenersAttached || typeof window === 'undefined') return;
  globalListenersAttached = true;
  window.addEventListener('pointerdown', handleOutsidePointerDown, true);
  window.addEventListener('scroll', handleGlobalScroll, true);
  window.addEventListener('resize', handleGlobalResize);
  window.addEventListener('keydown', handleGlobalKeyDown, true);
}

function detachGlobalListeners() {
  if (!globalListenersAttached || typeof window === 'undefined') return;
  globalListenersAttached = false;
  window.removeEventListener('pointerdown', handleOutsidePointerDown, true);
  window.removeEventListener('scroll', handleGlobalScroll, true);
  window.removeEventListener('resize', handleGlobalResize);
  window.removeEventListener('keydown', handleGlobalKeyDown, true);
}

function ensureMenuElement() {
  if (menuEl && menuEl.isConnected) return menuEl;
  menuEl = document.createElement('div');
  menuEl.className = 'photo-context-menu';
  menuEl.setAttribute('role', 'menu');
  menuEl.setAttribute('aria-hidden', 'true');
  menuEl.hidden = true;

  menuEl.addEventListener('contextmenu', (e) => {
    e.preventDefault();
  });

  menuEl.addEventListener('click', (e) => {
    const actionEl = e.target.closest('[data-ctx]');
    if (!actionEl || !activeSession) return;
    const act = actionEl.dataset.ctx;
    const { photoId, file, store, context, onCloseLightbox, targetIds, meta, comparePair } =
      activeSession;

    if (act === 'rate') {
      const clickedRating = Math.max(0, Math.min(5, Number(actionEl.dataset.rating || 0)));
      const nextRating = clickedRating === meta.myRating ? 0 : clickedRating;
      store.setRating(targetIds, nextRating);
      closePhotoContextMenu();
      return;
    }

    if (act === 'fav') {
      store.toggleFavorite(targetIds, !meta.myFavorite);
      closePhotoContextMenu();
      return;
    }

    if (act === 'open-lightbox') {
      closePhotoContextMenu();
      store.openLightbox(photoId);
      return;
    }

    if (act === 'exit-lightbox') {
      closePhotoContextMenu();
      if (typeof onCloseLightbox === 'function') {
        onCloseLightbox();
      } else {
        store.closeLightbox();
      }
      return;
    }

    if (act === 'compare-selected') {
      closePhotoContextMenu();
      openCompare(targetIds, store);
      return;
    }

    if (act === 'compare-next') {
      closePhotoContextMenu();
      if (comparePair && comparePair.length >= 2) {
        openCompare(comparePair, store);
      }
      return;
    }

    if (act === 'manage-tags') {
      closePhotoContextMenu();
      store.openModal('quickTag', { photoIds: targetIds });
      return;
    }

    if (act === 'toggle-select') {
      closePhotoContextMenu();
      if (typeof store.toggleSelectPhoto === 'function') {
        store.toggleSelectPhoto(photoId);
      } else {
        store.toggleSelectCheckbox(photoId);
      }
      return;
    }

    if (act === 'select-all') {
      closePhotoContextMenu();
      store.selectAllVisible();
      return;
    }

    if (act === 'clear-selection') {
      closePhotoContextMenu();
      store.clearSelection();
      return;
    }

    if (act === 'view-details') {
      closePhotoContextMenu();
      if (context === 'lightbox') {
        if (typeof onCloseLightbox === 'function') {
          onCloseLightbox();
        } else {
          store.closeLightbox();
        }
      }
      store.setState({
        focusedPhotoId: photoId,
        inspectorOpen: true,
        sidebarOpen: false,
      });
      return;
    }

    if (act === 'download') {
      const accessToken = store.state.accessToken || '';
      const apiKey = store.state.apiKey || '';
      const isBatchDownload = targetIds.length > 1 && targetIds.length <= 10;
      closePhotoContextMenu();
      if (isBatchDownload) {
        (async () => {
          for (const id of targetIds) {
            const targetFile = findFileById(store, id);
            if (targetFile) {
              await downloadOriginalFile(targetFile, accessToken, apiKey);
            }
          }
        })().catch((err) => {
          store.toast(err?.message || String(err), 'error');
        });
      } else {
        Promise.resolve(downloadOriginalFile(file, accessToken, apiKey)).catch((err) => {
          store.toast(err?.message || String(err), 'error');
        });
      }
      return;
    }

    if (act === 'open-drive') {
      closePhotoContextMenu();
      if (!file.isDemo) {
        const url = file.webViewLink || buildDriveWebViewLink(file.id);
        if (url) {
          window.open(url, '_blank', 'noopener');
        }
      }
      return;
    }

    if (act === 'copy-filename') {
      const filename = file.name || '';
      closePhotoContextMenu();
      const copyTask = navigator.clipboard?.writeText
        ? navigator.clipboard.writeText(filename).catch(() => {})
        : Promise.resolve();
      copyTask.finally(() => {
        store.toast(t('ctx.copiedFilename', { name: filename }), 'info');
      });
    }
  });

  document.body.appendChild(menuEl);
  return menuEl;
}

export function isPhotoContextMenuOpen() {
  return Boolean(menuEl && menuEl.isConnected && menuEl.classList.contains('is-open'));
}

export function closePhotoContextMenu() {
  activeSession = null;
  detachGlobalListeners();
  if (!menuEl) return;
  menuEl.classList.remove('is-open');
  menuEl.setAttribute('aria-hidden', 'true');
  menuEl.hidden = true;
}

export function openPhotoContextMenu({
  x = 0,
  y = 0,
  photoId,
  store,
  context = 'gallery',
  onCloseLightbox = null,
} = {}) {
  if (!store || !photoId || typeof document === 'undefined') return;
  const file = findFileById(store, photoId);
  if (!file) {
    closePhotoContextMenu();
    return;
  }

  const selectedSet = store.state?.selectedPhotoIds || new Set();
  const isSelected = selectedSet.has(photoId);
  const isMultiTarget = isSelected && selectedSet.size > 1;
  const targetIds = isMultiTarget ? Array.from(selectedSet) : [photoId];
  const meta = store.getAggregatedItemMeta(photoId);
  const visiblePhotos = typeof store.getVisiblePhotos === 'function' ? store.getVisiblePhotos() : [];
  const comparePair = resolveComparePair(visiblePhotos, photoId);
  const canCompareMulti = isMultiTarget && targetIds.length >= 2 && targetIds.length <= 4;
  const canComparePair = !canCompareMulti && Boolean(comparePair);
  const canBatchDownload = isMultiTarget && targetIds.length <= 10;

  activeSession = {
    photoId,
    file,
    store,
    context,
    onCloseLightbox,
    targetIds,
    meta,
    comparePair,
  };

  const starsHtml = [1, 2, 3, 4, 5]
    .map((r) => {
      const active = meta.myRating >= r;
      return `<button
        type="button"
        class="photo-ctx-star-btn${active ? ' is-active' : ''}"
        data-ctx="rate"
        data-rating="${r}"
        aria-pressed="${active ? 'true' : 'false'}"
        title="${escapeAttr(`${t('ctx.quickRate')} (${r})`)}">${starSectorIcon(active ? 5 : 0, 15)}</button>`;
    })
    .join('');

  const favHtml = `<button
    type="button"
    class="photo-ctx-fav-btn${meta.myFavorite ? ' is-active' : ''}"
    data-ctx="fav"
    aria-pressed="${meta.myFavorite ? 'true' : 'false'}"
    title="${escapeAttr(t('ctx.toggleFav'))}"
    aria-label="${escapeAttr(t('ctx.toggleFav'))}">${icon(meta.myFavorite ? 'heartFilled' : 'heart', 15)}</button>`;

  const primaryToggleHtml =
    context === 'lightbox'
      ? `<button type="button" class="photo-ctx-item" role="menuitem" data-ctx="exit-lightbox">${icon('x', 15)}<span>${escapeHtml(t('ctx.exitLightbox'))}</span></button>`
      : `<button type="button" class="photo-ctx-item" role="menuitem" data-ctx="open-lightbox">${icon('zoomIn', 15)}<span>${escapeHtml(t('ctx.openLightbox'))}</span></button>`;

  const compareHtml = canCompareMulti
    ? `<button type="button" class="photo-ctx-item" role="menuitem" data-ctx="compare-selected">${icon('compare', 15)}<span>${escapeHtml(t('ctx.compareSelected', { count: targetIds.length }))}</span></button>`
    : canComparePair
      ? `<button type="button" class="photo-ctx-item" role="menuitem" data-ctx="compare-next">${icon('compare', 15)}<span>${escapeHtml(t('ctx.compareWithNext'))}</span></button>`
      : '';

  const selectHtml = `<button type="button" class="photo-ctx-item" role="menuitem" data-ctx="toggle-select">${icon(isSelected ? 'checkCircle' : 'check', 15)}<span>${escapeHtml(isSelected ? t('ctx.deselectPhoto') : t('ctx.selectPhoto'))}</span></button>`;

  const selectAllHtml =
    visiblePhotos.length > 0
      ? `<button type="button" class="photo-ctx-item" role="menuitem" data-ctx="select-all">${icon('grid', 15)}<span>${escapeHtml(t('ctx.selectAllVisible', { count: visiblePhotos.length }))}</span></button>`
      : '';

  const clearSelHtml =
    selectedSet.size > 0
      ? `<button type="button" class="photo-ctx-item" role="menuitem" data-ctx="clear-selection">${icon('x', 15)}<span>${escapeHtml(t('ctx.clearSelection'))}</span></button>`
      : '';

  const downloadLabel = canBatchDownload
    ? t('ctx.downloadSelected', { count: targetIds.length })
    : t('ctx.downloadOriginal');

  const driveHtml = !file.isDemo
    ? `<button type="button" class="photo-ctx-item" role="menuitem" data-ctx="open-drive">${icon('externalLink', 15)}<span>${escapeHtml(t('ctx.openInDrive'))}</span></button>`
    : '';

  const el = ensureMenuElement();
  el.innerHTML = `
    <div class="photo-ctx-quickbar" role="group" aria-label="${escapeAttr(t('ctx.quickRate'))}">
      <div class="photo-ctx-stars">${starsHtml}</div>
      ${favHtml}
    </div>
    <div class="photo-ctx-sep" role="separator"></div>
    ${primaryToggleHtml}
    ${compareHtml}
    <button type="button" class="photo-ctx-item" role="menuitem" data-ctx="manage-tags">${icon('tag', 15)}<span>${escapeHtml(t('ctx.manageTags'))}</span></button>
    <div class="photo-ctx-sep" role="separator"></div>
    ${selectHtml}
    ${selectAllHtml}
    ${clearSelHtml}
    <div class="photo-ctx-sep" role="separator"></div>
    <button type="button" class="photo-ctx-item" role="menuitem" data-ctx="view-details">${icon('info', 15)}<span>${escapeHtml(t('ctx.viewDetails'))}</span></button>
    <button type="button" class="photo-ctx-item" role="menuitem" data-ctx="download">${icon('download', 15)}<span>${escapeHtml(downloadLabel)}</span></button>
    ${driveHtml}
    <button type="button" class="photo-ctx-item" role="menuitem" data-ctx="copy-filename">${icon('edit', 15)}<span>${escapeHtml(t('ctx.copyFilename'))}</span></button>
  `;

  el.hidden = false;
  el.style.left = '0px';
  el.style.top = '0px';
  el.classList.add('is-open');
  el.setAttribute('aria-hidden', 'false');

  const rect = el.getBoundingClientRect();
  const margin = 8;
  const vw = window.innerWidth || 1280;
  const vh = window.innerHeight || 800;
  const clampedX = Math.max(margin, Math.min(vw - rect.width - margin, Number(x) || 0));
  const clampedY = Math.max(margin, Math.min(vh - rect.height - margin, Number(y) || 0));
  el.style.left = `${Math.round(clampedX)}px`;
  el.style.top = `${Math.round(clampedY)}px`;

  attachGlobalListeners();
}
