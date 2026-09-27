"""Shared helpers for the procedural low-poly model builders (Blender 5.x, headless).

Conventions (see docs/MODELS.md): metres, front = +X, up = +Z, origin at ground centre,
flat-shaded faces, fixed material names.  Geometry is built with bmesh into ``Part``
objects (one Part per exported node), then turned into Blender objects with
``make_node``.  Every primitive is a closed solid; its winding is fixed automatically
(signed-volume test) so normals always point outward.
"""
import math
import random

import bpy
import bmesh
from mathutils import Vector, Matrix

V = Vector

# --------------------------------------------------------------------------------------
# Materials
# --------------------------------------------------------------------------------------
MAT_COLORS = {
    'Paint':   '#8a8466',
    'Dark':    '#2a2a28',
    'Metal':   '#4a4a48',
    'Glass':   '#2d3e4a',
    'Uniform': '#7a7a5a',
    'Gear':    '#5a5a44',
    'Skin':    '#c8a080',
    'Foliage': '#4b5a2f',
    'Trunk':   '#4a3b2b',
}
MAT_ROUGHNESS = {'Glass': 0.35}


def hex_to_linear(h):
    h = h.lstrip('#')
    out = []
    for i in (0, 2, 4):
        c = int(h[i:i + 2], 16) / 255.0
        out.append(c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4)
    return tuple(out)


def _principled(mat):
    try:
        if not mat.use_nodes:
            mat.use_nodes = True
    except Exception:  # use_nodes deprecated / always on in newer versions
        pass
    nt = mat.node_tree
    for n in nt.nodes:
        if n.type == 'BSDF_PRINCIPLED':
            return n
    bsdf = nt.nodes.new('ShaderNodeBsdfPrincipled')
    out = next((n for n in nt.nodes if n.type == 'OUTPUT_MATERIAL'), None)
    if out is None:
        out = nt.nodes.new('ShaderNodeOutputMaterial')
    nt.links.new(bsdf.outputs[0], out.inputs[0])
    return bsdf


def make_material(name, hex_color, roughness=0.8):
    mat = bpy.data.materials.new(name)
    col = hex_to_linear(hex_color)
    bsdf = _principled(mat)
    bsdf.inputs['Base Color'].default_value = (col[0], col[1], col[2], 1.0)
    bsdf.inputs['Roughness'].default_value = roughness
    bsdf.inputs['Metallic'].default_value = 0.0
    mat.diffuse_color = (col[0], col[1], col[2], 1.0)  # Workbench / viewport colour
    mat.roughness = roughness
    mat.metallic = 0.0
    return mat


def get_material(name):
    mat = bpy.data.materials.get(name)
    if mat is None:
        mat = make_material(name, MAT_COLORS[name], MAT_ROUGHNESS.get(name, 0.8))
    return mat


# --------------------------------------------------------------------------------------
# Small vector helpers
# --------------------------------------------------------------------------------------
def basis(d, hint=None):
    """Two unit vectors (u, w) perpendicular to d with (u, w, d) right-handed."""
    d = V(d).normalized()
    h = V(hint) if hint is not None else (V((0, 0, 1)) if abs(d.z) < 0.95 else V((1, 0, 0)))
    u = h.cross(d)
    if u.length < 1e-6:
        u = V((0, 1, 0)).cross(d)
    u.normalize()
    w = d.cross(u).normalized()
    return u, w


def ik2(root, target, l1, l2, pole):
    """Two-bone IK: returns middle joint (elbow/knee) position."""
    root, target, pole = V(root), V(target), V(pole)
    d = target - root
    dist = min(d.length, (l1 + l2) * 0.999)
    dn = d.normalized()
    a = (l1 * l1 - l2 * l2 + dist * dist) / (2 * dist)
    h = math.sqrt(max(l1 * l1 - a * a, 0.0))
    p = pole - dn * pole.dot(dn)
    if p.length < 1e-6:
        p = basis(dn)[0]
    p.normalize()
    return root + dn * a + p * h


def convex_hull_2d(pts):
    pts = sorted(set((round(p[0], 5), round(p[1], 5)) for p in pts))
    if len(pts) <= 2:
        return pts

    def cross(o, a, b):
        return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
    lower, upper = [], []
    for p in pts:
        while len(lower) >= 2 and cross(lower[-2], lower[-1], p) <= 0:
            lower.pop()
        lower.append(p)
    for p in reversed(pts):
        while len(upper) >= 2 and cross(upper[-2], upper[-1], p) <= 0:
            upper.pop()
        upper.append(p)
    return lower[:-1] + upper[:-1]  # CCW


def poly_area(pts):
    return 0.5 * sum(pts[i][0] * pts[(i + 1) % len(pts)][1] - pts[(i + 1) % len(pts)][0] * pts[i][1]
                     for i in range(len(pts)))


def simplify_loop(pts, min_dist):
    out = []
    for p in pts:
        if not out or math.hypot(p[0] - out[-1][0], p[1] - out[-1][1]) >= min_dist:
            out.append(p)
    while len(out) > 3 and math.hypot(out[0][0] - out[-1][0], out[0][1] - out[-1][1]) < min_dist:
        out.pop()
    return out


def offset_loop(pts, t):
    """Inset a convex CCW 2D loop by distance t."""
    n = len(pts)
    out = []
    for i in range(n):
        p0, p1, p2 = pts[i - 1], pts[i], pts[(i + 1) % n]
        e1 = (p1[0] - p0[0], p1[1] - p0[1])
        e2 = (p2[0] - p1[0], p2[1] - p1[1])
        n1 = V((-e1[1], e1[0])).normalized()
        n2 = V((-e2[1], e2[0])).normalized()
        m = (n1 + n2)
        m = m.normalized() if m.length > 1e-6 else n1
        dist = t / max(m.dot(n1), 0.3)
        out.append((p1[0] + m.x * dist, p1[1] + m.y * dist))
    return out


def circle_pts(cx, cy, r, n, rot=0.0, sx=1.0, sy=1.0):
    return [(cx + r * sx * math.cos(rot + 2 * math.pi * k / n), cy + r * sy * math.sin(rot + 2 * math.pi * k / n))
            for k in range(n)]


def rounded_rect(x0, x1, y0, y1, c):
    """Octagon: rectangle with chamfered corners (CCW)."""
    return [(x1 - c, y0), (x1, y0 + c), (x1, y1 - c), (x1 - c, y1),
            (x0 + c, y1), (x0, y1 - c), (x0, y0 + c), (x0 + c, y0)]


def sym_y(left):
    """Closed CCW (x,y) polygon mirrored about y=0 from its left half (y > 0), listed
    front (+x) to back.  Points on the centreline must not be included."""
    right = [(x, -y) for (x, y) in left]
    pts = list(left) + list(reversed(right))
    if poly_area(pts) < 0:
        pts.reverse()
    return pts


def sym_yz(left):
    """Closed (y,z) section mirrored about y=0 from its left half (y > 0), bottom to top."""
    right = [(-y, z) for (y, z) in left]
    pts = list(reversed(right)) + list(left)
    if poly_area(pts) < 0:
        pts.reverse()
    return pts


# --------------------------------------------------------------------------------------
# Part: accumulates closed low-poly solids for one exported node
# --------------------------------------------------------------------------------------
class Part:
    def __init__(self, offset=(0, 0, 0)):
        self.bm = bmesh.new()
        self.mats = []
        self.off = V(offset)

    # -- core -----------------------------------------------------------------------
    def _mi(self, mat):
        if mat not in MAT_COLORS:
            raise ValueError('unknown material %s' % mat)
        if mat not in self.mats:
            self.mats.append(mat)
        return self.mats.index(mat)

    def add(self, verts, faces, mat, closed=True):
        bv = [self.bm.verts.new(V(p) + self.off) for p in verts]
        fs = []
        for f in faces:
            fs.append(self.bm.faces.new([bv[i] for i in f]))
        idx = self._mi(mat)
        for f in fs:
            f.material_index = idx
            f.smooth = False
        if closed:
            vol = 0.0
            for f in fs:
                co = [v.co for v in f.verts]
                for k in range(1, len(co) - 1):
                    vol += co[0].dot(co[k].cross(co[k + 1]))
            if vol < 0:
                bmesh.ops.reverse_faces(self.bm, faces=fs)
        return fs

    def loft(self, rings, mat, cyclic=False, cap_start=True, cap_end=True, apex_start=None, apex_end=None):
        n = len(rings[0])
        R = len(rings)
        verts = [V(p) for ring in rings for p in ring]
        faces = []

        def ix(i, j):
            return i * n + (j % n)
        for i in range(R if cyclic else R - 1):
            i2 = (i + 1) % R
            for j in range(n):
                faces.append((ix(i, j), ix(i, j + 1), ix(i2, j + 1), ix(i2, j)))
        closed = cyclic
        if not cyclic:
            c0 = c1 = False
            if apex_start is not None:
                a = len(verts)
                verts.append(V(apex_start))
                for j in range(n):
                    faces.append((a, ix(0, j + 1), ix(0, j)))
                c0 = True
            elif cap_start:
                faces.append(tuple(ix(0, j) for j in reversed(range(n))))
                c0 = True
            if apex_end is not None:
                a = len(verts)
                verts.append(V(apex_end))
                for j in range(n):
                    faces.append((ix(R - 1, j), ix(R - 1, j + 1), a))
                c1 = True
            elif cap_end:
                faces.append(tuple(ix(R - 1, j) for j in range(n)))
                c1 = True
            closed = c0 and c1
        return self.add(verts, faces, mat, closed=closed)

    # -- boxes ----------------------------------------------------------------------
    def box(self, mn, mx, mat):
        x0, y0, z0 = mn
        x1, y1, z1 = mx
        r0 = [(x0, y0, z0), (x1, y0, z0), (x1, y1, z0), (x0, y1, z0)]
        r1 = [(x0, y0, z1), (x1, y0, z1), (x1, y1, z1), (x0, y1, z1)]
        return self.loft([r0, r1], mat)

    def cbox(self, c, s, mat):
        c = V(c)
        h = V(s) / 2
        return self.box(c - h, c + h, mat)

    def obox(self, c, ax, ay, az, hs, mat):
        c = V(c)
        ax, ay, az = V(ax).normalized(), V(ay).normalized(), V(az).normalized()

        def P(sx, sy, sz):
            return c + ax * (sx * hs[0]) + ay * (sy * hs[1]) + az * (sz * hs[2])
        r0 = [P(-1, -1, -1), P(1, -1, -1), P(1, 1, -1), P(-1, 1, -1)]
        r1 = [P(-1, -1, 1), P(1, -1, 1), P(1, 1, 1), P(-1, 1, 1)]
        return self.loft([r0, r1], mat)

    def tbox(self, p0, p1, s0, s1, mat, fwd=(1, 0, 0), shift1=(0, 0)):
        """Tapered box along axis p0->p1.  s = (width across, depth along fwd)."""
        p0, p1 = V(p0), V(p1)
        a = (p1 - p0).normalized()
        f = V(fwd) - a * a.dot(V(fwd))
        if f.length < 1e-6:
            f = basis(a)[0]
        f.normalize()
        s = a.cross(f).normalized()

        def ring(c, w, d):
            return [c - f * d / 2 - s * w / 2, c + f * d / 2 - s * w / 2,
                    c + f * d / 2 + s * w / 2, c - f * d / 2 + s * w / 2]
        c1 = p1 + s * shift1[0] + f * shift1[1]
        return self.loft([ring(p0, *s0), ring(c1, *s1)], mat)

    # -- round things ---------------------------------------------------------------
    def cyl(self, p0, p1, r0, r1=None, mat='Dark', segs=8, hint=None, rot=0.0, sx=1.0, sy=1.0):
        p0, p1 = V(p0), V(p1)
        r1 = r0 if r1 is None else r1
        d = (p1 - p0)
        u, w = basis(d, hint)
        angs = [rot + 2 * math.pi * k / segs for k in range(segs)]

        def ring(c, r):
            return [c + (u * (math.cos(a) * sx) + w * (math.sin(a) * sy)) * r for a in angs]
        if r1 <= 0:
            return self.loft([ring(p0, r0)], mat, apex_end=p1)
        if r0 <= 0:
            return self.loft([ring(p1, r1)], mat, apex_end=p0)
        return self.loft([ring(p0, r0), ring(p1, r1)], mat)

    def tube(self, pts, radii, mat='Dark', segs=8, hint=None, rot=0.0):
        """Multi-section cylinder along a straight or bent polyline."""
        pts = [V(p) for p in pts]
        rings = []
        for i, p in enumerate(pts):
            if i == 0:
                d = pts[1] - pts[0]
            elif i == len(pts) - 1:
                d = pts[-1] - pts[-2]
            else:
                d = (pts[i + 1] - pts[i]).normalized() + (pts[i] - pts[i - 1]).normalized()
            u, w = basis(d, hint)
            r = radii[i]
            rings.append([p + (u * math.cos(rot + 2 * math.pi * k / segs) + w * math.sin(rot + 2 * math.pi * k / segs)) * r
                          for k in range(segs)])
        return self.loft(rings, mat)

    def ico(self, c, r, mat, subdiv=1, scale=(1, 1, 1), jitter=0.0, seed=0, rot_z=0.0):
        tmp = bmesh.new()
        # bmesh counts the base icosahedron as subdivisions=1; here subdiv=1 means 80 faces
        bmesh.ops.create_icosphere(tmp, subdivisions=subdiv + 1, radius=1.0)
        tmp.verts.index_update()
        rng = random.Random(seed)
        rm = Matrix.Rotation(rot_z, 3, 'Z')
        c = V(c)
        verts = []
        for v in tmp.verts:
            p = v.co.copy()
            if jitter:
                p *= 1.0 + rng.uniform(-jitter, jitter)
            p = V((p.x * r * scale[0], p.y * r * scale[1], p.z * r * scale[2]))
            verts.append(c + rm @ p)
        faces = [[v.index for v in f.verts] for f in tmp.faces]
        tmp.free()
        return self.add(verts, faces, mat)

    def dome(self, c, r, mat, up=(0, 0, 1), fwd=(1, 0, 0), segs=8, rings=3, scale=(1, 1, 1), base=0.0):
        """Hemisphere (closed, flat base) oriented by up/fwd; scale=(fwd, side, up)."""
        c = V(c)
        up = V(up).normalized()
        f = V(fwd) - up * up.dot(V(fwd))
        f.normalize()
        s = up.cross(f).normalized()
        rs = []
        for i in range(rings):
            el = math.radians(base + (90.0 - base) * i / rings)
            rs.append([c + f * (math.cos(el) * math.cos(2 * math.pi * k / segs) * r * scale[0])
                       + s * (math.cos(el) * math.sin(2 * math.pi * k / segs) * r * scale[1])
                       + up * (math.sin(el) * r * scale[2]) for k in range(segs)])
        return self.loft(rs, mat, apex_end=c + up * r * scale[2])

    # -- prisms / lofts -------------------------------------------------------------
    def prism_xz(self, pts, y0, y1, mat):
        return self.loft([[(x, y0, z) for x, z in pts], [(x, y1, z) for x, z in pts]], mat)

    def prism_xy(self, pts, z0, z1, mat):
        return self.loft([[(x, y, z0) for x, y in pts], [(x, y, z1) for x, y in pts]], mat)

    def prism_yz(self, pts, x0, x1, mat):
        return self.loft([[(x0, y, z) for y, z in pts], [(x1, y, z) for y, z in pts]], mat)

    def stack_z(self, sections, mat):
        """sections: [(pts_xy, z), ...] bottom to top, same point count."""
        return self.loft([[(x, y, z) for x, y in pts] for pts, z in sections], mat)

    def loft_x(self, sections, mat):
        """sections: [(x, pts_yz), ...] rear to front, same point count."""
        return self.loft([[(x, y, z) for y, z in pts] for x, pts in sections], mat)

    def slab(self, pts, t, mat, out=None):
        """Thin plate from a planar polygon, extruded by t along its normal (towards out)."""
        pts = [V(p) for p in pts]
        n = V((0, 0, 0))
        for i in range(len(pts)):
            a, b = pts[i], pts[(i + 1) % len(pts)]
            n += V(((a.y - b.y) * (a.z + b.z), (a.z - b.z) * (a.x + b.x), (a.x - b.x) * (a.y + b.y)))
        n.normalize()
        if out is not None and n.dot(V(out)) < 0:
            n = -n
        return self.loft([pts, [p + n * t for p in pts]], mat)

    def band(self, loop_xz, t, y0, y1, mat):
        """Closed track-like band: outer loop (convex, x/z) with thickness t, spanning y0..y1."""
        loop = list(loop_xz)
        if poly_area(loop) < 0:
            loop.reverse()
        inner = offset_loop(loop, t)
        rings = []
        for (ox, oz), (ix_, iz) in zip(loop, inner):
            rings.append([(ox, y0, oz), (ox, y1, oz), (ix_, y1, iz), (ix_, y0, iz)])
        return self.loft(rings, mat, cyclic=True)


# --------------------------------------------------------------------------------------
# Scene / object helpers
# --------------------------------------------------------------------------------------
def reset_scene():
    for o in list(bpy.data.objects):
        bpy.data.objects.remove(o, do_unlink=True)
    for coll in (bpy.data.meshes, bpy.data.materials, bpy.data.cameras, bpy.data.lights,
                 bpy.data.curves):
        for d in list(coll):
            coll.remove(d)
    for img in list(bpy.data.images):
        if img.users == 0:
            bpy.data.images.remove(img)
    sc = bpy.context.scene
    for c in list(sc.collection.children):
        sc.collection.children.unlink(c)
    for c in list(bpy.data.collections):
        bpy.data.collections.remove(c)


def world_loc(obj):
    loc = obj.location.copy()
    p = obj.parent
    while p is not None:
        loc = p.location + p.rotation_euler.to_matrix() @ loc
        p = p.parent
    return loc


def make_node(name, part=None, origin=(0, 0, 0), parent=None, empty_size=0.15):
    """Create an object named `name`.  `part` geometry is in world coordinates; the
    object origin is placed at `origin` (world) and the mesh is shifted accordingly."""
    origin = V(origin)
    if part is not None:
        bm = part.bm
        bmesh.ops.translate(bm, vec=-origin, verts=bm.verts)
        me = bpy.data.meshes.new(name + '_mesh')
        bm.to_mesh(me)
        bm.free()
        for m in part.mats:
            me.materials.append(get_material(m))
        for poly in me.polygons:
            poly.use_smooth = False
        me.update()
        obj = bpy.data.objects.new(name, me)
    else:
        obj = bpy.data.objects.new(name, None)
        obj.empty_display_type = 'PLAIN_AXES'
        obj.empty_display_size = empty_size
    bpy.context.scene.collection.objects.link(obj)
    if obj.name != name:
        raise RuntimeError('object name clash: %s -> %s' % (name, obj.name))
    if parent is not None:
        obj.parent = parent
        obj.location = origin - world_loc(parent)
    else:
        obj.location = origin
    return obj


def descendants(obj):
    out = [obj]
    for c in obj.children:
        out.extend(descendants(c))
    return out


def model_stats(root, exclude_names=('gun',)):
    bpy.context.view_layer.update()
    objs = descendants(root)
    tris = 0
    all_pts, body_pts = [], []
    excluded = set()
    for o in objs:
        if o.name in exclude_names:
            excluded.update(d.name for d in descendants(o))
    for o in objs:
        if o.type != 'MESH':
            continue
        me = o.data
        me.calc_loop_triangles()
        tris += len(me.loop_triangles)
        mw = o.matrix_world
        pts = [mw @ v.co for v in me.vertices]
        all_pts.extend(pts)
        if o.name not in excluded:
            body_pts.extend(pts)

    def bb(pts):
        mn = V((min(p.x for p in pts), min(p.y for p in pts), min(p.z for p in pts)))
        mx = V((max(p.x for p in pts), max(p.y for p in pts), max(p.z for p in pts)))
        return mn, mx
    return tris, bb(all_pts), bb(body_pts or all_pts)


def to_gltf(v):
    """Blender (X fwd, Y left, Z up) -> glTF (+Y up): (x, y, z) -> (x, z, -y)."""
    return [round(v[0], 4), round(v[2], 4), round(-v[1], 4) + 0.0]


def export_glb(path, root, vertex_colors=False):
    """Export the hierarchy under root.  vertex_colors=True exports the active colour attribute as
    COLOR_0 (the v3 vertex-coloured models); otherwise no vertex colours are written."""
    objs = descendants(root)
    for o in bpy.context.scene.objects:
        o.select_set(o in objs)
    bpy.context.view_layer.objects.active = root
    kwargs = dict(filepath=path, export_format='GLB', use_selection=True, export_apply=True,
                  export_yup=True, export_animations=False, export_cameras=False,
                  export_lights=False, export_extras=False, export_texcoords=False,
                  export_normals=True, export_materials='EXPORT', export_tangents=False)
    if vertex_colors:
        bpy.ops.export_scene.gltf(export_vertex_color='ACTIVE', export_all_vertex_colors=False, **kwargs)
        return
    try:
        bpy.ops.export_scene.gltf(export_vertex_color='NONE', **kwargs)
    except TypeError:
        bpy.ops.export_scene.gltf(**kwargs)


# --------------------------------------------------------------------------------------
# Preview rendering (Workbench)
# --------------------------------------------------------------------------------------
def render_preview(path, root, res=(512, 384), az=38.0, el=27.0, color_type='MATERIAL', engine='WORKBENCH'):
    """3/4 view.  engine='WORKBENCH' (fast; color_type='VERTEX' shows the baked vertex colours with
    cavity off) or 'EEVEE' (sun + sky ambient + filmic tone mapping, close to the game's
    MeshStandardMaterial / ACES look; materials read the vertex colours through their nodes)."""
    sc = bpy.context.scene
    bpy.context.view_layer.update()
    objs = [o for o in descendants(root) if o.type == 'MESH']
    pts = [o.matrix_world @ v.co for o in objs for v in o.data.vertices]
    mn = V((min(p.x for p in pts), min(p.y for p in pts), min(p.z for p in pts)))
    mx = V((max(p.x for p in pts), max(p.y for p in pts), max(p.z for p in pts)))
    center = (mn + mx) / 2
    diag = (mx - mn).length

    # ground plane (not exported: created after export)
    gname = 'PreviewGround'
    gmat = bpy.data.materials.get(gname) or make_material(gname, '#a3a39a', 1.0)
    gs = max(diag * 4, 4.0)
    gme = bpy.data.meshes.new(gname)
    gme.from_pydata([(-gs, -gs, -0.002), (gs, -gs, -0.002), (gs, gs, -0.002), (-gs, gs, -0.002)], [], [(0, 1, 2, 3)])
    gme.materials.append(gmat)
    ground = bpy.data.objects.new(gname, gme)
    ground.location = (center.x, center.y, 0)
    sc.collection.objects.link(ground)

    cam_data = bpy.data.cameras.new('PreviewCam')
    cam_data.type = 'ORTHO'
    cam = bpy.data.objects.new('PreviewCam', cam_data)
    sc.collection.objects.link(cam)
    a, e = math.radians(az), math.radians(el)
    dirv = V((math.cos(e) * math.cos(a), math.cos(e) * math.sin(a), math.sin(e)))
    cam.location = center + dirv * (diag * 3 + 5)
    cam.rotation_euler = (-dirv).to_track_quat('-Z', 'Y').to_euler()
    bpy.context.view_layer.update()
    inv = cam.matrix_world.inverted()
    corners = [V((x, y, z)) for x in (mn.x, mx.x) for y in (mn.y, mx.y) for z in (mn.z, mx.z)]
    cs = [inv @ c for c in corners]
    x0, x1 = min(c.x for c in cs), max(c.x for c in cs)
    y0, y1 = min(c.y for c in cs), max(c.y for c in cs)
    aspect = res[0] / res[1]
    cam_data.ortho_scale = max(x1 - x0, (y1 - y0) * aspect) * 1.12
    cam.location = cam.matrix_world @ V(((x0 + x1) / 2, (y0 + y1) / 2, 0))
    cam_data.clip_start = 0.1
    cam_data.clip_end = diag * 10 + 50
    sc.camera = cam

    extra = []
    if engine == 'EEVEE':
        extra = _eevee_setup(sc, center, gmat)
    else:
        sc.render.engine = 'BLENDER_WORKBENCH'
    sc.render.resolution_x, sc.render.resolution_y = res
    sc.render.resolution_percentage = 100
    sc.render.film_transparent = False
    sc.render.image_settings.file_format = 'PNG'
    try:
        sc.view_settings.view_transform = 'AgX' if engine == 'EEVEE' else 'Standard'
        sc.view_settings.look = 'None'
        if engine == 'EEVEE':
            sc.view_settings.look = 'AgX - Medium High Contrast'
    except Exception:
        pass
    sc.view_settings.exposure = 1.0
    sh = sc.display.shading
    sh.light = 'STUDIO'
    sh.color_type = color_type
    sh.show_shadows = True
    sh.shadow_intensity = 0.35
    sh.show_cavity = color_type != 'VERTEX'
    sh.cavity_type = 'WORLD'
    sh.show_object_outline = True
    sh.object_outline_color = (0.05, 0.05, 0.05)
    sh.show_specular_highlight = False
    sc.display.light_direction = (0.35, 0.45, 0.82)
    try:
        sc.display.render_aa = '8'
    except Exception:
        pass
    if engine != 'EEVEE':
        if sc.world is None:
            sc.world = bpy.data.worlds.new('PreviewWorld')
        sc.world.color = (0.55, 0.57, 0.6)
    sc.render.filepath = path
    bpy.ops.render.render(write_still=True)

    for o in extra:
        data = o.data
        bpy.data.objects.remove(o, do_unlink=True)
        if data is not None and data.users == 0:
            bpy.data.lights.remove(data)
    bpy.data.objects.remove(ground, do_unlink=True)
    bpy.data.objects.remove(cam, do_unlink=True)
    bpy.data.meshes.remove(gme)
    bpy.data.cameras.remove(cam_data)


def _eevee_setup(sc, center, gmat):
    """Sun (from the camera's front-left, 50 deg up) + bluish sky ambient, like the game's
    afternoon preset.  Returns the temporary objects to delete afterwards."""
    for eng in ('BLENDER_EEVEE', 'BLENDER_EEVEE_NEXT'):
        try:
            sc.render.engine = eng
            break
        except TypeError:
            continue
    try:
        sc.eevee.taa_render_samples = 32
        sc.eevee.use_shadows = True
    except Exception:
        pass
    ld = bpy.data.lights.new('PreviewSun', 'SUN')
    ld.energy = 3.0
    ld.color = (1.0, 0.95, 0.88)
    ld.angle = math.radians(2.0)
    sun = bpy.data.objects.new('PreviewSun', ld)
    sc.collection.objects.link(sun)
    a, e = math.radians(80.0), math.radians(48.0)
    d = V((math.cos(e) * math.cos(a), math.cos(e) * math.sin(a), math.sin(e)))
    sun.rotation_euler = (-d).to_track_quat('-Z', 'Y').to_euler()
    w = bpy.data.worlds.get('PreviewSky') or bpy.data.worlds.new('PreviewSky')
    try:
        w.use_nodes = True
    except Exception:
        pass
    bg = next((n for n in w.node_tree.nodes if n.type == 'BACKGROUND'), None)
    if bg is not None:
        bg.inputs['Color'].default_value = (0.42, 0.5, 0.62, 1.0)
        bg.inputs['Strength'].default_value = 0.5
    sc.world = w
    # ground: neutral greyish-olive, like terrain seen through the game's fog
    bsdf = next((n for n in gmat.node_tree.nodes if n.type == 'BSDF_PRINCIPLED'), None)
    if bsdf is not None:
        bsdf.inputs['Base Color'].default_value = (0.2, 0.2, 0.17, 1.0)
    return [sun]


def contact_sheet(paths, out_path, cols=5, cell=(256, 192)):
    import numpy as np
    rows = (len(paths) + cols - 1) // cols
    W, H = cols * cell[0], rows * cell[1]
    canvas = np.full((H, W, 4), 0.2, dtype=np.float32)
    canvas[..., 3] = 1.0
    for i, p in enumerate(paths):
        img = bpy.data.images.load(p)
        img.colorspace_settings.name = 'Non-Color'
        img.scale(cell[0], cell[1])
        px = np.array(img.pixels[:], dtype=np.float32).reshape(cell[1], cell[0], 4)
        r, c = divmod(i, cols)
        y0 = (rows - 1 - r) * cell[1]
        canvas[y0:y0 + cell[1], c * cell[0]:(c + 1) * cell[0]] = px
        bpy.data.images.remove(img)
    out = bpy.data.images.new('contact_sheet', W, H, alpha=False)
    out.colorspace_settings.name = 'Non-Color'
    out.pixels.foreach_set(canvas.ravel())
    out.filepath_raw = out_path
    out.file_format = 'PNG'
    out.save()
    bpy.data.images.remove(out)
