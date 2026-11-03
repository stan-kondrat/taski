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
    python3 server.py --mcp   stdio instead of HTTP (the agent starts the process)
`--project NAME` (repeatable) limits MCP to those top-level project folders; the
browser API keeps the whole workspace. Tools: list_projects, list_files, read_file,
write_file, make_folder, move_file, delete_file.
"""

import argparse
import json
import os
import sys
import tempfile
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
    st = os.stat(path)
    return '"%d-%d"' % (st.st_mtime_ns, st.st_size)


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
            return self.send(HTTPStatus.METHOD_NOT_ALLOWED, "use POST", headers={"Allow": "POST"})
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
            return self.send(HTTPStatus.METHOD_NOT_ALLOWED, "no sessions to close", headers={"Allow": "POST"})
        if not self.dispatch("delete"):
            self.send(HTTPStatus.METHOD_NOT_ALLOWED, "method not allowed")

    # ---- MCP over HTTP ----

    def is_mcp(self):
        path = urlsplit(self.path).path
        return path == "/mcp" or path.startswith("/mcp/")

    def check_mcp_allowed(self):
        # Browsers must not reach the workspace through a rebound DNS name or another site.
        host = urlsplit("//" + self.headers.get("Host", "")).hostname
        if host not in ("127.0.0.1", "localhost", "::1", self.server.server_address[0]):
            raise ApiError(HTTPStatus.FORBIDDEN, "unexpected Host header")
        origin = self.headers.get("Origin")
        if origin and urlsplit(origin).netloc != self.headers.get("Host", ""):
            raise ApiError(HTTPStatus.FORBIDDEN, "cross-origin request refused")

    def mcp_post(self):
        try:
            self.check_mcp_allowed()
            workspace = self.mcp_workspace
            project = unquote(urlsplit(self.path).path[len("/mcp"):].strip("/"))
            if project:
                workspace = workspace.narrowed(project)
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

    # ---- API routes ----

    def api_get_ping(self, query):
        self.send(HTTPStatus.OK, "taski %s" % self.workspace.root)

    def api_get_list(self, query):
        self.send_json(HTTPStatus.OK, {"entries": self.workspace.list(query.get("path", ""))})

    def api_get_files(self, query):
        data, rev = self.workspace.read(query.get("path"))
        self.send(HTTPStatus.OK, data, "text/markdown; charset=utf-8", {"ETag": rev})

    def api_put_files(self, query):
        # resolve and validate the path before reading a body of any size
        self.workspace.writable(self.workspace.resolve(query.get("path"))[0])
        created, rev = self.workspace.write(
            query.get("path"), self.read_body(),
            self.headers.get("If-Match"), self.headers.get("If-None-Match"))
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

MCP_VERSIONS = ("2025-06-18", "2025-03-26", "2024-11-05")
MCP_INSTRUCTIONS = (
    "Taski workspace of Markdown files. Read AGENTS.md at the workspace root (and in a "
    "project) for the file format before editing. read_file returns a revision; pass it "
    "to write_file or delete_file so a change made meanwhile is never overwritten. "
    "Omit revision in write_file to create a new file.")


def _tool(name, description, properties, required):
    return {
        "name": name,
        "description": description,
        "inputSchema": {"type": "object", "properties": properties, "required": required},
    }


_PATH = {"type": "string", "description": "Path relative to the workspace root, e.g. my-project/tasks/fix-bug.md"}
MCP_TOOLS = [
    _tool("list_projects", "List the project folders you can use.", {}, []),
    _tool("list_files", "List the files and folders in a folder.",
          {"path": {"type": "string", "description": "Folder relative to the workspace root; empty for the root"}}, []),
    _tool("read_file", "Read a Markdown or text file. Returns its content and revision.", {"path": _PATH}, ["path"]),
    _tool("write_file",
          "Create or replace a Markdown or text file (.md, .markdown, .txt). To replace a file pass the "
          "revision from read_file; without a revision the file must not exist yet.",
          {"path": _PATH, "content": {"type": "string"}, "revision": {"type": "string"}}, ["path", "content"]),
    _tool("make_folder", "Create a folder (and missing parents) inside a project.", {"path": _PATH}, ["path"]),
    _tool("move_file", "Move or rename a file or folder. The destination must not exist.",
          {"path": _PATH, "to": _PATH}, ["path", "to"]),
    _tool("delete_file", "Delete a Markdown or text file. Pass its revision to be safe.",
          {"path": _PATH, "revision": {"type": "string"}}, ["path"]),
]


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
                "protocolVersion": wanted if wanted in MCP_VERSIONS else MCP_VERSIONS[0],
                "capabilities": {"tools": {}},
                "serverInfo": {"name": "taski", "version": "1"},
                "instructions": MCP_INSTRUCTIONS,
            }
        if method == "ping":
            return {}
        if method == "tools/list":
            return {"tools": MCP_TOOLS}
        if method == "tools/call":
            return self.call_tool(params.get("name"), params.get("arguments") or {})
        if method.startswith("notifications/"):
            return None
        raise McpError(-32601, "method not found: %s" % method)

    # -- tools --

    def call_tool(self, name, args):
        tool = getattr(self, "tool_%s" % name, None) if name in [t["name"] for t in MCP_TOOLS] else None
        if tool is None:
            raise McpError(-32602, "unknown tool: %s" % name)
        try:
            return self.text(tool(args))
        except ApiError as e:
            return self.text(e.message, error=True)
        except FileNotFoundError:
            return self.text("not found", error=True)
        except (NotADirectoryError, IsADirectoryError) as e:
            return self.text(str(e), error=True)
        except PermissionError as e:
            return self.text(str(e), error=True)

    @staticmethod
    def text(value, error=False):
        if not isinstance(value, str):
            value = json.dumps(value, ensure_ascii=False, indent=2)
        return {"content": [{"type": "text", "text": value}], "isError": error}

    @staticmethod
    def arg(args, key, required=True):
        value = args.get(key)
        if value is None and not required:
            return None
        if not isinstance(value, str):
            raise ApiError(HTTPStatus.BAD_REQUEST, "%s must be a string" % key)
        return value

    def tool_list_projects(self, args):
        ws = self.workspace
        projects = []
        for entry in ws.list(""):
            if entry["kind"] == "dir":
                has_readme = os.path.isfile(os.path.join(ws.root, entry["name"], "README.md"))
                projects.append({"name": entry["name"], "readme": entry["name"] + "/README.md" if has_readme else None})
        return {"projects": projects}

    def tool_list_files(self, args):
        return {"entries": self.workspace.list(self.arg(args, "path", False) or "")}

    def tool_read_file(self, args):
        path = self.arg(args, "path")
        data, rev = self.workspace.read(path)
        try:
            content = data.decode("utf-8")
        except UnicodeDecodeError:
            raise ApiError(HTTPStatus.CONFLICT, "not a UTF-8 text file")
        return {"path": path, "revision": rev, "content": content}

    def tool_write_file(self, args):
        path = self.arg(args, "path")
        data = self.arg(args, "content").encode("utf-8")
        rev = self.arg(args, "revision", False)
        # with a revision: replace only that version; without: create only
        created, new_rev = self.workspace.write(path, data, if_match=rev, if_none_match=None if rev else "*")
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


def make_server(root, host="127.0.0.1", port=8000, quiet=False, projects=None):
    handler = type("BoundHandler", (Handler,), {
        "workspace": Workspace(root),
        "mcp_workspace": Workspace(root, projects),
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
                        help="limit MCP to this top-level project folder (repeatable; default: all)")
    parser.add_argument("--mcp", action="store_true",
                        help="speak MCP on stdin/stdout instead of serving HTTP")
    args = parser.parse_args(argv)

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

    server = make_server(root, args.host, args.port, projects=args.project)
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
