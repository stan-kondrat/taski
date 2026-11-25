// Tasks: loading one task entry file and editing it in place.

(function (Taski) {
'use strict';

const { checklist, getTitle, parseFrontmatter, setCheckbox, setField, sectionLinks, slugify, appendToSection } = Taski.markdown;
const { basename, dirname, join, relativeLink, resolveRelative } = Taski.path;
const { NotFoundError } = Taski.storage;

const STATUSES = ['todo', 'doing', 'blocked', 'done', 'cancelled'];
/** Priorities of a project that lists none, highest first. */
const DEFAULT_PRIORITIES = ['high', 'normal', 'low'];
/** The "Linear-style" preset offered in a project's Settings. */
const LINEAR_PRIORITIES = ['urgent', 'high', 'medium', 'low'];

/**
 * A project's task statuses, from its README frontmatter:
 * `statuses` (in board order), `active-statuses` (work in progress) and
 * `closed-statuses` (finished). Every other status counts as open.
 * @typedef {Object} Workflow
 * @property {string[]} statuses
 * @property {Set<string>} active
 * @property {Set<string>} closed
 * @property {string} initial   Status of new tasks: the first open one.
 * @property {string[]} priorities  The project's `priorities`, highest first; a task may also have none.
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
  const priorities = splitList(fields.get('priorities'));
  return { statuses, active: new Set(active), closed: new Set(closed), initial, priorities: priorities.length ? priorities : DEFAULT_PRIORITIES };
}

const DEFAULT_WORKFLOW = workflowFrom();

/**
 * Rank of a priority: 0 for none, 1 for the highest, up to the list length. A value the
 * list does not have ranks after all listed ones, but before none.
 * @param {Workflow} wf
 * @param {string} priority
 */
function priorityRank(wf, priority) {
  if (!priority) return 0;
  const i = wf.priorities.indexOf(priority);
  return i < 0 ? wf.priorities.length + 1 : i + 1;
}

/**
 * Sort key of a priority, highest first: the ranked ones in order, then unlisted values, then none.
 * @param {Workflow} wf
 * @param {string} priority
 */
function priorityOrder(wf, priority) {
  const rank = priorityRank(wf, priority);
  return rank === 0 ? wf.priorities.length + 2 : rank;
}

/**
 * A project milestone: a name tasks refer to in their `milestone` field.
 * @typedef {Object} Milestone
 * @property {string} name
 * @property {string} due     `YYYY-MM-DD`, or empty.
 * @property {boolean} listed  In the project README's `milestones`, not only used by tasks.
 */

/**
 * Milestones from the project README's `milestones` field, in order. Each item
 * is a name, optionally followed by a due date in brackets: `MVP (2026-11-30), 1.0`.
 * @param {Map<string, string>} [fields]  Project README frontmatter.
 * @returns {Milestone[]}
 */
function milestonesFrom(fields = new Map()) {
  /** @type {Map<string, Milestone>} */
  const out = new Map();
  for (const item of splitList(fields.get('milestones'))) {
    const m = /^(.*?)\s*\((\d{4}-\d{2}-\d{2})\)$/.exec(item);
    const name = m ? m[1] : item;
    if (name && !out.has(name)) out.set(name, { name, due: m ? m[2] : '', listed: true });
  }
  return [...out.values()];
}

/**
 * The `milestones` field value for a list of milestones.
 * @param {{name: string, due?: string}[]} milestones
 */
function formatMilestones(milestones) {
  return milestones.map((m) => (m.due ? `${m.name} (${m.due})` : m.name)).join(', ');
}

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
 * @property {number} updated     When the file last changed, ms since the epoch; 0 when unknown.
 * @property {Map<string, string>} fields
 * @property {string} title
 * @property {string} status
 * @property {string} priority
 * @property {string} due
 * @property {string} milestone   Name of the project milestone, or empty.
 * @property {string[]} tags
 * @property {{done: number, total: number}} progress
 * @property {RelatedFile[]} files
 * @property {string[]} blockedBy   Tasks named in this task's own `blocked-by` field, as written.
 * @property {string[]} blocks      Tasks named in its `blocks` field.
 * @property {string[]} related     Tasks named in its `related` field.
 * @property {Relations} relations  Both directions, resolved by `linkRelations` once the workspace is loaded.
 */

/**
 * A task as seen from another task's relations.
 * @typedef {Object} TaskRef
 * @property {string} path     Entry file of the task.
 * @property {string} slug
 * @property {string} title
 * @property {string} status
 * @property {string} project  Path of the task's project.
 * @property {boolean} closed  In a closed status of its own project.
 * @property {boolean} here    Written in this task's own fields, not only in the other task's.
 */

/**
 * @typedef {Object} Relations
 * @property {TaskRef[]} blockedBy
 * @property {TaskRef[]} blocks
 * @property {TaskRef[]} related
 * @property {string[]} missing  Names in the task's own fields that match no task.
 */

/**
 * @param {string} path
 * @param {string} text
 * @param {string} rev
 * @param {number} [updated]
 * @returns {Task}
 */
function parseTask(path, text, rev, updated = 0) {
  const fm = parseFrontmatter(text);
  const name = basename(path);
  const slug = /^readme\.md$/i.test(name) ? basename(dirname(path)) : name.replace(/\.md$/i, '');
  const items = checklist(text);
  return {
    path,
    slug,
    text,
    rev,
    updated,
    fields: fm.fields,
    title: getTitle(fm.body) || slug,
    status: fm.fields.get('status') || 'todo',
    priority: fm.fields.get('priority') || '',
    due: fm.fields.get('due') || '',
    milestone: fm.fields.get('milestone') || '',
    tags: (fm.fields.get('tags') || '').split(',').map((t) => t.trim()).filter(Boolean),
    progress: { done: items.filter((i) => i.done).length, total: items.length },
    blockedBy: splitList(fm.fields.get('blocked-by')),
    blocks: splitList(fm.fields.get('blocks')),
    related: splitList(fm.fields.get('related')),
    relations: { blockedBy: [], blocks: [], related: [], missing: [] },
    files: sectionLinks(text, 'Files').map((l) => ({ text: l.text, href: l.href, path: resolveRelative(path, l.href) })),
  };
}

/**
 * @param {import('./storage/storage.js').Storage} storage
 * @param {string} path
 */
async function loadTask(storage, path) {
  const { text, rev, updated } = await storage.read(path);
  return parseTask(path, text, rev, updated || 0);
}

/** Frontmatter field of each relation. */
const RELATION_FIELDS = { blockedBy: 'blocked-by', blocks: 'blocks', related: 'related' };
const RELATION_INVERSE = { blockedBy: 'blocks', blocks: 'blockedBy', related: 'related' };

/**
 * Resolve the `blocked-by`, `blocks` and `related` fields of every task into
 * `task.relations`. A name is a task's folder or file name in the same project,
 * or `project/name` for a task in another one. Either task may record a
 * relation: it shows on both, so `A: blocks: B` equals `B: blocked-by: A`.
 * @param {{path: string, workflow: Workflow, tasks: Task[]}[]} projects
 */
function linkRelations(projects) {
  /** @type {Map<string, {task: Task, project: (typeof projects)[number]}>} */
  const index = new Map();
  for (const project of projects) {
    for (const task of project.tasks) {
      task.relations = { blockedBy: [], blocks: [], related: [], missing: [] };
      index.set(join(project.path, task.slug), { task, project });
    }
  }
  const refTo = (/** @type {{task: Task, project: (typeof projects)[number]}} */ { task, project }, /** @type {boolean} */ here) => ({
    path: task.path, slug: task.slug, title: task.title, status: task.status, project: project.path,
    closed: statusKind(project.workflow, task.status) === 'closed', here,
  });
  const add = (/** @type {Task} */ task, /** @type {'blockedBy' | 'blocks' | 'related'} */ kind, /** @type {TaskRef} */ ref) => {
    const found = task.relations[kind].find((r) => r.path === ref.path);
    if (found) found.here = found.here || ref.here;
    else task.relations[kind].push(ref);
  };
  for (const project of projects) {
    for (const task of project.tasks) {
      for (const kind of /** @type {('blockedBy' | 'blocks' | 'related')[]} */ (Object.keys(RELATION_FIELDS))) {
        for (const name of task[kind]) {
          const target = index.get(name.includes('/') ? join(name) : join(project.path, name));
          if (!target) task.relations.missing.push(name);
          else if (target.task !== task) {
            add(task, kind, refTo(target, true));
            add(target.task, RELATION_INVERSE[kind], refTo({ task, project }, false));
          }
        }
      }
    }
  }
}

/** Whether a task has an unfinished blocker. @param {Task} task */
function isBlocked(task) {
  return task.relations.blockedBy.some((r) => !r.closed);
}

/**
 * Write new text for a task, guarded by the revision it was loaded with.
 * @param {import('./storage/storage.js').Storage} storage
 * @param {Task} task
 * @param {string} text
 */
async function saveTask(storage, task, text) {
  const { rev } = await storage.write(task.path, text, { rev: task.rev });
  return parseTask(task.path, text, rev, Date.now());
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
    priorityOrder(wf, a.priority) - priorityOrder(wf, b.priority) ||
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
 * @param {{title: string, singleFile?: boolean, status?: string, priority?: string, due?: string, estimate?: string, milestone?: string, tags?: string[], description?: string}} input
 * @returns {Promise<Task>}
 */
async function createTask(storage, project, { title, singleFile = false, status = '', priority = undefined, due = '', estimate = '', milestone = '', tags = [], description = '' }) {
  status = status || (project.workflow || DEFAULT_WORKFLOW).initial;
  const base = slugify(title);
  let slug = base;
  const pathFor = (/** @type {string} */ s) => (singleFile ? join(project.path, 'tasks', `${s}.md`) : join(project.path, 'tasks', s, 'README.md'));
  for (let n = 2; await exists(storage, pathFor(slug)); n++) slug = `${base}-${n}`;
  const path = pathFor(slug);
  // Without a choice, new tasks start as "normal" when the project lists it, else with no priority.
  const wf = project.workflow || DEFAULT_WORKFLOW;
  if (priority === undefined) priority = wf.priorities.includes('normal') ? 'normal' : '';
  const front = ['type: task', `status: ${status}`];
  if (priority) front.push(`priority: ${priority}`);
  if (due) front.push(`due: ${due}`);
  front.push(`created: ${today()}`);
  if (estimate) front.push(`estimate: ${estimate}`);
  if (tags.length) front.push(`tags: ${tags.join(', ')}`);
  if (milestone) front.push(`milestone: ${milestone}`);
  const text = ['---', ...front, '---', '', `# ${title}`, '', ...(description.trim() ? [description.trim(), ''] : []), ''].join('\n');
  // Always: a single-file task still needs tasks/, which a new project lacks.
  await storage.mkdir(dirname(path));
  const { rev } = await storage.write(path, text, { create: true });

  const readme = project.readmePath;
  const link = `- [${title.replace(/[[\]]/g, '')}](${relativeLink(readme, path)})`;
  if (project.readme) {
    await storage.write(readme, appendToSection(project.readme.text, 'Tasks', link), { rev: project.readme.rev });
  } else {
    const fresh = ['---', 'type: project', 'status: active', '---', '', `# ${project.title}`, '', '## Tasks', '', link, ''].join('\n');
    await storage.write(readme, fresh, { create: true });
  }
  return parseTask(path, text, rev, Date.now());
}

Taski.tasks = {
  STATUSES, DEFAULT_PRIORITIES, LINEAR_PRIORITIES, priorityRank, DEFAULT_WORKFLOW, splitList, workflowFrom, milestonesFrom, formatMilestones, statusKind, statusRank,
  RELATION_FIELDS, linkRelations, isBlocked, parseTask, loadTask, saveTask, setTaskField, setTaskCheck, compareTasks, taskComparator, today, exists, createTask,
};
})(window.Taski = window.Taski || {});
