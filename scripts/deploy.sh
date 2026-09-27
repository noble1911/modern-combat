#!/usr/bin/env bash
# Deploy the committed HEAD to https://games.noblehaus.uk/modern-combat/.
#
# Static game: the built files go to ~/games-static/modern-combat/ on the home server
# (192.168.1.117), which the games-gateway Caddy container serves under /modern-combat/.
# Builds from a clean export of HEAD, never the working tree, and records the commit in
# .deployed-commit next to the files. See CLAUDE.md → Hosting.
set -euo pipefail

HOST=192.168.1.117
DEST=games-static/modern-combat
cd "$(git rev-parse --show-toplevel)"
if [ -n "$(git status --porcelain)" ]; then
  echo "note: uncommitted changes are NOT deployed (building $(git rev-parse --short HEAD))"
fi
COMMIT=$(git rev-parse HEAD)
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

git archive HEAD | tar -x -C "$TMP"
(cd "$TMP" && npm ci --no-audit --no-fund --loglevel=error && npm run build)
echo "$COMMIT" > "$TMP/dist/.deployed-commit"

ssh "$HOST" "mkdir -p ~/$DEST"
rsync -az --delete "$TMP/dist/" "$HOST:$DEST/"
echo "deployed $(git rev-parse --short HEAD) to $HOST:~/$DEST"

# the gateway listens on the box's LAN port 3010; check through an SSH forward
ssh -o ExitOnForwardFailure=yes -f -N -L 13010:localhost:3010 "$HOST"
sleep 1
code=$(curl -s -o /dev/null -w '%{http_code}' http://localhost:13010/modern-combat/ || true)
pkill -f 'ssh .*-L 13010:localhost:3010' || true
echo "gateway /modern-combat/ -> HTTP $code"
[ "$code" = 200 ]
