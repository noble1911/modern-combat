# 3D Model Specification

All models are generated **procedurally by Blender Python scripts** in `tools/blender/`
(run headless: `npm run models`) and exported as binary glTF to `public/models/<name>.glb`.
Nothing is hand-edited; the scripts are the source of truth.

## Conventions (must follow exactly — the game code relies on them)

* **Units:** 1 Blender unit = 1 metre. Real-world dimensions (an Abrams hull is ~7.9 m long, 3.7 m wide).
* **Orientation:** In Blender the model's **front faces +X**, up is **+Z**. (The glTF exporter
  converts to Y-up; the game expects the front along glTF +X.)
* **Origin:** at ground level (Z=0), centred on the footprint.
* **Style:** low-poly, faceted, flat-shaded "miniature wargame" look. Clean silhouettes matter more
  than detail; models are mostly seen from 40–200 m away at an oblique angle. Budget: vehicles
  ≤ 4k triangles, soldiers ≤ 800, trees ≤ 400.
* **Materials** (Principled BSDF, base colour only, roughness ~0.8; no image textures). Use these
  exact material names because the game re-tints them per faction:
  * `Paint` – main body/camo colour (default: NATO tan `#8a8466`; the game recolours for OPFOR)
  * `Dark` – tracks, tyres, gun barrels, vision blocks (`#2a2a28`)
  * `Metal` – weapon parts, fittings (`#4a4a48`)
  * `Glass` – optics/windows (`#2d3e4a`)
  * `Uniform` – soldier clothing (`#7a7a5a`, recoloured per faction)
  * `Gear` – soldier vest/helmet/pack (`#5a5a44`)
  * `Skin` – (`#c8a080`)
  * `Foliage` / `Trunk` – trees
* **Named nodes (vehicles):** every vehicle is a hierarchy, with object names:
  * `hull` – root visible body (parent of everything else; origin at ground centre)
  * `turret` – child of hull, **its origin placed at the turret ring centre** so rotating it about
    its local Z rotates the turret correctly. Vehicles with a remote weapon station instead of a
    turret still get a `turret` node (the RWS).
  * `gun` – child of turret, origin at the trunnion (gun pivot), barrel pointing +X so rotating
    about local Y elevates it.
  * `muzzle` – an Empty, child of `gun`, at the barrel tip (used for muzzle flash placement).
  * Wheeled vehicles: wheels are part of `hull` (no animation needed).
* Apply all transforms except for node origins described above. Do not apply modifiers that
  explode poly counts (no subdivision).

## Required models

| file | description | approx size (L×W×H) |
|---|---|---|
| `m1a2.glb` | M1A2 SEPv3 Abrams MBT: angular turret, long 120 mm gun, Trophy APS boxes on turret sides, side skirts, 7 road wheels | 7.9 × 3.7 × 2.4 (gun extends ~2.5 m forward) |
| `m2a4.glb` | M2A4 Bradley IFV: boxy hull with sloped front, small turret with 25 mm cannon, TOW launcher box on turret left side, 6 road wheels | 6.6 × 3.3 × 3.0 |
| `stryker.glb` | M1126 Stryker ICV: 8-wheeled, faceted hull, slat armour hint, small RWS with .50 cal on top | 7.0 × 2.7 × 2.6 |
| `jltv.glb` | JLTV: 4×4 armoured truck, cab + bed, RWS/ring mount with MG on roof | 6.2 × 2.5 × 2.6 |
| `t90m.glb` | T-90M: low rounded/wedge turret with ERA bricks (Relikt), long 125 mm gun, 6 road wheels, side skirts, rear fuel drums optional | 6.9 × 3.8 × 2.2 (gun extends ~2.7 m) |
| `t72b3.glb` | T-72B3: similar to T-90M but rounder cast turret with Kontakt-5 wedge blocks | 6.9 × 3.6 × 2.2 |
| `bmp3.glb` | BMP-3: low boat-like hull, turret with 100 mm + 30 mm guns side by side, 6 road wheels | 7.1 × 3.2 × 2.4 |
| `btr82a.glb` | BTR-82A: 8-wheeled boat-shaped APC with small turret and 30 mm cannon | 7.6 × 2.9 × 2.8 |
| `tigr.glb` | GAZ Tigr-M: 4×4 armoured car with roof MG | 5.7 × 2.4 × 2.4 |
| `soldier_stand.glb` | Infantryman standing, rifle held at low ready. Helmet, plate carrier, small pack. Front faces +X. | 1.8 tall |
| `soldier_kneel.glb` | Same soldier kneeling, rifle shouldered pointing +X | ~1.1 tall |
| `soldier_prone.glb` | Same soldier prone, rifle pointing +X, body along X axis (head toward +X) | ~0.4 tall, ~1.9 long |
| `soldier_dead.glb` | Soldier lying on back/side, no rifle in hands (rifle lying beside) | ~0.3 tall |
| `tree_oak.glb` | Deciduous tree, chunky faceted canopy (2–3 lumpy icospheres) | ~9 tall, canopy ~7 wide |
| `tree_pine.glb` | Conifer, stacked cones | ~12 tall |
| `bush.glb` | Low shrub cluster | ~1.5 tall, 2.5 wide |
| `drone_quad.glb` | Small quadcopter (recon / FPV), 4 arms and rotors, `Paint` body | 0.6 × 0.6 × 0.2 |
| `drone_fixed.glb` | Small fixed-wing UAS (Raven/Orlan-like), front +X | 1.2 long, 1.8 span |
| `mortar.glb` | 81/82 mm mortar on bipod + baseplate, tube pointing up-forward (+X,+Z) | ~1.2 long |
| `atgm_tripod.glb` | Kornet/TOW-style ATGM launcher on tripod, tube pointing +X | ~1.2 long, 1.0 tall |

Also export a `public/models/manifest.json`:

```json
{ "m1a2": { "file": "m1a2.glb", "tris": 3100, "size": [7.9, 3.7, 2.4] }, ... }
```

## Verification

The build script also renders a quick preview grid (`tools/blender/previews/*.png`, Workbench
engine, 3/4 view) of each model so a human (or agent) can eyeball silhouettes.

## Build notes

* Build: `npm run models` (Blender 5.2, headless; ~2 s). Scripts: `tools/blender/build_models.py`
  (driver), `mc_lib.py` (materials, bmesh primitives, export, previews), `mc_vehicles.py`,
  `mc_infantry.py` (joint-based poses + 2-bone IK), `mc_props.py` (trees, drones, weapons).
  Options after `--`: `--only m1a2,t90m`, `--no-preview`, `--pivot-dir DIR` (renders each
  vehicle with its turret yawed 60° and gun elevated 15° to check the pivots).
* Verify: `python3 tools/blender/verify_models.py` (plain Python, no Blender). It parses each GLB and checks
  node hierarchy/pivots, material names, triangle budgets, file size, face winding, bounds, grounding,
  approximate size vs the table above and the manifest. Exits non-zero on failure.
* Previews: `tools/blender/previews/<name>.png` plus `_contact_sheet.png` (all 20 models, table order).
* **Axes in the game (glTF / three.js):** Blender (x, y, z) → glTF (x, z, −y): front = +X, up = +Y,
  vehicle's left = −Z. `turret.rotation.y = +a` yaws the turret counter-clockwise seen from above
  (towards the vehicle's left); `gun.rotation.z = +e` elevates the barrel. Only the mortar's
  `muzzle` carries a rotation. No other node has rotation or scale.
* In three.js each named node loads as a `Group` holding one `Mesh` per material
  (`<node>_mesh`, `<node>_mesh_1`, …); `getObjectByName('turret')` returns the pivot group.
  `baseColorFactor` round-trips to the hex values above. Roughness is 0.8, except `Glass`, which is 0.35.
* Non-vehicle hierarchies: `soldier` → `muzzle` (stand/kneel/prone; `soldier_dead` has no muzzle).
  `tree_oak`, `tree_pine`, `bush`, `drone_quad` and `drone_fixed` are single nodes. `mortar` → `muzzle`
  sits at the tube mouth, local +X rotated up the tube at 55°. `atgm` → `turret` → `gun` → `muzzle`
  follows the same pivot rules as the vehicles. The BMP-3 also has `muzzle_30mm` (a child of `gun`)
  for the coaxial 30 mm.
* `manifest.json` per model: `file`, `kind`, `tris`, `size` = [L, W, H] in metres (vehicles exclude the
  `gun` subtree), `bounds` = full min/max in glTF axes, `nodes` = {name: {parent, translation (glTF)}}.
* Deviations from the size table, all deliberate and small:
  * Heights include sights, RWS, CITV and antennas, e.g. M1A2 turret roof 2.32 m, overall 2.74 m.
  * T-90M and T-72B3 lengths include the rear fuel drums (7.33 m; the hull alone is about 6.9 m).
  * `soldier_kneel` is 1.20 m tall (a realistic kneeling height for a 1.8 m figure).
  * `soldier_prone` is 2.34 m long including the rifle (the body is about 1.8 m).
  * `mortar` footprint is 1.05 m; the tube itself is 1.28 m long.

## Rigged, animated soldiers (v2)

Built by `tools/blender/mc_soldier_rig.py` via `npm run models:soldiers` (also part of `npm run models`).

* **Body:** a Skin-modifier mesh over the rest-pose joint graph, subdivided once (≈3.5k triangles),
  bound with automatic (heat) weights. Bevelled gear (plate carrier, pouches, helmet, headset, NVG
  mount, boots, gloves) is rigidly bound to single bones and joined into the same mesh.
* **Skeleton:** 19 bones — `root, hips, spine, chest, neck, head, upperarm/forearm/hand_{L,R},
  thigh/shin/foot_{L,R}, weapon`. `weapon` is a child of `root` so the gun can move freely; hands
  are IK-placed on it in every pose.
* **Weapons:** separate skinned meshes `wpn_rifle|mg|sniper|launcher|javelin` (NATO) or
  `wpn_rifle|mg|sniper|launcher|rpg` (OPFOR), each with a `muzzle_<name>` empty on the weapon bone.
  The game shows one per soldier.
* **Clips (20):** idle/aim/reload × stand/kneel/prone, walk, run, sneak, throw, death_back/fwd/
  crumple/prone, wounded, cower, surrender. Authored as joint-position poses (2-bone IK for knees and
  elbows), converted to bone transforms and keyed at 20 fps. Locomotion speeds (m/s at timeScale 1):
  walk 1.6, run 3.64, sneak 0.7 — see `public/models/soldier_rig.json`.
* **Colour:** one material, vertex colours (`COLOR_0`) with 3D-noise camouflage; exported per faction:
  `soldier_rig_nato.glb`, `soldier_rig_opfor.glb`.
* **Far LOD:** posed, decimated static copies `soldier_{stand,kneel,prone,dead}_{side}.glb` for
  instanced drawing beyond the animation radius / budget.

## Wheel nodes (vehicles)

Road wheels, sprockets and idlers are separate child nodes of `hull` — `wheel_L0..n`,
`wheel_R0..n` (0 = front-most), `sprocket_L/R`, `idler_L/R` — each with its origin on the axle, so
the game spins them about their local axle and steers `wheel_*0` on wheeled vehicles.

## Graphics pass (v3)

Applies to every model built by `build_models.py` **except** the legacy static `soldier_{stand,kneel,prone,dead}.glb`
(unchanged; the rigged soldiers are described in v2). It supersedes the "Style", "Materials" and budget notes above
for these models. Implementation: `tools/blender/mc_finish.py` (run from `build_models.py`, table `FINISH`).

* **Materials** (at most two per model, base colour white, metallic 0, no textures):
  vehicles and props `Vehicle` (roughness 0.7) + `Glass` (0.2: periscopes, optics, windows, lamps);
  vegetation `Foliage` (0.85) + `Trunk` (0.9) (`bush*` has only `Foliage`).
* **Vertex colours:** `COLOR_0` (Blender attribute `Col`, float, face-corner domain), linear RGBA, alpha 1 —
  the final albedo *including* the baked AO (multiplier 0.6–1.0) and ground-contact darkening. Render with
  `vertexColors: true` (GLTFLoader enables it) and a white material colour; multiply `material.color` to tint
  (e.g. burnt). Paint is baked per model, not re-tinted per faction: NATO CARC tan `#a8956b`; T-90M/BMP-3
  Russian 3-tone (green `#556043`, sand `#877c52`, black `#2b2c25`, large crisp blobs cut into the mesh);
  T-72B3/BTR-82A/Tigr plain green `#4f5a3a`; drones grey, mortar/ATGM olive. On top: noise variation, lighter
  worn bevel edges, dust on up-facing surfaces, mud below ~0.9 m (radial, rotation-invariant on wheels), grime
  in occluded corners, fictional white tactical numbers/chevrons (7-segment plates).
* **Shading:** smooth, with custom split normals — do **not** force `flatShading`. Hard edges are 1–2 segment
  bevels (angle limit 30°, width ≈14 % of the part's thickness, ≤3 cm) plus Weighted Normals, so plates stay
  flat and edges catch the light; round parts (wheels, barrels, drums) are fully smooth. Foliage uses soft
  canopy/lobe-centred normals.
* **Nodes and pivots are unchanged** (`hull`, `turret`, `gun`, `muzzle`, `muzzle_30mm`, `wheel_L0..`,
  `sprocket_*`, `idler_*`, `atgm`/`mortar` trees): all 161 v2 node translations/parents are identical. Wheel
  meshes are centred on their axle and their AO is rotationally symmetric, so spinning them is safe; the turret
  still casts its baked AO on the deck in the rest pose.
* **Geometry:** individual track links, lathe road wheels with hubs, toothed sprockets, treaded tyres; ERA as
  separate bevelled bricks (T-90M Relikt, T-72B3 Kontakt-5), Abrams Trophy radar panels/launchers and CROWS,
  Bradley TOW box and BUSK tiles, Stryker slat cage of real bars, BMP-3 twin guns, trim vane and spare links,
  BTR-82A hatches, firing ports and searchlight; stowage (bags, crates, jerrycans, rolls), tow cables/hooks,
  lamps, periscopes, antennas, handholds.
* **Budgets:** vehicles ≤ 12,000 triangles (currently 5.8k–11.9k), props ≤ 2,000, `tree_oak`/`tree_birch` ≤ 450,
  `tree_pine` ≤ 350, `bush` ≤ 200. Vehicle GLBs are ~250–600 KB.
* **New models:** `tree_birch` (≈10 m, pale trunk, airy canopy) and far LODs `tree_oak_lod`, `tree_pine_lod`,
  `tree_birch_lod`, `bush_lod` (≤ 100 triangles, same origin/size/silhouette/colour scheme, for > ~250 m). Each
  is a single node named like its file.
* **Manifest** entries of v3 models add `materials`, `vertexColors: true`, `paintProbe` (a vertex on open,
  flat paint with its built colour and the scheme's linear paint, used by the verifier) and, for LODs, `lodOf`.
* **Pipeline** per model: per-primitive bevel → constrained-Delaunay densification of large visible painted faces
  (~0.58 m) → camouflage iso-contour cuts → Weighted Normals → Cycles AO bake to corner colours for all nodes at
  once over a ground plane (0.7 m for vehicles; corners buried inside other parts take their neighbours' AO) →
  albedo from the builders' face tags (`Paint`, `Plate`, `Rubber`, `Track`, `Metal`, `Barrel`, `Canvas`, `Wood`,
  `Mark`, `Glass`, `Lens`, `Light`, `Red`, …) → AO multiply → collapse to the final materials.
* **Build / verify:** `npm run models` ≈ 20 s for these models (+ the soldiers); previews render with EEVEE
  (sun + sky, AgX) so the vertex colours show as in game. `verify_models.py` additionally checks the material set
  and factors, `COLOR_0`/`NORMAL` on every primitive, colour plausibility and variation, smooth shading, normals
  vs winding, wheel pivots, LOD size and the paint probe read back from the GLB.
