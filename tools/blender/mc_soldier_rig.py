"""Rigged, animated infantry figure (Blender coords: +X forward, +Y left, +Z up).

Pipeline
--------
* Poses are authored as *joint positions* (pelvis, neck, head, ankles, toes, hands, weapon frame);
  knees and elbows are solved with 2-bone IK so limb lengths never change.
* ``solve()`` turns a pose into an armature-space matrix per bone; ``to_basis()`` converts those
  into pose-bone local transforms (basis = rest^-1 * parent_rest * parent_pose^-1 * pose).
* The body mesh is built once at the rest pose from Part primitives; every primitive is rigidly
  bound to one bone (100 % weight), so no weight painting is needed.
* Weapons are separate meshes bound to the ``weapon`` bone; the game shows the one that matches the
  soldier's primary weapon. Each has a ``muzzle_<name>`` empty parented to that bone.
* Clips are functions t -> pose, sampled at FPS and keyframed into one Action each.
* Colours are baked into a vertex-colour attribute (camouflage from 3D noise), one material only,
  exported once per faction.
"""
import math
import random

import bpy
import bmesh
from mathutils import Matrix, Quaternion, Vector

import mc_lib
from mc_lib import Part, ik2

V = Vector
FPS = 20

THIGH, SHIN = 0.44, 0.43
TORSO = 0.51
UPPER, FORE = 0.30, 0.28
HIP_W, SHOULDER_W = 0.10, 0.19

# extra material tags used only for colouring (all merged into one material on export)
for _k, _c in {'Helmet': '#6a6450', 'Boot': '#3a3228', 'Glove': '#3a3830', 'Pouch': '#5a5a44', 'Strap': '#3c3a2e'}.items():
    mc_lib.MAT_COLORS.setdefault(_k, _c)

FACTION_COLORS = {
    # OCP-style: tan / olive / brown blotches
    'nato': {
        'camo': ['#8f8866', '#aca47e', '#666244', '#4e4935'],
        'Gear': '#6f6a4e', 'Pouch': '#747052', 'Helmet': '#7b6f52', 'Boot': '#6e5a40', 'Glove': '#57503d',
        'Strap': '#4f4a38', 'Skin': ['#c8a080', '#a67c5b', '#e0b894', '#7a553b'],
        'Dark': '#2b2b29', 'Metal': '#4a4a48',
    },
    # digital flora: greens with dark speckle
    'opfor': {
        'camo': ['#606b47', '#7a825b', '#3e462e', '#292e21'],
        'Gear': '#4e573b', 'Pouch': '#555e40', 'Helmet': '#4b5538', 'Boot': '#1f1f1d', 'Glove': '#262624',
        'Strap': '#34392a', 'Skin': ['#d2aa88', '#c29a78', '#e2bea0', '#b08566'],
        'Dark': '#252523', 'Metal': '#454543',
    },
}

BONES = [
    # name, parent
    ('root', None),
    ('hips', 'root'),
    ('spine', 'hips'),
    ('chest', 'spine'),
    ('neck', 'chest'),
    ('head', 'neck'),
    ('upperarm_L', 'chest'), ('forearm_L', 'upperarm_L'), ('hand_L', 'forearm_L'),
    ('upperarm_R', 'chest'), ('forearm_R', 'upperarm_R'), ('hand_R', 'forearm_R'),
    ('thigh_L', 'hips'), ('shin_L', 'thigh_L'), ('foot_L', 'shin_L'),
    ('thigh_R', 'hips'), ('shin_R', 'thigh_R'), ('foot_R', 'shin_R'),
    ('weapon', 'root'),
]
PARENT = dict(BONES)


# ======================================================================================
# Pose solving
# ======================================================================================
def _n(v):
    v = V(v)
    return v.normalized() if v.length > 1e-9 else V((0, 0, 1))


def frame(y, zref, fallback=V((1, 0, 0))):
    """Orthonormal (x, y, z) with y exact and z as close as possible to zref."""
    y = _n(y)
    z = V(zref) - y * y.dot(V(zref))
    if z.length < 1e-4:
        z = V(fallback) - y * y.dot(V(fallback))
        if z.length < 1e-4:
            z = mc_lib.basis(y)[0]
    z.normalize()
    x = y.cross(z).normalized()
    return x, y, z


def mat_from(head, x, y, z):
    m = Matrix((
        (x.x, y.x, z.x, head.x),
        (x.y, y.y, z.y, head.y),
        (x.z, y.z, z.z, head.z),
        (0, 0, 0, 1),
    ))
    return m


def reach(root, target, length):
    d = target - root
    if d.length > length * 0.998:
        return root + d.normalized() * length * 0.998
    return target


def solve(p):
    """pose dict -> {bone: (head, tail, zref)} in armature space."""
    pelvis = V(p['pelvis'])
    fwd = V(p.get('fwd', (1, 0, 0)))
    up_t = _n(V(p['neck']) - pelvis)
    neck = pelvis + up_t * TORSO  # rigid torso length
    f = _n(fwd - up_t * up_t.dot(fwd))
    left = _n(up_t.cross(f))
    # lower torso can bend differently from the upper torso
    spine1 = pelvis + up_t * 0.15
    chest = pelvis + up_t * 0.33
    head_c = V(p['head'])
    head_up = _n(p.get('head_up', head_c - neck))
    head_fwd = V(p.get('head_fwd', f))
    head_base = neck + _n(head_c - neck) * 0.06
    out = {}
    out['root'] = (V((0, 0, 0)), V((0, 0, 0.2)), V((1, 0, 0)))
    out['hips'] = (pelvis, spine1, f)
    out['spine'] = (spine1, chest, f)
    out['chest'] = (chest, neck, f)
    out['neck'] = (neck, head_base, head_fwd)
    out['head'] = (head_base, head_base + head_up * 0.22, head_fwd)
    # legs
    for side, k in ((1, 'L'), (-1, 'R')):
        hip = pelvis + left * (side * HIP_W) - up_t * 0.04
        ankle = reach(hip, V(p['ankle' + k]), THIGH + SHIN)
        if 'knee' + k in p:  # explicit knee = pole hint, lengths stay rigid
            pole = V(p['knee' + k]) - (hip + ankle) / 2
        else:
            pole = V(p.get('knee_pole' + k, p.get('knee_pole', f)))
        knee = ik2(hip, ankle, THIGH, SHIN, pole)
        bend = knee - (hip + ankle) / 2
        zref = bend if bend.length > 0.02 else f
        toe = V(p.get('toe' + k, ankle + f * 0.16 - up_t * 0.0 + V((0, 0, -0.06))))
        out['thigh_' + k] = (hip, knee, zref)
        out['shin_' + k] = (knee, ankle, zref)
        out['foot_' + k] = (ankle, toe, V(p.get('footup' + k, (0, 0, 1))))
    # weapon frame
    wpos, wdir, wup = (V(a) for a in p['weapon'])
    wdir = _n(wdir)
    out['weapon'] = (wpos, wpos + wdir * 0.3, wup)
    # arms
    hands = dict(p.get('hands', {}))
    hands.setdefault('R', wpos + wdir * 0.29 - _n(wup) * 0.08)
    hands.setdefault('L', wpos + wdir * 0.56 - _n(wup) * 0.05)
    sh_c = neck - up_t * 0.07 + f * p.get('shoulder_fwd', 0.03)
    for side, k in ((1, 'L'), (-1, 'R')):
        sh = sh_c + left * (side * SHOULDER_W)
        hand = V(hands[k])
        wrist = reach(sh, hand - _n(hand - sh) * 0.07, UPPER + FORE)
        if 'elbow' + k in p:
            pole = V(p['elbow' + k]) - (sh + wrist) / 2
        else:
            pole = V(p.get('elbow_pole' + k, (0, side * 0.6, -1)))
        elbow = ik2(sh, wrist, UPPER, FORE, pole)
        bend = elbow - (sh + wrist) / 2
        zref = bend if bend.length > 0.02 else V(p.get('elbow_pole' + k, (0, 0, -1)))
        out['upperarm_' + k] = (sh, elbow, zref)
        out['forearm_' + k] = (elbow, wrist, zref)
        hand_tip = wrist + _n(hand - wrist) * 0.12
        out['hand_' + k] = (wrist, hand_tip, V(p.get('palm' + k, up_t)))
    return out


def matrices(p):
    return {b: mat_from(h, *frame(t - h, z)) for b, (h, t, z) in solve(p).items()}


# ======================================================================================
# Poses
# ======================================================================================
def lerp(a, b, t):
    return a + (b - a) * t


def ease(t):
    t = max(0.0, min(1.0, t))
    return t * t * (3 - 2 * t)


def with_hands(p):
    if 'hands' in p:
        return p
    q = dict(p)
    wpos, wdir, wup = (V(a) for a in p['weapon'])
    q['hands'] = {'R': wpos + _n(wdir) * 0.29 - _n(wup) * 0.08, 'L': wpos + _n(wdir) * 0.56 - _n(wup) * 0.05}
    return q


def blend(p, q, t):
    """Interpolate two poses (vectors lerped, tuples of vectors lerped element-wise)."""
    p, q = with_hands(p), with_hands(q)
    out = {}
    for k in set(p) | set(q):
        a, b = p.get(k, q.get(k)), q.get(k, p.get(k))
        if isinstance(a, (int, float)):
            out[k] = lerp(a, b, t)
        elif isinstance(a, dict):
            out[k] = {kk: V(a.get(kk, b.get(kk))).lerp(V(b.get(kk, a.get(kk))), t) for kk in set(a) | set(b)}
        elif isinstance(a, tuple) and len(a) == 3 and not isinstance(a[0], (int, float)):
            out[k] = tuple(V(x).lerp(V(y), t) for x, y in zip(a, b))
        else:
            out[k] = V(a).lerp(V(b), t)
    return out


def shift(p, d):
    """Translate the whole pose (all positions) by d."""
    d = V(d)
    q = dict(p)
    for k in ('pelvis', 'neck', 'head', 'ankleL', 'ankleR', 'toeL', 'toeR', 'kneeL', 'kneeR', 'elbowL', 'elbowR'):
        if k in q:
            q[k] = V(q[k]) + d
    if 'weapon' in q:
        w = q['weapon']
        q['weapon'] = (V(w[0]) + d, w[1], w[2])
    if 'hands' in q:
        q['hands'] = {k: V(v) + d for k, v in q['hands'].items()}
    return q


def upper_offset(p, d):
    """Move only the upper body (neck, head, weapon, hands)."""
    d = V(d)
    q = dict(p)
    for k in ('neck', 'head', 'elbowL', 'elbowR'):
        if k in q:
            q[k] = V(q[k]) + d
    w = q['weapon']
    q['weapon'] = (V(w[0]) + d, w[1], w[2])
    if 'hands' in q:
        q['hands'] = {k: V(v) + d for k, v in q['hands'].items()}
    return q


def rotate_upper(p, R, pivot_old, pivot_new):
    """Rigidly rotate the upper body (neck, head, weapon, hands) about the pelvis."""
    q = dict(p)
    tr = lambda v: pivot_new + R @ (V(v) - pivot_old)
    for k in ('neck', 'head', 'elbowL', 'elbowR'):
        if k in q:
            q[k] = tr(q[k])
    for k in ('head_up', 'head_fwd', 'palmL', 'palmR', 'elbow_poleL', 'elbow_poleR'):
        if k in q:
            q[k] = R @ V(q[k])
    w = q['weapon']
    q['weapon'] = (tr(w[0]), R @ V(w[1]), R @ V(w[2]))
    if 'hands' in q:
        q['hands'] = {k: tr(v) for k, v in q['hands'].items()}
    return q


def rot_weapon(p, axis, ang, pivot=None):
    q = dict(p)
    pos, d, u = (V(a) for a in p['weapon'])
    R = Matrix.Rotation(ang, 3, V(axis))
    piv = V(pivot) if pivot is not None else pos
    q['weapon'] = (piv + R @ (pos - piv), R @ d, R @ u)
    return q


STAND_READY = dict(
    pelvis=V((0.0, 0.0, 0.98)), neck=V((0.025, 0.0, 1.49)), fwd=V((1, 0, 0)),
    head=V((0.045, 0.0, 1.635)),
    ankleL=V((0.03, 0.12, 0.09)), toeL=V((0.19, 0.15, 0.03)),
    ankleR=V((-0.05, -0.13, 0.09)), toeR=V((0.1, -0.19, 0.03)),
    weapon=(V((0.12, -0.17, 1.27)), V((0.86, 0.12, -0.46)), V((0.42, 0.0, 0.9))),
    shoulder_fwd=0.04,
    elbow_poleR=V((-0.3, -1, -0.7)), elbow_poleL=V((0, 1, -1)),
    palmR=V((0, 1, 0)), palmL=V((0, 0, 1)),
)

STAND_AIM = dict(
    pelvis=V((-0.02, 0.0, 0.965)), neck=V((0.06, -0.01, 1.475)), fwd=V((1, 0, 0)),
    head=V((0.1, -0.045, 1.6)), head_up=V((0.12, -0.22, 1)),
    ankleL=V((0.2, 0.13, 0.09)), toeL=V((0.35, 0.18, 0.03)),
    ankleR=V((-0.2, -0.15, 0.09)), toeR=V((-0.08, -0.26, 0.03)),
    weapon=(V((0.09, -0.16, 1.42)), V((1, 0.02, 0.0)), V((0, 0, 1))),
    shoulder_fwd=0.04,
    elbow_poleR=V((-0.1, -1, -0.35)), elbow_poleL=V((0, 0.3, -1)),
    palmR=V((0, 1, 0)), palmL=V((0, 0, 1)),
)

KNEEL_AIM = dict(
    pelvis=V((-0.12, 0.0, 0.47)), neck=V((0.02, -0.005, 0.94)), fwd=V((1, 0, 0)),
    head=V((0.085, -0.04, 1.065)), head_up=V((0.3, -0.2, 1)),
    ankleL=V((0.36, 0.16, 0.09)), toeL=V((0.52, 0.18, 0.03)), knee_poleL=V((1, 0, 0.8)),
    kneeR=V((0.08, -0.15, 0.075)), ankleR=V((-0.32, -0.16, 0.2)), toeR=V((-0.3, -0.16, 0.03)), footupR=V((0.95, 0, 0.3)),
    weapon=(V((0.08, -0.15, 0.89)), V((1, 0.05, 0.0)), V((0, 0, 1))),
    shoulder_fwd=0.04,
    elbow_poleR=V((0, -1, -0.5)), elbow_poleL=V((0, 0.2, -1)),
    palmR=V((0, 1, 0)), palmL=V((0, 0, 1)),
)
KNEEL_READY = rot_weapon(upper_offset(KNEEL_AIM, (0, 0, -0.03)), (0, 1, 0), 0.45)
KNEEL_READY['head_up'] = V((0.2, 0, 1))

PRONE_AIM = dict(
    pelvis=V((-0.32, 0.0, 0.13)), neck=V((0.19, 0.0, 0.21)), fwd=V((0, 0, -1)),
    head=V((0.34, -0.03, 0.31)), head_up=V((0.3, -0.1, 0.95)), head_fwd=V((1, 0, 0)),
    kneeL=V((-0.74, 0.2, 0.07)), ankleL=V((-1.15, 0.28, 0.12)), toeL=V((-1.2, 0.36, 0.0)), footupL=V((-1, 0, 0.1)),
    kneeR=V((-0.74, -0.16, 0.07)), ankleR=V((-1.16, -0.24, 0.12)), toeR=V((-1.21, -0.32, 0.0)), footupR=V((-1, 0, 0.1)),
    weapon=(V((0.17, -0.13, 0.25)), V((1, 0.03, 0.02)), V((0, 0, 1))),
    shoulder_fwd=0.0,
    elbowR=V((0.22, -0.38, 0.06)), elbowL=V((0.42, 0.14, 0.06)),
    palmR=V((0, 1, 0)), palmL=V((0, 0, 1)),
)
PRONE_IDLE = rot_weapon(upper_offset(PRONE_AIM, (-0.02, 0, -0.02)), (0, 0, 1), -0.12)
PRONE_IDLE['head_up'] = V((0.5, 0, 0.8))


def lying_back(head_dir=-1.0):
    """Dead on the back; head toward -X (fell backwards) or +X."""
    s = head_dir
    return dict(
        pelvis=V((0.05 * -s, 0.0, 0.12)), neck=V((0.55 * s, 0.05, 0.13)), fwd=V((0, 0, 1)),
        head=V((0.7 * s, 0.1, 0.13)), head_up=V((s, 0.3, 0.05)), head_fwd=V((0, 0.5, 0.85)),
        kneeL=V((-0.38 * s, 0.22, 0.28)), ankleL=V((-0.78 * s, 0.26, 0.1)), toeL=V((-0.8 * s, 0.3, 0.26)), footupL=V((-s, 0, 0)),
        kneeR=V((-0.45 * s, -0.18, 0.08)), ankleR=V((-0.88 * s, -0.22, 0.08)), toeR=V((-0.92 * s, -0.3, 0.24)), footupR=V((-s, 0, 0)),
        hands={'L': V((0.55 * s, 0.62, 0.05)), 'R': V((0.1 * s, -0.55, 0.05))},
        elbowL=V((0.38 * s, 0.4, 0.06)), elbowR=V((0.3 * s, -0.36, 0.06)),
        palmL=V((0, 0, 1)), palmR=V((0, 0, 1)),
        weapon=(V((-0.2 * s, -0.75, 0.03)), V((0.95 * s, -0.3, 0.0)), V((0, 0, 1))),
    )


def lying_front():
    return dict(
        pelvis=V((0.35, 0.02, 0.14)), neck=V((0.88, 0.05, 0.16)), fwd=V((0, 0, -1)),
        head=V((1.03, 0.1, 0.18)), head_up=V((1, 0.3, 0.1)), head_fwd=V((0, 0.4, -0.9)),
        kneeL=V((-0.08, 0.2, 0.08)), ankleL=V((-0.48, 0.28, 0.12)), toeL=V((-0.52, 0.34, 0.0)), footupL=V((-1, 0, 0.1)),
        kneeR=V((-0.06, -0.12, 0.08)), ankleR=V((-0.46, -0.2, 0.2)), toeR=V((-0.5, -0.28, 0.06)), footupR=V((-1, 0, 0.2)),
        hands={'L': V((1.2, 0.5, 0.05)), 'R': V((0.55, -0.45, 0.05))},
        elbowL=V((0.95, 0.42, 0.06)), elbowR=V((0.72, -0.35, 0.06)),
        palmL=V((0, 0, -1)), palmR=V((0, 0, -1)),
        weapon=(V((1.1, -0.25, 0.03)), V((0.9, 0.4, 0.0)), V((0, 0, 1))),
    )


def lying_side():
    return dict(
        pelvis=V((0.0, 0.1, 0.18)), neck=V((0.35, 0.48, 0.2)), fwd=V((0.7, -0.7, 0)),
        head=V((0.45, 0.6, 0.18)), head_up=V((0.6, 0.7, -0.3)), head_fwd=V((0.6, -0.6, -0.2)),
        kneeL=V((0.3, -0.18, 0.2)), ankleL=V((-0.05, -0.45, 0.1)), toeL=V((0.05, -0.55, 0.08)),
        kneeR=V((0.35, -0.12, 0.08)), ankleR=V((0.0, -0.4, 0.07)), toeR=V((0.1, -0.5, 0.05)),
        hands={'L': V((0.55, 0.2, 0.05)), 'R': V((0.3, 0.12, 0.3))},
        palmL=V((0, 0, 1)), palmR=V((0.5, -0.5, 0)),
        elbow_poleL=V((0, 0, -1)), elbow_poleR=V((0.5, -0.5, 0.5)),
        weapon=(V((0.6, -0.35, 0.03)), V((0.4, 0.9, 0.0)), V((0, 0, 1))),
    )


# ======================================================================================
# Clips  (each returns (duration_seconds, loop, fn(t)->pose))
# ======================================================================================
def gait(t, T, step, lift, stance_frac, pelvis_z, bob, lean, base_upper, foot_y=(0.12, -0.13)):
    """Generic in-place locomotion cycle. step = distance a foot travels back during stance."""
    ph = (t % T) / T
    p = dict(base_upper)
    fwd = V((1, 0, 0))
    # torso lean: rotate the pelvis->neck vector forward about +Y
    R = Matrix.Rotation(lean, 3, V((0, 1, 0)))
    pelvis = V((0.0, 0.0, pelvis_z + bob * math.cos(4 * math.pi * ph)))
    pelvis.y = 0.018 * math.sin(2 * math.pi * ph)
    p = rotate_upper(with_hands(base_upper), R, V(base_upper['pelvis']), pelvis)
    p['pelvis'] = pelvis
    for k, off in (('L', 0.0), ('R', 0.5)):
        q = (ph + off) % 1.0
        y = foot_y[0] if k == 'L' else foot_y[1]
        if q < stance_frac:
            u = q / stance_frac
            x = step / 2 - step * u
            z = 0.09
            toe_pitch = 0.0
        else:
            u = (q - stance_frac) / (1 - stance_frac)
            x = -step / 2 + step * ease(u)
            z = 0.09 + lift * math.sin(math.pi * u)
            toe_pitch = 0.35 * math.sin(math.pi * u)
        ankle = V((x + 0.02, y, z))
        p['ankle' + k] = ankle
        p['toe' + k] = ankle + V((0.16 * math.cos(toe_pitch), y * 0.15, -0.06 + 0.16 * math.sin(toe_pitch)))
        p['knee_pole' + k] = fwd
        p.pop('knee' + k, None)
        p.pop('footup' + k, None)
    return p


def clip_walk():
    T = 1.0
    return T, True, lambda t: gait(t, T, 0.8, 0.12, 0.55, 0.955, 0.012, 0.05, STAND_READY)


RUN_UPPER = dict(STAND_READY)
RUN_UPPER['weapon'] = (V((0.2, -0.16, 1.06)), V((0.45, 0.45, 0.77)), V((0.6, -0.6, -0.1)))
RUN_UPPER['hands'] = {'R': V((0.24, -0.1, 1.1)), 'L': V((0.34, 0.08, 1.33))}
RUN_UPPER['elbow_poleR'] = V((-0.4, -1, -0.5))
RUN_UPPER['elbow_poleL'] = V((-0.2, 1, -0.6))


def clip_run():
    T = 0.66
    return T, True, lambda t: gait(t, T, 1.2, 0.24, 0.4, 0.93, 0.03, 0.22, RUN_UPPER)


SNEAK_UPPER = rot_weapon(STAND_READY, (0, 1, 0), -0.25)


def clip_sneak():
    T = 1.2
    return T, True, lambda t: gait(t, T, 0.42, 0.09, 0.6, 0.72, 0.01, 0.38, SNEAK_UPPER)


def breathing(base, T=4.0, look=0.25, amp=0.006):
    def f(t):
        ph = 2 * math.pi * t / T
        p = upper_offset(base, (0, 0, amp * math.sin(ph)))
        yaw = look * math.sin(2 * math.pi * t / (T * 2))
        hf = V(base.get('head_fwd', base.get('fwd', (1, 0, 0))))
        p['head_fwd'] = Matrix.Rotation(yaw, 3, 'Z') @ hf
        return p
    return f


def clip_idle(base, T=4.0, look=0.3):
    return T * 2, True, breathing(base, T, look)


def clip_aim(base):
    return 2.0, True, breathing(base, 2.0, 0.0, 0.003)


def clip_reload(base):
    """Tilt the weapon, left hand to the magazine well, to a chest pouch, back, then to the handguard."""
    pos, d, u = (V(a) for a in base['weapon'])
    d = _n(d)
    u = _n(u)
    well = pos + d * 0.42 - u * 0.12
    fore = pos + d * 0.56 - u * 0.05
    up_t = _n(V(base['neck']) - V(base['pelvis']))
    front = _n(V(base.get('fwd', (1, 0, 0))) - up_t * up_t.dot(V(base.get('fwd', (1, 0, 0)))))
    pouch = V(base['pelvis']) + up_t * 0.3 + front * 0.2 + V((0, 0.06, 0))
    keys = [(0.0, fore, 0.0), (0.3, well, -0.5), (0.7, pouch, -0.5), (1.2, well, -0.5), (1.5, well, -0.4), (1.8, fore, 0.0), (2.0, fore, 0.0)]

    def f(t):
        for i in range(len(keys) - 1):
            t0, a, ra = keys[i]
            t1, b, rb = keys[i + 1]
            if t <= t1:
                k = ease((t - t0) / (t1 - t0))
                p = rot_weapon(base, d, lerp(ra, rb, k))
                p['hands'] = {'L': a.lerp(b, k)}
                p['elbow_poleL'] = V((0, 0.3, -1))
                return p
        return base
    return 2.0, False, f


def clip_throw():
    base = dict(STAND_AIM)
    # rifle held low in the left hand
    base['weapon'] = (V((0.05, 0.1, 1.0)), V((0.6, 0.1, -0.8)), V((0.8, 0, 0.6)))
    base['hands'] = {'L': V((0.25, 0.2, 0.83)), 'R': V((0.1, -0.25, 1.2))}
    keys = [(0.0, V((0.15, -0.3, 1.25))), (0.35, V((-0.35, -0.3, 1.65))), (0.6, V((0.35, -0.12, 1.85))), (0.85, V((0.45, 0.05, 1.1))), (1.1, V((0.15, -0.3, 1.2)))]

    def f(t):
        for i in range(len(keys) - 1):
            t0, a = keys[i]
            t1, b = keys[i + 1]
            if t <= t1:
                k = ease((t - t0) / (t1 - t0))
                p = dict(base)
                p['hands'] = {'L': base['hands']['L'], 'R': a.lerp(b, k)}
                p['elbow_poleR'] = V((-0.5, -1, 0.2))
                lean = -0.1 if t < 0.4 else 0.15
                return upper_offset(p, (lean * 0.3, 0, 0))
        return base
    return 1.1, False, f


def keyed(keys, loop=False):
    """keys: [(time, pose)] -> clip interpolating poses with easing."""
    T = keys[-1][0]

    def f(t):
        for i in range(len(keys) - 1):
            t0, a = keys[i]
            t1, b = keys[i + 1]
            if t <= t1:
                return blend(a, b, ease((t - t0) / max(1e-6, t1 - t0)))
        return keys[-1][1]
    return T, loop, f


def clip_death_back():
    mid1 = upper_offset(with_hands(STAND_READY), (-0.12, 0, -0.1))
    mid1['pelvis'] = V((-0.05, 0, 0.78))
    mid1 = rot_weapon(mid1, (0, 1, 0), -0.9)
    mid2 = blend(STAND_READY, lying_back(-1), 0.55)
    mid2['pelvis'] = V((-0.25, 0, 0.35))
    return keyed([(0.0, STAND_READY), (0.25, mid1), (0.6, mid2), (1.0, lying_back(-1))])


def clip_death_fwd():
    end = lying_front()
    mid1 = dict(STAND_READY)
    mid1 = upper_offset(mid1, (0.15, 0, -0.12))
    mid1['pelvis'] = V((0.05, 0, 0.8))
    mid2 = blend(STAND_READY, end, 0.5)
    mid2['pelvis'] = V((0.2, 0, 0.45))
    return keyed([(0.0, STAND_READY), (0.2, mid1), (0.55, mid2), (0.9, end)])


def clip_death_crumple():
    end = lying_side()
    kneel = dict(KNEEL_READY)
    kneel = upper_offset(kneel, (0.05, 0.05, -0.15))
    kneel['kneeL'] = V((0.1, 0.15, 0.07))
    kneel['ankleL'] = V((-0.3, 0.16, 0.12))
    kneel.pop('knee_poleL', None)
    return keyed([(0.0, STAND_READY), (0.45, kneel), (1.1, end)])


def clip_death_prone():
    end = dict(PRONE_IDLE)
    end = upper_offset(end, (0, 0, -0.05))
    end['head_up'] = V((0.6, 0.3, 0.0))
    end['head'] = V(end['head']) + V((0, 0.04, -0.1))
    end['weapon'] = (V((0.3, -0.35, 0.03)), V((0.95, -0.2, 0.0)), V((0, 0, 1)))
    end['hands'] = {'L': V((0.55, 0.25, 0.04)), 'R': V((0.2, -0.4, 0.04))}
    end.pop('elbowR', None)
    end.pop('elbowL', None)
    return keyed([(0.0, PRONE_AIM), (0.5, end)])


def clip_wounded():
    base = lying_back(-1)
    base['kneeL'] = V((0.05, 0.2, 0.45))
    base['ankleL'] = V((0.35, 0.22, 0.09))
    base['toeL'] = V((0.5, 0.25, 0.04))
    base['footupL'] = V((0, 0, 1))
    base['hands'] = {'L': V((-0.15, 0.05, 0.3)), 'R': V((-0.05, -0.1, 0.3))}
    base.pop('elbowL', None)
    base.pop('elbowR', None)
    base['elbow_poleL'] = V((0, 1, 0))
    base['elbow_poleR'] = V((0, -1, 0))

    def f(t):
        s = math.sin(2 * math.pi * t / 3.0)
        p = dict(base)
        p['kneeL'] = V(base['kneeL']) + V((0.04 * s, 0.03 * s, 0))
        p['head'] = V(base['head']) + V((0, 0.03 * s, 0.02 * abs(s)))
        return p
    return 3.0, True, f


def clip_cower():
    base = dict(KNEEL_READY)
    base = upper_offset(base, (0.12, 0, -0.18))
    base['neck'] = V((0.12, 0, 0.72))
    base['head'] = V((0.25, 0, 0.72))
    base['head_up'] = V((1, 0, -0.3))
    base['hands'] = {'L': V((0.28, 0.1, 0.84)), 'R': V((0.28, -0.1, 0.84))}
    base['weapon'] = (V((0.25, -0.35, 0.03)), V((0.95, 0.25, 0.0)), V((0, 0, 1)))
    base['elbow_poleL'] = V((0.3, 1, 0))
    base['elbow_poleR'] = V((0.3, -1, 0))

    def f(t):
        tr = 0.006 * math.sin(2 * math.pi * t * 7)
        return upper_offset(base, (0, tr, 0))
    return 2.0, True, f


def clip_surrender():
    base = dict(STAND_READY)
    base['hands'] = {'L': V((0.1, 0.28, 1.9)), 'R': V((0.1, -0.28, 1.9))}
    base['palmL'] = V((1, 0, 0))
    base['palmR'] = V((1, 0, 0))
    base['elbow_poleL'] = V((0, 1, 0))
    base['elbow_poleR'] = V((0, -1, 0))
    base['weapon'] = (V((0.45, -0.15, 0.03)), V((0.95, 0.3, 0.0)), V((0, 0, 1)))

    def f(t):
        return upper_offset(base, (0, 0.01 * math.sin(2 * math.pi * t / 3), 0))
    return 3.0, True, f


def clips():
    return {
        'idle_stand': clip_idle(STAND_READY),
        'idle_kneel': clip_idle(KNEEL_READY, 4.0, 0.35),
        'idle_prone': clip_idle(PRONE_IDLE, 4.0, 0.2),
        'aim_stand': clip_aim(STAND_AIM),
        'aim_kneel': clip_aim(KNEEL_AIM),
        'aim_prone': clip_aim(PRONE_AIM),
        'walk': clip_walk(),
        'run': clip_run(),
        'sneak': clip_sneak(),
        'reload_stand': clip_reload(STAND_AIM),
        'reload_kneel': clip_reload(KNEEL_AIM),
        'reload_prone': clip_reload(PRONE_AIM),
        'throw': clip_throw(),
        'death_back': clip_death_back(),
        'death_fwd': clip_death_fwd(),
        'death_crumple': clip_death_crumple(),
        'death_prone': clip_death_prone(),
        'wounded': clip_wounded(),
        'cower': clip_cower(),
        'surrender': clip_surrender(),
    }


# ======================================================================================
# Mesh (built at the rest pose, one bone per primitive)
# ======================================================================================
class Builder:
    def __init__(self):
        self.P = Part()
        self.bone_of = []  # per vertex

    def put(self, bone, fn, *a, **k):
        n0 = len(self.P.bm.verts)
        fn(*a, **k)
        n1 = len(self.P.bm.verts)
        self.bone_of.extend([bone] * (n1 - n0))


def build_body(rest):
    S = solve(rest)
    B = Builder()
    P = B.P
    pelvis, neck = V(rest['pelvis']), V(rest['neck'])
    up_t = _n(neck - pelvis)
    f = _n(V(rest['fwd']) - up_t * up_t.dot(V(rest['fwd'])))
    left = _n(up_t.cross(f))
    # ---- legs ----
    for k in ('L', 'R'):
        hip, knee, _ = S['thigh_' + k]
        _, ankle, _ = S['shin_' + k]
        _, toe, fup = S['foot_' + k]
        B.put('thigh_' + k, P.cyl, hip + up_t * 0.03, knee, 0.088, 0.066, mat='Uniform', segs=10)
        B.put('thigh_' + k, P.obox, (hip + knee) / 2 + left * (0.07 if k == 'L' else -0.07), f, left, up_t, (0.05, 0.025, 0.07), 'Pouch')  # cargo pocket
        B.put('shin_' + k, P.ico, knee, 0.066, 'Uniform', subdiv=1)
        B.put('shin_' + k, P.obox, knee + f * 0.055 - up_t * 0.02, f, left, up_t, (0.025, 0.055, 0.075), 'Gear')  # knee pad
        B.put('shin_' + k, P.cyl, knee, ankle + V((0, 0, 0.03)), 0.064, 0.05, mat='Uniform', segs=10)
        fd = _n(toe - ankle)
        side = _n(fd.cross(V(fup)))
        fu = _n(side.cross(fd))
        B.put('foot_' + k, P.cyl, ankle + fu * 0.05, ankle - fu * 0.04, 0.056, 0.058, mat='Boot', segs=8)
        B.put('foot_' + k, P.obox, ankle + fd * 0.07 - fu * 0.045, fd, side, fu, (0.135, 0.052, 0.045), 'Boot')
        B.put('foot_' + k, P.obox, ankle + fd * 0.07 - fu * 0.086, fd, side, fu, (0.14, 0.056, 0.012), 'Dark')  # sole
    # ---- pelvis & torso ----
    hips_h, spine1, _ = S['hips']
    _, chest, _ = S['spine']
    B.put('hips', P.obox, pelvis - up_t * 0.02, f, left, up_t, (0.11, 0.165, 0.1), 'Uniform')
    B.put('hips', P.obox, pelvis + up_t * 0.07, f, left, up_t, (0.12, 0.175, 0.03), 'Strap')  # belt
    B.put('hips', P.obox, pelvis + up_t * 0.03 - f * 0.12 + left * 0.08, f, left, up_t, (0.05, 0.06, 0.06), 'Pouch')  # dump pouch
    B.put('hips', P.obox, pelvis + up_t * 0.04 + left * -0.17, f, left, up_t, (0.05, 0.03, 0.06), 'Pouch')  # IFAK
    B.put('spine', P.tbox, spine1 - up_t * 0.03, chest + up_t * 0.02, (0.31, 0.21), (0.36, 0.23), 'Uniform', fwd=f)
    B.put('chest', P.tbox, chest - up_t * 0.02, neck - up_t * 0.03, (0.37, 0.24), (0.42, 0.22), 'Uniform', fwd=f)
    # plate carrier: front & back plates, cummerbund
    B.put('chest', P.obox, chest + up_t * 0.06 + f * 0.125, f, left, up_t, (0.03, 0.155, 0.15), 'Gear')
    B.put('chest', P.obox, chest + up_t * 0.07 - f * 0.125, f, left, up_t, (0.03, 0.155, 0.16), 'Gear')
    B.put('spine', P.tbox, spine1 + up_t * 0.08, chest + up_t * 0.02, (0.39, 0.25), (0.4, 0.26), 'Gear', fwd=f)
    for i in (-1, 0, 1):
        B.put('chest', P.obox, chest - up_t * 0.02 + f * 0.165 + left * (0.075 * i), f, left, up_t, (0.025, 0.033, 0.06), 'Pouch')  # mag pouches
    B.put('chest', P.obox, chest + up_t * 0.1 + f * 0.165, f, left, up_t, (0.02, 0.09, 0.04), 'Pouch')  # admin pouch
    B.put('chest', P.obox, chest + up_t * 0.05 - f * 0.2 + left * -0.1, f, left, up_t, (0.035, 0.04, 0.09), 'Pouch')  # radio
    B.put('chest', P.cyl, chest + up_t * 0.12 - f * 0.2 + left * -0.1, chest + up_t * 0.35 - f * 0.22 + left * -0.1, 0.006, mat='Dark', segs=4)  # antenna
    B.put('chest', P.obox, chest + up_t * 0.02 - f * 0.23 + left * 0.06, f, left, up_t, (0.06, 0.1, 0.13), 'Gear')  # assault pack
    for s in (1, -1):
        B.put('chest', P.obox, neck - up_t * 0.06 + left * (0.11 * s), f, left, up_t, (0.14, 0.035, 0.02), 'Strap')  # shoulder straps
    # ---- neck & head ----
    nb, hb, hfz = S['neck']
    head_base, head_tip, hf = S['head']
    hu = _n(head_tip - head_base)
    hf = _n(V(hf) - hu * hu.dot(V(hf)))
    hs = _n(hu.cross(hf))
    head_c = V(rest['head'])
    B.put('neck', P.cyl, neck - up_t * 0.05, head_base + hu * 0.02, 0.052, 0.048, mat='Skin', segs=8)
    B.put('head', P.ico, head_c, 1.0, 'Skin', subdiv=2, scale=(0.105, 0.085, 0.11))
    B.put('head', P.obox, head_c + hf * 0.1 - hu * 0.035, hf, hs, hu, (0.015, 0.02, 0.012), 'Skin')  # nose
    B.put('head', P.dome, head_c + hu * 0.012 - hf * 0.012, 0.132, 'Helmet', up=hu, fwd=hf, segs=14, rings=5, scale=(1.08, 1.0, 0.92), base=-8.0)
    B.put('head', P.obox, head_c + hf * 0.13 + hu * 0.07, hf, hs, hu, (0.015, 0.03, 0.02), 'Dark')  # NVG mount shroud
    for s in (1, -1):
        B.put('head', P.cyl, head_c + hs * (0.105 * s) - hu * 0.01, head_c + hs * (0.14 * s) - hu * 0.01, 0.042, mat='Dark', segs=8)  # headset cups
        B.put('head', P.obox, head_c + hs * (0.13 * s) + hu * 0.04, hf, hs, hu, (0.06, 0.008, 0.012), 'Dark')  # helmet rail
    # ---- arms ----
    for k in ('L', 'R'):
        sh, elbow, _ = S['upperarm_' + k]
        _, wrist, _ = S['forearm_' + k]
        _, tip, palm = S['hand_' + k]
        B.put('upperarm_' + k, P.ico, sh, 0.07, 'Uniform', subdiv=1)
        B.put('upperarm_' + k, P.cyl, sh, elbow, 0.064, 0.052, mat='Uniform', segs=9)
        B.put('upperarm_' + k, P.obox, (sh * 0.6 + elbow * 0.4), f, left, up_t, (0.045, 0.05, 0.045), 'Pouch')  # shoulder pocket
        B.put('forearm_' + k, P.ico, elbow, 0.054, 'Uniform', subdiv=1)
        B.put('forearm_' + k, P.cyl, elbow, wrist, 0.05, 0.04, mat='Uniform', segs=9)
        hd = _n(tip - wrist)
        B.put('hand_' + k, P.tbox, wrist - hd * 0.01, wrist + hd * 0.1, (0.055, 0.085), (0.045, 0.075), 'Glove', fwd=V(palm))
        B.put('hand_' + k, P.cyl, wrist + hd * 0.02, wrist + hd * 0.06 + _n(V(palm)).cross(hd) * 0.04, 0.016, mat='Glove', segs=5)  # thumb
    return B


def _bevel_apply(obj, width=0.008, segments=1):
    mod = obj.modifiers.new('Bevel', 'BEVEL')
    mod.width = width
    mod.segments = segments
    mod.limit_method = 'ANGLE'
    mod.angle_limit = math.radians(40)
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.modifier_apply(modifier=mod.name)


def build_skin_body(rest, arm):
    """Continuous, smooth body (trousers, shirt, neck) from a Skin modifier over the rest-pose joints,
    bound with automatic (heat) weights."""
    S = solve(rest)
    pelvis = S['hips'][0]
    up_t = _n(S['chest'][1] - pelvis)
    verts, edges, radii = [], [], []

    def add(p, r):
        verts.append(V(p))
        radii.append(r)
        return len(verts) - 1
    iP = add(pelvis - up_t * 0.02, (0.15, 0.11))
    iS = add(S['spine'][0], (0.14, 0.1))
    iC = add(S['chest'][0] + up_t * 0.02, (0.16, 0.11))
    iU = add(S['chest'][1] - up_t * 0.07, (0.14, 0.1))
    iN = add(S['neck'][0] + up_t * 0.02, (0.055, 0.055))
    iH = add(S['head'][0] + up_t * 0.02, (0.05, 0.05))
    edges += [(iP, iS), (iS, iC), (iC, iU), (iU, iN), (iN, iH)]
    for k in ('L', 'R'):
        hip, knee, _ = S['thigh_' + k]
        _, ankle, _ = S['shin_' + k]
        iHip = add(hip + up_t * 0.02, (0.09, 0.09))
        iK = add(knee, (0.066, 0.066))
        iA = add(ankle + V((0, 0, 0.04)), (0.052, 0.052))
        edges += [(iP, iHip), (iHip, iK), (iK, iA)]
        sh, elbow, _ = S['upperarm_' + k]
        _, wrist, _ = S['forearm_' + k]
        iSh = add(sh, (0.066, 0.066))
        iE = add(elbow, (0.053, 0.053))
        iW = add(wrist, (0.04, 0.04))
        edges += [(iU, iSh), (iSh, iE), (iE, iW)]
    me = bpy.data.meshes.new('skinbody')
    me.from_pydata([tuple(v) for v in verts], edges, [])
    obj = bpy.data.objects.new('skinbody', me)
    bpy.context.scene.collection.objects.link(obj)
    skin = obj.modifiers.new('Skin', 'SKIN')
    skin.use_smooth_shade = True
    skin.branch_smoothing = 0.6
    sv = me.skin_vertices[0].data
    for i, r in enumerate(radii):
        sv[i].radius = r
    sv[iP].use_root = True
    sub = obj.modifiers.new('Sub', 'SUBSURF')
    sub.levels = 1
    sub.render_levels = 1
    bpy.context.view_layer.objects.active = obj
    for o in bpy.context.selected_objects:
        o.select_set(False)
    obj.select_set(True)
    bpy.ops.object.modifier_apply(modifier='Skin')
    bpy.ops.object.modifier_apply(modifier='Sub')
    for poly in obj.data.polygons:
        poly.use_smooth = True
    # automatic weights against deforming body bones only (weapon/root excluded)
    wb = arm.data.bones['weapon']
    wb.use_deform = False
    for o in bpy.context.selected_objects:
        o.select_set(False)
    obj.select_set(True)
    arm.select_set(True)
    bpy.context.view_layer.objects.active = arm
    bpy.ops.object.parent_set(type='ARMATURE_AUTO')
    wb.use_deform = True
    return obj


def build_gear(rest):
    """Rigid, bevelled gear pieces bound to single bones."""
    S = solve(rest)
    B = Builder()
    P = B.P
    pelvis = V(rest['pelvis'])
    up_t = _n(S['chest'][1] - pelvis)
    f = _n(V(rest['fwd']) - up_t * up_t.dot(V(rest['fwd'])))
    left = _n(up_t.cross(f))
    neck = S['chest'][1]
    chest = S['spine'][1]
    spine1 = S['spine'][0]
    for k in ('L', 'R'):
        hip, knee, _ = S['thigh_' + k]
        _, ankle, _ = S['shin_' + k]
        _, toe, fup = S['foot_' + k]
        sgn = 1 if k == 'L' else -1
        B.put('thigh_' + k, P.obox, (hip * 0.45 + knee * 0.55) + left * (0.062 * sgn) + f * 0.01, f, left, up_t, (0.04, 0.014, 0.055), 'Pouch')
        B.put('shin_' + k, P.obox, knee + f * 0.052 - up_t * 0.01, f, left, up_t, (0.016, 0.045, 0.058), 'Gear')
        fd = _n(toe - ankle)
        side = _n(fd.cross(V(fup)))
        fu = _n(side.cross(fd))
        B.put('foot_' + k, P.cyl, ankle + fu * 0.07, ankle - fu * 0.03, 0.058, 0.062, mat='Boot', segs=12)
        B.put('foot_' + k, P.obox, ankle + fd * 0.065 - fu * 0.045, fd, side, fu, (0.13, 0.055, 0.045), 'Boot')
        B.put('foot_' + k, P.obox, ankle + fd * 0.068 - fu * 0.088, fd, side, fu, (0.138, 0.058, 0.012), 'Dark')
        # gloves
        wrist, tip, palm = S['hand_' + k]
        hd = _n(tip - wrist)
        B.put('hand_' + k, P.tbox, wrist - hd * 0.02, wrist + hd * 0.1, (0.058, 0.085), (0.048, 0.075), 'Glove', fwd=V(palm))
        B.put('hand_' + k, P.cyl, wrist + hd * 0.02, wrist + hd * 0.06 + _n(V(palm)).cross(hd) * 0.045, 0.017, mat='Glove', segs=6)
        # shoulder pocket / flag patch
        sh, elbow, _ = S['upperarm_' + k]
        B.put('upperarm_' + k, P.obox, sh * 0.55 + elbow * 0.45 + left * (0.045 * sgn), f, left, up_t, (0.04, 0.012, 0.045), 'Pouch')
    # belt & pouches
    B.put('hips', P.obox, pelvis + up_t * 0.06, f, left, up_t, (0.125, 0.165, 0.03), 'Strap')
    B.put('hips', P.obox, pelvis + up_t * 0.02 - f * 0.12 + left * 0.08, f, left, up_t, (0.045, 0.06, 0.06), 'Pouch')
    B.put('hips', P.obox, pelvis + up_t * 0.03 - left * 0.165, f, left, up_t, (0.05, 0.03, 0.06), 'Pouch')
    # plate carrier
    B.put('chest', P.obox, chest + up_t * 0.07 + f * 0.105, f, left, up_t, (0.035, 0.15, 0.15), 'Gear')
    B.put('chest', P.obox, chest + up_t * 0.08 - f * 0.105, f, left, up_t, (0.035, 0.15, 0.16), 'Gear')
    B.put('spine', P.tbox, spine1 + up_t * 0.08, chest + up_t * 0.02, (0.35, 0.24), (0.36, 0.25), 'Gear', fwd=f)
    for i in (-1, 0, 1):
        B.put('chest', P.obox, chest - up_t * 0.02 + f * 0.155 + left * (0.072 * i), f, left, up_t, (0.025, 0.031, 0.06), 'Pouch')
    B.put('chest', P.obox, chest + up_t * 0.11 + f * 0.15, f, left, up_t, (0.02, 0.085, 0.04), 'Pouch')
    B.put('chest', P.obox, chest + up_t * 0.05 - f * 0.175 - left * 0.1, f, left, up_t, (0.035, 0.04, 0.09), 'Pouch')
    B.put('chest', P.cyl, chest + up_t * 0.12 - f * 0.18 - left * 0.1, chest + up_t * 0.38 - f * 0.2 - left * 0.1, 0.006, mat='Dark', segs=4)
    B.put('chest', P.obox, chest + up_t * 0.03 - f * 0.205 + left * 0.06, f, left, up_t, (0.06, 0.1, 0.13), 'Gear')
    for sgn in (1, -1):
        B.put('chest', P.obox, neck - up_t * 0.05 + left * (0.11 * sgn), f, left, up_t, (0.12, 0.035, 0.02), 'Strap')
    # head, helmet, headset
    head_base, head_tip, hf = S['head']
    hu = _n(head_tip - head_base)
    hf = _n(V(hf) - hu * hu.dot(V(hf)))
    hs = _n(hu.cross(hf))
    hc = V(rest['head'])
    B.put('head', P.ico, hc, 1.0, 'Skin', subdiv=2, scale=(0.1, 0.082, 0.108))
    B.put('head', P.obox, hc + hf * 0.095 - hu * 0.03, hf, hs, hu, (0.014, 0.018, 0.012), 'Skin')
    B.put('head', P.dome, hc + hu * 0.015 - hf * 0.012, 0.13, 'Helmet', up=hu, fwd=hf, segs=16, rings=6, scale=(1.08, 1.0, 0.92), base=-6.0)
    B.put('head', P.obox, hc + hf * 0.128 + hu * 0.075, hf, hs, hu, (0.014, 0.028, 0.02), 'Dark')
    for sgn in (1, -1):
        B.put('head', P.cyl, hc + hs * (0.1 * sgn) - hu * 0.012, hc + hs * (0.138 * sgn) - hu * 0.012, 0.042, mat='Dark', segs=10)
        B.put('head', P.obox, hc + hs * (0.128 * sgn) + hu * 0.042, hf, hs, hu, (0.06, 0.008, 0.011), 'Dark')
    return B


def build_slung(rest, side):
    """A disposable launcher (AT4 / RPG-26) slung diagonally across the back, bound to the chest.
    The game shows it for soldiers carrying a launcher they are not currently firing."""
    S = solve(rest)
    B = Builder()
    P = B.P
    pelvis = V(rest['pelvis'])
    up_t = _n(S['chest'][1] - pelvis)
    f = _n(V(rest['fwd']) - up_t * up_t.dot(V(rest['fwd'])))
    left = _n(up_t.cross(f))
    chest = S['spine'][1]
    a = chest - f * 0.3 - up_t * 0.24 + left * 0.19
    b = chest - f * 0.3 + up_t * 0.4 - left * 0.15
    d = _n(b - a)
    tube = 'Gear' if side == 'nato' else 'Pouch'
    B.put('chest', P.cyl, a, b, 0.042, mat=tube, segs=12)
    for t, r in ((0.0, 0.05), (0.97, 0.05), (0.35, 0.046), (0.7, 0.046)):
        c = a + (b - a) * t
        B.put('chest', P.cyl, c - d * 0.018, c + d * 0.018, r, mat='Dark', segs=12)
    # sling running over the right shoulder to the front
    sh = S['upperarm_R'][0]
    B.put('chest', P.tube, [b - f * 0.0 + left * 0.02, sh + up_t * 0.06 - f * 0.02, sh + up_t * 0.02 + f * 0.12, chest + f * 0.17 - left * 0.02],
          [0.012, 0.012, 0.012, 0.012], mat='Strap', segs=4)
    return B


# ---------------------------------------------------------------------------- weapons
def weapon_parts(side):
    """Weapon meshes in the weapon bone's local frame: +Y along the barrel, +Z up, origin at the
    shoulder contact point. Returns {name: (Builder-like Part, muzzle_local)}"""
    out = {}

    def W():
        return Part()
    # frame helpers in local coords: y along barrel, z up, x = y cross z (right)
    Y, Z, X = V((0, 1, 0)), V((0, 0, 1)), V((1, 0, 0))

    def ob(P, c, hs, mat):
        P.obox(V(c), Y, X, Z, (hs[1], hs[0], hs[2]), mat)

    # --- assault rifle (M7 / AK-12)
    P = W()
    ob(P, (0, 0.11, -0.015), (0.02, 0.11, 0.045), 'Dark')          # stock
    ob(P, (0, 0.34, 0.0), (0.028, 0.13, 0.045), 'Metal')           # receiver
    ob(P, (0, 0.33, 0.07), (0.018, 0.06, 0.028), 'Dark')           # optic
    if side == 'opfor':
        P.tube([V((0, 0.4, -0.04)), V((0, 0.44, -0.12)), V((0, 0.5, -0.19))], [0.025, 0.025, 0.024], mat='Dark', segs=6)  # curved mag
    else:
        P.tbox(V((0, 0.4, -0.04)), V((0, 0.42, -0.17)), (0.05, 0.028), (0.05, 0.026), 'Dark', fwd=Y)
    P.tbox(V((0, 0.27, -0.04)), V((0, 0.25, -0.13)), (0.03, 0.045), (0.03, 0.04), 'Dark', fwd=Y)  # grip
    ob(P, (0, 0.6, 0.0), (0.03, 0.12, 0.034), 'Dark')              # handguard
    P.cyl(V((0, 0.72, 0.005)), V((0, 0.9, 0.005)), 0.012, mat='Dark', segs=6)   # barrel
    if side == 'nato':
        P.cyl(V((0, 0.84, 0.005)), V((0, 0.99, 0.005)), 0.02, mat='Dark', segs=8)  # suppressor
    out['rifle'] = (P, V((0, 0.99 if side == 'nato' else 0.9, 0.005)))
    # --- machine gun (M240 / PKP) and automatic rifle
    P = W()
    ob(P, (0, 0.1, -0.02), (0.022, 0.1, 0.05), 'Dark')
    ob(P, (0, 0.36, 0.0), (0.035, 0.16, 0.055), 'Metal')
    ob(P, (0, 0.34, 0.075), (0.02, 0.07, 0.022), 'Dark')
    ob(P, (0.06, 0.36, -0.03), (0.035, 0.07, 0.06), 'Dark')       # ammo box
    P.tbox(V((0, 0.25, -0.05)), V((0, 0.23, -0.14)), (0.03, 0.045), (0.03, 0.04), 'Dark', fwd=Y)
    P.cyl(V((0, 0.52, 0.01)), V((0, 1.05, 0.01)), 0.016, mat='Dark', segs=7)
    P.cyl(V((0, 0.95, 0.01)), V((0.05, 1.0, -0.2)), 0.006, mat='Metal', segs=4)   # bipod legs
    P.cyl(V((0, 0.95, 0.01)), V((-0.05, 1.0, -0.2)), 0.006, mat='Metal', segs=4)
    out['mg'] = (P, V((0, 1.05, 0.01)))
    # --- sniper rifle
    P = W()
    ob(P, (0, 0.12, -0.02), (0.022, 0.12, 0.05), 'Dark')
    ob(P, (0, 0.38, 0.0), (0.03, 0.14, 0.04), 'Metal')
    P.cyl(V((0, 0.26, 0.08)), V((0, 0.52, 0.08)), 0.024, mat='Dark', segs=8)     # scope
    P.cyl(V((0, 0.5, 0.005)), V((0, 1.12, 0.005)), 0.012, mat='Dark', segs=6)
    P.tbox(V((0, 0.27, -0.04)), V((0, 0.25, -0.13)), (0.03, 0.045), (0.03, 0.04), 'Dark', fwd=Y)
    out['sniper'] = (P, V((0, 1.12, 0.005)))
    # --- shoulder-fired launcher (AT4 / Carl Gustaf / RShG), tube on the shoulder
    P = W()
    P.cyl(V((0, -0.45, 0.04)), V((0, 0.55, 0.04)), 0.045, mat='Gear' if side == 'nato' else 'Dark', segs=10)
    ob(P, (0, 0.18, -0.06), (0.02, 0.03, 0.05), 'Dark')            # grip
    ob(P, (0.0, 0.3, 0.1), (0.015, 0.04, 0.02), 'Dark')            # sight
    out['launcher'] = (P, V((0, 0.55, 0.04)))
    # --- RPG-7 with warhead (OPFOR) / Javelin CLU+tube (NATO)
    P = W()
    if side == 'opfor':
        P.cyl(V((0, -0.35, 0.04)), V((0, 0.6, 0.04)), 0.028, mat='Dark', segs=8)
        P.cyl(V((0, -0.42, 0.04)), V((0, -0.3, 0.04)), 0.045, 0.03, mat='Dark', segs=8)   # venturi
        ob(P, (0, 0.05, 0.035), (0.03, 0.12, 0.035), 'Pouch')                               # wood guard
        P.cyl(V((0, 0.6, 0.04)), V((0, 0.82, 0.04)), 0.045, 0.02, mat='Gear', segs=8)     # warhead
        P.cyl(V((0, 0.82, 0.04)), V((0, 0.95, 0.04)), 0.02, 0.0, mat='Gear', segs=8)
        ob(P, (0, 0.2, -0.07), (0.02, 0.025, 0.05), 'Dark')
        out['rpg'] = (P, V((0, 0.95, 0.04)))
    else:
        P.cyl(V((0, -0.45, 0.05)), V((0, 0.75, 0.05)), 0.07, mat='Gear', segs=10)
        ob(P, (0.1, 0.05, 0.03), (0.05, 0.1, 0.07), 'Dark')          # command launch unit
        P.cyl(V((0.1, 0.16, 0.06)), V((0.1, 0.22, 0.06)), 0.03, mat='Glass', segs=8)
        out['javelin'] = (P, V((0, 0.75, 0.05)))
    return out


# ======================================================================================
# Colours
# ======================================================================================
def _hex(h):
    h = h.lstrip('#')
    return [int(h[i:i + 2], 16) / 255.0 for i in (0, 2, 4)]


def _srgb_to_lin(c):
    return [x / 12.92 if x <= 0.04045 else ((x + 0.055) / 1.055) ** 2.4 for x in c]


def vnoise(p, seed=0):
    """Cheap 3D value noise in [0,1]."""
    def h(i, j, k):
        n = (i * 73856093) ^ (j * 19349663) ^ (k * 83492791) ^ (seed * 2654435761)
        n = (n ^ (n >> 13)) * 1274126177
        return ((n ^ (n >> 16)) & 0xffff) / 65535.0
    x, y, z = p
    ix, iy, iz = math.floor(x), math.floor(y), math.floor(z)
    fx, fy, fz = x - ix, y - iy, z - iz
    fx, fy, fz = fx * fx * (3 - 2 * fx), fy * fy * (3 - 2 * fy), fz * fz * (3 - 2 * fz)
    acc = 0.0
    for dx in (0, 1):
        for dy in (0, 1):
            for dz in (0, 1):
                w = (fx if dx else 1 - fx) * (fy if dy else 1 - fy) * (fz if dz else 1 - fz)
                acc += w * h(ix + dx, iy + dy, iz + dz)
    return acc


def colourize(me, mats_per_face, side, skin_idx=0):
    pal = FACTION_COLORS[side]
    camo = [_hex(c) for c in pal['camo']]
    attr = me.color_attributes.get('Col') or me.color_attributes.new('Col', 'FLOAT_COLOR', 'POINT')
    vcol = [None] * len(me.vertices)
    for poly, mat in zip(me.polygons, mats_per_face):
        for vi in poly.vertices:
            if vcol[vi] is not None:
                continue
            co = me.vertices[vi].co
            if mat in ('Uniform',):
                n1 = vnoise((co.x * 7, co.y * 7, co.z * 7), 1)
                n2 = vnoise((co.x * 15 + 3, co.y * 15, co.z * 15), 2)
                if side == 'opfor':
                    # blocky digital pattern: quantise the noise
                    idx = 0 if n1 < 0.45 else 1 if n1 < 0.62 else 2 if n2 < 0.7 else 3
                else:
                    idx = 0 if n1 < 0.4 else 1 if n1 < 0.58 else 2 if n2 < 0.66 else 3
                c = camo[idx]
            elif mat == 'Skin':
                c = _hex(pal['Skin'][skin_idx % len(pal['Skin'])])
            elif mat in pal:
                c = _hex(pal[mat])
                j = (vnoise((co.x * 20, co.y * 20, co.z * 20), 5) - 0.5) * 0.06
                c = [max(0.0, min(1.0, x + j)) for x in c]
            else:
                c = _hex(mc_lib.MAT_COLORS.get(mat, '#808080'))
            vcol[vi] = _srgb_to_lin(c) + [1.0]
    for i, c in enumerate(vcol):
        attr.data[i].color = c or [0.5, 0.5, 0.5, 1.0]
    me.color_attributes.active_color = attr


def soldier_material():
    name = 'Soldier'
    mat = bpy.data.materials.get(name)
    if mat:
        return mat
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    nt = mat.node_tree
    bsdf = next(n for n in nt.nodes if n.type == 'BSDF_PRINCIPLED')
    attr = nt.nodes.new('ShaderNodeVertexColor')
    attr.layer_name = 'Col'
    nt.links.new(attr.outputs['Color'], bsdf.inputs['Base Color'])
    bsdf.inputs['Roughness'].default_value = 0.85
    return mat


# ======================================================================================
# Assembly
# ======================================================================================
def part_to_object(name, part, bone_of, arm, side, smooth_angle=35.0):
    mats = [part.mats[f.material_index] for f in part.bm.faces]
    me = bpy.data.meshes.new(name)
    part.bm.to_mesh(me)
    part.bm.free()
    me.materials.append(soldier_material())
    for poly in me.polygons:
        poly.material_index = 0
    obj = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(obj)
    colourize(me, mats, side)
    # vertex groups (rigid)
    groups = {}
    for vi, b in enumerate(bone_of):
        g = groups.get(b)
        if g is None:
            g = groups[b] = obj.vertex_groups.new(name=b)
        g.add([vi], 1.0, 'REPLACE')
    obj.parent = arm
    mod = obj.modifiers.new('Armature', 'ARMATURE')
    mod.object = arm
    # smooth shading with sharp creases
    bpy.context.view_layer.objects.active = obj
    for o in bpy.context.selected_objects:
        o.select_set(False)
    obj.select_set(True)
    try:
        bpy.ops.object.shade_smooth_by_angle(angle=math.radians(smooth_angle))
    except Exception:
        for poly in me.polygons:
            poly.use_smooth = True
    return obj


def build_armature(rest):
    arm_data = bpy.data.armatures.new('soldier_rig')
    arm = bpy.data.objects.new('soldier_rig', arm_data)
    bpy.context.scene.collection.objects.link(arm)
    bpy.context.view_layer.objects.active = arm
    for o in bpy.context.selected_objects:
        o.select_set(False)
    arm.select_set(True)
    bpy.ops.object.mode_set(mode='EDIT')
    S = solve(rest)
    ebs = {}
    for name, parent in BONES:
        h, t, z = S[name]
        eb = arm_data.edit_bones.new(name)
        eb.head = h
        eb.tail = t if (t - h).length > 1e-3 else h + V((0, 0, 0.1))
        x, y, zz = frame(eb.tail - eb.head, z)
        eb.align_roll(zz)
        eb.use_deform = name not in ('root',)
        if parent:
            eb.parent = ebs[parent]
            eb.use_connect = False
        ebs[name] = eb
    bpy.ops.object.mode_set(mode='OBJECT')
    arm.show_in_front = True
    return arm


def to_basis(arm, pose_mats):
    """Armature-space pose matrices -> {bone: (loc, quat)} local basis transforms."""
    out = {}
    for name, parent in BONES:
        b = arm.data.bones[name]
        rest = b.matrix_local
        pm = pose_mats[name]
        if parent:
            prest = arm.data.bones[parent].matrix_local
            basis = rest.inverted() @ prest @ pose_mats[parent].inverted() @ pm
        else:
            basis = rest.inverted() @ pm
        loc, rot, _ = basis.decompose()
        out[name] = (loc, rot)
    return out


def bake_clip(arm, name, dur, loop, fn):
    act = bpy.data.actions.new(name)
    act.use_fake_user = True
    if arm.animation_data is None:
        arm.animation_data_create()
    arm.animation_data.action = act
    frames = max(2, int(round(dur * FPS)))
    prev = {}
    for fi in range(frames + 1):
        t = fi / FPS if fi < frames else dur
        if loop and fi == frames:
            t = 0.0  # close the loop exactly
        mats = matrices(fn(t))
        basis = to_basis(arm, mats)
        for bn, (loc, rot) in basis.items():
            pb = arm.pose.bones[bn]
            pb.rotation_mode = 'QUATERNION'
            if bn in prev and prev[bn].dot(rot) < 0:
                rot = -rot  # keep quaternions continuous
            prev[bn] = rot
            pb.location = loc
            pb.rotation_quaternion = rot
            pb.keyframe_insert('location', frame=fi + 1)
            pb.keyframe_insert('rotation_quaternion', frame=fi + 1)
    act.frame_range = (1, frames + 1)
    act.use_frame_range = True
    act.use_cyclic = loop
    return act



def _bevel_apply_keep_mod(obj):
    """Bevel before the armature modifier (modifier order matters), then apply it."""
    mod = obj.modifiers.new('Bevel', 'BEVEL')
    mod.width = 0.006
    mod.segments = 1
    mod.limit_method = 'ANGLE'
    mod.angle_limit = math.radians(40)
    bpy.context.view_layer.objects.active = obj
    while obj.modifiers[0].name != mod.name:
        bpy.ops.object.modifier_move_up(modifier=mod.name)
    bpy.ops.object.modifier_apply(modifier=mod.name)


def colourize_skin(obj, arm, side):
    """Uniform camo everywhere except the neck (skin) — chosen by the dominant bone weight."""
    me = obj.data
    names = {g.index: g.name for g in obj.vertex_groups}
    mats = []
    dom = []
    for v in me.vertices:
        best, bw = None, -1
        for g in v.groups:
            if g.weight > bw:
                best, bw = names[g.group], g.weight
        dom.append(best)
    for poly in me.polygons:
        bs = [dom[i] for i in poly.vertices]
        mats.append('Skin' if bs.count('neck') + bs.count('head') > len(bs) / 2 else 'Uniform')
    me.materials.clear()
    me.materials.append(soldier_material())
    colourize(me, mats, side)


def join_body(skin, gear, arm):
    for o in bpy.context.selected_objects:
        o.select_set(False)
    skin.select_set(True)
    gear.select_set(True)
    bpy.context.view_layer.objects.active = skin
    bpy.ops.object.join()
    body = bpy.context.view_layer.objects.active
    body.name = 'body'
    body.data.name = 'body'
    # the joined object keeps skin's armature modifier; make sure there is exactly one
    arms = [m for m in body.modifiers if m.type == 'ARMATURE']
    for m in arms[1:]:
        body.modifiers.remove(m)
    if not arms:
        m = body.modifiers.new('Armature', 'ARMATURE')
        m.object = arm
    return body


def build(side='nato', with_clips=True):
    rest = STAND_READY
    arm = build_armature(rest)
    skin = build_skin_body(rest, arm)
    G = build_gear(rest)
    gear = part_to_object('gear', G.P, G.bone_of, arm, side, smooth_angle=40.0)
    _bevel_apply_keep_mod(gear)
    colourize_skin(skin, arm, side)
    body = join_body(skin, gear, arm)
    # weapons at the rest weapon frame
    wpos, wdir, wup = (V(a) for a in rest['weapon'])
    x, y, z = frame(wdir, wup)
    M = mat_from(wpos, x, y, z)
    weapons = {}
    for wname, (P, muzzle) in weapon_parts(side).items():
        bmesh.ops.transform(P.bm, matrix=M, verts=P.bm.verts)
        obj = part_to_object('wpn_' + wname, P, ['weapon'] * len(P.bm.verts), arm, side, smooth_angle=30.0)
        weapons[wname] = obj
        em = bpy.data.objects.new('muzzle_' + wname, None)
        em.empty_display_size = 0.05
        bpy.context.scene.collection.objects.link(em)
        em.parent = arm
        em.parent_type = 'BONE'
        em.parent_bone = 'weapon'
        # bone-parented children are relative to the bone tail; place in world then fix
        bpy.context.view_layer.update()
        em.matrix_world = Matrix.Translation(M @ muzzle)
    SL = build_slung(rest, side)
    slung = part_to_object('slung_launcher', SL.P, SL.bone_of, arm, side, smooth_angle=35.0)
    slung.data.name = 'slung_launcher'
    if with_clips:
        for cname, (dur, loop, fn) in clips().items():
            bake_clip(arm, cname, dur, loop, fn)
        arm.animation_data.action = None
        for pb in arm.pose.bones:
            pb.location = (0, 0, 0)
            pb.rotation_quaternion = (1, 0, 0, 0)
    return arm, body, weapons


def export(arm, path):
    objs = [arm] + list(arm.children)
    for o in bpy.context.scene.objects:
        o.select_set(o in objs)
    bpy.context.view_layer.objects.active = arm
    bpy.ops.export_scene.gltf(
        filepath=path, export_format='GLB', use_selection=True, export_apply=False, export_yup=True,
        export_animations=True, export_animation_mode='ACTIONS', export_skins=True,
        export_optimize_animation_size=True, export_anim_single_armature=True,
        export_cameras=False, export_lights=False, export_extras=False, export_texcoords=False,
        export_normals=True, export_materials='EXPORT', export_vertex_color='ACTIVE',
        export_force_sampling=True, export_frame_step=1,
    )


# ======================================================================================
# Batch export (both factions, rigged + static far-LOD poses)
# ======================================================================================
STATIC_POSES = {
    'stand': ('idle_stand', 0.0),
    'kneel': ('aim_kneel', 0.0),
    'prone': ('aim_prone', 0.0),
    'dead': ('death_back', 1.0),
}
WEAPON_FOR = {
    'nato': ['rifle', 'mg', 'sniper', 'launcher', 'javelin'],
    'opfor': ['rifle', 'mg', 'sniper', 'launcher', 'rpg'],
}


def clear_all():
    for o in list(bpy.data.objects):
        bpy.data.objects.remove(o, do_unlink=True)
    for coll in (bpy.data.actions, bpy.data.armatures, bpy.data.meshes, bpy.data.materials):
        for d in list(coll):
            coll.remove(d)


def set_pose(arm, pose):
    for bn, (loc, rot) in to_basis(arm, matrices(pose)).items():
        pb = arm.pose.bones[bn]
        pb.rotation_mode = 'QUATERNION'
        pb.location = loc
        pb.rotation_quaternion = rot
    bpy.context.view_layer.update()


def export_static(arm, body, weapon, pose, path, ratio=0.42):
    """Bake a posed copy (body + weapon), decimate it for distance use, export it."""
    set_pose(arm, pose)
    dg = bpy.context.evaluated_depsgraph_get()
    objs = []
    for src in (body, weapon):
        me = bpy.data.meshes.new_from_object(src.evaluated_get(dg))
        o = bpy.data.objects.new('soldier' if src is body else 'tmp_wpn', me)
        bpy.context.scene.collection.objects.link(o)
        objs.append(o)
    for o in bpy.context.selected_objects:
        o.select_set(False)
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    bpy.ops.object.join()
    obj = bpy.context.view_layer.objects.active
    obj.name = 'soldier'
    obj.vertex_groups.clear()
    dec = obj.modifiers.new('Dec', 'DECIMATE')
    dec.ratio = ratio
    bpy.ops.object.modifier_apply(modifier='Dec')
    for o in bpy.context.selected_objects:
        o.select_set(False)
    obj.select_set(True)
    bpy.ops.export_scene.gltf(filepath=path, export_format='GLB', use_selection=True, export_apply=True,
                              export_yup=True, export_animations=False, export_skins=False,
                              export_cameras=False, export_lights=False, export_texcoords=False,
                              export_normals=True, export_materials='EXPORT', export_vertex_color='ACTIVE')
    obj.data.calc_loop_triangles()
    tris = len(obj.data.loop_triangles)
    bpy.data.objects.remove(obj, do_unlink=True)
    for pb in arm.pose.bones:
        pb.location = (0, 0, 0)
        pb.rotation_quaternion = (1, 0, 0, 0)
    return tris


def build_all(out_dir):
    import json
    import os
    info = {'clips': {}, 'sides': {}}
    for name, (dur, loop, fn) in clips().items():
        info['clips'][name] = {'duration': round(dur, 3), 'loop': loop}
    info['clipSpeed'] = {'walk': 1.6, 'run': 2 * 1.2 / 0.66, 'sneak': 2 * 0.42 / 1.2}
    for side in ('nato', 'opfor'):
        clear_all()
        arm, body, weapons = build(side, with_clips=True)
        path = os.path.join(out_dir, 'soldier_rig_%s.glb' % side)
        export(arm, path)
        body.data.calc_loop_triangles()
        entry = {'file': os.path.basename(path), 'bodyTris': len(body.data.loop_triangles),
                 'weapons': sorted(weapons.keys()), 'kb': round(os.path.getsize(path) / 1024), 'static': {}}
        C = clips()
        for stance, (clip, frac) in STATIC_POSES.items():
            dur, loop, fn = C[clip]
            spath = os.path.join(out_dir, 'soldier_%s_%s.glb' % (stance, side))
            entry['static'][stance] = {'file': os.path.basename(spath), 'tris': export_static(arm, body, weapons['rifle'], fn(dur * frac), spath)}
        info['sides'][side] = entry
        print('[soldier] %s: body %d tris, rig %d KB' % (side, entry['bodyTris'], entry['kb']))
    with open(os.path.join(out_dir, 'soldier_rig.json'), 'w') as fh:
        json.dump(info, fh, indent=1)
    return info
