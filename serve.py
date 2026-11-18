#!/usr/bin/env python3
"""Zero-dependency static dev server for DriveLens.

Explicitly overrides Windows registry MIME types for .js/.css/.svg/.json
so native ES modules (<script type="module">) always load cleanly.
"""

import errno
from functools import partial
import http.server
import json
import mimetypes
import os
import re
import socketserver
import sys
import tempfile
import threading
from urllib.parse import parse_qs, urlsplit
import webbrowser

_META_LOCK = threading.Lock()


def _sanitize_folder_key(raw_folder):
    cleaned = re.sub(r"[^a-zA-Z0-9_-]", "", str(raw_folder or "").strip())
    return cleaned[:128]


def _merge_tag_schemas(existing_schema, incoming_schema):
    merged_tags = {}
    for source in (existing_schema, incoming_schema):
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
                merged_tags[tag_id] = tag_obj
            else:
                cur_ts = float(tag_obj.get("updatedAt") or 0)
                prev_ts = float(prev.get("updatedAt") or 0)
                if cur_ts >= prev_ts:
                    merged_tags[tag_id] = tag_obj
    return {"version": 1, "tags": merged_tags}


def _read_meta_file(meta_path):
    default_doc = {
        "tagSchema": {"version": 1, "tags": {}},
        "membersData": {},
    }
    if not os.path.isfile(meta_path):
        return default_doc
    try:
        with open(meta_path, "r", encoding="utf-8") as fp:
            data = json.load(fp)
    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
        return default_doc
    if not isinstance(data, dict):
        return default_doc
    schema = data.get("tagSchema")
    if not isinstance(schema, dict) or not isinstance(schema.get("tags"), dict):
        schema = {"version": 1, "tags": {}}
    else:
        schema = {"version": 1, "tags": schema["tags"]}
    members = data.get("membersData")
    if not isinstance(members, dict):
        members = {}
    return {"tagSchema": schema, "membersData": members}

# Ensure strict web-standard MIME types regardless of Windows registry state
mimetypes.init()
mimetypes.add_type("application/javascript", ".js")
mimetypes.add_type("application/javascript", ".mjs")
mimetypes.add_type("text/css", ".css")
mimetypes.add_type("image/svg+xml", ".svg")
mimetypes.add_type("image/png", ".png")
mimetypes.add_type("application/json", ".json")
mimetypes.add_type("application/manifest+json", ".webmanifest")


class NoCacheStaticHandler(http.server.SimpleHTTPRequestHandler):
    """Static handler with deterministic MIME types and no-cache headers."""

    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        ".js": "application/javascript; charset=utf-8",
        ".mjs": "application/javascript; charset=utf-8",
        ".css": "text/css; charset=utf-8",
        ".json": "application/json; charset=utf-8",
        ".webmanifest": "application/manifest+json; charset=utf-8",
        ".svg": "image/svg+xml",
        ".png": "image/png",
        ".html": "text/html; charset=utf-8",
    }

    def end_headers(self):
        self.send_header("Cache-Control", "no-cache, no-store, must-revalidate")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()

    def guess_type(self, path):
        _, ext = os.path.splitext(path)
        ext_lower = ext.lower()
        if ext_lower in self.extensions_map:
            return self.extensions_map[ext_lower]
        return super().guess_type(path)

    def _get_meta_dir(self):
        base_dir = getattr(self, "directory", None) or os.getcwd()
        return os.path.join(base_dir, ".local-meta")

    def _send_json(self, status_code, payload):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status_code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        parsed = urlsplit(self.path)
        if parsed.path == "/api/meta":
            qs = parse_qs(parsed.query)
            safe_folder = _sanitize_folder_key(qs.get("folder", [""])[0])
            if not safe_folder:
                self._send_json(400, {"ok": False, "error": "Missing or invalid folder parameter"})
                return
            meta_path = os.path.join(self._get_meta_dir(), f"{safe_folder}.json")
            with _META_LOCK:
                doc = _read_meta_file(meta_path)
            self._send_json(
                200,
                {
                    "ok": True,
                    "tagSchema": doc["tagSchema"],
                    "membersData": doc["membersData"],
                },
            )
            return
        super().do_GET()

    def do_POST(self):
        parsed = urlsplit(self.path)
        if parsed.path != "/api/meta":
            self._send_json(404, {"ok": False, "error": "Not found"})
            return

        try:
            content_len = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            self._send_json(400, {"ok": False, "error": "Invalid Content-Length"})
            return

        if content_len <= 0 or content_len > 10 * 1024 * 1024:
            self._send_json(400, {"ok": False, "error": "Invalid request body size"})
            return

        raw_body = self.rfile.read(content_len)
        try:
            payload = json.loads(raw_body.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            self._send_json(400, {"ok": False, "error": "Invalid JSON payload"})
            return

        if not isinstance(payload, dict):
            self._send_json(400, {"ok": False, "error": "Payload must be a JSON object"})
            return

        safe_folder = _sanitize_folder_key(payload.get("folderId"))
        if not safe_folder:
            self._send_json(400, {"ok": False, "error": "Missing or invalid folderId"})
            return

        meta_dir = self._get_meta_dir()
        meta_path = os.path.join(meta_dir, f"{safe_folder}.json")

        with _META_LOCK:
            doc = _read_meta_file(meta_path)
            merged_schema = _merge_tag_schemas(doc["tagSchema"], payload.get("tagSchema"))
            members_data = dict(doc["membersData"])

            member_id = payload.get("memberId")
            member_record = payload.get("memberRecord")
            if (
                isinstance(member_id, str)
                and member_id.strip()
                and isinstance(member_record, dict)
            ):
                members_data[member_id.strip()] = member_record

            next_doc = {
                "tagSchema": merged_schema,
                "membersData": members_data,
            }
            os.makedirs(meta_dir, exist_ok=True)
            fd, tmp_path = tempfile.mkstemp(prefix=f".{safe_folder}_", suffix=".tmp", dir=meta_dir)
            try:
                with os.fdopen(fd, "w", encoding="utf-8") as fp:
                    json.dump(next_doc, fp, ensure_ascii=False, indent=2)
                os.replace(tmp_path, meta_path)
            except Exception:
                if os.path.exists(tmp_path):
                    os.unlink(tmp_path)
                raise

        self._send_json(
            200,
            {
                "ok": True,
                "tagSchema": merged_schema,
                "membersData": members_data,
            },
        )


class ReusableThreadingHTTPServer(socketserver.ThreadingMixIn, http.server.HTTPServer):
    allow_reuse_address = True
    daemon_threads = True


def create_server(host="127.0.0.1", port=5173, directory=None):
    base_dir = directory or os.path.dirname(os.path.abspath(__file__))
    handler_cls = partial(NoCacheStaticHandler, directory=base_dir)
    return ReusableThreadingHTTPServer((host, port), handler_cls)


def _is_addr_in_use(exc):
    return (
        getattr(exc, "winerror", None) == 10048
        or getattr(exc, "errno", None) in (errno.EADDRINUSE, 10048)
    )


def _parse_args(argv):
    port = 5173
    port_seen = False
    open_browser = False
    dry_run = False

    for arg in argv:
        if arg == "--open":
            open_browser = True
        elif arg == "--dry-run":
            dry_run = True
        elif arg.startswith("-"):
            print(f"Unknown option: {arg}", file=sys.stderr)
            sys.exit(1)
        elif not port_seen:
            try:
                port = int(arg)
            except ValueError:
                print(f"Invalid port: {arg}", file=sys.stderr)
                sys.exit(1)
            if port < 0 or port > 65535:
                print(f"Invalid port: {arg}", file=sys.stderr)
                sys.exit(1)
            port_seen = True
        else:
            print(f"Unexpected argument: {arg}", file=sys.stderr)
            sys.exit(1)

    return port, open_browser, dry_run


def main():
    port, open_browser, dry_run = _parse_args(sys.argv[1:])

    if dry_run:
        try:
            server = create_server(host="127.0.0.1", port=port)
        except OSError as exc:
            if _is_addr_in_use(exc):
                server = create_server(host="127.0.0.1", port=0)
            else:
                raise
        try:
            actual_port = server.server_address[1]
            print(f"READY http://localhost:{actual_port}")
        finally:
            server.server_close()
        return

    try:
        server = create_server(host="127.0.0.1", port=port)
    except OSError as exc:
        if open_browser and _is_addr_in_use(exc):
            url = f"http://localhost:{port}"
            print(f"Server is already running at {url}")
            webbrowser.open(url)
            return
        raise

    actual_port = server.server_address[1]
    url = f"http://localhost:{actual_port}"
    print(f"DriveLens serving at http://127.0.0.1:{actual_port} ({url})")
    print("Press Ctrl+C to stop.")
    if open_browser:
        webbrowser.open(url)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nServer stopped.")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
