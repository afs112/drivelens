import { getCachedSession } from './api/gdrive.js';
import { t } from './i18n.js';
import { loadConnectPrefs, Store } from './state/store.js';
import {
  bindCompareEvents,
  closeCompare,
  isCompareOpen,
  openCompare,
  renderCompare,
} from './ui/renderCompare.js';
import {
  bindGalleryEvents,
  renderBatchBar,
  renderGalleryGrid,
  renderGallerySubbar,
  resetGallerySignature,
} from './ui/renderGallery.js';
import {
  bindHeaderEvents,
  bindMobileNavEvents,
  renderHeader,
  renderMobileNav,
} from './ui/renderHeader.js';
import { bindInspectorEvents, renderInspector } from './ui/renderInspector.js';
import { bindLightboxEvents, renderLightbox } from './ui/renderLightbox.js';
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

// Collapse side drawers initially on compact viewports so they don't cover the gallery
if (window.innerWidth <= 860) {
  store.state = {
    ...store.state,
    sidebarCollapsed: true,
    inspectorOpen: false,
  };
} else if (window.innerWidth <= 1120) {
  store.state = {
    ...store.state,
    inspectorOpen: false,
  };
}

function renderAll() {
  const visiblePhotos = store.getVisiblePhotos();
  renderHeader(topHeader, demoBanner, toastContainer, store);
  renderSidebar(sidebarPanel, store);
  renderGallerySubbar(gallerySubbar, store, visiblePhotos);
  renderBatchBar(batchBar, store, visiblePhotos);
  renderGalleryGrid(galleryGrid, galleryScroll, store, visiblePhotos);
  renderInspector(inspectorPanel, store);
  renderLightbox(lightboxRoot, store, visiblePhotos);
  renderCompare(compareRoot, store);
  renderModals(modalRoot, store);
  renderMobileNav(mobileNavBar, store);

  if (drawerBackdrop) {
    const showBackdrop =
      Boolean(store.state.sidebarOpen) ||
      (window.innerWidth <= 1120 && Boolean(store.state.inspectorOpen));
    drawerBackdrop.classList.toggle('visible', showBackdrop);
  }
}

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
    store.setState({
      sidebarOpen: false,
      ...(window.innerWidth <= 1120 ? { inspectorOpen: false } : {}),
    });
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
      resetGallerySignature();
      renderGalleryGrid(galleryGrid, galleryScroll, store, store.getVisiblePhotos());
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
  });

  const cached = clientId ? getCachedSession(clientId) : null;
  if (cached) {
    store.connectGoogleDrive({
      clientId,
      folderInput,
      reuseSession: true,
    });
  } else {
    store.openModal('connect');
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
    if (isEditableTarget(event.target)) {
      return;
    }
    if (isCompareOpen()) {
      event.preventDefault();
      closeCompare(store);
      return;
    }
    if (store.state.lightboxPhotoId) {
      event.preventDefault();
      store.closeLightbox();
      return;
    }
    if (store.state.sidebarOpen) {
      event.preventDefault();
      store.setState({ sidebarOpen: false });
      return;
    }
    if (window.innerWidth <= 1120 && store.state.inspectorOpen) {
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
    store.setState({ inspectorOpen: !store.state.inspectorOpen });
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
      store.closeLightbox();
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
