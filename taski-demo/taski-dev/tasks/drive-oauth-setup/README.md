---
type: task
status: todo
priority: high
created: 2026-10-30
tags: drive, deploy
milestone: MVP
---

# Set up Google Drive OAuth client

The app needs an OAuth client ID before `/app/` can talk to Google Drive.

- [ ] Create a Google Cloud project and enable the Drive API
- [ ] Configure the OAuth consent screen (testing mode, add yourself as a test user)
- [ ] Create a "Web application" client with origin `https://stan-kondrat.github.io`
- [ ] Enable the Google Picker API and create an API key for "Add from Drive"
- [ ] Add the `DRIVE_CLIENT_ID` and `DRIVE_API_KEY` repository secrets

## Files

- [Scope notes](./scope-notes.md)
