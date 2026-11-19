#!/usr/bin/env python3
"""Zero-dependency local stdio MCP Server for DriveLens Google Drive albums.

Exposes read/search, vision thumbnail fetch, and conflict-free LWW write tools
for .drivelens/tags-schema.json and a dedicated AI member file
.drivelens/member-<key>.json using Python 3 stdlib only.
"""

import base64
import hashlib
import json
import math
import os
import re
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid

DRIVE_API = "https://www.googleapis.com/drive/v3"
DRIVE_UPLOAD_API = "https://www.googleapis.com/upload/drive/v3"
GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token"
FOLDER_MIME = "application/vnd.google-apps.folder"
DRIVE_SCOPE = "https://www.googleapis.com/auth/drive"
DRIVE_FILE_FIELDS = (
    "id,name,mimeType,parents,size,createdTime,modifiedTime,thumbnailLink,"
    "imageMediaMetadata(width,height,time,cameraMake,cameraModel,focalLength,"
    "aperture,exposureTime,isoSpeed),"
    "videoMediaMetadata(width,height,durationMillis)"
)
MEDIA_OR_FOLDER_PREDICATE = (
    "trashed = false and "
    "(mimeType = 'application/vnd.google-apps.folder' "
    "or mimeType contains 'image/' or mimeType contains 'video/')"
)
MAX_CRAWL_DEPTH = 6
GROUP_BATCH_SIZE = 25
TAG_COLORS = ("red", "amber", "emerald", "cyan", "blue", "violet", "pink", "slate")
VALID_ASPECTS = ("all", "landscape", "portrait", "square")
VALID_MEDIA_TYPES = ("all", "photo", "video")
VALID_SORTS = (
    "dateDesc",
    "dateAsc",
    "ratingDesc",
    "ratingAsc",
    "nameAsc",
    "nameDesc",
    "sizeDesc",
    "sizeAsc",
)
SHA256_DIGEST_INFO_PREFIX = bytes.fromhex(
    "3031300d060960864801650304020105000420"
)
MEMBER_COLORS = (
    "#38bdf8",
    "#f472b6",
    "#34d399",
    "#fbbf24",
    "#a78bfa",
    "#fb7185",
    "#22d3ee",
    "#60a5fa",
)


def parse_drive_folder_id(raw_input):
    raw = str(raw_input or "").strip()
    if not raw:
        return None
    m_folder = re.search(r"/folders/([a-zA-Z0-9_-]{10,})", raw)
    if m_folder:
        return m_folder.group(1)
    m_query = re.search(r"[?&]id=([a-zA-Z0-9_-]{10,})", raw)
    if m_query:
        return m_query.group(1)
    if re.fullmatch(r"[a-zA-Z0-9_-]{10,}", raw):
        return raw
    return None


def normalize_renewal_endpoint(raw_url):
    trimmed = str(raw_url or "").strip()
    if not trimmed:
        return ""
    parsed = urllib.parse.urlsplit(trimmed)
    is_https = parsed.scheme == "https"
    is_local_http = parsed.scheme == "http" and parsed.hostname in ("localhost", "127.0.0.1")
    if not (is_https or is_local_http) or not parsed.netloc:
        return ""
    clean_path = re.sub(r"/+$", "", parsed.path or "")
    clean_path = re.sub(r"/(exchange|refresh)$", "", clean_path, flags=re.IGNORECASE)
    clean_path = re.sub(r"/+$", "", clean_path)
    return f"{parsed.scheme}://{parsed.netloc}{clean_path}"


def _to_int32(val):
    val &= 0xFFFFFFFF
    return val - 0x100000000 if (val & 0x80000000) else val


def _to_base36(val):
    n = abs(int(val))
    if n == 0:
        return "0"
    digits = "0123456789abcdefghijklmnopqrstuvwxyz"
    out = []
    while n:
        n, rem = divmod(n, 36)
        out.append(digits[rem])
    return "".join(reversed(out))


def sanitize_member_key(member_id):
    """Exact JS-compatible parity with sanitizeMemberKey in src/api/metaSync.js."""
    raw = str(member_id or "member").strip().lower()
    clean = re.sub(r"[^a-z0-9_-]+", "_", raw).strip("_")
    h = 0
    utf16_bytes = raw.encode("utf-16-le")
    for idx in range(0, len(utf16_bytes), 2):
        code_unit = int.from_bytes(utf16_bytes[idx : idx + 2], "little")
        h = _to_int32(((h << 5) & 0xFFFFFFFF) - h + code_unit)
    suffix = _to_base36(abs(h))[:5]
    prefix = clean[:42] or "user"
    return f"{prefix}_{suffix}"


def pick_member_color(seed):
    s = str(seed or "user")
    h = 0
    utf16_bytes = s.encode("utf-16-le")
    for idx in range(0, len(utf16_bytes), 2):
        code_unit = int.from_bytes(utf16_bytes[idx : idx + 2], "little")
        h = _to_int32(h * 31 + code_unit)
    return MEMBER_COLORS[abs(h) % len(MEMBER_COLORS)]


def merge_tag_schemas(local_schema, remote_schema):
    """Last-write-wins merge per tag ID, preserving tombstones."""
    merged_tags = {}
    for source in (remote_schema, local_schema):
        if not isinstance(source, dict):
            continue
        tags = source.get("tags")
        if not isinstance(tags, dict):
            continue
        for tag_id, tag_obj in tags.items():
            if not isinstance(tag_obj, dict):
                continue
            prev = merged_tags.get(tag_id)
            if prev is None:
                merged_tags[tag_id] = dict(tag_obj)
            else:
                cur_ts = float(tag_obj.get("updatedAt") or 0)
                prev_ts = float(prev.get("updatedAt") or 0)
                if source is local_schema:
                    if cur_ts >= prev_ts:
                        merged_tags[tag_id] = dict(tag_obj)
                else:
                    if cur_ts > prev_ts:
                        merged_tags[tag_id] = dict(tag_obj)
    return {"version": 1, "tags": merged_tags}


def _b64url(data):
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def _der_read_tlv(data, offset):
    if offset >= len(data):
        raise ValueError("Unexpected end of DER data")
    tag = data[offset]
    offset += 1
    if offset >= len(data):
        raise ValueError("Truncated DER length")
    length_byte = data[offset]
    offset += 1
    if length_byte < 0x80:
        length = length_byte
    else:
        num_octets = length_byte & 0x7F
        if num_octets == 0 or offset + num_octets > len(data):
            raise ValueError("Invalid DER length encoding")
        length = int.from_bytes(data[offset : offset + num_octets], "big")
        offset += num_octets
    end = offset + length
    if end > len(data):
        raise ValueError("DER element exceeds input length")
    return tag, data[offset:end], end


def _der_read_sequence_children(seq_bytes):
    children = []
    pos = 0
    while pos < len(seq_bytes):
        tag, val, pos = _der_read_tlv(seq_bytes, pos)
        children.append((tag, val))
    return children


def _decode_pem_key_bytes(pem_text):
    lines = []
    for raw_line in str(pem_text or "").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("-----"):
            continue
        lines.append(line)
    if not lines:
        raise ValueError("Empty PEM key material")
    return base64.b64decode("".join(lines).encode("ascii"))


def parse_rsa_private_key_der(der_bytes):
    """Extract (n, e, d) from PKCS#8 PrivateKeyInfo or PKCS#1 RSAPrivateKey DER bytes."""
    outer_tag, outer_val, _ = _der_read_tlv(der_bytes, 0)
    if outer_tag != 0x30:
        raise ValueError("Expected DER SEQUENCE for RSA private key")
    children = _der_read_sequence_children(outer_val)
    if (
        len(children) >= 3
        and children[0][0] == 0x02
        and children[1][0] == 0x30
        and children[2][0] == 0x04
    ):
        inner_tag, inner_val, _ = _der_read_tlv(children[2][1], 0)
        if inner_tag != 0x30:
            raise ValueError("Expected DER SEQUENCE inside PKCS#8 privateKey")
        rsa_fields = _der_read_sequence_children(inner_val)
    else:
        rsa_fields = children

    if len(rsa_fields) < 4:
        raise ValueError("Invalid RSA private key structure")
    for idx in range(4):
        if rsa_fields[idx][0] != 0x02:
            raise ValueError("Expected INTEGER fields in RSAPrivateKey")
    n = int.from_bytes(rsa_fields[1][1], "big")
    e = int.from_bytes(rsa_fields[2][1], "big")
    d = int.from_bytes(rsa_fields[3][1], "big")
    if n <= 0 or d <= 0:
        raise ValueError("Invalid RSA modulus/exponent")
    return n, e, d


def sign_rs256_pkcs1v15(message_bytes, n, d):
    """Sign message_bytes with RSASSA-PKCS1-v1_5 SHA-256 (RFC 8017)."""
    digest = hashlib.sha256(message_bytes).digest()
    t = SHA256_DIGEST_INFO_PREFIX + digest
    k = (n.bit_length() + 7) // 8
    ps_len = k - len(t) - 3
    if ps_len < 8:
        raise ValueError("RSA key modulus too small for SHA-256 DigestInfo")
    em = b"\x00\x01" + (b"\xff" * ps_len) + b"\x00" + t
    m = int.from_bytes(em, "big")
    s = pow(m, d, n)
    return s.to_bytes(k, "big")


def build_signed_jwt(client_email, private_key_pem_or_der, token_uri=GOOGLE_TOKEN_URL, scope=DRIVE_SCOPE, subject=""):
    """Build a short-lived Google OAuth2 RS256 service-account JWT assertion."""
    now = int(time.time())
    header = _b64url(json.dumps({"alg": "RS256", "typ": "JWT"}, separators=(",", ":")).encode("utf-8"))
    claims_obj = {
        "iss": client_email,
        "scope": scope,
        "aud": token_uri or GOOGLE_TOKEN_URL,
        "iat": now,
        "exp": now + 3600,
    }
    if subject:
        claims_obj["sub"] = subject
    claims = _b64url(json.dumps(claims_obj, separators=(",", ":")).encode("utf-8"))
    signing_input = f"{header}.{claims}".encode("ascii")
    if isinstance(private_key_pem_or_der, (bytes, bytearray)):
        der_bytes = bytes(private_key_pem_or_der)
    else:
        der_bytes = _decode_pem_key_bytes(private_key_pem_or_der)
    n, _e, d = parse_rsa_private_key_der(der_bytes)
    sig = sign_rs256_pkcs1v15(signing_input, n, d)
    return f"{header}.{claims}.{_b64url(sig)}"


def parse_timestamp_ms(file_obj):
    if not isinstance(file_obj, dict):
        return 0
    if isinstance(file_obj.get("_ts"), (int, float)):
        return int(file_obj["_ts"])

    def _parse_iso_or_exif(raw):
        s = str(raw or "").strip()
        if not s:
            return 0
        m_exif = re.match(r"^(\d{4}):(\d{2}):(\d{2})\s+(.*)$", s)
        if m_exif:
            s = f"{m_exif.group(1)}-{m_exif.group(2)}-{m_exif.group(3)}T{m_exif.group(4)}"
        if s.endswith("Z"):
            s = s[:-1] + "+00:00"
        elif re.match(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$", s):
            s += "+00:00"
        try:
            import datetime

            dt = datetime.datetime.fromisoformat(s)
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=datetime.timezone.utc)
            return int(dt.timestamp() * 1000)
        except Exception:
            return 0

    exif = file_obj.get("imageMediaMetadata") or {}
    ts = _parse_iso_or_exif(exif.get("time"))
    if ts:
        return ts
    name = str(file_obj.get("name") or "")
    m_sep = re.search(
        r"(?:^|\D)(199\d|20[0-4]\d)[-_.](0[1-9]|1[0-2])[-_.](0[1-9]|[12]\d|3[01])(?:[T _-]+([01]\d|2[0-3])[-_.:]([0-5]\d)(?:[-_.:]([0-5]\d))?)?(?:\D|$)",
        name,
    )
    if m_sep:
        y, mo, d, hh, mm, ss = m_sep.group(1), m_sep.group(2), m_sep.group(3), m_sep.group(4) or "12", m_sep.group(5) or "00", m_sep.group(6) or "00"
        ts = _parse_iso_or_exif(f"{y}-{mo}-{d}T{hh}:{mm}:{ss}+00:00")
        if ts:
            return ts
    mod_ts = _parse_iso_or_exif(file_obj.get("modifiedTime"))
    cre_ts = _parse_iso_or_exif(file_obj.get("createdTime"))
    if mod_ts and cre_ts:
        return min(mod_ts, cre_ts)
    return mod_ts or cre_ts


def normalize_aspect_ratio(file_obj):
    exif = file_obj.get("imageMediaMetadata") or {}
    vid = file_obj.get("videoMediaMetadata") or {}
    w = int(exif.get("width") or vid.get("width") or 0)
    h = int(exif.get("height") or vid.get("height") or 0)
    if w > 0 and h > 0:
        return max(0.45, min(2.6, w / h))
    return 1.5


def escape_drive_query(value):
    return str(value or "").replace("\\", "\\\\").replace("'", "\\'")


def resize_thumb_url(raw_url, size):
    url = str(raw_url or "").strip()
    if not url:
        return ""
    clamped = max(120, min(1600, int(size or 800)))
    replaced = re.sub(r"=s\d+(?=$|[?&])", f"=s{clamped}", url)
    if replaced != url:
        return replaced
    replaced = re.sub(r"=w\d+(?:-h\d+)?(?=$|[?&])", f"=s{clamped}", url)
    if replaced != url:
        return replaced
    return url


class DriveAuthManager:
    """Thread-safe OAuth token manager supporting Service Account, Worker renewal, or Refresh Token."""

    def __init__(self, env=None, opener=None):
        self.env = env if env is not None else os.environ
        self._lock = threading.Lock()
        self._access_token = str(self.env.get("GOOGLE_ACCESS_TOKEN") or "").strip()
        self._expires_at = time.time() + 3300 if self._access_token else 0.0
        self._renewal_url = normalize_renewal_endpoint(self.env.get("DRIVELENS_RENEWAL_URL") or "")
        self._client_id = str(
            self.env.get("DRIVELENS_CLIENT_ID") or self.env.get("GOOGLE_CLIENT_ID") or ""
        ).strip()
        self._refresh_ticket = str(self.env.get("DRIVELENS_REFRESH_TICKET") or "").strip()
        self._origin = str(self.env.get("DRIVELENS_ORIGIN") or "").strip()
        self._client_secret = str(self.env.get("GOOGLE_CLIENT_SECRET") or "").strip()
        self._refresh_token = str(self.env.get("GOOGLE_REFRESH_TOKEN") or "").strip()
        self._impersonate_user = str(self.env.get("GOOGLE_IMPERSONATE_USER") or "").strip()
        self._opener = opener or urllib.request.build_opener()
        self._service_account = self._load_service_account(self.env.get("GOOGLE_SERVICE_ACCOUNT_JSON") or "")

    @staticmethod
    def _load_service_account(raw_val):
        raw = str(raw_val or "").strip()
        if not raw:
            return None
        if raw.startswith("{"):
            doc = json.loads(raw)
        else:
            with open(raw, "r", encoding="utf-8") as fp:
                doc = json.load(fp)
        if not isinstance(doc, dict) or not doc.get("client_email") or not doc.get("private_key"):
            raise ValueError("GOOGLE_SERVICE_ACCOUNT_JSON must contain client_email and private_key")
        return doc

    def auth_mode(self):
        if self._service_account:
            return "service_account"
        if self._renewal_url and self._client_id and self._refresh_ticket:
            return "worker_renewal"
        if self._client_id and self._client_secret and self._refresh_token:
            return "oauth_refresh_token"
        if self._access_token:
            return "static_access_token"
        return "unconfigured"

    def _http_post(self, url, body_bytes, headers):
        req = urllib.request.Request(url, data=body_bytes, method="POST")
        req.add_header("User-Agent", "DriveLens-MCP/1.0")
        for k, v in headers.items():
            req.add_header(k, v)
        with self._opener.open(req, timeout=30) as resp:
            return resp.status, json.loads(resp.read().decode("utf-8"))

    def _refresh_via_service_account(self):
        token_uri = str(self._service_account.get("token_uri") or GOOGLE_TOKEN_URL).strip()
        assertion = build_signed_jwt(
            self._service_account["client_email"],
            self._service_account["private_key"],
            token_uri=token_uri,
            scope=DRIVE_SCOPE,
            subject=self._impersonate_user,
        )
        form = urllib.parse.urlencode(
            {
                "grant_type": "urn:ietf:params:oauth:grant-type:jwt-bearer",
                "assertion": assertion,
            }
        ).encode("ascii")
        _status, data = self._http_post(
            token_uri,
            form,
            {"Content-Type": "application/x-www-form-urlencoded", "Accept": "application/json"},
        )
        token = str(data.get("access_token") or "").strip()
        if not token:
            raise RuntimeError(f"Service account token exchange failed: {data!r}")
        expires_in = max(60, int(data.get("expires_in") or 3600))
        return token, time.time() + expires_in

    def _refresh_via_worker(self):
        payload = json.dumps(
            {
                "client_id": self._client_id,
                "refresh_ticket": self._refresh_ticket,
            }
        ).encode("utf-8")
        headers = {
            "Content-Type": "application/json; charset=utf-8",
            "Accept": "application/json",
        }
        if self._origin:
            headers["Origin"] = self._origin
        _status, data = self._http_post(f"{self._renewal_url}/refresh", payload, headers)
        token = str(data.get("access_token") or "").strip()
        if not token:
            raise RuntimeError(f"Worker /refresh failed: {data!r}")
        rotated_ticket = str(data.get("refresh_ticket") or "").strip()
        if rotated_ticket:
            self._refresh_ticket = rotated_ticket
        expires_in = max(60, int(data.get("expires_in") or 3600))
        return token, time.time() + expires_in

    def _refresh_via_direct_token(self):
        form = urllib.parse.urlencode(
            {
                "client_id": self._client_id,
                "client_secret": self._client_secret,
                "refresh_token": self._refresh_token,
                "grant_type": "refresh_token",
            }
        ).encode("ascii")
        _status, data = self._http_post(
            GOOGLE_TOKEN_URL,
            form,
            {"Content-Type": "application/x-www-form-urlencoded", "Accept": "application/json"},
        )
        token = str(data.get("access_token") or "").strip()
        if not token:
            raise RuntimeError(f"Google token refresh failed: {data!r}")
        expires_in = max(60, int(data.get("expires_in") or 3600))
        return token, time.time() + expires_in

    def get_access_token(self, force_refresh=False):
        with self._lock:
            now = time.time()
            if not force_refresh and self._access_token and now < self._expires_at - 300:
                return self._access_token

            mode = self.auth_mode()
            if mode == "service_account":
                token, exp = self._refresh_via_service_account()
            elif mode == "worker_renewal":
                token, exp = self._refresh_via_worker()
            elif mode == "oauth_refresh_token":
                token, exp = self._refresh_via_direct_token()
            elif mode == "static_access_token" and not force_refresh:
                return self._access_token
            else:
                raise RuntimeError(
                    "Missing DriveLens MCP authentication. Configure GOOGLE_SERVICE_ACCOUNT_JSON, "
                    "or DRIVELENS_RENEWAL_URL + DRIVELENS_CLIENT_ID + DRIVELENS_REFRESH_TICKET."
                )

            self._access_token = token
            self._expires_at = exp
            return token


class DriveHttpTransport:
    """Minimal HTTPS client for Google Drive v3 API with retry + 401 refresh."""

    def __init__(self, auth_manager, opener=None):
        self.auth = auth_manager
        self._opener = opener or urllib.request.build_opener()

    def request(self, method, url, body=None, headers=None, expect_json=True):
        req_headers = dict(headers or {})
        for attempt in range(4):
            force = attempt > 0 and req_headers.pop("_force_refresh", False)
            token = self.auth.get_access_token(force_refresh=force)
            merged_headers = {
                "User-Agent": "DriveLens-MCP/1.0",
                "Authorization": f"Bearer {token}",
                **req_headers,
            }
            req = urllib.request.Request(url, data=body, method=method)
            for k, v in merged_headers.items():
                req.add_header(k, v)
            try:
                with self._opener.open(req, timeout=45) as resp:
                    raw = resp.read()
                    ct = resp.headers.get("Content-Type", "")
                    if expect_json:
                        return json.loads(raw.decode("utf-8")) if raw else {}
                    return raw, ct
            except urllib.error.HTTPError as err:
                status = err.code
                err_body = ""
                try:
                    err_body = err.read().decode("utf-8", errors="replace")
                except Exception:
                    pass
                if status == 401 and attempt == 0:
                    req_headers["_force_refresh"] = True
                    continue
                if status in (429, 500, 502, 503, 504) and attempt < 3:
                    time.sleep(min(4.0, 0.5 * (2 ** attempt)))
                    continue
                raise RuntimeError(f"Google Drive HTTP {status}: {err_body[:300]}")
        raise RuntimeError("Drive API request failed after retries")


class DriveLensClient:
    """DriveLens album index + conflict-free LWW .drivelens metadata manager."""

    def __init__(
        self,
        folder_input,
        transport,
        member_id="ai_assistant",
        member_name="AI Assistant",
        member_color="#a78bfa",
        cache_ttl_sec=120,
    ):
        self.folder_id = parse_drive_folder_id(folder_input)
        if not self.folder_id:
            raise ValueError("Invalid or missing DRIVELENS_FOLDER_ID")
        self.transport = transport
        self.member_id = str(member_id or "ai_assistant").strip() or "ai_assistant"
        self.member_name = str(member_name or "AI Assistant").strip() or "AI Assistant"
        self.member_color = str(member_color or pick_member_color(self.member_id)).strip()
        self.member_key = sanitize_member_key(self.member_id)
        self.cache_ttl_sec = max(10, int(cache_ttl_sec or 120))
        self._lock = threading.RLock()
        self._index = None
        self._loaded_at = 0.0

    def _drive_json(self, method, path_or_url, body=None, headers=None):
        url = path_or_url if path_or_url.startswith("https://") else f"{DRIVE_API}{path_or_url}"
        return self.transport.request(method, url, body=body, headers=headers, expect_json=True)

    def _list_grouped_children(self, folder_ids, fields, predicate):
        if not folder_ids:
            return []
        parent_clauses = " or ".join(f"'{escape_drive_query(fid)}' in parents" for fid in folder_ids)
        q = f"{parent_clauses} and {predicate}" if len(folder_ids) == 1 else f"({parent_clauses}) and {predicate}"
        out = []
        page_token = ""
        try:
            while True:
                params = {
                    "q": q,
                    "fields": fields,
                    "pageSize": "1000",
                    "supportsAllDrives": "true",
                    "includeItemsFromAllDrives": "true",
                }
                if page_token:
                    params["pageToken"] = page_token
                qs = urllib.parse.urlencode(params)
                data = self._drive_json("GET", f"/files?{qs}")
                out.extend(data.get("files") or [])
                page_token = str(data.get("nextPageToken") or "")
                if not page_token:
                    break
        except RuntimeError as exc:
            if len(folder_ids) > 1 and ("400" in str(exc) or "403" in str(exc)):
                mid = len(folder_ids) // 2
                return self._list_grouped_children(folder_ids[:mid], fields, predicate) + self._list_grouped_children(
                    folder_ids[mid:], fields, predicate
                )
            raise
        return out

    def _fetch_json_file(self, file_id):
        return self._drive_json(
            "GET",
            f"/files/{urllib.parse.quote(file_id, safe='')}?alt=media&supportsAllDrives=true",
        )

    def _find_child_json(self, meta_folder_id, filename):
        safe_name = escape_drive_query(filename)
        q = (
            f"'{escape_drive_query(meta_folder_id)}' in parents and name = '{safe_name}' "
            f"and trashed = false and mimeType = 'application/json'"
        )
        qs = urllib.parse.urlencode(
            {
                "q": q,
                "fields": "files(id,name)",
                "pageSize": "5",
                "supportsAllDrives": "true",
                "includeItemsFromAllDrives": "true",
            }
        )
        data = self._drive_json("GET", f"/files?{qs}")
        files = data.get("files") or []
        return files[0]["id"] if files else None

    def _create_json_file(self, parent_id, filename, payload):
        boundary = f"drivelens_mcp_{int(time.time() * 1000)}_{uuid.uuid4().hex[:8]}"
        meta_json = json.dumps(
            {
                "name": filename,
                "mimeType": "application/json",
                "parents": [parent_id],
            },
            separators=(",", ":"),
        )
        content_json = json.dumps(payload, ensure_ascii=False)
        body = (
            f"--{boundary}\r\n"
            f"Content-Type: application/json; charset=UTF-8\r\n\r\n"
            f"{meta_json}\r\n"
            f"--{boundary}\r\n"
            f"Content-Type: application/json; charset=UTF-8\r\n\r\n"
            f"{content_json}\r\n"
            f"--{boundary}--"
        ).encode("utf-8")
        created = self._drive_json(
            "POST",
            f"{DRIVE_UPLOAD_API}/files?uploadType=multipart&supportsAllDrives=true",
            body=body,
            headers={"Content-Type": f"multipart/related; boundary={boundary}"},
        )
        return created["id"]

    def _update_json_file(self, file_id, payload):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self._drive_json(
            "PATCH",
            f"{DRIVE_UPLOAD_API}/files/{urllib.parse.quote(file_id, safe='')}?uploadType=media&supportsAllDrives=true",
            body=body,
            headers={"Content-Type": "application/json; charset=utf-8"},
        )
        return file_id

    def _ensure_meta_folder(self):
        idx = self.ensure_index()
        if idx["meta_folder_id"]:
            return idx["meta_folder_id"]
        q = (
            f"'{escape_drive_query(self.folder_id)}' in parents and name = '.drivelens' "
            f"and mimeType = '{FOLDER_MIME}' and trashed = false"
        )
        qs = urllib.parse.urlencode(
            {
                "q": q,
                "fields": "files(id,name)",
                "pageSize": "5",
                "supportsAllDrives": "true",
                "includeItemsFromAllDrives": "true",
            }
        )
        found = self._drive_json("GET", f"/files?{qs}").get("files") or []
        if found:
            idx["meta_folder_id"] = found[0]["id"]
            return idx["meta_folder_id"]
        created = self._drive_json(
            "POST",
            "/files?supportsAllDrives=true",
            body=json.dumps(
                {
                    "name": ".drivelens",
                    "mimeType": FOLDER_MIME,
                    "parents": [self.folder_id],
                }
            ).encode("utf-8"),
            headers={"Content-Type": "application/json; charset=utf-8"},
        )
        idx["meta_folder_id"] = created["id"]
        return idx["meta_folder_id"]

    def ensure_index(self, force_refresh=False):
        with self._lock:
            now = time.time()
            if (
                not force_refresh
                and self._index is not None
                and (now - self._loaded_at) < self.cache_ttl_sec
            ):
                return self._index

            root_qs = urllib.parse.urlencode(
                {
                    "fields": "id,name,mimeType,capabilities(canAddChildren,canEdit)",
                    "supportsAllDrives": "true",
                }
            )
            root_meta = self._drive_json(
                "GET", f"/files/{urllib.parse.quote(self.folder_id, safe='')}?{root_qs}"
            )
            if root_meta.get("mimeType") != FOLDER_MIME:
                raise RuntimeError("Target ID is not a Google Drive folder")

            caps = root_meta.get("capabilities") or {}
            can_write = bool(caps.get("canAddChildren") if caps.get("canAddChildren") is not None else caps.get("canEdit", False))
            root_folder = {
                "id": root_meta["id"],
                "name": root_meta.get("name") or "Shared Album",
                "parentId": None,
                "depth": 0,
                "canWrite": can_write,
            }
            folders = [root_folder]
            folders_by_id = {root_folder["id"]: root_folder}
            files = []
            files_by_id = {}
            seen_files = set()
            visited_folders = {root_folder["id"]}
            meta_folder_id = None
            queue = [(root_folder["id"], 0)]

            while queue:
                wave = queue
                queue = []
                for i in range(0, len(wave), GROUP_BATCH_SIZE):
                    batch = wave[i : i + GROUP_BATCH_SIZE]
                    batch_ids = [b[0] for b in batch]
                    depth_map = {b[0]: b[1] for b in batch}
                    batch_id_set = set(batch_ids)
                    entries = self._list_grouped_children(
                        batch_ids,
                        f"nextPageToken,files({DRIVE_FILE_FIELDS})",
                        MEDIA_OR_FOLDER_PREDICATE,
                    )
                    for entry in entries:
                        parents = entry.get("parents") or []
                        parent_id = next((p for p in parents if p in batch_id_set), None)
                        if not parent_id:
                            parent_id = parents[0] if parents else root_folder["id"]
                        parent_depth = depth_map.get(parent_id, 0)
                        name = str(entry.get("name") or "")
                        if entry.get("mimeType") == FOLDER_MIME:
                            if name == ".drivelens" and parent_id == root_folder["id"]:
                                meta_folder_id = entry["id"]
                                continue
                            if name.startswith("."):
                                continue
                            if entry["id"] not in visited_folders and parent_depth + 1 <= MAX_CRAWL_DEPTH:
                                visited_folders.add(entry["id"])
                                fnode = {
                                    "id": entry["id"],
                                    "name": name,
                                    "parentId": parent_id,
                                    "depth": parent_depth + 1,
                                }
                                folders.append(fnode)
                                folders_by_id[fnode["id"]] = fnode
                                queue.append((fnode["id"], fnode["depth"]))
                        elif entry.get("id") and entry["id"] not in seen_files:
                            seen_files.add(entry["id"])
                            norm = {
                                "id": entry["id"],
                                "name": name,
                                "parentId": parent_id,
                                "mimeType": entry.get("mimeType") or "image/jpeg",
                                "size": int(entry.get("size") or 0),
                                "createdTime": entry.get("createdTime") or "",
                                "modifiedTime": entry.get("modifiedTime") or "",
                                "thumbnailLink": entry.get("thumbnailLink") or "",
                                "imageMediaMetadata": entry.get("imageMediaMetadata"),
                                "videoMediaMetadata": entry.get("videoMediaMetadata"),
                            }
                            norm["_ts"] = parse_timestamp_ms(norm)
                            norm["_aspect"] = normalize_aspect_ratio(norm)
                            norm["_isVideo"] = str(norm["mimeType"]).startswith("video/")
                            files.append(norm)
                            files_by_id[norm["id"]] = norm

            tag_schema_file_id = None
            tag_schema = {"version": 1, "tags": {}}
            member_files_by_id = {}
            members_data = {}

            if meta_folder_id:
                mq = f"'{escape_drive_query(meta_folder_id)}' in parents and trashed = false and mimeType = 'application/json'"
                mqs = urllib.parse.urlencode(
                    {
                        "q": mq,
                        "fields": "files(id,name,modifiedTime)",
                        "pageSize": "200",
                        "supportsAllDrives": "true",
                        "includeItemsFromAllDrives": "true",
                    }
                )
                meta_files = self._drive_json("GET", f"/files?{mqs}").get("files") or []
                for mf in meta_files:
                    try:
                        doc = self._fetch_json_file(mf["id"])
                    except Exception:
                        continue
                    mname = str(mf.get("name") or "")
                    if mname == "tags-schema.json":
                        tag_schema_file_id = mf["id"]
                        if isinstance(doc, dict) and isinstance(doc.get("tags"), dict):
                            tag_schema = {"version": 1, "tags": doc["tags"]}
                    elif mname.startswith("member-") and mname.endswith(".json") and isinstance(doc, dict):
                        mid = str((doc.get("member") or {}).get("id") or mname[7:-5])
                        member_files_by_id[mid] = mf["id"]
                        members_data[mid] = doc

            self._index = {
                "root_folder": root_folder,
                "folders": folders,
                "folders_by_id": folders_by_id,
                "files": files,
                "files_by_id": files_by_id,
                "can_write": can_write,
                "meta_folder_id": meta_folder_id,
                "tag_schema_file_id": tag_schema_file_id,
                "tag_schema": tag_schema,
                "member_files_by_id": member_files_by_id,
                "members_data": members_data,
            }
            self._loaded_at = time.time()
            return self._index

    def get_aggregated_meta(self, photo_id, idx=None):
        index = idx or self.ensure_index()
        members_data = index["members_data"]
        schema_tags = (index["tag_schema"] or {}).get("tags") or {}
        ratings_by_member = []
        notes_by_member = []
        tag_latest = {}
        sum_rating = 0
        rating_count = 0
        fav_count = 0
        my_rating = 0
        my_favorite = False
        my_note = ""

        for member_id, record in members_data.items():
            if not isinstance(record, dict):
                continue
            item = (record.get("items") or {}).get(photo_id)
            if not isinstance(item, dict):
                continue
            member_info = dict(record.get("member") or {"id": member_id, "name": member_id, "color": "#60a5fa"})
            member_info["id"] = member_id
            r = int(item.get("rating") or 0)
            fav = bool(item.get("favorite"))
            note = str(item.get("note") or "")
            upd = int(item.get("updatedAt") or 0)
            if member_id == self.member_id:
                my_rating = r
                my_favorite = fav
                my_note = note
            if r > 0:
                sum_rating += r
                rating_count += 1
            if fav:
                fav_count += 1
            if r > 0 or fav:
                ratings_by_member.append(
                    {"member": member_info, "rating": r, "favorite": fav, "updatedAt": upd}
                )
            if note.strip():
                notes_by_member.append(
                    {"member": member_info, "note": note, "updatedAt": upd}
                )
            tags_map = item.get("tags")
            if isinstance(tags_map, dict):
                for tag_id, entry in tags_map.items():
                    if not isinstance(entry, dict):
                        continue
                    ts = int(entry.get("updatedAt") or 0)
                    prev = tag_latest.get(tag_id)
                    if prev is None or ts >= prev[1]:
                        tag_latest[tag_id] = (bool(entry.get("active")), ts)

        active_tag_ids = []
        for tag_id, (active, _ts) in tag_latest.items():
            tdef = schema_tags.get(tag_id)
            if active and isinstance(tdef, dict) and not tdef.get("deleted"):
                active_tag_ids.append(tag_id)

        return {
            "myRating": my_rating,
            "myFavorite": my_favorite,
            "myNote": my_note,
            "avgRating": (sum_rating / rating_count) if rating_count > 0 else 0.0,
            "ratingCount": rating_count,
            "favoriteCount": fav_count,
            "ratingsByMember": ratings_by_member,
            "notesByMember": notes_by_member,
            "activeTagIds": active_tag_ids,
        }

    def _folder_descendants(self, folder_id, idx):
        allowed = {folder_id}
        added = True
        folders = idx["folders"]
        while added:
            added = False
            for f in folders:
                pid = f.get("parentId")
                if pid and pid in allowed and f["id"] not in allowed:
                    allowed.add(f["id"])
                    added = True
        return allowed

    def get_album_stats(self):
        idx = self.ensure_index()
        files = idx["files"]
        schema_tags = (idx["tag_schema"] or {}).get("tags") or {}
        active_tags = {tid: tdef for tid, tdef in schema_tags.items() if isinstance(tdef, dict) and not tdef.get("deleted")}
        rated = 0
        favorited = 0
        tagged = 0
        videos = 0
        tag_counts = {tid: 0 for tid in active_tags}

        for f in files:
            if f["_isVideo"]:
                videos += 1
            meta = self.get_aggregated_meta(f["id"], idx)
            if meta["ratingCount"] > 0:
                rated += 1
            if meta["favoriteCount"] > 0:
                favorited += 1
            if meta["activeTagIds"]:
                tagged += 1
                for tid in meta["activeTagIds"]:
                    tag_counts[tid] = tag_counts.get(tid, 0) + 1

        return {
            "albumName": idx["root_folder"]["name"],
            "folderId": self.folder_id,
            "canWrite": idx["can_write"],
            "aiMemberId": self.member_id,
            "aiMemberName": self.member_name,
            "totalItems": len(files),
            "photosCount": len(files) - videos,
            "videosCount": videos,
            "folderCount": len(idx["folders"]),
            "ratedCount": rated,
            "unratedCount": max(0, len(files) - rated),
            "favoritedCount": favorited,
            "taggedCount": tagged,
            "untaggedCount": max(0, len(files) - tagged),
            "activeTagCount": len(active_tags),
            "memberCount": len(idx["members_data"]),
            "tagCounts": tag_counts,
        }

    def list_folders(self):
        idx = self.ensure_index()
        direct_counts = {}
        for f in idx["files"]:
            pid = f.get("parentId") or ""
            direct_counts[pid] = direct_counts.get(pid, 0) + 1
        return {
            "rootFolderId": idx["root_folder"]["id"],
            "folders": [
                {
                    "id": fl["id"],
                    "name": fl["name"],
                    "parentId": fl["parentId"],
                    "depth": fl["depth"],
                    "directMediaCount": direct_counts.get(fl["id"], 0),
                }
                for fl in idx["folders"]
            ],
        }

    def search_photos(
        self,
        folder_id=None,
        include_subfolders=True,
        query="",
        tag_ids=None,
        tag_match_mode="OR",
        min_rating=0,
        favorites_only=False,
        unrated_only=False,
        untagged_only=False,
        media_type="all",
        aspect="all",
        sort_by="dateDesc",
        limit=50,
        offset=0,
    ):
        idx = self.ensure_index()
        allowed_folders = None
        if folder_id:
            if folder_id not in idx["folders_by_id"]:
                raise ValueError(f"Unknown folder_id: {folder_id}")
            allowed_folders = (
                self._folder_descendants(folder_id, idx) if include_subfolders else {folder_id}
            )
        q_lower = str(query or "").strip().lower()
        req_tags = [str(tid).strip() for tid in (tag_ids or []) if str(tid).strip()]
        req_tag_set = set(req_tags)
        match_mode = "AND" if str(tag_match_mode or "OR").upper() == "AND" else "OR"
        min_r = float(min_rating or 0)
        media_f = media_type if media_type in VALID_MEDIA_TYPES else "all"
        aspect_f = aspect if aspect in VALID_ASPECTS else "all"
        sort_mode = sort_by if sort_by in VALID_SORTS else "dateDesc"
        lim = max(1, min(200, int(limit or 50)))
        off = max(0, int(offset or 0))
        schema_tags = (idx["tag_schema"] or {}).get("tags") or {}

        matched = []
        for f in idx["files"]:
            if allowed_folders is not None and f.get("parentId") not in allowed_folders:
                continue
            if media_f == "photo" and f["_isVideo"]:
                continue
            if media_f == "video" and not f["_isVideo"]:
                continue
            ratio = f["_aspect"]
            if aspect_f == "landscape" and ratio <= 1.08:
                continue
            if aspect_f == "portrait" and ratio >= 0.92:
                continue
            if aspect_f == "square" and (ratio < 0.92 or ratio > 1.08):
                continue

            meta = self.get_aggregated_meta(f["id"], idx)
            if favorites_only and meta["favoriteCount"] == 0:
                continue
            if unrated_only and meta["ratingCount"] > 0:
                continue
            if untagged_only and meta["activeTagIds"]:
                continue
            if min_r > 0 and meta["avgRating"] < min_r:
                continue
            if req_tags:
                item_tag_set = set(meta["activeTagIds"])
                if match_mode == "AND":
                    if not req_tag_set.issubset(item_tag_set):
                        continue
                elif not (req_tag_set & item_tag_set):
                    continue

            if q_lower:
                exif = f.get("imageMediaMetadata") or {}
                haystack_parts = [
                    str(f.get("name") or ""),
                    str(exif.get("cameraMake") or ""),
                    str(exif.get("cameraModel") or ""),
                    str(f.get("createdTime") or ""),
                    " ".join(n["note"] for n in meta["notesByMember"]),
                    " ".join(
                        str((schema_tags.get(tid) or {}).get("name") or "")
                        for tid in meta["activeTagIds"]
                    ),
                ]
                if q_lower not in " ".join(haystack_parts).lower():
                    continue

            matched.append((f, meta))

        def sort_key(pair):
            f, meta = pair
            if sort_mode == "dateAsc":
                return (f["_ts"], f["id"])
            if sort_mode == "ratingDesc":
                return (-meta["avgRating"], -meta["ratingCount"], -f["_ts"], f["id"])
            if sort_mode == "ratingAsc":
                return (meta["avgRating"], meta["ratingCount"], f["_ts"], f["id"])
            if sort_mode == "nameAsc":
                return (f["name"].lower(), f["id"])
            if sort_mode == "nameDesc":
                return f["id"]
            if sort_mode == "sizeDesc":
                return (-f["size"], f["id"])
            if sort_mode == "sizeAsc":
                return (f["size"], f["id"])
            return (-f["_ts"], f["id"])

        if sort_mode == "nameDesc":
            matched.sort(key=lambda pair: (pair[0]["name"].lower(), pair[0]["id"]), reverse=True)
        else:
            matched.sort(key=sort_key)

        page = matched[off : off + lim]
        items = []
        for f, meta in page:
            items.append(
                {
                    "id": f["id"],
                    "name": f["name"],
                    "parentId": f["parentId"],
                    "folderName": (idx["folders_by_id"].get(f["parentId"]) or {}).get("name") or "",
                    "mimeType": f["mimeType"],
                    "size": f["size"],
                    "createdTime": f["createdTime"],
                    "aspectRatio": round(f["_aspect"], 3),
                    "avgRating": round(meta["avgRating"], 2),
                    "ratingCount": meta["ratingCount"],
                    "myRating": meta["myRating"],
                    "myFavorite": meta["myFavorite"],
                    "favoriteCount": meta["favoriteCount"],
                    "activeTagIds": meta["activeTagIds"],
                    "activeTagNames": [
                        (schema_tags.get(tid) or {}).get("name") or tid
                        for tid in meta["activeTagIds"]
                    ],
                }
            )
        return {
            "total": len(matched),
            "offset": off,
            "limit": lim,
            "hasMore": (off + lim) < len(matched),
            "items": items,
        }

    def get_photo_details(self, photo_id):
        idx = self.ensure_index()
        f = idx["files_by_id"].get(photo_id)
        if not f:
            raise ValueError(f"Photo not found in album: {photo_id}")
        meta = self.get_aggregated_meta(photo_id, idx)
        schema_tags = (idx["tag_schema"] or {}).get("tags") or {}
        return {
            "id": f["id"],
            "name": f["name"],
            "parentId": f["parentId"],
            "folderName": (idx["folders_by_id"].get(f["parentId"]) or {}).get("name") or "",
            "mimeType": f["mimeType"],
            "size": f["size"],
            "createdTime": f["createdTime"],
            "modifiedTime": f["modifiedTime"],
            "aspectRatio": round(f["_aspect"], 3),
            "imageMediaMetadata": f.get("imageMediaMetadata"),
            "videoMediaMetadata": f.get("videoMediaMetadata"),
            "meta": {
                **meta,
                "activeTags": [
                    {
                        "id": tid,
                        "name": (schema_tags.get(tid) or {}).get("name") or tid,
                        "color": (schema_tags.get(tid) or {}).get("color") or "blue",
                        "group": (schema_tags.get(tid) or {}).get("group") or "",
                    }
                    for tid in meta["activeTagIds"]
                ],
            },
        }

    def get_photo_image(self, photo_id, size=800):
        idx = self.ensure_index()
        f = idx["files_by_id"].get(photo_id)
        if not f:
            raise ValueError(f"Photo not found in album: {photo_id}")
        target_size = max(120, min(1600, int(size or 800)))
        thumb_url = resize_thumb_url(f.get("thumbnailLink") or "", target_size)

        candidates = []
        if thumb_url:
            candidates.append(thumb_url)
        fresh_qs = urllib.parse.urlencode({"fields": "thumbnailLink", "supportsAllDrives": "true"})
        try:
            fresh = self._drive_json(
                "GET", f"/files/{urllib.parse.quote(photo_id, safe='')}?{fresh_qs}"
            )
            fresh_link = resize_thumb_url(fresh.get("thumbnailLink") or "", target_size)
            if fresh_link and fresh_link not in candidates:
                candidates.insert(0, fresh_link)
                f["thumbnailLink"] = fresh.get("thumbnailLink") or ""
        except Exception:
            pass
        candidates.append(f"https://lh3.googleusercontent.com/d/{urllib.parse.quote(photo_id, safe='')}=s{target_size}")
        if not f["_isVideo"] and int(f.get("size") or 0) <= 15 * 1024 * 1024:
            candidates.append(f"{DRIVE_API}/files/{urllib.parse.quote(photo_id, safe='')}?alt=media&supportsAllDrives=true")

        for candidate in candidates:
            try:
                raw, ct = self.transport.request("GET", candidate, expect_json=False)
                mime = (ct.split(";")[0] or "image/jpeg").strip().lower()
                if raw and mime.startswith("image/"):
                    return {
                        "photoId": f["id"],
                        "name": f["name"],
                        "mimeType": mime,
                        "byteLength": len(raw),
                        "base64": base64.b64encode(raw).decode("ascii"),
                    }
            except Exception:
                continue
        raise RuntimeError(f"Failed to fetch preview image bytes for photo {photo_id}")

    def list_tags(self):
        idx = self.ensure_index()
        schema_tags = (idx["tag_schema"] or {}).get("tags") or {}
        stats = self.get_album_stats()
        counts = stats["tagCounts"]
        tags = []
        for tid, tdef in schema_tags.items():
            if not isinstance(tdef, dict) or tdef.get("deleted"):
                continue
            tags.append(
                {
                    "id": tid,
                    "name": tdef.get("name") or tid,
                    "color": tdef.get("color") or "blue",
                    "group": tdef.get("group") or "",
                    "updatedAt": int(tdef.get("updatedAt") or 0),
                    "photoCount": counts.get(tid, 0),
                }
            )
        tags.sort(key=lambda t: (t["group"].lower(), t["name"].lower(), t["id"]))
        return {"tags": tags}

    def _persist_tag_schema(self, new_schema, idx):
        meta_folder_id = self._ensure_meta_folder()
        file_id = idx["tag_schema_file_id"]
        if not file_id:
            file_id = self._find_child_json(meta_folder_id, "tags-schema.json")
        if file_id:
            try:
                remote_doc = self._fetch_json_file(file_id)
            except Exception:
                remote_doc = None
            merged = merge_tag_schemas(new_schema, remote_doc or {"version": 1, "tags": {}})
            self._update_json_file(file_id, merged)
        else:
            merged = merge_tag_schemas(new_schema, {"version": 1, "tags": {}})
            file_id = self._create_json_file(meta_folder_id, "tags-schema.json", merged)
        idx["tag_schema_file_id"] = file_id
        idx["tag_schema"] = merged
        return merged

    def upsert_tag(self, name, tag_id=None, color="blue", group="AI"):
        clean_name = str(name or "").strip()
        if not clean_name:
            raise ValueError("Tag name cannot be empty")
        idx = self.ensure_index()
        if not idx["can_write"]:
            raise RuntimeError("Drive folder is read-only; cannot write tags")
        clean_color = color if color in TAG_COLORS else "blue"
        clean_group = str(group or "").strip() or "Custom Tags"
        cur_tags = dict((idx["tag_schema"] or {}).get("tags") or {})

        resolved_id = str(tag_id or "").strip()
        if not resolved_id:
            for existing_id, existing in cur_tags.items():
                if (
                    isinstance(existing, dict)
                    and not existing.get("deleted")
                    and str(existing.get("name") or "").strip().lower() == clean_name.lower()
                ):
                    resolved_id = existing_id
                    break
        if not resolved_id:
            resolved_id = f"tag-{uuid.uuid4().hex[:10]}"

        now_ms = int(time.time() * 1000)
        next_tag = {
            "id": resolved_id,
            "name": clean_name,
            "color": clean_color,
            "group": clean_group,
            "deleted": False,
            "updatedAt": now_ms,
        }
        cur_tags[resolved_id] = next_tag
        self._persist_tag_schema({"version": 1, "tags": cur_tags}, idx)
        return next_tag

    def delete_tag(self, tag_id):
        tid = str(tag_id or "").strip()
        if not tid:
            raise ValueError("tag_id is required")
        idx = self.ensure_index()
        if not idx["can_write"]:
            raise RuntimeError("Drive folder is read-only; cannot delete tags")
        cur_tags = dict((idx["tag_schema"] or {}).get("tags") or {})
        existing = cur_tags.get(tid)
        if not isinstance(existing, dict):
            raise ValueError(f"Tag not found: {tid}")
        now_ms = int(time.time() * 1000)
        cur_tags[tid] = {**existing, "deleted": True, "updatedAt": now_ms}
        self._persist_tag_schema({"version": 1, "tags": cur_tags}, idx)
        return {"deleted": True, "tagId": tid}

    def _validate_photo_ids(self, photo_ids, idx):
        cleaned = []
        seen = set()
        for pid in photo_ids or []:
            s = str(pid or "").strip()
            if not s or s in seen:
                continue
            if s not in idx["files_by_id"]:
                raise ValueError(f"Photo ID not found in configured album: {s}")
            seen.add(s)
            cleaned.append(s)
        if not cleaned:
            raise ValueError("photo_ids must contain at least one valid album photo ID")
        return cleaned

    def _save_my_member_record(self, mutator_fn, idx):
        meta_folder_id = self._ensure_meta_folder()
        filename = f"member-{self.member_key}.json"
        file_id = idx["member_files_by_id"].get(self.member_id)
        if not file_id:
            file_id = self._find_child_json(meta_folder_id, filename)

        remote_doc = None
        if file_id:
            try:
                remote_doc = self._fetch_json_file(file_id)
            except Exception:
                remote_doc = None

        base_doc = remote_doc if isinstance(remote_doc, dict) else idx["members_data"].get(self.member_id)
        if not isinstance(base_doc, dict):
            base_doc = {}
        doc = {
            "version": 1,
            "member": {
                "id": self.member_id,
                "name": self.member_name,
                "email": "",
                "picture": "",
                "color": self.member_color,
                "updatedAt": int(time.time() * 1000),
            },
            "items": dict(base_doc.get("items") or {}),
        }
        mutator_fn(doc)
        if file_id:
            self._update_json_file(file_id, doc)
        else:
            file_id = self._create_json_file(meta_folder_id, filename, doc)
        idx["member_files_by_id"][self.member_id] = file_id
        idx["members_data"][self.member_id] = doc
        return doc

    def tag_photos(
        self,
        photo_ids,
        add_tag_ids=None,
        add_tag_names=None,
        remove_tag_ids=None,
        remove_tag_names=None,
        create_missing_tags=True,
        default_color="violet",
        default_group="AI",
    ):
        idx = self.ensure_index()
        if not idx["can_write"]:
            raise RuntimeError("Drive folder is read-only; cannot tag photos")
        pids = self._validate_photo_ids(photo_ids, idx)
        schema_tags = dict((idx["tag_schema"] or {}).get("tags") or {})

        name_to_id = {
            str(tdef.get("name") or "").strip().lower(): tid
            for tid, tdef in schema_tags.items()
            if isinstance(tdef, dict) and not tdef.get("deleted")
        }

        resolved_add_ids = []
        for tid in add_tag_ids or []:
            s = str(tid or "").strip()
            if not s or s not in schema_tags or schema_tags[s].get("deleted"):
                raise ValueError(f"Tag ID not found or deleted: {s}")
            resolved_add_ids.append(s)

        schema_dirty = False
        now_ms = int(time.time() * 1000)
        for raw_name in add_tag_names or []:
            cname = str(raw_name or "").strip()
            if not cname:
                continue
            existing_id = name_to_id.get(cname.lower())
            if existing_id:
                resolved_add_ids.append(existing_id)
            elif create_missing_tags:
                new_id = f"tag-{uuid.uuid4().hex[:10]}"
                new_tag = {
                    "id": new_id,
                    "name": cname,
                    "color": default_color if default_color in TAG_COLORS else "violet",
                    "group": str(default_group or "AI").strip() or "AI",
                    "deleted": False,
                    "updatedAt": now_ms,
                }
                schema_tags[new_id] = new_tag
                name_to_id[cname.lower()] = new_id
                resolved_add_ids.append(new_id)
                schema_dirty = True
            else:
                raise ValueError(f"Tag name not found and create_missing_tags=false: {cname}")

        resolved_remove_ids = []
        for tid in remove_tag_ids or []:
            s = str(tid or "").strip()
            if s:
                resolved_remove_ids.append(s)
        for raw_name in remove_tag_names or []:
            cname = str(raw_name or "").strip().lower()
            if cname in name_to_id:
                resolved_remove_ids.append(name_to_id[cname])

        if not resolved_add_ids and not resolved_remove_ids:
            raise ValueError("Provide at least one tag ID or tag name to add or remove")

        if schema_dirty:
            self._persist_tag_schema({"version": 1, "tags": schema_tags}, idx)

        write_ms = int(time.time() * 1000)

        def mutate(doc):
            items = doc["items"]
            for pid in pids:
                prev = dict(items.get(pid) or {})
                item_tags = dict(prev.get("tags") or {})
                for tid in resolved_add_ids:
                    item_tags[tid] = {"active": True, "updatedAt": write_ms}
                for tid in resolved_remove_ids:
                    item_tags[tid] = {"active": False, "updatedAt": write_ms}
                items[pid] = {
                    "rating": int(prev.get("rating") or 0),
                    "favorite": bool(prev.get("favorite")),
                    "note": str(prev.get("note") or ""),
                    "tags": item_tags,
                    "updatedAt": write_ms,
                }

        self._save_my_member_record(mutate, idx)
        return {
            "updatedCount": len(pids),
            "addedTagIds": resolved_add_ids,
            "removedTagIds": resolved_remove_ids,
            "memberFile": f"member-{self.member_key}.json",
        }

    def rate_photos(self, photo_ids, rating=None, favorite=None):
        if rating is None and favorite is None:
            raise ValueError("Provide rating (0..5) and/or favorite (bool)")
        idx = self.ensure_index()
        if not idx["can_write"]:
            raise RuntimeError("Drive folder is read-only; cannot rate photos")
        pids = self._validate_photo_ids(photo_ids, idx)
        clamped_rating = None if rating is None else max(0, min(5, int(rating)))
        fav_val = None if favorite is None else bool(favorite)
        write_ms = int(time.time() * 1000)

        def mutate(doc):
            items = doc["items"]
            for pid in pids:
                prev = dict(items.get(pid) or {})
                items[pid] = {
                    "rating": clamped_rating if clamped_rating is not None else int(prev.get("rating") or 0),
                    "favorite": fav_val if fav_val is not None else bool(prev.get("favorite")),
                    "note": str(prev.get("note") or ""),
                    "tags": dict(prev.get("tags") or {}),
                    "updatedAt": write_ms,
                }

        self._save_my_member_record(mutate, idx)
        return {
            "updatedCount": len(pids),
            "rating": clamped_rating,
            "favorite": fav_val,
            "memberFile": f"member-{self.member_key}.json",
        }

    def set_photo_note(self, photo_id=None, note="", notes=None):
        note_map = {}
        if isinstance(notes, dict):
            for pid, text in notes.items():
                note_map[str(pid)] = str(text or "")
        if photo_id:
            note_map[str(photo_id)] = str(note or "")
        if not note_map:
            raise ValueError("Provide photo_id + note or notes dict")

        idx = self.ensure_index()
        if not idx["can_write"]:
            raise RuntimeError("Drive folder is read-only; cannot set photo notes")
        pids = self._validate_photo_ids(list(note_map.keys()), idx)
        write_ms = int(time.time() * 1000)

        def mutate(doc):
            items = doc["items"]
            for pid in pids:
                prev = dict(items.get(pid) or {})
                items[pid] = {
                    "rating": int(prev.get("rating") or 0),
                    "favorite": bool(prev.get("favorite")),
                    "note": note_map[pid],
                    "tags": dict(prev.get("tags") or {}),
                    "updatedAt": write_ms,
                }

        self._save_my_member_record(mutate, idx)
        return {
            "updatedCount": len(pids),
            "photoIds": pids,
            "memberFile": f"member-{self.member_key}.json",
        }


MCP_TOOLS = [
    {
        "name": "get_album_stats",
        "description": "Get summary counts and tag statistics for the configured Google Drive album.",
        "inputSchema": {"type": "object", "properties": {}, "additionalProperties": False},
    },
    {
        "name": "list_folders",
        "description": "List the folder hierarchy and direct media counts inside the configured album.",
        "inputSchema": {"type": "object", "properties": {}, "additionalProperties": False},
    },
    {
        "name": "search_photos",
        "description": "Search and paginate photos/videos in the album by folder, keyword, tags, rating, favorites, unrated/untagged state, media type, aspect, and sort order.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "folder_id": {"type": "string"},
                "include_subfolders": {"type": "boolean", "default": True},
                "query": {"type": "string"},
                "tag_ids": {"type": "array", "items": {"type": "string"}},
                "tag_match_mode": {"type": "string", "enum": ["OR", "AND"], "default": "OR"},
                "min_rating": {"type": "number", "minimum": 0, "maximum": 5},
                "favorites_only": {"type": "boolean", "default": False},
                "unrated_only": {"type": "boolean", "default": False},
                "untagged_only": {"type": "boolean", "default": False},
                "media_type": {"type": "string", "enum": list(VALID_MEDIA_TYPES), "default": "all"},
                "aspect": {"type": "string", "enum": list(VALID_ASPECTS), "default": "all"},
                "sort_by": {"type": "string", "enum": list(VALID_SORTS), "default": "dateDesc"},
                "limit": {"type": "integer", "minimum": 1, "maximum": 200, "default": 50},
                "offset": {"type": "integer", "minimum": 0, "default": 0},
            },
            "additionalProperties": False,
        },
    },
    {
        "name": "get_photo_details",
        "description": "Get full metadata, EXIF fields, collaborator ratings, notes, and active tags for a single photo ID.",
        "inputSchema": {
            "type": "object",
            "properties": {"photo_id": {"type": "string"}},
            "required": ["photo_id"],
            "additionalProperties": False,
        },
    },
    {
        "name": "get_photo_image",
        "description": "Fetch a resized preview image (800px default, up to 1600px) so a multimodal AI model can inspect visual content and auto-tag or rate it.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "photo_id": {"type": "string"},
                "size": {"type": "integer", "minimum": 120, "maximum": 1600, "default": 800},
            },
            "required": ["photo_id"],
            "additionalProperties": False,
        },
    },
    {
        "name": "list_tags",
        "description": "List all active tag definitions in .drivelens/tags-schema.json along with photo usage counts.",
        "inputSchema": {"type": "object", "properties": {}, "additionalProperties": False},
    },
    {
        "name": "upsert_tag",
        "description": "Create or update a shared tag definition in .drivelens/tags-schema.json.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "name": {"type": "string"},
                "id": {"type": "string"},
                "color": {"type": "string", "enum": list(TAG_COLORS), "default": "blue"},
                "group": {"type": "string", "default": "AI"},
            },
            "required": ["name"],
            "additionalProperties": False,
        },
    },
    {
        "name": "delete_tag",
        "description": "Soft-delete a tag in .drivelens/tags-schema.json using an LWW tombstone.",
        "inputSchema": {
            "type": "object",
            "properties": {"tag_id": {"type": "string"}},
            "required": ["tag_id"],
            "additionalProperties": False,
        },
    },
    {
        "name": "tag_photos",
        "description": "Batch add and/or remove tags across multiple photos in a single atomic write to the AI member JSON file.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "photo_ids": {"type": "array", "items": {"type": "string"}, "minItems": 1},
                "add_tag_ids": {"type": "array", "items": {"type": "string"}},
                "add_tag_names": {"type": "array", "items": {"type": "string"}},
                "remove_tag_ids": {"type": "array", "items": {"type": "string"}},
                "remove_tag_names": {"type": "array", "items": {"type": "string"}},
                "create_missing_tags": {"type": "boolean", "default": True},
                "default_color": {"type": "string", "enum": list(TAG_COLORS), "default": "violet"},
                "default_group": {"type": "string", "default": "AI"},
            },
            "required": ["photo_ids"],
            "additionalProperties": False,
        },
    },
    {
        "name": "rate_photos",
        "description": "Batch set star ratings (0..5) and/or favorite status across multiple photos in the AI member JSON file.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "photo_ids": {"type": "array", "items": {"type": "string"}, "minItems": 1},
                "rating": {"type": "integer", "minimum": 0, "maximum": 5},
                "favorite": {"type": "boolean"},
            },
            "required": ["photo_ids"],
            "additionalProperties": False,
        },
    },
    {
        "name": "set_photo_note",
        "description": "Set or clear collaborator review notes for one photo or a map of {photoId: note}.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "photo_id": {"type": "string"},
                "note": {"type": "string"},
                "notes": {"type": "object", "additionalProperties": {"type": "string"}},
            },
            "additionalProperties": False,
        },
    },
    {
        "name": "refresh_album_index",
        "description": "Force a full refresh of folders, media files, tags, and member metadata from Google Drive.",
        "inputSchema": {"type": "object", "properties": {}, "additionalProperties": False},
    },
]


class McpStdioServer:
    """Line-delimited JSON-RPC 2.0 MCP transport over stdin/stdout."""

    def __init__(self, client_factory):
        self._client_factory = client_factory
        self._client = None

    def _get_client(self):
        if self._client is None:
            self._client = self._client_factory()
        return self._client

    def _dispatch_tool(self, name, args):
        client = self._get_client()
        if name == "get_album_stats":
            res = client.get_album_stats()
        elif name == "list_folders":
            res = client.list_folders()
        elif name == "search_photos":
            res = client.search_photos(**args)
        elif name == "get_photo_details":
            res = client.get_photo_details(photo_id=args["photo_id"])
        elif name == "get_photo_image":
            img = client.get_photo_image(photo_id=args["photo_id"], size=args.get("size", 800))
            meta_text = json.dumps(
                {
                    "photoId": img["photoId"],
                    "name": img["name"],
                    "mimeType": img["mimeType"],
                    "byteLength": img["byteLength"],
                },
                ensure_ascii=False,
            )
            return {
                "content": [
                    {"type": "image", "data": img["base64"], "mimeType": img["mimeType"]},
                    {"type": "text", "text": meta_text},
                ],
                "isError": False,
            }
        elif name == "list_tags":
            res = client.list_tags()
        elif name == "upsert_tag":
            res = client.upsert_tag(
                name=args["name"],
                tag_id=args.get("id"),
                color=args.get("color", "blue"),
                group=args.get("group", "AI"),
            )
        elif name == "delete_tag":
            res = client.delete_tag(tag_id=args["tag_id"])
        elif name == "tag_photos":
            res = client.tag_photos(
                photo_ids=args["photo_ids"],
                add_tag_ids=args.get("add_tag_ids"),
                add_tag_names=args.get("add_tag_names"),
                remove_tag_ids=args.get("remove_tag_ids"),
                remove_tag_names=args.get("remove_tag_names"),
                create_missing_tags=args.get("create_missing_tags", True),
                default_color=args.get("default_color", "violet"),
                default_group=args.get("default_group", "AI"),
            )
        elif name == "rate_photos":
            res = client.rate_photos(
                photo_ids=args["photo_ids"],
                rating=args.get("rating"),
                favorite=args.get("favorite"),
            )
        elif name == "set_photo_note":
            res = client.set_photo_note(
                photo_id=args.get("photo_id"),
                note=args.get("note", ""),
                notes=args.get("notes"),
            )
        elif name == "refresh_album_index":
            idx = client.ensure_index(force_refresh=True)
            res = {
                "refreshed": True,
                "albumName": idx["root_folder"]["name"],
                "totalItems": len(idx["files"]),
                "folderCount": len(idx["folders"]),
                "tagCount": len([t for t in (idx["tag_schema"].get("tags") or {}).values() if not t.get("deleted")]),
            }
        else:
            raise ValueError(f"Unknown tool: {name}")

        return {
            "content": [{"type": "text", "text": json.dumps(res, ensure_ascii=False, indent=2)}],
            "isError": False,
        }

    def handle_message(self, msg):
        if not isinstance(msg, dict):
            return {"jsonrpc": "2.0", "id": None, "error": {"code": -32600, "message": "Invalid Request"}}
        has_id = "id" in msg and msg["id"] is not None
        req_id = msg.get("id")
        method = msg.get("method")
        params = msg.get("params") if isinstance(msg.get("params"), dict) else {}

        if method and str(method).startswith("notifications/"):
            return None
        if not has_id:
            return None

        if method == "initialize":
            proto = params.get("protocolVersion") if isinstance(params.get("protocolVersion"), str) else "2024-11-05"
            return {
                "jsonrpc": "2.0",
                "id": req_id,
                "result": {
                    "protocolVersion": proto,
                    "capabilities": {"tools": {"listChanged": False}},
                    "serverInfo": {"name": "drivelens-mcp", "version": "1.0.0"},
                    "instructions": (
                        "DriveLens Google Drive photo gallery MCP server. Writes tags to .drivelens/tags-schema.json "
                        "and ratings/tags/notes exclusively to a dedicated AI collaborator JSON file inside .drivelens/."
                    ),
                },
            }

        if method == "ping":
            return {"jsonrpc": "2.0", "id": req_id, "result": {}}

        if method == "tools/list":
            return {"jsonrpc": "2.0", "id": req_id, "result": {"tools": MCP_TOOLS}}

        if method == "tools/call":
            tool_name = params.get("name")
            args = params.get("arguments") if isinstance(params.get("arguments"), dict) else {}
            try:
                result = self._dispatch_tool(tool_name, args)
            except Exception as exc:
                result = {
                    "content": [{"type": "text", "text": f"Error ({tool_name}): {exc}"}],
                    "isError": True,
                }
            return {"jsonrpc": "2.0", "id": req_id, "result": result}

        return {
            "jsonrpc": "2.0",
            "id": req_id,
            "error": {"code": -32601, "message": f"Method not found: {method}"},
        }


def build_default_client_from_env(env=None):
    cfg = env if env is not None else os.environ
    folder_id = cfg.get("DRIVELENS_FOLDER_ID") or ""
    auth = DriveAuthManager(env=cfg)
    transport = DriveHttpTransport(auth)
    return DriveLensClient(
        folder_input=folder_id,
        transport=transport,
        member_id=cfg.get("DRIVELENS_MEMBER_ID") or "ai_assistant",
        member_name=cfg.get("DRIVELENS_MEMBER_NAME") or "AI Assistant",
        member_color=cfg.get("DRIVELENS_MEMBER_COLOR") or "#a78bfa",
        cache_ttl_sec=int(cfg.get("DRIVELENS_CACHE_TTL_SEC") or 120),
    )


def serve_stdio(stdin=None, stdout=None, client_factory=build_default_client_from_env):
    in_stream = stdin or sys.stdin
    out_stream = stdout or sys.stdout
    server = McpStdioServer(client_factory)
    for raw_line in in_stream:
        line = raw_line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
            resp = server.handle_message(msg)
        except json.JSONDecodeError as exc:
            resp = {
                "jsonrpc": "2.0",
                "id": None,
                "error": {"code": -32700, "message": f"Parse error: {exc}"},
            }
        except Exception as exc:
            print(f"[drivelens-mcp] unexpected error: {exc}", file=sys.stderr, flush=True)
            resp = {
                "jsonrpc": "2.0",
                "id": None,
                "error": {"code": -32603, "message": str(exc)},
            }
        if resp is not None:
            out_stream.write(json.dumps(resp, ensure_ascii=False) + "\n")
            out_stream.flush()


if __name__ == "__main__":
    serve_stdio()
