// Workspace and project discovery. Manifest links (`## Projects`, `## Tasks`)
// are always followed; adapters that can list folders add what they find.

(function (Taski) {
'use strict';

const { appendToSection, getTitle, parseFrontmatter, sectionLinks, setField, slugify } = Taski.markdown;
const { basename, dirname, join, relativeLink, resolveRelative } = Taski.path;
const { NotFoundError } = Taski.storage;
const { loadTask, milestonesFrom, splitList, taskComparator, workflowFrom } = Taski.tasks;

/**
 * @typedef {Object} FileText
 * @property {string} text
 * @property {string} rev
 */

/**
 * @typedef {Object} Project
 * @property {string} path         Project folder.
 * @property {string} readmePath   Its README (may not exist yet).
 * @property {FileText | null} readme
 * @property {string} title
 * @property {string} status
 * @property {import('./tasks.js').Workflow} workflow  Task statuses, from `statuses` and friends.
 * @property {string[]} labels    Labels from the README's `labels` field, then the ones tasks use.
 * @property {import('./tasks.js').Milestone[]} milestones  From the README's `milestones` field, then the ones tasks use.
 * @property {import('./tasks.js').RelatedFile[]} files  The README's `## Files` links.
 * @property {import('./tasks.js').Task[]} tasks
 * @property {string[]} warnings
 */

/**
 * @typedef {Object} Workspace
 * @property {FileText | null} readme   Root README.md with the `## Projects` manifest.
 * @property {string} title
 * @property {Project[]} projects
 * @property {string[]} warnings
 */

/**
 * @param {import('./storage/storage.js').Storage} storage
 * @param {string} path
 * @returns {Promise<FileText | null>}
 */
async function tryRead(storage, path) {
  try {
    return await storage.read(path);
  } catch (e) {
    if (e instanceof NotFoundError) return null;
    throw e;
  }
}

/**
 * Read `dir/README.md`, falling back to `dir/readme.md`.
 * @param {import('./storage/storage.js').Storage} storage
 * @param {string} dir
 * @param {import('./storage/storage.js').Entry[]} [listing]  Folder listing, when known.
 * @returns {Promise<{path: string, file: FileText | null}>}
 */
async function readReadme(storage, dir, listing) {
  const names = listing ? listing.filter((e) => e.kind === 'file' && /^readme\.md$/i.test(e.name)).map((e) => e.name) : ['README.md', 'readme.md'];
  for (const name of names.sort()) {
    const file = await tryRead(storage, join(dir, name));
    if (file) return { path: join(dir, name), file };
  }
  return { path: join(dir, 'README.md'), file: null };
}

/**
 * @param {import('./storage/storage.js').Storage} storage
 * @param {string} path
 */
async function tryList(storage, path) {
  if (!storage.canList) return null;
  try {
    return await storage.list(path);
  } catch (e) {
    if (e instanceof NotFoundError) return null;
    throw e;
  }
}

/**
 * Turn a manifest link into a folder: `./proj/` and `./proj/README.md` both mean `proj`.
 * @param {string} fromFile
 * @param {string} href
 */
function linkedFolder(fromFile, href) {
  const p = resolveRelative(fromFile, href);
  if (p === null) return null;
  return /\.md$/i.test(p) ? dirname(p) : p;
}

/**
 * @param {import('./storage/storage.js').Storage} storage
 * @param {string} path
 * @returns {Promise<Project>}
 */
async function loadProject(storage, path) {
  const listing = await tryList(storage, path);
  const { path: readmePath, file: readme } = await readReadme(storage, path, listing || undefined);
  const fm = readme ? parseFrontmatter(readme.text) : null;
  const warnings = [];

  /** @type {Set<string>} */
  const entries = new Set();
  if (readme) {
    for (const link of sectionLinks(readme.text, 'Tasks')) {
      const p = resolveRelative(readmePath, link.href);
      if (p === null) continue;
      entries.add(/\.md$/i.test(p) ? p : join(p, 'README.md'));
    }
  }
  const taskDir = await tryList(storage, join(path, 'tasks'));
  for (const e of taskDir || []) {
    if (e.name.startsWith('.') || e.name.startsWith('_')) continue;
    if (e.kind === 'file' && /\.md$/i.test(e.name)) entries.add(e.path);
    if (e.kind === 'dir') {
      const inner = await tryList(storage, e.path);
      const readmeName = inner?.find((f) => f.kind === 'file' && /^readme\.md$/i.test(f.name))?.name;
      if (readmeName) entries.add(join(e.path, readmeName));
    }
  }

  // The same task may be linked as README.md and found as readme.md; keep one.
  const seen = new Set();
  const unique = [...entries].filter((p) => {
    const key = p.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const loaded = await Promise.all(
    unique.map(async (p) => {
      try {
        return await loadTask(storage, p);
      } catch (e) {
        warnings.push(e instanceof NotFoundError ? `Linked task not found: ${p}` : `Could not read ${p}: ${/** @type {Error} */ (e).message}`);
        return null;
      }
    }),
  );

  const workflow = workflowFrom(fm?.fields);
  const tasks = /** @type {import('./tasks.js').Task[]} */ (loaded.filter(Boolean));
  for (const t of tasks) if (!t.fields.get('status')) t.status = workflow.initial;
  const strays = [...new Set(tasks.map((t) => t.status).filter((s) => !workflow.statuses.includes(s)))];
  if (strays.length) warnings.push(`Tasks use statuses this project does not list: ${strays.join(', ')}. Move them under Settings.`);
  const labels = [...new Set([...splitList(fm?.fields.get('labels')), ...tasks.flatMap((t) => t.tags).sort()])];
  const milestones = milestonesFrom(fm?.fields);
  for (const name of [...new Set(tasks.map((t) => t.milestone).filter(Boolean))].sort()) {
    if (!milestones.some((m) => m.name === name)) milestones.push({ name, due: '', listed: false });
  }

  return {
    path,
    readmePath,
    readme,
    title: (fm && getTitle(fm.body)) || basename(path) || 'Workspace',
    status: fm?.fields.get('status') || 'active',
    workflow,
    labels,
    milestones,
    files: readme ? sectionLinks(readme.text, 'Files').map((l) => ({ text: l.text, href: l.href, path: resolveRelative(readmePath, l.href) })) : [],
    tasks: tasks.sort(taskComparator(workflow)),
    warnings,
  };
}

/**
 * @param {import('./storage/storage.js').Storage} storage
 * @returns {Promise<Workspace>}
 */
async function loadWorkspace(storage) {
  const rootListing = await tryList(storage, '');
  const { file: readme } = await readReadme(storage, '', rootListing || undefined);
  const warnings = [];
  /** @type {Set<string>} */
  const folders = new Set();

  if (readme) {
    for (const link of sectionLinks(readme.text, 'Projects')) {
      const f = linkedFolder('README.md', link.href);
      if (f) folders.add(f);
    }
  } else if (!storage.canList) {
    warnings.push('No README.md with a “## Projects” list at the workspace root, so no projects can be found over plain HTTP.');
  }

  for (const e of rootListing || []) {
    if (e.kind !== 'dir' || e.name.startsWith('.') || e.name.startsWith('_') || folders.has(e.path)) continue;
    const inner = await tryList(storage, e.path);
    const hasTasks = inner?.some((f) => f.kind === 'dir' && f.name === 'tasks');
    let isProject = !!hasTasks;
    if (!isProject && inner?.some((f) => /^readme\.md$/i.test(f.name))) {
      const r = await readReadme(storage, e.path, inner);
      isProject = !!r.file && parseFrontmatter(r.file.text).fields.get('type') === 'project';
    }
    if (isProject) folders.add(e.path);
  }

  const projects = await Promise.all([...folders].map((f) => loadProject(storage, f)));
  for (const p of projects) {
    if (!p.readme && !p.tasks.length) warnings.push(`Linked project has no README.md or tasks: ${p.path}`);
  }
  projects.sort((a, b) => Number(a.status === 'archived') - Number(b.status === 'archived') || a.title.localeCompare(b.title));
  return {
    readme,
    title: (readme && getTitle(parseFrontmatter(readme.text).body)) || 'Taski',
    projects,
    warnings,
  };
}

/**
 * Create a project folder with a README and an empty `tasks/` folder, and
 * link it from the workspace README.
 * @param {import('./storage/storage.js').Storage} storage
 * @param {Workspace} workspace
 * @param {string} title
 */
async function createProject(storage, workspace, title) {
  const base = slugify(title);
  let slug = base;
  const taken = new Set(workspace.projects.map((p) => p.path));
  for (let n = 2; taken.has(slug) || (await tryRead(storage, join(slug, 'README.md'))); n++) slug = `${base}-${n}`;
  await storage.mkdir(join(slug, 'tasks'));
  const readmePath = join(slug, 'README.md');
  const text = ['---', 'type: project', 'status: active', '---', '', `# ${title}`, '', '## Tasks', '', ''].join('\n');
  await storage.write(readmePath, text, { create: true });

  const link = `- [${title.replace(/[[\]]/g, '')}](${relativeLink('README.md', slug)}/)`;
  if (workspace.readme) {
    await storage.write('README.md', appendToSection(workspace.readme.text, 'Projects', link), { rev: workspace.readme.rev });
  } else {
    await storage.write('README.md', ['---', 'type: workspace', '---', '', '# Taski', '', '## Projects', '', link, ''].join('\n'), { create: true });
  }
  return slug;
}

/**
 * Set fields in the project README (an empty value removes the field),
 * creating the README if the project has none yet. One write for all fields.
 * @param {import('./storage/storage.js').Storage} storage
 * @param {Project} project
 * @param {Record<string, string>} fields
 */
async function setProjectFields(storage, project, fields) {
  let text = project.readme
    ? project.readme.text
    : ['---', 'type: project', 'status: active', '---', '', `# ${project.title}`, '', '## Tasks', ''].join('\n');
  for (const [key, value] of Object.entries(fields)) text = setField(text, key, value.trim() ? value.trim() : null);
  if (project.readme && text === project.readme.text) return;
  await storage.write(project.readmePath, text, project.readme ? { rev: project.readme.rev } : { create: true });
}

Taski.projects = { loadProject, loadWorkspace, createProject, setProjectFields };
})(window.Taski = window.Taski || {});
