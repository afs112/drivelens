import { getLocaleTag, t } from '../i18n.js';
import { resolvePhotoTimestamp } from '../state/store.js';
import {
  buildDesktopDragDownloadSpec,
  cancelElementPhotoLoad,
  getAdaptiveThumbTier,
  loadPhotoIntoElement,
  preloadPhoto,
  quantizeThumbSize,
} from '../storage/imageLoader.js';
import { openPhotoContextMenu } from './contextMenu.js';
import { escapeAttr, escapeHtml, icon, starSectorIcon } from './icons.js';
import { openCompare } from './renderCompare.js';

const MAX_STAGE_PX = 12_000_000;
const STAGE_BAND_PX = 65536;
const MAX_MOUNTED_CARDS = 260;
const MAX_FREE_CARD_POOL = 220;
const ANCHOR_TTL_MS = 260;

const monthFormatterCache = new Map();
const fallbackVersionMap = new WeakMap();
let fallbackVersionSeq = 0;

function getPhotoTimestampValue(file) {
  return resolvePhotoTimestamp(file);
}

function getPhotosVersion(store, visiblePhotos) {
  if (typeof store?.visiblePhotosVersion === 'number') {
    return store.visiblePhotosVersion;
  }
  if (!visiblePhotos) return 0;
  let ver = fallbackVersionMap.get(visiblePhotos);
  if (ver === undefined) {
    fallbackVersionSeq += 1;
    ver = fallbackVersionSeq;
    fallbackVersionMap.set(visiblePhotos, ver);
  }
  return ver;
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
  if (typeof file?._aspect === 'number' && file._aspect > 0) {
    return file._aspect;
  }
  const w = Number(file?.imageMediaMetadata?.width || file?.videoMediaMetadata?.width || 0);
  const h = Number(file?.imageMediaMetadata?.height || file?.videoMediaMetadata?.height || 0);
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

function computeVirtualLayout(
  visiblePhotos,
  layoutMode,
  roundedWidth,
  clampedRowHeight,
  isMobile,
  photosVer
) {
  const n = visiblePhotos.length;
  const cacheKey = `${photosVer}|${n}|${layoutMode}|${roundedWidth}|${clampedRowHeight}|${isMobile ? 1 : 0}`;
  if (cachedLayout && cachedLayout.cacheKey === cacheKey) {
    return cachedLayout;
  }

  const itemX = new Float32Array(n);
  const itemY = new Float64Array(n);
  const itemW = new Float32Array(n);
  const itemH = new Float32Array(n);

  if (layoutMode === 'grid') {
    const gap = isMobile ? 3 : 8;
    const safeWidth = Math.max(240, roundedWidth);
    const minCard = isMobile
      ? Math.max(98, Math.round(clampedRowHeight * 0.5))
      : Math.max(130, clampedRowHeight - 20);
    const cols = Math.max(1, Math.floor((safeWidth + gap) / (minCard + gap)));
    const step = (safeWidth + gap) / cols;
    const colXs = new Float32Array(cols);
    const colWs = new Float32Array(cols);
    for (let c = 0; c < cols; c += 1) {
      const x = Math.round(c * step);
      const nextX = c === cols - 1 ? safeWidth + gap : Math.round((c + 1) * step);
      colXs[c] = x;
      colWs[c] = Math.max(48, nextX - x - gap);
    }
    const cellSize = Math.max(60, Math.round((safeWidth - gap * (cols - 1)) / cols));
    const rowStride = cellSize + gap;

    for (let i = 0; i < n; i += 1) {
      const c = i % cols;
      const r = (i - c) / cols;
      itemX[i] = colXs[c];
      itemY[i] = r * rowStride;
      itemW[i] = colWs[c];
      itemH[i] = cellSize;
    }

    const totalRows = n > 0 ? Math.ceil(n / cols) : 0;
    const logicalTotalHeight = totalRows > 0 ? totalRows * rowStride - gap : 0;

    cachedLayout = {
      cacheKey,
      mode: 'grid',
      count: n,
      containerWidth: roundedWidth,
      targetHeight: clampedRowHeight,
      isMobile,
      gap,
      logicalTotalHeight,
      itemX,
      itemY,
      itemW,
      itemH,
      cols,
      cellSize,
      rowStride,
    };
    return cachedLayout;
  }

  if (layoutMode === 'waterfall') {
    const gap = isMobile ? 4 : 10;
    const safeWidth = Math.max(220, roundedWidth);
    let colCount;
    if (isMobile) {
      if (safeWidth < 260 || clampedRowHeight >= 275) colCount = 1;
      else if (clampedRowHeight >= 190) colCount = 2;
      else if (clampedRowHeight >= 152) colCount = 3;
      else colCount = 4;
    } else {
      const tNorm = (clampedRowHeight - 130) / 190;
      const desiredColWidth = Math.round(135 + tNorm * 340);
      colCount = Math.max(
        2,
        Math.min(9, Math.round((safeWidth + gap) / (desiredColWidth + gap)))
      );
    }

    const step = (safeWidth + gap) / colCount;
    const colXs = new Float32Array(colCount);
    const colWs = new Float32Array(colCount);
    for (let c = 0; c < colCount; c += 1) {
      const x = Math.round(c * step);
      const nextX = c === colCount - 1 ? safeWidth + gap : Math.round((c + 1) * step);
      colXs[c] = x;
      colWs[c] = Math.max(60, nextX - x - gap);
    }

    const colHeights = new Float64Array(colCount);
    const colIndices = Array.from({ length: colCount }, () => []);
    const colTops = Array.from({ length: colCount }, () => []);
    const colBottoms = Array.from({ length: colCount }, () => []);

    for (let i = 0; i < n; i += 1) {
      let minCol = 0;
      let minH = colHeights[0];
      for (let c = 1; c < colCount; c += 1) {
        if (colHeights[c] < minH) {
          minH = colHeights[c];
          minCol = c;
        }
      }
      const ratio = getItemAspectRatio(visiblePhotos[i]);
      const cw = colWs[minCol];
      const h = Math.max(88, Math.round(cw / ratio));
      const y = minH;

      itemX[i] = colXs[minCol];
      itemY[i] = y;
      itemW[i] = cw;
      itemH[i] = h;

      colIndices[minCol].push(i);
      colTops[minCol].push(y);
      colBottoms[minCol].push(y + h);
      colHeights[minCol] = y + h + gap;
    }

    let maxColH = 0;
    for (let c = 0; c < colCount; c += 1) {
      if (colHeights[c] > maxColH) maxColH = colHeights[c];
    }
    const logicalTotalHeight = n > 0 ? Math.max(0, maxColH - gap) : 0;

    cachedLayout = {
      cacheKey,
      mode: 'waterfall',
      count: n,
      containerWidth: roundedWidth,
      targetHeight: clampedRowHeight,
      isMobile,
      gap,
      logicalTotalHeight,
      itemX,
      itemY,
      itemW,
      itemH,
      colCount,
      colIndices,
      colTops,
      colBottoms,
    };
    return cachedLayout;
  }

  // Justified layout (default)
  const gap = isMobile ? 4 : 8;
  const safeWidth = Math.max(260, roundedWidth);
  const effectiveRowHeight = isMobile
    ? Math.round(Math.max(105, clampedRowHeight * 0.62))
    : clampedRowHeight;

  const rowStarts = [];
  const rowEnds = [];
  const rowTops = [];
  const rowBottoms = [];

  let rowStart = 0;
  let sumRatios = 0;
  let y = 0;

  for (let i = 0; i < n; i += 1) {
    const ratio = getItemAspectRatio(visiblePhotos[i]);
    sumRatios += ratio;
    const countInRow = i - rowStart + 1;
    const naturalRowWidth = sumRatios * effectiveRowHeight + gap * (countInRow - 1);

    if (naturalRowWidth >= safeWidth) {
      const exactHeight = (safeWidth - gap * (countInRow - 1)) / sumRatios;
      const rowH = Math.max(40, Math.round(exactHeight));
      let x = 0;

      for (let k = rowStart; k <= i; k += 1) {
        const kRatio = getItemAspectRatio(visiblePhotos[k]);
        const w =
          k === i
            ? Math.max(48, Math.round(safeWidth - x))
            : Math.max(48, Math.floor(kRatio * exactHeight));
        itemX[k] = x;
        itemY[k] = y;
        itemW[k] = w;
        itemH[k] = rowH;
        x += w + gap;
      }

      rowStarts.push(rowStart);
      rowEnds.push(i + 1);
      rowTops.push(y);
      rowBottoms.push(y + rowH);

      y += rowH + gap;
      rowStart = i + 1;
      sumRatios = 0;
    }
  }

  if (rowStart < n) {
    const countInRow = n - rowStart;
    const naturalHeight = (safeWidth - gap * (countInRow - 1)) / Math.max(0.01, sumRatios);
    const rowH = Math.max(40, Math.round(Math.min(naturalHeight, effectiveRowHeight * 1.15)));
    let x = 0;

    for (let k = rowStart; k < n; k += 1) {
      const kRatio = getItemAspectRatio(visiblePhotos[k]);
      const w = Math.max(48, Math.round(kRatio * rowH));
      itemX[k] = x;
      itemY[k] = y;
      itemW[k] = w;
      itemH[k] = rowH;
      x += w + gap;
    }

    rowStarts.push(rowStart);
    rowEnds.push(n);
    rowTops.push(y);
    rowBottoms.push(y + rowH);
    y += rowH + gap;
  }

  const rowCount = rowStarts.length;
  const logicalTotalHeight = n > 0 ? Math.max(0, y - gap) : 0;

  cachedLayout = {
    cacheKey,
    mode: 'justified',
    count: n,
    containerWidth: roundedWidth,
    targetHeight: clampedRowHeight,
    isMobile,
    gap,
    logicalTotalHeight,
    itemX,
    itemY,
    itemW,
    itemH,
    rowCount,
    rowStartIdx: Int32Array.from(rowStarts),
    rowEndIdx: Int32Array.from(rowEnds),
    rowTop: Float64Array.from(rowTops),
    rowBottom: Float64Array.from(rowBottoms),
  };
  return cachedLayout;
}

function lowerBoundGreater(arr, len, target) {
  let lo = 0;
  let hi = len;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (arr[mid] > target) {
      hi = mid;
    } else {
      lo = mid + 1;
    }
  }
  return lo;
}

function upperBoundLess(arr, len, target) {
  let lo = 0;
  let hi = len;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (arr[mid] < target) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  return lo - 1;
}

function queryLayoutRange(layout, minY, maxY) {
  const n = layout.count;
  if (n === 0 || maxY < 0 || minY > layout.logicalTotalHeight) return [];

  if (layout.mode === 'grid') {
    const totalRows = Math.ceil(n / layout.cols);
    const startRow = Math.max(0, Math.floor(minY / layout.rowStride));
    const endRow = Math.min(totalRows - 1, Math.floor(maxY / layout.rowStride));
    if (endRow < startRow) return [];
    const startIdx = startRow * layout.cols;
    const endIdx = Math.min(n - 1, (endRow + 1) * layout.cols - 1);
    const out = new Array(endIdx - startIdx + 1);
    for (let i = startIdx, j = 0; i <= endIdx; i += 1, j += 1) {
      out[j] = i;
    }
    return out;
  }

  if (layout.mode === 'justified') {
    const rLen = layout.rowCount;
    if (rLen === 0) return [];
    const r0 = lowerBoundGreater(layout.rowBottom, rLen, minY);
    if (r0 >= rLen) return [];
    const r1 = upperBoundLess(layout.rowTop, rLen, maxY);
    if (r1 < r0) return [];
    const startIdx = layout.rowStartIdx[r0];
    const endIdx = layout.rowEndIdx[r1] - 1;
    const out = new Array(endIdx - startIdx + 1);
    for (let i = startIdx, j = 0; i <= endIdx; i += 1, j += 1) {
      out[j] = i;
    }
    return out;
  }

  // Waterfall
  const out = [];
  for (let c = 0; c < layout.colCount; c += 1) {
    const bottoms = layout.colBottoms[c];
    const tops = layout.colTops[c];
    const indices = layout.colIndices[c];
    const len = indices.length;
    if (len === 0) continue;
    let k = lowerBoundGreater(bottoms, len, minY);
    while (k < len && tops[k] < maxY) {
      out.push(indices[k]);
      k += 1;
    }
  }
  out.sort((a, b) => a - b);
  return out;
}

function getStageMetrics(layout, vh) {
  const logicalTotalHeight = layout.logicalTotalHeight;
  const isScaled = logicalTotalHeight > MAX_STAGE_PX;
  const physicalTotalHeight = isScaled ? MAX_STAGE_PX : logicalTotalHeight;
  const maxPhysicalScroll = Math.max(0, physicalTotalHeight - vh);
  const maxLogicalScroll = Math.max(0, logicalTotalHeight - vh);
  return {
    logicalTotalHeight,
    physicalTotalHeight,
    isScaled,
    maxPhysicalScroll,
    maxLogicalScroll,
  };
}

function scrollTopToLogicalTop(layout, scrollTop, vh) {
  const m = getStageMetrics(layout, vh);
  const clampedScroll = Math.max(0, Math.min(m.maxPhysicalScroll, scrollTop));
  if (!m.isScaled || m.maxPhysicalScroll <= 0 || m.maxLogicalScroll <= 0) {
    return Math.max(0, Math.min(m.maxLogicalScroll, clampedScroll));
  }
  return (clampedScroll / m.maxPhysicalScroll) * m.maxLogicalScroll;
}

function logicalTopToScrollTop(layout, logicalTop, vh) {
  const m = getStageMetrics(layout, vh);
  const clampedLogical = Math.max(0, Math.min(m.maxLogicalScroll, logicalTop));
  if (!m.isScaled || m.maxLogicalScroll <= 0 || m.maxPhysicalScroll <= 0) {
    return Math.max(0, Math.min(m.maxPhysicalScroll, clampedLogical));
  }
  return (clampedLogical / m.maxLogicalScroll) * m.maxPhysicalScroll;
}

function findAnchorItemIndexAtY(layout, targetY) {
  if (!layout || layout.count === 0) return -1;
  const y = Math.max(0, Math.min(layout.logicalTotalHeight, targetY));
  if (y <= 0) return 0;

  let candidates = queryLayoutRange(layout, y, y + 0.5);
  if (candidates.length === 0) {
    const pad = layout.gap + 8;
    candidates = queryLayoutRange(
      layout,
      Math.max(0, y - pad),
      Math.min(layout.logicalTotalHeight, y + pad)
    );
  }
  if (candidates.length === 0) {
    return y >= layout.logicalTotalHeight ? layout.count - 1 : 0;
  }

  let bestIdx = candidates[0];
  let bestDist = Infinity;
  for (let i = 0; i < candidates.length; i += 1) {
    const idx = candidates[i];
    const top = layout.itemY[idx];
    const bottom = top + layout.itemH[idx];
    if (y >= top && y <= bottom) {
      return idx;
    }
    const dist = y < top ? top - y : y - bottom;
    if (dist < bestDist) {
      bestDist = dist;
      bestIdx = idx;
    }
  }
  return bestIdx;
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

const mountedCardsById = new Map();
const freeCardPool = [];
const recentLookaheadPreloads = new Map();
let stageLayerEl = null;

let cachedLayout = null;
let activeLayout = null;
let activePhotos = [];
let activePhotosVer = 0;
let lastAnchorFilterKey = '';

let pooledAlbumKey = '';
let lastSubbarSignature = '';
let lastBatchSignature = '';
let lastGridSignature = '';
let lastFilterKey = '';
let lastVisiblePhotos = [];
let lastContainerWidth = 0;
let lastIsMobile = false;
let lastRenderedMode = '';
let lastStageHeightAttr = '';
let lastStageTransform = '';

let previewRafId = 0;
let pendingPreviewHeight = null;
let pendingPreviewFocalY = null;
let mobileSelectMode = false;
let scrollSettleCallback = null;
let gestureAnchor = null;
let lastProgrammaticScrollTop = -1;
let lastProgrammaticScrollAt = 0;

let activeHoverPeekClear = null;

function createCardElement(selectTitle) {
  const card = document.createElement('div');
  card.className = 'photo-card';
  card.draggable = true;
  card.innerHTML = `
    <div class="photo-skeleton"></div>
    <button type="button" class="photo-select-btn" data-action="toggle-select" title="${escapeAttr(selectTitle)}">
      ${icon('check', 13)}
    </button>
    <img alt="" decoding="async" draggable="false" />
    <div class="photo-overlay is-empty"></div>
  `;

  card._imgEl = card.querySelector('img');
  if (card._imgEl) {
    card._imgEl.draggable = false;
  }
  card._overlayEl = card.querySelector('.photo-overlay');
  card._selectBtn = card.querySelector('.photo-select-btn');
  card._selectTitle = selectTitle;
  card._videoBadgeEl = null;
  card._videoDurSpan = null;
  card._authSig = '';
  card._requestedThumbSize = 0;
  card._wasOnScreen = false;
  card._geomKey = '';
  card._selected = false;
  card._focused = false;
  card._overlayMode = 'empty';
  card._overlaySig = '';
  card._waterfall = false;
  return card;
}

function acquireFreeCard(file, selectTitle) {
  const card = freeCardPool.length > 0 ? freeCardPool.pop() : createCardElement(selectTitle);
  card.dataset.photoId = file.id;
  card.dataset.ts = String(getPhotoTimestampValue(file));
  if (card._imgEl) {
    card._imgEl.alt = file.name || '';
  }

  const isVideo = Boolean(file.mimeType && file.mimeType.startsWith('video/'));
  if (isVideo) {
    const dur = formatDuration(file.videoMediaMetadata?.durationMillis);
    const labelText = dur || t('gallery.video');
    if (!card._videoBadgeEl) {
      const badge = document.createElement('span');
      badge.className = 'photo-video-badge';
      badge.innerHTML = `${icon('video', 11)}<span></span>`;
      card._videoBadgeEl = badge;
      card._videoDurSpan = badge.querySelector('span');
    }
    if (card._videoDurSpan && card._videoDurSpan.textContent !== labelText) {
      card._videoDurSpan.textContent = labelText;
    }
    if (card._videoBadgeEl.parentElement !== card && card._imgEl) {
      card.insertBefore(card._videoBadgeEl, card._imgEl);
    }
  } else if (card._videoBadgeEl && card._videoBadgeEl.parentElement === card) {
    card._videoBadgeEl.remove();
  }

  return card;
}

function recycleCard(card) {
  if (!card) return;
  if (activeHoverPeekClear) {
    activeHoverPeekClear(card);
  }
  const imgEl = card._imgEl;
  if (imgEl) {
    cancelElementPhotoLoad(imgEl);
    imgEl.removeAttribute('src');
    imgEl.dataset.loadedSize = '0';
    delete imgEl.dataset.hdLoaded;
    delete imgEl._dlRetriedCachedSrc;
    imgEl.classList.remove('is-loaded');
  }
  card.classList.remove(
    'is-loaded',
    'has-img',
    'is-selected',
    'is-focused',
    'is-select-peek',
    'is-thumb-error',
    'waterfall-card'
  );
  card.style.removeProperty('--select-btn-top');
  card._selected = false;
  card._focused = false;
  card._authSig = '';
  card._requestedThumbSize = 0;
  card._wasOnScreen = false;
  card._geomKey = '';
  card._waterfall = false;
  card._overlayMode = 'empty';
  card._overlaySig = '';
  if (card._overlayEl) {
    card._overlayEl.className = 'photo-overlay is-empty';
    card._overlayEl.innerHTML = '';
  }
  if (card._videoBadgeEl && card._videoBadgeEl.parentElement === card) {
    card._videoBadgeEl.remove();
  }
  card.remove();
  if (freeCardPool.length < MAX_FREE_CARD_POOL) {
    freeCardPool.push(card);
  }
}

function clearAllMountedCards() {
  for (const entry of mountedCardsById.values()) {
    recycleCard(entry.el);
  }
  mountedCardsById.clear();
  recentLookaheadPreloads.clear();
  if (stageLayerEl) {
    stageLayerEl.remove();
    stageLayerEl = null;
  }
  lastStageHeightAttr = '';
  lastStageTransform = '';
}

function applyCardGeometry(card, x, relY, w, h, isWaterfall) {
  const geomKey = `${x}|${relY}|${w}|${h}`;
  if (card._geomKey !== geomKey) {
    card.style.width = `${w}px`;
    card.style.height = `${h}px`;
    card.style.transform = `translate3d(${x}px, ${relY}px, 0)`;
    card._geomKey = geomKey;
  }
  if (card._waterfall !== isWaterfall) {
    card.classList.toggle('waterfall-card', isWaterfall);
    card._waterfall = isWaterfall;
  }
}

function ensureStageDom(gridEl, physicalTotalHeight) {
  if (!stageLayerEl) {
    stageLayerEl = document.createElement('div');
    stageLayerEl.className = 'virtual-stage-layer';
  }
  gridEl.classList.add('is-virtual-stage');
  const nextHeightStr = `${Math.ceil(physicalTotalHeight)}px`;
  if (lastStageHeightAttr !== nextHeightStr || gridEl.style.height !== nextHeightStr) {
    gridEl.style.height = nextHeightStr;
    lastStageHeightAttr = nextHeightStr;
  }
  if (stageLayerEl.parentElement !== gridEl || gridEl.childElementCount !== 1) {
    gridEl.replaceChildren(stageLayerEl);
  }
}

function setScrollTopProgrammatically(scrollContainer, targetScrollTop) {
  const rounded = Math.max(0, Math.round(targetScrollTop));
  if (Math.abs((scrollContainer.scrollTop || 0) - rounded) < 0.5) return;
  scrollContainer.scrollTop = rounded;
  lastProgrammaticScrollTop = scrollContainer.scrollTop;
  lastProgrammaticScrollAt =
    typeof performance !== 'undefined' ? performance.now() : Date.now();
}

function selectBoundedIndices(layout, desiredIndices, onScreenMinY, onScreenMaxY, viewportCenterY) {
  if (desiredIndices.length <= MAX_MOUNTED_CARDS) {
    return desiredIndices;
  }
  const onScreen = [];
  const offScreen = [];
  for (let i = 0; i < desiredIndices.length; i += 1) {
    const idx = desiredIndices[i];
    const top = layout.itemY[idx];
    const bottom = top + layout.itemH[idx];
    if (bottom > onScreenMinY && top < onScreenMaxY) {
      onScreen.push(idx);
    } else {
      offScreen.push(idx);
    }
  }

  const distToCenter = (idx) => {
    const center = layout.itemY[idx] + layout.itemH[idx] * 0.5;
    return Math.abs(center - viewportCenterY);
  };

  if (onScreen.length >= MAX_MOUNTED_CARDS) {
    onScreen.sort((a, b) => distToCenter(a) - distToCenter(b));
    const sliced = onScreen.slice(0, MAX_MOUNTED_CARDS);
    sliced.sort((a, b) => a - b);
    return sliced;
  }

  offScreen.sort((a, b) => distToCenter(a) - distToCenter(b));
  const extra = MAX_MOUNTED_CARDS - onScreen.length;
  const combined = onScreen.concat(offScreen.slice(0, extra));
  combined.sort((a, b) => a - b);
  return combined;
}

function computeDirectionalOverscan(logicalTop, vh, logicalTotalHeight, vy) {
  const absVy = Math.abs(vy);
  let beforeMul = 0.85;
  let afterMul = 1.65;
  if (absVy >= 1400) {
    if (vy > 0) {
      beforeMul = 0.35;
      afterMul = 4.2;
    } else {
      beforeMul = 4.2;
      afterMul = 0.45;
    }
  } else if (absVy >= 250) {
    if (vy > 0) {
      beforeMul = 0.45;
      afterMul = 2.85;
    } else {
      beforeMul = 2.85;
      afterMul = 0.55;
    }
  }
  return {
    overscanMinY: Math.max(0, logicalTop - beforeMul * vh),
    overscanMaxY: Math.min(logicalTotalHeight, logicalTop + vh + afterMul * vh),
  };
}

function upgradeVisibleCardsOnScrollSettle(scrollContainer, store) {
  if (!scrollContainer || !store || store.state.loading || !activeLayout || activePhotos.length === 0) {
    return;
  }
  const vh = Math.max(
    1,
    scrollContainer.clientHeight || (typeof window !== 'undefined' ? window.innerHeight : 800)
  );
  const metrics = getStageMetrics(activeLayout, vh);
  const rawScrollTop = Math.max(0, scrollContainer.scrollTop || 0);
  const clampedScrollTop = Math.min(rawScrollTop, metrics.maxPhysicalScroll);
  const logicalTop = scrollTopToLogicalTop(activeLayout, clampedScrollTop, vh);
  const onScreenMinY = logicalTop;
  const onScreenMaxY = logicalTop + vh;
  const viewportCenterY = logicalTop + vh * 0.5;
  const getAccessToken = () => store.state.accessToken;
  const getApiKey = () => store.state.apiKey;

  for (const entry of mountedCardsById.values()) {
    const card = entry.el;
    const idx = entry.idx;
    const file = activePhotos[idx];
    if (!card || !card.isConnected || !card._imgEl || !file) continue;
    const y = activeLayout.itemY[idx];
    const h = activeLayout.itemH[idx];
    const w = activeLayout.itemW[idx];
    if (y + h <= onScreenMinY || y >= onScreenMaxY) continue;

    const imgEl = card._imgEl;
    if (imgEl.dataset.hdLoaded === 'true') continue;
    const desiredThumbPx = computeCardThumbTarget(Math.max(w, h));
    if (Number(imgEl.dataset.loadedSize || 0) < desiredThumbPx) {
      card._requestedThumbSize = desiredThumbPx;
      loadPhotoIntoElement(imgEl, file, {
        size: desiredThumbPx,
        virtualManaged: true,
        eager: true,
        priorityScore: Math.abs(y + h * 0.5 - viewportCenterY),
        scrollSpeedPxPerSec: 0,
        isLookahead: false,
        getAccessToken,
        getApiKey,
      });
    }
  }
}

function syncVirtualViewport(
  gridEl,
  scrollContainer,
  store,
  layout,
  visiblePhotos,
  { patchMeta = true, forceAllMeta = false } = {}
) {
  if (!gridEl || !scrollContainer || !layout || layout.count === 0) return;

  const vh = Math.max(
    1,
    scrollContainer.clientHeight || (typeof window !== 'undefined' ? window.innerHeight : 800)
  );
  const metrics = getStageMetrics(layout, vh);
  const rawScrollTop = Math.max(0, scrollContainer.scrollTop || 0);
  const clampedScrollTop = Math.min(rawScrollTop, metrics.maxPhysicalScroll);
  const logicalTop = scrollTopToLogicalTop(layout, clampedScrollTop, vh);
  const vy = Number(scrollContainer._dlScrollVelocityY || 0);
  const absVy = Math.abs(vy);

  let windowBaseY;
  let layerPhysicalY;
  if (metrics.isScaled) {
    windowBaseY = logicalTop;
    layerPhysicalY = clampedScrollTop;
  } else {
    windowBaseY = Math.floor(logicalTop / STAGE_BAND_PX) * STAGE_BAND_PX;
    layerPhysicalY = windowBaseY;
  }

  ensureStageDom(gridEl, metrics.physicalTotalHeight);

  const layerTransform = `translate3d(0, ${layerPhysicalY}px, 0)`;
  if (lastStageTransform !== layerTransform) {
    stageLayerEl.style.transform = layerTransform;
    lastStageTransform = layerTransform;
  }

  const onScreenMinY = logicalTop;
  const onScreenMaxY = logicalTop + vh;
  const { overscanMinY, overscanMaxY } = computeDirectionalOverscan(
    logicalTop,
    vh,
    metrics.logicalTotalHeight,
    vy
  );
  const viewportCenterY = logicalTop + vh * 0.5;

  const rawDesired = queryLayoutRange(layout, overscanMinY, overscanMaxY);
  const desiredIndices = selectBoundedIndices(
    layout,
    rawDesired,
    onScreenMinY,
    onScreenMaxY,
    viewportCenterY
  );

  const desiredById = new Map();
  for (let i = 0; i < desiredIndices.length; i += 1) {
    const idx = desiredIndices[i];
    const file = visiblePhotos[idx];
    if (file) {
      desiredById.set(file.id, idx);
    }
  }

  // Evict cards outside overscan window
  for (const [photoId, entry] of mountedCardsById.entries()) {
    if (!desiredById.has(photoId)) {
      recycleCard(entry.el);
      mountedCardsById.delete(photoId);
    }
  }

  const selectTitle = t('gallery.toggleSelect');
  const isWaterfall = layout.mode === 'waterfall';
  const hasToken = Boolean(store.state.accessToken);
  const hasKey = Boolean(store.state.apiKey);
  const getAccessToken = () => store.state.accessToken;
  const getApiKey = () => store.state.apiKey;

  let newCardsFrag = null;
  const pendingLoads = [];

  for (let i = 0; i < desiredIndices.length; i += 1) {
    const idx = desiredIndices[i];
    const file = visiblePhotos[idx];
    if (!file) continue;

    const x = layout.itemX[idx];
    const y = layout.itemY[idx];
    const w = layout.itemW[idx];
    const h = layout.itemH[idx];
    const relY = metrics.isScaled
      ? Math.round((y - windowBaseY) * 100) / 100
      : Math.round(y - windowBaseY);
    const isOnScreen = y + h > onScreenMinY && y < onScreenMaxY;
    const priorityScore = Math.abs(y + h * 0.5 - viewportCenterY);
    const desiredThumbPx = computeCardThumbTarget(Math.max(w, h));
    const authSig = `${file.id}|${file.thumbnailLink || ''}|${hasToken}|${hasKey}`;

    const existing = mountedCardsById.get(file.id);
    if (existing) {
      const card = existing.el;
      existing.idx = idx;
      if (card.parentElement !== stageLayerEl) {
        if (!newCardsFrag) newCardsFrag = document.createDocumentFragment();
        newCardsFrag.appendChild(card);
      }
      applyCardGeometry(card, x, relY, w, h, isWaterfall);
      const tsStr = String(getPhotoTimestampValue(file));
      if (card.dataset.ts !== tsStr) {
        card.dataset.ts = tsStr;
      }
      if (forceAllMeta || patchMeta) {
        patchCardMeta(card, file, store, selectTitle);
      }
      const enteredViewport = isOnScreen && !card._wasOnScreen;
      card._wasOnScreen = isOnScreen;
      const loadedSize = Number(card._imgEl?.dataset.loadedSize || 0);
      if (
        card._imgEl &&
        (card._authSig !== authSig ||
          (patchMeta && desiredThumbPx > Math.max(loadedSize, card._requestedThumbSize || 0)) ||
          (enteredViewport && loadedSize < desiredThumbPx && card._imgEl.dataset.hdLoaded !== 'true'))
      ) {
        card._authSig = authSig;
        card._requestedThumbSize = desiredThumbPx;
        pendingLoads.push({
          imgEl: card._imgEl,
          file,
          size: desiredThumbPx,
          eager: isOnScreen,
          priorityScore,
          scrollSpeedPxPerSec: absVy,
          isLookahead: !isOnScreen,
        });
      }
    } else {
      const card = acquireFreeCard(file, selectTitle);
      applyCardGeometry(card, x, relY, w, h, isWaterfall);
      patchCardMeta(card, file, store, selectTitle);
      card._authSig = authSig;
      card._requestedThumbSize = desiredThumbPx;
      card._wasOnScreen = isOnScreen;
      mountedCardsById.set(file.id, { el: card, idx });

      if (!newCardsFrag) newCardsFrag = document.createDocumentFragment();
      newCardsFrag.appendChild(card);

      if (card._imgEl) {
        pendingLoads.push({
          imgEl: card._imgEl,
          file,
          size: desiredThumbPx,
          eager: isOnScreen,
          priorityScore,
          scrollSpeedPxPerSec: absVy,
          isLookahead: !isOnScreen,
        });
      }
    }
  }

  if (newCardsFrag) {
    stageLayerEl.appendChild(newCardsFrag);
  }

  for (let i = 0; i < pendingLoads.length; i += 1) {
    const req = pendingLoads[i];
    loadPhotoIntoElement(req.imgEl, req.file, {
      size: req.size,
      virtualManaged: true,
      eager: req.eager,
      priorityScore: req.priorityScore,
      scrollSpeedPxPerSec: req.scrollSpeedPxPerSec,
      isLookahead: req.isLookahead,
      getAccessToken,
      getApiKey,
    });
  }

  // Ahead-of-DOM predictive preload strip in active scroll direction
  if (absVy >= 180) {
    const stripMinY = vy > 0 ? overscanMaxY : Math.max(0, overscanMinY - 1.5 * vh);
    const stripMaxY =
      vy > 0 ? Math.min(metrics.logicalTotalHeight, overscanMaxY + 1.5 * vh) : overscanMinY;
    if (stripMaxY > stripMinY) {
      const stripIndices = queryLayoutRange(layout, stripMinY, stripMaxY);
      const nowMs = typeof performance !== 'undefined' ? performance.now() : Date.now();
      const step = vy > 0 ? 1 : -1;
      let k = vy > 0 ? 0 : stripIndices.length - 1;
      let preloadedCount = 0;
      while (k >= 0 && k < stripIndices.length && preloadedCount < 24) {
        const idx = stripIndices[k];
        k += step;
        const file = visiblePhotos[idx];
        if (!file || desiredById.has(file.id)) continue;
        const desiredThumbPx = computeCardThumbTarget(
          Math.max(layout.itemW[idx], layout.itemH[idx])
        );
        const tier = getAdaptiveThumbTier(desiredThumbPx, {
          scrollSpeedPxPerSec: absVy,
          isLookahead: true,
        });
        const prevPreload = recentLookaheadPreloads.get(file.id);
        if (prevPreload && nowMs - prevPreload.at < 1200 && prevPreload.size >= tier) {
          continue;
        }
        recentLookaheadPreloads.set(file.id, { at: nowMs, size: tier });
        if (recentLookaheadPreloads.size > 300) {
          const oldest = recentLookaheadPreloads.keys().next().value;
          if (oldest !== undefined) recentLookaheadPreloads.delete(oldest);
        }
        preloadPhoto(file, {
          size: tier,
          getAccessToken,
          getApiKey,
        });
        preloadedCount += 1;
      }
    }
  }
}

export function setGalleryScrollSettleCallback(fn) {
  scrollSettleCallback = typeof fn === 'function' ? fn : null;
}

export function getCurrentPageSmartTargets(scrollContainer, store, visiblePhotos) {
  if (!store || !Array.isArray(visiblePhotos) || visiblePhotos.length === 0) {
    return { ratedPageItems: [], restPageItems: [] };
  }

  const len = visiblePhotos.length;
  let start = 0;
  let end = Math.min(len - 1, 59);
  let centerIdx = Math.round((start + end) * 0.5);

  if (activeLayout && activeLayout.count === len && scrollContainer) {
    const vh = Math.max(1, scrollContainer.clientHeight || 800);
    const logicalTop = scrollTopToLogicalTop(activeLayout, scrollContainer.scrollTop || 0, vh);
    const onScreen = queryLayoutRange(activeLayout, logicalTop, logicalTop + vh);
    if (onScreen.length > 0) {
      const minIdx = onScreen[0];
      const maxIdx = onScreen[onScreen.length - 1];
      centerIdx = Math.round((minIdx + maxIdx) * 0.5);
      start = Math.max(0, minIdx - 10);
      end = Math.min(len - 1, maxIdx + 10);
      if (end - start + 1 > 60) {
        start = Math.max(0, centerIdx - 30);
        end = Math.min(len - 1, start + 59);
      }
    }
  } else if (scrollContainer && scrollContainer.scrollHeight > scrollContainer.clientHeight) {
    const maxScroll = Math.max(1, scrollContainer.scrollHeight - scrollContainer.clientHeight);
    const ratio = Math.min(1, Math.max(0, scrollContainer.scrollTop / maxScroll));
    centerIdx = Math.round(ratio * Math.max(0, len - 1));
    start = Math.max(0, centerIdx - 30);
    end = Math.min(len - 1, start + 59);
  }

  const ratedCandidates = [];
  const restCandidates = [];
  for (let i = start; i <= end; i += 1) {
    const file = visiblePhotos[i];
    if (!file || file.isDemo || (file.mimeType && file.mimeType.startsWith('video/'))) continue;
    const meta = store.getAggregatedItemMeta(file.id);
    const dist = Math.abs(i - centerIdx);
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
    chips.push({ label: `${prefix} >= ${state.minRating}`, clear: 'minRating' });
  }
  for (const tid of state.selectedTagIds) {
    const tag = schemaTags[tid];
    if (tag) chips.push({ label: t('gallery.chipTag', { name: tag.name }), clear: `tag:${tid}` });
  }
  if (state.searchQuery.trim()) {
    chips.push({
      label: t('gallery.chipSearch', { q: state.searchQuery.trim() }),
      clear: 'search',
    });
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

function buildGridSignature(state, isMobile, rowHeight, roundedWidth, photosVer, count) {
  return `${state.lang}|${isMobile ? 'm' : 'd'}|${state.layoutMode}|${rowHeight}|${roundedWidth}|${photosVer}|${count}|${Boolean(state.accessToken)}|${Boolean(state.apiKey)}`;
}

function findSampleCardTimestamp(scrollContainer) {
  if (!activeLayout || activeLayout.count === 0 || activePhotos.length === 0) return 0;
  const vh = Math.max(1, scrollContainer?.clientHeight || 800);
  const logicalTop = scrollTopToLogicalTop(activeLayout, scrollContainer?.scrollTop || 0, vh);
  const probeY = Math.min(activeLayout.logicalTotalHeight, logicalTop + 72);
  const idx = findAnchorItemIndexAtY(activeLayout, probeY);
  if (idx < 0 || idx >= activePhotos.length) return 0;
  return getPhotoTimestampValue(activePhotos[idx]);
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

function ensureGalleryFloatingUi(gridEl, scrollContainer, store) {
  const host = scrollContainer.parentElement;
  if (!host) return;
  scrollContainer._dlStoreRef = store;
  scrollContainer._dlGridRef = gridEl;
  if (scrollContainer._dlFloatingAttached) {
    updateFloatingScrollState(scrollContainer, store, false);
    return;
  }

  const pillEl = document.createElement('div');
  pillEl.id = 'galleryMonthPill';
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

  let scrollVirtualRafId = 0;
  let lastScrollTop = scrollContainer.scrollTop || 0;
  let lastScrollTimeMs = 0;
  scrollContainer._dlScrollVelocityY = 0;
  scrollContainer.addEventListener(
    'scroll',
    () => {
      const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
      const curTopNow = scrollContainer.scrollTop || 0;
      if (
        lastProgrammaticScrollAt > 0 &&
        now - lastProgrammaticScrollAt < 80 &&
        Math.abs(curTopNow - lastProgrammaticScrollTop) <= 2
      ) {
        lastProgrammaticScrollAt = 0;
        lastScrollTop = curTopNow;
        lastScrollTimeMs = 0;
        scrollContainer._dlScrollVelocityY = 0;
        updateFloatingScrollState(scrollContainer, scrollContainer._dlStoreRef, false);
        return;
      }

      // User scroll clears any pending zoom/resize gesture anchor
      gestureAnchor = null;

      if (scrollVirtualRafId) return;
      scrollVirtualRafId = requestAnimationFrame(() => {
        scrollVirtualRafId = 0;
        const frameNow = typeof performance !== 'undefined' ? performance.now() : Date.now();
        const curTop = scrollContainer.scrollTop || 0;
        const delta = curTop - lastScrollTop;
        lastScrollTop = curTop;

        const dt =
          lastScrollTimeMs > 0 && frameNow - lastScrollTimeMs <= 250
            ? Math.max(8, frameNow - lastScrollTimeMs)
            : 32;
        lastScrollTimeMs = frameNow;
        if (Math.abs(delta) >= 0.5) {
          const rawVy = (delta / dt) * 1000;
          const prevVy = scrollContainer._dlScrollVelocityY || 0;
          if (prevVy !== 0 && Math.sign(rawVy) !== Math.sign(prevVy)) {
            scrollContainer._dlScrollVelocityY = rawVy * 0.65;
          } else if (prevVy === 0) {
            scrollContainer._dlScrollVelocityY = rawVy * 0.7;
          } else {
            scrollContainer._dlScrollVelocityY = prevVy * 0.55 + rawVy * 0.45;
          }
        }

        const curStore = scrollContainer._dlStoreRef;
        const curGrid = scrollContainer._dlGridRef;
        if (
          curGrid &&
          curStore &&
          !curStore.state.loading &&
          activeLayout &&
          activePhotos.length > 0
        ) {
          syncVirtualViewport(curGrid, scrollContainer, curStore, activeLayout, activePhotos, {
            patchMeta: true,
            forceAllMeta: false,
          });
        }

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

        updateFloatingScrollState(scrollContainer, curStore, true);
        clearTimeout(scrollContainer._dlVelocitySettleTimer);
        scrollContainer._dlVelocitySettleTimer = setTimeout(() => {
          scrollContainer._dlVelocitySettleTimer = 0;
          scrollContainer._dlScrollVelocityY = 0;
          lastScrollTimeMs = 0;
          upgradeVisibleCardsOnScrollSettle(scrollContainer, scrollContainer._dlStoreRef);
        }, 180);

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

function applyGalleryGeometry(
  gridEl,
  scrollContainer,
  store,
  visiblePhotos,
  targetHeight,
  patchMeta,
  focalScreenY = null
) {
  const state = store.state;
  const { layoutMode, lang } = state;
  const clampedRowHeight = Math.max(130, Math.min(320, Math.round(Number(targetHeight) || 210)));
  const isMobile = scrollContainer.clientWidth <= 600;
  const containerWidth = Math.max(
    240,
    gridEl.clientWidth || Math.max(0, scrollContainer.clientWidth - 4)
  );
  const roundedWidth = Math.round(containerWidth);
  const photosVer = getPhotosVersion(store, visiblePhotos);
  const filterKey = buildFilterKey(state);

  const vh = Math.max(
    1,
    scrollContainer.clientHeight || (typeof window !== 'undefined' ? window.innerHeight : 800)
  );
  const prevLayout = activeLayout;
  const prevPhotos = activePhotos;
  const prevScrollTop = Math.max(0, scrollContainer.scrollTop || 0);
  const now = typeof performance !== 'undefined' ? performance.now() : Date.now();

  let anchorToApply = null;
  const canPreserveAnchor = Boolean(
    prevLayout &&
      prevLayout.count > 0 &&
      (activePhotosVer === photosVer || filterKey === lastAnchorFilterKey)
  );

  if (canPreserveAnchor) {
    if (
      gestureAnchor &&
      gestureAnchor.expiresAt > now &&
      gestureAnchor.photosVer === photosVer
    ) {
      gestureAnchor.expiresAt = now + ANCHOR_TTL_MS;
      if (focalScreenY !== null) {
        gestureAnchor.focalScreenY = focalScreenY;
      }
      anchorToApply = gestureAnchor;
    } else if (prevScrollTop <= 4 && focalScreenY === null) {
      anchorToApply = { pinTop: true };
    } else {
      const focal = focalScreenY !== null ? focalScreenY : Math.min(110, vh * 0.25);
      const prevLogicalTop = scrollTopToLogicalTop(prevLayout, prevScrollTop, vh);
      const probeLogicalY = Math.max(
        0,
        Math.min(prevLayout.logicalTotalHeight, prevLogicalTop + focal)
      );
      const anchorIdx = findAnchorItemIndexAtY(prevLayout, probeLogicalY);
      if (anchorIdx >= 0 && prevPhotos[anchorIdx]) {
        const itemTop = prevLayout.itemY[anchorIdx];
        const itemH = Math.max(1, prevLayout.itemH[anchorIdx]);
        const offsetRatio = Math.max(0, Math.min(1, (probeLogicalY - itemTop) / itemH));
        gestureAnchor = {
          photoId: prevPhotos[anchorIdx].id,
          index: anchorIdx,
          offsetRatio,
          focalScreenY: focal,
          photosVer,
          expiresAt: now + ANCHOR_TTL_MS,
        };
        anchorToApply = gestureAnchor;
      }
    }
  } else {
    gestureAnchor = null;
  }

  const nextLayout = computeVirtualLayout(
    visiblePhotos,
    layoutMode,
    roundedWidth,
    clampedRowHeight,
    isMobile,
    photosVer
  );

  activeLayout = nextLayout;
  activePhotos = visiblePhotos;
  activePhotosVer = photosVer;
  lastAnchorFilterKey = filterKey;

  lastRenderedMode = layoutMode;
  lastContainerWidth = roundedWidth;
  lastIsMobile = isMobile;
  lastGridSignature = buildGridSignature(
    { ...state, lang },
    isMobile,
    clampedRowHeight,
    roundedWidth,
    photosVer,
    visiblePhotos.length
  );

  const metrics = getStageMetrics(nextLayout, vh);
  ensureStageDom(gridEl, metrics.physicalTotalHeight);

  if (anchorToApply) {
    let targetScrollTop = 0;
    if (!anchorToApply.pinTop) {
      let newIdx = anchorToApply.index;
      if (visiblePhotos[newIdx]?.id !== anchorToApply.photoId) {
        newIdx = visiblePhotos.findIndex((p) => p.id === anchorToApply.photoId);
      }
      if (newIdx >= 0 && newIdx < nextLayout.count) {
        anchorToApply.index = newIdx;
        const maxLogical = Math.max(0, nextLayout.logicalTotalHeight - vh);
        const targetLogicalTop = Math.max(
          0,
          Math.min(
            maxLogical,
            nextLayout.itemY[newIdx] +
              anchorToApply.offsetRatio * nextLayout.itemH[newIdx] -
              anchorToApply.focalScreenY
          )
        );
        targetScrollTop = logicalTopToScrollTop(nextLayout, targetLogicalTop, vh);
      } else {
        targetScrollTop = prevScrollTop;
      }
    }
    setScrollTopProgrammatically(scrollContainer, targetScrollTop);
  }

  syncVirtualViewport(gridEl, scrollContainer, store, nextLayout, visiblePhotos, {
    patchMeta,
    forceAllMeta: patchMeta,
  });
}

export function renderGalleryGrid(gridEl, scrollContainer, store, visiblePhotos) {
  if (!gridEl || !scrollContainer) return;

  const albumKey = `${store.state.mode}:${store.state.folderId || 'demo'}`;
  if (albumKey !== pooledAlbumKey) {
    pooledAlbumKey = albumKey;
    clearAllMountedCards();
    freeCardPool.length = 0;
    cachedLayout = null;
    activeLayout = null;
    activePhotos = [];
    activePhotosVer = 0;
    gestureAnchor = null;
    lastRenderedMode = '';
    lastGridSignature = '';
  }

  if (store.state.selectedPhotoIds.size === 0 && mobileSelectMode) {
    mobileSelectMode = false;
  }
  const selectActive = mobileSelectMode || store.state.selectedPhotoIds.size > 0;
  gridEl.classList.toggle('gallery-select-active', selectActive);

  if (store.state.loading) {
    clearAllMountedCards();
    activeLayout = null;
    activePhotos = [];
    lastVisiblePhotos = [];
    lastRenderedMode = '';
    lastGridSignature = '__loading__';
    gridEl.classList.remove('is-virtual-stage');
    gridEl.style.height = '';
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
    clearAllMountedCards();
    activeLayout = null;
    activePhotos = [];
    lastVisiblePhotos = [];
    lastRenderedMode = '';
    lastGridSignature = '__empty__';
    gridEl.classList.remove('is-virtual-stage');
    gridEl.style.height = '';
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

  ensureGalleryFloatingUi(gridEl, scrollContainer, store);
  lastVisiblePhotos = visiblePhotos;
  lastFilterKey = buildFilterKey(store.state);

  const rowHeight = Math.max(130, Math.min(320, Math.round(Number(store.state.rowHeight) || 210)));
  const isMobile = scrollContainer.clientWidth <= 600;
  const containerWidth = Math.max(
    240,
    gridEl.clientWidth || Math.max(0, scrollContainer.clientWidth - 4)
  );
  const roundedWidth = Math.round(containerWidth);
  const photosVer = getPhotosVersion(store, visiblePhotos);
  const sig = buildGridSignature(
    store.state,
    isMobile,
    rowHeight,
    roundedWidth,
    photosVer,
    visiblePhotos.length
  );

  if (sig === lastGridSignature && lastRenderedMode && stageLayerEl && stageLayerEl.isConnected) {
    const selectTitle = t('gallery.toggleSelect');
    const lastChange = store.lastChange;
    if (lastChange?.type === 'meta-only' && lastChange.photoIds) {
      for (const pid of lastChange.photoIds) {
        const entry = mountedCardsById.get(pid);
        if (entry && visiblePhotos[entry.idx]) {
          patchCardMeta(entry.el, visiblePhotos[entry.idx], store, selectTitle);
        }
      }
    } else {
      for (const entry of mountedCardsById.values()) {
        if (visiblePhotos[entry.idx]) {
          patchCardMeta(entry.el, visiblePhotos[entry.idx], store, selectTitle);
        }
      }
    }
    return;
  }

  applyGalleryGeometry(gridEl, scrollContainer, store, visiblePhotos, rowHeight, true, null);
}

export function previewGalleryRowHeight(
  gridEl,
  scrollContainer,
  store,
  nextHeight,
  focalScreenY = null
) {
  if (!gridEl || !scrollContainer || !store) return;
  const clamped = Math.max(130, Math.min(320, Math.round(Number(nextHeight) || 210)));
  pendingPreviewHeight = clamped;
  pendingPreviewFocalY = focalScreenY;
  if (previewRafId) return;
  previewRafId = requestAnimationFrame(() => {
    previewRafId = 0;
    if (pendingPreviewHeight === null) return;
    const heightToApply = pendingPreviewHeight;
    const focalToApply = pendingPreviewFocalY;
    pendingPreviewHeight = null;
    pendingPreviewFocalY = null;
    if (store.state.loading || lastVisiblePhotos.length === 0) return;
    applyGalleryGeometry(
      gridEl,
      scrollContainer,
      store,
      lastVisiblePhotos,
      heightToApply,
      false,
      focalToApply
    );
  });
}

export function relayoutGalleryOnResize(gridEl, scrollContainer, store) {
  if (!gridEl || !scrollContainer || !store) return;
  if (store.state.loading || lastVisiblePhotos.length === 0) return;

  const isMobile = scrollContainer.clientWidth <= 600;
  const containerWidth = Math.max(
    240,
    gridEl.clientWidth || Math.max(0, scrollContainer.clientWidth - 4)
  );
  const roundedWidth = Math.round(containerWidth);
  if (roundedWidth === lastContainerWidth && isMobile === lastIsMobile) return;

  const targetHeight = Math.max(130, Math.min(320, Number(store.state.rowHeight || 210)));
  applyGalleryGeometry(gridEl, scrollContainer, store, lastVisiblePhotos, targetHeight, true, null);
}

export function resetGallerySignature() {
  lastGridSignature = '';
  lastSubbarSignature = '';
  lastBatchSignature = '';
  cachedLayout = null;
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

    // Desktop 200ms top-left hover timer for unobtrusive checkbox reveal
    let hoverPeekTimer = 0;
    let hoverCandidateCard = null;
    let revealedPeekCard = null;

    activeHoverPeekClear = (card) => {
      if (hoverCandidateCard === card) {
        if (hoverPeekTimer) {
          clearTimeout(hoverPeekTimer);
          hoverPeekTimer = 0;
        }
        hoverCandidateCard = null;
      }
      if (revealedPeekCard === card) {
        revealedPeekCard = null;
      }
    };

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

    function resolveScrollContainer() {
      return (
        gridEl.closest('.gallery-scroll') ||
        document.getElementById('galleryScroll') ||
        gridEl.parentElement
      );
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
        }, 200);
      }
    });

    gridEl.addEventListener('mouseleave', () => {
      clearHoverPeek(false);
    });

    gridEl.addEventListener('dragstart', (e) => {
      clearHoverPeek(false);
      clearLongPress();
      const card = e.target.closest('.photo-card[data-photo-id]');
      if (!card || !e.dataTransfer) return;
      if (e.target.closest('[data-action="toggle-select"]')) {
        e.preventDefault();
        return;
      }
      const photoId = card.dataset.photoId;
      const file =
        store.getFileById?.(photoId) || lastVisiblePhotos.find((p) => p.id === photoId);
      if (!file) return;
      const spec = buildDesktopDragDownloadSpec(file, {
        accessToken: store.state.accessToken,
        apiKey: store.state.apiKey,
      });
      if (!spec || !spec.url) return;
      e.dataTransfer.effectAllowed = 'copy';
      e.dataTransfer.setData('DownloadURL', `${spec.mime}:${spec.filename}:${spec.url}`);
      e.dataTransfer.setData('text/uri-list', spec.url);
      e.dataTransfer.setData('text/plain', spec.filename);
    });

    gridEl.addEventListener('contextmenu', (e) => {
      if (e.shiftKey || (isTouchViewport() && window.matchMedia?.('(pointer: coarse)').matches)) {
        return;
      }
      const card = e.target.closest('.photo-card[data-photo-id]');
      if (!card) return;
      e.preventDefault();
      clearLongPress();
      clearHoverPeek(false);
      openPhotoContextMenu({
        x: e.clientX,
        y: e.clientY,
        photoId: card.dataset.photoId,
        store,
        context: 'gallery',
      });
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
          const sc = resolveScrollContainer();
          const rect = sc?.getBoundingClientRect?.();
          const midY = (e.touches[0].clientY + e.touches[1].clientY) * 0.5;
          const focalY = rect
            ? Math.max(0, Math.min(sc.clientHeight || 1, midY - rect.top))
            : null;
          previewGalleryRowHeight(gridEl, sc, store, nextH, focalY);
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
        const sc = resolveScrollContainer();
        const rect = sc?.getBoundingClientRect?.();
        const focalY = rect
          ? Math.max(0, Math.min(sc.clientHeight || 1, e.clientY - rect.top))
          : null;
        previewGalleryRowHeight(gridEl, sc, store, nextH, focalY);
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
