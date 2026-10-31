// The provider interface every storage adapter implements. Adapters move raw
// text in and out; they know nothing about tasks or projects.

(function (Taski) {
'use strict';

/**
 * @typedef {Object} Entry
 * @property {string} name
 * @property {string} path   Workspace-relative path.
 * @property {'file' | 'dir'} kind
 */

/**
 * @typedef {Object} FileData
 * @property {string} text
 * @property {string} rev    Opaque revision token; '' when the adapter cannot tell.
 */

/**
 * @typedef {Object} WriteOptions
 * @property {string} [rev]     Expected current revision; the write fails if the file changed.
 * @property {boolean} [create] The file must not exist yet.
 */

/**
 * @typedef {Object} Storage
 * @property {string} kind                 'drive' | 'http' | 'filesystem' | 'python'
 * @property {string} label                Human-readable location.
 * @property {boolean} canWrite
 * @property {boolean} canList
 * @property {(path: string) => Promise<Entry[]>} list
 * @property {(path: string) => Promise<FileData>} read
 * @property {(path: string, text: string, opts?: WriteOptions) => Promise<{rev: string}>} write
 * @property {(path: string) => Promise<void>} mkdir
 * @property {() => Promise<number>} [grantAccess]  Drive only: let the user pick existing
 *   files for Taski to see; resolves with how many were picked.
 */

class NotFoundError extends Error {
  /** @param {string} path */
  constructor(path) {
    super(`Not found: ${path}`);
    this.name = 'NotFoundError';
    this.path = path;
  }
}

class ConflictError extends Error {
  /** @param {string} path */
  constructor(path) {
    super(`${path} changed since it was loaded. Refresh and try again.`);
    this.name = 'ConflictError';
    this.path = path;
  }
}

class ReadOnlyError extends Error {
  constructor() {
    super('This storage is read-only.');
    this.name = 'ReadOnlyError';
  }
}

Taski.storage = { NotFoundError, ConflictError, ReadOnlyError };
})(window.Taski = window.Taski || {});
