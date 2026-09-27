import * as THREE from 'three';
import * as SkeletonUtils from 'three/examples/jsm/utils/SkeletonUtils.js';
import type { Side } from '../data/units';
import type { Soldier } from '../sim/types';
import { DT, type World } from '../sim/world';
import type { ModelLib } from './models';

/** Metres per second a locomotion clip covers at timeScale 1 (see tools/blender/soldier_rig.json). */
const CLIP_SPEED: Record<string, number> = { walk: 1.6, run: 3.64, sneak: 0.7 };
const DEATHS = ['death_back', 'death_fwd', 'death_crumple'];
const FADE = 0.25;
/** Secondary weapons drawn slung across the back when not in hand. */
const SLUNG = new Set(['at4', 'rpg26', 'm3e1']);

/** Which weapon mesh to show for a weapon definition id. */
function weaponModel(id: string, side: Side): string {
  switch (id) {
    case 'm250':
    case 'm240':
    case 'pkp':
      return 'mg';
    case 'mk22':
    case 'm110':
    case 'sv98':
    case 'svdm':
      return 'sniper';
    case 'at4':
    case 'm3e1':
    case 'rpg26':
      return 'launcher';
    case 'rpg7':
      return side === 'opfor' ? 'rpg' : 'launcher';
    case 'javelin':
      return side === 'nato' ? 'javelin' : 'launcher';
    default:
      return 'rifle';
  }
}

interface Instance {
  side: Side;
  root: THREE.Object3D;
  mixer: THREE.AnimationMixer;
  actions: Map<string, THREE.AnimationAction>;
  weapons: Map<string, THREE.Object3D>;
  muzzles: Map<string, THREE.Object3D>;
  /** Launcher slung across the back (null on older rigs). */
  slung: THREE.Object3D | null;
  slungShown: boolean;
  weaponBone: THREE.Bone | null;
  /** Spine, chest and head bones, jolted by a hit flinch. */
  flinchBones: THREE.Bone[];
  flinch: number;
  flinchSign: number;
  shownWeapon: string;
  clip: string;
  soldier: number;
  recoil: number;
  throwUntil: number;
  deathClip: string | null;
  finished: boolean;
}

/**
 * Skinned, animated soldiers for everyone near the camera. Soldiers further away (or beyond the
 * budget) are drawn by UnitView's cheap instanced static poses instead.
 */
export class SoldierAnimator {
  readonly group = new THREE.Group();
  private pool: Record<Side, Instance[]> = { nato: [], opfor: [] };
  private active = new Map<number, Instance>();
  private time = 0;
  readonly available: boolean;

  constructor(private models: ModelLib, private scale: number) {
    this.available = models.rigs.size === 2;
  }

  private create(side: Side): Instance {
    const rig = this.models.rigs.get(side)!;
    const root = SkeletonUtils.clone(rig.scene);
    const mixer = new THREE.AnimationMixer(root);
    const actions = new Map<string, THREE.AnimationAction>();
    for (const [name, clip] of rig.clips) {
      const a = mixer.clipAction(clip);
      if (name.startsWith('death') || name === 'throw' || name.startsWith('reload')) {
        a.setLoop(THREE.LoopOnce, 1);
        a.clampWhenFinished = true;
      }
      actions.set(name, a);
    }
    const weapons = new Map<string, THREE.Object3D>();
    const muzzles = new Map<string, THREE.Object3D>();
    let weaponBone: THREE.Bone | null = null;
    let slung: THREE.Object3D | null = null;
    const flinchBones: THREE.Bone[] = [];
    root.traverse((o) => {
      if (o.name.startsWith('wpn_')) weapons.set(o.name.slice(4), o);
      if (o.name === 'slung_launcher') slung = o;
      if ((o as THREE.Bone).isBone && (o.name === 'spine' || o.name === 'chest' || o.name === 'head')) flinchBones.push(o as THREE.Bone);
      if (o.name.startsWith('muzzle_')) muzzles.set(o.name.slice(7), o);
      if ((o as THREE.Bone).isBone && o.name === 'weapon') weaponBone = o as THREE.Bone;
    });
    root.scale.setScalar(this.scale);
    this.group.add(root);
    if (slung) (slung as THREE.Object3D).visible = false;
    return { side, root, mixer, actions, weapons, muzzles, slung, slungShown: false, weaponBone, flinchBones, flinch: 0, flinchSign: 1, shownWeapon: '', clip: '', soldier: -1, recoil: 0, throwUntil: 0, deathClip: null, finished: false };
  }

  private acquire(s: Soldier): Instance {
    let inst = this.active.get(s.id);
    if (inst) return inst;
    inst = this.pool[s.side].pop() ?? this.create(s.side);
    inst.soldier = s.id;
    inst.clip = '';
    inst.deathClip = null;
    inst.finished = false;
    inst.recoil = 0;
    inst.flinch = 0;
    inst.throwUntil = 0;
    inst.mixer.stopAllAction();
    inst.root.visible = true;
    this.active.set(s.id, inst);
    return inst;
  }

  private release(id: number): void {
    const inst = this.active.get(id);
    if (!inst) return;
    this.active.delete(id);
    inst.root.visible = false;
    inst.mixer.stopAllAction();
    this.pool[inst.side].push(inst);
  }

  /** Called for every soldier that should be animated this frame. */
  private pick(w: World, s: Soldier, inst: Instance): string {
    if (s.health === 'dead') {
      if (!inst.deathClip) inst.deathClip = s.stance === 'prone' ? 'death_prone' : DEATHS[s.id % DEATHS.length];
      return inst.deathClip;
    }
    if (s.health === 'incap') return 'wounded';
    if (s.state === 'surrendered') return 'surrender';
    if (s.moving) {
      if (s.state === 'panicked' || s.state === 'routing' || s.state === 'berserk' || s.moveMode === 'run') return 'run';
      return s.moveMode === 'sneak' ? 'sneak' : 'walk';
    }
    if (s.state === 'cowering') return 'cower';
    const st = s.stance === 'stand' ? 'stand' : s.stance === 'crouch' ? 'kneel' : 'prone';
    if (this.time < inst.throwUntil && st !== 'prone') return 'throw';
    const ws = s.weapons[s.wIdx];
    if (ws && ws.reloadT > 0 && ws.def.mag > 1) return `reload_${st}`;
    if (s.target || w.time - s.firedT < 2.5) return `aim_${st}`;
    return `idle_${st}`;
  }

  private play(inst: Instance, clip: string): void {
    if (inst.clip === clip) return;
    const next = inst.actions.get(clip);
    if (!next) return;
    const prev = inst.clip ? inst.actions.get(inst.clip) : null;
    next.reset();
    next.enabled = true;
    next.setEffectiveWeight(1);
    next.setEffectiveTimeScale(1);
    // desynchronise idle loops so a squad doesn't breathe in unison
    if (next.loop === THREE.LoopRepeat) next.time = ((inst.soldier * 0.37) % 1) * next.getClip().duration;
    next.play();
    if (prev) prev.crossFadeTo(next, clip.startsWith('death') ? 0.12 : FADE, false);
    inst.clip = clip;
    inst.finished = false;
  }

  private showWeapon(inst: Instance, s: Soldier): void {
    // secondary launchers are only in hand while being used
    const cur = s.weapons[s.wIdx]?.def.id ?? '';
    const primary = s.weapons[0]?.def.id ?? '';
    let want = weaponModel(primary, inst.side);
    const curModel = weaponModel(cur, inst.side);
    if ((curModel === 'launcher' || curModel === 'rpg' || curModel === 'javelin') && s.target) want = curModel;
    if (!inst.weapons.has(want)) want = 'rifle';
    // a disposable launcher carried as a secondary rides on the back until it's used
    let sling = false;
    for (let i = 1; i < s.weapons.length; i++) if (SLUNG.has(s.weapons[i].def.id) && s.weapons[i].ammo + s.weapons[i].loaded > 0) sling = true;
    sling = sling && want !== 'launcher' && want !== 'rpg';
    if (inst.slung && sling !== inst.slungShown) {
      inst.slung.visible = sling;
      inst.slungShown = sling;
    }
    if (want === inst.shownWeapon) return;
    for (const [name, obj] of inst.weapons) obj.visible = name === want;
    inst.shownWeapon = want;
  }

  /**
   * @param wanted  soldiers to animate this frame (already filtered for fog of war / budget)
   * @param animDt  game-time seconds elapsed since the last frame (0 when paused)
   */
  update(w: World, wanted: Soldier[], alpha: number, animDt: number): void {
    this.time += animDt;
    const keep = new Set<number>();
    for (const s of wanted) {
      keep.add(s.id);
      const inst = this.acquire(s);
      const x = s.px + (s.x - s.px) * alpha;
      const y = s.py + (s.y - s.py) * alpha;
      inst.root.position.set(x, w.map.groundAt(x, y), -y);
      if (s.health !== 'dead' || !inst.deathClip) inst.root.rotation.set(0, s.facing, 0);
      this.showWeapon(inst, s);
      const clip = this.pick(w, s, inst);
      this.play(inst, clip);
      const action = inst.actions.get(clip);
      if (action && CLIP_SPEED[clip]) {
        const speed = Math.hypot(s.x - s.px, s.y - s.py) / DT;
        action.setEffectiveTimeScale(Math.max(0.4, Math.min(1.8, speed / CLIP_SPEED[clip])));
      }
      if (inst.finished) continue; // corpses hold their last frame for free
      inst.mixer.update(animDt);
      if (action && action.loop === THREE.LoopOnce && !action.isRunning() && clip.startsWith('death')) inst.finished = true;
      // hit flinch: a sharp jolt through the upper body that settles over half a second
      if (inst.flinch > 0) {
        const k = Math.sin(Math.min(1, (1 - inst.flinch) * 4) * Math.PI * 0.5) * inst.flinch;
        for (const b of inst.flinchBones) {
          b.rotateX(-0.22 * k);
          b.rotateZ(0.12 * k * inst.flinchSign);
        }
        inst.flinch = Math.max(0, inst.flinch - animDt * 2);
      }
      // recoil kick along the barrel
      if (inst.recoil > 0 && inst.weaponBone) {
        const muzzle = inst.muzzles.get(inst.shownWeapon);
        if (muzzle) {
          const a = new THREE.Vector3();
          const b = new THREE.Vector3();
          inst.weaponBone.getWorldPosition(a);
          muzzle.getWorldPosition(b);
          const dir = b.sub(a).normalize().multiplyScalar(-0.045 * inst.recoil * this.scale);
          const parent = inst.weaponBone.parent!;
          const p0 = parent.worldToLocal(a.clone());
          const p1 = parent.worldToLocal(a.clone().add(dir));
          inst.weaponBone.position.add(p1.sub(p0));
        }
        inst.recoil = Math.max(0, inst.recoil - animDt * 12);
      }
    }
    for (const id of [...this.active.keys()]) if (!keep.has(id)) this.release(id);
  }

  /** A shot was fired by this soldier: kick the weapon (and throw for grenades). */
  onShot(soldierId: number, weaponCls: string): void {
    const inst = this.active.get(soldierId);
    if (!inst) return;
    if (weaponCls === 'grenade' || weaponCls === 'smoke') inst.throwUntil = this.time + 1.1;
    else inst.recoil = 1;
  }

  /** The soldier was wounded: flinch. */
  onHit(soldierId: number): void {
    const inst = this.active.get(soldierId);
    if (!inst) return;
    inst.flinch = 1;
    inst.flinchSign = Math.random() < 0.5 ? -1 : 1;
  }

  /** World-space muzzle of an animated soldier's visible weapon (for tracers and flashes). */
  muzzle(soldierId: number, out: THREE.Vector3): THREE.Vector3 | null {
    const inst = this.active.get(soldierId);
    if (!inst || !inst.shownWeapon) return null;
    const m = inst.muzzles.get(inst.shownWeapon);
    if (!m) return null;
    return m.getWorldPosition(out);
  }

  has(soldierId: number): boolean {
    return this.active.has(soldierId);
  }

  get count(): number {
    return this.active.size;
  }
}

