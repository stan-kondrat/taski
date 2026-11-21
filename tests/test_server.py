import base64
import hashlib
import hmac
import http.client
import json
import os
import shutil
import sys
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
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

    def test_tool_metadata(self):
        tools = self.rpc(self.scoped(), "tools/list")["result"]["tools"]
        by_name = {t["name"]: t for t in tools}
        for tool in tools:
            hints = tool["annotations"]
            self.assertTrue(tool["title"] and tool["description"], tool["name"])
            self.assertEqual(tool["inputSchema"]["type"], "object")
            self.assertFalse(hints["openWorldHint"], tool["name"])
            self.assertEqual(set(hints) - {"title"}, {"readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"})
            if hints["readOnlyHint"]:
                self.assertFalse(hints["destructiveHint"], tool["name"])
        for name in ("list_projects", "get_project", "list_tasks", "list_files", "read_file"):
            self.assertTrue(by_name[name]["annotations"]["readOnlyHint"], name)
        for name in ("write_file", "move_file", "delete_file"):
            self.assertTrue(by_name[name]["annotations"]["destructiveHint"], name)
        self.assertFalse(by_name["create_task"]["annotations"]["destructiveHint"])

    def test_structured_content(self):
        mcp = self.scoped()
        result = self.rpc(mcp, "tools/call", {"name": "list_projects", "arguments": {}})["result"]
        self.assertEqual(result["structuredContent"], json.loads(result["content"][0]["text"]))
        failed = self.rpc(mcp, "tools/call", {"name": "read_file", "arguments": {"path": "nope.md"}})["result"]
        self.assertTrue(failed["isError"])
        self.assertNotIn("structuredContent", failed)
        self.assertIn("list_files", failed["content"][0]["text"])
        self.assertEqual(self.rpc(mcp, "tools/call", {"name": "read_file", "arguments": ["x"]})["error"]["code"], -32602)

    @staticmethod
    def slurp(path):
        with open(path) as f:
            return f.read()

    def plan(self):
        """Project 'alpha' with its own workflow, two milestones and three tasks."""
        base = os.path.join(self.root, "alpha")
        with open(os.path.join(base, "README.md"), "w") as f:
            f.write("---\ntype: project\nstatuses: backlog, doing, review, done\nactive-statuses: doing, review\n"
                    "closed-statuses: done\nlabels: bug, idea\nmilestones: MVP (2026-12-01), Beta\n---\n"
                    "# Alpha\n\n## Tasks\n\n- [One](tasks/one.md)\n")
        files = {
            "tasks/one.md": "---\ntype: task\nstatus: done\nmilestone: MVP\nextra: keep me\n---\n# One\n\n- [x] a\n- [ ] b\n",
            "tasks/two/README.md": "---\nstatus: doing\nmilestone: MVP\ntags: bug, idea\n---\n# Two\n",
            "tasks/three.md": "---\nstatus: backlog\nmilestone: Later\n---\n# Three\n",
        }
        for rel, text in files.items():
            os.makedirs(os.path.dirname(os.path.join(base, rel)), exist_ok=True)
            with open(os.path.join(base, rel), "w") as f:
                f.write(text)

    def test_get_project_and_list_tasks(self):
        self.plan()
        mcp = self.scoped()
        err, project = self.call(mcp, "get_project", project="alpha")
        self.assertFalse(err)
        self.assertEqual(project["statuses"], ["backlog", "doing", "review", "done"])
        self.assertEqual((project["initial_status"], project["closed_statuses"], project["labels"]), ("backlog", ["done"], ["bug", "idea"]))
        ms = {m["name"]: m for m in project["milestones"]}
        self.assertEqual((ms["MVP"]["due"], ms["MVP"]["total"], ms["MVP"]["done"], ms["MVP"]["open"]), ("2026-12-01", 2, 1, 1))
        self.assertEqual((ms["Beta"]["total"], ms["Beta"]["listed"]), (0, True))
        self.assertEqual((ms["Later"]["total"], ms["Later"]["listed"]), (1, False))
        self.assertEqual((project["task_count"], project["open_task_count"]), (3, 2))

        err, listing = self.call(mcp, "list_tasks", project="alpha")
        self.assertEqual([t["title"] for t in listing["tasks"]], ["Three", "Two", "One"])  # board order
        one = listing["tasks"][2]
        self.assertEqual((one["kind"], one["progress"], one["milestone"]), ("closed", {"done": 1, "total": 2}, "MVP"))
        self.assertEqual(listing["tasks"][1]["tags"], ["bug", "idea"])
        self.assertEqual(listing["tasks"][1]["path"], "alpha/tasks/two/README.md")
        titles = lambda **a: [t["title"] for t in self.call(mcp, "list_tasks", project="alpha", **a)[1]["tasks"]]
        self.assertEqual(titles(milestone="MVP"), ["Two", "One"])
        self.assertEqual(titles(status="doing"), ["Two"])
        self.assertEqual(titles(tag="idea"), ["Two"])
        self.assertEqual(titles(open_only=True), ["Three", "Two"])
        self.assertTrue(self.call(mcp, "list_tasks", project="nope")[0])
        self.assertTrue(self.call(mcp, "list_tasks", project="../x")[0])
        self.assertTrue(self.call(mcp, "list_tasks", project="alpha", open_only="yes")[0])
        # a bare project (no README, no tasks folder) uses the default workflow
        self.assertEqual(self.call(self.scoped(), "get_project", project="beta")[1]["statuses"],
                         ["todo", "doing", "blocked", "done", "cancelled"])

    def test_update_task(self):
        self.plan()
        mcp = self.scoped()
        path = os.path.join(self.root, "alpha", "tasks", "one.md")
        err, task = self.call(mcp, "update_task", path="alpha/tasks/one.md",
                              fields={"status": "review", "due": "2026-12-24", "tags": ["bug"], "priority": "high"})
        self.assertFalse(err, task)
        self.assertEqual((task["status"], task["kind"], task["due"], task["tags"]), ("review", "active", "2026-12-24", ["bug"]))
        with open(path) as f:
            text = f.read()
        self.assertEqual(text, "---\ntype: task\nstatus: review\nmilestone: MVP\nextra: keep me\npriority: high\n"
                               "due: 2026-12-24\ntags: bug\n---\n# One\n\n- [x] a\n- [ ] b\n")
        # clearing removes the line and keeps the rest
        err, task = self.call(mcp, "update_task", path="alpha/tasks/one.md", fields={"milestone": None, "due": ""},
                              revision=task["revision"])
        self.assertFalse(err, task)
        self.assertNotIn("milestone", self.slurp(path))
        self.assertNotIn("due:", self.slurp(path))
        # the project's own rules are enforced, and nothing is written on a refusal
        before = self.slurp(path)
        for fields in ({"status": "todo"}, {"status": None}, {"priority": "urgent"}, {"due": "2026-13-40"},
                       {"due": "tomorrow"}, {"milestone": "Nope"}, {"tags": "a\nb"}, {"title": "x"}, {}):
            self.assertTrue(self.call(mcp, "update_task", path="alpha/tasks/one.md", fields=fields)[0], fields)
        err, message = self.call(mcp, "update_task", path="alpha/tasks/one.md", fields={"milestone": "Nope"})
        self.assertIn("MVP, Beta", message)
        self.assertEqual(self.slurp(path), before)
        # a stale revision is refused with a hint
        err, message = self.call(mcp, "update_task", path="alpha/tasks/one.md", fields={"status": "done"}, revision='"1-1"')
        self.assertTrue(err)
        self.assertIn("revision", message)
        self.assertEqual(self.slurp(path), before)
        # only task files
        self.assertTrue(self.call(mcp, "update_task", path="alpha/README.md", fields={"status": "done"})[0])
        self.assertTrue(self.call(mcp, "update_task", path="alpha/tasks/missing.md", fields={"status": "done"})[0])
        # scoped to another project: refused
        self.assertTrue(self.call(self.scoped("beta"), "update_task", path="alpha/tasks/one.md", fields={"status": "done"})[0])

    def test_create_task(self):
        self.plan()
        mcp = self.scoped()
        err, task = self.call(mcp, "create_task", project="alpha", title="Write  docs [now]", milestone="Beta",
                              tags=["idea"], due="2027-01-02")
        self.assertFalse(err, task)
        self.assertEqual((task["path"], task["status"], task["milestone"]), ("alpha/tasks/write-docs-now.md", "backlog", "Beta"))
        with open(os.path.join(self.root, "alpha", "tasks", "write-docs-now.md")) as f:
            text = f.read()
        self.assertIn("type: task\nstatus: backlog\npriority: normal\ncreated: ", text)
        self.assertIn("due: 2027-01-02\nmilestone: Beta\ntags: idea\n---\n\n# Write docs [now]\n\n", text)
        with open(os.path.join(self.root, "alpha", "README.md")) as f:
            readme = f.read()
        self.assertIn("- [One](tasks/one.md)\n- [Write docs now](tasks/write-docs-now.md)\n", readme)
        self.assertTrue(readme.startswith("---\ntype: project\nstatuses: backlog"))
        # same title again gets a new name; folder tasks work and a chosen status is honoured
        err, again = self.call(mcp, "create_task", project="alpha", title="Write docs now", single_file=False, status="doing")
        self.assertEqual((again["path"], again["status"]), ("alpha/tasks/write-docs-now-2/README.md", "doing"))
        self.assertTrue(os.path.isfile(os.path.join(self.root, "alpha", "tasks", "write-docs-now-2", "README.md")))
        self.assertIn("(tasks/write-docs-now-2/README.md)", self.slurp(os.path.join(self.root, "alpha", "README.md")))
        # invalid input creates nothing
        count = len(os.listdir(os.path.join(self.root, "alpha", "tasks")))
        for bad in ({"title": "  "}, {"title": "x", "status": "todo"}, {"title": "x", "milestone": "Nope"}, {"title": "x", "single_file": "yes"}):
            self.assertTrue(self.call(mcp, "create_task", project="alpha", **bad)[0], bad)
        self.assertEqual(len(os.listdir(os.path.join(self.root, "alpha", "tasks"))), count)
        # a project without README or tasks folder gets both
        os.makedirs(os.path.join(self.root, "gamma"))
        err, first = self.call(mcp, "create_task", project="gamma", title="First")
        self.assertFalse(err, first)
        self.assertEqual(first["status"], "todo")
        self.assertIn("## Tasks\n\n- [First](tasks/first.md)\n", self.slurp(os.path.join(self.root, "gamma", "README.md")))
        # the project filter applies
        self.assertTrue(self.call(self.scoped("beta"), "create_task", project="gamma", title="Nope")[0])

    def relations_plan(self):
        """alpha: a, b, c, d; beta: x. a is blocked by b (written on b), c is blocked by a, d relates to x."""
        self.plan_files = {
            "alpha/README.md": "---\ntype: project\nstatuses: todo, doing, done\nclosed-statuses: done\n---\n# Alpha\n\n## Tasks\n\n",
            "alpha/tasks/a.md": "---\nstatus: todo\n---\n# A\n",
            "alpha/tasks/b.md": "---\nstatus: doing\nblocks: a\n---\n# B\n",
            "alpha/tasks/c/README.md": "---\nstatus: todo\nblocked-by: a, gone\n---\n# C\n",
            "alpha/tasks/d.md": "---\nstatus: done\nrelated: beta/x\n---\n# D\n",
            "beta/tasks/x.md": "---\nstatus: todo\nblocks: alpha/d\n---\n# X\n",
        }
        for rel, text in self.plan_files.items():
            full = os.path.join(self.root, rel)
            os.makedirs(os.path.dirname(full), exist_ok=True)
            with open(full, "w") as f:
                f.write(text)

    def test_relations_are_read_from_both_sides(self):
        self.relations_plan()
        mcp = self.scoped()
        _, listing = self.call(mcp, "list_tasks", project="alpha")
        tasks = {t["slug"]: t for t in listing["tasks"]}
        names = lambda t, kind: [(r["slug"], r["declared_here"], r["closed"]) for r in tasks[t][kind]]
        self.assertEqual(names("a", "blocked_by"), [("b", False, False)])
        self.assertEqual(names("a", "blocks"), [("c", False, False)])
        self.assertEqual(names("b", "blocks"), [("a", True, False)])
        self.assertEqual(names("c", "blocked_by"), [("a", True, False)])
        self.assertEqual(tasks["c"]["missing_relations"], ["gone"])
        self.assertEqual([r["project"] for r in tasks["d"]["related"]], ["beta"])
        self.assertEqual(names("d", "related"), [("x", True, False)])
        self.assertEqual({s: t["blocked"] for s, t in tasks.items()}, {"a": True, "b": False, "c": True, "d": True})  # d: x blocks it
        self.assertNotIn("_own", tasks["a"])
        # filters: ready to start = open and not blocked
        ready = lambda **a: [t["slug"] for t in self.call(mcp, "list_tasks", project="alpha", **a)[1]["tasks"]]
        self.assertEqual(ready(blocked=True), ["a", "c", "d"])
        self.assertEqual(ready(open_only=True, blocked=False), ["b"])
        self.assertTrue(self.call(mcp, "list_tasks", project="alpha", blocked="no")[0])
        self.assertEqual(self.call(mcp, "get_project", project="alpha")[1]["blocked_task_count"], 2)
        # the other project sees the inverse of a relation written in alpha
        _, beta = self.call(mcp, "list_tasks", project="beta")
        self.assertEqual([(r["slug"], r["declared_here"]) for r in beta["tasks"][0]["related"]], [("d", False)])
        # a closed blocker no longer blocks
        self.call(mcp, "update_task", path="alpha/tasks/b.md", fields={"status": "done"})
        self.assertEqual(ready(open_only=True, blocked=False), ["a"])

    def test_update_task_relations(self):
        self.relations_plan()
        mcp = self.scoped()
        path = os.path.join(self.root, "alpha", "tasks", "a.md")
        err, task = self.call(mcp, "update_task", path="alpha/tasks/a.md",
                              fields={"related": ["d", "beta/x"], "blocks": "c", "status": "doing"})
        self.assertFalse(err, task)
        self.assertEqual(self.slurp(path), "---\nstatus: doing\nblocks: c\nrelated: d, beta/x\n---\n# A\n")
        self.assertEqual([r["slug"] for r in task["related"]], ["d", "x"])
        self.assertEqual([(r["slug"], r["declared_here"]) for r in task["blocked_by"]], [("b", False)])
        self.assertTrue(task["blocked"])
        # paths work too, and are stored as names; clearing removes the line, other sides stay
        err, task = self.call(mcp, "update_task", path="alpha/tasks/a.md",
                              fields={"blocked_by": ["alpha/tasks/c/README.md".replace("c/README.md", "d.md")], "related": None})
        self.assertFalse(err, task)
        self.assertEqual(self.slurp(path), "---\nstatus: doing\nblocks: c\nblocked-by: d\n---\n# A\n")
        self.assertEqual([r["slug"] for r in task["blocked_by"]], ["d", "b"])  # d here, b written on b
        # refusals write nothing
        before = self.slurp(path)
        bad = [{"blocked_by": ["nope"]}, {"blocks": ["a"]}, {"related": ["beta/nope"]}, {"related": "a\nb"},
               {"blocked_by": ["c"]},          # c is blocked by a: a cycle
               {"blocks": ["b"]},              # b already blocks a
               {"blocks": ["d"], "blocked_by": ["d"]}]
        for fields in bad:
            self.assertTrue(self.call(mcp, "update_task", path="alpha/tasks/a.md", fields=fields)[0], fields)
        err, message = self.call(mcp, "update_task", path="alpha/tasks/a.md", fields={"blocked_by": ["nope"]})
        self.assertIn("Tasks here:", message)
        err, message = self.call(mcp, "update_task", path="alpha/tasks/a.md", fields={"blocks": None, "blocked_by": ["c"]})
        self.assertIn("cannot also block", message)
        self.assertEqual(self.slurp(path), before)
        # a stale dangling name in the file does not stop unrelated edits
        err, task = self.call(mcp, "update_task", path="alpha/tasks/c/README.md", fields={"status": "doing", "related": ["d"]})
        self.assertFalse(err, task)
        self.assertEqual(task["missing_relations"], ["gone"])

    def test_create_task_with_relations(self):
        self.relations_plan()
        mcp = self.scoped()
        err, task = self.call(mcp, "create_task", project="alpha", title="New one", blocked_by=["a"], related=["beta/x"])
        self.assertFalse(err, task)
        self.assertIn("status: todo\npriority: normal", self.slurp(os.path.join(self.root, "alpha", "tasks", "new-one.md")))
        self.assertIn("blocked-by: a\nrelated: beta/x\n---", self.slurp(os.path.join(self.root, "alpha", "tasks", "new-one.md")))
        self.assertEqual((task["slug"], task["blocked"], [r["slug"] for r in task["blocked_by"]]), ("new-one", True, ["a"]))
        _, listing = self.call(mcp, "list_tasks", project="alpha")
        a = [t for t in listing["tasks"] if t["slug"] == "a"][0]
        self.assertEqual(sorted(r["slug"] for r in a["blocks"]), ["c", "new-one"])
        count = len(os.listdir(os.path.join(self.root, "alpha", "tasks")))
        for bad in ({"blocked_by": ["nope"]}, {"blocks": ["b"], "blocked_by": ["b"]}):
            self.assertTrue(self.call(mcp, "create_task", project="alpha", title="Never", **bad)[0], bad)
        self.assertEqual(len(os.listdir(os.path.join(self.root, "alpha", "tasks"))), count)
        # inside a --project scope other projects are invisible, so their tasks cannot be named
        self.assertTrue(self.call(self.scoped("alpha"), "create_task", project="alpha", title="Scoped", related=["beta/x"])[0])

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
        # a Host name is accepted only when allowed with --allow-host
        self.assertEqual(post("/mcp", read, {"Host": "taski.lan"})[0], 403)
        lan = server.make_server(self.root, port=0, quiet=True, allow_hosts=["taski.lan"])
        threading.Thread(target=lan.serve_forever, daemon=True).start()
        self.addCleanup(lan.server_close)
        self.addCleanup(lan.shutdown)
        lan_url = "/mcp"
        req = Request("http://127.0.0.1:%d%s" % (lan.server_address[1], lan_url), data=json.dumps(read).encode(),
                      method="POST", headers={"Host": "taski.lan"})
        with urlopen(req) as res:
            self.assertEqual(res.status, 200)
        with self.assertRaises(HTTPError) as ctx:
            urlopen(base + "/mcp")  # GET without Accept: text/event-stream
        self.assertEqual(ctx.exception.code, 406)
        # a project limit set with --project applies to the shared endpoint
        limited = server.make_server(self.root, port=0, quiet=True, projects=["alpha"])
        threading.Thread(target=limited.serve_forever, daemon=True).start()
        self.addCleanup(limited.server_close)
        self.addCleanup(limited.shutdown)
        base = "http://127.0.0.1:%d" % limited.server_address[1]
        self.assertTrue(post("/mcp", read)[1]["result"]["isError"])
        self.assertEqual(post("/mcp/beta", read)[0], 403)
        # the browser API is limited the same way
        with urlopen(base + "/api/list?path=") as res:
            self.assertEqual({e["name"] for e in json.loads(res.read())["entries"]}, {"alpha", "AGENTS.md"})
        with self.assertRaises(HTTPError) as ctx:
            urlopen(base + "/api/files?path=beta/README.md")
        self.assertEqual(ctx.exception.code, 403)
        put = Request(base + "/api/files?path=beta/x.md", data=b"x", method="PUT", headers={"X-Taski": "1"})
        with self.assertRaises(HTTPError) as ctx:
            urlopen(put)
        self.assertEqual(ctx.exception.code, 403)


class EventsTest(unittest.TestCase):
    SECRET = "whsec_" + "MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw"

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.root = os.path.join(self.tmp, "ws")
        for project in ("alpha", "beta"):
            os.makedirs(os.path.join(self.root, project, "tasks"))
            with open(os.path.join(self.root, project, "README.md"), "w") as f:
                f.write("# %s\n" % project)
        self.saved = (server.WEBHOOK_ALLOW_PRIVATE, server.WEBHOOK_BACKOFF, server.WEBHOOK_ATTEMPTS)
        server.WEBHOOK_ALLOW_PRIVATE, server.WEBHOOK_BACKOFF, server.WEBHOOK_ATTEMPTS = True, 0.01, 3
        server.EVENTS.items.clear()
        self.hits = []  # (headers, body) of every non-challenge POST
        self.fail_first = 0
        self.echo = True
        test = self

        class Receiver(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_POST(self):
                body = self.rfile.read(int(self.headers["Content-Length"]))
                data = json.loads(body)
                status, reply = 200, b""
                if data.get("type") == "url_verification":
                    reply = json.dumps({"challenge": data["challenge"] if test.echo else "nope"}).encode()
                else:
                    test.hits.append(({k.lower(): v for k, v in self.headers.items()}, body))
                    if test.fail_first > 0:
                        test.fail_first -= 1
                        status = 500
                self.send_response(status)
                self.send_header("Content-Length", str(len(reply)))
                self.end_headers()
                self.wfile.write(reply)

        self.receiver = ThreadingHTTPServer(("127.0.0.1", 0), Receiver)
        threading.Thread(target=self.receiver.serve_forever, daemon=True).start()
        self.url = "http://127.0.0.1:%d/hook" % self.receiver.server_address[1]

    def tearDown(self):
        self.receiver.shutdown()
        self.receiver.server_close()
        server.WEBHOOK_ALLOW_PRIVATE, server.WEBHOOK_BACKOFF, server.WEBHOOK_ATTEMPTS = self.saved
        server.EVENTS.items.clear()
        shutil.rmtree(self.tmp)

    def rpc(self, mcp, method, params=None):
        return mcp.handle({"jsonrpc": "2.0", "id": 1, "method": method, "params": params or {}})

    def mcp(self, *projects):
        return server.McpServer(server.Workspace(self.root, projects or None))

    def subscribe(self, mcp, name="task.created", params=None, secret=None, url=None):
        return self.rpc(mcp, "events/subscribe", {
            "eventName": name, "params": params or {},
            "webhook": {"url": url or self.url, "secret": secret or self.SECRET}})

    def wait_for(self, count):
        deadline = time.time() + 5
        while len(self.hits) < count and time.time() < deadline:
            time.sleep(0.01)

    def test_capabilities_and_list(self):
        mcp = self.mcp()
        for method in ("initialize", "server/discover"):
            caps = self.rpc(mcp, method, {"protocolVersion": "2026-07-28"})["result"]["capabilities"]
            self.assertEqual(caps["events"], {})
            self.assertEqual(caps["experimental"], {"events": {}})
        self.assertEqual(self.rpc(mcp, "initialize", {"protocolVersion": "2026-07-28"})["result"]["protocolVersion"], "2026-07-28")
        # an unknown (e.g. newer) version gets a widely supported one, never 2026-07-28 unasked
        self.assertEqual(self.rpc(mcp, "initialize", {"protocolVersion": "2099-01-01"})["result"]["protocolVersion"], "2025-06-18")
        events = self.rpc(mcp, "events/list")["result"]["events"]
        self.assertEqual([e["name"] for e in events], ["task.created", "task.updated"])
        for event in events:
            self.assertTrue(event["description"])
            self.assertEqual(event["inputSchema"]["type"], "object")
        for method in ("events/stream", "events/poll"):
            self.assertEqual(self.rpc(mcp, method)["error"]["code"], -32601)

    def test_subscribe_verifies_and_unsubscribe(self):
        mcp = self.mcp()
        sub = self.subscribe(mcp)["result"]["subscriptionId"]
        self.assertIn(sub, server.EVENTS.items)
        self.assertEqual(self.rpc(mcp, "events/unsubscribe", {"subscriptionId": sub})["result"], {})
        self.assertNotIn(sub, server.EVENTS.items)
        self.assertEqual(self.rpc(mcp, "events/unsubscribe", {"subscriptionId": sub})["error"]["code"], -32602)
        # a url that does not echo the challenge saves nothing
        self.echo = False
        self.assertEqual(self.subscribe(mcp)["error"]["code"], -32602)
        self.assertEqual(server.EVENTS.items, {})

    def test_subscribe_validation(self):
        mcp = self.mcp("alpha")
        for bad in (
            dict(secret="plain"), dict(secret="whsec_!!!"), dict(secret="whsec_AAAA"),
            dict(url="ftp://example.com/x"), dict(url="http://user:pw@127.0.0.1/x"),
            dict(name="task.deleted"), dict(params={"colour": "red"}), dict(params={"project": "beta"}),
        ):
            self.assertEqual(self.subscribe(mcp, **bad)["error"]["code"], -32602, bad)
        # private hosts are refused unless allowed
        server.WEBHOOK_ALLOW_PRIVATE = False
        self.assertEqual(self.subscribe(mcp)["error"]["code"], -32602)
        self.assertEqual(server.EVENTS.items, {})

    def test_delivery_is_signed_and_filtered(self):
        mcp = self.mcp()
        self.subscribe(mcp, "task.created", {"project": "alpha"})
        self.subscribe(mcp, "task.updated")
        call = lambda tool, **a: mcp.handle({"jsonrpc": "2.0", "id": 1, "method": "tools/call",
                                             "params": {"name": tool, "arguments": a}})["result"]
        self.assertFalse(call("create_task", project="beta", title="Other")["isError"])
        self.assertFalse(call("create_task", project="alpha", title="Mine", tags=["x"])["isError"])
        self.wait_for(1)
        time.sleep(0.1)
        self.assertEqual(len(self.hits), 1, "beta's task must not match the project filter")
        headers, body = self.hits[0]
        event = json.loads(body)
        self.assertEqual((event["type"], event["data"]["title"], event["data"]["project"]), ("task.created", "Mine", "alpha"))
        key = base64.b64decode(self.SECRET[len("whsec_"):])
        signed = ("%s.%s." % (headers["webhook-id"], headers["webhook-timestamp"])).encode() + body
        expected = "v1," + base64.b64encode(hmac.new(key, signed, hashlib.sha256).digest()).decode()
        self.assertEqual(headers["webhook-signature"], expected)
        self.assertLess(abs(int(headers["webhook-timestamp"]) - time.time()), 10)

        path = event["data"]["path"]
        self.assertFalse(call("update_task", path=path, fields={"status": "doing"})["isError"])
        self.wait_for(2)
        updated = json.loads(self.hits[1][1])
        self.assertEqual((updated["type"], updated["data"]["status"], updated["data"]["changed"]), ("task.updated", "doing", ["status"]))

    def test_project_scoped_endpoint_only_sees_its_project(self):
        self.subscribe(self.mcp("alpha"))
        self.assertEqual(server.emit_mcp_event("task.created", {"project": "beta"}), 0)
        self.assertEqual(server.emit_mcp_event("task.created", {"project": "alpha"}), 1)

    def test_retries_with_the_same_id_then_succeeds(self):
        self.subscribe(self.mcp())
        self.fail_first = 2
        server.emit_mcp_event("task.created", {"project": "alpha"})
        self.wait_for(3)
        self.assertEqual(len(self.hits), 3)
        self.assertEqual(len({h["webhook-id"] for h, _ in self.hits}), 1)

    def test_gives_up_after_the_last_attempt(self):
        self.subscribe(self.mcp())
        self.fail_first = 99
        server.emit_mcp_event("task.created", {"project": "alpha"})
        self.wait_for(3)
        time.sleep(0.2)
        self.assertEqual(len(self.hits), 3)

    def test_oversized_payload_is_not_sent(self):
        self.subscribe(self.mcp())
        self.assertEqual(server.emit_mcp_event("task.created", {"project": "alpha", "title": "x" * server.MAX_EVENT_BYTES}), 0)
        self.assertEqual(server.emit_mcp_event("task.created", {"project": "alpha", "title": "small"}), 1)


class EventStreamTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.root = os.path.join(self.tmp, "ws")
        for project in ("alpha", "beta"):
            os.makedirs(os.path.join(self.root, project, "tasks"))
            with open(os.path.join(self.root, project, "README.md"), "w") as f:
                f.write("# %s\n" % project)
        self.saved = (server.STREAM_HEARTBEAT, server.STREAMS)
        server.STREAM_HEARTBEAT = 0.05
        server.STREAMS = server.EventStreams()
        self.httpd = server.make_server(self.root, port=0, quiet=True)
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()
        self.port = self.httpd.server_address[1]

    def tearDown(self):
        self.httpd.shutdown()
        self.httpd.server_close()
        server.STREAM_HEARTBEAT, server.STREAMS = self.saved
        shutil.rmtree(self.tmp)

    def open(self, route="/mcp", headers=None):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        self.addCleanup(conn.close)
        conn.request("GET", route, headers=dict({"Accept": "text/event-stream"}, **(headers or {})))
        return conn.getresponse()

    @staticmethod
    def next_event(res):
        """The next SSE message with data, as (id, parsed JSON-RPC notification)."""
        fields = {}
        while True:
            line = res.fp.readline().decode("utf-8")
            if not line:
                raise EOFError("stream closed")
            line = line.rstrip("\n")
            if line:
                if not line.startswith(":"):
                    key, _, value = line.partition(": ")
                    fields[key] = value
            elif "data" in fields:
                return int(fields["id"]), json.loads(fields["data"])
            else:
                fields = {}

    def call(self, tool, **args):
        req = Request("http://127.0.0.1:%d/mcp" % self.port, method="POST", data=json.dumps({
            "jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": tool, "arguments": args}}).encode())
        with urlopen(req) as res:
            result = json.loads(res.read())["result"]
        self.assertFalse(result["isError"], result)
        return result

    def test_streams_tool_changes_as_notifications(self):
        res = self.open("/mcp?project=alpha")
        self.assertEqual(res.status, 200)
        self.assertTrue(res.getheader("Content-Type").startswith("text/event-stream"))
        self.call("create_task", project="beta", title="Other")
        self.call("create_task", project="alpha", title="Mine")
        seq, note = self.next_event(res)
        self.assertEqual((note["jsonrpc"], note["method"]), ("2.0", "notifications/events/event"))
        self.assertNotIn("id", note)
        self.assertEqual((note["params"]["type"], note["params"]["data"]["title"]), ("task.created", "Mine"))
        self.call("update_task", path=note["params"]["data"]["path"], fields={"status": "doing"})
        seq2, note = self.next_event(res)
        self.assertGreater(seq2, seq)
        self.assertEqual((note["params"]["type"], note["params"]["data"]["changed"]), ("task.updated", ["status"]))

    def test_event_and_project_scope(self):
        created_only = self.open("/mcp?event=task.created")
        alpha_endpoint = self.open("/mcp/alpha")
        server.emit_mcp_event("task.updated", {"project": "alpha", "title": "u"})
        server.emit_mcp_event("task.created", {"project": "beta", "title": "b"})
        server.emit_mcp_event("task.created", {"project": "alpha", "title": "a", "tags": ["x"]})
        self.assertEqual(self.next_event(created_only)[1]["params"]["data"]["title"], "b")
        self.assertEqual(self.next_event(created_only)[1]["params"]["data"]["title"], "a")
        self.assertEqual(self.next_event(alpha_endpoint)[1]["params"]["data"]["title"], "u")
        self.assertEqual(self.next_event(alpha_endpoint)[1]["params"]["data"]["title"], "a")
        tagged = self.open("/mcp?tag=x")
        server.emit_mcp_event("task.created", {"project": "alpha", "title": "untagged"})
        server.emit_mcp_event("task.created", {"project": "alpha", "title": "tagged", "tags": ["x"]})
        self.assertEqual(self.next_event(tagged)[1]["params"]["data"]["title"], "tagged")

    def test_last_event_id_replays_what_was_missed(self):
        res = self.open()
        server.emit_mcp_event("task.created", {"project": "alpha", "title": "one"})
        seen, _ = self.next_event(res)
        res.close()
        server.emit_mcp_event("task.created", {"project": "alpha", "title": "two"})
        server.emit_mcp_event("task.created", {"project": "beta", "title": "three"})
        again = self.open("/mcp?project=alpha", {"Last-Event-ID": str(seen)})
        self.assertEqual(self.next_event(again)[1]["params"]["data"]["title"], "two")
        server.emit_mcp_event("task.created", {"project": "alpha", "title": "four"})
        self.assertEqual(self.next_event(again)[1]["params"]["data"]["title"], "four")

    def test_refusals(self):
        self.assertEqual(self.open(headers={"Accept": "application/json"}).status, 406)
        for route in ("/mcp?event=task.deleted", "/mcp?colour=red"):
            self.assertEqual(self.open(route).status, 400, route)
        self.assertEqual(self.open("/mcp/gamma").status, 404)  # no such project
        self.assertEqual(self.open(headers={"Origin": "https://evil.example"}).status, 403)
        self.assertEqual(self.open(headers={"Host": "evil.example"}).status, 403)
        limited = server.make_server(self.root, port=0, quiet=True, projects=["alpha"])
        threading.Thread(target=limited.serve_forever, daemon=True).start()
        self.addCleanup(limited.server_close)
        self.addCleanup(limited.shutdown)
        conn = http.client.HTTPConnection("127.0.0.1", limited.server_address[1], timeout=5)
        self.addCleanup(conn.close)
        conn.request("GET", "/mcp?project=beta", headers={"Accept": "text/event-stream"})
        self.assertEqual(conn.getresponse().status, 400)
        self.assertEqual(server.STREAMS.streams, [])

    def test_limits_and_cleanup(self):
        saved = server.MAX_STREAMS
        server.MAX_STREAMS = 1
        self.addCleanup(setattr, server, "MAX_STREAMS", saved)
        first = self.open()
        self.assertEqual(self.open().status, 503)
        first.close()
        deadline = time.time() + 5  # the next ping notices the closed connection
        while server.STREAMS.streams and time.time() < deadline:
            time.sleep(0.02)
        self.assertEqual(server.STREAMS.streams, [])
        self.assertEqual(self.open().status, 200)

    def test_slow_client_is_dropped(self):
        saved = server.STREAM_QUEUE
        server.STREAM_QUEUE = 2
        self.addCleanup(setattr, server, "STREAM_QUEUE", saved)
        stream = {"events": {"task.created"}, "filters": {}, "projects": None,
                  "queue": server.queue.Queue(maxsize=server.STREAM_QUEUE)}
        server.STREAMS.open(stream)
        for i in range(3):
            server.emit_mcp_event("task.created", {"project": "alpha", "title": str(i)})
        self.assertEqual(server.STREAMS.streams, [])
        self.assertIsNone(stream["queue"].get_nowait())


if __name__ == "__main__":
    unittest.main()
