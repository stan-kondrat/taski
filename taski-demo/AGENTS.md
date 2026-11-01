# Rules for agents editing this workspace

Layout:

- `<project>/README.md` — project overview. Frontmatter `type: project`. Its `## Tasks`
  section links every task.
- `<project>/tasks/<task>/README.md` — a task with related files next to it, or
  `<project>/tasks/<task>.md` — a task that is a single file.
- `<project>/AGENTS.md` — optional project-specific instructions.

Frontmatter is a strict subset of YAML: one `key: value` per line between `---` lines,
no nesting, no multi-line values, no duplicate keys.

| key        | values                                        |
|------------|-----------------------------------------------|
| `type`     | `workspace`, `project`, `task`                |
| `status`   | task: `todo` `doing` `blocked` `done` `cancelled`; project: `active` `paused` `archived` |
| `priority` | `low` `normal` `high`                         |
| `due`      | `YYYY-MM-DD`                                  |
| `created`  | `YYYY-MM-DD`                                  |
| `tags`     | task labels, comma-separated                  |
| `milestone`| task: one of the project's `milestones`       |

A project README may set its own task statuses and labels:

| key               | meaning                                                         |
|-------------------|-----------------------------------------------------------------|
| `statuses`        | the project's task statuses, in board order                     |
| `active-statuses` | statuses that mean "in progress" (default `doing`)              |
| `closed-statuses` | statuses that mean finished (default `done`, `cancelled`, else the last one) |
| `labels`          | suggested task labels, comma-separated                          |
| `milestones`      | the project's milestones in order, each with an optional `(YYYY-MM-DD)` date |

```
statuses: backlog, todo, doing, review, done, cancelled
active-statuses: doing, review
labels: bug, idea, research
milestones: MVP (2026-12-01), Beta, 1.0
```

Without `statuses` a project uses `todo doing blocked done cancelled`. Use only the
project's statuses in its tasks. New tasks start in the first status that is neither
active nor closed. A task's `milestone` must be one of the project's `milestones`; to
add a milestone, add it to the project README first.

The first `# Heading` is the title. Everything else is free Markdown. Checklists use
`- [ ]` and `- [x]`.

Attached documents: a task's or project's `## Files` section links related files with
relative paths, or full URLs for outside documents. Put a folder task's files in its
folder; for a single-file task use `<project>/files/<task>/`. Project documents can live
anywhere in the project folder outside `tasks/`. Add a link for every file you add.

When editing:

- Change only the lines you need. Keep unknown frontmatter keys, notes and checklists.
- When you create a task, add a link to it under `## Tasks` in the project README.
  When you create a project, add it under `## Projects` in the workspace README.
  Plain web hosting can only find files through these links.
- Use relative links only.
