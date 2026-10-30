---
type: task
status: todo
priority: high
created: 2026-10-30
tags: drive, deploy
---

# Set up Google Drive OAuth client

The app needs an OAuth client ID before `/app/` can talk to Google Drive.

- [ ] Create a Google Cloud project and enable the Drive API
- [ ] Configure the OAuth consent screen (testing mode, add yourself as a test user)
- [ ] Create a "Web application" client with origin `https://stan-kondrat.github.io`
- [ ] Put the client ID in `taski_src/config.js`

## Files

- [Scope notes](./scope-notes.md)
