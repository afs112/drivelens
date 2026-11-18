import { getDemoPersonas } from '../demo/demoAlbum.js';
import { SUPPORTED_LANGS, t } from '../i18n.js';
import { escapeAttr, escapeHtml, icon } from './icons.js';
import { isCompareOpen, openCompare, closeCompare } from './renderCompare.js';
import {
  isGallerySelectModeActive,
  previewGalleryRowHeight,
  toggleGallerySelectMode,
} from './renderGallery.js';

const SIDEBAR_ICON_SVG =
  '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="18" height="18" x="3" y="3" rx="2"/><path d="M9 3v18"/></svg>';

const LAYOUT_INDEX_MAP = {
  justified: 0,
  waterfall: 1,
  grid: 2,
};

let lastBannerSignature = '';
let lastToastSignature = '';
let isSearchComposing = false;
let searchOpen = false;
let demoBannerExpanded = false;
let moreMenuOpen = false;
let headerDocBound = false;

function buildHeaderSkeleton(headerEl, state) {
  const currentLang = state.lang || 'en';
  const langOptions = SUPPORTED_LANGS.map(
    (l) =>
      `<option value="${escapeAttr(l.id)}" ${currentLang === l.id ? 'selected' : ''}>${escapeHtml(l.label)}</option>`
  ).join('');

  headerEl.innerHTML = `
    <div class="header-left header-glass-pill">
      <button type="button" class="btn btn-ghost btn-icon header-desktop" data-header="toggle-sidebar" aria-controls="sidebarPanel" title="${escapeAttr(t('header.toggleSidebar'))}">
        ${SIDEBAR_ICON_SVG}
      </button>
      <button type="button" class="album-pill" data-header="toggle-album" data-header-pill title="">
        <span class="album-pill-dot"></span>
        <span class="album-pill-name"></span>
        <span class="album-pill-count"></span>
      </button>
    </div>

    <div class="header-center">
      <div class="search-box header-glass-pill">
        <span class="search-icon">${icon('search', 14)}</span>
        <input
          id="searchInput"
          type="text"
          placeholder="${escapeAttr(t('header.searchPlaceholder'))}"
          aria-label="${escapeAttr(t('header.searchPlaceholder'))}"
          autocomplete="off"
        />
        <button
          type="button"
          id="searchClearBtn"
          class="search-clear-btn"
          data-header="clear-search"
          title="${escapeAttr(t('header.clearSearch'))}"
          aria-label="${escapeAttr(t('header.clearSearch'))}"
        >${icon('x', 13)}</button>
      </div>
    </div>

    <div class="header-right">
      <div class="segmented segmented-sliding header-glass-pill header-layout-shortcuts header-desktop" data-layout-seg role="group" aria-label="${escapeAttr(t('header.layoutGroup'))}">
        <button type="button" class="seg-btn" data-header="layout" data-layout="justified" title="${escapeAttr(t('header.layoutJustified'))}" aria-label="${escapeAttr(t('sidebar.viewJustified'))}">
          ${icon('rows', 16)}
        </button>
        <button type="button" class="seg-btn" data-header="layout" data-layout="waterfall" title="${escapeAttr(t('header.layoutWaterfall'))}" aria-label="${escapeAttr(t('sidebar.viewWaterfall'))}">
          ${icon('waterfall', 16)}
        </button>
        <button type="button" class="seg-btn" data-header="layout" data-layout="grid" title="${escapeAttr(t('header.layoutGrid'))}" aria-label="${escapeAttr(t('sidebar.viewGrid'))}">
          ${icon('grid', 16)}
        </button>
      </div>

      <button
        type="button"
        class="btn btn-icon header-glass-pill"
        data-header="toggle-select"
        title="${escapeAttr(t('header.toggleSelect'))}"
        aria-label="${escapeAttr(t('header.toggleSelect'))}"
      >
        ${icon('checkCircle', 17)}
      </button>

      <button
        type="button"
        class="btn btn-icon header-glass-pill header-desktop"
        data-header="toggle-search"
        title="${escapeAttr(t('mobile.navSearch'))}"
        aria-label="${escapeAttr(t('mobile.navSearch'))}"
      >
        ${icon('search', 16)}
      </button>

      <button
        type="button"
        class="btn btn-icon header-glass-pill header-desktop"
        data-header="toggle-inspector"
        aria-controls="inspectorPanel"
        title="${escapeAttr(t('header.toggleInspector'))}"
        aria-label="${escapeAttr(t('header.toggleInspector'))}"
      >
        ${icon('info', 16)}
      </button>

      <button
        type="button"
        class="btn btn-icon header-glass-pill"
        data-header="toggle-more"
        title="${escapeAttr(t('header.moreMenu'))}"
        aria-label="${escapeAttr(t('header.moreMenu'))}"
        aria-expanded="false"
        aria-controls="headerMorePopover"
      >
        ${icon('moreHorizontal', 17)}
      </button>
    </div>

    <div id="headerMorePopover" class="header-more-popover" role="region" aria-label="${escapeAttr(t('header.moreMenu'))}" inert>
      <div class="more-popover-section">
        <div class="more-popover-label">${escapeHtml(t('header.layoutGroup'))}</div>
        <div class="segmented segmented-sliding" data-more-layout-seg role="group" aria-label="${escapeAttr(t('header.layoutGroup'))}" style="width:100%">
          <button type="button" class="seg-btn" data-more-layout="justified" title="${escapeAttr(t('header.layoutJustified'))}" aria-label="${escapeAttr(t('sidebar.viewJustified'))}">
            ${icon('rows', 16)}
          </button>
          <button type="button" class="seg-btn" data-more-layout="waterfall" title="${escapeAttr(t('header.layoutWaterfall'))}" aria-label="${escapeAttr(t('sidebar.viewWaterfall'))}">
            ${icon('waterfall', 16)}
          </button>
          <button type="button" class="seg-btn" data-more-layout="grid" title="${escapeAttr(t('header.layoutGrid'))}" aria-label="${escapeAttr(t('sidebar.viewGrid'))}">
            ${icon('grid', 16)}
          </button>
        </div>
      </div>

      <div class="more-popover-section">
        <div class="more-popover-label">
          <span>${escapeHtml(t('header.thumbSize'))}</span>
          <span data-more-size-px class="more-size-badge">210px</span>
        </div>
        <input
          id="rowHeightRange"
          class="range-slider"
          style="width:100%"
          type="range"
          min="130"
          max="320"
          step="4"
          value="210"
          title="${escapeAttr(t('header.thumbSize'))}"
          aria-label="${escapeAttr(t('header.thumbSize'))}"
        />
      </div>

      <div class="more-popover-actions">
        <button type="button" class="btn btn-sm" data-header="connect" title="${escapeAttr(t('header.connectTooltip'))}">
          ${icon('cloud', 13)}
          <span data-header-connect-label>${escapeHtml(t('header.connectDrive'))}</span>
        </button>
        <button type="button" class="btn btn-sm" data-header="refresh" title="${escapeAttr(t('header.refresh'))}">
          ${icon('refresh', 13)}
          <span>${escapeHtml(t('header.refresh'))}</span>
        </button>
        <button type="button" class="btn btn-sm" data-header="compare" title="${escapeAttr(t('header.compareTooltip'))}">
          ${icon('compare', 14)}
          <span>${escapeHtml(t('header.compareBtn'))}</span>
        </button>
        <button type="button" class="btn btn-sm" data-header="export" title="${escapeAttr(t('header.exportTooltip'))}">
          ${icon('share', 13)}
          <span>${escapeHtml(t('header.exportBtn'))}</span>
        </button>
        <button type="button" class="btn btn-sm hidden" data-header="install-app" title="${escapeAttr(t('header.installAppTooltip'))}">
          ${icon('appWindow', 13)}
          <span>${escapeHtml(t('header.installApp'))}</span>
        </button>
        <button type="button" class="btn btn-sm" data-header="toggle-theme" title="${escapeAttr(t('header.themeToLight'))}">
          ${icon('sun', 13)}
        </button>
        <button type="button" class="btn btn-sm hide-xs" data-header="shortcuts" title="${escapeAttr(t('header.shortcuts'))}">
          ${icon('keyboard', 13)}
          <span>${escapeHtml(t('header.shortcuts'))}</span>
        </button>
      </div>

      <div class="more-popover-footer">
        <span class="sync-pill" data-header-sync></span>
        <select id="langSelect" class="select-sm" data-header-lang aria-label="${escapeAttr(t('header.langLabel'))}" title="${escapeAttr(t('header.langLabel'))}">
          ${langOptions}
        </select>
      </div>
    </div>
  `;
}

function updateHeaderElements(headerEl, state, store) {
  const sidebarBtn = headerEl.querySelector('[data-header="toggle-sidebar"]');
  if (sidebarBtn) {
    const expanded = Boolean(state.sidebarOpen);
    sidebarBtn.setAttribute('aria-expanded', String(expanded));
    sidebarBtn.classList.toggle('is-active', expanded);
  }

  const pillEl = headerEl.querySelector('[data-header-pill]');
  const pillNameEl = headerEl.querySelector('.album-pill-name');
  const pillCountEl = headerEl.querySelector('.album-pill-count');
  if (pillEl && pillNameEl) {
    const isGdrive = state.mode === 'gdrive';
    const albumName =
      state.rootFolder?.name ||
      (isGdrive ? t('header.albumDrive') : t('header.albumDemo'));
    pillEl.classList.toggle('is-gdrive', isGdrive);
    pillEl.title = isGdrive
      ? t('header.albumDrivePrefix', { name: albumName })
      : t('header.demoPillHint', { name: albumName });
    pillEl.setAttribute('aria-controls', isGdrive ? 'sidebarPanel' : 'demoBanner');
    pillEl.setAttribute('aria-expanded', String(isGdrive ? state.sidebarOpen : demoBannerExpanded));
    pillNameEl.textContent = albumName;
    if (pillCountEl) {
      pillCountEl.textContent = String(store.getVisiblePhotos().length);
    }
  }

  const selCount = state.selectedPhotoIds?.size || 0;
  const selectBtn = headerEl.querySelector('[data-header="toggle-select"]');
  if (selectBtn) {
    const selecting = isGallerySelectModeActive(store);
    selectBtn.classList.toggle('is-active', selecting);
    selectBtn.setAttribute('aria-pressed', String(selecting));
  }
  const searchInput = headerEl.querySelector('#searchInput');
  if (searchInput) {
    const nextQuery = state.searchQuery || '';
    if (!isSearchComposing && searchInput.value !== nextQuery) {
      const wasFocused = document.activeElement === searchInput;
      const start = searchInput.selectionStart;
      const end = searchInput.selectionEnd;
      searchInput.value = nextQuery;
      if (wasFocused && typeof start === 'number' && typeof end === 'number') {
        searchInput.setSelectionRange(
          Math.min(start, nextQuery.length),
          Math.min(end, nextQuery.length)
        );
      }
    }
  }

  const searchToggleBtn = headerEl.querySelector('[data-header="toggle-search"]');
  if (searchToggleBtn) {
    searchToggleBtn.classList.toggle('is-active', searchOpen || Boolean(state.searchQuery));
    searchToggleBtn.setAttribute('aria-expanded', String(searchOpen));
  }

  const segIndex = String(LAYOUT_INDEX_MAP[state.layoutMode] ?? 1);
  headerEl.querySelector('[data-layout-seg]')?.style.setProperty('--seg-index', segIndex);
  headerEl.querySelector('[data-more-layout-seg]')?.style.setProperty('--seg-index', segIndex);

  for (const btn of headerEl.querySelectorAll('[data-header="layout"]')) {
    const active = btn.dataset.layout === state.layoutMode;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-pressed', String(active));
  }
  for (const btn of headerEl.querySelectorAll('[data-more-layout]')) {
    const active = btn.dataset.moreLayout === state.layoutMode;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-pressed', String(active));
  }

  const rowRange = headerEl.querySelector('#rowHeightRange');
  const sizeBadge = headerEl.querySelector('[data-more-size-px]');
  const heightStr = String(state.rowHeight || 210);
  if (rowRange) {
    if (rowRange.value !== heightStr) {
      rowRange.value = heightStr;
    }
    rowRange.title = t('header.thumbSizePx', { px: heightStr });
  }
  if (sizeBadge) {
    sizeBadge.textContent = `${heightStr}px`;
  }

  const compareBtn = headerEl.querySelector('[data-header="compare"]');
  if (compareBtn) {
    compareBtn.classList.toggle('is-active', isCompareOpen());
    compareBtn.title =
      selCount >= 2
        ? t('header.compareSelectedTooltip', { count: Math.min(4, selCount) })
        : t('header.compareTooltip');
  }

  const refreshBtn = headerEl.querySelector('[data-header="refresh"]');
  if (refreshBtn) {
    const busy = Boolean(state.loading || state.backgroundRefreshing);
    refreshBtn.disabled = busy;
    const svg = refreshBtn.querySelector('svg');
    if (svg) svg.classList.toggle('spin', busy);
  }

  const syncEl = headerEl.querySelector('[data-header-sync]');
  if (syncEl) {
    const status = state.syncStatus || 'idle';
    syncEl.className = `sync-pill ${status}`;
    syncEl.title = state.syncMessage || '';
    if (status === 'syncing') {
      syncEl.innerHTML = `${icon('refresh', 12, 'spin')}<span>${escapeHtml(t('header.syncSyncing'))}</span>`;
    } else if (status === 'synced') {
      syncEl.innerHTML = `${icon('check', 12)}<span>${escapeHtml(t('header.syncSynced'))}</span>`;
    } else if (status === 'readonly') {
      syncEl.innerHTML = `<span>${escapeHtml(t('header.syncReadonly'))}</span>`;
    } else if (status === 'error') {
      syncEl.innerHTML = `${icon('alertCircle', 12)}<span>${escapeHtml(t('header.syncError'))}</span>`;
    } else {
      syncEl.innerHTML = `<span>${escapeHtml(state.mode === 'gdrive' ? t('header.syncReady') : t('header.syncDemo'))}</span>`;
    }
  }

  const connectBtn = headerEl.querySelector('[data-header="connect"]');
  if (connectBtn) {
    const isGdrive = state.mode === 'gdrive';
    connectBtn.classList.toggle('btn-primary', !isGdrive);
    const labelEl = connectBtn.querySelector('[data-header-connect-label]');
    if (labelEl) {
      labelEl.textContent = isGdrive
        ? state.currentUser?.name || t('header.switchDrive')
        : t('header.connectDrive');
    }
    connectBtn.title = isGdrive
      ? t('header.connectedTooltip', {
          user: state.currentUser?.email || state.currentUser?.name || '',
        })
      : t('header.connectTooltip');
  }

  const inspBtn = headerEl.querySelector('[data-header="toggle-inspector"]');
  if (inspBtn) {
    inspBtn.classList.toggle('is-active', Boolean(state.inspectorOpen));
    inspBtn.setAttribute('aria-expanded', String(state.inspectorOpen));
  }

  const moreBtn = headerEl.querySelector('[data-header="toggle-more"]');
  const morePop = headerEl.querySelector('#headerMorePopover');
  if (moreBtn) {
    moreBtn.classList.toggle('is-active', moreMenuOpen);
    moreBtn.setAttribute('aria-expanded', String(moreMenuOpen));
  }
  if (morePop) {
    morePop.classList.toggle('is-open', moreMenuOpen);
    morePop.inert = !moreMenuOpen;
  }

  const installBtn = headerEl.querySelector('[data-header="install-app"]');
  if (installBtn) {
    installBtn.classList.toggle('hidden', !state.canInstallPwa);
  }

  const langSelect = headerEl.querySelector('#langSelect');
  if (langSelect && langSelect.value !== (state.lang || 'en')) {
    langSelect.value = state.lang || 'en';
  }

  const themeBtn = headerEl.querySelector('[data-header="toggle-theme"]');
  if (themeBtn) {
    const currentTheme = state.theme === 'light' ? 'light' : 'dark';
    const labelText =
      currentTheme === 'dark' ? t('header.themeToLight') : t('header.themeToDark');
    themeBtn.innerHTML = `${icon(currentTheme === 'dark' ? 'sun' : 'moon', 13)} <span>${escapeHtml(labelText)}</span>`;
    themeBtn.title = labelText;
  }

  headerEl.classList.toggle('mobile-search-open', searchOpen);
  if (searchOpen || moreMenuOpen || demoBannerExpanded || state.sidebarOpen || state.inspectorOpen) {
    headerEl.classList.remove('is-hidden-scroll');
  }
}

export function dismissHeaderOverlay(headerEl, store) {
  if (moreMenuOpen || demoBannerExpanded || searchOpen) {
    const trigger = moreMenuOpen
      ? headerEl.querySelector('[data-header="toggle-more"]')
      : demoBannerExpanded
        ? headerEl.querySelector('[data-header-pill]')
        : headerEl.querySelector('[data-header="toggle-search"]');
    moreMenuOpen = false;
    demoBannerExpanded = false;
    searchOpen = false;
    store.emit();
    if (trigger?.offsetWidth) trigger.focus();
    else document.querySelector('[data-mnav="search"]')?.focus();
    return true;
  }
  return false;
}

function toggleSearch(headerEl, store) {
  searchOpen = !searchOpen;
  moreMenuOpen = false;
  demoBannerExpanded = false;
  headerEl.classList.remove('is-hidden-scroll');
  if (searchOpen) {
    store.setState({ sidebarOpen: false, inspectorOpen: false });
    headerEl.querySelector('#searchInput')?.focus();
  } else {
    store.emit();
  }
}

function renderDemoBanner(bannerEl, state) {
  if (!bannerEl) return;
  if (state.mode !== 'demo' || !demoBannerExpanded) {
    if (lastBannerSignature !== 'hidden') {
      lastBannerSignature = 'hidden';
      bannerEl.classList.add('hidden');
      bannerEl.innerHTML = '';
    }
    return;
  }

  bannerEl.classList.remove('hidden');
  const currentLang = state.lang || 'en';
  const sig = `demo|${currentLang}|${state.currentUser?.id || ''}`;
  if (sig === lastBannerSignature && bannerEl.childElementCount > 0) {
    return;
  }
  lastBannerSignature = sig;

  const personas = getDemoPersonas(currentLang);
  const personaButtons = personas
    .map(
      (p) => `
      <button
        type="button"
        class="persona-btn ${p.id === state.currentUser?.id ? 'active' : ''}"
        data-banner="persona"
        data-persona-id="${escapeAttr(p.id)}"
        title="${escapeAttr(t('banner.personaTooltip', { name: p.name }))}"
      >
        <span style="width:7px;height:7px;border-radius:50%;background:${escapeAttr(p.color)};display:inline-block;flex-shrink:0"></span>
        <span>${escapeHtml(p.name)}</span>
      </button>
    `
    )
    .join('');

  bannerEl.innerHTML = `
    <div class="demo-banner-info">
      ${icon('users', 14)}
      <span><strong>${escapeHtml(t('banner.infoStrong'))}</strong></span>
    </div>
    <div class="demo-banner-actions">
      <div class="persona-switcher" role="group" aria-label="${escapeAttr(t('banner.personaGroup'))}">
        ${personaButtons}
      </div>
      <button type="button" class="btn btn-sm" data-banner="reset-demo" title="${escapeAttr(t('banner.resetDemoTooltip'))}">
        ${icon('refresh', 12)} ${escapeHtml(t('banner.resetDemo'))}
      </button>
      <button type="button" class="btn btn-sm btn-primary" data-banner="connect-gdrive">
        ${icon('cloud', 12)} ${escapeHtml(t('banner.connectRealDrive'))}
      </button>
      <button type="button" class="btn btn-ghost btn-icon btn-sm" data-banner="close-banner" aria-label="${escapeAttr(t('modal.close'))}">
        ${icon('x', 14)}
      </button>
    </div>
  `;
}

function renderToasts(toastEl, state) {
  if (!toastEl) return;
  const toasts = state.toasts || [];
  const sig = toasts.map((tItem) => `${tItem.id}:${tItem.type}`).join(',');
  if (sig === lastToastSignature) return;
  lastToastSignature = sig;

  toastEl.innerHTML = toasts
    .map((tItem) => {
      const iconName =
        tItem.type === 'success'
          ? 'check'
          : tItem.type === 'error'
            ? 'alertCircle'
            : 'info';
      const color =
        tItem.type === 'success'
          ? 'var(--success)'
          : tItem.type === 'error'
            ? 'var(--danger)'
            : 'var(--accent)';
      return `
        <div class="toast ${escapeAttr(tItem.type || 'info')}" role="status" data-toast-id="${escapeAttr(tItem.id)}">
          <span style="color:${color};display:inline-flex;flex-shrink:0">${icon(iconName, 15)}</span>
          <span>${escapeHtml(tItem.message)}</span>
        </div>
      `;
    })
    .join('');
}

export function renderHeader(headerEl, bannerEl, toastEl, store) {
  const state = store.state;
  if (headerEl) {
    const currentLang = state.lang || 'en';
    if (!headerEl.querySelector('#searchInput') || headerEl.dataset.lang !== currentLang) {
      const prevSearch = headerEl.querySelector('#searchInput');
      const prevLangSelect = headerEl.querySelector('#langSelect');
      const wasSearchFocused = prevSearch && document.activeElement === prevSearch;
      const wasLangFocused = prevLangSelect && document.activeElement === prevLangSelect;
      const selStart = prevSearch?.selectionStart;
      const selEnd = prevSearch?.selectionEnd;

      headerEl.dataset.lang = currentLang;
      buildHeaderSkeleton(headerEl, state);

      const nextSearch = headerEl.querySelector('#searchInput');
      if (nextSearch) {
        nextSearch.value = state.searchQuery || '';
        if (wasSearchFocused) {
          nextSearch.focus();
          if (typeof selStart === 'number' && typeof selEnd === 'number') {
            nextSearch.setSelectionRange(
              Math.min(selStart, nextSearch.value.length),
              Math.min(selEnd, nextSearch.value.length)
            );
          }
        }
      }
      if (wasLangFocused) {
        headerEl.querySelector('#langSelect')?.focus();
      }
    }
    updateHeaderElements(headerEl, state, store);
  }
  renderDemoBanner(bannerEl, state);
  renderToasts(toastEl, state);
}

export function bindHeaderEvents(headerEl, bannerEl, store) {
  if (headerEl) {
    if (!headerDocBound) {
      headerDocBound = true;
      document.addEventListener('click', (e) => {
        if ((!moreMenuOpen && !demoBannerExpanded) || headerEl.contains(e.target) || bannerEl?.contains(e.target)) {
          return;
        }
        moreMenuOpen = false;
        demoBannerExpanded = false;
        store.emit();
      });
    }

    headerEl.addEventListener('compositionstart', (e) => {
      if (e.target.id === 'searchInput') isSearchComposing = true;
    });

    headerEl.addEventListener('compositionend', (e) => {
      if (e.target.id === 'searchInput') {
        isSearchComposing = false;
        store.setState({ searchQuery: e.target.value });
      }
    });

    headerEl.addEventListener('input', (e) => {
      if (e.target.id === 'searchInput') {
        store.setState({ searchQuery: e.target.value });
      } else if (e.target.id === 'rowHeightRange') {
        const nextVal = Number(e.target.value);
        e.target.title = t('header.thumbSizePx', { px: String(nextVal) });
        const sizeBadge = headerEl.querySelector('[data-more-size-px]');
        if (sizeBadge) sizeBadge.textContent = `${nextVal}px`;
        previewGalleryRowHeight(
          document.getElementById('galleryGrid'),
          document.getElementById('galleryScroll'),
          store,
          nextVal
        );
      }
    });

    headerEl.addEventListener('change', (e) => {
      if (e.target.id === 'langSelect') {
        store.setLanguage(e.target.value);
      } else if (e.target.id === 'rowHeightRange') {
        store.setRowHeight(Number(e.target.value));
      }
    });

    headerEl.addEventListener('click', (e) => {
      const moreLayoutBtn = e.target.closest('[data-more-layout]');
      if (moreLayoutBtn) {
        const layoutMode = moreLayoutBtn.dataset.moreLayout;
        if (layoutMode === 'justified' || layoutMode === 'waterfall' || layoutMode === 'grid') {
          store.setLayoutMode(layoutMode);
        }
        return;
      }

      const btn = e.target.closest('[data-header]');
      if (!btn) return;
      const action = btn.dataset.header;

      if (action === 'toggle-more') {
        moreMenuOpen = !moreMenuOpen;
        searchOpen = false;
        demoBannerExpanded = false;
        if (moreMenuOpen) store.setState({ sidebarOpen: false, inspectorOpen: false });
        else store.emit();
      } else if (action === 'toggle-select') {
        moreMenuOpen = false;
        demoBannerExpanded = false;
        toggleGallerySelectMode(store);
      } else if (action === 'toggle-album') {
        moreMenuOpen = false;
        searchOpen = false;
        if (store.state.mode === 'demo') {
          demoBannerExpanded = !demoBannerExpanded;
          store.setState({ sidebarOpen: false, inspectorOpen: false });
        } else {
          store.setState({ sidebarOpen: !store.state.sidebarOpen, inspectorOpen: false });
        }
      } else if (action === 'toggle-search') {
        toggleSearch(headerEl, store);
      } else if (action === 'toggle-sidebar') {
        moreMenuOpen = false;
        searchOpen = false;
        demoBannerExpanded = false;
        store.setState({ sidebarOpen: !store.state.sidebarOpen, inspectorOpen: false });
      } else if (action === 'clear-search') {
        searchOpen = false;
        const input = headerEl.querySelector('#searchInput');
        if (input) input.value = '';
        store.setState({ searchQuery: '' });
        const trigger = headerEl.querySelector('[data-header="toggle-search"]');
        if (trigger?.offsetWidth) trigger.focus();
        else document.querySelector('[data-mnav="search"]')?.focus();
      } else if (action === 'layout') {
        const layoutMode = btn.dataset.layout;
        if (layoutMode === 'justified' || layoutMode === 'waterfall' || layoutMode === 'grid') {
          store.setLayoutMode(layoutMode);
        }
      } else if (action === 'compare') {
        moreMenuOpen = false;
        openCompare(Array.from(store.state.selectedPhotoIds), store);
      } else if (action === 'refresh') {
        store.refreshAlbum();
      } else if (action === 'export') {
        moreMenuOpen = false;
        store.openModal('export');
      } else if (action === 'connect') {
        moreMenuOpen = false;
        store.openModal('connect');
      } else if (action === 'install-app') {
        moreMenuOpen = false;
        store.promptInstallPwa();
      } else if (action === 'toggle-inspector') {
        moreMenuOpen = false;
        searchOpen = false;
        demoBannerExpanded = false;
        store.setState({ inspectorOpen: !store.state.inspectorOpen, sidebarOpen: false });
      } else if (action === 'toggle-theme') {
        store.toggleTheme();
      } else if (action === 'shortcuts') {
        moreMenuOpen = false;
        store.openModal('shortcuts');
      }
    });
  }

  if (bannerEl) {
    bannerEl.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-banner]');
      if (!btn) return;
      const action = btn.dataset.banner;

      if (action === 'persona') {
        store.switchDemoPersona(btn.dataset.personaId);
      } else if (action === 'reset-demo') {
        store.resetDemo();
      } else if (action === 'connect-gdrive') {
        demoBannerExpanded = false;
        store.openModal('connect');
      } else if (action === 'close-banner') {
        demoBannerExpanded = false;
        store.emit();
        headerEl?.querySelector('[data-header-pill]')?.focus();
      }
    });
  }
}

export function syncMobileNavSlidingPill(navEl) {
  if (!navEl) return;
  const track = navEl.querySelector('[data-mnav-track]');
  const pill = navEl.querySelector('[data-mnav-pill]');
  if (!track || !pill) return;
  const activeBtn = track.querySelector('.mobile-nav-btn.is-active');
  if (!activeBtn || !activeBtn.offsetWidth) {
    pill.style.opacity = '0';
    return;
  }
  pill.style.opacity = '1';
  pill.style.width = `${activeBtn.offsetWidth}px`;
  pill.style.transform = `translateX(${activeBtn.offsetLeft}px)`;
}

export function renderMobileNav(navEl, store) {
  if (!navEl) return;
  const state = store.state;
  const currentLang = state.lang || 'en';
  navEl.setAttribute('aria-label', t('mobile.navAria'));

  if (!navEl.querySelector('[data-mnav-track]') || navEl.dataset.lang !== currentLang) {
    navEl.dataset.lang = currentLang;
    navEl.innerHTML = `
      <div class="mobile-nav-split">
        <div class="mobile-nav-pill-track" data-mnav-track>
          <div class="mobile-nav-sliding-pill" data-mnav-pill></div>
          <button type="button" class="mobile-nav-btn" data-mnav="folders" aria-controls="sidebarPanel" aria-label="${escapeAttr(t('mobile.navFolders'))}" title="${escapeAttr(t('mobile.navFolders'))}">
            ${icon('folder', 20)}
            <span class="sr-only">${escapeHtml(t('mobile.navFolders'))}</span>
            <span class="mobile-nav-badge hidden" data-mnav-badge="folders" aria-hidden="true"></span>
          </button>
          <button type="button" class="mobile-nav-btn" data-mnav="compare" aria-haspopup="dialog" aria-label="${escapeAttr(t('mobile.navCompare'))}" title="${escapeAttr(t('mobile.navCompare'))}">
            ${icon('compare', 20)}
            <span class="sr-only">${escapeHtml(t('mobile.navCompare'))}</span>
            <span class="mobile-nav-badge hidden" data-mnav-badge="compare" aria-hidden="true"></span>
          </button>
          <button type="button" class="mobile-nav-btn" data-mnav="details" aria-controls="inspectorPanel" aria-label="${escapeAttr(t('mobile.navDetails'))}" title="${escapeAttr(t('mobile.navDetails'))}">
            ${icon('info', 20)}
            <span class="sr-only">${escapeHtml(t('mobile.navDetails'))}</span>
          </button>
          <button type="button" class="mobile-nav-btn" data-mnav="connect" aria-haspopup="dialog" aria-label="${escapeAttr(t('mobile.navDrive'))}" title="${escapeAttr(t('mobile.navDrive'))}">
            ${icon('cloud', 20)}
            <span class="sr-only">${escapeHtml(t('mobile.navDrive'))}</span>
          </button>
        </div>
        <button
          type="button"
          class="mobile-nav-btn mobile-nav-search-orb"
          data-mnav="search"
          aria-controls="searchInput"
          aria-label="${escapeAttr(t('mobile.navSearch'))}"
          title="${escapeAttr(t('mobile.navSearch'))}"
        >
          ${icon('search', 20)}
          <span class="sr-only">${escapeHtml(t('mobile.navSearch'))}</span>
        </button>
        <button
          type="button"
          class="mobile-nav-btn mobile-nav-top-orb"
          data-mnav="back-top"
          aria-label="${escapeAttr(t('gallery.backToTop'))}"
          title="${escapeAttr(t('gallery.backToTop'))}"
        >
          ${icon('arrowUp', 20)}
          <span class="sr-only">${escapeHtml(t('gallery.backToTop'))}</span>
        </button>
      </div>
    `;
  }

  const filterBadgeCount =
    (state.quickView !== 'all' ? 1 : 0) +
    (state.minRating > 0 ? 1 : 0) +
    (state.selectedTagIds?.size || 0);
  const selectedCount = state.selectedPhotoIds?.size || 0;
  const compareOpen = isCompareOpen();

  const activeMap = {
    folders: Boolean(state.sidebarOpen),
    compare: compareOpen,
    details: Boolean(state.inspectorOpen),
    connect: state.mode === 'gdrive' && !state.sidebarOpen && !compareOpen && !state.inspectorOpen,
    search: searchOpen || Boolean(state.searchQuery),
  };

  for (const [key, isActive] of Object.entries(activeMap)) {
    const btn = navEl.querySelector(`[data-mnav="${key}"]`);
    if (btn) btn.classList.toggle('is-active', isActive);
  }
  navEl.querySelector('[data-mnav="folders"]')?.setAttribute('aria-expanded', String(state.sidebarOpen));
  navEl.querySelector('[data-mnav="details"]')?.setAttribute('aria-expanded', String(state.inspectorOpen));
  navEl.querySelector('[data-mnav="search"]')?.setAttribute('aria-expanded', String(searchOpen));

  const foldersBadge = navEl.querySelector('[data-mnav-badge="folders"]');
  if (foldersBadge) {
    foldersBadge.textContent = filterBadgeCount > 0 ? String(filterBadgeCount) : '';
    foldersBadge.classList.toggle('hidden', filterBadgeCount <= 0);
  }

  const compareBadge = navEl.querySelector('[data-mnav-badge="compare"]');
  if (compareBadge) {
    compareBadge.textContent = selectedCount > 0 ? String(selectedCount) : '';
    compareBadge.classList.toggle('hidden', selectedCount <= 0);
  }

  requestAnimationFrame(() => syncMobileNavSlidingPill(navEl));
}

export function bindMobileNavEvents(navEl, store) {
  if (!navEl) return;

  if (typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(() => syncMobileNavSlidingPill(navEl)).observe(navEl);
  }
  navEl.addEventListener('transitionend', () => syncMobileNavSlidingPill(navEl));

  navEl.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-mnav]');
    if (!btn) return;
    const action = btn.dataset.mnav;
    const headerEl = document.getElementById('topHeader');
    headerEl.classList.remove('is-hidden-scroll');
    if (action === 'back-top') {
      document.getElementById('galleryScroll')?.scrollTo({ top: 0, behavior: 'smooth' });
      return;
    }
    if (action === 'search') {
      toggleSearch(headerEl, store);
      return;
    }

    moreMenuOpen = false;
    searchOpen = false;
    demoBannerExpanded = false;

    if (action === 'folders') {
      store.setState({
        sidebarOpen: !store.state.sidebarOpen,
        inspectorOpen: false,
      });
    } else if (action === 'compare') {
      store.setState({ sidebarOpen: false, inspectorOpen: false });
      if (isCompareOpen()) {
        closeCompare(store);
      } else {
        openCompare(Array.from(store.state.selectedPhotoIds), store);
      }
    } else if (action === 'details') {
      store.setState({
        inspectorOpen: !store.state.inspectorOpen,
        sidebarOpen: false,
      });
    } else if (action === 'connect') {
      store.setState({ sidebarOpen: false, inspectorOpen: false });
      store.openModal('connect');
    }
  });
}
