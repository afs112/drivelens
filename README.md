# DriveLens · Shared Drive Photo Gallery

> **A zero-build, installable (PWA), static-hostable Google Drive shared photo gallery & collaborative culling workspace.**  
> Runs directly in modern browsers using native ES Modules—no Node.js, no bundler, and no backend database required. Includes a bilingual (**English** default / **Chinese (`zh`)**) offline demo album, persistent auto-reconnect sessions, and two ways to connect real Google Drive shared folders: **API Key Direct Connect** and **OAuth 2.0 Account Sign-In**.

---

## Design Inspiration & Independence

- **UX Inspiration**: DriveLens's darkroom-grade palette, rapid keyboard rating workflow (`1–5`, `0`, `F`, `T`), and side-by-side comparison mode draw UX inspiration from [julyx10/lap](https://github.com/julyx10/lap).
- **Independent Project**: DriveLens is designed and built from scratch as an independent pure-frontend web application. DriveLens is built specifically for zero-install browser/PWA viewing and conflict-free multiplayer culling directly on **Google Drive** shared folders.

---

## Key Features

- **Installable Desktop & Mobile App (PWA)**: Install DriveLens straight from desktop Chrome/Edge via the top-header **Install App** button (or browser address-bar prompt), or add it to your iOS/iPadOS Home Screen via Safari. Built with a relative `./` scope so both `http://localhost:5173` and subpath deployments (such as `GitHub Pages`) work cleanly, backed by a Network-First Service Worker ([`sw.js`](sw.js)).
- **Persistent Login Credentials & Auto-Reconnect**: Keep **Remember login credentials & auto-reconnect** checked (default) so refreshing the browser or relaunching the installed PWA automatically restores your last Google Drive album:
  - **API Key Direct** reconnects silently using your saved API Key, folder ID, and nickname.
  - **OAuth 2.0** silently reuses an active cached token while valid (`drivelens_session_v1`), and once Google's 1-hour access token expires, keeps your account hint (`drivelens_oauth_user_v1`) and opens the Connect modal with one-click re-consent prefilled.
  - Click **Forget Saved Credentials** inside the Connect modal at any time to wipe saved keys, tokens, recent albums, and OAuth account hints.
- **Fast Browsing & Adaptive Layouts**: Switch between **Justified Rows** and **Square Grid** layouts with a live thumbnail size slider (`130px–320px`) and recursive folder tree navigation (with an **Include subfolders** toggle).
- **Bilingual Interface (`English` / `Chinese (zh)`)**: Starts strictly in **English** by default (`<html lang="en">`) and switches live to **Chinese (`zh`)** via the top-right language selector (`#langSelect`) or `#lang=zh` URL hash, with localized dates, sorting, tags, and demo datasets. All Chinese translations live exclusively inside [`src/i18n.js`](src/i18n.js); every other file in the repository contains zero CJK characters.
- **Dual Google Drive Connection Modes**:
  - **API Key Direct (Recommended for public/link-shared albums)**: Connect with a Google Drive API Key (`AIzaSy...`) and any nickname—no OAuth consent review or test-user allowlist required. Syncs ratings/tags via `serve.py` `/api/meta` when self-hosted, or saves locally in `localStorage` on static hosts.
  - **OAuth 2.0 Account Sign-In (Private albums & static cloud sync)**: Sign in with Google Identity Services to browse private shared folders and sync conflict-free metadata directly inside a hidden `.drivelens/` folder on Google Drive—even when hosted on GitHub Pages or Cloudflare Pages.
- **Fullscreen Lightbox & Video Playback**: Smooth `1x–3x` zoom, drag-to-pan, filmstrip navigation, original file downloads, and video playback (authorized blob stream in OAuth mode; embedded Google Drive preview player in API Key mode).
- **2–4 Photo Side-by-Side Compare (`C`)**: Select 2–4 similar shots and press `C` to compare sharpness, framing, and EXIF side by side with **synchronized zoom (`1x–3x`) and drag-pan** plus inline rating, favoriting, and tagging.
- **Multiplayer Ratings, Grouped Color Tags & Notes**: Per-member ratings (`1–5★`), favorites, and notes aggregate deterministically into average scores and collaborator filters (`Average` / `Mine` / `Member`), paired with 8-color grouped tags and `OR` / `AND` multi-tag filtering.
- **Camera EXIF & Export**: Reads Google Drive `imageMediaMetadata` (capture time, resolution, camera, focal length, aperture, shutter, ISO) and exports filtered picks (`Avg ≥ 4★ or favorited`, optional extension stripping) to clipboard filename lists, UTF-8 BOM CSV (`drivelens-shared-picks.csv`), or JSON (`drivelens-shared-picks.json`).

---

## Quick Local Start

DriveLens uses native ES Modules (`<script type="module">`) and requires **no Node.js or npm**—only Python 3.

### Option 1: Windows One-Click Launcher

Double-click [`start.bat`](start.bat) (pure ASCII + CRLF) in the repository root. It starts the local server and opens your browser at:

```text
http://localhost:5173
```

### Option 2: Command Line (Windows / macOS / Linux)

```bash
python serve.py
```

Useful CLI flags:

```bash
# Custom port and auto-open browser
python serve.py 8080 --open

# Dry-run port bind check (prints READY http://localhost:<port> and exits)
python serve.py 5173 --dry-run
```

> **Why `serve.py`?**
> 
> 1. Browsers require strict MIME types for native ES Modules and PWAs (Windows registries can misreport `.js` or omit `.webmanifest`); [`serve.py`](serve.py) enforces `application/javascript; charset=utf-8` (`.js`/`.mjs`), `application/manifest+json` (`.webmanifest`), and `image/png` (`.png`), and disables stale dev caching.
> 2. [`serve.py`](serve.py) also exposes lightweight `GET/POST /api/meta` endpoints so collaborators sharing a local/LAN `serve.py` instance in API Key mode automatically sync ratings and tags to `.local-meta/`.

### Try the Built-In Offline Demo Album

Opening DriveLens immediately loads the offline **"2026 Autumn Alpine Loop Shared Album"** (4 child subfolders under root—5 folders total—plus 15 SVG landscape/portrait frames and 1 timelapse video item):

- **Switch Collaborator Personas**: Click **Me (Alex)**, **Lin**, or **Jay** in the top demo banner to preview how independent friend ratings, notes, and average scores combine.
- **Language Switch**: Use the top-right language selector (`#langSelect`) or append `#lang=zh` / `#lang=en` to the URL to switch UI labels, dates, tags, and demo album content between English and Chinese (`zh`).
- **Reset Demo**: Click **Reset Demo** in the banner anytime to restore initial demo ratings and tags.

---

## Installing as a Standalone App (PWA)

DriveLens ships with [`manifest.webmanifest`](manifest.webmanifest), [`sw.js`](sw.js), and scalable/raster app icons under [`icons/`](icons/) (`icon.svg`, `icon-192.png`, `icon-512.png`):

- **Requirements**: Service Worker registration and PWA installation activate automatically on HTTPS deployments (`GitHub Pages`, `Cloudflare Pages`, `Netlify Drop`) and on local `http://localhost:<port>` / `http://127.0.0.1:<port>` (treated as secure contexts by browsers; remote plain HTTP LAN IPs do not allow Service Workers).
- **Desktop Chrome / Edge**: Look for the **Install App** button (`[data-header="install-app"]`) in the DriveLens top header—shown automatically when the browser fires `beforeinstallprompt`—or click the install icon in the browser address bar to launch DriveLens in its own standalone window.
- **iOS / iPadOS Safari**: Open your HTTPS-hosted DriveLens URL in Safari and choose **Share → Add to Home Screen** (`apple-mobile-web-app-capable` and `apple-touch-icon` are preconfigured in [`index.html`](index.html)).
- **Offline App Shell Caching**: `sw.js` (`drivelens-shell-v1`) precaches the core HTML, CSS, SVG/PNG icons, and entry ES modules using a **Network-First** strategy with navigation fallback to `./index.html`. Cross-origin Google Drive API calls and local `/api/` metadata calls always bypass the Service Worker cache.

---

## Persistent Credentials & Auto-Reconnect

Both tabs in the **Connect Google Drive** modal include a **Remember login credentials & auto-reconnect** checkbox (enabled by default):

- **On Startup / PWA Relaunch**: When the URL hash does not specify another `?folder=...` target, DriveLens automatically invokes `store.restoreSavedSession()`:
  - **API Key Mode**: Silently reconnects using your saved API Key, folder ID, and nickname from `localStorage` (`drivelens_connect_prefs_v1`).
  - **OAuth 2.0 Mode**: Reuses the cached OAuth token in `localStorage` (`drivelens_session_v1`) silently if more than 60 seconds remain before expiry. When Google's 1-hour access token has expired, DriveLens keeps your remembered folder ID, Client ID, and account email/profile (`drivelens_oauth_user_v1`), opens the Connect modal displaying a saved-account badge and toast reminder, and passes `hint` (`loginHint`) to Google Identity Services so re-consent takes one click.
- **Remember Unchecked**: Session tokens are written only to ephemeral `sessionStorage` (cleared when closing the browser/PWA tab), and previously saved API keys, Client IDs, folder IDs, and OAuth account hints are removed.
- **Pause Auto-Reconnect**: Clicking **Back to Demo** (or **Disconnect**) sets `autoConnect: false` so subsequent page reloads stay in Demo Mode until you explicitly connect again.
- **One-Click Wipe**: Click **Forget Saved Credentials** in the Connect modal to clear `drivelens_session_v1`, `drivelens_oauth_user_v1`, `drivelens_connect_prefs_v1`, and `drivelens_recent_v1` immediately and return to Demo Mode if currently connected.

---

## Security & Zero-Credential Guarantee

**This repository contains ZERO API keys, OAuth Client IDs, folder IDs, emails, or local secrets:**

- No `config.js` or credential file is committed to the repository ([`src/constants.js`](src/constants.js) contains empty string defaults only).
- [`.gitignore`](.gitignore) explicitly blocks `config.js`, `config.*.js`, `config*.json`, `.env`, `.env.*`, `*credentials*`, `*credential*`, `client_secret*`, `*secret*`, `*token*.json`, `*.pem`, `*.key`, `*.p12`, `*.pfx`, and `.local-meta/`.
- Any API Key or OAuth Client ID you enter in the **Connect Google Drive** modal stays strictly inside your browser's `localStorage` / `sessionStorage` (or an optional share URL hash you generate yourself).

---

## Connecting Your Google Drive Album (2 Modes)

Click **Connect Drive** in the top header and choose between the two tabs:

### Mode 1: API Key Direct Connect (Recommended · No OAuth Allowlist)

Best for link-shared albums, quick guest viewing without Google sign-in prompts, or LAN/self-hosted `serve.py` sessions.

1. **Create a Google Drive API Key**:
   - Open [Google Cloud Console](https://console.cloud.google.com/) and create or select a project.
   - Go to **APIs & Services → Library**, search for **Google Drive API**, and click **Enable**.
   - Go to **APIs & Services → Credentials → + Create Credentials → API key**, and copy the key (`AIzaSy...`).
   - *(Recommended)* Restrict the key under **API restrictions** to **Google Drive API** (and optionally add HTTP referrer website restrictions for your hosted domain).
2. **Enable Link Sharing on Your Drive Folder**:
   - In Google Drive, right-click your album folder → **Share**.
   - Set **General access** to **Anyone with the link → Viewer**, then paste the folder URL/ID, API Key, and your display nickname into the **API Key Direct** tab.

#### Collaboration & Sharing in API Key Mode

- **With `serve.py` (`/api/meta`)**: Collaborators accessing the same `serve.py` server automatically sync ratings, favorites, tags, and notes into `.local-meta/<folderId>.json` (click **Refresh** in the header to pull peers' latest updates).
- **On Static Hosts (GitHub Pages / Cloudflare Pages)**: Without a `/api/meta` backend, DriveLens smoothly degrades to browser-local persistence (`localStorage` key `drivelens_apikey_meta_<folderId>`, status pill shows **Local Only**). For cloud-synced multiplayer ratings on pure static hosts, use **Mode 2 (OAuth 2.0)**.
- **Direct Share URL Hash**:
  
  ```text
  https://your-site.example/#folder=<FOLDER_ID>&key=<YOUR_API_KEY>&nick=<OPTIONAL_NICKNAME>
  ```
  
  Append `&lang=zh` or `&lang=en` if you want recipients to land in a specific UI language.

### Mode 2: OAuth 2.0 Account Sign-In (Private Folders & Cloud `.drivelens/` Sync)

Best when photos must remain private (shared only with specific Google accounts) or when hosting on pure static platforms (GitHub Pages / Cloudflare Pages) where collaborators' ratings should sync across devices directly inside Google Drive.

1. **Enable Google Drive API**: In [Google Cloud Console](https://console.cloud.google.com/), create a project and enable **Google Drive API** under **APIs & Services → Library**.
2. **Configure OAuth Consent Screen & Test Users**:
   - Open **Google Auth Platform → Audience** (or **APIs & Services → OAuth consent screen**).
   - Select **External**, keep publishing status in **Testing** (free, no Google verification needed), and add every collaborator's Google email under **Test Users** (supports up to **100 users**).
3. **Create a Web Application OAuth Client ID**:
   - Go to **Clients** (or **Credentials → + Create Credentials → OAuth client ID → Web application**).
   - Add your exact site origin under **Authorized JavaScript origins** (no trailing `/` and no subpath):
     - Local: `http://localhost:5173`, `http://127.0.0.1:5173`
     - Hosted: `https://<username>.github.io` or `https://<project>.pages.dev`
   - Paste the generated Client ID (`<YOUR_CLIENT_ID>.apps.googleusercontent.com`) into the **OAuth Account Sign-In** tab.

#### Folder Permissions & Share URL Hash

- Collaborators with **Editor** access write conflict-free ratings, tags, and notes to `.drivelens/member-<key>.json` and `.drivelens/tags-schema.json` inside the shared Drive folder.
- Collaborators with **Viewer** access can browse normally and cache their personal picks in browser `localStorage`.
- After connecting via OAuth, DriveLens updates the URL hash to `#folder=<FOLDER_ID>&client_id=<CLIENT_ID>`, which you can copy and share with your test-user friends.

---

## Zero-Cost Static Deployment

DriveLens requires **no build command**—upload the repository directory directly to any static host over HTTPS:

1. **GitHub Pages** *(repository includes `.nojekyll` and relative `./` PWA scope)*:
   - Push to GitHub → **Settings → Pages → Deploy from a branch (`main`, `/ (root)`)**.
   - PWA manifest (`manifest.webmanifest`) and Service Worker (`sw.js`) use relative `./` paths, so subpath hosting like `https://<username>.github.io/drivelens/` installs cleanly without colliding with other sites on the same origin.
   - If using OAuth mode, add `https://<username>.github.io` (origin only, without the repo subpath) to Google Cloud **Authorized JavaScript origins**.
2. **Cloudflare Pages**:
   - Create a Pages project (Git integration or Direct Upload) with an empty **Build command** and output directory `.`.
3. **Netlify Drop**:
   - Drag the `drivelens` folder onto [Netlify Drop](https://app.netlify.com/drop) for an instant HTTPS URL.

---

## Keyboard Shortcuts & Export Guide

> Single-key shortcuts automatically yield while typing inside search, note, or modal inputs.

| Shortcut               | Action                                                                    |
| ---------------------- | ------------------------------------------------------------------------- |
| `←` / `→`              | Previous / Next photo (Gallery focus & Lightbox)                          |
| `Enter` / `Space`      | Open / Close fullscreen Lightbox                                          |
| `1` – `5`              | Rate focused or selected photos **1–5 stars**                             |
| `0`                    | Clear your rating on focused or selected photos                           |
| `F`                    | Toggle **Favorite** (heart)                                               |
| `T`                    | Open **Quick Tag** modal                                                  |
| `C`                    | Toggle **2–4 Photo Side-by-Side Compare**                                 |
| `I`                    | Toggle right-hand **Inspector** panel                                     |
| `Ctrl + A` / `Cmd + A` | Select all currently visible photos                                       |
| `Esc`                  | Close active modal → Compare → Lightbox → mobile drawer → clear selection |
| `?`                    | Open Keyboard Shortcuts modal                                             |

### Multi-Select, Compare & Export Tips

- **Multi-Select**: Use `Ctrl/Cmd + Click` to toggle items, `Shift + Click` for range selection, or click card corner checkboxes to trigger the floating batch rating/favoriting/tagging bar.
- **Side-by-Side Compare (`C`)**: Displays 2 panes side by side, 3 panes in columns, or 4 panes in a 2×2 grid. Zoom via top controls, mouse wheel (`0.25x` steps), or double-click (`100% / 200%`, up to `300%`), then drag any pane to pan all panes in sync.
- **Export Picks**: Click **Export** in the header, optionally check **Only export picks (Avg ≥ 4★ or favorited)** and **Strip file extensions** (for quick filename matching in external raw editors), then copy the filename list or download `drivelens-shared-picks.csv` (UTF-8 BOM) or `drivelens-shared-picks.json`.

---

## Further Reading

- See [ARCHITECTURE.md](ARCHITECTURE.md) for the module graph, pure-`i18n.js` localization design, PWA & Service Worker shell caching, persistent credential lifecycle, Google Drive crawler & image caching pipeline, conflict-free `.drivelens/` & `/api/meta` schemas, and verification suite (`verify_project.py`).
