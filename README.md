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
  (Google's sign-in and Picker scripts load only if you choose Drive).
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
  script, and “Add from Drive” loads the Google Picker; no other third-party code is ever loaded.
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
- `status`: `todo`, `doing`, `blocked`, `done`, `cancelled`, unless the project sets its own
  (below). `priority`: `low`, `normal`, `high`. Dates: `YYYY-MM-DD`. `tags`: the task's labels.
  `milestone`: one of the project's milestones (below).
- The first `# Heading` is the title. Unknown fields and all other text are kept as they are.
- `## Files` in a task or project README links its documents: relative paths or URLs.
  Taski lists them with previews, next to unlinked files it finds in the same folder.

### Project statuses, labels and milestones

Each project can have its own workflow, set in its README frontmatter (or under
**Settings** on the project page):

```markdown
---
type: project
status: active
statuses: backlog, todo, doing, review, done, cancelled
active-statuses: doing, review
closed-statuses: done, cancelled
labels: bug, idea, research
milestones: MVP (2026-12-01), Beta, 1.0
---
```

- `statuses` is the order of the board columns and of the list.
- `active-statuses` are "in progress": shown first and under **Focus** (default `doing`).
- `closed-statuses` are finished: hidden from open tasks (default `done` and `cancelled`,
  or the last status).
- `labels` are suggested when labelling tasks; labels tasks already use are added.
- `milestones` are the project's milestones in order, each with an optional date in
  brackets. A task joins one with `milestone: MVP`. The project page shows each milestone's
  progress and filters by it; the sidebar lists them under their project; the overview shows
  each project's next unfinished milestone.
- `status: archived` (the **Archive** button on the project page) folds a project away under
  **Archived** in the sidebar and the overview and leaves its tasks out of Focus. Its files stay
  as they are; **Unarchive** makes it active again.
- New tasks get the first status that is neither active nor closed.
- Plain web hosting can't list folders, so `## Projects` and `## Tasks` links are how
  projects and tasks are found there. Taski adds these links when it creates something.
  Drive, local folders and `server.py` also find unlinked tasks inside `tasks/`.

The full rules for agents are in [taski-demo/AGENTS.md](./taski-demo/AGENTS.md).

## Google Drive setup

### Two levels of access
Which files Taski can see depends on whose Google client you sign in with:

| | Taski's client (published app) | Your own client ID |
|---|---|---|
| Scope | `drive.file` | `drive` (option on by default) |
| Who can sign in | anyone, once the app is published | you and up to 100 test users you add |
| Files added by agents or other apps | hidden until you use **Add from Drive** | ✅ visible on refresh |
| Google review | none: `drive.file` is non-sensitive | none, while the client stays in testing mode |

The full `drive` scope is restricted: to offer it to everyone, Google requires a
verification that can take weeks and may need a yearly security assessment. A client in
testing mode may use it for its own test users without that, so Taski's published client
uses `drive.file` and your own client can see everything. Google may ask testing-mode
users to sign in again after about a week. Taski has no server either way: the access
token stays in your browser's memory.

### What `drive.file` can see
With Taski's client, Google shows Taski just:

- files and folders **Taski created**, such as projects and tasks added in the app, even
  after you or an agent edit them elsewhere;
- existing files and folders **you add** with **Add from Drive** in the top bar, which
  opens the Google Picker in the workspace folder.

Anything else stays hidden, including Markdown files that agents, Drive for desktop or
another app add to the workspace later. To show them, use **Add from Drive** and select
them, and also the folders they are in, since Taski finds files by walking folders. Files
saved by deleting and recreating them get a new ID and must be added again. Taski finds
its workspace folder (default `taski`) the same way, so an existing folder of that name
that Taski didn't create is not used: Taski creates its own next to it. Add the existing
one's contents with **Add from Drive**, or pick another folder name. If you need agents
to drop files in, use your own client ID.

### Setting up Taski's client (published app)
The published app (https://stan-kondrat.github.io/taski/app/ and `/demo/`) comes with
Taski's Google OAuth client. The downloads and local copies don't include it. In
[Google Cloud Console](https://console.cloud.google.com/):

1. Enable the **Google Drive API** and the **Google Picker API**.
2. **Google Auth Platform → Clients:** a **Web application** client whose only authorized
   JavaScript origin is `https://stan-kondrat.github.io`, matching `DRIVE_ORIGINS` in
   [`taski_src/config.js`](./taski_src/config.js).
3. **Google Auth Platform → Data access:** only the scope `.../auth/drive.file`.
4. **APIs & Services → Credentials → Create credentials → API key**, for the Picker:
   - Application restrictions → **Websites**: `https://stan-kondrat.github.io/*` and
     `https://docs.google.com/*`. The Picker runs in a docs.google.com frame and fails
     with "API developer key is invalid" without it.
   - API restrictions: **Google Picker API** and **Google Drive API**.
5. **Google Auth Platform → Audience:** while the status is **Testing**, only test users
   can sign in. **Publish app** to let anyone sign in.
6. Add the client ID and the API key as the repository secrets `DRIVE_CLIENT_ID` and
   `DRIVE_API_KEY` (see below).

Taski needs only the client ID: sign-in runs entirely in the browser through Google
Identity Services' token client, with no redirect URI and no client secret. Don't put the
**client secret** (or the downloaded `client_secret_….json`) anywhere in the repository,
its secrets or the site; it is confidential, and `.gitignore` skips that file.

The API key is public by nature, like the client ID: it ends up in the page's JavaScript.
It only identifies the project for quota and gives no access to anyone's files; the
restrictions above stop other sites and other APIs from using it. Don't reuse it for
paid APIs.

### Using your own client
Anywhere else (a download served on `localhost`, `server.py`, your own domain), or to let
Taski see files that agents add, open **Use your own client ID** on the start screen. The
settings are remembered in that browser. For files on your own computer, a local folder
or `server.py` is usually simpler than Drive.

1. In [Google Cloud Console](https://console.cloud.google.com/), create a project and enable the **Google Drive API**.
2. **Google Auth Platform → Audience:** user type External, status **Testing**, and add
   your Google account as a test user. Keep it in testing mode.
3. **Clients:** create a **Web application** client. Add every address you open Taski on
   as an authorized JavaScript origin: scheme, host and port, no path, e.g. `http://localhost:8123`.
   No redirect URI is needed.
4. **Data access:** add the scope `.../auth/drive`.

On the start screen, leave **See every file in the folder** on. To use `drive.file`
instead (for example to publish your own copy), turn it off, add the `.../auth/drive.file`
scope, and for **Add from Drive** create an API key as in step 4 of the previous section,
with your own addresses, and paste it next to the client ID.

### How the client ID and API key get into builds
Neither is in the repository: `DRIVE_CLIENT_ID` and `DRIVE_API_KEY` in `config.js` are
empty. CI fills them in from the repository secrets **`DRIVE_CLIENT_ID`** and
**`DRIVE_API_KEY`** (Settings → Secrets and variables → Actions) when it builds the
published `/app/` and `/demo/`; see `scripts/build-dist.py`. Neither is really secret,
though: both end up readable in the published JavaScript, and what protects them is the
list of allowed origins and the key's restrictions. Running from a clone, set them yourself:

```bash
TASKI_DRIVE_CLIENT_ID=….apps.googleusercontent.com TASKI_DRIVE_API_KEY=AIza… scripts/build-site.sh
```

or paste them on the start screen.

## Repository layout

```
taski.html              the app (single entry page)
taski_src/              plain scripts + CSS; each file adds itself to window.Taski
  config.js             version, Drive client ID and API key, default folders
  app.js                startup, storage selection, routing
  markdown.js           frontmatter, sections, checklists, renderer
  projects.js, tasks.js workspace model, project statuses and labels
  files.js              attached documents (`## Files` links, notes)
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
publishes it to GitHub Pages. The published `/app/` and `/demo/` pages load their scripts
and stylesheet as `taski_src/…?v=<hash of the files>`, so browsers, which may cache each file
for 10 minutes, never mix files from two deploys.

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
