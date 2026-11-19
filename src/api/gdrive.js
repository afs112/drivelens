/**
 * Google Drive API v3 & Google Identity Services (OAuth 2.0) Client
 */
import { APP_CONFIG } from '../constants.js';
import { t } from '../i18n.js';

const GIS_SCRIPT_URL = 'https://accounts.google.com/gsi/client';
const DRIVE_API = 'https://www.googleapis.com/drive/v3';
const SESSION_KEY = 'drivelens_session_v1';
const SAVED_USER_KEY = 'drivelens_oauth_user_v1';
const RENEWAL_TICKET_KEY = 'drivelens_oauth_renewal_v1';
const REDIRECT_PENDING_KEY = 'drivelens_oauth_redirect_pending_v1';
const REDIRECT_PENDING_TTL_MS = 15 * 60 * 1000;
const SCOPES = [
  'https://www.googleapis.com/auth/drive',
  'https://www.googleapis.com/auth/userinfo.profile',
  'https://www.googleapis.com/auth/userinfo.email',
].join(' ');

const FALLBACK_OAUTH_PROMPTS = new Set([
  'interaction_required',
  'consent_required',
  'login_required',
  'account_selection_required',
]);

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
let inFlightRenewalPromise = null;
let inFlightRenewalKey = '';

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

export function normalizeRenewalEndpoint(rawUrl) {
  const trimmed = String(rawUrl || '').trim();
  if (!trimmed) return '';
  try {
    const parsed = new URL(trimmed);
    const isHttps = parsed.protocol === 'https:';
    const isLocalHttp =
      parsed.protocol === 'http:' &&
      (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1');
    if (!isHttps && !isLocalHttp) {
      return '';
    }
    const cleanPath = parsed.pathname
      .replace(/\/+$/, '')
      .replace(/\/(exchange|refresh)$/i, '')
      .replace(/\/+$/, '');
    return `${parsed.origin}${cleanPath}`;
  } catch {
    return '';
  }
}

function readRenewalTicketFromStorage(storage, clientId, cleanUrl) {
  try {
    if (!storage || !clientId || !cleanUrl) return null;
    const raw = storage.getItem(RENEWAL_TICKET_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    if (String(parsed.clientId || '').trim() !== clientId) return null;
    if (normalizeRenewalEndpoint(parsed.renewalUrl) !== cleanUrl) return null;
    const refreshTicket = String(parsed.refreshTicket || '').trim();
    if (!refreshTicket) return null;
    return {
      clientId,
      renewalUrl: cleanUrl,
      refreshTicket,
      updatedAt: Number(parsed.updatedAt || 0),
    };
  } catch {
    return null;
  }
}

function getStoredRenewalTicketRecord(clientId, tokenRenewalUrl) {
  const trimmedClientId = String(clientId || '').trim();
  const cleanUrl = normalizeRenewalEndpoint(tokenRenewalUrl);
  if (!trimmedClientId || !cleanUrl) return null;
  return (
    readRenewalTicketFromStorage(
      typeof localStorage !== 'undefined' ? localStorage : null,
      trimmedClientId,
      cleanUrl
    ) ||
    readRenewalTicketFromStorage(
      typeof sessionStorage !== 'undefined' ? sessionStorage : null,
      trimmedClientId,
      cleanUrl
    )
  );
}

function saveRenewalTicketRecord({ clientId, renewalUrl, refreshTicket }, remember = true) {
  const payload = JSON.stringify({
    clientId,
    renewalUrl,
    refreshTicket,
    updatedAt: Date.now(),
  });
  const primary =
    remember !== false
      ? typeof localStorage !== 'undefined'
        ? localStorage
        : null
      : typeof sessionStorage !== 'undefined'
        ? sessionStorage
        : null;
  const secondary =
    remember !== false
      ? typeof sessionStorage !== 'undefined'
        ? sessionStorage
        : null
      : typeof localStorage !== 'undefined'
        ? localStorage
        : null;
  try {
    secondary?.removeItem(RENEWAL_TICKET_KEY);
  } catch {
    // Ignore storage restrictions
  }
  try {
    primary?.setItem(RENEWAL_TICKET_KEY, payload);
  } catch {
    // Ignore storage restrictions
  }
}

function clearRenewalTicketStorage() {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.removeItem(RENEWAL_TICKET_KEY);
    }
  } catch {
    // Ignore
  }
  try {
    if (typeof sessionStorage !== 'undefined') {
      sessionStorage.removeItem(RENEWAL_TICKET_KEY);
    }
  } catch {
    // Ignore
  }
}

export function hasStoredRenewalTicket(clientId, tokenRenewalUrl) {
  return Boolean(getStoredRenewalTicketRecord(clientId, tokenRenewalUrl));
}

export function getStoredRenewalTicket(clientId, tokenRenewalUrl) {
  return getStoredRenewalTicketRecord(clientId, tokenRenewalUrl)?.refreshTicket || '';
}

export function clearSession(options = {}) {
  const shouldClearRenewal = options?.forgetUser === true || options?.clearRenewal === true;
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.removeItem(SESSION_KEY);
      if (options?.forgetUser === true) {
        localStorage.removeItem(SAVED_USER_KEY);
      }
      if (shouldClearRenewal) {
        localStorage.removeItem(RENEWAL_TICKET_KEY);
      }
    }
  } catch {
    // Ignore
  }
  try {
    if (typeof sessionStorage !== 'undefined') {
      sessionStorage.removeItem(SESSION_KEY);
      if (shouldClearRenewal) {
        sessionStorage.removeItem(RENEWAL_TICKET_KEY);
      }
    }
  } catch {
    // Ignore
  }
}

function persistOAuthSession(session, remember = true) {
  const { clientId, user } = session;
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
            clientId,
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
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.removeItem(SESSION_KEY);
        localStorage.removeItem(SAVED_USER_KEY);
      }
    } catch {
      // Ignore storage restrictions
    }
    try {
      if (typeof sessionStorage !== 'undefined') {
        sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
      }
    } catch {
      // Ignore sessionStorage restrictions
    }
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

export async function renewOAuthSessionSilently(
  clientId,
  tokenRenewalUrl,
  { remember = true } = {}
) {
  const trimmedClientId = String(clientId || '').trim();
  const cleanUrl = normalizeRenewalEndpoint(tokenRenewalUrl);
  const stored = getStoredRenewalTicketRecord(trimmedClientId, cleanUrl);
  if (!trimmedClientId || !cleanUrl || !stored?.refreshTicket) {
    return null;
  }

  const dedupeKey = `${trimmedClientId}|${cleanUrl}`;
  if (inFlightRenewalPromise && inFlightRenewalKey === dedupeKey) {
    return inFlightRenewalPromise;
  }

  inFlightRenewalKey = dedupeKey;
  inFlightRenewalPromise = (async () => {
    let resp;
    try {
      resp = await fetch(`${cleanUrl}/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_id: trimmedClientId,
          refresh_ticket: stored.refreshTicket,
        }),
      });
    } catch {
      // Transient network error: preserve stored renewal ticket
      return null;
    }

    if (resp.status === 400 || resp.status === 401 || resp.status === 403) {
      clearRenewalTicketStorage();
      return null;
    }
    if (!resp.ok) {
      // 5xx or transient gateway error: preserve stored renewal ticket
      return null;
    }

    let data = null;
    try {
      data = await resp.json();
    } catch {
      return null;
    }
    const accessToken = String(data?.access_token || '').trim();
    if (!accessToken) {
      return null;
    }

    const expiresInSec = Number(data?.expires_in || 3600);
    const expiresAt = Date.now() + expiresInSec * 1000;
    const savedUser = getSavedOAuthUser(trimmedClientId);
    const user = savedUser
      ? {
          id: savedUser.id || savedUser.email || 'gdrive-user',
          email: savedUser.email || '',
          name: savedUser.name || savedUser.email || t('gdrive.defaultUser'),
          picture: savedUser.picture || '',
          color: savedUser.color || '#38bdf8',
        }
      : await fetchUserProfile(accessToken);

    const session = { clientId: trimmedClientId, accessToken, expiresAt, user };
    persistOAuthSession(session, remember);

    const rotatedTicket = String(data?.refresh_ticket || data?.refresh_token || '').trim();
    if (rotatedTicket) {
      saveRenewalTicketRecord(
        {
          clientId: trimmedClientId,
          renewalUrl: cleanUrl,
          refreshTicket: rotatedTicket,
        },
        remember
      );
    }

    return {
      ...session,
      hasSilentRenewal: true,
    };
  })().finally(() => {
    inFlightRenewalPromise = null;
    inFlightRenewalKey = '';
  });

  return inFlightRenewalPromise;
}

function buildGisPopupError(err) {
  const errType = String(err?.type || '');
  const isClosed = errType === 'popup_closed';
  const msg = isClosed
    ? t('gdrive.popupClosed')
    : errType === 'popup_failed_to_open'
      ? t('gdrive.popupBlocked')
      : err?.message || t('gdrive.popupBlocked');
  const customErr = new Error(msg);
  if (errType) customErr.oauthError = errType;
  customErr.isPopupBlocked =
    !isClosed &&
    (errType === 'popup_failed_to_open' ||
      /popup/i.test(String(err?.type || err?.message || '')));
  return customErr;
}

function requestTokenViaGis(trimmedClientId, promptMode, hintVal) {
  return new Promise((resolve, reject) => {
    try {
      const client = window.google.accounts.oauth2.initTokenClient({
        client_id: trimmedClientId,
        scope: SCOPES,
        ...(hintVal ? { hint: hintVal } : {}),
        callback: (response) => {
          if (response?.error) {
            const err = new Error(
              response.error_description || response.error || t('gdrive.authFailed')
            );
            err.oauthError = response.error;
            reject(err);
            return;
          }
          if (!response?.access_token) {
            reject(new Error(t('gdrive.authFailed')));
            return;
          }
          resolve(response);
        },
        error_callback: (err) => {
          reject(buildGisPopupError(err));
        },
      });
      client.requestAccessToken({
        prompt: promptMode,
        ...(hintVal ? { hint: hintVal } : {}),
      });
    } catch (err) {
      reject(err);
    }
  });
}

function requestCodeViaGis(trimmedClientId, promptMode, hintVal) {
  return new Promise((resolve, reject) => {
    try {
      const codeClient = window.google.accounts.oauth2.initCodeClient({
        client_id: trimmedClientId,
        scope: SCOPES,
        ux_mode: 'popup',
        select_account: promptMode === 'select_account',
        ...(hintVal ? { hint: hintVal } : {}),
        callback: (response) => {
          if (!response || response.error || !response.code) {
            const err = new Error(
              response?.error_description || response?.error || t('gdrive.authFailed')
            );
            if (response?.error) err.oauthError = response.error;
            reject(err);
            return;
          }
          resolve(response);
        },
        error_callback: (err) => {
          reject(buildGisPopupError(err));
        },
      });
      codeClient.requestCode();
    } catch (err) {
      reject(err);
    }
  });
}

async function finalizeTokenSession({
  clientId,
  accessToken,
  expiresInSec,
  remember = true,
  hasSilentRenewal = false,
  clearRenewal = false,
}) {
  const expiresAt = Date.now() + Number(expiresInSec || 3600) * 1000;
  const user = await fetchUserProfile(accessToken);
  const session = { clientId, accessToken, expiresAt, user };
  if (remember === false) {
    clearSession({ forgetUser: true, clearRenewal });
  }
  persistOAuthSession(session, remember);
  return {
    ...session,
    hasSilentRenewal,
  };
}

async function exchangeCodeForSession({
  code,
  clientId,
  renewalUrl,
  redirectUri = 'postmessage',
  remember = true,
}) {
  const exchangeResp = await fetch(`${renewalUrl}/exchange`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      code,
      client_id: clientId,
      redirect_uri: redirectUri,
    }),
  });
  const exchangeData = await exchangeResp.json().catch(() => null);
  if (!exchangeResp.ok || !exchangeData?.access_token) {
    throw new Error(
      exchangeData?.error_description || exchangeData?.error || t('gdrive.authFailed')
    );
  }

  const incomingTicket = String(
    exchangeData.refresh_ticket || exchangeData.refresh_token || ''
  ).trim();
  const existingTicket =
    getStoredRenewalTicketRecord(clientId, renewalUrl)?.refreshTicket || '';
  const savedTicket = incomingTicket || existingTicket;

  const session = await finalizeTokenSession({
    clientId,
    accessToken: exchangeData.access_token,
    expiresInSec: exchangeData.expires_in,
    remember,
    hasSilentRenewal: Boolean(savedTicket),
    clearRenewal: true,
  });

  if (savedTicket) {
    saveRenewalTicketRecord(
      {
        clientId,
        renewalUrl,
        refreshTicket: savedTicket,
      },
      remember
    );
  }
  return session;
}

export function authenticateGoogle(clientId, options = {}) {
  const {
    prompt = 'select_account',
    loginHint = '',
    remember = true,
    tokenRenewalUrl = '',
    allowSilentFirst = false,
  } = options;
  const trimmedClientId = String(clientId || '').trim();
  if (!trimmedClientId) {
    return Promise.reject(new Error(t('gdrive.missingClientId')));
  }

  const cleanRenewalUrl = normalizeRenewalEndpoint(tokenRenewalUrl);
  const hintVal = String(loginHint || getSavedOAuthUser(trimmedClientId)?.email || '').trim();

  const launchGisSync = () => {
    if (
      cleanRenewalUrl &&
      typeof window.google?.accounts?.oauth2?.initCodeClient === 'function'
    ) {
      return requestCodeViaGis(trimmedClientId, prompt, hintVal).then((codeResp) =>
        exchangeCodeForSession({
          code: codeResp.code,
          clientId: trimmedClientId,
          renewalUrl: cleanRenewalUrl,
          redirectUri: 'postmessage',
          remember,
        })
      );
    }

    // Path A: Pure-Static Page (or fallback when only initTokenClient is mocked)
    return requestTokenViaGis(trimmedClientId, prompt, hintVal)
      .catch((err) => {
        const canRetryPopup =
          typeof navigator === 'undefined' ||
          !navigator.userActivation ||
          navigator.userActivation.isActive;
        if (prompt === '' && FALLBACK_OAUTH_PROMPTS.has(err?.oauthError)) {
          if (canRetryPopup) {
            return requestTokenViaGis(trimmedClientId, 'select_account', hintVal);
          }
          const retryErr = new Error(t('toast.reauthToSync'));
          retryErr.oauthError = err.oauthError;
          throw retryErr;
        }
        throw err;
      })
      .then((tokenResult) =>
        finalizeTokenSession({
          clientId: trimmedClientId,
          accessToken: tokenResult.access_token,
          expiresInSec: tokenResult.expires_in,
          remember,
          hasSilentRenewal: false,
          clearRenewal: false,
        })
      );
  };

  // Synchronous zero-await path: preserve Transient User Activation on mobile browsers
  if (!allowSilentFirst && window.google?.accounts?.oauth2) {
    return launchGisSync();
  }

  return (async () => {
    // Path B: Optional Renewal Endpoint (silent refresh first when allowed)
    if (
      allowSilentFirst &&
      cleanRenewalUrl &&
      prompt !== 'select_account' &&
      prompt !== 'consent' &&
      hasStoredRenewalTicket(trimmedClientId, cleanRenewalUrl)
    ) {
      const silent = await renewOAuthSessionSilently(trimmedClientId, cleanRenewalUrl, {
        remember,
      });
      if (silent) return silent;
    }

    await ensureGoogleIdentityLoaded();
    return launchGisSync();
  })();
}

export function getCleanOAuthRedirectUri() {
  if (typeof window === 'undefined' || !window.location) return '';
  return `${window.location.origin}${window.location.pathname}`;
}

function generateOAuthState() {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
      const bytes = new Uint8Array(16);
      crypto.getRandomValues(bytes);
      return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
    }
  } catch {
    // Fallback below
  }
  return `${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
}

function writePendingRedirectRecord(payload) {
  const raw = JSON.stringify(payload);
  for (const storage of [
    typeof sessionStorage !== 'undefined' ? sessionStorage : null,
    typeof localStorage !== 'undefined' ? localStorage : null,
  ]) {
    try {
      storage?.setItem(REDIRECT_PENDING_KEY, raw);
    } catch {
      // Ignore storage restrictions
    }
  }
}

function clearPendingRedirectRecord() {
  for (const storage of [
    typeof sessionStorage !== 'undefined' ? sessionStorage : null,
    typeof localStorage !== 'undefined' ? localStorage : null,
  ]) {
    try {
      storage?.removeItem(REDIRECT_PENDING_KEY);
    } catch {
      // Ignore storage restrictions
    }
  }
}

function readPendingRedirectRecord(expectedState) {
  const now = Date.now();
  for (const storage of [
    typeof sessionStorage !== 'undefined' ? sessionStorage : null,
    typeof localStorage !== 'undefined' ? localStorage : null,
  ]) {
    try {
      const raw = storage?.getItem(REDIRECT_PENDING_KEY);
      if (!raw) continue;
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') continue;
      const age = now - Number(parsed.savedAt || 0);
      if (age < 0 || age > REDIRECT_PENDING_TTL_MS) {
        clearPendingRedirectRecord();
        continue;
      }
      if (expectedState && parsed.state === expectedState && parsed.clientId) {
        return parsed;
      }
    } catch {
      // Ignore malformed storage
    }
  }
  return null;
}

export function startOAuthRedirectFlow({
  clientId,
  folderId,
  tokenRenewalUrl = '',
  remember = true,
  loginHint = '',
}) {
  const trimmedClientId = String(clientId || '').trim();
  if (!trimmedClientId) {
    throw new Error(t('gdrive.missingClientId'));
  }
  const cleanFolderId = parseDriveFolderId(folderId) || String(folderId || '').trim();
  const cleanRenewalUrl = normalizeRenewalEndpoint(tokenRenewalUrl);
  const redirectUri = getCleanOAuthRedirectUri();
  const state = generateOAuthState();

  writePendingRedirectRecord({
    state,
    clientId: trimmedClientId,
    folderId: cleanFolderId,
    tokenRenewalUrl: cleanRenewalUrl,
    remember: remember !== false,
    savedAt: Date.now(),
  });

  const hintVal = String(loginHint || getSavedOAuthUser(trimmedClientId)?.email || '').trim();
  const params = new URLSearchParams({
    client_id: trimmedClientId,
    redirect_uri: redirectUri,
    scope: SCOPES,
    include_granted_scopes: 'true',
    state,
  });
  if (cleanRenewalUrl) {
    params.set('response_type', 'code');
    params.set('access_type', 'offline');
    params.set('prompt', 'consent');
  } else {
    params.set('response_type', 'token');
  }
  if (hintVal) {
    params.set('login_hint', hintVal);
  }

  window.location.assign(`https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`);
}

export async function consumeOAuthRedirectCallback() {
  if (typeof window === 'undefined' || !window.location) return null;

  const searchParams = new URLSearchParams(window.location.search || '');
  const rawHash = window.location.hash || '';
  const hashBody = rawHash.startsWith('#') ? rawHash.slice(1) : rawHash;
  const hashParams = new URLSearchParams(hashBody);

  const code = (searchParams.get('code') || '').trim();
  const accessToken = (hashParams.get('access_token') || '').trim();
  const oauthError = (searchParams.get('error') || hashParams.get('error') || '').trim();
  const oauthErrorDesc = (
    searchParams.get('error_description') ||
    hashParams.get('error_description') ||
    ''
  ).trim();
  const incomingState = (searchParams.get('state') || hashParams.get('state') || '').trim();

  if ((!code && !accessToken && !oauthError) || !incomingState) {
    return null;
  }

  const pending = readPendingRedirectRecord(incomingState);
  if (!pending) {
    return null;
  }

  clearPendingRedirectRecord();

  const oauthParamKeys = [
    'code',
    'scope',
    'authuser',
    'prompt',
    'state',
    'access_token',
    'token_type',
    'expires_in',
    'error',
    'error_description',
    'hd',
  ];
  for (const key of oauthParamKeys) {
    searchParams.delete(key);
    hashParams.delete(key);
  }
  const cleanSearch = searchParams.toString();
  const cleanHash = hashParams.toString();
  const cleanUrl = `${window.location.pathname}${cleanSearch ? `?${cleanSearch}` : ''}${cleanHash ? `#${cleanHash}` : ''}`;
  try {
    window.history.replaceState(null, '', cleanUrl);
  } catch {
    // Ignore history restrictions
  }

  if (oauthError) {
    const err = new Error(oauthErrorDesc || oauthError || t('gdrive.authFailed'));
    err.oauthError = oauthError;
    throw err;
  }

  const remember = pending.remember !== false;
  if (code) {
    if (!pending.tokenRenewalUrl) {
      throw new Error(t('gdrive.authFailed'));
    }
    const session = await exchangeCodeForSession({
      code,
      clientId: pending.clientId,
      renewalUrl: pending.tokenRenewalUrl,
      redirectUri: getCleanOAuthRedirectUri(),
      remember,
    });
    return {
      session,
      folderId: pending.folderId,
      clientId: pending.clientId,
      tokenRenewalUrl: pending.tokenRenewalUrl,
      remember,
    };
  }

  const session = await finalizeTokenSession({
    clientId: pending.clientId,
    accessToken,
    expiresInSec: hashParams.get('expires_in'),
    remember,
    hasSilentRenewal: false,
    clearRenewal: false,
  });
  return {
    session,
    folderId: pending.folderId,
    clientId: pending.clientId,
    tokenRenewalUrl: '',
    remember,
  };
}

async function isRetryableDriveResponse(resp) {
  if (
    resp.status === 429 ||
    resp.status === 500 ||
    resp.status === 502 ||
    resp.status === 503 ||
    resp.status === 504
  ) {
    return true;
  }
  if (resp.status === 403) {
    const bodyText = await resp
      .clone()
      .text()
      .catch(() => '');
    return bodyText.includes('rateLimitExceeded') || bodyText.includes('userRateLimitExceeded');
  }
  return false;
}

function sleepWithAbort(ms, signal = null) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      reject(new DOMException('Aborted', 'AbortError'));
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Official Google Drive API truncated exponential backoff with random millisecond jitter:
 * wait = min((2^n) * 1000 + random_ms(0..1000), maximum_backoff)
 * Ref: https://developers.google.com/workspace/drive/api/guides/limits
 */
export async function fetchWithDriveBackoff(
  url,
  fetchOptions = {},
  {
    maxRetries = APP_CONFIG.DRIVE_MAX_RETRIES || 4,
    maxBackoffMs = APP_CONFIG.DRIVE_MAX_BACKOFF_MS || 32000,
    baseDelayMs = 1000,
  } = {}
) {
  const signal = fetchOptions?.signal || null;
  let attempt = 0;

  while (true) {
    const resp = await fetch(url, fetchOptions);
    if (resp.ok || attempt >= maxRetries || !(await isRetryableDriveResponse(resp))) {
      return resp;
    }

    const retryAfterSec = Number(resp.headers.get('retry-after') || 0);
    const jitterMs = Math.floor(Math.random() * 1000);
    const expMs = Math.min(2 ** attempt * baseDelayMs + jitterMs, maxBackoffMs);
    const waitMs =
      Number.isFinite(retryAfterSec) && retryAfterSec > 0
        ? Math.min(Math.max(expMs, retryAfterSec * 1000 + jitterMs), maxBackoffMs)
        : expMs;

    attempt += 1;
    await sleepWithAbort(waitMs, signal);
  }
}

export const DRIVE_FILE_FIELDS =
  'id,name,mimeType,parents,size,createdTime,modifiedTime,thumbnailLink,imageMediaMetadata(width,height,time,cameraMake,cameraModel,focalLength,aperture,exposureTime,isoSpeed),videoMediaMetadata(width,height,durationMillis)';

const FOLDER_MIME = 'application/vnd.google-apps.folder';
const MEDIA_OR_FOLDER_PREDICATE =
  "trashed = false and (mimeType = 'application/vnd.google-apps.folder' or mimeType contains 'image/' or mimeType contains 'video/')";
const MEDIA_ONLY_PREDICATE = "trashed = false and (mimeType contains 'image/' or mimeType contains 'video/')";
const FOLDER_ONLY_PREDICATE = "trashed = false and mimeType = 'application/vnd.google-apps.folder'";
const GROUP_BATCH_SIZE = 25;
const MAX_CRAWL_DEPTH = 6;
const MAX_CHANGES_PAGES = 15;

export function buildDriveWebViewLink(fileId) {
  return fileId ? `https://drive.google.com/file/d/${encodeURIComponent(fileId)}/view` : '';
}

function escapeDriveQueryValue(value) {
  return String(value || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function isMediaMimeType(mimeType) {
  return typeof mimeType === 'string' && (mimeType.startsWith('image/') || mimeType.startsWith('video/'));
}

function normalizeDriveFile(entry, parentId = '', fetchedAt = Date.now()) {
  const thumb = entry.thumbnailLink || '';
  return {
    id: entry.id,
    name: entry.name,
    parentId,
    mimeType: entry.mimeType || 'image/jpeg',
    size: Number(entry.size || 0),
    createdTime: entry.createdTime || '',
    modifiedTime: entry.modifiedTime || '',
    thumbnailLink: thumb,
    thumbFetchedAt: thumb ? fetchedAt : 0,
    webViewLink: buildDriveWebViewLink(entry.id),
    webContentLink: '',
    imageMediaMetadata: entry.imageMediaMetadata || null,
    videoMediaMetadata: entry.videoMediaMetadata || null,
    isDemo: false,
  };
}

function chunkItems(items, size) {
  const out = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

function resolveAuth(auth = {}) {
  return typeof auth === 'string' ? { accessToken: auth, apiKey: '' } : auth || {};
}

export async function fetchFreshThumbnailLink(fileId, auth = {}, signal = null) {
  if (!fileId) return '';
  const { accessToken = '', apiKey = '' } = resolveAuth(auth);
  if (!accessToken && !apiKey) return '';

  const baseUrl = `${DRIVE_API}/files/${encodeURIComponent(fileId)}?fields=thumbnailLink&supportsAllDrives=true`;
  const url = !accessToken && apiKey ? `${baseUrl}&key=${encodeURIComponent(apiKey)}` : baseUrl;
  const headers = accessToken ? { Authorization: `Bearer ${accessToken}` } : {};
  try {
    const resp = await fetchWithDriveBackoff(url, { headers, signal }, { maxRetries: 2 });
    if (!resp.ok) return '';
    const data = await resp.json();
    return typeof data?.thumbnailLink === 'string' ? data.thumbnailLink : '';
  } catch (err) {
    if (err?.name === 'AbortError') throw err;
    return '';
  }
}

export async function fetchBatchThumbnailLinks(items = [], auth = {}, signal = null) {
  const resultMap = new Map();
  const { accessToken = '', apiKey = '' } = resolveAuth(auth);
  if ((!accessToken && !apiKey) || !Array.isArray(items) || items.length === 0) {
    return resultMap;
  }

  const seenIds = new Set();
  const groupable = [];
  const fallbackItems = [];

  for (const item of items) {
    const id = item?.id;
    if (!id || seenIds.has(id)) continue;
    seenIds.add(id);
    if (item.parentId && item.name) {
      groupable.push(item);
    } else {
      fallbackItems.push(item);
    }
  }

  const headers = accessToken ? { Authorization: `Bearer ${accessToken}` } : {};
  const chunks = chunkItems(groupable, GROUP_BATCH_SIZE);

  for (const chunk of chunks) {
    if (signal?.aborted) {
      throw new DOMException('Aborted', 'AbortError');
    }
    const requestedIdSet = new Set(chunk.map((x) => x.id));
    const uniqueParents = Array.from(new Set(chunk.map((x) => x.parentId)));
    const uniqueNames = Array.from(new Set(chunk.map((x) => x.name)));
    const parentQ = uniqueParents.map((p) => `'${escapeDriveQueryValue(p)}' in parents`).join(' or ');
    const nameQ = uniqueNames.map((n) => `name = '${escapeDriveQueryValue(n)}'`).join(' or ');
    const q = `(${parentQ}) and (${nameQ}) and trashed = false`;

    const params = new URLSearchParams({
      q,
      fields: 'files(id,thumbnailLink)',
      pageSize: '100',
      supportsAllDrives: 'true',
      includeItemsFromAllDrives: 'true',
    });
    if (!accessToken && apiKey) {
      params.set('key', apiKey);
    }

    try {
      const resp = await fetchWithDriveBackoff(
        `${DRIVE_API}/files?${params.toString()}`,
        { headers, signal },
        { maxRetries: 2 }
      );
      if (!resp.ok) {
        fallbackItems.push(...chunk);
        continue;
      }
      const data = await resp.json();
      const files = Array.isArray(data?.files) ? data.files : [];
      const seenInResponse = new Set();
      for (const f of files) {
        if (f?.id) seenInResponse.add(f.id);
        if (f?.id && requestedIdSet.has(f.id) && typeof f.thumbnailLink === 'string' && f.thumbnailLink) {
          resultMap.set(f.id, f.thumbnailLink);
        }
      }
      if (files.length >= 100) {
        for (const item of chunk) {
          if (!seenInResponse.has(item.id)) {
            fallbackItems.push(item);
          }
        }
      }
    } catch (err) {
      if (err?.name === 'AbortError') throw err;
      fallbackItems.push(...chunk);
    }
  }

  if (fallbackItems.length > 0) {
    const CONCURRENCY = 4;
    let cursor = 0;
    const worker = async () => {
      while (cursor < fallbackItems.length) {
        if (signal?.aborted) {
          throw new DOMException('Aborted', 'AbortError');
        }
        const item = fallbackItems[cursor];
        cursor += 1;
        const link = await fetchFreshThumbnailLink(item.id, auth, signal);
        if (link) {
          resultMap.set(item.id, link);
        }
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(CONCURRENCY, fallbackItems.length) }, () => worker())
    );
  }

  return resultMap;
}

async function driveJsonFetch(url, auth = {}, signal = null) {
  const { accessToken = '', apiKey = '' } = resolveAuth(auth);
  const headers = accessToken ? { Authorization: `Bearer ${accessToken}` } : {};
  const resp = await fetchWithDriveBackoff(url, { headers, signal });

  if (resp.status === 400) {
    const text = await resp.text().catch(() => '');
    let msg = t('gdrive.errHttp', { status: 400 });
    if (!accessToken && apiKey) {
      if (text.includes('API_KEY_INVALID') || text.includes('keyInvalid') || text.includes('key')) {
        msg = t('gdrive.err400InvalidKey');
      } else {
        msg = t('gdrive.err400BadRequest');
      }
    }
    const err = new Error(msg);
    err.status = 400;
    err.responseText = text;
    throw err;
  }
  if (resp.status === 401) {
    clearSession();
    const err = new Error(t('gdrive.err401Expired'));
    err.status = 401;
    throw err;
  }
  if (resp.status === 403) {
    const text = await resp.text().catch(() => '');
    let msg = t('gdrive.err403Forbidden');
    if (text.includes('rateLimitExceeded') || text.includes('userRateLimitExceeded')) {
      msg = t('gdrive.err403RateLimit');
    } else if (!accessToken && apiKey) {
      if (text.includes('accessNotConfigured') || text.includes('SERVICE_DISABLED')) {
        msg = t('gdrive.err403Disabled');
      } else if (text.includes('API_KEY_INVALID') || text.includes('keyInvalid')) {
        msg = t('gdrive.err403KeyRestricted');
      } else {
        msg = t('gdrive.err403LinkAccess');
      }
    }
    const err = new Error(msg);
    err.status = 403;
    err.responseText = text;
    throw err;
  }
  if (resp.status === 404) {
    const err = new Error(
      !accessToken && apiKey ? t('gdrive.err404ApiKey') : t('gdrive.err404NotFound')
    );
    err.status = 404;
    throw err;
  }
  if (!resp.ok) {
    const err = new Error(t('gdrive.errHttp', { status: resp.status }));
    err.status = resp.status;
    throw err;
  }
  return resp.json();
}

function isSplittableQueryError(err) {
  if (!err || (err.status !== 400 && err.status !== 403)) return false;
  const text = String(err.responseText || '');
  if (
    text.includes('API_KEY_INVALID') ||
    text.includes('keyInvalid') ||
    text.includes('SERVICE_DISABLED') ||
    text.includes('accessNotConfigured')
  ) {
    return false;
  }
  return true;
}

async function listGroupedChildrenPages(
  folderIds,
  auth,
  {
    fields = `nextPageToken,files(${DRIVE_FILE_FIELDS})`,
    predicate = MEDIA_OR_FOLDER_PREDICATE,
    pageSize = APP_CONFIG.DRIVE_LIST_PAGE_SIZE || 1000,
    signal = null,
    onPage = null,
  } = {}
) {
  if (!Array.isArray(folderIds) || folderIds.length === 0) return [];
  const { accessToken = '', apiKey = '' } = resolveAuth(auth);
  const parentClauses = folderIds.map((id) => `'${escapeDriveQueryValue(id)}' in parents`).join(' or ');
  const q = folderIds.length === 1 ? `${parentClauses} and ${predicate}` : `(${parentClauses}) and ${predicate}`;

  const collected = onPage ? null : [];
  let pageToken = '';
  let emittedAnyPage = false;

  try {
    do {
      if (signal?.aborted) {
        throw new DOMException('Aborted', 'AbortError');
      }
      const params = new URLSearchParams({
        q,
        fields,
        pageSize: String(pageSize),
        supportsAllDrives: 'true',
        includeItemsFromAllDrives: 'true',
      });
      if (pageToken) params.set('pageToken', pageToken);
      if (!accessToken && apiKey) params.set('key', apiKey);

      const data = await driveJsonFetch(`${DRIVE_API}/files?${params.toString()}`, auth, signal);
      const pageFiles = Array.isArray(data.files) ? data.files : [];
      pageToken = data.nextPageToken || '';
      emittedAnyPage = true;
      if (onPage) {
        onPage(pageFiles, Boolean(pageToken));
      } else {
        collected.push(...pageFiles);
      }
    } while (pageToken);
  } catch (err) {
    if (err?.name === 'AbortError') throw err;
    if (folderIds.length > 1 && !emittedAnyPage && isSplittableQueryError(err)) {
      const mid = Math.ceil(folderIds.length / 2);
      const left = await listGroupedChildrenPages(folderIds.slice(0, mid), auth, {
        fields,
        predicate,
        pageSize,
        signal,
        onPage,
      });
      const right = await listGroupedChildrenPages(folderIds.slice(mid), auth, {
        fields,
        predicate,
        pageSize,
        signal,
        onPage,
      });
      return onPage ? [] : [...left, ...right];
    }
    throw err;
  }

  return collected || [];
}

async function fetchStartPageToken(auth, driveId = '', signal = null) {
  const { accessToken = '' } = resolveAuth(auth);
  if (!accessToken) return '';
  const params = new URLSearchParams({ supportsAllDrives: 'true' });
  if (driveId) params.set('driveId', driveId);
  try {
    const resp = await fetchWithDriveBackoff(
      `${DRIVE_API}/changes/startPageToken?${params.toString()}`,
      { headers: { Authorization: `Bearer ${accessToken}` }, signal },
      { maxRetries: 2 }
    );
    if (!resp.ok) return '';
    const data = await resp.json();
    return typeof data?.startPageToken === 'string' ? data.startPageToken : '';
  } catch (err) {
    if (err?.name === 'AbortError') throw err;
    return '';
  }
}

async function crawlAlbumTree({
  rootFolder,
  auth,
  onProgress = null,
  onBatch = null,
  captureMetaFolder = true,
  signal = null,
}) {
  const crawlStartIso = new Date(Date.now() - 60_000).toISOString();
  const crawlStartedAt = Date.now();
  const folders = [rootFolder];
  const files = [];
  const seenFileIds = new Set();
  let metaFolderId = null;

  let queue = [{ id: rootFolder.id, depth: rootFolder.depth || 0 }];
  const visited = new Set([rootFolder.id]);

  let lastBatchEmit = 0;
  let lastEmittedFileCount = 0;
  let emittedInitialBatch = false;
  let pendingNewFiles = [];

  while (queue.length > 0) {
    if (signal?.aborted) {
      throw new DOMException('Aborted', 'AbortError');
    }
    const wave = queue;
    queue = [];
    const chunks = chunkItems(wave, GROUP_BATCH_SIZE);
    let nextChunkIdx = 0;
    let remainingChunks = chunks.length;

    const runChunkWorker = async () => {
      while (nextChunkIdx < chunks.length) {
        const myIdx = nextChunkIdx;
        nextChunkIdx += 1;
        const batch = chunks[myIdx];
        const batchIds = batch.map((n) => n.id);
        const batchDepthById = new Map(batch.map((n) => [n.id, n.depth]));
        const batchIdSet = new Set(batchIds);

        try {
          await listGroupedChildrenPages(batchIds, auth, {
            fields: `nextPageToken,files(${DRIVE_FILE_FIELDS})`,
            predicate: MEDIA_OR_FOLDER_PREDICATE,
            pageSize: APP_CONFIG.DRIVE_LIST_PAGE_SIZE || 1000,
            signal,
            onPage: (pageFiles, hasMoreInQuery) => {
              const now = Date.now();
              for (const entry of pageFiles) {
                const parentId =
                  (Array.isArray(entry.parents) &&
                    (entry.parents.find((pid) => batchIdSet.has(pid)) || entry.parents[0])) ||
                  (batchIds.length === 1 ? batchIds[0] : rootFolder.id);
                const parentDepth = batchDepthById.get(parentId) ?? 0;

                if (entry.mimeType === FOLDER_MIME) {
                  if (captureMetaFolder && entry.name === '.drivelens' && parentId === rootFolder.id) {
                    metaFolderId = entry.id;
                    continue;
                  }
                  if (entry.name?.startsWith('.')) {
                    continue;
                  }
                  if (!visited.has(entry.id) && parentDepth + 1 <= MAX_CRAWL_DEPTH) {
                    visited.add(entry.id);
                    const nextDepth = parentDepth + 1;
                    folders.push({
                      id: entry.id,
                      name: entry.name,
                      parentId,
                      depth: nextDepth,
                    });
                    queue.push({ id: entry.id, depth: nextDepth });
                  }
                } else if (!seenFileIds.has(entry.id)) {
                  seenFileIds.add(entry.id);
                  const normalized = normalizeDriveFile(entry, parentId, now);
                  files.push(normalized);
                  pendingNewFiles.push(normalized);
                }
              }

              if (onProgress) {
                onProgress({ folderCount: folders.length, fileCount: files.length });
              }

              const hasMoreWork = hasMoreInQuery || queue.length > 0 || remainingChunks > 1;
              if (onBatch && files.length > 0 && hasMoreWork) {
                const shouldEmit = !emittedInitialBatch
                  ? now - crawlStartedAt >= 480 || files.length >= 240
                  : files.length < 5000
                    ? now - lastBatchEmit >= 900
                    : now - lastBatchEmit >= 2500 ||
                      files.length >= Math.ceil(lastEmittedFileCount * 1.25);

                if (shouldEmit) {
                  emittedInitialBatch = true;
                  lastBatchEmit = now;
                  lastEmittedFileCount = files.length;
                  const newFiles = pendingNewFiles;
                  pendingNewFiles = [];
                  onBatch({
                    rootFolder,
                    folders: [...folders],
                    files,
                    newFiles,
                    isStreaming: true,
                    metaFolderId,
                    canWrite: rootFolder.canWrite,
                  });
                }
              }
            },
          });
        } finally {
          remainingChunks -= 1;
        }
      }
    };

    const workerCount = Math.min(3, chunks.length);
    await Promise.all(Array.from({ length: workerCount }, () => runChunkWorker()));
  }

  return {
    rootFolder,
    folders,
    files,
    metaFolderId,
    canWrite: rootFolder.canWrite,
    syncWatermark: crawlStartIso,
  };
}

export async function loadSharedAlbum(folderId, accessToken, onProgress = null, onBatch = null) {
  const cleanId = parseDriveFolderId(folderId);
  if (!cleanId) {
    throw new Error(t('gdrive.invalidFolder'));
  }

  const auth = { accessToken };
  const rootParams = new URLSearchParams({
    fields: 'id,name,mimeType,driveId,capabilities(canAddChildren,canEdit),owners(displayName,emailAddress)',
    supportsAllDrives: 'true',
  });
  const rootMeta = await driveJsonFetch(
    `${DRIVE_API}/files/${encodeURIComponent(cleanId)}?${rootParams.toString()}`,
    auth
  );

  if (rootMeta.mimeType !== FOLDER_MIME) {
    throw new Error(t('gdrive.notFolder'));
  }

  const canWrite = Boolean(rootMeta.capabilities?.canAddChildren ?? rootMeta.capabilities?.canEdit ?? false);
  const rootFolder = {
    id: rootMeta.id,
    name: rootMeta.name || t('gdrive.defaultAlbumName'),
    parentId: null,
    depth: 0,
    canWrite,
    driveId: rootMeta.driveId || '',
  };

  const result = await crawlAlbumTree({
    rootFolder,
    auth,
    onProgress,
    onBatch,
    captureMetaFolder: true,
  });
  const startPageToken = await fetchStartPageToken(auth, rootFolder.driveId);
  return {
    ...result,
    startPageToken,
  };
}

export async function loadSharedAlbumWithApiKey(
  folderId,
  apiKey,
  onProgress = null,
  onBatch = null
) {
  const cleanId = parseDriveFolderId(folderId);
  if (!cleanId) {
    throw new Error(t('gdrive.invalidFolder'));
  }
  const cleanKey = String(apiKey || '').trim();
  if (!cleanKey) {
    throw new Error(t('gdrive.missingApiKey'));
  }

  const auth = { apiKey: cleanKey };
  const rootUrl = `${DRIVE_API}/files/${encodeURIComponent(cleanId)}?fields=id,name,mimeType,driveId&supportsAllDrives=true&key=${encodeURIComponent(cleanKey)}`;
  const rootMeta = await driveJsonFetch(rootUrl, auth);

  if (rootMeta.mimeType !== FOLDER_MIME) {
    throw new Error(t('gdrive.notFolder'));
  }

  const rootFolder = {
    id: rootMeta.id,
    name: rootMeta.name || t('gdrive.defaultAlbumName'),
    parentId: null,
    depth: 0,
    canWrite: true,
    driveId: rootMeta.driveId || '',
  };

  const result = await crawlAlbumTree({
    rootFolder,
    auth,
    onProgress,
    onBatch,
    captureMetaFolder: false,
  });
  return {
    ...result,
    startPageToken: '',
  };
}

function pruneFolderSubtree(folderMap, targetId) {
  const stack = [targetId];
  while (stack.length > 0) {
    const id = stack.pop();
    if (!folderMap.has(id)) continue;
    folderMap.delete(id);
    for (const [childId, folder] of folderMap.entries()) {
      if (folder.parentId === id) {
        stack.push(childId);
      }
    }
  }
}

async function crawlSubtreeIntoMaps({
  seedFolders,
  folderMap,
  upsertedMap,
  auth,
  signal = null,
}) {
  if (!seedFolders.length) return;
  const visited = new Set(seedFolders.map((s) => s.id));
  let queue = seedFolders.map((s) => ({ id: s.id, depth: s.depth }));

  while (queue.length > 0) {
    if (signal?.aborted) {
      throw new DOMException('Aborted', 'AbortError');
    }
    const wave = queue;
    queue = [];
    for (const chunk of chunkItems(wave, GROUP_BATCH_SIZE)) {
      const batchIds = chunk.map((n) => n.id);
      const batchDepthById = new Map(chunk.map((n) => [n.id, n.depth]));
      const batchIdSet = new Set(batchIds);

      await listGroupedChildrenPages(batchIds, auth, {
        fields: `nextPageToken,files(${DRIVE_FILE_FIELDS})`,
        predicate: MEDIA_OR_FOLDER_PREDICATE,
        pageSize: APP_CONFIG.DRIVE_LIST_PAGE_SIZE || 1000,
        signal,
        onPage: (pageFiles) => {
          const now = Date.now();
          for (const entry of pageFiles) {
            const parentId =
              (Array.isArray(entry.parents) &&
                (entry.parents.find((pid) => batchIdSet.has(pid)) || entry.parents[0])) ||
              (batchIds.length === 1 ? batchIds[0] : '');
            if (!parentId) continue;
            const parentDepth = batchDepthById.get(parentId) ?? 0;

            if (entry.mimeType === FOLDER_MIME) {
              if (entry.name?.startsWith('.')) continue;
              const nextDepth = parentDepth + 1;
              if (nextDepth <= MAX_CRAWL_DEPTH) {
                folderMap.set(entry.id, {
                  id: entry.id,
                  name: entry.name,
                  parentId,
                  depth: nextDepth,
                });
                if (!visited.has(entry.id)) {
                  visited.add(entry.id);
                  queue.push({ id: entry.id, depth: nextDepth });
                }
              }
            } else {
              upsertedMap.set(entry.id, normalizeDriveFile(entry, parentId, now));
            }
          }
        },
      });
    }
  }
}

async function runIdReconcileSweep({
  folderMap,
  knownFileIds,
  upsertedMap,
  removedSet,
  auth,
  fetchMissingDetails = true,
  signal = null,
}) {
  const folderIds = Array.from(folderMap.keys());
  const liveFileIds = new Set();
  const liveParentById = new Map();

  for (const chunk of chunkItems(folderIds, GROUP_BATCH_SIZE)) {
    const chunkSet = new Set(chunk);
    await listGroupedChildrenPages(chunk, auth, {
      fields: 'nextPageToken,files(id,parents)',
      predicate: MEDIA_ONLY_PREDICATE,
      pageSize: APP_CONFIG.DRIVE_LIST_PAGE_SIZE || 1000,
      signal,
      onPage: (pageFiles) => {
        for (const entry of pageFiles) {
          if (!entry?.id) continue;
          liveFileIds.add(entry.id);
          const pid =
            (Array.isArray(entry.parents) &&
              (entry.parents.find((p) => chunkSet.has(p)) || entry.parents[0])) ||
            (chunk.length === 1 ? chunk[0] : '');
          if (pid) liveParentById.set(entry.id, pid);
        }
      },
    });
  }

  for (const id of knownFileIds) {
    if (!liveFileIds.has(id)) {
      upsertedMap.delete(id);
      removedSet.add(id);
    }
  }

  if (fetchMissingDetails) {
    const missingIds = [];
    for (const id of liveFileIds) {
      if (!knownFileIds.has(id) && !upsertedMap.has(id)) {
        missingIds.push(id);
      }
    }
    if (missingIds.length > 0) {
      const { accessToken = '', apiKey = '' } = resolveAuth(auth);
      const CONCURRENCY = 4;
      let cursor = 0;
      const worker = async () => {
        while (cursor < missingIds.length) {
          if (signal?.aborted) {
            throw new DOMException('Aborted', 'AbortError');
          }
          const id = missingIds[cursor];
          cursor += 1;
          const params = new URLSearchParams({
            fields: DRIVE_FILE_FIELDS,
            supportsAllDrives: 'true',
          });
          if (!accessToken && apiKey) params.set('key', apiKey);
          try {
            const entry = await driveJsonFetch(
              `${DRIVE_API}/files/${encodeURIComponent(id)}?${params.toString()}`,
              auth,
              signal
            );
            if (entry?.id && isMediaMimeType(entry.mimeType)) {
              const parentId =
                (Array.isArray(entry.parents) &&
                  (entry.parents.find((p) => folderMap.has(p)) || entry.parents[0])) ||
                liveParentById.get(id) ||
                '';
              if (parentId && folderMap.has(parentId)) {
                removedSet.delete(entry.id);
                upsertedMap.set(entry.id, normalizeDriveFile(entry, parentId, Date.now()));
              }
            }
          } catch (err) {
            if (err?.name === 'AbortError') throw err;
            // Ignore single inaccessible file during reconcile
          }
        }
      };
      await Promise.all(
        Array.from({ length: Math.min(CONCURRENCY, missingIds.length) }, () => worker())
      );
    }
  }
}

export async function syncAlbumIncremental({
  rootFolder,
  existingFolders = [],
  existingFileIds = new Set(),
  auth = {},
  startPageToken = '',
  syncWatermark = '',
  lastFullReconcileAt = 0,
  forceFullReconcile = false,
  captureMetaFolder = true,
  signal = null,
}) {
  if (!rootFolder?.id) {
    throw new Error(t('gdrive.invalidFolder'));
  }

  const resolvedAuth = resolveAuth(auth);
  const knownFileIds =
    existingFileIds instanceof Set ? existingFileIds : new Set(existingFileIds || []);
  const syncStartIso = new Date(Date.now() - 60_000).toISOString();

  const initialFolderMap = new Map();
  for (const folder of existingFolders || []) {
    if (folder?.id) {
      initialFolderMap.set(folder.id, { ...folder });
    }
  }
  if (!initialFolderMap.has(rootFolder.id)) {
    initialFolderMap.set(rootFolder.id, { ...rootFolder, parentId: null, depth: 0 });
  }

  // Path 1: OAuth changes.list incremental sync
  if (resolvedAuth.accessToken && startPageToken && !forceFullReconcile) {
    let pageToken = startPageToken;
    let newStartPageToken = '';
    let pageCount = 0;
    let canUseChanges = true;
    const allChanges = [];

    while (pageToken) {
      if (signal?.aborted) {
        throw new DOMException('Aborted', 'AbortError');
      }
      pageCount += 1;
      if (pageCount > MAX_CHANGES_PAGES) {
        canUseChanges = false;
        break;
      }

      const params = new URLSearchParams({
        pageToken,
        pageSize: '1000',
        includeRemoved: 'true',
        includeItemsFromAllDrives: 'true',
        supportsAllDrives: 'true',
        fields: `newStartPageToken,nextPageToken,changes(fileId,removed,file(trashed,${DRIVE_FILE_FIELDS}))`,
      });
      if (rootFolder.driveId) {
        params.set('driveId', rootFolder.driveId);
        params.set('includeCorpusRemovals', 'true');
      }

      const resp = await fetchWithDriveBackoff(
        `${DRIVE_API}/changes?${params.toString()}`,
        { headers: { Authorization: `Bearer ${resolvedAuth.accessToken}` }, signal }
      );

      if (resp.status === 401) {
        clearSession();
        const err = new Error(t('gdrive.err401Expired'));
        err.status = 401;
        throw err;
      }
      if (resp.status === 400 || resp.status === 410 || !resp.ok) {
        canUseChanges = false;
        break;
      }

      const data = await resp.json();
      if (Array.isArray(data.changes)) {
        allChanges.push(...data.changes);
      }
      if (data.newStartPageToken) {
        newStartPageToken = data.newStartPageToken;
      }
      pageToken = data.nextPageToken || '';
    }

    if (canUseChanges) {
      const folderMap = new Map(
        Array.from(initialFolderMap.entries()).map(([k, v]) => [k, { ...v }])
      );
      const upsertedMap = new Map();
      const removedSet = new Set();
      let metaFolderId = null;
      let removedAnyFolder = false;

      // Track latest state per fileId across chronological change records
      const latestByFileId = new Map();
      for (const ch of allChanges) {
        if (ch?.fileId) {
          latestByFileId.set(ch.fileId, ch);
        }
      }

      // Step 1: Handle removed/trashed items
      for (const [fileId, ch] of latestByFileId.entries()) {
        if (ch.removed || ch.file?.trashed) {
          if (folderMap.has(fileId) && fileId !== rootFolder.id) {
            pruneFolderSubtree(folderMap, fileId);
            removedAnyFolder = true;
          } else if (knownFileIds.has(fileId)) {
            removedSet.add(fileId);
          }
        }
      }

      // Step 2: Handle folder creations, moves, and renames (fixed-point for nested moved folders)
      const activeFolderChanges = [];
      for (const ch of latestByFileId.values()) {
        if (!ch.removed && ch.file && !ch.file.trashed && ch.file.mimeType === FOLDER_MIME) {
          activeFolderChanges.push(ch.file);
        }
      }

      const newSubfolderSeeds = [];
      const seenSeedIds = new Set();
      let changed = true;
      let guard = 0;
      while (changed && guard < MAX_CRAWL_DEPTH + 2) {
        changed = false;
        guard += 1;
        for (const f of activeFolderChanges) {
          if (f.id === rootFolder.id) {
            const existingRoot = folderMap.get(rootFolder.id);
            if (existingRoot && f.name && existingRoot.name !== f.name) {
              existingRoot.name = f.name;
            }
            continue;
          }
          const parents = Array.isArray(f.parents) ? f.parents : [];
          const matchedParentId = parents.find((pid) => folderMap.has(pid)) || '';
          if (matchedParentId) {
            if (captureMetaFolder && f.name === '.drivelens' && matchedParentId === rootFolder.id) {
              metaFolderId = f.id;
              continue;
            }
            if (f.name?.startsWith('.')) {
              if (folderMap.has(f.id)) {
                pruneFolderSubtree(folderMap, f.id);
                removedAnyFolder = true;
                changed = true;
              }
              continue;
            }
            const nextDepth = (folderMap.get(matchedParentId)?.depth ?? 0) + 1;
            if (nextDepth <= MAX_CRAWL_DEPTH) {
              const prev = folderMap.get(f.id);
              if (!prev) {
                folderMap.set(f.id, {
                  id: f.id,
                  name: f.name,
                  parentId: matchedParentId,
                  depth: nextDepth,
                });
                if (!initialFolderMap.has(f.id) && !seenSeedIds.has(f.id)) {
                  seenSeedIds.add(f.id);
                  newSubfolderSeeds.push({ id: f.id, depth: nextDepth });
                }
                changed = true;
              } else if (
                prev.name !== f.name ||
                prev.parentId !== matchedParentId ||
                prev.depth !== nextDepth
              ) {
                prev.name = f.name;
                prev.parentId = matchedParentId;
                prev.depth = nextDepth;
                changed = true;
              }
            }
          } else if (folderMap.has(f.id)) {
            pruneFolderSubtree(folderMap, f.id);
            removedAnyFolder = true;
            changed = true;
          }
        }
      }

      // Crawl newly created/moved-in subfolders so existing photos inside them are discovered
      if (newSubfolderSeeds.length > 0) {
        await crawlSubtreeIntoMaps({
          seedFolders: newSubfolderSeeds,
          folderMap,
          upsertedMap,
          auth: resolvedAuth,
          signal,
        });
      }

      // Step 3: Handle media file upserts & moves outside album
      const now = Date.now();
      for (const [fileId, ch] of latestByFileId.entries()) {
        if (ch.removed || !ch.file || ch.file.trashed) continue;
        if (!isMediaMimeType(ch.file.mimeType)) continue;
        const parents = Array.isArray(ch.file.parents) ? ch.file.parents : [];
        const matchedParentId = parents.find((pid) => folderMap.has(pid)) || '';
        if (matchedParentId) {
          removedSet.delete(fileId);
          upsertedMap.set(fileId, normalizeDriveFile(ch.file, matchedParentId, now));
        } else if (knownFileIds.has(fileId) || upsertedMap.has(fileId)) {
          upsertedMap.delete(fileId);
          removedSet.add(fileId);
        }
      }

      // If a subfolder was removed or moved out, reconcile live file IDs so orphaned files inside it are removed
      let nextLastFullReconcileAt = Number(lastFullReconcileAt || 0);
      if (removedAnyFolder && knownFileIds.size > 0) {
        await runIdReconcileSweep({
          folderMap,
          knownFileIds,
          upsertedMap,
          removedSet,
          auth: resolvedAuth,
          fetchMissingDetails: false,
          signal,
        });
        nextLastFullReconcileAt = Date.now();
      }

      return {
        mode: 'changes',
        upsertedFiles: Array.from(upsertedMap.values()),
        removedFileIds: Array.from(removedSet),
        folders: Array.from(folderMap.values()),
        metaFolderId,
        nextStartPageToken: newStartPageToken || startPageToken,
        nextWatermark: syncStartIso,
        lastFullReconcileAt: nextLastFullReconcileAt,
        fullResult: null,
      };
    }
  }

  // Path 2: Watermark + Periodic ID Reconcile (API Key mode or OAuth fallback)
  if (!syncWatermark && (!existingFolders || existingFolders.length === 0)) {
    const fullResult = await crawlAlbumTree({
      rootFolder,
      auth: resolvedAuth,
      captureMetaFolder,
      signal,
    });
    const freshToken = resolvedAuth.accessToken
      ? await fetchStartPageToken(resolvedAuth, rootFolder.driveId, signal)
      : '';
    return {
      mode: 'fallback-full',
      upsertedFiles: [],
      removedFileIds: [],
      folders: fullResult.folders,
      metaFolderId: fullResult.metaFolderId,
      nextStartPageToken: freshToken,
      nextWatermark: fullResult.syncWatermark,
      lastFullReconcileAt: Date.now(),
      fullResult: {
        ...fullResult,
        startPageToken: freshToken,
      },
    };
  }

  // Step A: Discover current folder tree via grouped folder-only queries
  const discoveredFolderMap = new Map();
  discoveredFolderMap.set(rootFolder.id, { ...rootFolder, parentId: null, depth: 0 });
  let metaFolderId = null;
  let folderQueue = [{ id: rootFolder.id, depth: 0 }];
  const visitedFolders = new Set([rootFolder.id]);

  while (folderQueue.length > 0) {
    if (signal?.aborted) {
      throw new DOMException('Aborted', 'AbortError');
    }
    const wave = folderQueue;
    folderQueue = [];
    for (const chunk of chunkItems(wave, GROUP_BATCH_SIZE)) {
      const batchIds = chunk.map((n) => n.id);
      const batchDepthById = new Map(chunk.map((n) => [n.id, n.depth]));
      const batchIdSet = new Set(batchIds);

      await listGroupedChildrenPages(batchIds, resolvedAuth, {
        fields: 'nextPageToken,files(id,name,parents)',
        predicate: FOLDER_ONLY_PREDICATE,
        pageSize: APP_CONFIG.DRIVE_LIST_PAGE_SIZE || 1000,
        signal,
        onPage: (pageFolders) => {
          for (const entry of pageFolders) {
            const parentId =
              (Array.isArray(entry.parents) &&
                (entry.parents.find((pid) => batchIdSet.has(pid)) || entry.parents[0])) ||
              (batchIds.length === 1 ? batchIds[0] : '');
            if (!parentId) continue;

            if (captureMetaFolder && entry.name === '.drivelens' && parentId === rootFolder.id) {
              metaFolderId = entry.id;
              continue;
            }
            if (entry.name?.startsWith('.')) continue;

            const parentDepth = batchDepthById.get(parentId) ?? 0;
            const nextDepth = parentDepth + 1;
            if (!visitedFolders.has(entry.id) && nextDepth <= MAX_CRAWL_DEPTH) {
              visitedFolders.add(entry.id);
              discoveredFolderMap.set(entry.id, {
                id: entry.id,
                name: entry.name,
                parentId,
                depth: nextDepth,
              });
              folderQueue.push({ id: entry.id, depth: nextDepth });
            }
          }
        },
      });
    }
  }

  const newlyAddedFolderIds = [];
  for (const id of discoveredFolderMap.keys()) {
    if (!initialFolderMap.has(id)) {
      newlyAddedFolderIds.push(id);
    }
  }
  let hasVanishedFolder = false;
  for (const id of initialFolderMap.keys()) {
    if (!discoveredFolderMap.has(id)) {
      hasVanishedFolder = true;
      break;
    }
  }

  const upsertedMap = new Map();
  const removedSet = new Set();

  // Crawl newly discovered subfolders completely for all their media files
  if (newlyAddedFolderIds.length > 0) {
    for (const chunk of chunkItems(newlyAddedFolderIds, GROUP_BATCH_SIZE)) {
      const chunkSet = new Set(chunk);
      await listGroupedChildrenPages(chunk, resolvedAuth, {
        fields: `nextPageToken,files(${DRIVE_FILE_FIELDS})`,
        predicate: MEDIA_ONLY_PREDICATE,
        pageSize: APP_CONFIG.DRIVE_LIST_PAGE_SIZE || 1000,
        signal,
        onPage: (pageFiles) => {
          const now = Date.now();
          for (const entry of pageFiles) {
            const parentId =
              (Array.isArray(entry.parents) &&
                (entry.parents.find((pid) => chunkSet.has(pid)) || entry.parents[0])) ||
              (chunk.length === 1 ? chunk[0] : '');
            if (parentId) {
              upsertedMap.set(entry.id, normalizeDriveFile(entry, parentId, now));
            }
          }
        },
      });
    }
  }

  // Step B: Watermark query (modifiedTime > W or createdTime > W) across all folders
  const parsedWatermark = syncWatermark ? Date.parse(syncWatermark) : NaN;
  const hasValidWatermark = Number.isFinite(parsedWatermark);
  if (hasValidWatermark) {
    const safeWatermarkIso = new Date(Math.max(0, parsedWatermark - 5 * 60 * 1000)).toISOString();
    const watermarkPredicate = `${MEDIA_ONLY_PREDICATE} and (modifiedTime > '${safeWatermarkIso}' or createdTime > '${safeWatermarkIso}')`;
    const allFolderIds = Array.from(discoveredFolderMap.keys());

    for (const chunk of chunkItems(allFolderIds, GROUP_BATCH_SIZE)) {
      const chunkSet = new Set(chunk);
      await listGroupedChildrenPages(chunk, resolvedAuth, {
        fields: `nextPageToken,files(${DRIVE_FILE_FIELDS})`,
        predicate: watermarkPredicate,
        pageSize: APP_CONFIG.DRIVE_LIST_PAGE_SIZE || 1000,
        signal,
        onPage: (pageFiles) => {
          const now = Date.now();
          for (const entry of pageFiles) {
            const parentId =
              (Array.isArray(entry.parents) &&
                (entry.parents.find((pid) => chunkSet.has(pid)) || entry.parents[0])) ||
              (chunk.length === 1 ? chunk[0] : '');
            if (parentId) {
              upsertedMap.set(entry.id, normalizeDriveFile(entry, parentId, now));
            }
          }
        },
      });
    }
  }

  // Step C: Periodic or triggered ID-only sweep to reconcile removals & missed additions
  let nextLastFullReconcileAt = Number(lastFullReconcileAt || 0);
  const needsIdSweep =
    forceFullReconcile ||
    hasVanishedFolder ||
    !hasValidWatermark ||
    !nextLastFullReconcileAt ||
    Date.now() - nextLastFullReconcileAt > 24 * 60 * 60 * 1000;

  if (needsIdSweep) {
    await runIdReconcileSweep({
      folderMap: discoveredFolderMap,
      knownFileIds,
      upsertedMap,
      removedSet,
      auth: resolvedAuth,
      fetchMissingDetails: true,
      signal,
    });
    nextLastFullReconcileAt = Date.now();
  }

  const nextStartPageToken = resolvedAuth.accessToken
    ? await fetchStartPageToken(resolvedAuth, rootFolder.driveId, signal)
    : '';

  return {
    mode: 'watermark',
    upsertedFiles: Array.from(upsertedMap.values()),
    removedFileIds: Array.from(removedSet),
    folders: Array.from(discoveredFolderMap.values()),
    metaFolderId,
    nextStartPageToken,
    nextWatermark: syncStartIso,
    lastFullReconcileAt: nextLastFullReconcileAt,
    fullResult: null,
  };
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
    (item.id ? `https://drive.google.com/uc?export=download&id=${encodeURIComponent(item.id)}` : '');

  if (!accessToken && !apiKey) {
    if (fallbackDownloadUrl) {
      window.open(fallbackDownloadUrl, '_blank', 'noopener');
      return;
    }
    throw new Error(t('gdrive.missingDownloadAuth'));
  }

  const baseMediaUrl = `${DRIVE_API}/files/${encodeURIComponent(item.id)}?alt=media&supportsAllDrives=true`;
  const url = accessToken ? baseMediaUrl : `${baseMediaUrl}&key=${encodeURIComponent(apiKey)}`;
  const fetchOptions = accessToken ? { headers: { Authorization: `Bearer ${accessToken}` } } : {};

  try {
    const resp = await fetchWithDriveBackoff(url, fetchOptions);
    if (!resp.ok) {
      if (fallbackDownloadUrl) {
        window.open(fallbackDownloadUrl, '_blank', 'noopener');
        return;
      }
      throw new Error(t('gdrive.downloadFailedStatus', { status: resp.status }));
    }

    const blob = await resp.blob();
    const objUrl = URL.createObjectURL(blob);
    triggerDownloadUrl(objUrl, item.name || 'photo');
    setTimeout(() => URL.revokeObjectURL(objUrl), 5000);
  } catch (err) {
    if (!accessToken && apiKey && fallbackDownloadUrl) {
      window.open(fallbackDownloadUrl, '_blank', 'noopener');
      return;
    }
    throw err;
  }
}
