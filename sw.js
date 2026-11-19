const CACHE_NAME = 'drivelens-shell-v13';
const PRECACHE_ASSETS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './styles/tokens.css',
  './styles/layout.css',
  './styles/components.css',
  './styles/compare.css',
  './src/main.js',
  './src/constants.js',
  './src/i18n.js',
  './src/storage/albumCache.js',
  './src/ui/contextMenu.js',
];

let ephemeralAuth = { accessToken: '', apiKey: '' };

self.addEventListener('message', (event) => {
  if (event.data?.type === 'DL_AUTH_SYNC') {
    ephemeralAuth = {
      accessToken: String(event.data.accessToken || ''),
      apiKey: String(event.data.apiKey || ''),
    };
  }
});

async function handleOriginalDownloadProxy(fileId, filename) {
  const fallbackUrl =
    'https://drive.google.com/uc?export=download&id=' + encodeURIComponent(fileId);
  if (!ephemeralAuth.accessToken && !ephemeralAuth.apiKey) {
    return Response.redirect(fallbackUrl, 302);
  }

  const driveUrl =
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}` +
    `?alt=media&supportsAllDrives=true` +
    (!ephemeralAuth.accessToken && ephemeralAuth.apiKey
      ? `&key=${encodeURIComponent(ephemeralAuth.apiKey)}`
      : '');
  const headers = ephemeralAuth.accessToken
    ? { Authorization: `Bearer ${ephemeralAuth.accessToken}` }
    : {};

  try {
    const resp = await fetch(driveUrl, { headers });
    if (resp.ok) {
      const safeName = String(filename || 'photo.jpg').replace(/[\r\n"]/g, '_') || 'photo.jpg';
      const asciiSafeName = safeName.replace(/[^\x20-\x7e]/g, '_') || 'photo.jpg';
      const outHeaders = new Headers({
        'Content-Type': resp.headers.get('Content-Type') || 'application/octet-stream',
        'Content-Disposition': `attachment; filename="${asciiSafeName}"; filename*=UTF-8''${encodeURIComponent(safeName)}`,
        'Cache-Control': 'no-store',
      });
      const contentLength = resp.headers.get('Content-Length');
      if (contentLength) {
        outHeaders.set('Content-Length', contentLength);
      }
      return new Response(resp.body, { status: 200, headers: outHeaders });
    }
  } catch {
    // Fall through to Drive download redirect
  }
  return Response.redirect(fallbackUrl, 302);
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => Promise.allSettled(PRECACHE_ASSETS.map((url) => cache.add(url))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key !== CACHE_NAME)
            .map((key) => caches.delete(key))
        )
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  const dlMatch = url.pathname.match(/\/__dl_original__\/([^/]+)\/([^/]+)$/);
  if (dlMatch) {
    let fileId = dlMatch[1];
    let filename = dlMatch[2];
    try {
      fileId = decodeURIComponent(fileId);
      filename = decodeURIComponent(filename);
    } catch {
      // Keep raw path segments if URI decoding fails
    }
    event.respondWith(handleOriginalDownloadProxy(fileId, filename));
    return;
  }

  if (url.pathname.includes('/api/')) return;

  event.respondWith(
    fetch(req)
      .then((resp) => {
        if (resp && resp.ok && resp.type === 'basic') {
          const copy = resp.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(req, copy)).catch(() => {});
        }
        return resp;
      })
      .catch(() =>
        caches.match(req).then((cached) => {
          if (cached) return cached;
          if (req.mode === 'navigate') {
            return caches.match('./index.html').then((shell) => shell || Response.error());
          }
          return Response.error();
        })
      )
  );
});
