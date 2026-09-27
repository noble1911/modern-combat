"""Graphics pass v3: turns the builders' tagged, faceted solids into smooth-shaded, bevelled,
vertex-coloured models with baked ambient occlusion (Blender 5.x, headless).

Pipeline per model (``finish(root, scheme)``):

1. **Bevel** — every primitive added through ``VPart`` records a bevel width / segment count in
   face layers (auto: ~14 % of the primitive's thickness, capped per Part).  Edges sharper than
   30° (50° for round primitives) are bevelled with ``bmesh.ops.bevel``; the new faces are tagged
   as "edge" faces (paint wear).
2. **Density** — long edges of painted faces are split until no edge is longer than ``max_edge`` so
   the camouflage / mud / AO have vertices to live on.
3. **Normals** — smooth shading + Weighted Normal (face area): big flat plates stay flat, the
   bevel strips blend between them so edges catch the light; round parts are fully smooth.
4. **AO** — Cycles bakes ambient occlusion into a corner colour attribute for all nodes at once
   (with a ground plane, so the turret shadows the deck and the running gear gets contact
   occlusion).  Wheels are made rotationally symmetric so spinning them looks right.
5. **Colour** — per-corner albedo from the face tag + 3D noise (camouflage, variation, dust on
   upward faces, mud near the ground, grime in occluded areas, lighter worn edges), multiplied by
   the AO and a ground-contact term, written to the single colour attribute ``Col`` (glTF
   ``COLOR_0``, linear RGBA).
6. **Materials** — tags collapse into ``Vehicle`` (+ ``Glass``) or ``Foliage`` / ``Trunk``, all
   white base colour driven by the vertex colours.
"""
import json
import math
import random
import re
from collections import defaultdict

import bpy
import bmesh
import numpy as np
from mathutils import Vector

import mc_lib
from mc_lib import Part

V = Vector

# --------------------------------------------------------------------------------------
# Tags (temporary per-face "materials" used by the builders; collapsed on export)
# --------------------------------------------------------------------------------------
EXTRA_TAGS = {
    'Plate': '#97855f',     # non-slip / armour plates, a shade darker than Paint
    'Rubber': '#262624',    # tyres, rubber skirts, track pads
    'Track': '#3a3632',     # steel track links
    'Barrel': '#3a3a36',    # gun tubes, MG barrels
    'Canvas': '#6f6547',    # bags, tarps, rolled cam nets
    'Light': '#d8d4c0',     # headlight lenses
    'Red': '#7a1c14',       # tail lights
    'Lens': '#16222c',      # optics
    'Mark': '#e8e4d8',      # white tactical markings
    'MarkY': '#d9b43a',     # yellow markings
    'Cable': '#34322e',     # tow cables
    'Birch': '#d8d4c8',     # birch bark
    'Prop': '#2b2b2b',      # drone propellers
    'Wood': '#5c4a33',      # unditching log, tool handles
}
for _k, _c in EXTRA_TAGS.items():
    mc_lib.MAT_COLORS.setdefault(_k, _c)

GLASS_TAGS = {'Glass', 'Lens', 'Light', 'Red'}
PAINT_TAGS = {'Paint', 'Plate'}
DENSE_TAGS = {'Paint', 'Plate', 'Canvas', 'Foliage', 'Trunk', 'Birch'}
SPIN_RE = re.compile(r'^(wheel_|sprocket_|idler_)')


# --------------------------------------------------------------------------------------
# VPart: Part that records per-primitive bevel settings
# --------------------------------------------------------------------------------------
class VPart(Part):
    """Part whose primitives remember how they should be bevelled.

    ``bevel``: None = automatic (≈14 % of the primitive's thickness, capped at ``bevel_max``),
    0 = never, >0 = explicit width.  ``segs``: None = auto (2 for widths ≥ 12 mm)."""

    def __init__(self, offset=(0, 0, 0), bevel_max=0.025, bevel=None, segs=None):
        super().__init__(offset)
        L = self.bm.faces.layers
        self.l_bev = L.float.new('bev')
        self.l_seg = L.int.new('bseg')
        self.l_pid = L.int.new('pid')
        self.l_rnd = L.int.new('rnd')
        self.bevel_max = bevel_max
        self.min_bevel_thickness = 0.1
        self.bevel = bevel
        self.segs = segs
        self.pid = 0
        self._round = 0

    class _Style:
        def __init__(self, part, kw):
            self.part, self.kw, self.old = part, kw, {}

        def __enter__(self):
            for k, v in self.kw.items():
                self.old[k] = getattr(self.part, k)
                setattr(self.part, k, v)
            return self.part

        def __exit__(self, *a):
            for k, v in self.old.items():
                setattr(self.part, k, v)

    def style(self, **kw):
        """Temporarily override bevel / bevel_max / segs:  ``with P.style(bevel=0): ...``"""
        return VPart._Style(self, kw)

    def _thickness(self, fs):
        pts = [v.co for f in fs for v in f.verts]
        faces = sorted(fs, key=lambda f: -f.calc_area())[:10]
        best = math.inf
        for f in faces:
            f.normal_update()
            n = f.normal
            if n.length < 0.5:
                continue
            d = [n.dot(p) for p in pts]
            best = min(best, max(d) - min(d))
        return best if best < math.inf else 0.0

    def add(self, verts, faces, mat, closed=True):
        fs = super().add(verts, faces, mat, closed)
        self.pid += 1
        th = self._thickness(fs) if (self.bevel is None or self.segs is None) else 0.0
        if self.bevel is None:
            # small parts stay unbevelled (flat, crisp) -- their bevels would cost triangles
            # without being visible at game distances
            w = min(self.bevel_max, 0.14 * th) if th >= self.min_bevel_thickness else 0.0
        else:
            w = self.bevel
        s = self.segs if self.segs is not None else (2 if th >= 0.35 and w >= 0.015 else 1)
        for f in fs:
            f[self.l_bev] = w
            f[self.l_seg] = s
            f[self.l_pid] = self.pid
            f[self.l_rnd] = self._round
        return fs

    def _rounded(self, fn, *a, **k):
        self._round += 1
        try:
            return fn(*a, **k)
        finally:
            self._round -= 1

    def cyl(self, *a, **k):
        return self._rounded(super().cyl, *a, **k)

    def tube(self, *a, **k):
        return self._rounded(super().tube, *a, **k)

    def ico(self, *a, **k):
        return self._rounded(super().ico, *a, **k)

    def dome(self, *a, **k):
        return self._rounded(super().dome, *a, **k)


# --------------------------------------------------------------------------------------
# Noise (numpy, vectorised)
# --------------------------------------------------------------------------------------
_M1 = np.uint64(0xff51afd7ed558ccd)
_M2 = np.uint64(0xc4ceb9fe1a85ec53)
_S33 = np.uint64(33)


def _hash3(i, j, k, seed):
    n = (i.astype(np.uint64) * np.uint64(73856093)) ^ (j.astype(np.uint64) * np.uint64(19349663)) \
        ^ (k.astype(np.uint64) * np.uint64(83492791)) ^ np.uint64((seed * 2654435761) & 0xFFFFFFFFFFFF)
    n ^= n >> _S33
    n *= _M1
    n ^= n >> _S33
    n *= _M2
    n ^= n >> _S33
    return (n >> np.uint64(11)).astype(np.float64) / float(1 << 53)


def vnoise(P, seed=0):
    """3D value noise in [0, 1] for an (N, 3) array."""
    P = np.asarray(P, dtype=np.float64)
    Pi = np.floor(P)
    F = P - Pi
    Pi = Pi.astype(np.int64)
    F = F * F * (3 - 2 * F)
    acc = np.zeros(len(P))
    for dx in (0, 1):
        wx = F[:, 0] if dx else 1 - F[:, 0]
        for dy in (0, 1):
            wy = F[:, 1] if dy else 1 - F[:, 1]
            for dz in (0, 1):
                wz = F[:, 2] if dz else 1 - F[:, 2]
                acc += wx * wy * wz * _hash3(Pi[:, 0] + dx, Pi[:, 1] + dy, Pi[:, 2] + dz, seed)
    return acc


def fbm(P, octaves=3, seed=0, lac=2.03, gain=0.5):
    P = np.asarray(P, dtype=np.float64)
    tot, amp, norm = np.zeros(len(P)), 1.0, 0.0
    for o in range(octaves):
        tot += amp * vnoise(P * (lac ** o) + o * 17.13, seed + o * 101)
        norm += amp
        amp *= gain
    return tot / norm


def smoothstep(e0, e1, x):
    t = np.clip((x - e0) / (e1 - e0), 0.0, 1.0)
    return t * t * (3 - 2 * t)


def _quantiles(fn, qs, seed=5):
    rng = np.random.default_rng(seed)
    P = rng.uniform(-6, 6, size=(20000, 3))
    v = fn(P)
    return [float(np.quantile(v, q)) for q in qs]


def hexc(h):
    h = h.lstrip('#')
    return np.array([int(h[i:i + 2], 16) / 255.0 for i in (0, 2, 4)])


def srgb_to_lin(c):
    c = np.clip(c, 0.0, 1.0)
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def mix(a, b, t):
    t = np.asarray(t)[..., None] if np.ndim(t) else t
    return a + (b - a) * t


# --------------------------------------------------------------------------------------
# Colour schemes
# --------------------------------------------------------------------------------------
COMMON = {
    'Rubber': '#282826', 'Track': '#3b3833', 'Dark': '#2e2e2b', 'Metal': '#4c4b46', 'Barrel': '#383834',
    'Glass': '#1d2a33', 'Lens': '#142029', 'Light': '#d9d5c3', 'Red': '#7a1c14', 'Mark': '#e6e2d6',
    'MarkY': '#d4b03c', 'Cable': '#302e2a', 'Prop': '#262626', 'Wood': '#5c4a33',
    'mud': '#5b4b37', 'mud2': '#463a2b', 'grime': '#3a342a',
}
SCHEMES = {
    'nato': dict(COMMON, Paint='#a8956b', Plate='#978660', dust='#b3a07a',
                 Canvas=['#6f6547', '#7d7152', '#5f5a42', '#857a5a'], camo=None),
    # Russian 3-tone: green / sand / black, large soft blobs
    'opfor3': dict(COMMON, Paint='#556043', Plate='#4d573c', dust='#8c8266',
                   Canvas=['#4d5236', '#5a5a40', '#454a33', '#62603f'], camo=('#556043', '#877c52', '#2b2c25')),
    'opfor': dict(COMMON, Paint='#4f5a3a', Plate='#475135', dust='#8a8064',
                  Canvas=['#4d5236', '#5a5a40', '#454a33', '#62603f'], camo=None),
    'olive': dict(COMMON, Paint='#545a3c', Plate='#4a5036', dust='#8a8064',
                  Canvas=['#4d5236', '#5a5a40'], camo=None),
    'grey': dict(COMMON, Paint='#5d6264', Plate='#4a4e50', dust='#8a877c',
                 Canvas=['#4d5236', '#5a5a40'], camo=None),
}

_CAMO_Q = None


def _camo_fields(P):
    q = P * np.array([0.3, 0.44, 0.5])
    warp = fbm(P * 0.55 + 3.3, 2, seed=77)[:, None] * 0.7
    a = fbm(q + warp, 2, seed=11)
    b = fbm(q * 1.3 + np.array([4.7, -2.1, 9.3]) + warp, 2, seed=23)
    return a, b


def _camo_thresholds():
    global _CAMO_Q
    if _CAMO_Q is None:
        _CAMO_Q = (_quantiles(lambda P: _camo_fields(P)[0], [0.66])[0],
                   _quantiles(lambda P: _camo_fields(P)[1], [0.82])[0])
    return _CAMO_Q


CAMO_BAND = 0.002


def camo_bands():
    ta, tb = _camo_thresholds()
    return [('camoA', lambda P: _camo_fields(P)[0], [ta]),
            ('camoB', lambda P: _camo_fields(P)[1], [tb])]


def paint_colour(P, sch, pid, fields=None):
    """Base paint (sRGB) for (N,3) model-space points.  fields = precomputed (camoA, camoB)."""
    base = hexc(sch['Paint'])
    n_lo = fbm(P * 0.45 + 11.0, 3, seed=3)            # broad fading / patchiness
    n_hi = vnoise(P * 9.0, seed=4)                     # fine speckle
    if sch['camo']:
        g, s, k = (hexc(c) for c in sch['camo'])
        a, b = fields if fields is not None else _camo_fields(P)
        ta, tb = _camo_thresholds()
        col = mix(np.tile(g, (len(P), 1)), s, smoothstep(ta - CAMO_BAND, ta + CAMO_BAND, a))
        col = mix(col, k, smoothstep(tb - CAMO_BAND, tb + CAMO_BAND, b))
    else:
        col = np.tile(base, (len(P), 1))
    shade = 1.0 + (n_lo - 0.5) * 0.16 + (n_hi - 0.5) * 0.05
    warm = (n_lo - 0.5) * 0.03
    col = col * shade[:, None] + np.stack([warm, warm * 0.4, -warm], 1)
    return col


# --------------------------------------------------------------------------------------
# Mesh helpers
# --------------------------------------------------------------------------------------
def mesh_objects(root):
    return [o for o in mc_lib.descendants(root) if o.type == 'MESH']


def face_tags(me):
    names = [m.name if m else 'Paint' for m in me.materials]
    idx = np.empty(len(me.polygons), np.int32)
    me.polygons.foreach_get('material_index', idx)
    return [names[i] if i < len(names) else 'Paint' for i in idx]


def _split_edge_n(e, n):
    """Split edge e into n equal pieces (vertices are inserted into the adjacent faces)."""
    a, b = e.verts
    cur = e
    for k in range(n - 1):
        _, nv = bmesh.utils.edge_split(cur, a, 1.0 / (n - k))
        a = nv
        cur = next((x for x in nv.link_edges if b in x.verts), None)
        if cur is None:
            break


def _point_in_poly(x, y, poly):
    inside = False
    n = len(poly)
    j = n - 1
    for i in range(n):
        xi, yi = poly[i]
        xj, yj = poly[j]
        if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi + 1e-30) + xi:
            inside = not inside
        j = i
    return inside


def _dist_to_poly(x, y, poly):
    best = math.inf
    n = len(poly)
    for i in range(n):
        ax, ay = poly[i]
        bx, by = poly[(i + 1) % n]
        dx, dy = bx - ax, by - ay
        L2 = dx * dx + dy * dy
        t = 0.0 if L2 < 1e-12 else max(0.0, min(1.0, ((x - ax) * dx + (y - ay) * dy) / L2))
        px, py = ax + dx * t - x, ay + dy * t - y
        best = min(best, px * px + py * py)
    return math.sqrt(best)


def _densify_face(bm, f, s):
    """Replace a planar face by a constrained Delaunay triangulation with interior points on a
    hex grid of spacing s (its boundary edges must already be split to ~s)."""
    from mathutils.geometry import delaunay_2d_cdt
    f.normal_update()
    n = f.normal.copy()
    if n.length < 0.5:
        return
    u, w = mc_lib.basis(n)
    o = f.calc_center_median()
    bv = list(f.verts)
    poly = [((v.co - o).dot(u), (v.co - o).dot(w)) for v in bv]
    if max(abs((v.co - o).dot(n)) for v in bv) > 0.004:
        return  # not planar enough
    xs = [p[0] for p in poly]
    ys = [p[1] for p in poly]
    pts = []
    dy = s * 0.866
    row = 0
    y = min(ys) + dy * 0.5
    while y < max(ys):
        x = min(xs) + (s * 0.5 if row % 2 else 0.0) + s * 0.25
        while x < max(xs):
            if _point_in_poly(x, y, poly) and _dist_to_poly(x, y, poly) > s * 0.45:
                pts.append((x, y))
            x += s
        y += dy
        row += 1
    if not pts:
        return
    co2 = [V(p) for p in poly] + [V(p) for p in pts]
    face = list(range(len(poly)))
    if mc_lib.poly_area(poly) < 0:
        face.reverse()
    try:
        oc, _, ofaces, overts, _, _ = delaunay_2d_cdt(co2, [], [face], 1, 1e-7, True)
    except Exception:
        return
    vmap = []
    for i, c in enumerate(oc):
        ids = overts[i]
        if ids and ids[0] < len(bv):
            vmap.append(bv[ids[0]])
        else:
            vmap.append(bm.verts.new(o + u * c.x + w * c.y))
    made = []
    for tri in ofaces:
        vs = [vmap[i] for i in tri]
        if len(set(vs)) < 3:
            continue
        try:
            nf = bm.faces.new(vs, f)
        except ValueError:
            continue
        nf.normal_update()
        if nf.normal.dot(n) < 0:
            nf.normal_flip()
        made.append(nf)
    if made:
        bm.faces.remove(f)


def camo_contours(bm, obj, paint_idx, bands):
    """Store the camouflage fields as vertex layers and cut the painted faces along their
    iso-lines, so blob edges are crisp polygon edges (with a narrow soft band between the two
    cuts of each threshold) instead of being smeared across large triangles.

    bands: [(layer_name, field_fn(world_pts) -> values, [thresholds...]), ...]"""
    bmesh.ops.triangulate(bm, faces=[f for f in bm.faces if f.material_index in paint_idx and len(f.verts) > 3])
    M = np.array(obj.matrix_world)
    for name, fn, thrs in bands:
        lay = bm.verts.layers.float.get(name) or bm.verts.layers.float.new(name)
        bm.verts.ensure_lookup_table()
        co = np.array([tuple(v.co) for v in bm.verts]) if len(bm.verts) else np.zeros((0, 3))
        wv = co @ M[:3, :3].T + M[:3, 3]
        vals = fn(wv)
        for v, x in zip(bm.verts, vals):
            v[lay] = float(x)
        for thr in thrs:
            cross = []
            for e in bm.edges:
                if not any(f.material_index in paint_idx and f.calc_area() > 0.08 and f.normal.z > -0.4
                           for f in e.link_faces):
                    continue
                a, b = e.verts
                fa, fb = a[lay] - thr, b[lay] - thr
                if fa * fb < 0:
                    cross.append((e, a, fa / (fa - fb)))
            new = set()
            for e, a, fac in cross:
                if not e.is_valid:
                    continue
                _, nv = bmesh.utils.edge_split(e, a, fac)
                nv[lay] = thr
                new.add(nv)
            faces = {f for v in new for f in v.link_faces}
            for f in faces:
                if not f.is_valid or f.material_index not in paint_idx:
                    continue
                ns = [v for v in f.verts if v in new]
                if len(ns) == 2:
                    a, b = ns
                    if bm.edges.get((a, b)) is None:
                        try:
                            bmesh.utils.face_split(f, a, b)
                        except ValueError:
                            pass
        # other field layers of the new vertices: interpolate from their neighbours
    return


def process_geometry(obj, max_edge=0.45, dense_tags=DENSE_TAGS, bevel=True, camo=None):
    """Bevel (per-primitive widths), densify large visible faces, cut camouflage contours, set
    smooth + sharp flags."""
    me = obj.data
    names = [m.name for m in me.materials]
    bm = bmesh.new()
    bm.from_mesh(me)
    L = bm.faces.layers
    l_bev, l_seg, l_rnd = L.float.get('bev'), L.int.get('bseg'), L.int.get('rnd')
    l_edge = L.int.get('edge') or L.int.new('edge')
    for f in bm.faces:
        f[l_edge] = 0
    bm.normal_update()
    if bevel and l_bev is not None:
        groups = defaultdict(list)
        for e in bm.edges:
            if len(e.link_faces) != 2:
                continue
            f0, f1 = e.link_faces
            w = f0[l_bev]
            if w <= 0:
                continue
            if f0.normal.z < -0.6 or f1.normal.z < -0.6:
                continue  # underside edges: never seen, not worth the triangles
            lim = math.radians(50 if f0[l_rnd] else 30)
            if e.calc_face_angle(0.0) < lim:
                continue
            segs = f0[l_seg]
            groups[(round(w, 4), segs)].append(e)
        for (w, sg), es in sorted(groups.items()):
            es = [e for e in es if e.is_valid]
            if not es:
                continue
            vs = list({v for e in es for v in e.verts})
            res = bmesh.ops.bevel(bm, geom=vs + es, offset=w, offset_type='OFFSET', segments=max(1, sg),
                                  profile=0.5, affect='EDGES', clamp_overlap=True, loop_slide=True, material=-1,
                                  miter_outer='SHARP', miter_inner='SHARP')
            for f in res['faces']:
                f[l_edge] = 1
        bm.normal_update()
    # vertex density on large, visible painted faces (for camouflage / mud / AO gradients)
    if max_edge:
        dense_idx = {i for i, nm in enumerate(names) if nm in dense_tags}
        targets = [f for f in bm.faces if f.material_index in dense_idx and f[l_edge] == 0
                   and f.normal.z > -0.35 and f.calc_area() > max_edge * max_edge * 1.3]
        edges = {e for f in targets for e in f.edges if e.calc_length() > max_edge * 1.1}
        for e in list(edges):
            if e.is_valid:
                _split_edge_n(e, int(math.ceil(e.calc_length() / max_edge)))
        for f in targets:
            if f.is_valid:
                _densify_face(bm, f, max_edge)
    ngons = [f for f in bm.faces if len(f.verts) > 4]
    if ngons:
        bmesh.ops.triangulate(bm, faces=ngons, quad_method='BEAUTY', ngon_method='BEAUTY')
    if camo:
        paint_idx = {i for i, nm in enumerate(names) if nm in PAINT_TAGS}
        if paint_idx:
            camo_contours(bm, obj, paint_idx, camo)
            ngons = [f for f in bm.faces if len(f.verts) > 4]
            if ngons:
                bmesh.ops.triangulate(bm, faces=ngons, quad_method='BEAUTY', ngon_method='BEAUTY')
    # smooth everywhere; sharp only on unbevelled creases
    bm.normal_update()
    for f in bm.faces:
        f.smooth = True
    for e in bm.edges:
        if len(e.link_faces) != 2:
            continue
        f0 = e.link_faces[0]
        ang = e.calc_face_angle(0.0)
        unbev = l_bev is None or f0[l_bev] <= 0
        lim = 55 if (l_rnd is not None and f0[l_rnd]) else 32
        if (unbev and ang > math.radians(lim)) or ang > math.radians(80):
            e.smooth = False
        else:
            e.smooth = True
    bm.to_mesh(me)
    bm.free()
    me.update()


def weighted_normals(obj):
    mod = obj.modifiers.new('WN', 'WEIGHTED_NORMAL')
    mod.mode = 'FACE_AREA'
    mod.keep_sharp = True
    mod.weight = 50
    _apply(obj, mod.name)


def _apply(obj, name):
    vl = bpy.context.view_layer
    for o in bpy.context.selected_objects:
        o.select_set(False)
    obj.select_set(True)
    vl.objects.active = obj
    bpy.ops.object.modifier_apply(modifier=name)


def set_custom_normals(obj, normals_per_vertex):
    me = obj.data
    me.normals_split_custom_set_from_vertices([tuple(n) for n in normals_per_vertex])


# --------------------------------------------------------------------------------------
# AO bake
# --------------------------------------------------------------------------------------
def bake_ao(objs, distance=1.0, samples=96, ground=True):
    sc = bpy.context.scene
    prev = sc.render.engine
    sc.render.engine = 'CYCLES'
    sc.cycles.device = 'CPU'
    sc.cycles.samples = samples
    try:
        sc.cycles.use_denoising = False
    except Exception:
        pass
    if sc.world is None:
        sc.world = bpy.data.worlds.new('BakeWorld')
    sc.world.light_settings.distance = distance
    gobj = None
    if ground:
        gme = bpy.data.meshes.new('AOGround')
        s = 60.0
        gme.from_pydata([(-s, -s, 0), (s, -s, 0), (s, s, 0), (-s, s, 0)], [], [(0, 1, 2, 3)])
        gobj = bpy.data.objects.new('AOGround', gme)
        sc.collection.objects.link(gobj)
    for o in objs:
        me = o.data
        a = me.color_attributes.get('AO') or me.color_attributes.new('AO', 'FLOAT_COLOR', 'CORNER')
        me.color_attributes.active_color = a
    for o in sc.objects:
        o.select_set(o in objs)
    bpy.context.view_layer.objects.active = objs[0]
    sc.render.bake.target = 'VERTEX_COLORS'
    sc.render.bake.use_selected_to_active = False
    bpy.ops.object.bake(type='AO', target='VERTEX_COLORS')
    if gobj is not None:
        me = gobj.data
        bpy.data.objects.remove(gobj, do_unlink=True)
        bpy.data.meshes.remove(me)
    sc.render.engine = prev


# --------------------------------------------------------------------------------------
# Per-corner arrays
# --------------------------------------------------------------------------------------
class Corners:
    def __init__(self, obj):
        me = obj.data
        self.obj, self.me = obj, me
        nL, nP, nV = len(me.loops), len(me.polygons), len(me.vertices)
        self.vi = np.empty(nL, np.int32)
        me.loops.foreach_get('vertex_index', self.vi)
        ls = np.empty(nP, np.int32)
        lt = np.empty(nP, np.int32)
        me.polygons.foreach_get('loop_start', ls)
        me.polygons.foreach_get('loop_total', lt)
        self.fi = np.empty(nL, np.int32)
        for p in range(nP):
            self.fi[ls[p]:ls[p] + lt[p]] = p
        co = np.empty(nV * 3, np.float32)
        me.vertices.foreach_get('co', co)
        self.co_local = co.reshape(-1, 3).astype(np.float64)
        cn = np.empty(nL * 3, np.float32)
        me.corner_normals.foreach_get('vector', cn)
        cn = cn.reshape(-1, 3).astype(np.float64)
        M = np.array(obj.matrix_world)
        R, t = M[:3, :3], M[:3, 3]
        self.co_world = self.co_local @ R.T + t
        self.n_world = cn @ R.T
        self.n_local = cn
        self.tags = np.array(face_tags(me))[self.fi] if nP else np.array([])
        self.edge = self._face_attr('edge')
        self.pid = self._face_attr('pid')
        self.fields = None
        ca, cb = me.attributes.get('camoA'), me.attributes.get('camoB')
        if ca is not None and cb is not None and ca.domain == 'POINT':
            fa = np.empty(nV, np.float32)
            fb = np.empty(nV, np.float32)
            ca.data.foreach_get('value', fa)
            cb.data.foreach_get('value', fb)
            # region per face (mean of its vertex values): the contour cuts become crisp edges
            nP = len(me.polygons)
            cnt = np.bincount(self.fi, minlength=nP).astype(np.float64)
            ma = np.bincount(self.fi, weights=fa[self.vi], minlength=nP) / np.maximum(cnt, 1)
            mb = np.bincount(self.fi, weights=fb[self.vi], minlength=nP) / np.maximum(cnt, 1)
            self.fields = (ma[self.fi], mb[self.fi])

    def _face_attr(self, name):
        a = self.me.attributes.get(name)
        nP = len(self.me.polygons)
        if a is None or a.domain != 'FACE':
            return np.zeros(len(self.fi))
        v = np.empty(nP, np.float64 if a.data_type == 'FLOAT' else np.int32)
        a.data.foreach_get('value', v)
        return v[self.fi]

    def ao(self):
        a = self.me.color_attributes.get('AO')
        if a is None:
            return np.ones(len(self.fi))
        c = np.empty(len(a.data) * 4, np.float32)
        a.data.foreach_get('color', c)
        c = c.reshape(-1, 4)[:, 0].astype(np.float64)
        if a.domain == 'POINT':
            c = c[self.vi]
        return c

    def write(self, rgb_lin, name='Col'):
        me = self.me
        for a in list(me.color_attributes):
            me.color_attributes.remove(a)
        attr = me.color_attributes.new(name, 'FLOAT_COLOR', 'CORNER')
        rgba = np.ones((len(self.fi), 4), np.float32)
        rgba[:, :3] = np.clip(rgb_lin, 0.0, 1.0)
        attr.data.foreach_set('color', rgba.ravel())
        me.color_attributes.active_color = attr
        try:
            me.color_attributes.render_color_index = me.color_attributes.active_color_index
        except Exception:
            pass


AO_FLOOR = 0.6


def unbury_ao(C, ao):
    """Corners buried inside another part (AO ~ 0: every ray hits at once) are never seen, but
    their darkness would bleed across the visible faces they belong to.  Give such vertices the
    mean AO of their unburied neighbours (repeated a few times to fill clusters)."""
    me = C.me
    nV = len(me.vertices)
    vsum = np.bincount(C.vi, weights=ao, minlength=nV)
    vcnt = np.maximum(np.bincount(C.vi, minlength=nV), 1)
    vao = vsum / vcnt
    buried = vao < 0.04
    if not buried.any():
        return ao
    ev = np.empty(len(me.edges) * 2, np.int32)
    me.edges.foreach_get('vertices', ev)
    ev = ev.reshape(-1, 2)
    for _ in range(4):
        ok = ~buried
        a, b = ev[:, 0], ev[:, 1]
        s_ = np.bincount(a, weights=np.where(ok[b], vao[b], 0.0), minlength=nV) + \
            np.bincount(b, weights=np.where(ok[a], vao[a], 0.0), minlength=nV)
        c_ = np.bincount(a, weights=ok[b].astype(float), minlength=nV) + \
            np.bincount(b, weights=ok[a].astype(float), minlength=nV)
        fill = buried & (c_ > 0)
        vao[fill] = s_[fill] / c_[fill]
        buried = buried & ~fill
        if not buried.any():
            break
    vao[buried] = 0.5
    was = (vsum / vcnt) < 0.04
    return np.where(was[C.vi], vao[C.vi], ao)


def merge_corner_ao(C, ao):
    """Average the baked AO over the corners that share a vertex and a normal: removes bake noise
    and lets the exporter merge those corners into one glTF vertex (smaller files)."""
    key = np.concatenate([C.vi[:, None].astype(np.float64), np.round(C.n_local * 50)], 1)
    _, inv = np.unique(key, axis=0, return_inverse=True)
    inv = inv.ravel()
    s = np.bincount(inv, weights=ao)
    c = np.bincount(inv)
    return s[inv] / c[inv]


def symmetrize_spin_ao(C, ao):
    """Average AO around the axle (local Y) so a spinning wheel shows no fixed dark spot."""
    p = C.co_local[C.vi]
    n = C.n_local
    r = np.hypot(p[:, 0], p[:, 2])
    nr = (n[:, 0] * p[:, 0] + n[:, 2] * p[:, 2]) / np.maximum(r, 1e-6)
    key = np.stack([np.round(r * 80), np.round(p[:, 1] * 80), np.round(nr * 3), np.round(n[:, 1] * 3)], 1)
    _, inv = np.unique(key, axis=0, return_inverse=True)
    inv = inv.ravel()
    s = np.bincount(inv, weights=ao)
    c = np.bincount(inv)
    return s[inv] / c[inv]


# --------------------------------------------------------------------------------------
# Albedo
# --------------------------------------------------------------------------------------
def albedo_vehicle(C, sch, spin=False, mud_height=0.72):
    tags = C.tags
    N = len(tags)
    Pw = C.co_world[C.vi]
    nw = C.n_world
    out = np.zeros((N, 3))
    if spin:
        # rotation-invariant coordinates: radius and axle offset only
        pl = C.co_local[C.vi]
        r = np.hypot(pl[:, 0], pl[:, 2])
        Pn = np.stack([r * 3.0, pl[:, 1] * 3.0, np.full(N, C.obj.location.x * 0.37)], 1)
    else:
        Pn = Pw
    paint = paint_colour(Pw if not spin else Pn * 0.3, sch, C.pid, fields=None if spin else C.fields)
    for tag in set(tags.tolist()):
        m = tags == tag
        if tag in PAINT_TAGS or tag == 'Paint':
            c = paint[m]
            if tag == 'Plate':
                c = c * 0.87
        elif tag == 'Canvas':
            opts = [hexc(h) for h in sch['Canvas']]
            pid = C.pid[m].astype(np.int64)
            c = np.array([opts[(int(i) * 7 + 3) % len(opts)] for i in pid]) if len(pid) else np.zeros((0, 3))
            c = c * (1.0 + (vnoise(Pn[m] * 6.0, 9) - 0.5)[:, None] * 0.14)
        else:
            hx = sch.get(tag) or mc_lib.MAT_COLORS.get(tag, '#808080')
            if isinstance(hx, list):
                hx = hx[0]
            c = np.tile(hexc(hx), (m.sum(), 1))
            jit = 0.08 if tag in ('Rubber', 'Track', 'Metal', 'Dark', 'Barrel', 'Cable') else 0.03
            c = c * (1.0 + (vnoise(Pn[m] * 5.0, 12) - 0.5)[:, None] * jit)
        out[m] = c
    painted = np.isin(tags, ['Paint', 'Plate', 'Canvas'])
    metalish = np.isin(tags, ['Metal', 'Dark', 'Barrel', 'Track', 'Cable'])
    glass = np.isin(tags, list(GLASS_TAGS | {'Mark', 'MarkY'}))
    # worn, lighter paint on bevelled edges
    wear = (C.edge > 0) & painted
    if wear.any():
        wn = vnoise(Pn[wear] * 7.0, 31)
        out[wear] = out[wear] * (1.0 + 0.04 + 0.08 * wn)[:, None]
    # dust on upward-facing surfaces
    up = np.clip(nw[:, 2], 0.0, 1.0) ** 2
    dn = fbm(Pn * 1.7 + 2.0, 2, seed=41)
    dust_amt = up * (0.04 + 0.22 * smoothstep(0.4, 0.8, dn))
    dust_amt = np.where(glass, dust_amt * 0.25, dust_amt)
    dust_amt = np.where(metalish, dust_amt * 0.7, dust_amt)
    if spin:
        dust_amt = dust_amt * 0.0
    out = mix(out, hexc(sch['dust']), dust_amt)
    # mud near the ground (noisy upper edge), heavier on running gear
    mn = fbm(Pn * np.array([1.4, 1.4, 3.0]) + 7.0, 3, seed=53)
    mud_col = mix(np.tile(hexc(sch['mud']), (N, 1)), hexc(sch['mud2']), vnoise(Pn * 3.1, 57))
    if spin:
        pl = C.co_local[C.vi]
        r = np.hypot(pl[:, 0], pl[:, 2])
        rmax = max(float(r.max()), 1e-3)
        mud_amt = smoothstep(0.5, 1.0, r / rmax) * (0.22 + 0.33 * mn)
    elif mud_height <= 0:
        mud_amt = np.zeros(N)
    else:
        z = Pw[:, 2]
        top = mud_height * (0.6 + 0.8 * mn)
        mud_amt = (1.0 - smoothstep(0.35, 1.0, z / np.maximum(top, 1e-3))) * (0.62 + 0.33 * vnoise(Pw * 4.3, 59))
        # splatter spots a little higher up
        spots = smoothstep(0.68, 0.76, vnoise(Pw * np.array([4.0, 4.0, 7.0]), 61)) * (1.0 - smoothstep(0.4, 1.6, z))
        mud_amt = np.maximum(mud_amt, spots * 0.75)
    mud_amt = np.where(glass, mud_amt * 0.5, mud_amt)
    out = mix(out, mud_col, np.clip(mud_amt, 0, 0.92))
    return out


def albedo_tree(C, kind):
    tags = C.tags
    N = len(tags)
    Pw = C.co_world[C.vi]
    out = np.zeros((N, 3))
    fol = tags == 'Foliage'
    if fol.any():
        P = Pw[fol]
        zmin, zmax = P[:, 2].min(), P[:, 2].max()
        ht = (P[:, 2] - zmin) / max(zmax - zmin, 1e-3)
        cen = P.mean(0)
        d = P - cen
        rad = np.linalg.norm(d * np.array([1, 1, 0.8]), axis=1)
        out_t = rad / max(float(rad.max()), 1e-3)
        n1 = fbm(P * 0.9, 3, seed=71)
        n2 = vnoise(P * 3.3, 73)
        pal = {
            'tree_oak': ('#213218', '#3e5522', '#67803a'),
            'tree_pine': ('#182a1c', '#2b4629', '#4d6a40'),
            'tree_birch': ('#2c421d', '#56722b', '#8aa34a'),
            'bush': ('#223117', '#415622', '#65793a'),
        }[kind]
        dark, mid, light = (hexc(c) for c in pal)
        t = np.clip(0.2 + 0.35 * ht + 0.35 * out_t + 0.45 * (n1 - 0.5) + 0.12 * (n2 - 0.5), 0, 1)
        c = np.where((t < 0.5)[:, None], mix(np.tile(dark, (len(P), 1)), mid, t * 2),
                     mix(np.tile(mid, (len(P), 1)), light, (t - 0.5) * 2))
        # a few warmer / yellowed clumps, and per-lobe tone variation
        warm = smoothstep(0.66, 0.78, fbm(P * 0.7 + 9, 2, seed=79)) * 0.35
        c = mix(c, hexc('#8a8a3a'), warm)
        pid = C.pid[fol].astype(np.int64)
        lobe = ((pid * 2654435761) % 1000) / 1000.0
        c = c * (0.86 + 0.26 * lobe)[:, None] + np.stack([lobe * 0.02, lobe * 0.01, -lobe * 0.01], 1)
        out[fol] = c
    for tag, base in (('Trunk', '#4a3b2b'), ('Birch', '#d9d5c9')):
        m = tags == tag
        if not m.any():
            continue
        P = Pw[m]
        c = np.tile(hexc(base), (m.sum(), 1))
        if tag == 'Trunk':
            streak = vnoise(P * np.array([9.0, 9.0, 1.2]), 81)
            c = c * (0.8 + 0.35 * streak)[:, None]
            moss = smoothstep(0.55, 0.8, vnoise(P * 2.0, 83)) * (1 - smoothstep(0.0, 2.5, P[:, 2])) * 0.5
            c = mix(c, hexc('#4b5a2a'), moss)
        else:
            marks = smoothstep(0.62, 0.7, vnoise(P * np.array([7.0, 7.0, 13.0]), 85))
            c = mix(c, hexc('#2c2a26'), marks * 0.9)
            base_dark = 1 - smoothstep(0.0, 1.2, P[:, 2])
            c = mix(c, hexc('#3a3630'), base_dark * 0.75)
        out[m] = c
    return out


# --------------------------------------------------------------------------------------
# Materials
# --------------------------------------------------------------------------------------
def vc_material(name, roughness):
    mat = bpy.data.materials.get(name)
    if mat is not None and mat.get('mc_vc'):
        return mat
    if mat is not None:
        mat.name = name + '_old'
    mat = bpy.data.materials.new(name)
    mat['mc_vc'] = 1
    try:
        mat.use_nodes = True
    except Exception:
        pass
    nt = mat.node_tree
    bsdf = next(n for n in nt.nodes if n.type == 'BSDF_PRINCIPLED')
    attr = nt.nodes.new('ShaderNodeVertexColor')
    attr.layer_name = 'Col'
    nt.links.new(attr.outputs['Color'], bsdf.inputs['Base Color'])
    bsdf.inputs['Roughness'].default_value = roughness
    bsdf.inputs['Metallic'].default_value = 0.0
    mat.roughness = roughness
    mat.diffuse_color = (0.8, 0.8, 0.8, 1.0)
    return mat


FINAL_ROUGHNESS = {'Vehicle': 0.7, 'Glass': 0.2, 'Foliage': 0.85, 'Trunk': 0.9}


def final_material_name(tag, tree):
    if tree:
        return 'Foliage' if tag == 'Foliage' else 'Trunk'
    return 'Glass' if tag in GLASS_TAGS else 'Vehicle'


def assign_final_materials(obj, tree=False):
    me = obj.data
    tags = face_tags(me)
    finals = [final_material_name(t, tree) for t in tags]
    order = [n for n in (('Foliage', 'Trunk') if tree else ('Vehicle', 'Glass')) if n in finals]
    me.materials.clear()
    for n in order:
        me.materials.append(vc_material(n, FINAL_ROUGHNESS[n]))
    idx = np.array([order.index(f) for f in finals], np.int32)
    me.polygons.foreach_set('material_index', idx)
    for a in ('bev', 'bseg', 'pid', 'rnd', 'edge', 'camoA', 'camoB'):
        at = me.attributes.get(a)
        if at is not None:
            me.attributes.remove(at)
    me.update()


# --------------------------------------------------------------------------------------
# Driver
# --------------------------------------------------------------------------------------
def finish(root, scheme, kind='vehicle', ao_distance=None, ground=True, max_edge=None, samples=96):
    """Run the whole v3 graphics pass on the hierarchy under ``root``."""
    tree = kind == 'tree'
    objs = mesh_objects(root)
    sch = None if tree else SCHEMES[scheme]
    if max_edge is None:
        max_edge = {'vehicle': 0.58, 'prop': 0.12, 'tree': 0.0}[kind]
    bpy.context.view_layer.update()
    camo = camo_bands() if (sch and sch['camo']) else None
    for o in objs:
        spin = bool(SPIN_RE.match(o.name))
        if tree:
            process_geometry(o, max_edge=0, bevel=False)
            tree_normals(o)
        else:
            process_geometry(o, max_edge=0 if spin else max_edge, camo=None if spin else camo)
            weighted_normals(o)
    if ao_distance is None:
        ao_distance = {'vehicle': 0.7, 'prop': 0.2, 'tree': 2.0}[kind]
    bake_ao(objs, ao_distance, samples=samples, ground=ground)
    probe = None
    for o in objs:
        spin = bool(SPIN_RE.match(o.name))
        C = Corners(o)
        ao = merge_corner_ao(C, unbury_ao(C, C.ao()))
        if spin:
            ao = symmetrize_spin_ao(C, ao)
        if tree:
            alb = albedo_tree(C, scheme)
        else:
            alb = albedo_vehicle(C, SCHEMES[scheme], spin=spin,
                                 mud_height=(0.95 if kind == 'vehicle' else 0.22) if ground else 0.0)
        # a little brownish grime in occluded areas, then the AO multiply (linear, 0.6..1.0) and
        # ground-contact darkening
        grime = np.clip(1.0 - ao, 0, 1) * 0.3
        alb = mix(alb, alb * hexc(COMMON['grime']) * 2.6, grime)
        lin = srgb_to_lin(alb)
        aof = AO_FLOOR + (1.0 - AO_FLOOR) * np.clip(ao, 0, 1)
        if not spin and ground:
            z = C.co_world[C.vi][:, 2]
            gh = 0.35 if kind == 'vehicle' else (0.8 if tree else 0.12)
            aof = aof * (0.8 + 0.2 * smoothstep(0.0, gh, z))
        final = lin * aof[:, None]
        C.write(final)
        if not spin:
            cand = _probe_candidates(C, ao, tree, kind)
            if cand is not None and (probe is None or cand[0] > probe[0]):
                probe = cand + (o.name,)
        assign_final_materials(o, tree=tree)
    if probe is not None:
        _, co, col, oname = probe
        base = expected_base(scheme, tree, col)
        root['paintProbe'] = json.dumps({'node': oname, 'pos': [round(float(x), 5) for x in co],
                                         'color': [round(float(x), 5) for x in col],
                                         'expected': [round(float(x), 5) for x in base]})
    return objs


def _probe_candidates(C, ao, tree, kind='vehicle'):
    """An open, flat, painted (or foliage) vertex whose written colour can be checked after export:
    (score, local position, linear colour).  Picks the candidate closest to the median colour."""
    a = C.me.color_attributes.get('Col')
    if a is None:
        return None
    col = np.empty(len(a.data) * 4, np.float32)
    a.data.foreach_get('color', col)
    col = col.reshape(-1, 4)[:, :3].astype(np.float64)
    if tree:
        m = (C.tags == 'Foliage') & (C.n_world[:, 2] > 0.6)
    elif kind == 'vehicle':
        m = (C.tags == 'Paint') & (C.n_world[:, 2] > 0.95) & (ao > 0.9) & (C.edge == 0)
        m &= C.co_world[C.vi][:, 2] > 1.2
    else:
        m = (C.tags == 'Paint') & (C.n_world[:, 2] > 0.3) & (ao > 0.6) & (C.edge == 0)
    idx = np.nonzero(m)[0]
    if len(idx) < 4 and not tree and kind != 'vehicle':
        idx = np.nonzero((C.tags == 'Paint') & (ao > 0.4))[0]
    if len(idx) < 4:
        return None
    # the corner closest to the median colour; the exporter keeps one glTF vertex per distinct
    # (normal, colour) at a position, so this exact colour exists at that position after export
    med = np.median(col[idx], 0)
    i = idx[int(np.argmin(np.abs(col[idx] - med).sum(1)))]
    return (len(idx), C.co_local[C.vi[i]].copy(), col[i].copy())


def expected_base(scheme, tree, col):
    """The scheme's un-shaded base colour (linear) closest to a probed colour."""
    if tree:
        pal = {'tree_oak': '#3e5522', 'tree_pine': '#2b4629', 'tree_birch': '#56722b', 'bush': '#415622'}
        return srgb_to_lin(hexc(pal.get(scheme, '#34491d')))
    sch = SCHEMES[scheme]
    opts = [sch['Paint']] + list(sch['camo'] or [])
    lins = [srgb_to_lin(hexc(h)) for h in opts]
    return min(lins, key=lambda c: float(np.abs(np.log((c + 1e-3) / (col + 1e-3))).sum()))


def tree_normals(obj):
    """Foliage: soft 'spherical' normals -- a blend of the direction from the canopy centre and from
    the vertex's own lobe (obj['lobes'] = [x, y, z, r, ...]) -- so canopies shade like soft clumps
    instead of facets.  Trunks get plain smooth normals."""
    me = obj.data
    tags = face_tags(me)
    fol_v = set()
    for poly, t in zip(me.polygons, tags):
        if t == 'Foliage':
            fol_v.update(poly.vertices)
    co = [v.co.copy() for v in me.vertices]
    cen = V((0, 0, 0))
    if fol_v:
        cen = sum((co[i] for i in fol_v), V((0, 0, 0))) / len(fol_v)
    raw = list(obj.get('lobes') or [])
    lobes = [(V(raw[i:i + 3]), raw[i + 3]) for i in range(0, len(raw) - 3, 4)]
    me.update()
    vn = [v.normal.copy() for v in me.vertices]
    out = []
    for i, p in enumerate(co):
        if i not in fol_v:
            out.append(vn[i])
            continue
        d = p - cen
        d.z *= 1.3
        n = d.normalized() if d.length > 1e-6 else V((0, 0, 1))
        if lobes:
            lc, lr = min(lobes, key=lambda cr: abs((p - cr[0]).length / max(cr[1], 1e-3) - 1.0))
            nl = p - lc
            nl = nl.normalized() if nl.length > 1e-6 else n
            n = (n * 0.35 + nl * 0.65).normalized()
        out.append((n * 0.88 + vn[i] * 0.12).normalized())
    for poly in me.polygons:
        poly.use_smooth = True
    set_custom_normals(obj, out)


# --------------------------------------------------------------------------------------
# Markings: 7-segment digits and chevrons as thin raised plates
# --------------------------------------------------------------------------------------
_SEG = {
    '0': 'abcdef', '1': 'bc', '2': 'abged', '3': 'abgcd', '4': 'fgbc', '5': 'afgcd', '6': 'afgedc',
    '7': 'abc', '8': 'abcdefg', '9': 'abcfgd',
}


def digits(P, text, origin, u, v, n, h=0.22, t=0.004, tag='Mark'):
    """Paint-like raised digits on the plane (origin, u right, v up, n outward). h = digit height."""
    origin, u, v, n = V(origin), V(u).normalized(), V(v).normalized(), V(n).normalized()
    w = h * 0.55
    sw = h * 0.13
    adv = w + h * 0.22
    total = adv * len(text) - h * 0.22
    x0 = -total / 2
    with P.style(bevel=0):
        for k, ch in enumerate(text):
            cx = x0 + k * adv
            segs = {
                'a': ((cx, h - sw / 2), (cx + w, h - sw / 2)),
                'g': ((cx, h / 2), (cx + w, h / 2)),
                'd': ((cx, sw / 2), (cx + w, sw / 2)),
                'f': ((cx + sw / 2, h / 2), (cx + sw / 2, h)),
                'b': ((cx + w - sw / 2, h / 2), (cx + w - sw / 2, h)),
                'e': ((cx + sw / 2, 0), (cx + sw / 2, h / 2)),
                'c': ((cx + w - sw / 2, 0), (cx + w - sw / 2, h / 2)),
            }
            if ch == '1':
                segs['b'] = ((cx + w / 2, h / 2), (cx + w / 2, h))
                segs['c'] = ((cx + w / 2, 0), (cx + w / 2, h / 2))
            for s in _SEG.get(ch, ''):
                (a0, b0), (a1, b1) = segs[s]
                c = origin + u * ((a0 + a1) / 2) + v * ((b0 + b1) / 2 - h / 2) + n * (t / 2)
                horiz = abs(b1 - b0) < 1e-6
                L = (abs(a1 - a0) if horiz else abs(b1 - b0)) + sw
                hs = (L / 2, sw / 2, t / 2) if horiz else (sw / 2, L / 2, t / 2)
                P.obox(c, u, v, n, hs, tag)


def chevron(P, origin, u, v, n, size=0.3, bar=0.06, t=0.004, tag='Mark', inverted=True):
    """A chevron (inverted V by default) made of two thin bars on the plane (u right, v up, n out)."""
    origin, u, v, n = V(origin), V(u).normalized(), V(v).normalized(), V(n).normalized()
    k = 1.0 if inverted else -1.0
    with P.style(bevel=0):
        for side in (1, -1):
            d = (u * side - v * k).normalized()
            c = origin + u * (side * size * 0.2) + n * (t / 2)
            P.obox(c, d, n.cross(d).normalized(), n, (size * 0.3, bar / 2, t / 2), tag)
