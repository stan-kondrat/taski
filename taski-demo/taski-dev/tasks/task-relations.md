---
type: task
status: doing
priority: normal
created: 2026-11-10
tags: ui, format
milestone: 1.0
related: task-ids
---

# Task relations

A task can say which tasks block it and which it blocks, like in Linear. Write it in the
frontmatter, on either task: Taski shows it on both.

```
blocked-by: milestones, project-workflows
blocks: ship-mvp
related: task-ids
```

A name is the task's file or folder name, or `project/name` for a task in another project.

- [x] `blocked-by`, `blocks` and `related` fields
- [x] Relations panel on the task page
- [x] "Blocked by" and "Blocks" chips in lists and on the board
- [x] MCP tools list and set relations
- [ ] Show blocked tasks on the overview
