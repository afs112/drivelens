/**
 * Persistent local album directory & collaboration metadata cache.
 * Uses split IndexedDB storage (albumMeta + 2,000-file fileChunks) as primary storage
 * (max 12 albums) with automatic localStorage fallback (max 3 small albums <= 2,000 files).
 * Security: NEVER stores apiKey, accessToken, or clientId.
 */

const DB_NAME = 'drivelens-album-cache';
const DB_VERSION = 2;
const LEGACY_STORE_NAME = 'albums';
const META_STORE_NAME = 'albumMeta';
const CHUNK_STORE_NAME = 'fileChunks';
const CHUNK_SIZE = 2000;
const MAX_ALBUM_CACHES = 12;
const FALLBACK_PREFIX = 'drivelens_album_cache_v1_';
const MAX_FALLBACK_ENTRIES = 3;

let dbPromise = null;
const chunkIndexByAlbum = new Map();

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
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(META_STORE_NAME)) {
          const metaStore = db.createObjectStore(META_STORE_NAME, { keyPath: 'key' });
          metaStore.createIndex('savedAt', 'savedAt');
        }
        if (!db.objectStoreNames.contains(CHUNK_STORE_NAME)) {
          const chunkStore = db.createObjectStore(CHUNK_STORE_NAME, { keyPath: 'chunkKey' });
          chunkStore.createIndex('albumKey', 'albumKey');
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

function packFilesByParent(files) {
  if (!Array.isArray(files) || files.length === 0) return [];
  const byParent = new Map();
  for (let i = 0; i < files.length; i += 1) {
    const f = files[i];
    if (!f || !f.id) continue;
    const pid = f.parentId || '';
    let group = byParent.get(pid);
    if (!group) {
      group = [];
      byParent.set(pid, group);
    }
    group.push(f);
  }
  const packed = [];
  for (const group of byParent.values()) {
    for (let i = 0; i < group.length; i += 1) {
      packed.push(group[i]);
    }
  }
  return packed;
}

function splitIntoChunks(packedFiles) {
  const chunks = [];
  for (let i = 0; i < packedFiles.length; i += CHUNK_SIZE) {
    chunks.push(packedFiles.slice(i, i + CHUNK_SIZE));
  }
  return chunks;
}

function buildChunkIndex(chunks) {
  const fileToChunk = new Map();
  for (let chunkIdx = 0; chunkIdx < chunks.length; chunkIdx += 1) {
    const list = chunks[chunkIdx];
    for (let j = 0; j < list.length; j += 1) {
      const fid = list[j]?.id;
      if (fid) fileToChunk.set(fid, chunkIdx);
    }
  }
  return { chunkSize: CHUNK_SIZE, chunks, fileToChunk };
}

function sanitizeMetaPatch(metaPatch) {
  if (!metaPatch || typeof metaPatch !== 'object') return {};
  const out = {};
  if ('membersData' in metaPatch) {
    out.membersData =
      metaPatch.membersData && typeof metaPatch.membersData === 'object'
        ? metaPatch.membersData
        : {};
  }
  if ('tagSchema' in metaPatch) {
    out.tagSchema =
      metaPatch.tagSchema && typeof metaPatch.tagSchema === 'object'
        ? { version: 1, tags: metaPatch.tagSchema.tags || {} }
        : { version: 1, tags: {} };
  }
  if ('tagSchemaFileId' in metaPatch) {
    out.tagSchemaFileId = metaPatch.tagSchemaFileId || null;
  }
  if ('memberFilesById' in metaPatch) {
    out.memberFilesById =
      metaPatch.memberFilesById && typeof metaPatch.memberFilesById === 'object'
        ? metaPatch.memberFilesById
        : {};
  }
  if ('metaFolderId' in metaPatch) {
    out.metaFolderId = metaPatch.metaFolderId || null;
  }
  if ('canWrite' in metaPatch) {
    out.canWrite = Boolean(metaPatch.canWrite);
  }
  if ('localMetaSupported' in metaPatch) {
    out.localMetaSupported = Boolean(metaPatch.localMetaSupported);
  }
  if ('startPageToken' in metaPatch) {
    out.startPageToken = String(metaPatch.startPageToken || '');
  }
  if ('syncWatermark' in metaPatch) {
    out.syncWatermark = String(metaPatch.syncWatermark || '');
  }
  if ('lastFullReconcileAt' in metaPatch) {
    out.lastFullReconcileAt = Number(metaPatch.lastFullReconcileAt || 0);
  }
  if ('folders' in metaPatch && Array.isArray(metaPatch.folders)) {
    out.folders = metaPatch.folders;
  }
  if ('rootFolder' in metaPatch && metaPatch.rootFolder) {
    out.rootFolder = metaPatch.rootFolder;
  }
  return out;
}

function buildSanitizedMeta(key, authType, folderId, snapshot, chunkCount, fileCount) {
  if (!snapshot || !snapshot.rootFolder || !Array.isArray(snapshot.files)) {
    return null;
  }
  return {
    key,
    version: 2,
    authType: authType === 'oauth' ? 'oauth' : 'apikey',
    folderId: String(folderId || '').trim(),
    savedAt: Number(snapshot.savedAt || Date.now()),
    rootFolder: snapshot.rootFolder,
    folders: Array.isArray(snapshot.folders) ? snapshot.folders : [snapshot.rootFolder],
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
    chunkCount,
    fileCount,
    startPageToken: String(snapshot.startPageToken || ''),
    syncWatermark: String(snapshot.syncWatermark || ''),
    lastFullReconcileAt: Number(snapshot.lastFullReconcileAt || 0),
  };
}

function removeFallbackCacheKey(key) {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.removeItem(`${FALLBACK_PREFIX}${key}`);
    }
  } catch {
    // Ignore
  }
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
  if (!record || !Array.isArray(record.files) || record.files.length > CHUNK_SIZE) {
    if (record?.key) removeFallbackCacheKey(record.key);
    return;
  }
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

function updateExistingFallbackMeta(key, sanitizedPatch, savedAt) {
  try {
    if (typeof localStorage === 'undefined') return;
    const storageKey = `${FALLBACK_PREFIX}${key}`;
    const raw = localStorage.getItem(storageKey);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (!parsed || !parsed.rootFolder || !Array.isArray(parsed.files)) return;
    localStorage.setItem(
      storageKey,
      JSON.stringify({
        ...parsed,
        ...sanitizedPatch,
        savedAt,
      })
    );
  } catch {
    // Ignore
  }
}

function deleteChunksByAlbumInTx(chunkStore, albumKey, minChunkIdx = 0) {
  const idx = chunkStore.index('albumKey');
  idx.openCursor(IDBKeyRange.only(albumKey)).onsuccess = (ev) => {
    const cursor = ev.target.result;
    if (!cursor) return;
    if (Number(cursor.value?.chunkIdx || 0) >= minChunkIdx) {
      cursor.delete();
    }
    cursor.continue();
  };
}

function loadChunksForAlbum(db, key) {
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(CHUNK_STORE_NAME, 'readonly');
      const idx = tx.objectStore(CHUNK_STORE_NAME).index('albumKey');
      const req = idx.getAll(IDBKeyRange.only(key));
      req.onsuccess = () => {
        const records = Array.isArray(req.result) ? req.result : [];
        records.sort((a, b) => Number(a.chunkIdx || 0) - Number(b.chunkIdx || 0));
        const chunks = [];
        for (const rec of records) {
          const cIdx = Number(rec.chunkIdx || 0);
          chunks[cIdx] = Array.isArray(rec.files) ? rec.files : [];
        }
        for (let i = 0; i < chunks.length; i += 1) {
          if (!Array.isArray(chunks[i])) chunks[i] = [];
        }
        resolve(chunks);
      };
      req.onerror = () => resolve([]);
    } catch {
      resolve([]);
    }
  });
}

export async function getCachedAlbum(authType, folderId) {
  const key = buildAlbumCacheKey(authType, folderId);
  if (!key) return null;

  const db = await openAlbumCacheDb();
  if (db) {
    const hasLegacy = db.objectStoreNames.contains(LEGACY_STORE_NAME);
    const splitResult = await new Promise((resolve) => {
      try {
        const tx = db.transaction([META_STORE_NAME, CHUNK_STORE_NAME], 'readonly');
        const metaReq = tx.objectStore(META_STORE_NAME).get(key);
        const chunksReq = tx.objectStore(CHUNK_STORE_NAME).index('albumKey').getAll(IDBKeyRange.only(key));
        let meta = null;
        let chunkRecords = [];
        metaReq.onsuccess = () => {
          meta = metaReq.result || null;
        };
        chunksReq.onsuccess = () => {
          chunkRecords = Array.isArray(chunksReq.result) ? chunksReq.result : [];
        };
        tx.oncomplete = () => resolve({ meta, chunkRecords });
        tx.onerror = () => resolve(null);
        tx.onabort = () => resolve(null);
      } catch {
        resolve(null);
      }
    });

    if (splitResult?.meta && splitResult.meta.rootFolder) {
      const records = splitResult.chunkRecords.slice().sort(
        (a, b) => Number(a.chunkIdx || 0) - Number(b.chunkIdx || 0)
      );
      const chunks = [];
      const files = [];
      for (const rec of records) {
        const cIdx = Number(rec.chunkIdx || 0);
        const list = Array.isArray(rec.files) ? rec.files : [];
        chunks[cIdx] = list;
        for (let i = 0; i < list.length; i += 1) {
          files.push(list[i]);
        }
      }
      for (let i = 0; i < chunks.length; i += 1) {
        if (!Array.isArray(chunks[i])) chunks[i] = [];
      }

      const expectedCount = Number(splitResult.meta.fileCount || 0);
      if (expectedCount === 0 || files.length > 0) {
        chunkIndexByAlbum.set(key, buildChunkIndex(chunks));
        return {
          ...splitResult.meta,
          startPageToken: splitResult.meta.startPageToken || '',
          syncWatermark: splitResult.meta.syncWatermark || '',
          lastFullReconcileAt: Number(splitResult.meta.lastFullReconcileAt || 0),
          files,
        };
      }
    }

    if (hasLegacy) {
      const legacyResult = await new Promise((resolve) => {
        try {
          const tx = db.transaction(LEGACY_STORE_NAME, 'readonly');
          const req = tx.objectStore(LEGACY_STORE_NAME).get(key);
          req.onsuccess = () => resolve(req.result || null);
          req.onerror = () => resolve(null);
        } catch {
          resolve(null);
        }
      });
      if (legacyResult && legacyResult.rootFolder && Array.isArray(legacyResult.files)) {
        await setCachedAlbum(legacyResult.authType || authType, folderId, legacyResult).catch(() => {});
        return {
          startPageToken: '',
          syncWatermark: '',
          lastFullReconcileAt: 0,
          ...legacyResult,
        };
      }
    }
  }

  const fallback = readFallbackCache(key);
  if (fallback) {
    return {
      startPageToken: '',
      syncWatermark: '',
      lastFullReconcileAt: 0,
      ...fallback,
    };
  }
  return null;
}

export async function setCachedAlbum(authType, folderId, snapshot) {
  const key = buildAlbumCacheKey(authType, folderId);
  if (!key) return false;
  if (!snapshot || !snapshot.rootFolder || !Array.isArray(snapshot.files)) {
    return false;
  }

  const packed = packFilesByParent(snapshot.files);
  const chunks = splitIntoChunks(packed);
  const metaRecord = buildSanitizedMeta(
    key,
    authType,
    folderId,
    snapshot,
    chunks.length,
    packed.length
  );
  if (!metaRecord) return false;

  if (packed.length > CHUNK_SIZE) {
    removeFallbackCacheKey(key);
  }

  chunkIndexByAlbum.set(key, buildChunkIndex(chunks));

  const db = await openAlbumCacheDb();
  if (db) {
    const hasLegacy = db.objectStoreNames.contains(LEGACY_STORE_NAME);
    const storeNames = hasLegacy
      ? [META_STORE_NAME, CHUNK_STORE_NAME, LEGACY_STORE_NAME]
      : [META_STORE_NAME, CHUNK_STORE_NAME];

    const ok = await new Promise((resolve) => {
      try {
        const tx = db.transaction(storeNames, 'readwrite');
        const metaStore = tx.objectStore(META_STORE_NAME);
        const chunkStore = tx.objectStore(CHUNK_STORE_NAME);

        metaStore.put(metaRecord);
        for (let cIdx = 0; cIdx < chunks.length; cIdx += 1) {
          chunkStore.put({
            chunkKey: `${key}#${cIdx}`,
            albumKey: key,
            chunkIdx: cIdx,
            files: chunks[cIdx],
          });
        }
        deleteChunksByAlbumInTx(chunkStore, key, chunks.length);

        if (hasLegacy) {
          tx.objectStore(LEGACY_STORE_NAME).delete(key);
        }

        const countReq = metaStore.count();
        countReq.onsuccess = () => {
          if (countReq.result > MAX_ALBUM_CACHES) {
            const idx = metaStore.index('savedAt');
            let toDelete = countReq.result - MAX_ALBUM_CACHES;
            idx.openCursor().onsuccess = (ev) => {
              const cursor = ev.target.result;
              if (cursor && toDelete > 0) {
                const victimKey = cursor.primaryKey;
                if (victimKey !== key) {
                  cursor.delete();
                  chunkIndexByAlbum.delete(victimKey);
                  deleteChunksByAlbumInTx(chunkStore, victimKey, 0);
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

    if (ok) {
      if (packed.length <= CHUNK_SIZE && typeof localStorage !== 'undefined') {
        if (localStorage.getItem(`${FALLBACK_PREFIX}${key}`)) {
          pruneAndWriteFallbackCache({ ...metaRecord, files: packed });
        }
      }
      return true;
    }
  }

  if (packed.length <= CHUNK_SIZE) {
    pruneAndWriteFallbackCache({ ...metaRecord, files: packed });
    return true;
  }
  return false;
}

export async function saveCachedAlbumMetaOnly(authType, folderId, metaPatch) {
  const key = buildAlbumCacheKey(authType, folderId);
  if (!key) return false;
  const sanitized = sanitizeMetaPatch(metaPatch);
  const nextSavedAt =
    metaPatch && metaPatch.savedAt !== undefined
      ? Number(metaPatch.savedAt || Date.now())
      : Date.now();

  const db = await openAlbumCacheDb();
  if (!db) return false;

  const result = await new Promise((resolve) => {
    try {
      const tx = db.transaction(META_STORE_NAME, 'readwrite');
      const metaStore = tx.objectStore(META_STORE_NAME);
      const getReq = metaStore.get(key);
      let found = false;
      let fileCount = 0;

      getReq.onsuccess = () => {
        const existing = getReq.result;
        if (!existing || !existing.rootFolder) {
          found = false;
          return;
        }
        found = true;
        fileCount = Number(existing.fileCount || 0);
        const updated = {
          ...existing,
          ...sanitized,
          savedAt: nextSavedAt,
        };
        metaStore.put(updated);
      };

      tx.oncomplete = () => resolve({ ok: found, fileCount });
      tx.onerror = () => resolve({ ok: false, fileCount: 0 });
      tx.onabort = () => resolve({ ok: false, fileCount: 0 });
    } catch {
      resolve({ ok: false, fileCount: 0 });
    }
  });

  if (!result.ok) return false;

  if (result.fileCount <= CHUNK_SIZE) {
    updateExistingFallbackMeta(key, sanitized, nextSavedAt);
  } else {
    removeFallbackCacheKey(key);
  }
  return true;
}

export async function applyCachedAlbumDelta(
  authType,
  folderId,
  { upsertedFiles = [], removedFileIds = [], metaPatch = null } = {}
) {
  const key = buildAlbumCacheKey(authType, folderId);
  if (!key) return false;

  const db = await openAlbumCacheDb();
  if (!db) return false;

  const existingMeta = await new Promise((resolve) => {
    try {
      const tx = db.transaction(META_STORE_NAME, 'readonly');
      const req = tx.objectStore(META_STORE_NAME).get(key);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  if (!existingMeta || !existingMeta.rootFolder) return false;

  let indexEntry = chunkIndexByAlbum.get(key);
  if (!indexEntry) {
    const loadedChunks = await loadChunksForAlbum(db, key);
    indexEntry = buildChunkIndex(loadedChunks);
    chunkIndexByAlbum.set(key, indexEntry);
  }

  let chunks = indexEntry.chunks.map((c) => c.slice());
  const fileToChunk = new Map(indexEntry.fileToChunk);
  const dirtyChunks = new Set();

  const upsertMap = new Map();
  for (const f of upsertedFiles || []) {
    if (f && f.id) upsertMap.set(f.id, f);
  }

  const idsToRemove = new Set(removedFileIds || []);
  for (const id of upsertMap.keys()) {
    idsToRemove.add(id);
  }

  const removalsByChunk = new Map();
  for (const id of idsToRemove) {
    const cIdx = fileToChunk.get(id);
    if (cIdx !== undefined) {
      let set = removalsByChunk.get(cIdx);
      if (!set) {
        set = new Set();
        removalsByChunk.set(cIdx, set);
      }
      set.add(id);
      fileToChunk.delete(id);
    }
  }

  for (const [cIdx, removeSet] of removalsByChunk.entries()) {
    if (chunks[cIdx]) {
      chunks[cIdx] = chunks[cIdx].filter((f) => !removeSet.has(f.id));
      dirtyChunks.add(cIdx);
    }
  }

  const packedUpserts = packFilesByParent(Array.from(upsertMap.values()));
  for (let i = 0; i < packedUpserts.length; i += 1) {
    const f = packedUpserts[i];
    let tailIdx = chunks.length - 1;
    if (tailIdx < 0 || chunks[tailIdx].length >= CHUNK_SIZE) {
      chunks.push([]);
      tailIdx = chunks.length - 1;
    }
    chunks[tailIdx].push(f);
    fileToChunk.set(f.id, tailIdx);
    dirtyChunks.add(tailIdx);
  }

  while (chunks.length > 0 && chunks[chunks.length - 1].length === 0) {
    chunks.pop();
  }

  let nonTailFiles = 0;
  for (let i = 0; i < chunks.length - 1; i += 1) {
    nonTailFiles += chunks[i].length;
  }
  const nonTailCapacity = Math.max(0, (chunks.length - 1) * CHUNK_SIZE);
  const emptyHoles = nonTailCapacity - nonTailFiles;
  const totalCapacity = chunks.length * CHUNK_SIZE;
  let repacked = false;

  if (chunks.length > 1 && totalCapacity > 0 && emptyHoles > totalCapacity * 0.3) {
    const flat = [];
    for (let i = 0; i < chunks.length; i += 1) {
      for (let j = 0; j < chunks[i].length; j += 1) {
        flat.push(chunks[i][j]);
      }
    }
    chunks = splitIntoChunks(packFilesByParent(flat));
    dirtyChunks.clear();
    for (let i = 0; i < chunks.length; i += 1) {
      dirtyChunks.add(i);
    }
    repacked = true;
  }

  let totalFiles = 0;
  for (let i = 0; i < chunks.length; i += 1) {
    totalFiles += chunks[i].length;
  }

  const nextIndex = repacked
    ? buildChunkIndex(chunks)
    : { chunkSize: CHUNK_SIZE, chunks, fileToChunk };
  chunkIndexByAlbum.set(key, nextIndex);

  const sanitizedPatch = sanitizeMetaPatch(metaPatch);
  const nextSavedAt = Date.now();
  const updatedMeta = {
    ...existingMeta,
    ...sanitizedPatch,
    chunkCount: chunks.length,
    fileCount: totalFiles,
    savedAt: nextSavedAt,
  };

  if (totalFiles > CHUNK_SIZE) {
    removeFallbackCacheKey(key);
  } else if (typeof localStorage !== 'undefined' && localStorage.getItem(`${FALLBACK_PREFIX}${key}`)) {
    const allFiles = [];
    for (let i = 0; i < chunks.length; i += 1) {
      for (let j = 0; j < chunks[i].length; j += 1) {
        allFiles.push(chunks[i][j]);
      }
    }
    pruneAndWriteFallbackCache({ ...updatedMeta, files: allFiles });
  }

  return new Promise((resolve) => {
    try {
      const tx = db.transaction([META_STORE_NAME, CHUNK_STORE_NAME], 'readwrite');
      const metaStore = tx.objectStore(META_STORE_NAME);
      const chunkStore = tx.objectStore(CHUNK_STORE_NAME);

      metaStore.put(updatedMeta);
      for (const cIdx of dirtyChunks) {
        if (cIdx < chunks.length) {
          chunkStore.put({
            chunkKey: `${key}#${cIdx}`,
            albumKey: key,
            chunkIdx: cIdx,
            files: chunks[cIdx],
          });
        }
      }
      if (repacked || chunks.length < Number(existingMeta.chunkCount || 0)) {
        deleteChunksByAlbumInTx(chunkStore, key, chunks.length);
      }

      tx.oncomplete = () => resolve(true);
      tx.onerror = () => resolve(false);
      tx.onabort = () => resolve(false);
    } catch {
      resolve(false);
    }
  });
}

export async function patchCachedThumbnailLinks(authType, folderId, patches) {
  const key = buildAlbumCacheKey(authType, folderId);
  if (!key || !patches) return false;

  const rawEntries =
    patches instanceof Map
      ? Array.from(patches.entries())
      : typeof patches === 'object'
        ? Object.entries(patches)
        : [];
  if (rawEntries.length === 0) return true;

  const db = await openAlbumCacheDb();
  if (!db) return false;

  let indexEntry = chunkIndexByAlbum.get(key);
  if (!indexEntry) {
    const loadedChunks = await loadChunksForAlbum(db, key);
    if (loadedChunks.length === 0) return false;
    indexEntry = buildChunkIndex(loadedChunks);
    chunkIndexByAlbum.set(key, indexEntry);
  }

  const patchesByChunk = new Map();
  for (let i = 0; i < rawEntries.length; i += 1) {
    const [fileId, val] = rawEntries[i];
    if (!fileId) continue;
    const cIdx = indexEntry.fileToChunk.get(fileId);
    if (cIdx === undefined) continue;
    const link = typeof val === 'string' ? val : val?.thumbnailLink || '';
    if (!link) continue;
    const fetchedAt =
      typeof val === 'object' && val !== null
        ? Number(val.thumbFetchedAt || Date.now())
        : Date.now();
    let chunkMap = patchesByChunk.get(cIdx);
    if (!chunkMap) {
      chunkMap = new Map();
      patchesByChunk.set(cIdx, chunkMap);
    }
    chunkMap.set(fileId, { thumbnailLink: link, thumbFetchedAt: fetchedAt });
  }

  if (patchesByChunk.size === 0) return true;

  const dirtyChunkIdxs = [];
  for (const [cIdx, filePatchMap] of patchesByChunk.entries()) {
    const list = indexEntry.chunks[cIdx];
    if (!Array.isArray(list)) continue;
    let modified = false;
    for (let i = 0; i < list.length; i += 1) {
      const f = list[i];
      const patch = f ? filePatchMap.get(f.id) : null;
      if (patch) {
        f.thumbnailLink = patch.thumbnailLink;
        f.thumbFetchedAt = patch.thumbFetchedAt;
        modified = true;
      }
    }
    if (modified) dirtyChunkIdxs.push(cIdx);
  }

  if (dirtyChunkIdxs.length === 0) return true;

  return new Promise((resolve) => {
    try {
      const tx = db.transaction(CHUNK_STORE_NAME, 'readwrite');
      const chunkStore = tx.objectStore(CHUNK_STORE_NAME);
      for (let i = 0; i < dirtyChunkIdxs.length; i += 1) {
        const cIdx = dirtyChunkIdxs[i];
        chunkStore.put({
          chunkKey: `${key}#${cIdx}`,
          albumKey: key,
          chunkIdx: cIdx,
          files: indexEntry.chunks[cIdx],
        });
      }
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => resolve(false);
      tx.onabort = () => resolve(false);
    } catch {
      resolve(false);
    }
  });
}

export async function removeCachedAlbum(authType, folderId) {
  const key = buildAlbumCacheKey(authType, folderId);
  if (!key) return;

  chunkIndexByAlbum.delete(key);
  removeFallbackCacheKey(key);

  const db = await openAlbumCacheDb();
  if (!db) return;
  const hasLegacy = db.objectStoreNames.contains(LEGACY_STORE_NAME);
  const storeNames = hasLegacy
    ? [META_STORE_NAME, CHUNK_STORE_NAME, LEGACY_STORE_NAME]
    : [META_STORE_NAME, CHUNK_STORE_NAME];

  await new Promise((resolve) => {
    try {
      const tx = db.transaction(storeNames, 'readwrite');
      tx.objectStore(META_STORE_NAME).delete(key);
      deleteChunksByAlbumInTx(tx.objectStore(CHUNK_STORE_NAME), key, 0);
      if (hasLegacy) {
        tx.objectStore(LEGACY_STORE_NAME).delete(key);
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    } catch {
      resolve();
    }
  });
}

export async function clearAllAlbumCaches() {
  chunkIndexByAlbum.clear();
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
  const hasLegacy = db.objectStoreNames.contains(LEGACY_STORE_NAME);
  const storeNames = hasLegacy
    ? [META_STORE_NAME, CHUNK_STORE_NAME, LEGACY_STORE_NAME]
    : [META_STORE_NAME, CHUNK_STORE_NAME];

  await new Promise((resolve) => {
    try {
      const tx = db.transaction(storeNames, 'readwrite');
      tx.objectStore(META_STORE_NAME).clear();
      tx.objectStore(CHUNK_STORE_NAME).clear();
      if (hasLegacy) {
        tx.objectStore(LEGACY_STORE_NAME).clear();
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    } catch {
      resolve();
    }
  });
}
