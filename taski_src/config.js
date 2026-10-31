// Deployment settings. Edit these for your own GitHub Pages copy.

(function (Taski) {
'use strict';

/**
 * Taski's OAuth client ID (Google Cloud, type "Web application"). Empty in the
 * source: CI fills it in from the DRIVE_CLIENT_ID secret when it builds the
 * published site (scripts/build-dist.py); downloads stay without it. Without it,
 * the start screen asks for your own client ID. Google only signs it in on the
 * origins listed below.
 */
const DRIVE_CLIENT_ID = '';

/**
 * API key of the same Google Cloud project, used by the Google Picker
 * ("Add from Drive"). Empty in the source; CI fills it in from the
 * DRIVE_API_KEY secret, next to DRIVE_CLIENT_ID.
 */
const DRIVE_API_KEY = '';

/** Authorized JavaScript origins of DRIVE_CLIENT_ID. Keep in sync with Google Cloud. */
const DRIVE_ORIGINS = ['https://stan-kondrat.github.io'];

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

Taski.config = { DRIVE_CLIENT_ID, DRIVE_API_KEY, DRIVE_ORIGINS, DRIVE_ROOT, LOCAL_WORKSPACE, DEMO_WORKSPACE, VERSION };
})(window.Taski = window.Taski || {});
