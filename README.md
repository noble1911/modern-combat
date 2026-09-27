# Modern Combat: Operation Iron Corridor

A real-time tactical wargame in the tradition of **Close Combat: A Bridge Too Far**, with modern
military units. You command a company-sized battlegroup of individually simulated soldiers and
vehicles: US Army air assault infantry, Abrams, Bradleys and Strykers against a Russian-pattern
opposing force with T-90Ms, BMP-3s, Kornet teams and drone operators.

As in Close Combat, the soldiers are people, not robots. Under fire they become suppressed and
pinned, and they may cower, panic, rout or surrender. Winning means keeping your own men
functional while you break the enemy's will to fight.

All units, places and events are fictional.

## Running it

```bash
npm install
npm run dev          # http://127.0.0.1:5173
npm run server       # multiplayer relay on :3004 (the dev server forwards /ws to it)
npm run build        # production build in dist/
npm test             # simulation unit/integration tests
```

Useful URL flags:
- `?quick=<mapId>&side=nato|opfor` jumps straight into a quick battle. Map IDs: `veldmark`,
  `zonbrug`, `hollen`, `maasbrug`, `nordhaven`, `arnholt`.
- `?timer=1` drives the game loop from a `MessageChannel` instead of `requestAnimationFrame`. Use
  it for automated testing in hidden or occluded browser windows.
- `?light=morning|noon|afternoon|overcast|dusk` sets the time of day and weather for a quick
  battle.

## Game modes

- **Multiplayer.** Two players online, from the Multiplayer menu:
  - **Head to head:** one player commands NATO, the other OPFOR.
  - **Co-op vs AI:** both command units on one side against the AI.
  - **Setup:** host a game and send the invite link or 4-letter code; each player requisitions their own force in the lobby.
  - **Pausing:** anyone can pause; the battle resumes when everyone has resumed.
  - **Dropouts:** reloading or a dropped connection rejoins the battle in progress; a player who leaves is replaced by their partner or the AI.

- **Operation Iron Corridor (campaign).** Six sectors along Route Iron, played over seven days
  with two turns per day. Air assault battalions hold ground at Veldmark, Hollen and far-off
  Arnholt while Task Force Iron fights up the highway to relieve them.
  - **Orders.** Each turn you give every battlegroup Advance, Hold, Rest & Refit or Withdraw.
  - **Engagements.** You fight each engagement yourself or auto-resolve it. Auto-resolve runs the
    same simulation, AI against AI.
  - **Persistence.** Casualties, knocked-out vehicles, experience and kill tallies carry over
    between battles.
  - **Operational rules.** Bridges can be blown, and armour can't cross until engineers repair
    them. Cut-off units get no replacements. Beaten defenders fall back, or are overrun if they
    are surrounded.
  - **Reserves.** Reinforcements arrive for both sides. NATO gets a second air assault lift, a
    Stryker company and a Polish airborne brigade dropping at Arnholt on Day 4. OPFOR commits
    an armoured counter-attack at Hollen, fresh tanks at Arnholt and a second-echelon motor rifle
    battalion.
  - **Victory.** The outcomes are Success (link-up with Arnholt), Partial Success, *A Bridge Too
    Far* (the corridor is pushed deep but Arnholt falls), Stalemate or Failure. You can play
    either side.
- **Quick Battle.** Pick any of the six battlefields, or roll a **random battlefield**: a
  generated village and river valley with roads, woods, hedgerows and objectives. Then choose a
  side, the enemy's quality and a time limit, and requisition your force within a points budget.

## Controls (in battle)

| Input | Action |
|---|---|
| Left-click / drag | Select a unit / box-select several (shift adds) |
| Right-click | Context order menu at that spot (enemy → Fire/Strike, friendly carrier → Mount) |
| M R C F K H B V | Move, Move Fast, Sneak, Fire, Smoke, Defend, Ambush, Reverse (then click a target) |
| T U J Y X | Call artillery, Recon drone, Drone strike, Mount/Dismount, Stop |
| L | Line-of-sight tool (range, clear/obstructed/blocked, hit chance) |
| WASD / arrows / edge, Q E, wheel | Pan, rotate, zoom (middle-drag rotates/tilts, shift+middle pans) |
| Space, 1–4 | Pause (orders still allowed), speed ❚❚/1×/2×/4× |
| Tab, Ctrl+digit / digit | Cycle units, assign/recall groups |

The in-game **Field Manual** (main menu) explains orders, morale, armour and victory conditions.

## Architecture

```
src/sim/      deterministic simulation — no DOM/Three.js; runs headless in tests & auto-resolve
  terrain.ts      grid terrain (4 m cells), cover/concealment, LOS with soft obstruction & smoke
  mapgen.ts       declarative map definitions → rasterised terrain, towns, rivers, bridges
  pathfinding.ts  A* with mobility classes, vehicle clearance, supercover path smoothing
  world.ts        entities + fixed 10 Hz tick
  spotting.ts     per-side fog of war (range, concealment, activity, thermals, drones)
  combat.ts       target selection, hitscan small arms, projectiles, HE blast, armour/ERA/APS/slat
  morale.ts       suppression, pinned/cowering/panic/rout/surrender/berserk, leadership
  orders.ts       CC-style orders → cover-seeking soldier slots, mount/dismount, abilities
  support.ts      off-map artillery, recon & strike drones (can be shot down), smoke, fires
  victory.ts      victory locations, force morale
  ai.ts           commander AI (attack: prep, overwatch, bounding, smoke, local superiority;
                  defend: garrison VLs, counter-attack) + self-preservation for player units
src/data/     weapons, vehicles, unit templates, factions, the six campaign maps
src/render/   Three.js view: terrain texture painter, instanced soldiers & trees, vehicle models,
              GPU particles/tracers, NATO symbols, overlays, RTS camera
src/game/     battle HUD/controller, campaign rules + UI, menus, quick battle, multiplayer lobby
src/net/      multiplayer: wire protocol, lockstep engine, shared session state, socket client
server/       Node server: serves the built game and relays multiplayer battles (rooms, steps, replay)
src/audio/    procedural WebAudio battlefield sound
tools/blender/  headless Blender scripts that build every 3D model (npm run models)
public/models/  exported .glb models + manifest
```

### Animation

Soldiers near the camera are skinned, rigged models driven by 20 animation clips: idle, aim and reload in each stance; walk, run and sneak; grenade throw; four deaths; wounded; cower; surrender. Each soldier's simulation state picks its clip: moving, stance, firing, reloading, pinned, surrendered or dead. Clips cross-fade, walk cycles are time-scaled to real ground speed, and rifles recoil and fire tracers from the actual muzzle. Distant soldiers use cheap instanced poses (budget: 160 animated on High, 60 on Performance).

Vehicle wheels, sprockets and idlers turn with distance travelled, and wheeled vehicles steer their front axle. Main guns recoil, the hull rocks when firing and pitches under acceleration or braking, and moving vehicles throw up dust and exhaust.

### Graphics

Each battle is lit by an analytic sky and a sun that casts cascaded shadows. The sky also
provides image-based ambient light and reflections, and the fog colour comes from the sky's
horizon. There are five time-of-day and weather presets. Post-processing adds ground-truth
ambient occlusion, HDR bloom on flashes, fire and tracers, ACES tone mapping and a per-preset
colour grade.

The ground has world-space detail and bump mapping by terrain type, plus GPU grass near the
camera. Trees are batched, with per-instance culling, a distant LOD and wind sway. Buildings
use PBR facades with glossy windows, doors and chimneys. Rivers have animated reflective water.
Render resolution adapts to hold the frame rate. See [docs/GRAPHICS.md](docs/GRAPHICS.md).

### 3D models

All vehicles, soldiers, trees, drones and weapon props are built procedurally by Blender Python
scripts. The rigged soldiers (skeleton, body and animation clips) come from
`tools/blender/mc_soldier_rig.py` (`npm run models:soldiers`). Run them with `npm run models`, which uses Blender 5.x in headless mode; see
[docs/MODELS.md](docs/MODELS.md) for the conventions. `tools/blender/previews/_contact_sheet.png`
shows every model.

### Unit pictures and weapon icons

Every unit type has a portrait in `public/portraits/<unit id>.webp`: its vehicle, or a few of its
soldiers posed with the unit's signature weapon. Blender renders them from the game's own models
and animation clips (`npm run portraits`, script `tools/blender/build_portraits.py`). Weapon
side-profile pictures are static SVGs in `public/icons/weapons/`, drawn by
`tools/icons/weapon_art.ts` (`npm run icons`). The game only references these files, so any of
them can be replaced by hand-made art.

They appear in:
- the battle roster and unit panel, where every soldier shows their weapons with ammo;
- the Quick Battle force selection, with a composition line for each unit and a full breakdown
  of any unit you click (soldiers and weapons, or armour, speed, protection, weapons and crew);
- the campaign battlegroup roster.

### Multiplayer

Multiplayer uses **deterministic lockstep**. Every player's browser runs the same battle, and
only commands cross the network.
- **Steps:** a command is stamped with the 0.1 s simulation step it takes effect on (0.3 s
  ahead, to hide latency), and no one runs a step until they have every player's commands for it.
- **Determinism:** the simulation uses only seeded randomness, and its trigonometry and
  exponentials (`src/sim/dmath.ts`) are built from exactly rounded IEEE operations. So Chrome,
  Firefox and Safari compute bit-identical battles.
- **Checksums:** exchanged every two seconds to detect any desync.
- **Relay:** `server/index.mjs` forwards steps, keeps rooms and logs commands. A player who
  reloads replays the battle from the log in a second or two and carries on.
- **Tests:** `tests/lockstep.test.ts` and `tests/relay.test.ts` cover sync over a laggy network,
  replay, drops and the relay protocol.

### Simulation tooling

These commands run AI against AI, headless:

```bash
npm run sim:batch                          # all maps × seeds, prints results/casualties
MAP=hollen SIDE=opfor npm run sim:trace    # per-unit order trace (KILLS=1 for kill attribution)
npm run sim:prof                           # per-subsystem timing
SEED=7 npm run sim:campaign                # a full automated operation
```

A 25-minute battle simulates in about 2–6 seconds, which is what makes auto-resolve practical.
