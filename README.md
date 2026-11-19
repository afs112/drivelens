# DriveLens · Shared Google Drive Photo Gallery

<p>
  <strong>English</strong> · <a href="README.zh-CN.md"><strong>简体中文</strong></a> · <a href="https://afs112.github.io/drivelens/"><strong>Open Live Web App (Zero-Install) ↗</strong></a>
</p>

> **Turn any Google Drive folder into a fast, zero-install shared photo gallery & multiplayer culling workspace.**  
> Runs 100% in your browser with no backend server, no database, and no sign-up—open the live web app directly or self-host in 1 minute.

---

## 1. What You Can Do with DriveLens

- **Instant 60fps Darkroom Gallery (Up to 10,000–100,000+ Photos & Videos)**: Browse massive Google Drive folders in **Waterfall Masonry**, **Justified Rows**, or **Square Grid** layouts with predictive thumbnail loading, incremental cloud refresh, and local browser caching.
- **Multiplayer Collaborative Culling**: Share one album with friends—everyone rates (`1–5★`), favorites (`♥`), adds color tags (`T`), and writes notes independently without overwriting each other. Filter by **Average**, **Mine**, or any **Collaborator**, compare **2–4 shots side-by-side (`C`)** with synchronized zoom, and export final picks for Lightroom or Capture One.
- **Desktop & Mobile Native Experience**: Install as a standalone Desktop / iOS / Android app (PWA), **drag any photo straight onto your computer Desktop** to save the original file, use the **right-click quick menu** to rate or download, and close fullscreen Lightbox effortlessly with a single click or swipe.
- **Built-In Offline Demo Album**: Try every feature immediately—even without connecting Google Drive—using the preloaded **2026 Autumn Alpine Loop Shared Album** with 3 switchable collaborator personas (**Me (Alex)**, **Lin**, **Jay**).

---

## 2. Fastest Way to Start: Zero Deployment (Recommended)

You do **not** need to fork the repository, install Node.js, or run any server. Open the official static host directly:

👉 **[https://afs112.github.io/drivelens/](https://afs112.github.io/drivelens/)**

> **Why is Zero-Deploy 100% private & safe?**  
> DriveLens is a pure static frontend (`0` backend servers, `0` analytics, `0` telemetry). Your API Key, Google OAuth token, folder IDs, and photos travel **strictly between your browser and Google's official APIs**—`afs112.github.io` never sees, intercepts, or stores any of your data.

Choose whichever connection method fits your album:

### Method A: Public Link-Shared Album (API Key · Easiest for Viewing, ~2 Mins)

Best when anyone with the folder link is allowed to view the photos and you want zero Google login prompts for guests.

1. **Share your Google Drive folder**: Right-click the album folder in Google Drive → **Share** → set General access to **Anyone with the link (Viewer)**.
2. **Create a free API Key**: Open [Google Cloud Console](https://console.cloud.google.com/) → create/select a project → enable **Google Drive API** under **APIs & Services → Library** → go to **Credentials → + Create Credentials → API key** (`AIzaSy...`). *(Optional: restrict the key to **Google Drive API** under API restrictions.)*
3. **Connect & share**: Open **[https://afs112.github.io/drivelens/](https://afs112.github.io/drivelens/)** → click **Connect Drive** → paste your **Folder Link/ID**, **API Key**, and display nickname.
   - To send friends a **1-click direct link**, share:
     ```text
     https://afs112.github.io/drivelens/#folder=<FOLDER_ID>&key=<YOUR_API_KEY>
     ```
   - *(Tip: on static hosts like GitHub Pages, API Key mode saves your ratings in your own browser; for cloud-synced multiplayer ratings or private folders, use **Method B** below.)*

### Method B: Private Folder & Cloud Rating Sync (Use Your Own Google OAuth on `afs112.github.io`, No Fork Needed!)

Best when photos must stay private to invited Google accounts, or when multiple friends want their ratings, tags, and notes synced directly inside the Google Drive folder (`.drivelens/`).

1. **Enable Google Drive API**: In your own [Google Cloud Console](https://console.cloud.google.com/), create or select a project and enable **Google Drive API** (**APIs & Services → Library**).
2. **Configure OAuth Consent Screen & Test Users**:
   - Open **Google Auth Platform → Audience** (or **APIs & Services → OAuth consent screen**).
   - Select **External** and keep publishing status in **Testing** (completely free, no Google app verification needed).
   - Add your Gmail and your friends' Gmail addresses under **Test Users** (supports up to **100 users**).
3. **Authorize `https://afs112.github.io`**:
   - Go to **Credentials → + Create Credentials → OAuth client ID → Web application**.
   - Under **Authorized JavaScript origins**, add:
     ```text
     https://afs112.github.io
     ```
     *(Origin only—do **not** include `/drivelens` or a trailing `/`!)*
4. **Connect & share 1-click album link**:
   - Copy the generated **Client ID** (`<YOUR_CLIENT_ID>.apps.googleusercontent.com`).
   - Open **[https://afs112.github.io/drivelens/](https://afs112.github.io/drivelens/)**, switch to the **OAuth Account Sign-In** tab, paste your **Folder Link/ID** and **Client ID**, and click **Authorize & Open Album**.
   - Collaborators with **Editor** access automatically sync ratings, tags, and notes to `.drivelens/` inside the Drive folder; **Viewer** accounts save picks locally.
   - Share this 1-click link with your test-user friends:
     ```text
     https://afs112.github.io/drivelens/#folder=<FOLDER_ID>&client_id=<YOUR_CLIENT_ID>
     ```
   - Append `&lang=zh` to launch directly in Chinese, or `&lang=en` for English.

---

## 3. Quick Self-Deployment (Own Domain or Local LAN in 1 Minute)

DriveLens uses native browser ES Modules with **zero build steps** and **no Node.js / npm required**.

### Option 1: 1-Click GitHub Fork + GitHub Pages

1. Fork this repository to your GitHub account.
2. Open **Settings → Pages → Build and deployment → Deploy from a branch** → select **`main`** and **`/ (root)`**, then click **Save**.
3. Your gallery goes live at `https://<your-username>.github.io/drivelens/` (already configured with `.nojekyll` and relative `./` PWA paths).
4. If using OAuth mode, add `https://<your-username>.github.io` (origin only, without `/drivelens`) under Google Cloud **Authorized JavaScript origins**.

### Option 2: Cloudflare Pages / Netlify Drop

- **Cloudflare Pages**: Connect your fork or upload the folder with an **empty Build command** and Output directory `.`.
- **Netlify Drop**: Drag the `drivelens` folder onto [Netlify Drop](https://app.netlify.com/drop) for an instant HTTPS deployment.

### Option 3: Local Computer or LAN (`start.bat` / `python serve.py`)

Requires only **Python 3**:

- **Windows**: Double-click [`start.bat`](start.bat) in the repository root to start the server and open `http://localhost:5173`.
- **macOS / Linux / CLI**:
  ```bash
  python serve.py
  # Optional: custom port & auto-open browser
  python serve.py 8080 --open
  # Dry-run port bind check
  python serve.py 5173 --dry-run
  ```
- **Bonus in `serve.py`**: Sets strict ES Module & PWA MIME types and provides lightweight `/api/meta` endpoints so collaborators sharing a local/LAN `serve.py` instance in **API Key mode** automatically sync ratings and tags to `.local-meta/`!

---

## 4. Practical User Guide & Controls Cheat-Sheet

### Browsing, Layouts & Multimodal Search

- **3 Gallery Layouts**: Switch between **Justified Rows**, **Waterfall Masonry** (`V`), and **Square Grid** from the top-right segmented pill. Adjust thumbnail size via the `...` menu slider, `Ctrl/Cmd + Wheel` on desktop, or 2-finger pinch on touchscreens.
- **Multimodal Search Capsule**: Click the top-center search bar to type keywords, filenames, camera models, dates, or notes, and combine quick filter pills for **media type**, **aspect/framing ratio**, **star rating**, **tags**, and **collaborators**.
- **Folders & Demo Personas**: Toggle the left **Folders** drawer to browse subfolders (with optional *Include subfolders*). In Demo Mode, click the top-left album pill to switch between **Me (Alex)**, **Lin**, and **Jay** or click **Reset Demo**.

### Rating, Tagging & Right-Click Quick Menu

- **Fast Culling**: Click any photo to focus it, press `1–5` to rate, `0` to clear, `F` to favorite, or `T` for quick tags; press `I` to toggle the **Inspector** panel for Camera EXIF and notes.
- **Right-Click Context Menu**: Right-click any photo card in the gallery—or right-click inside **Lightbox**—to quickly apply `1–5★` ratings, toggle **Favorite**, open **Tags**, or **Download Original** without touching the keyboard.

### Multi-Select & Batch Actions

- **Desktop**: Hover near the **top-left corner** of a photo card for **`200ms`** to peek and click its checkbox, or use `Ctrl/Cmd + Click` (toggle), `Shift + Click` (range), or `Ctrl/Cmd + A` (select all visible).
- **Mobile / Touch**: **Long-press** any photo (or tap **Select** in the gallery bar) to enter multi-select and use the floating Liquid Glass batch action pill.

### Drag Photo to Desktop to Download Originals

- In desktop **Chrome / Edge**, click and **drag any photo card straight onto your Desktop** (or into Finder / File Explorer) to download the original file immediately (`DownloadURL` integration, backed by the Service Worker in Drive modes).

### Effortless Lightbox Exit & Touch Gestures

- **Desktop**:
  - **Click-in-place exit**: Click a photo to open Lightbox, then click again **without moving your mouse** (`< 30px`) to close immediately.
  - **Backdrop / drag / keys**: Move the mouse and click the **dark backdrop** outside the image, drag downward, or press `Esc`, `Space`, or `Enter` to close.
  - **Zoom & step**: Move the mouse onto the photo and **double-click** to toggle `100% / 200%` zoom (or scroll to zoom), and use `←` / `→` to step between photos.
- **Mobile**:
  - **Flick up or pull down** anywhere on the Lightbox stage, or use your **system edge-back gesture**, to close cleanly without leaving the app.
  - Swipe left/right to navigate, double-tap (`1x ↔ 2x`) or pinch (`1x–3x`) to zoom, and drag to pan.

### Top-Right Sync & Refresh Indicator

- **Red `!` badge**: Cloud sync failed or edits have not synced yet—click the sync button to retry immediately.
- **Amber `!` badge**: Read-only Drive access or static API Key mode—your ratings and notes are safely saved **locally in this browser**.
- **Refresh vs. Full Rescan**: Click **Refresh** for fast incremental Drive sync (`changes.list` / watermark), or **`Shift + Click`** Refresh to force a full folder rescan.

### 2–4 Photo Side-by-Side Compare (`C`) & Export Picks

- **Compare (`C`)**: Select 2–4 similar shots and press `C` to inspect sharpness, framing, and EXIF side by side with **synchronized zoom (`1x–3x`) and drag-pan**, plus inline rating, favoriting, and tagging.
- **Export Picks**: Open **Export** in the header (or `...` menu), optionally check **Only export picks (Avg ≥ 4★ or favorited)** and **Strip file extensions** (ideal for matching RAW/JPEG filenames in Lightroom or Capture One), then copy the filename list or download `drivelens-shared-picks.csv` (UTF-8 BOM) or `drivelens-shared-picks.json`.

### Keyboard Shortcuts

> Single-key shortcuts automatically pause while typing in search, note, or modal inputs.

| Shortcut               | Action                                                                    |
| ---------------------- | ------------------------------------------------------------------------- |
| `←` / `→`              | Previous / Next photo (Gallery focus & Lightbox)                          |
| `Enter` / `Space`      | Open / Close fullscreen Lightbox                                          |
| `1` – `5`              | Rate focused or selected photos **1–5 stars**                             |
| `0`                    | Clear your rating on focused or selected photos                           |
| `F`                    | Toggle **Favorite** (heart)                                               |
| `T`                    | Open **Quick Tag** modal                                                  |
| `C`                    | Toggle **2–4 Photo Side-by-Side Compare**                                 |
| `I`                    | Toggle **Inspector** panel (or photo info in Lightbox)                    |
| `V`                    | Cycle gallery layout (**Justified / Waterfall / Grid**)                   |
| `Ctrl + A` / `Cmd + A` | Select all currently visible photos                                       |
| `Esc`                  | Close active modal → Compare → Lightbox → panel → clear selection         |
| `?`                    | Open Keyboard Shortcuts modal                                             |

---

## 5. Installing as Desktop / Mobile App (PWA) & Security Guarantee

### Install as a Standalone App (PWA)

Service Worker caching ([`sw.js`](sw.js)) and PWA installation activate automatically on HTTPS sites (`https://afs112.github.io/drivelens/`, GitHub Pages, Cloudflare Pages, Netlify Drop) and `http://localhost` / `127.0.0.1`:

- **Desktop Chrome / Edge**: Click **Install App** in the top header or the install icon in the browser address bar.
- **iOS / iPadOS Safari**: Open the HTTPS URL in Safari and choose **Share → Add to Home Screen**.
- **Android Chrome**: Tap **Install app** or **Add to Home screen** from the browser menu.

### Persistent Credentials & Zero-Secret Guarantee

- **Auto-Reconnect**: **Remember login credentials & auto-reconnect** is enabled by default so refreshing or relaunching the PWA restores your album automatically. In OAuth mode, after Google's 1-hour access token expires, DriveLens keeps your email hint for 1-click re-consent.
- **One-Click Wipe**: Click **Forget Saved Credentials** in the Connect modal to immediately clear saved API keys, Client IDs, tokens, and recent albums, or click **Clear Cache** to wipe local IndexedDB album/thumbnail caches.
- **Zero Secrets in Repository**: This repository contains **zero** API keys, OAuth Client IDs, folder IDs, emails, or tokens ([`src/constants.js`](src/constants.js) holds empty defaults only; [`.gitignore`](.gitignore) blocks `config*.js`, `.env*`, `*credentials*`, `*secret*`, and `.local-meta/`).

---

## Design Inspiration & Independence

- **UX Inspiration**: DriveLens's darkroom-grade palette, rapid keyboard rating workflow (`1–5`, `0`, `F`, `T`), and side-by-side comparison mode draw UX inspiration from [julyx10/lap](https://github.com/julyx10/lap).
- **Independent Project**: DriveLens is designed and built from scratch as an independent pure-frontend web application. DriveLens is built specifically for zero-install browser/PWA viewing and conflict-free multiplayer culling directly on **Google Drive** shared folders.

---

## Further Reading

- See [ARCHITECTURE.md](ARCHITECTURE.md) for the module graph, 100k-scale virtualization & thumbnail tiering, pure-`i18n.js` localization design, PWA & Service Worker caching (`sw.js`), Google Drive incremental sync pipeline, conflict-free `.drivelens/` & `/api/meta` schemas, and verification suite ([`verify_project.py`](verify_project.py)).
