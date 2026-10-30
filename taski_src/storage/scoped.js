// A subfolder of another storage, used as the workspace root. Lets `?path=`
// open e.g. `work/tasks` inside a picked folder or the server's root.

(function (Taski) {
'use strict';

const { join, normalize } = Taski.path;

/**
 * @param {import('./storage.js').Storage} inner
 * @param {string} folder   Path inside `inner`; '' returns `inner` unchanged.
 * @returns {import('./storage.js').Storage}
 */
function scopedStorage(inner, folder) {
  const base = normalize(folder);
  if (!base) return inner;
  const full = (/** @type {string} */ path) => join(base, path);

  return {
    ...inner,
    label: `${inner.label} › ${base}`,
    async list(path) {
      const entries = await inner.list(full(path));
      return entries.map((e) => ({ ...e, path: e.path.slice(base.length + 1) }));
    },
    read: (path) => inner.read(full(path)),
    write: (path, text, opts) => inner.write(full(path), text, opts),
    mkdir: (path) => inner.mkdir(full(path)),
  };
}

Taski.scoped = { scopedStorage };
})(window.Taski = window.Taski || {});
