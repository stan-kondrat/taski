// Static HTTP: read-only, discovery only through manifest links.

(function (Taski) {
'use strict';

const { NotFoundError, ReadOnlyError } = Taski.storage;
const { normalize } = Taski.path;

/**
 * @param {string} baseUrl  Folder URL of the workspace root.
 * @returns {import('./storage.js').Storage}
 */
function httpStorage(baseUrl) {
  const base = new URL(baseUrl.endsWith('/') ? baseUrl : baseUrl + '/', location.href);
  // Browsers never let a page fetch file:// URLs, even when the page itself came from disk.
  if (base.protocol !== 'http:' && base.protocol !== 'https:') {
    throw new Error('A web folder must be an http:// or https:// address. Browsers don’t let a page read files from disk by URL. Use “Folder on this computer” (Chrome, Edge), or run python3 server.py and open http://127.0.0.1:8000/taski.html.');
  }
  const url = (/** @type {string} */ path) =>
    new URL(normalize(path).split('/').map(encodeURIComponent).join('/'), base);

  return {
    kind: 'http',
    label: base.href,
    canWrite: false,
    canList: false,
    async list() {
      return [];
    },
    async read(path) {
      const res = await fetch(url(path), { cache: 'no-store' });
      if (res.status === 404) throw new NotFoundError(path);
      if (!res.ok) throw new Error(`HTTP ${res.status} reading ${path}`);
      const rev = res.headers.get('ETag') || res.headers.get('Last-Modified') || '';
      return { text: await res.text(), rev };
    },
    async write() {
      throw new ReadOnlyError();
    },
    async mkdir() {
      throw new ReadOnlyError();
    },
  };
}

Taski.http = { httpStorage };
})(window.Taski = window.Taski || {});
