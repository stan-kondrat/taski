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

MCP (Model Context Protocol) for AI agents, over the same workspace:
    POST /mcp                 Streamable HTTP, all allowed projects
    POST /mcp/PROJECT         Streamable HTTP, only that project
    GET  /mcp[/PROJECT]       Accept: text/event-stream opens an SSE stream of task events
    python3 server.py --mcp   stdio instead of HTTP (the agent starts the process)
`--allow-host HOST` (repeatable) accepts that Host name on /mcp when the server is
reached by a LAN IP or DNS name (the default accepts only loopback names).
`--project NAME` (repeatable) limits MCP and the browser API to those top-level project
folders; root files stay readable. Tools: list_projects, get_project, list_tasks,
create_task, update_task, list_files, read_file, write_file, make_folder, move_file,
delete_file.

MCP Events (protocol 2026-07-28): events/list, events/subscribe, events/unsubscribe.
Events: task.created, task.updated. They are sent when create_task or update_task changes a task, and also
when a task file is saved through write_file or the browser app (then `via` says which, and `changed` lists
what differs). Edits made directly on disk are not seen. Two ways to receive them:
- Webhooks: a subscription is verified with a url_verification challenge, then each event
  is POSTed to its webhook signed with Standard Webhooks headers (webhook-id,
  webhook-timestamp, webhook-signature), retried with backoff. Webhook URLs must be public
  https unless the server is started with `--allow-private-webhooks`.
- Server-sent events: GET /mcp (or /mcp/PROJECT) with `Accept: text/event-stream` and
  optional filters in the query (event, project, status, priority, tag) streams each event
  as a JSON-RPC notification `notifications/events/event`, with `: ping` comments to keep
  the connection alive. Each SSE message has an `id`; reconnect with `Last-Event-ID` to get
  the recent events you missed.
Subscriptions and streams live in memory and end when the server stops.

Catching up after being away: list_files with recursive=true and hash=true lists every file with
size, updated_at, revision and sha256, plus next_since, event_seq, instance and workspace. Compare
it with an earlier listing to find added, changed, deleted and moved files (since=<time> lists only
newer files, but cannot show deletions), then follow the event stream from event_seq.
"""

import argparse
import base64
import collections
import datetime
import email.utils
import hashlib
import hmac
import ipaddress
import json
import os
import queue
import random
import re
import secrets
import socket
import sys
import tempfile
import threading
import time
import unicodedata
import urllib.error
import urllib.request
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, unquote, urlsplit

APP_DIR = os.path.dirname(os.path.abspath(__file__))
WRITABLE_EXTENSIONS = (".md", ".markdown", ".txt")
MAX_BODY = 5 * 1024 * 1024


class ApiError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status
        self.message = message


def revision(path):
    return revision_of(os.stat(path))


def revision_of(st):
    return '"%d-%d"' % (st.st_mtime_ns, st.st_size)


_EPOCH = datetime.datetime(1970, 1, 1, tzinfo=datetime.timezone.utc)


def iso_time(ns):
    """Nanoseconds since the epoch as UTC ISO 8601 with milliseconds, e.g. 2026-11-21T09:30:00.123Z."""
    moment = _EPOCH + datetime.timedelta(milliseconds=ns // 1_000_000)
    return moment.isoformat(timespec="milliseconds").replace("+00:00", "Z")


def parse_time(value, key):
    """An ISO 8601 date or time (UTC when it has no offset) as nanoseconds since the epoch."""
    try:
        moment = datetime.datetime.fromisoformat(value.strip().replace("Z", "+00:00").replace("z", "+00:00"))
    except ValueError:
        raise ApiError(HTTPStatus.BAD_REQUEST, "%s must be an ISO 8601 time like 2026-11-21T09:30:00Z" % key)
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=datetime.timezone.utc)
    return (moment - _EPOCH) // datetime.timedelta(microseconds=1) * 1000


class HashCache:
    """SHA-256 of files, kept while a file's stat is unchanged, so listing hashes reads only files that changed.
    The key includes ctime and the inode: restoring an old mtime (touch -d) or an atomic replace still rehashes."""

    LIMIT = 100_000

    def __init__(self):
        self.lock = threading.Lock()
        self.known = {}

    def get(self, full, st):
        key = (st.st_mtime_ns, st.st_ctime_ns, st.st_size, st.st_ino)
        with self.lock:
            hit = self.known.get(full)
        if hit is not None and hit[0] == key:
            return hit[1]
        if st.st_size > MAX_BODY:
            return None
        try:
            with open(full, "rb") as f:
                digest = hashlib.sha256(f.read()).hexdigest()
        except OSError:
            return None
        with self.lock:
            if len(self.known) >= self.LIMIT:
                self.known.clear()
            self.known[full] = (key, digest)
        return digest


HASHES = HashCache()
# Identifies this server process: event numbers and the replay buffer belong to one process.
SERVER_INSTANCE = secrets.token_hex(8)
MAX_LIST_ENTRIES = 20_000
# list_files' next_since is this much earlier than the listing, for coarse filesystem timestamps (FAT keeps 2 s).
SINCE_MARGIN_NS = 2_000_000_000


class Workspace:
    def __init__(self, root, projects=None):
        self.root = os.path.realpath(root)
        # None = the whole workspace; otherwise only these top-level folders
        self.projects = None if projects is None else tuple(projects)

    def narrowed(self, project):
        """The same workspace limited to one project (which must already be allowed)."""
        if self.projects is not None and project not in self.projects:
            raise ApiError(HTTPStatus.FORBIDDEN, "project not allowed: %s" % project)
        if not project or project.startswith(".") or "/" in project or "\\" in project \
                or not os.path.isdir(os.path.join(self.root, project)):
            raise ApiError(HTTPStatus.NOT_FOUND, "no such project: %s" % project)
        return Workspace(self.root, [project])

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
        self.check_scope(full)
        return full, "/".join(parts)

    def project_of(self, full):
        """Top-level folder name a real path lives in, plus its depth below the root."""
        parts = full[len(self.root):].strip(os.sep).split(os.sep)
        return parts[0], len(parts)

    def check_scope(self, full):
        # Checked on the real path, so a symlink into another project is caught too.
        if self.projects is None or full == self.root:
            return
        top, depth = self.project_of(full)
        if top in self.projects:
            return
        if depth == 1 and not os.path.isdir(full):
            return  # root-level files (AGENTS.md, README.md) stay readable
        raise ApiError(HTTPStatus.FORBIDDEN, "path is outside the allowed projects")

    def require_project(self, full):
        """Changes are only allowed inside an allowed project, never to the project folder itself."""
        if self.projects is None:
            return
        if full == self.root or self.project_of(full)[0] not in self.projects or self.project_of(full)[1] < 2:
            raise ApiError(HTTPStatus.FORBIDDEN, "changes are limited to files inside the allowed projects")

    def writable(self, full):
        if not full.lower().endswith(WRITABLE_EXTENSIONS):
            raise ApiError(HTTPStatus.FORBIDDEN, "only Markdown and text files can be written")
        self.require_project(full)

    def check_precondition(self, full, if_match=None, if_none_match=None):
        exists = os.path.isfile(full)
        if if_none_match == "*" and exists:
            raise ApiError(HTTPStatus.PRECONDITION_FAILED, "file already exists")
        if if_match and (not exists or revision(full) != if_match):
            raise ApiError(HTTPStatus.PRECONDITION_FAILED, "file changed since it was read")

    # ---- operations shared by the HTTP API and MCP ----

    def list(self, rel):
        full, rel = self.resolve(rel)
        entries = []
        for entry in sorted(os.scandir(full), key=lambda e: e.name):
            if entry.name.startswith("."):
                continue
            if self.projects is not None and full == self.root and entry.is_dir() and entry.name not in self.projects:
                continue
            entries.append({
                "name": entry.name,
                "path": (rel + "/" if rel else "") + entry.name,
                "kind": "dir" if entry.is_dir() else "file",
            })
        return entries

    def details(self, rel, recursive=False, since_ns=None, want_hash=False, limit=MAX_LIST_ENTRIES):
        """Entries of a folder (or its whole tree) with size, updated_at, revision and optionally sha256.
        Returns (entries, truncated). Folders are always listed; `since_ns` leaves out files updated before it.
        Symlinked folders are listed but not entered, so nothing is listed twice and no loop is possible."""
        full, rel = self.resolve(rel)
        if not os.path.isdir(full):
            raise NotADirectoryError("not a folder: %s" % rel)
        entries = []

        def walk(folder, folder_rel):
            """Adds the folder's entries, each folder followed by its own; False once the limit is hit."""
            try:
                items = sorted(os.scandir(folder), key=lambda e: e.name)
            except OSError:
                return True
            for entry in items:
                if entry.name.startswith("."):
                    continue
                path = (folder_rel + "/" if folder_rel else "") + entry.name
                try:
                    target, _ = self.resolve(path)  # scope and symlink checks, as for every other access
                    st = os.stat(target)
                except (ApiError, OSError):
                    continue
                is_dir = os.path.isdir(target)
                item = {"name": entry.name, "path": path, "kind": "dir" if is_dir else "file",
                        "updated_at": iso_time(st.st_mtime_ns)}
                if not is_dir:
                    if since_ns is not None and st.st_mtime_ns < since_ns:
                        continue
                    item["size"] = st.st_size
                    item["revision"] = revision_of(st)
                    if want_hash:
                        item["sha256"] = HASHES.get(target, st)
                if len(entries) >= limit:
                    return False
                entries.append(item)
                if is_dir and recursive and not entry.is_symlink() and not walk(target, path):
                    return False
            return True

        return entries, not walk(full, rel)

    def read(self, rel):
        full, _ = self.resolve(rel)
        if not os.path.isfile(full):
            raise FileNotFoundError(full)
        with open(full, "rb") as f:
            return f.read(), revision(full)

    def write(self, rel, data, if_match=None, if_none_match=None):
        """Returns (created, revision)."""
        full, _ = self.resolve(rel)
        self.writable(full)
        if len(data) > MAX_BODY:
            raise ApiError(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, "file too large")
        try:
            data.decode("utf-8")
        except UnicodeDecodeError:
            raise ApiError(HTTPStatus.BAD_REQUEST, "body must be UTF-8 text")
        if not os.path.isdir(os.path.dirname(full)):
            raise ApiError(HTTPStatus.CONFLICT, "parent folder does not exist")
        self.check_precondition(full, if_match, if_none_match)
        created = not os.path.exists(full)
        atomic_write(full, data)
        return created, revision(full)

    def make_dir(self, rel):
        full, _ = self.resolve(rel)
        self.require_project(full)
        os.makedirs(full, exist_ok=True)

    def move(self, rel_from, rel_to):
        src, _ = self.resolve(rel_from)
        dst, _ = self.resolve(rel_to)
        self.require_project(src)
        self.require_project(dst)
        if not os.path.exists(src):
            raise FileNotFoundError(src)
        if os.path.exists(dst):
            raise ApiError(HTTPStatus.CONFLICT, "destination exists")
        if os.path.isfile(src):
            self.writable(src)
            self.writable(dst)
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        os.rename(src, dst)

    def delete(self, rel, if_match=None):
        full, _ = self.resolve(rel)
        self.writable(full)
        if not os.path.isfile(full):
            raise FileNotFoundError(full)
        self.check_precondition(full, if_match)
        os.unlink(full)


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
    mcp_workspace = None  # type: Workspace  # limited by --project
    mcp_hosts = ()  # extra Host names accepted on /mcp (--allow-host)
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
        if self.is_mcp():
            return self.mcp_stream()
        if not self.dispatch("get"):
            super().do_GET()

    def do_HEAD(self):
        if not self.dispatch("get"):
            super().do_HEAD()

    def do_PUT(self):
        if not self.dispatch("put"):
            self.send(HTTPStatus.METHOD_NOT_ALLOWED, "method not allowed")

    def do_POST(self):
        if self.is_mcp():
            return self.mcp_post()
        if not self.dispatch("post"):
            self.send(HTTPStatus.METHOD_NOT_ALLOWED, "method not allowed")

    def do_DELETE(self):
        if self.is_mcp():
            return self.send(HTTPStatus.METHOD_NOT_ALLOWED, "no sessions to close", headers={"Allow": "GET, POST"})
        if not self.dispatch("delete"):
            self.send(HTTPStatus.METHOD_NOT_ALLOWED, "method not allowed")

    # ---- MCP over HTTP ----

    def is_mcp(self):
        path = urlsplit(self.path).path
        return path == "/mcp" or path.startswith("/mcp/")

    def check_mcp_allowed(self):
        # Browsers must not reach the workspace through a rebound DNS name or another site.
        host = urlsplit("//" + self.headers.get("Host", "")).hostname
        if host not in ("127.0.0.1", "localhost", "::1", self.server.server_address[0]) \
                and host not in self.mcp_hosts:
            raise ApiError(HTTPStatus.FORBIDDEN, "unexpected Host header")
        origin = self.headers.get("Origin")
        if origin and urlsplit(origin).netloc != self.headers.get("Host", ""):
            raise ApiError(HTTPStatus.FORBIDDEN, "cross-origin request refused")

    def mcp_endpoint_workspace(self):
        """The workspace this /mcp or /mcp/PROJECT request may see (after the Host and Origin checks)."""
        self.check_mcp_allowed()
        workspace = self.mcp_workspace
        project = unquote(urlsplit(self.path).path[len("/mcp"):].strip("/"))
        return workspace.narrowed(project) if project else workspace

    def mcp_post(self):
        try:
            workspace = self.mcp_endpoint_workspace()
            try:
                message = json.loads(self.read_body().decode("utf-8"))
            except ValueError:
                return self.send_json(HTTPStatus.BAD_REQUEST, McpServer.error(None, -32700, "parse error"))
        except ApiError as e:
            return self.send(e.status, e.message)
        reply = McpServer(workspace).handle(message)
        if reply is None:
            return self.send(HTTPStatus.ACCEPTED)
        self.send_json(HTTPStatus.OK, reply)

    def mcp_stream(self):
        """GET /mcp: a server-sent event stream of task events as JSON-RPC notifications."""
        try:
            workspace = self.mcp_endpoint_workspace()
            if "text/event-stream" not in self.headers.get("Accept", ""):
                raise ApiError(HTTPStatus.NOT_ACCEPTABLE, "GET opens an event stream: send Accept: text/event-stream")
            query = parse_qs(urlsplit(self.path).query)
            names = [n for value in query.pop("event", []) for n in value.split(",") if n]
            try:
                events = check_event_names(names) if names else {e["name"] for e in MCP_EVENTS}
                filters = check_event_filters(workspace, {k: v[-1] for k, v in query.items()})
            except McpError as e:
                raise ApiError(HTTPStatus.BAD_REQUEST, e.message)
            stream = {"events": events, "filters": filters, "projects": workspace.projects,
                      "queue": queue.Queue(maxsize=STREAM_QUEUE)}
            try:
                STREAMS.open(stream)
            except OverflowError as e:
                raise ApiError(HTTPStatus.SERVICE_UNAVAILABLE, str(e))
        except ApiError as e:
            return self.send(e.status, e.message)
        try:
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", "text/event-stream; charset=utf-8")
            self.send_header("X-Accel-Buffering", "no")  # keep reverse proxies from buffering events
            self.end_headers()
            self.close_connection = True
            self.wfile.write(b"retry: %d\n\n" % STREAM_RETRY_MS)
            last = -1
            try:
                last = int(self.headers.get("Last-Event-ID", ""))
            except ValueError:
                pass
            pending = STREAMS.since(stream, last) if last >= 0 else []
            while True:
                for seq, message in pending:
                    if seq > last:  # a replayed event may also be in the queue
                        self.wfile.write(b"id: %d\nevent: message\ndata: %s\n\n" % (seq, message))
                        last = seq
                self.wfile.flush()
                try:
                    item = stream["queue"].get(timeout=STREAM_HEARTBEAT)
                except queue.Empty:
                    self.wfile.write(b": ping\n\n")
                    pending = []
                    continue
                if item is None:  # dropped for falling too far behind
                    return
                pending = [item]
        except OSError:
            pass  # the client went away
        finally:
            STREAMS.close(stream)

    # ---- API routes ----

    def api_get_ping(self, query):
        self.send(HTTPStatus.OK, "taski %s" % self.workspace.root)

    def api_get_list(self, query):
        self.send_json(HTTPStatus.OK, {"entries": self.workspace.list(query.get("path", ""))})

    def api_get_files(self, query):
        data, rev = self.workspace.read(query.get("path"))
        headers = {"ETag": rev}
        try:  # the revision is "<mtime_ns>-<size>": tell clients when the file last changed
            headers["Last-Modified"] = email.utils.formatdate(int(rev.strip('"').split("-")[0]) / 1e9, usegmt=True)
        except ValueError:
            pass
        self.send(HTTPStatus.OK, data, "text/markdown; charset=utf-8", headers)

    def api_put_files(self, query):
        # resolve and validate the path before reading a body of any size
        self.workspace.writable(self.workspace.resolve(query.get("path"))[0])
        body = self.read_body()
        events = McpServer(self.workspace)
        before = events.snapshot(query.get("path"))
        created, rev = self.workspace.write(
            query.get("path"), body,
            self.headers.get("If-Match"), self.headers.get("If-None-Match"))
        events.write_event(query.get("path"), before, created, "http-api")
        self.send(HTTPStatus.CREATED if created else HTTPStatus.OK, "", headers={"ETag": rev})

    def api_post_mkdir(self, query):
        self.workspace.make_dir(query.get("path"))
        self.send(HTTPStatus.NO_CONTENT)

    def api_post_move(self, query):
        self.workspace.move(query.get("path"), query.get("to"))
        self.send(HTTPStatus.NO_CONTENT)

    def api_delete_files(self, query):
        self.workspace.delete(query.get("path"), self.headers.get("If-Match"))
        self.send(HTTPStatus.NO_CONTENT)


# ---- MCP (Model Context Protocol): JSON-RPC 2.0 over stdio or Streamable HTTP ----

MCP_VERSIONS = ("2026-07-28", "2025-06-18", "2025-03-26", "2024-11-05")
# What to answer a client that asks for a version we do not know. Not the newest: clients
# reject a version they do not support, and most still stop at 2025-06-18.
MCP_FALLBACK_VERSION = "2025-06-18"
MCP_INSTRUCTIONS = (
    "Taski workspace of Markdown files: projects with tasks and milestones. Start with "
    "list_projects, then get_project (statuses, labels, milestones with progress) and "
    "list_tasks. Use create_task and update_task for tasks: they check values against the "
    "project's own statuses and milestones and change only the lines they must. Use "
    "read_file and write_file for everything else, after reading AGENTS.md at the workspace "
    "root (and in the project) for the file format. read_file returns a revision; pass it to "
    "write_file or delete_file so a change made meanwhile is never overwritten. Omit "
    "revision in write_file to create a new file.")

TASK_FIELDS = ("status", "priority", "due", "milestone", "tags")
# Relations between tasks, like Linear's: tool argument -> frontmatter key. Either task may record one.
RELATIONS = {"blocked_by": "blocked-by", "blocks": "blocks", "related": "related"}
RELATION_INVERSE = {"blocked_by": "blocks", "blocks": "blocked_by", "related": "related"}
PRIORITIES = ("low", "normal", "high")
DEFAULT_STATUSES = ("todo", "doing", "blocked", "done", "cancelled")
FIELD_RE = re.compile(r"^([A-Za-z][\w-]*):\s?(.*)$")
FENCE_RE = re.compile(r"^\s*(```+|~~~+)")
CHECK_RE = re.compile(r"^\s*[-*+]\s+\[([ xX])\]")


# ---- Markdown helpers: Python twins of the frontmatter functions in taski_src/markdown.js ----

def split_lines(text):
    return re.split(r"\r?\n", text)


def eol_of(text):
    return "\r\n" if "\r\n" in text else "\n"


def frontmatter_end(lines):
    """Index of the closing --- line, or -1 when there is no frontmatter."""
    if not lines or lines[0] != "---":
        return -1
    for i in range(1, len(lines)):
        if lines[i] == "---":
            return i
    return -1


def frontmatter(text):
    """(fields, body): the first value of each key, and the text after the block."""
    lines = split_lines(text)
    end = frontmatter_end(lines)
    fields = {}
    if end < 0:
        return fields, text
    for line in lines[1:end]:
        m = FIELD_RE.match(line)
        if m and m.group(1) not in fields:
            fields[m.group(1)] = m.group(2).strip()
    return fields, eol_of(text).join(lines[end + 1:])


def set_field(text, key, value):
    """Set (or with None remove) one frontmatter field, keeping every other line."""
    eol = eol_of(text)
    lines = split_lines(text)
    end = frontmatter_end(lines)
    if end < 0:
        if value is None:
            return text
        return eol.join(["---", "%s: %s" % (key, value), "---"] + lines)
    for i in range(1, end):
        m = FIELD_RE.match(lines[i])
        if m and m.group(1) == key:
            if value is None:
                del lines[i]
            else:
                lines[i] = "%s: %s" % (key, value)
            return eol.join(lines)
    if value is not None:
        lines.insert(end, "%s: %s" % (key, value))
    return eol.join(lines)


def prose_indexes(lines):
    """Indexes of the lines outside fenced code blocks."""
    out, fence = [], ""
    for i, line in enumerate(lines):
        m = FENCE_RE.match(line)
        if m:
            marker = m.group(1)[0]
            if not fence:
                fence = marker
            elif fence == marker:
                fence = ""
            continue
        if not fence:
            out.append(i)
    return out


def title_of(body, fallback):
    lines = split_lines(body)
    for i in prose_indexes(lines):
        m = re.match(r"^#\s+(.+?)\s*#*\s*$", lines[i])
        if m:
            return m.group(1)
    return fallback


def checklist_progress(text):
    lines = split_lines(text)
    items = [CHECK_RE.match(lines[i]) for i in prose_indexes(lines)]
    items = [m for m in items if m]
    return {"done": sum(1 for m in items if m.group(1) != " "), "total": len(items)}


def append_to_section(text, heading, line):
    """Add a line at the end of a `## heading` section (created when missing)."""
    eol = eol_of(text)
    lines = split_lines(text)
    want = heading.strip().lower()
    prose = prose_indexes(lines)
    start, stop = -1, len(lines)
    for i in prose:
        m = re.match(r"^(#{1,6})\s+(.+?)\s*$", lines[i])
        if not m:
            continue
        if start >= 0 and len(m.group(1)) <= 2:
            stop = i
            break
        if start < 0 and len(m.group(1)) == 2 and m.group(2).lower() == want:
            start = i + 1
    if start < 0:
        while lines and lines[-1] == "":
            lines.pop()
        lines += ["", "## %s" % heading, "", line, ""]
        return eol.join(lines)
    at = stop
    while at > start and lines[at - 1].strip() == "":
        at -= 1
    if at == start:
        lines.insert(at, "")
        lines.insert(at + 1, line)
        if at + 2 < len(lines) and lines[at + 2].strip() != "":
            lines.insert(at + 2, "")
    else:
        lines.insert(at, line)
    return eol.join(lines)


def slugify(title):
    text = unicodedata.normalize("NFKD", title.lower())
    text = "".join(c for c in text if not unicodedata.combining(c))
    text = re.sub(r"[\W_]+", "-", text, flags=re.UNICODE).strip("-")
    return text[:60].strip("-") or "untitled"


def split_list(value):
    return [item.strip() for item in (value or "").split(",") if item.strip()]


def project_model(fields):
    """Statuses, labels and milestones a project README declares (defaults when it declares none)."""
    statuses = split_list(fields.get("statuses")) or list(DEFAULT_STATUSES)

    def pick(key, fallback):
        given = [s for s in split_list(fields.get(key)) if s in statuses]
        return given or [s for s in statuses if s in fallback]

    closed = pick("closed-statuses", ("done", "cancelled"))
    if not closed and len(statuses) > 1:
        closed = [statuses[-1]]
    active = [s for s in pick("active-statuses", ("doing",)) if s not in closed]
    initial = next((s for s in statuses if s not in active and s not in closed), statuses[0])
    milestones, seen = [], set()
    for item in split_list(fields.get("milestones")):
        m = re.match(r"^(.*?)\s*\((\d{4}-\d{2}-\d{2})\)$", item)
        name = m.group(1) if m else item
        if name and name not in seen:
            seen.add(name)
            milestones.append({"name": name, "due": m.group(2) if m else ""})
    return {"statuses": statuses, "active": active, "closed": closed, "initial": initial,
            "labels": split_list(fields.get("labels")), "milestones": milestones}


def status_kind(model, status):
    return "closed" if status in model["closed"] else "active" if status in model["active"] else "open"


def valid_date(value):
    try:
        datetime.datetime.strptime(value, "%Y-%m-%d")
        return bool(re.match(r"^\d{4}-\d{2}-\d{2}$", value))
    except ValueError:
        return False


def _tool(name, title, description, properties, required, read_only=False, destructive=False,
          idempotent=False, output=None):
    tool = {
        "name": name,
        "title": title,
        "description": description,
        "inputSchema": {"type": "object", "properties": properties, "required": required},
        # Hints for clients that ask the user before risky calls. All data stays on this machine.
        "annotations": {
            "title": title,
            "readOnlyHint": read_only,
            "destructiveHint": destructive,
            "idempotentHint": idempotent,
            "openWorldHint": False,
        },
    }
    if output:
        tool["outputSchema"] = {"type": "object", "properties": output}
    return tool


_PATH = {"type": "string", "description": "Path relative to the workspace root, e.g. my-project/tasks/fix-bug.md"}
_PROJECT = {"type": "string", "description": "Project folder name, as listed by list_projects"}
_REVISION = {"type": "string", "description": "The revision returned by read_file or an earlier write"}
_TASK_PROPS = {
    "status": {"type": "string", "description": "One of the project's statuses (see get_project)"},
    "priority": {"type": "string", "enum": list(PRIORITIES)},
    "due": {"type": "string", "description": "Date as YYYY-MM-DD"},
    "milestone": {"type": "string", "description": "One of the project's milestones (see get_project)"},
    "tags": {"type": "array", "items": {"type": "string"}, "description": "The task's labels"},
    "blocked_by": {"type": "array", "items": {"type": "string"},
                   "description": "Tasks that must finish before this one: each a task's file or folder name in this project, "
                                  "or project/name. Replaces the names written on this task (the entries marked declared_here "
                                  "in list_tasks); relations written on other tasks stay."},
    "blocks": {"type": "array", "items": {"type": "string"},
               "description": "Tasks that wait for this one. Same names as blocked_by."},
    "related": {"type": "array", "items": {"type": "string"}, "description": "Related tasks. Same names as blocked_by."},
}
_TASK_OUT = {
    "path": {"type": "string"}, "title": {"type": "string"}, "status": {"type": "string"},
    "kind": {"type": "string", "enum": ["open", "active", "closed"]}, "priority": {"type": "string"},
    "due": {"type": "string"}, "milestone": {"type": "string"},
    "tags": {"type": "array", "items": {"type": "string"}},
    "progress": {"type": "object"}, "revision": {"type": "string"}, "slug": {"type": "string"},
    "sha256": {"type": "string", "description": "SHA-256 of the task file's content"},
    "blocked": {"type": "boolean", "description": "Has a blocker that is not in a closed status"},
    "blocked_by": {"type": "array", "items": {"type": "object"}},
    "blocks": {"type": "array", "items": {"type": "object"}},
    "related": {"type": "array", "items": {"type": "object"}},
    "missing_relations": {"type": "array", "items": {"type": "string"}},
}
MCP_TOOLS = [
    _tool("list_projects", "List projects",
          "List the project folders you can use. Call this first.", {}, [], read_only=True, idempotent=True,
          output={"projects": {"type": "array", "items": {"type": "object"}}}),
    _tool("get_project", "Get project overview",
          "A project's workflow and plan: its statuses (in board order, with which are active and "
          "closed), the status new tasks start in, labels, and milestones with due date and progress "
          "(tasks done of total). Read this before creating or updating tasks.",
          {"project": _PROJECT}, ["project"], read_only=True, idempotent=True,
          output={"project": {"type": "string"}, "title": {"type": "string"}, "statuses": {"type": "array"},
                  "milestones": {"type": "array"}, "task_count": {"type": "integer"}}),
    _tool("list_tasks", "List tasks",
          "List a project's tasks with their status, priority, due date, milestone, tags and checklist "
          "progress, without reading each file. Each task lists its blocked_by, blocks and related tasks "
          "(from both tasks' files) and `blocked`: true while a blocker is not finished. All filters are "
          "optional and combine with AND; open_only=true with blocked=false gives the tasks ready to start. "
          "Use read_file for a task's full text.",
          {"project": _PROJECT,
           "status": {"type": "string", "description": "Only tasks in this status"},
           "milestone": {"type": "string", "description": "Only tasks in this milestone; empty string for tasks in none"},
           "tag": {"type": "string", "description": "Only tasks with this tag"},
           "open_only": {"type": "boolean", "description": "Leave out tasks in a closed status (done, cancelled)"},
           "blocked": {"type": "boolean", "description": "true: only tasks with an unfinished blocker; false: only tasks without one"}},
          ["project"], read_only=True, idempotent=True,
          output={"project": {"type": "string"}, "count": {"type": "integer"},
                  "tasks": {"type": "array", "items": {"type": "object", "properties": _TASK_OUT}}}),
    _tool("create_task", "Create a task",
          "Create a task file in a project and link it under `## Tasks` in the project README. The "
          "task starts in the project's initial status unless you pass one. Relations (blocked_by, "
          "blocks, related) name existing tasks. Add the task body afterwards with write_file if needed.",
          dict({"project": _PROJECT, "title": {"type": "string", "description": "The task's title (its # heading)"},
                "single_file": {"type": "boolean", "description": "true (default): tasks/<name>.md; false: tasks/<name>/README.md so the task can hold files"}},
               **_TASK_PROPS), ["project", "title"],
          output=_TASK_OUT),
    _tool("update_task", "Update task fields",
          "Change a task's status, priority, due date, milestone, tags or relations (blocked_by, "
          "blocks, related). Changes only those frontmatter lines and keeps the rest of the file. "
          "Values are checked against the project (see get_project); relations must name existing "
          "tasks and may not make a task block itself, directly or through other tasks. Pass null "
          "(or an empty list/string) to clear a field; status cannot be cleared. A relation shows on "
          "both tasks whichever one it is written on, and the list you pass replaces only what is "
          "written on this task. For checklists or text use write_file.",
          {"path": dict(_PATH, description="The task file, e.g. my-project/tasks/fix-bug.md"),
           "fields": {"type": "object", "properties": _TASK_PROPS, "additionalProperties": False,
                      "description": "Only the fields to change"},
           "revision": dict(_REVISION, description="Optional: revision from read_file/list_tasks; the update is refused if the file changed since")},
          ["path", "fields"], idempotent=True, output=_TASK_OUT),
    _tool("list_files", "List files",
          "List the files and folders in a folder, or with recursive=true its whole tree. Files come with size, "
          "updated_at (UTC), revision and, with hash=true, sha256 of the content. since=<ISO time> leaves out files "
          "updated before it (folders are always listed); a deleted file simply is not listed, so to find deletions "
          "compare a full listing with an earlier one. To keep in sync, pass the reply's next_since as since next "
          "time, and read event_seq and instance to continue from the event stream.",
          {"path": {"type": "string", "description": "Folder relative to the workspace root; empty for the root"},
           "recursive": {"type": "boolean", "description": "List every file and folder below path, not only its direct entries"},
           "since": {"type": "string", "description": "ISO 8601 time, e.g. 2026-11-21T09:30:00Z: only files updated at or after it"},
           "hash": {"type": "boolean", "description": "Add sha256 of each file (null for files over 5 MB)"}}, [],
          read_only=True, idempotent=True,
          output={"path": {"type": "string"}, "entries": {"type": "array", "items": {"type": "object"}},
                  "truncated": {"type": "boolean", "description": "true when the listing stopped at its entry limit"},
                  "server_time": {"type": "string"}, "next_since": {"type": "string"},
                  "event_seq": {"type": "integer"}, "instance": {"type": "string"}, "workspace": {"type": "string"},
                  "scope": {"type": ["array", "null"], "items": {"type": "string"}}}),
    _tool("read_file", "Read file",
          "Read a Markdown or text file. Returns its content and revision.", {"path": _PATH}, ["path"],
          read_only=True, idempotent=True),
    _tool("write_file", "Write file",
          "Create or replace a Markdown or text file (.md, .markdown, .txt). To replace a file pass the "
          "revision from read_file; without a revision the file must not exist yet. Replaces the whole "
          "file: keep frontmatter keys and text you do not mean to change. Prefer update_task for task fields.",
          {"path": _PATH, "content": {"type": "string"}, "revision": _REVISION}, ["path", "content"],
          destructive=True, idempotent=True),
    _tool("make_folder", "Make folder", "Create a folder (and missing parents) inside a project.",
          {"path": _PATH}, ["path"], idempotent=True),
    _tool("move_file", "Move or rename",
          "Move or rename a file or folder. The destination must not exist. Links to it from other "
          "files are not updated.",
          {"path": _PATH, "to": _PATH}, ["path", "to"], destructive=True),
    _tool("delete_file", "Delete file",
          "Delete a Markdown or text file. Pass its revision to be safe. Links to it are not removed.",
          {"path": _PATH, "revision": _REVISION}, ["path"], destructive=True, idempotent=True),
]


def link_relations(graph):
    """Resolve each task's own blocked-by/blocks/related names into `blocked_by`, `blocks` and `related`
    on both tasks (the Python twin of linkRelations in taski_src/tasks.js). graph: {project: [task]}."""
    index = {}
    for tasks in graph.values():
        for task in tasks:
            index["%s/%s" % (task["_project"], task["slug"])] = task

    def ref(task, here):
        return {"path": task["path"], "slug": task["slug"], "title": task["title"], "status": task["status"],
                "project": task["_project"], "closed": task["kind"] == "closed", "declared_here": here}

    def add(task, kind, entry):
        for found in task[kind]:
            if found["path"] == entry["path"]:
                found["declared_here"] = found["declared_here"] or entry["declared_here"]
                return
        task[kind].append(entry)

    for tasks in graph.values():
        for task in tasks:
            for kind, names in task["_own"].items():
                for name in names:
                    target = index.get(name if "/" in name else "%s/%s" % (task["_project"], name))
                    if target is None:
                        task["missing_relations"].append(name)
                    elif target is not task:
                        add(task, kind, ref(target, True))
                        add(target, RELATION_INVERSE[kind], ref(task, False))
    for tasks in graph.values():
        for task in tasks:
            task["blocked"] = any(not r["closed"] for r in task["blocked_by"])


# ---- MCP Events: webhook delivery, signed with Standard Webhooks (standardwebhooks.com) ----

MCP_CAPABILITIES = {"tools": {}, "events": {}, "experimental": {"events": {}}}
MCP_EVENTS = [
    {
        "name": name,
        "description": description,
        "inputSchema": {
            "type": "object",
            "properties": {
                "project": {"type": "string", "description": "Only tasks of this project (top-level folder name)."},
                "status": {"type": "string", "description": "Only tasks with this status."},
                "priority": {"type": "string", "description": "Only tasks with this priority: low, normal or high."},
                "tag": {"type": "string", "description": "Only tasks that have this tag."},
            },
            "additionalProperties": False,
        },
    }
    for name, description in (
        ("task.created", "A task was created through create_task. The payload is the new task."),
        ("task.updated", "A task was changed through update_task. The payload is the task after the change, "
                         "plus `changed`: the field names that were set."),
    )
]
MAX_EVENT_BYTES = 256 * 1024
MAX_SUBSCRIPTIONS = 100
WEBHOOK_TIMEOUT = 10  # seconds per request
WEBHOOK_ATTEMPTS = 6  # first try plus five retries
WEBHOOK_BACKOFF = 1.0  # seconds before the first retry, doubled each time
WEBHOOK_BACKOFF_MAX = 300.0
# Webhook URLs must be public https by default, so a subscriber cannot aim this server at
# your LAN or loopback. --allow-private-webhooks lifts that (plain http, private addresses).
WEBHOOK_ALLOW_PRIVATE = False


class EventSubscriptions:
    """In-memory subscriptions, shared by every request; they end when the server stops."""

    def __init__(self):
        self.lock = threading.Lock()
        self.items = {}

    def add(self, sub):
        with self.lock:
            if len(self.items) >= MAX_SUBSCRIPTIONS:
                raise OverflowError("too many subscriptions; unsubscribe some first")
            self.items[sub["id"]] = sub

    def remove(self, sub_id):
        with self.lock:
            return self.items.pop(sub_id, None) is not None

    def matching(self, event, payload):
        with self.lock:
            subs = list(self.items.values())
        return [sub for sub in subs if sub["event"] == event and event_matches(sub, payload)]


def event_matches(sub, payload):
    """Whether a subscription or stream (its `projects` and `filters`) wants this payload."""
    if sub["projects"] is not None and payload.get("project") not in sub["projects"]:
        return False  # the endpoint it subscribed through cannot see this project
    return all(payload.get(k) == v if k != "tag" else v in (payload.get("tags") or [])
               for k, v in sub["filters"].items())


EVENTS = EventSubscriptions()

# ---- MCP Events over server-sent events: GET /mcp streams JSON-RPC notifications ----

MCP_EVENT_NOTIFICATION = "notifications/events/event"
MAX_STREAMS = 20  # each open stream holds one server thread
STREAM_HEARTBEAT = 15.0  # seconds between `: ping` comments, which also notice a closed connection
STREAM_RETRY_MS = 3000  # how long a client waits before reconnecting
STREAM_REPLAY = 100  # recent events kept for clients that reconnect with Last-Event-ID
STREAM_QUEUE = 1000  # events waiting for a slow client before its stream is dropped


class EventStreams:
    """Open SSE streams and the most recent events, numbered for Last-Event-ID."""

    def __init__(self):
        self.lock = threading.Lock()
        self.streams = []
        self.recent = collections.deque(maxlen=STREAM_REPLAY)  # (seq, event name, payload, message)
        # Start from the clock, not from 0: a client that reconnects after this server restarted sends the
        # Last-Event-ID of the old process, and event numbers that start over would sit below it and be skipped.
        self.seq = int(time.time() * 1000)

    def open(self, stream):
        with self.lock:
            if len(self.streams) >= MAX_STREAMS:
                raise OverflowError("too many open event streams; close some first")
            self.streams.append(stream)

    def close(self, stream):
        with self.lock:
            if stream in self.streams:
                self.streams.remove(stream)

    def publish(self, event, payload, message):
        """Queue an encoded notification for every stream that wants it; returns how many."""
        with self.lock:
            self.seq += 1
            self.recent.append((self.seq, event, payload, message))
            streams = [s for s in self.streams if event in s["events"] and event_matches(s, payload)]
            item = (self.seq, message)
        for stream in streams:
            try:
                stream["queue"].put_nowait(item)
            except queue.Full:
                self.close(stream)
                with stream["queue"].mutex:
                    stream["queue"].queue.clear()
                stream["queue"].put_nowait(None)  # tell its thread to end; the client reconnects with Last-Event-ID
        return len(streams)

    def current(self):
        """The number of the latest event; later events get higher numbers."""
        with self.lock:
            return self.seq

    def since(self, stream, seq):
        """The recent events after `seq` that this stream wants, oldest first."""
        with self.lock:
            recent = list(self.recent)
        return [(n, message) for n, event, payload, message in recent
                if n > seq and event in stream["events"] and event_matches(stream, payload)]


STREAMS = EventStreams()


def check_event_names(names):
    known = {e["name"] for e in MCP_EVENTS}
    for name in names:
        if name not in known:
            raise McpError(-32602, "unknown event: %s (see events/list)" % (name,))
    return set(names)


def check_event_filters(workspace, filters):
    """Event filters as events/subscribe takes them: non-empty strings, an allowed project."""
    schema = MCP_EVENTS[0]["inputSchema"]["properties"]  # every event takes the same filters
    if not isinstance(filters, dict) or any(k not in schema or not isinstance(v, str) or not v
                                            for k, v in filters.items()):
        raise McpError(-32602, "params must be an object of non-empty strings; allowed: %s" % ", ".join(schema))
    project = filters.get("project")
    if project and workspace.projects is not None and project not in workspace.projects:
        raise McpError(-32602, "project not allowed: %s" % project)
    return filters


def webhook_key(secret):
    """The HMAC key inside a `whsec_` secret (base64, 16 to 64 bytes once decoded)."""
    if not secret.startswith("whsec_"):
        raise ValueError("webhook secret must start with whsec_")
    try:
        key = base64.b64decode(secret[len("whsec_"):], validate=True)
    except ValueError:
        raise ValueError("webhook secret must be base64 after the whsec_ prefix")
    if not 16 <= len(key) <= 64:
        raise ValueError("webhook secret must decode to 16 to 64 bytes")
    return key


def check_webhook_url(url):
    """Refuse URLs that are not public https (unless WEBHOOK_ALLOW_PRIVATE)."""
    parts = urlsplit(url)
    try:
        host, port = parts.hostname, parts.port
    except ValueError:
        raise ValueError("webhook url is not valid")
    if parts.scheme not in ("https", "http") or not host or parts.username is not None:
        raise ValueError("webhook url must be https://host/path without credentials")
    if WEBHOOK_ALLOW_PRIVATE:
        return
    if parts.scheme != "https":
        raise ValueError("webhook url must use https")
    try:
        addresses = {info[4][0] for info in socket.getaddrinfo(host, port or 443, type=socket.SOCK_STREAM)}
    except OSError:
        raise ValueError("webhook host does not resolve")
    for address in addresses:
        ip = ipaddress.ip_address(address.split("%")[0])
        ip = getattr(ip, "ipv4_mapped", None) or ip
        if not ip.is_global:
            raise ValueError("webhook url must point to a public address")


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None  # a 3xx is an answer like any other non-2xx, never a detour to another host


_webhook_opener = urllib.request.build_opener(_NoRedirect)


def sign_webhook(key, msg_id, timestamp, body):
    signed = ("%s.%s." % (msg_id, timestamp)).encode() + body
    return "v1," + base64.b64encode(hmac.new(key, signed, hashlib.sha256).digest()).decode()


def post_webhook(url, body, key, msg_id):
    """One signed POST: (status or None when nothing answered, first bytes of the reply).
    Raises ValueError when the url is refused."""
    check_webhook_url(url)
    timestamp = str(int(time.time()))
    req = urllib.request.Request(url, data=body, method="POST", headers={
        "Content-Type": "application/json",
        "User-Agent": "taski-mcp-events",
        "webhook-id": msg_id,
        "webhook-timestamp": timestamp,
        "webhook-signature": sign_webhook(key, msg_id, timestamp, body),
    })
    try:
        with _webhook_opener.open(req, timeout=WEBHOOK_TIMEOUT) as res:
            return res.status, res.read(64 * 1024)
    except urllib.error.HTTPError as e:
        return e.code, b""
    except (urllib.error.URLError, OSError):
        return None, b""


def challenge_echoed(reply, challenge):
    """The url_verification answer is the challenge itself, as plain text or as {"challenge": ...}."""
    text = reply.decode("utf-8", "replace").strip()
    try:
        data = json.loads(text)
    except ValueError:
        return text == challenge
    return isinstance(data, dict) and data.get("challenge") == challenge


def deliver_event(sub, body, msg_id):
    for attempt in range(1, WEBHOOK_ATTEMPTS + 1):
        try:
            status, _ = post_webhook(sub["url"], body, sub["key"], msg_id)
        except ValueError as e:
            print("MCP event %s dropped: %s" % (sub["id"], e), file=sys.stderr)
            return False
        if status is not None and 200 <= status < 300:
            return True
        if attempt < WEBHOOK_ATTEMPTS:
            delay = min(WEBHOOK_BACKOFF * 2 ** (attempt - 1), WEBHOOK_BACKOFF_MAX)
            time.sleep(delay * random.uniform(1.0, 1.25))
    print("MCP event %s to subscription %s failed after %d attempts" % (msg_id, sub["id"], WEBHOOK_ATTEMPTS),
          file=sys.stderr)
    return False


def emit_mcp_event(event_name, payload):
    """Send an event to every matching webhook (in the background) and open event stream.
    Returns how many deliveries were started; never raises, so a tool call cannot fail because of it."""
    try:
        started = 0
        message = json.dumps({
            "jsonrpc": "2.0",
            "method": MCP_EVENT_NOTIFICATION,
            "params": {
                "type": event_name,
                "id": "msg_" + secrets.token_hex(12),
                "timestamp": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds"),
                "data": payload,
            },
        }, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        if len(message) > MAX_EVENT_BYTES:
            print("MCP event %s not streamed: %d bytes is over the %d limit" % (event_name, len(message), MAX_EVENT_BYTES),
                  file=sys.stderr)
        else:
            started += STREAMS.publish(event_name, payload, message)
        for sub in EVENTS.matching(event_name, payload):
            msg_id = "msg_" + secrets.token_hex(12)
            body = json.dumps({
                "type": event_name,
                "id": msg_id,
                "timestamp": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds"),
                "subscriptionId": sub["id"],
                "data": payload,
            }, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
            if len(body) > MAX_EVENT_BYTES:
                print("MCP event %s dropped: %d bytes is over the %d limit" % (event_name, len(body), MAX_EVENT_BYTES),
                      file=sys.stderr)
                continue
            threading.Thread(target=deliver_event, args=(sub, body, msg_id), daemon=True).start()
            started += 1
        return started
    except Exception as e:
        print("MCP event error: %r" % (e,), file=sys.stderr)
        return 0


class McpError(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code
        self.message = message


class McpServer:
    def __init__(self, workspace):
        self.workspace = workspace

    # -- JSON-RPC plumbing --

    def handle(self, message):
        """One JSON-RPC message in, response out (None for notifications and responses)."""
        if isinstance(message, list):
            replies = [r for r in (self.handle(m) for m in message) if r is not None]
            return replies or None
        if not isinstance(message, dict) or message.get("jsonrpc") != "2.0":
            return self.error(None, -32600, "invalid request")
        if "method" not in message:
            return None  # a response to a request we never send
        msg_id = message.get("id")
        is_notification = "id" not in message
        try:
            result = self.dispatch(message["method"], message.get("params") or {})
        except McpError as e:
            return None if is_notification else self.error(msg_id, e.code, e.message)
        except Exception as e:  # a bug here must not kill the connection
            print("MCP internal error: %r" % (e,), file=sys.stderr)
            return None if is_notification else self.error(msg_id, -32603, "internal error")
        if is_notification:
            return None
        return {"jsonrpc": "2.0", "id": msg_id, "result": result}

    @staticmethod
    def error(msg_id, code, message):
        return {"jsonrpc": "2.0", "id": msg_id, "error": {"code": code, "message": message}}

    def dispatch(self, method, params):
        if method == "initialize":
            wanted = params.get("protocolVersion")
            return {
                "protocolVersion": wanted if wanted in MCP_VERSIONS else MCP_FALLBACK_VERSION,
                "capabilities": MCP_CAPABILITIES,
                "serverInfo": {"name": "taski", "version": "1"},
                "instructions": MCP_INSTRUCTIONS,
            }
        if method == "server/discover":
            return {
                "protocolVersion": MCP_FALLBACK_VERSION,
                "supportedVersions": list(MCP_VERSIONS),
                "capabilities": MCP_CAPABILITIES,
                "serverInfo": {"name": "taski", "version": "1"},
                "instructions": MCP_INSTRUCTIONS,
            }
        if method == "ping":
            return {}
        if method == "events/list":
            return {"events": MCP_EVENTS}
        if method == "events/subscribe":
            return self.events_subscribe(params)
        if method == "events/unsubscribe":
            return self.events_unsubscribe(params)
        if method == "tools/list":
            return {"tools": MCP_TOOLS}
        if method == "tools/call":
            return self.call_tool(params.get("name"), params.get("arguments") or {})
        if method.startswith("notifications/"):
            return None
        raise McpError(-32601, "method not found: %s" % method)

    # -- events: webhooks here; the SSE stream is GET /mcp (Handler.mcp_stream). No events/poll. --

    def events_subscribe(self, params):
        name = params.get("eventName")
        check_event_names([name])
        filters = check_event_filters(self.workspace, params.get("params") or {})
        webhook = params.get("webhook")
        if not isinstance(webhook, dict) or not isinstance(webhook.get("url"), str) \
                or not isinstance(webhook.get("secret"), str):
            raise McpError(-32602, "webhook must be an object with url and secret")
        try:
            key = webhook_key(webhook["secret"])
            check_webhook_url(webhook["url"])
        except ValueError as e:
            raise McpError(-32602, str(e))
        challenge = secrets.token_urlsafe(24)
        body = json.dumps({"type": "url_verification", "challenge": challenge}, separators=(",", ":")).encode()
        try:
            status, reply = post_webhook(webhook["url"], body, key, "msg_" + secrets.token_hex(12))
        except ValueError as e:
            raise McpError(-32602, str(e))
        if status is None or not 200 <= status < 300:
            raise McpError(-32602, "webhook verification failed: the url answered %s" % (status or "nothing"))
        if not challenge_echoed(reply, challenge):
            raise McpError(-32602, "webhook verification failed: the response did not echo the challenge")
        sub_id = "sub_" + secrets.token_urlsafe(18)
        try:
            EVENTS.add({"id": sub_id, "event": name, "filters": filters, "url": webhook["url"], "key": key,
                        "projects": self.workspace.projects})
        except OverflowError as e:
            raise McpError(-32000, str(e))
        return {"subscriptionId": sub_id}

    @staticmethod
    def events_unsubscribe(params):
        sub_id = params.get("subscriptionId")
        if not isinstance(sub_id, str) or not EVENTS.remove(sub_id):
            raise McpError(-32602, "unknown subscriptionId")
        return {}

    # -- tools --

    def call_tool(self, name, args):
        tool = getattr(self, "tool_%s" % name, None) if name in [t["name"] for t in MCP_TOOLS] else None
        if tool is None:
            raise McpError(-32602, "unknown tool: %s" % name)
        if not isinstance(args, dict):
            raise McpError(-32602, "arguments must be an object")
        try:
            return self.text(tool(args))
        except ApiError as e:
            hint = ""
            if e.status == HTTPStatus.PRECONDITION_FAILED:
                hint = " Read the file again to get its current revision, redo your change on that, and retry."
            return self.text(e.message + hint, error=True)
        except FileNotFoundError:
            return self.text("not found: check the path with list_files or list_projects", error=True)
        except (NotADirectoryError, IsADirectoryError) as e:
            return self.text(str(e), error=True)
        except PermissionError as e:
            return self.text(str(e), error=True)

    @staticmethod
    def text(value, error=False):
        """Tool result. Objects go out twice: as text for any client, as structuredContent for those that parse it."""
        result = {}
        if isinstance(value, dict) and not error:
            result["structuredContent"] = value
        if not isinstance(value, str):
            value = json.dumps(value, ensure_ascii=False, indent=2)
        result["content"] = [{"type": "text", "text": value}]
        result["isError"] = error
        return result

    @staticmethod
    def arg(args, key, required=True):
        value = args.get(key)
        if value is None and not required:
            return None
        if not isinstance(value, str):
            raise ApiError(HTTPStatus.BAD_REQUEST, "%s must be a string" % key)
        return value

    # -- task helpers --

    def load_project(self, project):
        """(model, readme_text) of a project; the project must exist and be allowed."""
        if not project or "/" in project or "\\" in project or project.startswith("."):
            raise ApiError(HTTPStatus.BAD_REQUEST, "project must be a top-level folder name, see list_projects")
        names = [e["name"] for e in self.workspace.list("") if e["kind"] == "dir"]
        if project not in names:
            raise ApiError(HTTPStatus.NOT_FOUND, "no such project: %s. Available: %s" % (project, ", ".join(names) or "none"))
        try:
            data, _ = self.workspace.read(project + "/README.md")
            text = data.decode("utf-8")
        except (FileNotFoundError, UnicodeDecodeError):
            text = ""
        fields, _ = frontmatter(text)
        return project_model(fields), text

    def task_paths(self, project):
        """Every task file of a project: tasks/NAME.md and tasks/NAME/README.md."""
        try:
            entries = self.workspace.list(project + "/tasks")
        except (FileNotFoundError, NotADirectoryError):
            return []
        paths = []
        for entry in entries:
            if entry["kind"] == "file" and entry["name"].lower().endswith(".md"):
                paths.append(entry["path"])
            elif entry["kind"] == "dir":
                readme = entry["path"] + "/README.md"
                if os.path.isfile(self.workspace.resolve(readme)[0]):
                    paths.append(readme)
        return paths

    @staticmethod
    def task_summary(path, text, rev, model):
        """The task as the tools report it. Keys starting with _ are internal (see public())."""
        fields, body = frontmatter(text)
        name = path.rsplit("/", 1)[-1]
        slug = path.rsplit("/", 2)[-2] if name.lower() == "readme.md" else name[:-3]
        status = fields.get("status") or "todo"
        return {
            "_project": path.split("/", 1)[0],
            "_own": {kind: split_list(fields.get(key)) for kind, key in RELATIONS.items()},
            "path": path,
            "slug": slug,
            "title": title_of(body, slug),
            "status": status,
            "kind": status_kind(model, status),
            "priority": fields.get("priority") or "normal",
            "due": fields.get("due") or "",
            "milestone": fields.get("milestone") or "",
            "tags": split_list(fields.get("tags")),
            "progress": checklist_progress(text),
            "revision": rev,
            "sha256": hashlib.sha256(text.encode("utf-8")).hexdigest(),
            "blocked": False,
            "blocked_by": [],
            "blocks": [],
            "related": [],
            "missing_relations": [],
        }

    @staticmethod
    def public(task):
        return {k: v for k, v in task.items() if not k.startswith("_")}

    def load_tasks(self, project, model):
        tasks = []
        for path in self.task_paths(project):
            try:
                data, rev = self.workspace.read(path)
                tasks.append(self.task_summary(path, data.decode("utf-8"), rev, model))
            except (FileNotFoundError, UnicodeDecodeError):
                continue
        return tasks

    def load_graph(self):
        """Every allowed project's tasks with their relations resolved: ({project: model}, {project: [task]})."""
        models, graph = {}, {}
        for entry in self.workspace.list(""):
            if entry["kind"] != "dir":
                continue
            try:
                models[entry["name"]], _ = self.load_project(entry["name"])
            except ApiError:
                continue
            graph[entry["name"]] = self.load_tasks(entry["name"], models[entry["name"]])
        link_relations(graph)
        return models, graph

    @staticmethod
    def find_task(graph, path):
        for tasks in graph.values():
            for task in tasks:
                if task["path"] == path:
                    return task
        return None

    def checked_relation(self, kind, value, task, graph):
        """The names to write on `task` for a relation field (a list), or None to clear it.

        `task` is the task being changed, or a stand-in for one being created (its _project and path).
        """
        if value is None or value == "" or value == []:
            return None
        names = value if isinstance(value, list) else split_list(value) if isinstance(value, str) else None
        if names is None or not all(isinstance(n, str) and n.strip() and "," not in n and "\n" not in n for n in names):
            raise ApiError(HTTPStatus.BAD_REQUEST, "%s must be a list of task names" % kind)
        project = task["_project"]
        index = {"%s/%s" % (p, t["slug"]): t for p, tasks in graph.items() for t in tasks}
        by_path = {t["path"]: t for t in index.values()}
        stored = []
        for raw in names:
            raw = raw.strip()
            target = by_path.get(raw)
            if target is None:
                target = index.get(raw if "/" in raw else "%s/%s" % (project, raw))
            if target is None:
                others = sorted(t["slug"] for t in graph.get(project, []) if t is not task)
                raise ApiError(HTTPStatus.BAD_REQUEST, "no task %r in project %s. Use a task's slug (its file or folder name) "
                               "or project/slug. Tasks here: %s" % (raw, project, ", ".join(others[:50]) or "none"))
            if target is task:
                raise ApiError(HTTPStatus.BAD_REQUEST, "a task cannot be related to itself")
            name = target["slug"] if target["_project"] == project else "%s/%s" % (target["_project"], target["slug"])
            if name not in stored:
                stored.append(name)
        return stored

    @staticmethod
    def blocks_itself(task, new_blockers, graph):
        """Name of a task that would end up blocking itself, or None. `new_blockers` are paths that will block `task`."""
        by_path = {t["path"]: t for tasks in graph.values() for t in tasks}
        for start in new_blockers:
            seen, stack = set(), [start]
            while stack:
                path = stack.pop()
                if path == task["path"]:
                    return by_path[start]["title"]
                if path in seen or path not in by_path:
                    continue
                seen.add(path)
                stack.extend(r["path"] for r in by_path[path]["blocked_by"])
        return None

    def check_no_cycle(self, task, own, graph):
        """`own` maps relation -> names about to be written on `task`. Refuses relations that make it block itself."""
        index = {"%s/%s" % (p, t["slug"]): t for p, tasks in graph.items() for t in tasks}

        def resolved(kind):  # {name: path} for the names that match a task (a file may still hold stale ones)
            out = {}
            for name in own.get(kind, []):
                found = index.get(name if "/" in name else "%s/%s" % (task["_project"], name))
                if found is not None:
                    out[name] = found["path"]
            return out

        blockers, blocked = resolved("blocked_by"), resolved("blocks")
        if set(blockers.values()) & set(blocked.values()):
            raise ApiError(HTTPStatus.BAD_REQUEST, "a task cannot both block and be blocked by the same task")
        old = task["_own"]
        for name, path in blockers.items():
            if name in old.get("blocked_by", []):
                continue
            hit = self.blocks_itself(task, [path], graph)
            if hit:
                raise ApiError(HTTPStatus.BAD_REQUEST, "%r is already blocked by this task, directly or through other tasks, "
                               "so it cannot also block it" % hit)
        for name, path in blocked.items():
            if name in old.get("blocks", []):
                continue
            other = self.find_task(graph, path)
            if other is not None and self.blocks_itself(other, [task["path"]], graph):
                raise ApiError(HTTPStatus.BAD_REQUEST, "this task is already blocked by %r, directly or through other "
                               "tasks, so it cannot block it" % other["title"])

    @staticmethod
    def checked_value(key, value, model):
        """A field value ready for the frontmatter, or None to clear it. Raises with a fix hint."""
        if value is None or value == "" or value == []:
            if key == "status":
                raise ApiError(HTTPStatus.BAD_REQUEST, "status cannot be cleared; choose one of: %s" % ", ".join(model["statuses"]))
            return None
        if key == "tags":
            tags = value if isinstance(value, list) else split_list(value) if isinstance(value, str) else None
            if tags is None or not all(isinstance(t, str) and t.strip() and "," not in t and "\n" not in t for t in tags):
                raise ApiError(HTTPStatus.BAD_REQUEST, "tags must be a list of non-empty strings without commas")
            return ", ".join(t.strip() for t in tags)
        if not isinstance(value, str) or "\n" in value or "\r" in value:
            raise ApiError(HTTPStatus.BAD_REQUEST, "%s must be a single-line string" % key)
        value = value.strip()
        if key == "status" and value not in model["statuses"]:
            raise ApiError(HTTPStatus.BAD_REQUEST, "unknown status %r; this project uses: %s" % (value, ", ".join(model["statuses"])))
        if key == "priority" and value not in PRIORITIES:
            raise ApiError(HTTPStatus.BAD_REQUEST, "unknown priority %r; use: %s" % (value, ", ".join(PRIORITIES)))
        if key == "due" and not valid_date(value):
            raise ApiError(HTTPStatus.BAD_REQUEST, "due must be a real date as YYYY-MM-DD, got %r" % value)
        if key == "milestone" and value not in [m["name"] for m in model["milestones"]]:
            listed = ", ".join(m["name"] for m in model["milestones"])
            raise ApiError(HTTPStatus.BAD_REQUEST, "unknown milestone %r; this project's milestones: %s. To add one, "
                           "extend `milestones:` in the project README first." % (value, listed or "none"))
        return value

    # -- tools --

    def tool_list_projects(self, args):
        ws = self.workspace
        projects = []
        for entry in ws.list(""):
            if entry["kind"] == "dir":
                has_readme = os.path.isfile(os.path.join(ws.root, entry["name"], "README.md"))
                projects.append({"name": entry["name"], "readme": entry["name"] + "/README.md" if has_readme else None})
        return {"projects": projects}

    def tool_get_project(self, args):
        project = self.arg(args, "project")
        model, text = self.load_project(project)
        fields, body = frontmatter(text)
        _, graph = self.load_graph()
        tasks = graph.get(project, [])
        milestones = []
        listed = {m["name"] for m in model["milestones"]}
        extra = sorted({t["milestone"] for t in tasks if t["milestone"] and t["milestone"] not in listed})
        for m in model["milestones"] + [{"name": n, "due": ""} for n in extra]:
            mine = [t for t in tasks if t["milestone"] == m["name"]]
            closed = sum(1 for t in mine if t["kind"] == "closed")
            milestones.append(dict(m, listed=m["name"] in listed, total=len(mine), done=closed, open=len(mine) - closed))
        return {
            "project": project,
            "title": title_of(body, project),
            "status": fields.get("status") or "active",
            "statuses": model["statuses"],
            "active_statuses": model["active"],
            "closed_statuses": model["closed"],
            "initial_status": model["initial"],
            "labels": model["labels"],
            "milestones": milestones,
            "task_count": len(tasks),
            "open_task_count": sum(1 for t in tasks if t["kind"] != "closed"),
            "blocked_task_count": sum(1 for t in tasks if t["kind"] != "closed" and t["blocked"]),
        }

    def tool_list_tasks(self, args):
        project = self.arg(args, "project")
        model, _ = self.load_project(project)
        status = self.arg(args, "status", False)
        milestone = self.arg(args, "milestone", False)
        tag = self.arg(args, "tag", False)
        flags = {}
        for key in ("open_only", "blocked"):
            flags[key] = args.get(key)
            if flags[key] is not None and not isinstance(flags[key], bool):
                raise ApiError(HTTPStatus.BAD_REQUEST, "%s must be true or false" % key)
        _, graph = self.load_graph()
        tasks = list(graph.get(project, []))
        if status is not None:
            tasks = [t for t in tasks if t["status"] == status]
        if milestone is not None:
            tasks = [t for t in tasks if t["milestone"] == milestone]
        if tag is not None:
            tasks = [t for t in tasks if tag in t["tags"]]
        if flags["open_only"]:
            tasks = [t for t in tasks if t["kind"] != "closed"]
        if flags["blocked"] is not None:
            tasks = [t for t in tasks if t["blocked"] == flags["blocked"]]
        order = {s: i for i, s in enumerate(model["statuses"])}
        tasks.sort(key=lambda t: (order.get(t["status"], len(order)), t["title"].lower()))
        return {"project": project, "count": len(tasks), "tasks": [self.public(t) for t in tasks]}

    def tool_create_task(self, args):
        project = self.arg(args, "project")
        title = " ".join(self.arg(args, "title").split())
        if not title:
            raise ApiError(HTTPStatus.BAD_REQUEST, "title must not be empty")
        single = args.get("single_file", True)
        if not isinstance(single, bool):
            raise ApiError(HTTPStatus.BAD_REQUEST, "single_file must be true or false")
        model, readme = self.load_project(project)
        values = {}
        for key in TASK_FIELDS:
            if key in args:
                value = self.checked_value(key, args[key], model)
                if value is not None:
                    values[key] = value
        base = slugify(title)
        slug, n = base, 2

        def path_for(name):
            return "%s/tasks/%s" % (project, name + ".md" if single else name + "/README.md")

        def taken(name):  # tasks/NAME.md and tasks/NAME/ would be the same task name
            return any(os.path.exists(self.workspace.resolve("%s/tasks/%s" % (project, name + ext))[0]) for ext in (".md", ""))

        while taken(slug):
            slug = "%s-%d" % (base, n)
            n += 1
        path = path_for(slug)
        relations = {}
        if any(kind in args for kind in RELATIONS):
            _, graph = self.load_graph()
            new = {"_project": project, "path": path, "title": title, "_own": {}}
            for kind in RELATIONS:
                names = self.checked_relation(kind, args.get(kind), new, graph) if kind in args else None
                if names:
                    relations[kind] = names
            self.check_no_cycle(new, relations, graph)
        text = "\n".join(["---", "type: task", "status: %s" % model["initial"], "priority: normal",
                          "created: %s" % datetime.date.today().isoformat(), "---", "", "# %s" % title, "", ""])
        for key in TASK_FIELDS:
            if key in values:
                text = set_field(text, key, values[key])
        for kind, names in relations.items():
            text = set_field(text, RELATIONS[kind], ", ".join(names))
        self.workspace.make_dir("%s/tasks" % project)
        if not single:
            self.workspace.make_dir("%s/tasks/%s" % (project, slug))
        self.workspace.write(path, text.encode("utf-8"), if_none_match="*")

        link = "- [%s](%s)" % (re.sub(r"[\[\]]", "", title), path[len(project) + 1:])
        readme_path = project + "/README.md"
        if readme:
            _, readme_rev = self.workspace.read(readme_path)
            self.workspace.write(readme_path, append_to_section(readme, "Tasks", link).encode("utf-8"), if_match=readme_rev)
        else:
            fresh = "\n".join(["---", "type: project", "status: active", "---", "", "# %s" % project, "", "## Tasks", "", link, ""])
            self.workspace.write(readme_path, fresh.encode("utf-8"), if_none_match="*")
        created = self.public(self.find_task(self.load_graph()[1], path))
        emit_mcp_event("task.created", dict(created, project=project))
        return created

    def tool_update_task(self, args):
        path = self.arg(args, "path")
        fields = args.get("fields")
        allowed = TASK_FIELDS + tuple(RELATIONS)
        if not isinstance(fields, dict) or not fields:
            raise ApiError(HTTPStatus.BAD_REQUEST, "fields must be an object with at least one of: %s" % ", ".join(allowed))
        unknown = [k for k in fields if k not in allowed]
        if unknown:
            raise ApiError(HTTPStatus.BAD_REQUEST, "cannot set %s here; allowed: %s. Use write_file for other fields."
                           % (", ".join(unknown), ", ".join(allowed)))
        parts = self.workspace.resolve(path)[1].split("/")
        if len(parts) < 3 or parts[1] != "tasks" or not parts[-1].lower().endswith(".md"):
            raise ApiError(HTTPStatus.BAD_REQUEST, "path must be a task file like <project>/tasks/<name>.md")
        project = parts[0]
        model, _ = self.load_project(project)
        data, current = self.workspace.read(path)
        try:
            text = data.decode("utf-8")
        except UnicodeDecodeError:
            raise ApiError(HTTPStatus.CONFLICT, "not a UTF-8 text file")
        wanted = self.arg(args, "revision", False)
        if wanted and wanted != current:
            raise ApiError(HTTPStatus.PRECONDITION_FAILED, "file changed since it was read")
        checked = {k: self.checked_value(k, v, model) for k, v in fields.items() if k in TASK_FIELDS}
        relations = {}
        if any(k in fields for k in RELATIONS):
            _, graph = self.load_graph()
            task = self.find_task(graph, path)
            if task is None:
                raise ApiError(HTTPStatus.BAD_REQUEST, "not a task of project %s: %s" % (project, path))
            for kind in RELATIONS:
                if kind in fields:
                    relations[kind] = self.checked_relation(kind, fields[kind], task, graph)
            # the lists as they will be on this task, for the cycle check
            final = {kind: relations[kind] if kind in relations else task["_own"][kind] for kind in RELATIONS}
            self.check_no_cycle(task, {k: v or [] for k, v in final.items()}, graph)
        for key in TASK_FIELDS:  # a fixed order, whatever order the caller used
            if key in checked:
                text = set_field(text, key, checked[key])
        for kind, names in relations.items():
            text = set_field(text, RELATIONS[kind], ", ".join(names) if names else None)
        self.workspace.write(path, text.encode("utf-8"), if_match=current)
        updated = self.public(self.find_task(self.load_graph()[1], path))
        emit_mcp_event("task.updated", dict(updated, project=project, changed=sorted(fields)))
        return updated

    @staticmethod
    def flag(args, key):
        value = args.get(key, False)
        if not isinstance(value, bool):
            raise ApiError(HTTPStatus.BAD_REQUEST, "%s must be true or false" % key)
        return value

    def tool_list_files(self, args):
        path = self.arg(args, "path", False) or ""
        recursive, want_hash = self.flag(args, "recursive"), self.flag(args, "hash")
        since = self.arg(args, "since", False)
        since_ns = parse_time(since, "since") if since else None
        # Both are read before the walk: an event numbered above event_seq, or a file updated at or after
        # next_since, may be missing from this listing; anything older is in it.
        seq = STREAMS.current()
        started = time.time_ns()
        entries, truncated = self.workspace.details(path, recursive, since_ns, want_hash)
        ws = self.workspace
        return {
            "path": ws.resolve(path)[1],
            "entries": entries,
            "truncated": truncated,
            "server_time": iso_time(started),
            "next_since": iso_time(started - SINCE_MARGIN_NS),
            "event_seq": seq,
            "instance": SERVER_INSTANCE,
            # The same folder gives the same id, so a client can tell it is looking at another workspace.
            "workspace": hashlib.sha256(ws.root.encode("utf-8")).hexdigest()[:16],
            "scope": list(ws.projects) if ws.projects is not None else None,
        }

    def tool_read_file(self, args):
        path = self.arg(args, "path")
        data, rev = self.workspace.read(path)
        try:
            content = data.decode("utf-8")
        except UnicodeDecodeError:
            raise ApiError(HTTPStatus.CONFLICT, "not a UTF-8 text file")
        return {"path": path, "revision": rev, "content": content}

    # -- events for plain writes of task files (the browser app, write_file) --

    def snapshot(self, path):
        """The text of an existing file before it is overwritten, or None (missing, unreadable, not text)."""
        try:
            return self.workspace.read(path)[0].decode("utf-8")
        except (OSError, ApiError, UnicodeDecodeError):
            return None

    def write_event(self, path, before, created, via):
        """After a plain write of a task file, send task.created or task.updated like create_task and
        update_task do, with `changed` listing what differs from `before`. Never raises: a write has
        already happened and must not fail because of an event."""
        try:
            parts = self.workspace.resolve(path)[1].split("/")
            is_task = len(parts) >= 3 and parts[1] == "tasks" and parts[-1].lower().endswith(".md") \
                and (len(parts) == 3 or (len(parts) == 4 and parts[-1].lower() == "readme.md"))
            if not is_task:
                return
            model, _ = self.load_project(parts[0])
            data, rev = self.workspace.read(path)
            text = data.decode("utf-8")
            payload = dict(self.public(self.task_summary(path, text, rev, model)), project=parts[0], via=via)
            if created or before is None:
                emit_mcp_event("task.created", payload)
                return
            changed = self.changed_fields(before, text)
            if changed:
                emit_mcp_event("task.updated", dict(payload, changed=changed))
        except Exception as e:
            print("MCP event for %s not sent: %r" % (path, e), file=sys.stderr)

    @staticmethod
    def changed_fields(before, after):
        """Names of what differs between two versions of a task file, using update_task's field names."""
        old_fields, old_body = frontmatter(before)
        new_fields, new_body = frontmatter(after)
        keys = {name: name for name in TASK_FIELDS}
        keys.update({name: key for name, key in RELATIONS.items()})
        changed = [name for name, key in keys.items() if old_fields.get(key, "") != new_fields.get(key, "")]
        known = set(keys.values())
        if any(old_fields.get(k) != new_fields.get(k) for k in (set(old_fields) | set(new_fields)) - known):
            changed.append("frontmatter")
        if title_of(old_body, "") != title_of(new_body, ""):
            changed.append("title")
        if old_body != new_body:
            changed.append("content")
        return sorted(changed)

    def tool_write_file(self, args):
        path = self.arg(args, "path")
        data = self.arg(args, "content").encode("utf-8")
        rev = self.arg(args, "revision", False)
        # with a revision: replace only that version; without: create only
        before = self.snapshot(path)
        created, new_rev = self.workspace.write(path, data, if_match=rev, if_none_match=None if rev else "*")
        self.write_event(path, before, created, "write_file")
        return {"path": path, "created": created, "revision": new_rev}

    def tool_make_folder(self, args):
        self.workspace.make_dir(self.arg(args, "path"))
        return "ok"

    def tool_move_file(self, args):
        self.workspace.move(self.arg(args, "path"), self.arg(args, "to"))
        return "ok"

    def tool_delete_file(self, args):
        self.workspace.delete(self.arg(args, "path"), self.arg(args, "revision", False))
        return "ok"


def serve_stdio(mcp, stdin=None, stdout=None):
    """Newline-delimited JSON-RPC on stdin/stdout; everything else goes to stderr."""
    stdin = stdin or sys.stdin
    stdout = stdout or sys.stdout
    for line in stdin:
        line = line.strip()
        if not line:
            continue
        try:
            reply = mcp.handle(json.loads(line))
        except ValueError:
            reply = McpServer.error(None, -32700, "parse error")
        if reply is not None:
            stdout.write(json.dumps(reply, ensure_ascii=False) + "\n")
            stdout.flush()


def make_server(root, host="127.0.0.1", port=8000, quiet=False, projects=None, allow_hosts=()):
    handler = type("BoundHandler", (Handler,), {
        "workspace": Workspace(root, projects),
        "mcp_workspace": Workspace(root, projects),
        "mcp_hosts": tuple(allow_hosts),
    })
    server = ThreadingHTTPServer((host, port), handler)
    server.quiet = quiet
    return server


def main(argv=None):
    parser = argparse.ArgumentParser(description="Serve Taski with read/write access to a local Markdown workspace.")
    parser.add_argument("--root", default=os.path.join(APP_DIR, "taski-demo"), help="workspace folder (default: ./taski-demo)")
    parser.add_argument("--host", default="127.0.0.1", help="bind address (default: 127.0.0.1)")
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument("--project", action="append", metavar="NAME",
                        help="limit MCP and the web app to this top-level project folder (repeatable; default: all)")
    parser.add_argument("--allow-host", action="append", metavar="HOST", default=[],
                        help="also accept this Host name on /mcp, e.g. a LAN IP or DNS name (repeatable)")
    parser.add_argument("--allow-private-webhooks", action="store_true",
                        help="let MCP event webhooks use http and private or loopback addresses (default: public https only)")
    parser.add_argument("--mcp", action="store_true",
                        help="speak MCP on stdin/stdout instead of serving HTTP")
    args = parser.parse_args(argv)

    global WEBHOOK_ALLOW_PRIVATE
    WEBHOOK_ALLOW_PRIVATE = args.allow_private_webhooks
    root = os.path.expanduser(args.root)
    if not os.path.isdir(root):
        sys.exit("Workspace folder not found: %s" % root)
    for name in args.project or []:
        if name.startswith(".") or "/" in name or not os.path.isdir(os.path.join(root, name)):
            sys.exit("Project folder not found in %s: %s" % (root, name))

    if args.mcp:
        print("Taski MCP (stdio): %s" % os.path.realpath(root), file=sys.stderr)
        try:
            serve_stdio(McpServer(Workspace(root, args.project)))
        except KeyboardInterrupt:
            pass
        return

    if args.host not in ("127.0.0.1", "localhost", "::1"):
        print("Warning: binding to %s exposes your files to the network." % args.host, file=sys.stderr)

    server = make_server(root, args.host, args.port, projects=args.project, allow_hosts=args.allow_host)
    print("Taski workspace: %s" % os.path.realpath(root))
    print("Open http://%s:%d/taski.html" % (args.host, args.port))
    print("MCP:  http://%s:%d/mcp%s" % (args.host, args.port, "  (projects: %s)" % ", ".join(args.project) if args.project else ""))
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
