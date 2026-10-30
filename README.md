# Taski

A private, serverless task manager in a single static HTML page. Every project
and task is a plain Markdown file. No backend, no database, no account, no
dependencies. You, the browser UI and AI agents all edit the same files.

- **Static HTML** — `taski.html` plus plain JavaScript files. Host it on GitHub Pages,
  any static web server, or just open the downloaded file in your browser.
- **Readable** — nothing is minified. The downloadable single file is the same commented
  source, pasted in unchanged.
- **Serverless** — there is no Taski backend. Your browser talks directly to where your
  files live: your disk or your own Google Drive.
- **Privacy first** — no analytics, tracking or cookies, and no third-party scripts
  (Google's sign-in script loads only if you choose Drive).
- **Offline** — with a local folder or `server.py`, nothing leaves your computer.

Try it:

- **Landing:** https://stan-kondrat.github.io/taski/
- **App (Google Drive or a local folder):** https://stan-kondrat.github.io/taski/app/
- **Demo (this repo's [`taski-demo/`](./taski-demo/) folder, read-only):** https://stan-kondrat.github.io/taski/demo/
- **Download:** https://stan-kondrat.github.io/taski/releases/

## How to use

1. **Public page** — open https://stan-kondrat.github.io/taski/app/. Nothing to install.
2. **Download and open** — get [`taski.html`](https://stan-kondrat.github.io/taski/releases/)
   (one file) or `taski.zip` (the source folder) and open the HTML file in your browser.
   It runs straight from disk.
3. **Python static server** — in the repo or unzipped folder:
   ```bash
   python3 -m http.server 8000
   ```
   then open http://localhost:8000/taski.html. It shows the `taski-demo/` folder next to it, read-only.
4. **Private server** — Taski's own server stores files on that machine and edits them from
   any browser:
   ```bash
   python3 server.py --root ~/Documents/taski
   ```
   then open http://127.0.0.1:8000/taski.html. Without `--root` it serves the sample workspace.

Where your files can live, for each way:

| Way to run | Folder on your computer | Google Drive | Files on the server | Web folder (read-only) | Offline | Setup |
|---|---|---|---|---|---|---|
| 1 · Public page | ✓ ᵃ | ✓ | – | ✓ ᵇ | – | none |
| 2 · Downloaded HTML, opened from disk | ✓ ᵃ | – ᶜ | – | ✓ ᵇ | ✓ | download |
| 3 · `python3 -m http.server` | ✓ ᵃ | ✓ ᵈ | read-only | ✓ ᵇ | ✓ | one command |
| 4 · `python3 server.py` | ✓ ᵃ | ✓ ᵈ | ✓ read & write | ✓ ᵇ | ✓ ᵉ | one command |

- ᵃ Read and write in Chrome, Edge, Arc, Brave and other Chromium browsers, on `https://`,
  `localhost` or a file opened from disk. Safari and Firefox can open a folder **read-only**
  (Taski reads a copy of the files you pick); to edit there, use way 4.
- ᵇ An `http(s)://` address whose server allows cross-origin reads (GitHub Pages does).
  Browsers never let a page opened from disk read other files on disk by address, so for
  local files use a local folder (ᵃ) or way 4.
- ᶜ Google signs in only on a web address, so a downloaded file links to the public page for Drive.
- ᵈ Needs your own OAuth client ID with this address as an allowed origin (see [Google Drive setup](#google-drive-setup)).
- ᵉ On your own computer. On a remote server, you only need a connection to that server.

**Private server safety:** `server.py` has no login. It listens only on `127.0.0.1`; reach a
remote one through an SSH tunnel (`ssh -L 8000:127.0.0.1:8000 your-server`) or put it behind
a reverse proxy with HTTPS and a password.

## URL parameters

`taski.html` takes the storage type and a path from the query string, so you can bookmark
or link straight to a workspace:

| `storage` | `path` means | Default path | Opens |
|---|---|---|---|
| `http` | workspace URL, absolute or relative to the page | `./taski-demo/` | right away, read-only |
| `server` | folder inside `server.py --root` | the root | right away |
| `folder` | folder inside the folder you pick on this computer | the picked folder | after a click ¹ |
| `files` | same, read-only, for Safari and Firefox | the picked folder | after a click ¹ |
| `drive` | folder in My Drive | `taski` | after a click ² |

Examples:

```
taski.html?storage=http&path=https://example.com/notes/taski/
taski.html?storage=server&path=work
taski.html?storage=folder&path=projects/2026
taski.html?storage=drive&path=Work/taski
```

1. Browsers only open a local folder after a click. If you already allowed the remembered
   folder, Chromium may open it right away.
2. Google sign-in needs a click; the start screen opens with Drive first and the path filled in.

The start screen says how Taski was opened (from disk, from this computer, by `server.py`
or from a website) and shows only the options that work there. The rest are listed under
"Not available here" with the reason and what to do instead.

Without parameters, Taski uses `server.py` if that served the page, then a `taski-demo/`
folder next to `taski.html`, and otherwise shows the start screen.

Taski also writes these parameters into the address bar whenever a workspace opens, so
reloading or bookmarking the page brings you back to the same storage (the `#/…` part keeps
the project or task you were on). They hold only the storage type and the `path` you gave:
never a Drive client ID, and not the name of a folder you picked on this computer.

The query string is part of the page request, so the site hosting `taski.html` can see
it. For private folder names, use the start screen instead of a link.

## Privacy

Taski runs entirely in your browser and has no server of its own, so there is nowhere
your tasks could be collected.

- **Your files** are read and written directly between your browser and the storage you
  choose. In local folder and `server.py` modes they never leave your computer;
  `server.py` listens only on 127.0.0.1.
- **Google Drive** access goes straight from your browser to Google's API. The access
  token stays in the page's memory and is never saved. Signing in loads Google's sign-in
  script; no other third-party code is ever loaded.
- **Stored in your browser** (local storage, never sent anywhere): which storage you
  picked, the Drive client ID and folder name, and the web-folder URL. A chosen local
  folder is remembered in IndexedDB so you can reopen it.
- **No analytics, tracking, cookies or telemetry.**
- **Hosting:** whoever serves the static page (for example GitHub Pages) sees ordinary web
  requests for it, as with any website. Your task files are not part of those requests,
  except in read-only web-folder mode, where the files come from that web server.

## File format

```
taski/
├── README.md                 type: workspace — "## Projects" links every project
├── AGENTS.md                 format rules for AI agents
└── homelab/
    ├── README.md             type: project — "## Tasks" links every task
    └── tasks/
        ├── k3s-cluster/
        │   ├── README.md     a task with related files
        │   └── install-log.md
        └── tailscale.md      a task that is a single file
```

```markdown
---
type: task
status: doing
priority: high
due: 2026-11-09
tags: kubernetes, raspberry-pi
---

# Run a k3s cluster on the Pis

- [x] Join pi-2 and pi-3 as agents
- [ ] Install Longhorn and test a volume failover

## Files

- [Install log](./install-log.md)
```

- Frontmatter is a strict subset of YAML: one `key: value` per line, no nesting.
- `status`: `todo`, `doing`, `blocked`, `done`, `cancelled`. `priority`: `low`, `normal`, `high`. Dates: `YYYY-MM-DD`.
- The first `# Heading` is the title. Unknown fields and all other text are kept as they are.
- Plain web hosting can't list folders, so `## Projects` and `## Tasks` links are how
  projects and tasks are found there. Taski adds these links when it creates something.
  Drive, local folders and `server.py` also find unlinked tasks inside `tasks/`.

The full rules for agents are in [taski-demo/AGENTS.md](./taski-demo/AGENTS.md).

## Google Drive setup

Drive mode needs your own OAuth client ID:

1. In [Google Cloud Console](https://console.cloud.google.com/), create a project and enable the **Google Drive API**.
2. Set up the OAuth consent screen in testing mode and add your Google account as a test user.
3. Create an OAuth client of type **Web application**. Add your site as an authorized
   JavaScript origin, for example `https://stan-kondrat.github.io` and `http://127.0.0.1:8000`.
4. Put the client ID in [`taski_src/config.js`](./taski_src/config.js), or paste it on the start screen (it is remembered in that browser).

Taski asks for the full `drive` scope so it can see Markdown files that you or
agents created outside the app. Taski has no server: the access token stays in your browser.

## Repository layout

```
taski.html              the app (single entry page)
taski_src/              plain scripts + CSS; each file adds itself to window.Taski
  config.js             version, Drive client ID, default folders
  app.js                startup, storage selection, routing
  markdown.js           frontmatter, sections, checklists, renderer
  projects.js, tasks.js workspace model
  storage/              drive.js, http.js, filesystem.js, python.js, scoped.js (subfolder)
  ui/                   views
server.py               optional local read/write server (Python 3.9+, standard library)
taski-demo/             sample workspace, published as the demo
landing/                landing page (site root) and releases/ download page
tests/                  tests.html (browser) and test_server.py
scripts/
  build-dist.py         dist/taski.html (single file) and dist/taski.zip, files copied verbatim
  build-site.sh         the GitHub Pages site, including the downloads
  run-js-tests.sh       tests.html in headless Chrome
  check-single-file.sh  opens dist/taski.html from disk in headless Chrome
.github/workflows/      ci.yml: tests and Pages deploy; release.yml: GitHub Releases
```

## Tests

```bash
python3 -m unittest discover tests
```

For the JavaScript tests, run `python3 server.py` and open http://127.0.0.1:8000/tests/tests.html,
or run them headless if Chrome is installed:

```bash
scripts/run-js-tests.sh "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
```

## Deploying

`.github/workflows/ci.yml` runs the Python and JavaScript tests on every push and pull
request. On `main`, once the tests pass, it builds the site with `scripts/build-site.sh` and
publishes it to GitHub Pages.

One-time setup: in the repository settings, set **Pages → Build and deployment → Source**
to **GitHub Actions**.

To preview the published site locally:

```bash
scripts/build-site.sh && python3 -m http.server 8002 --directory _site
```

## Releasing

1. Set `VERSION` in [`taski_src/config.js`](./taski_src/config.js), commit and push to `main`.
2. Tag it and push the tag:
   ```bash
   git tag v0.1.0 && git push origin v0.1.0
   ```

`.github/workflows/release.yml` checks that the tag matches `VERSION`, runs the tests,
builds `taski.html` and `taski.zip` with `scripts/build-dist.py`, and publishes them as a
GitHub Release. The download page on the site always offers the build from `main`.

To build the downloads locally:

```bash
python3 scripts/build-dist.py
```

## License

[JSON License](./LICENSE): the MIT License plus one condition, "The Software shall be
used for Good, not Evil."
