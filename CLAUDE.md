# Modern Combat: Operation Iron Corridor

Browser real-time tactics game in the style of Close Combat: A Bridge Too Far, with modern units.
TypeScript + Vite + three.js. The simulation (`src/sim/`) is deterministic and headless, and the
renderer (`src/render/`) is separate. See README.md, docs/GRAPHICS.md and docs/MODELS.md.

```bash
npm run dev            # http://127.0.0.1:5173
npm test               # sim unit/integration tests (tests/tools/** excluded)
npm run build          # tsc + vite build → dist/
npm run models         # Blender: all 3D models → public/models/
npm run portraits      # Blender: unit portraits → public/portraits/
npm run icons          # weapon pictures → public/icons/weapons/
```

- Blender art pipeline: `tools/blender/` (headless Blender 5.x, `/Applications/Blender.app`).
- URL flags: `?quick=<mapId>&side=nato|opfor`, `?light=morning|noon|afternoon|overcast|dusk`,
  and `?timer=1` for hidden or automated browser windows.
- Commits: no co-author lines.

## Hosting

Live at **https://games.noblehaus.uk/modern-combat/**, one of the games on the games site. On the
LAN it's http://192.168.1.117:3004/ (the container) or http://192.168.1.117:3010/modern-combat/
(through the gateway).

- **A game with a server.** Container `modern-combat` on the home server (`ssh 192.168.1.117`, user
  ron; a Mac, Docker at `/usr/local/bin/docker`, not on the SSH PATH).
  - It runs on the external `homeserver` Docker network with `restart: unless-stopped` and a
    `/healthz` healthcheck.
  - LAN port **3004** (container port 3000) is registered in the home-server
    `registry/services.yaml`.
  - `server/index.mjs` serves the built game (`dist/`) and the multiplayer relay (WebSocket
    `/ws`); `Dockerfile` and `docker-compose.yml` are in this repo.
  - The source lives in `~/modern-combat` on the box, a plain copy of a commit (no git);
    `.deployed-commit` there records which commit is live.
- **Serving.** The `games-gateway` Caddy container (LAN :3010) proxies `handle_path /modern-combat/*`
  to `modern-combat:3000`, stripping the prefix; WebSockets pass through. `/modern-combat`
  redirects to `/modern-combat/`. Cloudflare sends all of games.noblehaus.uk to the gateway, so
  there is no tunnel route or subdomain for this game.
- **Hub card.** The entry in `~/home-server/games/site/games.json` (id `modern-combat`) and the
  640×400 screenshot `site/img/modern-combat.jpg`: a battle in progress at Hollen, afternoon light.
- **Gateway docs.** `~/home-server/games/README.md` on the server, and `docs/17-games.md` in
  [noble1911/home-server](https://github.com/noble1911/home-server) (repo copy of `games/`).
- **Code.** [noble1911/modern-combat](https://github.com/noble1911/modern-combat) (public).
  `gh` stays on ron875: use `GH_TOKEN="$(gh auth token --user noble1911)"` per command, and push
  over HTTPS (the SSH key is ron875's), e.g.
  `git -c credential.helper='!f() { echo username=x-access-token; echo "password=$(gh auth token --user noble1911)"; }; f' push`.

**Deploy** a committed version (uncommitted changes are never deployed):

```bash
npm run deploy         # scripts/deploy.sh: export HEAD → ~/modern-combat → docker compose up -d --build
                       #   → wait healthy → check the page and a multiplayer socket via the gateway
```

Then open https://games.noblehaus.uk/modern-combat/ and check the hub card at
https://games.noblehaus.uk/ says *Online*. A deploy restarts only this game's container.
Gateway (Caddyfile) changes need `~/home-server/scripts/17-games.sh` on the server.

**Path rules**: the game shares one origin with the other games and is served under a path.

- **Relative asset URLs.** `vite.config.ts` has `base: './'`. Runtime loads (models, portraits,
  weapon icons) are built from `import.meta.env.BASE_URL`. Never write root-absolute URLs like
  `/models/…`.
- **Socket URL built from the page URL.** `socketURL()` in `src/net/client.ts` is
  `new URL('ws', location.href)` with ws/wss chosen by protocol, never `location.host`. The same
  applies to any future API call.
- **Storage keys prefixed `modern-combat.`.** localStorage uses `STORAGE` in
  `src/game/campaign.ts` and `modern-combat.name`; sessionStorage uses `modern-combat.mp`. Old
  `mc.*` keys are read once and migrated.
- **Check under a prefix before deploying.**
  - `npm run preview:path` serves `dist/` at http://127.0.0.1:5190/modern-combat/ with the prefix
    stripped (static files only), and logs any request outside it.
  - For multiplayer, run `npm run server` and `npm run dev` (Vite forwards `/ws`), or build the
    image and run it.

**Multiplayer notes**: deterministic lockstep; see README → Multiplayer.

- **Determinism.** The simulation must stay deterministic, so in `src/sim/` use only the seeded
  `Rng` and the `dmath` functions (`dsin`, `dcos`, `datan2`, `dhypot`, `dexp`, `dpow`). Never use
  `Math.random`, `Math.sin`, `Math.hypot` and similar, or wall-clock time. `tests/lockstep.test.ts`
  catches desyncs.
- **Player actions.** Everything a player does to the battle goes through a `Command`
  (`src/net/protocol.ts`), applied by `Session.apply` (`src/net/session.ts`). A new kind of player
  action needs a new command, not a direct call from the UI.
