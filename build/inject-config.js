/**
 * Netlify build script: copies frontend/ to dist/, stamping the Apps Script
 * URL into config.js from the APPS_SCRIPT_URL environment variable.
 * Run by Netlify on every deploy (see netlify.toml).
 *
 * Local use: APPS_SCRIPT_URL="https://…/exec" node build/inject-config.js
 * then serve dist/.
 */
var fs = require('fs');
var path = require('path');

var ROOT = path.join(__dirname, '..');
var SRC = path.join(ROOT, 'frontend');
var DIST = path.join(ROOT, 'dist');

fs.rmSync(DIST, { recursive: true, force: true });
fs.cpSync(SRC, DIST, { recursive: true });

var url = (process.env.APPS_SCRIPT_URL || '').trim();
var cfgPath = path.join(DIST, 'config.js');
var src = fs.readFileSync(cfgPath, 'utf8');

if (url) {
  var replaced = src.replace(
    'const API_URL = "";',
    'const API_URL = ' + JSON.stringify(url) + ';'
  );
  if (replaced === src) {
    console.error('inject-config: placeholder not found in config.js — leaving demo mode');
  } else {
    fs.writeFileSync(cfgPath, replaced);
    console.log('inject-config: stamped APPS_SCRIPT_URL into dist/config.js');
  }
} else {
  console.log('inject-config: APPS_SCRIPT_URL not set — building in demo mode');
}
