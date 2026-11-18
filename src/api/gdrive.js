/**
 * Google Drive API v3 & Google Identity Services (OAuth 2.0) Client
 */
import { t } from '../i18n.js';

const GIS_SCRIPT_URL = 'https://accounts.google.com/gsi/client';
const DRIVE_API = 'https://www.googleapis.com/drive/v3';
const SESSION_KEY = 'drivelens_session_v1';
const SAVED_USER_KEY = 'drivelens_oauth_user_v1';
const SCOPES = [
  'https://www.googleapis.com/auth/drive',
  'https://www.googleapis.com/auth/userinfo.profile',
  'https://www.googleapis.com/auth/userinfo.email',
].join(' ');

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

let gisLoadPromise = null;

function pickMemberColor(seed) {
  let hash = 0;
  const s = String(seed || 'user');
  for (let i = 0; i < s.length; i += 1) {
    hash = (hash * 31 + s.charCodeAt(i)) | 0;
  }
  return MEMBER_COLORS[Math.abs(hash) % MEMBER_COLORS.length];
}

export function parseDriveFolderId(input) {
  const raw = String(input || '').trim();
  if (!raw) return null;

  // URL patterns: /folders/<id> or ?id=<id>
  const folderMatch = raw.match(/\/folders\/([a-zA-Z0-9_-]{10,})/);
  if (folderMatch) return folderMatch[1];

  const queryMatch = raw.match(/[?&]id=([a-zA-Z0-9_-]{10,})/);
  if (queryMatch) return queryMatch[1];

  if (/^[a-zA-Z0-9_-]{10,}$/.test(raw)) {
    return raw;
  }
  return null;
}

export function ensureGoogleIdentityLoaded() {
  if (window.google?.accounts?.oauth2) {
    return Promise.resolve();
  }
  if (gisLoadPromise) return gisLoadPromise;

  gisLoadPromise = new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[src="${GIS_SCRIPT_URL}"]`);
    const timer = setTimeout(() => {
      gisLoadPromise = null;
      reject(new Error(t('gdrive.gisTimeout')));
    }, 10000);

    const finish = () => {
      clearTimeout(timer);
      if (window.google?.accounts?.oauth2) {
        resolve();
      } else {
        gisLoadPromise = null;
        reject(new Error(t('gdrive.gisIncomplete')));
      }
    };

    if (existing) {
      existing.addEventListener('load', finish, { once: true });
      existing.addEventListener(
        'error',
        () => {
          clearTimeout(timer);
          gisLoadPromise = null;
          reject(new Error(t('gdrive.gisScriptError')));
        },
        { once: true }
      );
      return;
    }

    const script = document.createElement('script');
    script.src = GIS_SCRIPT_URL;
    script.async = true;
    script.defer = true;
    script.onload = finish;
    script.onerror = () => {
      clearTimeout(timer);
      gisLoadPromise = null;
      reject(new Error(t('gdrive.gisNetworkError')));
    };
    document.head.appendChild(script);
  });

  return gisLoadPromise;
}

function readSessionFromStorage(storage, clientId) {
  try {
    if (!storage) return null;
    const raw = storage.getItem(SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed?.accessToken || !parsed?.expiresAt) return null;
    if (clientId && parsed.clientId !== clientId) return null;
    if (parsed.expiresAt <= Date.now() + 60 * 1000) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function getCachedSession(clientId) {
  return (
    readSessionFromStorage(typeof localStorage !== 'undefined' ? localStorage : null, clientId) ||
    readSessionFromStorage(typeof sessionStorage !== 'undefined' ? sessionStorage : null, clientId)
  );
}

export function getSavedOAuthUser(clientId = '') {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(SAVED_USER_KEY) : null;
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    if (clientId && parsed.clientId !== clientId) return null;
    return {
      clientId: parsed.clientId || '',
      id: parsed.id || '',
      email: parsed.email || '',
      name: parsed.name || '',
      picture: parsed.picture || '',
      color: parsed.color || '#38bdf8',
    };
  } catch {
    return null;
  }
}

export function clearSession(options = {}) {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.removeItem(SESSION_KEY);
      if (options?.forgetUser === true) {
        localStorage.removeItem(SAVED_USER_KEY);
      }
    }
  } catch {
    // Ignore
  }
  try {
    if (typeof sessionStorage !== 'undefined') {
      sessionStorage.removeItem(SESSION_KEY);
    }
  } catch {
    // Ignore
  }
}

async function fetchUserProfile(accessToken) {
  const resp = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!resp.ok) {
    return {
      id: 'gdrive-user',
      email: '',
      name: t('gdrive.defaultUser'),
      picture: '',
      color: '#38bdf8',
    };
  }
  const data = await resp.json();
  const id = data.email || data.sub || 'gdrive-user';
  return {
    id,
    email: data.email || '',
    name: data.name || data.email || t('gdrive.defaultUser'),
    picture: data.picture || '',
    color: pickMemberColor(id),
  };
}

export async function authenticateGoogle(clientId, options = {}) {
  const { prompt = 'select_account', loginHint = '', remember = true } = options;
  const trimmedClientId = String(clientId || '').trim();
  if (!trimmedClientId) {
    throw new Error(t('gdrive.missingClientId'));
  }

  await ensureGoogleIdentityLoaded();

  const hintVal = String(loginHint || getSavedOAuthUser(trimmedClientId)?.email || '').trim();

  const tokenResult = await new Promise((resolve, reject) => {
    try {
      const client = window.google.accounts.oauth2.initTokenClient({
        client_id: trimmedClientId,
        scope: SCOPES,
        ...(hintVal ? { hint: hintVal } : {}),
        callback: (response) => {
          if (response.error) {
            reject(new Error(response.error_description || response.error || t('gdrive.authFailed')));
            return;
          }
          resolve(response);
        },
        error_callback: (err) => {
          reject(new Error(err?.message || t('gdrive.popupBlocked')));
        },
      });
      client.requestAccessToken({
        prompt,
        ...(hintVal ? { hint: hintVal } : {}),
      });
    } catch (err) {
      reject(err);
    }
  });

  const accessToken = tokenResult.access_token;
  const expiresInSec = Number(tokenResult.expires_in || 3600);
  const expiresAt = Date.now() + expiresInSec * 1000;
  const user = await fetchUserProfile(accessToken);

  const session = { clientId: trimmedClientId, accessToken, expiresAt, user };
  if (remember !== false) {
    try {
      if (typeof sessionStorage !== 'undefined') {
        sessionStorage.removeItem(SESSION_KEY);
      }
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem(SESSION_KEY, JSON.stringify(session));
        localStorage.setItem(
          SAVED_USER_KEY,
          JSON.stringify({
            clientId: trimmedClientId,
            id: user.id,
            email: user.email,
            name: user.name,
            picture: user.picture,
            color: user.color,
          })
        );
      }
    } catch {
      // Ignore storage restrictions
    }
  } else {
    clearSession({ forgetUser: true });
    try {
      if (typeof sessionStorage !== 'undefined') {
        sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
      }
    } catch {
      // Ignore sessionStorage restrictions
    }
  }
  return session;
}

async function driveJsonFetch(url, auth = {}) {
  const { accessToken = '', apiKey = '' } = typeof auth === 'string' ? { accessToken: auth } : auth;
  const headers = accessToken ? { Authorization: `Bearer ${accessToken}` } : {};
  const resp = await fetch(url, { headers });

  if (resp.status === 400 && !accessToken && apiKey) {
    const text = await resp.text().catch(() => '');
    if (text.includes('API_KEY_INVALID') || text.includes('keyInvalid') || text.includes('key')) {
      throw new Error(t('gdrive.err400InvalidKey'));
    }
    throw new Error(t('gdrive.err400BadRequest'));
  }
  if (resp.status === 401) {
    clearSession();
    throw new Error(t('gdrive.err401Expired'));
  }
  if (resp.status === 403) {
    const text = await resp.text().catch(() => '');
    if (text.includes('rateLimitExceeded') || text.includes('userRateLimitExceeded')) {
      throw new Error(t('gdrive.err403RateLimit'));
    }
    if (!accessToken && apiKey) {
      if (text.includes('accessNotConfigured') || text.includes('SERVICE_DISABLED')) {
        throw new Error(t('gdrive.err403Disabled'));
      }
      if (text.includes('API_KEY_INVALID') || text.includes('keyInvalid')) {
        throw new Error(t('gdrive.err403KeyRestricted'));
      }
      throw new Error(t('gdrive.err403LinkAccess'));
    }
    throw new Error(t('gdrive.err403Forbidden'));
  }
  if (resp.status === 404) {
    if (!accessToken && apiKey) {
      throw new Error(t('gdrive.err404ApiKey'));
    }
    throw new Error(t('gdrive.err404NotFound'));
  }
  if (!resp.ok) {
    throw new Error(t('gdrive.errHttp', { status: resp.status }));
  }
  return resp.json();
}

async function listFolderChildren(folderId, auth) {
  const { apiKey = '' } = auth;
  const items = [];
  let pageToken = '';
  const fields =
    'nextPageToken,files(id,name,mimeType,size,createdTime,modifiedTime,thumbnailLink,webViewLink,webContentLink,imageMediaMetadata,videoMediaMetadata)';
  const q = `'${folderId}' in parents and trashed = false and (mimeType = 'application/vnd.google-apps.folder' or mimeType contains 'image/' or mimeType contains 'video/')`;

  do {
    const params = new URLSearchParams({
      q,
      fields,
      pageSize: '200',
      supportsAllDrives: 'true',
      includeItemsFromAllDrives: 'true',
    });
    if (pageToken) params.set('pageToken', pageToken);
    if (!auth.accessToken && apiKey) params.set('key', apiKey);

    const data = await driveJsonFetch(`${DRIVE_API}/files?${params.toString()}`, auth);
    if (Array.isArray(data.files)) {
      items.push(...data.files);
    }
    pageToken = data.nextPageToken || '';
  } while (pageToken);

  return items;
}

async function crawlAlbumTree({ rootFolder, auth, onProgress = null, captureMetaFolder = true }) {
  const folders = [rootFolder];
  const files = [];
  let metaFolderId = null;

  let queue = [{ id: rootFolder.id, depth: 0 }];
  const visited = new Set([rootFolder.id]);
  const MAX_DEPTH = 6;
  const BATCH_SIZE = 4;

  while (queue.length > 0) {
    const batch = queue.slice(0, BATCH_SIZE);
    queue = queue.slice(BATCH_SIZE);

    const results = await Promise.all(
      batch.map(async (node) => {
        const children = await listFolderChildren(node.id, auth);
        return { node, children };
      })
    );

    for (const { node, children } of results) {
      for (const entry of children) {
        if (entry.mimeType === 'application/vnd.google-apps.folder') {
          if (captureMetaFolder && entry.name === '.drivelens' && node.id === rootFolder.id) {
            metaFolderId = entry.id;
            continue;
          }
          if (entry.name.startsWith('.')) {
            continue;
          }
          if (!visited.has(entry.id) && node.depth + 1 <= MAX_DEPTH) {
            visited.add(entry.id);
            folders.push({
              id: entry.id,
              name: entry.name,
              parentId: node.id,
              depth: node.depth + 1,
            });
            queue.push({ id: entry.id, depth: node.depth + 1 });
          }
        } else {
          files.push({
            id: entry.id,
            name: entry.name,
            parentId: node.id,
            mimeType: entry.mimeType || 'image/jpeg',
            size: Number(entry.size || 0),
            createdTime: entry.createdTime || '',
            modifiedTime: entry.modifiedTime || '',
            thumbnailLink: entry.thumbnailLink || '',
            webViewLink: entry.webViewLink || '',
            webContentLink: entry.webContentLink || '',
            imageMediaMetadata: entry.imageMediaMetadata || null,
            videoMediaMetadata: entry.videoMediaMetadata || null,
            isDemo: false,
          });
        }
      }
    }

    if (onProgress) {
      onProgress({ folderCount: folders.length, fileCount: files.length });
    }
  }

  return {
    rootFolder,
    folders,
    files,
    metaFolderId,
    canWrite: rootFolder.canWrite,
  };
}

export async function loadSharedAlbum(folderId, accessToken, onProgress = null) {
  const cleanId = parseDriveFolderId(folderId);
  if (!cleanId) {
    throw new Error(t('gdrive.invalidFolder'));
  }

  const auth = { accessToken };
  const rootParams = new URLSearchParams({
    fields: 'id,name,mimeType,capabilities(canAddChildren,canEdit),owners(displayName,emailAddress)',
    supportsAllDrives: 'true',
  });
  const rootMeta = await driveJsonFetch(
    `${DRIVE_API}/files/${encodeURIComponent(cleanId)}?${rootParams.toString()}`,
    auth
  );

  if (rootMeta.mimeType !== 'application/vnd.google-apps.folder') {
    throw new Error(t('gdrive.notFolder'));
  }

  const canWrite = Boolean(rootMeta.capabilities?.canAddChildren ?? rootMeta.capabilities?.canEdit ?? false);
  const rootFolder = {
    id: rootMeta.id,
    name: rootMeta.name || t('gdrive.defaultAlbumName'),
    parentId: null,
    depth: 0,
    canWrite,
  };

  return crawlAlbumTree({ rootFolder, auth, onProgress, captureMetaFolder: true });
}

export async function loadSharedAlbumWithApiKey(folderId, apiKey, onProgress = null) {
  const cleanId = parseDriveFolderId(folderId);
  if (!cleanId) {
    throw new Error(t('gdrive.invalidFolder'));
  }
  const cleanKey = String(apiKey || '').trim();
  if (!cleanKey) {
    throw new Error(t('gdrive.missingApiKey'));
  }

  const auth = { apiKey: cleanKey };
  const rootUrl = `${DRIVE_API}/files/${encodeURIComponent(cleanId)}?fields=id,name,mimeType&supportsAllDrives=true&key=${encodeURIComponent(cleanKey)}`;
  const rootMeta = await driveJsonFetch(rootUrl, auth);

  if (rootMeta.mimeType !== 'application/vnd.google-apps.folder') {
    throw new Error(t('gdrive.notFolder'));
  }

  const rootFolder = {
    id: rootMeta.id,
    name: rootMeta.name || t('gdrive.defaultAlbumName'),
    parentId: null,
    depth: 0,
    canWrite: true,
  };

  return crawlAlbumTree({ rootFolder, auth, onProgress, captureMetaFolder: false });
}

function triggerDownloadUrl(url, filename) {
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

export async function downloadOriginalFile(item, accessToken, apiKey = '') {
  if (!item) return;

  if (item.isDemo) {
    triggerDownloadUrl(item.demoDataUrl, item.name.replace(/\.[^.]+$/, '') + '.svg');
    return;
  }

  const fallbackDownloadUrl =
    item.webContentLink ||
    `https://drive.google.com/uc?export=download&id=${encodeURIComponent(item.id)}`;

  if (!accessToken && !apiKey) {
    if (item.webContentLink) {
      window.open(item.webContentLink, '_blank', 'noopener');
      return;
    }
    throw new Error(t('gdrive.missingDownloadAuth'));
  }

  const baseMediaUrl = `${DRIVE_API}/files/${encodeURIComponent(item.id)}?alt=media&supportsAllDrives=true`;
  const url = accessToken ? baseMediaUrl : `${baseMediaUrl}&key=${encodeURIComponent(apiKey)}`;
  const fetchOptions = accessToken ? { headers: { Authorization: `Bearer ${accessToken}` } } : {};

  try {
    const resp = await fetch(url, fetchOptions);
    if (!resp.ok) {
      if (!accessToken && apiKey) {
        window.open(fallbackDownloadUrl, '_blank', 'noopener');
        return;
      }
      if (item.webContentLink) {
        window.open(item.webContentLink, '_blank', 'noopener');
        return;
      }
      throw new Error(t('gdrive.downloadFailedStatus', { status: resp.status }));
    }

    const blob = await resp.blob();
    const objUrl = URL.createObjectURL(blob);
    triggerDownloadUrl(objUrl, item.name || 'photo');
    setTimeout(() => URL.revokeObjectURL(objUrl), 5000);
  } catch (err) {
    if (!accessToken && apiKey) {
      window.open(fallbackDownloadUrl, '_blank', 'noopener');
      return;
    }
    throw err;
  }
}
