/**
 * The Google Apps Script Web App URL for the shared backend.
 *
 * This file is committed with an EMPTY value on purpose — the real URL must
 * not live in git. It is injected at deploy time:
 *
 *   Netlify: set the APPS_SCRIPT_URL environment variable in the Netlify UI
 *            (Site settings → Environment variables). The build script
 *            build/inject-config.js stamps it in (see netlify.toml).
 *   Docker:  the entrypoint replaces this from the $API_URL env var at
 *            container start.
 *
 * Leave it empty to run in DEMO MODE: the app works fully, but data stays in
 * this browser (localStorage) and is not shared with friends.
 */
const API_URL = "";
