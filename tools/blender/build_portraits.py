"""Render the unit portraits shown in the roster, unit panel and force selection.

    npm run portraits
    (Blender --background --factory-startup --python tools/blender/build_portraits.py [-- --only us_rifle ...])

Each unit type gets a small posed scene built from the game's own exported models
(public/models/*.glb): a vehicle in three-quarter view, or a few soldiers from the rigged
soldier posed with the unit's signature weapon (animation clips from the rig), plus props such
as the mortar, the Kornet tripod or a drone. Rendered with Cycles on a transparent background
with a shadow catcher, to public/portraits/<unit id>.webp (880 x 400).

The table UNITS below is the single place to add or change a portrait. Positions are given in
screen terms: sx metres across the picture (+ right), dz metres towards the camera.
"""
import math
import os
import sys

import bpy
from mathutils import Vector

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
MODELS = os.path.join(ROOT, 'public', 'models')
OUT = os.path.join(ROOT, 'public', 'portraits')
W, H = 880, 400
FPS = 24
# all figures are shown at this frame of their clip (0.35 s in: aims are settled, idles mid-breath)
POSE_FRAME = 1 + round(0.35 * FPS)


def F(clip, weapon, sx, dz, rot=0.0, slung=False, **_):
    return dict(clip=clip, weapon=weapon, sx=sx, dz=dz, rot=rot, slung=slung)


def PROP(name, sx, dz, z=0.0, rot=0.0, scale=1.0, shadow=True):
    return dict(name=name, sx=sx, dz=dz, z=z, rot=rot, scale=scale, shadow=shadow)


def infantry(side, figures, props=()):
    return dict(side=side, figures=figures, props=list(props))


def vehicle(side, model):
    return dict(side=side, vehicle=model)


def rifle_squad(side):
    return infantry(side, [
        F('aim_kneel', 'rifle', 0.9, 0.4),
        F('aim_stand', 'rifle', -0.4, -0.8, rot=0.1, slung=True),
        F('aim_kneel', 'launcher' if side == 'nato' else 'rpg', -1.7, 0.5, rot=-0.1),
    ])


def crew(side):
    return infantry(side, [F('idle_stand', 'rifle', 0.5, 0.2, rot=0.3), F('idle_stand', 'rifle', -0.8, -0.4, rot=0.1, t=1.3)])


UNITS = {
    # ------------------------------------------------------------------ NATO
    'us_rifle': rifle_squad('nato'),
    'us_mg': infantry('nato', [F('aim_prone', 'mg', 0.5, 0.3), F('aim_kneel', 'rifle', -1.5, -0.4, rot=0.15)]),
    'us_javelin': infantry('nato', [F('aim_kneel', 'javelin', 0.5, 0.3), F('idle_kneel', 'rifle', -1.4, -0.4, rot=0.2)]),
    'us_gustaf': infantry('nato', [F('aim_kneel', 'launcher', 0.5, 0.3), F('idle_kneel', 'rifle', -1.4, -0.4, rot=0.2)]),
    'us_sniper': infantry('nato', [F('aim_prone', 'sniper', 0.4, 0.6), F('aim_prone', 'rifle', -1.1, -0.6, rot=0.1)]),
    'us_mortar': infantry('nato', [F('idle_kneel', 'rifle', -0.2, 0.7, rot=-0.5), F('aim_kneel', 'rifle', -1.6, -0.4, rot=0.2)],
                          [PROP('mortar', 1.0, 0.2, rot=0.3)]),
    'us_hq': infantry('nato', [F('idle_stand', 'rifle', 0.4, 0.0, rot=0.35), F('idle_kneel', 'rifle', -1.0, 0.6, rot=-0.9, t=1.1)]),
    'us_uas': infantry('nato', [F('idle_kneel', 'rifle', -0.3, 0.4, rot=0.2), F('aim_kneel', 'rifle', -1.6, -0.4, rot=0.1)],
                       [PROP('drone_quad', 1.2, 0.0, z=1.5, rot=0.6, scale=2.4, shadow=False)]),
    'us_crew': crew('nato'),
    'us_m1a2': vehicle('nato', 'm1a2'),
    'us_m2a4': vehicle('nato', 'm2a4'),
    'us_stryker': vehicle('nato', 'stryker'),
    'us_jltv': vehicle('nato', 'jltv'),
    # ------------------------------------------------------------------ OPFOR
    'ru_rifle': rifle_squad('opfor'),
    'ru_mg': infantry('opfor', [F('aim_prone', 'mg', 0.5, 0.3), F('aim_kneel', 'rifle', -1.5, -0.4, rot=0.15)]),
    'ru_kornet': infantry('opfor', [F('idle_kneel', 'rifle', -0.4, 0.5, rot=0.1), F('aim_kneel', 'rifle', -1.7, -0.4, rot=0.1)],
                          [PROP('atgm_tripod', 0.9, 0.2)]),
    'ru_ags': infantry('opfor', [F('aim_prone', 'mg', 0.5, 0.3), F('idle_kneel', 'rifle', -1.5, -0.4, rot=0.2)]),
    'ru_sniper': infantry('opfor', [F('aim_prone', 'sniper', 0.4, 0.6), F('aim_prone', 'rifle', -1.1, -0.6, rot=0.1)]),
    'ru_mortar': infantry('opfor', [F('idle_kneel', 'rifle', -0.2, 0.7, rot=-0.5), F('aim_kneel', 'rifle', -1.6, -0.4, rot=0.2)],
                          [PROP('mortar', 1.0, 0.2, rot=0.3)]),
    'ru_hq': infantry('opfor', [F('idle_stand', 'rifle', 0.4, 0.0, rot=0.35), F('idle_kneel', 'rifle', -1.0, 0.6, rot=-0.9, t=1.1)]),
    'ru_uas': infantry('opfor', [F('idle_kneel', 'rifle', -0.3, 0.4, rot=0.2), F('aim_kneel', 'rifle', -1.6, -0.4, rot=0.1)],
                       [PROP('drone_quad', 1.2, 0.0, z=1.5, rot=0.6, scale=2.4, shadow=False)]),
    'ru_crew': crew('opfor'),
    'ru_t90m': vehicle('opfor', 't90m'),
    'ru_t72b3': vehicle('opfor', 't72b3'),
    'ru_bmp3': vehicle('opfor', 'bmp3'),
    'ru_btr82a': vehicle('opfor', 'btr82a'),
    'ru_tigr': vehicle('opfor', 'tigr'),
}


def at(sx, dz):
    """Screen placement -> Blender ground position. The camera looks from (+x, -y), so screen
    right runs along (1, 1) and 'towards the camera' along (1, -1)."""
    return Vector(((sx + dz) / 2, (sx - dz) / 2, 0.0))


# ---------------------------------------------------------------------------- scene
def setup_scene():
    bpy.ops.wm.read_homefile(use_empty=True)
    sc = bpy.context.scene
    sc.render.engine = 'CYCLES'
    sc.render.fps = FPS
    try:
        prefs = bpy.context.preferences.addons['cycles'].preferences
        prefs.compute_device_type = 'METAL'
        prefs.get_devices()
        for d in prefs.devices:
            d.use = True
        sc.cycles.device = 'GPU'
    except Exception:
        pass
    sc.cycles.samples = 64
    sc.cycles.use_denoising = True
    sc.render.film_transparent = True
    sc.render.resolution_x, sc.render.resolution_y = W, H
    sc.render.resolution_percentage = 100
    sc.render.image_settings.file_format = 'WEBP'
    sc.render.image_settings.color_mode = 'RGBA'
    sc.render.image_settings.quality = 90
    sc.view_settings.view_transform = 'AgX'
    sc.view_settings.look = 'AgX - Medium High Contrast'
    sc.view_settings.exposure = 0.35
    # soft sky ambient
    world = bpy.data.worlds.new('Studio')
    world.use_nodes = True
    bg = world.node_tree.nodes['Background']
    bg.inputs['Color'].default_value = (0.55, 0.6, 0.66, 1)
    bg.inputs['Strength'].default_value = 0.55
    sc.world = world
    # warm key with soft shadows, cool rim from behind
    key = bpy.data.objects.new('Key', bpy.data.lights.new('Key', 'SUN'))
    key.data.energy = 4.2
    key.data.color = (1.0, 0.93, 0.84)
    key.data.angle = math.radians(9)
    key.rotation_euler = (math.radians(42), 0, math.radians(-35))
    rim = bpy.data.objects.new('Rim', bpy.data.lights.new('Rim', 'SUN'))
    rim.data.energy = 3.0
    rim.data.color = (0.78, 0.86, 1.0)
    rim.data.angle = math.radians(4)
    rim.rotation_euler = (math.radians(60), 0, math.radians(145))
    rim.data.use_shadow = False
    cam = bpy.data.objects.new('Cam', bpy.data.cameras.new('Cam'))
    cam.data.lens_unit = 'FOV'
    cam.data.sensor_fit = 'VERTICAL'
    cam.data.angle = math.radians(26)
    catcher = bpy.data.objects.new('Catcher', bpy.data.meshes.new('Catcher'))
    catcher.data.from_pydata([(-80, -80, 0), (80, -80, 0), (80, 80, 0), (-80, 80, 0)], [], [(0, 1, 2, 3)])
    catcher.is_shadow_catcher = True
    for o in (key, rim, cam, catcher):
        sc.collection.objects.link(o)
    sc.camera = cam
    return sc, cam


def import_glb(name):
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=os.path.join(MODELS, name + '.glb'))
    new = [o for o in bpy.data.objects if o not in before]
    for o in new:
        # the importer adds a bone-display widget mesh; never render it
        if o.type == 'MESH' and o.parent is None and not o.material_slots:
            o.hide_render = True
    return new


def top_level(objs):
    return [o for o in objs if o.parent is None and not o.hide_render]


def place(roots, pos, rot, scale=1.0):
    """Move a set of imported root objects together (about the origin)."""
    for r in roots:
        r.rotation_mode = 'XYZ'
        r.location = r.location + pos
        r.rotation_euler.z += rot
        r.scale = r.scale * scale


_rigs = {}


def rig(side):
    """Import the rigged soldier once per side; figures are linked copies of it."""
    if side not in _rigs:
        objs = import_glb('soldier_rig_' + side)
        arm = next(o for o in objs if o.type == 'ARMATURE')
        for o in objs:
            o.hide_render = True
            o.hide_viewport = True
        _rigs[side] = (arm, [o for o in objs if o.parent == arm and o.type == 'MESH'])
    return _rigs[side]


def figure(side, f):
    src, meshes = rig(side)
    arm = src.copy()
    arm.animation_data_clear()
    bpy.context.scene.collection.objects.link(arm)
    arm.hide_render = arm.hide_viewport = False
    made = [arm]
    for m in meshes:
        c = m.copy()
        bpy.context.scene.collection.objects.link(c)
        c.parent = arm
        for mod in c.modifiers:
            if mod.type == 'ARMATURE':
                mod.object = arm
        base = m.name.split('.')[0]  # a second side's import gets '.001' suffixes
        show = base == 'body' or base == 'wpn_' + f['weapon'] or (base == 'slung_launcher' and f['slung'])
        c.hide_render = c.hide_viewport = not show
        made.append(c)
    act = bpy.data.actions.get(f['clip']) or bpy.data.actions['idle_stand']
    ad = arm.animation_data_create()
    ad.action = act
    if not ad.action_slot and len(act.slots):
        ad.action_slot = act.slots[0]
    arm.location = at(f['sx'], f['dz'])
    arm.rotation_mode = 'XYZ'
    arm.rotation_euler = (0, 0, f['rot'])
    return made


def visible_points(objs, step_target=600):
    """Posed world-space vertices of the rendered meshes (evaluated: armatures applied)."""
    dg = bpy.context.evaluated_depsgraph_get()
    pts = []
    for o in objs:
        if o.type != 'MESH' or o.hide_render:
            continue
        ev = o.evaluated_get(dg)
        me = ev.to_mesh()
        n = len(me.vertices)
        step = max(1, n // step_target)
        mw = ev.matrix_world
        for i in range(0, n, step):
            pts.append(mw @ me.vertices[i].co)
        ev.to_mesh_clear()
    return pts


def frame_camera(cam, pts, direction, fill_x=0.88, fill_y=0.80):
    """Aim along `direction` and fit the silhouette of pts into the frame, centred."""
    from bpy_extras.object_utils import world_to_camera_view
    sc = bpy.context.scene
    lo = Vector((min(p.x for p in pts), min(p.y for p in pts), min(p.z for p in pts)))
    hi = Vector((max(p.x for p in pts), max(p.y for p in pts), max(p.z for p in pts)))
    target = (lo + hi) / 2
    d = direction.normalized()
    dist = (hi - lo).length * 2.2 + 1
    aspect = W / H
    tan_v = math.tan(cam.data.angle / 2)
    for _ in range(7):
        cam.location = target + d * dist
        cam.rotation_euler = (-d).to_track_quat('-Z', 'Y').to_euler()
        bpy.context.view_layer.update()
        xs, ys = [], []
        for p in pts:
            v = world_to_camera_view(sc, cam, p)
            xs.append(v.x * 2 - 1)
            ys.append(v.y * 2 - 1)
        x0, x1, y0, y1 = min(xs), max(xs), min(ys), max(ys)
        mat = cam.matrix_world.to_3x3()
        right, up = mat.col[0], mat.col[1]
        target = target + right * ((x0 + x1) / 2 * dist * tan_v * aspect) + up * ((y0 + y1) / 2 * dist * tan_v)
        dist *= max((x1 - x0) / 2 / fill_x, (y1 - y0) / 2 / fill_y)
    cam.location = target + d * dist
    cam.rotation_euler = (-d).to_track_quat('-Z', 'Y').to_euler()
    cam.data.clip_start = max(0.05, dist * 0.05)
    cam.data.clip_end = dist * 4


def clear(objs):
    for o in objs:
        bpy.data.objects.remove(o, do_unlink=True)


def render_unit(uid, spec, cam):
    made = []
    if 'vehicle' in spec:
        objs = import_glb(spec['vehicle'])
        made += objs
        for o in objs:
            if o.name.split('.')[0] == 'turret':
                o.rotation_mode = 'XYZ'
                o.rotation_euler.z += 0.3
        place(top_level(objs), Vector((0, 0, 0)), -0.15)
        direction = Vector((0.95, -1.0, 0.5))
    else:
        for f in spec['figures']:
            made += figure(spec['side'], f)
        for p in spec['props']:
            objs = import_glb(p['name'])
            made += objs
            place(top_level(objs), at(p['sx'], p['dz']) + Vector((0, 0, p['z'])), p['rot'], p['scale'])
            if not p['shadow']:
                for o in objs:
                    o.visible_shadow = False
        direction = Vector((0.95, -1.0, 0.42))
    bpy.context.scene.frame_set(POSE_FRAME)
    bpy.context.view_layer.update()
    pts = visible_points(made)
    frame_camera(cam, pts, direction)
    bpy.context.scene.render.filepath = os.path.join(OUT, uid + '.webp')
    bpy.ops.render.render(write_still=True)
    clear(made)
    print('[portrait] %s' % uid)


def main():
    argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
    only = set(argv[argv.index('--only') + 1:]) if '--only' in argv else None
    os.makedirs(OUT, exist_ok=True)
    sc, cam = setup_scene()
    for uid, spec in UNITS.items():
        if only and uid not in only:
            continue
        render_unit(uid, spec, cam)


main()
