# Working on Taski's code

- **Zero dependencies.** Never install or add Node.js, npm, pip packages or any other
  package manager. Use only what ships with a browser and with Python 3.9 (the oldest
  version we support).
- **Readable code is a feature. Never minify or transform it.** The only build step,
  `scripts/build-dist.py`, copies files verbatim into a single `taski.html` and a zip.
  It edits only these values in `config.js`: `DEMO_WORKSPACE` stays relative (`./taski-demo/`)
  in the source and becomes the public demo URL in the single file and `/app/`;
  `DRIVE_CLIENT_ID` and `DRIVE_API_KEY` are empty in the source and filled in from the
  GitHub secrets of the same names (env `TASKI_DRIVE_CLIENT_ID`, `TASKI_DRIVE_API_KEY`)
  only in the published `/app/` and `/demo/`; downloads keep them empty. Never commit them.
  `scripts/build-site.sh` also adds `?v=<hash>` to the script and stylesheet URLs in the
  published pages so browsers never mix cached old files with new ones.
- Frontend: `taski.html` + classic scripts in `taski_src/` (not ES modules, so the
  downloaded folder works when opened from disk). Each file is wrapped in
  `(function (Taski) { ... })(window.Taski = window.Taski || {});`, takes what it needs
  from `Taski.<name>` at the top and publishes its own exports as `Taski.<name>` at the
  bottom. Script order in `taski.html` is dependency order. Plain JavaScript with JSDoc
  types, no TypeScript, no frameworks.
- Version lives in `taski_src/config.js` (`VERSION`). Releases are tags `vX.Y.Z` that
  must match it.
- `server.py`: standard library only. It binds to 127.0.0.1, keeps every path inside
  the workspace root (symlinks included), writes atomically and refuses stale writes.
- Storage adapters (`taski_src/storage/`) move raw text only. Task and project meaning
  lives in `markdown.js`, `tasks.js`, `projects.js` and `files.js`.
- Edits to Markdown files must change only the lines they need. Never rewrite a whole
  file from parsed data: unknown fields and free text must survive.
- `taski-demo/` is the sample workspace and the published demo. Its format rules are in
  `taski-demo/AGENTS.md`. `taski-demo/taski-dev/` tracks Taski's own roadmap.
- Tests: `python3 -m unittest discover tests` and `tests/tests.html` in a browser.
