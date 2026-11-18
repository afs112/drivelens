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
  }

  enqueue(task, { priority = false } = {}) {
    return new Promise((resolve, reject) => {
      const entry = { task, resolve, reject };
      if (priority) {
        this.queue.unshift(entry);
      } else {
        this.queue.push(entry);
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
        });
    }
  }
}

const loadQueue = new ImageLoadQueue(APP_CONFIG.THUMBNAIL_CONCURRENCY);

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
    probe.referrerPolicy = 'no-referrer';
    probe.decoding = 'async';
    probe.onload = () => resolve(url);
    probe.onerror = () => reject(new Error('Thumbnail image load failed'));
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
const BROWSER_DECODABLE_RE = /^image\/(jpe?g|png|webp|gif|avif|bmp|svg\+xml)$/i;
const MAX_ORIGINAL_STREAM_BYTES = 65 * 1024 * 1024;
const MAX_IDB_HD_BLOB_BYTES = 25 * 1024 * 1024;

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
      objectUrlCache.set(hdKey, objUrl);
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
        objectUrlCache.set(hdKey, objUrl);
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
        objectUrlCache.set(hdKey, candidateUrl);
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
