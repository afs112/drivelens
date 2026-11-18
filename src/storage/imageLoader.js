import { APP_CONFIG } from '../constants.js';

const DB_NAME = 'drivelens-img-cache';
const STORE_NAME = 'blobs';
const MAX_CACHE_ENTRIES = 120;

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

  enqueue(task) {
    return new Promise((resolve, reject) => {
      this.queue.push({ task, resolve, reject });
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
      return thumbUrl;
    } catch {
      // Fall through to lh3 or alt=media fallback
    }
  }

  if (!item.thumbnailLink && item.id) {
    const lh3Url = `https://lh3.googleusercontent.com/d/${encodeURIComponent(item.id)}=s${size}`;
    try {
      await loadViaImgTag(lh3Url);
      return lh3Url;
    } catch {
      // Fall through to IndexedDB / alt=media fallback
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

export function loadPhotoIntoElement(imgEl, item, options = {}) {
  const {
    size = 600,
    getAccessToken = null,
    getApiKey = null,
    eager = false,
    onLoaded = null,
  } = options;
  if (!imgEl || !item) return;

  if (item.isDemo) {
    imgEl.src = item.demoDataUrl;
    imgEl.classList.add('is-loaded');
    imgEl.closest('.photo-card')?.classList.add('has-img');
    if (onLoaded) onLoaded();
    return;
  }

  const runLoad = () => {
    if (!imgEl.isConnected) return;
    loadQueue
      .enqueue(() => resolveImageSrc(item, size, getAccessToken, getApiKey))
      .then((src) => {
        if (!imgEl.isConnected) return;
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
