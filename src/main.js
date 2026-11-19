import { getCachedSession } from './api/gdrive.js';
import { t } from './i18n.js';
import { loadConnectPrefs, Store } from './state/store.js';
import { syncServiceWorkerAuth, updateSmartHdSchedule } from './storage/imageLoader.js';
import { closePhotoContextMenu } from './ui/contextMenu.js';
import {
  bindCompareEvents,
  closeCompare,
  isCompareOpen,
  openCompare,
  renderCompare,
} from './ui/renderCompare.js';
import {
  bindGalleryEvents,
  getCurrentPageSmartTargets,
  relayoutGalleryOnResize,
  renderBatchBar,
  renderGalleryGrid,
  renderGallerySubbar,
  setGalleryScrollSettleCallback,
} from './ui/renderGallery.js';
import {
  bindHeaderEvents,
  bindMobileNavEvents,
  dismissHeaderOverlay,
  renderHeader,
  renderMobileNav,
} from './ui/renderHeader.js';
import { bindInspectorEvents, renderInspector } from './ui/renderInspector.js';
import {
  bindLightboxEvents,
  closeLightboxWithAnimation,
  dismissLightboxPopover,
  renderLightbox,
  toggleLightboxInfo,
} from './ui/renderLightbox.js';
import { bindModalEvents, renderModals } from './ui/renderModals.js';
import { bindSidebarEvents, renderSidebar } from './ui/renderSidebar.js';

const topHeader = document.getElementById('topHeader');
const demoBanner = document.getElementById('demoBanner');
const drawerBackdrop = document.getElementById('drawerBackdrop');
const sidebarPanel = document.getElementById('sidebarPanel');
const gallerySubbar = document.getElementById('gallerySubbar');
const galleryScroll = document.getElementById('galleryScroll');
const batchBar = document.getElementById('batchBar');
const galleryGrid = document.getElementById('galleryGrid');
const inspectorPanel = document.getElementById('inspectorPanel');
const lightboxRoot = document.getElementById('lightboxRoot');
const compareRoot = document.getElementById('compareRoot');
const modalRoot = document.getElementById('modalRoot');
const toastContainer = document.getElementById('toastContainer');
const mobileNavBar = document.getElementById('mobileNavBar');

const store = new Store();

let lastSwAccessToken = null;
let lastSwApiKey = null;
let lastModalRef = null;
let lastSidebarOpen = false;
let lastInspectorOpen = false;

function syncSmartHdPipeline(visiblePhotos = store.getVisiblePhotos()) {
  const state = store.state;
  const albumKey = `${state.mode}:${state.folderId || 'demo'}`;
  if (state.loading) {
    updateSmartHdSchedule({ albumKey, lightboxItems: [], ratedPageItems: [], restPageItems: [] });
    return;
  }

  let lightboxItems = [];
  if (state.lightboxPhotoId) {
    const idx = visiblePhotos.findIndex((p) => p.id === state.lightboxPhotoId);
    if (idx >= 0) {
      lightboxItems = visiblePhotos.slice(idx, idx + 4);
    } else {
      const single = store.getFileById(state.lightboxPhotoId);
      if (single) lightboxItems = [single];
    }
  }

  const { ratedPageItems, restPageItems } = getCurrentPageSmartTargets(
    galleryScroll,
    store,
    visiblePhotos
  );
  updateSmartHdSchedule({
    albumKey,
    lightboxItems,
    ratedPageItems,
    restPageItems,
    getAccessToken: () => store.state.accessToken,
    getApiKey: () => store.state.apiKey,
  });
}

function renderAll() {
  const nextToken = store.state.accessToken || '';
  const nextApiKey = store.state.apiKey || '';
  if (nextToken !== lastSwAccessToken || nextApiKey !== lastSwApiKey) {
    lastSwAccessToken = nextToken;
    lastSwApiKey = nextApiKey;
    syncServiceWorkerAuth({ accessToken: nextToken, apiKey: nextApiKey });
  }

  const curModal = store.state.modal || null;
  const curSidebarOpen = Boolean(store.state.sidebarOpen);
  const curInspectorOpen = Boolean(store.state.inspectorOpen);
  if (
    (curModal && curModal !== lastModalRef) ||
    curSidebarOpen !== lastSidebarOpen ||
    curInspectorOpen !== lastInspectorOpen
  ) {
    closePhotoContextMenu();
  }
  lastModalRef = curModal;
  lastSidebarOpen = curSidebarOpen;
  lastInspectorOpen = curInspectorOpen;

  const visiblePhotos = store.getVisiblePhotos();
  renderHeader(topHeader, demoBanner, toastContainer, store);
  renderSidebar(sidebarPanel, store);
  renderInspector(inspectorPanel, store);
  renderGallerySubbar(gallerySubbar, store, visiblePhotos);
  renderBatchBar(batchBar, store, visiblePhotos);
  renderGalleryGrid(galleryGrid, galleryScroll, store, visiblePhotos);
  renderLightbox(lightboxRoot, store, visiblePhotos);
  renderCompare(compareRoot, store);
  renderModals(modalRoot, store);
  renderMobileNav(mobileNavBar, store);
  syncSmartHdPipeline(visiblePhotos);

  if (drawerBackdrop) {
    const showBackdrop = store.state.sidebarOpen || store.state.inspectorOpen;
    drawerBackdrop.classList.toggle('visible', showBackdrop);
  }
}

setGalleryScrollSettleCallback(() => {
  syncSmartHdPipeline();
});

bindHeaderEvents(topHeader, demoBanner, store);
bindMobileNavEvents(mobileNavBar, store);
bindSidebarEvents(sidebarPanel, store);
bindGalleryEvents(gallerySubbar, batchBar, galleryGrid, store);
bindInspectorEvents(inspectorPanel, store);
bindLightboxEvents(lightboxRoot, store);
bindCompareEvents(compareRoot, store);
bindModalEvents(modalRoot, store);

if (drawerBackdrop) {
  drawerBackdrop.addEventListener('click', () => {
    store.setState({ sidebarOpen: false, inspectorOpen: false });
  });
}

store.subscribe(() => {
  renderAll();
});

renderAll();

if (typeof ResizeObserver !== 'undefined' && galleryScroll) {
  let lastWidth = galleryScroll.clientWidth;
  let rafId = 0;
  const resizeObserver = new ResizeObserver(() => {
    const nextWidth = galleryScroll.clientWidth;
    if (nextWidth === lastWidth) return;
    lastWidth = nextWidth;
    cancelAnimationFrame(rafId);
    rafId = requestAnimationFrame(() => {
      relayoutGalleryOnResize(galleryGrid, galleryScroll, store);
    });
  });
  resizeObserver.observe(galleryScroll);
}

function handleInitialUrlHash() {
  const rawHash = window.location.hash || '';
  const hashBody = rawHash.startsWith('#') ? rawHash.slice(1) : rawHash;
  if (!hashBody) {
    store.restoreSavedSession();
    return;
  }

  const params = new URLSearchParams(hashBody);
  const langParam = (params.get('lang') || '').trim().toLowerCase();
  if (langParam === 'en' || langParam === 'zh') {
    store.setLanguage(langParam);
  }

  const layoutParam = (params.get('layout') || '').trim().toLowerCase();
  if (layoutParam === 'justified' || layoutParam === 'waterfall' || layoutParam === 'grid') {
    store.setLayoutMode(layoutParam);
  }

  const folderInput = (params.get('folder') || '').trim();
  if (!folderInput) {
    store.restoreSavedSession();
    return;
  }

  const prefs = loadConnectPrefs();
  const keyParam = (params.get('key') || '').trim();
  const clientIdParam = (params.get('client_id') || '').trim();
  const renewalUrlParam = (params.get('renewal_url') || '').trim();
  const nickname =
    (params.get('nick') || params.get('nickname') || '').trim() ||
    store.state.nickname ||
    prefs.nickname;

  const authType = keyParam
    ? 'apikey'
    : clientIdParam
      ? 'oauth'
      : store.state.authType || prefs.authType || 'apikey';

  const apiKey = keyParam || store.state.apiKey || prefs.apiKey || '';
  const clientId = clientIdParam || store.state.clientId || prefs.clientId || '';
  const tokenRenewalUrl =
    renewalUrlParam || store.state.tokenRenewalUrl || prefs.tokenRenewalUrl || '';

  if (authType === 'apikey' && apiKey) {
    store.setState({
      folderId: folderInput,
      apiKey,
      authType: 'apikey',
    });
    store.connectWithApiKey({
      apiKey,
      folderInput,
      nickname,
    });
    return;
  }

  store.setState({
    folderId: folderInput,
    clientId,
    apiKey,
    authType,
    tokenRenewalUrl,
  });

  const cached = clientId ? getCachedSession(clientId) : null;
  if (cached) {
    store.connectGoogleDrive({
      clientId,
      folderInput,
      tokenRenewalUrl,
      reuseSession: true,
    });
  } else {
    store.restoreExpiredOAuthCacheOrPrompt({
      clientId,
      folderInput,
      tokenRenewalUrl,
    });
  }
}

handleInitialUrlHash();

if (
  'serviceWorker' in navigator &&
  (window.location.protocol === 'https:' ||
    window.location.hostname === 'localhost' ||
    window.location.hostname === '127.0.0.1')
) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js', { scope: './' }).catch(() => {});
  });
}

window.addEventListener('beforeinstallprompt', (event) => {
  event.preventDefault();
  store.setInstallPrompt(event);
});

window.addEventListener('appinstalled', () => {
  store.onAppInstalled();
});

window.addEventListener('beforeunload', (e) => {
  if (store.hasUnsavedCloudChanges()) {
    e.preventDefault();
    e.returnValue = '';
  }
});

function isEditableTarget(target) {
  if (!target || typeof target !== 'object') return false;
  const tag = target.tagName;
  return (
    tag === 'INPUT' ||
    tag === 'TEXTAREA' ||
    tag === 'SELECT' ||
    Boolean(target.isContentEditable)
  );
}

window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    if (store.state.modal) {
      event.preventDefault();
      store.closeModal();
      return;
    }
    if (event.isComposing) return;
    if (isCompareOpen()) {
      event.preventDefault();
      closeCompare(store);
      return;
    }
    if (store.state.lightboxPhotoId) {
      event.preventDefault();
      if (!dismissLightboxPopover(lightboxRoot)) {
        closeLightboxWithAnimation(lightboxRoot, store);
      }
      return;
    }
    if (dismissHeaderOverlay(topHeader, store)) {
      event.preventDefault();
      return;
    }
    if (isEditableTarget(event.target)) return;
    if (store.state.sidebarOpen) {
      event.preventDefault();
      store.setState({ sidebarOpen: false });
      return;
    }
    if (store.state.inspectorOpen) {
      event.preventDefault();
      store.setState({ inspectorOpen: false });
      return;
    }
    store.clearSelection();
    return;
  }

  if (isEditableTarget(event.target)) {
    return;
  }

  if (store.state.modal) {
    return;
  }

  if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 'a') {
    event.preventDefault();
    store.selectAllVisible();
    return;
  }

  if (event.ctrlKey || event.metaKey || event.altKey) {
    return;
  }

  if (event.key >= '0' && event.key <= '5') {
    event.preventDefault();
    store.setRating(store.getActionTargetPhotoIds(), Number(event.key));
    return;
  }

  const lower = event.key.toLowerCase();

  if (lower === 'f') {
    event.preventDefault();
    store.toggleFavorite(store.getActionTargetPhotoIds());
    return;
  }

  if (lower === 't') {
    event.preventDefault();
    const ids = store.getActionTargetPhotoIds();
    if (ids.length === 0) {
      store.toast(t('main.selectPhotoBeforeTag'), 'info');
    } else {
      store.openModal('quickTag', { photoIds: ids });
    }
    return;
  }

  if (lower === 'c') {
    event.preventDefault();
    if (isCompareOpen()) {
      closeCompare(store);
    } else {
      openCompare(Array.from(store.state.selectedPhotoIds), store);
    }
    return;
  }

  if (lower === 'i') {
    event.preventDefault();
    if (store.state.lightboxPhotoId) {
      toggleLightboxInfo(lightboxRoot);
    } else {
      store.setState({ inspectorOpen: !store.state.inspectorOpen, sidebarOpen: false });
    }
    return;
  }

  if (lower === 'v') {
    event.preventDefault();
    store.cycleLayoutMode();
    return;
  }

  if (event.key === '?') {
    event.preventDefault();
    store.openModal('shortcuts');
    return;
  }

  if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
    if (isCompareOpen()) return;
    event.preventDefault();
    store.stepPhoto(event.key === 'ArrowLeft' ? -1 : 1);
    return;
  }

  if (event.key === 'Enter' || event.key === ' ') {
    if (isCompareOpen()) return;
    if (event.target && event.target.closest('button, a, input, select, textarea')) {
      return;
    }
    event.preventDefault();
    if (store.state.lightboxPhotoId) {
      if (!dismissLightboxPopover(lightboxRoot)) {
        closeLightboxWithAnimation(lightboxRoot, store);
      }
    } else {
      const targetId =
        store.state.focusedPhotoId ||
        Array.from(store.state.selectedPhotoIds)[0] ||
        store.getVisiblePhotos()[0]?.id;
      if (targetId) {
        store.openLightbox(targetId);
      }
    }
  }
});
