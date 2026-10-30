#!/usr/bin/env python3
"""Taski local server: serves the app and reads/writes a Markdown workspace.

Standard library only, Python 3.9+. Usage:

    python3 server.py                 # workspace ./taski-demo, http://127.0.0.1:8000/taski.html
    python3 server.py --root ~/notes/taski --port 8123

API (all paths are relative to the workspace root):
    GET    /api/ping
    GET    /api/list?path=DIR          -> {"entries": [{"name", "path", "kind"}]}
    GET    /api/files?path=FILE        -> raw text, ETag = revision
    PUT    /api/files?path=FILE        body = raw text; If-Match: REV or If-None-Match: *
    POST   /api/mkdir?path=DIR
    POST   /api/move?path=FROM&to=TO
    DELETE /api/files?path=FILE        If-Match: REV (optional)

Writes need the header `X-Taski: 1`, which browsers cannot send cross-origin
without a CORS preflight this server never approves.
"""

import argparse
import json
import os
import sys
import tempfile
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlsplit

APP_DIR = os.path.dirname(os.path.abspath(__file__))
WRITABLE_EXTENSIONS = (".md", ".markdown", ".txt")
MAX_BODY = 5 * 1024 * 1024


class ApiError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status
        self.message = message


def revision(path):
    st = os.stat(path)
    return '"%d-%d"' % (st.st_mtime_ns, st.st_size)


class Workspace:
    def __init__(self, root):
        self.root = os.path.realpath(root)

    def resolve(self, rel):
        """Map a workspace path to a real path inside the root, or raise."""
        if rel is None:
            raise ApiError(HTTPStatus.BAD_REQUEST, "missing path")
        rel = rel.replace("\\", "/").strip("/")
        parts = [p for p in rel.split("/") if p not in ("", ".")]
        if any(p == ".." or p.startswith(".") for p in parts):
            raise ApiError(HTTPStatus.FORBIDDEN, "path not allowed")
        full = os.path.realpath(os.path.join(self.root, *parts))
        # realpath follows symlinks, so links pointing outside the root are rejected too
        if full != self.root and not full.startswith(self.root + os.sep):
            raise ApiError(HTTPStatus.FORBIDDEN, "path escapes workspace")
        return full, "/".join(parts)

    def writable(self, full):
        if not full.lower().endswith(WRITABLE_EXTENSIONS):
            raise ApiError(HTTPStatus.FORBIDDEN, "only Markdown and text files can be written")


def atomic_write(full, data):
    directory = os.path.dirname(full)
    fd, tmp = tempfile.mkstemp(prefix=".taski-", suffix=".tmp", dir=directory)
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(data)
            f.flush()
            os.fsync(f.fileno())
        if os.path.exists(full):
            os.chmod(tmp, os.stat(full).st_mode & 0o777)
        else:
            os.chmod(tmp, 0o644)
        os.replace(tmp, full)
    except BaseException:
        if os.path.exists(tmp):
            os.unlink(tmp)
        raise


class Handler(SimpleHTTPRequestHandler):
    workspace = None  # type: Workspace
    server_version = "taski"

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=APP_DIR, **kwargs)

    # ---- plumbing ----

    def log_message(self, fmt, *args):
        if not getattr(self.server, "quiet", False):
            super().log_message(fmt, *args)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        super().end_headers()

    def guess_type(self, path):
        if str(path).endswith(".js"):
            return "text/javascript"
        if str(path).endswith(".md"):
            return "text/markdown; charset=utf-8"
        return super().guess_type(path)

    def send(self, status, body=b"", content_type="text/plain; charset=utf-8", headers=None):
        if isinstance(body, str):
            body = body.encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def send_json(self, status, obj, headers=None):
        self.send(status, json.dumps(obj), "application/json", headers)

    def api(self):
        url = urlsplit(self.path)
        if not url.path.startswith("/api/"):
            return None
        query = {k: v[0] for k, v in parse_qs(url.query).items()}
        return url.path[len("/api/"):], query

    def check_write_allowed(self):
        if self.headers.get("X-Taski") != "1":
            raise ApiError(HTTPStatus.FORBIDDEN, "missing X-Taski header")
        origin = self.headers.get("Origin")
        if origin:
            host = self.headers.get("Host", "")
            if urlsplit(origin).netloc != host:
                raise ApiError(HTTPStatus.FORBIDDEN, "cross-origin write refused")

    def read_body(self):
        length = int(self.headers.get("Content-Length") or 0)
        if length > MAX_BODY:
            raise ApiError(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, "file too large")
        return self.rfile.read(length)

    def check_precondition(self, full):
        exists = os.path.isfile(full)
        if self.headers.get("If-None-Match") == "*" and exists:
            raise ApiError(HTTPStatus.PRECONDITION_FAILED, "file already exists")
        expected = self.headers.get("If-Match")
        if expected and (not exists or revision(full) != expected):
            raise ApiError(HTTPStatus.PRECONDITION_FAILED, "file changed since it was read")

    def dispatch(self, method):
        api = self.api()
        if api is None:
            return False
        route, query = api
        try:
            handler = getattr(self, "api_%s_%s" % (method, route), None)
            if handler is None:
                raise ApiError(HTTPStatus.NOT_FOUND, "unknown API route")
            if method != "get":
                self.check_write_allowed()
            handler(query)
        except ApiError as e:
            self.send(e.status, e.message)
        except FileNotFoundError:
            self.send(HTTPStatus.NOT_FOUND, "not found")
        except (NotADirectoryError, IsADirectoryError) as e:
            self.send(HTTPStatus.CONFLICT, str(e))
        except PermissionError as e:
            self.send(HTTPStatus.FORBIDDEN, str(e))
        return True

    # ---- HTTP verbs ----

    def do_GET(self):
        if not self.dispatch("get"):
            super().do_GET()

    def do_HEAD(self):
        if not self.dispatch("get"):
            super().do_HEAD()

    def do_PUT(self):
        if not self.dispatch("put"):
            self.send(HTTPStatus.METHOD_NOT_ALLOWED, "method not allowed")

    def do_POST(self):
        if not self.dispatch("post"):
            self.send(HTTPStatus.METHOD_NOT_ALLOWED, "method not allowed")

    def do_DELETE(self):
        if not self.dispatch("delete"):
            self.send(HTTPStatus.METHOD_NOT_ALLOWED, "method not allowed")

    # ---- API routes ----

    def api_get_ping(self, query):
        self.send(HTTPStatus.OK, "taski %s" % self.workspace.root)

    def api_get_list(self, query):
        full, rel = self.workspace.resolve(query.get("path", ""))
        entries = []
        for entry in sorted(os.scandir(full), key=lambda e: e.name):
            if entry.name.startswith("."):
                continue
            entries.append({
                "name": entry.name,
                "path": (rel + "/" if rel else "") + entry.name,
                "kind": "dir" if entry.is_dir() else "file",
            })
        self.send_json(HTTPStatus.OK, {"entries": entries})

    def api_get_files(self, query):
        full, _ = self.workspace.resolve(query.get("path"))
        if not os.path.isfile(full):
            raise FileNotFoundError(full)
        with open(full, "rb") as f:
            data = f.read()
        self.send(HTTPStatus.OK, data, "text/markdown; charset=utf-8", {"ETag": revision(full)})

    def api_put_files(self, query):
        full, _ = self.workspace.resolve(query.get("path"))
        self.workspace.writable(full)
        data = self.read_body()
        try:
            data.decode("utf-8")
        except UnicodeDecodeError:
            raise ApiError(HTTPStatus.BAD_REQUEST, "body must be UTF-8 text")
        if not os.path.isdir(os.path.dirname(full)):
            raise ApiError(HTTPStatus.CONFLICT, "parent folder does not exist")
        self.check_precondition(full)
        created = not os.path.exists(full)
        atomic_write(full, data)
        self.send(HTTPStatus.CREATED if created else HTTPStatus.OK, "", headers={"ETag": revision(full)})

    def api_post_mkdir(self, query):
        full, _ = self.workspace.resolve(query.get("path"))
        os.makedirs(full, exist_ok=True)
        self.send(HTTPStatus.NO_CONTENT)

    def api_post_move(self, query):
        src, _ = self.workspace.resolve(query.get("path"))
        dst, _ = self.workspace.resolve(query.get("to"))
        if not os.path.exists(src):
            raise FileNotFoundError(src)
        if os.path.exists(dst):
            raise ApiError(HTTPStatus.CONFLICT, "destination exists")
        if os.path.isfile(src):
            self.workspace.writable(dst)
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        os.rename(src, dst)
        self.send(HTTPStatus.NO_CONTENT)

    def api_delete_files(self, query):
        full, _ = self.workspace.resolve(query.get("path"))
        self.workspace.writable(full)
        if not os.path.isfile(full):
            raise FileNotFoundError(full)
        self.check_precondition(full)
        os.unlink(full)
        self.send(HTTPStatus.NO_CONTENT)


def make_server(root, host="127.0.0.1", port=8000, quiet=False):
    handler = type("BoundHandler", (Handler,), {"workspace": Workspace(root)})
    server = ThreadingHTTPServer((host, port), handler)
    server.quiet = quiet
    return server


def main(argv=None):
    parser = argparse.ArgumentParser(description="Serve Taski with read/write access to a local Markdown workspace.")
    parser.add_argument("--root", default=os.path.join(APP_DIR, "taski-demo"), help="workspace folder (default: ./taski-demo)")
    parser.add_argument("--host", default="127.0.0.1", help="bind address (default: 127.0.0.1)")
    parser.add_argument("--port", type=int, default=8000)
    args = parser.parse_args(argv)

    root = os.path.expanduser(args.root)
    if not os.path.isdir(root):
        sys.exit("Workspace folder not found: %s" % root)
    if args.host not in ("127.0.0.1", "localhost", "::1"):
        print("Warning: binding to %s exposes your files to the network." % args.host, file=sys.stderr)

    server = make_server(root, args.host, args.port)
    print("Taski workspace: %s" % os.path.realpath(root))
    print("Open http://%s:%d/taski.html" % (args.host, args.port))
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
