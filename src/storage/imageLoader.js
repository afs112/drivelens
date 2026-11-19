import {
  fetchBatchThumbnailLinks,
  fetchFreshThumbnailLink,
  fetchWithDriveBackoff,
} from '../api/gdrive.js';
import { APP_CONFIG } from '../constants.js';

const DB_NAME = 'drivelens-img-cache';
const STORE_NAME = 'blobs';
const MAX_CACHE_ENTRIES = 400;
const MAX_MEMORY_BLOB_ENTRIES = 90;
const MAX_MEMORY_URL_ENTRIES = 3000;
const MAX_BEST_LOADED_ENTRIES = 2500;
const THUMB_LINK_TTL_MS = 2.5 * 60 * 60 * 1000;
const HEALED_FLUSH_DEBOUNCE_MS = 1500;
const REPAIR_COALESCE_MS = 80;
const REPAIR_CHUNK_SIZE = 25;

let dbPromise = null;
const objectUrlCache = new Map();
const bestLoadedByItem = new Map();
const liveElementsByItem = new Map();

let thumbnailLinkHealedCallback = null;
const pendingHealedPatches = new Map();
let healedFlushTimer = 0;

export function setThumbnailLinkHealedCallback(fn) {
  thumbnailLinkHealedCallback = typeof fn === 'function' ? fn : null;
  if (!thumbnailLinkHealedCallback) {
    clearTimeout(healedFlushTimer);
    healedFlushTimer = 0;
    pendingHealedPatches.clear();
  }
}

function flushHealedThumbnailLinks() {
  healedFlushTimer = 0;
  if (!thumbnailLinkHealedCallback || pendingHealedPatches.size === 0) return;
  const flushedMap = new Map(pendingHealedPatches);
  pendingHealedPatches.clear();
  try {
    thumbnailLinkHealedCallback({ patches: flushedMap });
  } catch {
    // Ignore listener errors
  }
}

function queueHealedThumbnailLink(fileId, thumbnailLink, thumbFetchedAt = Date.now()) {
  if (!fileId || !thumbnailLink) return;
  pendingHealedPatches.set(fileId, { thumbnailLink, thumbFetchedAt });
  if (!thumbnailLinkHealedCallback) return;
  clearTimeout(healedFlushTimer);
  healedFlushTimer = setTimeout(flushHealedThumbnailLinks, HEALED_FLUSH_DEBOUNCE_MS);
}

export function quantizeThumbSize(requestedPx = 480) {
  const px = Number(requestedPx) || 480;
  if (px <= 260) return 240;
  if (px <= 560) return 480;
  if (px <= 920) return 800;
  if (px <= 1360) return 1280;
  if (px <= 1920) return 1600;
  return 3840;
}

let avgThumbLoadMs = 130;
const THUMB_EMA_ALPHA = 0.22;
const MIN_THUMB_EMA_MS = 35;
const MAX_THUMB_EMA_MS = 3000;

function recordThumbLoadDuration(ms) {
  const clamped = Math.max(MIN_THUMB_EMA_MS, Math.min(MAX_THUMB_EMA_MS, Number(ms) || 130));
  avgThumbLoadMs = Math.max(
    MIN_THUMB_EMA_MS,
    Math.min(MAX_THUMB_EMA_MS, avgThumbLoadMs * (1 - THUMB_EMA_ALPHA) + clamped * THUMB_EMA_ALPHA)
  );
}

export function getAdaptiveThumbTier(
  requestedPx = 480,
  { scrollSpeedPxPerSec = 0, isLookahead = false } = {}
) {
  const base = quantizeThumbSize(requestedPx);
  const pending = loadQueue.pendingCount();
  const speed = Math.abs(Number(scrollSpeedPxPerSec) || 0);
  if (avgThumbLoadMs > 360 || speed > 1600 || pending > 16) {
    return 240;
  }
  if (avgThumbLoadMs > 165 || speed > 650 || pending > 8 || isLookahead) {
    if (avgThumbLoadMs > 260 && isLookahead) return 240;
    return base >= 1280 ? 480 : base >= 800 ? 480 : 240;
  }
  return base;
}

function isBlobCacheEntry(key, val) {
  return (
    key.endsWith(':hd') ||
    key.endsWith(':media') ||
    (typeof val === 'string' && val.startsWith('blob:'))
  );
}

function touchObjectUrlCache(key) {
  if (!objectUrlCache.has(key)) return undefined;
  const val = objectUrlCache.get(key);
  objectUrlCache.delete(key);
  objectUrlCache.set(key, val);
  return val;
}

function setObjectUrlCache(key, url, protectedIds = smartHdState.protectedIds) {
  objectUrlCache.delete(key);
  objectUrlCache.set(key, url);

  let blobCount = 0;
  for (const [k, val] of objectUrlCache.entries()) {
    if (isBlobCacheEntry(k, val)) blobCount += 1;
  }

  if (blobCount > MAX_MEMORY_BLOB_ENTRIES) {
    for (const [k, val] of objectUrlCache.entries()) {
      if (!isBlobCacheEntry(k, val)) continue;
      const sepIdx = k.lastIndexOf(':');
      const id = sepIdx > 0 ? k.slice(0, sepIdx) : k;
      if (protectedIds && protectedIds.has(id)) continue;
      objectUrlCache.delete(k);
      if (typeof val === 'string' && val.startsWith('blob:')) {
        try {
          URL.revokeObjectURL(val);
        } catch {
          // Ignore
        }
        if (bestLoadedByItem.get(id)?.src === val) {
          bestLoadedByItem.delete(id);
        }
      }
      blobCount -= 1;
      if (blobCount <= MAX_MEMORY_BLOB_ENTRIES) break;
    }
  }

  if (objectUrlCache.size > MAX_MEMORY_URL_ENTRIES) {
    for (const [k, val] of objectUrlCache.entries()) {
      if (isBlobCacheEntry(k, val)) continue;
      objectUrlCache.delete(k);
      if (objectUrlCache.size <= MAX_MEMORY_URL_ENTRIES) break;
    }
  }
}

function getBestLoaded(fileId) {
  if (!fileId || !bestLoadedByItem.has(fileId)) return undefined;
  const val = bestLoadedByItem.get(fileId);
  bestLoadedByItem.delete(fileId);
  bestLoadedByItem.set(fileId, val);
  return val;
}

function removeLiveImgElement(imgEl) {
  if (!imgEl) return;
  const prevId = imgEl._dlItemId;
  if (!prevId) return;
  const set = liveElementsByItem.get(prevId);
  if (set) {
    set.delete(imgEl);
    if (set.size === 0) {
      liveElementsByItem.delete(prevId);
    }
  }
  imgEl._dlItemId = '';
}

function registerLiveImgElement(fileId, imgEl) {
  if (!fileId || !imgEl) return;
  if (imgEl._dlItemId && imgEl._dlItemId !== fileId) {
    removeLiveImgElement(imgEl);
  }
  imgEl._dlItemId = fileId;
  let set = liveElementsByItem.get(fileId);
  if (!set) {
    set = new Set();
    liveElementsByItem.set(fileId, set);
  }
  set.add(imgEl);
  if (set.size > 16) {
    for (const el of set) {
      if (!el.isConnected) {
        set.delete(el);
        if (el._dlItemId === fileId) el._dlItemId = '';
      }
    }
  }
}

function recordBestLoaded(fileId, size, src) {
  if (!fileId || !src) return;
  const numSize = Number(size) || 480;
  const prev = bestLoadedByItem.get(fileId);
  if (!prev || numSize >= prev.size) {
    bestLoadedByItem.delete(fileId);
    bestLoadedByItem.set(fileId, { size: numSize, src });
    while (bestLoadedByItem.size > MAX_BEST_LOADED_ENTRIES) {
      const oldestKey = bestLoadedByItem.keys().next().value;
      if (oldestKey === undefined) break;
      bestLoadedByItem.delete(oldestKey);
    }
  }

  const set = liveElementsByItem.get(fileId);
  if (!set) return;
  for (const el of set) {
    if (!el.isConnected) {
      set.delete(el);
      if (el._dlItemId === fileId) el._dlItemId = '';
      continue;
    }
    const curLoaded = Number(el.dataset.loadedSize || 0);
    if (numSize > curLoaded && el.getAttribute('src') !== src) {
      el.referrerPolicy = 'no-referrer';
      el.dataset.loadedSize = String(numSize);
      if (numSize >= 3840) {
        el.dataset.hdLoaded = 'true';
      }
      el.src = src;
      el.classList.add('is-loaded');
      const card = el.closest('.photo-card');
      if (card) {
        card.classList.add('has-img');
        card.classList.remove('is-thumb-error');
      }
    }
  }
}

function evictCachedSrcForItem(item, staleSrc) {
  if (!item?.id || !staleSrc) return;
  const best = bestLoadedByItem.get(item.id);
  if (best && best.src === staleSrc) {
    bestLoadedByItem.delete(item.id);
  }
  const prefix = `${item.id}:`;
  for (const [k, val] of objectUrlCache.entries()) {
    if (k.startsWith(prefix) && val === staleSrc) {
      objectUrlCache.delete(k);
      if (typeof val === 'string' && val.startsWith('blob:')) {
        try {
          URL.revokeObjectURL(val);
        } catch {
          // Ignore
        }
      }
    }
  }
  if (
    staleSrc.includes('/drive-storage/') &&
    item.thumbnailLink &&
    item.thumbnailLink.includes('drive-storage')
  ) {
    item.thumbFetchedAt = 1;
    driveStorageFailCount += 1;
  }
}

function openCacheDb() {
  if (dbPromise) return dbPromise;
  if (typeof indexedDB === 'undefined') {
    dbPromise = Promise.resolve(null);
    return dbPromise;
  }
  dbPromise = new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          const store = db.createObjectStore(STORE_NAME, { keyPath: 'key' });
          store.createIndex('createdAt', 'createdAt');
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return dbPromise;
}

async function getCachedBlob(key) {
  const db = await openCacheDb();
  if (!db) return null;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const req = tx.objectStore(STORE_NAME).get(key);
      req.onsuccess = () => resolve(req.result?.blob || null);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

async function setCachedBlob(key, blob) {
  const db = await openCacheDb();
  if (!db) return;
  try {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    store.put({ key, blob, createdAt: Date.now() });

    const countReq = store.count();
    countReq.onsuccess = () => {
      if (countReq.result > MAX_CACHE_ENTRIES) {
        const idx = store.index('createdAt');
        let toDelete = countReq.result - MAX_CACHE_ENTRIES;
        idx.openCursor().onsuccess = (ev) => {
          const cursor = ev.target.result;
          if (cursor && toDelete > 0) {
            cursor.delete();
            toDelete -= 1;
            cursor.continue();
          }
        };
      }
    };
  } catch {
    // Ignore IndexedDB quota/incognito errors gracefully
  }
}

function scoreElementViewportPriority(imgEl) {
  if (!imgEl || !imgEl.isConnected) return 1e9;
  const vh = typeof window !== 'undefined' ? window.innerHeight || 800 : 800;
  const rect = imgEl.getBoundingClientRect();
  if (!rect.width && !rect.height) return 5e8;
  const centerY = (rect.top + rect.bottom) * 0.5;
  const distFromCenter = Math.abs(centerY - vh * 0.5);
  const onScreen = rect.bottom > 0 && rect.top < vh;
  return onScreen ? distFromCenter : 100000 + distFromCenter;
}

function isElementStrictlyOffScreen(imgEl) {
  if (!imgEl || !imgEl.isConnected) return true;
  const vh = typeof window !== 'undefined' ? window.innerHeight || 800 : 800;
  const rect = imgEl.getBoundingClientRect();
  return rect.bottom < -48 || rect.top > vh + 48;
}

class ImageLoadQueue {
  constructor(concurrency) {
    this.concurrency = Math.max(1, concurrency || 12);
    this.active = 0;
    this.queue = [];
    this.activeEntries = new Set();
    this._settling = false;
    this._settleTimer = 0;
    this._busyListeners = new Set();
    this._idleListeners = new Set();
  }

  isIdle() {
    return this.active === 0 && this.queue.length === 0 && !this._settling;
  }

  pendingCount() {
    return this.queue.length;
  }

  onBusy(fn) {
    this._busyListeners.add(fn);
    return () => this._busyListeners.delete(fn);
  }

  onIdle(fn) {
    this._idleListeners.add(fn);
    return () => this._idleListeners.delete(fn);
  }

  touchActivity(settleMs = 150) {
    const wasIdle = this.isIdle();
    this._settling = true;
    if (wasIdle) {
      for (const fn of this._busyListeners) fn();
    }
    clearTimeout(this._settleTimer);
    this._settleTimer = setTimeout(() => {
      this._settling = false;
      if (this.active === 0 && this.queue.length === 0) {
        for (const fn of this._idleListeners) fn();
      }
    }, settleMs);
  }

  enqueue(
    task,
    {
      priority = false,
      imgEl = null,
      abortCtrl = null,
      priorityScore = null,
      virtualManaged = false,
      needsFirstPaint = false,
    } = {}
  ) {
    let entryRef = null;
    const promise = new Promise((resolve, reject) => {
      const wasIdle = this.isIdle();
      clearTimeout(this._settleTimer);
      this._settling = false;
      entryRef = {
        task,
        resolve,
        reject,
        priority: Boolean(priority),
        imgEl,
        abortCtrl,
        priorityScore: typeof priorityScore === 'number' ? priorityScore : null,
        virtualManaged: Boolean(virtualManaged),
        needsFirstPaint: Boolean(needsFirstPaint),
        cancelled: false,
      };
      if (entryRef.priority) {
        this.queue.unshift(entryRef);
      } else {
        this.queue.push(entryRef);
      }
      if (wasIdle) {
        for (const fn of this._busyListeners) fn();
      }
      this._maybePreemptOffScreen(entryRef);
      this._drain();
    });

    const cancel = () => {
      if (!entryRef || entryRef.cancelled) return;
      entryRef.cancelled = true;
      const idx = this.queue.indexOf(entryRef);
      if (idx !== -1) {
        this.queue.splice(idx, 1);
        entryRef.reject(new DOMException('Aborted', 'AbortError'));
        if (this.active === 0 && this.queue.length === 0) {
          this.touchActivity(120);
        }
      }
    };

    const updatePriority = (nextPriority, nextScore, nextNeedsFirstPaint) => {
      if (!entryRef || entryRef.cancelled) return;
      entryRef.priority = Boolean(nextPriority);
      if (typeof nextScore === 'number') {
        entryRef.priorityScore = nextScore;
      }
      if (typeof nextNeedsFirstPaint === 'boolean') {
        entryRef.needsFirstPaint = nextNeedsFirstPaint;
      }
    };

    return { promise, cancel, updatePriority };
  }

  _maybePreemptOffScreen(incoming) {
    if (this.active < this.concurrency) return;
    const incomingUrgent =
      incoming.priority ||
      incoming.needsFirstPaint ||
      (!incoming.virtualManaged &&
        typeof incoming.priorityScore !== 'number' &&
        incoming.imgEl &&
        scoreElementViewportPriority(incoming.imgEl) < 100000);
    if (!incomingUrgent) return;

    for (const running of this.activeEntries) {
      if (running.priority || !running.abortCtrl) continue;
      if (running.virtualManaged || typeof running.priorityScore === 'number') {
        if (!running.imgEl?.isConnected) {
          running.abortCtrl.abort();
          break;
        }
        continue;
      }
      if (isElementStrictlyOffScreen(running.imgEl)) {
        running.abortCtrl.abort();
        break;
      }
    }
  }

  _pickNextIndex() {
    if (this.queue.length <= 1) return 0;
    let bestIdx = 0;
    let bestTier = Infinity;
    let bestPriorityRank = Infinity;
    let bestScore = Infinity;
    for (let i = 0; i < this.queue.length; i += 1) {
      const entry = this.queue[i];
      const tier = entry.needsFirstPaint ? 0 : 1;
      const priorityRank = entry.priority ? 0 : 1;
      const hasNumericScore = typeof entry.priorityScore === 'number';
      const score = hasNumericScore
        ? entry.priorityScore
        : scoreElementViewportPriority(entry.imgEl);
      if (
        tier < bestTier ||
        (tier === bestTier &&
          (priorityRank < bestPriorityRank ||
            (priorityRank === bestPriorityRank && score < bestScore)))
      ) {
        bestTier = tier;
        bestPriorityRank = priorityRank;
        bestScore = score;
        bestIdx = i;
      }
    }
    return bestIdx;
  }

  _drain() {
    while (this.active < this.concurrency && this.queue.length > 0) {
      const pickIdx = this._pickNextIndex();
      const entry = this.queue.splice(pickIdx, 1)[0];
      if (!entry || entry.cancelled) continue;
      this.active += 1;
      this.activeEntries.add(entry);
      Promise.resolve()
        .then(() => entry.task(entry.abortCtrl?.signal || null))
        .then(entry.resolve, entry.reject)
        .finally(() => {
          this.active -= 1;
          this.activeEntries.delete(entry);
          this._drain();
          if (this.active === 0 && this.queue.length === 0) {
            this.touchActivity(120);
          }
        });
    }
  }
}

const loadQueue = new ImageLoadQueue(APP_CONFIG.THUMBNAIL_CONCURRENCY);

class RateLimitedGate {
  constructor(maxConcurrent = 6, minIntervalMs = 125) {
    this.maxConcurrent = maxConcurrent;
    this.minIntervalMs = minIntervalMs;
    this.active = 0;
    this.lastStartAt = 0;
    this.waiters = [];
    this.timer = 0;
  }

  run(fn, signal = null) {
    if (signal?.aborted) {
      return Promise.reject(new DOMException('Aborted', 'AbortError'));
    }
    return new Promise((resolve, reject) => {
      const entry = { fn, signal, resolve, reject, cancelled: false, onAbort: null };
      const onAbort = () => {
        if (entry.cancelled) return;
        entry.cancelled = true;
        const idx = this.waiters.indexOf(entry);
        if (idx !== -1) this.waiters.splice(idx, 1);
        reject(new DOMException('Aborted', 'AbortError'));
      };
      entry.onAbort = onAbort;
      signal?.addEventListener('abort', onAbort, { once: true });
      this.waiters.push(entry);
      this._pump();
    });
  }

  _pump() {
    if (this.timer) return;
    while (this.active < this.maxConcurrent && this.waiters.length > 0) {
      const now = Date.now();
      const waitMs = Math.max(0, this.lastStartAt + this.minIntervalMs - now);
      if (waitMs > 0) {
        this.timer = setTimeout(() => {
          this.timer = 0;
          this._pump();
        }, waitMs);
        return;
      }
      const entry = this.waiters.shift();
      if (!entry || entry.cancelled) continue;
      entry.signal?.removeEventListener('abort', entry.onAbort);
      if (entry.signal?.aborted) {
        entry.reject(new DOMException('Aborted', 'AbortError'));
        continue;
      }
      this.lastStartAt = Date.now();
      this.active += 1;
      Promise.resolve()
        .then(() => entry.fn())
        .then(entry.resolve, entry.reject)
        .finally(() => {
          this.active -= 1;
          this._pump();
        });
    }
  }

  clear() {
    clearTimeout(this.timer);
    this.timer = 0;
    const dropped = this.waiters.splice(0);
    for (const entry of dropped) {
      entry.cancelled = true;
      entry.signal?.removeEventListener('abort', entry.onAbort);
      entry.reject(new DOMException('Aborted', 'AbortError'));
    }
  }
}

const lh3RateGate = new RateLimitedGate(6, 125);

class ThumbnailRepairBatcher {
  constructor(coalesceMs = REPAIR_COALESCE_MS, chunkSize = REPAIR_CHUNK_SIZE) {
    this.coalesceMs = coalesceMs;
    this.chunkSize = chunkSize;
    this.pending = new Map();
    this.inFlight = new Map();
    this.flushTimer = 0;
  }

  enqueue({ item, token = '', key = '', signal = null }) {
    if (!item?.id) return Promise.resolve('');
    if (signal?.aborted) {
      return Promise.reject(new DOMException('Aborted', 'AbortError'));
    }

    const existingInFlight = this.inFlight.get(item.id);
    if (existingInFlight) {
      return this._awaitWithAbort(existingInFlight, signal);
    }

    return new Promise((resolve, reject) => {
      let entry = this.pending.get(item.id);
      if (!entry) {
        entry = { item, token, key, waiters: [] };
        this.pending.set(item.id, entry);
      } else {
        if (token) entry.token = token;
        if (key) entry.key = key;
      }

      const waiter = { signal, resolve, reject, onAbort: null, settled: false };
      if (signal) {
        waiter.onAbort = () => {
          if (waiter.settled) return;
          waiter.settled = true;
          const idx = entry.waiters.indexOf(waiter);
          if (idx !== -1) entry.waiters.splice(idx, 1);
          if (entry.waiters.length === 0 && this.pending.get(item.id) === entry) {
            this.pending.delete(item.id);
          }
          reject(new DOMException('Aborted', 'AbortError'));
        };
        signal.addEventListener('abort', waiter.onAbort, { once: true });
      }
      entry.waiters.push(waiter);

      if (!this.flushTimer) {
        this.flushTimer = setTimeout(() => {
          this.flushTimer = 0;
          this._flush();
        }, this.coalesceMs);
      }
    });
  }

  _awaitWithAbort(promise, signal) {
    if (!signal) return promise;
    return new Promise((resolve, reject) => {
      if (signal.aborted) {
        reject(new DOMException('Aborted', 'AbortError'));
        return;
      }
      let settled = false;
      const onAbort = () => {
        if (settled) return;
        settled = true;
        reject(new DOMException('Aborted', 'AbortError'));
      };
      signal.addEventListener('abort', onAbort, { once: true });
      promise.then(
        (val) => {
          if (settled) return;
          settled = true;
          signal.removeEventListener('abort', onAbort);
          resolve(val);
        },
        (err) => {
          if (settled) return;
          settled = true;
          signal.removeEventListener('abort', onAbort);
          reject(err);
        }
      );
    });
  }

  _flush() {
    if (this.pending.size === 0) return;
    const entries = Array.from(this.pending.values());
    this.pending.clear();

    const groups = new Map();
    for (const entry of entries) {
      entry.waiters = entry.waiters.filter((w) => !w.settled && !w.signal?.aborted);
      if (entry.waiters.length === 0) continue;
      if (!entry.token && !entry.key) {
        for (const w of entry.waiters) {
          w.settled = true;
          w.signal?.removeEventListener('abort', w.onAbort);
          w.resolve('');
        }
        continue;
      }
      const authKey = `${entry.token || ''}::${entry.key || ''}`;
      let list = groups.get(authKey);
      if (!list) {
        list = [];
        groups.set(authKey, list);
      }
      list.push(entry);
    }

    for (const groupEntries of groups.values()) {
      for (let i = 0; i < groupEntries.length; i += this.chunkSize) {
        const chunk = groupEntries.slice(i, i + this.chunkSize);
        this._dispatchChunk(chunk);
      }
    }
  }

  _dispatchChunk(chunkEntries) {
    const auth = {
      accessToken: chunkEntries[0].token || '',
      apiKey: chunkEntries[0].key || '',
    };
    const items = chunkEntries.map((e) => e.item);
    const chunkPromise = fetchBatchThumbnailLinks(items, auth)
      .catch(() => new Map());

    for (const entry of chunkEntries) {
      const itemPromise = chunkPromise.then((linkMap) => {
        const freshLink = linkMap instanceof Map ? linkMap.get(entry.item.id) || '' : '';
        if (freshLink) {
          const now = Date.now();
          entry.item.thumbnailLink = freshLink;
          entry.item.thumbFetchedAt = now;
          driveStorageFailCount = 0;
          queueHealedThumbnailLink(entry.item.id, freshLink, now);
        }
        return freshLink;
      });

      this.inFlight.set(entry.item.id, itemPromise);

      itemPromise
        .then((freshLink) => {
          for (const w of entry.waiters) {
            if (w.settled) continue;
            w.settled = true;
            w.signal?.removeEventListener('abort', w.onAbort);
            if (w.signal?.aborted) {
              w.reject(new DOMException('Aborted', 'AbortError'));
            } else {
              w.resolve(freshLink);
            }
          }
        })
        .catch((err) => {
          for (const w of entry.waiters) {
            if (w.settled) continue;
            w.settled = true;
            w.signal?.removeEventListener('abort', w.onAbort);
            w.reject(err);
          }
        })
        .finally(() => {
          if (this.inFlight.get(entry.item.id) === itemPromise) {
            this.inFlight.delete(entry.item.id);
          }
        });
    }
  }

  clear() {
    clearTimeout(this.flushTimer);
    this.flushTimer = 0;
    for (const entry of this.pending.values()) {
      for (const w of entry.waiters) {
        if (w.settled) continue;
        w.settled = true;
        w.signal?.removeEventListener('abort', w.onAbort);
        w.reject(new DOMException('Aborted', 'AbortError'));
      }
    }
    this.pending.clear();
  }
}

const thumbnailRepairBatcher = new ThumbnailRepairBatcher();

export function isPreviewQueueIdle() {
  return loadQueue.isIdle();
}

export function buildDriveThumbUrl(item, targetSize = 600) {
  if (!item) return '';
  if (item.isDemo) return item.demoDataUrl || '';
  if (item.thumbnailLink) {
    if (/=s\d+/.test(item.thumbnailLink)) {
      return item.thumbnailLink.replace(/=s\d+[^&]*/, `=s${targetSize}`);
    }
    return `${item.thumbnailLink}=s${targetSize}`;
  }
  if (!item.id) return '';
  return `https://drive.google.com/thumbnail?id=${encodeURIComponent(item.id)}&sz=w${targetSize}`;
}

function loadViaImgTag(url, signal = null) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }
    const probe = new Image();
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    function onAbort() {
      if (settled) return;
      settled = true;
      probe.src = '';
      cleanup();
      reject(new DOMException('Aborted', 'AbortError'));
    }
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      probe.src = '';
      cleanup();
      reject(new Error('Thumbnail load timeout'));
    }, 8000);
    signal?.addEventListener('abort', onAbort, { once: true });
    probe.referrerPolicy = 'no-referrer';
    probe.decoding = 'async';
    probe.onload = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(url);
    };
    probe.onerror = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error('Thumbnail image load failed'));
    };
    probe.src = url;
  });
}

let driveStorageFailCount = 0;

async function measureThumbImgLoad(url, signal = null) {
  const nowFn = typeof performance !== 'undefined' ? () => performance.now() : () => Date.now();
  const startedAt = nowFn();
  try {
    const res = await loadViaImgTag(url, signal);
    recordThumbLoadDuration(nowFn() - startedAt);
    return res;
  } catch (err) {
    if (err?.name !== 'AbortError' && !signal?.aborted) {
      const elapsed = nowFn() - startedAt;
      const penaltyMs =
        err?.message === 'Thumbnail load timeout'
          ? Math.max(elapsed, 1500)
          : Math.max(elapsed, 650);
      recordThumbLoadDuration(penaltyMs);
    }
    throw err;
  }
}

function isKnownExpiredThumbLink(item) {
  if (!item || !item.thumbnailLink) return false;
  if (!item.thumbnailLink.includes('drive-storage')) return false;
  const fetchedAt = Number(item.thumbFetchedAt || 0);
  return fetchedAt > 0 && Date.now() - fetchedAt > THUMB_LINK_TTL_MS;
}

function isStaleDriveStorageUrl(url) {
  return Boolean(url && url.includes('/drive-storage/') && driveStorageFailCount >= 2);
}

async function fetchMediaBlobWithRetry(fileId, auth = {}, signal = null) {
  const { accessToken = '', apiKey = '' } = typeof auth === 'string' ? { accessToken: auth } : auth;
  const baseUrl = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media&supportsAllDrives=true`;
  const url = !accessToken && apiKey
    ? `${baseUrl}&key=${encodeURIComponent(apiKey)}`
    : baseUrl;
  const headers = accessToken ? { Authorization: `Bearer ${accessToken}` } : {};
  const resp = await fetchWithDriveBackoff(url, { headers, signal });
  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status}`);
  }
  return resp.blob();
}

async function resolveImageSrc(
  item,
  requestedSize,
  getAccessToken,
  getApiKey,
  signal = null,
  { allowMediaFallback = false } = {}
) {
  if (!item) return { src: '', size: 0 };
  if (item.isDemo) return { src: item.demoDataUrl || '', size: 3840 };

  const size = requestedSize;
  const best = getBestLoaded(item.id);
  if (best && best.size >= size) {
    return best;
  }

  const memKey = `${item.id}:${size}`;
  const cachedUrl = touchObjectUrlCache(memKey);
  if (cachedUrl) {
    recordBestLoaded(item.id, size, cachedUrl);
    return { src: cachedUrl, size };
  }

  const thumbUrl = buildDriveThumbUrl(item, size);
  const skipInitialThumb =
    !thumbUrl || isKnownExpiredThumbLink(item) || isStaleDriveStorageUrl(thumbUrl);
  if (!skipInitialThumb) {
    try {
      await measureThumbImgLoad(thumbUrl, signal);
      if (thumbUrl.includes('/drive-storage/')) driveStorageFailCount = 0;
      setObjectUrlCache(memKey, thumbUrl);
      recordBestLoaded(item.id, size, thumbUrl);
      return { src: thumbUrl, size };
    } catch (err) {
      if (err?.name === 'AbortError' || signal?.aborted) throw err;
      if (thumbUrl.includes('/drive-storage/')) driveStorageFailCount += 1;
    }
  }

  const token = typeof getAccessToken === 'function' ? getAccessToken() : '';
  const apiKey = typeof getApiKey === 'function' ? getApiKey() : '';

  let triedLh3Url = '';
  if (!token && apiKey && item.id) {
    triedLh3Url = `https://lh3.googleusercontent.com/d/${encodeURIComponent(item.id)}=s${size}`;
    if (triedLh3Url !== thumbUrl || skipInitialThumb) {
      try {
        await lh3RateGate.run(() => measureThumbImgLoad(triedLh3Url, signal), signal);
        setObjectUrlCache(memKey, triedLh3Url);
        recordBestLoaded(item.id, size, triedLh3Url);
        return { src: triedLh3Url, size };
      } catch (err) {
        if (err?.name === 'AbortError' || signal?.aborted) throw err;
      }
    }
  } else if (!token && !apiKey && item.id) {
    const fallbackUrl = `https://drive.google.com/thumbnail?id=${encodeURIComponent(item.id)}&sz=w${size}`;
    if (fallbackUrl !== thumbUrl) {
      try {
        await measureThumbImgLoad(fallbackUrl, signal);
        setObjectUrlCache(memKey, fallbackUrl);
        recordBestLoaded(item.id, size, fallbackUrl);
        return { src: fallbackUrl, size };
      } catch (err) {
        if (err?.name === 'AbortError' || signal?.aborted) throw err;
      }
    }
  }

  if ((token || apiKey) && item.id) {
    const freshLink = await thumbnailRepairBatcher.enqueue({
      item,
      token,
      key: apiKey,
      signal,
    });
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    if (freshLink) {
      const freshSized = buildDriveThumbUrl(item, size);
      if (freshSized && freshSized !== triedLh3Url) {
        try {
          await measureThumbImgLoad(freshSized, signal);
          setObjectUrlCache(memKey, freshSized);
          recordBestLoaded(item.id, size, freshSized);
          return { src: freshSized, size };
        } catch (err) {
          if (err?.name === 'AbortError' || signal?.aborted) throw err;
        }
      }
    }
  }

  if (!allowMediaFallback) {
    throw new Error('Thumbnail load failed');
  }

  const cacheKey = `${item.id}:media`;
  const mediaUrl = touchObjectUrlCache(cacheKey);
  if (mediaUrl) {
    recordBestLoaded(item.id, 3840, mediaUrl);
    return { src: mediaUrl, size: 3840 };
  }

  const cachedBlob = await getCachedBlob(cacheKey);
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  if (cachedBlob) {
    const objUrl = URL.createObjectURL(cachedBlob);
    setObjectUrlCache(cacheKey, objUrl);
    recordBestLoaded(item.id, 3840, objUrl);
    return { src: objUrl, size: 3840 };
  }

  if (!token && !apiKey) {
    throw new Error('Missing Google Drive access token or API key');
  }

  const blob = await fetchMediaBlobWithRetry(item.id, { accessToken: token, apiKey }, signal);
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  await setCachedBlob(cacheKey, blob);
  const objUrl = URL.createObjectURL(blob);
  setObjectUrlCache(cacheKey, objUrl);
  recordBestLoaded(item.id, 3840, objUrl);
  return { src: objUrl, size: 3840 };
}

const activeObservers = new WeakMap();
const inFlightHdPromises = new Map();
const hdCachedIds = new Set();
const failedHdIds = new Set();
const hdStatusListeners = new Set();
const BROWSER_DECODABLE_RE = /^image\/(jpe?g|png|webp|gif|avif|bmp|svg\+xml)$/i;
const MAX_ORIGINAL_STREAM_BYTES = 65 * 1024 * 1024;
const MAX_IDB_HD_BLOB_BYTES = 25 * 1024 * 1024;

function rememberHdInMemory(hdKey, fileId, url, protectedIds = null) {
  setObjectUrlCache(hdKey, url, protectedIds);
  hdCachedIds.add(fileId);
  recordBestLoaded(fileId, 3840, url);
}

function decodeImageUrl(url, signal = null) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }
    const probe = new Image();
    let settled = false;
    const cleanup = () => {
      signal?.removeEventListener('abort', onAbort);
    };
    function onAbort() {
      if (settled) return;
      settled = true;
      probe.src = '';
      cleanup();
      reject(new DOMException('Aborted', 'AbortError'));
    }
    signal?.addEventListener('abort', onAbort, { once: true });
    probe.referrerPolicy = 'no-referrer';
    probe.decoding = 'async';
    probe.onload = () => {
      if (settled) return;
      settled = true;
      cleanup();
      if (typeof probe.decode === 'function') {
        probe.decode().then(() => resolve(url), () => resolve(url));
      } else {
        resolve(url);
      }
    };
    probe.onerror = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error('HD image decode failed'));
    };
    probe.src = url;
  });
}

async function fetchOriginalHdStream(item, auth = {}, signal = null, onProgress = null) {
  const { accessToken = '', apiKey = '' } = auth;
  const baseUrl = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(item.id)}?alt=media&supportsAllDrives=true`;
  const url = !accessToken && apiKey ? `${baseUrl}&key=${encodeURIComponent(apiKey)}` : baseUrl;
  const headers = accessToken ? { Authorization: `Bearer ${accessToken}` } : {};

  const resp = await fetchWithDriveBackoff(url, { headers, signal });
  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status}`);
  }

  const totalBytes = Number(resp.headers.get('content-length') || 0) || Number(item.size || 0);
  const contentType = resp.headers.get('content-type') || item.mimeType || 'image/jpeg';

  if (!resp.body || typeof resp.body.getReader !== 'function') {
    const blob = await resp.blob();
    if (onProgress) onProgress(0.95);
    return blob;
  }

  const reader = resp.body.getReader();
  const chunks = [];
  let loaded = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value && value.byteLength) {
        chunks.push(value);
        loaded += value.byteLength;
        if (onProgress) {
          const ratio =
            totalBytes > 0
              ? Math.min(0.95, Math.max(0.08, loaded / totalBytes))
              : Math.min(0.9, 1 - Math.exp(-loaded / (1.4 * 1024 * 1024)));
          onProgress(ratio);
        }
      }
    }
  } catch (err) {
    try {
      reader.cancel();
    } catch {
      // Ignore cancel error
    }
    throw err;
  }

  return new Blob(chunks, { type: contentType });
}

export function hasCachedHdSrc(item) {
  if (!item) return '';
  if (item.isDemo) return item.demoDataUrl || '';
  const best = getBestLoaded(item.id);
  if (best && best.size >= 3840 && best.src) return best.src;
  return (
    touchObjectUrlCache(`${item.id}:hd`) ||
    touchObjectUrlCache(`${item.id}:media`) ||
    ''
  );
}

export async function loadHdPhoto(
  item,
  { getAccessToken = null, getApiKey = null, signal = null, onProgress = null } = {}
) {
  if (!item) return { src: '', fromMemory: true };
  if (item.isDemo) {
    if (onProgress) onProgress(1);
    return { src: item.demoDataUrl || '', fromMemory: true };
  }

  const memHd = hasCachedHdSrc(item);
  if (memHd) {
    if (onProgress) onProgress(1);
    return { src: memHd, fromMemory: true };
  }

  if (onProgress) onProgress(0.08);

  const hdKey = `${item.id}:hd`;
  const mediaKey = `${item.id}:media`;
  const cachedBlob = (await getCachedBlob(hdKey)) || (await getCachedBlob(mediaKey));
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  if (cachedBlob) {
    const objUrl = URL.createObjectURL(cachedBlob);
    try {
      await decodeImageUrl(objUrl);
      rememberHdInMemory(hdKey, item.id, objUrl, smartHdState.protectedIds);
      if (onProgress) onProgress(1);
      return { src: objUrl, fromMemory: false };
    } catch {
      URL.revokeObjectURL(objUrl);
    }
  }

  const token = typeof getAccessToken === 'function' ? getAccessToken() : '';
  const apiKey = typeof getApiKey === 'function' ? getApiKey() : '';

  let simVal = 0.14;
  const simTimer = onProgress
    ? setInterval(() => {
        simVal = Math.min(0.86, simVal + (0.9 - simVal) * 0.24);
        onProgress(simVal);
      }, 85)
    : null;

  try {
    const directThumb = buildDriveThumbUrl(item, 3840);
    const cdnCandidates = [
      !isKnownExpiredThumbLink(item) && !isStaleDriveStorageUrl(directThumb) ? directThumb : '',
      `https://lh3.googleusercontent.com/d/${encodeURIComponent(item.id)}=s3840`,
      `https://drive.google.com/thumbnail?id=${encodeURIComponent(item.id)}&sz=w3840`,
    ].filter(Boolean);

    const seen = new Set();
    for (const candidateUrl of cdnCandidates) {
      if (seen.has(candidateUrl)) continue;
      seen.add(candidateUrl);
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      try {
        await decodeImageUrl(candidateUrl, signal);
        if (candidateUrl.includes('/drive-storage/')) driveStorageFailCount = 0;
        rememberHdInMemory(hdKey, item.id, candidateUrl, smartHdState.protectedIds);
        if (onProgress) onProgress(1);
        return { src: candidateUrl, fromMemory: false };
      } catch (err) {
        if (err?.name === 'AbortError' || signal?.aborted) throw err;
        if (candidateUrl.includes('/drive-storage/')) driveStorageFailCount += 1;
      }
    }

    if (token || apiKey) {
      const freshLink = await fetchFreshThumbnailLink(
        item.id,
        { accessToken: token, apiKey },
        signal
      );
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      if (freshLink) {
        const now = Date.now();
        item.thumbnailLink = freshLink;
        item.thumbFetchedAt = now;
        driveStorageFailCount = 0;
        queueHealedThumbnailLink(item.id, freshLink, now);
        const freshHdUrl = buildDriveThumbUrl(item, 3840);
        try {
          await decodeImageUrl(freshHdUrl, signal);
          rememberHdInMemory(hdKey, item.id, freshHdUrl, smartHdState.protectedIds);
          if (onProgress) onProgress(1);
          return { src: freshHdUrl, fromMemory: false };
        } catch (err) {
          if (err?.name === 'AbortError' || signal?.aborted) throw err;
        }
      }
    }
  } finally {
    if (simTimer) clearInterval(simTimer);
  }

  const mime = item.mimeType || 'image/jpeg';
  const fileSize = Number(item.size || 0);
  const canStreamOriginal =
    Boolean(token || apiKey) &&
    BROWSER_DECODABLE_RE.test(mime) &&
    (fileSize === 0 || fileSize <= MAX_ORIGINAL_STREAM_BYTES);

  if (canStreamOriginal) {
    const blob = await fetchOriginalHdStream(
      item,
      { accessToken: token, apiKey },
      signal,
      onProgress
    );
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const objUrl = URL.createObjectURL(blob);
    try {
      await decodeImageUrl(objUrl, signal);
      rememberHdInMemory(hdKey, item.id, objUrl, smartHdState.protectedIds);
      if (blob.size > 0 && blob.size <= MAX_IDB_HD_BLOB_BYTES) {
        setCachedBlob(hdKey, blob).catch(() => {});
      }
      if (onProgress) onProgress(1);
      return { src: objUrl, fromMemory: false };
    } catch (decodeErr) {
      URL.revokeObjectURL(objUrl);
      throw decodeErr;
    }
  }

  const resolved = await resolveImageSrc(
    item,
    3840,
    getAccessToken,
    getApiKey,
    signal,
    { allowMediaFallback: true }
  );
  if (resolved?.src) {
    rememberHdInMemory(hdKey, item.id, resolved.src, smartHdState.protectedIds);
    if (onProgress) onProgress(1);
    return { src: resolved.src, fromMemory: false };
  }

  throw new Error('Failed to load HD photo');
}

export function isPhotoHdCached(item) {
  if (!item) return true;
  if (item.isDemo) return true;
  if (item.mimeType && item.mimeType.startsWith('video/')) return true;
  return Boolean(hasCachedHdSrc(item) || hdCachedIds.has(item.id));
}

const HD_POOL_CONCURRENCY = Math.max(1, Number(APP_CONFIG.HD_CONCURRENCY) || 4);

const smartHdState = {
  lightboxItems: [],
  ratedPageItems: [],
  restPageItems: [],
  protectedIds: new Set(),
  getAccessToken: null,
  getApiKey: null,
  activeJobs: new Map(),
  albumKey: '',
};

function emitHdStatus(payload) {
  for (const fn of hdStatusListeners) {
    fn(payload);
  }
}

export function subscribeHdStatus(fn) {
  hdStatusListeners.add(fn);
  return () => hdStatusListeners.delete(fn);
}

export function getSmartHdDebugState() {
  const firstJob = smartHdState.activeJobs.values().next().value || null;
  return {
    previewIdle: loadQueue.isIdle(),
    previewActive: loadQueue.active,
    previewQueued: loadQueue.queue.length,
    currentJob: firstJob ? { itemId: firstJob.itemId, tier: firstJob.tier } : null,
    activeJobIds: Array.from(smartHdState.activeJobs.keys()),
    lightboxTargetIds: smartHdState.lightboxItems.map((i) => i.id),
    ratedTargetIds: smartHdState.ratedPageItems.map((i) => i.id),
    pageTargetIds: smartHdState.restPageItems.map((i) => i.id),
    hdCachedIds: Array.from(hdCachedIds),
  };
}

function isEligibleHdItem(item) {
  return Boolean(
    item &&
      item.id &&
      !item.isDemo &&
      !(item.mimeType && item.mimeType.startsWith('video/')) &&
      !failedHdIds.has(item.id)
  );
}

export function abortBackgroundHdJobs(predicate = null) {
  for (const [id, job] of smartHdState.activeJobs.entries()) {
    if (!predicate || predicate(job)) {
      job.abortCtrl?.abort();
      smartHdState.activeJobs.delete(id);
    }
  }
}

function startSmartHdJob(item, tier, isCurrentLightbox = false) {
  if (!item?.id || smartHdState.activeJobs.has(item.id)) return;
  const abortCtrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const job = {
    itemId: item.id,
    tier,
    isCurrentLightbox,
    abortCtrl,
  };
  smartHdState.activeJobs.set(item.id, job);

  emitHdStatus({ itemId: item.id, status: 'loading', progress: 0.08, tier });

  loadHdPhoto(item, {
    getAccessToken: smartHdState.getAccessToken,
    getApiKey: smartHdState.getApiKey,
    signal: abortCtrl?.signal || null,
    onProgress: (p) => {
      if (smartHdState.activeJobs.get(item.id) !== job) return;
      emitHdStatus({ itemId: item.id, status: 'loading', progress: p, tier });
    },
  })
    .then(({ src, fromMemory }) => {
      hdCachedIds.add(item.id);
      emitHdStatus({
        itemId: item.id,
        status: 'ready',
        progress: 1,
        src,
        fromMemory,
        tier,
      });
    })
    .catch((err) => {
      if (err?.name !== 'AbortError' && !abortCtrl?.signal?.aborted) {
        failedHdIds.add(item.id);
        emitHdStatus({ itemId: item.id, status: 'error', progress: 0, tier });
      } else {
        emitHdStatus({ itemId: item.id, status: 'aborted', progress: 0, tier });
      }
    })
    .finally(() => {
      if (smartHdState.activeJobs.get(item.id) === job) {
        smartHdState.activeJobs.delete(item.id);
      }
      Promise.resolve().then(pumpSmartHdScheduler);
    });
}

function pumpSmartHdScheduler() {
  const previewIdle = loadQueue.isIdle();
  const lbList = smartHdState.lightboxItems;
  const inLightbox = lbList.length > 0;

  if (!previewIdle) {
    abortBackgroundHdJobs((job) => job.tier !== 'lightbox');
    if (inLightbox) {
      const curItem = lbList[0];
      const keepLbIds = new Set(lbList.map((i) => i.id));
      abortBackgroundHdJobs((job) => !keepLbIds.has(job.itemId));
      if (isEligibleHdItem(curItem) && !hasCachedHdSrc(curItem) && !smartHdState.activeJobs.has(curItem.id)) {
        if (smartHdState.activeJobs.size >= HD_POOL_CONCURRENCY) {
          const nonCurrent = Array.from(smartHdState.activeJobs.values()).find((j) => !j.isCurrentLightbox);
          if (nonCurrent) {
            nonCurrent.abortCtrl?.abort();
            smartHdState.activeJobs.delete(nonCurrent.itemId);
          }
        }
        if (smartHdState.activeJobs.size < HD_POOL_CONCURRENCY) {
          startSmartHdJob(curItem, 'lightbox', true);
        }
      }
    }
    return;
  }

  // Tier 2: Lightbox open -> parallel load current + next 3 in exact order
  if (inLightbox) {
    const keepLbIds = new Set(lbList.map((i) => i.id));
    abortBackgroundHdJobs((job) => job.tier !== 'lightbox' || !keepLbIds.has(job.itemId));

    for (let i = 0; i < lbList.length; i += 1) {
      if (smartHdState.activeJobs.size >= HD_POOL_CONCURRENCY) break;
      const item = lbList[i];
      if (
        isEligibleHdItem(item) &&
        !hasCachedHdSrc(item) &&
        !smartHdState.activeJobs.has(item.id)
      ) {
        startSmartHdJob(item, 'lightbox', i === 0);
      }
    }
    return;
  }

  abortBackgroundHdJobs((job) => job.tier === 'lightbox');

  // Tier 3: Idle gallery -> prioritize rated / favorited current-page items in parallel
  let uncachedRatedCount = 0;
  for (let i = 0; i < smartHdState.ratedPageItems.length; i += 1) {
    const item = smartHdState.ratedPageItems[i];
    if (!isEligibleHdItem(item) || isPhotoHdCached(item)) continue;
    uncachedRatedCount += 1;
    if (!smartHdState.activeJobs.has(item.id)) {
      if (smartHdState.activeJobs.size >= HD_POOL_CONCURRENCY) {
        const pageJob = Array.from(smartHdState.activeJobs.values()).find((j) => j.tier === 'page');
        if (pageJob) {
          pageJob.abortCtrl?.abort();
          smartHdState.activeJobs.delete(pageJob.itemId);
        } else {
          break;
        }
      }
      startSmartHdJob(item, 'rated', false);
    }
  }

  // Wait until all rated/favorited items finish before upgrading remaining unrated page items
  if (uncachedRatedCount > 0) {
    return;
  }

  // Tier 4: Upgrade remaining current-page photos to HD in parallel
  for (let i = 0; i < smartHdState.restPageItems.length; i += 1) {
    if (smartHdState.activeJobs.size >= HD_POOL_CONCURRENCY) break;
    const item = smartHdState.restPageItems[i];
    if (
      isEligibleHdItem(item) &&
      !isPhotoHdCached(item) &&
      !smartHdState.activeJobs.has(item.id)
    ) {
      startSmartHdJob(item, 'page', false);
    }
  }
}

loadQueue.onBusy(() => {
  abortBackgroundHdJobs((job) => job.tier !== 'lightbox');
});

loadQueue.onIdle(() => {
  pumpSmartHdScheduler();
});

export function updateSmartHdSchedule({
  albumKey = '',
  lightboxItems = [],
  ratedPageItems = [],
  restPageItems = [],
  getAccessToken = null,
  getApiKey = null,
} = {}) {
  if (albumKey && albumKey !== smartHdState.albumKey) {
    smartHdState.albumKey = albumKey;
    driveStorageFailCount = 0;
    failedHdIds.clear();
    abortBackgroundHdJobs();
  }
  smartHdState.lightboxItems = Array.isArray(lightboxItems) ? lightboxItems : [];
  smartHdState.ratedPageItems = Array.isArray(ratedPageItems) ? ratedPageItems : [];
  smartHdState.restPageItems = Array.isArray(restPageItems) ? restPageItems : [];
  smartHdState.protectedIds = new Set(smartHdState.lightboxItems.map((i) => i.id));
  smartHdState.getAccessToken = getAccessToken;
  smartHdState.getApiKey = getApiKey;
  pumpSmartHdScheduler();
}

export function getInstantCachedSrc(item, sizes = [3840, 2048, 1600, 1280, 800, 600, 480, 240, 220]) {
  if (!item) return '';
  if (item.isDemo) return item.demoDataUrl || '';
  const best = getBestLoaded(item.id);
  if (best && best.src) return best.src;
  const hd = hasCachedHdSrc(item);
  if (hd) return hd;
  for (const sz of sizes) {
    const url = touchObjectUrlCache(`${item.id}:${sz}`);
    if (url) return url;
  }
  return '';
}

export function preloadPhoto(item, { size = 2048, getAccessToken = null, getApiKey = null } = {}) {
  if (!item || item.isDemo || (item.mimeType && item.mimeType.startsWith('video/'))) return;
  if (hasCachedHdSrc(item) || inFlightHdPromises.has(item.id)) return;
  if (size >= 2048) {
    const p = loadHdPhoto(item, { getAccessToken, getApiKey })
      .catch(() => {})
      .finally(() => inFlightHdPromises.delete(item.id));
    inFlightHdPromises.set(item.id, p);
    return;
  }
  const targetSize = quantizeThumbSize(size);
  const best = getBestLoaded(item.id);
  if (best && best.size >= targetSize) return;
  loadQueue
    .enqueue(
      () =>
        resolveImageSrc(item, targetSize, getAccessToken, getApiKey, null, {
          allowMediaFallback: false,
        }),
      {}
    )
    .promise.catch(() => {});
}

export function cancelElementPhotoLoad(imgEl) {
  if (!imgEl) return;
  clearTimeout(imgEl._dlDwellTimer);
  imgEl._dlDwellTimer = 0;
  clearTimeout(imgEl._dlUpgradeTimer);
  imgEl._dlUpgradeTimer = 0;
  imgEl._dlPendingUpgradeTo = 0;
  if (typeof imgEl._dlCancelQueue === 'function') {
    imgEl._dlCancelQueue();
    imgEl._dlCancelQueue = null;
  }
  imgEl._dlUpdatePriority = null;
  if (imgEl._dlAbortCtrl) {
    try {
      imgEl._dlAbortCtrl.abort();
    } catch {
      // Ignore
    }
    imgEl._dlAbortCtrl = null;
  }
  imgEl._dlInFlightSize = 0;
  imgEl._dlTargetSize = 0;
  imgEl._dlRetriedCachedSrc = '';
  const obs = activeObservers.get(imgEl);
  if (obs) {
    obs.disconnect();
    activeObservers.delete(imgEl);
  }
  removeLiveImgElement(imgEl);
  imgEl.onload = null;
  imgEl.onerror = null;
}

export function loadPhotoIntoElement(imgEl, item, options = {}) {
  const {
    size = 480,
    getAccessToken = null,
    getApiKey = null,
    eager = false,
    onLoaded = null,
    virtualManaged = false,
    priorityScore = 0,
    scrollSpeedPxPerSec = 0,
    isLookahead = false,
  } = options;
  if (!imgEl || !item) return;
  imgEl.decoding = 'async';

  if (item.isDemo) {
    cancelElementPhotoLoad(imgEl);
    imgEl.src = item.demoDataUrl;
    imgEl.dataset.loadedSize = '3840';
    imgEl.classList.add('is-loaded');
    const card = imgEl.closest('.photo-card');
    if (card) {
      card.classList.add('has-img');
      card.classList.remove('is-thumb-error');
    }
    if (onLoaded) onLoaded();
    return;
  }

  clearTimeout(imgEl._dlUpgradeTimer);
  imgEl._dlUpgradeTimer = 0;
  if (isLookahead) {
    imgEl._dlPendingUpgradeTo = 0;
  }

  const fullTargetSize = quantizeThumbSize(size);
  const initialSize = getAdaptiveThumbTier(size, { scrollSpeedPxPerSec, isLookahead });
  imgEl._dlTargetSize = fullTargetSize;
  registerLiveImgElement(item.id, imgEl);

  const runLoad = (
    desiredSize = fullTargetSize,
    {
      needsFirstPaintArg = Boolean(!isLookahead && Number(imgEl.dataset.loadedSize || 0) === 0),
      priorityArg = eager,
      upgradeTarget = 0,
    } = {}
  ) => {
    if (!imgEl.isConnected) return;
    const desired = desiredSize || imgEl._dlTargetSize || fullTargetSize;
    if (Number(imgEl.dataset.loadedSize || 0) >= desired || imgEl.dataset.hdLoaded === 'true') {
      return;
    }
    if (imgEl._dlInFlightSize && imgEl._dlInFlightSize >= desired) {
      if (upgradeTarget > 0) {
        imgEl._dlPendingUpgradeTo = upgradeTarget;
      }
      imgEl._dlUpdatePriority?.(
        priorityArg,
        virtualManaged ? Number(priorityScore) || 0 : null,
        needsFirstPaintArg
      );
      return;
    }
    if (
      imgEl._dlInFlightSize > 0 &&
      imgEl._dlInFlightSize < desired &&
      Number(imgEl.dataset.loadedSize || 0) === 0 &&
      !isLookahead
    ) {
      imgEl._dlPendingUpgradeTo = desired;
      imgEl._dlUpdatePriority?.(
        priorityArg,
        virtualManaged ? Number(priorityScore) || 0 : null,
        true
      );
      return;
    }

    imgEl._dlCancelQueue?.();
    imgEl._dlPendingUpgradeTo = upgradeTarget;
    const abortCtrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    imgEl._dlAbortCtrl = abortCtrl;
    imgEl._dlInFlightSize = desired;

    const { promise, cancel, updatePriority } = loadQueue.enqueue(
      (sig) =>
        resolveImageSrc(item, desired, getAccessToken, getApiKey, sig, {
          allowMediaFallback: false,
        }),
      {
        priority: priorityArg,
        imgEl,
        abortCtrl,
        priorityScore: virtualManaged ? Number(priorityScore) || 0 : null,
        virtualManaged: Boolean(virtualManaged),
        needsFirstPaint: Boolean(needsFirstPaintArg),
      }
    );
    imgEl._dlCancelQueue = cancel;
    imgEl._dlUpdatePriority = updatePriority;

    promise
      .then(({ src, size: resolvedSz }) => {
        if (!imgEl.isConnected) return;
        const curSz = Number(imgEl.dataset.loadedSize || 0);
        if (resolvedSz >= curSz && src) {
          imgEl.referrerPolicy = 'no-referrer';
          imgEl.dataset.loadedSize = String(resolvedSz);
          imgEl.onerror = null;
          imgEl.onload = () => {
            imgEl._dlRetriedCachedSrc = '';
            imgEl.classList.add('is-loaded');
            const card = imgEl.closest('.photo-card');
            if (card) {
              card.classList.add('has-img');
              card.classList.remove('is-thumb-error');
            }
            if (onLoaded) onLoaded();
          };
          imgEl.src = src;
        }
        const targetAfter = imgEl._dlTargetSize || fullTargetSize;
        const nextUpgrade = imgEl._dlPendingUpgradeTo || upgradeTarget || 0;
        imgEl._dlPendingUpgradeTo = 0;
        if (resolvedSz >= targetAfter) {
          const obs = activeObservers.get(imgEl);
          if (obs) {
            obs.disconnect();
            activeObservers.delete(imgEl);
          }
        } else if (
          nextUpgrade > resolvedSz &&
          !isLookahead &&
          imgEl.isConnected &&
          imgEl._dlItemId === item.id
        ) {
          clearTimeout(imgEl._dlUpgradeTimer);
          imgEl._dlUpgradeTimer = setTimeout(() => {
            imgEl._dlUpgradeTimer = 0;
            if (!imgEl.isConnected || imgEl._dlItemId !== item.id) return;
            const latestTarget = imgEl._dlTargetSize || nextUpgrade;
            if (
              Number(imgEl.dataset.loadedSize || 0) >= latestTarget ||
              imgEl.dataset.hdLoaded === 'true'
            ) {
              return;
            }
            runLoad(latestTarget, {
              needsFirstPaintArg: false,
              priorityArg: false,
              upgradeTarget: 0,
            });
          }, 240);
        }
      })
      .catch((err) => {
        if (err?.name === 'AbortError' || abortCtrl?.signal?.aborted) return;
        const card = imgEl.closest('.photo-card');
        if (card) {
          card.classList.add('has-img', 'is-thumb-error');
        }
      })
      .finally(() => {
        if (imgEl._dlAbortCtrl === abortCtrl) {
          imgEl._dlAbortCtrl = null;
          imgEl._dlInFlightSize = 0;
          imgEl._dlCancelQueue = null;
          imgEl._dlUpdatePriority = null;
        }
      });
  };

  const attachCachedErrorRetry = (assignedSrc) => {
    if (!assignedSrc) return;
    imgEl.onerror = () => {
      imgEl.onerror = null;
      if (imgEl._dlRetriedCachedSrc === assignedSrc) return;
      imgEl._dlRetriedCachedSrc = assignedSrc;
      evictCachedSrcForItem(item, assignedSrc);
      imgEl.dataset.loadedSize = '0';
      delete imgEl.dataset.hdLoaded;
      imgEl.classList.remove('is-loaded');
      runLoad(fullTargetSize, {
        needsFirstPaintArg: !isLookahead,
        priorityArg: eager,
        upgradeTarget: 0,
      });
    };
  };

  let hasInstantHit = false;
  // Always show the sharpest already-loaded version immediately (never downgrade!)
  const best = getBestLoaded(item.id);
  if (best && best.src) {
    hasInstantHit = true;
    const curLoaded = Number(imgEl.dataset.loadedSize || 0);
    if (!imgEl.getAttribute('src') || best.size > curLoaded) {
      imgEl.referrerPolicy = 'no-referrer';
      imgEl.dataset.loadedSize = String(best.size);
      if (best.size >= 3840) imgEl.dataset.hdLoaded = 'true';
      attachCachedErrorRetry(best.src);
      imgEl.src = best.src;
      imgEl.classList.add('is-loaded');
      const card = imgEl.closest('.photo-card');
      if (card) {
        card.classList.add('has-img');
        card.classList.remove('is-thumb-error');
      }
    }
    if (best.size >= fullTargetSize) {
      if (onLoaded) onLoaded();
      return;
    }
  } else if (!imgEl.getAttribute('src')) {
    const instant = getInstantCachedSrc(item);
    if (instant) {
      hasInstantHit = true;
      imgEl.referrerPolicy = 'no-referrer';
      attachCachedErrorRetry(instant);
      imgEl.src = instant;
      imgEl.classList.add('is-loaded');
      const card = imgEl.closest('.photo-card');
      if (card) {
        card.classList.add('has-img');
        card.classList.remove('is-thumb-error');
      }
    }
  }

  if (Number(imgEl.dataset.loadedSize || 0) >= fullTargetSize || imgEl.dataset.hdLoaded === 'true') {
    if (onLoaded) onLoaded();
    return;
  }

  const startStage = () => {
    if (!imgEl.isConnected || imgEl._dlItemId !== item.id) return;
    const hasVisibleImage = Number(imgEl.dataset.loadedSize || 0) > 0 || hasInstantHit;
    if (!hasVisibleImage && initialSize < fullTargetSize) {
      runLoad(initialSize, {
        needsFirstPaintArg: !isLookahead,
        priorityArg: eager,
        upgradeTarget: !isLookahead ? fullTargetSize : 0,
      });
    } else {
      runLoad(fullTargetSize, {
        needsFirstPaintArg: Boolean(!isLookahead && !hasVisibleImage),
        priorityArg: eager,
        upgradeTarget: 0,
      });
    }
  };

  const prevObs = activeObservers.get(imgEl);
  if (prevObs) {
    prevObs.disconnect();
    activeObservers.delete(imgEl);
  }
  clearTimeout(imgEl._dlDwellTimer);
  imgEl._dlDwellTimer = 0;

  if (virtualManaged) {
    if (eager) {
      startStage();
    } else {
      loadQueue.touchActivity(170);
      imgEl._dlDwellTimer = setTimeout(() => {
        imgEl._dlDwellTimer = 0;
        startStage();
      }, 35);
    }
    return;
  }

  if (eager || typeof IntersectionObserver === 'undefined') {
    startStage();
    return;
  }

  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          clearTimeout(imgEl._dlDwellTimer);
          const onScreenNow =
            entry.boundingClientRect.bottom > 0 &&
            entry.boundingClientRect.top < (window.innerHeight || 800);
          const dwellMs = onScreenNow ? 45 : 85;
          imgEl._dlDwellTimer = setTimeout(() => {
            imgEl._dlDwellTimer = 0;
            startStage();
          }, dwellMs);
          loadQueue.touchActivity(170);
        } else {
          clearTimeout(imgEl._dlDwellTimer);
          imgEl._dlDwellTimer = 0;
          if (imgEl._dlCancelQueue) {
            imgEl._dlCancelQueue();
            imgEl._dlCancelQueue = null;
            imgEl._dlUpdatePriority = null;
            imgEl._dlInFlightSize = 0;
          }
        }
      }
    },
    { rootMargin: '200px 0px' }
  );

  activeObservers.set(imgEl, observer);
  loadQueue.touchActivity(170);
  observer.observe(imgEl);
}

let lastSyncedSwAuth = { accessToken: '', apiKey: '' };
let swControllerListenerAttached = false;

function postAuthToSwController() {
  if (typeof navigator === 'undefined' || !navigator.serviceWorker?.controller) return;
  try {
    navigator.serviceWorker.controller.postMessage({
      type: 'DL_AUTH_SYNC',
      accessToken: lastSyncedSwAuth.accessToken,
      apiKey: lastSyncedSwAuth.apiKey,
    });
  } catch {
    // Ignore postMessage errors
  }
}

export function syncServiceWorkerAuth({ accessToken = '', apiKey = '' } = {}) {
  lastSyncedSwAuth = {
    accessToken: String(accessToken || ''),
    apiKey: String(apiKey || ''),
  };
  if (typeof navigator !== 'undefined' && navigator.serviceWorker && !swControllerListenerAttached) {
    swControllerListenerAttached = true;
    try {
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        postAuthToSwController();
      });
    } catch {
      // Ignore environments without addEventListener on serviceWorker
    }
  }
  postAuthToSwController();
}

export function buildDesktopDragDownloadSpec(item, { accessToken = '', apiKey = '' } = {}) {
  syncServiceWorkerAuth({ accessToken, apiKey });
  const cleanedName = String(item?.name || '').replace(/[:/\\\r\n]/g, '').trim();
  let filename = cleanedName || 'photo.jpg';

  if (item?.isDemo) {
    if (!/\.svg$/i.test(filename)) {
      filename = filename.replace(/\.[^.]+$/, '') + '.svg';
    }
    return {
      mime: 'image/svg+xml',
      filename,
      url: item.demoDataUrl || '',
    };
  }

  const mime =
    String(item?.mimeType || 'application/octet-stream').replace(/[:\r\n]/g, '').trim() ||
    'application/octet-stream';

  if (!item?.id) {
    return { mime, filename, url: '' };
  }

  if (objectUrlCache.has(`${item.id}:media`)) {
    return {
      mime,
      filename,
      url: touchObjectUrlCache(`${item.id}:media`) || objectUrlCache.get(`${item.id}:media`),
    };
  }

  if (
    typeof navigator !== 'undefined' &&
    navigator.serviceWorker?.controller &&
    typeof window !== 'undefined'
  ) {
    const streamUrl = new URL(
      './__dl_original__/' + encodeURIComponent(item.id) + '/' + encodeURIComponent(filename),
      window.location.href
    ).href;
    return { mime, filename, url: streamUrl };
  }

  if (!accessToken && apiKey) {
    return {
      mime,
      filename,
      url:
        'https://www.googleapis.com/drive/v3/files/' +
        encodeURIComponent(item.id) +
        '?alt=media&supportsAllDrives=true&key=' +
        encodeURIComponent(apiKey),
    };
  }

  if (objectUrlCache.has(`${item.id}:hd`)) {
    const hdUrl = objectUrlCache.get(`${item.id}:hd`);
    if (typeof hdUrl === 'string' && hdUrl.startsWith('blob:')) {
      return { mime, filename, url: hdUrl };
    }
  }

  return {
    mime,
    filename,
    url: 'https://drive.google.com/uc?export=download&id=' + encodeURIComponent(item.id),
  };
}

export async function fetchAuthorizedMediaBlobUrl(fileId, accessToken, apiKey = '') {
  const cacheKey = `${fileId}:media`;
  const memUrl = touchObjectUrlCache(cacheKey);
  if (memUrl) {
    return memUrl;
  }
  const cachedBlob = await getCachedBlob(cacheKey);
  if (cachedBlob) {
    const objUrl = URL.createObjectURL(cachedBlob);
    setObjectUrlCache(cacheKey, objUrl);
    return objUrl;
  }
  const blob = await fetchMediaBlobWithRetry(fileId, { accessToken, apiKey });
  await setCachedBlob(cacheKey, blob);
  const objUrl = URL.createObjectURL(blob);
  setObjectUrlCache(cacheKey, objUrl);
  return objUrl;
}

export async function clearImageCache() {
  abortBackgroundHdJobs();
  thumbnailRepairBatcher.clear();
  lh3RateGate.clear();
  clearTimeout(healedFlushTimer);
  healedFlushTimer = 0;
  pendingHealedPatches.clear();
  hdCachedIds.clear();
  failedHdIds.clear();
  bestLoadedByItem.clear();
  liveElementsByItem.clear();
  driveStorageFailCount = 0;
  avgThumbLoadMs = 130;
  for (const url of objectUrlCache.values()) {
    if (typeof url === 'string' && url.startsWith('blob:')) {
      try {
        URL.revokeObjectURL(url);
      } catch {
        // Ignore
      }
    }
  }
  objectUrlCache.clear();

  const db = await openCacheDb();
  if (!db) return;
  await new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    } catch {
      resolve();
    }
  });
}
