import { APP_CONFIG } from '../constants.js';

const DB_NAME = 'drivelens-img-cache';
const STORE_NAME = 'blobs';
const MAX_CACHE_ENTRIES = 400;

let dbPromise = null;
const objectUrlCache = new Map();

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

class ImageLoadQueue {
  constructor(concurrency) {
    this.concurrency = Math.max(1, concurrency || 6);
    this.active = 0;
    this.queue = [];
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

  touchActivity(settleMs = 180) {
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

  enqueue(task, { priority = false } = {}) {
    return new Promise((resolve, reject) => {
      const wasIdle = this.isIdle();
      clearTimeout(this._settleTimer);
      this._settling = false;
      const entry = { task, resolve, reject };
      if (priority) {
        this.queue.unshift(entry);
      } else {
        this.queue.push(entry);
      }
      if (wasIdle) {
        for (const fn of this._busyListeners) fn();
      }
      this._drain();
    });
  }

  _drain() {
    while (this.active < this.concurrency && this.queue.length > 0) {
      const { task, resolve, reject } = this.queue.shift();
      this.active += 1;
      Promise.resolve()
        .then(task)
        .then(resolve, reject)
        .finally(() => {
          this.active -= 1;
          this._drain();
          if (this.active === 0 && this.queue.length === 0) {
            this.touchActivity(140);
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

function loadViaImgTag(url) {
  return new Promise((resolve, reject) => {
    const probe = new Image();
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      probe.src = '';
      reject(new Error('Thumbnail load timeout'));
    }, 8000);
    probe.referrerPolicy = 'no-referrer';
    probe.decoding = 'async';
    probe.onload = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(url);
    };
    probe.onerror = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error('Thumbnail image load failed'));
    };
    probe.src = url;
  });
}

async function fetchMediaBlobWithRetry(fileId, auth = {}, attempt = 0) {
  const { accessToken = '', apiKey = '' } = typeof auth === 'string' ? { accessToken: auth } : auth;
  const baseUrl = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media&supportsAllDrives=true`;
  const url = !accessToken && apiKey
    ? `${baseUrl}&key=${encodeURIComponent(apiKey)}`
    : baseUrl;
  const headers = accessToken ? { Authorization: `Bearer ${accessToken}` } : {};
  const resp = await fetch(url, { headers });
  if ((resp.status === 429 || resp.status === 503) && attempt < 1) {
    await new Promise((r) => setTimeout(r, 1200));
    return fetchMediaBlobWithRetry(fileId, { accessToken, apiKey }, attempt + 1);
  }
  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status}`);
  }
  return resp.blob();
}

async function resolveImageSrc(item, size, getAccessToken, getApiKey) {
  if (!item) return '';
  if (item.isDemo) return item.demoDataUrl || '';

  const memKey = `${item.id}:${size}`;
  if (objectUrlCache.has(memKey)) {
    return objectUrlCache.get(memKey);
  }

  const thumbUrl = buildDriveThumbUrl(item, size);
  if (thumbUrl) {
    try {
      await loadViaImgTag(thumbUrl);
      objectUrlCache.set(memKey, thumbUrl);
      return thumbUrl;
    } catch {
      // Fall through to fresh Drive / lh3 / alt=media fallbacks (handles expired thumbnailLink tokens)
    }
  }

  if (item.id) {
    const candidates = [
      `https://drive.google.com/thumbnail?id=${encodeURIComponent(item.id)}&sz=w${size}`,
      `https://lh3.googleusercontent.com/d/${encodeURIComponent(item.id)}=s${size}`,
    ];
    for (const candidateUrl of candidates) {
      if (candidateUrl === thumbUrl) continue;
      try {
        await loadViaImgTag(candidateUrl);
        objectUrlCache.set(memKey, candidateUrl);
        return candidateUrl;
      } catch {
        // Try next lightweight endpoint
      }
    }
  }

  const cacheKey = `${item.id}:media`;
  if (objectUrlCache.has(cacheKey)) {
    return objectUrlCache.get(cacheKey);
  }

  const cachedBlob = await getCachedBlob(cacheKey);
  if (cachedBlob) {
    const objUrl = URL.createObjectURL(cachedBlob);
    objectUrlCache.set(cacheKey, objUrl);
    return objUrl;
  }

  const token = typeof getAccessToken === 'function' ? getAccessToken() : '';
  const apiKey = typeof getApiKey === 'function' ? getApiKey() : '';
  if (!token && !apiKey) {
    throw new Error('Missing Google Drive access token or API key');
  }

  const blob = await fetchMediaBlobWithRetry(item.id, { accessToken: token, apiKey });
  await setCachedBlob(cacheKey, blob);
  const objUrl = URL.createObjectURL(blob);
  objectUrlCache.set(cacheKey, objUrl);
  return objUrl;
}

const activeObservers = new WeakMap();
const inFlightHdPromises = new Map();
const hdCachedIds = new Set();
const failedHdIds = new Set();
const hdStatusListeners = new Set();
const BROWSER_DECODABLE_RE = /^image\/(jpe?g|png|webp|gif|avif|bmp|svg\+xml)$/i;
const MAX_ORIGINAL_STREAM_BYTES = 65 * 1024 * 1024;
const MAX_IDB_HD_BLOB_BYTES = 25 * 1024 * 1024;
const MAX_MEMORY_HD_ENTRIES = 50;

function rememberHdInMemory(hdKey, fileId, url, protectedIds = null) {
  objectUrlCache.delete(hdKey);
  objectUrlCache.set(hdKey, url);
  hdCachedIds.add(fileId);

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
    }
    hdCount -= 1;
    if (hdCount <= MAX_MEMORY_HD_ENTRIES) break;
  }
}

function decodeImageUrl(url) {
  return new Promise((resolve, reject) => {
    const probe = new Image();
    probe.referrerPolicy = 'no-referrer';
    probe.decoding = 'async';
    probe.onload = () => {
      if (typeof probe.decode === 'function') {
        probe.decode().then(() => resolve(url), () => resolve(url));
      } else {
        resolve(url);
      }
    };
    probe.onerror = () => reject(new Error('HD image decode failed'));
    probe.src = url;
  });
}

async function fetchOriginalHdStream(item, auth = {}, signal = null, onProgress = null, attempt = 0) {
  const { accessToken = '', apiKey = '' } = auth;
  const baseUrl = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(item.id)}?alt=media&supportsAllDrives=true`;
  const url = !accessToken && apiKey ? `${baseUrl}&key=${encodeURIComponent(apiKey)}` : baseUrl;
  const headers = accessToken ? { Authorization: `Bearer ${accessToken}` } : {};

  const resp = await fetch(url, { headers, signal });
  if ((resp.status === 429 || resp.status === 503) && attempt < 1) {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, 900);
      signal?.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          reject(new DOMException('Aborted', 'AbortError'));
        },
        { once: true }
      );
    });
    return fetchOriginalHdStream(item, auth, signal, onProgress, attempt + 1);
  }
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
  const mime = item.mimeType || 'image/jpeg';
  const fileSize = Number(item.size || 0);
  const canStreamOriginal =
    Boolean(token || apiKey) &&
    BROWSER_DECODABLE_RE.test(mime) &&
    (fileSize === 0 || fileSize <= MAX_ORIGINAL_STREAM_BYTES);

  if (canStreamOriginal) {
    try {
      const blob = await fetchOriginalHdStream(
        item,
        { accessToken: token, apiKey },
        signal,
        onProgress
      );
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      const objUrl = URL.createObjectURL(blob);
      try {
        await decodeImageUrl(objUrl);
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
    } catch (err) {
      if (err?.name === 'AbortError' || signal?.aborted) {
        throw err;
      }
      // Fall through to 4096px server-rendered HD fallback (RAW/HEIC or restricted download quota)
    }
  }

  let simVal = 0.22;
  const simTimer = onProgress
    ? setInterval(() => {
        simVal = Math.min(0.86, simVal + (0.9 - simVal) * 0.22);
        onProgress(simVal);
      }, 90)
    : null;

  try {
    const candidates = [
      `https://lh3.googleusercontent.com/d/${encodeURIComponent(item.id)}=s4096`,
      `https://drive.google.com/thumbnail?id=${encodeURIComponent(item.id)}&sz=w4096`,
      buildDriveThumbUrl(item, 4096),
      `https://drive.google.com/thumbnail?id=${encodeURIComponent(item.id)}&sz=w2048`,
      buildDriveThumbUrl(item, 2048),
    ].filter(Boolean);

    const seen = new Set();
    for (const candidateUrl of candidates) {
      if (seen.has(candidateUrl)) continue;
      seen.add(candidateUrl);
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      try {
        await decodeImageUrl(candidateUrl);
        if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
        rememberHdInMemory(hdKey, item.id, candidateUrl, smartHdState.protectedIds);
        if (onProgress) onProgress(1);
        return { src: candidateUrl, fromMemory: false };
      } catch {
        // Try next HD endpoint
      }
    }
  } finally {
    if (simTimer) clearInterval(simTimer);
  }

  throw new Error('Failed to load HD photo');
}

export function isPhotoHdCached(item) {
  if (!item) return true;
  if (item.isDemo) return true;
  if (item.mimeType && item.mimeType.startsWith('video/')) return true;
  return Boolean(hasCachedHdSrc(item) || hdCachedIds.has(item.id));
}

const smartHdState = {
  lightboxItems: [],
  ratedPageItems: [],
  protectedIds: new Set(),
  getAccessToken: null,
  getApiKey: null,
  currentJob: null,
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
  return {
    previewIdle: loadQueue.isIdle(),
    previewActive: loadQueue.active,
    previewQueued: loadQueue.queue.length,
    currentJob: smartHdState.currentJob
      ? { itemId: smartHdState.currentJob.itemId, tier: smartHdState.currentJob.tier }
      : null,
    lightboxTargetIds: smartHdState.lightboxItems.map((i) => i.id),
    ratedTargetIds: smartHdState.ratedPageItems.map((i) => i.id),
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

function selectNextSmartHdTarget() {
  for (let i = 0; i < smartHdState.lightboxItems.length; i += 1) {
    const item = smartHdState.lightboxItems[i];
    if (isEligibleHdItem(item) && !hasCachedHdSrc(item)) {
      return { item, tier: 'lightbox', isCurrentLightbox: i === 0 };
    }
  }
  for (let i = 0; i < smartHdState.ratedPageItems.length; i += 1) {
    const item = smartHdState.ratedPageItems[i];
    if (isEligibleHdItem(item) && !isPhotoHdCached(item)) {
      return { item, tier: 'rated', isCurrentLightbox: false };
    }
  }
  return null;
}

function pumpSmartHdScheduler() {
  const next = selectNextSmartHdTarget();

  // Tier 1: Always load page & slide previews FIRST before starting heavy HD downloads
  if (!loadQueue.isIdle()) {
    if (smartHdState.currentJob && smartHdState.currentJob.tier === 'rated') {
      smartHdState.currentJob.abortCtrl?.abort();
      smartHdState.currentJob = null;
    }
    if (next && next.isCurrentLightbox && !smartHdState.currentJob) {
      emitHdStatus({ itemId: next.item.id, status: 'queued', progress: 0.06, tier: 'lightbox' });
    }
    return;
  }

  if (!next) {
    return;
  }

  const cur = smartHdState.currentJob;
  if (cur) {
    if (cur.itemId === next.item.id) {
      return;
    }
    const curStillInLightboxWindow = smartHdState.lightboxItems.some((i) => i.id === cur.itemId);
    if (
      next.tier === 'lightbox' &&
      (cur.tier === 'rated' || next.isCurrentLightbox || !curStillInLightboxWindow)
    ) {
      cur.abortCtrl?.abort();
      smartHdState.currentJob = null;
    } else {
      return;
    }
  }

  const abortCtrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const job = {
    itemId: next.item.id,
    tier: next.tier,
    abortCtrl,
  };
  smartHdState.currentJob = job;

  emitHdStatus({ itemId: next.item.id, status: 'loading', progress: 0.08, tier: next.tier });

  loadHdPhoto(next.item, {
    getAccessToken: smartHdState.getAccessToken,
    getApiKey: smartHdState.getApiKey,
    signal: abortCtrl?.signal || null,
    onProgress: (p) => {
      if (smartHdState.currentJob !== job) return;
      emitHdStatus({ itemId: next.item.id, status: 'loading', progress: p, tier: next.tier });
    },
  })
    .then(({ src, fromMemory }) => {
      hdCachedIds.add(next.item.id);
      emitHdStatus({
        itemId: next.item.id,
        status: 'ready',
        progress: 1,
        src,
        fromMemory,
        tier: next.tier,
      });
    })
    .catch((err) => {
      if (err?.name !== 'AbortError' && !abortCtrl?.signal?.aborted) {
        failedHdIds.add(next.item.id);
        emitHdStatus({ itemId: next.item.id, status: 'error', progress: 0, tier: next.tier });
      } else {
        emitHdStatus({ itemId: next.item.id, status: 'aborted', progress: 0, tier: next.tier });
      }
    })
    .finally(() => {
      if (smartHdState.currentJob === job) {
        smartHdState.currentJob = null;
      }
      Promise.resolve().then(pumpSmartHdScheduler);
    });
}

loadQueue.onBusy(() => {
  if (smartHdState.currentJob && smartHdState.currentJob.tier === 'rated') {
    smartHdState.currentJob.abortCtrl?.abort();
    smartHdState.currentJob = null;
  }
});

loadQueue.onIdle(() => {
  pumpSmartHdScheduler();
});

export function updateSmartHdSchedule({
  albumKey = '',
  lightboxItems = [],
  ratedPageItems = [],
  getAccessToken = null,
  getApiKey = null,
} = {}) {
  if (albumKey && albumKey !== smartHdState.albumKey) {
    smartHdState.albumKey = albumKey;
    failedHdIds.clear();
    if (smartHdState.currentJob) {
      smartHdState.currentJob.abortCtrl?.abort();
      smartHdState.currentJob = null;
    }
  }
  smartHdState.lightboxItems = Array.isArray(lightboxItems) ? lightboxItems : [];
  smartHdState.ratedPageItems = Array.isArray(ratedPageItems) ? ratedPageItems : [];
  smartHdState.protectedIds = new Set(smartHdState.lightboxItems.map((i) => i.id));
  smartHdState.getAccessToken = getAccessToken;
  smartHdState.getApiKey = getApiKey;
  pumpSmartHdScheduler();
}

export function getInstantCachedSrc(item, sizes = [4096, 2048, 600, 480]) {
  if (!item) return '';
  if (item.isDemo) return item.demoDataUrl || '';
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
  if (objectUrlCache.has(`${item.id}:${size}`)) return;
  loadQueue.enqueue(() => resolveImageSrc(item, size, getAccessToken, getApiKey)).catch(() => {});
}

export function loadPhotoIntoElement(imgEl, item, options = {}) {
  const {
    size = 600,
    getAccessToken = null,
    getApiKey = null,
    eager = false,
    onLoaded = null,
  } = options;
  if (!imgEl || !item) return;
  imgEl.decoding = 'async';

  if (item.isDemo) {
    imgEl.src = item.demoDataUrl;
    imgEl.classList.add('is-loaded');
    imgEl.closest('.photo-card')?.classList.add('has-img');
    if (onLoaded) onLoaded();
    return;
  }

  if (!imgEl.getAttribute('src')) {
    const instant = getInstantCachedSrc(item, [size, 480, 600]);
    if (instant) {
      imgEl.referrerPolicy = 'no-referrer';
      imgEl.src = instant;
      imgEl.classList.add('is-loaded');
    }
  }

  const runLoad = () => {
    if (!imgEl.isConnected || imgEl.dataset.hdLoaded === 'true') return;
    loadQueue
      .enqueue(() => resolveImageSrc(item, size, getAccessToken, getApiKey), { priority: eager })
      .then((src) => {
        if (!imgEl.isConnected || imgEl.dataset.hdLoaded === 'true') return;
        imgEl.referrerPolicy = 'no-referrer';
        imgEl.onload = () => {
          imgEl.classList.add('is-loaded');
          imgEl.closest('.photo-card')?.classList.add('has-img');
          if (onLoaded) onLoaded();
        };
        imgEl.src = src;
      })
      .catch(() => {
        imgEl.closest('.photo-card')?.classList.add('has-img');
      });
  };

  if (eager || typeof IntersectionObserver === 'undefined') {
    runLoad();
    return;
  }

  const prevObs = activeObservers.get(imgEl);
  if (prevObs) prevObs.disconnect();

  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          observer.disconnect();
          activeObservers.delete(imgEl);
          runLoad();
          break;
        }
      }
    },
    { rootMargin: '260px 0px' }
  );

  activeObservers.set(imgEl, observer);
  loadQueue.touchActivity(180);
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
  if (smartHdState.currentJob) {
    smartHdState.currentJob.abortCtrl?.abort();
    smartHdState.currentJob = null;
  }
  hdCachedIds.clear();
  failedHdIds.clear();
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
