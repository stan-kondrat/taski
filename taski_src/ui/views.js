// Screens: overview, project, task and plain file. Each returns a DOM node and
// talks back to the app only through the `ctx` callbacks.

(function (Taski) {
'use strict';

const { h, select } = Taski.dom;
const { parseFrontmatter, renderMarkdown } = Taski.markdown;
const { resolveRelative } = Taski.path;
const { PRIORITIES, STATUSES, today } = Taski.tasks;

/**
 * @typedef {Object} ViewContext
 * @property {import('../storage/storage.js').Storage} storage
 * @property {import('../projects.js').Workspace} workspace
 * @property {(task: import('../tasks.js').Task, text: string) => Promise<void>} saveTaskText
 * @property {(project: import('../projects.js').Project, title: string, singleFile: boolean) => Promise<void>} createTask
 * @property {(title: string) => Promise<void>} createProject
 * @property {(path: string, text: string, rev: string) => Promise<void>} saveFile
 * @property {(task: import('../tasks.js').Task, key: string, value: string) => Promise<void>} setField
 * @property {(task: import('../tasks.js').Task, n: number, done: boolean) => Promise<void>} setCheck
 */

/** @param {string} path */
const encodePath = (path) => path.split('/').map(encodeURIComponent).join('/');
/** @param {string} path */
const taskHref = (path) => `#/t/${encodePath(path)}`;
/** @param {string} path */
const projectHref = (path) => `#/p/${encodePath(path)}`;
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

/** @param {import('../tasks.js').Task} t */
function isOpen(t) {
  return t.status !== 'done' && t.status !== 'cancelled';
}

/** @param {import('../tasks.js').Task} t */
function dueBadge(t) {
  if (!t.due) return null;
  const now = today();
  const cls = isOpen(t) && t.due < now ? 'due.overdue' : isOpen(t) && t.due === now ? 'due.today' : 'due';
  return h(`span.${cls}`, { title: 'Due date' }, t.due);
}

/** @param {{done: number, total: number}} p */
function progress(p) {
  if (!p.total) return null;
  return h('span.progress', { title: `${p.done} of ${p.total} checklist items done` },
    h('span.bar', null, h('span', { style: `width:${Math.round((p.done / p.total) * 100)}%` })),
    `${p.done}/${p.total}`);
}

/**
 * One row in a task list.
 * @param {ViewContext} ctx
 * @param {import('../tasks.js').Task} t
 * @param {import('../projects.js').Project} [project]  Shown when listing across projects.
 */
function taskRow(ctx, t, project) {
  const status = select(t.status, STATUSES, {
    class: `status s-${t.status}`,
    disabled: !ctx.storage.canWrite,
    'aria-label': 'Status',
    onchange: (/** @type {Event} */ e) => ctx.setField(t, 'status', /** @type {HTMLSelectElement} */ (e.target).value),
  });
  return h(`li.task-row.p-${t.priority}${isOpen(t) ? '' : '.closed'}`, null,
    status,
    h('a.title', { href: taskHref(t.path) }, t.title),
    t.priority !== 'normal' ? h(`span.prio.p-${t.priority}`, { title: 'Priority' }, t.priority) : null,
    project ? h('a.proj', { href: projectHref(project.path) }, project.title) : null,
    t.tags.map((tag) => h('span.tag', null, tag)),
    progress(t.progress),
    dueBadge(t));
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
  const items = allTasks(ws).filter((x) => isOpen(x.task));
  const now = today();
  const soon = new Date(Date.now() + 7 * 864e5);
  const soonStr = today(soon);
  const focus = items.filter((x) => x.task.status === 'doing' || (x.task.due && x.task.due <= soonStr) || x.task.priority === 'high');

  return h('section.view', null,
    h('h1', null, ws.title),
    warningBox(ws.warnings),
    h('h2', null, 'Focus'),
    focus.length
      ? h('ul.task-list', null, focus.map((x) => taskRow(ctx, x.task, x.project)))
      : h('p.muted', null, items.length ? 'Nothing in progress, high priority or due this week.' : 'No open tasks.'),
    h('h2', null, 'Projects'),
    ws.projects.length
      ? h('ul.project-cards', null, ws.projects.map((p) => {
          const open = p.tasks.filter(isOpen);
          const overdue = open.filter((t) => t.due && t.due < now).length;
          return h(`li.card${p.status === 'archived' ? '.archived' : ''}`, null,
            h('a', { href: projectHref(p.path) }, h('strong', null, p.title)),
            h('span.muted', null, `${open.length} open · ${p.tasks.length - open.length} closed`),
            overdue ? h('span.due.overdue', null, `${overdue} overdue`) : null,
            p.status !== 'active' ? h('span.tag', null, p.status) : null);
        }))
      : h('p.muted', null, 'No projects yet.'),
    ctx.storage.canWrite ? quickForm('New project name', 'Add project', (v) => ctx.createProject(v)) : null);
}

/**
 * @param {ViewContext} ctx
 * @param {import('../projects.js').Project} project
 * @param {{filter: string, query: string}} ui   Remembered list filter.
 */
function projectView(ctx, project, ui) {
  const list = h('ul.task-list');
  const counts = h('span.muted');
  const render = () => {
    const q = ui.query.toLowerCase();
    const shown = project.tasks.filter((t) =>
      (ui.filter === 'all' || (ui.filter === 'open' ? isOpen(t) : !isOpen(t))) &&
      (!q || t.title.toLowerCase().includes(q) || t.tags.some((tag) => tag.toLowerCase().includes(q))));
    list.replaceChildren(...shown.map((t) => taskRow(ctx, t)));
    if (!shown.length) list.append(h('li.muted', null, project.tasks.length ? 'No tasks match.' : 'No tasks yet.'));
    counts.textContent = `${shown.length} of ${project.tasks.length}`;
  };
  const tabs = ['open', 'closed', 'all'].map((f) =>
    h(`button.tab${ui.filter === f ? '.on' : ''}`, {
      type: 'button',
      onclick: (/** @type {Event} */ e) => {
        ui.filter = f;
        for (const b of tabs) b.classList.toggle('on', b === e.currentTarget);
        render();
      },
    }, f));
  render();

  const singleFile = /** @type {HTMLInputElement} */ (h('input', { type: 'checkbox' }));
  const notes = project.readme ? bodyWithoutTitle(project.readme.text) : '';

  return h('section.view', null,
    h('nav.crumbs', null, h('a', { href: '#/' }, ctx.workspace.title), ' › '),
    h('h1', null, project.title, project.status !== 'active' ? h('span.tag', null, project.status) : null),
    warningBox(project.warnings),
    ctx.storage.canWrite
      ? quickForm('New task title', 'Add task', (v) => ctx.createTask(project, v, singleFile.checked),
          h('label.inline', { title: 'Create tasks/<name>.md instead of a folder' }, singleFile, ' single file'))
      : null,
    h('div.toolbar', null, h('div.tabs', null, tabs),
      h('input.search', { type: 'search', placeholder: 'Filter by title or tag', value: ui.query, 'aria-label': 'Filter tasks',
        oninput: (/** @type {Event} */ e) => { ui.query = /** @type {HTMLInputElement} */ (e.target).value; render(); } }),
      counts),
    list,
    notes.trim()
      ? h('details.notes', null, h('summary', null, 'Project README'),
          h('div.md', { html: renderMarkdown(notes, { resolveLink: linkResolver(ctx.workspace, project.readmePath) }) }),
          h('p.path', null, h('a', { href: fileHref(project.readmePath) }, project.readmePath)))
      : project.readme ? h('p.path', null, h('a', { href: fileHref(project.readmePath) }, project.readmePath)) : null);
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
 * @param {ViewContext} ctx
 * @param {import('../tasks.js').Task} task
 * @param {import('../projects.js').Project | undefined} project
 * @param {{editing: boolean, setEditing: (on: boolean) => void}} ui
 */
function taskView(ctx, task, project, ui) {
  const w = !ctx.storage.canWrite;
  const crumbs = h('nav.crumbs', null, h('a', { href: '#/' }, ctx.workspace.title), ' › ',
    project ? [h('a', { href: projectHref(project.path) }, project.title), ' › '] : null);

  if (ui.editing) {
    return h('section.view', null, crumbs, h('h1', null, task.title),
      editor(task.text, async (text) => {
        await ctx.saveTaskText(task, text);
        ui.setEditing(false);
      }, () => ui.setEditing(false)),
      h('p.path', null, task.path));
  }

  const field = (/** @type {string} */ key) => (/** @type {Event} */ e) =>
    ctx.setField(task, key, /** @type {HTMLInputElement} */ (e.target).value);

  const body = h('div.md', { html: renderMarkdown(bodyWithoutTitle(task.text), { resolveLink: linkResolver(ctx.workspace, task.path) }) });
  for (const box of body.querySelectorAll('input[data-check]')) {
    const input = /** @type {HTMLInputElement} */ (box);
    if (w) input.disabled = true;
    input.addEventListener('change', () => ctx.setCheck(task, Number(input.dataset.check), input.checked));
  }

  const known = new Set(['type', 'status', 'priority', 'due', 'created', 'tags']);
  const extra = [...task.fields].filter(([k]) => !known.has(k));

  return h('section.view.task', null,
    crumbs,
    h('h1', null, task.title),
    h('div.meta', null,
      h('label', null, 'Status', select(task.status, STATUSES, { class: `status s-${task.status}`, disabled: w, onchange: field('status') })),
      h('label', null, 'Priority', select(task.priority, PRIORITIES, { disabled: w, onchange: field('priority') })),
      h('label', null, 'Due', h('input', { type: 'date', value: task.due, disabled: w, onchange: field('due') })),
      h('label.grow', null, 'Tags', h('input', { type: 'text', value: task.tags.join(', '), placeholder: 'comma, separated', disabled: w, onchange: field('tags') })),
      progress(task.progress)),
    extra.length ? h('dl.extra', null, extra.map(([k, v]) => [h('dt', null, k), h('dd', null, v)])) : null,
    body.childElementCount ? body : h('p.muted', null, 'No description.'),
    h('div.actions', null,
      w ? null : h('button', { type: 'button', onclick: () => ui.setEditing(true) }, 'Edit Markdown'),
      h('span.path', null, task.path, task.fields.get('created') ? ` · created ${task.fields.get('created')}` : '')));
}

/**
 * Any other Markdown file: rendered, with raw editing.
 * @param {ViewContext} ctx
 * @param {string} path
 * @param {{text: string, rev: string}} file
 * @param {{editing: boolean, setEditing: (on: boolean) => void}} ui
 */
function fileView(ctx, path, file, ui) {
  const crumbs = h('nav.crumbs', null, h('a', { href: '#/' }, ctx.workspace.title), ' › ', path);
  if (ui.editing) {
    return h('section.view', null, crumbs,
      editor(file.text, async (text) => {
        await ctx.saveFile(path, text, file.rev);
        ui.setEditing(false);
      }, () => ui.setEditing(false)));
  }
  const isMd = /\.md$/i.test(path);
  return h('section.view', null, crumbs,
    isMd
      ? h('div.md', { html: renderMarkdown(parseFrontmatter(file.text).body, { resolveLink: linkResolver(ctx.workspace, path) }) })
      : h('pre.raw', null, file.text),
    h('div.actions', null,
      ctx.storage.canWrite && isMd ? h('button', { type: 'button', onclick: () => ui.setEditing(true) }, 'Edit Markdown') : null,
      h('span.path', null, path)));
}

Taski.views = { encodePath, taskHref, projectHref, fileHref, overviewView, projectView, taskView, fileView };
})(window.Taski = window.Taski || {});
