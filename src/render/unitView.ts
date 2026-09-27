import * as THREE from 'three';
import type { Side } from '../data/units';
import { wrapAngle } from '../sim/math';
import type { Soldier, VehicleState } from '../sim/types';
import type { World } from '../sim/world';
import { InstPart, ModelLib } from './models';
import { SoldierAnimator } from './soldierAnim';
import { softDot } from './textures';

export const SOLDIER_SCALE = 1.35;
/** Soldiers closer than this (m) to the camera are fully animated, up to ANIM_BUDGET of them. */
const ANIM_DIST = 360;
const STANCES = ['stand', 'kneel', 'prone', 'dead'] as const;
type StanceModel = (typeof STANCES)[number];

interface InstSet {
  meshes: THREE.InstancedMesh[];
  count: number;
}

interface WheelVis {
  node: THREE.Object3D;
  radius: number;
  front: boolean;
}

interface VehicleVis {
  obj: THREE.Object3D;
  turret: THREE.Object3D | null;
  gun: THREE.Object3D | null;
  muzzle: THREE.Object3D | null;
  burnt: boolean;
  seen: boolean;
  wheels: WheelVis[];
  gunRestX: number;
  recoil: number;
  /** Extra hull pitch (radians) from firing and acceleration, spring-damped. */
  rock: number;
  rockVel: number;
  prevSpeed: number;
  prevHeading: number;
  steer: number;
}

/** Find spinning wheel nodes and their radii in a freshly cloned vehicle. */
function findWheels(obj: THREE.Object3D, wheeled: boolean): WheelVis[] {
  const out: WheelVis[] = [];
  const box = new THREE.Box3();
  const size = new THREE.Vector3();
  obj.updateMatrixWorld(true);
  obj.traverse((o) => {
    if (!/^(wheel_[LR]\d+|sprocket_[LR]|idler_[LR])$/.test(o.name)) return;
    box.setFromObject(o);
    box.getSize(size);
    o.rotation.order = 'YXZ';
    // road wheels behind track skirts: not worth two extra shadow-pass draws each
    if (!wheeled) o.traverse((m) => ((m as THREE.Mesh).isMesh ? (m.castShadow = false) : undefined));
    out.push({ node: o, radius: Math.max(0.1, size.y / 2), front: wheeled && /^wheel_[LR]0$/.test(o.name) });
  });
  return out;
}

const tmpM = new THREE.Matrix4();
const tmpQ = new THREE.Quaternion();
const tmpE = new THREE.Euler();
const tmpP = new THREE.Vector3();
const tmpS = new THREE.Vector3();

/** Draws soldiers (instanced), vehicles, drones and heavy weapon props. */
export class UnitView {
  readonly group = new THREE.Group();
  private sets = new Map<string, InstSet>();
  private vehicles = new Map<number, VehicleVis>();
  private drones = new Map<number, THREE.Object3D>();
  private props = new Map<number, THREE.Object3D>();
  /** Markers for soldiers hidden inside buildings (drawn above the roof). */
  private garrison: THREE.Points;
  private garrisonPos: Float32Array;
  private garrisonCol: Float32Array;
  /** Enemy units the player has ever seen (bodies/wrecks stay visible). */
  private everSeen = new Set<number>();
  readonly animator: SoldierAnimator;
  /** Max fully animated soldiers per frame (set from the graphics quality). */
  animBudget = 160;
  private frustum = new THREE.Frustum();
  private projScreen = new THREE.Matrix4();
  private sphere = new THREE.Sphere(new THREE.Vector3(), 2.5);

  constructor(private world: World, private models: ModelLib, private player: Side | null) {
    const count: Record<Side, number> = { nato: 0, opfor: 0 };
    for (const s of world.soldiers) count[s.side]++;
    this.garrisonPos = new Float32Array(600 * 3);
    this.garrisonCol = new Float32Array(600 * 3);
    const gg = new THREE.BufferGeometry();
    gg.setAttribute('position', new THREE.BufferAttribute(this.garrisonPos, 3).setUsage(THREE.DynamicDrawUsage));
    gg.setAttribute('color', new THREE.BufferAttribute(this.garrisonCol, 3).setUsage(THREE.DynamicDrawUsage));
    this.garrison = new THREE.Points(gg, new THREE.PointsMaterial({ size: 9, sizeAttenuation: false, vertexColors: true, depthTest: false, transparent: true, opacity: 0.95, map: softDot(), alphaTest: 0.25 }));
    this.garrison.frustumCulled = false;
    this.garrison.renderOrder = 8;
    this.group.add(this.garrison);
    this.animator = new SoldierAnimator(models, SOLDIER_SCALE);
    this.group.add(this.animator.group);
    for (const side of ['nato', 'opfor'] as Side[]) {
      for (const st of STANCES) {
        // new vertex-coloured faction models when available, the old tinted ones otherwise
        const fresh = models.has(`soldier_${st}_${side}`);
        const parts: InstPart[] = fresh ? models.parts(`soldier_${st}_${side}`, null) : models.parts(`soldier_${st}`, side);
        const max = Math.max(1, count[side] + 40);
        const meshes = parts.map((p) => {
          const m = new THREE.InstancedMesh(p.geometry, p.material, max);
          m.castShadow = true;
          m.receiveShadow = false;
          m.count = 0;
          m.frustumCulled = false;
          this.group.add(m);
          return m;
        });
        this.sets.set(`${side}|${st}`, { meshes, count: 0 });
      }
    }
  }

  /** Can the player see this unit right now? */
  visibleUnit(unitId: number): boolean {
    if (!this.player) return true;
    const u = this.world.units[unitId];
    if (u.side === this.player) return true;
    const vis = this.world.isVisibleTo(this.player, unitId);
    if (vis) this.everSeen.add(unitId);
    return vis;
  }

  private stanceModel(s: Soldier): StanceModel {
    if (s.health === 'dead' || s.health === 'incap') return 'dead';
    if (s.stance === 'stand') return 'stand';
    if (s.stance === 'crouch') return 'kneel';
    return 'prone';
  }

  update(alpha: number, time: number, camera?: THREE.Camera, animDt = 0): void {
    const w = this.world;
    for (const set of this.sets.values()) set.count = 0;
    let gn = 0;
    // choose who gets a fully animated model: nearest visible soldiers inside the view
    const animated = new Set<number>();
    const animList: Soldier[] = [];
    if (camera && this.animator.available) {
      this.projScreen.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
      this.frustum.setFromProjectionMatrix(this.projScreen);
      const cp = camera.position;
      const cands: { s: Soldier; d: number }[] = [];
      for (const s of w.soldiers) {
        if (s.vehicle >= 0 || s.fled) continue;
        const u = w.units[s.unitId];
        if (this.player && u.side !== this.player && !this.visibleUnit(u.id) && !((s.health === 'dead' || s.health === 'incap') && this.everSeen.has(u.id))) continue;
        const gz = w.map.groundAt(s.x, s.y);
        const d = Math.hypot(s.x - cp.x, gz - cp.y, -s.y - cp.z);
        if (d > ANIM_DIST) continue;
        this.sphere.center.set(s.x, gz + 1, -s.y);
        if (!this.frustum.intersectsSphere(this.sphere)) continue;
        cands.push({ s, d });
      }
      cands.sort((a, b) => a.d - b.d);
      for (const c of cands.slice(0, this.animBudget)) {
        animated.add(c.s.id);
        animList.push(c.s);
      }
    }
    this.animator.update(w, animList, alpha, animDt);
    // soldiers
    for (const s of w.soldiers) {
      if (s.vehicle >= 0 || s.fled) continue;
      const u = w.units[s.unitId];
      const dead = s.health === 'dead' || s.health === 'incap';
      if (u.side !== this.player && this.player) {
        const vis = this.visibleUnit(u.id);
        if (!vis && !(dead && this.everSeen.has(u.id))) continue;
      }
      if (!dead && gn < 600) {
        const bid = w.map.buildingAt(s.x, s.y);
        if (bid >= 0 && !w.map.buildings[bid].destroyed) {
          const b = w.map.buildings[bid];
          this.garrisonPos[gn * 3] = s.x;
          this.garrisonPos[gn * 3 + 1] = w.map.groundAt(s.x, s.y) + b.height + 2.5;
          this.garrisonPos[gn * 3 + 2] = -s.y;
          const c = s.side === 'nato' ? [0.45, 0.72, 1] : [1, 0.42, 0.36];
          const k = s.state === 'ready' ? 1 : 0.55;
          this.garrisonCol.set([c[0] * k, c[1] * k, c[2] * k], gn * 3);
          gn++;
        }
      }
      if (animated.has(s.id)) continue;
      const st = this.stanceModel(s);
      const set = this.sets.get(`${s.side}|${st}`)!;
      const x = s.px + (s.x - s.px) * alpha;
      const y = s.py + (s.y - s.py) * alpha;
      let z = w.map.groundAt(x, y);
      if (s.moving && st === 'stand') z += Math.abs(Math.sin(time * 9 + s.id)) * 0.08;
      const yaw = dead ? (s.id * 2.399) % (Math.PI * 2) : s.facing;
      tmpQ.setFromEuler(tmpE.set(0, yaw, 0));
      tmpP.set(x, z, -y);
      tmpS.setScalar(SOLDIER_SCALE);
      tmpM.compose(tmpP, tmpQ, tmpS);
      const i = set.count++;
      for (const m of set.meshes) if (i < m.instanceMatrix.count) m.setMatrixAt(i, tmpM);
    }
    for (const set of this.sets.values()) {
      for (const m of set.meshes) {
        m.count = Math.min(set.count, m.instanceMatrix.count);
        m.instanceMatrix.needsUpdate = true;
      }
    }
    this.garrison.geometry.setDrawRange(0, gn);
    (this.garrison.geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    (this.garrison.geometry.attributes.color as THREE.BufferAttribute).needsUpdate = true;
    // vehicles
    for (const v of w.vehicles) this.updateVehicle(v, alpha, animDt);
    // drones
    const alive = new Set<number>();
    for (const d of w.drones) {
      alive.add(d.id);
      let o = this.drones.get(d.id);
      if (!o) {
        o = this.models.clone(d.model === 'quad' ? 'drone_quad' : 'drone_fixed', d.side);
        o.scale.setScalar(d.model === 'quad' ? 3 : 2.2);
        this.drones.set(d.id, o);
        this.group.add(o);
      }
      const x = d.px + (d.x - d.px) * alpha;
      const y = d.py + (d.y - d.py) * alpha;
      const z = d.pz + (d.z - d.pz) * alpha;
      o.position.set(x, z, -y);
      o.rotation.set(0, d.heading, d.model === 'fixed' ? -0.25 : 0);
    }
    for (const [id, o] of this.drones) {
      if (!alive.has(id)) {
        this.group.remove(o);
        this.drones.delete(id);
      }
    }
    // heavy weapon props (mortar tube, ATGM tripod)
    for (const u of w.units) {
      const prop = u.template.id.endsWith('_mortar') ? 'mortar' : u.template.id === 'ru_kornet' ? 'atgm_tripod' : null;
      if (!prop) continue;
      let o = this.props.get(u.id);
      const lead = w.leaderOf(u);
      const show = !!lead && !lead.moving && lead.vehicle < 0 && !u.eliminated && (u.side === this.player || !this.player || this.visibleUnit(u.id));
      if (!o) {
        o = this.models.clone(prop, u.side);
        o.scale.setScalar(1.3);
        this.props.set(u.id, o);
        this.group.add(o);
      }
      o.visible = show;
      if (show && lead) {
        const fx = lead.x + Math.cos(lead.facing) * 1.6;
        const fy = lead.y + Math.sin(lead.facing) * 1.6;
        o.position.set(fx, w.map.groundAt(fx, fy), -fy);
        o.rotation.set(0, lead.facing, 0);
      }
    }
  }

  private updateVehicle(v: VehicleState, alpha: number, animDt: number): void {
    const w = this.world;
    let vis = this.vehicles.get(v.id);
    if (!vis) {
      const obj = this.models.clone(v.def.model, v.side);
      const gun = obj.getObjectByName('gun') ?? null;
      vis = {
        obj, turret: obj.getObjectByName('turret') ?? null, gun, muzzle: obj.getObjectByName('muzzle') ?? null, burnt: false, seen: false,
        wheels: findWheels(obj, v.def.mobility === 'wheel'), gunRestX: gun ? gun.position.x : 0, recoil: 0, rock: 0, rockVel: 0,
        prevSpeed: 0, prevHeading: v.heading, steer: 0,
      };
      this.vehicles.set(v.id, vis);
      this.group.add(obj);
    }
    const own = !this.player || v.side === this.player;
    const visibleNow = own || this.visibleUnit(v.unitId);
    if (visibleNow) vis.seen = true;
    vis.obj.visible = visibleNow || (v.destroyed && vis.seen);
    if (!vis.obj.visible) return;
    if ((v.destroyed || v.abandoned) && !vis.burnt && v.destroyed) {
      const old = vis.obj;
      const obj = this.models.clone(v.def.model, v.side, true);
      this.group.remove(old);
      this.group.add(obj);
      vis.obj = obj;
      vis.turret = obj.getObjectByName('turret') ?? null;
      vis.gun = obj.getObjectByName('gun') ?? null;
      vis.muzzle = obj.getObjectByName('muzzle') ?? null;
      vis.wheels = [];
      vis.burnt = true;
    }
    const x = v.px + (v.x - v.px) * alpha;
    const y = v.py + (v.y - v.py) * alpha;
    const h = v.pheading + wrapAngle(v.heading - v.pheading) * alpha;
    const t = v.pturret + wrapAngle(v.turret - v.pturret) * alpha;
    // tilt to the terrain
    const L = v.def.length * 0.45;
    const Wd = v.def.width * 0.45;
    const c = Math.cos(h);
    const s = Math.sin(h);
    const gf = w.map.groundAt(x + c * L, y + s * L);
    const gb = w.map.groundAt(x - c * L, y - s * L);
    const gl = w.map.groundAt(x - s * Wd, y + c * Wd);
    const gr = w.map.groundAt(x + s * Wd, y - c * Wd);
    const pitch = Math.atan2(gf - gb, 2 * L);
    const roll = Math.atan2(gl - gr, 2 * Wd);
    // suspension: pitch back when accelerating, dip when braking, kick when the main gun fires
    if (animDt > 0 && !v.destroyed) {
      const accel = (v.speed - vis.prevSpeed) / animDt;
      vis.prevSpeed = v.speed;
      const target = Math.max(-0.05, Math.min(0.05, accel * 0.012));
      vis.rockVel += ((target - vis.rock) * 60 - vis.rockVel * 9) * animDt;
      vis.rock += vis.rockVel * animDt;
      // wheels spin with distance travelled; front wheels of wheeled vehicles steer with the turn rate
      const yawRate = wrapAngle(v.heading - vis.prevHeading) / animDt;
      vis.prevHeading = v.heading;
      vis.steer += (Math.max(-0.5, Math.min(0.5, yawRate * 0.9)) - vis.steer) * Math.min(1, animDt * 6);
      const dist = v.speed * animDt;
      for (const wv of vis.wheels) {
        wv.node.rotation.z -= dist / wv.radius;
        if (wv.front) wv.node.rotation.y = vis.steer;
      }
      if (vis.recoil > 0) vis.recoil = Math.max(0, vis.recoil - animDt * 3.5);
    }
    vis.obj.position.set(x, (gf + gb + gl + gr) / 4, -y);
    vis.obj.rotation.set(0, 0, 0);
    vis.obj.rotateY(h);
    vis.obj.rotateZ(pitch + vis.rock);
    vis.obj.rotateX(roll);
    if (vis.turret) vis.turret.rotation.y = wrapAngle(t - h);
    if (vis.gun) {
      vis.gun.rotation.z = v.destroyed ? -0.08 : 0.02;
      // barrel slams back and returns (ease-out)
      vis.gun.position.x = vis.gunRestX - 0.5 * vis.recoil * vis.recoil;
    }
    if (v.destroyed && vis.turret && v.id % 3 === 0) vis.turret.rotation.z = 0.12; // blown turret askew
  }

  /** The main gun (or cannon) of a vehicle fired: recoil the barrel and rock the hull. */
  onVehicleFire(vehicleId: number, cls: string): void {
    const vis = this.vehicles.get(vehicleId);
    if (!vis) return;
    if (cls === 'tankgun') {
      vis.recoil = 1;
      vis.rockVel -= 0.9;
    } else if (cls === 'autocannon') {
      vis.recoil = Math.max(vis.recoil, 0.35);
      vis.rockVel -= 0.15;
    }
  }

  /** World position of a vehicle's gun muzzle (for effects). */
  muzzleOf(vehicleId: number): THREE.Vector3 | null {
    const vis = this.vehicles.get(vehicleId);
    if (!vis?.muzzle) return null;
    return vis.muzzle.getWorldPosition(new THREE.Vector3());
  }

  wasSeen(unitId: number): boolean {
    return this.everSeen.has(unitId);
  }
}
