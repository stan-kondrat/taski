#!/usr/bin/env python3
"""Build the downloadable releases. Standard library only, Python 3.9+.

    dist/taski.html   one self-contained file: taski.html with every <script src>
                      and the stylesheet pasted in verbatim. Nothing is minified or
                      renamed; each block is labelled with its source file. The one
                      change: DEMO_WORKSPACE in config.js points at the public demo,
                      because the relative ./taski-demo/ does not exist next to it.
    dist/taski.zip    the readable source exactly as it is in the repo: taski.html,
                      taski_src/, server.py, the sample workspace, README and LICENSE.

Usage:
    python3 scripts/build-dist.py [output-dir]          (default: dist)
    python3 scripts/build-dist.py --publish-config FILE  rewrite DEMO_WORKSPACE in a
                                                         copied config.js (used for /app/)
"""

import os
import re
import shutil
import sys
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PUBLIC_DEMO_URL = "https://stan-kondrat.github.io/taski/demo/taski-demo/"
DEMO_LINE = "const DEMO_WORKSPACE = './taski-demo/';"
ZIP_CONTENTS = ["taski.html", "taski_src", "taski-demo", "server.py", "README.md", "LICENSE", "AGENTS.md"]


def version():
    with open(os.path.join(ROOT, "taski_src", "config.js"), encoding="utf-8") as f:
        m = re.search(r"const VERSION = '([^']+)';", f.read())
    if not m:
        sys.exit("VERSION not found in taski_src/config.js")
    return m.group(1)


def publish_config(text):
    """Point DEMO_WORKSPACE at the public demo. Fails if the line has changed."""
    if DEMO_LINE not in text:
        sys.exit("config.js no longer contains: %s" % DEMO_LINE)
    return text.replace(DEMO_LINE, "const DEMO_WORKSPACE = '%s'; // set by scripts/build-dist.py" % PUBLIC_DEMO_URL)


def read_source(rel):
    with open(os.path.join(ROOT, rel), encoding="utf-8") as f:
        text = f.read()
    tag = "</style" if rel.endswith(".css") else "</script"
    if tag in text.lower():
        sys.exit("%s contains %s and cannot be inlined" % (rel, tag))
    return text.rstrip("\n")


def single_file(ver):
    with open(os.path.join(ROOT, "taski.html"), encoding="utf-8") as f:
        html = f.read()

    def style(m):
        rel = m.group(1)
        return "<style>\n/* ---- %s ---- */\n%s\n</style>" % (rel, read_source(rel))

    def script(m):
        rel = m.group(1)
        text = read_source(rel)
        if rel == "taski_src/config.js":
            text = publish_config(text)
        return "<script>\n// ---- %s ----\n%s\n</script>" % (rel, text)

    html, styles = re.subn(r'<link rel="stylesheet" href="([^"]+)">', style, html)
    html, scripts = re.subn(r'<script src="([^"]+)"></script>', script, html)
    if not styles or not scripts:
        sys.exit("taski.html has no stylesheet or scripts to inline")

    banner = (
        "<!--\n"
        "  Taski %s, single-file edition.\n"
        "  Save this file anywhere and open it in a browser. It is the same readable\n"
        "  source as taski_src/ in the repository, pasted in unchanged and in order.\n"
        "  Source and license: https://github.com/stan-kondrat/taski\n"
        "-->\n" % ver
    )
    return html.replace("<!doctype html>\n", "<!doctype html>\n" + banner, 1)


def add_tree(zf, rel, prefix):
    full = os.path.join(ROOT, rel)
    if os.path.isfile(full):
        zf.write(full, "%s/%s" % (prefix, rel))
        return
    for dirpath, dirnames, filenames in os.walk(full):
        dirnames[:] = sorted(d for d in dirnames if not d.startswith(".") and d != "__pycache__")
        for name in sorted(filenames):
            if name.startswith("."):
                continue
            path = os.path.join(dirpath, name)
            zf.write(path, "%s/%s" % (prefix, os.path.relpath(path, ROOT).replace(os.sep, "/")))


def main():
    if len(sys.argv) == 3 and sys.argv[1] == "--publish-config":
        with open(sys.argv[2], encoding="utf-8") as f:
            text = publish_config(f.read())
        with open(sys.argv[2], "w", encoding="utf-8") as f:
            f.write(text)
        return
    out = os.path.abspath(sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, "dist"))
    ver = version()
    shutil.rmtree(out, ignore_errors=True)
    os.makedirs(out)

    with open(os.path.join(out, "taski.html"), "w", encoding="utf-8") as f:
        f.write(single_file(ver))

    with zipfile.ZipFile(os.path.join(out, "taski.zip"), "w", zipfile.ZIP_DEFLATED) as zf:
        for rel in ZIP_CONTENTS:
            add_tree(zf, rel, "taski-%s" % ver)

    with open(os.path.join(out, "VERSION"), "w") as f:
        f.write(ver + "\n")

    for name in sorted(os.listdir(out)):
        print("  %-12s %7.1f KB" % (name, os.path.getsize(os.path.join(out, name)) / 1024))
    print("Built Taski %s in %s" % (ver, out))


if __name__ == "__main__":
    main()
