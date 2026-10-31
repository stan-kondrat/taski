// Screens: overview, project, task and plain file. Each returns a DOM node and
// talks back to the app only through the `ctx` callbacks.

(function (Taski) {
'use strict';

const { h, select } = Taski.dom;
const { parseFrontmatter, renderMarkdown, withoutSection } = Taski.markdown;
const { basename, dirname, join, resolveRelative } = Taski.path;
const { DEFAULT_WORKFLOW, PRIORITIES, splitList, statusKind, today } = Taski.tasks;
const { canPreview, fileKind, listAttachments, projectOwner, taskOwner } = Taski.files;

/**
 * @typedef {Object} ListUi   Remembered per project while the page is open.
 * @property {string} filter   'open' | 'closed' | 'all'
 * @property {string} query
 * @property {string[]} labels Show tasks with any of these labels.
 * @property {string} layout   'list' | 'board'
 */

/**
 * @typedef {Object} ViewContext
 * @property {import('../storage/storage.js').Storage} storage
 * @property {import('../projects.js').Workspace} workspace
 * @property {(task: import('../tasks.js').Task, text: string) => Promise<void>} saveTaskText
 * @property {(project: import('../projects.js').Project, title: string, singleFile: boolean) => Promise<void>} createTask
 * @property {(title: string) => Promise<void>} createProject
 * @property {(project: import('../projects.js').Project, fields: Record<string, string>) => Promise<void>} setProjectFields
 * @property {(path: string, text: string, rev: string) => Promise<void>} saveFile
 * @property {(task: import('../tasks.js').Task, key: string, value: string) => Promise<void>} setField
 * @property {(task: import('../tasks.js').Task, n: number, done: boolean) => Promise<void>} setCheck
 * @property {(owner: import('../files.js').Owner, target: string, title: string) => Promise<void>} attach
 * @property {(owner: import('../files.js').Owner, path: string) => Promise<void>} attachPath
 * @property {(owner: import('../files.js').Owner, title: string) => Promise<void>} createNote
 * @property {(project: import('../projects.js').Project, label: string) => void} showLabel
 * @property {(project: import('../projects.js').Project, from: string, to: string) => Promise<void>} moveStatus
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
  if (!t.due) return null;
  const now = today();
  const open = isOpen(t, project);
  const cls = open && t.due < now ? 'due.overdue' : open && t.due === now ? 'due.today' : 'due';
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
function taskRow(ctx, t, project, showProject = false) {
  return h(`li.task-row.p-${t.priority}${isOpen(t, project) ? '' : '.closed'}`, null,
    statusSelect(ctx, t, project),
    h('a.title', { href: taskHref(t.path) }, t.title),
    t.priority !== 'normal' ? h(`span.prio.p-${t.priority}`, { title: 'Priority' }, t.priority) : null,
    showProject && project ? h('a.proj', { href: projectHref(project.path) }, project.title) : null,
    taskLabels(ctx, t, project),
    t.files.length ? h('span.attach', { title: `${t.files.length} attached file${t.files.length > 1 ? 's' : ''}` }, `📎 ${t.files.length}`) : null,
    progress(t.progress),
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
  const items = allTasks(ws).filter((x) => isOpen(x.task, x.project));
  const now = today();
  const soonStr = today(new Date(Date.now() + 7 * 864e5));
  const focus = items.filter((x) =>
    statusKind(x.project.workflow, x.task.status) === 'active' || (x.task.due && x.task.due <= soonStr) || x.task.priority === 'high');

  return h('section.view', null,
    h('h1', null, ws.title),
    warningBox(ws.warnings),
    h('h2', null, 'Focus'),
    focus.length
      ? h('ul.task-list', null, focus.map((x) => taskRow(ctx, x.task, x.project, true)))
      : h('p.muted', null, items.length ? 'Nothing in progress, high priority or due this week.' : 'No open tasks.'),
    h('h2', null, 'Projects'),
    ws.projects.length
      ? h('ul.project-cards', null, ws.projects.map((p) => {
          const open = p.tasks.filter((t) => isOpen(t, p));
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
 * Project settings: status, task statuses and labels, kept in the README frontmatter.
 * @param {ViewContext} ctx
 * @param {import('../projects.js').Project} project
 */
function projectSettings(ctx, project) {
  const fm = project.readme ? parseFrontmatter(project.readme.text).fields : new Map();
  const wf = project.workflow;
  const input = (/** @type {string} */ value, /** @type {string} */ placeholder) =>
    /** @type {HTMLInputElement} */ (h('input', { type: 'text', value, placeholder, disabled: !ctx.storage.canWrite }));
  const status = /** @type {HTMLSelectElement} */ (select(project.status, ['active', 'paused', 'archived'], { disabled: !ctx.storage.canWrite }));
  const statuses = input(fm.get('statuses') || '', DEFAULT_WORKFLOW.statuses.join(', '));
  const active = input(fm.get('active-statuses') || '', [...wf.active].join(', ') || 'none');
  const closed = input(fm.get('closed-statuses') || '', [...wf.closed].join(', '));
  const labels = input(fm.get('labels') || '', 'bug, idea, research');
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
  return h('details.panel.settings-panel', { open: strays.length ? true : null }, h('summary', null, 'Settings'), form, moves);
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
  const body = h('div.tasks');
  const counts = h('span.muted');
  const labelBar = h('div.label-bar');

  const matches = (/** @type {import('../tasks.js').Task} */ t) => {
    const q = ui.query.toLowerCase();
    return (!q || t.title.toLowerCase().includes(q) || t.tags.some((tag) => tag.toLowerCase().includes(q))) &&
      (!ui.labels.length || ui.labels.some((l) => t.tags.includes(l)));
  };
  const render = () => {
    const filtered = project.tasks.filter(matches);
    const shown = ui.layout === 'board' ? filtered
      : filtered.filter((t) => ui.filter === 'all' || (ui.filter === 'open') === isOpen(t, project));
    if (ui.layout === 'board') {
      body.replaceChildren(board(ctx, project, shown));
    } else {
      const list = h('ul.task-list', null, shown.map((t) => taskRow(ctx, t, project)));
      if (!shown.length) list.append(h('li.muted', null, project.tasks.length ? 'No tasks match.' : 'No tasks yet.'));
      body.replaceChildren(list);
    }
    counts.textContent = `${shown.length} of ${project.tasks.length}`;
    for (const b of tabs) b.hidden = ui.layout === 'board';
    labelBar.replaceChildren(...(project.labels.length
      ? [h('span.muted.small', null, 'Labels'),
          ...project.labels.map((l) => labelChip(l, {
            on: ui.labels.includes(l),
            onclick: () => {
              ui.labels = ui.labels.includes(l) ? ui.labels.filter((x) => x !== l) : [...ui.labels, l];
              render();
            },
          })),
          ui.labels.length ? h('button.link', { type: 'button', onclick: () => { ui.labels = []; render(); } }, 'clear') : '']
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
  const layouts = ['list', 'board'].map((l) =>
    h(`button.tab${ui.layout === l ? '.on' : ''}`, {
      type: 'button',
      onclick: (/** @type {Event} */ e) => { ui.layout = l; toggle(layouts, e.currentTarget); render(); },
    }, l));
  render();

  const singleFile = /** @type {HTMLInputElement} */ (h('input', { type: 'checkbox' }));
  const notes = project.readme ? bodyWithoutTitle(withoutSection(withoutSection(project.readme.text, 'Tasks'), 'Files')) : '';

  return h('section.view.project', null,
    h('nav.crumbs', null, h('a', { href: '#/' }, ctx.workspace.title), ' › '),
    h('h1', null, project.title, project.status !== 'active' ? h('span.tag', null, project.status) : null),
    warningBox(project.warnings),
    notes.trim()
      ? h('details.panel.notes', null, h('summary', null, 'About this project'),
          h('div.md', { html: renderMarkdown(notes, { resolveLink: linkResolver(ctx.workspace, project.readmePath) }) }),
          h('p.path', null, h('a', { href: fileHref(project.readmePath) }, project.readmePath)))
      : null,
    ctx.storage.canWrite
      ? quickForm('New task title', 'Add task', (v) => ctx.createTask(project, v, singleFile.checked),
          h('label.inline', { title: 'Create tasks/<name>.md instead of a folder' }, singleFile, ' single file'))
      : null,
    h('div.toolbar', null,
      h('div.tabs', { role: 'group', 'aria-label': 'Layout' }, layouts),
      h('div.tabs', { role: 'group', 'aria-label': 'Show' }, tabs),
      h('input.search', { type: 'search', placeholder: 'Filter by title or label', value: ui.query, 'aria-label': 'Filter tasks',
        oninput: (/** @type {Event} */ e) => { ui.query = /** @type {HTMLInputElement} */ (e.target).value; render(); } }),
      counts),
    labelBar,
    body,
    filesPanel(ctx, projectOwner(project), 'Project files'),
    projectSettings(ctx, project));
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

const KIND_ICON = { markdown: '📝', text: '📄', image: '🖼️', pdf: '📕', link: '🔗', other: '📦' };

/**
 * Attached documents of a task or project, with inline previews.
 * @param {ViewContext} ctx
 * @param {import('../files.js').Owner} owner
 * @param {string} heading
 */
function filesPanel(ctx, owner, heading) {
  const list = h('ul.files', null, h('li.muted', null, 'Loading…'));
  const count = h('span.count');
  const canWrite = ctx.storage.canWrite;

  listAttachments(ctx.storage, owner).then((items) => {
    count.textContent = items.length ? String(items.length) : '';
    list.replaceChildren(...items.map((a) => fileItem(ctx, owner, a)));
    if (!items.length) list.append(h('li.muted', null, canWrite ? 'No files yet. Add a note or attach a file or link.' : 'No files.'));
  }, (e) => {
    list.replaceChildren(h('li.muted', null, `Could not list files: ${e.message}`));
  });

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

  return h('section.panel.files-panel', null,
    h('h2', null, heading, count),
    list,
    canWrite
      ? h('div.file-actions', null,
          quickForm('New note title', 'New note', (v) => ctx.createNote(owner, v)),
          attachForm,
          h('p.hint', null, 'Links live in the ', h('code', null, '## Files'), ' section of ',
            h('code', null, basename(owner.file)), '. Notes are created next to it.'))
      : null);
}

/**
 * @param {ViewContext} ctx
 * @param {import('../files.js').Owner} owner
 * @param {import('../files.js').Attachment} a
 */
function fileItem(ctx, owner, a) {
  const where = a.path === null ? hostOf(a.href) : relativeTo(owner.file, a.path);
  const linkBtn = !a.linked && ctx.storage.canWrite
    ? h('button.small', { type: 'button', title: `Add to ## Files in ${basename(owner.file)}`, onclick: () => ctx.attachPath(owner, /** @type {string} */ (a.path)) }, 'Link')
    : null;
  const badge = a.linked ? null : h('span.tag', { title: 'In the folder but not listed under ## Files' }, 'not linked');
  const icon = h('span.icon', { 'aria-hidden': 'true' }, KIND_ICON[a.kind]);

  if (a.path === null) {
    return h('li.file', null, h('div.row', null, icon,
      h('a.name', { href: a.href, target: '_blank', rel: 'noopener noreferrer' }, a.name), h('span.where', null, where)));
  }
  const path = a.path;
  if (!canPreview(a.kind)) {
    return h('li.file', null, h('div.row', null, icon, h('a.name', { href: fileHref(path) }, a.name), h('span.where', null, where), badge, linkBtn));
  }
  const preview = h('div.preview');
  let loaded = false;
  const details = h('details', {
    ontoggle: async () => {
      if (!(/** @type {HTMLDetailsElement} */ (details)).open || loaded) return;
      loaded = true;
      preview.replaceChildren(h('p.muted', null, 'Loading…'));
      try {
        const { text } = await ctx.storage.read(path);
        preview.replaceChildren(a.kind === 'markdown'
          ? h('div.md', { html: renderMarkdown(parseFrontmatter(text).body, { resolveLink: linkResolver(ctx.workspace, path) }) || '<p class="muted">Empty file.</p>' })
          : h('pre.raw', null, text));
      } catch (e) {
        loaded = false;
        preview.replaceChildren(h('p.muted', null, `Could not read ${path}: ${/** @type {Error} */ (e).message}`));
      }
    },
  },
  h('summary', null, icon, h('span.name', null, a.name), h('span.where', null, where), badge,
    h('a.open', { href: fileHref(path), title: 'Open full page', onclick: (/** @type {Event} */ e) => e.stopPropagation() }, 'Open')),
  preview);
  return h('li.file', null, details, linkBtn ? h('div.under', null, linkBtn) : null);
}

/** @param {string} href */
function hostOf(href) {
  try {
    return new URL(href).host;
  } catch {
    return href;
  }
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

  // `## Files` is shown in the files panel instead.
  const body = h('div.md', { html: renderMarkdown(bodyWithoutTitle(withoutSection(task.text, 'Files')), { resolveLink: linkResolver(ctx.workspace, task.path) }) });
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
      h('label', null, 'Status', statusSelect(ctx, task, project)),
      h('label', null, 'Priority', select(task.priority, PRIORITIES, { disabled: w, onchange: field('priority') })),
      h('label', null, 'Due', h('input', { type: 'date', value: task.due, disabled: w, onchange: field('due') })),
      h('div.field.grow', null, h('span', null, 'Labels'), labelEditor(ctx, task, project)),
      progress(task.progress)),
    extra.length ? h('dl.extra', null, extra.map(([k, v]) => [h('dt', null, k), h('dd', null, v)])) : null,
    body.childElementCount ? body : h('p.muted', null, 'No description.'),
    filesPanel(ctx, taskOwner(task, project), 'Files'),
    h('div.actions', null,
      w ? null : h('button', { type: 'button', onclick: () => ui.setEditing(true) }, 'Edit Markdown'),
      h('span.path', null, task.path, task.fields.get('created') ? ` · created ${task.fields.get('created')}` : '')));
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
  return h('section.view', null, crumbs,
    !file
      ? h('p.muted', null, `Taski shows Markdown and text files only. Open ${basename(path)} from where your files live.`)
      : isMd
        ? h('div.md', { html: renderMarkdown(parseFrontmatter(file.text).body, { resolveLink: linkResolver(ctx.workspace, path) }) })
        : h('pre.raw', null, file.text),
    h('div.actions', null,
      file && ctx.storage.canWrite && isMd ? h('button', { type: 'button', onclick: () => ui.setEditing(true) }, 'Edit Markdown') : null,
      task ? h('a', { href: taskHref(task.path) }, `← ${task.title}`) : project ? h('a', { href: projectHref(project.path) }, `← ${project.title}`) : null,
      h('span.path', null, path)));
}

Taski.views = { encodePath, taskHref, projectHref, fileHref, isOpen, labelHue, overviewView, projectView, taskView, fileView };
})(window.Taski = window.Taski || {});
