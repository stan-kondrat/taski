// Tasks: loading one task entry file and editing it in place.

(function (Taski) {
'use strict';

const { checklist, getTitle, parseFrontmatter, setCheckbox, setField, sectionLinks, slugify, appendToSection } = Taski.markdown;
const { basename, dirname, join, relativeLink, resolveRelative } = Taski.path;
const { NotFoundError } = Taski.storage;

const STATUSES = ['todo', 'doing', 'blocked', 'done', 'cancelled'];
const PRIORITIES = ['high', 'normal', 'low'];

/**
 * A project's task statuses, from its README frontmatter:
 * `statuses` (in board order), `active-statuses` (work in progress) and
 * `closed-statuses` (finished). Every other status counts as open.
 * @typedef {Object} Workflow
 * @property {string[]} statuses
 * @property {Set<string>} active
 * @property {Set<string>} closed
 * @property {string} initial   Status of new tasks: the first open one.
 */

/** @param {string | undefined} value */
function splitList(value) {
  return [...new Set((value || '').split(',').map((s) => s.trim()).filter(Boolean))];
}

/**
 * @param {Map<string, string>} [fields]  Project README frontmatter.
 * @returns {Workflow}
 */
function workflowFrom(fields = new Map()) {
  const custom = splitList(fields.get('statuses'));
  const statuses = custom.length ? custom : STATUSES;
  const pick = (/** @type {string} */ key, /** @type {string[]} */ fallback) => {
    const given = splitList(fields.get(key)).filter((s) => statuses.includes(s));
    return given.length ? given : statuses.filter((s) => fallback.includes(s));
  };
  let closed = pick('closed-statuses', ['done', 'cancelled']);
  if (!closed.length && statuses.length > 1) closed = [statuses[statuses.length - 1]];
  const active = pick('active-statuses', ['doing']).filter((s) => !closed.includes(s));
  const initial = statuses.find((s) => !active.includes(s) && !closed.includes(s)) || statuses[0];
  return { statuses, active: new Set(active), closed: new Set(closed), initial };
}

const DEFAULT_WORKFLOW = workflowFrom();

/**
 * 'active', 'open' or 'closed'.
 * @param {Workflow} wf
 * @param {string} status
 */
function statusKind(wf, status) {
  return wf.closed.has(status) ? 'closed' : wf.active.has(status) ? 'active' : 'open';
}

/**
 * @typedef {Object} RelatedFile
 * @property {string} text
 * @property {string | null} path   Workspace path, or null for external links.
 * @property {string} href
 */

/**
 * @typedef {Object} Task
 * @property {string} path        Entry file, e.g. `proj/tasks/login/README.md` or `proj/tasks/fix.md`.
 * @property {string} slug        Folder or file name without `.md`.
 * @property {string} text
 * @property {string} rev
 * @property {Map<string, string>} fields
 * @property {string} title
 * @property {string} status
 * @property {string} priority
 * @property {string} due
 * @property {string[]} tags
 * @property {{done: number, total: number}} progress
 * @property {RelatedFile[]} files
 */

/**
 * @param {string} path
 * @param {string} text
 * @param {string} rev
 * @returns {Task}
 */
function parseTask(path, text, rev) {
  const fm = parseFrontmatter(text);
  const name = basename(path);
  const slug = /^readme\.md$/i.test(name) ? basename(dirname(path)) : name.replace(/\.md$/i, '');
  const items = checklist(text);
  return {
    path,
    slug,
    text,
    rev,
    fields: fm.fields,
    title: getTitle(fm.body) || slug,
    status: fm.fields.get('status') || 'todo',
    priority: fm.fields.get('priority') || 'normal',
    due: fm.fields.get('due') || '',
    tags: (fm.fields.get('tags') || '').split(',').map((t) => t.trim()).filter(Boolean),
    progress: { done: items.filter((i) => i.done).length, total: items.length },
    files: sectionLinks(text, 'Files').map((l) => ({ text: l.text, href: l.href, path: resolveRelative(path, l.href) })),
  };
}

/**
 * @param {import('./storage/storage.js').Storage} storage
 * @param {string} path
 */
async function loadTask(storage, path) {
  const { text, rev } = await storage.read(path);
  return parseTask(path, text, rev);
}

/**
 * Write new text for a task, guarded by the revision it was loaded with.
 * @param {import('./storage/storage.js').Storage} storage
 * @param {Task} task
 * @param {string} text
 */
async function saveTask(storage, task, text) {
  const { rev } = await storage.write(task.path, text, { rev: task.rev });
  return parseTask(task.path, text, rev);
}

/**
 * @param {import('./storage/storage.js').Storage} storage
 * @param {Task} task
 * @param {string} key
 * @param {string} value  Empty string removes the field.
 */
function setTaskField(storage, task, key, value) {
  return saveTask(storage, task, setField(task.text, key, value.trim() ? value.trim() : null));
}

/**
 * @param {import('./storage/storage.js').Storage} storage
 * @param {Task} task
 * @param {number} n
 * @param {boolean} done
 */
function setTaskCheck(storage, task, n, done) {
  return saveTask(storage, task, setCheckbox(task.text, n, done));
}

const PRIORITY_ORDER = new Map(PRIORITIES.map((p, i) => [p, i]));
const KIND_ORDER = { active: 0, open: 1, closed: 2 };

/**
 * Sort key of a status: active ones first, then open, then closed, each in
 * the project's order. Unknown statuses go after the known open ones.
 * @param {Workflow} wf
 * @param {string} status
 */
function statusRank(wf, status) {
  const i = wf.statuses.indexOf(status);
  return KIND_ORDER[statusKind(wf, status)] * 1000 + (i < 0 ? 999 : i);
}

/**
 * Comparator for one project's tasks.
 * @param {Workflow} [wf]
 * @returns {(a: Task, b: Task) => number}
 */
function taskComparator(wf = DEFAULT_WORKFLOW) {
  return (a, b) => compareTasks(a, b, wf);
}

/** @param {Task} a @param {Task} b @param {Workflow} [wf] */
function compareTasks(a, b, wf = DEFAULT_WORKFLOW) {
  return (
    statusRank(wf, a.status) - statusRank(wf, b.status) ||
    (PRIORITY_ORDER.get(a.priority) ?? 1) - (PRIORITY_ORDER.get(b.priority) ?? 1) ||
    (a.due || '9999').localeCompare(b.due || '9999') ||
    a.title.localeCompare(b.title)
  );
}

/** @param {Date} [d] */
function today(d = new Date()) {
  const pad = (/** @type {number} */ n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * @param {import('./storage/storage.js').Storage} storage
 * @param {string} path
 */
async function exists(storage, path) {
  try {
    await storage.read(path);
    return true;
  } catch (e) {
    if (e instanceof NotFoundError) return false;
    throw e;
  }
}

/**
 * Create a task and link it from the project README's `## Tasks` section.
 * @param {import('./storage/storage.js').Storage} storage
 * @param {import('./projects.js').Project} project
 * @param {{title: string, singleFile?: boolean}} input
 * @returns {Promise<Task>}
 */
async function createTask(storage, project, { title, singleFile = false }) {
  const status = (project.workflow || DEFAULT_WORKFLOW).initial;
  const base = slugify(title);
  let slug = base;
  const pathFor = (/** @type {string} */ s) => (singleFile ? join(project.path, 'tasks', `${s}.md`) : join(project.path, 'tasks', s, 'README.md'));
  for (let n = 2; await exists(storage, pathFor(slug)); n++) slug = `${base}-${n}`;
  const path = pathFor(slug);
  const text = ['---', 'type: task', `status: ${status}`, 'priority: normal', `created: ${today()}`, '---', '', `# ${title}`, '', ''].join('\n');
  if (!singleFile) await storage.mkdir(dirname(path));
  const { rev } = await storage.write(path, text, { create: true });

  const readme = project.readmePath;
  const link = `- [${title.replace(/[[\]]/g, '')}](${relativeLink(readme, path)})`;
  if (project.readme) {
    await storage.write(readme, appendToSection(project.readme.text, 'Tasks', link), { rev: project.readme.rev });
  } else {
    const fresh = ['---', 'type: project', 'status: active', '---', '', `# ${project.title}`, '', '## Tasks', '', link, ''].join('\n');
    await storage.write(readme, fresh, { create: true });
  }
  return parseTask(path, text, rev);
}

Taski.tasks = {
  STATUSES, PRIORITIES, DEFAULT_WORKFLOW, splitList, workflowFrom, statusKind, statusRank,
  parseTask, loadTask, saveTask, setTaskField, setTaskCheck, compareTasks, taskComparator, today, exists, createTask,
};
})(window.Taski = window.Taski || {});
