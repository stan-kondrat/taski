// Client for server.py, the optional local read/write adapter.

(function (Taski) {
'use strict';

const { ConflictError, NotFoundError } = Taski.storage;
const { normalize } = Taski.path;

/**
 * @param {string} [apiBase]  URL of the server's `/api/` prefix.
 * @returns {import('./storage.js').Storage}
 */
function pythonStorage(apiBase = new URL('api/', location.href).href) {
  const api = (/** @type {string} */ route, /** @type {string} */ path) =>
    `${apiBase}${route}?path=${encodeURIComponent(normalize(path))}`;

  /** @param {Response} res @param {string} path */
  async function check(res, path) {
    if (res.status === 404) throw new NotFoundError(path);
    if (res.status === 409 || res.status === 412) throw new ConflictError(path);
    if (!res.ok) throw new Error(`Server error ${res.status}: ${await res.text()}`);
    return res;
  }

  return {
    kind: 'python',
    label: `Local server (${new URL(apiBase).host})`,
    canWrite: true,
    canList: true,
    async list(path) {
      const res = await check(await fetch(api('list', path), { cache: 'no-store' }), path);
      /** @type {{entries: import('./storage.js').Entry[]}} */
      const data = await res.json();
      return data.entries;
    },
    async read(path) {
      const res = await check(await fetch(api('files', path), { cache: 'no-store' }), path);
      return { text: await res.text(), rev: res.headers.get('ETag') || '' };
    },
    async write(path, text, opts = {}) {
      /** @type {Record<string, string>} */
      const headers = { 'Content-Type': 'text/markdown; charset=utf-8', 'X-Taski': '1' };
      if (opts.create) headers['If-None-Match'] = '*';
      else if (opts.rev) headers['If-Match'] = opts.rev;
      const res = await check(await fetch(api('files', path), { method: 'PUT', headers, body: text }), path);
      return { rev: res.headers.get('ETag') || '' };
    },
    async mkdir(path) {
      await check(await fetch(api('mkdir', path), { method: 'POST', headers: { 'X-Taski': '1' } }), path);
    },
  };
}

/** Whether the page is served by server.py. */
async function detectPythonServer() {
  try {
    const res = await fetch(new URL('api/ping', location.href), { cache: 'no-store' });
    return res.ok && (await res.text()).startsWith('taski');
  } catch {
    return false;
  }
}

Taski.python = { pythonStorage, detectPythonServer };
})(window.Taski = window.Taski || {});
