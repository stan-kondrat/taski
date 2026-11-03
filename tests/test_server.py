import json
import os
import shutil
import sys
import tempfile
import threading
import unittest
from urllib.error import HTTPError
from urllib.request import Request, urlopen

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import server  # noqa: E402


class ServerTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp()
        cls.root = os.path.join(cls.tmp, "ws")
        os.makedirs(os.path.join(cls.root, "proj", "tasks"))
        with open(os.path.join(cls.root, "README.md"), "w") as f:
            f.write("# WS\n")
        cls.outside = os.path.join(cls.tmp, "secret.md")
        with open(cls.outside, "w") as f:
            f.write("secret")
        os.symlink(cls.outside, os.path.join(cls.root, "link.md"))
        cls.httpd = server.make_server(cls.root, port=0, quiet=True)
        cls.base = "http://127.0.0.1:%d" % cls.httpd.server_address[1]
        threading.Thread(target=cls.httpd.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()
        shutil.rmtree(cls.tmp)

    def request(self, method, route, body=None, headers=None, write=True):
        h = {"X-Taski": "1"} if write and method != "GET" else {}
        h.update(headers or {})
        req = Request(self.base + route, data=body.encode() if isinstance(body, str) else body, method=method, headers=h)
        try:
            with urlopen(req) as res:
                return res.status, res.read().decode(), dict(res.headers)
        except HTTPError as e:
            return e.code, e.read().decode(), dict(e.headers)

    def test_ping_and_static(self):
        status, body, _ = self.request("GET", "/api/ping")
        self.assertEqual(status, 200)
        self.assertTrue(body.startswith("taski"))
        status, body, _ = self.request("GET", "/taski.html")
        self.assertEqual(status, 200)
        self.assertIn("taski_src/app.js", body)

    def test_list(self):
        status, body, _ = self.request("GET", "/api/list?path=")
        self.assertEqual(status, 200)
        names = {e["name"]: e["kind"] for e in json.loads(body)["entries"]}
        self.assertEqual(names["proj"], "dir")
        self.assertEqual(names["README.md"], "file")

    def test_write_read_and_conflict(self):
        path = "/api/files?path=proj/tasks/a.md"
        status, _, headers = self.request("PUT", path, "one", {"If-None-Match": "*"})
        self.assertEqual(status, 201)
        rev = headers["ETag"]

        status, _, _ = self.request("PUT", path, "again", {"If-None-Match": "*"})
        self.assertEqual(status, 412)

        status, body, headers = self.request("GET", path)
        self.assertEqual((status, body, headers["ETag"]), (200, "one", rev))

        status, _, headers = self.request("PUT", path, "two!", {"If-Match": rev})
        self.assertEqual(status, 200)
        status, _, _ = self.request("PUT", path, "three", {"If-Match": rev})
        self.assertEqual(status, 412, "stale revision must be refused")
        self.assertEqual(self.request("GET", path)[1], "two!")
        leftovers = [n for n in os.listdir(os.path.join(self.root, "proj", "tasks")) if n.startswith(".taski-")]
        self.assertEqual(leftovers, [])

    def test_mkdir_move_delete(self):
        self.assertEqual(self.request("POST", "/api/mkdir?path=proj/tasks/b")[0], 204)
        self.assertEqual(self.request("PUT", "/api/files?path=proj/tasks/b/README.md", "b")[0], 201)
        self.assertEqual(self.request("POST", "/api/move?path=proj/tasks/b&to=proj/tasks/c")[0], 204)
        self.assertEqual(self.request("GET", "/api/files?path=proj/tasks/c/README.md")[1], "b")
        self.assertEqual(self.request("DELETE", "/api/files?path=proj/tasks/c/README.md")[0], 204)
        self.assertEqual(self.request("GET", "/api/files?path=proj/tasks/c/README.md")[0], 404)

    def test_paths_stay_inside_root(self):
        self.assertEqual(self.request("GET", "/api/files?path=../secret.md")[0], 403)
        self.assertEqual(self.request("GET", "/api/files?path=link.md")[0], 403, "symlink out of root")
        self.assertEqual(self.request("GET", "/api/files?path=.git/config")[0], 403)
        self.assertEqual(self.request("PUT", "/api/files?path=proj/x.html", "<script>")[0], 403)

    def test_writes_need_header_and_same_origin(self):
        self.assertEqual(self.request("PUT", "/api/files?path=x.md", "x", write=False)[0], 403)
        status, _, _ = self.request("PUT", "/api/files?path=x.md", "x", {"Origin": "https://evil.example"})
        self.assertEqual(status, 403)
        self.assertFalse(os.path.exists(os.path.join(self.root, "x.md")))

    def test_missing_parent_folder(self):
        self.assertEqual(self.request("PUT", "/api/files?path=nope/x.md", "x")[0], 409)


class McpTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.root = os.path.join(self.tmp, "ws")
        for project in ("alpha", "beta"):
            os.makedirs(os.path.join(self.root, project, "tasks"))
            with open(os.path.join(self.root, project, "README.md"), "w") as f:
                f.write("# %s\n" % project)
        with open(os.path.join(self.root, "AGENTS.md"), "w") as f:
            f.write("rules")
        os.symlink(os.path.join(self.root, "beta"), os.path.join(self.root, "alpha", "to-beta"))
        self.next_id = 0

    def tearDown(self):
        shutil.rmtree(self.tmp)

    def rpc(self, mcp, method, params=None):
        self.next_id += 1
        reply = mcp.handle({"jsonrpc": "2.0", "id": self.next_id, "method": method, "params": params or {}})
        self.assertEqual(reply["id"], self.next_id)
        return reply

    def call(self, mcp, tool, **args):
        result = self.rpc(mcp, "tools/call", {"name": tool, "arguments": args})["result"]
        text = result["content"][0]["text"]
        return result["isError"], (text if result["isError"] else json.loads(text) if text.startswith(("{", "[")) else text)

    def scoped(self, *projects):
        return server.McpServer(server.Workspace(self.root, projects or None))

    def test_handshake_and_tool_list(self):
        mcp = self.scoped()
        result = self.rpc(mcp, "initialize", {"protocolVersion": "2024-11-05"})["result"]
        self.assertEqual(result["protocolVersion"], "2024-11-05")
        self.assertIn("tools", result["capabilities"])
        self.assertIsNone(mcp.handle({"jsonrpc": "2.0", "method": "notifications/initialized"}))
        names = [t["name"] for t in self.rpc(mcp, "tools/list")["result"]["tools"]]
        self.assertIn("write_file", names)
        self.assertEqual(self.rpc(mcp, "nope")["error"]["code"], -32601)
        self.assertEqual(self.rpc(mcp, "tools/call", {"name": "rm_rf"})["error"]["code"], -32602)

    def test_read_write_with_revisions(self):
        mcp = self.scoped()
        err, made = self.call(mcp, "write_file", path="alpha/tasks/a.md", content="one")
        self.assertFalse(err)
        self.assertTrue(made["created"])
        self.assertTrue(self.call(mcp, "write_file", path="alpha/tasks/a.md", content="again")[0], "create must not overwrite")
        err, read = self.call(mcp, "read_file", path="alpha/tasks/a.md")
        self.assertEqual((read["content"], read["revision"]), ("one", made["revision"]))
        err, updated = self.call(mcp, "write_file", path="alpha/tasks/a.md", content="two", revision=read["revision"])
        self.assertFalse(err)
        self.assertTrue(self.call(mcp, "write_file", path="alpha/tasks/a.md", content="x", revision=read["revision"])[0], "stale")
        self.assertTrue(self.call(mcp, "write_file", path="alpha/x.html", content="<b>")[0])
        self.assertTrue(self.call(mcp, "read_file", path="alpha/nope.md")[0])
        self.assertFalse(self.call(mcp, "delete_file", path="alpha/tasks/a.md", revision=updated["revision"])[0])
        self.assertFalse(os.path.exists(os.path.join(self.root, "alpha", "tasks", "a.md")))

    def test_project_limit(self):
        mcp = self.scoped("alpha")
        _, projects = self.call(mcp, "list_projects")
        self.assertEqual([p["name"] for p in projects["projects"]], ["alpha"])
        _, root = self.call(mcp, "list_files", path="")
        self.assertEqual({e["name"] for e in root["entries"]}, {"alpha", "AGENTS.md"})

        self.assertEqual(self.call(mcp, "read_file", path="AGENTS.md")[1]["content"], "rules")
        self.assertFalse(self.call(mcp, "read_file", path="alpha/README.md")[0])
        for path in ("beta/README.md", "alpha/to-beta/README.md", "alpha/../beta/README.md"):
            self.assertTrue(self.call(mcp, "read_file", path=path)[0], path)
        self.assertTrue(self.call(mcp, "list_files", path="beta")[0])
        # root files are read-only, no new projects, no moving across projects
        self.assertTrue(self.call(mcp, "write_file", path="AGENTS.md", content="x", revision="r")[0])
        self.assertTrue(self.call(mcp, "write_file", path="new.md", content="x")[0])
        self.assertTrue(self.call(mcp, "make_folder", path="gamma")[0])
        self.assertTrue(self.call(mcp, "move_file", path="alpha/README.md", to="beta/README2.md")[0])
        self.assertTrue(self.call(mcp, "move_file", path="alpha", to="alpha2")[0])
        self.assertTrue(self.call(mcp, "delete_file", path="AGENTS.md")[0])
        self.assertFalse(self.call(mcp, "make_folder", path="alpha/files")[0])
        self.assertEqual(sorted(os.listdir(self.root)), ["AGENTS.md", "alpha", "beta"])

    def test_stdio(self):
        import io
        lines = [
            {"jsonrpc": "2.0", "id": 1, "method": "ping"},
            {"jsonrpc": "2.0", "method": "notifications/initialized"},
            {"jsonrpc": "2.0", "id": 2, "method": "tools/list"},
        ]
        stdin = io.StringIO("\n".join(json.dumps(m) for m in lines) + "\nnot json\n")
        stdout = io.StringIO()
        server.serve_stdio(self.scoped(), stdin, stdout)
        replies = [json.loads(line) for line in stdout.getvalue().splitlines()]
        self.assertEqual([r["id"] for r in replies], [1, 2, None])
        self.assertEqual(replies[2]["error"]["code"], -32700)

    def test_http_endpoint(self):
        httpd = server.make_server(self.root, port=0, quiet=True, projects=["alpha", "beta"])
        threading.Thread(target=httpd.serve_forever, daemon=True).start()
        self.addCleanup(httpd.server_close)
        self.addCleanup(httpd.shutdown)
        base = "http://127.0.0.1:%d" % httpd.server_address[1]

        def post(route, message, headers=None):
            req = Request(base + route, data=json.dumps(message).encode(), method="POST", headers=headers or {})
            try:
                with urlopen(req) as res:
                    body = res.read().decode()
                    return res.status, json.loads(body) if body else None
            except HTTPError as e:
                return e.code, e.read().decode()

        read = {"jsonrpc": "2.0", "id": 1, "method": "tools/call",
                "params": {"name": "read_file", "arguments": {"path": "beta/README.md"}}}
        status, reply = post("/mcp", read)
        self.assertEqual(status, 200)
        self.assertFalse(reply["result"]["isError"])
        # /mcp/PROJECT narrows further
        status, reply = post("/mcp/alpha", read)
        self.assertEqual(status, 200)
        self.assertTrue(reply["result"]["isError"])
        self.assertEqual(post("/mcp/gamma", read)[0], 403)
        self.assertEqual(post("/mcp", {"jsonrpc": "2.0", "method": "notifications/initialized"})[0], 202)
        # other sites and rebound host names are refused
        self.assertEqual(post("/mcp", read, {"Origin": "https://evil.example"})[0], 403)
        self.assertEqual(post("/mcp", read, {"Host": "evil.example"})[0], 403)
        with self.assertRaises(HTTPError) as ctx:
            urlopen(base + "/mcp")
        self.assertEqual(ctx.exception.code, 405)
        # a project limit set with --project applies to the shared endpoint
        limited = server.make_server(self.root, port=0, quiet=True, projects=["alpha"])
        threading.Thread(target=limited.serve_forever, daemon=True).start()
        self.addCleanup(limited.server_close)
        self.addCleanup(limited.shutdown)
        base = "http://127.0.0.1:%d" % limited.server_address[1]
        self.assertTrue(post("/mcp", read)[1]["result"]["isError"])
        self.assertEqual(post("/mcp/beta", read)[0], 403)


if __name__ == "__main__":
    unittest.main()
