#!/bin/zsh
# QuickBoard auto-deploy to Netlify — run after user confirms.
# Token lives in ~/.quickboard-netlify-token (chmod 600), never in chat/logs.
set -e
TOKEN_FILE="$HOME/.quickboard-netlify-token"
SITE_NAME="jolly-sundae-9ea86e"
APP_DIR="$HOME/quickboard-app"

if [[ ! -f "$TOKEN_FILE" ]]; then echo "Missing token: $TOKEN_FILE"; exit 1; fi
TOKEN="$(cat "$TOKEN_FILE")"

echo "→ Resolving site $SITE_NAME…"
SITE_ID=$(curl -s -H "Authorization: Bearer $TOKEN" "https://api.netlify.com/api/v1/sites" | python3 -c "
import json,sys
for s in json.load(sys.stdin):
    if s.get('name')=='$SITE_NAME': print(s['id']); break
")
if [[ -z "$SITE_ID" ]]; then echo "Site not found / bad token"; exit 1; fi

echo "→ Zipping $APP_DIR…"
cd "$APP_DIR" && /usr/bin/zip -qr /tmp/qb-deploy.zip . -x '*.DS_Store*' 'deploy.sh'
echo "→ Deploying…"
DEPLOY_ID=$(curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/zip" --data-binary @/tmp/qb-deploy.zip "https://api.netlify.com/api/v1/sites/$SITE_ID/deploys" | python3 -c "import json,sys; print(json.load(sys.stdin)['id'])")

for i in {1..30}; do
  STATE=$(curl -s -H "Authorization: Bearer $TOKEN" "https://api.netlify.com/api/v1/deploys/$DEPLOY_ID" | python3 -c "import json,sys; print(json.load(sys.stdin).get('state'))")
  echo "  state: $STATE"
  [[ "$STATE" == "ready" ]] && break
  sleep 4
done
[[ "$STATE" == "ready" ]] || { echo "Deploy not ready: $STATE"; exit 1; }
rm -f /tmp/qb-deploy.zip
echo "→ Live check:"
curl -s "https://$SITE_NAME.netlify.app/" | grep -o "v[0-9][0-9]* • [a-z-]*" | head -1 || true
echo "DONE https://$SITE_NAME.netlify.app/"
