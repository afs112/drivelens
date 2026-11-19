# DriveLens · Architecture & Engineering Design

> **Overview**: DriveLens is a zero-build, installable (PWA), pure client-side native ES Modules web application for browsing and collaboratively culling **Google Drive** shared photo albums. It supports **API Key Direct Connect** (with optional local `/api/meta` multiplayer sync via `serve.py`) and **OAuth 2.0 Account Sign-In** (with conflict-free cloud metadata sync inside `.drivelens/`), persistent credential auto-reconnect, and a strict-English-default bilingual (`en` / `zh`) runtime with all Chinese strings isolated solely inside [`src/i18n.js`](src/i18n.js).  
> **Project Independence**: DriveLens draws UX inspiration from [julyx10/lap](https://github.com/julyx10/lap) for its darkroom layout, rapid rating shortcuts, and comparison flow, while remaining a completely independent browser-native architecture built from scratch for Google Drive collaboration.

---

## 1. Zero-Build & Installable PWA Architecture

### 1.1 Native ES Modules + Python Static/Sync Server + Static Hosting

- **Native Browser ES Modules (`<script type="module" src="./src/main.js">`)**: Eliminates Node.js, npm, bundlers, and transpilation steps while maintaining clean modular boundaries across API, storage, state, i18n, demo, and UI layers.
- **Zero-Dependency Python Server ([`serve.py`](serve.py)) & Pure-ASCII Launcher ([`start.bat`](start.bat))**:
  - `NoCacheStaticHandler` overrides Windows MIME registry quirks by explicitly mapping `.js`/`.mjs` to `application/javascript; charset=utf-8`, `.css` to `text/css; charset=utf-8`, `.webmanifest` to `application/manifest+json`, and `.png` to `image/png`, with `Cache-Control: no-cache, no-store, must-revalidate`.
  - `serve.py` parses `--open` (opens `http://localhost:<port>` after socket bind, or attaches to an already-running instance on `EADDRINUSE` / `WinError 10048`) and `--dry-run` (verifies socket binding and prints `READY http://localhost:<actual_port>`).
  - `start.bat` uses 100% pure ASCII with strict CRLF (`\r\n`) line endings (no `chcp`) to avoid `cmd.exe` seek/encoding failures on Windows.
- **Static Host Compatibility**: The static asset tree deploys directly to GitHub Pages (with `.nojekyll`), Cloudflare Pages, or Netlify Drop. Relative `./` asset and PWA scope URLs prevent origin-root collisions on subpath hosts (such as `/drivelens/`). When `/api/meta` is absent on a static host, API Key mode smoothly falls back to `localStorage`, while OAuth mode syncs directly with Google Drive.

### 1.2 Installable PWA & Service Worker (`manifest.webmanifest`, `sw.js`, `icons/`)

- **Web App Manifest ([`manifest.webmanifest`](manifest.webmanifest))**:
  - Declares `"name": "DriveLens · Shared Drive Photo Gallery"`, `"short_name": "DriveLens"`, `"display": "standalone"`, `"display_override": ["window-controls-overlay", "standalone"]`, `"background_color": "#0b0e14"`, and `"theme_color": "#0b0e14"`.
  - Uses relative `"start_url": "./"` and `"scope": "./"` so the PWA installs cleanly at both root origins (`http://localhost:5173/`) and repository subpaths.
  - References three dedicated icons in `icons/`: `./icons/icon-192.png` (`192x192` RGBA PNG), `./icons/icon-512.png` (`512x512` RGBA PNG), and `./icons/icon.svg` (scalable `any maskable` vector icon).
- **Document Shell Meta Tags ([`index.html`](index.html))**:
  - Includes `<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />`, `<meta name="theme-color" content="#0b0e14" />`, `<meta name="apple-mobile-web-app-capable" content="yes" />`, `<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />`, `<meta name="apple-mobile-web-app-title" content="DriveLens" />`, `<link rel="manifest" href="./manifest.webmanifest" />`, and `<link rel="apple-touch-icon" href="./icons/icon-192.png" />`.
- **Service Worker ([`sw.js`](sw.js))**:
  - Maintains `CACHE_NAME = 'drivelens-shell-v12'` and precaches `PRECACHE_ASSETS` (14 local shell paths: `./`, `./index.html`, `./manifest.webmanifest`, all 3 icons, all 4 CSS stylesheets, `src/main.js`, `src/constants.js`, `src/i18n.js`, and `src/storage/albumCache.js`) during `install`, calling `self.skipWaiting()`.
  - Deletes older `drivelens-*` cache buckets during `activate` and calls `self.clients.claim()`.
  - Intercepts only same-origin `GET` requests excluding `/api/` paths (so `serve.py` `/api/meta`, Google Drive API calls, GIS scripts, and `googleusercontent.com` thumbnails always bypass the Service Worker cache). Uses a **Network-First** strategy that refreshes cached `response.type === 'basic'` assets online and falls back to `caches.match()` or `./index.html` (for navigations) when offline.
- **Install Prompt Lifecycle (`src/main.js`, `src/state/store.js`, `src/ui/renderHeader.js`)**:
  - On `window` `load`, `src/main.js` registers `./sw.js` with `{ scope: './' }` when running over `https:`, `localhost`, or `127.0.0.1`.
  - Browser `beforeinstallprompt` events call `event.preventDefault()` and pass the deferred prompt to `store.setInstallPrompt(event)`, exposing the top-header `[data-header="install-app"]` button in `renderHeader.js` (`!state.canInstallPwa` toggles `.hidden`).
  - Clicking **Install App** invokes `store.promptInstallPwa()`, and the browser's `appinstalled` event calls `store.onAppInstalled()` to clear the prompt state and display a toast confirmation.

### 1.3 Dual-Mode Runtime & Startup Auto-Reconnect Data Flow

```text
Browser / Installed PWA Startup (src/main.js)
  ├── Service Worker: register ./sw.js ({ scope: './' }) on https:/localhost/127.0.0.1
  ├── URL Hash Check (#folder=..., #lang=...):
  │     ├── Folder in hash -> connect via API Key (?key=...) or OAuth 2.0 (?client_id=...)
  │     └── No folder in hash -> store.restoreSavedSession()
  │           ├── Remember + autoConnect (API Key) -> silent connectWithApiKey()
  │           ├── Remember + autoConnect (OAuth)
  │           │     ├── Unexpired token in drivelens_session_v1 -> silent connectGoogleDrive({ reuseSession: true })
  │           │     ├── Expired token + tokenRenewalUrl -> hydrate cache + silent POST /refresh (0 popups)
  │           │     └── Expired token (Solution A) -> hydrate cache + 1-click 0.5s prompt:'' reconnect / API-Key read fallback
  │           └── Otherwise -> stay in Offline Demo Album (src/demo/demoAlbum.js)
  ├── Mode 1 — API Key Direct Connect (Zero-OAuth):
  │     ├── Auth: Drive API Key (?key=AIzaSy...) + link-shared Drive folder + local nickname
  │     ├── Media: Drive API v3 -> thumbnailLink / drive.google.com/thumbnail / lh3 / alt=media + IndexedDB
  │     └── Sync: serve.py GET/POST /api/meta (.local-meta/<folder>.json) -> fallback localStorage
  ├── Mode 2 — OAuth 2.0 Account Sign-In (Dual-Mode Session Lifecycle):
  │     ├── Auth (Solution A): GIS initTokenClient -> drivelens_session_v1 + drivelens_oauth_user_v1 + 1-click prompt:'' reconnect
  │     ├── Auth (Solution B): GIS initCodeClient -> Worker /exchange -> AES-256-GCM drivelens_oauth_renewal_v1 -> silent /refresh
  │     ├── Media: Drive API v3 (Bearer Token, private/Shared Drives, authorized video stream; API-Key read fallback if configured)
  │     └── Sync: Google Drive .drivelens/ (tags-schema.json + member-<key>.json) -> read-only localStorage
  └── Offline Demo Layer (src/demo/demoAlbum.js):
        └── Pure i18n.js-driven EN/ZH SVG dataset (5 folders, 16 media, 3 personas) + localStorage (drivelens_demo_state_v1)
```

---

## 2. Directory Map & Module Dependency Graph

### 2.1 Directory Structure

```text
drivelens/
├── index.html                   # Single-page shell (<html lang="en">, viewport-fit=cover), PWA meta links, 14 mount IDs
├── manifest.webmanifest         # Web App Manifest (relative ./ scope, standalone display, icon references)
├── sw.js                        # Service Worker (drivelens-shell-v12 precache, Network-First same-origin shell cache)
├── workers/
│   └── oauth-renewal-worker.js  # Optional Cloudflare Worker (/health, /exchange, /refresh) with AES-256-GCM ticket sealing
├── icons/
│   ├── icon.svg                 # Scalable vector app icon (any maskable)
│   ├── icon-192.png             # 192x192 RGBA PNG app icon & apple-touch-icon
│   └── icon-512.png             # 512x512 RGBA PNG splash/install icon
├── serve.py                     # Python 3 stdlib static server (incl. .webmanifest/.png) + /api/meta sync + --open/--dry-run
├── start.bat                    # Pure ASCII + CRLF Windows launcher invoking serve.py 5173 --open
├── .gitignore                   # Ignores __pycache__/, .local-meta/, config.js, .env*, *credentials*, *secret*, keys
├── .nojekyll                    # Disables Jekyll processing on GitHub Pages
├── .local-meta/                 # Runtime-only directory created by serve.py for API Key /api/meta JSON files
├── README.md                    # English user, PWA install, mobile touch, credential, and deployment guide (0 CJK)
├── ARCHITECTURE.md              # System architecture documentation (this file, 0 CJK chars)
├── verify_project.py            # Stdlib verification suite ([a]–[j]: HTTP, ES modules, DOM, PWA, Mobile UX, i18n)
├── styles/
│   ├── tokens.css               # Dark/light theme variables, safe-area inset tokens, touch-action manipulation
│   ├── layout.css               # Header, workspace, mobile nav bar, drawer headers/backdrop, mobile breakpoints
│   ├── components.css           # Cards, touch select targets, 16px mobile inputs, mobile Lightbox, bottom-sheet modals
│   └── compare.css              # Fullscreen 2–4 photo compare overlay, touch-action: none, stacked/2x2 phone grid
└── src/
    ├── main.js                  # Entry point, SW registration, beforeinstallprompt, mobile nav/drawer, shortcuts
    ├── constants.js             # Empty runtime defaults (DEFAULT_API_KEY/CLIENT_ID/FOLDER_ID), concurrency/debounce
    ├── i18n.js                  # Bilingual EN/ZH dictionary (444 mirrored keys); sole repository home for CJK strings
    ├── api/
    │   ├── gdrive.js            # GIS OAuth + hint/remember persistence, API Key & OAuth BFS crawlers, original download
    │   └── metaSync.js          # Cloud .drivelens/ LWW+isolated member sync & non-throwing ./api/meta helpers
    ├── storage/
    │   ├── albumCache.js        # IndexedDB + localStorage SWR cache (up to 12 albums; zero credentials stored)
    │   └── imageLoader.js       # 6-concurrency queue, IntersectionObserver, thumbnail fallback & 400-blob IDB cache
    ├── state/
    │   └── store.js             # Pub/sub Store, SWR cache hydration/revalidation, UI prefs, language, sync
    ├── demo/
    │   └── demoAlbum.js         # Zero-CJK bilingual demo builder reading MESSAGES[code] from src/i18n.js
    └── ui/
        ├── icons.js             # Inline SVG icons (incl. waterfall, globe & appWindow) & XSS escaping helpers
        ├── renderHeader.js      # Header skeleton, 3-view switcher, #langSelect, #mobileNavBar tabs, search popover
        ├── renderSidebar.js     # Mobile drawer header, gallery views switcher, folders, filters, tags
        ├── renderGallery.js     # Justified/Waterfall (computeWaterfallColumns)/Grid, subbar, batch bar, touch UX
        ├── renderInspector.js   # Mobile drawer header across all states, preview reuse, note guard, localized EXIF
        ├── renderLightbox.js    # Fullscreen lightbox (2048px / video stream / iframe), touch pinch/pan/swipe, filmstrip
        ├── renderCompare.js     # 2–4 pane compare with mouse + touch pinch/double-tap/synced drag-pan & inline HUD
        └── renderModals.js      # 2-tab Connect (remember checkbox, saved account hint, forget btn), Tag, Export, Help
```

### 2.2 Module Dependency Graph

```mermaid
flowchart TD
    HTML["index.html + manifest.webmanifest"] --> MAIN["src/main.js + sw.js"]
    MAIN --> I18N["src/i18n.js"]
    MAIN --> STORE["src/state/store.js (Store)"]
    MAIN --> UI_HDR["src/ui/renderHeader.js"]
    MAIN --> UI_SB["src/ui/renderSidebar.js"]
    MAIN --> UI_GAL["src/ui/renderGallery.js"]
    MAIN --> UI_INSP["src/ui/renderInspector.js"]
    MAIN --> UI_LB["src/ui/renderLightbox.js"]
    MAIN --> UI_CMP["src/ui/renderCompare.js"]
    MAIN --> UI_MOD["src/ui/renderModals.js"]
    MAIN --> API_GD["src/api/gdrive.js"]

    STORE --> CFG["src/constants.js (APP_CONFIG)"]
    STORE --> I18N
    STORE --> DEMO["src/demo/demoAlbum.js"]
    STORE --> API_GD
    STORE --> API_SYNC["src/api/metaSync.js"]
    STORE --> ACACHE["src/storage/albumCache.js"]
    STORE --> IMG["src/storage/imageLoader.js"]

    DEMO --> I18N
    API_GD --> I18N
    API_SYNC --> I18N
    IMG --> CFG

    UI_GAL --> IMG
    UI_INSP --> IMG
    UI_INSP --> API_GD
    UI_LB --> IMG
    UI_LB --> API_GD
    UI_CMP --> IMG

    UI_HDR --> ICONS["src/ui/icons.js"]
    UI_HDR --> UI_CMP
    UI_HDR --> UI_GAL
    UI_HDR --> DEMO
    UI_HDR --> I18N
    UI_SB --> ICONS
    UI_SB --> I18N
    UI_GAL --> ICONS
    UI_GAL --> I18N
    UI_INSP --> ICONS
    UI_INSP --> I18N
    UI_LB --> ICONS
    UI_LB --> I18N
    UI_CMP --> ICONS
    UI_CMP --> I18N
    UI_MOD --> ICONS
    UI_MOD --> CFG
    UI_MOD --> STORE
    UI_MOD --> I18N
```

### 2.3 Module Exports Summary

| Module | Key Exports | Responsibility |
| --- | --- | --- |
| `src/constants.js` | `APP_CONFIG` | Empty credential placeholders, `THUMBNAIL_CONCURRENCY` (`12`), `DRIVE_LIST_PAGE_SIZE` (`1000`), `DRIVE_MAX_RETRIES` (`4`), `DRIVE_MAX_BACKOFF_MS` (`32000`), `SYNC_DEBOUNCE_MS` (`800`) |
| `src/i18n.js` | `SUPPORTED_LANGS`, `MESSAGES`, `getLang`, `setLangCode`, `getLocaleTag`, `t` | Strict `'en'`-default localization runtime, 444-key EN/ZH parity, `{param}` interpolation, sole CJK string store |
| `serve.py` | `create_server`, `NoCacheStaticHandler`, `ReusableThreadingHTTPServer` | Static serving with strict MIME types (`.js`/`.mjs`, `.css`, `.webmanifest`, `.png`), `--open`/`--dry-run`, thread-safe `GET/POST /api/meta` |
| `sw.js` | `CACHE_NAME`, `PRECACHE_ASSETS` (worker scope) | Precaches 14 core shell files (`drivelens-shell-v12`), Network-First same-origin cache, excludes cross-origin & `/api/` |
| `workers/oauth-renewal-worker.js` | `default` (`fetch` handler) | Optional zero-secret Cloudflare Worker (`/health`, `/exchange`, `/refresh`) exchanging GIS auth codes and sealing refresh tokens with `AES-256-GCM` (`TICKET_ENC_KEY`) |
| `src/api/gdrive.js` | `parseDriveFolderId`, `ensureGoogleIdentityLoaded`, `getCachedSession`, `getSavedOAuthUser`, `clearSession`, `normalizeRenewalEndpoint`, `hasStoredRenewalTicket`, `renewOAuthSessionSilently`, `authenticateGoogle`, `fetchWithDriveBackoff`, `fetchFreshThumbnailLink`, `fetchBatchThumbnailLinks`, `buildDriveWebViewLink`, `loadSharedAlbum`, `loadSharedAlbumWithApiKey`, `syncAlbumIncremental`, `downloadOriginalFile` | Truncated exponential backoff (`2^n + jitter`), grouped `25`-folder BFS crawler with binary-split fallback, OAuth `changes.list` & API Key watermark incremental sync, `parents+name` batch thumbnail repair, Dual-Mode GIS OAuth (`initTokenClient` + `prompt: ''` fallback & `initCodeClient` + Worker `/exchange`/`/refresh`), and file download |
| `src/api/metaSync.js` | `META_FOLDER_NAME`, `TAGS_SCHEMA_FILENAME`, `sanitizeMemberKey`, `ensureMetaFolder`, `mergeTagSchemas`, `loadAlbumMetadata`, `saveMemberMetadata`, `saveTagSchema`, `loadLocalServerMeta`, `saveLocalServerMeta` | Compact JSON `.drivelens/` cloud persistence, LWW tag schema merge, non-throwing `./api/meta` client |
| `src/storage/albumCache.js` | `buildAlbumCacheKey`, `getCachedAlbum`, `setCachedAlbum`, `saveCachedAlbumMetaOnly`, `applyCachedAlbumDelta`, `patchCachedThumbnailLinks`, `removeCachedAlbum`, `clearAllAlbumCaches` | Split IndexedDB (`albumMeta` + 2,000-file `fileChunks`) with O(1) chunk index, <2ms meta-only writes, delta chunk patching, and `localStorage` fallback (`<=2000` files; excludes secrets) |
| `src/storage/imageLoader.js` | `quantizeThumbSize`, `buildDriveThumbUrl`, `isPreviewQueueIdle`, `hasCachedHdSrc`, `isPhotoHdCached`, `loadHdPhoto`, `subscribeHdStatus`, `getSmartHdDebugState`, `updateSmartHdSchedule`, `getInstantCachedSrc`, `preloadPhoto`, `loadPhotoIntoElement`, `cancelElementPhotoLoad`, `setThumbnailLinkHealedCallback`, `fetchAuthorizedMediaBlobUrl`, `clearImageCache` | Virtualizer-aware priority queue (zero `getBoundingClientRect` reflow), coalesced 80ms `parents+name` thumbnail self-healing, grid-safe no-`alt=media` fallback, Lightbox `current + 3` & page Smart HD scheduler, bounded LRU blob cache |
| `src/state/store.js` | `Store`, `getTagColors`, `TAG_COLORS`, `loadConnectPrefs`, `resolvePhotoTimestamp` | O(1) `_fileById` + sparse `_itemsByPhotoId` + `EMPTY_META` metadata engine, cached `Intl.Collator`, `visiblePhotosVersion`/`lastChange` fast-paths, split IDB + incremental sync hydration |
| `src/demo/demoAlbum.js` | `DEMO_STORAGE_KEY`, `DEMO_PERSONAS`, `DEFAULT_TAG_SCHEMA`, `getDemoPersonas`, `localizeDemoState`, `createDemoDataset`, `saveDemoState`, `resetDemoState` | Zero-CJK offline demo album builder (`5` folders, `16` items, `3` personas, `8` default tags) reading `MESSAGES[code]` |
| `src/ui/renderHeader.js` | `dismissHeaderOverlay`, `renderHeader`, `bindHeaderEvents`, `syncMobileNavSlidingPill`, `renderMobileNav`, `bindMobileNavEvents` | Floating Liquid Glass top islands, incremental Refresh (`Shift+Click` full rescan), icon-only sliding layout pills, `#headerMorePopover`, `#langSelect`, `[data-header="install-app"]`, Split Liquid Glass `#mobileNavBar` |
| `src/ui/renderSidebar.js` | `renderSidebar`, `bindSidebarEvents` | Floating Liquid Glass sheet, signature-guarded render, O(K) `getLibraryStats()`/`getTagCounts()`, O(N + F) folder counts, sliders, folders, filters, tags |
| `src/ui/renderGallery.js` | `computeJustifiedRows`, `computeWaterfallColumns`, `getCurrentPageSmartTargets`, `setGalleryScrollSettleCallback`, `renderGallerySubbar`, `renderBatchBar`, `renderGalleryGrid`, `previewGalleryRowHeight`, `relayoutGalleryOnResize`, `bindGalleryEvents` | 2D TypedArray virtualized Justified/Waterfall/Grid engine, `<=180`-node card recycler, `12M px` height scale guard, zero-drift scroll-anchor lock, touch UX |
| `src/ui/renderInspector.js` | `renderInspector`, `bindInspectorEvents` | Floating Liquid Glass sheet, signature-guarded render, drawer header across all states, preview reuse, note focus guard, localized EXIF |
| `src/ui/renderLightbox.js` | `renderLightbox`, `dismissLightboxPopover`, `toggleLightboxInfo`, `bindLightboxEvents` | FLIP hero zoom-in/out, default `chrome-hidden` clean view + single-tap HUD toggle, 3-slide preloaded `.lightbox-track`, `2048px` + `preloadPhoto`, touch/mouse swipe & pull-down dismiss |
| `src/ui/renderCompare.js` | `openCompare`, `closeCompare`, `isCompareOpen`, `renderCompare`, `bindCompareEvents` | 2–4 pane side-by-side view with mouse + touch pinch/double-tap/synced drag-pan & inline HUD patching |
| `src/ui/renderModals.js` | `renderModals`, `bindModalEvents` | 2-tab Connect (`#rememberApiKeyCheck`, `#rememberOAuthCheck`, saved OAuth account badge, `[data-action="forget-creds"]`), Tag, Export, Shortcuts modals |
| `src/ui/icons.js` | `icon`, `escapeHtml`, `escapeAttr` | Inline SVG icon registry (`globe`, `appWindow`, etc.) & XSS-safe HTML/attribute escaping |

---

## 3. Pure-`src/i18n.js` Internationalization Architecture

### 3.1 Strict Default-English Runtime & Single-File CJK Isolation (`src/i18n.js`)

- **Supported Languages**: `SUPPORTED_LANGS` registers `'en'` (`'English'`) and `'zh'` (localized Chinese endonym defined inside [`src/i18n.js`](src/i18n.js)).
- **Single-File CJK Isolation**: All Chinese strings in the entire repository—including UI labels, error messages, demo persona names/emails, demo folder names, SVG media filenames/labels, default tag definitions/groups, and initial demo collaborator notes—reside exclusively inside `MESSAGES.zh` in [`src/i18n.js`](src/i18n.js). All HTML, CSS, batch, Markdown, and remaining JS files contain **zero** CJK characters (`[\u3400-\u9fff\u3000-\u303f\uff00-\uffef]`).
- **Strict `'en'` Default**: `getLang()` reads `localStorage.getItem('drivelens_lang_v1')` and returns `'zh'` **only** when that exact key equals `'zh'`. It deliberately **never inspects `navigator.language`**, guaranteeing deterministic English startup on any OS locale unless explicitly toggled by the user or URL hash `#lang=zh`.
- **DOM & Document Sync**: `setLangCode(lang)` normalizes input (`'zh'` or `'en'`), persists to `drivelens_lang_v1`, updates `document.documentElement.lang` (`'zh-CN'` vs `'en'`), and updates `document.title = t('app.title')`.
- **Locale-Aware Formatting**: `getLocaleTag()` returns `'zh-CN'` or `'en-US'`, consumed by `Store.getActiveTagList()`, `Store.getVisiblePhotos()` (`nameAsc` sorting), `renderSidebar.js` folder sorting, and `renderInspector.js` `formatDate()`.
- **Translation Helper**: `t(key, params = {})` resolves `MESSAGES[currentLang]?.[key] ?? MESSAGES.en[key] ?? key` and substitutes `{param}` placeholders across all 444 mirrored keys in `MESSAGES.en` and `MESSAGES.zh`.

### 3.2 Language Switching & Non-Destructive Demo Localization

Calling `store.setLanguage(nextLang)` (via the header `#langSelect` dropdown or `#lang=en|zh` hash in `src/main.js`):

1. Updates `state.lang` via `setLangCode()` and switches uncustomized default nicknames (`store.defaultNickname` / `store.guestNickname`) between the previous and target locales.
2. Re-resolves `state.syncMessage` from `state.syncMessageKey` so header sync tooltips localize immediately.
3. In demo mode, invokes `localizeDemoState(state, lang)` (`src/demo/demoAlbum.js`), which resolves `MESSAGES[code]` entries (`demo.folder.*`, `demo.file.*`, `demo.persona.*`, `demo.tag.*`, `demo.note.*`) to update unedited folder names, photo filenames/SVG labels, persona names (`Me (Alex)`, `Lin`, `Jay` in `en`, and their localized `zh` equivalents), built-in tag names/groups, and initial collaborator notes—while **preserving any custom tags, renamed tags, or edited notes** created by the user.
4. Invalidates language-dependent UI signatures (`headerEl.dataset.lang`, `demo|<lang>|...` in `renderHeader.js`; `${lang}|...` in `renderGallery.js` and `renderCompare.js`; `activeLightboxLang` in `renderLightbox.js`) so open overlays and cards re-render into the new language immediately without breaking same-language fast paths.

---

## 4. Google Drive Integration, Persistent Sessions & Pitfall Mitigations

### 4.1 Mode 1: API Key Direct Connect (`loadSharedAlbumWithApiKey`)

- Appends `&key=${encodeURIComponent(apiKey)}` to Drive API v3 calls without loading GIS or requesting OAuth tokens, completely bypassing the 100-user OAuth Testing Mode allowlist when folders are set to "Anyone with the link can view".
- Assigns deterministic virtual collaborator identities (`nick_${sanitizeMemberKey(cleanNick)}`).
- `driveJsonFetch` maps HTTP `400` (`API_KEY_INVALID`/`keyInvalid`), `403` (`accessNotConfigured`/`SERVICE_DISABLED` vs link-sharing permission), and `404` into actionable localized errors via `t('gdrive.*')`.
- Video playback in Lightbox uses `<iframe class="lightbox-video" src="https://drive.google.com/file/d/<id>/preview">` when `authType === 'apikey' && !accessToken`, avoiding unauthenticated CORS media stream blocks.
- Original file downloads (`downloadOriginalFile`) try `?alt=media&supportsAllDrives=true&key=...` and fall back to opening `webContentLink` or `https://drive.google.com/uc?export=download&id=<id>`.

### 4.2 Mode 2: Dual-Mode OAuth 2.0 Session Lifecycle (`Solution A` vs `Solution B`)

Because pure-frontend Google Identity Services (GIS) `initTokenClient` issues 60-minute `access_token` values without a `refresh_token` (Google requires a confidential server-side `client_secret` for refresh tokens), DriveLens implements a **Dual-Mode OAuth Session Lifecycle** in [`src/api/gdrive.js`](src/api/gdrive.js), [`src/state/store.js`](src/state/store.js), and optional [`workers/oauth-renewal-worker.js`](workers/oauth-renewal-worker.js):

- **Dynamic GIS Loader & Allowlist**: Dynamically injects `https://accounts.google.com/gsi/client` (`ensureGoogleIdentityLoaded`, 10s timeout) only when OAuth sign-in is triggered, requesting `drive`, `userinfo.profile`, and `userinfo.email` scopes.
- **Persistent vs Ephemeral Session Storage (`remember` flag)**:
  - When `remember !== false` (default), `authenticateGoogle` stores `{ clientId, accessToken, expiresAt, user }` in `localStorage` under `drivelens_session_v1` (removing any stale copy in `sessionStorage`) and persists the user hint profile (`{ clientId, id, email, name, picture, color }`) in `localStorage` under `drivelens_oauth_user_v1`.
  - When `remember === false`, `authenticateGoogle` calls `clearSession({ forgetUser: true, clearRenewal: true })`, wipes saved credentials in `drivelens_connect_prefs_v1`, and stores the active session strictly inside ephemeral `sessionStorage` (`drivelens_session_v1`).
  - `getCachedSession(clientId)` checks `localStorage` first and `sessionStorage` second, accepting sessions with more than 60 seconds left (`expiresAt > Date.now() + 60 * 1000`).
- **Solution A — Pure Static Page (Default when `tokenRenewalUrl` is empty)**:
  - Uses `window.google.accounts.oauth2.initTokenClient` with `hint: hintVal` (`loginHint || getSavedOAuthUser(trimmedClientId)?.email`).
  - **Proactive Expiry Without Kicking the User Out**: `Store._scheduleSessionLifecycle(expiresAt)` sets a timer 5 minutes prior to expiry (`_sessionExpiresAt - 5 * 60 * 1000`) and also checks on `visibilitychange`. Once within 30s of expiry (`!tokenRenewalUrl`), `Store` clears `accessToken` cleanly BEFORE API calls fail with `401`, preserving the loaded gallery, photos, and any buffered local ratings/tags (`syncStatus: 'error'` if unsynced edits exist, `'readonly'` otherwise) and updating the header sync pill to **Reconnect (`!`)**.
  - **1-Click `0.5s` Flash Reconnect (`retryOrSyncNow`)**: Clicking `[data-header="sync-now"]` directly invokes `authenticateGoogle(clientId, { prompt: '', loginHint, remember, tokenRenewalUrl })` inside the user's click gesture—bypassing the Connect modal and account picker so Google's popup auto-closes in `~0.5s`, restores `accessToken`, flushes `_unsyncedPhotoIds` and `_unsyncedSchemaDirty`, and refreshes the album. If Google returns `interaction_required` / `consent_required` / `login_required` / `account_selection_required` on `prompt: ''`, `authenticateGoogle` automatically falls back once to `prompt: 'select_account'`.
  - **Hybrid API-Key Read Fallback**: If `state.apiKey` is also saved alongside OAuth (`saveConnectPrefs` preserves `apiKey` unless explicitly cleared), read-only `syncAlbumIncremental` (watermark path) and thumbnail healing in `imageLoader.js` fall back to `state.apiKey` while `accessToken` is expired, so photo browsing and incremental new-photo discovery never expire.
- **Solution B — Silent Background Auto-Renewal (`tokenRenewalUrl` configured + Cloudflare Worker)**:
  - `normalizeRenewalEndpoint(rawUrl)` accepts `https://...` (or `http://localhost` / `http://127.0.0.1`), stripping trailing slashes and `/exchange` or `/refresh` suffixes.
  - **Code Exchange (`initCodeClient` -> `POST /exchange`)**: When `cleanRenewalUrl` is non-empty, `authenticateGoogle` invokes `window.google.accounts.oauth2.initCodeClient({ client_id, scope, ux_mode: 'popup', select_account, hint })` (with mock fallback to `initTokenClient` if `initCodeClient` is absent) and posts `{ code, client_id }` to `${cleanRenewalUrl}/exchange`.
  - **AES-256-GCM Encrypted Refresh Tickets (`workers/oauth-renewal-worker.js`)**: The standalone Cloudflare Worker holds `env.GOOGLE_CLIENT_SECRET`, enforces `env.ALLOWED_ORIGINS` (403 on unlisted `Origin`) and optional `env.ALLOWED_CLIENT_IDS`, exchanges the code with `https://oauth2.googleapis.com/token` (`redirect_uri: 'postmessage'`), and seals `refresh_token` with `AES-256-GCM` (`env.TICKET_ENC_KEY`, SHA-256 derived 256-bit key + 12-byte random IV -> `'enc:v1:' + base64url(iv + ciphertext)`) so the raw Google `refresh_token` never leaves the Worker.
  - **Browser Ticket Storage & Silent `POST /refresh`**: The client stores `{ clientId, renewalUrl, refreshTicket, updatedAt }` in `drivelens_oauth_renewal_v1`. Before expiry (`~55 min` timer), on `visibilitychange`, or on startup when `getCachedSession` is expired, `renewOAuthSessionSilently` (deduplicated via `inFlightRenewalPromise`) posts `{ client_id, refresh_ticket }` to `${cleanUrl}/refresh`, updates `drivelens_session_v1` and any rotated `refreshTicket`, and keeps transient network/`5xx` failures non-destructive while clearing `drivelens_oauth_renewal_v1` only on `400`/`401`/`403` (`invalid_grant` / revoked).

### 4.3 Startup Auto-Reconnect & Credential Reset Lifecycle

- **Startup Dispatch (`handleInitialUrlHash` in `src/main.js`)**: When the URL hash has no `#folder=...` parameter (including clean launches or `#lang=zh` language-only hashes), `main.js` invokes `store.restoreSavedSession()`. Optional `#renewal_url=...` in hash links forwards `tokenRenewalUrl` to `store.connectGoogleDrive(...)`.
- **`store.restoreSavedSession()` (`src/state/store.js`)**: Reads `loadConnectPrefs()` from `drivelens_connect_prefs_v1` (including `tokenRenewalUrl` and preserved `apiKey`). If `rememberCredentials && autoConnect && folderId` are true:
  - **API Key mode (`authType === 'apikey' && apiKey`)**: Silently invokes `connectWithApiKey(...)`.
  - **OAuth mode (`authType === 'oauth' && clientId`)**:
    - If `getCachedSession(clientId)` returns a valid unexpired token, silently calls `connectGoogleDrive({ ..., reuseSession: true })` and arms `_scheduleSessionLifecycle(session.expiresAt)`.
    - If the 1-hour OAuth token has expired and `prefs.tokenRenewalUrl` is set, hydrates the cached album immediately (`<50ms`), calls `renewOAuthSessionSilently(prefs.clientId, prefs.tokenRenewalUrl, { remember: true })` with zero popups, and runs silent incremental sync (`_performIncrementalSync`).
    - If no `tokenRenewalUrl` is set (Solution A) or silent renewal returns `null`, `restoreExpiredOAuthCacheOrPrompt` keeps the cached album open (with API-Key read fallback if available) or prompts for 1-click reconnect.
- **Pausing Auto-Reconnect**: Switching back via `loadDemoMode(true, true)` (**Back to Demo**) or `disconnectGoogleDrive()` clears the active token and writes `autoConnect: false` to `drivelens_connect_prefs_v1` so refreshing stays in Demo Mode until the user reconnects.
- **Wiping Saved Credentials (`forgetSavedCredentials`)**: Triggered by clicking `[data-action="forget-creds"]` in `renderModals.js`. Calls `clearSession({ forgetUser: true, clearRenewal: true })`, removes `drivelens_connect_prefs_v1`, `drivelens_recent_v1`, and `drivelens_oauth_renewal_v1`, resets `tokenRenewalUrl: ''` and in-memory credentials/recent albums/saved OAuth profile, returns to Demo Mode if currently connected, and displays `store.credsClearedToast`.

### 4.4 Grouped BFS Crawler & Incremental Sync (`crawlAlbumTree`, `syncAlbumIncremental`)

- **Grouped Multi-Folder Crawl**: Batches up to `25` BFS frontier folder IDs into a single `files.list` query (`('${id1}' in parents or ...) and trashed = false and (mimeType = 'application/vnd.google-apps.folder' or mimeType contains 'image/' or mimeType contains 'video/')`, `pageSize=1000`, `supportsAllDrives=true`, `includeItemsFromAllDrives=true`) with automatic recursive binary-split fallback on query-complexity 400/403 errors and truncated exponential backoff (`min((2^n)*1000 + random_ms, 32000)`).
- **Page-Level Streaming**: Emits the first page immediately via `onBatch` with adaptive throttling (`900ms` under 5k files, `2500ms` or `+25%` growth above 5k) without O(N^2) array cloning, while trimming requested `fields` (`DRIVE_FILE_FIELDS`) and synthesizing `webViewLink` / `uc?export=download` URLs client-side.
- **Incremental Sync (`syncAlbumIncremental`)**:
  - **OAuth `changes.list` Path**: Captures `startPageToken` (`changes/startPageToken`) on initial crawl and paginates `GET /drive/v3/changes` (`includeRemoved=true`, capped at `15` pages) to apply folder moves/creations, file upserts, and removals/trash without full tree recrawls.
  - **API Key Watermark + Periodic ID Reconcile**: Discovers folder tree changes, queries `(modifiedTime > W or createdTime > W)` (5-minute safety overlap `W` to catch preserved desktop mtimes), and runs a lightweight `fields=files(id,parents)` ID-only reconcile sweep every 24h (or on fallback) to detect deletions.
  - **Refresh UX**: Clicking Refresh runs background `syncAlbumIncremental` without clearing the gallery (`toast.syncUpdated` / `toast.syncUpToDate`); `Shift+Click` forces a full album rescan.

### 4.5 Coalesced Viewport Thumbnail Self-Healing & Bounded Image Queue (`src/storage/imageLoader.js`)

1. **Zero-Reflow Priority Queue**: `ImageLoadQueue` caps concurrency at `APP_CONFIG.THUMBNAIL_CONCURRENCY` (`12`) and uses virtualizer-provided numeric `priorityScore` (avoiding `getBoundingClientRect()` layout thrashing during 60fps scrolling).
2. **Virtualizer-Managed Loading & Cancellation**: Gallery cards pass `virtualManaged: true` with a `35ms` dwell timer (skipping `IntersectionObserver` overhead), and off-screen recycling invokes `cancelElementPhotoLoad(imgEl)` to abort pending loads immediately.
3. **Coalesced `parents+name` Thumbnail Self-Healing (`ThumbnailRepairBatcher`)**: Treats `drive-storage` links older than `THUMB_LINK_TTL_MS` (`2.5h`) as known-expired, batches up to `25` visible missing/expired items over an `80ms` coalesce window into a single `fetchBatchThumbnailLinks` (`files.list` by `parents + name`), mutates `thumbnailLink` / `thumbFetchedAt`, and flushes patches via `setThumbnailLinkHealedCallback` to `patchCachedThumbnailLinks` in IndexedDB.
4. **Grid-Safe Fallback (Zero Grid `alt=media`)**: Grid cards use `allowMediaFallback: false` (marking failed offline tiles `.is-thumb-error` rather than downloading 20 MB originals); only `loadHdPhoto` enables `alt=media` streaming into the 400-blob `drivelens-img-cache` and bounded `90`-entry `objectUrlCache` / `2,500`-entry `bestLoadedByItem` LRU caches.

---

## 5. Conflict-Free Multiplayer Metadata Schema & Storage Keys

### 5.1 OAuth Cloud Sync (`.drivelens/` on Google Drive)

- **`.drivelens/tags-schema.json` (LWW + Tombstones)**: `saveTagSchema` fetches remote JSON and runs `mergeTagSchemas(localSchema, remoteSchema)` per tag ID (`Number(l.updatedAt || 0) >= Number(r.updatedAt || 0)`). Deleted tags retain `deleted: true` tombstones so deletions propagate cleanly across concurrent clients.
- **`.drivelens/member-<key>.json` (Per-User Isolation)**: Each collaborator writes exclusively to `member-${sanitizeMemberKey(memberId)}.json` (`[a-z0-9_-]` truncated to 42 chars + 5-char base-36 hash), preventing concurrent overwrite conflicts. `loadAlbumMetadata` fetches up to 6 JSON files in parallel and skips single corrupted files gracefully.
- **Read-Only Fallback**: When Drive folder permissions are Viewer-only (`!canWrite`), personal edits persist to `localStorage` (`drivelens_readonly_<folderId>_<myId>`).

### 5.2 API Key Local Server Sync (`serve.py` `/api/meta`)

- `GET /api/meta?folder=<id>` and `POST /api/meta` (10MB payload limit) sanitize folder keys (`[a-zA-Z0-9_-]{1,128}`), acquire module-level `_META_LOCK`, merge `tagSchema.tags` via `_merge_tag_schemas` (LWW + tombstones), update `membersData[memberId]`, and write atomically to `.local-meta/<safeFolder>.json` using `tempfile.mkstemp` + `os.replace`.
- `loadLocalServerMeta` / `saveLocalServerMeta` return `null` on static hosts without throwing, seamlessly falling back to `localStorage` (`drivelens_apikey_meta_<folderId>`).

### 5.3 Deterministic Aggregation & Browser Storage Keys

`Store.getAggregatedItemMeta(fileId)` computes `myRating`, `myFavorite`, `myNote`, `avgRating` (across `rating > 0`), `ratingCount`, `favoriteCount`, `ratingsByMember`, `notesByMember`, and `activeTagIds` (latest `updatedAt` per `(fileId, tagId)` across all members, filtered by `!def.deleted`).

| Storage | Key / DB Name | Purpose |
| --- | --- | --- |
| `localStorage` / `sessionStorage` | `drivelens_session_v1` | OAuth `clientId`, `accessToken`, `expiresAt`, and Google `user` profile (`localStorage` when Remember is enabled; `sessionStorage` otherwise) |
| `localStorage` | `drivelens_oauth_user_v1` | Persistent OAuth account profile & email hint (`clientId`, `id`, `email`, `name`, `picture`, `color`) for one-click re-consent |
| `localStorage` / `sessionStorage` | `drivelens_oauth_renewal_v1` | Optional Solution B Worker renewal ticket (`clientId`, `renewalUrl`, `AES-256-GCM` `refreshTicket`, `updatedAt`) |
| `localStorage` | `drivelens_connect_prefs_v1` | Saved `authType`, `apiKey`, `clientId`, `folderId`, `tokenRenewalUrl`, `nickname`, `rememberCredentials`, `autoConnect` |
| `localStorage` | `drivelens_lang_v1` | Explicit UI language preference (`'en'` or `'zh'`) |
| `localStorage` | `drivelens_theme` | UI theme (`'dark'` or `'light'`) |
| `localStorage` | `drivelens_recent_v1` | Up to 6 recently opened albums |
| `localStorage` | `drivelens_demo_state_v1` | Offline demo album state (`tagSchema`, `membersData`, `activePersonaId`) |
| `localStorage` | `drivelens_apikey_meta_<folderId>` | Local mirror/fallback for API Key mode |
| `localStorage` | `drivelens_readonly_<folderId>_<myId>` | Local fallback for OAuth Viewer-only folders |
| `IndexedDB` | `drivelens-album-cache` v2 (`albumMeta`, `fileChunks`) | Split album cache: `albumMeta` (sync tokens, folders, `membersData`, `tagSchema`) + 2,000-file `fileChunks` (max 12 albums; excludes secrets) |
| `IndexedDB` | `drivelens-img-cache` (`blobs`) | Cached `alt=media` image/video Blobs (max 400 entries) |
| `Cache Storage` | `drivelens-shell-v12` | Precached & Network-First PWA app shell managed by [`sw.js`](sw.js) |

---

## 6. 10k–100k Scaling Architecture, Performance & Verification

### 6.1 O(1) Sparse Metadata Engine, Split IDB & Debounced Sync (`src/state/store.js`, `src/storage/albumCache.js`)

- **Single-Pass Normalization & O(1) Lookup**: `_normalizeFileRecord` precomputes `_ts`, `_aspect`, `_isVideo`, and `webViewLink` fallback once per file; `this._fileById` (`Map`) powers `store.getFileById(id)` in `O(1)` across Inspector and Lightbox.
- **Frozen `EMPTY_META` & Sparse `O(K)` Aggregation**: `this._itemsByPhotoId` (`Map<photoId, Map<memberId, item>>`) tracks only rated/favorited/tagged/noted items (`K << N`), returning a shared frozen `EMPTY_META` singleton with zero allocations for untouched files, invalidating only mutated `photoIds` in `_aggMetaCache`, and computing `getLibraryStats()` and `getTagCounts()` in `O(K)`.
- **Fast Selectors & Granular `lastChange`**: `getVisiblePhotos()` caches per-locale `Intl.Collator` (`numeric: true`), lazily caches `_searchHaystack`, skips metadata dependencies when sorting/filtering without metadata predicates (`visiblePhotosVersion` unchanged), and emits typed `lastChange` events (`meta-only`, `selection-only`, `ui-only`, `full`).
- **Split IDB Persistence**: Rating/tag edits call `saveCachedAlbumMetaOnly` (`<2ms`, touching only `albumMeta`), incremental sync calls `applyCachedAlbumDelta` (patching only touched 2k `fileChunks`), and healed thumbnails persist via `patchCachedThumbnailLinks`.

### 6.2 2D TypedArray Virtualizer, 12M px Guard & Scroll-Anchor Lock (`src/ui/renderGallery.js`)

- **TypedArray 2D Layout Engine**: Precomputes `(itemX, itemW, itemH)` in `Float32Array` and `itemY` in `Float64Array` for `100,000` items across `grid` (`O(1)` math), `justified` (`O(log R)` row binary search), and `waterfall` (`O(C log(N/C))` column binary searches) in `3–8ms`.
- **`MAX_STAGE_PX = 12_000_000` Scale Guard**: Caps physical `.gallery-grid` height at `12,000,000px`, linearly mapping `scrollTop <-> logicalTop` and translating `.virtual-stage-layer` + relative `translate3d(x, itemY - windowBaseY, 0)` cards for subpixel GPU accuracy up to item `#99,999`.
- **Bounded Card Recycler (`<= 180` DOM nodes)**: Mounts only overscanned viewport cards, cancels off-screen loads via `cancelElementPhotoLoad`, recycles cards through `freeCardPool`, and patches `meta-only`/`selection-only` updates in `O(1)` over `mountedCardsById`.
- **Zero-Drift Scroll-Anchor Preservation**: Anchors the focal item (`photoId`, `offsetRatio`, `focalScreenY`) across thumbnail size slider drags, pinch zoom, `Ctrl+Wheel`, resize, and layout switches, restoring exact scroll position synchronously before mounting cards (`overflow-anchor: none`).

### 6.3 Mobile Responsive & Touch UX Architecture

- **Safe-Area Tokens & Touch Ergonomics (`styles/tokens.css`, `layout.css`, `components.css`)**:
  - `:root` exposes `--safe-top`, `--safe-bottom`, `--safe-left`, and `--safe-right` (`env(safe-area-inset-*, 0px)`) plus `--mobile-nav-height: 56px`, paired with `-webkit-tap-highlight-color: transparent` and `touch-action: manipulation` on interactive controls and cards.
  - Under `@media (max-width: 768px)`, inputs (`.search-box input`, `.form-input`, `.note-textarea`, `.select-sm`) enforce `font-size: 16px` to prevent automatic iOS Safari viewport zoom, while `@media (max-width: 640px)` anchors modals as bottom sheets (`max-height: 92dvh`, rounded top corners, bottom safe-area padding).
  - Under `@media (hover: none), (pointer: coarse), (max-width: 860px)`, corner checkboxes (`.photo-select-btn`), tag action icons, and star buttons remain directly visible and finger-sized without hover states.
- **Bottom Navigation Bar & Mutually Exclusive Drawers (`index.html`, `src/main.js`, `src/ui/renderHeader.js`, `renderSidebar.js`, `renderInspector.js`)**:
  - `<nav id="mobileNavBar" class="mobile-nav-bar">` is rendered at viewports `<= 860px` by `renderMobileNav(navEl, store)` and bound by `bindMobileNavEvents(navEl, store)` with 5 tabs: **Folders** (with active filter count badge), **Search** (toggling `.mobile-search-open` popover on `#topHeader` and focusing `#searchInput`), **Compare** (with selected photo count badge), **Details**, and **Drive**.
  - `src/main.js` collapses drawers cleanly at startup (`<= 860px`: sidebar collapsed + inspector closed; `<= 1120px`: inspector closed), coordinates `#drawerBackdrop` visibility across both `sidebarOpen` and `inspectorOpen` (`window.innerWidth <= 1120`), closes opposite drawers when opening one, and unwinds open drawers cleanly via `Escape` or `.mobile-drawer-header` close buttons.
- **Compact Phone Grid, Single-Tap Open & Long-Press Selection (`src/ui/renderGallery.js`)**:
  - Below `scrollContainer.clientWidth <= 600` (`isMobile`), `renderGalleryGrid` scales target row height (`max(105, rowHeight * 0.62)`), tightens gaps (`6px`), and sets Square Grid `minCard = max(96, round(rowHeight * 0.5))` for clean 3-column phone browsing.
  - Exposes `[data-subbar="toggle-select-mode"]` (`mobile.selectMode` / `mobile.doneSelect`) on compact screens alongside `420ms` long-press detection (`touchstart`/`touchmove` `>10px` cancel/`touchend`/`touchcancel` + `navigator.vibrate?.(12)`). On touch viewports (`isTouchViewport()`), single-tapping a card opens Lightbox directly unless `mobileSelectMode` or an active selection is present.
- **Touch Gestures in Lightbox & Compare (`src/ui/renderLightbox.js`, `src/ui/renderCompare.js`)**:
  - Both `.lightbox-stage` (and `.lightbox-media-wrap`) and `.compare-stage` set `touch-action: none` and attach `{ passive: false }` `touchmove` listeners for 2-finger pinch zoom (`1x–3x`), `< 280ms` double-tap zoom toggling (`1x <-> 2x`), and 1-finger panning when zoomed (`> 1`).
  - At `1x` zoom in Lightbox, horizontal swipes (`|dx| > 48 && |dx| > |dy| * 1.3`) step between photos and downward swipes (`dy > 85 && dy > |dx| * 1.4`) dismiss Lightbox. On phones (`<= 640px`), Compare stacks 2 panes vertically (`.compare-grid-2`) and lays out 3–4 panes in a scrollable 2-column grid (`.compare-grid-3`, `.compare-grid-4`) with synchronized touch zoom/pan.

### 6.4 Verification Suite (`verify_project.py`)

Run `python verify_project.py` (Python 3 stdlib only) to execute all 10 automated checks:

- **`[a]` HTTP Server Crawl (`verify_http_server`)**: Binds `serve.create_server('127.0.0.1', 0)` (with in-process `NoCacheStaticHandler` fallback if loopback TCP is sandbox-blocked) and fetches `/index.html`, stylesheets, and all transitive ES module imports from `/src/main.js`, asserting HTTP `200`, `no-cache`, and strict MIME types.
- **`[b]` Static ES Module Graph (`verify_static_modules`)**: Tokenizes all JS files, validates balanced `{}/()/[]`, resolves relative import paths case-sensitively, and verifies every imported symbol exists in the target module's exports.
- **`[c]` HTML / CSS / DOM IDs (`verify_html_css_and_dom_ids`)**: Validates balanced HTML tags, CSS braces, and that every `#id` queried in `src/main.js` (including `#mobileNavBar`) exists in `index.html`.
- **`[d]` Documentation Presence (`verify_docs`)**: Confirms `README.md` and `ARCHITECTURE.md` exist and are non-empty.
- **`[e]` `start.bat` Hygiene (`verify_start_bat`)**: Verifies 100% pure ASCII bytes and strict CRLF (`\r\n`) line endings.
- **`[f]` `/api/meta` In-Process Sync (`verify_api_meta`)**: Exercises `GET`/`POST /api/meta`, LWW tag merging, tombstone retention, `400` validation, and `.local-meta/` cleanup.
- **`[g]` Credential & Secret Hygiene (`verify_no_credentials_or_secrets`)**: Ensures zero credential config files (`config.js`, `.env*`, etc.) and zero API keys, Client IDs, personal emails, or local user paths appear anywhere in the repository.
- **`[h]` i18n Integrity (`verify_i18n`)**: Validates `<html lang="en">`, strict `'en'` default, 100% key parity between `MESSAGES.en` and `MESSAGES.zh`, existence of all literal `t(...)` keys, and zero CJK characters in non-`i18n.js` repository files (including documentation, CSS, HTML, and source modules).
- **`[i]` PWA Integrity (`verify_pwa`)**: Validates `manifest.webmanifest` (`display: 'standalone'`, `start_url: './'`), binary PNG dimensions (`192x192` and `512x512`) + SVG icon existence, `sw.js` syntax + `PRECACHE_ASSETS` disk resolution, and live `serve.py` MIME headers for `.webmanifest`, `sw.js`, and `.png`.
- **`[j]` Mobile & Touch UX (`verify_mobile_ux`)**: Verifies `viewport-fit=cover` and `<nav id="mobileNavBar"` in `index.html`, safe-area CSS tokens and mobile/input rules across all 4 stylesheets, `touchstart`/`touchmove`/`touchend` handlers in `renderGallery.js`/`renderLightbox.js`/`renderCompare.js`, `'drivelens-shell-v12'` in `sw.js`, `workers/oauth-renewal-worker.js` syntax & `default` `fetch` handler export, gallery exports, and preservation of the `README.md` `## Design Inspiration & Independence` section.
