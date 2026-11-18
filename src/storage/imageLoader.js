import { fetchFreshThumbnailLink, fetchWithDriveBackoff } from '../api/gdrive.js';
import { APP_CONFIG } from '../constants.js';

const DB_NAME = 'drivelens-img-cache';
const STORE_NAME = 'blobs';
const MAX_CACHE_ENTRIES = 400;

let dbPromise = null;
const objectUrlCache = new Map();
const bestLoadedByItem = new Map();
const liveElementsByItem = new Map();

export function quantizeThumbSize(requestedPx = 480) {
  const px = Number(requestedPx) || 480;
  if (px <= 260) return 240;
  if (px <= 560) return 480;
  if (px <= 920) return 800;
  if (px <= 1360) return 1280;
  if (px <= 1920) return 1600;
  return 3840;
}

function registerLiveImgElement(fileId, imgEl) {
  if (!fileId || !imgEl) return;
  let set = liveElementsByItem.get(fileId);
  if (!set) {
    set = new Set();
    liveElementsByItem.set(fileId, set);
  }
  set.add(imgEl);
  if (set.size > 16) {
    for (const el of set) {
      if (!el.isConnected) set.delete(el);
    }
  }
}

function recordBestLoaded(fileId, size, src) {
  if (!fileId || !src) return;
  const numSize = Number(size) || 480;
  const prev = bestLoadedByItem.get(fileId);
  if (!prev || numSize >= prev.size) {
    bestLoadedByItem.set(fileId, { size: numSize, src });
  }

  const set = liveElementsByItem.get(fileId);
  if (!set) return;
  for (const el of set) {
    if (!el.isConnected) {
      set.delete(el);
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
      el.closest('.photo-card')?.classList.add('has-img');
    }
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

  enqueue(task, { priority = false, imgEl = null, abortCtrl = null } = {}) {
    let entryRef = null;
    const promise = new Promise((resolve, reject) => {
      const wasIdle = this.isIdle();
      clearTimeout(this._settleTimer);
      this._settling = false;
      entryRef = { task, resolve, reject, priority, imgEl, abortCtrl, cancelled: false };
      if (priority) {
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

    return { promise, cancel };
  }

  _maybePreemptOffScreen(incoming) {
    if (this.active < this.concurrency) return;
    const incomingUrgent =
      incoming.priority ||
      (incoming.imgEl && scoreElementViewportPriority(incoming.imgEl) < 100000);
    if (!incomingUrgent) return;

    for (const running of this.activeEntries) {
      if (!running.priority && running.abortCtrl && isElementStrictlyOffScreen(running.imgEl)) {
        running.abortCtrl.abort();
        break;
      }
    }
  }

  _pickNextIndex() {
    if (this.queue.length <= 1) return 0;
    let bestIdx = 0;
    let bestScore = Infinity;
    for (let i = 0; i < this.queue.length; i += 1) {
      const entry = this.queue[i];
      if (entry.priority) return i;
      const score = scoreElementViewportPriority(entry.imgEl);
      if (score < bestScore) {
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

async function resolveImageSrc(item, size, getAccessToken, getApiKey, signal = null) {
  if (!item) return { src: '', size: 0 };
  if (item.isDemo) return { src: item.demoDataUrl || '', size: 3840 };

  const best = bestLoadedByItem.get(item.id);
  if (best && best.size >= size) {
    return best;
  }

  const memKey = `${item.id}:${size}`;
  if (objectUrlCache.has(memKey)) {
    const cachedUrl = objectUrlCache.get(memKey);
    recordBestLoaded(item.id, size, cachedUrl);
    return { src: cachedUrl, size };
  }

  const thumbUrl = buildDriveThumbUrl(item, size);
  if (thumbUrl && !isStaleDriveStorageUrl(thumbUrl)) {
    try {
      await loadViaImgTag(thumbUrl, signal);
      if (thumbUrl.includes('/drive-storage/')) driveStorageFailCount = 0;
      objectUrlCache.set(memKey, thumbUrl);
      recordBestLoaded(item.id, size, thumbUrl);
      return { src: thumbUrl, size };
    } catch (err) {
      if (err?.name === 'AbortError' || signal?.aborted) throw err;
      if (thumbUrl.includes('/drive-storage/')) driveStorageFailCount += 1;
    }
  }

  if (item.id) {
    const candidates = [
      `https://drive.google.com/thumbnail?id=${encodeURIComponent(item.id)}&sz=w${size}`,
      `https://lh3.googleusercontent.com/d/${encodeURIComponent(item.id)}=s${size}`,
    ];
    for (const candidateUrl of candidates) {
      if (candidateUrl === thumbUrl) continue;
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      try {
        await loadViaImgTag(candidateUrl, signal);
        objectUrlCache.set(memKey, candidateUrl);
        recordBestLoaded(item.id, size, candidateUrl);
        return { src: candidateUrl, size };
      } catch (err) {
        if (err?.name === 'AbortError' || signal?.aborted) throw err;
      }
    }
  }

  const token = typeof getAccessToken === 'function' ? getAccessToken() : '';
  const apiKey = typeof getApiKey === 'function' ? getApiKey() : '';

  if ((token || apiKey) && item.id) {
    const freshLink = await fetchFreshThumbnailLink(item.id, { accessToken: token, apiKey }, signal);
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    if (freshLink) {
      item.thumbnailLink = freshLink;
      driveStorageFailCount = 0;
      const freshSized = buildDriveThumbUrl(item, size);
      try {
        await loadViaImgTag(freshSized, signal);
        objectUrlCache.set(memKey, freshSized);
        recordBestLoaded(item.id, size, freshSized);
        return { src: freshSized, size };
      } catch (err) {
        if (err?.name === 'AbortError' || signal?.aborted) throw err;
      }
    }
  }

  const cacheKey = `${item.id}:media`;
  if (objectUrlCache.has(cacheKey)) {
    const mediaUrl = objectUrlCache.get(cacheKey);
    recordBestLoaded(item.id, 3840, mediaUrl);
    return { src: mediaUrl, size: 3840 };
  }

  const cachedBlob = await getCachedBlob(cacheKey);
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  if (cachedBlob) {
    const objUrl = URL.createObjectURL(cachedBlob);
    objectUrlCache.set(cacheKey, objUrl);
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
  objectUrlCache.set(cacheKey, objUrl);
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
const MAX_MEMORY_HD_ENTRIES = 80;

function rememberHdInMemory(hdKey, fileId, url, protectedIds = null) {
  objectUrlCache.delete(hdKey);
  objectUrlCache.set(hdKey, url);
  hdCachedIds.add(fileId);
  recordBestLoaded(fileId, 3840, url);

  let hdCount = 0;
  for (const k of objectUrlCache.keys()) {
    if (k.endsWith(':hd')) hdCount += 1;
  }
  if (hdCount <= MAX_MEMORY_HD_ENTRIES) return;

  for (const [k, val] of objectUrlCache.entries()) {
    if (!k.endsWith(':hd')) continue;
    const id = k.slice(0, -3);
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
    hdCount -= 1;
    if (hdCount <= MAX_MEMORY_HD_ENTRIES) break;
  }
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
  const best = bestLoadedByItem.get(item.id);
  if (best && best.size >= 3840 && best.src) return best.src;
  return objectUrlCache.get(`${item.id}:hd`) || objectUrlCache.get(`${item.id}:media`) || '';
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
      !isStaleDriveStorageUrl(directThumb) ? directThumb : '',
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
        item.thumbnailLink = freshLink;
        driveStorageFailCount = 0;
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

function abortBackgroundHdJobs(predicate = null) {
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
  const best = bestLoadedByItem.get(item.id);
  if (best && best.src) return best.src;
  const hd = hasCachedHdSrc(item);
  if (hd) return hd;
  for (const sz of sizes) {
    const url = objectUrlCache.get(`${item.id}:${sz}`);
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
  const best = bestLoadedByItem.get(item.id);
  if (best && best.size >= targetSize) return;
  loadQueue.enqueue(() => resolveImageSrc(item, targetSize, getAccessToken, getApiKey)).promise.catch(() => {});
}

export function loadPhotoIntoElement(imgEl, item, options = {}) {
  const {
    size = 480,
    getAccessToken = null,
    getApiKey = null,
    eager = false,
    onLoaded = null,
  } = options;
  if (!imgEl || !item) return;
  imgEl.decoding = 'async';

  if (item.isDemo) {
    imgEl.src = item.demoDataUrl;
    imgEl.dataset.loadedSize = '3840';
    imgEl.classList.add('is-loaded');
    imgEl.closest('.photo-card')?.classList.add('has-img');
    if (onLoaded) onLoaded();
    return;
  }

  const targetSize = quantizeThumbSize(size);
  imgEl._dlTargetSize = targetSize;
  registerLiveImgElement(item.id, imgEl);

  // Always show the sharpest already-loaded version immediately (never downgrade!)
  const best = bestLoadedByItem.get(item.id);
  if (best && best.src) {
    const curLoaded = Number(imgEl.dataset.loadedSize || 0);
    if (!imgEl.getAttribute('src') || best.size > curLoaded) {
      imgEl.referrerPolicy = 'no-referrer';
      imgEl.dataset.loadedSize = String(best.size);
      if (best.size >= 3840) imgEl.dataset.hdLoaded = 'true';
      imgEl.src = best.src;
      imgEl.classList.add('is-loaded');
      imgEl.closest('.photo-card')?.classList.add('has-img');
    }
    if (best.size >= targetSize) {
      if (onLoaded) onLoaded();
      return;
    }
  } else if (!imgEl.getAttribute('src')) {
    const instant = getInstantCachedSrc(item);
    if (instant) {
      imgEl.referrerPolicy = 'no-referrer';
      imgEl.src = instant;
      imgEl.classList.add('is-loaded');
      imgEl.closest('.photo-card')?.classList.add('has-img');
    }
  }

  if (Number(imgEl.dataset.loadedSize || 0) >= targetSize || imgEl.dataset.hdLoaded === 'true') {
    if (onLoaded) onLoaded();
    return;
  }

  const runLoad = () => {
    if (!imgEl.isConnected) return;
    const desired = imgEl._dlTargetSize || targetSize;
    if (Number(imgEl.dataset.loadedSize || 0) >= desired || imgEl.dataset.hdLoaded === 'true') {
      return;
    }
    if (imgEl._dlInFlightSize && imgEl._dlInFlightSize >= desired) {
      return;
    }

    imgEl._dlCancelQueue?.();
    const abortCtrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    imgEl._dlAbortCtrl = abortCtrl;
    imgEl._dlInFlightSize = desired;

    const { promise, cancel } = loadQueue.enqueue(
      (sig) => resolveImageSrc(item, desired, getAccessToken, getApiKey, sig),
      { priority: eager, imgEl, abortCtrl }
    );
    imgEl._dlCancelQueue = cancel;

    promise
      .then(({ src, size: resolvedSz }) => {
        if (!imgEl.isConnected) return;
        const curSz = Number(imgEl.dataset.loadedSize || 0);
        if (resolvedSz >= curSz && src) {
          imgEl.referrerPolicy = 'no-referrer';
          imgEl.dataset.loadedSize = String(resolvedSz);
          imgEl.onload = () => {
            imgEl.classList.add('is-loaded');
            imgEl.closest('.photo-card')?.classList.add('has-img');
            if (onLoaded) onLoaded();
          };
          imgEl.src = src;
        }
        if (resolvedSz >= (imgEl._dlTargetSize || desired)) {
          const obs = activeObservers.get(imgEl);
          if (obs) {
            obs.disconnect();
            activeObservers.delete(imgEl);
          }
        }
      })
      .catch((err) => {
        if (err?.name === 'AbortError') return;
        imgEl.closest('.photo-card')?.classList.add('has-img');
      })
      .finally(() => {
        if (imgEl._dlAbortCtrl === abortCtrl) {
          imgEl._dlAbortCtrl = null;
          imgEl._dlInFlightSize = 0;
          imgEl._dlCancelQueue = null;
        }
      });
  };

  if (eager || typeof IntersectionObserver === 'undefined') {
    runLoad();
    return;
  }

  const prevObs = activeObservers.get(imgEl);
  if (prevObs) {
    prevObs.disconnect();
    activeObservers.delete(imgEl);
  }
  clearTimeout(imgEl._dlDwellTimer);

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
            runLoad();
          }, dwellMs);
          loadQueue.touchActivity(170);
        } else {
          clearTimeout(imgEl._dlDwellTimer);
          imgEl._dlDwellTimer = 0;
          if (imgEl._dlCancelQueue) {
            imgEl._dlCancelQueue();
            imgEl._dlCancelQueue = null;
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

export async function fetchAuthorizedMediaBlobUrl(fileId, accessToken, apiKey = '') {
  const cacheKey = `${fileId}:media`;
  if (objectUrlCache.has(cacheKey)) {
    return objectUrlCache.get(cacheKey);
  }
  const cachedBlob = await getCachedBlob(cacheKey);
  if (cachedBlob) {
    const objUrl = URL.createObjectURL(cachedBlob);
    objectUrlCache.set(cacheKey, objUrl);
    return objUrl;
  }
  const blob = await fetchMediaBlobWithRetry(fileId, { accessToken, apiKey });
  await setCachedBlob(cacheKey, blob);
  const objUrl = URL.createObjectURL(blob);
  objectUrlCache.set(cacheKey, objUrl);
  return objUrl;
}

export async function clearImageCache() {
  abortBackgroundHdJobs();
  hdCachedIds.clear();
  failedHdIds.clear();
  bestLoadedByItem.clear();
  liveElementsByItem.clear();
  driveStorageFailCount = 0;
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
