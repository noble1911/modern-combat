#!/usr/bin/env bash
# Deploy the committed HEAD to https://games.noblehaus.uk/modern-combat/.
#
# The game runs as a container (`modern-combat`, LAN :3004) on the home server (192.168.1.117):
# a small Node server that serves the built game and relays multiplayer battles. The games-gateway
# Caddy container reverse-proxies /modern-combat/* to it (prefix stripped, WebSockets included).
# This exports HEAD (never the working tree) to ~/modern-combat on the box, builds the image
# there, waits for the container to be healthy, then checks the page and a multiplayer socket
# through the gateway. See CLAUDE.md → Hosting.
set -euo pipefail

HOST=192.168.1.117
DEST=modern-combat
DOCKER='PATH=/usr/local/bin:$PATH docker'
cd "$(git rev-parse --show-toplevel)"
if [ -n "$(git status --porcelain)" ]; then
  echo "note: uncommitted changes are NOT deployed (deploying $(git rev-parse --short HEAD))"
fi
COMMIT=$(git rev-parse HEAD)
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

git archive HEAD | tar -x -C "$TMP"
echo "$COMMIT" > "$TMP/.deployed-commit"
ssh "$HOST" "mkdir -p ~/$DEST"
rsync -az --delete "$TMP/" "$HOST:$DEST/"
echo "copied $(git rev-parse --short HEAD) to $HOST:~/$DEST; building…"
ssh "$HOST" "cd ~/$DEST && $DOCKER compose up -d --build 2>&1 | tail -3"

for _ in $(seq 1 45); do
  state=$(ssh "$HOST" "$DOCKER inspect -f '{{.State.Health.Status}}' modern-combat" 2>/dev/null || true)
  [ "$state" = healthy ] && break
  sleep 2
done
echo "container: ${state:-unknown}"
[ "$state" = healthy ]

# the gateway listens on the box's LAN port 3010: check through an SSH forward
ssh -o ExitOnForwardFailure=yes -f -N -L 13010:localhost:3010 "$HOST"
sleep 1
code=$(curl -s -o /dev/null -w '%{http_code}' http://localhost:13010/modern-combat/ || true)
echo "gateway /modern-combat/ -> HTTP $code"
node -e '
  const WebSocket = require("ws");
  const ws = new WebSocket("ws://localhost:13010/modern-combat/ws");
  const fail = setTimeout(() => { console.log("gateway socket: no answer"); process.exit(1); }, 5000);
  ws.on("open", () => ws.send(JSON.stringify({ t: "create", name: "deploy-check", settings: { mode: "versus", mapId: "hollen", side: "nato", minutes: 25, budget: 1000, enemy: "regular" } })));
  ws.on("message", (d) => { const m = JSON.parse(d); if (m.t === "welcome") { console.log("gateway socket: ok (room " + m.room + ")"); clearTimeout(fail); ws.send(JSON.stringify({ t: "leave" })); setTimeout(() => process.exit(0), 100); } });
  ws.on("error", (e) => { console.log("gateway socket: " + e.message); process.exit(1); });
' && sock=ok || sock=fail
pkill -f 'ssh .*-L 13010:localhost:3010' || true
[ "$code" = 200 ] && [ "$sock" = ok ]
