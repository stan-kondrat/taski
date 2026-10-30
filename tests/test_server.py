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


if __name__ == "__main__":
    unittest.main()
