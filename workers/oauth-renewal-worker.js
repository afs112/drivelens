/**
 * DriveLens OAuth Renewal Cloudflare Worker (Zero-Secret Template)
 *
 * Configure via Wrangler secrets / environment variables only:
 * - GOOGLE_CLIENT_SECRET (required secret)
 * - ALLOWED_ORIGINS (comma-separated, e.g. https://afs112.github.io,http://localhost:5173)
 * - ALLOWED_CLIENT_IDS (optional comma-separated OAuth Client ID allowlist)
 * - TICKET_ENC_KEY (optional passphrase to seal refresh_token into enc:v1:... AES-GCM tickets)
 */

const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const TICKET_PREFIX = 'enc:v1:';
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function parseCsvList(raw) {
  return String(raw || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function toBase64Url(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function fromBase64Url(str) {
  const padded = String(str || '').replace(/-/g, '+').replace(/_/g, '/');
  const padLen = (4 - (padded.length % 4)) % 4;
  const binary = atob(padded + '='.repeat(padLen));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

async function deriveTicketKey(secret) {
  const digest = await crypto.subtle.digest('SHA-256', textEncoder.encode(String(secret)));
  return crypto.subtle.importKey('raw', digest, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

async function sealRefreshToken(refreshToken, encSecret) {
  const raw = String(refreshToken || '').trim();
  if (!raw) return '';
  if (!encSecret) return raw;
  const key = await deriveTicketKey(encSecret);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipherBuf = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    textEncoder.encode(raw)
  );
  const combined = new Uint8Array(iv.length + cipherBuf.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(cipherBuf), iv.length);
  return TICKET_PREFIX + toBase64Url(combined);
}

async function unsealRefreshTicket(ticket, encSecret) {
  const raw = String(ticket || '').trim();
  if (!raw) throw new Error('empty_ticket');
  if (raw.startsWith(TICKET_PREFIX)) {
    if (!encSecret) throw new Error('missing_enc_key');
    const bytes = fromBase64Url(raw.slice(TICKET_PREFIX.length));
    if (bytes.length <= 12) throw new Error('malformed_ticket');
    const key = await deriveTicketKey(encSecret);
    const plainBuf = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: bytes.slice(0, 12) },
      key,
      bytes.slice(12)
    );
    return textDecoder.decode(plainBuf);
  }
  if (encSecret) throw new Error('unsealed_ticket_rejected');
  return raw;
}

function buildCorsHeaders(origin, allowedOrigins) {
  const allowOrigin =
    allowedOrigins.length > 0 ? (origin && allowedOrigins.includes(origin) ? origin : '') : origin || '*';
  const headers = {
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
  if (allowOrigin) {
    headers['Access-Control-Allow-Origin'] = allowOrigin;
  }
  return headers;
}

function jsonResponse(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...extraHeaders,
    },
  });
}

async function postGoogleToken(params) {
  const resp = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
  });
  const data = await resp.json().catch(() => ({}));
  return { ok: resp.ok, status: resp.status, data };
}

export default {
  async fetch(request, env = {}) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin') || '';
    const allowedOrigins = parseCsvList(env.ALLOWED_ORIGINS);
    const corsHeaders = buildCorsHeaders(origin, allowedOrigins);

    if (allowedOrigins.length > 0 && origin && !allowedOrigins.includes(origin)) {
      return jsonResponse({ error: 'origin_not_allowed' }, 403, corsHeaders);
    }

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/health')) {
      return jsonResponse(
        {
          ok: true,
          service: 'drivelens-oauth-renewal',
          hasClientSecret: Boolean(env.GOOGLE_CLIENT_SECRET),
          encryptedTickets: Boolean(env.TICKET_ENC_KEY),
        },
        200,
        corsHeaders
      );
    }

    if (request.method !== 'POST' || (url.pathname !== '/exchange' && url.pathname !== '/refresh')) {
      return jsonResponse({ error: 'not_found' }, 404, corsHeaders);
    }

    if (!env.GOOGLE_CLIENT_SECRET) {
      return jsonResponse({ error: 'server_misconfigured' }, 500, corsHeaders);
    }

    const payload = await request.json().catch(() => null);
    const clientId = String(payload?.client_id || '').trim();
    const allowedClientIds = parseCsvList(env.ALLOWED_CLIENT_IDS);
    if (!clientId) {
      return jsonResponse({ error: 'invalid_request' }, 400, corsHeaders);
    }
    if (allowedClientIds.length > 0 && !allowedClientIds.includes(clientId)) {
      return jsonResponse({ error: 'client_not_allowed' }, 403, corsHeaders);
    }

    if (url.pathname === '/exchange') {
      const code = String(payload?.code || '').trim();
      if (!code) {
        return jsonResponse({ error: 'invalid_request' }, 400, corsHeaders);
      }
      const redirectUri = String(payload?.redirect_uri || 'postmessage').trim() || 'postmessage';
      if (redirectUri !== 'postmessage') {
        let parsedRedirect;
        try {
          parsedRedirect = new URL(redirectUri);
        } catch {
          return jsonResponse({ error: 'invalid_redirect_uri' }, 400, corsHeaders);
        }
        if (parsedRedirect.protocol !== 'https:' && parsedRedirect.protocol !== 'http:') {
          return jsonResponse({ error: 'invalid_redirect_uri' }, 400, corsHeaders);
        }
        if (allowedOrigins.length > 0 && !allowedOrigins.includes(parsedRedirect.origin)) {
          return jsonResponse({ error: 'redirect_origin_not_allowed' }, 403, corsHeaders);
        }
      }
      const tokenRes = await postGoogleToken({
        code,
        client_id: clientId,
        client_secret: env.GOOGLE_CLIENT_SECRET,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
      });
      if (!tokenRes.ok || !tokenRes.data?.access_token) {
        return jsonResponse(
          {
            error: tokenRes.data?.error || 'exchange_failed',
            error_description: tokenRes.data?.error_description || '',
          },
          tokenRes.status >= 400 ? tokenRes.status : 400,
          corsHeaders
        );
      }
      const refreshTicket = tokenRes.data.refresh_token
        ? await sealRefreshToken(tokenRes.data.refresh_token, env.TICKET_ENC_KEY)
        : '';
      return jsonResponse(
        {
          access_token: tokenRes.data.access_token,
          expires_in: tokenRes.data.expires_in,
          scope: tokenRes.data.scope || '',
          token_type: tokenRes.data.token_type || 'Bearer',
          ...(refreshTicket ? { refresh_ticket: refreshTicket } : {}),
        },
        200,
        corsHeaders
      );
    }

    const rawTicket = String(payload?.refresh_ticket || '').trim();
    if (!rawTicket) {
      return jsonResponse({ error: 'invalid_request' }, 400, corsHeaders);
    }
    let refreshToken;
    try {
      refreshToken = await unsealRefreshTicket(rawTicket, env.TICKET_ENC_KEY);
    } catch {
      return jsonResponse({ error: 'invalid_ticket' }, 400, corsHeaders);
    }

    const tokenRes = await postGoogleToken({
      client_id: clientId,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    });
    if (!tokenRes.ok || !tokenRes.data?.access_token) {
      return jsonResponse(
        {
          error: tokenRes.data?.error || 'refresh_failed',
          error_description: tokenRes.data?.error_description || '',
        },
        tokenRes.status >= 400 ? tokenRes.status : 400,
        corsHeaders
      );
    }
    const newTicket = tokenRes.data.refresh_token
      ? await sealRefreshToken(tokenRes.data.refresh_token, env.TICKET_ENC_KEY)
      : '';
    return jsonResponse(
      {
        access_token: tokenRes.data.access_token,
        expires_in: tokenRes.data.expires_in,
        token_type: tokenRes.data.token_type || 'Bearer',
        ...(newTicket ? { refresh_ticket: newTicket } : {}),
      },
      200,
      corsHeaders
    );
  },
};
