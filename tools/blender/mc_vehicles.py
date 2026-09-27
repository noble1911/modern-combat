"""Vehicle builders.  Blender coords: +X front, +Y left, +Z up, metres.

Every vehicle returns the root `hull` object with the hierarchy
hull -> turret (origin at turret ring centre) -> gun (origin at trunnion, barrel +X)
-> muzzle (Empty at barrel tip), plus wheel_*/sprocket_*/idler_* children of the hull.

Faces carry *tags* (Paint, Plate, Rubber, Track, Metal, Barrel, Canvas, Glass, Lens, Light, Mark,
...) that mc_finish turns into vertex colours; primitives remember their bevel width (VPart).
Node origins (turret ring, trunnion, muzzle, axles) are unchanged from the v1/v2 models.
"""
import math

from mathutils import Vector

from mc_lib import (make_node, circle_pts, convex_hull_2d, simplify_loop, sym_y, sym_yz, rounded_rect,
                    offset_loop, basis)
from mc_finish import VPart as Part, digits, chevron

V = Vector
SIDES = (1, -1)
Z = V((0, 0, 1))


# --------------------------------------------------------------------------------------
# Rotating parts (own nodes, origin on the axle)
# --------------------------------------------------------------------------------------
_WHEELS = []


def _wheel(name, axle, fn):
    P = Part(bevel_max=0.01)
    fn(P)
    _WHEELS.append((name, P, axle))


def lathe(P, c, axis, prof, tags, segs=12, rot=0.0, lug=0.0, lug_rings=None):
    """Closed surface of revolution about `axis` through c.  prof = [(r, a), ...] from one pole to
    the other (r = 0 gives an apex); tags = one tag per band.  lug_rings = {ring: phase}: those
    rings alternate between r and r - lug per vertex (tyre tread)."""
    c = V(c)
    ax = V(axis).normalized()
    u, w = basis(ax)
    lug_rings = lug_rings or {}
    verts, rings = [], []
    for i, (r, a) in enumerate(prof):
        if r <= 1e-9:
            rings.append(len(verts))
            verts.append(c + ax * a)
            continue
        start = len(verts)
        for k in range(segs):
            ang = rot + 2 * math.pi * k / segs
            rr = r - (lug if (i in lug_rings and (k + lug_rings[i]) % 2) else 0.0)
            verts.append(c + ax * a + (u * math.cos(ang) + w * math.sin(ang)) * rr)
        rings.append(list(range(start, start + segs)))
    faces = []
    for b in range(len(prof) - 1):
        A, B = rings[b], rings[b + 1]
        for k in range(segs):
            k1 = (k + 1) % segs
            if isinstance(A, int):
                faces.append((A, B[k1], B[k]))
            elif isinstance(B, int):
                faces.append((A[k], A[k1], B))
            else:
                faces.append((A[k], A[k1], B[k1], B[k]))
    fs = P.add(verts, faces, tags[0], closed=True)
    for b in range(len(prof) - 1):
        mi = P._mi(tags[b])
        for f in fs[b * segs:(b + 1) * segs]:
            f.material_index = mi
    return fs


def road_wheel(P, c, R, width, s, segs=12, hub='Paint'):
    """Tracked-vehicle road wheel: rubber tyre, dished painted disc, hub cap and a hex nut."""
    c = V(c)
    hw = width / 2
    prof = [(0, hw + 0.012), (0.2 * R, hw + 0.012), (0.68 * R, hw - 0.03), (0.82 * R, hw - 0.004),
            (R, hw - 0.035), (R, -hw), (0, -hw)]
    with P.style(bevel=0):
        lathe(P, c, (0, s, 0), prof, ['Metal', hub, hub, 'Rubber', 'Rubber', 'Rubber'], segs=segs,
              rot=math.pi / segs)
        P.cyl(c + V((0, s * (hw + 0.004), 0)), c + V((0, s * (hw + 0.04), 0)), 0.11 * R, mat='Metal', segs=6,
              hint=(0, 0, 1))


def sprocket_wheel(P, c, R, width, s, teeth=11):
    """Drive sprocket: hub drum with two toothed rings."""
    c = V(c)
    hw = width / 2
    ax = V((0, s, 0))
    with P.style(bevel=0):
        lathe(P, c, ax, [(0, hw + 0.03), (0.22 * R, hw + 0.03), (0.5 * R, hw - 0.01), (0.5 * R, -hw + 0.02),
                         (0, -hw + 0.02)], ['Metal', 'Paint', 'Paint', 'Paint'], segs=12)
        for a0, a1 in ((hw - 0.075, hw - 0.015),):
            rings = []
            for a in (a0, a1):
                ring = []
                for k in range(teeth * 2):
                    ang = 2 * math.pi * k / (teeth * 2)
                    r = R + 0.035 if k % 2 == 0 else R - 0.045
                    ring.append(c + ax * a + V((math.cos(ang) * r, 0, math.sin(ang) * r)))
                rings.append(ring)
            P.loft(rings, 'Dark')
        P.cyl(c + ax * (hw + 0.02), c + ax * (hw + 0.055), 0.1 * R, mat='Metal', segs=6, hint=(0, 0, 1))


def idler_wheel(P, c, R, width, s):
    c = V(c)
    hw = width / 2
    prof = [(0, hw + 0.01), (0.25 * R, hw + 0.01), (0.7 * R, hw - 0.035), (0.86 * R, hw - 0.005),
            (R, hw - 0.025), (R, -hw), (0, -hw)]
    with P.style(bevel=0):
        lathe(P, c, (0, s, 0), prof, ['Metal', 'Paint', 'Paint', 'Dark', 'Dark', 'Dark'], segs=12)
        P.cyl(c + V((0, s * (hw + 0.005), 0)), c + V((0, s * (hw + 0.045), 0)), 0.12 * R, mat='Metal', segs=6,
              hint=(0, 0, 1))


def tyre_wheel(P, c, R, width, s, segs=20, lugs=True, hub='Paint', nuts=6):
    """Wheeled-vehicle wheel: off-road tyre with staggered tread lugs, steel rim and hub."""
    c = V(c)
    hw = width / 2
    d = min(0.035, R * 0.06) if lugs else 0.0
    prof = [(0, hw - 0.005), (0.2 * R, hw - 0.005), (0.4 * R, hw - 0.045), (0.58 * R, hw - 0.03),
            (0.66 * R, hw - 0.015), (0.9 * R, hw + 0.008), (R, hw - 0.06), (R, -hw + 0.06),
            (0.9 * R, -hw - 0.008), (0.62 * R, -hw), (0, -hw)]
    tags = [hub, hub, hub, 'Metal', 'Rubber', 'Rubber', 'Rubber', 'Rubber', 'Rubber', hub]
    with P.style(bevel=0):
        lathe(P, c, (0, s, 0), prof, tags, segs=segs, rot=0.0, lug=d, lug_rings={6: 0, 7: 1})
        ax = V((0, s, 0))
        P.cyl(c + ax * (hw - 0.01), c + ax * (hw + 0.035), 0.13 * R, 0.1 * R, mat='Metal', segs=8, hint=(0, 0, 1))
        for k in range(nuts):
            a = 2 * math.pi * k / nuts
            p = c + V((math.cos(a) * 0.3 * R, 0, math.sin(a) * 0.3 * R))
            P.cyl(p + ax * (hw - 0.03), p + ax * (hw - 0.005), 0.022, mat='Metal', segs=5, hint=(0, 0, 1))


def track_links(P, loop, t, y0, y1, pitch=0.23):
    """Individual track links (boxes) following the convex track loop (x, z, CCW)."""
    path = offset_loop(loop, t / 2)
    n = len(path)
    seg = []
    per = 0.0
    for i in range(n):
        a, b = V(path[i]), V(path[(i + 1) % n])
        L = (b - a).length
        seg.append((a, b, L))
        per += L
    N = max(12, int(round(per / pitch)))
    step = per / N
    yc, hw = (y0 + y1) / 2, abs(y1 - y0) / 2
    with P.style(bevel=0):
        si, acc = 0, 0.0
        for k in range(N):
            s_k = (k + 0.5) * step
            while si < len(seg) - 1 and acc + seg[si][2] < s_k:
                acc += seg[si][2]
                si += 1
            a, b, L = seg[si]
            p = a + (b - a) * ((s_k - acc) / max(L, 1e-9))
            T = (b - a).normalized()
            O = V((T.y, -T.x))  # outward (CCW loop)
            T3, O3 = V((T.x, 0, T.y)), V((O.x, 0, O.y))
            hl = step * 0.43
            cz = p.y
            low = cz - abs(T3.z) * hl - abs(O3.z) * t / 2
            if low < 0:
                cz -= low
            c = V((p.x, yc, cz))
            P.obox(c, T3, V((0, 1, 0)), O3, (hl, hw, t / 2), 'Track')


def running_gear(P, y_out, tw, wheels_x, wr, sprocket, idler, rollers=(), roller_z=0.9, roller_r=0.08,
                 t=0.07, hub_mat='Paint', wheel_segs=12, pitch=0.27, teeth=10):
    """Track links + road wheels, sprocket, idler (own nodes) and return rollers, both sides."""
    y_in = y_out - tw
    wz = wr + t
    yc = (y_in + y_out) / 2
    circles = [(x, wz, wr + t) for x in wheels_x]
    circles.append((sprocket[0], sprocket[1], sprocket[2] + t))
    circles.append((idler[0], idler[1], idler[2] + t))
    circles += [(x, roller_z, roller_r + t) for x in rollers]
    pts = []
    for cx, cz, r in circles:
        pts += circle_pts(cx, cz, r, 32)
    loop = simplify_loop(convex_hull_2d(pts), 0.05)
    for s in SIDES:
        side = 'L' if s > 0 else 'R'
        track_links(P, loop, t, s * y_in, s * y_out, pitch)
        for i, x in enumerate(sorted(wheels_x, reverse=True)):
            ax_c = (x, s * yc, wz)
            _wheel('wheel_%s%d' % (side, i), ax_c,
                   lambda Q, c=ax_c, s=s: road_wheel(Q, c, wr, tw - 0.1, s, segs=wheel_segs, hub=hub_mat))
        cx, cz, cr = sprocket
        sc = (cx, s * yc, cz)
        _wheel('sprocket_%s' % side, sc, lambda Q, c=sc, s=s, cr=cr: sprocket_wheel(Q, c, cr, tw - 0.08, s, teeth))
        cx, cz, cr = idler
        ic = (cx, s * yc, cz)
        _wheel('idler_%s' % side, ic, lambda Q, c=ic, s=s, cr=cr: idler_wheel(Q, c, cr, tw - 0.1, s))
        with P.style(bevel=0):
            for x in rollers:
                P.cyl((x, s * (y_in + 0.08), roller_z), (x, s * (y_out - 0.1), roller_z), roller_r, mat='Rubber',
                      segs=10, hint=(0, 0, 1))
                P.cyl((x, s * (y_out - 0.1), roller_z), (x, s * (y_out - 0.07), roller_z), roller_r * 0.5,
                      mat='Metal', segs=6, hint=(0, 0, 1))
    return y_in


def road_wheels(P, axles_x, wr, width, y_out, segs=20, hub='Paint', nuts=6):
    """Wheeled-vehicle wheels (own nodes).  The axle keeps its v1 height wr*cos(pi/12); the tyre's
    outer radius equals that height so it rests on z = 0."""
    wz = wr * math.cos(math.pi / 12)
    for s in SIDES:
        side = 'L' if s > 0 else 'R'
        for i, x in enumerate(sorted(axles_x, reverse=True)):
            c = (x, s * (y_out - width / 2), wz)
            _wheel('wheel_%s%d' % (side, i), c,
                   lambda Q, c=c, s=s: tyre_wheel(Q, c, wz, width, s, segs=segs, hub=hub, nuts=nuts))


# --------------------------------------------------------------------------------------
# Detail helpers
# --------------------------------------------------------------------------------------
def plane_pts(a, b, y0, y1, u0, u1):
    """Points of a quad lying on the plane through side-profile line a->b (x,z), spanning
    y0..y1 and parameter u0..u1 along the line."""
    ax, az = a
    bx, bz = b

    def P(u, y):
        return (ax + (bx - ax) * u, y, az + (bz - az) * u)
    return [P(u0, y0), P(u1, y0), P(u1, y1), P(u0, y1)]


def glacis_slab(P, a, b, y0, y1, u0, u1, t, mat):
    """Plate lying on a sloped hull face given by side-profile line a->b (outward = up/forward)."""
    P.slab(plane_pts(a, b, y0, y1, u0, u1), t, mat, out=(1, 0, 1))


def glacis_frame(a, b, u, y):
    """(point, along-slope unit vector, +Y, outward normal) on the sloped face a->b (x, z)."""
    a3, b3 = V((a[0], 0, a[1])), V((b[0], 0, b[1]))
    d = (b3 - a3).normalized()
    n = V((0, 1, 0)).cross(d).normalized()
    if n.dot(V((1, 0, 1))) < 0:
        n = -n
    p = a3 + (b3 - a3) * u + V((0, y, 0))
    return p, d, V((0, 1, 0)), n


def grille(P, x0, x1, y0, y1, z, n=5, h=0.035, mat='Dark', base='Plate'):
    """Engine deck louvres: a flat access panel with n raised slats running across the vehicle."""
    P.box((x0 - 0.04, y0 - 0.04, z - 0.01), (x1 + 0.04, y1 + 0.04, z + 0.012), base)
    w = (x1 - x0) / (2 * n - 1)
    with P.style(bevel=0):
        for i in range(n):
            xa = x0 + i * 2 * w
            P.box((xa, y0, z), (xa + w, y1, z + h), mat)


def barrel(P, sections, mat='Barrel', segs=16):
    """Barrel along +X from a list of (x0, x1, r0, r1)."""
    for x0, x1, r0, r1 in sections:
        P.cyl((x0, 0, 0), (x1, 0, 0), r0, r1, mat=mat, segs=segs, hint=(0, 0, 1), rot=math.pi / segs)


def lamp(P, c, facing=(1, 0, 0), r=0.06, tag='Light', depth=0.07, guard=False):
    c, f = V(c), V(facing).normalized()
    with P.style(bevel=0):
        P.cyl(c - f * depth, c, r * 1.3, mat='Metal', segs=10)
        P.cyl(c - f * 0.01, c + f * 0.01, r, mat=tag, segs=10)
        if guard:
            u = Z.cross(f).normalized() if abs(f.z) < 0.9 else V((0, 1, 0))
            w = f.cross(u).normalized()
            for k in (-0.4, 0.4):
                P.obox(c + f * 0.05 + w * (k * r * 1.2), u, w, f, (r * 1.45, 0.007, 0.007), 'Metal')


def tail_light(P, c, facing=(-1, 0, 0), w=0.14, h=0.09):
    c, f = V(c), V(facing).normalized()
    u = Z.cross(f).normalized()
    P.obox(c - f * 0.03, f, u, Z, (0.03, w / 2 + 0.02, h / 2 + 0.02), 'Metal')
    with P.style(bevel=0):
        P.obox(c + f * 0.004 + Z * (h * 0.2), f, u, Z, (0.006, w / 2, h * 0.22), 'Red')
        P.obox(c + f * 0.004 - Z * (h * 0.25), f, u, Z, (0.006, w / 2, h * 0.15), 'Light')


def tow_hook(P, c, facing=(1, 0, 0), size=1.0):
    c, f = V(c), V(facing).normalized()
    u = Z.cross(f).normalized() if abs(f.z) < 0.95 else V((0, 1, 0))
    w = f.cross(u).normalized()
    P.obox(c - f * 0.02 * size, f, u, w, (0.04 * size, 0.07 * size, 0.07 * size), 'Metal')
    with P.style(bevel=0):
        P.tube([c + f * 0.02 * size, c + f * 0.1 * size, c + f * 0.14 * size + w * 0.07 * size],
               [0.02 * size] * 3, mat='Metal', segs=6)


def cable(P, pts, r=0.016, eyes=True):
    pts = [V(p) for p in pts]
    with P.style(bevel=0):
        P.tube(pts, [r] * len(pts), mat='Cable', segs=6)
        if eyes:
            for end, nxt in ((pts[0], pts[1]), (pts[-1], pts[-2])):
                d = (end - nxt).normalized()
                u, w = basis(d)
                ring = [end + d * 0.055 + (d * math.cos(a) + u * math.sin(a)) * 0.05
                        for a in [math.pi + 2 * math.pi * k / 6 for k in range(6)]]
                P.tube(ring, [r * 1.1] * len(ring), mat='Cable', segs=4)


def grab(P, a, b, n, h=0.07, r=0.012):
    """Handhold / grab rail: a U-shaped bar from a to b standing off by h along n (three thin
    square bars: robust at the bends, cheap)."""
    a, b, n = V(a), V(b), V(n).normalized()
    d = b - a
    L = d.length
    d = d.normalized()
    n = (n - d * n.dot(d)).normalized()
    w = d.cross(n).normalized()
    with P.style(bevel=0):
        for p in (a, b):
            P.obox(p + n * (h / 2 - 0.005), n, d, w, (h / 2 + 0.005, r, r), 'Metal')
        P.obox((a + b) / 2 + n * h, d, n, w, (L / 2 + r, r, r), 'Metal')


def periscope(P, c, facing=(1, 0, 0), w=0.16, h=0.07, d=0.1):
    c, f = V(c), V(facing).normalized()
    u = Z.cross(f).normalized()
    up = f.cross(u).normalized()
    P.obox(c, f, u, up, (d / 2, w / 2 + 0.015, h / 2), 'Metal')
    with P.style(bevel=0):
        P.obox(c + f * (d / 2 + 0.002) + up * 0.005, f, u, up, (0.004, w / 2, h / 2 - 0.012), 'Glass')


def antenna(P, base, h=0.6, r=0.01, lean=(0, 0, 0)):
    b = V(base)
    top = b + V((0, 0, h)) + V(lean)
    P.cyl(b - V((0, 0, 0.01)), b + V((0, 0, 0.09)), 0.045, 0.035, mat='Metal', segs=8)
    with P.style(bevel=0):
        P.cyl(b + V((0, 0, 0.09)), b + V((0, 0, 0.16)), 0.018, mat='Dark', segs=6)
        P.cyl(b + V((0, 0, 0.16)), top, r, r * 0.4, mat='Dark', segs=4)


def jerrycan(P, c, yaw=0.0, tag='Paint', lying=False):
    c = V(c)
    fx = V((math.cos(yaw), math.sin(yaw), 0))
    fy = Z.cross(fx)
    hs = (0.235, 0.17, 0.083) if lying else (0.17, 0.083, 0.235)
    with P.style(bevel=0.012, segs=1):
        P.obox(c, fx, fy, Z, hs, tag)
    if not lying:
        with P.style(bevel=0):
            P.obox(c + Z * (hs[2] + 0.015), fx, fy, Z, (0.1, 0.02, 0.015), tag)
            P.cyl(c + Z * hs[2] + fx * 0.12, c + Z * (hs[2] + 0.04) + fx * 0.14, 0.022, mat='Metal', segs=6)


def bag(P, c, size, yaw=0.0, tag='Canvas', strap=True):
    c = V(c)
    fx = V((math.cos(yaw), math.sin(yaw), 0))
    fy = Z.cross(fx)
    hs = (size[0] / 2, size[1] / 2, size[2] / 2)
    with P.style(bevel=min(size) * 0.3, segs=2):
        P.obox(c, fx, fy, Z, hs, tag)
    if strap:
        with P.style(bevel=0):
            P.obox(c, fx, fy, Z, (0.018, hs[1] * 0.9 + 0.004, hs[2] * 0.95 + 0.004), 'Dark')


def roll(P, p0, p1, r, tag='Canvas'):
    p0, p1 = V(p0), V(p1)
    d = (p1 - p0).normalized()
    P.cyl(p0, p1, r, mat=tag, segs=12, hint=(0, 0, 1))
    with P.style(bevel=0):
        for f in (0.2, 0.8):
            c = p0 + (p1 - p0) * f
            P.cyl(c - d * 0.018, c + d * 0.018, r + 0.008, mat='Dark', segs=10, hint=(0, 0, 1))


def crate(P, mn, mx, tag='Paint', latch=True):
    mn, mx = V(mn), V(mx)
    P.box(mn, mx, tag)
    with P.style(bevel=0):
        P.box((mn.x - 0.012, mn.y - 0.012, mx.z - 0.04), (mx.x + 0.012, mx.y + 0.012, mx.z - 0.01), tag)
        if latch:
            for fy in (0.25, 0.75):
                y = mn.y + (mx.y - mn.y) * fy
                P.box((mx.x, y - 0.025, mx.z - 0.1), (mx.x + 0.015, y + 0.025, mx.z - 0.03), 'Metal')


def smoke_bank(P, base, out, n=4, spacing=0.09, r=0.036, L=0.2, up=0.35, tag='Dark', rows=1):
    """n smoke-grenade tubes in a fan, pointing along `out` tilted up, on a mounting bracket."""
    base, out = V(base), V(out).normalized()
    side = Z.cross(out).normalized()
    for row in range(rows):
        for k in range(n):
            off = (k - (n - 1) / 2) * spacing
            d = (out + Z * (up + 0.12 * row) + side * (off * 0.8)).normalized()
            p = base + side * off + Z * (row * 0.085)
            P.cyl(p, p + d * L, r, mat=tag, segs=6)
    P.obox(base - out * 0.02 + Z * (0.04 * (rows - 1)), out, side, Z,
           (0.04, spacing * n / 2 + 0.02, 0.05 + 0.04 * (rows - 1)), 'Metal')


def spare_links(P, origin, u, v, n, count=5, pitch=0.2, w=0.5, t=0.05):
    """A row of spare track links lying on a plane (origin, u along the row, v across, n out)."""
    origin, u, v, n = V(origin), V(u).normalized(), V(v).normalized(), V(n).normalized()
    with P.style(bevel=0):
        for k in range(count):
            c = origin + u * ((k - (count - 1) / 2) * pitch) + n * (t / 2)
            P.obox(c, u, v, n, (pitch * 0.43, w / 2, t / 2), 'Track')
            P.obox(c + n * (t / 2 + 0.006), u, v, n, (pitch * 0.14, w * 0.46, 0.008), 'Track')


def face_frame(p0, p1, p2):
    """(origin=p0, u along p0->p1, v in-plane towards p2, n = u x v) for decals on a planar face."""
    p0, p1, p2 = V(p0), V(p1), V(p2)
    u = (p1 - p0).normalized()
    n = u.cross(p2 - p0).normalized()
    v = n.cross(u).normalized()
    return p0, u, v, n


def side_decal_frame(s, n_hint=None):
    """Frame for markings on a vertical side face (+Y side when s > 0): u runs front-to-back as
    seen from that side, v up, n outward."""
    n = V((0, s, 0)) if n_hint is None else V(n_hint).normalized()
    u = Z.cross(n).normalized()
    v = n.cross(u).normalized()
    return u, v, n


def add(a, b):
    return tuple(x + y for x, y in zip(a, b))


def assemble(hull_p, turret_p, turret_o, gun_p, gun_o, muzzle_o, extra_muzzles=()):
    hull = make_node('hull', hull_p, (0, 0, 0))
    for name, P, axle in _WHEELS:
        make_node(name, P, axle, parent=hull)
    _WHEELS.clear()
    tur = make_node('turret', turret_p, turret_o, parent=hull)
    gun = make_node('gun', gun_p, gun_o, parent=tur)
    make_node('muzzle', None, muzzle_o, parent=gun)
    for name, o in extra_muzzles:
        make_node(name, None, o, parent=gun)
    return hull


def m2hb(P, c, d=(1, 0, 0), L=1.0, can=True, can_tag='Paint'):
    """M2 / Kord style heavy MG: receiver, barrel with jacket and flash hider, optional ammo can."""
    c, d = V(c), V(d).normalized()
    u = Z.cross(d).normalized()
    P.obox(c, d, u, Z, (0.3, 0.07, 0.075), 'Metal')
    P.obox(c - d * 0.33, d, u, Z, (0.04, 0.05, 0.05), 'Dark')
    with P.style(bevel=0):
        P.cyl(c + d * 0.3, c + d * 0.52, 0.042, mat='Barrel', segs=10)
        P.cyl(c + d * 0.52, c + d * L, 0.024, mat='Barrel', segs=8)
        P.cyl(c + d * (L - 0.1), c + d * L, 0.032, mat='Barrel', segs=8)
    if can:
        P.obox(c - d * 0.02 - u * 0.17 - Z * 0.03, d, u, Z, (0.14, 0.07, 0.1), can_tag)


# --------------------------------------------------------------------------------------
# M1A2 SEPv3 Abrams
# --------------------------------------------------------------------------------------
def build_m1a2():
    H = Part(bevel_max=0.03)
    running_gear(H, y_out=1.74, tw=0.635, wheels_x=[2.25 - i * 0.8 for i in range(7)], wr=0.32,
                 sprocket=(-3.38, 0.62, 0.33), idler=(3.3, 0.55, 0.3), rollers=(1.65, 0.0, -1.7),
                 roller_z=0.84, t=0.08, teeth=12)
    # lower hull between the tracks and upper hull (full width, over the tracks)
    H.prism_xz([(-3.6, 0.45), (3.2, 0.45), (3.9, 1.0), (-3.95, 1.0), (-3.95, 0.8)], -1.1, 1.1, 'Paint')
    H.prism_xz([(-3.95, 0.98), (3.9, 0.98), (3.95, 1.06), (2.3, 1.43), (-3.85, 1.45), (-3.95, 1.38)],
               -1.77, 1.77, 'Paint')
    for s in SIDES:
        # side skirts: heavy armoured front panels, lighter rear ones
        H.prism_xz([(2.36, 0.56), (3.5, 0.56), (3.85, 0.99), (2.36, 1.0)], s * 1.77, s * 1.87, 'Paint')
        xs = [2.34, 1.56, 0.78, 0.0, -0.8, -1.6, -2.42, -3.25]
        for i in range(len(xs) - 1):
            yo = 1.87 if i < 2 else 1.84
            H.box((xs[i + 1] + 0.012, min(s * 1.77, s * yo), 0.56), (xs[i] - 0.012, max(s * 1.77, s * yo), 1.0),
                  'Paint')
        for x in (1.2, -2.0):
            yo = 1.87 if x > 0.78 else 1.84
            grab(H, (x - 0.1, s * yo, 0.93), (x + 0.1, s * yo, 0.93), (0, s, 0), h=0.04)
        # headlight clusters with guards
        H.box((3.58, s * 1.3 if s > 0 else -1.66, 1.02), (3.86, s * 1.66 if s > 0 else -1.3, 1.1), 'Metal')
        lamp(H, (3.83, s * 1.39, 1.16), r=0.045, guard=True)
        lamp(H, (3.83, s * 1.57, 1.16), r=0.045, tag='Lens')
        # tail lights and rear fender stowage boxes
        tail_light(H, (-3.97, s * 1.5, 1.27))
        crate(H, (-3.8, min(s * 1.25, s * 1.72), 1.44), (-2.6, max(s * 1.25, s * 1.72), 1.6), 'Paint')
        # tow hooks front & rear
        tow_hook(H, (3.62, s * 0.72, 0.72), (0.75, 0, -0.66))
        tow_hook(H, (-3.96, s * 0.8, 0.9), (-1, 0, 0))
        # mud flaps at the front of the fenders
        H.box((3.84, min(s * 1.46, s * 1.74), 0.72), (3.87, max(s * 1.46, s * 1.74), 0.98), 'Rubber')
    # engine deck louvres, access panels, rear exhaust grille
    grille(H, -3.6, -1.95, -1.1, 1.1, 1.445, n=7)
    for y0, y1 in ((-1.6, -1.2), (1.2, 1.6)):
        H.box((-3.5, y0, 1.445), (-2.05, y1, 1.46), 'Plate')
    H.box((-3.99, -1.05, 0.93), (-3.93, 1.05, 1.32), 'Dark')
    with H.style(bevel=0):
        for i in range(6):
            z = 0.97 + i * 0.058
            H.box((-4.0, -1.0, z), (-3.95, 1.0, z + 0.025), 'Metal')
    # tow cable along the rear deck edge
    cable(H, [(-3.8, 1.2, 1.47), (-3.83, 0.4, 1.465), (-3.83, -0.4, 1.465), (-3.8, -1.2, 1.47)])
    # driver's periscopes and hatch
    for y in (-0.28, 0.0, 0.28):
        periscope(H, (2.49, y, 1.41), (1, 0, 0.35), w=0.18, h=0.07, d=0.12)
    H.cyl((2.05, 0.0, 1.43), (2.05, 0.0, 1.48), 0.3, mat='Plate', segs=16)
    # non-slip plates on the front fenders
    for s in SIDES:
        glacis_slab(H, (3.95, 1.06), (2.3, 1.43), min(s * 1.25, s * 1.72), max(s * 1.25, s * 1.72), 0.25, 0.9, 0.012,
                    'Plate')

    # --- turret (local coords, origin at ring centre) ---
    TO = (0.35, 0.0, 1.44)
    T = Part(offset=TO, bevel_max=0.028)
    T.stack_z([
        (sym_y([(1.5, 0.43), (1.8, 0.5), (1.3, 1.48), (-1.3, 1.52), (-2.85, 1.35)]), 0.02),
        (sym_y([(1.7, 0.45), (2.05, 0.55), (1.45, 1.58), (-1.35, 1.65), (-2.9, 1.45)]), 0.32),
        (sym_y([(1.62, 0.42), (1.88, 0.5), (1.32, 1.48), (-1.3, 1.53), (-2.8, 1.33)]), 0.88),
    ], 'Paint')

    # bustle rack: floor, posts, rails and stowage
    T.box((-3.35, -1.45, 0.26), (-2.82, 1.45, 0.3), 'Metal')
    with T.style(bevel=0):
        for y in (-1.43, -0.95, -0.47, 0.0, 0.47, 0.95, 1.43):
            T.box((-3.37, y - 0.02, 0.3), (-3.33, y + 0.02, 0.74), 'Metal')
        for s in SIDES:
            for x in (-3.1, -2.86):
                T.box((x - 0.02, s * 1.45 - 0.02, 0.3), (x + 0.02, s * 1.45 + 0.02, 0.74), 'Metal')
    for z in (0.5, 0.74):
        T.tube([V((-2.84, 1.46, z)), V((-3.35, 1.46, z)), V((-3.35, -1.46, z)), V((-2.84, -1.46, z))],
               [0.016] * 4, mat='Metal', segs=5)
    bag(T, V((-3.05, 0.95, 0.44)), (0.42, 0.7, 0.3))
    bag(T, V((-3.08, 0.3, 0.42)), (0.38, 0.5, 0.26), yaw=0.1)
    crate(T, V((-3.28, -0.95, 0.3)), V((-2.88, -0.2, 0.6)), 'Canvas')
    roll(T, V((-3.08, -1.4, 0.7)), V((-3.08, 0.25, 0.7)), 0.1)
    jerrycan(T, V((-3.06, -1.2, 0.54)), yaw=math.pi / 2)
    for s in SIDES:
        # Trophy APS: housing, two flat radar panels and the launcher on top
        T.box((0.45, min(s * 1.46, s * 1.84), 0.16), (1.2, max(s * 1.46, s * 1.84), 0.7), 'Paint')
        for x, a in ((1.0, 0.55), (0.64, -0.55)):
            nrm = V((math.sin(a), s * math.cos(a), 0))
            c = V((x, s * 1.86, 0.43))
            T.obox(c, nrm, Z.cross(nrm), Z, (0.035, 0.19, 0.22), 'Plate')
            with T.style(bevel=0):
                T.obox(c + nrm * 0.036, nrm, Z.cross(nrm), Z, (0.003, 0.15, 0.18), 'Dark')
        T.cyl((0.82, s * 1.66, 0.7), (0.82, s * 1.66, 0.78), 0.16, mat='Metal', segs=16)
        T.box((0.64, min(s * 1.52, s * 1.8), 0.78), (1.02, max(s * 1.52, s * 1.8), 0.96), 'Paint')
        with T.style(bevel=0):
            for z in (0.83, 0.9):
                T.box((1.02, min(s * 1.58, s * 1.75), z - 0.025), (1.035, max(s * 1.58, s * 1.75), z + 0.025), 'Dark')
        # smoke grenade launchers (2 x 3 tubes)
        smoke_bank(T, V((1.32, s * 1.3, 0.8)), (0.6, s * 0.8, 0), n=3, spacing=0.09, rows=2)
        # blow-out panels
        T.box((-2.55, min(s * 0.12, s * 0.62), 0.86), (-1.45, max(s * 0.12, s * 0.62), 0.9), 'Plate')
        T.box((-2.55, min(s * 0.68, s * 1.15), 0.86), (-1.45, max(s * 0.68, s * 1.15), 0.9), 'Plate')
        # markings on the turret side: company chevron + tank number
        p0, p1, p2 = V((-1.35, s * 1.65, 0.32)), V((-2.9, s * 1.45, 0.32)), V((-1.3, s * 1.53, 0.88))
        o, u, v, n = face_frame(p0, p1, p2)
        if n.y * s < 0:
            n = -n
        u = n.cross(v).normalized() * -1 if False else u
        if (u.x > 0) != (s < 0):
            u = -u
        centre = o + (p1 - o) * 0.42 + (p2 - o) * 0.5
        chevron(T, centre - u * 0.2, u, v, n, size=0.24, bar=0.05, tag='Mark')
        digits(T, '24', centre + u * 0.18, u, v, n, h=0.19, tag='Mark')
    # gunner's primary sight "doghouse" (right front) with armoured doors
    T.box((0.9, -1.0, 0.85), (1.52, -0.52, 1.12), 'Paint')
    with T.style(bevel=0):
        T.box((1.52, -0.94, 0.9), (1.535, -0.58, 1.07), 'Lens')
    T.box((1.3, -1.05, 0.84), (1.56, -1.0, 1.13), 'Plate')
    T.box((1.3, -0.52, 0.84), (1.56, -0.47, 1.13), 'Plate')
    # CITV (left front)
    T.cyl((0.9, 0.85, 0.85), (0.9, 0.85, 1.0), 0.18, mat='Paint', segs=16)
    T.box((0.7, 0.66, 1.0), (1.1, 1.04, 1.22), 'Paint')
    with T.style(bevel=0):
        T.box((1.1, 0.72, 1.04), (1.115, 0.98, 1.18), 'Lens')
    # commander's cupola with vision blocks and the CROWS RWS (right)
    T.cyl((-0.55, -0.72, 0.85), (-0.55, -0.72, 0.97), 0.42, mat='Paint', segs=20)
    T.cyl((-0.75, -0.72, 0.97), (-0.75, -0.72, 1.01), 0.24, mat='Plate', segs=16)
    for k in range(5):
        a = math.radians(-70 + k * 35)
        periscope(T, V((-0.55 + math.cos(a) * 0.37, -0.72 + math.sin(a) * 0.37, 0.99)),
                  (math.cos(a), math.sin(a), 0), w=0.1, h=0.05, d=0.06)
    T.box((-0.42, -0.9, 0.97), (-0.08, -0.54, 1.08), 'Paint')               # CROWS pedestal
    for y in (-0.94, -0.5):
        T.box((-0.36, y - 0.03, 1.05), (-0.12, y + 0.03, 1.36), 'Paint')    # cradle arms
    m2hb(T, V((-0.2, -0.72, 1.3)), L=1.0)
    T.box((-0.33, -1.14, 1.18), (-0.02, -0.97, 1.42), 'Paint')              # sensor unit
    with T.style(bevel=0):
        T.cyl((-0.02, -1.05, 1.34), (0.0, -1.05, 1.34), 0.045, mat='Lens', segs=10)
        T.box((-0.02, -1.11, 1.2), (-0.005, -1.0, 1.27), 'Lens')
    # loader's hatch with M240 and gun shield (left)
    T.cyl((-0.5, 0.72, 0.85), (-0.5, 0.72, 0.94), 0.38, mat='Paint', segs=20)
    T.cyl((-0.6, 0.72, 0.94), (-0.6, 0.72, 0.98), 0.26, mat='Plate', segs=16)
    T.box((-0.2, 0.42, 0.94), (-0.15, 1.02, 1.3), 'Paint')
    for s2 in (1, -1):
        T.obox(V((-0.3, 0.72 + s2 * 0.34, 1.12)), V((0.6, s2 * 0.8, 0)), V((-s2 * 0.8, 0.6, 0)), Z,
               (0.14, 0.02, 0.18), 'Paint')
    with T.style(bevel=0):
        T.box((-0.55, 0.69, 1.05), (-0.15, 0.75, 1.11), 'Metal')
        T.cyl((-0.15, 0.72, 1.08), (0.4, 0.72, 1.08), 0.018, mat='Barrel', segs=8)
    # wind sensor mast and antennas
    with T.style(bevel=0):
        T.cyl((-1.9, 0.35, 0.86), (-1.9, 0.35, 1.3), 0.018, mat='Dark', segs=6)
        T.box((-1.93, 0.25, 1.28), (-1.87, 0.45, 1.31), 'Dark')
    for s in SIDES:
        antenna(T, V((-2.6, s * 1.05, 0.88)), h=0.62)
        grab(T, V((-0.4, s * 1.535, 0.7)), V((-1.1, s * 1.56, 0.7)), (0, s, 0), h=0.05)

    # --- gun (origin at trunnion) ---
    GO = add(TO, (1.6, 0.0, 0.47))
    G = Part(offset=GO, bevel_max=0.02)
    G.box((-0.3, -0.42, -0.3), (0.52, 0.42, 0.28), 'Paint')           # mantlet
    G.box((0.52, -0.35, -0.24), (0.58, 0.35, 0.2), 'Plate')            # gun shield face
    barrel(G, [(0.55, 1.7, 0.125, 0.12), (1.7, 2.3, 0.15, 0.15), (2.3, 4.35, 0.105, 0.095),
               (4.35, 4.5, 0.11, 0.11)])
    with G.style(bevel=0):
        for x, r in ((1.2, 0.128), (2.9, 0.106), (3.6, 0.103)):
            G.cyl((x, 0, 0), (x + 0.04, 0, 0), r, mat='Barrel', segs=16, hint=(0, 0, 1))
    G.box((4.22, -0.035, 0.09), (4.38, 0.035, 0.16), 'Metal')          # muzzle reference sensor
    G.cyl((0.5, -0.28, 0.1), (0.75, -0.28, 0.1), 0.025, mat='Barrel', segs=8)  # coax
    L = 4.5
    return assemble(H, T, TO, G, GO, add(GO, (L, 0, 0)))


# --------------------------------------------------------------------------------------
# Soviet-style MBT hull shared by T-90M and T-72B3
# --------------------------------------------------------------------------------------
def split_quad(q, k, n, gap=0.02):
    """Sub-quad k of n of the quad q = (A, B, C, D) split along A->B / D->C with small gaps."""
    A, B, C, D = (V(p) for p in q)
    L = (B - A).length
    g = gap / max(L, 1e-6)
    u0, u1 = k / n + g / 2, (k + 1) / n - g / 2
    return [A + (B - A) * u0, A + (B - A) * u1, D + (C - D) * u1, D + (C - D) * u0]


def soviet_hull(H, half_w, skirt_era, glacis_style):
    xf, xr = 3.45, -3.35
    y_out = half_w - 0.08
    running_gear(H, y_out=y_out, tw=0.58, wheels_x=[2.08 - i * 0.84 for i in range(6)], wr=0.375,
                 sprocket=(-3.02, 0.55, 0.32), idler=(2.95, 0.5, 0.28), rollers=(1.65, 0.25, -1.1),
                 roller_z=0.9, roller_r=0.08, t=0.07)
    ga, gb = (xf, 0.92), (2.05, 1.38)          # glacis line (side profile)
    xg = xf - (0.08 / 0.46) * (xf - 2.05)       # where the glacis crosses z=1.0
    H.prism_xz([(-3.2, 0.42), (2.85, 0.42), ga, gb, (xr + 0.05, 1.4), (xr, 1.05)], -1.12, 1.12, 'Paint')
    H.prism_xz([(xr, 1.0), (xg, 1.0), gb, (xr + 0.05, 1.4)], -y_out, y_out, 'Paint')
    for s in SIDES:
        lo, hi = (lambda a, b: (min(a, b), max(a, b)))(s * y_out, s * (y_out + 0.05))
        # rubber side skirt flaps
        xs = [3.15, 2.1, 1.05, 0.0, -1.0, -2.0, -3.0]
        for i in range(len(xs) - 1):
            H.box((xs[i + 1] + 0.01, lo, 0.64), (xs[i] - 0.01, hi, 1.0), 'Rubber')
        # fender stowage boxes / fuel tanks
        for x0, x1 in ((1.15, 1.9), (0.1, 1.0), (-1.05, -0.05), (-2.4, -1.25)):
            a, b = sorted((s * 1.2, s * (y_out - 0.04)))
            crate(H, (x0, a, 1.4), (x1, b, 1.56), 'Paint')
        # headlight cluster with guard + IR lamp
        H.box((2.5, min(s * 1.16, s * 1.42), 1.3), (2.62, max(s * 1.16, s * 1.42), 1.36), 'Metal')
        lamp(H, (2.66, s * 1.23, 1.41), r=0.05, guard=True)
        lamp(H, (2.66, s * 1.36, 1.41), r=0.04, tag='Lens')
        # tow cable along the fender side, tow hooks, mud flaps, tail lights
        cable(H, [(1.9, s * (y_out + 0.02), 1.37), (0.0, s * (y_out + 0.025), 1.36), (-2.3, s * (y_out + 0.02), 1.37)])
        tow_hook(H, (3.3, s * 0.72, 0.84), (0.6, 0, -0.8))
        tow_hook(H, (-3.3, s * 0.72, 0.95), (-1, 0, 0))
        H.box((3.2, min(s * 1.2, s * y_out), 0.72), (3.23, max(s * 1.2, s * y_out), 1.0), 'Rubber')
        tail_light(H, (xr - 0.02, s * 1.45, 1.22))
    if skirt_era:
        for s in SIDES:
            lo, hi = sorted((s * (y_out + 0.05), s * (y_out + 0.14)))
            for i in range(skirt_era):
                x0 = 3.05 - i * 0.62
                H.box((x0 - 0.57, lo, 0.66), (x0 - 0.01, hi, 0.98), 'Paint')
    # exhaust louvres (left side, rear)
    H.box((-2.62, y_out - 0.02, 1.06), (-2.08, y_out + 0.03, 1.32), 'Dark')
    with H.style(bevel=0):
        for i in range(4):
            z = 1.09 + i * 0.06
            H.box((-2.6, y_out + 0.02, z), (-2.1, y_out + 0.05, z + 0.025), 'Metal')
    grille(H, -3.0, -1.6, -1.0, 1.0, 1.4, n=5)
    # rear fuel drums with ribs and straps, unditching log on top
    for s in SIDES:
        a, b = s * 0.1, s * 1.0
        H.cyl((-3.6, a, 1.12), (-3.6, b, 1.12), 0.28, mat='Paint', segs=16, hint=(0, 0, 1))
        with H.style(bevel=0):
            for f in (0.5,):
                y = a + (b - a) * f
                H.cyl((-3.6, y - 0.015, 1.12), (-3.6, y + 0.015, 1.12), 0.29, mat='Paint', segs=16, hint=(0, 0, 1))
            for f in (0.15, 0.85):
                y = a + (b - a) * f
                H.cyl((-3.6, y - 0.02, 1.12), (-3.6, y + 0.02, 1.12), 0.295, mat='Dark', segs=12, hint=(0, 0, 1))
    H.cyl((-3.64, -1.45, 1.51), (-3.64, 1.45, 1.51), 0.11, mat='Wood', segs=10, hint=(0, 0, 1))
    with H.style(bevel=0):
        for y in (-0.9, 0.9):
            H.cyl((-3.64, y - 0.02, 1.51), (-3.64, y + 0.02, 1.51), 0.118, mat='Dark', segs=10, hint=(0, 0, 1))
    # driver's periscope and hatch
    periscope(H, (2.24, 0.0, 1.4), (1, 0, 0.3), w=0.36, h=0.07, d=0.12)
    H.cyl((1.85, 0.0, 1.38), (1.85, 0.0, 1.43), 0.26, mat='Plate', segs=16)
    # glacis armour
    if glacis_style == 'relikt':
        for row in range(2):
            for col in range(4):
                y0 = -1.08 + col * 0.545
                u0 = 0.06 + row * 0.44
                glacis_slab(H, ga, gb, y0, y0 + 0.52, u0, u0 + 0.42, 0.1, 'Paint')
    else:  # Kontakt-5 plate split around the driver's periscope
        for s in SIDES:
            for k in range(2):
                y0, y1 = s * (0.3 + k * 0.42), s * (0.3 + k * 0.42 + 0.4)
                for u0 in (0.06, 0.45):
                    glacis_slab(H, ga, gb, min(y0, y1), max(y0, y1), u0, u0 + 0.36, 0.12, 'Paint')
        glacis_slab(H, ga, gb, -0.27, 0.27, 0.06, 0.55, 0.12, 'Paint')
    return y_out


def soviet_gun(G, clamps=(1.5, 3.7, 4.35)):
    barrel(G, [(0.75, 2.7, 0.1, 0.095), (2.7, 3.2, 0.135, 0.135), (3.2, 4.75, 0.085, 0.08)], mat='Paint')
    barrel(G, [(4.75, 4.83, 0.09, 0.09)], mat='Barrel')
    with G.style(bevel=0):
        for x in clamps:
            r = 0.1 if x < 2.7 else 0.088
            G.cyl((x, 0, 0), (x + 0.035, 0, 0), r, mat='Metal', segs=12, hint=(0, 0, 1))
        G.box((4.5, -0.03, 0.08), (4.62, 0.03, 0.13), 'Metal')         # muzzle reference system


def build_t90m():
    H = Part(bevel_max=0.03)
    soviet_hull(H, half_w=1.82, skirt_era=4, glacis_style='relikt')
    TO = (0.3, 0.0, 1.38)
    T = Part(offset=TO, bevel_max=0.026)
    tr = 0.6                                        # turret roof height above the ring
    T.stack_z([
        (sym_y([(1.0, 0.55), (0.72, 1.08), (-0.95, 1.14), (-1.42, 0.88)]), 0.0),
        (sym_y([(1.08, 0.55), (0.8, 1.15), (-1.0, 1.2), (-1.5, 0.92)]), 0.3),
        (sym_y([(0.85, 0.48), (0.6, 1.0), (-0.95, 1.06), (-1.38, 0.8)]), tr),
    ], 'Paint')
    for s in SIDES:
        # Relikt wedge modules on the turret front (3 per side), top sloping down to the tip
        bot = [(2.0, s * 0.36, 0.1), (1.12, s * 1.24, 0.1), (0.62, s * 1.16, 0.1), (0.75, s * 0.36, 0.1)]
        top = [(1.92, s * 0.36, 0.4), (1.08, s * 1.2, 0.46), (0.62, s * 1.12, tr + 0.02), (0.75, s * 0.36, tr + 0.02)]
        for k in range(3):
            T.loft([split_quad(bot, k, 3), split_quad(top, k, 3)], 'Paint')
        # side ERA bricks
        lo, hi = sorted((s * 1.12, s * 1.28))
        for i in range(4):
            x0 = -0.85 + i * 0.35
            T.box((x0 + 0.01, lo, 0.1), (x0 + 0.34, hi, 0.48), 'Paint')
        # roof ERA bricks
        for i in range(2):
            for j in range(2):
                ya, yb = sorted((s * (0.38 + j * 0.27), s * (0.38 + j * 0.27 + 0.25)))
                T.box((0.15 + i * 0.33, ya, tr - 0.02), (0.46 + i * 0.33, yb, tr + 0.06), 'Paint')
        # smoke grenade launchers
        smoke_bank(T, (0.05, s * 1.32, 0.4), (0.8, s * 0.5, 0), n=4, spacing=0.085)
        # tactical number on the side ERA
        u, v, n = side_decal_frame(s)
        digits(T, '241', (-0.16, s * 1.28, 0.29), u, v, n, h=0.2)
        grab(T, (-1.2, s * 1.19, 0.45), (-0.95, s * 1.17, 0.45), (0, s, 0), h=0.05)
    # bustle (ammunition compartment) with a slat cage around it
    T.box((-2.15, -0.98, 0.08), (-1.38, 0.98, 0.54), 'Paint')
    with T.style(bevel=0):
        for k in range(9):
            y = -1.04 + k * 0.26
            T.box((-2.29, y - 0.012, 0.06), (-2.25, y + 0.012, 0.56), 'Paint')
        for s in SIDES:
            for k in range(5):
                x = -2.2 + k * 0.21
                T.box((x - 0.012, s * 1.07 - 0.02, 0.06), (x + 0.012, s * 1.07 + 0.02, 0.56), 'Paint')
        for z in (0.07, 0.55):
            T.box((-2.3, -1.09, z - 0.02), (-2.24, 1.09, z + 0.02), 'Metal')
            for s in SIDES:
                T.box((-2.3, s * 1.07 - 0.025, z - 0.02), (-1.3, s * 1.07 + 0.025, z + 0.02), 'Metal')
    # commander's cupola (right) with remote 12.7 mm MG
    T.cyl((-0.35, -0.52, tr - 0.02), (-0.35, -0.52, tr + 0.12), 0.36, mat='Paint', segs=20)
    T.cyl((-0.42, -0.52, tr + 0.12), (-0.42, -0.52, tr + 0.16), 0.24, mat='Plate', segs=16)
    T.box((-0.5, -0.76, tr + 0.12), (-0.12, -0.44, tr + 0.24), 'Paint')
    m2hb(T, (-0.18, -0.62, tr + 0.3), L=0.95, can_tag='Paint')
    # commander's panoramic sight (right front)
    T.cyl((0.35, -0.8, tr), (0.35, -0.8, tr + 0.25), 0.08, mat='Paint', segs=10)
    T.box((0.25, -0.9, tr + 0.25), (0.49, -0.68, tr + 0.4), 'Paint')
    with T.style(bevel=0):
        T.box((0.49, -0.86, tr + 0.28), (0.505, -0.72, tr + 0.37), 'Lens')
    # gunner's Sosna-U sight (left front) and hatch
    T.box((0.3, 0.45, tr - 0.02), (0.82, 0.86, tr + 0.24), 'Paint')
    with T.style(bevel=0):
        T.box((0.82, 0.5, tr + 0.03), (0.835, 0.81, tr + 0.2), 'Lens')
    T.box((0.6, 0.42, tr + 0.24), (0.84, 0.89, tr + 0.27), 'Plate')
    T.cyl((-0.45, 0.52, tr - 0.02), (-0.45, 0.52, tr + 0.06), 0.3, mat='Plate', segs=16)
    antenna(T, (-1.1, 0.45, tr), h=0.6)
    # rolled tarpaulin on the turret rear
    roll(T, (-1.5, -0.7, tr - 0.05), (-1.5, 0.7, tr - 0.05), 0.1)

    GO = add(TO, (1.0, 0.0, 0.3))
    G = Part(offset=GO, bevel_max=0.02)
    G.cyl((-0.1, 0, 0), (0.78, 0, 0), 0.2, 0.13, mat='Paint', segs=16, hint=(0, 0, 1))  # mantlet cover
    soviet_gun(G)
    L = 4.83
    return assemble(H, T, TO, G, GO, add(GO, (L, 0, 0)))


def ellipse_ring(cx, rxf, rxb, ry, n, k=1.0):
    pts = []
    for i in range(n):
        a = 2 * math.pi * i / n
        c, s = math.cos(a), math.sin(a)
        pts.append((cx + (rxf if c > 0 else rxb) * c * k, ry * s * k))
    return pts


def build_t72b3():
    H = Part(bevel_max=0.03)
    soviet_hull(H, half_w=1.79, skirt_era=3, glacis_style='k5')
    TO = (0.3, 0.0, 1.38)
    T = Part(offset=TO, bevel_max=0.026)
    n = 20
    T.stack_z([
        (ellipse_ring(-0.1, 1.2, 1.3, 1.1, n, 0.97), 0.0),
        (ellipse_ring(-0.1, 1.2, 1.3, 1.1, n, 1.0), 0.28),
        (ellipse_ring(-0.12, 1.2, 1.3, 1.1, n, 0.83), 0.55),
        (ellipse_ring(-0.15, 1.2, 1.3, 1.1, n, 0.5), 0.7),
    ], 'Paint')
    for s in SIDES:
        # Kontakt-5 wedge boxes on the turret front ("horseshoe"), 3 bricks per side
        bot = [(1.62, s * 0.34, 0.08), (1.28, s * 1.1, 0.08), (0.7, s * 1.05, 0.08), (0.95, s * 0.34, 0.08)]
        top = [(1.5, s * 0.34, 0.58), (1.18, s * 1.02, 0.58), (0.72, s * 0.97, 0.58), (0.9, s * 0.34, 0.58)]
        for k in range(3):
            T.loft([split_quad(bot, k, 3), split_quad(top, k, 3)], 'Paint')
        # K-5 roof plates
        T.stack_z([
            ([(1.12, s * 0.34), (0.95, s * 0.95), (0.25, s * 0.85), (0.3, s * 0.34)][::s], 0.5),
            ([(1.05, s * 0.34), (0.9, s * 0.9), (0.28, s * 0.8), (0.32, s * 0.34)][::s], 0.68),
        ], 'Paint')
        # smoke grenade launchers
        smoke_bank(T, (0.02, s * 1.0, 0.5), (0.85, s * 0.45, 0), n=4, spacing=0.085)
        grab(T, (-0.6, s * 1.08, 0.4), (-0.95, s * 1.06, 0.4), (0, s, 0), h=0.05)
        spare_links(T, (-0.55, s * 1.05, 0.25), (1, 0, 0), (0, 0, 1), (0, s, 0.1), count=4, pitch=0.17, w=0.26,
                    t=0.04)
    # rear turret stowage box with the tactical number, snorkel tube above it
    crate(T, (-1.75, -0.8, 0.12), (-1.2, 0.8, 0.5), 'Paint', latch=False)
    for s in SIDES:
        u, v, n2 = side_decal_frame(s)
        digits(T, '117', (-1.47, s * 0.8, 0.3), u, v, n2, h=0.19)
    T.cyl((-1.55, -0.95, 0.62), (-1.55, 0.7, 0.62), 0.09, mat='Paint', segs=12, hint=(0, 0, 1))
    with T.style(bevel=0):
        for y in (-0.6, 0.4):
            T.cyl((-1.55, y - 0.02, 0.62), (-1.55, y + 0.02, 0.62), 0.1, mat='Metal', segs=12, hint=(0, 0, 1))
    # commander's cupola (right) with 12.7 mm MG
    T.cyl((-0.3, -0.5, 0.6), (-0.3, -0.5, 0.78), 0.38, mat='Paint', segs=20)
    T.cyl((-0.38, -0.5, 0.78), (-0.38, -0.5, 0.82), 0.26, mat='Plate', segs=16)
    for k in range(4):
        a = math.radians(-50 + k * 33)
        periscope(T, (-0.3 + math.cos(a) * 0.34, -0.5 + math.sin(a) * 0.34, 0.8), (math.cos(a), math.sin(a), 0),
                  w=0.09, h=0.05, d=0.06)
    T.box((-0.5, -0.62, 0.82), (-0.1, -0.4, 0.92), 'Metal')
    m2hb(T, (-0.1, -0.5, 0.98), L=1.0, can_tag='Paint')
    # Sosna-U gunner's sight box (left front) and hatch
    T.box((0.25, 0.45, 0.6), (0.8, 0.85, 0.9), 'Paint')
    with T.style(bevel=0):
        T.box((0.8, 0.5, 0.66), (0.815, 0.8, 0.86), 'Lens')
    T.cyl((-0.4, 0.5, 0.62), (-0.4, 0.5, 0.72), 0.3, mat='Plate', segs=16)
    antenna(T, (-1.0, 0.5, 0.64), h=0.6)

    GO = add(TO, (0.95, 0.0, 0.36))
    G = Part(offset=GO, bevel_max=0.02)
    G.cyl((-0.1, 0, 0), (0.8, 0, 0), 0.22, 0.14, mat='Paint', segs=16, hint=(0, 0, 1))
    soviet_gun(G, clamps=(1.6, 2.4, 3.9))
    L = 4.83
    return assemble(H, T, TO, G, GO, add(GO, (L, 0, 0)))


# --------------------------------------------------------------------------------------
# M2A4 Bradley
# --------------------------------------------------------------------------------------
def build_m2a4():
    H = Part(bevel_max=0.03)
    running_gear(H, y_out=1.52, tw=0.53, wheels_x=[2.05 - i * 0.84 for i in range(6)], wr=0.31,
                 sprocket=(2.78, 0.62, 0.3), idler=(-2.88, 0.52, 0.29), rollers=(1.6, 0.3, -1.0),
                 roller_z=0.93, t=0.07)
    ga, gb = (3.28, 1.02), (1.72, 2.0)
    H.prism_xz([(-3.05, 0.45), (2.55, 0.45), ga, (-3.28, 1.02), (-3.28, 0.72)], -0.99, 0.99, 'Paint')
    H.prism_xz([(-3.28, 1.0), (3.25, 1.0), gb, (-3.22, 2.0), (-3.28, 1.94)], -1.52, 1.52, 'Paint')
    for s in SIDES:
        lo, hi = sorted((s * 1.52, s * 1.6))
        # armoured skirt panels
        for x0, x1 in ((2.95, 1.95), (1.93, 0.9), (0.88, -0.15), (-0.17, -1.2), (-1.22, -2.15), (-2.17, -3.1)):
            H.box((x1, lo, 0.6), (x0, hi, 1.1), 'Paint')
        # BUSK / BRAT reactive tiles on the hull sides (2 rows)
        lo2, hi2 = sorted((s * 1.52, s * 1.64))
        for i in range(5):
            x0 = 2.3 - i * 0.66
            H.box((x0 - 0.62, lo2, 1.12), (x0 - 0.02, hi2, 1.47), 'Paint')
            if x0 <= 1.75:
                H.box((x0 - 0.62, lo2, 1.52), (x0 - 0.02, hi2, 1.86), 'Paint')
        # rear stowage boxes, headlights, tail lights, tow hooks
        crate(H, (-3.25, min(s * 1.1, s * 1.5), 2.0), (-2.4, max(s * 1.1, s * 1.5), 2.2), 'Paint')
        H.box((3.05, min(s * 1.18, s * 1.44), 1.06), (3.2, max(s * 1.18, s * 1.44), 1.12), 'Metal')
        lamp(H, (3.2, s * 1.25, 1.18), r=0.045, guard=True)
        lamp(H, (3.2, s * 1.38, 1.18), r=0.04, tag='Lens')
        tail_light(H, (-3.3, s * 1.3, 1.85))
        tow_hook(H, (3.1, s * 0.7, 0.85), (0.6, 0, -0.8))
        tow_hook(H, (-3.28, s * 0.85, 0.85), (-1, 0, 0))
        # vision blocks along the troop compartment roof edge
        for x in (-0.6, -1.4, -2.2):
            periscope(H, (x, s * 1.45, 2.03), (0, s, 0.25), w=0.16, h=0.06, d=0.1)
        antenna(H, (-2.95, s * 1.3, 2.2), h=0.55)
    # trim vane folded on the glacis (with ribs), engine exhaust grille (right front)
    glacis_slab(H, ga, gb, -1.3, 1.3, 0.12, 0.45, 0.05, 'Paint')
    p, d, yv, nrm = glacis_frame(ga, gb, 0.285, 0.0)
    with H.style(bevel=0):
        for y in (-0.9, -0.3, 0.3, 0.9):
            H.obox(p + nrm * 0.07 + V((0, y, 0)), d, yv, nrm, (0.26, 0.02, 0.02), 'Paint')
    glacis_slab(H, ga, gb, -1.3, -0.75, 0.55, 0.85, 0.04, 'Dark')
    with H.style(bevel=0):
        for k in range(4):
            u0 = 0.57 + k * 0.07
            glacis_slab(H, ga, gb, -1.28, -0.77, u0, u0 + 0.03, 0.055, 'Metal')
    # driver's hatch + periscopes (left front)
    H.cyl((1.35, 0.75, 1.98), (1.35, 0.75, 2.06), 0.28, mat='Plate', segs=16)
    for y in (0.55, 0.75, 0.95):
        periscope(H, (1.68, y, 2.02), (1, 0, 0.4), w=0.15, h=0.06, d=0.09)
    # rear ramp with door, handles and lights; roof cargo hatch; stowage
    H.box((-3.31, -0.8, 0.55), (-3.27, 0.8, 1.85), 'Plate')
    H.box((-3.34, 0.1, 0.9), (-3.3, 0.6, 1.7), 'Plate')
    grab(H, (-3.33, -0.5, 1.3), (-3.33, -0.2, 1.3), (-1, 0, 0), h=0.05)
    H.box((-3.0, -0.75, 2.0), (-1.8, 0.75, 2.05), 'Plate')
    grab(H, (-2.0, -0.3, 2.05), (-2.0, 0.3, 2.05), (0, 0, 1), h=0.04)
    bag(H, (-2.6, 0.95, 2.13), (0.5, 0.35, 0.26), yaw=0.05)
    bag(H, (-2.1, -1.05, 2.12), (0.45, 0.32, 0.24), yaw=-0.1)
    jerrycan(H, (-3.36, -1.2, 1.35), yaw=0.0, lying=False)
    jerrycan(H, (-3.36, 1.2, 1.35), yaw=0.0, lying=False)
    roll(H, (-3.12, -0.7, 2.12), (-3.12, 0.7, 2.12), 0.11)
    crate(H, (-1.6, 0.55, 2.0), (-1.1, 1.3, 2.2), 'Canvas')
    for s in SIDES:
        grab(H, (-3.2, s * 1.45, 2.0), (-2.7, s * 1.45, 2.0), (0, 0, 1), h=0.05)
        grab(H, (0.8, s * 1.5, 1.95), (0.3, s * 1.5, 1.95), (0, s, 0.4), h=0.05)

    TO = (0.3, 0.0, 2.0)
    T = Part(offset=TO, bevel_max=0.026)
    T.stack_z([
        (sym_y([(1.0, 0.42), (0.62, 0.95), (-1.05, 0.98), (-1.3, 0.72)]), 0.0),
        (sym_y([(1.05, 0.45), (0.68, 1.0), (-1.1, 1.02), (-1.35, 0.75)]), 0.3),
        (sym_y([(0.75, 0.4), (0.5, 0.85), (-1.0, 0.9), (-1.25, 0.65)]), 0.65),
    ], 'Paint')
    # TOW launcher on the left side: arm, box, twin tube openings, chevron + number on its side
    T.box((-0.3, 0.98, 0.22), (0.1, 1.12, 0.5), 'Paint')
    T.box((-0.6, 1.08, 0.22), (0.85, 1.56, 0.74), 'Paint')
    T.box((0.83, 1.1, 0.26), (0.88, 1.54, 0.7), 'Plate')
    with T.style(bevel=0):
        for y in (1.2, 1.44):
            T.cyl((0.87, y, 0.48), (0.9, y, 0.48), 0.1, mat='Dark', segs=14)
    u, v, n = side_decal_frame(1)
    chevron(T, (0.35, 1.56, 0.5), u, v, n, size=0.22, bar=0.045)
    digits(T, '31', (-0.1, 1.56, 0.48), u, v, n, h=0.17)
    # BUSK tiles on the right turret side
    for i in range(3):
        x0 = 0.55 - i * 0.5
        T.box((x0 - 0.46, -1.1, 0.06), (x0, -0.98, 0.3), 'Paint')
    u, v, n = side_decal_frame(-1)
    digits(T, '31', (-0.5, -1.02, 0.46), u, v, n, h=0.15)
    # commander's independent viewer (right rear) and gunner's sight (left front)
    T.cyl((-0.55, -0.55, 0.6), (-0.55, -0.55, 0.84), 0.09, mat='Paint', segs=10)
    T.box((-0.75, -0.76, 0.84), (-0.32, -0.34, 1.02), 'Paint')
    with T.style(bevel=0):
        T.box((-0.32, -0.7, 0.87), (-0.305, -0.4, 0.98), 'Lens')
    T.box((0.22, 0.18, 0.62), (0.68, 0.5, 0.82), 'Paint')
    with T.style(bevel=0):
        T.box((0.68, 0.22, 0.66), (0.695, 0.46, 0.78), 'Lens')
    T.cyl((-0.35, 0.4, 0.62), (-0.35, 0.4, 0.68), 0.28, mat='Plate', segs=16)
    for s in SIDES:
        smoke_bank(T, (0.58, s * 0.86, 0.5), (0.8, s * 0.55, 0), n=4, spacing=0.07, r=0.03, L=0.16)
    antenna(T, (-1.05, -0.25, 0.65), h=0.55)
    # bustle rack with bags
    T.box((-1.75, -0.8, 0.08), (-1.28, 0.8, 0.12), 'Metal')
    with T.style(bevel=0):
        T.tube([(-1.3, 0.82, 0.45), (-1.77, 0.82, 0.45), (-1.77, -0.82, 0.45), (-1.3, -0.82, 0.45)], [0.015] * 4,
               mat='Metal', segs=5)
    bag(T, (-1.52, 0.4, 0.3), (0.42, 0.7, 0.34))
    bag(T, (-1.5, -0.4, 0.28), (0.4, 0.66, 0.3), yaw=0.08)

    GO = add(TO, (0.95, 0.0, 0.32))
    G = Part(offset=GO, bevel_max=0.02)
    G.box((-0.15, -0.3, -0.2), (0.32, 0.3, 0.18), 'Paint')
    barrel(G, [(0.3, 0.85, 0.075, 0.07), (0.85, 2.2, 0.042, 0.042), (2.2, 2.34, 0.056, 0.056)], segs=12)
    with G.style(bevel=0):
        G.cyl((2.24, 0, 0), (2.27, 0, 0), 0.065, mat='Barrel', segs=12, hint=(0, 0, 1))
    G.cyl((0.3, -0.2, 0.02), (0.7, -0.2, 0.02), 0.02, mat='Barrel', segs=8)
    L = 2.34
    return assemble(H, T, TO, G, GO, add(GO, (L, 0, 0)))


# --------------------------------------------------------------------------------------
# M1126 Stryker ICV
# --------------------------------------------------------------------------------------
def build_stryker():
    H = Part(bevel_max=0.03)
    road_wheels(H, [2.3, 1.0, -0.95, -2.25], wr=0.55, width=0.4, y_out=1.32, segs=20)
    sec = sym_yz([(0.72, 0.62), (1.22, 1.05), (1.2, 1.32), (1.06, 2.02)])
    H.loft_x([
        (-3.48, sym_yz([(0.68, 0.68), (1.16, 1.05), (1.14, 1.32), (1.0, 1.96)])),
        (-3.36, sec),
        (1.5, sec),
        (3.3, sym_yz([(0.64, 0.8), (1.08, 1.02), (1.06, 1.14), (0.98, 1.36)])),
        (3.48, sym_yz([(0.6, 0.84), (1.02, 1.03), (1.0, 1.13), (0.92, 1.32)])),
    ], 'Paint')
    # slat armour cage: vertical slats on stand-off frames, both sides and rear
    with H.style(bevel=0):
        for s in SIDES:
            x = -3.2
            while x <= 1.96:
                H.box((x - 0.008, min(s * 1.31, s * 1.37), 1.14), (x + 0.008, max(s * 1.31, s * 1.37), 1.96), 'Paint')
                x += 0.15
            for z in (1.12, 1.53, 1.94):
                H.box((-3.26, min(s * 1.3, s * 1.38), z), (2.0, max(s * 1.3, s * 1.38), z + 0.045), 'Paint')
            for x in (-3.25, -1.9, -0.55, 0.8, 1.97):
                H.box((x - 0.03, min(s * 1.08, s * 1.31), 1.88), (x + 0.03, max(s * 1.08, s * 1.31), 1.94), 'Metal')
                H.box((x - 0.03, min(s * 1.18, s * 1.31), 1.14), (x + 0.03, max(s * 1.18, s * 1.31), 1.19), 'Metal')
        y = -1.2
        while y <= 1.21:
            H.box((-3.64, y - 0.008, 1.1), (-3.58, y + 0.008, 1.95), 'Paint')
            y += 0.15
        for z in (1.1, 1.52, 1.9):
            H.box((-3.66, -1.3, z), (-3.57, 1.3, z + 0.045), 'Paint')
    for s in SIDES:
        H.box((3.2, min(s * 0.62, s * 0.95), 1.14), (3.42, max(s * 0.62, s * 0.95), 1.2), 'Metal')
        lamp(H, (3.44, s * 0.72, 1.24), r=0.045, guard=True)
        lamp(H, (3.44, s * 0.86, 1.24), r=0.04, tag='Lens')
        tow_hook(H, (3.46, s * 0.45, 0.92), (1, 0, -0.2))
        tail_light(H, (-3.49, s * 0.95, 1.3))
        antenna(H, (-3.0, s * 0.95, 1.97), h=0.6)
        H.box((-2.3, min(s * 0.62, s * 1.02), 0.72), (-2.26, max(s * 0.62, s * 1.02), 1.02), 'Rubber')  # mud flaps
        bag(H, (-2.2, s * 0.72, 2.1), (0.6, 0.32, 0.24), yaw=0.03 * s)
    # rear ramp with door, roof hatches with vision blocks, driver periscopes, exhaust
    H.box((-3.5, -0.75, 0.75), (-3.46, 0.75, 1.85), 'Plate')
    H.box((-3.53, 0.12, 0.95), (-3.49, 0.62, 1.7), 'Plate')
    grab(H, (-3.52, -0.5, 1.35), (-3.52, -0.2, 1.35), (-1, 0, 0), h=0.05)
    u, v, n = side_decal_frame(1, (-1, 0, 0))
    chevron(H, (-3.515, -0.4, 1.6), u, v, n, size=0.22, bar=0.045)
    H.box((-2.9, -0.8, 2.02), (-1.2, 0.8, 2.08), 'Plate')
    H.box((-2.85, -0.1, 2.08), (-1.25, 0.1, 2.1), 'Metal')
    H.cyl((1.25, 0.55, 2.0), (1.25, 0.55, 2.1), 0.3, mat='Plate', segs=16)
    H.cyl((0.1, -0.55, 2.0), (0.1, -0.55, 2.09), 0.32, mat='Plate', segs=16)
    for k in range(5):
        a = math.radians(-60 + k * 30)
        periscope(H, (0.1 + math.cos(a) * 0.34, -0.55 + math.sin(a) * 0.34, 2.06), (math.cos(a), math.sin(a), 0.2),
                  w=0.1, h=0.05, d=0.07)
    for y in (0.4, 0.55, 0.7):
        periscope(H, (1.58, y, 2.03), (1, 0, 0.3), w=0.13, h=0.06, d=0.09)
    H.box((-0.4, -1.08, 1.7), (0.3, -0.98, 1.95), 'Dark')
    with H.style(bevel=0):
        for i in range(4):
            z = 1.73 + i * 0.055
            H.box((-0.38, -1.1, z), (0.28, -1.07, z + 0.025), 'Metal')
    # bumper number on the nose
    for s in SIDES:
        for i, x in enumerate((-0.9, -1.55, -2.55)):
            bag(H, (x, s * 0.85, 2.14), (0.5, 0.36, 0.26), yaw=0.05 * (i - 1) * s,
                tag='Canvas')
        jerrycan(H, (-3.42, s * 1.12, 1.35), yaw=0.0)
        crate(H, (0.5, min(s * 0.62, s * 1.0), 2.02), (0.95, max(s * 0.62, s * 1.0), 2.22), 'Paint')
        grab(H, (2.4, s * 0.92, 1.4), (2.9, s * 0.9, 1.33), (0, s * 0.3, 1), h=0.05)
    roll(H, (-3.2, -0.75, 2.13), (-3.2, 0.75, 2.13), 0.11)
    with H.style(bevel=0):
        H.tube([(3.2, -0.55, 1.18), (2.55, -0.55, 1.3)], [0.03, 0.03], mat='Metal', segs=6)   # stowed tow bar
        H.tube([(3.2, 0.55, 1.18), (2.55, 0.55, 1.3)], [0.03, 0.03], mat='Metal', segs=6)
        H.box((2.53, -0.6, 1.27), (2.58, 0.6, 1.33), 'Metal')
    antenna(H, (-1.1, -0.95, 2.02), h=0.55)

    u, v, n = side_decal_frame(1, (1, 0, 0.25))
    digits(H, '12', (3.4, 0.0, 1.21), u, v, n, h=0.11)

    TO = (0.3, 0.0, 2.02)
    T = Part(offset=TO, bevel_max=0.015)
    T.cyl((0, 0, 0), (0, 0, 0.1), 0.32, mat='Paint', segs=20)
    T.box((-0.28, -0.2, 0.1), (0.2, 0.18, 0.28), 'Paint')
    for yy in (-0.16, 0.1):
        T.box((-0.18, yy, 0.28), (0.12, yy + 0.05, 0.46), 'Paint')
    T.box((-0.15, 0.18, 0.1), (0.25, 0.42, 0.48), 'Paint')          # sight head (left)
    with T.style(bevel=0):
        T.box((0.25, 0.22, 0.26), (0.265, 0.38, 0.42), 'Lens')
        T.cyl((0.25, 0.3, 0.2), (0.27, 0.3, 0.2), 0.035, mat='Lens', segs=10)
    antenna(T, (-0.25, 0.3, 0.48), h=0.3)
    GO = add(TO, (0.0, -0.03, 0.38))
    G = Part(offset=GO, bevel_max=0.012)
    G.box((-0.45, -0.07, -0.07), (0.2, 0.07, 0.08), 'Metal')
    G.box((-0.28, -0.26, -0.12), (-0.02, -0.08, 0.06), 'Paint')      # ammo can
    G.box((-0.52, -0.05, -0.05), (-0.45, 0.05, 0.05), 'Dark')
    barrel(G, [(0.2, 0.45, 0.045, 0.045), (0.45, 1.25, 0.026, 0.026), (1.25, 1.35, 0.034, 0.034)], mat='Barrel',
           segs=10)
    L = 1.35
    return assemble(H, T, TO, G, GO, add(GO, (L, 0, 0)))


# --------------------------------------------------------------------------------------
# JLTV
# --------------------------------------------------------------------------------------
def side_window(P, s, x0, x1, z0, z1, y_at, mat='Glass'):
    pts = [(x0, s * y_at(z0), z0), (x1, s * y_at(z0), z0), (x1, s * y_at(z1), z1), (x0, s * y_at(z1), z1)]
    P.slab(pts, 0.02, mat, out=(0, s, 0))


def mirror(P, base, s, reach=0.16):
    b = V(base)
    tip = b + V((0.05, s * reach, 0.05))
    with P.style(bevel=0):
        P.tube([b, b + V((0.02, s * reach * 0.6, 0.0)), tip], [0.012] * 3, mat='Metal', segs=5)
    P.box((tip.x - 0.03, min(tip.y, tip.y + s * 0.02) - 0.05, tip.z - 0.05),
          (tip.x + 0.03, max(tip.y, tip.y + s * 0.02) + 0.05, tip.z + 0.15), 'Dark')


def build_jltv():
    H = Part(bevel_max=0.025)
    road_wheels(H, [1.85, -1.6], wr=0.47, width=0.34, y_out=1.2, segs=24, nuts=8)
    H.box((-2.6, -0.7, 0.42), (2.75, 0.7, 0.82), 'Dark')                    # chassis
    H.prism_xz([(1.4, 0.8), (3.05, 0.8), (3.1, 1.38), (2.9, 1.46), (1.4, 1.62)], -0.95, 0.95, 'Paint')  # hood
    for s in SIDES:
        H.prism_xz([(1.15, 0.97), (2.8, 0.97), (3.0, 1.15), (2.92, 1.36), (1.2, 1.45)], s * 0.9, s * 1.25, 'Paint')
        H.box((-2.35, min(s * 0.92, s * 1.25), 0.97), (-0.9, max(s * 0.92, s * 1.25), 1.14), 'Paint')  # rear fender
        H.box((-3.1, min(s * 1.06, s * 1.16), 1.0), (-1.0, max(s * 1.06, s * 1.16), 1.42), 'Paint')    # bed wall
        lamp(H, (3.09, s * 0.8, 1.25), r=0.055, guard=True)
        tail_light(H, (-3.16, s * 0.95, 1.2))
        tow_hook(H, (3.22, s * 0.6, 0.72), (1, 0, 0), size=0.9)
        mirror(H, (1.42, s * 1.2, 1.62), s)
        # armoured door panels with handles and hinges
        for x0, x1 in ((0.25, 1.4), (-0.95, 0.2)):
            H.box((x0 + 0.02, min(s * 1.2, s * 1.23), 0.86), (x1 - 0.02, max(s * 1.2, s * 1.23), 1.48), 'Plate')
            with H.style(bevel=0):
                H.box((x1 - 0.22, min(s * 1.23, s * 1.255), 1.3), (x1 - 0.1, max(s * 1.23, s * 1.255), 1.34), 'Metal')
                for z in (1.0, 1.35):
                    H.box((x0 + 0.03, min(s * 1.23, s * 1.25), z), (x0 + 0.1, max(s * 1.23, s * 1.25), z + 0.06), 'Metal')
        H.box((-0.95, min(s * 1.2, s * 1.28), 0.72), (1.35, max(s * 1.2, s * 1.28), 0.76), 'Metal')       # step
    # crew cab
    H.stack_z([
        ([(1.45, -1.2), (1.45, 1.2), (-1.0, 1.2), (-1.0, -1.2)], 0.8),
        ([(1.45, -1.2), (1.45, 1.2), (-1.0, 1.2), (-1.0, -1.2)], 1.5),
        ([(1.05, -1.05), (1.05, 1.05), (-0.95, 1.05), (-0.95, -1.05)], 1.95),
    ], 'Paint')
    # windscreen (two panes on the sloped front)
    for s in SIDES:
        a, b = (1.45 - 0.4 * (0.1 / 0.45), 1.6), (1.45 - 0.4 * (0.39 / 0.45), 1.89)
        lo, hi = sorted((s * 0.08, s * 0.85))
        H.slab(plane_pts(a, b, lo, hi, 0.0, 1.0), 0.02, 'Glass', out=(1, 0, 1))

        def y_at(z):
            return 1.2 - 0.15 * (z - 1.5) / 0.45
        side_window(H, s, 0.35, 0.95, 1.62, 1.86, y_at)
        side_window(H, s, -0.75, 0.15, 1.62, 1.86, y_at)
    # hood grille, bumper with winch, rear bed with stowage
    with H.style(bevel=0):
        for k in range(6):
            y = -0.5 + k * 0.2
            H.box((3.08, y - 0.03, 0.95), (3.12, y + 0.03, 1.3), 'Dark')
    H.box((3.05, -1.0, 0.58), (3.22, 1.0, 0.8), 'Dark')
    H.cyl((3.2, -0.25, 0.69), (3.2, 0.25, 0.69), 0.08, mat='Metal', segs=12, hint=(0, 0, 1))
    H.box((-3.1, -1.16, 0.8), (-1.0, 1.16, 1.0), 'Paint')
    H.box((-3.14, -1.16, 1.0), (-3.04, 1.16, 1.36), 'Paint')
    crate(H, (-2.75, -0.95, 1.0), (-1.95, -0.1, 1.32), 'Paint')
    bag(H, (-1.5, 0.3, 1.14), (0.65, 0.95, 0.28), yaw=0.05)
    crate(H, (-2.8, 0.2, 1.0), (-2.1, 0.9, 1.2), 'Canvas')
    for k in range(3):
        jerrycan(H, (-1.2 - 0.0 * k, -0.9 + k * 0.19, 1.235), yaw=math.pi / 2)
    u, v, n = side_decal_frame(1, (1, 0, 0))
    digits(H, '07', (3.225, 0.55, 0.69), u, v, n, h=0.1)
    for s in SIDES:
        antenna(H, (-0.85, s * 0.95, 1.95), h=0.6)
    with H.style(bevel=0):
        H.tube([(3.2, -0.9, 0.8), (3.26, -0.85, 1.3), (3.26, 0.85, 1.3), (3.2, 0.9, 0.8)], [0.025] * 4,
               mat='Dark', segs=6)
        for y in (-0.45, 0.45):
            H.tube([(3.22, y, 0.8), (3.26, y, 1.3)], [0.02, 0.02], mat='Dark', segs=6)
    for s in SIDES:
        H.box((-2.4, min(s * 0.95, s * 1.2), 0.5), (-2.37, max(s * 0.95, s * 1.2), 0.9), 'Rubber')
        H.box((1.12, min(s * 0.95, s * 1.2), 0.55), (1.15, max(s * 0.95, s * 1.2), 0.9), 'Rubber')
    bag(H, (-2.35, 0.55, 1.34), (0.55, 0.4, 0.3), yaw=0.1)
    bag(H, (-1.55, -0.65, 1.3), (0.5, 0.38, 0.26), yaw=-0.08)
    roll(H, (-2.95, -0.95, 1.46), (-2.95, 0.95, 1.46), 0.1)

    TO = (0.05, 0.0, 1.95)
    T = Part(offset=TO, bevel_max=0.015)
    T.cyl((0, 0, 0), (0, 0, 0.1), 0.5, mat='Paint', segs=24)
    T.box((0.44, -0.52, 0.1), (0.52, 0.52, 0.68), 'Paint')                  # gunner shield front
    with T.style(bevel=0):
        T.box((0.52, -0.2, 0.4), (0.535, 0.2, 0.58), 'Glass')
    for s in SIDES:
        c = V((0.24, s * 0.62, 0.38))
        ax = V((-0.44, s * 0.2, 0)).normalized()
        ay = V((-ax.y, ax.x, 0))
        T.obox(c, ax, ay, (0, 0, 1), (0.25, 0.03, 0.28), 'Paint')
    T.cyl((0.22, 0, 0.1), (0.22, 0, 0.42), 0.035, mat='Metal', segs=8)       # pintle
    GO = add(TO, (0.22, 0.0, 0.46))
    G = Part(offset=GO, bevel_max=0.012)
    G.box((-0.5, -0.08, -0.07), (0.15, 0.08, 0.09), 'Metal')
    G.box((-0.3, -0.26, -0.12), (-0.05, -0.08, 0.05), 'Paint')
    G.box((-0.58, -0.05, -0.05), (-0.5, 0.05, 0.05), 'Dark')
    barrel(G, [(0.15, 0.38, 0.05, 0.05), (0.38, 1.2, 0.03, 0.03), (1.2, 1.3, 0.038, 0.038)], segs=10)
    L = 1.3
    return assemble(H, T, TO, G, GO, add(GO, (L, 0, 0)))


# --------------------------------------------------------------------------------------
# GAZ Tigr-M
# --------------------------------------------------------------------------------------
def build_tigr():
    H = Part(bevel_max=0.025)
    road_wheels(H, [1.65, -1.6], wr=0.49, width=0.32, y_out=1.18, segs=24, nuts=8)
    H.box((-2.5, -0.7, 0.42), (2.55, 0.7, 0.82), 'Dark')
    H.prism_xz([(1.3, 0.8), (2.72, 0.8), (2.78, 1.2), (2.64, 1.36), (1.3, 1.48)], -1.0, 1.0, 'Paint')  # hood
    for s in SIDES:
        H.prism_xz([(1.02, 0.99), (2.52, 0.99), (2.72, 1.12), (2.62, 1.3), (1.08, 1.4)], s * 0.95, s * 1.2, 'Paint')
        lamp(H, (2.77, s * 0.81, 1.18), r=0.05, guard=True)
        tail_light(H, (-2.74, s * 0.95, 1.1))
        mirror(H, (1.3, s * 1.2, 1.55), s)
        tow_hook(H, (2.9, s * 0.62, 0.7), (1, 0, 0), size=0.9)
        # rear wheel arch and side steps
        H.box((-2.2, min(s * 1.12, s * 1.24), 0.98), (-1.0, max(s * 1.12, s * 1.24), 1.08), 'Paint')
        H.box((-0.9, min(s * 1.2, s * 1.3), 0.66), (0.95, max(s * 1.2, s * 1.3), 0.7), 'Metal')
    H.stack_z([
        ([(1.35, -1.2), (1.35, 1.2), (-2.72, 1.2), (-2.72, -1.2)], 0.8),
        ([(1.35, -1.2), (1.35, 1.2), (-2.72, 1.2), (-2.72, -1.2)], 1.45),
        ([(0.92, -1.07), (0.92, 1.07), (-2.66, 1.07), (-2.66, -1.07)], 1.95),
    ], 'Paint')
    for s in SIDES:
        a, b = (1.35 - 0.43 * (0.07 / 0.5), 1.52), (1.35 - 0.43 * (0.42 / 0.5), 1.87)
        lo, hi = sorted((s * 0.06, s * 0.92))
        H.slab(plane_pts(a, b, lo, hi, 0.0, 1.0), 0.02, 'Glass', out=(1, 0, 1))

        def y_at(z):
            return 1.2 - 0.13 * (z - 1.45) / 0.5
        for x0, x1 in ((0.35, 0.9), (-0.55, 0.15), (-1.55, -0.8)):
            side_window(H, s, x0, x1, 1.55, 1.83, y_at)
        # door seams + handles, tactical number on the rear door
        for x0, x1 in ((0.25, 1.3), (-0.75, 0.2)):
            with H.style(bevel=0):
                H.box((x1 - 0.2, min(s * 1.2, s * 1.225), 1.3), (x1 - 0.08, max(s * 1.2, s * 1.225), 1.34), 'Metal')
                H.box((x0, min(s * 1.2, s * 1.215), 0.86), (x0 + 0.02, max(s * 1.2, s * 1.215), 1.44), 'Dark')
        u, v, n = side_decal_frame(s)
        digits(H, '305', (-1.35, s * 1.2, 1.18), u, v, n, h=0.2)
    # grille, spare wheel on the rear door, bull bar with winch
    with H.style(bevel=0):
        for k in range(7):
            y = -0.54 + k * 0.18
            H.box((2.74, y - 0.03, 0.9), (2.78, y + 0.03, 1.15), 'Dark')
    H.cyl((-2.72, 0.35, 1.3), (-2.93, 0.35, 1.3), 0.4, mat='Rubber', segs=20)
    H.cyl((-2.9, 0.35, 1.3), (-2.95, 0.35, 1.3), 0.24, mat='Paint', segs=16)
    H.box((2.7, -1.0, 0.55), (2.9, 1.0, 0.78), 'Dark')
    with H.style(bevel=0):
        H.tube([(2.9, -0.95, 0.75), (2.95, -0.8, 1.02), (2.95, 0.8, 1.02), (2.9, 0.95, 0.75)], [0.03] * 4, mat='Dark',
               segs=6)
    H.cyl((2.9, -0.2, 0.66), (2.9, 0.2, 0.66), 0.07, mat='Metal', segs=12, hint=(0, 0, 1))
    H.box((-2.85, -0.9, 0.62), (-2.72, 0.9, 0.78), 'Dark')
    # roof: hatch ring, antennas, stowage rack with a box
    for s in SIDES:
        antenna(H, (-2.4, s * 0.9, 1.95), h=0.6)
    with H.style(bevel=0):
        for y in (-0.9, 0.9):
            H.box((-2.42, y - 0.015, 2.02), (-1.08, y + 0.015, 2.05), 'Metal')
            for x in (-2.4, -1.75, -1.1):
                H.box((x - 0.015, y - 0.015, 1.94), (x + 0.015, y + 0.015, 2.03), 'Metal')
    crate(H, (-2.2, -0.6, 1.95), (-1.4, 0.1, 2.15), 'Paint')
    jerrycan(H, (-1.3, 0.55, 2.03), yaw=0.0, lying=True)
    jerrycan(H, (-1.3, 0.2, 2.03), yaw=0.0, lying=True)
    bag(H, (-2.05, 0.55, 2.08), (0.5, 0.36, 0.26), yaw=0.1)
    for s in SIDES:
        grab(H, (-2.73, s * 0.62, 1.2), (-2.73, s * 0.62, 1.6), (-1, 0, 0), h=0.05)
        H.box((-2.2, min(s * 0.92, s * 1.18), 0.48), (-2.17, max(s * 0.92, s * 1.18), 0.9), 'Rubber')
        lamp(H, (1.2, s * 1.07, 1.97), (1, 0, 0), r=0.05, tag='Light')
    roll(H, (-2.3, 0.3, 2.04), (-2.3, 0.85, 2.04), 0.09)

    TO = (-0.35, 0.0, 1.95)
    T = Part(offset=TO, bevel_max=0.015)
    T.cyl((0, 0, 0), (0, 0, 0.1), 0.45, mat='Paint', segs=24)
    T.box((0.3, -0.4, 0.1), (0.37, 0.4, 0.5), 'Paint')                       # gun shield
    with T.style(bevel=0):
        T.box((0.37, -0.12, 0.3), (0.385, 0.12, 0.42), 'Glass')
    for s in SIDES:
        T.obox(V((0.22, s * 0.46, 0.3)), V((-0.5, s * 0.8, 0)), V((-s * 0.8, -0.5, 0)), (0, 0, 1), (0.12, 0.025, 0.2),
               'Paint')
    T.cyl((0.12, 0, 0.1), (0.12, 0, 0.32), 0.035, mat='Metal', segs=8)       # pintle
    GO = add(TO, (0.12, 0.0, 0.36))
    G = Part(offset=GO, bevel_max=0.012)
    G.box((-0.45, -0.065, -0.06), (0.14, 0.065, 0.08), 'Metal')
    G.box((-0.22, -0.22, -0.12), (0.02, -0.065, 0.04), 'Paint')
    barrel(G, [(0.14, 0.9, 0.026, 0.026), (0.9, 1.0, 0.036, 0.036)], segs=10)
    L = 1.0
    return assemble(H, T, TO, G, GO, add(GO, (L, 0, 0)))


# --------------------------------------------------------------------------------------
# BMP-3
# --------------------------------------------------------------------------------------
def build_bmp3():
    H = Part(bevel_max=0.03)
    running_gear(H, y_out=1.55, tw=0.38, wheels_x=[2.2 - i * 0.86 for i in range(6)], wr=0.32,
                 sprocket=(-3.0, 0.6, 0.3), idler=(3.0, 0.55, 0.27), rollers=(1.7, 0.8, -0.1, -1.0),
                 roller_z=0.88, roller_r=0.07, t=0.07)
    ga, gb = (3.57, 0.95), (1.4, 1.52)
    xg = 3.57 - (0.05 / 0.57) * 2.17
    H.prism_xz([(-3.3, 0.42), (2.75, 0.42), ga, gb, (-3.5, 1.56), (-3.57, 1.3)], -1.16, 1.16, 'Paint')
    H.prism_xz([(-3.57, 1.0), (xg, 1.0), gb, (-3.5, 1.56), (-3.57, 1.45)], -1.56, 1.56, 'Paint')
    # trim vane / wave deflector with ribs and hinges
    glacis_slab(H, ga, gb, -1.35, 1.35, 0.04, 0.36, 0.05, 'Paint')
    p, d, yv, nrm = glacis_frame(ga, gb, 0.2, 0.0)
    with H.style(bevel=0):
        for y in (-1.0, -0.5, 0.0, 0.5, 1.0):
            H.obox(p + nrm * 0.07 + V((0, y, 0)), d, yv, nrm, (0.3, 0.018, 0.022), 'Paint')
        for y in (-1.2, 1.2):
            H.obox(p + nrm * 0.03 + d * 0.33 + V((0, y, 0)), d, yv, nrm, (0.06, 0.05, 0.05), 'Metal')
    for s in SIDES:
        lo, hi = sorted((s * 1.56, s * 1.62))
        for x0, x1 in ((3.1, 2.05), (2.03, 0.95), (0.93, -0.15), (-0.17, -1.1), (-1.12, -2.1), (-2.12, -3.2)):
            H.box((x1, lo, 0.64), (x0, hi, 1.0), 'Paint')                      # skirt panels
        crate(H, (-3.45, min(s * 1.08, s * 1.52), 1.55), (-2.2, max(s * 1.08, s * 1.52), 1.76), 'Paint')
        # bow machine guns in ball mounts
        H.cyl((2.12, s * 0.9, 1.26), (2.12, s * 0.9, 1.4), 0.08, mat='Paint', segs=12)
        H.dome((2.22, s * 0.9, 1.31), 0.075, 'Paint', up=(1, 0, 0.5), segs=10, rings=2)
        with H.style(bevel=0):
            H.cyl((2.25, s * 0.9, 1.33), (2.6, s * 0.9, 1.35), 0.02, mat='Barrel', segs=8)
        lamp(H, (3.3, s * 1.1, 1.12), r=0.045, guard=True)
        lamp(H, (3.3, s * 1.24, 1.1), r=0.035, tag='Lens')
        tow_hook(H, (3.35, s * 0.62, 0.78), (0.6, 0, -0.8))
        tail_light(H, (-3.59, s * 1.42, 1.38))
        # water-jet outlets and their flaps (rear)
        H.cyl((-3.6, s * 1.25, 1.14), (-3.56, s * 1.25, 1.14), 0.14, mat='Dark', segs=16)
        H.box((-3.63, s * 1.25 - 0.15, 1.27), (-3.59, s * 1.25 + 0.15, 1.33), 'Metal')
        # vision blocks along the hull roof edge
        for x in (1.0, 0.3):
            periscope(H, (x, s * 1.45, 1.58), (0.3, s, 0.3), w=0.12, h=0.05, d=0.08)
        cable(H, [(1.3, s * 1.58, 1.52), (-0.3, s * 1.585, 1.52), (-1.9, s * 1.58, 1.52)])
    periscope(H, (1.95, 0.0, 1.56), (1, 0, 0.4), w=0.44, h=0.07, d=0.12)
    p, d, yv, nrm = glacis_frame(ga, gb, 0.62, 0.0)
    for s in SIDES:
        spare_links(H, p + nrm * 0.005 + V((0, s * 0.8, 0)), yv, d, nrm, count=3, pitch=0.17, w=0.3, t=0.04)
        grab(H, (0.4, s * 1.5, 1.55), (-0.4, s * 1.52, 1.555), (0, s * 0.2, 1), h=0.05)
    roll(H, (-2.3, -0.9, 1.63), (-2.3, 0.9, 1.63), 0.1)
    grille(H, -3.2, -1.4, -1.0, 1.0, 1.555, n=6)
    # rear doors with handles, troop hatches above them
    for s in SIDES:
        a, b = sorted((s * 0.05, s * 0.88))
        H.box((-3.61, a, 0.92), (-3.56, b, 1.44), 'Plate')
        grab(H, (-3.61, s * 0.5, 1.2), (-3.61, s * 0.72, 1.2), (-1, 0, 0), h=0.04)
        a, b = sorted((s * 0.08, s * 0.85))
        H.box((-3.45, a, 1.56), (-3.0, b, 1.59), 'Plate')

    TO = (0.15, 0.0, 1.55)
    T = Part(offset=TO, bevel_max=0.026)
    T.stack_z([
        (sym_y([(1.05, 0.5), (0.7, 1.1), (-0.9, 1.15), (-1.2, 0.85)]), 0.0),
        (sym_y([(1.1, 0.5), (0.75, 1.15), (-0.95, 1.2), (-1.25, 0.88)]), 0.22),
        (sym_y([(0.75, 0.45), (0.45, 0.95), (-0.85, 1.0), (-1.1, 0.7)]), 0.55),
    ], 'Paint')
    T.box((0.2, -0.92, 0.5), (0.65, -0.55, 0.75), 'Paint')                    # gunner's sight (right)
    with T.style(bevel=0):
        T.box((0.65, -0.88, 0.55), (0.665, -0.6, 0.7), 'Lens')
    T.box((0.4, -0.95, 0.75), (0.68, -0.52, 0.78), 'Plate')
    T.cyl((0.05, 0.6, 0.52), (0.05, 0.6, 0.72), 0.12, mat='Paint', segs=12)  # commander's sight (left)
    T.box((-0.1, 0.48, 0.72), (0.22, 0.74, 0.86), 'Paint')
    with T.style(bevel=0):
        T.box((0.22, 0.52, 0.74), (0.235, 0.7, 0.84), 'Lens')
    T.cyl((-0.45, 0.45, 0.53), (-0.45, 0.45, 0.6), 0.26, mat='Plate', segs=16)
    T.cyl((-0.45, -0.45, 0.53), (-0.45, -0.45, 0.6), 0.24, mat='Plate', segs=16)
    for s in SIDES:
        smoke_bank(T, (-0.05, s * 1.14, 0.36), (0.6, s * 0.8, 0), n=3, spacing=0.09)
        o, u, v, n = face_frame((0.75, s * 1.15, 0.22), (-0.95, s * 1.2, 0.22), (0.45, s * 0.95, 0.55))
        if n.y * s < 0:
            n = -n
        if (u.x < 0) != (s > 0):
            u = -u
        v = n.cross(u).normalized()
        if v.z < 0:
            v = -v
        c = V((-0.55, s * 1.13, 0.36))
        digits(T, '342', c, u, v, n, h=0.18)
    antenna(T, (-0.8, -0.4, 0.55), h=0.55)
    antenna(T, (-0.85, 0.3, 0.55), h=0.4)
    GO = add(TO, (0.85, 0.0, 0.3))
    G = Part(offset=GO, bevel_max=0.02)
    G.box((-0.25, -0.48, -0.2), (0.36, 0.48, 0.2), 'Paint')
    G.box((0.33, -0.44, -0.16), (0.4, 0.44, 0.16), 'Plate')
    barrel(G, [(0.35, 0.9, 0.12, 0.11), (0.9, 2.95, 0.08, 0.08)], mat='Paint')
    barrel(G, [(2.95, 3.05, 0.09, 0.09)], mat='Barrel')
    with G.style(bevel=0):
        G.cyl((1.8, 0, 0), (1.84, 0, 0), 0.088, mat='Metal', segs=16, hint=(0, 0, 1))
    for x0, x1, r in ((0.35, 0.72, 0.06), (0.72, 2.75, 0.032), (2.75, 2.88, 0.045)):
        G.cyl((x0, -0.32, -0.02), (x1, -0.32, -0.02), r, mat='Barrel', segs=12, hint=(0, 0, 1))
    G.cyl((0.35, 0.32, -0.05), (0.75, 0.32, -0.05), 0.02, mat='Barrel', segs=8)
    L = 3.05
    return assemble(H, T, TO, G, GO, add(GO, (L, 0, 0)),
                    extra_muzzles=[('muzzle_30mm', add(GO, (2.88, -0.32, -0.02)))])


# --------------------------------------------------------------------------------------
# BTR-82A
# --------------------------------------------------------------------------------------
def build_btr82a():
    H = Part(bevel_max=0.03)
    road_wheels(H, [2.2, 0.85, -0.7, -2.05], wr=0.54, width=0.36, y_out=1.34, segs=20)
    mid = sym_yz([(0.88, 0.52), (1.45, 1.15), (1.05, 2.05)])
    H.loft_x([
        (-3.825, sym_yz([(0.72, 0.9), (1.22, 1.2), (0.95, 1.78)])),
        (-2.95, mid),
        (2.25, mid),
        (3.825, sym_yz([(0.7, 0.95), (0.95, 1.08), (0.72, 1.22)])),
    ], 'Paint')

    def upper_y(z):
        return 1.45 - 0.4 * (z - 1.15) / 0.9
    for s in SIDES:
        # side door between the 2nd and 3rd axle (with handle), step, vision blocks, firing ports
        side_window(H, s, -0.35, 0.25, 1.22, 1.75, upper_y, mat='Plate')
        with H.style(bevel=0):
            H.box((0.08, s * upper_y(1.5) - 0.02, 1.47), (0.2, s * upper_y(1.5) + 0.02, 1.51), 'Metal')
        H.box((-0.4, min(s * 1.3, s * 1.42), 1.1), (0.3, max(s * 1.3, s * 1.42), 1.14), 'Metal')
        for x in (1.45, -1.25, -2.05):
            side_window(H, s, x - 0.1, x + 0.1, 1.8, 1.9, upper_y)
        for x in (1.1, -0.9, -1.65):
            z = 1.55
            p = V((x, s * (upper_y(z) + 0.01), z))
            H.cyl(p - V((0, s * 0.03, 0)), p + V((0, s * 0.03, -0.012)), 0.055, mat='Paint', segs=10)
        lamp(H, (3.66, s * 0.71, 1.15), r=0.045, guard=True)
        tow_hook(H, (3.8, s * 0.35, 0.98), (1, 0, -0.3))
        tow_hook(H, (-3.82, s * 0.45, 1.0), (-1, 0, 0))
        tail_light(H, (-3.83, s * 0.72, 1.3))
        antenna(H, (-2.6, s * 0.7, 2.0), h=0.6)
        # tactical number on the upper side plate
        zc = 1.5
        p0 = V((1.6, s * upper_y(zc), zc))
        p1 = V((0.6, s * upper_y(zc), zc))
        p2 = V((1.6, s * upper_y(zc + 0.4), zc + 0.4))
        if s < 0:
            p0, p1 = p1, p0
            p2 = V((0.6, s * upper_y(zc + 0.4), zc + 0.4))
        o, u, v, n = face_frame(p0, p1, p2)
        if n.y * s < 0:
            n = -n
        digits(H, '215', V((1.1, s * upper_y(zc + 0.1), zc + 0.1)) + n * 0.005, u, v, n, h=0.2)
    # windscreen shutters with vision blocks on the upper glacis
    ga, gb = (2.25, 2.05), (3.825, 1.22)
    for s in SIDES:
        lo, hi = sorted((s * 0.08, s * 0.78))
        H.slab(plane_pts(ga, gb, lo, hi, 0.1, 0.32), 0.03, 'Glass', out=(1, 0, 1))
        H.slab(plane_pts(ga, gb, lo, hi, 0.33, 0.38), 0.05, 'Plate', out=(1, 0, 1))
    H.slab(plane_pts(ga, gb, -0.9, 0.9, 0.62, 0.9), 0.04, 'Paint', out=(1, 0, 1))   # trim vane
    p, d, yv, nrm = glacis_frame(gb, ga, 0.24, 0.0)
    with H.style(bevel=0):
        for y in (-0.6, 0.0, 0.6):
            H.obox(p + nrm * 0.065 + V((0, y, 0)), d, yv, nrm, (0.18, 0.018, 0.02), 'Paint')
    grille(H, -2.85, -1.3, -0.8, 0.8, 2.045, n=5)
    for s in SIDES:
        H.cyl((1.85, s * 0.45, 2.03), (1.85, s * 0.45, 2.1), 0.25, mat='Plate', segs=16)
        periscope(H, (2.12, s * 0.45, 2.06), (1, 0, 0.3), w=0.14, h=0.05, d=0.08)
        H.box((-0.55, min(s * 0.15, s * 0.75), 2.04), (0.15, max(s * 0.15, s * 0.75), 2.08), 'Plate')  # troop hatches
    # rear: water-jet opening and stowage
    H.cyl((-3.85, 0.0, 1.12), (-3.8, 0.0, 1.12), 0.18, mat='Dark', segs=16)
    crate(H, (-2.9, -0.7, 2.04), (-2.3, 0.1, 2.26), 'Paint')
    for s in SIDES:
        for x0, x1 in ((1.6, 0.9), (-1.0, -1.7)):
            grab(H, (x0, s * 0.98, 2.06), (x1, s * 0.98, 2.06), (0, s * 0.4, 1), h=0.05)
        # exhaust grilles on the rear hull sides
        zc = 1.65
        H.slab([(-2.4, s * (upper_y(zc - 0.1) + 0.002), zc - 0.1), (-1.9, s * (upper_y(zc - 0.1) + 0.002), zc - 0.1),
                (-1.9, s * (upper_y(zc + 0.12) + 0.002), zc + 0.12), (-2.4, s * (upper_y(zc + 0.12) + 0.002), zc + 0.12)],
               0.03, 'Dark', out=(0, s, 0.4))
        bag(H, (-1.2, s * 0.55, 2.2), (0.5, 0.36, 0.28), yaw=0.08 * s)
        jerrycan(H, (-3.2, s * 0.62, 2.12), yaw=math.pi / 2)
    roll(H, (-2.6, 0.25, 2.14), (-2.6, 0.8, 2.14), 0.09)

    TO = (0.9, 0.0, 2.05)
    T = Part(offset=TO, bevel_max=0.02)
    T.stack_z([
        (rounded_rect(-0.75, 0.65, -0.72, 0.72, 0.28), 0.0),
        (rounded_rect(-0.62, 0.52, -0.58, 0.58, 0.22), 0.5),
    ], 'Paint')
    T.box((0.05, 0.18, 0.48), (0.42, 0.46, 0.72), 'Paint')
    with T.style(bevel=0):
        T.box((0.42, 0.22, 0.54), (0.435, 0.42, 0.68), 'Lens')
    T.box((-0.35, -0.42, 0.48), (-0.02, -0.14, 0.6), 'Paint')
    with T.style(bevel=0):
        T.box((-0.02, -0.38, 0.5), (-0.005, -0.18, 0.58), 'Lens')
    T.cyl((-0.3, 0.2, 0.49), (-0.3, 0.2, 0.54), 0.2, mat='Plate', segs=16)
    for s in SIDES:
        smoke_bank(T, (-0.4, s * 0.64, 0.3), (-0.2, s * 1.0, 0), n=3, spacing=0.09)
    antenna(T, (-0.45, -0.3, 0.5), h=0.5)
    lamp(T, (0.5, -0.55, 0.45), (1, 0, 0), r=0.07, tag='Light')          # searchlight
    T.box((0.3, -0.62, 0.35), (0.44, -0.48, 0.4), 'Metal')
    with T.style(bevel=0):
        T.tube([(-0.62, 0.45, 0.15), (-0.8, 0.45, 0.2), (-0.8, -0.45, 0.2), (-0.62, -0.45, 0.15)], [0.015] * 4,
               mat='Metal', segs=5)
    bag(T, (-0.72, 0.0, 0.3), (0.26, 0.7, 0.26), tag='Canvas')
    GO = add(TO, (0.58, 0.0, 0.24))
    G = Part(offset=GO, bevel_max=0.015)
    G.box((-0.12, -0.22, -0.15), (0.28, 0.22, 0.15), 'Paint')
    barrel(G, [(0.28, 0.9, 0.055, 0.05), (0.9, 2.45, 0.03, 0.03), (2.45, 2.58, 0.042, 0.042)], segs=12)
    G.cyl((0.28, 0.16, 0.0), (0.8, 0.16, 0.0), 0.018, mat='Barrel', segs=8)
    L = 2.58
    return assemble(H, T, TO, G, GO, add(GO, (L, 0, 0)))
