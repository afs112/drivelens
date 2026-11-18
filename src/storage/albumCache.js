/**
 * Persistent local album directory & collaboration metadata cache.
 * Uses IndexedDB as primary storage (max 12 albums) with automatic
 * localStorage fallback (max 3 albums) for Stale-While-Revalidate loading.
 * Security: NEVER stores apiKey, accessToken, or clientId.
 */

const DB_NAME = 'drivelens-album-cache';
const STORE_NAME = 'albums';
const MAX_ALBUM_CACHES = 12;
const FALLBACK_PREFIX = 'drivelens_album_cache_v1_';
const MAX_FALLBACK_ENTRIES = 3;

let dbPromise = null;

export function buildAlbumCacheKey(authType, folderId) {
  const normAuth = String(authType || 'apikey').trim().toLowerCase() === 'oauth' ? 'oauth' : 'apikey';
  const cleanFolder = String(folderId || '').trim();
  return cleanFolder ? `${normAuth}:${cleanFolder}` : '';
}

function openAlbumCacheDb() {
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
          store.createIndex('savedAt', 'savedAt');
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

function buildSanitizedSnapshot(key, authType, folderId, snapshot) {
  if (!snapshot || !snapshot.rootFolder || !Array.isArray(snapshot.files)) {
    return null;
  }
  return {
    key,
    version: 1,
    authType: authType === 'oauth' ? 'oauth' : 'apikey',
    folderId: String(folderId || '').trim(),
    savedAt: Number(snapshot.savedAt || Date.now()),
    rootFolder: snapshot.rootFolder,
    folders: Array.isArray(snapshot.folders) ? snapshot.folders : [snapshot.rootFolder],
    files: snapshot.files,
    metaFolderId: snapshot.metaFolderId || null,
    canWrite: Boolean(snapshot.canWrite),
    tagSchemaFileId: snapshot.tagSchemaFileId || null,
    tagSchema:
      snapshot.tagSchema && typeof snapshot.tagSchema === 'object'
        ? { version: 1, tags: snapshot.tagSchema.tags || {} }
        : { version: 1, tags: {} },
    memberFilesById:
      snapshot.memberFilesById && typeof snapshot.memberFilesById === 'object'
        ? snapshot.memberFilesById
        : {},
    membersData:
      snapshot.membersData && typeof snapshot.membersData === 'object'
        ? snapshot.membersData
        : {},
    localMetaSupported: Boolean(snapshot.localMetaSupported),
  };
}

function readFallbackCache(key) {
  try {
    if (typeof localStorage === 'undefined') return null;
    const raw = localStorage.getItem(`${FALLBACK_PREFIX}${key}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || !parsed.rootFolder || !Array.isArray(parsed.files)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function pruneAndWriteFallbackCache(record) {
  try {
    if (typeof localStorage === 'undefined') return;
    const entries = [];
    for (let i = 0; i < localStorage.length; i += 1) {
      const k = localStorage.key(i);
      if (k && k.startsWith(FALLBACK_PREFIX)) {
        try {
          const val = JSON.parse(localStorage.getItem(k) || 'null');
          entries.push({ storageKey: k, savedAt: Number(val?.savedAt || 0) });
        } catch {
          entries.push({ storageKey: k, savedAt: 0 });
        }
      }
    }
    const targetStorageKey = `${FALLBACK_PREFIX}${record.key}`;
    const others = entries
      .filter((e) => e.storageKey !== targetStorageKey)
      .sort((a, b) => a.savedAt - b.savedAt);
    while (others.length >= MAX_FALLBACK_ENTRIES) {
      const oldest = others.shift();
      if (oldest) localStorage.removeItem(oldest.storageKey);
    }
    localStorage.setItem(targetStorageKey, JSON.stringify(record));
  } catch {
    // Ignore storage quota / privacy mode errors
  }
}

export async function getCachedAlbum(authType, folderId) {
  const key = buildAlbumCacheKey(authType, folderId);
  if (!key) return null;

  const db = await openAlbumCacheDb();
  if (db) {
    const idbResult = await new Promise((resolve) => {
      try {
        const tx = db.transaction(STORE_NAME, 'readonly');
        const req = tx.objectStore(STORE_NAME).get(key);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => resolve(null);
      } catch {
        resolve(null);
      }
    });
    if (idbResult && idbResult.rootFolder && Array.isArray(idbResult.files)) {
      return idbResult;
    }
  }

  return readFallbackCache(key);
}

export async function setCachedAlbum(authType, folderId, snapshot) {
  const key = buildAlbumCacheKey(authType, folderId);
  if (!key) return false;
  const record = buildSanitizedSnapshot(key, authType, folderId, snapshot);
  if (!record) return false;

  const db = await openAlbumCacheDb();
  if (db) {
    const ok = await new Promise((resolve) => {
      try {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        store.put(record);

        const countReq = store.count();
        countReq.onsuccess = () => {
          if (countReq.result > MAX_ALBUM_CACHES) {
            const idx = store.index('savedAt');
            let toDelete = countReq.result - MAX_ALBUM_CACHES;
            idx.openCursor().onsuccess = (ev) => {
              const cursor = ev.target.result;
              if (cursor && toDelete > 0) {
                if (cursor.primaryKey !== key) {
                  cursor.delete();
                  toDelete -= 1;
                }
                cursor.continue();
              }
            };
          }
        };

        tx.oncomplete = () => resolve(true);
        tx.onerror = () => resolve(false);
        tx.onabort = () => resolve(false);
      } catch {
        resolve(false);
      }
    });
    if (ok) return true;
  }

  pruneAndWriteFallbackCache(record);
  return true;
}

export async function removeCachedAlbum(authType, folderId) {
  const key = buildAlbumCacheKey(authType, folderId);
  if (!key) return;

  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.removeItem(`${FALLBACK_PREFIX}${key}`);
    }
  } catch {
    // Ignore
  }

  const db = await openAlbumCacheDb();
  if (!db) return;
  await new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).delete(key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    } catch {
      resolve();
    }
  });
}

export async function clearAllAlbumCaches() {
  try {
    if (typeof localStorage !== 'undefined') {
      const toRemove = [];
      for (let i = 0; i < localStorage.length; i += 1) {
        const k = localStorage.key(i);
        if (k && k.startsWith(FALLBACK_PREFIX)) {
          toRemove.push(k);
        }
      }
      for (const k of toRemove) {
        localStorage.removeItem(k);
      }
    }
  } catch {
    // Ignore
  }

  const db = await openAlbumCacheDb();
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
