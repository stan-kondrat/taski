// Google Drive: OAuth through Google Identity Services, files through the
// Drive v3 REST API. Workspace paths map to file IDs by walking folder names
// from a root folder (default `taski` in My Drive).
//
// Two levels of access:
// - `drive.file` (Taski's published client): Taski sees the files and folders it
//   created, plus those the user hands it in the Google Picker ("Add from Drive").
//   Google treats that scope as non-sensitive, so the app can be public without
//   a security review. Files that agents or other apps add stay hidden until picked.
// - `drive` (your own client ID): Taski sees everything in the workspace folder.
//   The scope is restricted; a client in testing mode may use it for its own test
//   users without Google's verification.

(function (Taski) {
'use strict';

const { ConflictError, NotFoundError } = Taski.storage;
const { normalize } = Taski.path;

const SCOPE_FILE = 'https://www.googleapis.com/auth/drive.file';
const SCOPE_FULL = 'https://www.googleapis.com/auth/drive';
const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
const FOLDER = 'application/vnd.google-apps.folder';

/** Load the Google Identity Services script once. */
let gisLoading = null;
function loadGis() {
  // @ts-ignore
  if (window.google?.accounts?.oauth2) return Promise.resolve();
  gisLoading ??= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client';
    s.onload = () => resolve(undefined);
    s.onerror = () => reject(new Error('Could not load Google sign-in. Check your connection.'));
    document.head.append(s);
  });
  return gisLoading;
}

/** Load the Google Picker (through Google's api.js loader) once. */
let pickerLoading = null;
function loadPicker() {
  // @ts-ignore
  if (window.google?.picker) return Promise.resolve();
  pickerLoading ??= new Promise((resolve, reject) => {
    const fail = () => {
      pickerLoading = null;
      reject(new Error('Could not load the Google Picker. Check your connection.'));
    };
    const s = document.createElement('script');
    s.src = 'https://apis.google.com/js/api.js';
    // @ts-ignore
    s.onload = () => window.gapi.load('picker', { callback: () => resolve(undefined), onerror: fail });
    s.onerror = fail;
    document.head.append(s);
  });
  return pickerLoading;
}

/**
 * Plain-language message for a failed Google sign-in popup.
 * Google shows problems such as an unregistered address (origin_mismatch)
 * inside the popup and only reports that it was closed, so say so.
 * @param {string | undefined} type
 */
function signInError(type) {
  if (type === 'popup_failed_to_open') return 'The browser blocked Google’s sign-in window. Allow pop-ups for this site and try again.';
  if (type === 'popup_closed') {
    return `Google sign-in was closed before it finished. If Google said “origin_mismatch” or “Access blocked”, this address (${location.origin}) isn’t allowed for this client ID: use your own client ID, or open Taski on an allowed address.`;
  }
  return 'Google sign-in failed. Try again.';
}

/** @param {string} s */
const q = (s) => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

/**
 * Sign in and return a Drive storage. Must run inside a user gesture the
 * first time, because Google opens a popup.
 * @param {string} clientId   OAuth client ID (Web application) from Google Cloud.
 * @param {string} rootPath   Folder path in My Drive, e.g. `taski` or `Work/taski`.
 * @param {Object} [opts]
 * @param {boolean} [opts.fullAccess]  Ask for the whole Drive (`drive`) instead of
 *   only Taski's own and picked files (`drive.file`).
 * @param {string} [opts.apiKey]  API key of the same Google Cloud project, for the
 *   Picker. Only used with `drive.file`.
 * @returns {Promise<import('./storage.js').Storage>}
 */
async function driveStorage(clientId, rootPath = 'taski', { fullAccess = false, apiKey = '' } = {}) {
  const scope = fullAccess ? SCOPE_FULL : SCOPE_FILE;
  await loadGis();
  /** @type {string} */
  let token = '';

  /** @param {string} prompt */
  function requestToken(prompt) {
    return new Promise((resolve, reject) => {
      // @ts-ignore
      const client = window.google.accounts.oauth2.initTokenClient({
        client_id: clientId,
        scope,
        callback: (/** @type {any} */ r) => {
          if (r.error) return reject(new Error(r.error_description || r.error));
          // Google lets people untick a permission on the consent screen.
          // @ts-ignore
          if (!window.google.accounts.oauth2.hasGrantedAllScopes(r, scope)) {
            return reject(new Error(fullAccess
              ? 'Google didn’t give Taski access to your Drive. Sign in again and allow it, and check that your client has the “…/auth/drive” scope under Data access.'
              : 'Google didn’t give Taski access to its Drive files. Sign in again and allow it.'));
          }
          resolve(r.access_token);
        },
        error_callback: (/** @type {any} */ e) => reject(new Error(signInError(e && e.type))),
      });
      client.requestAccessToken({ prompt });
    });
  }

  token = await requestToken('');

  /**
   * @param {string} url
   * @param {RequestInit} [init]
   */
  async function call(url, init = {}) {
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(url, { ...init, headers: { ...(init.headers || {}), Authorization: `Bearer ${token}` } });
      if (res.status === 401 && attempt === 0) {
        token = await requestToken('');
        continue;
      }
      if (!res.ok) throw new Error(`Drive error ${res.status}: ${(await res.text()).slice(0, 200)}`);
      return res;
    }
  }

  /** @type {Map<string, {id: string, kind: 'file' | 'dir'}>} */
  const ids = new Map();

  /**
   * @param {string} parentId
   * @param {string} name
   */
  async function child(parentId, name) {
    const params = new URLSearchParams({
      q: `${q(parentId)} in parents and name = ${q(name)} and trashed = false`,
      fields: 'files(id,mimeType)',
      pageSize: '10',
    });
    const data = await (await call(`${API}/files?${params}`)).json();
    const f = data.files[0];
    return f ? { id: f.id, kind: /** @type {'file'|'dir'} */ (f.mimeType === FOLDER ? 'dir' : 'file') } : null;
  }

  /** @param {string} parentId @param {string} name */
  async function createFolder(parentId, name) {
    const res = await call(`${API}/files?fields=id`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, mimeType: FOLDER, parents: [parentId] }),
    });
    return (await res.json()).id;
  }

  // Resolve (creating if needed) the workspace root folder.
  let rootId = 'root';
  for (const part of normalize(rootPath).split('/').filter(Boolean)) {
    const found = await child(rootId, part);
    rootId = found && found.kind === 'dir' ? found.id : await createFolder(rootId, part);
  }
  ids.set('', { id: rootId, kind: 'dir' });

  /**
   * Let the user pick existing files and folders for Taski to see, starting in
   * the workspace folder. Resolves with how many were picked (0 if cancelled).
   * @returns {Promise<number>}
   */
  async function grantAccess() {
    await loadPicker();
    // @ts-ignore
    const picker = window.google.picker;
    const view = new picker.DocsView(picker.ViewId.DOCS)
      .setParent(rootId)
      .setIncludeFolders(true)
      .setSelectFolderEnabled(true)
      .setMimeTypes(`text/markdown,text/x-markdown,text/plain,application/octet-stream,${FOLDER}`);
    const picked = await new Promise((resolve) => {
      const builder = new picker.PickerBuilder()
        .setTitle('Add Markdown files and folders to Taski')
        .addView(view)
        .enableFeature(picker.Feature.MULTISELECT_ENABLED)
        .setOAuthToken(token)
        // The project number, which starts the client ID. Picked files are
        // granted to this app.
        .setAppId(clientId.split('-')[0])
        .setOrigin(location.origin)
        .setCallback((/** @type {any} */ data) => {
          if (data.action === picker.Action.PICKED) resolve(data.docs.length);
          else if (data.action === picker.Action.CANCEL) resolve(0);
        });
      if (apiKey) builder.setDeveloperKey(apiKey);
      builder.build().setVisible(true);
    });
    // Folder lookups made before the grant may have come back empty.
    for (const key of [...ids.keys()]) if (key) ids.delete(key);
    return picked;
  }

  /**
   * @param {string} path
   * @param {boolean} [createDirs]  Create missing folders along the way.
   */
  async function resolve(path, createDirs = false) {
    const p = normalize(path);
    const cached = ids.get(p);
    if (cached) return cached;
    const parts = p.split('/');
    let cur = /** @type {{id: string, kind: 'file'|'dir'}} */ (ids.get(''));
    let sofar = '';
    for (const part of parts) {
      sofar = sofar ? `${sofar}/${part}` : part;
      let next = ids.get(sofar) || (await child(cur.id, part));
      if (!next) {
        if (!createDirs) throw new NotFoundError(path);
        next = { id: await createFolder(cur.id, part), kind: 'dir' };
      }
      ids.set(sofar, next);
      cur = next;
    }
    return cur;
  }

  /** @param {string} id */
  async function version(id) {
    return String((await (await call(`${API}/files/${id}?fields=version`)).json()).version);
  }

  return {
    kind: 'drive',
    label: `Google Drive: /${normalize(rootPath)}`,
    canWrite: true,
    canList: true,
    // With full access there is nothing to grant.
    grantAccess: fullAccess ? undefined : grantAccess,
    async list(path) {
      const dir = await resolve(path);
      const entries = [];
      let pageToken = '';
      do {
        const params = new URLSearchParams({
          q: `${q(dir.id)} in parents and trashed = false`,
          fields: 'nextPageToken,files(id,name,mimeType)',
          pageSize: '1000',
        });
        if (pageToken) params.set('pageToken', pageToken);
        const data = await (await call(`${API}/files?${params}`)).json();
        for (const f of data.files) {
          const p = normalize(`${path}/${f.name}`);
          const kind = f.mimeType === FOLDER ? 'dir' : 'file';
          ids.set(p, { id: f.id, kind });
          entries.push({ name: f.name, path: p, kind });
        }
        pageToken = data.nextPageToken || '';
      } while (pageToken);
      return entries.sort((a, b) => a.name.localeCompare(b.name));
    },
    async read(path) {
      const f = await resolve(path);
      if (f.kind !== 'file') throw new NotFoundError(path);
      const [res, rev] = await Promise.all([call(`${API}/files/${f.id}?alt=media`), version(f.id)]);
      return { text: await res.text(), rev };
    },
    async write(path, text, opts = {}) {
      const p = normalize(path);
      let existing = null;
      try {
        existing = await resolve(p);
      } catch (e) {
        if (!(e instanceof NotFoundError)) throw e;
      }
      if (existing) {
        if (opts.create) throw new ConflictError(path);
        // Drive has no conditional write; checking first narrows but does not close the race.
        if (opts.rev && (await version(existing.id)) !== opts.rev) throw new ConflictError(path);
        const res = await call(`${UPLOAD}/files/${existing.id}?uploadType=media&fields=version`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'text/markdown; charset=utf-8' },
          body: text,
        });
        return { rev: String((await res.json()).version) };
      }
      const i = p.lastIndexOf('/');
      const parent = await resolve(i < 0 ? '' : p.slice(0, i), true);
      const boundary = 'taski' + Math.random().toString(36).slice(2);
      const meta = JSON.stringify({ name: p.slice(i + 1), parents: [parent.id], mimeType: 'text/markdown' });
      const body = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n--${boundary}\r\nContent-Type: text/markdown; charset=UTF-8\r\n\r\n${text}\r\n--${boundary}--`;
      const res = await call(`${UPLOAD}/files?uploadType=multipart&fields=id,version`, {
        method: 'POST',
        headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
        body,
      });
      const data = await res.json();
      ids.set(p, { id: data.id, kind: 'file' });
      return { rev: String(data.version) };
    },
    async mkdir(path) {
      await resolve(path, true);
    },
  };
}

Taski.drive = { driveStorage };
})(window.Taski = window.Taski || {});
