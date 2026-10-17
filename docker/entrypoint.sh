#!/bin/sh
# If API_URL is set, write it into config.js so the frontend talks to your
# Google Apps Script backend. Otherwise config.js is left as-is (demo mode:
# data stays in each visitor's browser).
set -e
if [ -n "$API_URL" ]; then
  printf 'const API_URL = "%s";\n' "$API_URL" > /usr/share/nginx/html/config.js
fi
exec "$@"
