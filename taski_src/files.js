// Attached documents of a task or project: the links in its `## Files`
// section, plus files found next to it where the storage can list folders.
// Attaching a file only ever adds a link line; the files stay where they are.

(function (Taski) {
'use strict';

const { appendToSection, slugify } = Taski.markdown;
const { basename, dirname, join, relativeLink, resolveRelative } = Taski.path;
const { NotFoundError } = Taski.storage;
const { exists } = Taski.tasks;

/**
 * @typedef {'markdown' | 'text' | 'image' | 'pdf' | 'link' | 'other'} FileKind
 */

/**
 * @typedef {Object} Attachment
 * @property {string} name          Link text, or the file name for unlinked files.
 * @property {string} href          Link target as written, '' for unlinked files.
 * @property {string | null} path   Workspace path, null for external links.
 * @property {boolean} linked       Listed in `## Files`.
 * @property {FileKind} kind
 */

/**
 * The file a task or project keeps its `## Files` links in, and the folder
 * whose other files belong to it (null for a single-file task).
 * @typedef {Object} Owner
 * @property {string} file
 * @property {string | null} dir
 * @property {{text: string, rev: string} | null} entry   Current text of `file`, if it exists.
 * @property {import('./tasks.js').RelatedFile[]} links
 * @property {string[]} [skip]      Folder names inside `dir` that are not attachments.
 * @property {string} [notesDir]    Where new notes go; defaults to `dir`.
 * @property {() => string} [fresh] Text for `file` when it does not exist yet.
 */

const TEXT_RE = /\.(txt|csv|tsv|json|ya?ml|toml|ini|conf|log|sh|py|js|mjs|ts|css|html?|xml|svg|c|h|cpp|go|rs|swift|sql)$/i;

/**
 * @param {string | null} path
 * @returns {FileKind}
 */
function fileKind(path) {
  if (path === null) return 'link';
  if (/\.(md|markdown)$/i.test(path)) return 'markdown';
  if (/\.(png|jpe?g|gif|webp|avif|bmp|ico)$/i.test(path)) return 'image';
  if (/\.pdf$/i.test(path)) return 'pdf';
  if (TEXT_RE.test(path) || !/\.[^/]+$/.test(basename(path))) return 'text';
  return 'other';
}

/** Whether Taski can show the file's text. @param {FileKind} kind */
const canPreview = (kind) => kind === 'markdown' || kind === 'text';

/**
 * Files in `dir` and its subfolders, skipping hidden and `_`-prefixed names.
 * @param {import('./storage/storage.js').Storage} storage
 * @param {string} dir
 * @param {Set<string>} skip   Folder names to leave out at the top level.
 * @param {number} depth
 * @returns {Promise<string[]>}
 */
async function walk(storage, dir, skip, depth) {
  let entries;
  try {
    entries = await storage.list(dir);
  } catch (e) {
    if (e instanceof NotFoundError) return [];
    throw e;
  }
  const out = [];
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (e.name.startsWith('.') || e.name.startsWith('_')) continue;
    if (e.kind === 'file') out.push(e.path);
    else if (depth > 0 && !skip.has(e.name)) out.push(...(await walk(storage, e.path, new Set(), depth - 1)));
  }
  return out;
}

/**
 * Linked files first, in `## Files` order, then the unlinked ones found on disk.
 * @param {import('./storage/storage.js').Storage} storage
 * @param {Owner} owner
 * @returns {Promise<Attachment[]>}
 */
async function listAttachments(storage, owner) {
  /** @type {Attachment[]} */
  const out = owner.links.map((l) => ({
    name: l.text || (l.path ? basename(l.path) : l.href),
    href: l.href,
    path: l.path,
    linked: true,
    kind: fileKind(l.path),
  }));
  if (owner.dir === null || !storage.canList) return out;
  const seen = new Set([owner.file, ...owner.links.map((l) => l.path)].filter(Boolean).map((p) => /** @type {string} */ (p).toLowerCase()));
  for (const path of await walk(storage, owner.dir, new Set(owner.skip || []), 2)) {
    if (seen.has(path.toLowerCase())) continue;
    out.push({ name: basename(path), href: '', path, linked: false, kind: fileKind(path) });
  }
  return out;
}

/**
 * Add `- [title](href)` to the owner's `## Files` section.
 * @param {import('./storage/storage.js').Storage} storage
 * @param {Owner} owner
 * @param {string} title
 * @param {string} href   A URL, or a path relative to the owner file.
 */
async function addLink(storage, owner, title, href) {
  const line = `- [${title.replace(/[[\]]/g, '')}](${href})`;
  if (owner.entry) {
    await storage.write(owner.file, appendToSection(owner.entry.text, 'Files', line), { rev: owner.entry.rev });
  } else {
    await storage.write(owner.file, appendToSection(owner.fresh ? owner.fresh() : '', 'Files', line), { create: true });
  }
}

/**
 * Turn what the user typed into a link target: URLs stay as they are,
 * paths are taken relative to the owner file.
 * @param {Owner} owner
 * @param {string} target
 * @returns {{href: string, path: string | null}}
 */
function linkTarget(owner, target) {
  const t = target.trim();
  if (/^[a-z][\w+.-]*:/i.test(t)) return { href: t, path: null };
  const path = resolveRelative(owner.file, t.replace(/^\/+/, ''));
  if (path === null) throw new Error(`Not a path inside the workspace: ${t}`);
  return { href: relativeLink(owner.file, path), path };
}

/**
 * Attach an existing file or a URL.
 * @param {import('./storage/storage.js').Storage} storage
 * @param {Owner} owner
 * @param {string} target   URL, or path relative to the owner file.
 * @param {string} [title]
 */
async function attach(storage, owner, target, title) {
  const { href, path } = linkTarget(owner, target);
  await addLink(storage, owner, title || (path ? basename(path) : href), href);
}

/**
 * Link a file found on disk, by its workspace path.
 * @param {import('./storage/storage.js').Storage} storage
 * @param {Owner} owner
 * @param {string} path
 * @param {string} [title]
 */
function attachPath(storage, owner, path, title) {
  return addLink(storage, owner, title || basename(path), relativeLink(owner.file, path));
}

/**
 * Create a Markdown note next to the owner and link it.
 * @param {import('./storage/storage.js').Storage} storage
 * @param {Owner} owner
 * @param {string} title
 * @returns {Promise<string>}  The note's path.
 */
async function createNote(storage, owner, title) {
  const dir = owner.notesDir ?? owner.dir ?? dirname(owner.file);
  const base = slugify(title);
  let slug = base;
  for (let n = 2; await exists(storage, join(dir, `${slug}.md`)) || /^readme$/i.test(slug); n++) slug = `${base}-${n}`;
  const path = join(dir, `${slug}.md`);
  if (dir) await storage.mkdir(dir);
  await storage.write(path, `# ${title}\n\n`, { create: true });
  await addLink(storage, owner, title, relativeLink(owner.file, path));
  return path;
}

/**
 * @param {import('./tasks.js').Task} task
 * @param {import('./projects.js').Project} [project]
 * @returns {Owner}
 */
function taskOwner(task, project) {
  const folder = /^readme\.md$/i.test(basename(task.path));
  return {
    file: task.path,
    dir: folder ? dirname(task.path) : null,
    entry: { text: task.text, rev: task.rev },
    links: task.files,
    // A single-file task has no folder of its own; `tasks/` would turn notes into tasks.
    notesDir: folder ? dirname(task.path) : join(project ? project.path : dirname(dirname(task.path)), 'files', task.slug),
  };
}

/**
 * @param {import('./projects.js').Project} project
 * @returns {Owner}
 */
function projectOwner(project) {
  return {
    file: project.readmePath,
    dir: project.path,
    entry: project.readme,
    links: project.files,
    skip: ['tasks'],
    fresh: () => ['---', 'type: project', 'status: active', '---', '', `# ${project.title}`, '', '## Tasks', ''].join('\n'),
  };
}

Taski.files = { fileKind, canPreview, listAttachments, attach, attachPath, createNote, taskOwner, projectOwner };
})(window.Taski = window.Taski || {});
