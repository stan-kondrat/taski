// Google Drive: OAuth through Google Identity Services, files through the
// Drive v3 REST API. Workspace paths map to file IDs by walking folder names
// from a root folder (default `taski` in My Drive).

(function (Taski) {
'use strict';

const { ConflictError, NotFoundError } = Taski.storage;
const { normalize } = Taski.path;

// Full Drive scope so Taski can see Markdown files created by you or agents,
// not only files it created itself (which is all `drive.file` allows).
const SCOPE = 'https://www.googleapis.com/auth/drive';
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

/** @param {string} s */
const q = (s) => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

/**
 * Sign in and return a Drive storage. Must run inside a user gesture the
 * first time, because Google opens a popup.
 * @param {string} clientId   OAuth client ID (Web application) from Google Cloud.
 * @param {string} rootPath   Folder path in My Drive, e.g. `taski` or `Work/taski`.
 * @returns {Promise<import('./storage.js').Storage>}
 */
async function driveStorage(clientId, rootPath = 'taski') {
  await loadGis();
  /** @type {string} */
  let token = '';

  /** @param {string} prompt */
  function requestToken(prompt) {
    return new Promise((resolve, reject) => {
      // @ts-ignore
      const client = window.google.accounts.oauth2.initTokenClient({
        client_id: clientId,
        scope: SCOPE,
        callback: (/** @type {any} */ r) => (r.error ? reject(new Error(r.error_description || r.error)) : resolve(r.access_token)),
        error_callback: (/** @type {any} */ e) => reject(new Error(e.message || e.type || 'Sign-in cancelled')),
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
