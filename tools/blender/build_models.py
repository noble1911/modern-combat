"""Build every model in docs/MODELS.md and export it to public/models/<name>.glb.

Run headless:
    /Applications/Blender.app/Contents/MacOS/Blender --background --factory-startup \
        --python tools/blender/build_models.py [-- options]

Options (after "--"):
    --only m1a2,t90m     build a subset (manifest entries for the others are kept)
    --no-preview         skip the Workbench preview renders
    --pivot-dir DIR      additionally render vehicles with turret rotated / gun elevated
                         (sanity check for node pivots) into DIR

Outputs:
    public/models/<name>.glb, public/models/manifest.json,
    tools/blender/previews/<name>.png and previews/_contact_sheet.png
"""
import json
import math
import os
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

import importlib  # noqa: E402

import bpy  # noqa: E402

import mc_lib  # noqa: E402
import mc_finish  # noqa: E402
import mc_vehicles  # noqa: E402
import mc_infantry  # noqa: E402
import mc_props  # noqa: E402

for _m in (mc_lib, mc_finish, mc_vehicles, mc_infantry, mc_props):
    importlib.reload(_m)

ROOT = os.path.abspath(os.path.join(HERE, '..', '..'))
OUT_DIR = os.path.join(ROOT, 'public', 'models')
PREVIEW_DIR = os.path.join(HERE, 'previews')

# name, kind, builder
MODELS = [
    ('m1a2', 'vehicle', mc_vehicles.build_m1a2),
    ('m2a4', 'vehicle', mc_vehicles.build_m2a4),
    ('stryker', 'vehicle', mc_vehicles.build_stryker),
    ('jltv', 'vehicle', mc_vehicles.build_jltv),
    ('t90m', 'vehicle', mc_vehicles.build_t90m),
    ('t72b3', 'vehicle', mc_vehicles.build_t72b3),
    ('bmp3', 'vehicle', mc_vehicles.build_bmp3),
    ('btr82a', 'vehicle', mc_vehicles.build_btr82a),
    ('tigr', 'vehicle', mc_vehicles.build_tigr),
    ('soldier_stand', 'soldier', mc_infantry.build_stand),
    ('soldier_kneel', 'soldier', mc_infantry.build_kneel),
    ('soldier_prone', 'soldier', mc_infantry.build_prone),
    ('soldier_dead', 'soldier', mc_infantry.build_dead),
    ('tree_oak', 'tree', mc_props.build_tree_oak),
    ('tree_pine', 'tree', mc_props.build_tree_pine),
    ('tree_birch', 'tree', mc_props.build_tree_birch),
    ('bush', 'tree', mc_props.build_bush),
    ('tree_oak_lod', 'tree', mc_props.build_tree_oak_lod),
    ('tree_pine_lod', 'tree', mc_props.build_tree_pine_lod),
    ('tree_birch_lod', 'tree', mc_props.build_tree_birch_lod),
    ('bush_lod', 'tree', mc_props.build_bush_lod),
    ('drone_quad', 'prop', mc_props.build_drone_quad),
    ('drone_fixed', 'prop', mc_props.build_drone_fixed),
    ('mortar', 'prop', mc_props.build_mortar),
    ('atgm_tripod', 'prop', mc_props.build_atgm_tripod),
]
BUDGET = {'vehicle': 12000, 'soldier': 800, 'tree': 700, 'prop': 2000}
# per-model caps (vegetation is instanced ~3,700x per map and drawn in the main view + 2 shadow
# cascades; *_lod models are swapped in beyond ~250 m)
MODEL_BUDGET = {'tree_oak': 450, 'tree_birch': 450, 'tree_pine': 350, 'bush': 200,
                'tree_oak_lod': 100, 'tree_pine_lod': 100, 'tree_birch_lod': 100, 'bush_lod': 100}
LOD_OF = {'tree_oak_lod': 'tree_oak', 'tree_pine_lod': 'tree_pine', 'tree_birch_lod': 'tree_birch',
          'bush_lod': 'bush'}

# Graphics pass v3 (tools/blender/mc_finish.py): colour scheme per model.  Models listed here are
# bevelled, smooth-shaded, vertex-coloured (albedo x baked AO in COLOR_0) and use only the materials
# Vehicle/Glass (trees: Foliage/Trunk).  The legacy static soldiers keep the old flat format.
FINISH = {
    'm1a2': 'nato', 'm2a4': 'nato', 'stryker': 'nato', 'jltv': 'nato',
    't90m': 'opfor3', 't72b3': 'opfor', 'bmp3': 'opfor3', 'btr82a': 'opfor', 'tigr': 'opfor',
    'tree_oak': 'tree_oak', 'tree_pine': 'tree_pine', 'tree_birch': 'tree_birch', 'bush': 'bush',
    'tree_oak_lod': 'tree_oak', 'tree_pine_lod': 'tree_pine', 'tree_birch_lod': 'tree_birch', 'bush_lod': 'bush',
    'drone_quad': 'grey', 'drone_fixed': 'grey', 'mortar': 'olive', 'atgm_tripod': 'olive',
}
NO_GROUND = {'drone_quad', 'drone_fixed'}   # flying: no ground-contact occlusion


def parse_args():
    argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
    opts = {'only': None, 'preview': True, 'pivot_dir': None}
    i = 0
    while i < len(argv):
        a = argv[i]
        if a == '--only':
            opts['only'] = set(argv[i + 1].split(','))
            i += 1
        elif a == '--no-preview':
            opts['preview'] = False
        elif a == '--pivot-dir':
            opts['pivot_dir'] = argv[i + 1]
            i += 1
        i += 1
    return opts


def gltf_bounds(mn, mx):
    # Blender (x, y, z) -> glTF (x, z, -y)
    return {'min': [round(mn.x, 3), round(mn.z, 3), round(-mx.y, 3)],
            'max': [round(mx.x, 3), round(mx.z, 3), round(-mn.y, 3)]}


def main():
    opts = parse_args()
    os.makedirs(OUT_DIR, exist_ok=True)
    os.makedirs(PREVIEW_DIR, exist_ok=True)
    manifest_path = os.path.join(OUT_DIR, 'manifest.json')
    old = {}
    if opts['only'] and os.path.exists(manifest_path):
        with open(manifest_path) as fh:
            old = json.load(fh)

    manifest = {}
    problems = []
    t_start = time.time()
    for name, kind, builder in MODELS:
        if opts['only'] and name not in opts['only']:
            if name in old:
                manifest[name] = old[name]
            continue
        mc_lib.reset_scene()
        t0 = time.time()
        root = builder()
        v3 = name in FINISH
        if v3:
            mc_finish.finish(root, FINISH[name], kind=kind, ground=name not in NO_GROUND)
        exclude = ('gun',) if kind == 'vehicle' else ()
        tris, (amn, amx), (bmn, bmx) = mc_lib.model_stats(root, exclude_names=exclude)
        path = os.path.join(OUT_DIR, name + '.glb')
        mc_lib.export_glb(path, root, vertex_colors=v3)
        nodes = {}
        for o in mc_lib.descendants(root):
            entry = {'parent': o.parent.name if o.parent else None,
                     'translation': mc_lib.to_gltf(o.location)}
            nodes[o.name] = entry
        size = [round(bmx.x - bmn.x, 2), round(bmx.y - bmn.y, 2), round(bmx.z - bmn.z, 2)]
        manifest[name] = {
            'file': name + '.glb',
            'kind': kind,
            'tris': tris,
            'size': size,
            'bounds': gltf_bounds(amn, amx),
            'nodes': nodes,
        }
        if v3:
            mats = sorted({m.name for o in mc_finish.mesh_objects(root) for m in o.data.materials})
            manifest[name]['materials'] = mats
            manifest[name]['vertexColors'] = True
            if 'paintProbe' in root:
                pr = json.loads(root['paintProbe'])
                pr['pos'] = mc_lib.to_gltf(pr['pos'])      # node-local, glTF axes
                manifest[name]['paintProbe'] = pr
        if name in LOD_OF:
            manifest[name]['lodOf'] = LOD_OF[name]
        kb = os.path.getsize(path) / 1024.0
        budget = MODEL_BUDGET.get(name, BUDGET[kind])
        if tris > budget:
            problems.append('%s: %d tris exceeds budget %d' % (name, tris, budget))
        print('[models] %-14s %5d tris  size L%.2f W%.2f H%.2f  %4.0f KB  %.1fs' % (
            name, tris, size[0], size[1], size[2], kb, time.time() - t0))

        if opts['preview']:
            mc_lib.render_preview(os.path.join(PREVIEW_DIR, name + '.png'), root,
                                  color_type='VERTEX' if v3 else 'MATERIAL', engine='EEVEE')
        if opts['pivot_dir'] and 'turret' in bpy.data.objects:
            os.makedirs(opts['pivot_dir'], exist_ok=True)
            tur, gun = bpy.data.objects['turret'], bpy.data.objects['gun']
            tur.rotation_euler = (0, 0, math.radians(60))
            gun.rotation_euler = (0, math.radians(-15), 0)   # negative about +Y = elevate
            mc_lib.render_preview(os.path.join(opts['pivot_dir'], name + '_pivot.png'), root,
                                  color_type='VERTEX' if v3 else 'MATERIAL', engine='EEVEE')
            tur.rotation_euler = (0, 0, 0)
            gun.rotation_euler = (0, 0, 0)

    ordered = {n: manifest[n] for n, _, _ in MODELS if n in manifest}
    with open(manifest_path, 'w') as fh:
        json.dump(ordered, fh, indent=2)
        fh.write('\n')

    if opts['preview']:
        pngs = [os.path.join(PREVIEW_DIR, n + '.png') for n, _, _ in MODELS
                if os.path.exists(os.path.join(PREVIEW_DIR, n + '.png'))]
        mc_lib.reset_scene()
        mc_lib.contact_sheet(pngs, os.path.join(PREVIEW_DIR, '_contact_sheet.png'))

    print('[models] built %d models in %.1fs -> %s' % (len(manifest), time.time() - t_start, OUT_DIR))
    for p in problems:
        print('[models] WARNING', p)


if __name__ == '__main__':
    main()
