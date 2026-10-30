// Deployment settings. Edit these for your own GitHub Pages copy.

(function (Taski) {
'use strict';

/**
 * OAuth client ID (type "Web application") from Google Cloud Console, with
 * the site origin (e.g. https://stan-kondrat.github.io) as an authorized
 * JavaScript origin. Left empty, the app asks for one and remembers it.
 */
const DRIVE_CLIENT_ID = '';

/** Default Drive folder for the workspace, relative to My Drive. */
const DRIVE_ROOT = 'taski';

/** Workspace folder the demo and local static mode look for next to taski.html. */
const LOCAL_WORKSPACE = './taski-demo/';

/**
 * Default for "Web folder" on the start screen, relative to this page.
 * The published app and the single-file download get the public demo URL
 * instead; scripts/build-dist.py rewrites this line when building them.
 */
const DEMO_WORKSPACE = './taski-demo/';

/** Release version. A `vX.Y.Z` git tag must match it to publish a release. */
const VERSION = '0.1.0';

Taski.config = { DRIVE_CLIENT_ID, DRIVE_ROOT, LOCAL_WORKSPACE, DEMO_WORKSPACE, VERSION };
})(window.Taski = window.Taski || {});
