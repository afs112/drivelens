import { downloadOriginalFile } from '../api/gdrive.js';
import { getLocaleTag, t } from '../i18n.js';
import { loadPhotoIntoElement } from '../storage/imageLoader.js';
import { escapeAttr, escapeHtml, icon } from './icons.js';

function formatBytes(bytes) {
  const n = Number(bytes || 0);
  if (!n) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

function formatDate(raw) {
  if (!raw) return '—';
  const normalized = /^\d{4}:\d{2}:\d{2}\s/.test(raw)
    ? raw.replace(/^(\d{4}):(\d{2}):(\d{2})\s/, '$1-$2-$3T')
    : raw;
  const d = new Date(normalized);
  if (Number.isNaN(d.getTime())) return raw;
  return d.toLocaleString(getLocaleTag(), { hour12: false });
}

function formatShutter(sec) {
  const n = Number(sec || 0);
  if (!n) return '';
  if (n >= 1) return `${n}s`;
  return `1/${Math.round(1 / n)}s`;
}

function getInitial(name) {
  const s = String(name || '?').trim();
  return s ? s[0].toUpperCase() : '?';
}

let lastInspectorKey = '';

export function renderInspector(container, store) {
  if (!container) return;
  const state = store.state;
  container.classList.toggle('collapsed', !state.inspectorOpen);
  if (!state.inspectorOpen) return;

  // Preserve typing focus if user is actively editing #myNoteInput for the same photo
  const activeEl = document.activeElement;
  if (
    activeEl &&
    activeEl.id === 'myNoteInput' &&
    activeEl.dataset.photoId === state.focusedPhotoId &&
    state.selectedPhotoIds.size <= 1
  ) {
    return;
  }

  const selectedCount = state.selectedPhotoIds.size;

  // Multi-select batch inspector view
  if (selectedCount > 1) {
    lastInspectorKey = `multi:${selectedCount}`;
    container.innerHTML = `
      <div class="inspector-scroll">
        <div class="inspector-card">
          <div class="inspector-card-title">
            <span>${escapeHtml(t('inspector.batchTitle'))}</span>
            <span style="color:var(--accent)">${escapeHtml(t('inspector.batchCount', { count: selectedCount }))}</span>
          </div>
          <div class="form-help">${escapeHtml(t('inspector.batchHelp'))}</div>
          <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:4px">
            <div class="star-input">
              ${[1, 2, 3, 4, 5]
                .map(
                  (r) =>
                    `<button type="button" class="star-btn" data-insp="batch-rate" data-rating="${r}" title="${escapeAttr(t('inspector.batchRateTitle', { n: r }))}">${icon('starFilled', 18)}</button>`
                )
                .join('')}
            </div>
            <button type="button" class="btn btn-sm btn-ghost" data-insp="batch-rate" data-rating="0">${escapeHtml(t('inspector.clearRate'))}</button>
          </div>
          <div style="display:flex;gap:8px;margin-top:6px">
            <button type="button" class="btn btn-sm" style="flex:1" data-insp="batch-fav">${icon('heartFilled', 13)} ${escapeHtml(t('inspector.batchFavAll'))}</button>
            <button type="button" class="btn btn-sm btn-primary" style="flex:1" data-insp="batch-tag">${icon('tag', 13)} ${escapeHtml(t('inspector.batchTag'))}</button>
          </div>
          <button type="button" class="btn btn-sm btn-ghost" data-insp="clear-select">${escapeHtml(t('inspector.cancelMulti'))}</button>
        </div>
      </div>
    `;
    return;
  }

  const photoId = state.lightboxPhotoId || state.focusedPhotoId || Array.from(state.selectedPhotoIds)[0];
  const file = state.files.find((f) => f.id === photoId);

  if (!file) {
    lastInspectorKey = 'empty';
    container.innerHTML = `
      <div class="inspector-empty">
        ${icon('info', 30)}
        <div style="font-size:13.5px;color:var(--text-primary)">${escapeHtml(t('inspector.emptyTitle'))}</div>
        <div style="font-size:12px">${escapeHtml(t('inspector.emptyHelp'))}</div>
      </div>
    `;
    return;
  }

  const meta = store.getAggregatedItemMeta(file.id);
  const schemaTags = state.tagSchema?.tags || {};
  const folder = state.folders.find((f) => f.id === file.parentId);
  const exif = file.imageMediaMetadata || {};
  const vid = file.videoMediaMetadata || {};

  const width = exif.width || vid.width || 0;
  const height = exif.height || vid.height || 0;
  const avgText = meta.avgRating > 0 ? meta.avgRating.toFixed(1) : t('inspector.na');

  const shouldRebuildPreview = lastInspectorKey !== file.id;
  lastInspectorKey = file.id;

  const myRatingHtml = [1, 2, 3, 4, 5]
    .map(
      (r) => `
      <button
        type="button"
        class="star-btn ${meta.myRating >= r ? 'filled' : ''}"
        data-insp="rate"
        data-photo-id="${escapeAttr(file.id)}"
        data-rating="${r}"
        title="${escapeAttr(t('inspector.rateTitle', { n: r }))}"
      >${icon(meta.myRating >= r ? 'starFilled' : 'star', 18)}</button>
    `
    )
    .join('');

  const friendListHtml =
    meta.ratingsByMember.length > 0
      ? meta.ratingsByMember
          .map(
            (entry) => `
          <div class="friend-rating-row">
            <span class="member-badge">
              <span class="member-avatar" style="background:${escapeAttr(entry.member.color || '#38bdf8')}">
                ${entry.member.picture ? `<img src="${escapeAttr(entry.member.picture)}" alt="" />` : escapeHtml(getInitial(entry.member.name))}
              </span>
              <span>${escapeHtml(entry.member.name)}${entry.member.id === state.currentUser.id ? escapeHtml(t('sidebar.meSuffix')) : ''}</span>
            </span>
            <span style="display:inline-flex;align-items:center;gap:6px">
              ${
                entry.rating > 0
                  ? `<span style="color:var(--star-gold);font-weight:600">${entry.rating} ★</span>`
                  : ''
              }
              ${entry.favorite ? `<span style="color:var(--heart-rose)">${icon('heartFilled', 13)}</span>` : ''}
            </span>
          </div>
        `
          )
          .join('')
      : `<div class="form-help">${escapeHtml(t('inspector.noRatings'))}</div>`;

  const tagsHtml = meta.activeTagIds
    .map((tid) => {
      const tag = schemaTags[tid];
      if (!tag) return '';
      return `
        <span class="tag-chip tag-color-${escapeAttr(tag.color || 'blue')}">
          <span class="tag-dot tag-color-${escapeAttr(tag.color || 'blue')}"></span>
          <span>${escapeHtml(tag.name)}</span>
          <span class="tag-chip-remove" data-insp="remove-tag" data-photo-id="${escapeAttr(file.id)}" data-tag-id="${escapeAttr(tid)}" title="${escapeAttr(t('inspector.removeTag'))}">${icon('x', 11)}</span>
        </span>
      `;
    })
    .join('');

  const notesHtml = meta.notesByMember
    .filter((n) => n.member.id !== state.currentUser.id)
    .map(
      (n) => `
      <div class="note-item">
        <div class="note-author">${escapeHtml(n.member.name)}</div>
        <div>${escapeHtml(n.note)}</div>
      </div>
    `
    )
    .join('');

  // Keep existing preview img element if photoId hasn't changed to avoid blinking
  const existingPreviewImg = !shouldRebuildPreview
    ? container.querySelector('.inspector-preview img')
    : null;

  container.innerHTML = `
    <div class="inspector-scroll">
      <div class="inspector-preview" data-insp="open-lightbox" data-photo-id="${escapeAttr(file.id)}" title="${escapeAttr(t('inspector.zoomPreview'))}">
        <img alt="${escapeAttr(file.name)}" />
      </div>

      <div>
        <div class="inspector-filename">${escapeHtml(file.name)}</div>
        <div class="inspector-sub">
          <span>${escapeHtml(folder?.name || t('inspector.rootFolder'))}</span>
          <span>${formatBytes(file.size)}</span>
        </div>
        <div style="display:flex;gap:6px;margin-top:8px">
          <button type="button" class="btn btn-sm" style="flex:1" data-insp="open-lightbox" data-photo-id="${escapeAttr(file.id)}">${icon('zoomIn', 13)} ${escapeHtml(t('inspector.fullScreen'))}</button>
          <button type="button" class="btn btn-sm" style="flex:1" data-insp="download" data-photo-id="${escapeAttr(file.id)}">${icon('download', 13)} ${escapeHtml(t('inspector.original'))}</button>
          ${
            file.webViewLink
              ? `<a class="btn btn-sm btn-icon" href="${escapeAttr(file.webViewLink)}" target="_blank" rel="noopener" title="${escapeAttr(t('inspector.openInDrive'))}">${icon('externalLink', 13)}</a>`
              : ''
          }
        </div>
      </div>

      <!-- Rating & Favorite -->
      <div class="inspector-card">
        <div class="inspector-card-title">
          <span>${escapeHtml(t('inspector.ratingSection'))}</span>
          <span style="color:var(--star-gold)">${escapeHtml(t('inspector.avgSummary', { avg: avgText, count: meta.ratingCount }))}</span>
        </div>
        <div style="display:flex;align-items:center;justify-content:space-between;gap:8px">
          <div class="star-input">
            ${myRatingHtml}
          </div>
          <div style="display:inline-flex;align-items:center;gap:4px">
            ${
              meta.myRating > 0
                ? `<button type="button" class="btn btn-ghost btn-sm" data-insp="rate" data-photo-id="${escapeAttr(file.id)}" data-rating="0" title="${escapeAttr(t('inspector.clearMyRatingTitle'))}">${escapeHtml(t('inspector.clearRate'))}</button>`
                : ''
            }
            <button
              type="button"
              class="btn btn-sm ${meta.myFavorite ? 'is-active' : ''}"
              style="${meta.myFavorite ? 'color:var(--heart-rose);border-color:rgba(244,63,94,0.45);background:var(--heart-soft)' : ''}"
              data-insp="toggle-fav"
              data-photo-id="${escapeAttr(file.id)}"
              title="${escapeAttr(t('inspector.favToggleTitle'))}"
            >${icon(meta.myFavorite ? 'heartFilled' : 'heart', 13)} ${escapeHtml(meta.myFavorite ? t('inspector.favorited') : t('inspector.favorite'))}</button>
          </div>
        </div>
        <div class="friend-rating-list">
          ${friendListHtml}
        </div>
      </div>

      <!-- Tags -->
      <div class="inspector-card">
        <div class="inspector-card-title">
          <span>${escapeHtml(t('inspector.sharedTags', { count: meta.activeTagIds.length }))}</span>
          <button type="button" class="btn btn-ghost btn-sm" data-insp="open-quick-tag" data-photo-id="${escapeAttr(file.id)}">${icon('plus', 12)} ${escapeHtml(t('inspector.addTagBtn'))}</button>
        </div>
        <div style="display:flex;flex-wrap:wrap;gap:6px">
          ${tagsHtml || `<span class="form-help">${escapeHtml(t('inspector.noTagsHint'))}</span>`}
        </div>
      </div>

      <!-- Notes -->
      <div class="inspector-card">
        <div class="inspector-card-title">
          <span>${escapeHtml(t('inspector.notesSection'))}</span>
        </div>
        ${notesHtml ? `<div class="note-list">${notesHtml}</div>` : ''}
        <textarea
          id="myNoteInput"
          class="note-textarea"
          data-photo-id="${escapeAttr(file.id)}"
          placeholder="${escapeAttr(t('inspector.notePlaceholder'))}"
        >${escapeHtml(meta.myNote)}</textarea>
      </div>

      <!-- EXIF -->
      <div class="inspector-card">
        <div class="inspector-card-title"><span>${escapeHtml(t('inspector.exifSection'))}</span></div>
        <div class="exif-grid">
          <span class="exif-label">${escapeHtml(t('inspector.exifTime'))}</span>
          <span class="exif-value">${escapeHtml(formatDate(exif.time || file.createdTime))}</span>
          <span class="exif-label">${escapeHtml(t('inspector.exifResolution'))}</span>
          <span class="exif-value">${width && height ? `${width} × ${height}` : '—'}</span>
          <span class="exif-label">${escapeHtml(t('inspector.exifCamera'))}</span>
          <span class="exif-value">${escapeHtml([exif.cameraMake, exif.cameraModel].filter(Boolean).join(' ') || '—')}</span>
          <span class="exif-label">${escapeHtml(t('inspector.exifLens'))}</span>
          <span class="exif-value">${[exif.focalLength ? `${exif.focalLength}mm` : '', exif.aperture ? `f/${exif.aperture}` : ''].filter(Boolean).join(' · ') || '—'}</span>
          <span class="exif-label">${escapeHtml(t('inspector.exifExposure'))}</span>
          <span class="exif-value">${[formatShutter(exif.exposureTime), exif.isoSpeed ? `ISO ${exif.isoSpeed}` : ''].filter(Boolean).join(' · ') || '—'}</span>
        </div>
      </div>
    </div>
  `;

  const newImg = container.querySelector('.inspector-preview img');
  if (newImg) {
    if (existingPreviewImg && existingPreviewImg.src) {
      newImg.src = existingPreviewImg.src;
      newImg.classList.add('is-loaded');
    } else {
      loadPhotoIntoElement(newImg, file, {
        size: 600,
        eager: true,
        getAccessToken: () => store.state.accessToken,
        getApiKey: () => store.state.apiKey,
      });
    }
  }
}

export function bindInspectorEvents(container, store) {
  if (!container) return;

  container.addEventListener('input', (e) => {
    if (e.target.id === 'myNoteInput') {
      const pid = e.target.dataset.photoId;
      store.setMyNote(pid, e.target.value);
    }
  });

  container.addEventListener('click', (e) => {
    const el = e.target.closest('[data-insp]');
    if (!el) return;
    const action = el.dataset.insp;
    const pid = el.dataset.photoId;

    if (action === 'open-lightbox') {
      store.openLightbox(pid);
    } else if (action === 'download') {
      const file = store.state.files.find((f) => f.id === pid);
      if (file) {
        downloadOriginalFile(file, store.state.accessToken, store.state.apiKey).catch((err) =>
          store.toast(err?.message || t('inspector.downloadFailed'), 'error')
        );
      }
    } else if (action === 'rate') {
      const rating = Number(el.dataset.rating || 0);
      const current = store.getAggregatedItemMeta(pid).myRating;
      store.setRating([pid], rating === current ? 0 : rating);
    } else if (action === 'toggle-fav') {
      store.toggleFavorite([pid]);
    } else if (action === 'remove-tag') {
      store.toggleTagOnPhotos([pid], el.dataset.tagId, false);
    } else if (action === 'open-quick-tag') {
      store.openModal('quickTag', { photoIds: [pid] });
    } else if (action === 'batch-rate') {
      store.setRating(Array.from(store.state.selectedPhotoIds), Number(el.dataset.rating || 0));
    } else if (action === 'batch-fav') {
      store.toggleFavorite(Array.from(store.state.selectedPhotoIds), true);
    } else if (action === 'batch-tag') {
      store.openModal('quickTag', { photoIds: Array.from(store.state.selectedPhotoIds) });
    } else if (action === 'clear-select') {
      store.clearSelection();
    }
  });
}
