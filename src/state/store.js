import { APP_CONFIG } from '../constants.js';
import { getLang, getLocaleTag, setLangCode, t } from '../i18n.js';
import {
  createDemoDataset,
  getDemoPersonas,
  localizeDemoState,
  resetDemoState,
  saveDemoState,
} from '../demo/demoAlbum.js';
import {
  authenticateGoogle,
  buildDriveWebViewLink,
  clearSession,
  consumeOAuthRedirectCallback,
  getCachedSession,
  getSavedOAuthUser,
  hasStoredRenewalTicket,
  loadSharedAlbum,
  loadSharedAlbumWithApiKey,
  normalizeRenewalEndpoint,
  parseDriveFolderId,
  renewOAuthSessionSilently,
  startOAuthRedirectFlow,
  syncAlbumIncremental,
} from '../api/gdrive.js';
import {
  loadAlbumMetadata,
  loadLocalServerMeta,
  mergeTagSchemas,
  sanitizeMemberKey,
  saveLocalServerMeta,
  saveMemberMetadata,
  saveTagSchema,
} from '../api/metaSync.js';

import {
  applyCachedAlbumDelta,
  clearAllAlbumCaches,
  getCachedAlbum,
  patchCachedThumbnailLinks,
  saveCachedAlbumMetaOnly,
  setCachedAlbum,
} from '../storage/albumCache.js';
import { clearImageCache, setThumbnailLinkHealedCallback } from '../storage/imageLoader.js';

const THEME_KEY = 'drivelens_theme';
const RECENT_KEY = 'drivelens_recent_v1';
const SETTINGS_KEY = 'drivelens_connect_prefs_v1';
const UI_PREFS_KEY = 'drivelens_ui_prefs_v1';
const VALID_LAYOUT_MODES = ['justified', 'waterfall', 'grid'];
const VALID_SORT_MODES = [
  'dateDesc',
  'dateAsc',
  'ratingDesc',
  'ratingAsc',
  'nameAsc',
  'nameDesc',
  'sizeDesc',
  'sizeAsc',
];

const MEMBER_COLORS = [
  '#38bdf8',
  '#f472b6',
  '#34d399',
  '#fbbf24',
  '#a78bfa',
  '#fb7185',
  '#22d3ee',
  '#60a5fa',
];

function pickMemberColor(seed) {
  let hash = 0;
  const s = String(seed || 'user');
  for (let i = 0; i < s.length; i += 1) {
    hash = (hash * 31 + s.charCodeAt(i)) | 0;
  }
  return MEMBER_COLORS[Math.abs(hash) % MEMBER_COLORS.length];
}

const TAG_COLOR_DEFS = [
  { id: 'red', hex: '#f87171' },
  { id: 'amber', hex: '#fbbf24' },
  { id: 'emerald', hex: '#34d399' },
  { id: 'cyan', hex: '#22d3ee' },
  { id: 'blue', hex: '#60a5fa' },
  { id: 'violet', hex: '#a78bfa' },
  { id: 'pink', hex: '#f472b6' },
  { id: 'slate', hex: '#94a3b8' },
];

export function getTagColors() {
  return TAG_COLOR_DEFS.map((c) => ({
    id: c.id,
    label: t(`color.${c.id}`),
    hex: c.hex,
  }));
}

export const TAG_COLORS = TAG_COLOR_DEFS.map((c) => ({
  id: c.id,
  label: t(`color.${c.id}`),
  hex: c.hex,
}));

function getInitialTheme() {
  try {
    const saved = localStorage.getItem(THEME_KEY);
    if (saved === 'light' || saved === 'dark') return saved;
  } catch {
    // Ignore
  }
  return 'dark';
}

function loadRecentAlbums() {
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

export function loadConnectPrefs() {
  const defaultAuthType =
    APP_CONFIG.DEFAULT_CLIENT_ID && !APP_CONFIG.DEFAULT_API_KEY ? 'oauth' : 'apikey';
  const defaultNick = t('store.defaultNickname');
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    return {
      authType: parsed.authType || defaultAuthType,
      apiKey: parsed.apiKey || APP_CONFIG.DEFAULT_API_KEY || '',
      clientId: parsed.clientId || APP_CONFIG.DEFAULT_CLIENT_ID || '',
      folderId: parsed.folderId || APP_CONFIG.DEFAULT_FOLDER_ID || '',
      tokenRenewalUrl: normalizeRenewalEndpoint(parsed.tokenRenewalUrl || ''),
      nickname: parsed.nickname || defaultNick,
      rememberCredentials: parsed.rememberCredentials !== false,
      autoConnect: Boolean(parsed.autoConnect),
    };
  } catch {
    return {
      authType: defaultAuthType,
      apiKey: APP_CONFIG.DEFAULT_API_KEY || '',
      clientId: APP_CONFIG.DEFAULT_CLIENT_ID || '',
      folderId: APP_CONFIG.DEFAULT_FOLDER_ID || '',
      tokenRenewalUrl: '',
      nickname: defaultNick,
      rememberCredentials: true,
      autoConnect: false,
    };
  }
}

function saveConnectPrefs(patch) {
  try {
    const prev = loadConnectPrefs();
    const next = { ...prev, ...patch };
    if ('tokenRenewalUrl' in next) {
      next.tokenRenewalUrl = normalizeRenewalEndpoint(next.tokenRenewalUrl || '');
    }
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
  } catch {
    // Ignore
  }
}

function loadUiPrefs() {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(UI_PREFS_KEY) : null;
    const parsed = raw ? JSON.parse(raw) : {};
    const layoutMode = VALID_LAYOUT_MODES.includes(parsed?.layoutMode)
      ? parsed.layoutMode
      : 'waterfall';
    const rawHeight = Number(parsed?.rowHeight || 210);
    const rowHeight = Number.isFinite(rawHeight)
      ? Math.max(130, Math.min(320, Math.round(rawHeight)))
      : 210;
    const sortBy = VALID_SORT_MODES.includes(parsed?.sortBy) ? parsed.sortBy : 'dateDesc';
    const includeSubfolders = parsed?.includeSubfolders !== false;
    return { layoutMode, rowHeight, sortBy, includeSubfolders };
  } catch {
    return {
      layoutMode: 'waterfall',
      rowHeight: 210,
      sortBy: 'dateDesc',
      includeSubfolders: true,
    };
  }
}

function saveUiPrefs(patch) {
  try {
    if (typeof localStorage === 'undefined') return;
    const prev = loadUiPrefs();
    localStorage.setItem(UI_PREFS_KEY, JSON.stringify({ ...prev, ...patch }));
  } catch {
    // Ignore
  }
}

const photoTimestampCache = new WeakMap();
const collatorCache = new Map();
const EMPTY_ARRAY = Object.freeze([]);
const EMPTY_META = Object.freeze({
  myRating: 0,
  myFavorite: false,
  myNote: '',
  avgRating: 0,
  ratingCount: 0,
  favoriteCount: 0,
  ratingsByMember: EMPTY_ARRAY,
  notesByMember: EMPTY_ARRAY,
  activeTagIds: EMPTY_ARRAY,
});
const UI_ONLY_STATE_KEYS = new Set([
  'sidebarOpen',
  'inspectorOpen',
  'modal',
  'toasts',
  'rowHeight',
  'theme',
  'lightboxPhotoId',
  'lightboxZoom',
  'canInstallPwa',
  'syncStatus',
  'syncMessageKey',
  'syncMessage',
  'loadingText',
  'backgroundRefreshing',
]);
const SELECTION_ONLY_STATE_KEYS = new Set([
  'selectedPhotoIds',
  'lastClickedPhotoId',
  'focusedPhotoId',
]);

function getNameCollator(locale) {
  let col = collatorCache.get(locale);
  if (!col) {
    col = new Intl.Collator(locale, { numeric: true, sensitivity: 'base' });
    collatorCache.set(locale, col);
  }
  return col;
}

function normalizeAspectRatio(file) {
  const w = Number(file?.imageMediaMetadata?.width || file?.videoMediaMetadata?.width || 0);
  const h = Number(file?.imageMediaMetadata?.height || file?.videoMediaMetadata?.height || 0);
  if (w > 0 && h > 0) {
    return Math.max(0.45, Math.min(2.6, w / h));
  }
  return 1.5;
}

function parseDateString(raw) {
  if (!raw) return 0;
  const normalized = /^\d{4}:\d{2}:\d{2}\s/.test(raw)
    ? raw.replace(/^(\d{4}):(\d{2}):(\d{2})\s/, '$1-$2-$3T')
    : raw;
  const parsed = Date.parse(normalized);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function parseFilenameTimestamp(name) {
  if (!name) return 0;
  const s = String(name);
  const sepMatch = s.match(
    /(?:^|\D)(199\d|20[0-4]\d)[-_.](0[1-9]|1[0-2])[-_.](0[1-9]|[12]\d|3[01])(?:[T _-]+([01]\d|2[0-3])[-_.:]([0-5]\d)(?:[-_.:]([0-5]\d))?)?(?:\D|$)/
  );
  if (sepMatch) {
    const [, y, mo, d, hh = '12', mm = '00', ss = '00'] = sepMatch;
    const ts = Date.parse(`${y}-${mo}-${d}T${hh}:${mm}:${ss}`);
    if (!Number.isNaN(ts)) return ts;
  }
  const compactMatch = s.match(
    /(?:^|\D)(199\d|20[0-4]\d)(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])(?:[_-]?([01]\d|2[0-3])([0-5]\d)([0-5]\d))?(?:\D|$)/
  );
  if (compactMatch) {
    const [, y, mo, d, hh = '12', mm = '00', ss = '00'] = compactMatch;
    const ts = Date.parse(`${y}-${mo}-${d}T${hh}:${mm}:${ss}`);
    if (!Number.isNaN(ts)) return ts;
  }
  const msMatch = s.match(/(?:mmexport|wx_camera_|Screenshot_)(\d{13})(?:\D|$)/i);
  if (msMatch) {
    const ms = Number(msMatch[1]);
    if (ms >= 1262304000000 && ms <= 2524608000000) return ms;
  }
  return 0;
}

export function resolvePhotoTimestamp(file) {
  if (!file || typeof file !== 'object') return 0;
  if (typeof file._ts === 'number') return file._ts;
  const key = `${file.imageMediaMetadata?.time || ''}|${file.name || ''}|${file.modifiedTime || ''}|${file.createdTime || ''}`;
  const cached = photoTimestampCache.get(file);
  if (cached && cached.key === key) return cached.ts;

  let ts = parseDateString(file.imageMediaMetadata?.time);
  if (!ts) {
    ts = parseFilenameTimestamp(file.name);
  }
  if (!ts) {
    const modTs = parseDateString(file.modifiedTime);
    const creTs = parseDateString(file.createdTime);
    if (modTs && creTs) ts = Math.min(modTs, creTs);
    else ts = modTs || creTs;
  }

  photoTimestampCache.set(file, { key, ts });
  return ts;
}

function getPhotoTimestamp(file) {
  return resolvePhotoTimestamp(file);
}

export class Store {
  constructor() {
    this.listeners = new Set();
    this.memberSyncTimer = null;
    this.schemaSyncTimer = null;
    this.cacheSnapshotTimer = null;
    this.connectSeq = 0;
    this.toastCounter = 0;
    this.deferredInstallPrompt = null;
    this._aggMetaCache = new Map();
    this._aggMetaRefs = null;
    this._visiblePhotosCache = null;
    this._fileById = new Map();
    this._itemsByPhotoId = new Map();
    this._itemsByPhotoIdRef = null;
    this._libraryStatsCache = null;
    this.visiblePhotosVersion = 0;
    this._changeSeq = 0;
    this.lastChange = { type: 'full', photoIds: null, seq: 0 };
    this._startPageToken = '';
    this._syncWatermark = '';
    this._lastFullReconcileAt = 0;
    this._unsyncedPhotoIds = new Set();
    this._unsyncedSchemaDirty = false;
    this._sessionExpiresAt = 0;
    this._sessionTimer = 0;
    this._silentRenewalExhausted = false;

    const initialLang = setLangCode(getLang());
    const prefs = loadConnectPrefs();
    const uiPrefs = loadUiPrefs();
    const initialPersonas = getDemoPersonas(initialLang);

    this.state = {
      lang: initialLang,
      mode: 'demo',
      authType: prefs.authType,
      loading: false,
      loadingText: '',
      backgroundRefreshing: false,
      cacheRestoredAt: 0,
      syncStatus: 'idle',
      syncMessageKey: 'store.syncDemo',
      syncMessage: t('store.syncDemo'),
      apiKey: prefs.apiKey,
      nickname: prefs.nickname,
      clientId: prefs.clientId,
      folderId: prefs.folderId,
      tokenRenewalUrl: prefs.tokenRenewalUrl || '',
      rememberCredentials: prefs.rememberCredentials,
      savedOAuthUser: getSavedOAuthUser(prefs.clientId),
      canInstallPwa: false,
      localMetaSupported: false,
      accessToken: '',
      currentUser: { ...initialPersonas[0] },
      rootFolder: null,
      folders: [],
      files: [],
      metaFolderId: null,
      canWrite: true,
      tagSchemaFileId: null,
      tagSchema: { version: 1, tags: {} },
      memberFilesById: {},
      membersData: {},

      // Navigation & Filters
      activeFolderId: null,
      includeSubfolders: uiPrefs.includeSubfolders,
      searchQuery: '',
      quickView: 'all',
      mediaFilter: 'all',
      aspectFilter: 'all',
      ratingScope: 'avg',
      minRating: 0,
      memberFilterId: null,
      selectedTagIds: new Set(),
      tagMatchMode: 'OR',
      sortBy: uiPrefs.sortBy,

      // UI State
      layoutMode: uiPrefs.layoutMode,
      rowHeight: uiPrefs.rowHeight,
      selectedPhotoIds: new Set(),
      lastClickedPhotoId: null,
      focusedPhotoId: null,
      lightboxPhotoId: null,
      lightboxZoom: 1,
      inspectorOpen: false,
      sidebarOpen: false,
      theme: getInitialTheme(),
      recentAlbums: loadRecentAlbums(),
      modal: null,
      toasts: [],
    };

    if (typeof document !== 'undefined') {
      document.documentElement.setAttribute('data-theme', this.state.theme);
      if (typeof document.addEventListener === 'function') {
        this._onVisibilityChange = () => {
          if (document.visibilityState === 'visible') {
            this._checkOrRenewSession().catch(() => {});
          }
        };
        document.addEventListener('visibilitychange', this._onVisibilityChange, { passive: true });
      }
    }
    setThumbnailLinkHealedCallback(({ patches }) => {
      if (!patches || !(patches instanceof Map) || patches.size === 0) return;
      for (const [fileId, info] of patches.entries()) {
        const file = this._fileById.get(fileId);
        if (file && info) {
          if (typeof info === 'string') {
            file.thumbnailLink = info;
            file.thumbFetchedAt = Date.now();
          } else if (info.thumbnailLink) {
            file.thumbnailLink = info.thumbnailLink;
            file.thumbFetchedAt = Number(info.thumbFetchedAt || Date.now());
          }
        }
      }
      if (this.state.mode === 'gdrive' && this.state.folderId) {
        const authType = this.state.authType === 'oauth' ? 'oauth' : 'apikey';
        patchCachedThumbnailLinks(authType, this.state.folderId, patches).catch(() => {});
      }
    });
    this.loadDemoMode(false);
  }

  _normalizeFileRecord(f) {
    if (!f || typeof f !== 'object') return f;
    if (typeof f._ts !== 'number') {
      f._ts = resolvePhotoTimestamp(f);
    }
    if (typeof f._aspect !== 'number') {
      f._aspect = normalizeAspectRatio(f);
    }
    if (typeof f._isVideo !== 'boolean') {
      f._isVideo = Boolean(f.mimeType && f.mimeType.startsWith('video/'));
    }
    if (!f.webViewLink && !f.isDemo && f.id) {
      f.webViewLink = buildDriveWebViewLink(f.id);
    }
    return f;
  }

  _rebuildFileIndex(files) {
    const map = new Map();
    const list = Array.isArray(files) ? files : [];
    for (let i = 0; i < list.length; i += 1) {
      const f = this._normalizeFileRecord(list[i]);
      if (f && f.id) {
        map.set(f.id, f);
      }
    }
    this._fileById = map;
    this._libraryStatsCache = null;
  }

  getFileById(id) {
    if (!id) return null;
    return this._fileById.get(id) || null;
  }

  _rebuildItemsByPhotoId(membersData) {
    const map = new Map();
    const entries = Object.entries(membersData || {});
    for (let m = 0; m < entries.length; m += 1) {
      const [memberId, record] = entries[m];
      const items = record?.items;
      if (!items || typeof items !== 'object') continue;
      const itemEntries = Object.entries(items);
      for (let i = 0; i < itemEntries.length; i += 1) {
        const [photoId, item] = itemEntries[i];
        if (!item || typeof item !== 'object') continue;
        let perPhoto = map.get(photoId);
        if (!perPhoto) {
          perPhoto = new Map();
          map.set(photoId, perPhoto);
        }
        perPhoto.set(memberId, item);
      }
    }
    this._itemsByPhotoId = map;
    this._itemsByPhotoIdRef = membersData;
    this._libraryStatsCache = null;
  }

  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit() {
    for (const fn of this.listeners) {
      fn(this.state, this.lastChange);
    }
  }

  setState(patch, changeInfo = null) {
    const prevFiles = this.state?.files;
    this.state = { ...this.state, ...patch };
    if (Object.prototype.hasOwnProperty.call(patch, 'files')) {
      const nextFiles = this.state.files;
      const skipRebuild = Boolean(changeInfo && changeInfo._skipFileIndexRebuild);
      if (
        !skipRebuild &&
        (nextFiles !== prevFiles ||
          (Array.isArray(nextFiles) && nextFiles.length !== this._fileById.size))
      ) {
        this._rebuildFileIndex(nextFiles);
      }
    }

    let type = changeInfo?.type || null;
    if (!type) {
      const keys = Object.keys(patch || {});
      if (keys.length > 0 && keys.every((k) => UI_ONLY_STATE_KEYS.has(k))) {
        type = 'ui-only';
      } else if (keys.length > 0 && keys.every((k) => SELECTION_ONLY_STATE_KEYS.has(k))) {
        type = 'selection-only';
      } else {
        type = 'full';
      }
    }
    this.lastChange = {
      type,
      photoIds: changeInfo?.photoIds || null,
      seq: ++this._changeSeq,
    };
    this.emit();
  }

  _resolveSyncMessageKey(s) {
    if (s.syncMessageKey) return s.syncMessageKey;
    if (s.mode === 'demo') return 'store.syncDemo';
    if (s.syncStatus === 'syncing') return 'store.syncSavingRatings';
    if (s.syncStatus === 'error') {
      return s.authType === 'apikey' ? 'store.syncErrorLocal' : 'store.syncErrorAuth';
    }
    if (s.authType === 'apikey') {
      return s.localMetaSupported ? 'store.syncApiKeySynced' : 'store.syncApiKeyLocal';
    }
    if (!s.canWrite) return 'store.syncReadonly';
    return 'store.syncOAuthSynced';
  }

  setLanguage(nextLang) {
    const prevDefaultNick = t('store.defaultNickname');
    const prevGuestNick = t('store.guestNickname');
    const lang = setLangCode(nextLang);
    const nextDefaultNick = t('store.defaultNickname');

    const currentNick = String(this.state.nickname || '').trim();
    const shouldUpdateNick =
      !currentNick || currentNick === prevDefaultNick || currentNick === prevGuestNick;
    const nextNickname = shouldUpdateNick ? nextDefaultNick : this.state.nickname;

    if (shouldUpdateNick) {
      try {
        const raw = localStorage.getItem(SETTINGS_KEY);
        if (raw) {
          const parsed = JSON.parse(raw);
          if (parsed && (!parsed.nickname || parsed.nickname === prevDefaultNick)) {
            saveConnectPrefs({ nickname: nextDefaultNick });
          }
        }
      } catch {
        // Ignore
      }
    }

    let nextPatch = {
      lang,
      nickname: nextNickname,
    };

    if (this.state.mode === 'demo') {
      const localized = localizeDemoState(this.state, lang);
      for (const f of localized.files || []) {
        if (f && typeof f === 'object') delete f._searchHaystack;
      }
      nextPatch = {
        ...nextPatch,
        rootFolder: localized.rootFolder,
        folders: localized.folders,
        files: localized.files,
        tagSchema: localized.tagSchema,
        membersData: localized.membersData,
        currentUser: localized.currentUser,
      };
      saveDemoState({
        tagSchema: localized.tagSchema,
        membersData: localized.membersData,
        activePersonaId: localized.currentUser?.id || 'me',
      });
    }

    const msgKey = this._resolveSyncMessageKey({ ...this.state, ...nextPatch });
    nextPatch.syncMessageKey = msgKey;
    nextPatch.syncMessage = t(msgKey);

    this.setState(nextPatch);
  }

  toast(message, type = 'info', duration = 3200) {
    const id = ++this.toastCounter;
    this.setState({
      toasts: [...this.state.toasts, { id, type, message }],
    });
    setTimeout(() => {
      this.setState({
        toasts: this.state.toasts.filter((item) => item.id !== id),
      });
    }, duration);
  }

  setInstallPrompt(event) {
    this.deferredInstallPrompt = event || null;
    this.setState({ canInstallPwa: Boolean(event) });
  }

  async promptInstallPwa() {
    const promptEvent = this.deferredInstallPrompt;
    if (!promptEvent || typeof promptEvent.prompt !== 'function') {
      return false;
    }
    try {
      await promptEvent.prompt();
      const choice = await promptEvent.userChoice;
      if (choice?.outcome === 'accepted') {
        this.deferredInstallPrompt = null;
        this.setState({ canInstallPwa: false });
        return true;
      }
      return false;
    } catch {
      return false;
    }
  }

  onAppInstalled() {
    this.deferredInstallPrompt = null;
    this.setState({ canInstallPwa: false });
    this.toast(t('store.appInstalledToast'), 'success');
  }

  _resetUnsyncedTracking() {
    clearTimeout(this.memberSyncTimer);
    clearTimeout(this.schemaSyncTimer);
    this.memberSyncTimer = null;
    this.schemaSyncTimer = null;
    this._unsyncedPhotoIds.clear();
    this._unsyncedSchemaDirty = false;
  }

  _clearSessionLifecycle() {
    if (this._sessionTimer) {
      clearTimeout(this._sessionTimer);
      this._sessionTimer = 0;
    }
    this._sessionExpiresAt = 0;
  }

  _scheduleSessionLifecycle(expiresAt) {
    if (this._sessionTimer) {
      clearTimeout(this._sessionTimer);
      this._sessionTimer = 0;
    }
    const exp = Number(expiresAt || 0);
    this._sessionExpiresAt = exp;
    if (!exp || this.state.authType !== 'oauth') {
      return;
    }
    const delayMs = Math.min(2147483647, Math.max(1000, exp - Date.now() - 5 * 60 * 1000));
    this._sessionTimer = setTimeout(() => {
      this._sessionTimer = 0;
      this._checkOrRenewSession().catch(() => {});
    }, delayMs);
  }

  async _checkOrRenewSession() {
    if (this.state.mode !== 'gdrive' || this.state.authType !== 'oauth') {
      return false;
    }
    if (!this._sessionExpiresAt) {
      return false;
    }
    if (Date.now() < this._sessionExpiresAt - 5 * 60 * 1000) {
      if (!this._sessionTimer) {
        this._scheduleSessionLifecycle(this._sessionExpiresAt);
      }
      return false;
    }

    if (this.state.tokenRenewalUrl && this.state.clientId) {
      const renewed = await renewOAuthSessionSilently(
        this.state.clientId,
        this.state.tokenRenewalUrl,
        { remember: this.state.rememberCredentials }
      );
      if (this.state.mode !== 'gdrive' || this.state.authType !== 'oauth') {
        return false;
      }
      if (renewed?.accessToken) {
        this._silentRenewalExhausted = false;
        this.setState(
          {
            accessToken: renewed.accessToken,
            ...(renewed.user ? { currentUser: renewed.user } : {}),
          },
          { type: 'ui-only' }
        );
        this._scheduleSessionLifecycle(renewed.expiresAt);
        if (this._unsyncedPhotoIds.size > 0) {
          await this._flushMemberSync();
        }
        if (this._unsyncedSchemaDirty) {
          await this._flushSchemaSync();
        }
        return true;
      }
      this._silentRenewalExhausted = true;
    }

    if (Date.now() >= this._sessionExpiresAt - 30_000) {
      const hasPending = this._unsyncedPhotoIds.size > 0 || this._unsyncedSchemaDirty;
      if (this.state.accessToken) {
        this.setState(
          {
            accessToken: '',
            syncStatus: hasPending ? 'error' : 'readonly',
            syncMessageKey: 'store.syncCachedSessionExpired',
            syncMessage: t('store.syncCachedSessionExpired'),
          },
          { type: 'ui-only' }
        );
      }
      this._clearSessionLifecycle();
      return false;
    }

    if (!this._sessionTimer && this._sessionExpiresAt > 0) {
      const untilBoundary = Math.max(1000, this._sessionExpiresAt - 30_000 - Date.now());
      const retryDelay = this.state.tokenRenewalUrl
        ? Math.min(60_000, untilBoundary)
        : untilBoundary;
      this._sessionTimer = setTimeout(() => {
        this._sessionTimer = 0;
        this._checkOrRenewSession().catch(() => {});
      }, retryDelay);
    }
    return false;
  }

  loadDemoMode(showNotice = true, disableAutoConnect = false) {
    const wasGdrive = this.state?.mode === 'gdrive';
    this.connectSeq += 1;
    clearTimeout(this.cacheSnapshotTimer);
    this._clearSessionLifecycle();
    this._resetUnsyncedTracking();
    if (disableAutoConnect) {
      saveConnectPrefs({ autoConnect: false });
    }
    if (wasGdrive) {
      this._clearUrlHash();
    }
    const lang = this.state?.lang || getLang();
    const demo = createDemoDataset(lang);
    const personas = getDemoPersonas(lang);
    const persona =
      personas.find((p) => p.id === demo.activePersonaId) || personas[0];
    const firstPhoto = demo.files[0]?.id || null;

    this._startPageToken = '';
    this._syncWatermark = '';
    this._lastFullReconcileAt = 0;

    this.setState({
      mode: 'demo',
      localMetaSupported: false,
      loading: false,
      loadingText: '',
      backgroundRefreshing: false,
      cacheRestoredAt: 0,
      syncStatus: 'idle',
      syncMessageKey: 'store.syncDemo',
      syncMessage: t('store.syncDemo'),
      rootFolder: demo.rootFolder,
      folders: demo.folders,
      files: demo.files,
      metaFolderId: null,
      canWrite: true,
      tagSchemaFileId: null,
      tagSchema: demo.tagSchema,
      memberFilesById: {},
      membersData: demo.membersData,
      currentUser: { ...persona },
      activeFolderId: demo.rootFolder.id,
      selectedPhotoIds: new Set(),
      lastClickedPhotoId: null,
      focusedPhotoId: firstPhoto,
      lightboxPhotoId: null,
      quickView: 'all',
      mediaFilter: 'all',
      aspectFilter: 'all',
      minRating: 0,
      memberFilterId: null,
      ratingScope: 'avg',
      selectedTagIds: new Set(),
      searchQuery: '',
    });

    if (showNotice) {
      this.toast(t('store.switchedToDemoToast'), 'info');
    }
  }

  resetDemo() {
    const lang = this.state.lang || getLang();
    const fresh = resetDemoState(lang);
    this.loadDemoMode(false);
    this.setState({
      tagSchema: fresh.tagSchema,
      membersData: fresh.membersData,
    });
    this.toast(t('store.demoResetToast'), 'success');
  }

  switchDemoPersona(memberId) {
    if (this.state.mode !== 'demo') return;
    const personas = getDemoPersonas(this.state.lang || getLang());
    const persona = personas.find((p) => p.id === memberId);
    if (!persona) return;
    this.setState({ currentUser: { ...persona } });
    saveDemoState({
      tagSchema: this.state.tagSchema,
      membersData: this.state.membersData,
      activePersonaId: persona.id,
    });
    this.toast(t('store.switchedPersonaToast', { name: persona.name }), 'info');
  }

  _mergeMemberItems(localItems = {}, cloudItems = {}) {
    const merged = { ...cloudItems };
    for (const [fid, localItem] of Object.entries(localItems || {})) {
      const cloudItem = merged[fid];
      if (!cloudItem || Number(localItem?.updatedAt || 0) > Number(cloudItem?.updatedAt || 0)) {
        merged[fid] = localItem;
      }
    }
    return merged;
  }

  _mergeFreshWithLocalEdits(localMembers, cloudMembers, localSchema, cloudSchema, myId) {
    const mergedMembers = { ...(cloudMembers || {}) };
    if (myId && localMembers?.[myId]) {
      const localRecord = localMembers[myId];
      const cloudRecord = mergedMembers[myId] || {
        version: 1,
        member: localRecord.member,
        items: {},
      };
      mergedMembers[myId] = {
        ...cloudRecord,
        member: localRecord.member || cloudRecord.member,
        items: this._mergeMemberItems(localRecord.items, cloudRecord.items),
      };
    }
    const mergedSchema = mergeTagSchemas(localSchema || { version: 1, tags: {} }, cloudSchema || { version: 1, tags: {} });
    return { mergedMembers, mergedSchema };
  }

  _hydrateFromAlbumCache(
    cached,
    {
      authType,
      folderId,
      clientId = '',
      apiKey = '',
      user,
      localMetaSupportedOverride = null,
      syncStatus = 'syncing',
      syncMessageKey = 'store.syncCachedRevalidating',
      backgroundRefreshing = false,
    }
  ) {
    if (!cached?.rootFolder || !Array.isArray(cached.files)) return false;
    const sameAlbum = this.state.mode === 'gdrive' && this.state.folderId === folderId;
    const folderIds = new Set((cached.folders || []).map((f) => f.id));
    const fileIds = new Set(cached.files.map((f) => f.id));

    const membersData = { ...(cached.membersData || {}) };
    if (user?.id) {
      if (!membersData[user.id]) {
        membersData[user.id] = {
          version: 1,
          member: { ...user, updatedAt: Date.now() },
          items: {},
        };
      } else {
        membersData[user.id] = {
          ...membersData[user.id],
          member: { ...user, updatedAt: Date.now() },
        };
      }
    }

    const nextActiveFolder =
      sameAlbum && this.state.activeFolderId && folderIds.has(this.state.activeFolderId)
        ? this.state.activeFolderId
        : cached.rootFolder.id;
    const nextFocused =
      sameAlbum && this.state.focusedPhotoId && fileIds.has(this.state.focusedPhotoId)
        ? this.state.focusedPhotoId
        : cached.files[0]?.id || null;
    const nextLightbox =
      sameAlbum && this.state.lightboxPhotoId && fileIds.has(this.state.lightboxPhotoId)
        ? this.state.lightboxPhotoId
        : null;

    this._startPageToken = cached.startPageToken || '';
    this._syncWatermark = cached.syncWatermark || '';
    this._lastFullReconcileAt = Number(cached.lastFullReconcileAt || 0);

    this.setState({
      mode: 'gdrive',
      authType,
      folderId,
      ...(clientId ? { clientId } : {}),
      ...(apiKey ? { apiKey } : {}),
      ...(user ? { currentUser: user } : {}),
      localMetaSupported:
        localMetaSupportedOverride !== null
          ? Boolean(localMetaSupportedOverride)
          : Boolean(cached.localMetaSupported),
      loading: false,
      loadingText: '',
      backgroundRefreshing: Boolean(backgroundRefreshing),
      cacheRestoredAt: Number(cached.savedAt || Date.now()),
      syncStatus,
      syncMessageKey,
      syncMessage: t(syncMessageKey),
      rootFolder: cached.rootFolder,
      folders: cached.folders || [cached.rootFolder],
      files: cached.files,
      metaFolderId: cached.metaFolderId || null,
      canWrite: Boolean(cached.canWrite),
      tagSchemaFileId: cached.tagSchemaFileId || null,
      tagSchema: cached.tagSchema || { version: 1, tags: {} },
      memberFilesById: cached.memberFilesById || {},
      membersData,
      activeFolderId: nextActiveFolder,
      focusedPhotoId: nextFocused,
      lightboxPhotoId: nextLightbox,
      ...(sameAlbum
        ? {}
        : {
            selectedPhotoIds: new Set(),
            lastClickedPhotoId: null,
            quickView: 'all',
            minRating: 0,
            memberFilterId: null,
            ratingScope: 'avg',
            selectedTagIds: new Set(),
            searchQuery: '',
          }),
      modal: null,
    });
    return true;
  }

  _recordRecentAlbum({ folderId, name, authType, clientId = '', apiKey = '', remember = true }) {
    if (!remember || !folderId) return this.state.recentAlbums;
    const recent = [
      {
        folderId,
        name,
        authType,
        ...(clientId ? { clientId } : {}),
        ...(apiKey ? { apiKey } : {}),
        updatedAt: Date.now(),
      },
      ...this.state.recentAlbums.filter((a) => a.folderId !== folderId),
    ].slice(0, 6);
    try {
      localStorage.setItem(RECENT_KEY, JSON.stringify(recent));
    } catch {
      // Ignore
    }
    return recent;
  }

  _handleStreamingBatch(reqSeq, batch, { authType, folderId, clientId = '', apiKey = '', user }) {
    if (reqSeq !== this.connectSeq || !batch?.files?.length) return;
    const membersData = { ...(this.state.membersData || {}) };
    if (user?.id && !membersData[user.id]) {
      membersData[user.id] = {
        version: 1,
        member: { ...user, updatedAt: Date.now() },
        items: {},
      };
    }
    const isSameArray = batch.files === this.state.files;
    if (isSameArray && Array.isArray(batch.newFiles)) {
      for (let i = 0; i < batch.newFiles.length; i += 1) {
        const norm = this._normalizeFileRecord(batch.newFiles[i]);
        if (norm && norm.id) {
          this._fileById.set(norm.id, norm);
        }
      }
      this._libraryStatsCache = null;
    }
    const curFolderIds = new Set((batch.folders || []).map((f) => f.id));
    const focusedValid =
      this.state.focusedPhotoId &&
      (isSameArray ? this._fileById.has(this.state.focusedPhotoId) : batch.files.some((f) => f.id === this.state.focusedPhotoId));

    this.setState(
      {
        mode: 'gdrive',
        authType,
        folderId,
        ...(clientId ? { clientId } : {}),
        ...(apiKey ? { apiKey } : {}),
        ...(user ? { currentUser: user } : {}),
        loading: false,
        loadingText: '',
        backgroundRefreshing: true,
        syncStatus: 'syncing',
        syncMessageKey: 'store.syncStreamingAlbum',
        syncMessage: t('store.syncStreamingAlbum'),
        rootFolder: batch.rootFolder,
        folders: batch.folders,
        files: batch.files,
        metaFolderId: batch.metaFolderId || this.state.metaFolderId,
        canWrite: Boolean(batch.canWrite),
        membersData,
        activeFolderId:
          this.state.activeFolderId && curFolderIds.has(this.state.activeFolderId)
            ? this.state.activeFolderId
            : batch.rootFolder.id,
        focusedPhotoId: focusedValid ? this.state.focusedPhotoId : batch.files[0]?.id || null,
        modal: null,
      },
      {
        type: 'full',
        _skipFileIndexRebuild: isSameArray && Array.isArray(batch.newFiles),
      }
    );
  }

  _commitLoadedAlbumState({
    authType,
    folderId,
    album,
    tagSchema,
    tagSchemaFileId = null,
    memberFilesById = {},
    membersData,
    canWrite = true,
    localMetaSupported = false,
    syncStatus,
    syncMessageKey,
    recent,
  }) {
    const sameActiveAlbum = this.state.mode === 'gdrive' && this.state.folderId === folderId;
    const folderIds = new Set(album.folders.map((f) => f.id));
    const alreadyIndexed =
      album.files === this.state.files && this._fileById.size === album.files.length;
    if (!alreadyIndexed) {
      this._rebuildFileIndex(album.files);
    }
    const nextSelectedIds = sameActiveAlbum
      ? new Set(Array.from(this.state.selectedPhotoIds).filter((id) => this._fileById.has(id)))
      : new Set();

    this._startPageToken = album.startPageToken || '';
    this._syncWatermark = album.syncWatermark || new Date().toISOString();
    this._lastFullReconcileAt = Date.now();

    this.setState(
      {
        mode: 'gdrive',
        authType,
        localMetaSupported,
        loading: false,
        loadingText: '',
        backgroundRefreshing: false,
        cacheRestoredAt: Date.now(),
        syncStatus,
        syncMessageKey,
        syncMessage: t(syncMessageKey),
        rootFolder: album.rootFolder,
        folders: album.folders,
        files: album.files,
        metaFolderId: album.metaFolderId || null,
        canWrite,
        tagSchemaFileId,
        tagSchema,
        memberFilesById,
        membersData,
        activeFolderId:
          sameActiveAlbum && folderIds.has(this.state.activeFolderId)
            ? this.state.activeFolderId
            : album.rootFolder.id,
        selectedPhotoIds: nextSelectedIds,
        lastClickedPhotoId:
          sameActiveAlbum && this._fileById.has(this.state.lastClickedPhotoId)
            ? this.state.lastClickedPhotoId
            : null,
        focusedPhotoId:
          sameActiveAlbum && this._fileById.has(this.state.focusedPhotoId)
            ? this.state.focusedPhotoId
            : album.files[0]?.id || null,
        lightboxPhotoId:
          sameActiveAlbum && this._fileById.has(this.state.lightboxPhotoId)
            ? this.state.lightboxPhotoId
            : null,
        ...(sameActiveAlbum
          ? {}
          : {
              quickView: 'all',
              minRating: 0,
              memberFilterId: null,
              ratingScope: 'avg',
              selectedTagIds: new Set(),
              searchQuery: '',
            }),
        recentAlbums: recent,
        modal: null,
      },
      { type: 'full', _skipFileIndexRebuild: true }
    );
  }

  _scheduleAlbumMetaOnlyCacheUpdate() {
    if (this.state.mode !== 'gdrive' || !this.state.folderId || !this.state.rootFolder) {
      return;
    }
    const authType = this.state.authType === 'oauth' ? 'oauth' : 'apikey';
    const folderId = this.state.folderId;
    clearTimeout(this.cacheSnapshotTimer);
    this.cacheSnapshotTimer = setTimeout(() => {
      if (this.state.mode !== 'gdrive' || this.state.folderId !== folderId || !this.state.rootFolder) {
        return;
      }
      saveCachedAlbumMetaOnly(authType, folderId, {
        metaFolderId: this.state.metaFolderId,
        canWrite: this.state.canWrite,
        tagSchemaFileId: this.state.tagSchemaFileId,
        tagSchema: this.state.tagSchema,
        memberFilesById: this.state.memberFilesById,
        membersData: this.state.membersData,
        localMetaSupported: this.state.localMetaSupported,
        startPageToken: this._startPageToken || '',
        syncWatermark: this._syncWatermark || '',
        lastFullReconcileAt: this._lastFullReconcileAt || 0,
      }).catch(() => {});
    }, 300);
  }

  _persistOAuthConnectPrefs({ remember, clientId, folderId, tokenRenewalUrl }) {
    if (remember) {
      saveConnectPrefs({
        authType: 'oauth',
        clientId,
        folderId,
        tokenRenewalUrl,
        rememberCredentials: true,
        autoConnect: true,
      });
    } else {
      saveConnectPrefs({
        authType: 'oauth',
        rememberCredentials: false,
        autoConnect: false,
        apiKey: '',
        clientId: '',
        folderId: '',
        tokenRenewalUrl: '',
      });
    }
  }

  async connectGoogleDrive({
    clientId,
    folderInput,
    tokenRenewalUrl = this.state.tokenRenewalUrl,
    reuseSession = false,
    rememberCredentials = this.state.rememberCredentials,
    prompt,
    loginHint,
    forceRescan = false,
  }) {
    const cleanClientId = String(clientId || '').trim();
    const cleanFolderId = parseDriveFolderId(folderInput);
    const cleanRenewalUrl = normalizeRenewalEndpoint(tokenRenewalUrl);
    const remember = rememberCredentials !== false;

    if (!cleanClientId) {
      this.toast(t('store.missingClientId'), 'error');
      return false;
    }
    if (!cleanFolderId) {
      this.toast(t('store.invalidFolder'), 'error');
      return false;
    }

    const reqSeq = ++this.connectSeq;
    const isAlbumSwitch = this.state.mode !== 'gdrive' || this.state.folderId !== cleanFolderId;
    if (isAlbumSwitch) {
      this._resetUnsyncedTracking();
    }
    const existingSavedUser = getSavedOAuthUser(cleanClientId);
    const savedHint = existingSavedUser?.email || '';
    const effectiveHint = loginHint !== undefined ? loginHint : savedHint;
    const effectivePrompt = prompt !== undefined ? prompt : effectiveHint ? '' : 'select_account';

    this._persistOAuthConnectPrefs({
      remember,
      clientId: cleanClientId,
      folderId: cleanFolderId,
      tokenRenewalUrl: cleanRenewalUrl,
    });

    let session = reuseSession ? getCachedSession(cleanClientId) : null;
    if (!remember && !session) {
      clearSession({ forgetUser: true, clearRenewal: true });
    }
    const pendingAuthPromise = !session
      ? authenticateGoogle(cleanClientId, {
          prompt: effectivePrompt,
          loginHint: effectiveHint,
          remember,
          tokenRenewalUrl: cleanRenewalUrl,
          allowSilentFirst: false,
        })
      : null;
    if (pendingAuthPromise) {
      pendingAuthPromise.catch(() => {});
    }

    const cachedBeforeAuth = !forceRescan ? await getCachedAlbum('oauth', cleanFolderId) : null;
    if (reqSeq !== this.connectSeq) return false;

    const hasUsableCache = Boolean(cachedBeforeAuth && cachedBeforeAuth.files?.length > 0);

    let keepVisible =
      hasUsableCache ||
      (this.state.mode === 'gdrive' &&
        this.state.folderId === cleanFolderId &&
        this.state.files.length > 0);

    if (hasUsableCache) {
      this._hydrateFromAlbumCache(cachedBeforeAuth, {
        authType: 'oauth',
        folderId: cleanFolderId,
        clientId: cleanClientId,
        user: existingSavedUser || this.state.currentUser,
        syncStatus: 'syncing',
        syncMessageKey: 'store.syncCachedRevalidating',
        backgroundRefreshing: true,
      });
      this.setState(
        {
          tokenRenewalUrl: cleanRenewalUrl,
          rememberCredentials: remember,
          savedOAuthUser: remember ? existingSavedUser : null,
        },
        { type: 'ui-only' }
      );
      this._updateUrlHash(cleanFolderId, cleanClientId);
      this.toast(
        t('store.loadedFromCacheToast', {
          name: cachedBeforeAuth.rootFolder.name,
          count: cachedBeforeAuth.files.length,
        }),
        'info',
        2400
      );
    } else {
      this.setState({
        loading: !keepVisible,
        loadingText: keepVisible ? '' : t('store.connectingAccount'),
        backgroundRefreshing: keepVisible,
        authType: 'oauth',
        localMetaSupported: false,
        clientId: cleanClientId,
        folderId: cleanFolderId,
        tokenRenewalUrl: cleanRenewalUrl,
        rememberCredentials: remember,
        savedOAuthUser: remember ? existingSavedUser : null,
        ...(keepVisible
          ? {
              syncStatus: 'syncing',
              syncMessageKey: 'store.syncRefreshingAlbum',
              syncMessage: t('store.syncRefreshingAlbum'),
            }
          : {}),
      });
    }

    try {
      if (!session && pendingAuthPromise) {
        session = await pendingAuthPromise;
      }
      if (reqSeq !== this.connectSeq) return false;
      this._silentRenewalExhausted = false;

      const nextSavedUser = remember
        ? getSavedOAuthUser(cleanClientId) || {
            clientId: cleanClientId,
            id: session.user.id,
            email: session.user.email,
            name: session.user.name,
            picture: session.user.picture,
            color: session.user.color,
          }
        : null;

      this.setState({
        ...(this.state.loading ? { loadingText: t('store.scanningAlbum') } : {}),
        accessToken: session.accessToken,
        currentUser: session.user,
        savedOAuthUser: nextSavedUser,
        tokenRenewalUrl: cleanRenewalUrl,
      });
      this._scheduleSessionLifecycle(session.expiresAt);

      // Cache-first fast path: hydrate immediately and run background incremental sync
      if (hasUsableCache) {
        const recent = this._recordRecentAlbum({
          folderId: cleanFolderId,
          name: cachedBeforeAuth.rootFolder.name,
          authType: 'oauth',
          clientId: cleanClientId,
          remember,
        });
        this.setState({ recentAlbums: recent }, { type: 'ui-only' });
        this._performIncrementalSync({ reqSeq, showToast: false }).catch(() => {});
        return true;
      }

      const album = await loadSharedAlbum(
        cleanFolderId,
        session.accessToken,
        (prog) => {
          if (reqSeq !== this.connectSeq || !this.state.loading) return;
          this.setState({
            loadingText: t('store.scanningProgress', {
              folders: prog.folderCount,
              files: prog.fileCount,
            }),
          });
        },
        keepVisible
          ? null
          : (batch) =>
              this._handleStreamingBatch(reqSeq, batch, {
                authType: 'oauth',
                folderId: cleanFolderId,
                clientId: cleanClientId,
                user: session.user,
              })
      );
      if (reqSeq !== this.connectSeq) return false;

      if (this.state.loading) {
        this.setState({
          loadingText: t('store.syncingMetadata'),
        });
      }

      const meta = await loadAlbumMetadata(album.metaFolderId, session.accessToken);
      if (reqSeq !== this.connectSeq) return false;

      let membersData = { ...meta.membersData };
      let tagSchema = meta.tagSchema || { version: 1, tags: {} };
      const myId = session.user.id;

      // Read-only fallback merge from localStorage if folder is read-only
      if (!album.canWrite) {
        try {
          const localRaw = localStorage.getItem(`drivelens_readonly_${cleanFolderId}_${myId}`);
          if (localRaw) {
            const parsed = JSON.parse(localRaw);
            if (parsed.memberData) membersData[myId] = parsed.memberData;
            if (parsed.tagSchema) {
              tagSchema = {
                version: 1,
                tags: { ...tagSchema.tags, ...parsed.tagSchema.tags },
              };
            }
          }
        } catch {
          // Ignore
        }
      }

      if ((keepVisible || this.state.files.length > 0) && this.state.mode === 'gdrive' && this.state.folderId === cleanFolderId) {
        const merged = this._mergeFreshWithLocalEdits(
          this.state.membersData,
          membersData,
          this.state.tagSchema,
          tagSchema,
          myId
        );
        membersData = merged.mergedMembers;
        tagSchema = merged.mergedSchema;
      }

      if (!membersData[myId]) {
        membersData[myId] = {
          version: 1,
          member: { ...session.user, updatedAt: Date.now() },
          items: {},
        };
      } else {
        membersData[myId] = {
          ...membersData[myId],
          member: { ...session.user, updatedAt: Date.now() },
        };
      }

      const recent = this._recordRecentAlbum({
        folderId: cleanFolderId,
        name: album.rootFolder.name,
        authType: 'oauth',
        clientId: cleanClientId,
        remember,
      });

      const savedSnapshot = {
        rootFolder: album.rootFolder,
        folders: album.folders,
        files: album.files,
        metaFolderId: album.metaFolderId,
        canWrite: album.canWrite,
        tagSchemaFileId: meta.tagSchemaFileId,
        tagSchema,
        memberFilesById: meta.memberFilesById,
        membersData,
        localMetaSupported: false,
        startPageToken: album.startPageToken || '',
        syncWatermark: album.syncWatermark || new Date().toISOString(),
        lastFullReconcileAt: Date.now(),
      };
      await setCachedAlbum('oauth', cleanFolderId, savedSnapshot);
      if (reqSeq !== this.connectSeq) return false;

      this._updateUrlHash(cleanFolderId, cleanClientId);

      const msgKey = album.canWrite ? 'store.syncOAuthSynced' : 'store.syncReadonly';
      const hadPendingEdits =
        !isAlbumSwitch &&
        album.canWrite &&
        (this._unsyncedPhotoIds.size > 0 || this._unsyncedSchemaDirty);
      this._commitLoadedAlbumState({
        authType: 'oauth',
        folderId: cleanFolderId,
        album,
        tagSchema,
        tagSchemaFileId: meta.tagSchemaFileId,
        memberFilesById: meta.memberFilesById,
        membersData,
        canWrite: album.canWrite,
        localMetaSupported: false,
        syncStatus: album.canWrite ? 'synced' : 'readonly',
        syncMessageKey: msgKey,
        recent,
      });

      if (hadPendingEdits) {
        if (this._unsyncedPhotoIds.size > 0) {
          this._flushMemberSync();
        }
        if (this._unsyncedSchemaDirty) {
          this._flushSchemaSync();
        }
      }

      if (!cachedBeforeAuth || forceRescan) {
        this.toast(
          t('store.loadedAlbumToast', { name: album.rootFolder.name, count: album.files.length }),
          'success'
        );
      }
      return true;
    } catch (err) {
      if (reqSeq !== this.connectSeq) return false;
      if (keepVisible && this.state.mode === 'gdrive' && this.state.folderId === cleanFolderId) {
        this.setState({
          loading: false,
          loadingText: '',
          backgroundRefreshing: false,
          syncStatus: 'readonly',
          syncMessageKey: 'store.syncOfflineCached',
          syncMessage: t('store.syncOfflineCached'),
        });
      } else {
        this.setState({ loading: false, loadingText: '', backgroundRefreshing: false });
      }
      if (err?.isPopupBlocked) {
        this.openModal('connect');
        this.toast(t('gdrive.popupBlockedRedirectHint'), 'error', 6000);
      } else {
        this.toast(err?.message || t('store.connectFailed'), 'error', 5000);
      }
      return false;
    }
  }

  startRedirectGoogleDrive({
    clientId,
    folderInput,
    tokenRenewalUrl = this.state.tokenRenewalUrl,
    rememberCredentials = this.state.rememberCredentials,
  }) {
    const cleanClientId = String(clientId || '').trim();
    const cleanFolderId = parseDriveFolderId(folderInput);
    const cleanRenewalUrl = normalizeRenewalEndpoint(tokenRenewalUrl);
    const remember = rememberCredentials !== false;

    if (!cleanClientId) {
      this.toast(t('store.missingClientId'), 'error');
      return false;
    }
    if (!cleanFolderId) {
      this.toast(t('store.invalidFolder'), 'error');
      return false;
    }

    this._persistOAuthConnectPrefs({
      remember,
      clientId: cleanClientId,
      folderId: cleanFolderId,
      tokenRenewalUrl: cleanRenewalUrl,
    });
    if (!remember) {
      clearSession({ forgetUser: true, clearRenewal: true });
    }

    const savedHint = getSavedOAuthUser(cleanClientId)?.email || '';
    startOAuthRedirectFlow({
      clientId: cleanClientId,
      folderId: cleanFolderId,
      tokenRenewalUrl: cleanRenewalUrl,
      remember,
      loginHint: savedHint,
    });
    return true;
  }

  async handleOAuthRedirectReturn() {
    let result = null;
    try {
      result = await consumeOAuthRedirectCallback();
    } catch (err) {
      this.toast(err?.message || t('store.connectFailed'), 'error', 5000);
      return false;
    }
    if (!result) return false;

    const { session, folderId, clientId, tokenRenewalUrl, remember } = result;
    this._silentRenewalExhausted = false;
    if (remember !== false) {
      saveConnectPrefs({
        authType: 'oauth',
        clientId,
        folderId,
        tokenRenewalUrl,
        rememberCredentials: true,
        autoConnect: true,
      });
    }
    const savedOAuthUser =
      remember !== false
        ? getSavedOAuthUser(clientId) || {
            clientId,
            id: session.user.id,
            email: session.user.email,
            name: session.user.name,
            picture: session.user.picture,
            color: session.user.color,
          }
        : null;

    this.setState({
      authType: 'oauth',
      clientId,
      folderId,
      tokenRenewalUrl,
      rememberCredentials: remember !== false,
      accessToken: session.accessToken,
      currentUser: session.user,
      savedOAuthUser,
    });
    this._scheduleSessionLifecycle(session.expiresAt);

    return this.connectGoogleDrive({
      clientId,
      folderInput: folderId,
      tokenRenewalUrl,
      reuseSession: true,
      rememberCredentials: remember,
    });
  }

  async connectWithApiKey({
    apiKey,
    folderInput,
    nickname,
    rememberCredentials = this.state.rememberCredentials,
    forceRescan = false,
  }) {
    const cleanApiKey = String(apiKey || '').trim();
    const cleanFolderId = parseDriveFolderId(folderInput);
    const cleanNick = String(nickname || '').trim() || t('store.guestNickname');
    const remember = rememberCredentials !== false;

    if (!cleanApiKey) {
      this.toast(t('store.missingApiKey'), 'error');
      return false;
    }
    if (!cleanFolderId) {
      this.toast(t('store.invalidFolder'), 'error');
      return false;
    }

    const reqSeq = ++this.connectSeq;
    this._clearSessionLifecycle();
    if (this.state.mode !== 'gdrive' || this.state.folderId !== cleanFolderId) {
      this._resetUnsyncedTracking();
    }

    if (remember) {
      saveConnectPrefs({
        authType: 'apikey',
        apiKey: cleanApiKey,
        folderId: cleanFolderId,
        nickname: cleanNick,
        rememberCredentials: true,
        autoConnect: true,
      });
    } else {
      saveConnectPrefs({
        authType: 'apikey',
        rememberCredentials: false,
        autoConnect: false,
        apiKey: '',
        clientId: '',
        folderId: '',
        tokenRenewalUrl: '',
      });
      clearSession({ forgetUser: true, clearRenewal: true });
    }

    const userId = `nick_${sanitizeMemberKey(cleanNick)}`;
    const user = {
      id: userId,
      name: cleanNick,
      email: '',
      picture: '',
      color: pickMemberColor(userId),
    };

    const cached = !forceRescan ? await getCachedAlbum('apikey', cleanFolderId) : null;
    if (reqSeq !== this.connectSeq) return false;

    const hasUsableCache = Boolean(cached && cached.files?.length > 0);

    const keepVisible =
      hasUsableCache ||
      (this.state.mode === 'gdrive' &&
        this.state.folderId === cleanFolderId &&
        this.state.files.length > 0);

    if (hasUsableCache) {
      this._hydrateFromAlbumCache(cached, {
        authType: 'apikey',
        folderId: cleanFolderId,
        apiKey: cleanApiKey,
        user,
        syncStatus: 'syncing',
        syncMessageKey: 'store.syncCachedRevalidating',
        backgroundRefreshing: true,
      });
      const recent = this._recordRecentAlbum({
        folderId: cleanFolderId,
        name: cached.rootFolder.name,
        authType: 'apikey',
        apiKey: cleanApiKey,
        remember,
      });
      this.setState({
        nickname: cleanNick,
        rememberCredentials: remember,
        ...(remember ? {} : { savedOAuthUser: null }),
        accessToken: '',
        recentAlbums: recent,
      });
      this._updateUrlHash(cleanFolderId, '');
      this.toast(
        t('store.loadedFromCacheToast', {
          name: cached.rootFolder.name,
          count: cached.files.length,
        }),
        'info',
        2400
      );
      this._performIncrementalSync({ reqSeq, showToast: false }).catch(() => {});
      return true;
    } else {
      this.setState({
        loading: !keepVisible,
        loadingText: keepVisible ? '' : t('store.connectingApiKey'),
        backgroundRefreshing: keepVisible,
        authType: 'apikey',
        apiKey: cleanApiKey,
        folderId: cleanFolderId,
        nickname: cleanNick,
        rememberCredentials: remember,
        ...(remember ? {} : { savedOAuthUser: null }),
        accessToken: '',
        currentUser: user,
        ...(keepVisible
          ? {
              syncStatus: 'syncing',
              syncMessageKey: 'store.syncRefreshingAlbum',
              syncMessage: t('store.syncRefreshingAlbum'),
            }
          : {}),
      });
    }

    try {
      const album = await loadSharedAlbumWithApiKey(
        cleanFolderId,
        cleanApiKey,
        (prog) => {
          if (reqSeq !== this.connectSeq || !this.state.loading) return;
          this.setState({
            loadingText: t('store.scanningProgress', {
              folders: prog.folderCount,
              files: prog.fileCount,
            }),
          });
        },
        keepVisible
          ? null
          : (batch) =>
              this._handleStreamingBatch(reqSeq, batch, {
                authType: 'apikey',
                folderId: cleanFolderId,
                apiKey: cleanApiKey,
                user,
              })
      );
      if (reqSeq !== this.connectSeq) return false;

      if (this.state.loading) {
        this.setState({ loadingText: t('store.syncingMetadata') });
      }

      const serverMeta = await loadLocalServerMeta(cleanFolderId);
      if (reqSeq !== this.connectSeq) return false;

      const localStorageKey = `drivelens_apikey_meta_${cleanFolderId}`;
      let tagSchema = { version: 1, tags: {} };
      let membersData = {};

      if (serverMeta) {
        if (serverMeta.tagSchema && typeof serverMeta.tagSchema.tags === 'object') {
          tagSchema = { version: 1, tags: serverMeta.tagSchema.tags };
        }
        if (serverMeta.membersData && typeof serverMeta.membersData === 'object') {
          membersData = { ...serverMeta.membersData };
        }
      } else {
        try {
          const localRaw = localStorage.getItem(localStorageKey);
          if (localRaw) {
            const parsed = JSON.parse(localRaw);
            if (parsed?.tagSchema?.tags) {
              tagSchema = { version: 1, tags: parsed.tagSchema.tags };
            }
            if (parsed?.membersData && typeof parsed.membersData === 'object') {
              membersData = { ...parsed.membersData };
            }
          }
        } catch {
          // Ignore
        }
      }

      if ((keepVisible || this.state.files.length > 0) && this.state.mode === 'gdrive' && this.state.folderId === cleanFolderId) {
        const merged = this._mergeFreshWithLocalEdits(
          this.state.membersData,
          membersData,
          this.state.tagSchema,
          tagSchema,
          user.id
        );
        membersData = merged.mergedMembers;
        tagSchema = merged.mergedSchema;
      }

      if (!membersData[user.id]) {
        membersData[user.id] = {
          version: 1,
          member: { ...user, updatedAt: Date.now() },
          items: {},
        };
      } else {
        membersData[user.id] = {
          ...membersData[user.id],
          member: { ...user, updatedAt: Date.now() },
        };
      }

      const recent = this._recordRecentAlbum({
        folderId: cleanFolderId,
        name: album.rootFolder.name,
        authType: 'apikey',
        apiKey: cleanApiKey,
        remember,
      });

      try {
        localStorage.setItem(localStorageKey, JSON.stringify({ tagSchema, membersData }));
      } catch {
        // Ignore
      }

      const localMetaSupported = Boolean(serverMeta);
      await setCachedAlbum('apikey', cleanFolderId, {
        rootFolder: album.rootFolder,
        folders: album.folders,
        files: album.files,
        metaFolderId: null,
        canWrite: true,
        tagSchemaFileId: null,
        tagSchema,
        memberFilesById: {},
        membersData,
        localMetaSupported,
        startPageToken: '',
        syncWatermark: album.syncWatermark || new Date().toISOString(),
        lastFullReconcileAt: Date.now(),
      });
      if (reqSeq !== this.connectSeq) return false;

      this._updateUrlHash(cleanFolderId, '');

      const msgKey = localMetaSupported ? 'store.syncApiKeySynced' : 'store.syncApiKeyLocal';
      this._commitLoadedAlbumState({
        authType: 'apikey',
        folderId: cleanFolderId,
        album,
        tagSchema,
        tagSchemaFileId: null,
        memberFilesById: {},
        membersData,
        canWrite: true,
        localMetaSupported,
        syncStatus: localMetaSupported ? 'synced' : 'readonly',
        syncMessageKey: msgKey,
        recent,
      });

      if (!cached || forceRescan) {
        this.toast(
          t('store.loadedAlbumToast', { name: album.rootFolder.name, count: album.files.length }),
          'success'
        );
      }
      return true;
    } catch (err) {
      if (reqSeq !== this.connectSeq) return false;
      if (keepVisible && this.state.mode === 'gdrive' && this.state.folderId === cleanFolderId) {
        this.setState({
          loading: false,
          loadingText: '',
          backgroundRefreshing: false,
          syncStatus: 'readonly',
          syncMessageKey: 'store.syncOfflineCached',
          syncMessage: t('store.syncOfflineCached'),
        });
      } else {
        this.setState({ loading: false, loadingText: '', backgroundRefreshing: false });
      }
      this.toast(err?.message || t('store.connectApiKeyFailed'), 'error', 5000);
      return false;
    }
  }

  _applyExpiredOAuthFallback({
    cleanClientId,
    cleanFolderId,
    folderInput,
    cleanRenewalUrl,
    savedUser,
    cached,
  }) {
    if (cached) {
      this._hydrateFromAlbumCache(cached, {
        authType: 'oauth',
        folderId: cleanFolderId,
        clientId: cleanClientId,
        user: savedUser || {
          id: 'saved-oauth',
          name: 'Google',
          email: '',
          picture: '',
          color: '#38bdf8',
        },
        syncStatus: 'readonly',
        syncMessageKey: 'store.syncCachedSessionExpired',
        backgroundRefreshing: false,
      });
      this.setState(
        {
          savedOAuthUser: savedUser,
          tokenRenewalUrl: cleanRenewalUrl,
        },
        { type: 'ui-only' }
      );
      this._updateUrlHash(cleanFolderId, cleanClientId);
      this.toast(
        t('store.cachedSessionReconnectHint', {
          email: savedUser?.email || savedUser?.name || 'Google',
        }),
        'info'
      );
      return true;
    }

    this.setState({
      authType: 'oauth',
      clientId: cleanClientId,
      folderId: folderInput,
      tokenRenewalUrl: cleanRenewalUrl,
      savedOAuthUser: savedUser,
    });
    this.openModal('connect');
    if (savedUser?.email || savedUser?.name) {
      this.toast(
        t('store.sessionExpiredReconnect', {
          email: savedUser.email || savedUser.name,
        }),
        'info'
      );
    }
    return false;
  }

  async restoreExpiredOAuthCacheOrPrompt({
    clientId,
    folderInput,
    tokenRenewalUrl = this.state.tokenRenewalUrl,
  }) {
    const cleanClientId = String(clientId || '').trim();
    const cleanFolderId = parseDriveFolderId(folderInput);
    const cleanRenewalUrl = normalizeRenewalEndpoint(tokenRenewalUrl);
    const savedUser = getSavedOAuthUser(cleanClientId);
    const cached = cleanFolderId ? await getCachedAlbum('oauth', cleanFolderId) : null;

    if (
      cleanClientId &&
      cleanRenewalUrl &&
      hasStoredRenewalTicket(cleanClientId, cleanRenewalUrl)
    ) {
      const reqSeq = ++this.connectSeq;
      const hasUsableCache = Boolean(cached && cached.files?.length > 0);
      if (hasUsableCache) {
        this._hydrateFromAlbumCache(cached, {
          authType: 'oauth',
          folderId: cleanFolderId,
          clientId: cleanClientId,
          user: savedUser || this.state.currentUser,
          syncStatus: 'syncing',
          syncMessageKey: 'store.syncCachedRevalidating',
          backgroundRefreshing: true,
        });
        this.setState(
          {
            savedOAuthUser: savedUser,
            tokenRenewalUrl: cleanRenewalUrl,
          },
          { type: 'ui-only' }
        );
        this._updateUrlHash(cleanFolderId, cleanClientId);
      }

      const renewed = await renewOAuthSessionSilently(cleanClientId, cleanRenewalUrl, {
        remember: this.state.rememberCredentials,
      });
      if (reqSeq !== this.connectSeq) return false;
      this._silentRenewalExhausted = !renewed?.accessToken;
      if (renewed?.accessToken) {
        if (hasUsableCache) {
          this.setState(
            {
              accessToken: renewed.accessToken,
              currentUser: renewed.user,
              savedOAuthUser: getSavedOAuthUser(cleanClientId) || savedUser,
              tokenRenewalUrl: cleanRenewalUrl,
            },
            { type: 'ui-only' }
          );
          this._scheduleSessionLifecycle(renewed.expiresAt);
          await this._performIncrementalSync({ reqSeq, showToast: false });
          return true;
        }
        return this.connectGoogleDrive({
          clientId: cleanClientId,
          folderInput,
          tokenRenewalUrl: cleanRenewalUrl,
          reuseSession: true,
          rememberCredentials: this.state.rememberCredentials,
        });
      }
    }

    return this._applyExpiredOAuthFallback({
      cleanClientId,
      cleanFolderId,
      folderInput,
      cleanRenewalUrl,
      savedUser,
      cached,
    });
  }

  async restoreSavedSession() {
    const prefs = loadConnectPrefs();
    if (!prefs.rememberCredentials || !prefs.autoConnect || !prefs.folderId) {
      return false;
    }

    if (prefs.authType === 'apikey' && prefs.apiKey) {
      return this.connectWithApiKey({
        apiKey: prefs.apiKey,
        folderInput: prefs.folderId,
        nickname: prefs.nickname,
        rememberCredentials: true,
      });
    }

    if (prefs.authType === 'oauth' && prefs.clientId) {
      if (getCachedSession(prefs.clientId)) {
        return this.connectGoogleDrive({
          clientId: prefs.clientId,
          folderInput: prefs.folderId,
          tokenRenewalUrl: prefs.tokenRenewalUrl,
          reuseSession: true,
          rememberCredentials: true,
        });
      }

      if (prefs.tokenRenewalUrl) {
        const cleanFolderId = parseDriveFolderId(prefs.folderId);
        const reqSeq = ++this.connectSeq;
        const savedUser = getSavedOAuthUser(prefs.clientId);
        const cached = cleanFolderId ? await getCachedAlbum('oauth', cleanFolderId) : null;
        if (reqSeq !== this.connectSeq) return false;

        const hasUsableCache = Boolean(cached && cached.files?.length > 0);
        if (hasUsableCache) {
          this._hydrateFromAlbumCache(cached, {
            authType: 'oauth',
            folderId: cleanFolderId,
            clientId: prefs.clientId,
            user: savedUser || this.state.currentUser,
            syncStatus: 'syncing',
            syncMessageKey: 'store.syncCachedRevalidating',
            backgroundRefreshing: true,
          });
          this.setState(
            {
              savedOAuthUser: savedUser,
              tokenRenewalUrl: prefs.tokenRenewalUrl,
              rememberCredentials: true,
            },
            { type: 'ui-only' }
          );
          this._updateUrlHash(cleanFolderId, prefs.clientId);
        }

        const renewed = await renewOAuthSessionSilently(
          prefs.clientId,
          prefs.tokenRenewalUrl,
          { remember: true }
        );
        if (reqSeq !== this.connectSeq) return false;
        this._silentRenewalExhausted = !renewed?.accessToken;
        if (renewed?.accessToken) {
          if (hasUsableCache) {
            this.setState(
              {
                accessToken: renewed.accessToken,
                currentUser: renewed.user,
                savedOAuthUser: getSavedOAuthUser(prefs.clientId) || savedUser,
                tokenRenewalUrl: prefs.tokenRenewalUrl,
              },
              { type: 'ui-only' }
            );
            this._scheduleSessionLifecycle(renewed.expiresAt);
            await this._performIncrementalSync({ reqSeq, showToast: false });
            return true;
          }
          return this.connectGoogleDrive({
            clientId: prefs.clientId,
            folderInput: prefs.folderId,
            tokenRenewalUrl: prefs.tokenRenewalUrl,
            reuseSession: true,
            rememberCredentials: true,
          });
        }

        return this._applyExpiredOAuthFallback({
          cleanClientId: prefs.clientId,
          cleanFolderId,
          folderInput: prefs.folderId,
          cleanRenewalUrl: prefs.tokenRenewalUrl,
          savedUser,
          cached,
        });
      }

      return this.restoreExpiredOAuthCacheOrPrompt({
        clientId: prefs.clientId,
        folderInput: prefs.folderId,
        tokenRenewalUrl: prefs.tokenRenewalUrl,
      });
    }

    return false;
  }

  async clearLocalCache() {
    clearTimeout(this.cacheSnapshotTimer);
    await Promise.all([clearAllAlbumCaches(), clearImageCache()]);
    this.toast(t('store.cacheClearedToast'), 'info');
  }

  forgetSavedCredentials() {
    this.connectSeq += 1;
    this._clearSessionLifecycle();
    clearSession({ forgetUser: true, clearRenewal: true });
    clearAllAlbumCaches().catch(() => {});
    clearImageCache().catch(() => {});
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.removeItem(SETTINGS_KEY);
        localStorage.removeItem(RECENT_KEY);
      }
    } catch {
      // Ignore
    }

    const defaultNick = t('store.defaultNickname');
    const wasGdrive = this.state.mode === 'gdrive';

    this._startPageToken = '';
    this._syncWatermark = '';
    this._lastFullReconcileAt = 0;
    this._resetUnsyncedTracking();
    this._unsyncedPhotoIds = new Set();
    this._unsyncedSchemaDirty = false;

    this.setState({
      apiKey: '',
      clientId: '',
      folderId: '',
      tokenRenewalUrl: '',
      nickname: defaultNick,
      recentAlbums: [],
      savedOAuthUser: null,
      rememberCredentials: true,
      accessToken: '',
      localMetaSupported: false,
      backgroundRefreshing: false,
      cacheRestoredAt: 0,
    });

    if (wasGdrive) {
      this.loadDemoMode(false);
    } else {
      this._clearUrlHash();
    }

    this.toast(t('store.credsClearedToast'), 'info');
  }

  async _performIncrementalSync({ reqSeq, showToast = false } = {}) {
    if (this.state.mode !== 'gdrive' || !this.state.folderId || !this.state.rootFolder) {
      return false;
    }
    const authType = this.state.authType === 'oauth' ? 'oauth' : 'apikey';
    const isOAuth = authType === 'oauth';
    const folderId = this.state.folderId;
    let accessToken = this.state.accessToken;

    if (isOAuth && !accessToken) {
      const cachedSess = this.state.clientId ? getCachedSession(this.state.clientId) : null;
      if (cachedSess?.accessToken) {
        accessToken = cachedSess.accessToken;
        this.setState({ accessToken }, { type: 'ui-only' });
        this._scheduleSessionLifecycle(cachedSess.expiresAt);
      } else if (
        this.state.tokenRenewalUrl &&
        this.state.clientId &&
        hasStoredRenewalTicket(this.state.clientId, this.state.tokenRenewalUrl)
      ) {
        const renewed = await renewOAuthSessionSilently(
          this.state.clientId,
          this.state.tokenRenewalUrl,
          { remember: this.state.rememberCredentials }
        );
        if (reqSeq !== this.connectSeq) return false;
        this._silentRenewalExhausted = !renewed?.accessToken;
        if (renewed?.accessToken) {
          accessToken = renewed.accessToken;
          this.setState(
            { accessToken, currentUser: renewed.user },
            { type: 'ui-only' }
          );
          this._scheduleSessionLifecycle(renewed.expiresAt);
        }
      }
    }

    const usingApiKeyAssist = isOAuth && !accessToken && Boolean(this.state.apiKey);

    if (isOAuth && !accessToken && !usingApiKeyAssist) {
      if (showToast && this.state.clientId) {
        const sess = await authenticateGoogle(this.state.clientId, {
          prompt: '',
          loginHint: this.state.savedOAuthUser?.email || this.state.currentUser?.email || '',
          remember: this.state.rememberCredentials,
          tokenRenewalUrl: this.state.tokenRenewalUrl,
        });
        if (reqSeq !== this.connectSeq) return false;
        accessToken = sess.accessToken;
        this.setState(
          { accessToken, currentUser: sess.user },
          { type: 'ui-only' }
        );
        this._scheduleSessionLifecycle(sess.expiresAt);
      } else {
        const hasPending = this._unsyncedPhotoIds.size > 0 || this._unsyncedSchemaDirty;
        this.setState(
          {
            backgroundRefreshing: false,
            syncStatus: hasPending ? 'error' : 'readonly',
            syncMessageKey: 'store.syncCachedSessionExpired',
            syncMessage: t('store.syncCachedSessionExpired'),
          },
          { type: 'ui-only' }
        );
        return false;
      }
    }

    this.setState(
      {
        backgroundRefreshing: true,
        syncStatus: 'syncing',
        syncMessageKey: 'store.syncIncremental',
        syncMessage: t('store.syncIncremental'),
      },
      { type: 'ui-only' }
    );

    try {
      const watermark =
        this._syncWatermark ||
        (this.state.cacheRestoredAt ? new Date(this.state.cacheRestoredAt).toISOString() : '');

      const res = await syncAlbumIncremental({
        rootFolder: this.state.rootFolder,
        existingFolders: this.state.folders,
        existingFileIds: new Set(this._fileById.keys()),
        auth: isOAuth && accessToken ? { accessToken } : { apiKey: this.state.apiKey },
        startPageToken: this._startPageToken || '',
        syncWatermark: watermark,
        lastFullReconcileAt: this._lastFullReconcileAt || 0,
        forceFullReconcile: false,
        captureMetaFolder: isOAuth && Boolean(accessToken),
      });
      if (reqSeq !== this.connectSeq) return false;

      if (res?.mode === 'fallback-full') {
        if (res.fullResult) {
          const fullAlbum = {
            rootFolder: res.fullResult.rootFolder || this.state.rootFolder,
            folders: res.fullResult.folders || this.state.folders,
            files: res.fullResult.files || [],
            metaFolderId: res.fullResult.metaFolderId ?? this.state.metaFolderId,
            canWrite:
              typeof res.fullResult.canWrite === 'boolean'
                ? res.fullResult.canWrite
                : this.state.canWrite,
            startPageToken: res.nextStartPageToken || res.fullResult.startPageToken || '',
            syncWatermark:
              res.nextWatermark || res.fullResult.syncWatermark || new Date().toISOString(),
          };

          let membersData = this.state.membersData || {};
          let tagSchema = this.state.tagSchema || { version: 1, tags: {} };
          let tagSchemaFileId = this.state.tagSchemaFileId;
          let memberFilesById = this.state.memberFilesById || {};
          let localMetaSupported = this.state.localMetaSupported;
          const myId = this.state.currentUser?.id;

          if (isOAuth && accessToken && fullAlbum.metaFolderId) {
            const meta = await loadAlbumMetadata(fullAlbum.metaFolderId, accessToken);
            if (reqSeq !== this.connectSeq) return false;
            const merged = this._mergeFreshWithLocalEdits(
              membersData,
              meta.membersData || {},
              tagSchema,
              meta.tagSchema || { version: 1, tags: {} },
              myId
            );
            membersData = merged.mergedMembers;
            tagSchema = merged.mergedSchema;
            tagSchemaFileId = meta.tagSchemaFileId;
            memberFilesById = meta.memberFilesById;
          } else if (!isOAuth) {
            const serverMeta = await loadLocalServerMeta(folderId);
            if (reqSeq !== this.connectSeq) return false;
            if (serverMeta) {
              localMetaSupported = true;
              const merged = this._mergeFreshWithLocalEdits(
                membersData,
                serverMeta.membersData || {},
                tagSchema,
                serverMeta.tagSchema?.tags ? { version: 1, tags: serverMeta.tagSchema.tags } : { version: 1, tags: {} },
                myId
              );
              membersData = merged.mergedMembers;
              tagSchema = merged.mergedSchema;
            }
          }

          await setCachedAlbum(authType, folderId, {
            rootFolder: fullAlbum.rootFolder,
            folders: fullAlbum.folders,
            files: fullAlbum.files,
            metaFolderId: fullAlbum.metaFolderId,
            canWrite: fullAlbum.canWrite,
            tagSchemaFileId,
            tagSchema,
            memberFilesById,
            membersData,
            localMetaSupported,
            startPageToken: fullAlbum.startPageToken,
            syncWatermark: fullAlbum.syncWatermark,
            lastFullReconcileAt: Number(res.lastFullReconcileAt || Date.now()),
          });
          if (reqSeq !== this.connectSeq) return false;

          const hasPendingAfterFull =
            isOAuth &&
            fullAlbum.canWrite &&
            (this._unsyncedPhotoIds.size > 0 || this._unsyncedSchemaDirty);
          const msgKey = usingApiKeyAssist
            ? hasPendingAfterFull
              ? 'store.syncErrorAuth'
              : 'store.syncCachedSessionExpired'
            : isOAuth
              ? fullAlbum.canWrite
                ? 'store.syncOAuthSynced'
                : 'store.syncReadonly'
              : localMetaSupported
                ? 'store.syncApiKeySynced'
                : 'store.syncApiKeyLocal';

          this._commitLoadedAlbumState({
            authType,
            folderId,
            album: fullAlbum,
            tagSchema,
            tagSchemaFileId,
            memberFilesById,
            membersData,
            canWrite: fullAlbum.canWrite,
            localMetaSupported,
            syncStatus: usingApiKeyAssist
              ? hasPendingAfterFull
                ? 'error'
                : 'readonly'
              : isOAuth
                ? fullAlbum.canWrite
                  ? 'synced'
                  : 'readonly'
                : localMetaSupported
                  ? 'synced'
                  : 'readonly',
            syncMessageKey: msgKey,
            recent: this.state.recentAlbums,
          });
          if (showToast) {
            this.toast(
              t('store.loadedAlbumToast', {
                name: fullAlbum.rootFolder.name,
                count: fullAlbum.files.length,
              }),
              'success'
            );
          }
          return true;
        }

        if (isOAuth) {
          return this.connectGoogleDrive({
            clientId: this.state.clientId,
            folderInput: folderId,
            reuseSession: true,
            rememberCredentials: this.state.rememberCredentials,
            forceRescan: true,
          });
        }
        return this.connectWithApiKey({
          apiKey: this.state.apiKey,
          folderInput: folderId,
          nickname: this.state.nickname || this.state.currentUser?.name,
          rememberCredentials: this.state.rememberCredentials,
          forceRescan: true,
        });
      }

      if (res.nextStartPageToken !== undefined && res.nextStartPageToken !== null) {
        this._startPageToken = res.nextStartPageToken;
      }
      if (res.nextWatermark) {
        this._syncWatermark = res.nextWatermark;
      }
      if (res.lastFullReconcileAt) {
        this._lastFullReconcileAt = Number(res.lastFullReconcileAt);
      }

      const removedSet = new Set(res.removedFileIds || []);
      const upsertedMap = new Map();
      const normalizedUpserted = [];
      for (const rawFile of res.upsertedFiles || []) {
        const norm = this._normalizeFileRecord(rawFile);
        if (norm && norm.id) {
          upsertedMap.set(norm.id, norm);
          normalizedUpserted.push(norm);
        }
      }
      const deltaCount = upsertedMap.size + removedSet.size;

      let nextFiles = this.state.files;
      if (deltaCount > 0) {
        nextFiles = [];
        const pendingReplace = new Map(upsertedMap);
        for (let i = 0; i < this.state.files.length; i += 1) {
          const f = this.state.files[i];
          if (removedSet.has(f.id)) continue;
          const replacement = pendingReplace.get(f.id);
          if (replacement) {
            nextFiles.push(replacement);
            pendingReplace.delete(f.id);
          } else {
            nextFiles.push(f);
          }
        }
        for (const added of pendingReplace.values()) {
          nextFiles.push(added);
        }
      }

      const nextFolders =
        Array.isArray(res.folders) && res.folders.length > 0 ? res.folders : this.state.folders;
      const nextMetaFolderId = res.metaFolderId || this.state.metaFolderId;

      let membersData = this.state.membersData || {};
      let tagSchema = this.state.tagSchema || { version: 1, tags: {} };
      let tagSchemaFileId = this.state.tagSchemaFileId;
      let memberFilesById = this.state.memberFilesById || {};
      let localMetaSupported = this.state.localMetaSupported;
      let metaChanged = false;
      const myId = this.state.currentUser?.id;

      if (isOAuth && accessToken && nextMetaFolderId) {
        try {
          const meta = await loadAlbumMetadata(nextMetaFolderId, accessToken);
          if (reqSeq !== this.connectSeq) return false;
          const merged = this._mergeFreshWithLocalEdits(
            membersData,
            meta.membersData || {},
            tagSchema,
            meta.tagSchema || { version: 1, tags: {} },
            myId
          );
          membersData = merged.mergedMembers;
          tagSchema = merged.mergedSchema;
          tagSchemaFileId = meta.tagSchemaFileId;
          memberFilesById = meta.memberFilesById;
          if (myId && !membersData[myId]) {
            membersData[myId] = {
              version: 1,
              member: { ...this.state.currentUser, updatedAt: Date.now() },
              items: {},
            };
          }
          metaChanged = true;
        } catch {
          // Non-fatal; keep existing local metadata
        }
      } else if (!isOAuth) {
        try {
          const serverMeta = await loadLocalServerMeta(folderId);
          if (reqSeq !== this.connectSeq) return false;
          if (serverMeta) {
            localMetaSupported = true;
            const remoteSchema = serverMeta.tagSchema?.tags
              ? { version: 1, tags: serverMeta.tagSchema.tags }
              : { version: 1, tags: {} };
            const remoteMembers =
              serverMeta.membersData && typeof serverMeta.membersData === 'object'
                ? { ...serverMeta.membersData }
                : {};
            const merged = this._mergeFreshWithLocalEdits(
              membersData,
              remoteMembers,
              tagSchema,
              remoteSchema,
              myId
            );
            membersData = merged.mergedMembers;
            tagSchema = merged.mergedSchema;
            if (myId && !membersData[myId]) {
              membersData[myId] = {
                version: 1,
                member: { ...this.state.currentUser, updatedAt: Date.now() },
                items: {},
              };
            }
            try {
              localStorage.setItem(
                `drivelens_apikey_meta_${folderId}`,
                JSON.stringify({ tagSchema, membersData })
              );
            } catch {
              // Ignore
            }
            metaChanged = true;
          }
        } catch {
          // Non-fatal
        }
      }

      const metaPatch = {
        rootFolder: this.state.rootFolder,
        folders: nextFolders,
        metaFolderId: nextMetaFolderId,
        canWrite: this.state.canWrite,
        tagSchemaFileId,
        tagSchema,
        memberFilesById,
        membersData,
        localMetaSupported,
        startPageToken: this._startPageToken,
        syncWatermark: this._syncWatermark,
        lastFullReconcileAt: this._lastFullReconcileAt,
      };

      await applyCachedAlbumDelta(authType, folderId, {
        upsertedFiles: normalizedUpserted,
        removedFileIds: res.removedFileIds || [],
        metaPatch,
      }).catch(() => {});
      if (reqSeq !== this.connectSeq) return false;

      if (deltaCount > 0) {
        this._rebuildFileIndex(nextFiles);
      }

      const folderIds = new Set(nextFolders.map((f) => f.id));
      const nextSelectedIds =
        removedSet.size > 0
          ? new Set(Array.from(this.state.selectedPhotoIds).filter((id) => this._fileById.has(id)))
          : this.state.selectedPhotoIds;

      const hasPendingWrite =
        ((isOAuth && this.state.canWrite) || (!isOAuth && localMetaSupported)) &&
        (this._unsyncedPhotoIds.size > 0 || this._unsyncedSchemaDirty);
      const syncStatus = usingApiKeyAssist
        ? hasPendingWrite
          ? 'error'
          : 'readonly'
        : hasPendingWrite
          ? this.memberSyncTimer || this.schemaSyncTimer
            ? 'syncing'
            : 'error'
          : isOAuth
            ? this.state.canWrite
              ? 'synced'
              : 'readonly'
            : localMetaSupported
              ? 'synced'
              : 'readonly';
      const syncMessageKey = usingApiKeyAssist
        ? hasPendingWrite
          ? 'store.syncErrorAuth'
          : 'store.syncCachedSessionExpired'
        : hasPendingWrite
          ? this.memberSyncTimer || this.schemaSyncTimer
            ? 'store.syncSavingRatings'
            : isOAuth
              ? 'store.syncErrorAuth'
              : 'store.syncErrorLocal'
          : isOAuth
            ? this.state.canWrite
              ? 'store.syncOAuthSynced'
              : 'store.syncReadonly'
            : localMetaSupported
              ? 'store.syncApiKeySynced'
              : 'store.syncApiKeyLocal';

      const foldersChanged = nextFolders.length !== this.state.folders.length || nextFolders !== this.state.folders;
      const changeType = deltaCount > 0 || foldersChanged || metaChanged ? 'full' : 'ui-only';

      this.setState(
        {
          backgroundRefreshing: false,
          cacheRestoredAt: Date.now(),
          syncStatus,
          syncMessageKey,
          syncMessage: t(syncMessageKey),
          folders: nextFolders,
          files: nextFiles,
          metaFolderId: nextMetaFolderId,
          tagSchemaFileId,
          tagSchema,
          memberFilesById,
          membersData,
          localMetaSupported,
          activeFolderId: folderIds.has(this.state.activeFolderId)
            ? this.state.activeFolderId
            : this.state.rootFolder.id,
          selectedPhotoIds: nextSelectedIds,
          lastClickedPhotoId: this._fileById.has(this.state.lastClickedPhotoId)
            ? this.state.lastClickedPhotoId
            : null,
          focusedPhotoId: this._fileById.has(this.state.focusedPhotoId)
            ? this.state.focusedPhotoId
            : nextFiles[0]?.id || null,
          lightboxPhotoId: this._fileById.has(this.state.lightboxPhotoId)
            ? this.state.lightboxPhotoId
            : null,
        },
        { type: changeType, _skipFileIndexRebuild: true }
      );

      if (showToast) {
        if (deltaCount > 0) {
          this.toast(t('toast.syncUpdated', { count: deltaCount }), 'success');
        } else {
          this.toast(t('toast.syncUpToDate'), 'info');
        }
      }
      return true;
    } catch (err) {
      if (reqSeq !== this.connectSeq) return false;
      this.setState(
        {
          backgroundRefreshing: false,
          syncStatus: showToast ? 'error' : 'readonly',
          syncMessageKey: showToast
            ? isOAuth
              ? 'store.syncErrorAuth'
              : 'store.syncErrorLocal'
            : 'store.syncOfflineCached',
          syncMessage: t(
            showToast
              ? isOAuth
                ? 'store.syncErrorAuth'
                : 'store.syncErrorLocal'
              : 'store.syncOfflineCached'
          ),
        },
        { type: 'ui-only' }
      );
      if (showToast) {
        this.toast(err?.message || t('store.connectFailed'), 'error', 5000);
      }
      return false;
    }
  }

  async refreshAlbum({ fullRescan = false } = {}) {
    if (this.state.mode !== 'gdrive') {
      this.toast(t('store.refreshDemoNotice'), 'info');
      return;
    }
    if (!fullRescan && this.state.files.length > 0 && this.state.rootFolder) {
      const reqSeq = ++this.connectSeq;
      await this._performIncrementalSync({ reqSeq, showToast: true });
      return;
    }
    if (this.state.authType === 'apikey') {
      await this.connectWithApiKey({
        apiKey: this.state.apiKey,
        folderInput: this.state.folderId,
        nickname: this.state.nickname || this.state.currentUser?.name,
        rememberCredentials: this.state.rememberCredentials,
        forceRescan: true,
      });
      return;
    }
    await this.connectGoogleDrive({
      clientId: this.state.clientId,
      folderInput: this.state.folderId,
      reuseSession: true,
      rememberCredentials: this.state.rememberCredentials,
      forceRescan: true,
    });
  }

  disconnectGoogleDrive() {
    this.connectSeq += 1;
    this._clearSessionLifecycle();
    clearSession();
    this._startPageToken = '';
    this._syncWatermark = '';
    this._lastFullReconcileAt = 0;
    this._resetUnsyncedTracking();
    this._unsyncedPhotoIds = new Set();
    this._unsyncedSchemaDirty = false;
    this.setState({ accessToken: '', localMetaSupported: false, backgroundRefreshing: false });
    this.loadDemoMode(true, true);
  }

  _clearUrlHash() {
    try {
      const rawHash = window.location.hash || '';
      if (!rawHash) return;
      const body = rawHash.startsWith('#') ? rawHash.slice(1) : rawHash;
      const params = new URLSearchParams(body);
      params.delete('folder');
      params.delete('client_id');
      params.delete('key');
      params.delete('renewal_url');
      const rest = params.toString();
      const nextUrl = `${window.location.pathname}${window.location.search}${rest ? `#${rest}` : ''}`;
      window.history.replaceState(null, '', nextUrl);
    } catch {
      // Ignore
    }
  }

  _updateUrlHash(folderId, clientId) {
    try {
      const params = new URLSearchParams();
      if (folderId) params.set('folder', folderId);
      if (clientId && clientId !== APP_CONFIG.DEFAULT_CLIENT_ID) {
        params.set('client_id', clientId);
      }
      const nextHash = params.toString();
      if (nextHash) {
        window.history.replaceState(null, '', `#${nextHash}`);
      }
    } catch {
      // Ignore
    }
  }

  // ---------- Computed Selectors ----------

  getFolderDescendantIds(folderId) {
    const result = new Set([folderId]);
    let added = true;
    while (added) {
      added = false;
      for (const f of this.state.folders) {
        if (f.parentId && result.has(f.parentId) && !result.has(f.id)) {
          result.add(f.id);
          added = true;
        }
      }
    }
    return result;
  }

  getFolderPhotoCount(folderId, includeChildren = true) {
    if (!folderId) return 0;
    const scope = includeChildren ? this.getFolderDescendantIds(folderId) : new Set([folderId]);
    let count = 0;
    for (const file of this.state.files) {
      if (scope.has(file.parentId)) count += 1;
    }
    return count;
  }

  getActiveTagList() {
    const locale = getLocaleTag();
    const tags = Object.values(this.state.tagSchema?.tags || {});
    return tags
      .filter((item) => item && !item.deleted)
      .sort(
        (a, b) =>
          (a.group || '').localeCompare(b.group || '', locale) ||
          a.name.localeCompare(b.name, locale)
      );
  }

  getAggregatedItemMeta(fileId) {
    const membersData = this.state.membersData || {};
    const tagSchema = this.state.tagSchema;
    const myId = this.state.currentUser?.id || 'me';

    if (this._itemsByPhotoIdRef !== membersData) {
      this._rebuildItemsByPhotoId(membersData);
      this._aggMetaCache.clear();
      this._aggMetaRefs = { membersData, tagSchema, myId };
    } else {
      const refs = this._aggMetaRefs;
      if (!refs || refs.tagSchema !== tagSchema || refs.myId !== myId) {
        this._aggMetaCache.clear();
        this._aggMetaRefs = { membersData, tagSchema, myId };
      }
    }

    const perPhoto = this._itemsByPhotoId.get(fileId);
    if (!perPhoto || perPhoto.size === 0) {
      return EMPTY_META;
    }

    const cached = this._aggMetaCache.get(fileId);
    if (cached) return cached;

    const ratingsByMember = [];
    const notesByMember = [];
    const tagLatest = new Map();

    let sumRating = 0;
    let ratingCount = 0;
    let favoriteCount = 0;
    let myRating = 0;
    let myFavorite = false;
    let myNote = '';

    for (const [memberId, item] of perPhoto.entries()) {
      const memberInfo = membersData[memberId]?.member || {
        id: memberId,
        name: memberId,
        color: '#60a5fa',
      };
      const rating = Number(item?.rating || 0);
      const favorite = Boolean(item?.favorite);
      const note = String(item?.note || '');

      if (memberId === myId) {
        myRating = rating;
        myFavorite = favorite;
        myNote = note;
      }

      if (rating > 0) {
        sumRating += rating;
        ratingCount += 1;
      }
      if (favorite) {
        favoriteCount += 1;
      }

      if (rating > 0 || favorite) {
        ratingsByMember.push({
          member: { ...memberInfo, id: memberId },
          rating,
          favorite,
          updatedAt: Number(item?.updatedAt || 0),
        });
      }

      if (note.trim()) {
        notesByMember.push({
          member: { ...memberInfo, id: memberId },
          note,
          updatedAt: Number(item?.updatedAt || 0),
        });
      }

      if (item?.tags && typeof item.tags === 'object') {
        for (const [tagId, entry] of Object.entries(item.tags)) {
          const ts = Number(entry?.updatedAt || 0);
          const prev = tagLatest.get(tagId);
          if (!prev || ts >= prev.updatedAt) {
            tagLatest.set(tagId, { active: Boolean(entry?.active), updatedAt: ts });
          }
        }
      }
    }

    const schemaTags = tagSchema?.tags || {};
    const activeTagIds = [];
    for (const [tagId, status] of tagLatest.entries()) {
      const def = schemaTags[tagId];
      if (status.active && def && !def.deleted) {
        activeTagIds.push(tagId);
      }
    }

    if (ratingsByMember.length > 1) {
      ratingsByMember.sort((a, b) =>
        a.member.id === myId ? -1 : b.member.id === myId ? 1 : b.rating - a.rating
      );
    }

    const result = {
      myRating,
      myFavorite,
      myNote,
      avgRating: ratingCount > 0 ? sumRating / ratingCount : 0,
      ratingCount,
      favoriteCount,
      ratingsByMember,
      notesByMember,
      activeTagIds,
    };
    this._aggMetaCache.set(fileId, result);
    return result;
  }

  getLibraryStats() {
    const files = this.state.files || [];
    const totalCount = files.length;
    const membersData = this.state.membersData || {};
    const tagSchema = this.state.tagSchema;
    const myId = this.state.currentUser?.id || 'me';

    if (this._itemsByPhotoIdRef !== membersData) {
      this._rebuildItemsByPhotoId(membersData);
    }

    const cached = this._libraryStatsCache;
    if (
      cached &&
      cached.files === files &&
      cached.filesLen === totalCount &&
      cached.membersData === membersData &&
      cached.tagSchema === tagSchema &&
      cached.myId === myId
    ) {
      return cached.result;
    }

    let favTotal = 0;
    let ratedExistingCount = 0;
    for (const photoId of this._itemsByPhotoId.keys()) {
      if (!this._fileById.has(photoId)) continue;
      const meta = this.getAggregatedItemMeta(photoId);
      if (meta.favoriteCount > 0) favTotal += 1;
      if (meta.ratingCount > 0) ratedExistingCount += 1;
    }
    const unratedTotal = Math.max(0, totalCount - ratedExistingCount);
    const result = { totalCount, favTotal, unratedTotal };
    this._libraryStatsCache = {
      files,
      filesLen: totalCount,
      membersData,
      tagSchema,
      myId,
      result,
    };
    return result;
  }

  getMembersSummary() {
    const list = [];
    const seen = new Set();
    const entries = Object.entries(this.state.membersData || {});

    for (const [memberId, record] of entries) {
      seen.add(memberId);
      const items = Object.values(record?.items || {});
      let ratedCount = 0;
      let favoriteCount = 0;
      for (const it of items) {
        if (Number(it?.rating || 0) > 0) ratedCount += 1;
        if (it?.favorite) favoriteCount += 1;
      }
      list.push({
        id: memberId,
        name: record?.member?.name || memberId,
        picture: record?.member?.picture || '',
        color: record?.member?.color || '#38bdf8',
        ratedCount,
        favoriteCount,
      });
    }

    const me = this.state.currentUser;
    if (me && !seen.has(me.id)) {
      list.unshift({
        id: me.id,
        name: me.name,
        picture: me.picture || '',
        color: me.color || '#38bdf8',
        ratedCount: 0,
        favoriteCount: 0,
      });
    }

    return list;
  }

  getTagCounts() {
    const membersData = this.state.membersData || {};
    if (this._itemsByPhotoIdRef !== membersData) {
      this._rebuildItemsByPhotoId(membersData);
    }
    const counts = {};
    for (const photoId of this._itemsByPhotoId.keys()) {
      if (!this._fileById.has(photoId)) continue;
      const meta = this.getAggregatedItemMeta(photoId);
      for (const tagId of meta.activeTagIds) {
        counts[tagId] = (counts[tagId] || 0) + 1;
      }
    }
    return counts;
  }

  getVisiblePhotos() {
    const {
      files,
      folders,
      membersData,
      tagSchema,
      currentUser,
      activeFolderId,
      includeSubfolders,
      quickView,
      mediaFilter,
      aspectFilter,
      ratingScope,
      minRating,
      memberFilterId,
      selectedTagIds,
      tagMatchMode,
      searchQuery,
      sortBy,
      lang,
    } = this.state;

    const myId = currentUser?.id || '';
    const tagList = Array.from(selectedTagIds);
    const tagKey = tagList.length > 0 ? [...tagList].sort().join(',') : '';
    const query = searchQuery.trim().toLowerCase();
    const dependsOnMeta =
      quickView === 'favorites' ||
      quickView === 'unrated' ||
      minRating > 0 ||
      Boolean(memberFilterId) ||
      tagList.length > 0 ||
      sortBy === 'ratingDesc' ||
      sortBy === 'ratingAsc' ||
      Boolean(query);

    const cached = this._visiblePhotosCache;
    if (
      cached &&
      cached.files === files &&
      cached.filesLen === files.length &&
      cached.folders === folders &&
      cached.foldersLen === folders.length &&
      (!dependsOnMeta ||
        (cached.membersData === membersData &&
          cached.tagSchema === tagSchema &&
          cached.myId === myId)) &&
      cached.activeFolderId === activeFolderId &&
      cached.includeSubfolders === includeSubfolders &&
      cached.quickView === quickView &&
      cached.mediaFilter === mediaFilter &&
      cached.aspectFilter === aspectFilter &&
      cached.ratingScope === ratingScope &&
      cached.minRating === minRating &&
      cached.memberFilterId === memberFilterId &&
      cached.tagKey === tagKey &&
      cached.tagMatchMode === tagMatchMode &&
      cached.searchQuery === searchQuery &&
      cached.sortBy === sortBy &&
      cached.lang === lang
    ) {
      return cached.result;
    }

    const allowedFolderIds = activeFolderId
      ? includeSubfolders
        ? this.getFolderDescendantIds(activeFolderId)
        : new Set([activeFolderId])
      : null;

    const schemaTags = tagSchema?.tags || {};
    const locale = getLocaleTag();
    const sortByRating = sortBy === 'ratingDesc' || sortBy === 'ratingAsc';
    const nameCollator =
      sortBy === 'nameAsc' || sortBy === 'nameDesc' ? getNameCollator(locale) : null;
    const activeTagSet = tagList.length > 0 ? new Set(tagList) : null;
    const memberItemsMap =
      ratingScope === 'member' && memberFilterId
        ? membersData?.[memberFilterId]?.items || null
        : null;

    const matched = [];
    for (let i = 0; i < files.length; i += 1) {
      const file = files[i];
      if (allowedFolderIds && !allowedFolderIds.has(file.parentId)) continue;

      const isVideo =
        typeof file._isVideo === 'boolean'
          ? file._isVideo
          : Boolean(file.mimeType && file.mimeType.startsWith('video/'));
      if (mediaFilter === 'photo' && isVideo) continue;
      if (mediaFilter === 'video' && !isVideo) continue;

      if (aspectFilter && aspectFilter !== 'all') {
        const ratio =
          typeof file._aspect === 'number' ? file._aspect : normalizeAspectRatio(file);
        if (aspectFilter === 'landscape' && ratio <= 1.08) continue;
        if (aspectFilter === 'portrait' && ratio >= 0.92) continue;
        if (aspectFilter === 'square' && (ratio < 0.92 || ratio > 1.08)) continue;
      }

      if (!dependsOnMeta) {
        matched.push(file);
        continue;
      }

      const meta = this.getAggregatedItemMeta(file.id);

      if (quickView === 'favorites' && meta.favoriteCount === 0) continue;
      if (quickView === 'unrated' && meta.ratingCount > 0) continue;

      if (ratingScope === 'member' && memberFilterId) {
        const memberItem = memberItemsMap?.[file.id];
        const mRating = Number(memberItem?.rating || 0);
        const mFav = Boolean(memberItem?.favorite);
        const mNote = String(memberItem?.note || '').trim();
        if (minRating > 0) {
          if (mRating < minRating) continue;
        } else if (mRating === 0 && !mFav && !mNote) {
          continue;
        }
      } else if (minRating > 0) {
        const targetScore = ratingScope === 'mine' ? meta.myRating : meta.avgRating;
        if (targetScore < minRating) continue;
      }

      if (activeTagSet) {
        const itemTags = meta.activeTagIds;
        if (tagMatchMode === 'AND') {
          if (itemTags.length < tagList.length) continue;
          const itemSet = new Set(itemTags);
          let allOk = true;
          for (let k = 0; k < tagList.length; k += 1) {
            if (!itemSet.has(tagList[k])) {
              allOk = false;
              break;
            }
          }
          if (!allOk) continue;
        } else {
          let anyOk = false;
          for (let k = 0; k < itemTags.length; k += 1) {
            if (activeTagSet.has(itemTags[k])) {
              anyOk = true;
              break;
            }
          }
          if (!anyOk) continue;
        }
      }

      if (query) {
        let baseHaystack = file._searchHaystack;
        if (typeof baseHaystack !== 'string') {
          const exif = file.imageMediaMetadata || {};
          const camText = `${exif.cameraMake || ''} ${exif.cameraModel || ''} ${exif.focalLength ? `${exif.focalLength}mm` : ''} ${exif.isoSpeed ? `iso${exif.isoSpeed}` : ''}`;
          const ts = getPhotoTimestamp(file);
          const dateStr = ts > 0 ? new Date(ts).toISOString().slice(0, 10) : '';
          const dateSlash = dateStr ? dateStr.replace(/-/g, '/') : '';
          baseHaystack = `${file.name || ''} ${camText} ${dateStr} ${dateSlash}`.toLowerCase();
          file._searchHaystack = baseHaystack;
        }
        if (!baseHaystack.includes(query)) {
          let extraMatch = false;
          if (meta.notesByMember.length > 0) {
            for (let k = 0; k < meta.notesByMember.length; k += 1) {
              if (meta.notesByMember[k].note.toLowerCase().includes(query)) {
                extraMatch = true;
                break;
              }
            }
          }
          if (!extraMatch && meta.activeTagIds.length > 0) {
            for (let k = 0; k < meta.activeTagIds.length; k += 1) {
              const tName = schemaTags[meta.activeTagIds[k]]?.name;
              if (tName && tName.toLowerCase().includes(query)) {
                extraMatch = true;
                break;
              }
            }
          }
          if (!extraMatch) continue;
        }
      }

      if (sortByRating) {
        matched.push({
          file,
          avgRating: meta.avgRating,
          ratingCount: meta.ratingCount,
          ts: getPhotoTimestamp(file),
        });
      } else {
        matched.push(file);
      }
    }

    if (sortByRating) {
      matched.sort((a, b) => {
        if (sortBy === 'ratingDesc') {
          const diff = b.avgRating - a.avgRating;
          if (Math.abs(diff) > 0.001) return diff;
          return b.ratingCount - a.ratingCount || b.ts - a.ts;
        }
        const diff = a.avgRating - b.avgRating;
        if (Math.abs(diff) > 0.001) return diff;
        return a.ratingCount - b.ratingCount || a.ts - b.ts;
      });
    } else {
      matched.sort((a, b) => {
        switch (sortBy) {
          case 'dateAsc':
            return getPhotoTimestamp(a) - getPhotoTimestamp(b);
          case 'nameAsc':
            return nameCollator.compare(a.name || '', b.name || '');
          case 'nameDesc':
            return nameCollator.compare(b.name || '', a.name || '');
          case 'sizeDesc':
            return (b.size || 0) - (a.size || 0);
          case 'sizeAsc':
            return (a.size || 0) - (b.size || 0);
          case 'dateDesc':
          default:
            return getPhotoTimestamp(b) - getPhotoTimestamp(a);
        }
      });
    }

    const result = sortByRating ? matched.map((x) => x.file) : matched;
    this.visiblePhotosVersion += 1;
    this._visiblePhotosCache = {
      files,
      filesLen: files.length,
      folders,
      foldersLen: folders.length,
      membersData,
      tagSchema,
      myId,
      activeFolderId,
      includeSubfolders,
      quickView,
      mediaFilter,
      aspectFilter,
      ratingScope,
      minRating,
      memberFilterId,
      tagKey,
      tagMatchMode,
      searchQuery,
      sortBy,
      lang,
      result,
    };
    return result;
  }

  // ---------- Mutation Actions (0ms Optimistic UI + Debounced Sync) ----------

  _ensureMyRecord() {
    const me = this.state.currentUser;
    const myId = me.id;
    const existing = this.state.membersData[myId] || {
      version: 1,
      member: { ...me, updatedAt: Date.now() },
      items: {},
    };
    return {
      myId,
      record: {
        ...existing,
        member: { ...me, updatedAt: Date.now() },
        items: { ...existing.items },
      },
    };
  }

  _persistChanges({ memberDirty = false, schemaDirty = false, deferEmit = false }) {
    if (this.state.mode === 'demo') {
      saveDemoState({
        tagSchema: this.state.tagSchema,
        membersData: this.state.membersData,
        activePersonaId: this.state.currentUser.id,
      });
      return;
    }

    this._scheduleAlbumMetaOnlyCacheUpdate();

    const applySyncPatch = (syncPatch) => {
      if (deferEmit) {
        this.state = { ...this.state, ...syncPatch };
      } else {
        this.setState(syncPatch, { type: 'ui-only' });
      }
    };

    if (this.state.mode === 'gdrive' && this.state.authType === 'apikey') {
      try {
        localStorage.setItem(
          `drivelens_apikey_meta_${this.state.folderId}`,
          JSON.stringify({
            tagSchema: this.state.tagSchema,
            membersData: this.state.membersData,
          })
        );
      } catch {
        // Ignore
      }

      if (!this.state.localMetaSupported) {
        applySyncPatch({
          syncStatus: 'readonly',
          syncMessageKey: 'store.syncApiKeyLocal',
          syncMessage: t('store.syncApiKeyLocal'),
        });
        return;
      }

      if (memberDirty || schemaDirty) {
        clearTimeout(this.memberSyncTimer);
        clearTimeout(this.schemaSyncTimer);
        applySyncPatch({
          syncStatus: 'syncing',
          syncMessageKey: 'store.syncSavingRatings',
          syncMessage: t('store.syncSavingRatings'),
        });
        this.memberSyncTimer = setTimeout(() => {
          this.memberSyncTimer = null;
          this._flushApiKeyMetaSync();
        }, APP_CONFIG.SYNC_DEBOUNCE_MS);
      }
      return;
    }

    if (!this.state.canWrite) {
      const myId = this.state.currentUser.id;
      try {
        localStorage.setItem(
          `drivelens_readonly_${this.state.folderId}_${myId}`,
          JSON.stringify({
            memberData: this.state.membersData[myId],
            tagSchema: this.state.tagSchema,
          })
        );
      } catch {
        // Ignore
      }
      applySyncPatch({
        syncStatus: 'readonly',
        syncMessageKey: 'store.syncReadonlySaved',
        syncMessage: t('store.syncReadonlySaved'),
      });
      return;
    }

    if (memberDirty) {
      clearTimeout(this.memberSyncTimer);
      applySyncPatch({
        syncStatus: 'syncing',
        syncMessageKey: 'store.syncSavingRatings',
        syncMessage: t('store.syncSavingRatings'),
      });
      this.memberSyncTimer = setTimeout(() => {
        this.memberSyncTimer = null;
        this._flushMemberSync();
      }, APP_CONFIG.SYNC_DEBOUNCE_MS);
    }

    if (schemaDirty) {
      clearTimeout(this.schemaSyncTimer);
      applySyncPatch({
        syncStatus: 'syncing',
        syncMessageKey: 'store.syncSavingTags',
        syncMessage: t('store.syncSavingTags'),
      });
      this.schemaSyncTimer = setTimeout(() => {
        this.schemaSyncTimer = null;
        this._flushSchemaSync();
      }, APP_CONFIG.SYNC_DEBOUNCE_MS);
    }
  }

  async _flushApiKeyMetaSync() {
    if (
      this.state.mode !== 'gdrive' ||
      this.state.authType !== 'apikey' ||
      !this.state.localMetaSupported ||
      !this.state.folderId
    ) {
      return;
    }
    const myId = this.state.currentUser.id;
    const memberRecord = this.state.membersData[myId];
    const syncedIds = Array.from(this._unsyncedPhotoIds);
    const sentSchema = this.state.tagSchema;

    try {
      const res = await saveLocalServerMeta({
        folderId: this.state.folderId,
        memberId: myId,
        memberRecord,
        tagSchema: sentSchema,
      });

      if (!res) {
        this.setState({
          localMetaSupported: false,
          syncStatus: 'readonly',
          syncMessageKey: 'store.syncApiKeyLocal',
          syncMessage: t('store.syncApiKeyLocal'),
        });
        return;
      }

      for (const id of syncedIds) {
        const sentTs = memberRecord?.items?.[id]?.updatedAt || 0;
        const curTs = this.state.membersData[myId]?.items?.[id]?.updatedAt || 0;
        if (curTs <= sentTs) {
          this._unsyncedPhotoIds.delete(id);
        }
      }
      if (this.state.tagSchema === sentSchema) {
        this._unsyncedSchemaDirty = false;
      }

      const mergedSchema = res.tagSchema?.tags
        ? mergeTagSchemas(this.state.tagSchema, res.tagSchema)
        : this.state.tagSchema;
      const mergedMembers = {
        ...(res.membersData || {}),
        [myId]: this.state.membersData[myId] || res.membersData?.[myId],
      };

      try {
        localStorage.setItem(
          `drivelens_apikey_meta_${this.state.folderId}`,
          JSON.stringify({ tagSchema: mergedSchema, membersData: mergedMembers })
        );
      } catch {
        // Ignore
      }

      this.setState({
        tagSchema: mergedSchema,
        membersData: mergedMembers,
        syncStatus: 'synced',
        syncMessageKey: 'store.syncApiKeySynced',
        syncMessage: t('store.syncApiKeySynced'),
      });
      this._scheduleAlbumMetaOnlyCacheUpdate();
    } catch (err) {
      this.setState({
        syncStatus: 'error',
        syncMessageKey: 'store.syncErrorLocal',
        syncMessage: t('store.syncErrorLocal'),
      });
      this.toast(err?.message || t('store.syncRatingsFailed'), 'error');
    }
  }

  async _flushMemberSync() {
    if (this.state.authType === 'apikey') {
      return this._flushApiKeyMetaSync();
    }
    if (this.state.mode !== 'gdrive' || !this.state.canWrite) return;
    if (!this.state.accessToken) {
      if (this._unsyncedPhotoIds.size > 0 || this.state.syncStatus === 'syncing') {
        this.setState(
          {
            syncStatus: 'error',
            syncMessageKey: 'store.syncErrorAuth',
            syncMessage: t('store.syncErrorAuth'),
          },
          { type: 'ui-only' }
        );
      }
      return;
    }
    const myId = this.state.currentUser.id;
    const payload = this.state.membersData[myId];
    if (!payload) return;
    const syncedIds = Array.from(this._unsyncedPhotoIds);

    try {
      const res = await saveMemberMetadata({
        rootFolderId: this.state.folderId,
        metaFolderId: this.state.metaFolderId,
        existingFileId: this.state.memberFilesById[myId] || null,
        memberKey: sanitizeMemberKey(myId),
        payload,
        accessToken: this.state.accessToken,
      });
      for (const id of syncedIds) {
        const sentTs = payload?.items?.[id]?.updatedAt || 0;
        const curTs = this.state.membersData[myId]?.items?.[id]?.updatedAt || 0;
        if (curTs <= sentTs) {
          this._unsyncedPhotoIds.delete(id);
        }
      }
      this.setState(
        {
          metaFolderId: res.metaFolderId,
          memberFilesById: { ...this.state.memberFilesById, [myId]: res.fileId },
          syncStatus: 'synced',
          syncMessageKey: 'store.syncOAuthUpdated',
          syncMessage: t('store.syncOAuthUpdated'),
        },
        { type: 'ui-only' }
      );
      this._scheduleAlbumMetaOnlyCacheUpdate();
    } catch (err) {
      this.setState({
        syncStatus: 'error',
        syncMessageKey: 'store.syncErrorAuth',
        syncMessage: t('store.syncErrorAuth'),
      });
      this.toast(err?.message || t('store.syncRatingsFailed'), 'error');
    }
  }

  async _flushSchemaSync() {
    if (this.state.authType === 'apikey') {
      return this._flushApiKeyMetaSync();
    }
    if (this.state.mode !== 'gdrive' || !this.state.canWrite) return;
    if (!this.state.accessToken) {
      if (this._unsyncedSchemaDirty || this.state.syncStatus === 'syncing') {
        this.setState(
          {
            syncStatus: 'error',
            syncMessageKey: 'store.syncTagsErrorShort',
            syncMessage: t('store.syncTagsErrorShort'),
          },
          { type: 'ui-only' }
        );
      }
      return;
    }
    const sentSchema = this.state.tagSchema;
    try {
      const res = await saveTagSchema({
        rootFolderId: this.state.folderId,
        metaFolderId: this.state.metaFolderId,
        existingFileId: this.state.tagSchemaFileId,
        localSchema: sentSchema,
        accessToken: this.state.accessToken,
      });
      if (this.state.tagSchema === sentSchema) {
        this._unsyncedSchemaDirty = false;
      }
      this.setState({
        metaFolderId: res.metaFolderId,
        tagSchemaFileId: res.fileId,
        tagSchema: res.mergedSchema,
        syncStatus: 'synced',
        syncMessageKey: 'store.syncTagsUpdated',
        syncMessage: t('store.syncTagsUpdated'),
      });
      this._scheduleAlbumMetaOnlyCacheUpdate();
    } catch (err) {
      this.setState({
        syncStatus: 'error',
        syncMessageKey: 'store.syncTagsErrorShort',
        syncMessage: t('store.syncTagsErrorShort'),
      });
      this.toast(err?.message || t('store.syncTagsFailed'), 'error');
    }
  }

  getSyncIndicatorState() {
    const s = this.state;
    if (s.mode !== 'gdrive') {
      return {
        level: 'demo',
        badgeCount: 0,
        isSpinning: false,
        title: t('header.syncDemo'),
        shortLabel: '',
      };
    }

    const pendingCount = this._unsyncedPhotoIds.size + (this._unsyncedSchemaDirty ? 1 : 0);
    const isReadonlyOrStaticApiKey =
      !s.canWrite || (s.authType === 'apikey' && !s.localMetaSupported);
    const myId = s.currentUser?.id;
    const localOnlyEditCount = isReadonlyOrStaticApiKey
      ? Object.keys((myId && s.membersData?.[myId]?.items) || {}).length
      : 0;

    if (s.loading || s.backgroundRefreshing || s.syncStatus === 'syncing') {
      return {
        level: 'syncing',
        badgeCount: pendingCount,
        isSpinning: true,
        title: s.syncMessage || t('header.syncSyncing'),
        shortLabel: '',
      };
    }

    const isOAuthMissingToken = s.authType === 'oauth' && !s.accessToken;

    if (isOAuthMissingToken) {
      if (pendingCount > 0) {
        return {
          level: 'danger',
          badgeCount: pendingCount,
          isSpinning: false,
          title: t('header.syncExpiredUnsyncedTitle', { count: pendingCount }),
          shortLabel: t('header.syncUnsyncedShort'),
        };
      }
      return {
        level: 'warn',
        badgeCount: 1,
        isSpinning: false,
        title: t('header.syncSessionExpiredClick'),
        shortLabel: t('header.syncReconnectShort'),
      };
    }

    if (s.syncStatus === 'error') {
      const count = Math.max(1, pendingCount);
      return {
        level: 'danger',
        badgeCount: count,
        isSpinning: false,
        title: t('header.syncDangerTitle', { count }),
        shortLabel: t('header.syncUnsyncedShort'),
      };
    }

    if (isReadonlyOrStaticApiKey && (pendingCount > 0 || localOnlyEditCount > 0)) {
      const count = pendingCount || localOnlyEditCount;
      return {
        level: 'warn',
        badgeCount: count,
        isSpinning: false,
        title: t('header.syncLocalOnlyTitle', { count }),
        shortLabel: t('header.syncLocalShort'),
      };
    }

    return {
      level: 'synced',
      badgeCount: 0,
      isSpinning: false,
      title: t('header.syncHealthyTitle'),
      shortLabel: '',
    };
  }

  hasUnsavedCloudChanges() {
    return Boolean(
      this.state.mode === 'gdrive' &&
        (this.memberSyncTimer ||
          this.schemaSyncTimer ||
          (this.state.canWrite &&
            (this.state.authType === 'oauth' || this.state.localMetaSupported) &&
            (this._unsyncedPhotoIds.size > 0 || this._unsyncedSchemaDirty)))
    );
  }

  async retryOrSyncNow({ fullRescan = false } = {}) {
    if (this.state.mode !== 'gdrive') {
      return this.refreshAlbum({ fullRescan });
    }

    if (this.state.authType === 'oauth' && !this.state.accessToken) {
      if (!this.state.clientId) {
        this.openModal('connect');
        this.toast(t('toast.reauthToSync'), 'info');
        return false;
      }

      const promptInteractiveAuth = async () => {
        try {
          return await authenticateGoogle(this.state.clientId, {
            prompt: '',
            loginHint:
              this.state.savedOAuthUser?.email || this.state.currentUser?.email || '',
            remember: this.state.rememberCredentials,
            tokenRenewalUrl: this.state.tokenRenewalUrl,
            allowSilentFirst: false,
          });
        } catch (err) {
          this.openModal('connect');
          this.toast(
            err?.isPopupBlocked
              ? t('gdrive.popupBlockedRedirectHint')
              : err?.message || t('toast.reauthToSync'),
            err?.isPopupBlocked ? 'error' : 'info',
            err?.isPopupBlocked ? 6000 : 3200
          );
          return null;
        }
      };

      let session = getCachedSession(this.state.clientId);
      const canTrySilent =
        !session &&
        this.state.tokenRenewalUrl &&
        hasStoredRenewalTicket(this.state.clientId, this.state.tokenRenewalUrl) &&
        !this._silentRenewalExhausted;

      if (!session && canTrySilent) {
        session = await renewOAuthSessionSilently(
          this.state.clientId,
          this.state.tokenRenewalUrl,
          { remember: this.state.rememberCredentials }
        );
        if (!session) {
          this._silentRenewalExhausted = true;
        }
      }

      if (!session) {
        session = await promptInteractiveAuth();
        if (!session) return false;
      }
      this._silentRenewalExhausted = false;

      const remember = this.state.rememberCredentials !== false;
      const nextSavedUser = remember
        ? getSavedOAuthUser(this.state.clientId) || {
            clientId: this.state.clientId,
            id: session.user.id,
            email: session.user.email,
            name: session.user.name,
            picture: session.user.picture,
            color: session.user.color,
          }
        : this.state.savedOAuthUser;

      this.setState({
        accessToken: session.accessToken,
        currentUser: session.user,
        savedOAuthUser: nextSavedUser,
      });
      this._scheduleSessionLifecycle(session.expiresAt);

      const hadMemberTimer = Boolean(this.memberSyncTimer);
      if (this.memberSyncTimer) {
        clearTimeout(this.memberSyncTimer);
        this.memberSyncTimer = null;
      }
      const hadSchemaTimer = Boolean(this.schemaSyncTimer);
      if (this.schemaSyncTimer) {
        clearTimeout(this.schemaSyncTimer);
        this.schemaSyncTimer = null;
      }

      if (this.state.canWrite && (this._unsyncedPhotoIds.size > 0 || hadMemberTimer)) {
        await this._flushMemberSync();
      }
      if (this.state.canWrite && (this._unsyncedSchemaDirty || hadSchemaTimer)) {
        await this._flushSchemaSync();
      }

      await this.refreshAlbum({ fullRescan });
      this.toast(t('toast.sessionRenewedSynced'), 'success');
      return true;
    }

    let flushedAny = false;
    if (this.memberSyncTimer) {
      clearTimeout(this.memberSyncTimer);
      this.memberSyncTimer = null;
      await this._flushMemberSync();
      flushedAny = true;
    }
    if (this.schemaSyncTimer) {
      clearTimeout(this.schemaSyncTimer);
      this.schemaSyncTimer = null;
      await this._flushSchemaSync();
      flushedAny = true;
    }

    if (this.state.authType === 'apikey' && this.state.localMetaSupported && !flushedAny) {
      await this._flushApiKeyMetaSync();
    }

    const myItems = this.state.membersData?.[this.state.currentUser?.id]?.items || {};
    if (
      (!this.state.canWrite || (this.state.authType === 'apikey' && !this.state.localMetaSupported)) &&
      (this._unsyncedPhotoIds.size > 0 || Object.keys(myItems).length > 0)
    ) {
      this.toast(t('toast.localOnlySyncHint'), 'info', 4200);
      await this.refreshAlbum({ fullRescan });
      return true;
    }

    if (this.state.authType === 'oauth' && this.state.canWrite && this.state.accessToken) {
      if (this._unsyncedPhotoIds.size > 0) {
        await this._flushMemberSync();
      }
      if (this._unsyncedSchemaDirty) {
        await this._flushSchemaSync();
      }
    }

    await this.refreshAlbum({ fullRescan });
    return true;
  }

  _commitLocalItemEdits(ids, myId, record) {
    if (this._itemsByPhotoIdRef !== this.state.membersData) {
      this._rebuildItemsByPhotoId(this.state.membersData);
    }
    const mutatedSet = new Set(ids);
    if (this.state.mode === 'gdrive') {
      for (const fid of mutatedSet) {
        this._unsyncedPhotoIds.add(fid);
      }
    }
    for (const fid of mutatedSet) {
      let perPhoto = this._itemsByPhotoId.get(fid);
      if (!perPhoto) {
        perPhoto = new Map();
        this._itemsByPhotoId.set(fid, perPhoto);
      }
      perPhoto.set(myId, record.items[fid]);
      this._aggMetaCache.delete(fid);
    }
    const nextMembersData = { ...this.state.membersData, [myId]: record };
    this._itemsByPhotoIdRef = nextMembersData;
    if (this._aggMetaRefs) {
      this._aggMetaRefs.membersData = nextMembersData;
    }
    this._libraryStatsCache = null;
    this.state = { ...this.state, membersData: nextMembersData };
    this._persistChanges({ memberDirty: true, deferEmit: true });
    this.lastChange = {
      type: 'meta-only',
      photoIds: mutatedSet,
      seq: ++this._changeSeq,
    };
    this.emit();
  }

  setRating(photoIds, rating) {
    const ids = Array.isArray(photoIds) ? photoIds : [photoIds];
    if (ids.length === 0) return;

    const nextRating = Math.max(0, Math.min(5, Number(rating || 0)));
    const { myId, record } = this._ensureMyRecord();
    const now = Date.now();

    for (const fid of ids) {
      const prev = record.items[fid] || { rating: 0, favorite: false, note: '', tags: {} };
      record.items[fid] = {
        ...prev,
        rating: nextRating,
        updatedAt: now,
      };
    }

    this._commitLocalItemEdits(ids, myId, record);
  }

  toggleFavorite(photoIds, forceState = null) {
    const ids = Array.isArray(photoIds) ? photoIds : [photoIds];
    if (ids.length === 0) return;

    const { myId, record } = this._ensureMyRecord();
    const now = Date.now();
    const firstMeta = this.getAggregatedItemMeta(ids[0]);
    const nextFav = forceState !== null ? Boolean(forceState) : !firstMeta.myFavorite;

    for (const fid of ids) {
      const prev = record.items[fid] || { rating: 0, favorite: false, note: '', tags: {} };
      record.items[fid] = {
        ...prev,
        favorite: nextFav,
        updatedAt: now,
      };
    }

    this._commitLocalItemEdits(ids, myId, record);
  }

  toggleTagOnPhotos(photoIds, tagId, forceState = null) {
    const ids = Array.isArray(photoIds) ? photoIds : [photoIds];
    if (ids.length === 0 || !tagId) return;

    const { myId, record } = this._ensureMyRecord();
    const now = Date.now();

    let nextActive = forceState;
    if (nextActive === null) {
      const firstActive = this.getAggregatedItemMeta(ids[0]).activeTagIds.includes(tagId);
      nextActive = !firstActive;
    }

    for (const fid of ids) {
      const prev = record.items[fid] || { rating: 0, favorite: false, note: '', tags: {} };
      record.items[fid] = {
        ...prev,
        tags: {
          ...(prev.tags || {}),
          [tagId]: { active: Boolean(nextActive), updatedAt: now },
        },
        updatedAt: now,
      };
    }

    this._commitLocalItemEdits(ids, myId, record);
  }

  setMyNote(photoId, note) {
    if (!photoId) return;
    const { myId, record } = this._ensureMyRecord();
    const prev = record.items[photoId] || { rating: 0, favorite: false, note: '', tags: {} };
    record.items[photoId] = {
      ...prev,
      note: String(note || ''),
      updatedAt: Date.now(),
    };
    this._commitLocalItemEdits([photoId], myId, record);
  }

  upsertTagDefinition({ id = null, name, color = 'blue', group = '' }) {
    const trimmed = String(name || '').trim();
    if (!trimmed) {
      this.toast(t('store.emptyTagName'), 'error');
      return null;
    }

    const now = Date.now();
    const tagId = id || `tag-${now.toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const prevTag = this.state.tagSchema?.tags?.[tagId];

    const nextTag = {
      id: tagId,
      name: trimmed,
      color,
      group: String(group || '').trim() || t('store.defaultTagGroup'),
      deleted: false,
      updatedAt: now,
      createdBy: prevTag?.createdBy || this.state.currentUser.id,
    };

    const nextSchema = {
      version: 1,
      tags: {
        ...(this.state.tagSchema?.tags || {}),
        [tagId]: nextTag,
      },
    };

    if (this.state.mode === 'gdrive') {
      this._unsyncedSchemaDirty = true;
    }
    this.setState({ tagSchema: nextSchema });
    this._persistChanges({ schemaDirty: true });
    this.toast(
      t(id ? 'store.tagUpdatedToast' : 'store.tagCreatedToast', { name: trimmed }),
      'success'
    );
    return nextTag;
  }

  deleteTagDefinition(tagId) {
    const existing = this.state.tagSchema?.tags?.[tagId];
    if (!existing) return;

    const nextSchema = {
      version: 1,
      tags: {
        ...this.state.tagSchema.tags,
        [tagId]: {
          ...existing,
          deleted: true,
          updatedAt: Date.now(),
        },
      },
    };

    const nextSelectedTags = new Set(this.state.selectedTagIds);
    nextSelectedTags.delete(tagId);

    if (this.state.mode === 'gdrive') {
      this._unsyncedSchemaDirty = true;
    }
    this.setState({
      tagSchema: nextSchema,
      selectedTagIds: nextSelectedTags,
    });
    this._persistChanges({ schemaDirty: true });
    this.toast(t('store.tagDeletedToast', { name: existing.name }), 'info');
  }

  // ---------- Selection & UI Actions ----------

  getActionTargetPhotoIds() {
    if (this.state.lightboxPhotoId) return [this.state.lightboxPhotoId];
    if (this.state.selectedPhotoIds.size > 0) return Array.from(this.state.selectedPhotoIds);
    if (this.state.focusedPhotoId) return [this.state.focusedPhotoId];
    return [];
  }

  selectPhoto(photoId, { ctrl = false, shift = false } = {}) {
    const visible = this.getVisiblePhotos();
    const nextSelected = new Set(this.state.selectedPhotoIds);

    if (shift && this.state.lastClickedPhotoId) {
      const idx1 = visible.findIndex((p) => p.id === this.state.lastClickedPhotoId);
      const idx2 = visible.findIndex((p) => p.id === photoId);
      if (idx1 !== -1 && idx2 !== -1) {
        const start = Math.min(idx1, idx2);
        const end = Math.max(idx1, idx2);
        if (!ctrl) nextSelected.clear();
        for (let i = start; i <= end; i += 1) {
          nextSelected.add(visible[i].id);
        }
        this.setState({
          selectedPhotoIds: nextSelected,
          focusedPhotoId: photoId,
        });
        return;
      }
    }

    if (ctrl) {
      if (nextSelected.has(photoId)) {
        nextSelected.delete(photoId);
      } else {
        nextSelected.add(photoId);
      }
      this.setState({
        selectedPhotoIds: nextSelected,
        focusedPhotoId: photoId,
        lastClickedPhotoId: photoId,
      });
      return;
    }

    this.setState({
      selectedPhotoIds: new Set(),
      focusedPhotoId: photoId,
      lastClickedPhotoId: photoId,
    });
  }

  toggleSelectCheckbox(photoId) {
    const next = new Set(this.state.selectedPhotoIds);
    if (next.has(photoId)) next.delete(photoId);
    else next.add(photoId);
    this.setState({
      selectedPhotoIds: next,
      focusedPhotoId: photoId,
      lastClickedPhotoId: photoId,
    });
  }

  selectAllVisible() {
    const visible = this.getVisiblePhotos();
    this.setState({
      selectedPhotoIds: new Set(visible.map((p) => p.id)),
      focusedPhotoId: this.state.focusedPhotoId || visible[0]?.id || null,
    });
  }

  clearSelection() {
    this.setState({ selectedPhotoIds: new Set() });
  }

  openLightbox(photoId) {
    this.setState({
      lightboxPhotoId: photoId,
      focusedPhotoId: photoId,
      lightboxZoom: 1,
    });
  }

  closeLightbox() {
    this.setState({ lightboxPhotoId: null, lightboxZoom: 1 });
  }

  stepPhoto(delta) {
    const visible = this.getVisiblePhotos();
    if (visible.length === 0) return;

    const currentId = this.state.lightboxPhotoId || this.state.focusedPhotoId;
    const idx = visible.findIndex((p) => p.id === currentId);
    const nextIdx =
      idx === -1
        ? 0
        : Math.max(0, Math.min(visible.length - 1, idx + delta));
    const nextId = visible[nextIdx].id;

    if (this.state.lightboxPhotoId) {
      this.setState({
        lightboxPhotoId: nextId,
        focusedPhotoId: nextId,
        lightboxZoom: 1,
      });
    } else {
      this.setState({
        focusedPhotoId: nextId,
        lastClickedPhotoId: nextId,
      });
    }
  }

  toggleTagFilter(tagId) {
    const next = new Set(this.state.selectedTagIds);
    if (next.has(tagId)) next.delete(tagId);
    else next.add(tagId);
    this.setState({ selectedTagIds: next });
  }

  clearAllFilters() {
    this.setState({
      quickView: 'all',
      mediaFilter: 'all',
      aspectFilter: 'all',
      ratingScope: 'avg',
      minRating: 0,
      memberFilterId: null,
      selectedTagIds: new Set(),
      searchQuery: '',
    });
  }

  toggleTheme() {
    const next = this.state.theme === 'dark' ? 'light' : 'dark';
    if (typeof document !== 'undefined') {
      document.documentElement.setAttribute('data-theme', next);
    }
    try {
      localStorage.setItem(THEME_KEY, next);
    } catch {
      // Ignore
    }
    this.setState({ theme: next });
  }

  setLayoutMode(mode) {
    const next = VALID_LAYOUT_MODES.includes(mode) ? mode : 'justified';
    saveUiPrefs({ layoutMode: next });
    if (this.state.layoutMode !== next) {
      this.setState({ layoutMode: next });
    }
  }

  cycleLayoutMode() {
    const idx = VALID_LAYOUT_MODES.indexOf(this.state.layoutMode);
    const next = VALID_LAYOUT_MODES[(idx + 1) % VALID_LAYOUT_MODES.length];
    this.setLayoutMode(next);
    return next;
  }

  setRowHeight(px) {
    const val = Number(px);
    const clamped = Number.isFinite(val) ? Math.max(130, Math.min(320, Math.round(val))) : 210;
    saveUiPrefs({ rowHeight: clamped });
    if (this.state.rowHeight !== clamped) {
      this.setState({ rowHeight: clamped });
    }
  }

  setSortBy(sortBy) {
    const next = VALID_SORT_MODES.includes(sortBy) ? sortBy : 'dateDesc';
    saveUiPrefs({ sortBy: next });
    if (this.state.sortBy !== next) {
      this.setState({ sortBy: next });
    }
  }

  setIncludeSubfolders(includeSubfolders) {
    const next = Boolean(includeSubfolders);
    saveUiPrefs({ includeSubfolders: next });
    if (this.state.includeSubfolders !== next) {
      this.setState({ includeSubfolders: next });
    }
  }

  openModal(type, payload = null) {
    this.setState({ modal: { type, payload } });
  }

  closeModal() {
    this.setState({ modal: null });
  }
}
