#!/usr/bin/env python3
"""Verify the exported GLBs against the conventions in docs/MODELS.md.

Pure Python (no Blender needed):   python3 tools/blender/verify_models.py [models_dir]

Checks, per model: GLB structure, no textures/images, material names, triangle budget,
file size, bounds (glTF: +Y up, front along +X, feet/tracks on y=0, footprint centred),
approximate dimensions vs the spec table, vehicle node hierarchy
hull -> turret -> gun -> muzzle with the turret origin at the ring (not world origin),
wheel/sprocket/idler nodes centred on their axles, and agreement with manifest.json.

Graphics pass v3 (every model except the legacy static soldier_* files):
  * materials only Vehicle (+ Glass) or Foliage / Trunk, white base colour, sane roughness;
  * every primitive has NORMAL and COLOR_0 (the albedo incl. baked AO), with plausible,
    varied values;
  * smooth shading (a good share of triangles with non-identical vertex normals) and no
    triangles whose normals point against their winding (foliage excepted: it uses soft
    spherical normals on purpose);
  * vegetation LODs (<name>_lod) stay within 100 triangles and match their full model's size.
Exits 1 if any check fails.
"""
import json
import math
import os
import struct
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_DIR = os.path.join(HERE, '..', '..', 'public', 'models')

# name: (kind, (L, W, H) from the spec table; None = not specified)
SPEC = {
    'm1a2': ('vehicle', (7.9, 3.7, 2.4)),
    'm2a4': ('vehicle', (6.6, 3.3, 3.0)),
    'stryker': ('vehicle', (7.0, 2.7, 2.6)),
    'jltv': ('vehicle', (6.2, 2.5, 2.6)),
    't90m': ('vehicle', (6.9, 3.8, 2.2)),
    't72b3': ('vehicle', (6.9, 3.6, 2.2)),
    'bmp3': ('vehicle', (7.1, 3.2, 2.4)),
    'btr82a': ('vehicle', (7.6, 2.9, 2.8)),
    'tigr': ('vehicle', (5.7, 2.4, 2.4)),
    'soldier_stand': ('soldier', (None, None, 1.8)),
    'soldier_kneel': ('soldier', (None, None, 1.1)),
    'soldier_prone': ('soldier', (1.9, None, 0.4)),
    'soldier_dead': ('soldier', (None, None, 0.3)),
    'tree_oak': ('tree', (7.0, 7.0, 9.0)),
    'tree_pine': ('tree', (None, None, 12.0)),
    'tree_birch': ('tree', (3.5, 3.5, 10.0)),
    'bush': ('tree', (2.5, 2.5, 1.5)),
    'tree_oak_lod': ('tree', (7.0, 7.0, 9.0)),
    'tree_pine_lod': ('tree', (None, None, 12.0)),
    'tree_birch_lod': ('tree', (3.5, 3.5, 10.0)),
    'bush_lod': ('tree', (2.5, 2.5, 1.5)),
    'drone_quad': ('prop', (0.6, 0.6, 0.2)),
    'drone_fixed': ('prop', (1.2, 1.8, None)),
    'mortar': ('prop', (1.2, None, None)),
    'atgm_tripod': ('prop', (1.2, None, 1.0)),
}
BUDGET = {'vehicle': 12000, 'soldier': 800, 'tree': 700, 'prop': 2000}
MODEL_BUDGET = {'tree_oak': 450, 'tree_birch': 450, 'tree_pine': 350, 'bush': 200,
                'tree_oak_lod': 100, 'tree_pine_lod': 100, 'tree_birch_lod': 100, 'bush_lod': 100}
LOD_OF = {'tree_oak_lod': 'tree_oak', 'tree_pine_lod': 'tree_pine', 'tree_birch_lod': 'tree_birch',
          'bush_lod': 'bush'}
# legacy (v1) static soldiers: flat-shaded, per-part materials, no vertex colours
LEGACY_MATS = {'Paint', 'Dark', 'Metal', 'Glass', 'Uniform', 'Gear', 'Skin'}
LEGACY_REQUIRED = {'Uniform', 'Gear', 'Skin'}
# v3: vertex-coloured albedo, at most two materials
V3_MATS = {'vehicle': {'Vehicle', 'Glass'}, 'prop': {'Vehicle', 'Glass'}, 'tree': {'Foliage', 'Trunk'}}
V3_REQUIRED = {'vehicle': {'Vehicle', 'Glass'}, 'prop': {'Vehicle'}, 'tree': {'Foliage'}}
ROUGHNESS = {'Vehicle': (0.6, 0.8), 'Glass': (0.1, 0.35), 'Foliage': (0.7, 1.0), 'Trunk': (0.7, 1.0)}
SIZE_TOL = 0.30        # relative tolerance vs the approximate spec sizes
MAX_KB = 800


# --------------------------------------------------------------------------------------
def read_glb(path):
    with open(path, 'rb') as fh:
        data = fh.read()
    magic, version, length = struct.unpack_from('<III', data, 0)
    if magic != 0x46546C67 or version != 2:
        raise ValueError('not a glTF 2.0 binary')
    off, js, bin_ = 12, None, None
    while off < length:
        clen, ctype = struct.unpack_from('<II', data, off)
        off += 8
        chunk = data[off:off + clen]
        off += clen
        if ctype == 0x4E4F534A:
            js = json.loads(chunk.decode('utf-8'))
        elif ctype == 0x004E4942:
            bin_ = chunk
    return js, bin_


def mat_mul(a, b):
    return [[sum(a[i][k] * b[k][j] for k in range(4)) for j in range(4)] for i in range(4)]


def node_matrix(n):
    if 'matrix' in n:
        m = n['matrix']
        return [[m[c * 4 + r] for c in range(4)] for r in range(4)]
    tx, ty, tz = n.get('translation', [0, 0, 0])
    x, y, z, w = n.get('rotation', [0, 0, 0, 1])
    sx, sy, sz = n.get('scale', [1, 1, 1])
    r = [[1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
         [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
         [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)]]
    return [[r[0][0] * sx, r[0][1] * sy, r[0][2] * sz, tx],
            [r[1][0] * sx, r[1][1] * sy, r[1][2] * sz, ty],
            [r[2][0] * sx, r[2][1] * sy, r[2][2] * sz, tz],
            [0, 0, 0, 1]]


def xform(m, p):
    return [m[i][0] * p[0] + m[i][1] * p[1] + m[i][2] * p[2] + m[i][3] for i in range(3)]


def is_identity_rs(n):
    r = n.get('rotation', [0, 0, 0, 1])
    s = n.get('scale', [1, 1, 1])
    return all(abs(a - b) < 1e-5 for a, b in zip(r, [0, 0, 0, 1])) and all(abs(a - 1) < 1e-5 for a in s)


class Model:
    def __init__(self, path):
        self.js, self.bin = read_glb(path)
        js = self.js
        self.nodes = js.get('nodes', [])
        self.parent = {}
        for i, n in enumerate(self.nodes):
            for c in n.get('children', []):
                self.parent[c] = i
        scene = js['scenes'][js.get('scene', 0)]
        self.roots = scene['nodes']
        self.world = {}

        def walk(i, m):
            wm = mat_mul(m, node_matrix(self.nodes[i]))
            self.world[i] = wm
            for c in self.nodes[i].get('children', []):
                walk(c, wm)
        ident = [[1 if r == c else 0 for c in range(4)] for r in range(4)]
        for r in self.roots:
            walk(r, ident)
        self.by_name = {n.get('name'): i for i, n in enumerate(self.nodes)}
        self.materials = [m.get('name') for m in js.get('materials', [])]

    def subtree(self, i):
        out = [i]
        for c in self.nodes[i].get('children', []):
            out += self.subtree(c)
        return out

    def tris(self):
        t = 0
        for mesh in self.js.get('meshes', []):
            for p in mesh['primitives']:
                if p.get('mode', 4) != 4:
                    raise ValueError('non-triangle primitive')
                acc = p['indices'] if 'indices' in p else p['attributes']['POSITION']
                t += self.js['accessors'][acc]['count'] // 3
        return t

    def read_accessor(self, idx):
        acc = self.js['accessors'][idx]
        bv = self.js['bufferViews'][acc['bufferView']]
        ncomp = {'SCALAR': 1, 'VEC2': 2, 'VEC3': 3, 'VEC4': 4}[acc['type']]
        fmt, size = {5126: ('f', 4), 5125: ('I', 4), 5123: ('H', 2), 5121: ('B', 1)}[acc['componentType']]
        stride = bv.get('byteStride', size * ncomp)
        base = bv.get('byteOffset', 0) + acc.get('byteOffset', 0)
        norm = {5123: 65535.0, 5121: 255.0}.get(acc['componentType']) if acc.get('normalized') else None
        out = []
        for i in range(acc['count']):
            vals = struct.unpack_from('<%d%s' % (ncomp, fmt), self.bin, base + i * stride)
            if norm:
                vals = tuple(v / norm for v in vals)
            out.append(vals if ncomp > 1 else vals[0])
        return out

    def v3_report(self):
        """Vertex-colour / normal statistics for the v3 format.
        Returns dict(missing_color, missing_normal, lum_min, lum_mean, lum_max, lum_std,
        tris, smooth_tris, bad_tris) where bad_tris counts non-foliage triangles whose averaged
        vertex normal points clearly against the winding."""
        r = dict(missing_color=0, missing_normal=0, tris=0, smooth_tris=0, bad_tris=0)
        lums = []
        for mesh in self.js.get('meshes', []):
            for p in mesh['primitives']:
                at = p['attributes']
                mat = self.materials[p['material']] if 'material' in p else None
                if 'COLOR_0' not in at:
                    r['missing_color'] += 1
                else:
                    acc = self.js['accessors'][at['COLOR_0']]
                    if acc['type'] not in ('VEC3', 'VEC4') or (acc['componentType'] != 5126 and not acc.get('normalized')):
                        r['missing_color'] += 1
                    else:
                        for c in self.read_accessor(at['COLOR_0']):
                            lums.append(0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2])
                if 'NORMAL' not in at:
                    r['missing_normal'] += 1
                    continue
                pos = self.read_accessor(at['POSITION'])
                nrm = self.read_accessor(at['NORMAL'])
                idx = self.read_accessor(p['indices']) if 'indices' in p else list(range(len(pos)))
                for t in range(0, len(idx), 3):
                    ia, ib, ic = idx[t], idx[t + 1], idx[t + 2]
                    r['tris'] += 1
                    na, nb, nc = nrm[ia], nrm[ib], nrm[ic]
                    if max(abs(na[k] - nb[k]) + abs(na[k] - nc[k]) for k in range(3)) > 1e-3:
                        r['smooth_tris'] += 1
                    if mat == 'Foliage':
                        continue
                    a, b, c = pos[ia], pos[ib], pos[ic]
                    u = [b[k] - a[k] for k in range(3)]
                    v = [c[k] - a[k] for k in range(3)]
                    n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]]
                    L = math.sqrt(sum(x * x for x in n))
                    if L < 2e-7:      # degenerate sliver (area < 1e-7 m^2): no visible shading
                        continue
                    avg = [na[k] + nb[k] + nc[k] for k in range(3)]
                    if sum(n[k] * avg[k] for k in range(3)) / L < -0.3:
                        r['bad_tris'] += 1
        if lums:
            mean = sum(lums) / len(lums)
            r.update(lum_min=min(lums), lum_max=max(lums), lum_mean=mean,
                     lum_std=math.sqrt(sum((x - mean) ** 2 for x in lums) / len(lums)))
        return r

    def winding_report(self):
        """(triangles whose winding disagrees with their normals, list of mesh signed volumes)."""
        bad, vols = 0, []
        for mesh in self.js.get('meshes', []):
            vol = 0.0
            for p in mesh['primitives']:
                pos = self.read_accessor(p['attributes']['POSITION'])
                nrm = self.read_accessor(p['attributes']['NORMAL']) if 'NORMAL' in p['attributes'] else None
                idx = self.read_accessor(p['indices']) if 'indices' in p else list(range(len(pos)))
                for t in range(0, len(idx), 3):
                    a, b, c = pos[idx[t]], pos[idx[t + 1]], pos[idx[t + 2]]
                    u = [b[k] - a[k] for k in range(3)]
                    v = [c[k] - a[k] for k in range(3)]
                    n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]]
                    vol += (a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0])
                            + a[2] * (b[0] * c[1] - b[1] * c[0])) / 6.0
                    if nrm is not None and sum(n[k] * n[k] for k in range(3)) > 1e-14:
                        vn = nrm[idx[t]]
                        if n[0] * vn[0] + n[1] * vn[1] + n[2] * vn[2] < 0:
                            bad += 1
            vols.append(vol)
        return bad, vols

    def bounds(self, node_ids=None, material=None):
        mn = [math.inf] * 3
        mx = [-math.inf] * 3
        ids = node_ids if node_ids is not None else list(self.world)
        for i in ids:
            n = self.nodes[i]
            if 'mesh' not in n or i not in self.world:
                continue
            for p in self.js['meshes'][n['mesh']]['primitives']:
                if material is not None and self.materials[p.get('material', -1)] != material:
                    continue
                acc = self.js['accessors'][p['attributes']['POSITION']]
                a, b = acc['min'], acc['max']
                for cx in (a[0], b[0]):
                    for cy in (a[1], b[1]):
                        for cz in (a[2], b[2]):
                            w = xform(self.world[i], (cx, cy, cz))
                            for k in range(3):
                                mn[k] = min(mn[k], w[k])
                                mx[k] = max(mx[k], w[k])
        return mn, mx


# --------------------------------------------------------------------------------------
def verify(models_dir):
    manifest_path = os.path.join(models_dir, 'manifest.json')
    manifest = json.load(open(manifest_path)) if os.path.exists(manifest_path) else {}
    failures, warnings = [], []
    rows = []

    def fail(name, msg):
        failures.append('%s: %s' % (name, msg))

    for name, (kind, spec_size) in SPEC.items():
        path = os.path.join(models_dir, name + '.glb')
        if not os.path.exists(path):
            fail(name, 'missing file')
            continue
        kb = os.path.getsize(path) / 1024.0
        try:
            m = Model(path)
        except Exception as exc:  # noqa: BLE001
            fail(name, 'unreadable GLB: %s' % exc)
            continue
        js = m.js
        if js.get('images') or js.get('textures') or js.get('samplers'):
            fail(name, 'contains images/textures')
        if kb > MAX_KB:
            warnings.append('%s: %.0f KB > %d KB' % (name, kb, MAX_KB))

        v3 = kind != 'soldier'
        mats = set(m.materials)
        allowed = V3_MATS[kind] if v3 else LEGACY_MATS
        bad = mats - allowed
        if bad:
            fail(name, 'unexpected material names %s (allowed %s)' % (sorted(bad), sorted(allowed)))
        required = V3_REQUIRED[kind] if v3 else LEGACY_REQUIRED
        if kind == 'tree' and not name.startswith('bush'):
            required = required | {'Trunk'}
        missing = required - mats
        if missing:
            fail(name, 'missing materials %s' % sorted(missing))
        for mat in js.get('materials', []):
            pbr = mat.get('pbrMetallicRoughness', {})
            if 'baseColorTexture' in pbr:
                fail(name, 'material %s uses a texture' % mat.get('name'))
            if v3:
                bcf = pbr.get('baseColorFactor', [1, 1, 1, 1])
                if any(abs(x - 1.0) > 1e-3 for x in bcf[:3]):
                    fail(name, 'material %s baseColorFactor %s should be white (albedo is in COLOR_0)'
                         % (mat.get('name'), [round(x, 3) for x in bcf]))
                lo, hi = ROUGHNESS.get(mat.get('name'), (0, 1))
                rf = pbr.get('roughnessFactor', 1.0)
                if not lo <= rf <= hi:
                    fail(name, 'material %s roughness %.2f outside %.2f..%.2f' % (mat.get('name'), rf, lo, hi))

        tris = m.tris()
        budget = MODEL_BUDGET.get(name, BUDGET[kind])
        if tris > budget:
            fail(name, '%d tris > budget %d' % (tris, budget))
        if name in manifest and manifest[name].get('tris') != tris:
            fail(name, 'manifest tris %s != glb %d' % (manifest[name].get('tris'), tris))
        if v3 and name in manifest and not manifest[name].get('vertexColors'):
            fail(name, 'manifest entry lacks vertexColors: true')

        # outward-facing, consistently wound triangles (three.js culls back faces)
        bad_tris, vols = m.winding_report()
        if not v3 and bad_tris:
            fail(name, '%d triangles wound against their normals' % bad_tris)
        if any(v <= 0 for v in vols):
            fail(name, 'mesh with non-positive signed volume (inside-out faces) %s' % [round(v, 3) for v in vols])
        vc = ''
        if v3:
            r = m.v3_report()
            if r['missing_color']:
                fail(name, '%d primitives without a usable COLOR_0 (vertex colours)' % r['missing_color'])
            if r['missing_normal']:
                fail(name, '%d primitives without NORMAL' % r['missing_normal'])
            if 'lum_mean' in r:
                if not 0.01 <= r['lum_mean'] <= 0.6 or r['lum_max'] > 1.0001 or r['lum_min'] < 0:
                    fail(name, 'implausible vertex colours (luminance min %.3f mean %.3f max %.3f)'
                         % (r['lum_min'], r['lum_mean'], r['lum_max']))
                if r['lum_std'] < 0.004:
                    fail(name, 'vertex colours are nearly uniform (std %.4f): no AO / variation baked in'
                         % r['lum_std'])
            smooth = r['smooth_tris'] / max(r['tris'], 1)
            if smooth < 0.25:
                fail(name, 'only %.0f%% of triangles are smooth-shaded' % (smooth * 100))
            if r['bad_tris']:
                fail(name, '%d triangles with normals pointing against their winding' % r['bad_tris'])
            vc = 'COLOR_0 lum %.2f..%.2f smooth %.0f%%' % (r.get('lum_min', 0), r.get('lum_max', 0), smooth * 100)
        # colour pipeline regression: the manifest's paint probe (a vertex on open, flat paint,
        # recorded at build time) must be found in the GLB with the same COLOR_0, and that colour
        # must be close to the scheme's linear paint colour (a double sRGB->linear conversion
        # would make it ~3-5x too dark)
        pr = manifest.get(name, {}).get('paintProbe')
        if v3 and pr is None:
            warnings.append('%s: no paintProbe in manifest' % name)
        if v3 and pr is not None:
            ni = m.by_name.get(pr['node'])
            found = None
            if ni is not None and 'mesh' in m.nodes[ni]:
                for p in m.js['meshes'][m.nodes[ni]['mesh']]['primitives']:
                    pos = m.read_accessor(p['attributes']['POSITION'])
                    cols = m.read_accessor(p['attributes']['COLOR_0'])
                    for P_, c_ in zip(pos, cols):
                        if max(abs(P_[k] - pr['pos'][k]) for k in range(3)) < 2e-3:
                            if found is None or max(abs(c_[k] - pr['color'][k]) for k in range(3)) < \
                                    max(abs(found[k] - pr['color'][k]) for k in range(3)):
                                found = c_
            if found is None:
                fail(name, 'paint probe vertex %s not found in node %s' % (pr['pos'], pr['node']))
            else:
                err = max(abs(found[k] - pr['color'][k]) for k in range(3))
                if err > 0.004:
                    fail(name, 'COLOR_0 at the paint probe %s differs from the built colour %s' % (
                        [round(x, 3) for x in found[:3]], pr['color']))
                ratio = [found[k] / max(pr['expected'][k], 1e-4) for k in range(3)]
                # lower bound catches a double sRGB->linear conversion (~0.1-0.35x); the upper bound
                # allows for dust on dark camouflage and the lighter outer foliage of the tree LODs
                lo, hi = (0.45, 2.6) if kind == 'tree' else (0.7, 1.9)
                if not all(lo <= r_ <= hi for r_ in ratio):
                    fail(name, 'paint probe colour %s is not ~ the scheme paint %s (linear); ratios %s' % (
                        [round(x, 3) for x in found[:3]], pr['expected'], [round(r_, 2) for r_ in ratio]))
                vc += ' probe x%.2f' % (sum(ratio) / 3)
        # vegetation LODs: same footprint / height as the full model
        if name in LOD_OF:
            full = os.path.join(models_dir, LOD_OF[name] + '.glb')
            if os.path.exists(full):
                fm = Model(full)
                a0, a1 = fm.bounds()
                b0, b1 = m.bounds()
                for k, label, tol in ((1, 'height', 0.12), (0, 'length', 0.25), (2, 'width', 0.25)):
                    fa, fb = a1[k] - a0[k], b1[k] - b0[k]
                    if abs(fa - fb) / max(fa, 1e-6) > tol:
                        fail(name, 'LOD %s %.2f differs from %s (%.2f) by >%d%%' % (label, fb, LOD_OF[name], fa,
                                                                                   tol * 100))

        # node transforms: only the mortar muzzle may carry a rotation; no scaling anywhere
        for i, n in enumerate(m.nodes):
            if not is_identity_rs(n) and not (name == 'mortar' and n.get('name') == 'muzzle'):
                fail(name, 'node %s has rotation/scale' % n.get('name'))

        # bounds (glTF: x = front, y = up, z = right)
        body_ids = list(m.world)
        if kind == 'vehicle' and 'gun' in m.by_name:
            gun_sub = set(m.subtree(m.by_name['gun']))
            body_ids = [i for i in body_ids if i not in gun_sub]
        mn, mx = m.bounds(body_ids)
        fmn, fmx = m.bounds()
        L, H, W = mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2]
        if abs(fmn[1]) > 0.005:
            fail(name, 'lowest point y=%.3f (should rest on y=0)' % fmn[1])
        cmn, cmx = (m.bounds(material='Uniform') if kind == 'soldier' else (mn, mx))   # soldiers: body only
        cx, cz = (cmn[0] + cmx[0]) / 2, (cmn[2] + cmx[2]) / 2
        tol_c = 0.3 if kind == 'vehicle' else max(0.2 * max(L, W), 0.1)
        if abs(cx) > tol_c or abs(cz) > tol_c:
            fail(name, 'footprint not centred (centre x=%.2f z=%.2f)' % (cx, cz))
        for label, got, want in (('L', L, spec_size[0]), ('W', W, spec_size[1]), ('H', H, spec_size[2])):
            if want is not None and abs(got - want) / want > SIZE_TOL:
                fail(name, '%s=%.2f differs from spec %.2f by >%d%%' % (label, got, want, SIZE_TOL * 100))

        notes = ''
        if kind == 'vehicle':
            ids = m.by_name
            for req in ('hull', 'turret', 'gun', 'muzzle'):
                if req not in ids:
                    fail(name, 'missing node %s' % req)
            if all(k in ids for k in ('hull', 'turret', 'gun', 'muzzle')):
                h, t, g, z = ids['hull'], ids['turret'], ids['gun'], ids['muzzle']
                if h not in m.roots:
                    fail(name, 'hull is not a scene root')
                if m.parent.get(t) != h or m.parent.get(g) != t or m.parent.get(z) != g:
                    fail(name, 'hierarchy is not hull>turret>gun>muzzle')
                if 'mesh' in m.nodes[z]:
                    fail(name, 'muzzle should be an empty node')
                ht = m.nodes[h].get('translation', [0, 0, 0])
                if any(abs(v) > 1e-4 for v in ht):
                    fail(name, 'hull origin not at world origin %s' % ht)
                tt = m.nodes[t].get('translation', [0, 0, 0])
                if tt[1] < 0.8 or abs(tt[0]) > 2.5 or abs(tt[2]) > 0.5:
                    fail(name, 'turret origin %s not at a plausible turret ring' % tt)
                gt = m.nodes[g].get('translation', [0, 0, 0])
                if gt[0] < -0.1 or gt[1] < 0.0:
                    fail(name, 'gun trunnion %s should be forward/up of the ring' % gt)
                zt = m.nodes[z].get('translation', [0, 0, 0])
                if zt[0] < 0.5 or abs(zt[1]) > 0.05 or abs(zt[2]) > 0.05:
                    fail(name, 'muzzle %s should lie on the gun +X axis' % zt)
                gmn, gmx = m.bounds([g])
                gw = m.world[g]
                gx0, gx1 = gmn[0] - gw[0][3], gmx[0] - gw[0][3]
                if gx1 < 2 * abs(gx0):
                    fail(name, 'gun mesh does not point along +X (local x %.2f..%.2f)' % (gx0, gx1))
                mw = [m.world[z][k][3] for k in range(3)]
                if mw[0] <= 0:
                    fail(name, 'muzzle is behind the origin (front must be +X)')
                if abs(zt[0] - (gmx[0] - gw[0][3])) > 0.05:
                    warnings.append('%s: muzzle x %.2f vs barrel tip %.2f' % (name, zt[0], gmx[0] - gw[0][3]))
                notes = 'turret@(%.2f,%.2f,%.2f) gun+(%.2f,%.2f,%.2f) muzzle+%.2f world_x=%.2f' % (
                    tt[0], tt[1], tt[2], gt[0], gt[1], gt[2], zt[0], mw[0])
            # rotating running gear: children of hull, mesh centred on the node origin (the axle)
            spin = [n for n in ids if n and (n.startswith('wheel_') or n.startswith('sprocket_')
                                             or n.startswith('idler_'))]
            if sum(1 for n in spin if n.startswith('wheel_L')) < 2 or sum(1 for n in spin if n.startswith('wheel_R')) < 2:
                fail(name, 'missing wheel_L*/wheel_R* nodes')
            for n in spin:
                i = ids[n]
                if m.parent.get(i) != ids.get('hull'):
                    fail(name, '%s is not a child of hull' % n)
                if 'mesh' not in m.nodes[i]:
                    fail(name, '%s has no mesh' % n)
                    continue
                wmn, wmx = m.bounds([i])
                w = m.world[i]
                cx_, cy_ = (wmn[0] + wmx[0]) / 2 - w[0][3], (wmn[1] + wmx[1]) / 2 - w[1][3]
                rad = (wmx[1] - wmn[1]) / 2
                if abs(cx_) > 0.05 * max(rad, 0.2) + 0.01 or abs(cy_) > 0.05 * max(rad, 0.2) + 0.01:
                    fail(name, '%s mesh not centred on its axle (offset %.3f, %.3f)' % (n, cx_, cy_))
            notes += ' spin=%d' % len(spin)
        elif kind == 'soldier':
            if 'soldier' not in m.by_name or m.by_name['soldier'] not in m.roots:
                fail(name, 'root node "soldier" missing')
            armed = name != 'soldier_dead'
            if armed:
                if 'muzzle' not in m.by_name:
                    fail(name, 'missing muzzle node')
                else:
                    mw = [m.world[m.by_name['muzzle']][k][3] for k in range(3)]
                    if mw[0] <= 0.2:
                        fail(name, 'rifle muzzle at x=%.2f (should point +X)' % mw[0])
                    notes = 'muzzle world (%.2f,%.2f,%.2f)' % tuple(mw)
            smn, smx = m.bounds(material='Skin')
            if name == 'soldier_prone':
                gmn_, gmx_ = m.bounds(material='Gear')
                # head (helmet is Gear) should be the front-most Gear part: helmet top near +X
                if gmx_[0] < 0.2:
                    fail(name, 'head/helmet not toward +X')
        elif name in ('mortar', 'atgm_tripod'):
            if 'muzzle' not in m.by_name:
                fail(name, 'missing muzzle node')
            else:
                mw = [m.world[m.by_name['muzzle']][k][3] for k in range(3)]
                if mw[0] <= 0:
                    fail(name, 'muzzle not toward +X')
                notes = 'muzzle world (%.2f,%.2f,%.2f)' % tuple(mw)

        rows.append((name, tris, budget, kb, L, W, H, sorted(mats), (vc + ' ' + notes).strip()))

    print('%-14s %6s %6s %7s  %-18s %s' % ('model', 'tris', 'budget', 'KB', 'L x W x H (m)', 'materials / nodes'))
    for name, tris, budget, kb, L, W, H, mats, notes in rows:
        print('%-14s %6d %6d %7.1f  %5.2f x %4.2f x %5.2f  %s %s' % (name, tris, budget, kb, L, W, H, ','.join(mats), notes))
    for w in warnings:
        print('WARN', w)
    for f in failures:
        print('FAIL', f)
    print('%d models checked, %d failures, %d warnings' % (len(rows), len(failures), len(warnings)))
    return 1 if failures else 0


if __name__ == '__main__':
    sys.exit(verify(sys.argv[1] if len(sys.argv) > 1 else DEFAULT_DIR))
