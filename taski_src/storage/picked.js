// A folder the user picked with <input type="file" webkitdirectory>. Works in
// every browser, including pages opened from disk, but only for reading: the
// browser hands over File objects, not a way to write back. Nothing is uploaded.

(function (Taski) {
'use strict';

const { NotFoundError, ReadOnlyError } = Taski.storage;
const { normalize } = Taski.path;

const supported = typeof HTMLInputElement !== 'undefined' && 'webkitdirectory' in HTMLInputElement.prototype;

/**
 * @param {FileList | File[]} fileList  Files from the input; each has a
 *   webkitRelativePath like `my-folder/project/README.md`.
 * @returns {import('./storage.js').Storage}
 */
function pickedStorage(fileList) {
  /** @type {Map<string, File>} */
  const files = new Map();
  /** @type {Map<string, Set<string>>} folder path → names of its direct children */
  const children = new Map([['', new Set()]]);
  let rootName = '';

  for (const file of Array.from(fileList)) {
    const parts = (file.webkitRelativePath || file.name).split('/');
    rootName ||= parts.length > 1 ? parts[0] : '';
    const rel = parts.length > 1 ? parts.slice(1) : parts;
    if (rel.some((p) => p.startsWith('.'))) continue; // .git, .DS_Store, …
    const path = rel.join('/');
    files.set(path, file);
    // register every parent folder so list() can answer for it
    for (let i = 0; i < rel.length; i++) {
      const parent = rel.slice(0, i).join('/');
      if (!children.has(parent)) children.set(parent, new Set());
      /** @type {Set<string>} */ (children.get(parent)).add(rel[i]);
    }
  }

  /** @param {File} f */
  const revOf = (f) => `${f.lastModified}-${f.size}`;

  return {
    kind: 'picked',
    label: `Folder “${rootName || 'picked'}” (copy)`,
    canWrite: false,
    canList: true,
    async list(path) {
      const dir = normalize(path);
      const names = children.get(dir);
      if (!names) throw new NotFoundError(path);
      return [...names].sort().map((name) => {
        const p = dir ? `${dir}/${name}` : name;
        return { name, path: p, kind: /** @type {'file' | 'dir'} */ (files.has(p) ? 'file' : 'dir') };
      });
    },
    async read(path) {
      const file = files.get(normalize(path));
      if (!file) throw new NotFoundError(path);
      try {
        return { text: await file.text(), rev: revOf(file) };
      } catch {
        // Browsers refuse to read a picked file that changed on disk afterwards.
        throw new Error(`${path} changed on disk since the folder was picked. Choose the folder again to reload it.`);
      }
    },
    async write() {
      throw new ReadOnlyError();
    },
    async mkdir() {
      throw new ReadOnlyError();
    },
  };
}

/**
 * Show the browser's folder chooser. Must run inside a user gesture.
 * Resolves with the chosen files, or null if the user cancelled. Some browsers
 * never report a cancel, so the promise may simply stay pending; callers must
 * not lock the UI while waiting.
 * @returns {Promise<FileList | null>}
 */
function chooseFolderFiles() {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.webkitdirectory = true;
    input.setAttribute('webkitdirectory', '');
    // Keep it in the page: Safari ignores or loses detached file inputs, and a
    // detached input can be garbage-collected while the dialog is open.
    input.hidden = true;
    input.dataset.taskiPicker = '';
    // An earlier dialog that was cancelled without an event leaves its input behind.
    for (const old of document.querySelectorAll('input[data-taski-picker]')) old.remove();
    document.body.append(input);
    const done = (/** @type {FileList | null} */ files) => {
      input.remove();
      resolve(files);
    };
    input.addEventListener('change', () => done(input.files && input.files.length ? input.files : null));
    input.addEventListener('cancel', () => done(null));
    input.click();
  });
}

Taski.picked = { supported, pickedStorage, chooseFolderFiles };
})(window.Taski = window.Taski || {});
