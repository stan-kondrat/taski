// Entry point: choose storage, load the workspace, route by URL hash.

(function (Taski) {
'use strict';

const { DRIVE_CLIENT_ID, DRIVE_ROOT, LOCAL_WORKSPACE, DEMO_WORKSPACE, VERSION } = Taski.config;
const { createProject, loadWorkspace } = Taski.projects;
const { driveStorage } = Taski.drive;
const { ensurePermission, filesystemStorage, filesystemSupported, hasPermission, pickFolder, rememberedFolder } = Taski.filesystem;
const { httpStorage } = Taski.http;
const { normalize } = Taski.path;
const { detectPythonServer, pythonStorage } = Taski.python;
const { scopedStorage } = Taski.scoped;
const { supported: pickedSupported, pickedStorage, chooseFolderFiles } = Taski.picked;
const { ConflictError } = Taski.storage;
const { createTask, loadTask, saveTask, setTaskCheck, setTaskField } = Taski.tasks;
const { h } = Taski.dom;
const { fileView, overviewView, projectHref, projectView, taskHref, taskView } = Taski.views;

const main = /** @type {HTMLElement} */ (document.getElementById('main'));
const sidebar = /** @type {HTMLElement} */ (document.getElementById('sidebar'));
const sourceLabel = /** @type {HTMLElement} */ (document.getElementById('source'));
const toast = /** @type {HTMLElement} */ (document.getElementById('toast'));

/** Opened as a downloaded file: no server to probe, and Google sign-in is unavailable. */
const fromDisk = location.protocol === 'file:';
const ONLINE_APP = 'https://stan-kondrat.github.io/taski/app/';

/** @type {import('./storage/storage.js').Storage | null} */
let storage = null;
/** @type {import('./projects.js').Workspace | null} */
let workspace = null;
let editing = false;
/** @type {Map<string, {filter: string, query: string}>} */
const listUi = new Map();

// ---- settings kept in this browser only ----

const PREFS_KEY = 'taski.source';
/** @returns {{kind?: string, url?: string, clientId?: string, root?: string}} */
function prefs() {
  try {
    return JSON.parse(localStorage.getItem(PREFS_KEY) || '{}');
  } catch {
    return {};
  }
}
/** @param {object} p */
function savePrefs(p) {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify({ ...prefs(), ...p }));
  } catch {
    // private mode: nothing remembered
  }
}

// ---- feedback ----

let toastTimer = 0;
/**
 * @param {string} message
 * @param {'info' | 'error'} [kind]
 */
function notify(message, kind = 'info') {
  toast.textContent = message;
  toast.className = `toast show ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (toast.className = 'toast'), kind === 'error' ? 6000 : 2500);
}

/** @param {unknown} e */
function showError(e) {
  console.error(e);
  const err = /** @type {Error} */ (e);
  if (err instanceof ConflictError) {
    notify(editing ? `${err.message} Copy your edits before refreshing.` : err.message, 'error');
    if (!editing) refresh();
  } else {
    notify(err.message || String(e), 'error');
  }
}

// ---- storage selection ----

/**
 * Where the open workspace came from, as URL parameters (see STORAGE_PARAM below).
 * @typedef {Object} Link
 * @property {'http' | 'server' | 'folder' | 'files' | 'drive'} storage
 * @property {string} [path]   Left out when it is the default.
 */

/**
 * Put ?storage=…&path=… in the address bar, so reloading or bookmarking the
 * page reopens the same storage. Other query parameters and the #/route stay.
 * @param {Link} link
 */
function setUrlParams(link) {
  const params = new URLSearchParams(location.search);
  params.delete('storage');
  params.delete('path');
  params.set('storage', link.storage);
  if (link.path) params.set('path', link.path);
  // URLSearchParams escapes '/' and ':'; both are allowed in a query and easier to read.
  const query = params.toString().replace(/%2F/gi, '/').replace(/%3A/gi, ':');
  try {
    history.replaceState(null, '', `${location.pathname}?${query}${location.hash}`);
  } catch {
    // Some browsers refuse to rewrite file:// addresses; the URL just stays as it was.
  }
}

/**
 * @param {import('./storage/storage.js').Storage} s
 * @param {Link} link  How to reopen it; written to the URL.
 */
async function connect(s, link) {
  storage = s;
  setUrlParams(link);
  sourceLabel.textContent = `${s.label}${s.canWrite ? '' : ' · read-only'}`;
  document.body.classList.add('connected');
  await refresh();
}

/**
 * URL parameters, e.g. `taski.html?storage=server&path=work`:
 *
 *   storage  path
 *   http     workspace URL, absolute or relative to this page (default ./taski-demo/)
 *   server   folder inside server.py's --root (default: the root)
 *   folder   folder inside the folder you pick on this computer (default: that folder)
 *   files    same, read-only, for browsers that can't edit folders (Safari, Firefox)
 *   drive    folder in My Drive (default: taski)
 *
 * `http` and `server` open right away. `folder`, `files` and `drive` need a click, so the
 * start screen opens with that choice first and the path filled in; a folder
 * that already has permission opens right away.
 */
const STORAGE_PARAM = /** @type {Record<string, 'http' | 'python' | 'filesystem' | 'picked' | 'drive'>} */ ({
  http: 'http', web: 'http',
  server: 'python', python: 'python',
  folder: 'filesystem', filesystem: 'filesystem',
  files: 'picked', picked: 'picked',
  drive: 'drive',
});

/**
 * @typedef {Object} StartRequest
 * @property {'http' | 'python' | 'filesystem' | 'picked' | 'drive' | null} kind
 * @property {string} path
 */

/** @returns {StartRequest} */
function startRequest() {
  const params = new URLSearchParams(location.search);
  const name = (params.get('storage') || '').trim().toLowerCase();
  const kind = STORAGE_PARAM[name] || null;
  if (name && !kind) notify(`Unknown storage “${name}”. Use http, server, folder, files or drive.`, 'error');
  return { kind, path: (params.get('path') || '').trim() };
}

/** Choose storage without user input where possible; otherwise show the picker. */
async function start() {
  const want = startRequest();
  try {
    if (want.kind === 'http') return await connect(httpStorage(want.path || LOCAL_WORKSPACE), { storage: 'http', path: want.path });
    if (want.kind === 'python') {
      if (!(await detectPythonServer())) throw new Error('This page is not served by server.py, so storage=server is not available.');
      return await connect(scopedStorage(pythonStorage(), want.path), { storage: 'server', path: want.path });
    }
    if (want.kind === 'filesystem') {
      const remembered = filesystemSupported ? await rememberedFolder() : null;
      if (remembered && (await hasPermission(remembered))) return await connect(scopedStorage(filesystemStorage(remembered), want.path), { storage: 'folder', path: want.path });
    }
    if (!want.kind && !fromDisk) {
      if (await detectPythonServer()) return await connect(pythonStorage(), { storage: 'server' });
      const probe = await fetch(new URL('README.md', new URL(LOCAL_WORKSPACE, location.href)), { cache: 'no-store' }).catch(() => null);
      if (probe?.ok) return await connect(httpStorage(LOCAL_WORKSPACE), { storage: 'http' });
    }
  } catch (e) {
    showError(e);
  }
  showPicker(want);
}

/**
 * @typedef {Object} PageContext
 * @property {'disk' | 'local' | 'web'} opened  file://, this computer (localhost), or a website
 * @property {boolean} server         served by server.py
 * @property {boolean} folderAccess   can read and write a local folder (File System Access API)
 * @property {boolean} folderPick     can read a picked folder (<input webkitdirectory>)
 */

/** Work out what this page can do, from how it was opened and what the browser supports. */
async function pageContext() {
  const host = location.hostname;
  const local = host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host.endsWith('.localhost');
  return {
    opened: fromDisk ? 'disk' : local ? 'local' : 'web',
    server: !fromDisk && (await detectPythonServer()),
    folderAccess: filesystemSupported && window.isSecureContext,
    folderPick: pickedSupported,
  };
}

/** @param {PageContext} ctx */
function describeContext(ctx) {
  if (ctx.opened === 'disk') return 'You opened Taski as a file on this computer (file://).';
  if (ctx.server) return 'Taski is served by server.py on this computer.';
  if (ctx.opened === 'local') return `Taski is served from this computer (${location.host}) by a web server. “Web folder” can read Markdown files it serves, read-only.`;
  return `Taski is served from ${location.host}.`;
}

/** Fresh nodes each call: a DOM node can only sit in one place. */
const serverHowto = () => ['run ', h('code', null, 'python3 server.py'), ' in the Taski folder and open ', h('code', null, 'http://127.0.0.1:8000/taski.html')];
const staticHowto = () => ['serve the Taski folder with any static web server, for example ', h('code', null, 'python3 -m http.server 8000'), ', and open ', h('code', null, 'http://localhost:8000/taski.html')];

/** @param {StartRequest} [want]  Choice and path from the URL, if any. */
async function showPicker(want = { kind: null, path: '' }) {
  document.body.classList.remove('connected');
  sourceLabel.textContent = '';
  sidebar.replaceChildren();
  main.replaceChildren(h('p.muted.loading', null, 'Checking what this page can do…'));
  const ctx = await pageContext();
  const p = prefs();
  const remembered = ctx.folderAccess ? await rememberedFolder() : null;

  /**
   * @param {() => Promise<import('./storage/storage.js').Storage | null>} make  null = cancelled
   * @param {() => Link} link  Read after `make`, so it sees the values the user entered.
   */
  const run = (make, link) => async (/** @type {Event} */ e) => {
    e.preventDefault();
    const btn = /** @type {HTMLElement} */ (e.currentTarget);
    btn.closest('.choice')?.classList.add('busy');
    try {
      const s = await make();
      if (s) await connect(s, link());
    } catch (err) {
      if (/** @type {Error} */ (err).name !== 'AbortError') showError(err);
    } finally {
      btn.closest('.choice')?.classList.remove('busy');
    }
  };

  // A path from the URL (?storage=…&path=…) applies to the matching option.
  const fromUrl = (/** @type {string} */ kind) => (want.kind === kind && want.path) || '';
  const subfolderNote = (/** @type {string} */ sub) => (sub ? h('p.muted', null, 'Opens the subfolder ', h('code', null, sub), ' inside it.') : null);

  /**
   * @typedef {Object} Option
   * @property {string} key
   * @property {string} title
   * @property {HTMLElement | null} card      Shown when the option works here.
   * @property {import('./ui/dom.js').Child} [why]  Why not, and what to do instead.
   */
  /** @type {Option[]} */
  const options = [];

  // Local server: read and write through server.py.
  options.push({
    key: 'python',
    title: 'Local server (server.py)',
    card: ctx.server
      ? h('div.choice', null,
          h('h2', null, 'Local server'),
          h('p.muted', null, 'Read and write the folder server.py serves. Any browser, works offline.'),
          subfolderNote(fromUrl('python')),
          h('button.primary', { type: 'button', onclick: run(async () => scopedStorage(pythonStorage(), fromUrl('python')), () => ({ storage: 'server', path: fromUrl('python') })) }, 'Open'))
      : null,
    why: ['This page isn’t served by server.py. To read and write files in any browser, ', ...serverHowto(), '.'],
  });

  // Any static web server: only a hint when opened from disk, where fetching neighbouring files is blocked.
  options.push({
    key: 'static',
    title: 'Files next to this page (read-only, always current)',
    card: null,
    why: ctx.opened === 'disk'
      ? ['A page opened from disk can’t read the files next to it. To view them in any browser, ', ...staticHowto(), '. Taski then reads them read-only and picks up every change on refresh.']
      : null,
  });

  // Folder on this computer, read and write (Chromium).
  const sub = fromUrl('filesystem');
  options.push({
    key: 'filesystem',
    title: 'Folder on this computer (read and write)',
    card: ctx.folderAccess
      ? h('div.choice', null,
          h('h2', null, 'Folder on this computer'),
          h('p.muted', null, 'Read and write Markdown files directly on disk. Works offline.'),
          subfolderNote(sub),
          remembered
            ? h('button.primary', { type: 'button', onclick: run(async () => {
                if (!(await ensurePermission(remembered))) throw new Error('Permission to the folder was not granted.');
                savePrefs({ kind: 'filesystem' });
                return scopedStorage(filesystemStorage(remembered), sub);
              }, () => ({ storage: 'folder', path: sub })) }, `Reopen “${remembered.name}”`)
            : null,
          h(remembered ? 'button' : 'button.primary', { type: 'button', onclick: run(async () => {
            savePrefs({ kind: 'filesystem' });
            return scopedStorage(filesystemStorage(await pickFolder()), sub);
          }, () => ({ storage: 'folder', path: sub })) }, 'Choose folder…'))
      : null,
    why: filesystemSupported
      ? 'Editing a local folder needs a secure page: https:// or localhost.'
      : ['This browser can’t edit local folders; that works in Chrome, Edge, Arc and Brave. Here you can open a folder read-only, or ', ...serverHowto(), ' to edit.'],
  });

  // Folder on this computer, read-only (every browser). Redundant where editing works.
  const pickedSub = fromUrl('picked');
  options.push({
    key: 'picked',
    title: 'Folder on this computer (read-only)',
    card: ctx.folderPick && (!ctx.folderAccess || want.kind === 'picked')
      ? h('div.choice', null,
          h('h2', null, ctx.folderAccess ? 'Folder, read-only' : 'Folder on this computer'),
          h('p.muted', null, 'Read-only. Pick a folder to view its Markdown files. Your browser may call this “upload”, but nothing leaves this computer.'),
          subfolderNote(pickedSub),
          h('button.primary', { type: 'button', onclick: async (/** @type {Event} */ e) => {
            // Not run(): the card must stay clickable while the dialog is open,
            // because some browsers never tell us it was cancelled.
            const card = /** @type {HTMLElement} */ (e.currentTarget).closest('.choice');
            const files = await chooseFolderFiles();
            if (!files) return;
            card?.classList.add('busy');
            try {
              savePrefs({ kind: 'picked' });
              await connect(scopedStorage(pickedStorage(files), pickedSub), { storage: 'files', path: pickedSub });
            } catch (err) {
              showError(err);
            } finally {
              card?.classList.remove('busy');
            }
          } }, 'Choose folder…'))
      : null,
    why: ctx.folderPick ? null : 'This browser can’t pick folders.',
  });

  // Google Drive: needs a web origin for sign-in.
  const clientId = /** @type {HTMLInputElement} */ (h('input', { type: 'text', value: p.clientId || DRIVE_CLIENT_ID, placeholder: '1234-abc.apps.googleusercontent.com', required: true }));
  const driveRoot = /** @type {HTMLInputElement} */ (h('input', { type: 'text', value: fromUrl('drive') || p.root || DRIVE_ROOT, required: true }));
  options.push({
    key: 'drive',
    title: 'Google Drive',
    card: ctx.opened !== 'disk'
      ? h('form.choice', {
          onsubmit: run(async () => {
            savePrefs({ kind: 'drive', clientId: clientId.value.trim(), root: driveRoot.value.trim() });
            return driveStorage(clientId.value.trim(), driveRoot.value.trim());
          }, () => ({ storage: 'drive', path: driveRoot.value.trim() === DRIVE_ROOT ? '' : driveRoot.value.trim() })),
        },
        h('h2', null, 'Google Drive'),
        h('p.muted', null, 'Read and write Markdown files in a folder of your Drive.'),
        DRIVE_CLIENT_ID ? null : h('label', null, 'OAuth client ID', clientId),
        h('label', null, 'Folder in My Drive', driveRoot),
        h('button.primary', { type: 'submit' }, 'Connect Google Drive'))
      : null,
    why: ['Google sign-in needs a web address, not a file opened from disk. ', h('a', { href: ONLINE_APP }, 'Open the online app'), ' to use Drive.'],
  });

  // Web folder: any http(s) address, also from disk.
  // Only web addresses can be read as a web folder, so skip file:// defaults.
  const webOnly = (/** @type {string | undefined} */ u) => (u && /^https?:/i.test(u) ? u : '');
  const demoUrl = webOnly(new URL(DEMO_WORKSPACE, location.href).href);
  const url = /** @type {HTMLInputElement} */ (h('input', { type: 'url', value: webOnly(p.url) || demoUrl, placeholder: 'https://example.com/taski/', required: true }));
  options.push({
    key: 'http',
    title: 'Web folder',
    card: h('form.choice', {
      onsubmit: run(async () => {
        savePrefs({ kind: 'http', url: url.value.trim() });
        return httpStorage(url.value.trim());
      }, () => {
        // The workspace next to the page is the default, so it needs no path.
        const value = url.value.trim();
        return { storage: 'http', path: value === new URL(LOCAL_WORKSPACE, location.href).href ? '' : value };
      }),
    },
    h('h2', null, 'Web folder'),
    h('p.muted', null, 'Read-only, from an http(s):// address. The folder needs a README.md listing its projects.', demoUrl ? ' Filled in with the demo to try.' : ''),
    h('label', null, 'Workspace URL', url),
    h('button', { type: 'submit' }, 'Open read-only')),
  });

  // Order: the URL's choice, then the last one used, then what suits this page best.
  const defaults =
    ctx.opened === 'disk' ? ['filesystem', 'picked', 'http'] :
    ctx.server ? ['python', 'filesystem', 'picked', 'drive', 'http'] :
    ctx.opened === 'local' ? ['filesystem', 'picked', 'http', 'drive'] :
    ['drive', 'filesystem', 'picked', 'http'];
  const rank = (/** @type {string} */ key) => {
    if (key === want.kind) return -2;
    if (key === p.kind) return -1;
    const i = defaults.indexOf(key);
    return i < 0 ? 99 : i;
  };
  const available = options.filter((o) => o.card).sort((a, b) => rank(a.key) - rank(b.key));
  const missing = options.filter((o) => !o.card && o.why);

  main.replaceChildren(h('section.view.picker', null,
    h('h1', null, 'Open a Taski workspace'),
    h('p.muted', null, 'Taski keeps tasks as Markdown files. Choose where they live.'),
    h('p.context', null, describeContext(ctx)),
    h('div.choices', null, available.map((o) => o.card)),
    missing.length
      ? h('section.unavailable', null,
          h('h2', null, 'Not available here'),
          h('ul', null, missing.map((o) => h('li', null, h('strong', null, o.title), h('span', null, o.why)))))
      : null,
    h('p.muted.small', null, `Taski ${VERSION}`)));
}

// ---- loading and routing ----

async function refresh() {
  if (!storage) return;
  try {
    workspace = await loadWorkspace(storage);
  } catch (e) {
    showError(e);
    return;
  }
  renderSidebar();
  await route();
}

function renderSidebar() {
  if (!workspace) return;
  const here = decodeURIComponent(location.hash);
  sidebar.replaceChildren(
    h('a.home', { href: '#/', class: here === '' || here === '#/' ? 'on' : '' }, workspace.title),
    h('ul', null, workspace.projects.map((p) => {
      const open = p.tasks.filter((t) => t.status !== 'done' && t.status !== 'cancelled').length;
      const on = here.startsWith(`#/p/${p.path}`) || p.tasks.some((t) => here === `#/t/${t.path}`);
      return h('li', null, h('a', { href: projectHref(p.path), class: on ? 'on' : '' },
        h('span', null, p.title), open ? h('span.count', null, open) : null));
    })));
}

/** @returns {import('./ui/views.js').ViewContext} */
function ctx() {
  return {
    storage: /** @type {import('./storage/storage.js').Storage} */ (storage),
    workspace: /** @type {import('./projects.js').Workspace} */ (workspace),
    saveTaskText: async (task, text) => {
      try {
        const saved = await saveTask(/** @type {any} */ (storage), task, text);
        editing = false;
        await replaceTask(saved);
        notify('Saved');
      } catch (e) {
        showError(e);
        throw e;
      }
    },
    setField: async (task, key, value) => {
      try {
        await replaceTask(await setTaskField(/** @type {any} */ (storage), task, key, value));
      } catch (e) {
        showError(e);
      }
    },
    setCheck: async (task, n, done) => {
      try {
        await replaceTask(await setTaskCheck(/** @type {any} */ (storage), task, n, done));
      } catch (e) {
        showError(e);
      }
    },
    createTask: async (project, title, singleFile) => {
      try {
        const task = await createTask(/** @type {any} */ (storage), project, { title, singleFile });
        await refreshData();
        location.hash = taskHref(task.path);
      } catch (e) {
        showError(e);
      }
    },
    createProject: async (title) => {
      try {
        const slug = await createProject(/** @type {any} */ (storage), /** @type {any} */ (workspace), title);
        await refreshData();
        location.hash = projectHref(slug);
      } catch (e) {
        showError(e);
      }
    },
    saveFile: async (path, text, rev) => {
      try {
        await /** @type {any} */ (storage).write(path, text, { rev });
      } catch (e) {
        showError(e);
        throw e;
      }
      editing = false;
      notify('Saved');
      await refresh();
    },
  };
}

async function refreshData() {
  if (!storage) return;
  workspace = await loadWorkspace(storage);
  renderSidebar();
}

/** Swap an edited task into the loaded workspace and re-render. */
async function replaceTask(/** @type {import('./tasks.js').Task} */ task) {
  for (const p of workspace?.projects || []) {
    const i = p.tasks.findIndex((t) => t.path === task.path);
    if (i >= 0) p.tasks[i] = task;
  }
  renderSidebar();
  await route();
}

/** @param {boolean} on */
function setEditing(on) {
  editing = on;
  route();
}

async function route() {
  if (!storage || !workspace) return;
  const hash = location.hash.replace(/^#\/?/, '');
  const [kind, ...rest] = hash.split('/');
  let path = '';
  try {
    path = normalize(rest.map(decodeURIComponent).join('/'));
  } catch {
    location.hash = '#/';
    return;
  }
  const c = ctx();
  const editUi = { editing, setEditing };
  /** @type {HTMLElement} */
  let view;

  if (kind === 'p') {
    const project = workspace.projects.find((p) => p.path === path);
    if (!project) return notFound(path);
    if (!listUi.has(path)) listUi.set(path, { filter: 'open', query: '' });
    view = projectView(c, project, /** @type {any} */ (listUi.get(path)));
    document.title = `${project.title} · Taski`;
  } else if (kind === 't') {
    const project = workspace.projects.find((p) => p.tasks.some((t) => t.path === path));
    let task = project?.tasks.find((t) => t.path === path);
    if (!task) {
      try {
        task = await loadTask(storage, path);
      } catch {
        return notFound(path);
      }
    }
    view = taskView(c, task, project, editUi);
    document.title = `${task.title} · Taski`;
  } else if (kind === 'f') {
    let file;
    try {
      file = await storage.read(path);
    } catch {
      return notFound(path);
    }
    view = fileView(c, path, file, editUi);
    document.title = `${path} · Taski`;
  } else {
    view = overviewView(c);
    document.title = workspace.title === 'Taski' ? 'Taski' : `${workspace.title} · Taski`;
  }
  main.replaceChildren(view);
}

/** @param {string} path */
function notFound(path) {
  main.replaceChildren(h('section.view', null, h('h1', null, 'Not found'), h('p.muted', null, path), h('a', { href: '#/' }, 'Back to overview')));
}

window.addEventListener('hashchange', () => {
  editing = false;
  renderSidebar();
  route();
  main.scrollTo?.(0, 0);
});

// Pick up edits made by agents or other apps when the tab comes back.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && storage && !editing) refresh();
});

document.getElementById('refresh')?.addEventListener('click', () => refresh().then(() => notify('Refreshed')));
document.getElementById('switch')?.addEventListener('click', () => {
  storage = null;
  workspace = null;
  history.replaceState(null, '', location.pathname);
  showPicker();
});

start();

})(window.Taski = window.Taski || {});
