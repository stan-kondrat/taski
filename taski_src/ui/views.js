// Screens: overview, project, task and plain file. Each returns a DOM node and
// talks back to the app only through the `ctx` callbacks.

(function (Taski) {
'use strict';

const { h, select, toggleFold } = Taski.dom;
const { parseFrontmatter, renderMarkdown, withoutSection } = Taski.markdown;
const { basename, dirname, join, resolveRelative } = Taski.path;
const { DEFAULT_WORKFLOW, PRIORITIES, RELATION_FIELDS, formatMilestones, isBlocked, milestonesFrom, splitList, statusKind, today } = Taski.tasks;
const { canPreview, fileKind, listAttachments, projectOwner, taskOwner } = Taski.files;

/**
 * @typedef {Object} ListUi   Remembered per project while the page is open.
 * @property {string} filter   'open' | 'closed' | 'all'
 * @property {string} query
 * @property {string[]} labels Show tasks with any of these labels.
 * @property {string} [sort]   One of SORTS; 'default' keeps the workflow order.
 * @property {string[]} [statuses]  Show tasks with any of these statuses; all when empty.
 * @property {string} milestone  Show only this milestone's tasks: '' for all, NO_MILESTONE for tasks without one.
 * @property {string} layout   'list' | 'board' | 'graph'
 * @property {string} [tab]    'tasks' | 'files' | 'about' | 'settings'; set from the URL.
 */

/**
 * @typedef {Object} ViewContext
 * @property {import('../storage/storage.js').Storage} storage
 * @property {import('../projects.js').Workspace} workspace
 * @property {(task: import('../tasks.js').Task, text: string) => Promise<void>} saveTaskText
 * @property {(project: import('../projects.js').Project, title: string, singleFile: boolean, extra?: Partial<import('../tasks.js').Task> & {description?: string}) => Promise<void>} createTask
 * @property {(title: string) => Promise<void>} createProject
 * @property {(project: import('../projects.js').Project, fields: Record<string, string>) => Promise<void>} setProjectFields
 * @property {(path: string, text: string, rev: string) => Promise<void>} saveFile
 * @property {(task: import('../tasks.js').Task, key: string, value: string) => Promise<void>} setField
 * @property {(task: import('../tasks.js').Task, n: number, done: boolean) => Promise<void>} setCheck
 * @property {(owner: import('../files.js').Owner, target: string, title: string) => Promise<void>} attach
 * @property {(owner: import('../files.js').Owner, path: string) => Promise<void>} attachPath
 * @property {(owner: import('../files.js').Owner, title: string) => Promise<void>} createNote
 * @property {(project: import('../projects.js').Project, label: string) => void} showLabel
 * @property {(project: import('../projects.js').Project, milestone: string) => void} showMilestone
 * @property {(project: import('../projects.js').Project, from: string, to: string) => Promise<void>} moveStatus
 */

/** Sort choices for the task list: key → label. Created / Updated, newest or oldest first. */
const SORTS = {
  default: 'Default order',
  'created-desc': 'Created, newest first',
  'created-asc': 'Created, oldest first',
  'updated-desc': 'Updated, newest first',
  'updated-asc': 'Updated, oldest first',
};
const SORT_KEY = 'taski.sort';

/** When a task was created (ms since the epoch, from `created:`); 0 when it has none. @param {import('../tasks.js').Task} t */
function createdAt(t) {
  const ms = Date.parse(t.fields.get('created') || '');
  return Number.isNaN(ms) ? 0 : ms;
}

/**
 * Stable sort by creation or update time. Tasks without the time go last, whichever direction.
 * Ties keep the order they came in.
 * @param {import('../tasks.js').Task[]} tasks
 * @param {string} sort
 */
function sortTasks(tasks, sort) {
  const [by, dir] = sort.split('-');
  if (by !== 'created' && by !== 'updated') return tasks;
  const time = (/** @type {import('../tasks.js').Task} */ t) => (by === 'created' ? createdAt(t) : t.updated || 0);
  const sign = dir === 'asc' ? 1 : -1;
  return tasks.map((t, i) => ({ t, i, v: time(t) })).sort((a, b) =>
    (!a.v - !b.v) || (a.v - b.v) * sign || a.i - b.i).map((x) => x.t);
}

/** The date shown on a row while a Created / Updated sort is active. @param {import('../tasks.js').Task} t @param {string} sort */
function stampFor(t, sort) {
  const by = sort.split('-')[0];
  if (by === 'created') return t.fields.get('created') ? `created ${t.fields.get('created')}` : 'no created date';
  if (by === 'updated') return t.updated ? `updated ${new Date(t.updated).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}` : 'updated unknown';
  return '';
}

/** `ListUi.milestone` value for tasks without a milestone; no name can be empty. */
const NO_MILESTONE = ' ';

/** @param {string} path */
const encodePath = (path) => path.split('/').map(encodeURIComponent).join('/');
/** @param {string} path */
const taskHref = (path) => `#/t/${encodePath(path)}`;
/** @param {string} path */
/** @param {string} path @param {string} [tab]  'files' or 'settings'; the task list when left out. */
const projectHref = (path, tab) => `#/p/${encodePath(path)}${tab && tab !== 'tasks' ? `?tab=${tab}` : ''}`;
/** @param {string} path */
const fileHref = (path) => `#/f/${encodePath(path)}`;

/** @param {import('../projects.js').Workspace} ws */
function allTasks(ws) {
  return ws.projects.flatMap((p) => p.tasks.map((t) => ({ task: t, project: p })));
}

/**
 * Link target for a Markdown link inside `fromFile`.
 * @param {import('../projects.js').Workspace} ws
 * @param {string} fromFile
 */
function linkResolver(ws, fromFile) {
  const tasks = new Set(allTasks(ws).map((x) => x.task.path));
  const projects = new Set(ws.projects.map((p) => p.path));
  return (/** @type {string} */ href) => {
    const p = resolveRelative(fromFile, href);
    if (p === null) return href;
    if (tasks.has(p)) return taskHref(p);
    const folder = p.replace(/\/(readme\.md)?$/i, '');
    if (projects.has(folder)) return projectHref(folder);
    if (tasks.has(`${folder}/README.md`)) return taskHref(`${folder}/README.md`);
    return fileHref(p);
  };
}

/** Body without frontmatter and without the first `# Title` line (shown separately). */
function bodyWithoutTitle(/** @type {string} */ text) {
  const body = parseFrontmatter(text).body;
  return body.replace(/^\s*#\s+.*(\r?\n|$)/, '');
}

/** @param {import('../projects.js').Project | undefined} project */
const workflowOf = (project) => project?.workflow || DEFAULT_WORKFLOW;

/**
 * @param {import('../tasks.js').Task} t
 * @param {import('../projects.js').Project} [project]
 */
function isOpen(t, project) {
  return statusKind(workflowOf(project), t.status) !== 'closed';
}

/**
 * Colour classes for a status: its kind (active, open, closed) and, for the
 * built-in names, the status itself.
 * @param {import('../tasks.js').Workflow} wf
 * @param {string} status
 */
function statusClass(wf, status) {
  return `status k-${statusKind(wf, status)} s-${status.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
}

/**
 * @param {ViewContext} ctx
 * @param {import('../tasks.js').Task} t
 * @param {import('../projects.js').Project} [project]
 * @param {Record<string, any>} [attrs]
 */
function statusSelect(ctx, t, project, attrs = {}) {
  const wf = workflowOf(project);
  return select(t.status, wf.statuses, {
    class: statusClass(wf, t.status),
    disabled: !ctx.storage.canWrite,
    'aria-label': 'Status',
    onchange: (/** @type {Event} */ e) => ctx.setField(t, 'status', /** @type {HTMLSelectElement} */ (e.target).value),
    ...attrs,
  });
}

/** Stable colour for a label name. @param {string} name */
function labelHue(name) {
  let n = 0;
  for (const c of name.toLowerCase()) n = (n * 31 + c.codePointAt(0)) % 360;
  return n;
}

/**
 * @param {string} name
 * @param {{on?: boolean, onclick?: (e: Event) => void, remove?: () => void, title?: string}} [opts]
 */
function labelChip(name, opts = {}) {
  const style = `--hue:${labelHue(name)}`;
  const cls = `span.label${opts.on ? '.on' : ''}`;
  if (opts.remove) {
    return h(cls, { style }, name,
      h('button.x', { type: 'button', title: `Remove ${name}`, 'aria-label': `Remove label ${name}`, onclick: opts.remove }, '×'));
  }
  return opts.onclick
    ? h(`button.label${opts.on ? '.on' : ''}`, { type: 'button', style, onclick: opts.onclick, title: opts.title, 'aria-pressed': opts.on ? 'true' : 'false' }, name)
    : h(cls, { style }, name);
}

/**
 * @param {import('../tasks.js').Task} t
 * @param {import('../projects.js').Project} [project]
 */
function dueBadge(t, project) {
  return dateBadge(t.due, isOpen(t, project));
}

/**
 * A due date, marked overdue or due today while the work is still open.
 * @param {string} date
 * @param {boolean} open
 * @param {string} [title]
 */
function dateBadge(date, open, title = 'Due date') {
  if (!date) return null;
  const now = today();
  const cls = open && date < now ? 'due.overdue' : open && date === now ? 'due.today' : 'due';
  return h(`span.${cls}`, { title }, date);
}

/**
 * How many of a milestone's tasks are closed, in the shape `progress()` takes.
 * @param {import('../projects.js').Project} project
 * @param {string} name
 */
function milestoneProgress(project, name) {
  const tasks = project.tasks.filter((t) => t.milestone === name);
  return { done: tasks.filter((t) => !isOpen(t, project)).length, total: tasks.length };
}

/** A milestone with no tasks, or with open ones, is not reached yet. @param {{done: number, total: number}} p */
const unfinished = (p) => !p.total || p.done < p.total;

/**
 * Milestone of a task; clicking it filters the project by it.
 * @param {ViewContext} ctx
 * @param {import('../tasks.js').Task} t
 * @param {import('../projects.js').Project} [project]
 */
function milestoneChip(ctx, t, project) {
  if (!t.milestone) return null;
  return project
    ? h('button.milestone', { type: 'button', title: `Show tasks of milestone ${t.milestone}`, onclick: () => ctx.showMilestone(project, t.milestone) }, t.milestone)
    : h('span.milestone', { title: 'Milestone' }, t.milestone);
}

/**
 * "Blocked by 2" while a task has unfinished blockers, "Blocks 1" while it holds
 * up unfinished tasks. Nothing for a finished task.
 * @param {import('../tasks.js').Task} t
 * @param {import('../projects.js').Project} [project]
 */
function relationChips(t, project) {
  if (!isOpen(t, project)) return null;
  const by = t.relations.blockedBy.filter((r) => !r.closed);
  const of = t.relations.blocks.filter((r) => !r.closed);
  return [
    by.length ? h('span.rel.blocked', { title: `Blocked by ${by.map((r) => r.title).join(', ')}` }, `⛔ blocked by ${by.length}`) : null,
    of.length ? h('span.rel.blocking', { title: `Blocking ${of.map((r) => r.title).join(', ')}` }, `⏳ blocks ${of.length}`) : null,
  ];
}

/** @param {{done: number, total: number}} p */
function progress(p) {
  if (!p.total) return null;
  return h('span.progress', { title: `${p.done} of ${p.total} checklist items done` },
    h('span.bar', null, h('span', { style: `width:${Math.round((p.done / p.total) * 100)}%` })),
    `${p.done}/${p.total}`);
}

/**
 * Labels of a task; clicking one filters the project by it.
 * @param {ViewContext} ctx
 * @param {import('../tasks.js').Task} t
 * @param {import('../projects.js').Project} [project]
 */
function taskLabels(ctx, t, project) {
  return t.tags.map((tag) => project
    ? labelChip(tag, { onclick: () => ctx.showLabel(project, tag), title: `Show tasks labelled ${tag}` })
    : labelChip(tag));
}

/**
 * One row in a task list.
 * @param {ViewContext} ctx
 * @param {import('../tasks.js').Task} t
 * @param {import('../projects.js').Project} [project]
 * @param {boolean} [showProject]  Name the project, for lists across projects.
 */
function taskRow(ctx, t, project, showProject = false, stamp = '') {
  return h(`li.task-row.p-${t.priority}${isOpen(t, project) ? '' : '.closed'}`, null,
    // Read-only: change a status on the task page.
    h(`span.${statusClass(workflowOf(project), t.status).replace(/ /g, '.')}.status-pill`, { title: 'Status: change it on the task page' }, t.status),
    h('a.title', { href: taskHref(t.path) }, t.title),
    t.priority !== 'normal' ? h(`span.prio.p-${t.priority}`, { title: 'Priority' }, t.priority) : null,
    showProject && project ? h('a.proj', { href: projectHref(project.path) }, project.title) : null,
    milestoneChip(ctx, t, project),
    relationChips(t, project),
    taskLabels(ctx, t, project),
    t.files.length ? h('span.attach', { title: `${t.files.length} attached file${t.files.length > 1 ? 's' : ''}` }, `📎 ${t.files.length}`) : null,
    progress(t.progress),
    stamp ? h('span.stamp.muted.small', { title: stamp }, stamp) : null,
    dueBadge(t, project));
}

/** @param {string[]} warnings */
function warningBox(warnings) {
  if (!warnings.length) return null;
  return h('details.warnings', null, h('summary', null, `${warnings.length} warning${warnings.length > 1 ? 's' : ''}`),
    h('ul', null, warnings.map((w) => h('li', null, w))));
}

/**
 * Inline "title + button" form.
 * @param {string} placeholder
 * @param {string} button
 * @param {(value: string, form: HTMLFormElement) => Promise<void>} onSubmit
 * @param {...import('./dom.js').Child} extra
 */
function quickForm(placeholder, button, onSubmit, ...extra) {
  const input = /** @type {HTMLInputElement} */ (h('input', { type: 'text', placeholder, required: true, 'aria-label': placeholder }));
  const form = /** @type {HTMLFormElement} */ (h('form.quick', {
    onsubmit: async (/** @type {Event} */ e) => {
      e.preventDefault();
      const v = input.value.trim();
      if (!v) return;
      form.classList.add('busy');
      try {
        await onSubmit(v, form);
        input.value = '';
      } finally {
        form.classList.remove('busy');
      }
    },
  }, input, extra, h('button', { type: 'submit' }, button)));
  return form;
}

/** @param {ViewContext} ctx */
function overviewView(ctx) {
  const ws = ctx.workspace;
  const items = allTasks(ws).filter((x) => x.project.status !== 'archived' && isOpen(x.task, x.project));
  const now = today();
  const soonStr = today(new Date(Date.now() + 7 * 864e5));
  const live = ws.projects.filter((p) => p.status !== 'archived');
  const archived = ws.projects.filter((p) => p.status === 'archived');
  const focus = items.filter((x) =>
    statusKind(x.project.workflow, x.task.status) === 'active' || (x.task.due && x.task.due <= soonStr) || x.task.priority === 'high');

  let sort = 'default';
  try {
    sort = localStorage.getItem(SORT_KEY) || 'default';
  } catch {
    // private mode: default order
  }
  if (!(sort in SORTS)) sort = 'default';
  const focusList = h('ul.task-list');
  const drawFocus = () => {
    const byTask = new Map(focus.map((x) => [x.task, x]));
    const ordered = sortTasks(focus.map((x) => x.task), sort).map((t) => /** @type {(typeof focus)[number]} */ (byTask.get(t)));
    focusList.replaceChildren(...ordered.map((x) => taskRow(ctx, x.task, x.project, true, stampFor(x.task, sort))));
  };
  const focusSort = /** @type {HTMLSelectElement} */ (h('select.sort', { 'aria-label': 'Sort tasks', title: 'Sort tasks' },
    Object.entries(SORTS).map(([key, label]) => h('option', { value: key, selected: key === sort }, label))));
  focusSort.addEventListener('change', () => {
    sort = focusSort.value;
    try {
      localStorage.setItem(SORT_KEY, sort);
    } catch {
      // private mode: not remembered
    }
    drawFocus();
  });
  drawFocus();

  return h('section.view', null,
    h('h1', null, ws.title),
    warningBox(ws.warnings),
    h('h2.with-sort', null, 'Focus', focus.length ? focusSort : null),
    focus.length ? focusList : h('p.muted', null, items.length ? 'Nothing in progress, high priority or due this week.' : 'No open tasks.'),
    h('h2', null, 'Projects'),
    live.length
      ? h('ul.project-cards', null, live.map(projectCard))
      : h('p.muted', null, archived.length ? 'Every project is archived.' : 'No projects yet.'),
    ctx.storage.canWrite ? quickForm('New project name', 'Add project', (v) => ctx.createProject(v)) : null,
    archived.length
      ? h('details.panel.archived-projects', null, h('summary', null, `Archived projects · ${archived.length}`),
          h('ul.project-cards', null, archived.map(projectCard)))
      : null);

  /** @param {import('../projects.js').Project} p */
  function projectCard(p) {
          const open = p.tasks.filter((t) => isOpen(t, p));
          const overdue = open.filter((t) => t.due && t.due < now).length;
          const next = p.milestones.find((m) => m.listed && unfinished(milestoneProgress(p, m.name)));
          const nextProgress = next ? milestoneProgress(p, next.name) : null;
          return h(`li.card${p.status === 'archived' ? '.archived' : ''}`, null,
            h('a', { href: projectHref(p.path) }, h('strong', null, p.title)),
            h('span.muted', null, `${open.length} open · ${p.tasks.length - open.length} closed`),
            next && nextProgress
              ? h('span.next-milestone', { title: 'Next milestone' }, h('span.milestone', null, next.name),
                  progress(nextProgress), dateBadge(next.due, true, 'Milestone date'))
              : null,
            overdue ? h('span.due.overdue', null, `${overdue} overdue`) : null,
            p.status !== 'active' ? h('span.tag', null, p.status) : null);
  }
}

/**
 * Project settings: status, task statuses and labels, kept in the README frontmatter.
 * @param {ViewContext} ctx
 * @param {import('../projects.js').Project} project
 */
function projectSettings(ctx, project, open) {
  const fm = project.readme ? parseFrontmatter(project.readme.text).fields : new Map();
  const wf = project.workflow;
  const input = (/** @type {string} */ value, /** @type {string} */ placeholder) =>
    /** @type {HTMLInputElement} */ (h('input', { type: 'text', value, placeholder, disabled: !ctx.storage.canWrite }));
  const status = /** @type {HTMLSelectElement} */ (select(project.status, ['active', 'paused', 'archived'], { disabled: !ctx.storage.canWrite }));
  const statuses = input(fm.get('statuses') || '', DEFAULT_WORKFLOW.statuses.join(', '));
  const active = input(fm.get('active-statuses') || '', [...wf.active].join(', ') || 'none');
  const closed = input(fm.get('closed-statuses') || '', [...wf.closed].join(', '));
  const labels = input(fm.get('labels') || '', 'bug, idea, research');
  const milestones = input(fm.get('milestones') || '', 'MVP (2026-12-01), Beta, 1.0');
  const form = /** @type {HTMLFormElement} */ (h('form.settings', {
    onsubmit: async (/** @type {Event} */ e) => {
      e.preventDefault();
      form.classList.add('busy');
      try {
        // Leave a field out of the README while it says the same as the default.
        await ctx.setProjectFields(project, {
          status: status.value === 'active' && !fm.has('status') ? '' : status.value,
          statuses: splitList(statuses.value).join(', '),
          'active-statuses': splitList(active.value).join(', '),
          'closed-statuses': splitList(closed.value).join(', '),
          labels: splitList(labels.value).join(', '),
          milestones: formatMilestones(milestonesFrom(new Map([['milestones', milestones.value]]))),
        });
      } finally {
        form.classList.remove('busy');
      }
    },
  },
  h('label', null, 'Project status', status),
  h('label.wide', null, 'Task statuses, in order', statuses,
    h('span.hint', null, 'Comma-separated. New tasks get the first one that is neither in progress nor closed.')),
  h('label', null, 'In progress', active, h('span.hint', null, 'Shown under Focus.')),
  h('label', null, 'Closed', closed, h('span.hint', null, 'Finished; hidden from open tasks.')),
  h('label.wide', null, 'Labels', labels, h('span.hint', null, 'Suggested when labelling tasks. Labels tasks already use are added automatically.')),
  h('label.wide', null, 'Milestones, in order', milestones,
    h('span.hint', null, 'Comma-separated. Add a date in brackets: MVP (2026-12-01). Tasks pick one in their Milestone field.')),
  ctx.storage.canWrite ? h('div.actions', null, h('button.primary', { type: 'submit' }, 'Save settings'),
    h('span.muted.small', null, 'Saved in ', h('a', { href: fileHref(project.readmePath) }, project.readmePath))) : null));

  // Tasks left with a status the project no longer lists can be moved in one go.
  const strays = [...new Set(project.tasks.map((t) => t.status).filter((s) => !wf.statuses.includes(s)))];
  const moves = strays.length && ctx.storage.canWrite
    ? h('div.moves', null, h('p.muted.small', null, 'These statuses are used by tasks but not listed above:'),
        strays.map((s) => {
          const to = /** @type {HTMLSelectElement} */ (select(wf.initial, wf.statuses, { 'aria-label': `New status for ${s}` }));
          const n = project.tasks.filter((t) => t.status === s).length;
          return h('div.move', null, h('span', null, h('strong', null, s), ` · ${n} task${n > 1 ? 's' : ''} → `), to,
            h('button', { type: 'button', onclick: (/** @type {Event} */ e) => {
              /** @type {HTMLElement} */ (e.currentTarget).closest('.move')?.classList.add('busy');
              ctx.moveStatus(project, s, to.value);
            } }, 'Move'));
        }))
    : null;
  return h('details.panel.settings-panel', { open: open || strays.length ? true : null }, h('summary', null, 'Settings'), form, moves);
}

/** Side-panel icon for the details toggle. */
const SIDEBAR_ICON = '<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><rect x="2" y="3" width="12" height="10" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M10 3v10" stroke="currentColor" stroke-width="1.5"/></svg>';

/** Funnel icon for the filters toggle. */
const FILTER_ICON = '<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="M2 3h12l-4.5 5.5V13l-3-1.5V8.5z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>';

/**
 * Dependency graph: a task sits to the right of the tasks that block it, and tasks in
 * one column are ordered top to bottom (connected ones first, close to their neighbours).
 * Only relations between the tasks shown are drawn.
 * @param {ViewContext} ctx
 * @param {import('../projects.js').Project} project
 * @param {import('../tasks.js').Task[]} tasks
 */
function graph(ctx, project, tasks) {
  const wf = project.workflow;
  const byPath = new Map(tasks.map((t) => [t.path, t]));
  /** @type {Map<string, string[]>} */
  const blockers = new Map(tasks.map((t) => [t.path, t.relations.blockedBy.map((r) => r.path).filter((p) => byPath.has(p))]));
  /** @type {Map<string, string[]>} */
  const blocked = new Map(tasks.map((t) => [t.path, []]));
  for (const [to, froms] of blockers) for (const from of froms) blocked.get(from)?.push(to);

  // Column = length of the longest chain of blockers before the task.
  /** @type {Map<string, number>} */
  const depth = new Map();
  const visiting = new Set();
  const depthOf = (/** @type {string} */ p) => {
    if (depth.has(p)) return /** @type {number} */ (depth.get(p));
    if (visiting.has(p)) return 0; // a cycle: break it
    visiting.add(p);
    const d = Math.max(-1, ...(blockers.get(p) || []).map(depthOf)) + 1;
    visiting.delete(p);
    depth.set(p, d);
    return d;
  };
  for (const t of tasks) depthOf(t.path);

  const linked = tasks.filter((t) => blockers.get(t.path)?.length || blocked.get(t.path)?.length);
  const alone = tasks.filter((t) => !linked.includes(t));
  const cols = /** @type {string[][]} */ ([]);
  for (const t of linked) (cols[/** @type {number} */ (depth.get(t.path))] ||= []).push(t.path);
  for (let i = 0; i < cols.length; i++) cols[i] ||= [];

  // Order each column by the average row of its neighbours, a few sweeps both ways.
  /** @type {Map<string, number>} */
  const row = new Map();
  const setRows = () => cols.forEach((c) => c.forEach((p, i) => row.set(p, i)));
  setRows();
  const sweep = (/** @type {number} */ i, /** @type {Map<string, string[]>} */ toward) => {
    const key = (/** @type {string} */ p) => {
      const ns = (toward.get(p) || []).filter((n) => row.has(n));
      return ns.length ? ns.reduce((a, n) => a + /** @type {number} */ (row.get(n)), 0) / ns.length : /** @type {number} */ (row.get(p));
    };
    cols[i] = cols[i].map((p, k) => ({ p, k, v: key(p) })).sort((a, b) => a.v - b.v || a.k - b.k).map((x) => x.p);
    cols[i].forEach((p, k) => row.set(p, k));
  };
  for (let n = 0; n < 4; n++) {
    for (let i = 1; i < cols.length; i++) sweep(i, blockers);
    for (let i = cols.length - 2; i >= 0; i--) sweep(i, blocked);
  }

  const W = 220, H = 40, GX = 70, GY = 16;
  const pos = new Map();
  let bottom = 0;
  cols.forEach((c, i) => c.forEach((p, k) => {
    pos.set(p, { x: i * (W + GX), y: k * (H + GY) });
    bottom = Math.max(bottom, (k + 1) * (H + GY));
  }));
  // Tasks without relations go below, in rows of the same width.
  const perRow = Math.max(1, cols.length || 1);
  const startY = linked.length ? bottom + 24 : 0;
  alone.forEach((t, k) => pos.set(t.path, { x: (k % perRow) * (W + GX), y: startY + Math.floor(k / perRow) * (H + GY) }));
  const width = Math.max(cols.length, alone.length ? Math.min(perRow, alone.length) : 0) * (W + GX) - GX;
  const height = alone.length ? startY + Math.ceil(alone.length / perRow) * (H + GY) : bottom;
  if (!tasks.length) return h('p.muted', null, 'No tasks match.');

  const esc = Taski.markdown.escapeHtml;
  const edges = [];
  for (const [to, froms] of blockers) {
    for (const from of froms) {
      const a = pos.get(from), b = pos.get(to);
      if (!a || !b) continue;
      const x1 = a.x + W, y1 = a.y + H / 2, x2 = b.x, y2 = b.y + H / 2, dx = Math.max(24, (x2 - x1) / 2);
      const open = !byPath.get(from) || statusKind(wf, /** @type {any} */ (byPath.get(from)).status) !== 'closed';
      edges.push(`<path class="edge${open ? ' open' : ''}" d="M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}" marker-end="url(#arrow)"/>`);
    }
  }
  const nodes = tasks.map((t) => {
    const p = /** @type {{x: number, y: number}} */ (pos.get(t.path));
    const title = t.title.length > 30 ? `${t.title.slice(0, 29)}…` : t.title;
    const kind = statusKind(wf, t.status);
    const cls = `node k-${kind}${isBlocked(t) ? ' blocked' : ''}${t.priority === 'high' ? ' high' : ''}`;
    return `<a href="${esc(taskHref(t.path))}" class="${cls}"><title>${esc(t.title)} · ${esc(t.status)}</title>`
      + `<rect x="${p.x}" y="${p.y}" width="${W}" height="${H}" rx="7"/>`
      + `<text x="${p.x + 10}" y="${p.y + 17}" class="t">${esc(title)}</text>`
      + `<text x="${p.x + 10}" y="${p.y + 31}" class="s">${esc(t.status)}${isBlocked(t) ? ' · blocked' : ''}</text></a>`;
  });
  const svg = `<svg class="graph-svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="Task dependency graph">`
    + '<defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z"/></marker></defs>'
    + `${edges.join('')}${nodes.join('')}</svg>`;
  return h('div.graph', null,
    h('p.muted.small', null, linked.length
      ? 'Left to right: a task comes after the tasks that block it. Tasks without relations are at the bottom.'
      : 'No blocked-by or blocks relations yet. Add them to a task to see the graph.'),
    h('div.graph-scroll', { html: svg }));
}

/**
 * Columns of tasks, one per status. Drag a card to change its status.
 * @param {ViewContext} ctx
 * @param {import('../projects.js').Project} project
 * @param {import('../tasks.js').Task[]} tasks
 */
function board(ctx, project, tasks) {
  const wf = project.workflow;
  const extra = [...new Set(tasks.map((t) => t.status).filter((s) => !wf.statuses.includes(s)))];
  const canWrite = ctx.storage.canWrite;
  return h('div.board', null, [...wf.statuses, ...extra].map((status) => {
    const cards = tasks.filter((t) => t.status === status);
    const col = h(`section.column.${statusKind(wf, status)}`, {
      ondragover: canWrite ? (/** @type {DragEvent} */ e) => { e.preventDefault(); col.classList.add('over'); } : null,
      ondragleave: () => col.classList.remove('over'),
      ondrop: canWrite ? (/** @type {DragEvent} */ e) => {
        e.preventDefault();
        col.classList.remove('over');
        const t = tasks.find((x) => x.path === e.dataTransfer?.getData('text/x-taski-task'));
        if (t && t.status !== status) ctx.setField(t, 'status', status);
      } : null,
    },
    h('h3', null, h(`span.${statusClass(wf, status).replace(/ /g, '.')}`, null, status), h('span.count', null, cards.length),
      wf.statuses.includes(status) ? null : h('span.hint', { title: 'Not in this project’s statuses' }, '?')),
    h('ul', null, cards.map((t) => h(`li.card.p-${t.priority}`, {
      draggable: canWrite ? 'true' : null,
      ondragstart: (/** @type {DragEvent} */ e) => e.dataTransfer?.setData('text/x-taski-task', t.path),
    },
    h('a.title', { href: taskHref(t.path) }, t.title),
    h('div.chips', null,
      t.priority !== 'normal' ? h(`span.prio.p-${t.priority}`, null, t.priority) : null,
      milestoneChip(ctx, t, project),
      relationChips(t, project),
      taskLabels(ctx, t, project),
      t.files.length ? h('span.attach', null, `📎 ${t.files.length}`) : null,
      progress(t.progress),
      dueBadge(t, project))))));
    return col;
  }));
}

/**
 * @param {ViewContext} ctx
 * @param {import('../projects.js').Project} project
 * @param {ListUi} ui
 */
function projectView(ctx, project, ui) {
  const tab = ui.tab || 'tasks';
  ui.statuses ||= [];
  if (!ui.sort) {
    try {
      ui.sort = localStorage.getItem(SORT_KEY) || 'default';
    } catch {
      ui.sort = 'default';
    }
    if (!(ui.sort in SORTS)) ui.sort = 'default';
  }
  const body = h('div.tasks');
  const counts = h('span.muted');
  const labelBar = h('div.label-bar');
  const statusBar = h('div.status-bar');
  const milestoneBar = h('div.milestone-bar');
  const activeBar = h('div.active-filters');
  const searchInput = /** @type {HTMLInputElement} */ (h('input.search', { type: 'search', placeholder: 'Title, label or milestone', value: ui.query, 'aria-label': 'Filter tasks',
    oninput: (/** @type {Event} */ e) => { ui.query = /** @type {HTMLInputElement} */ (e.target).value; render(); } }));
  const chip = (/** @type {string} */ kind, /** @type {string} */ text, /** @type {() => void} */ clear) =>
    h('span.filter-chip', null, h('span.kind', null, kind), text,
      h('button', { type: 'button', 'aria-label': `Clear ${kind} filter`, title: 'Clear', onclick: () => { clear(); render(); } }, '×'));
  if (ui.milestone && ui.milestone !== NO_MILESTONE && !project.milestones.some((m) => m.name === ui.milestone)) ui.milestone = '';

  const matches = (/** @type {import('../tasks.js').Task} */ t) => {
    const q = ui.query.toLowerCase();
    return (!q || t.title.toLowerCase().includes(q) || t.milestone.toLowerCase().includes(q) || t.tags.some((tag) => tag.toLowerCase().includes(q))) &&
      (!ui.labels.length || ui.labels.some((l) => t.tags.includes(l))) &&
      (!ui.statuses?.length || ui.statuses.includes(t.status)) &&
      (!ui.milestone || t.milestone === (ui.milestone === NO_MILESTONE ? '' : ui.milestone));
  };
  // Through the app, so the sidebar highlights the milestone too.
  const pickMilestone = (/** @type {string} */ name) => ctx.showMilestone(project, ui.milestone === name ? '' : name);
  const render = () => {
    const filtered = sortTasks(project.tasks.filter(matches), ui.sort || 'default');
    const shown = ui.layout === 'board' ? filtered
      : ui.layout === 'graph' ? filtered.filter((t) => isOpen(t, project))
      : filtered.filter((t) => ui.filter === 'all' || (ui.filter === 'open') === isOpen(t, project));
    if (ui.layout === 'graph') {
      body.replaceChildren(graph(ctx, project, shown));
    } else if (ui.layout === 'board') {
      body.replaceChildren(board(ctx, project, shown));
    } else {
      const list = h('ul.task-list', null, shown.map((t) => taskRow(ctx, t, project, false, stampFor(t, ui.sort || 'default'))));
      if (!shown.length) list.append(h('li.muted', null, project.tasks.length ? 'No tasks match.' : 'No tasks yet.'));
      body.replaceChildren(list);
    }
    counts.textContent = `${shown.length} of ${project.tasks.length}`;
    if (searchInput.value !== ui.query) searchInput.value = ui.query;
    activeBar.replaceChildren(
      ...(ui.query ? [chip('Search', ui.query, () => { ui.query = ''; })] : []),
      ...(ui.layout === 'list' && ui.filter !== 'open' ? [chip('Show', ui.filter, () => { ui.filter = 'open'; for (const b of tabs) b.classList.toggle('on', b.textContent === 'open'); })] : []),
      ...(ui.statuses || []).map((st) => chip('Status', st, () => { ui.statuses = (ui.statuses || []).filter((x) => x !== st); })),
      ...(ui.milestone ? [chip('Milestone', ui.milestone === NO_MILESTONE ? 'none' : ui.milestone, () => { ui.milestone = ''; })] : []),
      ...ui.labels.map((l) => chip('Label', l, () => { ui.labels = ui.labels.filter((x) => x !== l); })));
    for (const b of tabs) b.hidden = ui.layout !== 'list';
    const allStatuses = [...project.workflow.statuses, ...new Set(project.tasks.map((t) => t.status).filter((x) => !project.workflow.statuses.includes(x)))];
    statusBar.replaceChildren(...allStatuses.map((st) => {
      const on = !!ui.statuses?.includes(st);
      const n = project.tasks.filter((t) => t.status === st).length;
      return h(`button.status-opt${on ? '.on' : ''}`, {
        type: 'button', 'aria-pressed': on ? 'true' : 'false', title: `Show tasks with status ${st}`,
        onclick: () => { ui.statuses = on ? (ui.statuses || []).filter((x) => x !== st) : [...(ui.statuses || []), st]; render(); },
      }, st, h('span.count', null, n));
    }));
    labelBar.replaceChildren(...(project.labels.length
      ? [...project.labels.map((l) => labelChip(l, {
            on: ui.labels.includes(l),
            onclick: () => {
              ui.labels = ui.labels.includes(l) ? ui.labels.filter((x) => x !== l) : [...ui.labels, l];
              render();
            },
          })),
          ui.labels.length ? h('button.link', { type: 'button', onclick: () => { ui.labels = []; render(); } }, 'clear') : '']
      : []));
    const unplanned = project.tasks.filter((t) => !t.milestone && isOpen(t, project)).length;
    milestoneBar.replaceChildren(...(project.milestones.length
      ? [...project.milestones.map((m) => {
          const p = milestoneProgress(project, m.name);
          const on = ui.milestone === m.name;
          return h(`button.milestone-card${on ? '.on' : ''}${unfinished(p) ? '' : '.reached'}`, {
            type: 'button', 'aria-pressed': on ? 'true' : 'false', onclick: () => pickMilestone(m.name),
            title: m.listed ? `Show tasks of ${m.name}` : `${m.name} is used by tasks but not listed in Settings`,
          },
          h('span.name', null, m.name, m.listed ? null : h('span.hint', null, ' ?')),
          h('span.chips', null, p.total ? progress(p) : h('span.muted.small', null, 'no tasks'), dateBadge(m.due, unfinished(p), 'Milestone date')));
        }),
        h(`button.milestone-card.none${ui.milestone === NO_MILESTONE ? '.on' : ''}`, {
          type: 'button', 'aria-pressed': ui.milestone === NO_MILESTONE ? 'true' : 'false', onclick: () => pickMilestone(NO_MILESTONE),
          title: 'Show tasks without a milestone',
        }, h('span.name', null, 'No milestone'), h('span.muted.small', null, `${unplanned} open`))]
      : []));
  };
  const toggle = (/** @type {HTMLElement[]} */ group, /** @type {EventTarget | null} */ on) => {
    for (const b of group) b.classList.toggle('on', b === on);
  };
  const tabs = ['open', 'closed', 'all'].map((f) =>
    h(`button.tab${ui.filter === f ? '.on' : ''}`, {
      type: 'button',
      onclick: (/** @type {Event} */ e) => { ui.filter = f; toggle(tabs, e.currentTarget); render(); },
    }, f));
  const sortSelect = /** @type {HTMLSelectElement} */ (h('select.sort', { 'aria-label': 'Sort tasks', title: 'Sort tasks' },
    Object.entries(SORTS).map(([key, label]) => h('option', { value: key, selected: key === ui.sort }, label))));
  sortSelect.addEventListener('change', () => {
    ui.sort = sortSelect.value;
    try {
      localStorage.setItem(SORT_KEY, ui.sort);
    } catch {
      // private mode: not remembered
    }
    render();
  });
  const layouts = ['list', 'board', 'graph'].map((l) =>
    h(`button.tab${ui.layout === l ? '.on' : ''}`, {
      type: 'button',
      onclick: (/** @type {Event} */ e) => { ui.layout = l; toggle(layouts, e.currentTarget); render(); },
    }, l));
  render();

  const archived = project.status === 'archived';
  const singleFile = /** @type {HTMLInputElement} */ (h('input', { type: 'checkbox' }));
  const notes = project.readme ? bodyWithoutTitle(withoutSection(withoutSection(project.readme.text, 'Tasks'), 'Files')) : '';

  const field = (/** @type {string} */ label, /** @type {Node} */ control, wide = false) => h(`label${wide ? '.wide' : ''}`, null, label, control);
  const titleInput = /** @type {HTMLInputElement} */ (h('input', { type: 'text', placeholder: 'Task title', required: true, 'aria-label': 'Task title' }));
  const statusSel = /** @type {HTMLSelectElement} */ (select(project.workflow.initial, project.workflow.statuses));
  const prioSel = /** @type {HTMLSelectElement} */ (select('normal', ['low', 'normal', 'high']));
  const dueIn = /** @type {HTMLInputElement} */ (h('input', { type: 'date' }));
  const estIn = /** @type {HTMLInputElement} */ (h('input', { type: 'text', placeholder: '30m, 3h, 1d' }));
  const msSel = /** @type {HTMLSelectElement} */ (select('', ['', ...project.milestones.map((m) => m.name)]));
  const tagsIn = /** @type {HTMLInputElement} */ (h('input', { type: 'text', placeholder: project.labels.join(', ') || 'bug, idea' }));
  const descIn = /** @type {HTMLTextAreaElement} */ (h('textarea', { rows: 4, placeholder: 'Description (Markdown)' }));
  const newTask = /** @type {HTMLDialogElement} */ (h('dialog.modal', {
    onclick: (/** @type {MouseEvent} */ e) => { if (e.target === newTask) newTask.close(); },
  },
  h('form.new-task', {
    onsubmit: async (/** @type {Event} */ e) => {
      e.preventDefault();
      const v = titleInput.value.trim();
      if (!v) return;
      /** @type {HTMLElement} */ (e.currentTarget).classList.add('busy');
      await ctx.createTask(project, v, singleFile.checked, {
        status: statusSel.value, priority: /** @type {any} */ (prioSel.value), due: dueIn.value, estimate: estIn.value.trim(),
        milestone: msSel.value, tags: splitList(tagsIn.value), description: descIn.value,
      });
      newTask.close();
    },
  },
  h('h2', null, 'New task'),
  field('Title', titleInput, true),
  field('Status', statusSel),
  field('Priority', prioSel),
  field('Due', dueIn),
  field('Estimate', estIn),
  field('Milestone', msSel),
  field('Labels', tagsIn),
  field('Description', descIn, true),
  h('label.inline', { title: 'Create tasks/<name>.md instead of a folder' }, singleFile, ' single file'),
  h('div.actions', null,
    h('button', { type: 'button', onclick: () => newTask.close() }, 'Cancel'),
    h('button.primary', { type: 'submit' }, 'Add task')))));

  const addFile = /** @type {HTMLDialogElement} */ (h('dialog.modal', {
    onclick: (/** @type {MouseEvent} */ e) => { if (e.target === addFile) addFile.close(); },
  },
  h('h2', null, 'Add file'),
  fileActions(ctx, projectOwner(project)),
  h('div.actions', null, h('button', { type: 'button', onclick: () => addFile.close() }, 'Close'))));

  return h('section.view.project', null,
    newTask,
    addFile,
    h('nav.crumbs', null, h('a', { href: '#/' }, ctx.workspace.title), ' › '),
    h('h1', null, project.title, project.status !== 'active' ? h('span.tag', null, project.status) : null,
      h('div.tabs.project-tabs', { role: 'tablist', 'aria-label': 'Project' },
      [['tasks', 'Tasks'], ['files', 'Files'], ['about', 'About']].map(([id, label]) =>
        h(`a.tab${tab === id ? '.on' : ''}`, { href: projectHref(project.path, id), role: 'tab', 'aria-selected': tab === id ? 'true' : 'false' }, label))),
      h('span.head-actions', null,
        ctx.storage.canWrite
          ? (tab === 'files'
              ? h('button.small.primary.add-task', { type: 'button', onclick: () => addFile.showModal() }, '+ Add file')
              : h('button.small.primary.add-task', { type: 'button', onclick: () => { titleInput.form?.reset(); newTask.showModal(); titleInput.focus(); } }, '+ Add task'))
          : null,
        h(`a.button.small.settings-btn${tab === 'settings' ? '.on' : ''}`, {
          href: projectHref(project.path, tab === 'settings' ? 'tasks' : 'settings'),
          title: 'Statuses, labels, milestones and visibility',
        }, 'Settings'),
        ctx.storage.canWrite
          ? h('button.small.archive', {
              type: 'button',
              title: archived ? 'Make the project active again' : 'Hide the project from the sidebar and Focus; its files stay',
              onclick: (/** @type {Event} */ e) => {
                const ok = archived || confirm(`Archive “${project.title}”? It is hidden from the sidebar and Focus; its files stay. You can unarchive it later.`);
                if (!ok) return;
                /** @type {HTMLElement} */ (e.currentTarget).classList.add('busy');
                ctx.setProjectFields(project, { status: archived ? '' : 'archived' });
              },
            }, archived ? 'Unarchive' : 'Archive')
          : null)),
    archived ? h('p.archived-note', null, 'This project is archived: it is left out of Focus and folded away in the sidebar.') : null,
    warningBox(project.warnings),
    tab === 'about' ? h('section.panel.notes', null,
        notes.trim()
          ? h('div.md', { html: renderMarkdown(notes, { resolveLink: linkResolver(ctx.workspace, project.readmePath) }) })
          : h('p.muted', null, 'No description yet.'),
        h('p.path', null, h('a', { href: fileHref(project.readmePath) }, project.readmePath)))
      : tab === 'files' ? filesPanel(ctx, projectOwner(project), 'Project files', false)
      : tab === 'settings' ? projectSettings(ctx, project, true)
      : h('div.tasks-tab', null,
      h('div.tasks-layout', null,
        h('div.tasks-main', null,
          h('div.toolbar', null, h('div.tabs', { role: 'group', 'aria-label': 'Layout' }, layouts), counts,
            sortSelect,
            h('button.small.icon.fold-right', { type: 'button', title: 'Show or hide filters', 'aria-label': 'Show or hide filters', onclick: () => toggleFold('right'), html: FILTER_ICON })),
          activeBar,
          body),
        h('aside.filters', { 'aria-label': 'Filters' },
          h('div.filters-head', null, h('h3', null, 'Filters'),
            h('button.small.icon', { type: 'button', title: 'Hide filters', 'aria-label': 'Hide filters', onclick: () => toggleFold('right'), html: FILTER_ICON })),
          searchInput,
          h('div.tabs', { role: 'group', 'aria-label': 'Show' }, tabs),
          h('h4', null, 'Task statuses'),
          statusBar,
          h('h4', null, 'Milestones'),
          milestoneBar,
          h('h4', null, 'Labels'),
          labelBar))));
}

/**
 * Raw Markdown editor shared by task and file views.
 * @param {string} text
 * @param {(text: string) => Promise<void>} onSave
 * @param {() => void} onCancel
 */
function editor(text, onSave, onCancel) {
  const area = /** @type {HTMLTextAreaElement} */ (h('textarea.editor', { spellcheck: 'false', 'aria-label': 'Markdown source' }));
  area.value = text;
  const save = async () => {
    wrap.classList.add('busy');
    try {
      await onSave(area.value);
    } catch {
      // the app already showed the error; keep the edits in the textarea
    } finally {
      wrap.classList.remove('busy');
    }
  };
  area.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 's') {
      e.preventDefault();
      save();
    } else if (e.key === 'Escape') {
      onCancel();
    }
  });
  const wrap = h('div.editing', null, area,
    h('div.actions', null,
      h('button.primary', { type: 'button', onclick: save }, 'Save'),
      h('button', { type: 'button', onclick: onCancel }, 'Cancel'),
      h('span.muted', null, '⌘/Ctrl+S to save, Esc to cancel')));
  queueMicrotask(() => area.focus());
  return wrap;
}

/**
 * The project's milestones, plus "none" and the task's own if the project
 * does not list it.
 * @param {import('../tasks.js').Task} task
 * @param {import('../projects.js').Project | undefined} project
 * @param {Record<string, any>} attrs
 */
function milestoneSelect(task, project, attrs) {
  const names = (project?.milestones || []).map((m) => m.name);
  if (task.milestone && !names.includes(task.milestone)) names.push(task.milestone);
  const due = project?.milestones.find((m) => m.name === task.milestone)?.due;
  return h('select', {
    ...attrs,
    disabled: attrs.disabled || (!names.length ? true : null),
    title: names.length ? (due ? `Milestone date ${due}` : null) : 'Add milestones under the project’s Settings',
  },
  h('option', { value: '', selected: !task.milestone }, '—'),
  names.map((n) => h('option', { value: n, selected: n === task.milestone }, n)));
}

/**
 * Label editor: chips with a remove button and an input that suggests the
 * project's labels. Enter or comma adds the label.
 * @param {ViewContext} ctx
 * @param {import('../tasks.js').Task} task
 * @param {import('../projects.js').Project | undefined} project
 */
function labelEditor(ctx, task, project) {
  const w = !ctx.storage.canWrite;
  const save = (/** @type {string[]} */ tags) => ctx.setField(task, 'tags', [...new Set(tags)].join(', '));
  const listId = `labels-${Math.random().toString(36).slice(2)}`;
  const suggestions = (project?.labels || []).filter((l) => !task.tags.includes(l));
  const input = /** @type {HTMLInputElement} */ (h('input.add-label', {
    type: 'text', list: listId, placeholder: task.tags.length ? 'add…' : 'add a label', 'aria-label': 'Add label', disabled: w,
    onkeydown: (/** @type {KeyboardEvent} */ e) => {
      if (e.key === 'Backspace' && !input.value && task.tags.length) save(task.tags.slice(0, -1));
      if (e.key !== 'Enter' && e.key !== ',') return;
      e.preventDefault();
      add();
    },
    onchange: () => { if (suggestions.includes(input.value.trim())) add(); },
  }));
  const add = () => {
    const more = splitList(input.value);
    input.value = '';
    if (more.length) save([...task.tags, ...more]);
  };
  return h('div.labels-edit', null,
    task.tags.map((tag) => w ? labelChip(tag) : labelChip(tag, { remove: () => save(task.tags.filter((x) => x !== tag)) })),
    w ? null : input,
    h('datalist', { id: listId }, suggestions.map((l) => h('option', { value: l }))));
}

const RELATION_TITLES = { blockedBy: 'Blocked by', blocks: 'Blocking', related: 'Related' };

/**
 * Blocked by / blocking / related tasks, as in Linear. A relation written on
 * either task shows on both; only the ones written here can be removed here.
 * @param {ViewContext} ctx
 * @param {import('../tasks.js').Task} task
 * @param {import('../projects.js').Project | undefined} project
 */
function relationsPanel(ctx, task, project) {
  const canWrite = ctx.storage.canWrite;
  const rel = task.relations;
  const kinds = /** @type {('blockedBy' | 'blocks' | 'related')[]} */ (['blockedBy', 'blocks', 'related']);
  if (!canWrite && !kinds.some((k) => rel[k].length) && !rel.missing.length) return null;

  /** Same rule as `linkRelations`, so removing keeps exactly the other names. @param {string} name */
  const resolve = (name) => (name.includes('/') ? join(name) : join(project?.path || '', name));
  const remove = (/** @type {'blockedBy' | 'blocks' | 'related'} */ kind, /** @type {(name: string) => boolean} */ drop) =>
    ctx.setField(task, RELATION_FIELDS[kind], task[kind].filter((n) => !drop(n)).join(', '));
  const removeButton = (/** @type {() => void} */ onclick, /** @type {string} */ label) =>
    canWrite ? h('button.small.remove', { type: 'button', 'aria-label': label, title: label, onclick }, '×') : null;

  const groups = kinds.filter((k) => rel[k].length).map((kind) => h('div.rel-group', null,
    h('h3', null, RELATION_TITLES[kind]),
    h('ul', null, rel[kind].map((r) => h(`li${r.closed ? '.closed' : ''}`, null,
      h('span.status', { title: 'Status' }, r.status),
      h('a', { href: taskHref(r.path) }, r.title),
      r.project !== (project?.path || '') ? h('span.muted.small', null, r.project) : null,
      r.here
        ? removeButton(() => remove(kind, (n) => resolve(n) === join(r.project, r.slug)), `Remove ${r.title}`)
        : h('span.muted.small', { title: `Written in ${r.title}, so remove it there` }, 'set there'))))));
  if (rel.missing.length) {
    groups.push(h('div.rel-group', null, h('h3', null, 'Not found'),
      h('ul', null, rel.missing.map((name) => h('li.missing', null, h('code', null, name),
        removeButton(() => {
          for (const kind of kinds) if (task[kind].includes(name)) remove(kind, (n) => n === name);
        }, `Remove ${name}`))))));
  }

  const kind = /** @type {HTMLSelectElement} */ (h('select', { 'aria-label': 'Relation' },
    kinds.map((k) => h('option', { value: k }, RELATION_TITLES[k]))));
  const listId = `rel-${Math.random().toString(36).slice(2)}`;
  const target = /** @type {HTMLInputElement} */ (h('input', {
    type: 'text', list: listId, required: true, placeholder: 'Task name, or project/name', 'aria-label': 'Related task',
    oninput: () => target.setCustomValidity(''),
  }));
  const choices = (project?.tasks || []).filter((t) => t.path !== task.path)
    .map((t) => h('option', { value: t.slug }, t.title));
  const dialog = /** @type {HTMLDialogElement} */ (h('dialog.modal', {
    onclick: (/** @type {MouseEvent} */ e) => { if (e.target === dialog) dialog.close(); },
  },
  h('form.new-task', {
    onsubmit: (/** @type {Event} */ e) => {
      e.preventDefault();
      const name = target.value.trim();
      const k = /** @type {'blockedBy' | 'blocks' | 'related'} */ (kind.value);
      const found = allTasks(ctx.workspace).find((x) => join(x.project.path, x.task.slug) === resolve(name));
      if (!found || found.task.path === task.path) {
        target.setCustomValidity(found ? 'A task cannot relate to itself' : 'No task with that name. Use its folder or file name.');
        target.reportValidity();
        return;
      }
      dialog.close();
      if (task[k].some((n) => resolve(n) === resolve(name))) return;
      ctx.setField(task, RELATION_FIELDS[k], [...task[k], name].join(', '));
    },
  },
  h('h2', null, 'Add relation'),
  h('label', null, 'Relation', kind),
  h('label.wide', null, 'Task', target, h('datalist', { id: listId }, choices)),
  h('div.actions', null,
    h('button', { type: 'button', onclick: () => dialog.close() }, 'Cancel'),
    h('button.primary', { type: 'submit' }, 'Add')))));

  return h('section.panel.relations', null,
    h('h2.with-action', null, 'Relations',
      canWrite ? h('button.small.add-relation', { type: 'button', onclick: () => { target.value = ''; target.setCustomValidity(''); dialog.showModal(); target.focus(); } }, '+ Add') : null),
    groups.length ? h('div.rel-groups', null, groups) : h('p.muted', null, 'No related tasks.'),
    canWrite ? dialog : null);
}

const KIND_ICON = { markdown: '📝', text: '📄', image: '🖼️', pdf: '📕', link: '🔗', other: '📦' };

const FILES_MODE_KEY = 'taski.filesMode';
/** How the file list is laid out: folders as a tree, newest first, or A–Z. */
const FILE_MODES = [['tree', 'Folders'], ['recent', 'Recent'], ['name', 'A–Z']];

/**
 * “3d ago” for recent changes, the date for old ones, '' when unknown.
 * @param {number | undefined} ms
 */
function ago(ms) {
  if (!ms) return '';
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)}d ago`;
  return new Date(ms).toLocaleDateString([], { dateStyle: 'medium' });
}

/**
 * Attached documents of a task or project: a list on the left, the selected
 * file shown in full on the right.
 * @param {ViewContext} ctx
 * @param {import('../files.js').Owner} owner
 * @param {string} heading
 * @param {boolean} [withActions]  Show the new-note and attach forms under the list.
 */
function filesPanel(ctx, owner, heading, withActions = true) {
  const body = h('div.files-browser', null, h('p.muted', null, 'Loading…'));
  const count = h('span.count');
  const canWrite = ctx.storage.canWrite;

  listAttachments(ctx.storage, owner).then((items) => {
    count.textContent = items.length ? String(items.length) : '';
    body.replaceChildren(items.length
      ? filesBrowser(ctx, owner, items)
      : h('p.muted', null, canWrite ? 'No files yet. Add a note or attach a file or link.' : 'No files.'));
  }, (e) => {
    body.replaceChildren(h('p.muted', null, `Could not list files: ${e.message}`));
  });

  return h('section.panel.files-panel', null,
    h('h2', null, heading, count),
    body,
    canWrite && withActions ? fileActions(ctx, owner) : null);
}

/**
 * @param {ViewContext} ctx
 * @param {import('../files.js').Owner} owner
 * @param {import('../files.js').Attachment[]} items
 */
function filesBrowser(ctx, owner, items) {
  let mode = 'tree';
  try {
    const saved = localStorage.getItem(FILES_MODE_KEY);
    if (FILE_MODES.some(([id]) => id === saved)) mode = /** @type {string} */ (saved);
  } catch {
    // storage blocked: default layout
  }
  let query = '';
  /** @type {import('../files.js').Attachment | null} */
  let selected = null;
  let raw = false;
  const folded = new Set();
  /** @type {Map<string, string>} */
  const texts = new Map();

  const dirOf = (/** @type {import('../files.js').Attachment} */ a) => (a.path === null ? '' : dirname(relativeTo(owner.file, a.path)));
  const byName = (/** @type {import('../files.js').Attachment} */ a, /** @type {import('../files.js').Attachment} */ b) => a.name.localeCompare(b.name);
  const byNewest = (/** @type {import('../files.js').Attachment} */ a, /** @type {import('../files.js').Attachment} */ b) => (b.updated || 0) - (a.updated || 0) || byName(a, b);
  const visible = () => items.filter((a) => !query || `${a.name} ${a.path || a.href}`.toLowerCase().includes(query));

  const modes = h('div.tabs', { role: 'group', 'aria-label': 'Order files' });
  const list = h('div.file-list');
  const viewer = h('div.file-viewer');
  const search = h('input.search', {
    type: 'search', placeholder: 'Filter files…', 'aria-label': 'Filter files',
    oninput: (/** @type {Event} */ e) => { query = /** @type {HTMLInputElement} */ (e.target).value.trim().toLowerCase(); renderList(); },
  });

  /** @param {import('../files.js').Attachment} a */
  function row(a) {
    const flat = mode !== 'tree';
    const sub = flat && dirOf(a) ? h('span.dir', null, dirOf(a)) : null;
    const inner = [
      h('span.icon', { 'aria-hidden': 'true' }, KIND_ICON[a.kind]),
      h('span.text', null, h('span.name', null, a.name), sub),
      a.linked ? null : h('span.tag', { title: 'In the folder but not listed under ## Files' }, 'not linked'),
      h('span.when', { title: a.updated ? new Date(a.updated).toLocaleString() : '' }, ago(a.updated)),
    ];
    if (a.path === null) return h('a.file-row', { href: a.href, target: '_blank', rel: 'noopener noreferrer', title: a.href }, inner);
    const path = a.path;
    if (!canPreview(a.kind)) return h('a.file-row', { href: fileHref(path), title: path }, inner);
    return h(`button.file-row${selected === a ? '.sel' : ''}`, { type: 'button', title: path, 'aria-pressed': selected === a ? 'true' : 'false', onclick: () => select(a) }, inner);
  }

  /** @param {{files: import('../files.js').Attachment[], dirs: Map<string, any>}} node @param {string} base */
  function treeNodes(node, base) {
    const out = [];
    for (const [name, child] of [...node.dirs].sort((x, y) => x[0].localeCompare(y[0]))) {
      const key = base ? `${base}/${name}` : name;
      const open = !!query || !folded.has(key);
      const total = (/** @type {any} */ n) => n.files.length + [...n.dirs.values()].reduce((s, c) => s + total(c), 0);
      out.push(h('div.folder', null,
        h('button.folder-row', {
          type: 'button', 'aria-expanded': open ? 'true' : 'false',
          onclick: () => { if (folded.has(key)) folded.delete(key); else folded.add(key); renderList(); },
        }, h('span.caret', { 'aria-hidden': 'true' }, open ? '▾' : '▸'), h('span.name', null, name), h('span.when', null, String(total(child)))),
        open ? h('div.children', null, treeNodes(child, key)) : null));
    }
    for (const a of node.files.sort(byName)) out.push(row(a));
    return out;
  }

  function renderList() {
    modes.replaceChildren(...FILE_MODES.map(([id, label]) =>
      h(`button.tab${mode === id ? '.on' : ''}`, {
        type: 'button', 'aria-pressed': mode === id ? 'true' : 'false',
        onclick: () => {
          mode = id;
          try { localStorage.setItem(FILES_MODE_KEY, id); } catch { /* not remembered */ }
          renderList();
        },
      }, label)));
    const shown = visible();
    if (!shown.length) return list.replaceChildren(h('p.muted.empty', null, 'No files match.'));
    if (mode !== 'tree') return list.replaceChildren(...shown.sort(mode === 'recent' ? byNewest : byName).map(row));
    const links = shown.filter((a) => a.path === null);
    const root = { files: /** @type {import('../files.js').Attachment[]} */ ([]), dirs: /** @type {Map<string, any>} */ (new Map()) };
    for (const a of shown) {
      if (a.path === null) continue;
      let node = root;
      for (const part of dirOf(a).split('/').filter(Boolean)) {
        if (!node.dirs.has(part)) node.dirs.set(part, { files: [], dirs: new Map() });
        node = node.dirs.get(part);
      }
      node.files.push(a);
    }
    list.replaceChildren(
      ...(links.length ? [h('div.group-title', null, 'Links'), ...links.sort(byName).map(row), h('div.group-title', null, 'Files')] : []),
      ...treeNodes(root, ''));
  }

  /** @param {import('../files.js').Attachment} a */
  function select(a) {
    selected = a;
    raw = false;
    renderList();
    renderViewer();
  }

  async function renderViewer() {
    const a = selected;
    if (!a || a.path === null) return viewer.replaceChildren(h('p.muted.empty', null, 'Pick a file on the left to read it here.'));
    const path = a.path;
    const body = h('div.file-body', null, h('p.muted', null, 'Loading…'));
    const rawBtn = a.kind === 'markdown'
      ? h('button.small', { type: 'button', title: 'Switch between rendered text and the file as written', onclick: () => { raw = !raw; show(); rawBtn.textContent = raw ? 'Rendered' : 'Raw'; } }, raw ? 'Rendered' : 'Raw')
      : null;
    const linkBtn = !a.linked && ctx.storage.canWrite
      ? h('button.small', { type: 'button', title: `Add to ## Files in ${basename(owner.file)}`, onclick: () => ctx.attachPath(owner, path) }, 'Link')
      : null;
    viewer.replaceChildren(
      h('div.file-head', null,
        h('div.titles', null, h('strong', null, a.name), h('span.path', null, relativeTo(owner.file, path), a.updated ? ` · updated ${ago(a.updated)}` : '')),
        h('div.head-actions', null, rawBtn, linkBtn, h('a.open', { href: fileHref(path), title: 'Open on its own page' }, 'Open ↗'))),
      body);
    const show = () => {
      const text = texts.get(path) ?? '';
      body.replaceChildren(a.kind === 'markdown' && !raw
        ? h('div.md', { html: renderMarkdown(parseFrontmatter(text).body, { resolveLink: linkResolver(ctx.workspace, path) }) || '<p class="muted">Empty file.</p>' })
        : h('pre.raw', null, text || 'Empty file.'));
    };
    if (texts.has(path)) return show();
    try {
      texts.set(path, (await ctx.storage.read(path)).text);
      if (selected === a) show();
    } catch (e) {
      if (selected === a) body.replaceChildren(h('p.muted', null, `Could not read ${path}: ${/** @type {Error} */ (e).message}`));
    }
  }

  selected = items.find((a) => a.path !== null && canPreview(a.kind)) || null;
  renderList();
  renderViewer();
  return h('div.files-browser-inner', null,
    h('div.file-nav', null, h('div.toolbar', null, modes, search), list),
    viewer);
}

/**
 * Forms to create a note or attach a file or link.
 * @param {ViewContext} ctx
 * @param {import('../files.js').Owner} owner
 */
function fileActions(ctx, owner) {
  const target = /** @type {HTMLInputElement} */ (h('input', { type: 'text', placeholder: 'Path like ./notes.md, or a URL', required: true, 'aria-label': 'Path or URL' }));
  const title = /** @type {HTMLInputElement} */ (h('input', { type: 'text', placeholder: 'Title (optional)', 'aria-label': 'Link title' }));
  const attachForm = /** @type {HTMLFormElement} */ (h('form.quick', {
    onsubmit: async (/** @type {Event} */ e) => {
      e.preventDefault();
      attachForm.classList.add('busy');
      try {
        await ctx.attach(owner, target.value, title.value.trim());
      } finally {
        attachForm.classList.remove('busy');
      }
    },
  }, target, title, h('button', { type: 'submit' }, 'Attach')));

  return h('div.file-actions', null,
    quickForm('New note title', 'New note', (v) => ctx.createNote(owner, v)),
    attachForm,
    h('p.hint', null, 'Links live in the ', h('code', null, '## Files'), ' section of ',
      h('code', null, basename(owner.file)), '. Notes are created next to it.'));
}

/**
 * Path of `path` as seen from the folder of `fromFile`, for display.
 * @param {string} fromFile
 * @param {string} path
 */
function relativeTo(fromFile, path) {
  const dir = dirname(fromFile);
  return dir && path.startsWith(`${dir}/`) ? path.slice(dir.length + 1) : path;
}

/**
 * @param {ViewContext} ctx
 * @param {import('../tasks.js').Task} task
 * @param {import('../projects.js').Project | undefined} project
 * @param {{editing: boolean, setEditing: (on: boolean) => void, tab?: string}} ui
 */
function taskView(ctx, task, project, ui) {
  const w = !ctx.storage.canWrite;
  const crumbs = h('nav.crumbs', null, h('a', { href: '#/' }, ctx.workspace.title), ' › ',
    project ? [h('a', { href: projectHref(project.path) }, project.title), ' › '] : null);

  // View and Files are addresses (?tab=files); Edit is a mode of this page.
  const go = (/** @type {string} */ tab) => {
    const href = taskHref(task.path) + (tab === 'files' ? '?tab=files' : '');
    if (Taski.hashlink.strip(location.hash) !== href) location.hash = href;
    else if (ui.editing) ui.setEditing(false);
  };
  const tabsFor = (/** @type {'view' | 'files' | 'edit'} */ active) => h('div.tabs.project-tabs', { role: 'tablist', 'aria-label': 'Task' },
    [['view', 'View'], ['files', `Files${task.files.length ? ` ${task.files.length}` : ''}`], ...(w ? [] : [['edit', 'Edit']])].map(([id, label]) =>
      h(`button.tab${active === id ? '.on' : ''}`, { type: 'button', role: 'tab', 'aria-selected': active === id ? 'true' : 'false',
        onclick: () => { if (active !== id) { if (id === 'edit') ui.setEditing(true); else go(id); } } }, label)));

  if (ui.editing) {
    return h('section.view', null, crumbs, h('h1', null, task.title, tabsFor('edit')),
      editor(task.text, async (text) => {
        await ctx.saveTaskText(task, text);
        ui.setEditing(false);
      }, () => ui.setEditing(false)),
      h('p.path', null, task.path));
  }

  const field = (/** @type {string} */ key) => (/** @type {Event} */ e) =>
    ctx.setField(task, key, /** @type {HTMLInputElement} */ (e.target).value);

  // `## Files` is shown in the files panel instead.
  const body = h('div.md', { html: renderMarkdown(bodyWithoutTitle(withoutSection(task.text, 'Files')), { resolveLink: linkResolver(ctx.workspace, task.path) }) });
  for (const box of body.querySelectorAll('input[data-check]')) {
    const input = /** @type {HTMLInputElement} */ (box);
    if (w) input.disabled = true;
    input.addEventListener('change', () => ctx.setCheck(task, Number(input.dataset.check), input.checked));
  }

  const known = new Set(['type', 'status', 'priority', 'due', 'created', 'tags', 'milestone', ...Object.values(RELATION_FIELDS)]);
  const extra = [...task.fields].filter(([k]) => !known.has(k));

  return h('section.view.task', null,
    crumbs,
    h('h1', null, task.title, tabsFor(ui.tab === 'files' ? 'files' : 'view'),
      h('button.small.icon.fold-right', { type: 'button', title: 'Show or hide details', 'aria-label': 'Show or hide details', onclick: () => toggleFold('right'), html: SIDEBAR_ICON })),
    h('div.tasks-layout.task-layout', null,
      h('div.task-main', null,
        ui.tab === 'files'
          ? filesPanel(ctx, taskOwner(task, project), 'Files')
          : body.childElementCount ? body : h('p.muted', null, 'No description.'),
        h('div.actions', null,
          h('span.path', null, task.path, task.fields.get('created') ? ` · created ${task.fields.get('created')}` : ''))),
      h('aside.filters.task-side', { 'aria-label': 'Task details' },
        h('div.filters-head', null, h('h3', null, 'Details'),
          h('button.small.icon', { type: 'button', title: 'Hide details', 'aria-label': 'Hide details', onclick: () => toggleFold('right'), html: SIDEBAR_ICON })),
        h('div.meta', null,
          h('label', null, 'Status', statusSelect(ctx, task, project)),
          h('label', null, 'Priority', select(task.priority, PRIORITIES, { disabled: w, onchange: field('priority') })),
          h('label', null, 'Due', h('input', { type: 'date', value: task.due, disabled: w, onchange: field('due') })),
          h('label', null, 'Milestone', milestoneSelect(task, project, { disabled: w, onchange: field('milestone') })),
          h('div.field.grow', null, h('span', null, 'Labels'), labelEditor(ctx, task, project)),
          progress(task.progress)),
        extra.length ? h('dl.extra', null, extra.map(([k, v]) => [h('dt', null, k), h('dd', null, v)])) : null,
        relationsPanel(ctx, task, project))));
}

/**
 * The task or project a file belongs to, for breadcrumbs: the task whose
 * folder (or `files/<task>` folder) holds it, else the project.
 * @param {import('../projects.js').Workspace} ws
 * @param {string} path
 */
function ownerOf(ws, path) {
  const project = ws.projects.find((p) => path.startsWith(`${p.path}/`));
  if (!project) return { project: undefined, task: undefined };
  const task = project.tasks.find((t) => {
    const folder = /^readme\.md$/i.test(basename(t.path)) ? dirname(t.path) : join(project.path, 'files', t.slug);
    return path.startsWith(`${folder}/`) || t.files.some((f) => f.path === path);
  });
  return { project, task };
}

/**
 * Any other file: Markdown rendered, text shown as is, with raw editing.
 * @param {ViewContext} ctx
 * @param {string} path
 * @param {{text: string, rev: string} | null} file   null when the file is not text.
 * @param {{editing: boolean, setEditing: (on: boolean) => void}} ui
 */
function fileView(ctx, path, file, ui) {
  const { project, task } = ownerOf(ctx.workspace, path);
  const crumbs = h('nav.crumbs', null, h('a', { href: '#/' }, ctx.workspace.title), ' › ',
    project ? [h('a', { href: projectHref(project.path) }, project.title), ' › '] : null,
    task ? [h('a', { href: taskHref(task.path) }, task.title), ' › '] : null,
    basename(path));
  if (file && ui.editing) {
    return h('section.view', null, crumbs,
      editor(file.text, async (text) => {
        await ctx.saveFile(path, text, file.rev);
        ui.setEditing(false);
      }, () => ui.setEditing(false)));
  }
  const kind = fileKind(path);
  const isMd = kind === 'markdown';
  const content = h('div.file-body');
  let raw = false;
  const show = () => {
    if (!file) return content.replaceChildren(h('p.muted', null, `Taski shows Markdown and text files only. Open ${basename(path)} from where your files live.`));
    content.replaceChildren(isMd && !raw
      ? h('div.md', { html: renderMarkdown(parseFrontmatter(file.text).body, { resolveLink: linkResolver(ctx.workspace, path) }) || '<p class="muted">Empty file.</p>' })
      : h('pre.raw', null, file.text || 'Empty file.'));
  };
  show();
  const rawBtn = file && isMd
    ? h('button.small', { type: 'button', title: 'Switch between rendered text and the file as written', onclick: () => { raw = !raw; rawBtn.textContent = raw ? 'Rendered' : 'Raw'; show(); } }, 'Raw')
    : null;
  return h('section.view.file-page', null, crumbs,
    h('div.file-head', null,
      h('div.titles', null, h('h1', null, KIND_ICON[kind], ' ', basename(path)), h('span.path', null, path)),
      h('div.head-actions', null,
        rawBtn,
        file && ctx.storage.canWrite && isMd ? h('button.small', { type: 'button', onclick: () => ui.setEditing(true) }, 'Edit Markdown') : null)),
    content,
    h('div.actions', null,
      task ? h('a', { href: taskHref(task.path) }, `← ${task.title}`) : project ? h('a', { href: projectHref(project.path) }, `← ${project.title}`) : null));
}

Taski.views = { encodePath, taskHref, projectHref, fileHref, isOpen, labelHue, overviewView, projectView, taskView, fileView };
})(window.Taski = window.Taski || {});
