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
  clearSession,
  getCachedSession,
  getSavedOAuthUser,
  loadSharedAlbum,
  loadSharedAlbumWithApiKey,
  parseDriveFolderId,
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

const THEME_KEY = 'drivelens_theme';
const RECENT_KEY = 'drivelens_recent_v1';
const SETTINGS_KEY = 'drivelens_connect_prefs_v1';

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
      nickname: defaultNick,
      rememberCredentials: true,
      autoConnect: false,
    };
  }
}

function saveConnectPrefs(patch) {
  try {
    const prev = loadConnectPrefs();
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({ ...prev, ...patch }));
  } catch {
    // Ignore
  }
}

function getPhotoTimestamp(file) {
  const raw = file.imageMediaMetadata?.time || file.createdTime || file.modifiedTime || '';
  if (!raw) return 0;
  // Handle EXIF format "YYYY:MM:DD HH:MM:SS" if Google Drive returns it
  const normalized = /^\d{4}:\d{2}:\d{2}\s/.test(raw)
    ? raw.replace(/^(\d{4}):(\d{2}):(\d{2})\s/, '$1-$2-$3T')
    : raw;
  const ts = Date.parse(normalized);
  return Number.isNaN(ts) ? 0 : ts;
}

export class Store {
  constructor() {
    this.listeners = new Set();
    this.memberSyncTimer = null;
    this.schemaSyncTimer = null;
    this.toastCounter = 0;
    this.deferredInstallPrompt = null;

    const initialLang = setLangCode(getLang());
    const prefs = loadConnectPrefs();
    const initialPersonas = getDemoPersonas(initialLang);

    this.state = {
      lang: initialLang,
      mode: 'demo',
      authType: prefs.authType,
      loading: false,
      loadingText: '',
      syncStatus: 'idle',
      syncMessageKey: 'store.syncDemo',
      syncMessage: t('store.syncDemo'),
      apiKey: prefs.apiKey,
      nickname: prefs.nickname,
      clientId: prefs.clientId,
      folderId: prefs.folderId,
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
      includeSubfolders: true,
      searchQuery: '',
      quickView: 'all',
      ratingScope: 'avg',
      minRating: 0,
      memberFilterId: null,
      selectedTagIds: new Set(),
      tagMatchMode: 'OR',
      sortBy: 'dateDesc',

      // UI State
      layoutMode: 'justified',
      rowHeight: 210,
      selectedPhotoIds: new Set(),
      lastClickedPhotoId: null,
      focusedPhotoId: null,
      lightboxPhotoId: null,
      lightboxZoom: 1,
      inspectorOpen: true,
      sidebarOpen: false,
      sidebarCollapsed: false,
      theme: getInitialTheme(),
      recentAlbums: loadRecentAlbums(),
      modal: null,
      toasts: [],
    };

    if (typeof document !== 'undefined') {
      document.documentElement.setAttribute('data-theme', this.state.theme);
    }
    this.loadDemoMode(false);
  }

  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit() {
    for (const fn of this.listeners) {
      fn(this.state);
    }
  }

  setState(patch) {
    this.state = { ...this.state, ...patch };
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

  loadDemoMode(showNotice = true, disableAutoConnect = false) {
    if (disableAutoConnect) {
      saveConnectPrefs({ autoConnect: false });
    }
    const lang = this.state?.lang || getLang();
    const demo = createDemoDataset(lang);
    const personas = getDemoPersonas(lang);
    const persona =
      personas.find((p) => p.id === demo.activePersonaId) || personas[0];
    const firstPhoto = demo.files[0]?.id || null;

    this.setState({
      mode: 'demo',
      localMetaSupported: false,
      loading: false,
      loadingText: '',
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

  async connectGoogleDrive({
    clientId,
    folderInput,
    reuseSession = false,
    rememberCredentials = this.state.rememberCredentials,
    prompt,
    loginHint,
  }) {
    const cleanClientId = String(clientId || '').trim();
    const cleanFolderId = parseDriveFolderId(folderInput);
    const remember = rememberCredentials !== false;

    if (!cleanClientId) {
      this.toast(t('store.missingClientId'), 'error');
      return false;
    }
    if (!cleanFolderId) {
      this.toast(t('store.invalidFolder'), 'error');
      return false;
    }

    const existingSavedUser = getSavedOAuthUser(cleanClientId);
    const savedHint = existingSavedUser?.email || '';
    const effectiveHint = loginHint !== undefined ? loginHint : savedHint;
    const effectivePrompt = prompt !== undefined ? prompt : effectiveHint ? '' : 'select_account';

    if (remember) {
      saveConnectPrefs({
        authType: 'oauth',
        clientId: cleanClientId,
        folderId: cleanFolderId,
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
      });
      clearSession({ forgetUser: true });
    }

    this.setState({
      loading: true,
      loadingText: t('store.connectingAccount'),
      authType: 'oauth',
      localMetaSupported: false,
      clientId: cleanClientId,
      folderId: cleanFolderId,
      rememberCredentials: remember,
      savedOAuthUser: remember ? existingSavedUser : null,
    });

    try {
      let session = reuseSession ? getCachedSession(cleanClientId) : null;
      if (!session) {
        session = await authenticateGoogle(cleanClientId, {
          prompt: effectivePrompt,
          loginHint: effectiveHint,
          remember,
        });
      }

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
        loadingText: t('store.scanningAlbum'),
        accessToken: session.accessToken,
        currentUser: session.user,
        savedOAuthUser: nextSavedUser,
      });

      const album = await loadSharedAlbum(cleanFolderId, session.accessToken, (prog) => {
        this.setState({
          loadingText: t('store.scanningProgress', {
            folders: prog.folderCount,
            files: prog.fileCount,
          }),
        });
      });

      this.setState({
        loadingText: t('store.syncingMetadata'),
      });

      const meta = await loadAlbumMetadata(album.metaFolderId, session.accessToken);
      const membersData = { ...meta.membersData };
      const myId = session.user.id;

      // Read-only fallback merge from localStorage if folder is read-only
      if (!album.canWrite) {
        try {
          const localRaw = localStorage.getItem(`drivelens_readonly_${cleanFolderId}_${myId}`);
          if (localRaw) {
            const parsed = JSON.parse(localRaw);
            if (parsed.memberData) membersData[myId] = parsed.memberData;
            if (parsed.tagSchema) {
              meta.tagSchema = {
                version: 1,
                tags: { ...meta.tagSchema.tags, ...parsed.tagSchema.tags },
              };
            }
          }
        } catch {
          // Ignore
        }
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

      let recent = this.state.recentAlbums;
      if (remember) {
        recent = [
          {
            folderId: cleanFolderId,
            name: album.rootFolder.name,
            authType: 'oauth',
            clientId: cleanClientId,
            updatedAt: Date.now(),
          },
          ...this.state.recentAlbums.filter((a) => a.folderId !== cleanFolderId),
        ].slice(0, 6);

        try {
          localStorage.setItem(RECENT_KEY, JSON.stringify(recent));
        } catch {
          // Ignore
        }
      }

      this._updateUrlHash(cleanFolderId, cleanClientId);

      const msgKey = album.canWrite ? 'store.syncOAuthSynced' : 'store.syncReadonly';

      this.setState({
        mode: 'gdrive',
        authType: 'oauth',
        localMetaSupported: false,
        loading: false,
        loadingText: '',
        syncStatus: album.canWrite ? 'synced' : 'readonly',
        syncMessageKey: msgKey,
        syncMessage: t(msgKey),
        rootFolder: album.rootFolder,
        folders: album.folders,
        files: album.files,
        metaFolderId: album.metaFolderId,
        canWrite: album.canWrite,
        tagSchemaFileId: meta.tagSchemaFileId,
        tagSchema: meta.tagSchema,
        memberFilesById: meta.memberFilesById,
        membersData,
        activeFolderId: album.rootFolder.id,
        selectedPhotoIds: new Set(),
        lastClickedPhotoId: null,
        focusedPhotoId: album.files[0]?.id || null,
        lightboxPhotoId: null,
        quickView: 'all',
        minRating: 0,
        memberFilterId: null,
        ratingScope: 'avg',
        selectedTagIds: new Set(),
        searchQuery: '',
        recentAlbums: recent,
        modal: null,
      });

      this.toast(
        t('store.loadedAlbumToast', { name: album.rootFolder.name, count: album.files.length }),
        'success'
      );
      return true;
    } catch (err) {
      this.setState({ loading: false, loadingText: '' });
      this.toast(err?.message || t('store.connectFailed'), 'error', 5000);
      return false;
    }
  }

  async connectWithApiKey({
    apiKey,
    folderInput,
    nickname,
    rememberCredentials = this.state.rememberCredentials,
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
      });
      clearSession({ forgetUser: true });
    }

    const userId = `nick_${sanitizeMemberKey(cleanNick)}`;
    const user = {
      id: userId,
      name: cleanNick,
      email: '',
      picture: '',
      color: pickMemberColor(userId),
    };

    this.setState({
      loading: true,
      loadingText: t('store.connectingApiKey'),
      authType: 'apikey',
      apiKey: cleanApiKey,
      folderId: cleanFolderId,
      nickname: cleanNick,
      rememberCredentials: remember,
      ...(remember ? {} : { savedOAuthUser: null }),
      accessToken: '',
      currentUser: user,
    });

    try {
      const album = await loadSharedAlbumWithApiKey(cleanFolderId, cleanApiKey, (prog) => {
        this.setState({
          loadingText: t('store.scanningProgress', {
            folders: prog.folderCount,
            files: prog.fileCount,
          }),
        });
      });

      this.setState({ loadingText: t('store.syncingMetadata') });

      const serverMeta = await loadLocalServerMeta(cleanFolderId);
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

      let recent = this.state.recentAlbums;
      if (remember) {
        recent = [
          {
            folderId: cleanFolderId,
            name: album.rootFolder.name,
            authType: 'apikey',
            apiKey: cleanApiKey,
            updatedAt: Date.now(),
          },
          ...this.state.recentAlbums.filter((a) => a.folderId !== cleanFolderId),
        ].slice(0, 6);

        try {
          localStorage.setItem(RECENT_KEY, JSON.stringify(recent));
        } catch {
          // Ignore
        }
      }

      try {
        localStorage.setItem(localStorageKey, JSON.stringify({ tagSchema, membersData }));
      } catch {
        // Ignore
      }

      this._updateUrlHash(cleanFolderId, '');

      const localMetaSupported = Boolean(serverMeta);
      const msgKey = localMetaSupported ? 'store.syncApiKeySynced' : 'store.syncApiKeyLocal';

      this.setState({
        mode: 'gdrive',
        authType: 'apikey',
        localMetaSupported,
        loading: false,
        loadingText: '',
        syncStatus: localMetaSupported ? 'synced' : 'readonly',
        syncMessageKey: msgKey,
        syncMessage: t(msgKey),
        rootFolder: album.rootFolder,
        folders: album.folders,
        files: album.files,
        metaFolderId: null,
        canWrite: true,
        tagSchemaFileId: null,
        tagSchema,
        memberFilesById: {},
        membersData,
        activeFolderId: album.rootFolder.id,
        selectedPhotoIds: new Set(),
        lastClickedPhotoId: null,
        focusedPhotoId: album.files[0]?.id || null,
        lightboxPhotoId: null,
        quickView: 'all',
        minRating: 0,
        memberFilterId: null,
        ratingScope: 'avg',
        selectedTagIds: new Set(),
        searchQuery: '',
        recentAlbums: recent,
        modal: null,
      });

      this.toast(
        t('store.loadedAlbumToast', { name: album.rootFolder.name, count: album.files.length }),
        'success'
      );
      return true;
    } catch (err) {
      this.setState({ loading: false, loadingText: '' });
      this.toast(err?.message || t('store.connectApiKeyFailed'), 'error', 5000);
      return false;
    }
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
          reuseSession: true,
          rememberCredentials: true,
        });
      }

      const savedUser = getSavedOAuthUser(prefs.clientId);
      this.setState({
        authType: 'oauth',
        clientId: prefs.clientId,
        folderId: prefs.folderId,
        savedOAuthUser: savedUser,
      });
      this.openModal('connect');
      this.toast(
        t('store.sessionExpiredReconnect', {
          email: savedUser?.email || savedUser?.name || 'Google',
        }),
        'info'
      );
      return false;
    }

    return false;
  }

  forgetSavedCredentials() {
    clearSession({ forgetUser: true });
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

    this.setState({
      apiKey: '',
      clientId: '',
      folderId: '',
      nickname: defaultNick,
      recentAlbums: [],
      savedOAuthUser: null,
      rememberCredentials: true,
      accessToken: '',
      localMetaSupported: false,
    });

    if (wasGdrive) {
      this.loadDemoMode(false);
    }

    this.toast(t('store.credsClearedToast'), 'info');
  }

  async refreshAlbum() {
    if (this.state.mode !== 'gdrive') {
      this.toast(t('store.refreshDemoNotice'), 'info');
      return;
    }
    if (this.state.authType === 'apikey') {
      await this.connectWithApiKey({
        apiKey: this.state.apiKey,
        folderInput: this.state.folderId,
        nickname: this.state.nickname || this.state.currentUser?.name,
        rememberCredentials: this.state.rememberCredentials,
      });
      return;
    }
    await this.connectGoogleDrive({
      clientId: this.state.clientId,
      folderInput: this.state.folderId,
      reuseSession: true,
      rememberCredentials: this.state.rememberCredentials,
    });
  }

  disconnectGoogleDrive() {
    clearSession();
    this.setState({ accessToken: '', localMetaSupported: false });
    this.loadDemoMode(true, true);
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
    const myId = this.state.currentUser?.id || 'me';
    const membersEntries = Object.entries(this.state.membersData || {});
    const ratingsByMember = [];
    const notesByMember = [];
    const tagLatest = new Map();

    let sumRating = 0;
    let ratingCount = 0;
    let favoriteCount = 0;
    let myRating = 0;
    let myFavorite = false;
    let myNote = '';

    for (const [memberId, record] of membersEntries) {
      const memberInfo = record?.member || { id: memberId, name: memberId, color: '#60a5fa' };
      const item = record?.items?.[fileId];
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

    const schemaTags = this.state.tagSchema?.tags || {};
    const activeTagIds = [];
    for (const [tagId, status] of tagLatest.entries()) {
      const def = schemaTags[tagId];
      if (status.active && def && !def.deleted) {
        activeTagIds.push(tagId);
      }
    }

    ratingsByMember.sort((a, b) =>
      a.member.id === myId ? -1 : b.member.id === myId ? 1 : b.rating - a.rating
    );

    return {
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
    const counts = {};
    for (const file of this.state.files) {
      const meta = this.getAggregatedItemMeta(file.id);
      for (const tagId of meta.activeTagIds) {
        counts[tagId] = (counts[tagId] || 0) + 1;
      }
    }
    return counts;
  }

  getVisiblePhotos() {
    const {
      activeFolderId,
      includeSubfolders,
      quickView,
      ratingScope,
      minRating,
      memberFilterId,
      selectedTagIds,
      tagMatchMode,
      searchQuery,
      sortBy,
    } = this.state;

    const allowedFolderIds = activeFolderId
      ? includeSubfolders
        ? this.getFolderDescendantIds(activeFolderId)
        : new Set([activeFolderId])
      : null;

    const query = searchQuery.trim().toLowerCase();
    const tagList = Array.from(selectedTagIds);
    const schemaTags = this.state.tagSchema?.tags || {};
    const locale = getLocaleTag();

    const matched = [];
    for (const file of this.state.files) {
      if (allowedFolderIds && !allowedFolderIds.has(file.parentId)) continue;

      const meta = this.getAggregatedItemMeta(file.id);

      if (quickView === 'favorites' && meta.favoriteCount === 0) continue;
      if (quickView === 'unrated' && meta.ratingCount > 0) continue;

      if (ratingScope === 'member' && memberFilterId) {
        const memberItem = this.state.membersData?.[memberFilterId]?.items?.[file.id];
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

      if (tagList.length > 0) {
        const activeSet = new Set(meta.activeTagIds);
        const ok =
          tagMatchMode === 'AND'
            ? tagList.every((tid) => activeSet.has(tid))
            : tagList.some((tid) => activeSet.has(tid));
        if (!ok) continue;
      }

      if (query) {
        const camText = `${file.imageMediaMetadata?.cameraMake || ''} ${file.imageMediaMetadata?.cameraModel || ''}`;
        const notesText = meta.notesByMember.map((n) => n.note).join(' ');
        const tagNames = meta.activeTagIds.map((id) => schemaTags[id]?.name || '').join(' ');
        const haystack = `${file.name} ${camText} ${notesText} ${tagNames}`.toLowerCase();
        if (!haystack.includes(query)) continue;
      }

      matched.push({ file, meta });
    }

    matched.sort((a, b) => {
      switch (sortBy) {
        case 'dateAsc':
          return getPhotoTimestamp(a.file) - getPhotoTimestamp(b.file);
        case 'ratingDesc': {
          const diff = b.meta.avgRating - a.meta.avgRating;
          if (Math.abs(diff) > 0.001) return diff;
          return b.meta.ratingCount - a.meta.ratingCount || getPhotoTimestamp(b.file) - getPhotoTimestamp(a.file);
        }
        case 'nameAsc':
          return a.file.name.localeCompare(b.file.name, locale);
        case 'sizeDesc':
          return (b.file.size || 0) - (a.file.size || 0);
        case 'dateDesc':
        default:
          return getPhotoTimestamp(b.file) - getPhotoTimestamp(a.file);
      }
    });

    return matched.map((x) => x.file);
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

  _persistChanges({ memberDirty = false, schemaDirty = false }) {
    if (this.state.mode === 'demo') {
      saveDemoState({
        tagSchema: this.state.tagSchema,
        membersData: this.state.membersData,
        activePersonaId: this.state.currentUser.id,
      });
      return;
    }

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
        this.setState({
          syncStatus: 'readonly',
          syncMessageKey: 'store.syncApiKeyLocal',
          syncMessage: t('store.syncApiKeyLocal'),
        });
        return;
      }

      if (memberDirty || schemaDirty) {
        clearTimeout(this.memberSyncTimer);
        clearTimeout(this.schemaSyncTimer);
        this.setState({
          syncStatus: 'syncing',
          syncMessageKey: 'store.syncSavingRatings',
          syncMessage: t('store.syncSavingRatings'),
        });
        this.memberSyncTimer = setTimeout(
          () => this._flushApiKeyMetaSync(),
          APP_CONFIG.SYNC_DEBOUNCE_MS
        );
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
      this.setState({
        syncStatus: 'readonly',
        syncMessageKey: 'store.syncReadonlySaved',
        syncMessage: t('store.syncReadonlySaved'),
      });
      return;
    }

    if (memberDirty) {
      clearTimeout(this.memberSyncTimer);
      this.setState({
        syncStatus: 'syncing',
        syncMessageKey: 'store.syncSavingRatings',
        syncMessage: t('store.syncSavingRatings'),
      });
      this.memberSyncTimer = setTimeout(() => this._flushMemberSync(), APP_CONFIG.SYNC_DEBOUNCE_MS);
    }

    if (schemaDirty) {
      clearTimeout(this.schemaSyncTimer);
      this.setState({
        syncStatus: 'syncing',
        syncMessageKey: 'store.syncSavingTags',
        syncMessage: t('store.syncSavingTags'),
      });
      this.schemaSyncTimer = setTimeout(() => this._flushSchemaSync(), APP_CONFIG.SYNC_DEBOUNCE_MS);
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

    try {
      const res = await saveLocalServerMeta({
        folderId: this.state.folderId,
        memberId: myId,
        memberRecord,
        tagSchema: this.state.tagSchema,
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
    if (this.state.mode !== 'gdrive' || !this.state.canWrite || !this.state.accessToken) return;
    const myId = this.state.currentUser.id;
    const payload = this.state.membersData[myId];
    if (!payload) return;

    try {
      const res = await saveMemberMetadata({
        rootFolderId: this.state.folderId,
        metaFolderId: this.state.metaFolderId,
        existingFileId: this.state.memberFilesById[myId] || null,
        memberKey: sanitizeMemberKey(myId),
        payload,
        accessToken: this.state.accessToken,
      });
      this.setState({
        metaFolderId: res.metaFolderId,
        memberFilesById: { ...this.state.memberFilesById, [myId]: res.fileId },
        syncStatus: 'synced',
        syncMessageKey: 'store.syncOAuthUpdated',
        syncMessage: t('store.syncOAuthUpdated'),
      });
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
    if (this.state.mode !== 'gdrive' || !this.state.canWrite || !this.state.accessToken) return;
    try {
      const res = await saveTagSchema({
        rootFolderId: this.state.folderId,
        metaFolderId: this.state.metaFolderId,
        existingFileId: this.state.tagSchemaFileId,
        localSchema: this.state.tagSchema,
        accessToken: this.state.accessToken,
      });
      this.setState({
        metaFolderId: res.metaFolderId,
        tagSchemaFileId: res.fileId,
        tagSchema: res.mergedSchema,
        syncStatus: 'synced',
        syncMessageKey: 'store.syncTagsUpdated',
        syncMessage: t('store.syncTagsUpdated'),
      });
    } catch (err) {
      this.setState({
        syncStatus: 'error',
        syncMessageKey: 'store.syncTagsErrorShort',
        syncMessage: t('store.syncTagsErrorShort'),
      });
      this.toast(err?.message || t('store.syncTagsFailed'), 'error');
    }
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

    this.setState({
      membersData: { ...this.state.membersData, [myId]: record },
    });
    this._persistChanges({ memberDirty: true });
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

    this.setState({
      membersData: { ...this.state.membersData, [myId]: record },
    });
    this._persistChanges({ memberDirty: true });
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

    this.setState({
      membersData: { ...this.state.membersData, [myId]: record },
    });
    this._persistChanges({ memberDirty: true });
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
    this.setState({
      membersData: { ...this.state.membersData, [myId]: record },
    });
    this._persistChanges({ memberDirty: true });
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

  openModal(type, payload = null) {
    this.setState({ modal: { type, payload } });
  }

  closeModal() {
    this.setState({ modal: null });
  }
}
