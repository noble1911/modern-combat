"""Infantry figures built from joint positions (Blender coords: +X front, +Y left, +Z up).

Each pose is a dict of joint positions; limbs are 6-sided tapered cylinders between
joints, elbows/knees come from 2-bone IK when not given explicitly.  The exported
hierarchy is  soldier (mesh)  ->  muzzle (Empty at the rifle muzzle, armed poses only).
"""
import math

from mathutils import Vector

from mc_lib import Part, make_node, ik2

V = Vector

THIGH, SHIN = 0.44, 0.43
UPPER_ARM, FOREARM = 0.31, 0.29
RIFLE_LEN = 0.86


def _frame(fwd, up):
    f = V(fwd).normalized()
    u = V(up) - f * f.dot(V(up))
    u.normalize()
    s = u.cross(f)          # left of f when u is up
    return f, s, u


def boot(P, ankle, fwd, up):
    f, s, u = _frame(fwd, up)
    c = V(ankle) + f * 0.055 - u * 0.04
    P.obox(c, f, s, u, (0.12, 0.048, 0.045), 'Dark')


def rifle(P, butt, direction, up):
    """M4-style carbine.  Returns (muzzle, grip_hand, fore_hand) positions."""
    a, s, u = _frame(direction, up)
    b = V(butt)

    def pt(t, h=0.0, w=0.0):
        return b + a * t + u * h + s * w
    P.obox(pt(0.12, -0.012), a, s, u, (0.12, 0.022, 0.048), 'Dark')          # stock
    P.obox(pt(0.38, 0.0), a, s, u, (0.14, 0.028, 0.045), 'Metal')             # receiver
    P.obox(pt(0.37, 0.078), a, s, u, (0.07, 0.02, 0.03), 'Dark')              # optic
    P.tbox(pt(0.44, -0.04), pt(0.47, -0.17), (0.05, 0.075), (0.05, 0.07), 'Dark', fwd=a)   # magazine
    P.tbox(pt(0.3, -0.04), pt(0.27, -0.13), (0.035, 0.05), (0.035, 0.045), 'Dark', fwd=a)  # grip
    P.obox(pt(0.62, 0.0), a, s, u, (0.1, 0.03, 0.034), 'Dark')                # handguard
    P.cyl(pt(0.72), pt(RIFLE_LEN), 0.012, mat='Dark', segs=5)                 # barrel
    return pt(RIFLE_LEN), pt(0.29, -0.09), pt(0.56, -0.05)


def build_soldier(pose):
    P = Part()
    pelvis, neck = V(pose['pelvis']), V(pose['neck'])
    up_t = (neck - pelvis).normalized()
    f = V(pose['fwd']) - up_t * up_t.dot(V(pose['fwd']))
    f.normalize()
    left = up_t.cross(f).normalized()

    # --- legs ---
    for side, key in ((1, 'L'), (-1, 'R')):
        hip = pelvis + left * (side * 0.1) - up_t * 0.03
        ankle = V(pose['ankle' + key])
        knee = V(pose['knee' + key]) if ('knee' + key) in pose else ik2(hip, ankle, THIGH, SHIN, pose.get('knee_pole', f))
        P.cyl(hip, knee, 0.078, 0.062, mat='Uniform', segs=6)
        P.cyl(knee, ankle, 0.058, 0.045, mat='Uniform', segs=6)
        boot(P, ankle, pose['foot' + key], pose.get('footup' + key, (0, 0, 1)))

    # --- torso ---
    P.obox(pelvis, f, left, up_t, (0.1, 0.16, 0.1), 'Uniform')
    P.tbox(pelvis + up_t * 0.04, neck - up_t * 0.02, (0.3, 0.2), (0.4, 0.22), 'Uniform', fwd=f)
    P.tbox(pelvis + up_t * 0.2 + f * 0.012, neck - up_t * 0.07 + f * 0.012, (0.37, 0.28), (0.41, 0.28), 'Gear', fwd=f)
    P.obox(pelvis + up_t * 0.25 + f * 0.155, f, left, up_t, (0.035, 0.15, 0.055), 'Gear')   # mag pouches
    if pose.get('pack', True):
        P.obox(pelvis + up_t * 0.35 - f * 0.18, f, left, up_t, (0.06, 0.13, 0.14), 'Gear')

    # --- head ---
    head = V(pose['head'])
    hu = V(pose.get('head_up', up_t)).normalized()
    hf = V(pose.get('head_fwd', f))
    P.cyl(neck - up_t * 0.04, head - hu * 0.06, 0.05, mat='Skin', segs=6)
    P.ico(head, 0.1, 'Skin', subdiv=1)
    P.dome(head + hu * 0.012 - hf.normalized() * 0.012, 0.132, 'Gear', up=hu, fwd=hf, segs=8, rings=3,
           scale=(1.08, 1.0, 0.95), base=-12.0)

    body_n = len(P.bm.verts)

    # --- rifle and arms ---
    muzzle = None
    hands = dict(pose.get('hands', {}))
    if 'rifle' in pose:
        butt, rdir, rup = pose['rifle']
        muzzle, grip, fore = rifle(P, butt, rdir, rup)
        hands.setdefault('R', grip)
        hands.setdefault('L', fore)
    if 'rifle_ground' in pose:
        butt, rdir, rup = pose['rifle_ground']
        rifle(P, butt, rdir, rup)
    sh_c = neck - up_t * 0.07 + f * pose.get('shoulder_fwd', 0.02)
    for side, key in ((1, 'L'), (-1, 'R')):
        sh = sh_c + left * (side * 0.19)
        hand = V(hands[key])
        d = (hand - sh)
        wrist = hand - d.normalized() * 0.07
        if ('elbow' + key) in pose:
            elbow = V(pose['elbow' + key])
        else:
            pole = V(pose.get('elbow_pole' + key, (0, side * 0.6, -1)))
            elbow = ik2(sh, wrist, UPPER_ARM, FOREARM, pole)
        P.cyl(sh, elbow, 0.058, 0.047, mat='Uniform', segs=6)
        P.cyl(elbow, wrist, 0.047, 0.036, mat='Uniform', segs=6)
        hd = (hand - wrist).normalized()
        P.tbox(wrist, wrist + hd * 0.1, (0.05, 0.085), (0.045, 0.07), 'Skin', fwd=V(pose.get('palm', (0, 0, 1))))

    return P, body_n, muzzle


def finish(P, body_n, muzzle):
    """Centre the figure on its body footprint (XY) and create the nodes."""
    vs = list(P.bm.verts)[:body_n]
    cx = (min(v.co.x for v in vs) + max(v.co.x for v in vs)) / 2
    cy = (min(v.co.y for v in vs) + max(v.co.y for v in vs)) / 2
    zmin = min(v.co.z for v in P.bm.verts)
    if abs(zmin) > 0.03:
        print('[models] note: soldier pose lifted by %.3f m to sit on the ground' % -zmin)
    shift = V((-cx, -cy, -zmin))
    for v in P.bm.verts:
        v.co += shift
    root = make_node('soldier', P, (0, 0, 0))
    if muzzle is not None:
        make_node('muzzle', None, muzzle + shift, parent=root)
    return root


# --------------------------------------------------------------------------------------
# Poses
# --------------------------------------------------------------------------------------
STAND = dict(
    pelvis=(0.0, 0.0, 0.97), neck=(0.03, 0.0, 1.47), fwd=(1, 0, 0),
    head=(0.06, 0.0, 1.635),
    ankleL=(0.11, 0.13, 0.1), footL=(1, 0.2, 0),
    ankleR=(-0.1, -0.14, 0.1), footR=(1, -0.35, 0),
    rifle=((0.13, -0.15, 1.32), (0.85, 0.12, -0.42), (0, 0, 1)),
    shoulder_fwd=0.05,
    elbow_poleR=(-0.3, -1, -0.7), elbow_poleL=(0, 1, -1),
)

KNEEL = dict(
    pelvis=(-0.12, 0.0, 0.47), neck=(0.007, 0.0, 0.943), fwd=(1, 0, 0),
    head=(0.075, -0.03, 1.075), head_up=(0.3, 0, 1),
    ankleL=(0.36, 0.16, 0.1), footL=(1, 0.1, 0), knee_pole=(1, 0, 0.8),
    kneeR=(0.08, -0.15, 0.075), ankleR=(-0.32, -0.16, 0.2), footR=(0.3, 0, -0.95), footupR=(0.95, 0, 0.3),
    rifle=((0.09, -0.14, 0.9), (1, 0.06, 0.0), (0, 0, 1)),
    shoulder_fwd=0.05,
    elbow_poleR=(0, -1, -0.5), elbow_poleL=(0, 0.3, -1),
)

PRONE = dict(
    pelvis=(-0.3, 0.0, 0.13), neck=(0.2, 0.0, 0.2), fwd=(0, 0, -1),
    head=(0.36, -0.02, 0.3), head_up=(0.3, 0, 0.95), head_fwd=(1, 0, 0),
    kneeL=(-0.72, 0.19, 0.07), ankleL=(-1.13, 0.27, 0.15), footL=(-0.85, 0.4, -0.4), footupL=(-0.4, 0, 0.85),
    kneeR=(-0.72, -0.16, 0.07), ankleR=(-1.14, -0.24, 0.15), footR=(-0.85, -0.4, -0.4), footupR=(-0.4, 0, 0.85),
    rifle=((0.18, -0.13, 0.25), (1, 0.03, 0.02), (0, 0, 1)),
    shoulder_fwd=0.0,
    elbowR=(0.24, -0.38, 0.06), elbow_poleL=(0, 0.6, -1),
)

DEAD = dict(
    pelvis=(-0.25, 0.0, 0.12), neck=(0.27, 0.06, 0.13), fwd=(0, 0, 1),
    head=(0.42, 0.1, 0.12), head_up=(1, 0.25, 0.08), head_fwd=(0, 0.5, 0.85),
    pack=False,
    kneeL=(-0.62, -0.22, 0.25), ankleL=(-0.98, -0.26, 0.1), footL=(-1, 0, 0),
    kneeR=(-0.68, 0.16, 0.08), ankleR=(-1.1, 0.2, 0.08), footR=(0.0, 0.4, 0.9), footupR=(1, 0, 0),
    hands=dict(L=(0.35, -0.65, 0.05), R=(-0.22, 0.6, 0.05)),
    elbowL=(0.12, -0.42, 0.06), elbowR=(0.02, 0.45, 0.06),
    palm=(0, 0, 1),
    rifle_ground=((-0.62, 0.66, 0.03), (0.95, 0.25, 0.0), (-0.25, 0.95, 0.0)),
)


def build_stand():
    return finish(*build_soldier(STAND))


def build_kneel():
    return finish(*build_soldier(KNEEL))


def build_prone():
    return finish(*build_soldier(PRONE))


def build_dead():
    return finish(*build_soldier(DEAD))
