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
LAN it's http://192.168.1.117:3010/modern-combat/.

- **Static game, no server.** The built `dist/` is copied to `~/games-static/modern-combat/` on the
  home server (`ssh 192.168.1.117`, user ron; a Mac, Docker at `/usr/local/bin/docker`).
  `~/games-static/modern-combat/.deployed-commit` records which commit is live.
- **Serving.** The `games-gateway` Caddy container (LAN :3010) serves it with
  `handle_path /modern-combat/*` from `/srv/static/modern-combat`, stripping the prefix, and
  redirects `/modern-combat` to `/modern-combat/`. Cloudflare sends all of games.noblehaus.uk to
  the gateway, so there is no tunnel route or subdomain for this game.
- **Hub card.** The entry in `~/home-server/games/site/games.json` (id `modern-combat`) and the
  640×400 screenshot `site/img/modern-combat.jpg`: a battle in progress at Hollen, afternoon light.
- **Gateway docs.** `~/home-server/games/README.md` on the server, and `docs/17-games.md` in
  [noble1911/home-server](https://github.com/noble1911/home-server) (repo copy of `games/`).
- **Code.** [noble1911/modern-combat](https://github.com/noble1911/modern-combat) (public).
  `gh` stays on ron875: use `GH_TOKEN="$(gh auth token --user noble1911)"` per command, and push
  over HTTPS (the SSH key is ron875's).

**Deploy** a committed version (uncommitted changes are never deployed):

```bash
npm run deploy         # scripts/deploy.sh: export HEAD → npm ci → build → rsync → check gateway
```

Then open https://games.noblehaus.uk/modern-combat/ and check the hub card at
https://games.noblehaus.uk/ says *Online*. No gateway reload is needed for a file update; only
Caddyfile changes need `~/home-server/scripts/17-games.sh` on the server.

**Path rules**: the game shares one origin with the other games and is served under a path.

- **Relative asset URLs.** `vite.config.ts` has `base: './'`. Runtime loads (models, portraits,
  weapon icons) are built from `import.meta.env.BASE_URL`. Never write root-absolute URLs like
  `/models/…`.
- **Storage keys prefixed `modern-combat.`** (`STORAGE` in `src/game/campaign.ts`). Old `mc.*`
  keys are read once and migrated.
- **Network calls.** There are none today. Any future socket or API URL must be built from
  `location.href` (`new URL('ws', location.href)`), not `location.host`.
- **Check under a prefix before deploying.** `npm run preview:path` serves `dist/` at
  http://127.0.0.1:5190/modern-combat/ with the prefix stripped, and logs any request outside it.
