import { getDemoPersonas } from '../demo/demoAlbum.js';
import { SUPPORTED_LANGS, t } from '../i18n.js';
import { escapeAttr, escapeHtml, icon } from './icons.js';
import { isCompareOpen, openCompare, closeCompare } from './renderCompare.js';
import { previewGalleryRowHeight } from './renderGallery.js';

const SIDEBAR_ICON_SVG =
  '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="18" height="18" x="3" y="3" rx="2"/><path d="M9 3v18"/></svg>';

const COMPARE_ICON_SVG =
  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="18" height="18" x="3" y="3" rx="2"/><path d="M12 3v18"/></svg>';

const COMPARE_ICON_LG_SVG =
  '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="18" height="18" x="3" y="3" rx="2"/><path d="M12 3v18"/></svg>';

let lastBannerSignature = '';
let lastToastSignature = '';
let isSearchComposing = false;
let mobileSearchOpen = false;

function buildHeaderSkeleton(headerEl, state) {
  const currentLang = state.lang || 'en';
  const langOptions = SUPPORTED_LANGS.map(
    (l) =>
      `<option value="${escapeAttr(l.id)}" ${currentLang === l.id ? 'selected' : ''}>${escapeHtml(l.label)}</option>`
  ).join('');

  headerEl.innerHTML = `
    <div class="header-left">
      <button type="button" class="btn btn-ghost btn-icon hide-xs" data-header="toggle-sidebar" title="${escapeAttr(t('header.toggleSidebar'))}">
        ${SIDEBAR_ICON_SVG}
      </button>
      <div class="brand-badge">
        <span class="brand-logo">${icon('image', 15)}</span>
        <span class="hide-sm">DriveLens</span>
      </div>
      <div class="album-pill" data-header-pill title="">
        <span class="album-pill-dot"></span>
        <span class="album-pill-name"></span>
      </div>
    </div>

    <div class="header-center">
      <div class="search-box">
        <span class="search-icon">${icon('search', 14)}</span>
        <input
          id="searchInput"
          type="text"
          placeholder="${escapeAttr(t('header.searchPlaceholder'))}"
          autocomplete="off"
        />
        <button
          type="button"
          id="searchClearBtn"
          class="search-clear-btn hidden"
          data-header="clear-search"
          title="${escapeAttr(t('header.clearSearch'))}"
          aria-label="${escapeAttr(t('header.clearSearch'))}"
        >${icon('x', 13)}</button>
      </div>
    </div>

    <div class="header-right">
      <div class="segmented" role="group" aria-label="${escapeAttr(t('header.layoutGroup'))}">
        <button type="button" class="seg-btn" data-header="layout" data-layout="justified" title="${escapeAttr(t('header.layoutJustified'))}">
          ${icon('rows', 14)}
        </button>
        <button type="button" class="seg-btn" data-header="layout" data-layout="waterfall" title="${escapeAttr(t('header.layoutWaterfall'))}">
          ${icon('waterfall', 14)}
        </button>
        <button type="button" class="seg-btn" data-header="layout" data-layout="grid" title="${escapeAttr(t('header.layoutGrid'))}">
          ${icon('grid', 14)}
        </button>
      </div>

      <input
        id="rowHeightRange"
        class="range-slider hide-sm"
        type="range"
        min="130"
        max="320"
        step="4"
        value="210"
        title="${escapeAttr(t('header.thumbSize'))}"
        aria-label="${escapeAttr(t('header.thumbSize'))}"
      />

      <button type="button" class="btn btn-sm hide-xs" data-header="compare" title="${escapeAttr(t('header.compareTooltip'))}">
        ${COMPARE_ICON_SVG}
        <span class="hide-sm">${escapeHtml(t('header.compareBtn'))}</span>
      </button>

      <button type="button" class="btn btn-ghost btn-icon" data-header="refresh" title="${escapeAttr(t('header.refresh'))}">
        ${icon('refresh', 15)}
      </button>

      <button type="button" class="btn btn-sm" data-header="export" title="${escapeAttr(t('header.exportTooltip'))}">
        ${icon('share', 14)}
        <span class="hide-sm">${escapeHtml(t('header.exportBtn'))}</span>
      </button>

      <span class="sync-pill hide-sm" data-header-sync></span>

      <button type="button" class="btn btn-sm hidden" data-header="install-app" title="${escapeAttr(t('header.installAppTooltip'))}">
        ${icon('appWindow', 14)}
        <span class="hide-sm">${escapeHtml(t('header.installApp'))}</span>
      </button>

      <button type="button" class="btn btn-sm btn-primary hide-xs" data-header="connect" title="${escapeAttr(t('header.connectTooltip'))}">
        ${icon('cloud', 14)}
        <span data-header-connect-label>${escapeHtml(t('header.connectDrive'))}</span>
      </button>

      <button type="button" class="btn btn-ghost btn-icon hide-xs" data-header="toggle-inspector" title="${escapeAttr(t('header.toggleInspector'))}">
        ${icon('info', 15)}
      </button>

      <select id="langSelect" class="select-sm" data-header-lang aria-label="${escapeAttr(t('header.langLabel'))}" title="${escapeAttr(t('header.langLabel'))}">
        ${langOptions}
      </select>

      <button type="button" class="btn btn-ghost btn-icon" data-header="toggle-theme" title="${escapeAttr(t('header.themeToLight'))}">
        ${icon('sun', 15)}
      </button>

      <button type="button" class="btn btn-ghost btn-icon hide-xs" data-header="shortcuts" title="${escapeAttr(t('header.shortcuts'))}">
        ${icon('keyboard', 15)}
      </button>
    </div>
  `;
}

function updateHeaderElements(headerEl, state) {
  const sidebarBtn = headerEl.querySelector('[data-header="toggle-sidebar"]');
  if (sidebarBtn) {
    const expanded =
      window.innerWidth <= 860 ? Boolean(state.sidebarOpen) : !state.sidebarCollapsed;
    sidebarBtn.setAttribute('aria-expanded', String(expanded));
  }

  const pillEl = headerEl.querySelector('[data-header-pill]');
  const pillNameEl = headerEl.querySelector('.album-pill-name');
  if (pillEl && pillNameEl) {
    const isGdrive = state.mode === 'gdrive';
    const albumName =
      state.rootFolder?.name ||
      (isGdrive ? t('header.albumDrive') : t('header.albumDemo'));
    pillEl.classList.toggle('is-gdrive', isGdrive);
    pillEl.title = isGdrive
      ? t('header.albumDrivePrefix', { name: albumName })
      : t('header.albumDemoPrefix', { name: albumName });
    pillNameEl.textContent = albumName;
  }

  // Preserve #searchInput DOM node, focus, cursor, and IME composition
  const searchInput = headerEl.querySelector('#searchInput');
  if (searchInput) {
    const nextQuery = state.searchQuery || '';
    if (!isSearchComposing && searchInput.value !== nextQuery) {
      const wasFocused = document.activeElement === searchInput;
      const start = searchInput.selectionStart;
      const end = searchInput.selectionEnd;
      searchInput.value = nextQuery;
      if (wasFocused && typeof start === 'number' && typeof end === 'number') {
        const clampedStart = Math.min(start, nextQuery.length);
        const clampedEnd = Math.min(end, nextQuery.length);
        searchInput.setSelectionRange(clampedStart, clampedEnd);
      }
    }
  }

  const searchClearBtn = headerEl.querySelector('#searchClearBtn');
  if (searchClearBtn) {
    searchClearBtn.classList.toggle('hidden', !state.searchQuery);
  }

  const layoutBtns = headerEl.querySelectorAll('[data-header="layout"]');
  for (const btn of layoutBtns) {
    btn.classList.toggle('active', btn.dataset.layout === state.layoutMode);
  }

  const rowRange = headerEl.querySelector('#rowHeightRange');
  if (rowRange) {
    const heightStr = String(state.rowHeight || 210);
    if (rowRange.value !== heightStr) {
      rowRange.value = heightStr;
    }
    rowRange.title = t('header.thumbSizePx', { px: heightStr });
  }

  const compareBtn = headerEl.querySelector('[data-header="compare"]');
  if (compareBtn) {
    const open = isCompareOpen();
    compareBtn.classList.toggle('is-active', open);
    const selCount = state.selectedPhotoIds?.size || 0;
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
    syncEl.className = `sync-pill hide-sm ${status}`;
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
    if (themeBtn.dataset.themeIcon !== currentTheme) {
      themeBtn.dataset.themeIcon = currentTheme;
      themeBtn.innerHTML = icon(currentTheme === 'dark' ? 'sun' : 'moon', 15);
    }
    themeBtn.title =
      currentTheme === 'dark' ? t('header.themeToLight') : t('header.themeToDark');
  }

  headerEl.classList.toggle('mobile-search-open', mobileSearchOpen);
}

function renderDemoBanner(bannerEl, state) {
  if (!bannerEl) return;
  if (state.mode !== 'demo') {
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
      ${icon('users', 15)}
      <span><strong>${escapeHtml(t('banner.infoStrong'))}</strong> ${escapeHtml(t('banner.infoText'))}</span>
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
    updateHeaderElements(headerEl, state);
  }
  renderDemoBanner(bannerEl, state);
  renderToasts(toastEl, state);
}

export function bindHeaderEvents(headerEl, bannerEl, store) {
  if (headerEl) {
    headerEl.addEventListener('compositionstart', (e) => {
      if (e.target.id === 'searchInput') {
        isSearchComposing = true;
      }
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
      const btn = e.target.closest('[data-header]');
      if (!btn) return;
      const action = btn.dataset.header;

      if (action === 'toggle-sidebar') {
        if (window.innerWidth <= 860) {
          const nextOpen = !store.state.sidebarOpen;
          store.setState({
            sidebarOpen: nextOpen,
            sidebarCollapsed: true,
            ...(nextOpen ? { inspectorOpen: false } : {}),
          });
        } else {
          store.setState({
            sidebarCollapsed: !store.state.sidebarCollapsed,
            sidebarOpen: false,
          });
        }
      } else if (action === 'clear-search') {
        const input = headerEl.querySelector('#searchInput');
        if (input) {
          input.value = '';
          input.focus();
        }
        store.setState({ searchQuery: '' });
      } else if (action === 'layout') {
        const layoutMode = btn.dataset.layout;
        if (layoutMode === 'justified' || layoutMode === 'waterfall' || layoutMode === 'grid') {
          store.setLayoutMode(layoutMode);
        }
      } else if (action === 'compare') {
        openCompare(Array.from(store.state.selectedPhotoIds), store);
      } else if (action === 'refresh') {
        store.refreshAlbum();
      } else if (action === 'export') {
        store.openModal('export');
      } else if (action === 'connect') {
        store.openModal('connect');
      } else if (action === 'install-app') {
        store.promptInstallPwa();
      } else if (action === 'toggle-inspector') {
        const nextInspector = !store.state.inspectorOpen;
        store.setState({
          inspectorOpen: nextInspector,
          ...(window.innerWidth <= 1120 && nextInspector ? { sidebarOpen: false } : {}),
        });
      } else if (action === 'toggle-theme') {
        store.toggleTheme();
      } else if (action === 'shortcuts') {
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
        store.openModal('connect');
      }
    });
  }
}

export function renderMobileNav(navEl, store) {
  if (!navEl) return;
  const state = store.state;
  navEl.setAttribute('aria-label', t('mobile.navAria'));

  const filterBadgeCount =
    (state.quickView !== 'all' ? 1 : 0) +
    (state.minRating > 0 ? 1 : 0) +
    (state.selectedTagIds?.size || 0);
  const selectedCount = state.selectedPhotoIds?.size || 0;
  const compareOpen = isCompareOpen();

  navEl.innerHTML = `
    <button type="button" class="mobile-nav-btn ${state.sidebarOpen ? 'is-active' : ''}" data-mnav="folders">
      ${icon('folder', 17)}
      <span>${escapeHtml(t('mobile.navFolders'))}</span>
      ${filterBadgeCount > 0 ? `<span class="mobile-nav-badge">${filterBadgeCount}</span>` : ''}
    </button>
    <button type="button" class="mobile-nav-btn ${mobileSearchOpen || Boolean(state.searchQuery) ? 'is-active' : ''}" data-mnav="search">
      ${icon('search', 17)}
      <span>${escapeHtml(t('mobile.navSearch'))}</span>
    </button>
    <button type="button" class="mobile-nav-btn ${compareOpen ? 'is-active' : ''}" data-mnav="compare">
      ${COMPARE_ICON_LG_SVG}
      <span>${escapeHtml(t('mobile.navCompare'))}</span>
      ${selectedCount > 0 ? `<span class="mobile-nav-badge">${selectedCount}</span>` : ''}
    </button>
    <button type="button" class="mobile-nav-btn ${state.inspectorOpen ? 'is-active' : ''}" data-mnav="details">
      ${icon('info', 17)}
      <span>${escapeHtml(t('mobile.navDetails'))}</span>
    </button>
    <button type="button" class="mobile-nav-btn ${state.mode === 'gdrive' ? 'is-active' : ''}" data-mnav="connect">
      ${icon('cloud', 17)}
      <span>${escapeHtml(t('mobile.navDrive'))}</span>
    </button>
  `;
}

export function bindMobileNavEvents(navEl, store) {
  if (!navEl) return;

  navEl.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-mnav]');
    if (!btn) return;
    const action = btn.dataset.mnav;

    if (action === 'folders') {
      mobileSearchOpen = false;
      const topHeader = document.getElementById('topHeader');
      if (topHeader) topHeader.classList.remove('mobile-search-open');
      const nextOpen = !store.state.sidebarOpen;
      store.setState({
        sidebarOpen: nextOpen,
        sidebarCollapsed: true,
        inspectorOpen: false,
      });
    } else if (action === 'search') {
      mobileSearchOpen = !mobileSearchOpen;
      const topHeader = document.getElementById('topHeader');
      if (topHeader) {
        topHeader.classList.toggle('mobile-search-open', mobileSearchOpen);
      }
      if (mobileSearchOpen && (store.state.sidebarOpen || store.state.inspectorOpen)) {
        store.setState({ sidebarOpen: false, inspectorOpen: false });
      } else {
        renderMobileNav(navEl, store);
      }
      if (mobileSearchOpen) {
        const input = document.getElementById('searchInput');
        if (input) input.focus();
      }
    } else if (action === 'compare') {
      mobileSearchOpen = false;
      const topHeader = document.getElementById('topHeader');
      if (topHeader) topHeader.classList.remove('mobile-search-open');
      if (store.state.sidebarOpen || store.state.inspectorOpen) {
        store.setState({ sidebarOpen: false, inspectorOpen: false });
      }
      if (isCompareOpen()) {
        closeCompare(store);
      } else {
        openCompare(Array.from(store.state.selectedPhotoIds), store);
      }
    } else if (action === 'details') {
      mobileSearchOpen = false;
      const topHeader = document.getElementById('topHeader');
      if (topHeader) topHeader.classList.remove('mobile-search-open');
      store.setState({
        inspectorOpen: !store.state.inspectorOpen,
        sidebarOpen: false,
      });
    } else if (action === 'connect') {
      mobileSearchOpen = false;
      const topHeader = document.getElementById('topHeader');
      if (topHeader) topHeader.classList.remove('mobile-search-open');
      if (store.state.sidebarOpen || store.state.inspectorOpen) {
        store.setState({ sidebarOpen: false, inspectorOpen: false });
      }
      store.openModal('connect');
    }
  });
}
