"""Trees, bush, drones and crew-served weapons (Blender coords: +X front, +Z up).

Vegetation is built from lumpy "blob" lobes (jittered, staggered-ring spheres) with the Foliage
tag and tapered trunks/branches (Trunk / Birch); mc_finish gives the foliage spherical normals
(stored lobe centres in the object's 'lobes' property) and paints it by height / depth in the
canopy.  Every tree also has a far LOD (``<name>_lod``, <= 100 triangles) with the same size,
silhouette and colour scheme.
"""
import math
import random

from mathutils import Vector

from mc_lib import make_node, sym_y
from mc_finish import VPart as Part

V = Vector
Z = V((0, 0, 1))


def clamp_ground(P, z=0.0):
    for v in P.bm.verts:
        if v.co.z < z:
            v.co.z = z


# --------------------------------------------------------------------------------------
# Vegetation helpers
# --------------------------------------------------------------------------------------
def blob(P, c, r, scale=(1, 1, 1), segs=8, rings=5, jitter=0.12, seed=0, tag='Foliage', flat_bottom=0.0):
    """Lumpy closed ellipsoid: staggered latitude rings (icosphere-like triangles), per-vertex radial
    jitter.  flat_bottom in 0..1 squashes the lower half (canopies are flatter underneath)."""
    rng = random.Random(seed)
    c = V(c)
    rot = rng.uniform(0, 2 * math.pi)
    verts = [c + V((0, 0, -r * scale[2] * (1 - flat_bottom)))]
    rings_idx = []
    for i in range(1, rings):
        el = -math.pi / 2 + math.pi * i / rings
        ce, se = math.cos(el), math.sin(el)
        if se < 0:
            se *= (1 - flat_bottom)
        start = len(verts)
        for k in range(segs):
            a = rot + 2 * math.pi * (k + 0.5 * (i % 2)) / segs
            j = 1 + rng.uniform(-jitter, jitter)
            verts.append(c + V((ce * math.cos(a) * r * scale[0] * j, ce * math.sin(a) * r * scale[1] * j,
                                se * r * scale[2] * j)))
        rings_idx.append(list(range(start, start + segs)))
    top = len(verts)
    verts.append(c + V((0, 0, r * scale[2] * (1 + rng.uniform(-jitter, jitter) * 0.5))))
    faces = []
    A = rings_idx[0]
    for k in range(segs):
        faces.append((0, A[(k + 1) % segs], A[k]))
    for i in range(len(rings_idx) - 1):
        A, B = rings_idx[i], rings_idx[i + 1]
        for k in range(segs):
            k1 = (k + 1) % segs
            if (i + 1) % 2:  # A is shifted by half a step: split along the short diagonal A[k]-B[k+1]
                faces.append((A[k], A[k1], B[k1]))
                faces.append((A[k], B[k1], B[k]))
            else:            # B is shifted: short diagonal A[k+1]-B[k]
                faces.append((A[k], A[k1], B[k]))
                faces.append((A[k1], B[k1], B[k]))
    B = rings_idx[-1]
    for k in range(segs):
        faces.append((B[k], B[(k + 1) % segs], top))
    return P.add(verts, faces, tag)


def limb(P, pts, radii, tag='Trunk', segs=6):
    with P.style(bevel=0):
        return P.tube([V(p) for p in pts], radii, mat=tag, segs=segs)


def tree_node(name, P, lobes):
    """lobes: [(centre, radius), ...] used by mc_finish for the soft foliage normals."""
    clamp_ground(P)
    obj = make_node(name, P)
    obj['lobes'] = [float(x) for c, r in lobes for x in (c[0], c[1], c[2], r)]
    return obj


def droopy_tier(P, z, R, h, segs=8, seed=0, droop=0.35, tag='Foliage'):
    """One conifer tier: apex -> inner ring -> drooping outer ring (alternating branch tips) ->
    underside ring -> lower apex (closed)."""
    rng = random.Random(seed)
    rot = rng.uniform(0, 2 * math.pi)
    verts = [V((rng.uniform(-0.05, 0.05), rng.uniform(-0.05, 0.05), z + h))]
    mid, outer, under = [], [], []
    for k in range(segs):
        a = rot + 2 * math.pi * k / segs
        tip = 1.0 if k % 2 == 0 else 0.8
        rr = R * tip * (1 + rng.uniform(-0.1, 0.1))
        mid.append(V((math.cos(a) * rr * 0.5, math.sin(a) * rr * 0.5, z + h * 0.45)))
        outer.append(V((math.cos(a) * rr, math.sin(a) * rr, z - droop * tip + rng.uniform(-0.08, 0.08))))
        under.append(V((math.cos(a + math.pi / segs) * rr * 0.45, math.sin(a + math.pi / segs) * rr * 0.45,
                        z + 0.05)))
    base = len(verts)
    verts += mid + outer + under
    bot = len(verts)
    verts.append(V((0, 0, z - 0.1)))
    M, O, U = [base + k for k in range(segs)], [base + segs + k for k in range(segs)], \
        [base + 2 * segs + k for k in range(segs)]
    faces = []
    for k in range(segs):
        k1 = (k + 1) % segs
        faces.append((0, M[k], M[k1]))
        faces.append((M[k], O[k], O[k1], M[k1]))
        faces.append((O[k], U[k], O[k1]))
        faces.append((U[k], U[k1], O[k1]))
        faces.append((U[k], bot, U[k1]))
    return P.add(verts, faces, tag)


# --------------------------------------------------------------------------------------
# Oak
# --------------------------------------------------------------------------------------
OAK_LOBES = [((0.0, 0.0, 6.9), 2.0, (1.1, 1.05, 0.85), 1),
             ((1.75, 0.55, 5.55), 1.6, (1.1, 1.0, 0.8), 2),
             ((-1.65, -0.6, 5.75), 1.65, (1.1, 1.05, 0.8), 3),
             ((0.45, -1.8, 5.8), 1.45, (1.05, 1.0, 0.8), 5),
             ((-0.55, 1.7, 5.95), 1.45, (1.05, 1.0, 0.8), 6),
             ((0.35, 0.15, 8.05), 1.3, (1.0, 1.0, 0.85), 4)]


def build_tree_oak():
    P = Part()
    limb(P, [(0, 0, 0), (0.03, 0.02, 1.8), (0.08, 0.04, 3.4), (0.1, 0.05, 5.4)], [0.4, 0.3, 0.24, 0.15], segs=5)
    for (c, r, sc, seed) in OAK_LOBES[1:5]:
        tip = V(c) * 0.72 + V((0, 0, -0.2))
        limb(P, [(0.05, 0.02, 3.1 + 0.15 * seed % 3), (tip.x * 0.5, tip.y * 0.5, (3.3 + tip.z) / 2 + 0.1), tip],
             [0.13, 0.09, 0.05], segs=4)
    for c, r, sc, seed in OAK_LOBES:
        blob(P, c, r, sc, segs=6 if seed == 4 else 7, rings=5, jitter=0.12, seed=seed, flat_bottom=0.3)
    return tree_node('tree_oak', P, [(c, r * sc[0]) for c, r, sc, _ in OAK_LOBES])


def build_tree_oak_lod():
    P = Part()
    with P.style(bevel=0):
        P.cyl((0, 0, 0), (0.1, 0.05, 4.9), 0.36, 0.16, mat='Trunk', segs=5)
    blob(P, (0.05, -0.05, 6.1), 3.25, (1.05, 0.93, 0.83), segs=9, rings=5, jitter=0.07, seed=7, flat_bottom=0.3)
    return tree_node('tree_oak_lod', P, [((0.05, -0.05, 6.1), 3.2)])


# --------------------------------------------------------------------------------------
# Pine
# --------------------------------------------------------------------------------------
PINE_TIERS = [(2.0, 2.5, 1.6), (3.5, 2.15, 1.5), (5.0, 1.8, 1.45), (6.5, 1.45, 1.4), (7.9, 1.1, 1.35),
              (9.2, 0.75, 1.3)]


def build_tree_pine():
    P = Part()
    with P.style(bevel=0):
        P.cyl((0, 0, 0), (0, 0, 10.2), 0.28, 0.06, mat='Trunk', segs=6)
    for i, (z, r, h) in enumerate(PINE_TIERS):
        droopy_tier(P, z, r, h, segs=8, seed=7 + i, droop=0.45 - 0.05 * i)
    with P.style(bevel=0):
        P.cyl((0, 0, 10.3), (0.02, 0.0, 12.0), 0.3, 0.0, mat='Foliage', segs=6)
    return tree_node('tree_pine', P, [((0, 0, z + h * 0.25), r * 0.8) for z, r, h in PINE_TIERS])


def build_tree_pine_lod():
    P = Part()
    with P.style(bevel=0):
        P.cyl((0, 0, 0), (0, 0, 3.0), 0.28, 0.2, mat='Trunk', segs=4)
        for z, r, h in ((1.6, 2.5, 4.2), (4.9, 1.85, 4.2), (8.0, 1.2, 4.0)):
            P.cyl((0, 0, z), (0, 0, z + h), r, 0.0, mat='Foliage', segs=8, rot=0.3 * z)
    return tree_node('tree_pine_lod', P, [((0, 0, 3.0), 2.0), ((0, 0, 6.3), 1.5), ((0, 0, 9.3), 1.0)])


# --------------------------------------------------------------------------------------
# Birch
# --------------------------------------------------------------------------------------
BIRCH_LOBES = [((0.15, 0.1, 8.2), 0.95, (1.0, 0.95, 1.25), 31),
               ((-0.75, 0.55, 7.1), 0.85, (1.0, 1.0, 1.2), 32),
               ((0.95, -0.5, 6.8), 0.85, (1.05, 0.95, 1.15), 33),
               ((-0.35, -0.85, 5.9), 0.75, (1.0, 1.0, 1.15), 34),
               ((0.7, 0.85, 5.6), 0.72, (1.0, 1.0, 1.1), 35),
               ((0.05, 0.05, 9.3), 0.6, (1.0, 1.0, 1.3), 36),
               ((-0.9, -0.1, 5.0), 0.55, (1.0, 1.0, 1.2), 38)]


def build_tree_birch():
    P = Part()
    limb(P, [(0, 0, 0), (0.06, 0.0, 2.5), (0.0, 0.08, 5.0), (0.1, 0.05, 7.6), (0.05, 0.05, 9.4)],
         [0.17, 0.13, 0.1, 0.07, 0.03], tag='Birch', segs=6)
    limb(P, [(0.03, 0.05, 4.4), (0.45, -0.3, 5.3), (0.75, -0.45, 6.1)], [0.05, 0.035, 0.02], tag='Birch', segs=4)
    limb(P, [(0.0, 0.07, 5.0), (-0.35, 0.35, 5.9), (-0.55, 0.45, 6.5)], [0.045, 0.03, 0.02], tag='Birch', segs=4)
    for c, r, sc, seed in BIRCH_LOBES:
        blob(P, c, r, sc, segs=6, rings=4, jitter=0.18, seed=seed, flat_bottom=0.1)
    return tree_node('tree_birch', P, [(c, r * sc[0]) for c, r, sc, _ in BIRCH_LOBES])


def build_tree_birch_lod():
    P = Part()
    with P.style(bevel=0):
        P.cyl((0, 0, 0), (0.05, 0.05, 6.0), 0.17, 0.08, mat='Birch', segs=4)
    blob(P, (0.12, 0.02, 7.25), 1.95, (0.95, 0.9, 1.1), segs=8, rings=5, jitter=0.1, seed=37)
    return tree_node('tree_birch_lod', P, [((0.12, 0.02, 7.25), 1.9)])


# --------------------------------------------------------------------------------------
# Bush
# --------------------------------------------------------------------------------------
BUSH_LOBES = [((0.0, 0.0, 0.5), 0.8, (1.2, 1.1, 0.95), 11),
              ((0.66, 0.38, 0.32), 0.6, (1.1, 1.0, 1.0), 12),
              ((-0.62, -0.3, 0.36), 0.62, (1.1, 1.05, 0.95), 13),
              ((0.14, -0.58, 0.28), 0.52, (1.05, 1.0, 1.0), 14)]


def build_bush():
    P = Part()
    for c, r, sc, seed in BUSH_LOBES:
        blob(P, c, r, sc, segs=7, rings=4, jitter=0.14, seed=seed, flat_bottom=0.2)
    return tree_node('bush', P, [(c, r * sc[0]) for c, r, sc, _ in BUSH_LOBES])


def build_bush_lod():
    P = Part()
    blob(P, (0.3, 0.15, 0.45), 0.95, (1.05, 0.95, 0.85), segs=7, rings=4, jitter=0.1, seed=15, flat_bottom=0.2)
    blob(P, (-0.45, -0.25, 0.38), 0.8, (1.0, 1.0, 0.85), segs=6, rings=4, jitter=0.1, seed=16, flat_bottom=0.2)
    return tree_node('bush_lod', P, [((0.3, 0.15, 0.55), 0.95), ((-0.45, -0.25, 0.5), 0.8)])


# --------------------------------------------------------------------------------------
# Drones
# --------------------------------------------------------------------------------------
def build_drone_quad():
    P = Part(bevel_max=0.008)
    P.min_bevel_thickness = 0.03
    # body: bevelled core, top shell and battery
    P.box((-0.1, -0.05, 0.075), (0.1, 0.05, 0.135), 'Paint')
    P.tbox((0.0, 0, 0.135), (0.0, 0, 0.16), (0.09, 0.18), (0.06, 0.12), 'Paint', fwd=(1, 0, 0))
    P.box((-0.085, -0.036, 0.16), (0.045, 0.036, 0.178), 'Dark')            # battery
    with P.style(bevel=0):
        P.cyl((-0.05, 0.0, 0.178), (-0.05, 0.0, 0.19), 0.022, mat='Metal', segs=10)  # GPS puck
        for s in (1, -1):
            P.cyl((-0.1, s * 0.03, 0.14), (-0.13, s * 0.05, 0.2), 0.003, mat='Dark', segs=4)  # antennas
    arm = 0.24
    for k in range(4):
        a = math.radians(45 + 90 * k)
        d = V((math.cos(a), math.sin(a), 0))
        side = V((-d.y, d.x, 0))
        tip = d * arm + V((0, 0, 0.125))
        P.tbox(V((0, 0, 0.12)) + d * 0.05, tip - d * 0.02, (0.03, 0.022), (0.02, 0.018), 'Dark', fwd=side)
        P.cyl(tip - V((0, 0, 0.022)), tip + V((0, 0, 0.042)), 0.022, mat='Metal', segs=12)   # motor
        with P.style(bevel=0):
            P.cyl(tip + V((0, 0, 0.042)), tip + V((0, 0, 0.05)), 0.008, mat='Metal', segs=6)
            # two-blade propeller, slightly pitched
            blade = V((math.cos(a * 1.7), math.sin(a * 1.7), 0))
            bs = V((-blade.y, blade.x, 0))
            P.obox(tip + V((0, 0, 0.052)), blade, bs, Z, (0.115, 0.013, 0.003), 'Prop')
            P.obox(tip + V((0, 0, 0.001)) - d * 0.01, d, side, Z, (0.01, 0.006, 0.004),
                   'Red' if k in (1, 2) else 'Light')                         # nav LEDs
    for s in (1, -1):                                                       # landing skids
        with P.style(bevel=0):
            P.tube([(-0.09, s * 0.068, 0.006), (0.09, s * 0.068, 0.006)], [0.006, 0.006], mat='Dark', segs=6)
            for x in (-0.05, 0.05):
                P.tube([(x, s * 0.068, 0.006), (x, s * 0.052, 0.078)], [0.005, 0.005], mat='Dark', segs=5)
    # camera gimbal
    P.box((0.085, -0.025, 0.07), (0.115, 0.025, 0.085), 'Dark')
    P.ico((0.13, 0.0, 0.058), 0.028, 'Dark', subdiv=1)
    with P.style(bevel=0):
        P.cyl((0.148, 0.0, 0.058), (0.16, 0.0, 0.058), 0.014, mat='Lens', segs=10)
    return make_node('drone_quad', P)


def build_drone_fixed():
    P = Part(bevel_max=0.006)
    P.min_bevel_thickness = 0.03
    zc = 0.08

    def sec(w, h, n=12):
        return [(w * math.cos(2 * math.pi * k / n + math.pi / n), zc + h * math.sin(2 * math.pi * k / n + math.pi / n))
                for k in range(n)]
    P.loft_x([(-0.5, sec(0.012, 0.012)), (-0.3, sec(0.022, 0.026)), (-0.12, sec(0.042, 0.047)),
              (0.12, sec(0.055, 0.058)), (0.3, sec(0.055, 0.058)), (0.46, sec(0.047, 0.048)),
              (0.56, sec(0.025, 0.026))], 'Paint')
    # high wing with an airfoil-ish section and upturned tips
    for s in (1, -1):
        with P.style(bevel=0.003, segs=1):
            P.loft([[(0.2, s * 0.02, 0.152), (0.12, s * 0.02, 0.172), (0.0, s * 0.02, 0.162), (-0.02, s * 0.02, 0.156),
                     (0.03, s * 0.02, 0.15)],
                    [(0.16, s * 0.78, 0.17), (0.1, s * 0.78, 0.185), (0.02, s * 0.78, 0.178), (0.005, s * 0.78, 0.173),
                     (0.04, s * 0.78, 0.168)],
                    [(0.14, s * 0.9, 0.2), (0.1, s * 0.9, 0.21), (0.05, s * 0.9, 0.205), (0.04, s * 0.9, 0.2),
                     (0.06, s * 0.9, 0.197)]], 'Paint')
    P.box((0.0, -0.025, 0.12), (0.17, 0.025, 0.155), 'Paint')               # wing pylon
    with P.style(bevel=0):
        P.cyl((-0.12, 0, zc + 0.012), (-0.62, 0, zc + 0.02), 0.014, 0.011, mat='Dark', segs=8)   # tail boom
    P.prism_xy([(-0.5, 0.0), (-0.53, 0.28), (-0.62, 0.28), (-0.62, -0.28), (-0.53, -0.28)], zc + 0.014, zc + 0.026,
               'Paint')                                                    # tailplane
    P.prism_xz([(-0.52, zc + 0.02), (-0.63, zc + 0.02), (-0.63, 0.27), (-0.59, 0.27)], -0.005, 0.005, 'Paint')
    with P.style(bevel=0):
        P.cyl((0.56, 0, zc), (0.62, 0, zc), 0.026, 0.006, mat='Metal', segs=10)    # spinner
        for sgn in (1, -1):                                                        # two-blade propeller
            P.obox(V((0.575, 0, zc + sgn * 0.07)), V((0, 0, 1)), V((0.2 * sgn, 1, 0)).normalized(),
                   V((1, -0.2 * sgn, 0)).normalized(), (0.065, 0.012, 0.003), 'Prop')
        P.ico((0.22, 0, 0.034), 0.034, 'Dark', subdiv=1)                           # camera ball
        P.cyl((0.245, 0, 0.03), (0.255, 0, 0.028), 0.016, mat='Lens', segs=10)
        P.cyl((0.1, 0.0, 0.135), (0.08, 0.0, 0.26), 0.003, mat='Dark', segs=4)     # antenna
    zmin = min(v.co.z for v in P.bm.verts)
    for v in P.bm.verts:                                                    # rest on z=0
        v.co.z -= zmin
    return make_node('drone_fixed', P)


# --------------------------------------------------------------------------------------
# Crew-served weapons
# --------------------------------------------------------------------------------------
def build_mortar():
    P = Part(bevel_max=0.008)
    P.min_bevel_thickness = 0.03
    bx = -0.2
    el = math.radians(55)
    d = V((math.cos(el), 0, math.sin(el)))
    P.cyl((bx, 0, 0), (bx, 0, 0.05), 0.27, 0.23, mat='Paint', segs=20)      # baseplate
    with P.style(bevel=0):
        P.cyl((bx, 0, 0.05), (bx, 0, 0.075), 0.09, 0.07, mat='Metal', segs=12)  # socket
        for k in range(6):
            a = math.radians(30 + 60 * k)
            P.obox((bx + math.cos(a) * 0.15, math.sin(a) * 0.15, 0.058), (math.cos(a), math.sin(a), 0),
                   (-math.sin(a), math.cos(a), 0), (0, 0, 1), (0.085, 0.01, 0.016), 'Paint')   # ribs
        for k in range(2):
            a = math.radians(90 + 180 * k)
            P.tube([(bx + math.cos(a) * 0.2, math.sin(a) * 0.2 - 0.04, 0.05),
                    (bx + math.cos(a) * 0.22, math.sin(a) * 0.22, 0.09),
                    (bx + math.cos(a) * 0.2, math.sin(a) * 0.2 + 0.04, 0.05)], [0.008] * 3, mat='Metal', segs=5)
    start = V((bx, 0, 0.09))
    tube_len = 1.28
    P.cyl(start - d * 0.04, start + d * 0.08, 0.065, 0.055, mat='Metal', segs=14)       # breech cap
    P.cyl(start, start + d * tube_len, 0.05, 0.046, mat='Paint', segs=16)
    P.cyl(start + d * (tube_len - 0.06), start + d * tube_len, 0.056, mat='Paint', segs=16)
    with P.style(bevel=0):
        for f in (0.35, 0.55):
            P.cyl(start + d * (tube_len * f), start + d * (tube_len * f + 0.025), 0.054, mat='Metal', segs=14)
    collar = start + d * 0.88
    P.cyl(collar - d * 0.05, collar + d * 0.05, 0.075, mat='Metal', segs=14)
    base = V((collar.x + 0.03, 0, collar.z - 0.34))
    with P.style(bevel=0):
        P.cyl(collar, base, 0.022, mat='Metal', segs=8)                        # elevating gear
        P.cyl(base + V((0, 0, 0.1)), base + V((0, 0, 0.16)), 0.035, mat='Metal', segs=10)
        # elevating and traversing handwheels
        for c0, ax in ((base + V((0.0, 0.0, 0.03)), V((0, 1, 0))), (collar + V((0, -0.1, -0.05)), V((0, 1, 0)))):
            u = V((1, 0, 0))
            w = ax.cross(u)
            ring = [c0 + (u * math.cos(t) + w * math.sin(t)) * 0.06 for t in [2 * math.pi * k / 9 for k in range(8)]]
            P.tube(ring, [0.007] * len(ring), mat='Dark', segs=4)
    P.box((base.x - 0.03, -0.12, base.z - 0.03), (base.x + 0.03, 0.12, base.z + 0.03), 'Metal')
    for s in (1, -1):
        foot = V((collar.x + 0.17, s * 0.3, 0.0))
        with P.style(bevel=0):
            P.cyl(base + V((0, s * 0.1, 0)), foot + V((0, 0, 0.02)), 0.018, mat='Paint', segs=8)
            P.cyl((base + V((0, s * 0.1, 0))).lerp(foot, 0.55), (base + V((0, s * 0.1, 0))).lerp(foot, 0.6), 0.024,
                  mat='Metal', segs=8)
        P.box((foot.x - 0.045, foot.y - 0.035, 0.0), (foot.x + 0.045, foot.y + 0.035, 0.022), 'Dark')
    with P.style(bevel=0):
        P.tube([base + V((0, 0.1, 0.0)), base + V((0, -0.1, 0.0))], [0.012, 0.012], mat='Metal', segs=6)
    P.box((collar.x - 0.05, 0.08, collar.z - 0.02), (collar.x + 0.07, 0.15, collar.z + 0.1), 'Metal')   # sight
    with P.style(bevel=0):
        P.cyl((collar.x + 0.07, 0.115, collar.z + 0.06), (collar.x + 0.085, 0.115, collar.z + 0.06), 0.018,
              mat='Lens', segs=10)
        P.cyl((collar.x - 0.02, 0.115, collar.z + 0.1), (collar.x - 0.02, 0.115, collar.z + 0.16), 0.014,
              mat='Metal', segs=8)
    root = make_node('mortar', P)
    mz = make_node('muzzle', None, start + d * tube_len, parent=root)
    mz.rotation_euler = (0.0, -el, 0.0)    # local +X along the tube
    return root


def build_atgm_tripod():
    P = Part(bevel_max=0.008)
    P.min_bevel_thickness = 0.03
    head = V((0, 0, 0.66))
    for foot in ((0.45, 0, 0), (-0.33, 0.4, 0), (-0.33, -0.4, 0)):
        f = V(foot)
        with P.style(bevel=0):
            P.cyl(head - V((0, 0, 0.02)), f + V((0, 0, 0.03)), 0.022, 0.018, mat='Paint', segs=8)
            P.cyl(head.lerp(f, 0.45), head.lerp(f, 0.5), 0.028, mat='Metal', segs=8)       # leg clamps
        P.cbox(f + V((0, 0, 0.012)), (0.07, 0.07, 0.024), 'Dark')
    P.cyl(head - V((0, 0, 0.08)), head + V((0, 0, 0.05)), 0.055, mat='Metal', segs=14)
    clamp_ground(P)
    root = make_node('atgm', P)

    TO = head + V((0, 0, 0.05))
    T = Part(offset=TO, bevel_max=0.008)
    T.min_bevel_thickness = 0.03
    T.box((-0.09, -0.09, 0.0), (0.09, 0.09, 0.08), 'Metal')
    for s in (1, -1):
        T.box((-0.05, s * 0.09 if s > 0 else -0.115, 0.0), (0.05, s * 0.115 if s > 0 else -0.09, 0.25), 'Metal')
    with T.style(bevel=0):
        T.cyl((0.0, -0.12, 0.04), (0.0, -0.16, 0.04), 0.04, mat='Dark', segs=10)          # traverse handwheel
        T.cyl((0.0, -0.16, 0.04), (0.0, -0.22, 0.02), 0.008, mat='Metal', segs=5)
    tur = make_node('turret', T, TO, parent=root)

    GO = TO + V((0, 0, 0.21))
    G = Part(offset=GO, bevel_max=0.01)
    G.min_bevel_thickness = 0.03
    G.cyl((-0.56, 0, 0), (0.62, 0, 0), 0.075, mat='Paint', segs=16, hint=(0, 0, 1))     # launch tube
    for x0, x1 in ((-0.58, -0.5), (0.54, 0.64)):
        G.cyl((x0, 0, 0), (x1, 0, 0), 0.085, mat='Dark', segs=16, hint=(0, 0, 1))
    with G.style(bevel=0):
        for x in (-0.25, 0.25):
            G.cyl((x, 0, 0), (x + 0.03, 0, 0), 0.08, mat='Dark', segs=16, hint=(0, 0, 1))      # straps
        G.cyl((0.64, 0, 0), (0.645, 0, 0), 0.07, mat='Dark', segs=16, hint=(0, 0, 1))
    G.box((-0.28, 0.08, -0.14), (0.14, 0.24, 0.05), 'Paint')               # guidance / sight unit
    with G.style(bevel=0):
        G.cyl((0.14, 0.13, -0.03), (0.155, 0.13, -0.03), 0.035, mat='Lens', segs=12)
        G.cyl((0.14, 0.2, -0.09), (0.155, 0.2, -0.09), 0.025, mat='Lens', segs=10)
    G.box((-0.28, 0.12, 0.05), (0.08, 0.22, 0.12), 'Paint')                # thermal sight
    with G.style(bevel=0):
        G.box((0.08, 0.135, 0.06), (0.095, 0.205, 0.11), 'Lens')
    G.box((-0.4, 0.1, -0.06), (-0.28, 0.2, 0.02), 'Dark')                   # eyepiece
    with G.style(bevel=0):
        G.cyl((-0.4, 0.15, -0.02), (-0.44, 0.15, -0.02), 0.03, mat='Rubber', segs=10)
    G.box((-0.1, -0.02, -0.16), (-0.04, 0.02, -0.075), 'Dark')              # grip
    gun = make_node('gun', G, GO, parent=tur)
    make_node('muzzle', None, GO + V((0.64, 0, 0)), parent=gun)
    return root
