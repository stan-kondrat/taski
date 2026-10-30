// Workspace paths are relative, '/'-separated and never start with '/'.
// The empty string is the workspace root.

(function (Taski) {
'use strict';

/**
 * Normalize a relative path, resolving `.` and `..`. Throws if it escapes the root.
 * @param {string} path
 */
function normalize(path) {
  const out = [];
  for (const part of path.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (!out.length) throw new Error(`Path escapes workspace: ${path}`);
      out.pop();
    } else {
      out.push(part);
    }
  }
  return out.join('/');
}

/** @param {...string} parts */
function join(...parts) {
  return normalize(parts.filter(Boolean).join('/'));
}

/** @param {string} path */
function dirname(path) {
  const i = path.lastIndexOf('/');
  return i < 0 ? '' : path.slice(0, i);
}

/** @param {string} path */
function basename(path) {
  return path.slice(path.lastIndexOf('/') + 1);
}

/**
 * Resolve a link found in the file at `fromFile` to a workspace path,
 * or null when it is external or escapes the workspace.
 * @param {string} fromFile
 * @param {string} href
 */
function resolveRelative(fromFile, href) {
  if (/^[a-z][\w+.-]*:/i.test(href) || href.startsWith('#') || href.startsWith('/')) return null;
  const clean = decodeURIComponent(href.split('#')[0].split('?')[0]);
  try {
    return join(dirname(fromFile), clean);
  } catch {
    return null;
  }
}

/**
 * Relative link from the file at `fromFile` to `toPath`, starting with `./`.
 * @param {string} fromFile
 * @param {string} toPath
 */
function relativeLink(fromFile, toPath) {
  const from = dirname(fromFile).split('/').filter(Boolean);
  const to = toPath.split('/');
  let common = 0;
  while (common < from.length && common < to.length - 1 && from[common] === to[common]) common++;
  const ups = from.length - common;
  const rest = to.slice(common).map(encodeURIComponent).join('/');
  return ups ? '../'.repeat(ups) + rest : './' + rest;
}

Taski.path = { normalize, join, dirname, basename, resolveRelative, relativeLink };
})(window.Taski = window.Taski || {});
