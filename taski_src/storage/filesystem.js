// Browser File System Access API: a folder on disk picked by the user.
// The handle is remembered in IndexedDB so the folder can be reopened.

(function (Taski) {
'use strict';

const { ConflictError, NotFoundError } = Taski.storage;
const { normalize } = Taski.path;

const filesystemSupported = typeof window !== 'undefined' && 'showDirectoryPicker' in window;

/**
 * @param {FileSystemDirectoryHandle} root
 * @returns {import('./storage.js').Storage}
 */
function filesystemStorage(root) {
  /**
   * @param {string} path
   * @param {boolean} [create]
   * @returns {Promise<FileSystemDirectoryHandle>}
   */
  async function dir(path, create = false) {
    let handle = root;
    for (const part of normalize(path).split('/').filter(Boolean)) {
      try {
        handle = await handle.getDirectoryHandle(part, { create });
      } catch (e) {
        if (e instanceof DOMException && (e.name === 'NotFoundError' || e.name === 'TypeMismatchError')) throw new NotFoundError(path);
        throw e;
      }
    }
    return handle;
  }

  /**
   * @param {string} path
   * @param {boolean} [create]
   */
  async function file(path, create = false) {
    const p = normalize(path);
    const i = p.lastIndexOf('/');
    const parent = await dir(i < 0 ? '' : p.slice(0, i), create);
    try {
      return await parent.getFileHandle(p.slice(i + 1), { create });
    } catch (e) {
      if (e instanceof DOMException && (e.name === 'NotFoundError' || e.name === 'TypeMismatchError')) throw new NotFoundError(path);
      throw e;
    }
  }

  /** @param {File} f */
  const revOf = (f) => `${f.lastModified}-${f.size}`;

  return {
    kind: 'filesystem',
    label: `Folder “${root.name}”`,
    canWrite: true,
    canList: true,
    async list(path) {
      const d = await dir(path);
      const entries = [];
      // @ts-ignore entries() is not in every lib.dom version
      for await (const [name, handle] of d.entries()) {
        if (name.startsWith('.')) continue;
        entries.push({ name, path: normalize(`${path}/${name}`), kind: handle.kind === 'directory' ? 'dir' : 'file' });
      }
      return entries.sort((a, b) => a.name.localeCompare(b.name));
    },
    async read(path) {
      const f = await (await file(path)).getFile();
      return { text: await f.text(), rev: revOf(f) };
    },
    async write(path, text, opts = {}) {
      let handle;
      try {
        handle = await file(path);
        if (opts.create) throw new ConflictError(path);
        if (opts.rev && revOf(await handle.getFile()) !== opts.rev) throw new ConflictError(path);
      } catch (e) {
        if (!(e instanceof NotFoundError)) throw e;
        handle = await file(path, true);
      }
      const w = await handle.createWritable();
      await w.write(text);
      await w.close();
      return { rev: revOf(await handle.getFile()) };
    },
    async mkdir(path) {
      await dir(path, true);
    },
  };
}

const DB = 'taski';
const STORE = 'handles';

/** @returns {Promise<IDBDatabase>} */
function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** @param {FileSystemDirectoryHandle} handle */
async function rememberFolder(handle) {
  try {
    const db = await openDb();
    db.transaction(STORE, 'readwrite').objectStore(STORE).put(handle, 'root');
  } catch {
    // remembering is a convenience only
  }
}

/**
 * The folder picked last time, or null. Gives up after `timeoutMs`: IndexedDB
 * can stall (some private modes, headless test runs), and the start screen
 * must not wait on it.
 * @param {number} [timeoutMs]
 * @returns {Promise<FileSystemDirectoryHandle | null>}
 */
function rememberedFolder(timeoutMs = 1000) {
  const lookup = (async () => {
    try {
      const db = await openDb();
      return await new Promise((resolve) => {
        const req = db.transaction(STORE).objectStore(STORE).get('root');
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => resolve(null);
      });
    } catch {
      return null;
    }
  })();
  const giveUp = new Promise((resolve) => setTimeout(() => resolve(null), timeoutMs));
  return /** @type {Promise<FileSystemDirectoryHandle | null>} */ (Promise.race([lookup, giveUp]));
}

/**
 * Ask for read/write permission on a folder. Must run inside a user gesture.
 * @param {FileSystemDirectoryHandle} handle
 */
async function ensurePermission(handle) {
  const opts = /** @type {any} */ ({ mode: 'readwrite' });
  // @ts-ignore permission methods are Chromium-only
  if ((await handle.queryPermission(opts)) === 'granted') return true;
  // @ts-ignore
  return (await handle.requestPermission(opts)) === 'granted';
}

/**
 * Whether read/write permission is already granted, so the folder can be
 * opened without a click (Chromium may keep it between visits).
 * @param {FileSystemDirectoryHandle} handle
 */
async function hasPermission(handle) {
  try {
    // @ts-ignore permission methods are Chromium-only
    return (await handle.queryPermission({ mode: 'readwrite' })) === 'granted';
  } catch {
    return false;
  }
}

/** Show the folder picker. Must run inside a user gesture. */
async function pickFolder() {
  // @ts-ignore showDirectoryPicker is Chromium-only
  const handle = /** @type {FileSystemDirectoryHandle} */ (await window.showDirectoryPicker({ id: 'taski', mode: 'readwrite' }));
  await rememberFolder(handle);
  return handle;
}

Taski.filesystem = { filesystemSupported, filesystemStorage, rememberFolder, rememberedFolder, ensurePermission, hasPermission, pickFolder };
})(window.Taski = window.Taski || {});
