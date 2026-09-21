#!/bin/zsh
# QuickBoard auto-deploy to GitHub Pages — run after user confirms.
# Pushes current folder to main; Pages rebuilds (~1 min).
set -e
APP_DIR="$HOME/quickboard-app"
cd "$APP_DIR"
git add -A
if git diff --cached --quiet; then echo "No changes to deploy."; exit 0; fi
MSG="${1:-QuickBoard update} ($(date '+%Y-%m-%d %H:%M'))"
git commit -m "$MSG" | tail -1
git push origin main 2>&1 | tail -2
echo "Pushed. Pages rebuilds in ~1 min: https://nick03meister.github.io/quickboard-app/"
