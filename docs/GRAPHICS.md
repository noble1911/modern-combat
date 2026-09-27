# Rendering

How a battle is drawn, from sky to screen. All of it lives in `src/render/`. `BattleView` owns
the renderer and composes the layers.

## Light: `atmosphere.ts`

- **Sky.** three's Preetham `Sky` supplies the clouds, and its radiance is scaled into scene
  units (`SKY_SCALE`). Unscaled, the analytic sky is about 20 times brighter than sunlit ground.
- **Sun.** The sun is a `SunLight` (three/examples) with two shadow cascades fitted to the view
  frustum. The shadow range, `shadow.camera.far`, follows the camera zoom, so close-ups get
  crisp shadows and overviews still reach the horizon.
- **Ambient light.** A PMREM environment map is rendered once from the same sky, plus a ground
  disc for bounce light. It serves as `scene.environment`, giving diffuse and specular IBL for
  every PBR material: soft sky fill, glossy windows and water reflections. No hemisphere light
  is used.
- **Fog.** The `FogExp2` colour is read back from the rendered sky at the horizon as half-floats,
  so distant terrain dissolves into the sky seamlessly.
- **Presets.** `LIGHTING` holds Morning, Midday, Afternoon, Overcast and Dusk. Each sets sun
  angle, colour and intensity, sky turbidity, clouds, ambient strength, fog, exposure, a colour
  grade and a smoke tint. Campaign morning turns use morning light; afternoon turns use
  afternoon or dusk; roughly one day in five is overcast. Quick battles derive a preset from the
  seed, and `?light=<id>` overrides it.

## Post-processing: `post.ts`

The scene renders into a half-float render target with 2× MSAA (none on Performance) and a depth
texture. The chain is:

1. **GTAO**, ground-truth ambient occlusion at half resolution. Normals are reconstructed from
   the scene depth, so no extra geometry pass is needed. The radius is 2.2 m, which darkens
   contact under vehicles, wall bases, hedge bottoms and corners.
2. **Bloom** (`UnrealBloomPass`). The threshold sits above 1.0 in linear HDR, so only emissive
   things glow: muzzle flashes, fire and explosions (the fire particle shader boosts them ×2.6),
   tracer heads (×4), sun glints on water and the sun disc.
3. **Output.** ACES tone mapping and sRGB conversion.
4. **Grade.** Per-preset saturation, contrast, shadow lift, highlight gain, plus a light
   vignette and grain.

Settings can turn off post-processing and AO. The Performance preset defaults both to off.

`BattleView.adaptResolution` lowers the pixel ratio in 0.125 steps (never below 1.0) while
frames run slower than about 45 fps. It raises it back towards the maximum (1.5× with post, 2×
without, on High) after a sustained stretch at about 60 fps.

## Ground: `groundDetail.ts`, `grass.ts`

- **Terrain texture.** The painted 4K map texture (`MapPainter`) still supplies layout and colour.
- **Info texture.** A 2 m per texel `terrainInfoTexture` records detail and bump amount, leaf
  litter and grass density per terrain type. Roads, rivers and building plots are painted over
  it with the painter's own shapes, so grass stops exactly at the asphalt.
- **Detail.** `applyGroundDetail` samples a tileable procedural detail texture in world space at
  three scales (2 m, 9 m and 57 m). It modulates the albedo and perturbs the normal from the
  detail height gradient, so tussocks, ruts and furrows catch low sun.
- **Grass.** `GrassField` draws about 23,000 tufts of five blades in one instanced draw, inside a
  window around the camera focus. Instances wrap on a fixed world grid, so the field stays still
  while the camera pans. The vertex shader looks up height (a float texture of corner
  elevations), density (the info texture) and colour (the map texture), and adds wind sway.
  Grass fades out as the camera pulls back past about 150 m.

## Vegetation: `vegetation.ts`

Trees and bushes are grouped into 160 m chunks, one `BatchedMesh` per chunk. Each chunk is a
single multi-draw call, culled as a whole by its bounding sphere for the camera and for each
shadow cascade. Per-instance culling and sorting of about 3,800 plants cost about 5 ms of CPU
per frame, which is why chunks are used instead. Plants beyond 260 m swap to their
`<model>_lod` geometry, checked four times a second with hysteresis.

The vertex shader adds wind sway, stronger with height, plus leaf flutter. A `tintMask`
attribute limits per-instance colour variation to foliage. Leaves get a translucency term when
the camera looks towards the sun, and extra sky fill (`envMapIntensity` 1.5), so backlit
canopies don't turn into black blobs. Vehicles the player can see flatten any plants they
overlap (`Vegetation.flatten`), including at deployment, so tanks parked in woods sit in a
clearing instead of clipping through canopies.

Hedgerows are overlapping, lumpy, smooth-shaded blobs with spherical normals, built in
`TerrainView.buildLinear`.

## Buildings: `facades.ts`

Procedural PBR sets (albedo, normal map, roughness map) for rendered plaster, brick and pantile
roofs. One wall tile is one 4 m window bay by one 3.2 m storey. Window glass is glossy, so it
reflects the sky environment. Vertex colours tint the near-white albedo per building.
`rebuildBuildings` adds a plinth, doors with frames and steps between ground-floor windows,
roof ridge caps, chimneys, and plain gable ends.

## Water: `water.ts`

Glossy PBR water with two ripple normal-map layers drifting downstream at different speeds.
Reflections and fresnel come from the sky environment, and sun glints feed the bloom. Alpha
fades toward both banks.

## Models

Vehicles, trees and props carry albedo, including baked AO and grime, in vertex colours. See
[MODELS.md](MODELS.md). `ModelLib` keys tinted materials by the source material, not the
material name, and forces the base colour of vertex-coloured materials to white, so the
albedo is never tinted twice.

## Performance notes

- Use `?timer=1` in hidden or automated windows (see the README).
- The main costs are pixel fill (MSAA HDR plus AO) and the two shadow cascades. The cascades
  default to 3072² on High and 2048² on Performance. Road wheels of tracked vehicles don't cast
  shadows, because the skirts hide them.
- Vehicles leave ruts on soft ground, painted into the map canvas. Uploading that canvas is
  effectively free in Chrome, where the canvas stays on the GPU. Ruts and tree flattening only
  happen for vehicles the player can see, so neither gives away hidden enemies.

## UI art: portraits and weapon pictures

- **Unit portraits.** `tools/blender/build_portraits.py` (`npm run portraits`, about 2–3 minutes)
  imports the exported GLBs. For infantry it makes linked copies of the rigged soldier, one per
  figure, each with its own animation action and only its weapon mesh visible. It adds props (the
  mortar, the Kornet tripod, a drone), then fits the camera to the projected posed vertices, not
  the bounding box, which is far too loose for a three-quarter view. Output is Cycles with a shadow
  catcher on a transparent background, saved as `public/portraits/<unit id>.webp` at 880×400.
  The `UNITS` table in the script is the single place to change a scene; figures are placed in
  screen terms (metres across the picture and towards the camera). The UI draws each portrait over
  a soft vignette (`PORTRAIT_BACKDROP`), so a missing file just shows the backdrop.
- **Weapon pictures.** `tools/icons/weapon_art.ts` draws side profiles from simple shapes on a
  shared 120 × 36 scale, so an M240 is visibly longer than an M4. Grenades get a tighter crop.
  Fills use material gradients (black polymer, steel, FDE, olive, wood), and a faint light rim keeps
  dark guns readable on the dark HUD. `npm run icons` writes one SVG per weapon to
  `public/icons/weapons/`. `src/ui/weaponIcons.ts` maps weapon ids to files; vehicle guns share
  class pictures (tank gun, autocannon, missile, heavy MG, grenade launcher, coax).
- **Where they're used.** `src/ui/unitInfo.ts` builds the shared pieces: the one-line composition
  summary, the per-soldier weapon cell (primary picture with ammo, secondaries small below) and
  the full unit breakdown.
