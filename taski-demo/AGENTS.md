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
| `tags`     | comma-separated words                         |

The first `# Heading` is the title. Everything else is free Markdown. Checklists use
`- [ ]` and `- [x]`. A task's `## Files` section links related documents with relative paths.

When editing:

- Change only the lines you need. Keep unknown frontmatter keys, notes and checklists.
- When you create a task, add a link to it under `## Tasks` in the project README.
  When you create a project, add it under `## Projects` in the workspace README.
  Plain web hosting can only find files through these links.
- Use relative links only.
