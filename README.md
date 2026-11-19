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

## 3. Solving Google 1-Hour Sign-In Expiry (Solution A Pure Static vs. Solution B Auto-Renewal Worker)

### Why Google OAuth Expires After 1 Hour

Pure-frontend web apps receive a **60-minute** `access_token` from Google Identity Services (GIS) without a `refresh_token`, because Google requires a confidential server-side `client_secret` to issue and exchange refresh tokens. DriveLens solves this cleanly with two built-in options:

### Solution A — Pure Static Page (Default · Zero Extra Deployment)

Built into DriveLens out of the box whenever **Token Renewal Endpoint (Optional)** is left blank:

- **Never Kicked Out**: When the 60-minute `access_token` expires, your cached album and photos stay open on screen, and any new star ratings, favorites, tags, or notes buffer safely in your browser.
- **1-Click `0.5s` Flash Reconnect**: The top-right sync indicator switches to **Reconnect (`!`)** (or red **`!`** if you have unsynced edits). Click it **once** and DriveLens directly invokes GIS with `prompt: ''` and your saved account hint—no Connect modal and no re-selecting your account; the popup auto-closes in `~0.5s` and immediately flushes all pending ratings to `.drivelens/`.
- **Hybrid API Key Tip**: If your folder is link-shared and you have also saved an **API Key**, photo browsing, thumbnail self-healing, and incremental new-photo refresh continue running on the non-expiring API Key—you only ever reconnect OAuth when writing ratings!

### Solution B — Permanent Background Silent Auto-Renewal (Free Cloudflare Worker · ~3 Mins Setup · Zero Credentials in GitHub!)

For users who want native-app-style **sign in once for months** with zero popups across refreshes, tab wakes, and PWA restarts:

#### Step 1: Google Cloud Console Setup

1. Open your Web OAuth Client in [Google Cloud Console](https://console.cloud.google.com/) (**APIs & Services → Credentials**) and copy its **Client Secret** (`<YOUR_OAUTH_CLIENT_SECRET>` — **keep it strictly private and NEVER commit it to GitHub!**).
2. Ensure your site origin (`https://afs112.github.io` or `https://<your-username>.github.io`) is listed under **Authorized JavaScript origins**. Google's popup code flow automatically uses `postmessage`, so no extra redirect URI is needed (you can leave **Authorized redirect URIs** empty).
3. *(Important Google Tip)*: Under **OAuth consent screen / Audience**, if **Publishing status** is **Testing**, Google forces refresh tokens to expire every **7 days**. Click **Publish App** (free; for personal or small-group unverified apps, users simply click *"Advanced → Go to ... (unsafe)"* once on first sign-in, and the refresh token lasts for months instead of 7 days!).

#### Step 2: Deploy [`workers/oauth-renewal-worker.js`](workers/oauth-renewal-worker.js) to Cloudflare Workers (Free Tier: 100k req/day)

*Browser Dashboard Method (No CLI needed)*:

1. Sign in to [Cloudflare Dashboard](https://dash.cloudflare.com/) → **Compute (Workers & Pages) → Create → Create Worker**.
2. Click **Deploy**, then click **Edit Code**, paste the entire contents of [`workers/oauth-renewal-worker.js`](workers/oauth-renewal-worker.js), and click **Deploy**.
3. Open your Worker → **Settings → Variables and Secrets → + Add**:
   - Add **Secret**: Name = `GOOGLE_CLIENT_SECRET`, Value = `<YOUR_OAUTH_CLIENT_SECRET>` *(MUST select type **Secret** so it is encrypted!)*.
   - Add **Text Variable**: Name = `ALLOWED_ORIGINS`, Value = `https://afs112.github.io` *(comma-separated if adding `http://localhost:5173` or your own fork origin)*.
   - *(Optional Extra Security)* Add **Secret**: Name = `TICKET_ENC_KEY`, Value = `<ANY_RANDOM_32_CHAR_PASSPHRASE>` *(encrypts the Google refresh token with `AES-256-GCM` so the browser only ever holds an opaque encrypted ticket!)*.
   - *(Optional)* Add **Text Variable**: Name = `ALLOWED_CLIENT_IDS`, Value = `<YOUR_CLIENT_ID>.apps.googleusercontent.com`.
4. Test your Worker by opening `https://<your-worker>.<your-subdomain>.workers.dev/health` in your browser—it should return `{"ok":true,"service":"drivelens-oauth-renewal",...}`.

#### Step 3: Connect in DriveLens

1. Open DriveLens → **Connect Drive → OAuth Account Sign-In**, paste `https://<your-worker>.<your-subdomain>.workers.dev` into **Token Renewal Endpoint (Optional)**, and sign in once.
2. Your Worker URL is saved **only in your own browser's `localStorage`** (never in GitHub). DriveLens will now silently renew your `access_token` in the background every ~55 minutes (5 minutes before expiry), on tab wake, and automatically upon reopening the browser or PWA! *(You can also pass `#folder=<FOLDER_ID>&client_id=<YOUR_CLIENT_ID>&renewal_url=https://<your-worker>.<your-subdomain>.workers.dev` in a direct share link.)*

---

## 4. Quick Self-Deployment (Own Domain or Local LAN in 1 Minute)

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

## 5. Practical User Guide & Controls Cheat-Sheet

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

- **Red `!` badge**: Cloud sync failed or edits have not synced yet—click the sync button to retry immediately (or perform a 1-click `0.5s` OAuth reconnect and flush pending ratings).
- **Amber `!` / `Reconnect` badge**: Read-only Drive access, static API Key mode (ratings saved locally in this browser), or expired OAuth session—click **Reconnect** once for instant `0.5s` OAuth renewal without opening the settings modal.
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

## 6. Installing as Desktop / Mobile App (PWA) & Security Guarantee

### Install as a Standalone App (PWA)

Service Worker caching ([`sw.js`](sw.js)) and PWA installation activate automatically on HTTPS sites (`https://afs112.github.io/drivelens/`, GitHub Pages, Cloudflare Pages, Netlify Drop) and `http://localhost` / `127.0.0.1`:

- **Desktop Chrome / Edge**: Click **Install App** in the top header or the install icon in the browser address bar.
- **iOS / iPadOS Safari**: Open the HTTPS URL in Safari and choose **Share → Add to Home Screen**.
- **Android Chrome**: Tap **Install app** or **Add to Home screen** from the browser menu.

### Persistent Credentials & Zero-Secret Guarantee

- **Auto-Reconnect**: **Remember login credentials & auto-reconnect** is enabled by default so refreshing or relaunching the PWA restores your album automatically. In OAuth mode, Solution A preserves your email hint for 1-click `0.5s` re-consent (`prompt: ''`), while Solution B (optional Cloudflare Worker) stores an encrypted refresh ticket in your browser to renew silently in the background.
- **One-Click Wipe**: Click **Forget Saved Credentials** in the Connect modal to immediately clear saved API keys, Client IDs, tokens, and recent albums, or click **Clear Cache** to wipe local IndexedDB album/thumbnail caches.
- **Zero Secrets in Repository**: This repository contains **zero** API keys, OAuth Client IDs, folder IDs, emails, or tokens ([`src/constants.js`](src/constants.js) holds empty defaults only; [`.gitignore`](.gitignore) blocks `config*.js`, `.env*`, `*credentials*`, `*secret*`, and `.local-meta/`).

---

## Design Inspiration & Independence

- **UX Inspiration**: DriveLens's darkroom-grade palette, rapid keyboard rating workflow (`1–5`, `0`, `F`, `T`), and side-by-side comparison mode draw UX inspiration from [julyx10/lap](https://github.com/julyx10/lap).
- **Independent Project**: DriveLens is designed and built from scratch as an independent pure-frontend web application. DriveLens is built specifically for zero-install browser/PWA viewing and conflict-free multiplayer culling directly on **Google Drive** shared folders.

---

## Further Reading

- See [ARCHITECTURE.md](ARCHITECTURE.md) for the module graph, 100k-scale virtualization & thumbnail tiering, pure-`i18n.js` localization design, PWA & Service Worker caching (`sw.js`), Google Drive incremental sync pipeline, conflict-free `.drivelens/` & `/api/meta` schemas, and verification suite ([`verify_project.py`](verify_project.py)).
