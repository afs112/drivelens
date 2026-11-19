import {
  ensureGoogleIdentityLoaded,
  getCleanOAuthRedirectUri,
  getStoredRenewalTicket,
  normalizeRenewalEndpoint,
  parseDriveFolderId,
} from '../api/gdrive.js';
import { APP_CONFIG } from '../constants.js';
import { t } from '../i18n.js';
import { getTagColors, saveConnectPrefs } from '../state/store.js';
import { escapeAttr, escapeHtml, icon } from './icons.js';

let selectedTagColor = 'blue';
let quickTagSearch = '';
let exportOnlyPicks = false;
let exportStripExt = false;
let connectTab = '';

function buildExportRows(store) {
  const visible = store.getVisiblePhotos();
  const schemaTags = store.state.tagSchema?.tags || {};
  const rows = [];

  for (const f of visible) {
    const meta = store.getAggregatedItemMeta(f.id);
    if (exportOnlyPicks && meta.avgRating < 4 && meta.favoriteCount === 0) continue;
    const folder = store.state.folders.find((fl) => fl.id === f.parentId)?.name || '';
    const tagNames = meta.activeTagIds.map((id) => schemaTags[id]?.name).filter(Boolean);
    const displayName = exportStripExt ? f.name.replace(/\.[^.]+$/, '') : f.name;
    rows.push({
      id: f.id,
      name: displayName,
      rawName: f.name,
      folder,
      avgRating: meta.avgRating ? meta.avgRating.toFixed(1) : '0',
      myRating: meta.myRating,
      favoriteCount: meta.favoriteCount,
      tags: tagNames,
      notes: meta.notesByMember.map((n) => `${n.member.name}: ${n.note}`).join(' | '),
    });
  }
  return rows;
}

async function copyTextWithFallback(text) {
  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Fallback below
    }
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.top = '-9999px';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return Boolean(ok);
  } catch {
    return false;
  }
}

function downloadTextFile(filename, content, mimeType) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

function parseSetupLinkInput(rawInput) {
  const trimmed = String(rawInput || '').trim();
  if (!trimmed) return null;

  let searchStr = '';
  let hashStr = '';
  if (/^https?:\/\//i.test(trimmed)) {
    try {
      const parsed = new URL(trimmed);
      searchStr = parsed.search || '';
      hashStr = parsed.hash || '';
    } catch {
      return null;
    }
  } else if (trimmed.includes('=')) {
    const normalized =
      trimmed.startsWith('?') || trimmed.startsWith('#')
        ? `https://drivelens.local/${trimmed}`
        : `https://drivelens.local/?${trimmed}`;
    try {
      const parsed = new URL(normalized);
      searchStr = parsed.search || '';
      hashStr = parsed.hash || '';
    } catch {
      return null;
    }
  }

  const sp = new URLSearchParams(searchStr);
  const hp = new URLSearchParams(hashStr.startsWith('#') ? hashStr.slice(1) : hashStr);
  const getParam = (name) => (hp.get(name) ?? sp.get(name) ?? '').trim();

  const rawFolder = getParam('folder');
  const folderId = rawFolder ? parseDriveFolderId(rawFolder) : '';
  const clientId = getParam('client_id');
  const apiKey = getParam('key');
  const rawRenewal = getParam('renewal_url') || getParam('worker');
  const tokenRenewalUrl = rawRenewal ? normalizeRenewalEndpoint(rawRenewal) : '';
  if (rawRenewal && !tokenRenewalUrl) {
    return { invalidRenewalUrl: true };
  }
  const nickname = getParam('nick') || getParam('nickname');
  const rawLang = getParam('lang').toLowerCase();
  const lang = rawLang === 'en' || rawLang === 'zh' ? rawLang : '';
  const rawLayout = getParam('layout').toLowerCase();
  const layout =
    rawLayout === 'justified' || rawLayout === 'waterfall' || rawLayout === 'grid'
      ? rawLayout
      : '';

  const fallbackDriveFolder =
    !folderId &&
    !clientId &&
    !apiKey &&
    !tokenRenewalUrl &&
    !nickname &&
    !lang &&
    !layout &&
    /^(https?:\/\/)?(drive|docs)\.google\.com\//i.test(trimmed)
      ? parseDriveFolderId(trimmed)
      : '';
  const finalFolderId = folderId || fallbackDriveFolder;

  const fields = {
    folderId: finalFolderId,
    clientId,
    apiKey,
    tokenRenewalUrl,
    nickname,
    lang,
    layout,
  };
  const fieldCount = Object.values(fields).filter(Boolean).length;
  if (fieldCount === 0) return null;
  return { ...fields, fieldCount };
}

export function renderModals(container, store) {
  if (!container) return;
  const modal = store.state.modal;

  if (!modal) {
    quickTagSearch = '';
    connectTab = '';
    container.innerHTML = '';
    return;
  }

  if (modal.type === 'connect') {
    ensureGoogleIdentityLoaded().catch(() => {});
    const redirectUriPreview = getCleanOAuthRedirectUri();
    if (!connectTab) {
      connectTab = store.state.authType === 'oauth' ? 'oauth' : 'apikey';
    }
    const activeTab = connectTab;
    const apiKeyVal = store.state.apiKey || APP_CONFIG.DEFAULT_API_KEY || '';
    const nicknameVal = store.state.nickname || store.state.currentUser?.name || '';
    const clientIdVal = store.state.clientId || APP_CONFIG.DEFAULT_CLIENT_ID || '';
    const folderVal = store.state.folderId || APP_CONFIG.DEFAULT_FOLDER_ID || '';
    const renewalUrlVal = store.state.tokenRenewalUrl || '';
    const recent = store.state.recentAlbums || [];

    const recentHtml =
      recent.length > 0
        ? `
          <div class="form-field">
            <span class="form-label">${escapeHtml(t('modal.recentAlbums'))}</span>
            <div style="display:flex;flex-wrap:wrap;gap:6px">
              ${recent
                .map(
                  (r) => `
                <button
                  type="button"
                  class="btn btn-sm"
                  data-recent-folder="${escapeAttr(r.folderId)}"
                  data-recent-client="${escapeAttr(r.clientId || clientIdVal)}"
                  data-recent-apikey="${escapeAttr(r.apiKey || '')}"
                >
                  ${icon('folder', 13)} ${escapeHtml(r.name)}
                </button>
              `
                )
                .join('')}
            </div>
          </div>
        `
        : '';

    const backToDemoBtn =
      store.state.mode === 'gdrive'
        ? `<button type="button" class="btn" data-action="back-to-demo">${escapeHtml(t('modal.backToDemo'))}</button>`
        : '';

    const rememberChecked = store.state.rememberCredentials !== false ? 'checked' : '';
    const hasSavedCreds = Boolean(
      apiKeyVal || clientIdVal || folderVal || renewalUrlVal || store.state.savedOAuthUser
    );
    const forgetCredsBtn = hasSavedCreds
      ? `<button type="button" class="btn btn-ghost btn-sm" data-action="forget-creds">${icon('trash', 13)} ${escapeHtml(t('modal.forgetCredsBtn'))}</button>`
      : '';
    const clearCacheBtn = `<button type="button" class="btn btn-ghost btn-sm" data-action="clear-cache">${icon('refresh', 13)} ${escapeHtml(t('modal.clearCacheBtn'))}</button>`;
    const savedAccountHtml = store.state.savedOAuthUser?.email
      ? `<div class="form-help" style="color:var(--accent)">${escapeHtml(t('modal.savedAccountBadge', { email: store.state.savedOAuthUser.email }))}</div>`
      : '';

    const importLinkHtml = `
      <div class="form-field">
        <label class="form-label" for="importSetupLinkInput">${escapeHtml(t('modal.importSetupLinkLabel'))}</label>
        <div style="display:flex;align-items:center;gap:8px">
          <input
            id="importSetupLinkInput"
            class="form-input"
            type="text"
            inputmode="url"
            autocomplete="off"
            spellcheck="false"
            placeholder="${escapeAttr(t('modal.importSetupLinkPlaceholder'))}"
            style="flex:1;min-width:0"
          />
          <button
            type="button"
            class="btn btn-sm"
            data-action="import-setup-link"
            style="flex-shrink:0"
          >${icon('download', 13)} ${escapeHtml(t('modal.importSetupLinkBtn'))}</button>
        </div>
        <span class="form-help">${escapeHtml(t('modal.importSetupLinkHint'))}</span>
      </div>
    `;

    const formHtml =
      activeTab === 'apikey'
        ? `
          <form id="connectApiKeyForm">
            <div class="modal-body">
              ${importLinkHtml}

              <div class="form-field">
                <label class="form-label" for="apiKeyInput">${escapeHtml(t('modal.apiKeyLabel'))}</label>
                <input id="apiKeyInput" class="form-input" type="text" placeholder="${escapeAttr(t('modal.apiKeyPlaceholder'))}" value="${escapeAttr(apiKeyVal)}" required />
                <span class="form-help">${escapeHtml(t('modal.apiKeyHelp'))}</span>
              </div>

              <div class="form-field">
                <label class="form-label" for="apiKeyFolderUrlInput">${escapeHtml(t('modal.folderUrlLabel'))}</label>
                <input id="apiKeyFolderUrlInput" class="form-input" type="text" placeholder="${escapeAttr(t('modal.folderUrlPlaceholder'))}" value="${escapeAttr(folderVal)}" required />
                <span class="form-help">${escapeHtml(t('modal.apiKeyFolderHelp'))}</span>
              </div>

              <div class="form-field">
                <label class="form-label" for="nicknameInput">${escapeHtml(t('modal.nicknameLabel'))}</label>
                <input id="nicknameInput" class="form-input" type="text" placeholder="${escapeAttr(t('modal.nicknamePlaceholder'))}" value="${escapeAttr(nicknameVal)}" required />
                <span class="form-help">${escapeHtml(t('modal.nicknameHelp'))}</span>
              </div>

              <label class="switch-label">
                <input type="checkbox" id="rememberApiKeyCheck" ${rememberChecked} />
                <span>${escapeHtml(t('modal.rememberCreds'))}</span>
              </label>

              <div class="connect-tools-row" style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
                <button type="button" class="btn btn-sm" data-action="copy-setup-link-apikey" title="${escapeAttr(t('modal.copySetupLinkHint'))}">
                  ${icon('share', 13)} ${escapeHtml(t('modal.copySetupLinkBtn'))}
                </button>
              </div>

              ${recentHtml}

              <details class="guide-details">
                <summary>${escapeHtml(t('modal.apiKeyGuideSummary'))}</summary>
                <ol>
                  <li>${t('modal.apiKeyGuideStep1')}</li>
                  <li>${t('modal.apiKeyGuideStep2')}</li>
                </ol>
              </details>
            </div>
            <div class="modal-footer" style="justify-content:space-between;flex-wrap:wrap">
              <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
                ${forgetCredsBtn}
                ${clearCacheBtn}
                ${backToDemoBtn}
              </div>
              <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
                <button type="button" class="btn btn-ghost" data-modal-close="true">${escapeHtml(t('modal.cancel'))}</button>
                <button type="submit" class="btn btn-primary">${icon('cloud', 14)} ${escapeHtml(t('modal.connectApiKeySubmit'))}</button>
              </div>
            </div>
          </form>
        `
        : `
          <form id="connectDriveForm">
            <div class="modal-body">
              ${importLinkHtml}

              <div class="form-field">
                <label class="form-label" for="clientIdInput">${escapeHtml(t('modal.clientIdLabel'))}</label>
                <input id="clientIdInput" class="form-input" type="text" placeholder="${escapeAttr(t('modal.clientIdPlaceholder'))}" value="${escapeAttr(clientIdVal)}" required />
                <span class="form-help">${escapeHtml(t('modal.clientIdHelp'))}</span>
                ${savedAccountHtml}
              </div>

              <div class="form-field">
                <label class="form-label" for="folderUrlInput">${escapeHtml(t('modal.folderUrlLabel'))}</label>
                <input id="folderUrlInput" class="form-input" type="text" placeholder="${escapeAttr(t('modal.folderUrlPlaceholder'))}" value="${escapeAttr(folderVal)}" required />
                <span class="form-help">${escapeHtml(t('modal.oauthFolderHelp'))}</span>
              </div>

              <div class="form-field">
                <label class="form-label" for="tokenRenewalUrlInput">${escapeHtml(t('modal.renewalUrlLabel'))}</label>
                <input
                  id="tokenRenewalUrlInput"
                  class="form-input"
                  type="url"
                  placeholder="${escapeAttr(t('modal.renewalUrlPlaceholder'))}"
                  value="${escapeAttr(renewalUrlVal)}"
                  autocomplete="off"
                />
                <span class="form-help">${escapeHtml(t('modal.renewalUrlHelp'))}</span>
              </div>

              <label class="switch-label">
                <input type="checkbox" id="rememberOAuthCheck" ${rememberChecked} />
                <span>${escapeHtml(t('modal.rememberCreds'))}</span>
              </label>

              <div class="connect-tools-row" style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
                <button type="button" class="btn btn-sm" data-action="copy-setup-link-oauth" title="${escapeAttr(t('modal.copySetupLinkHint'))}">
                  ${icon('share', 13)} ${escapeHtml(t('modal.copySetupLinkBtn'))}
                </button>
                <button type="button" class="btn btn-sm" data-action="copy-mcp-config" title="${escapeAttr(t('modal.copyMcpConfigHint'))}">
                  ${icon('appWindow', 13)} ${escapeHtml(t('modal.copyMcpConfigBtn'))}
                </button>
              </div>

              ${recentHtml}

              <details class="guide-details">
                <summary>${escapeHtml(t('modal.oauthGuideSummary'))}</summary>
                <ol>
                  <li>${t('modal.oauthGuideStep1')}</li>
                  <li>${t('modal.oauthGuideStep2')}</li>
                  <li>${t('modal.oauthGuideStep3')}</li>
                </ol>
              </details>
            </div>
            <div class="modal-footer" style="justify-content:space-between;flex-wrap:wrap">
              <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
                ${forgetCredsBtn}
                ${clearCacheBtn}
                ${backToDemoBtn}
              </div>
              <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
                <button type="button" class="btn btn-ghost" data-modal-close="true">${escapeHtml(t('modal.cancel'))}</button>
                <button type="button" class="btn" data-action="oauth-redirect" title="${escapeAttr(t('modal.redirectAuthHint', { uri: redirectUriPreview }))}">${icon('externalLink', 13)} ${escapeHtml(t('modal.redirectAuthBtn'))}</button>
                <button type="submit" class="btn btn-primary">${icon('cloud', 14)} ${escapeHtml(t('modal.connectOAuthSubmit'))}</button>
              </div>
            </div>
          </form>
        `;

    container.innerHTML = `
      <div class="modal-backdrop" data-modal-backdrop="true">
        <div class="modal-card" role="dialog" aria-modal="true">
          <div class="modal-header">
            <span class="modal-title">${icon('cloud', 18)} ${escapeHtml(t('modal.connectTitle'))}</span>
            <button type="button" class="btn btn-ghost btn-icon btn-sm" data-modal-close="true">${icon('x', 16)}</button>
          </div>
          <div style="padding:12px 18px 0">
            <div class="segmented segmented-2" role="tablist">
              <button
                type="button"
                class="seg-btn ${activeTab === 'apikey' ? 'active' : ''}"
                data-connect-tab="apikey"
                role="tab"
                aria-selected="${activeTab === 'apikey'}"
              >${escapeHtml(t('modal.tabApiKey'))}</button>
              <button
                type="button"
                class="seg-btn ${activeTab === 'oauth' ? 'active' : ''}"
                data-connect-tab="oauth"
                role="tab"
                aria-selected="${activeTab === 'oauth'}"
              >${escapeHtml(t('modal.tabOAuth'))}</button>
            </div>
          </div>
          ${formHtml}
        </div>
      </div>
    `;
    return;
  }

  if (modal.type === 'tagEditor') {
    const editing = modal.payload;
    selectedTagColor = editing?.color || 'blue';
    const existingGroups = Array.from(
      new Set([
        t('modal.defaultGroup1'),
        t('modal.defaultGroup2'),
        t('modal.defaultGroup3'),
        t('modal.defaultGroup4'),
        ...store.getActiveTagList().map((tg) => tg.group),
      ])
    );
    const tagColors = getTagColors();

    container.innerHTML = `
      <div class="modal-backdrop" data-modal-backdrop="true">
        <div class="modal-card modal-sm" role="dialog" aria-modal="true">
          <div class="modal-header">
            <span class="modal-title">${icon('tag', 17)} ${escapeHtml(editing ? t('modal.editTagTitle') : t('modal.newTagTitle'))}</span>
            <button type="button" class="btn btn-ghost btn-icon btn-sm" data-modal-close="true">${icon('x', 16)}</button>
          </div>
          <form id="tagEditorForm">
            <div class="modal-body">
              <div class="form-field">
                <label class="form-label" for="tagNameInput">${escapeHtml(t('modal.tagNameLabel'))}</label>
                <input id="tagNameInput" class="form-input" type="text" placeholder="${escapeAttr(t('modal.tagNamePlaceholder'))}" value="${escapeAttr(editing?.name || '')}" required />
              </div>
              <div class="form-field">
                <label class="form-label" for="tagGroupInput">${escapeHtml(t('modal.tagGroupLabel'))}</label>
                <input id="tagGroupInput" class="form-input" type="text" list="tagGroupsDatalist" value="${escapeAttr(editing?.group || t('modal.defaultGroup1'))}" />
                <datalist id="tagGroupsDatalist">
                  ${existingGroups.map((g) => `<option value="${escapeAttr(g)}"></option>`).join('')}
                </datalist>
              </div>
              <div class="form-field">
                <span class="form-label">${escapeHtml(t('modal.tagColorLabel'))}</span>
                <div class="color-swatches">
                  ${tagColors
                    .map(
                      (c) => `
                    <button
                      type="button"
                      class="color-swatch ${selectedTagColor === c.id ? 'active' : ''}"
                      style="background:${c.hex}"
                      data-pick-color="${c.id}"
                      title="${escapeAttr(c.label)}"
                    >${selectedTagColor === c.id ? icon('check', 14) : ''}</button>
                  `
                    )
                    .join('')}
                </div>
              </div>
            </div>
            <div class="modal-footer" style="flex-wrap:wrap">
              <button type="button" class="btn btn-ghost" data-modal-close="true">${escapeHtml(t('modal.cancel'))}</button>
              <button type="submit" class="btn btn-primary">${escapeHtml(editing ? t('modal.saveTag') : t('modal.createTag'))}</button>
            </div>
          </form>
        </div>
      </div>
    `;
    setTimeout(() => container.querySelector('#tagNameInput')?.focus(), 20);
    return;
  }

  if (modal.type === 'quickTag') {
    const photoIds = modal.payload?.photoIds || [];
    const allTags = store.getActiveTagList();
    const filtered = allTags.filter(
      (tg) =>
        !quickTagSearch.trim() ||
        tg.name.toLowerCase().includes(quickTagSearch.trim().toLowerCase())
    );

    const firstMeta = photoIds[0] ? store.getAggregatedItemMeta(photoIds[0]) : { activeTagIds: [] };
    const activeSet = new Set(firstMeta.activeTagIds);

    container.innerHTML = `
      <div class="modal-backdrop" data-modal-backdrop="true">
        <div class="modal-card modal-sm" role="dialog" aria-modal="true">
          <div class="modal-header">
            <span class="modal-title">${icon('tag', 17)} ${escapeHtml(t('modal.quickTagTitle', { count: photoIds.length }))}</span>
            <button type="button" class="btn btn-ghost btn-icon btn-sm" data-modal-close="true">${icon('x', 16)}</button>
          </div>
          <div class="modal-body">
            <input id="quickTagSearchInput" class="form-input" type="text" placeholder="${escapeAttr(t('modal.quickTagSearch'))}" value="${escapeAttr(quickTagSearch)}" />
            <div style="display:flex;flex-direction:column;gap:4px;max-height:280px;overflow-y:auto">
              ${
                filtered.length > 0
                  ? filtered
                      .map((tg) => {
                        const checked = activeSet.has(tg.id);
                        return `
                        <button type="button" class="nav-item ${checked ? 'active' : ''}" data-quick-toggle-tag="${escapeAttr(tg.id)}">
                          <span class="nav-item-main">
                            <span class="tag-dot tag-color-${escapeAttr(tg.color || 'blue')}"></span>
                            <span class="nav-item-label">${escapeHtml(tg.name)}</span>
                            <span style="font-size:11px;color:var(--text-muted)">(${escapeHtml(tg.group || t('sidebar.ungrouped'))})</span>
                          </span>
                          <span>${checked ? icon('check', 15) : ''}</span>
                        </button>
                      `;
                      })
                      .join('')
                  : `<div class="form-help" style="padding:12px 4px">${escapeHtml(t('modal.noMatchingTags'))}</div>`
              }
            </div>
          </div>
          <div class="modal-footer" style="justify-content:space-between;flex-wrap:wrap">
            <button type="button" class="btn btn-sm" data-action="create-from-quick">${icon('plus', 13)} ${escapeHtml(t('sidebar.newTag'))}</button>
            <button type="button" class="btn btn-primary btn-sm" data-modal-close="true">${escapeHtml(t('modal.done'))}</button>
          </div>
        </div>
      </div>
    `;
    setTimeout(() => container.querySelector('#quickTagSearchInput')?.focus(), 20);
    return;
  }

  if (modal.type === 'export') {
    const rows = buildExportRows(store);
    const filenameList = rows.map((r) => r.name).join('\n');

    container.innerHTML = `
      <div class="modal-backdrop" data-modal-backdrop="true">
        <div class="modal-card" role="dialog" aria-modal="true">
          <div class="modal-header">
            <span class="modal-title">${icon('share', 17)} ${escapeHtml(t('modal.exportTitle', { count: rows.length }))}</span>
            <button type="button" class="btn btn-ghost btn-icon btn-sm" data-modal-close="true">${icon('x', 16)}</button>
          </div>
          <div class="modal-body">
            <div style="display:flex;gap:14px;flex-wrap:wrap">
              <label class="switch-label">
                <input type="checkbox" id="exportOnlyPicksCheck" ${exportOnlyPicks ? 'checked' : ''} />
                <span>${escapeHtml(t('modal.exportOnlyPicks'))}</span>
              </label>
              <label class="switch-label">
                <input type="checkbox" id="exportStripExtCheck" ${exportStripExt ? 'checked' : ''} />
                <span>${escapeHtml(t('modal.exportStripExt'))}</span>
              </label>
            </div>
            <div class="form-field">
              <span class="form-label">${escapeHtml(t('modal.exportPreviewLabel'))}</span>
              <textarea id="exportPreviewBox" class="note-textarea" style="min-height:150px;font-family:var(--font-mono)" readonly>${escapeHtml(filenameList || t('modal.exportEmpty'))}</textarea>
            </div>
          </div>
          <div class="modal-footer" style="justify-content:space-between;flex-wrap:wrap">
            <div style="display:flex;gap:8px;flex-wrap:wrap">
              <button type="button" class="btn btn-sm" data-export-action="csv">${escapeHtml(t('modal.exportCsvBtn'))}</button>
              <button type="button" class="btn btn-sm" data-export-action="json">${escapeHtml(t('modal.exportJsonBtn'))}</button>
            </div>
            <div style="display:flex;gap:8px;flex-wrap:wrap">
              <button type="button" class="btn btn-ghost btn-sm" data-modal-close="true">${escapeHtml(t('modal.close'))}</button>
              <button type="button" class="btn btn-primary btn-sm" data-export-action="copy">${escapeHtml(t('modal.exportCopyBtn'))}</button>
            </div>
          </div>
        </div>
      </div>
    `;
    return;
  }

  if (modal.type === 'shortcuts') {
    container.innerHTML = `
      <div class="modal-backdrop" data-modal-backdrop="true">
        <div class="modal-card modal-sm" role="dialog" aria-modal="true">
          <div class="modal-header">
            <span class="modal-title">${icon('keyboard', 17)} ${escapeHtml(t('modal.shortcutsTitle'))}</span>
            <button type="button" class="btn btn-ghost btn-icon btn-sm" data-modal-close="true">${icon('x', 16)}</button>
          </div>
          <div class="modal-body">
            <div class="shortcuts-grid">
              <span>${escapeHtml(t('modal.scPrevNext'))}</span><span><kbd>←</kbd> <kbd>→</kbd></span>
              <span>${escapeHtml(t('modal.scLightbox'))}</span><span><kbd>Enter</kbd> / <kbd>Space</kbd> / <kbd>Esc</kbd></span>
              <span>${escapeHtml(t('modal.scRate'))}</span><span><kbd>1</kbd> ~ <kbd>5</kbd></span>
              <span>${escapeHtml(t('modal.scClearRate'))}</span><span><kbd>0</kbd></span>
              <span>${escapeHtml(t('modal.scFav'))}</span><span><kbd>F</kbd></span>
              <span>${escapeHtml(t('modal.scQuickTag'))}</span><span><kbd>T</kbd></span>
              <span>${escapeHtml(t('modal.scCompare'))}</span><span><kbd>C</kbd></span>
              <span>${escapeHtml(t('modal.scInspector'))}</span><span><kbd>I</kbd></span>
              <span>${escapeHtml(t('modal.scSwitchLayout'))}</span><span><kbd>V</kbd></span>
              <span>${escapeHtml(t('modal.scSelectAll'))}</span><span><kbd>Ctrl</kbd> + <kbd>A</kbd></span>
              <span>${escapeHtml(t('modal.scHelp'))}</span><span><kbd>?</kbd></span>
            </div>
          </div>
          <div class="modal-footer">
            <button type="button" class="btn btn-primary btn-sm" data-modal-close="true">${escapeHtml(t('modal.gotIt'))}</button>
          </div>
        </div>
      </div>
    `;
  }
}

export function bindModalEvents(container, store) {
  if (!container) return;

  container.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target?.id === 'importSetupLinkInput') {
      e.preventDefault();
      container.querySelector('[data-action="import-setup-link"]')?.click();
    }
  });

  container.addEventListener('input', (e) => {
    if (e.target.id === 'quickTagSearchInput') {
      quickTagSearch = e.target.value;
      renderModals(container, store);
      const nextInput = container.querySelector('#quickTagSearchInput');
      if (nextInput) {
        nextInput.focus();
        const len = nextInput.value.length;
        nextInput.setSelectionRange(len, len);
      }
    }
  });

  container.addEventListener('change', (e) => {
    if (e.target.id === 'exportOnlyPicksCheck') {
      exportOnlyPicks = e.target.checked;
      renderModals(container, store);
    } else if (e.target.id === 'exportStripExtCheck') {
      exportStripExt = e.target.checked;
      renderModals(container, store);
    }
  });

  container.addEventListener('submit', async (e) => {
    if (e.target.id === 'connectApiKeyForm') {
      e.preventDefault();
      const apiKey = container.querySelector('#apiKeyInput')?.value || '';
      const folderInput = container.querySelector('#apiKeyFolderUrlInput')?.value || '';
      const nickname = container.querySelector('#nicknameInput')?.value || '';
      const rememberCredentials = Boolean(
        container.querySelector('#rememberApiKeyCheck')?.checked
      );
      await store.connectWithApiKey({
        apiKey,
        folderInput,
        nickname,
        rememberCredentials,
      });
      return;
    }

    if (e.target.id === 'connectDriveForm') {
      e.preventDefault();
      const clientId = container.querySelector('#clientIdInput')?.value || '';
      const folderInput = container.querySelector('#folderUrlInput')?.value || '';
      const tokenRenewalUrl = container.querySelector('#tokenRenewalUrlInput')?.value || '';
      const rememberCredentials = Boolean(
        container.querySelector('#rememberOAuthCheck')?.checked
      );
      const savedUser = store.state.savedOAuthUser;
      const useSaved = savedUser && savedUser.clientId === clientId.trim();
      await store.connectGoogleDrive({
        clientId,
        folderInput,
        tokenRenewalUrl,
        rememberCredentials,
        prompt: useSaved ? '' : 'select_account',
        ...(useSaved ? { loginHint: savedUser.email || '' } : {}),
      });
      return;
    }

    if (e.target.id === 'tagEditorForm') {
      e.preventDefault();
      const name = container.querySelector('#tagNameInput')?.value || '';
      const group = container.querySelector('#tagGroupInput')?.value || '';
      const editing = store.state.modal?.payload;
      const saved = store.upsertTagDefinition({
        id: editing?.id || null,
        name,
        color: selectedTagColor,
        group,
      });
      if (saved) store.closeModal();
    }
  });

  container.addEventListener('click', async (e) => {
    if (e.target.dataset.modalBackdrop === 'true' || e.target.closest('[data-modal-close]')) {
      store.closeModal();
      return;
    }

    const tabBtn = e.target.closest('[data-connect-tab]');
    if (tabBtn) {
      const nextTab = tabBtn.dataset.connectTab;
      if (nextTab === 'apikey' || nextTab === 'oauth') {
        connectTab = nextTab;
        renderModals(container, store);
      }
      return;
    }

    const recentBtn = e.target.closest('[data-recent-folder]');
    if (recentBtn) {
      const fid = recentBtn.dataset.recentFolder;
      const cid = recentBtn.dataset.recentClient || '';
      const akey = recentBtn.dataset.recentApikey || '';
      const fInput = container.querySelector('#folderUrlInput');
      const cInput = container.querySelector('#clientIdInput');
      const apiFolderInput = container.querySelector('#apiKeyFolderUrlInput');
      const apiKeyInput = container.querySelector('#apiKeyInput');
      if (fInput) fInput.value = fid;
      if (cInput && cid) cInput.value = cid;
      if (apiFolderInput) apiFolderInput.value = fid;
      if (apiKeyInput && akey) apiKeyInput.value = akey;
      return;
    }

    if (e.target.closest('[data-action="oauth-redirect"]')) {
      const clientId = container.querySelector('#clientIdInput')?.value || '';
      const folderInput = container.querySelector('#folderUrlInput')?.value || '';
      const tokenRenewalUrl = container.querySelector('#tokenRenewalUrlInput')?.value || '';
      const rememberCredentials = Boolean(
        container.querySelector('#rememberOAuthCheck')?.checked
      );
      store.startRedirectGoogleDrive({
        clientId,
        folderInput,
        tokenRenewalUrl,
        rememberCredentials,
      });
      return;
    }

    if (e.target.closest('[data-action="import-setup-link"]')) {
      const linkInput = container.querySelector('#importSetupLinkInput');
      let rawText = String(linkInput?.value || '').trim();
      if (!rawText && typeof navigator !== 'undefined' && navigator.clipboard?.readText) {
        try {
          rawText = String((await navigator.clipboard.readText()) || '').trim();
        } catch {
          // Ignore clipboard permission denial
        }
      }
      if (!rawText) {
        linkInput?.focus();
        store.toast(t('modal.importSetupLinkEmpty'), 'info');
        return;
      }

      const parsed = parseSetupLinkInput(rawText);
      if (parsed?.invalidRenewalUrl) {
        linkInput?.focus();
        store.toast(t('modal.invalidRenewalUrl'), 'error');
        return;
      }
      if (!parsed) {
        linkInput?.focus();
        store.toast(t('modal.importSetupLinkInvalid'), 'error');
        return;
      }

      const targetAuth =
        parsed.apiKey && !parsed.clientId
          ? 'apikey'
          : parsed.clientId || parsed.tokenRenewalUrl
            ? 'oauth'
            : connectTab || store.state.authType || 'oauth';
      connectTab = targetAuth;

      if (parsed.lang) {
        store.setLanguage(parsed.lang);
      }
      if (parsed.layout) {
        store.setLayoutMode(parsed.layout);
      }

      const remEl =
        container.querySelector('#rememberOAuthCheck') ||
        container.querySelector('#rememberApiKeyCheck');
      const rememberCredentials = remEl
        ? Boolean(remEl.checked)
        : store.state.rememberCredentials !== false;
      const patch = {
        authType: targetAuth,
        rememberCredentials,
      };
      if (parsed.folderId) patch.folderId = parsed.folderId;
      if (parsed.clientId) patch.clientId = parsed.clientId;
      if (parsed.apiKey) patch.apiKey = parsed.apiKey;
      if (parsed.tokenRenewalUrl) patch.tokenRenewalUrl = parsed.tokenRenewalUrl;
      if (parsed.nickname) patch.nickname = parsed.nickname;

      if (rememberCredentials) {
        saveConnectPrefs({
          authType: targetAuth,
          folderId: patch.folderId ?? store.state.folderId ?? '',
          clientId: patch.clientId ?? store.state.clientId ?? '',
          apiKey: patch.apiKey ?? store.state.apiKey ?? '',
          tokenRenewalUrl: patch.tokenRenewalUrl ?? store.state.tokenRenewalUrl ?? '',
          nickname: patch.nickname ?? store.state.nickname ?? '',
          rememberCredentials: true,
          autoConnect: true,
        });
      }

      store.setState(patch, { type: 'ui-only' });
      renderModals(container, store);

      if (parsed.clientId || parsed.tokenRenewalUrl || (parsed.folderId && targetAuth === 'oauth')) {
        store.toast(
          t('modal.importSetupLinkSuccessOAuth', { count: parsed.fieldCount }),
          'success',
          4800
        );
      } else if (parsed.apiKey || (parsed.folderId && targetAuth === 'apikey')) {
        store.toast(
          t('modal.importSetupLinkSuccessApiKey', { count: parsed.fieldCount }),
          'success',
          4800
        );
      } else {
        store.toast(
          t('modal.importSetupLinkSuccessGeneric', { count: parsed.fieldCount }),
          'success',
          3800
        );
      }
      return;
    }

    if (e.target.closest('[data-action="copy-setup-link-oauth"]')) {
      const clientId = String(container.querySelector('#clientIdInput')?.value || '').trim();
      const folderInput = container.querySelector('#folderUrlInput')?.value || '';
      const rawRenewal = String(container.querySelector('#tokenRenewalUrlInput')?.value || '').trim();
      const folderId = parseDriveFolderId(folderInput);
      if (!clientId) {
        store.toast(t('store.missingClientId'), 'error');
        return;
      }
      if (!folderId) {
        store.toast(t('store.invalidFolder'), 'error');
        return;
      }
      const cleanRenewal = rawRenewal ? normalizeRenewalEndpoint(rawRenewal) : '';
      if (rawRenewal && !cleanRenewal) {
        store.toast(t('modal.invalidRenewalUrl'), 'error');
        return;
      }
      const params = new URLSearchParams();
      params.set('folder', folderId);
      params.set('client_id', clientId);
      if (cleanRenewal) {
        params.set('renewal_url', cleanRenewal);
      }
      const setupUrl = `${window.location.origin}${window.location.pathname}#${params.toString()}`;
      const copied = await copyTextWithFallback(setupUrl);
      if (copied) {
        store.toast(t('modal.setupLinkCopiedToast'), 'success', 4200);
      } else {
        window.prompt(t('modal.copySetupLinkBtn'), setupUrl);
        store.toast(t('modal.copyFailedManual'), 'info');
      }
      return;
    }

    if (e.target.closest('[data-action="copy-setup-link-apikey"]')) {
      const apiKey = String(container.querySelector('#apiKeyInput')?.value || '').trim();
      const folderInput = container.querySelector('#apiKeyFolderUrlInput')?.value || '';
      const nickname = String(container.querySelector('#nicknameInput')?.value || '').trim();
      const folderId = parseDriveFolderId(folderInput);
      if (!apiKey) {
        store.toast(t('store.missingApiKey'), 'error');
        return;
      }
      if (!folderId) {
        store.toast(t('store.invalidFolder'), 'error');
        return;
      }
      const params = new URLSearchParams();
      params.set('folder', folderId);
      params.set('key', apiKey);
      if (nickname) {
        params.set('nick', nickname);
      }
      const setupUrl = `${window.location.origin}${window.location.pathname}#${params.toString()}`;
      const copied = await copyTextWithFallback(setupUrl);
      if (copied) {
        store.toast(t('modal.setupLinkCopiedToast'), 'success', 4200);
      } else {
        window.prompt(t('modal.copySetupLinkBtn'), setupUrl);
        store.toast(t('modal.copyFailedManual'), 'info');
      }
      return;
    }

    if (e.target.closest('[data-action="copy-mcp-config"]')) {
      const clientId =
        String(container.querySelector('#clientIdInput')?.value || '').trim() ||
        store.state.clientId ||
        '';
      const folderInput =
        container.querySelector('#folderUrlInput')?.value || store.state.folderId || '';
      const rawRenewal =
        String(container.querySelector('#tokenRenewalUrlInput')?.value || '').trim() ||
        store.state.tokenRenewalUrl ||
        '';
      const folderId = parseDriveFolderId(folderInput);
      const cleanRenewal = rawRenewal ? normalizeRenewalEndpoint(rawRenewal) : '';
      if (rawRenewal && !cleanRenewal) {
        store.toast(t('modal.invalidRenewalUrl'), 'error');
        return;
      }
      const ticket =
        clientId && cleanRenewal ? getStoredRenewalTicket(clientId, cleanRenewal) : '';
      const mcpConfig = {
        mcpServers: {
          drivelens: {
            command: 'python',
            args: ['/path/to/drivelens/mcp/drivelens_mcp.py'],
            env: {
              DRIVELENS_FOLDER_ID: folderId || '<YOUR_FOLDER_ID>',
              DRIVELENS_CLIENT_ID: clientId || '<YOUR_CLIENT_ID>',
              DRIVELENS_RENEWAL_URL: cleanRenewal || '<YOUR_WORKER_URL>',
              DRIVELENS_REFRESH_TICKET:
                ticket || '<SIGN_IN_FIRST_OR_USE_SERVICE_ACCOUNT>',
            },
          },
        },
      };
      const jsonText = JSON.stringify(mcpConfig, null, 2);
      const copied = await copyTextWithFallback(jsonText);
      if (copied) {
        store.toast(t('modal.mcpConfigCopiedToast'), 'success', 5000);
      } else {
        window.prompt(t('modal.copyMcpConfigBtn'), jsonText);
        store.toast(t('modal.copyFailedManual'), 'info');
      }
      return;
    }

    if (e.target.closest('[data-action="forget-creds"]')) {
      store.forgetSavedCredentials();
      return;
    }

    if (e.target.closest('[data-action="clear-cache"]')) {
      await store.clearLocalCache();
      return;
    }

    if (e.target.closest('[data-action="back-to-demo"]')) {
      store.closeModal();
      store.loadDemoMode(true, true);
      return;
    }

    const colorBtn = e.target.closest('[data-pick-color]');
    if (colorBtn) {
      selectedTagColor = colorBtn.dataset.pickColor;
      const swatches = container.querySelectorAll('.color-swatch');
      for (const sw of swatches) {
        const active = sw.dataset.pickColor === selectedTagColor;
        sw.classList.toggle('active', active);
        sw.innerHTML = active ? icon('check', 14) : '';
      }
      return;
    }

    const quickTagBtn = e.target.closest('[data-quick-toggle-tag]');
    if (quickTagBtn) {
      const photoIds = store.state.modal?.payload?.photoIds || [];
      store.toggleTagOnPhotos(photoIds, quickTagBtn.dataset.quickToggleTag);
      return;
    }

    if (e.target.closest('[data-action="create-from-quick"]')) {
      store.openModal('tagEditor', null);
      return;
    }

    const exportBtn = e.target.closest('[data-export-action]');
    if (exportBtn) {
      const act = exportBtn.dataset.exportAction;
      const rows = buildExportRows(store);
      if (act === 'copy') {
        const text = rows.map((r) => r.name).join('\n');
        try {
          await navigator.clipboard.writeText(text);
          store.toast(t('modal.exportCopiedToast', { count: rows.length }), 'success');
        } catch {
          const box = container.querySelector('#exportPreviewBox');
          box?.select();
          store.toast(t('modal.exportCopyManualToast'), 'info');
        }
      } else if (act === 'csv') {
        const header = t('modal.csvHeaders').split(',');
        const csvLines = [
          header.join(','),
          ...rows.map((r) =>
            [
              r.name,
              r.folder,
              r.avgRating,
              r.myRating,
              r.favoriteCount,
              r.tags.join('; '),
              r.notes,
            ]
              .map((v) => `"${String(v ?? '').replace(/"/g, '""')}"`)
              .join(',')
          ),
        ];
        downloadTextFile('drivelens-shared-picks.csv', '\uFEFF' + csvLines.join('\n'), 'text/csv;charset=utf-8');
        store.toast(t('modal.exportedCsvToast'), 'success');
      } else if (act === 'json') {
        downloadTextFile('drivelens-shared-picks.json', JSON.stringify(rows, null, 2), 'application/json');
        store.toast(t('modal.exportedJsonToast'), 'success');
      }
    }
  });
}
