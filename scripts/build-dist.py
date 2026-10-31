#!/usr/bin/env python3
"""Build the downloadable releases. Standard library only, Python 3.9+.

    dist/taski.html   one self-contained file: taski.html with every <script src>
                      and the stylesheet pasted in verbatim. Nothing is minified or
                      renamed; each block is labelled with its source file.
    dist/taski.zip    the readable source as it is in the repo: taski.html,
                      taski_src/, server.py, the sample workspace, README and LICENSE.

The only edits are values in config.js:
    DEMO_WORKSPACE    single file and /app/ only: the public demo URL, because the
                      relative ./taski-demo/ does not exist next to them.
    DRIVE_CLIENT_ID   /app/ and /demo/ only, from the TASKI_DRIVE_CLIENT_ID and
    DRIVE_API_KEY     TASKI_DRIVE_API_KEY environment variables when set (CI passes the
                      DRIVE_CLIENT_ID and DRIVE_API_KEY secrets). Taski's Google client
                      only allows the published site, so the downloads keep them empty
                      and ask for your own client ID.

Usage:
    python3 scripts/build-dist.py [output-dir]          (default: dist)
    python3 scripts/build-dist.py --publish-config FILE  apply both edits to a copied
                                                         config.js (used for /app/)
    python3 scripts/build-dist.py --drive-config FILE    only fill in the Drive values
                                                         (used for /demo/)
"""

import os
import re
import shutil
import sys
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PUBLIC_DEMO_URL = "https://stan-kondrat.github.io/taski/demo/taski-demo/"
DEMO_LINE = "const DEMO_WORKSPACE = './taski-demo/';"
# config.js line → (environment variable, pattern its value must match)
DRIVE_VALUES = {
    "DRIVE_CLIENT_ID": ("TASKI_DRIVE_CLIENT_ID", r"[\w-]+\.apps\.googleusercontent\.com"),
    "DRIVE_API_KEY": ("TASKI_DRIVE_API_KEY", r"AIza[\w-]{30,}"),
}
ZIP_CONTENTS = ["taski.html", "taski_src", "taski-demo", "server.py", "README.md", "LICENSE", "AGENTS.md"]


def version():
    with open(os.path.join(ROOT, "taski_src", "config.js"), encoding="utf-8") as f:
        m = re.search(r"const VERSION = '([^']+)';", f.read())
    if not m:
        sys.exit("VERSION not found in taski_src/config.js")
    return m.group(1)


def set_drive_values(text):
    """Fill in the Drive client ID and API key from the environment, where set.
    Fails if a config.js line has changed or a value looks wrong."""
    for name, (env, pattern) in DRIVE_VALUES.items():
        line = "const %s = '';" % name
        if line not in text:
            sys.exit("config.js no longer contains: %s" % line)
        value = os.environ.get(env, "").strip()
        if not value:
            continue
        if not re.fullmatch(pattern, value):
            sys.exit("%s does not look like a Google %s" % (env, name))
        text = text.replace(line, "const %s = '%s'; // set by scripts/build-dist.py from CI" % (name, value))
    return text


def set_demo_url(text):
    """Point DEMO_WORKSPACE at the public demo. Fails if the line has changed."""
    if DEMO_LINE not in text:
        sys.exit("config.js no longer contains: %s" % DEMO_LINE)
    return text.replace(DEMO_LINE, "const DEMO_WORKSPACE = '%s'; // set by scripts/build-dist.py" % PUBLIC_DEMO_URL)


def publish_config(text):
    """config.js for /app/: the public demo URL and the Drive values."""
    return set_drive_values(set_demo_url(text))


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
            text = set_demo_url(text)
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
    if len(sys.argv) == 3 and sys.argv[1] in ("--publish-config", "--drive-config"):
        edit = publish_config if sys.argv[1] == "--publish-config" else set_drive_values
        with open(sys.argv[2], encoding="utf-8") as f:
            text = edit(f.read())
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
