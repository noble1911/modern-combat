import * as THREE from 'three';
import { WEAPONS } from '../data/weapons';
import type { SimEvent } from '../sim/types';
import { T } from '../sim/terrain';
import type { World } from '../sim/world';
import { smokePuff, softDot } from './textures';
import type { TerrainView } from './terrainView';

interface PSpawn {
  x: number;
  y: number;
  z: number;
  vx?: number;
  vy?: number;
  vz?: number;
  life: number;
  s0: number;
  s1: number;
  c0: [number, number, number, number];
  c1: [number, number, number, number];
  drag?: number;
  grav?: number;
}

const VS = `
attribute float size;
attribute vec4 pcolor;
varying vec4 vColor;
uniform float scale;
void main() {
  vColor = pcolor;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = clamp(size * scale / -mv.z, 1.0, 512.0);
  gl_Position = projectionMatrix * mv;
}`;
const FS = `
uniform sampler2D map;
uniform vec3 tint;
uniform float boost;
uniform float vshade;
varying vec4 vColor;
void main() {
  vec4 t = texture2D(map, gl_PointCoord);
  // smoke: lit from above, self-shadowed underneath (point coord y runs top to bottom)
  float lit = 1.0 + vshade * (0.35 - gl_PointCoord.y);
  gl_FragColor = vec4(vColor.rgb * tint * boost * lit, vColor.a * t.a);
  if (gl_FragColor.a < 0.004) discard;
}`;

/** Simple CPU-simulated point-sprite particle system. */
class Particles {
  readonly points: THREE.Points;
  private n = 0;
  private pos: Float32Array;
  private col: Float32Array;
  private size: Float32Array;
  private vel: Float32Array;
  private age: Float32Array;
  private life: Float32Array;
  private s01: Float32Array;
  private c0: Float32Array;
  private c1: Float32Array;
  private phys: Float32Array; // drag, grav
  private geo: THREE.BufferGeometry;
  readonly mat: THREE.ShaderMaterial;

  constructor(private max: number, tex: THREE.Texture, additive: boolean) {
    this.pos = new Float32Array(max * 3);
    this.col = new Float32Array(max * 4);
    this.size = new Float32Array(max);
    this.vel = new Float32Array(max * 3);
    this.age = new Float32Array(max);
    this.life = new Float32Array(max);
    this.s01 = new Float32Array(max * 2);
    this.c0 = new Float32Array(max * 4);
    this.c1 = new Float32Array(max * 4);
    this.phys = new Float32Array(max * 2);
    this.geo = new THREE.BufferGeometry();
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('pcolor', new THREE.BufferAttribute(this.col, 4).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('size', new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage));
    this.geo.setDrawRange(0, 0);
    this.mat = new THREE.ShaderMaterial({
      // fire is HDR-bright (> 1) so the bloom pass makes it glow; smoke takes the scene's light colour
      uniforms: { map: { value: tex }, scale: { value: 800 }, tint: { value: new THREE.Color(1, 1, 1) }, boost: { value: additive ? 2.6 : 1 }, vshade: { value: additive ? 0 : 0.7 } },
      vertexShader: VS,
      fragmentShader: FS,
      transparent: true,
      depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
    this.points = new THREE.Points(this.geo, this.mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = additive ? 3 : 2;
  }

  spawn(p: PSpawn): void {
    if (this.n >= this.max) return;
    const i = this.n++;
    this.pos[i * 3] = p.x;
    this.pos[i * 3 + 1] = p.z;
    this.pos[i * 3 + 2] = -p.y;
    this.vel[i * 3] = p.vx ?? 0;
    this.vel[i * 3 + 1] = p.vz ?? 0;
    this.vel[i * 3 + 2] = -(p.vy ?? 0);
    this.age[i] = 0;
    this.life[i] = p.life;
    this.s01[i * 2] = p.s0;
    this.s01[i * 2 + 1] = p.s1;
    this.c0.set(p.c0, i * 4);
    this.c1.set(p.c1, i * 4);
    this.phys[i * 2] = p.drag ?? 0;
    this.phys[i * 2 + 1] = p.grav ?? 0;
  }

  update(dt: number): void {
    let i = 0;
    while (i < this.n) {
      this.age[i] += dt;
      if (this.age[i] >= this.life[i]) {
        // swap-remove
        const j = --this.n;
        if (i !== j) this.copy(j, i);
        continue;
      }
      const t = this.age[i] / this.life[i];
      const drag = Math.max(0, 1 - this.phys[i * 2] * dt);
      this.vel[i * 3] *= drag;
      this.vel[i * 3 + 1] = this.vel[i * 3 + 1] * drag - this.phys[i * 2 + 1] * dt;
      this.vel[i * 3 + 2] *= drag;
      this.pos[i * 3] += this.vel[i * 3] * dt;
      this.pos[i * 3 + 1] += this.vel[i * 3 + 1] * dt;
      this.pos[i * 3 + 2] += this.vel[i * 3 + 2] * dt;
      this.size[i] = this.s01[i * 2] + (this.s01[i * 2 + 1] - this.s01[i * 2]) * t;
      for (let k = 0; k < 4; k++) this.col[i * 4 + k] = this.c0[i * 4 + k] + (this.c1[i * 4 + k] - this.c0[i * 4 + k]) * t;
      i++;
    }
    this.geo.setDrawRange(0, this.n);
    (this.geo.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    (this.geo.attributes.pcolor as THREE.BufferAttribute).needsUpdate = true;
    (this.geo.attributes.size as THREE.BufferAttribute).needsUpdate = true;
  }

  private copy(from: number, to: number): void {
    this.pos.copyWithin(to * 3, from * 3, from * 3 + 3);
    this.vel.copyWithin(to * 3, from * 3, from * 3 + 3);
    this.col.copyWithin(to * 4, from * 4, from * 4 + 4);
    this.c0.copyWithin(to * 4, from * 4, from * 4 + 4);
    this.c1.copyWithin(to * 4, from * 4, from * 4 + 4);
    this.s01.copyWithin(to * 2, from * 2, from * 2 + 2);
    this.phys.copyWithin(to * 2, from * 2, from * 2 + 2);
    this.size[to] = this.size[from];
    this.age[to] = this.age[from];
    this.life[to] = this.life[from];
  }

  get count(): number {
    return this.n;
  }
}

interface Tracer {
  sx: number;
  sy: number;
  sz: number;
  dx: number;
  dy: number;
  dz: number;
  len: number;
  t: number;
  delay: number;
  speed: number;
  streak: number;
  color: THREE.Color;
}

/** Pooled flying tracer streaks. */
class Tracers {
  readonly lines: THREE.LineSegments;
  private list: Tracer[] = [];
  private pos: Float32Array;
  private col: Float32Array;
  constructor(private max: number) {
    this.pos = new Float32Array(max * 6);
    this.col = new Float32Array(max * 6);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('color', new THREE.BufferAttribute(this.col, 3).setUsage(THREE.DynamicDrawUsage));
    this.lines = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
    this.lines.frustumCulled = false;
    this.lines.renderOrder = 4;
  }
  add(sx: number, sy: number, sz: number, ex: number, ey: number, ez: number, color: number, delay: number, speed = 900, streak = 14): void {
    if (this.list.length >= this.max) return;
    const dx = ex - sx;
    const dy = ey - sy;
    const dz = ez - sz;
    const len = Math.hypot(dx, dy, dz);
    if (len < 1) return;
    this.list.push({ sx, sy, sz, dx: dx / len, dy: dy / len, dz: dz / len, len, t: 0, delay, speed, streak, color: new THREE.Color(color) });
  }
  update(dt: number): void {
    let k = 0;
    this.list = this.list.filter((tr) => {
      if (tr.delay > 0) {
        tr.delay -= dt;
        return true;
      }
      tr.t += dt;
      return tr.t * tr.speed < tr.len + tr.streak;
    });
    for (const tr of this.list) {
      if (tr.delay > 0) continue;
      const head = Math.min(tr.len, tr.t * tr.speed);
      const tail = Math.max(0, head - tr.streak);
      const h = [tr.sx + tr.dx * head, tr.sz + tr.dz * head, -(tr.sy + tr.dy * head)];
      const t = [tr.sx + tr.dx * tail, tr.sz + tr.dz * tail, -(tr.sy + tr.dy * tail)];
      this.pos.set(h, k * 6);
      this.pos.set(t, k * 6 + 3);
      // HDR head so tracers bloom, fading to a dim tail
      this.col.set([tr.color.r * 4, tr.color.g * 4, tr.color.b * 4, tr.color.r * 0.3, tr.color.g * 0.3, tr.color.b * 0.3], k * 6);
      k++;
    }
    const g = this.lines.geometry;
    g.setDrawRange(0, k * 2);
    (g.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    (g.attributes.color as THREE.BufferAttribute).needsUpdate = true;
  }
}

const rnd = (a: number, b: number) => a + Math.random() * (b - a);

/** Rut stroke opacity per soft terrain type (hard ground leaves no marks). */
const SOFT = new Map<number, number>([
  [T.Grass, 0.1],
  [T.Field, 0.16],
  [T.Dirt, 0.12],
  [T.Marsh, 0.2],
  [T.Scrub, 0.1],
  [T.Orchard, 0.1],
  [T.Crater, 0.12],
]);

export class EffectsView {
  readonly group = new THREE.Group();
  private fire: Particles;
  private smoke: Particles;
  private tracers: Tracers;
  private lights: { l: THREE.PointLight; t: number; max: number }[] = [];
  private smokeAcc = new Map<number, number>();
  private fireAcc = new Map<number, number>();
  private dustAcc = new Map<number, number>();
  /** Last rut position per vehicle (sim metres). */
  private rutAt = new Map<number, { x: number; y: number }>();
  /** Whether the player can see a vehicle (ruts of hidden vehicles would give them away). */
  vehicleVisible: (vehicleId: number) => boolean = () => true;
  /** Flash callback for screen shake etc. */
  onBigBang: ((x: number, y: number, size: number) => void) | null = null;

  constructor(private terrain: TerrainView | null) {
    this.fire = new Particles(6000, softDot(), true);
    this.smoke = new Particles(5000, smokePuff(), false);
    this.tracers = new Tracers(1200);
    this.group.add(this.smoke.points, this.fire.points, this.tracers.lines);
    for (let i = 0; i < 6; i++) {
      const l = new THREE.PointLight(0xffaa55, 0, 60, 1.6);
      this.group.add(l);
      this.lights.push({ l, t: 0, max: 0 });
    }
  }

  /** Colour of the ambient light (smoke and dust are unlit sprites, so they are tinted instead). */
  setLight(hex: number): void {
    (this.smoke.mat.uniforms.tint.value as THREE.Color).setHex(hex);
  }

  setScale(viewportHeight: number, fovDeg: number): void {
    const s = viewportHeight / (2 * Math.tan((fovDeg * Math.PI) / 360));
    this.fire.mat.uniforms.scale.value = s;
    this.smoke.mat.uniforms.scale.value = s;
  }

  private flash(x: number, y: number, z: number, intensity: number, color = 0xffaa55): void {
    let best = this.lights[0];
    for (const L of this.lights) if (L.t <= 0 || L.max < best.max) best = L;
    best.l.position.set(x, z + 2, -y);
    best.l.color.setHex(color);
    best.max = intensity;
    best.t = 0.18;
    best.l.intensity = intensity;
  }

  /** Visible = whether the player can see the source (fog of war). */
  handle(e: SimEvent, world: World, visibleShooter: boolean): void {
    switch (e.type) {
      case 'shot': {
        const def = WEAPONS[e.weapon];
        if (!def) return;
        if (!visibleShooter && Math.random() < 0.6) return;
        const every = def.tracerEvery ?? 1;
        const rounds = Math.max(1, e.rounds);
        // muzzle flash
        const big = def.cls === 'tankgun';
        this.fire.spawn({ x: e.sx, y: e.sy, z: e.sz, life: big ? 0.12 : 0.06, s0: big ? 5 : def.cls === 'autocannon' ? 2.2 : 1.1, s1: big ? 7 : 1.5, c0: [1, 0.85, 0.5, 1], c1: [1, 0.4, 0.1, 0] });
        if (big) {
          this.flash(e.sx, e.sy, e.sz, 60, 0xffcc88);
          for (let i = 0; i < 10; i++) this.smoke.spawn({ x: e.sx, y: e.sy, z: e.sz - 1.5, vx: rnd(-4, 4), vy: rnd(-4, 4), vz: rnd(0.5, 2), life: rnd(1.5, 3), s0: 3, s1: 9, c0: [0.75, 0.72, 0.65, 0.5], c1: [0.8, 0.78, 0.72, 0], drag: 1.5 });
        }
        if (def.tracer === undefined || e.rounds === 0) return;
        for (let i = 0; i < rounds; i++) {
          if (i % every !== 0 && def.cls !== 'autocannon' && def.cls !== 'tankgun') continue;
          const jx = (Math.random() - 0.5) * 1.5;
          const jy = (Math.random() - 0.5) * 1.5;
          const speed = def.cls === 'tankgun' ? 1600 : def.cls === 'autocannon' ? 1000 : 850;
          this.tracers.add(e.sx, e.sy, e.sz, e.tx + jx, e.ty + jy, e.tz + Math.random() * 0.6, def.tracer, i * e.interval, speed, def.cls === 'tankgun' ? 30 : 12);
        }
        return;
      }
      case 'launch': {
        const def = WEAPONS[e.weapon];
        if (!def) return;
        if (def.cls === 'rocket' || def.cls === 'atgm') {
          // backblast
          for (let i = 0; i < 12; i++) this.smoke.spawn({ x: e.x, y: e.y, z: e.z, vx: rnd(-5, 5), vy: rnd(-5, 5), vz: rnd(0, 2), life: rnd(1.5, 3), s0: 1.5, s1: 6, c0: [0.8, 0.78, 0.74, 0.55], c1: [0.85, 0.83, 0.8, 0], drag: 2 });
          this.fire.spawn({ x: e.x, y: e.y, z: e.z, life: 0.15, s0: 3, s1: 4, c0: [1, 0.8, 0.5, 1], c1: [1, 0.4, 0.1, 0] });
        } else if (def.cls === 'mortar') {
          this.fire.spawn({ x: e.x, y: e.y, z: e.z + 1, life: 0.1, s0: 2, s1: 3, c0: [1, 0.8, 0.5, 1], c1: [1, 0.4, 0.1, 0] });
          for (let i = 0; i < 5; i++) this.smoke.spawn({ x: e.x, y: e.y, z: e.z + 1, vx: rnd(-1, 1), vy: rnd(-1, 1), vz: rnd(1, 3), life: 2, s0: 1, s1: 4, c0: [0.8, 0.78, 0.74, 0.45], c1: [0.85, 0.83, 0.8, 0], drag: 1 });
        }
        return;
      }
      case 'explosion':
        this.explosion(e.x, e.y, e.z, e.size, e.kind);
        return;
      case 'impact':
        if (e.kind === 'dirt') this.dust(e.x, e.y, e.z, 1);
        else if (e.kind === 'ricochet' || e.kind === 'bounce') {
          for (let i = 0; i < (e.kind === 'bounce' ? 14 : 4); i++)
            this.fire.spawn({ x: e.x, y: e.y, z: e.z, vx: rnd(-12, 12), vy: rnd(-12, 12), vz: rnd(2, 10), life: rnd(0.2, 0.5), s0: 0.5, s1: 0.2, c0: [1, 0.85, 0.5, 1], c1: [1, 0.5, 0.1, 0], grav: 18 });
        } else if (e.kind === 'penetrate') {
          this.fire.spawn({ x: e.x, y: e.y, z: e.z, life: 0.25, s0: 4, s1: 6, c0: [1, 0.9, 0.7, 1], c1: [1, 0.4, 0.1, 0] });
        }
        return;
      case 'vehicleKilled':
        return;
    }
  }

  private dust(x: number, y: number, z: number, s: number): void {
    for (let i = 0; i < 3 * s; i++) this.smoke.spawn({ x, y, z, vx: rnd(-1, 1), vy: rnd(-1, 1), vz: rnd(1, 3) * s, life: rnd(0.6, 1.2), s0: 0.6 * s, s1: 2 * s, c0: [0.5, 0.42, 0.3, 0.55], c1: [0.55, 0.48, 0.38, 0], drag: 2, grav: 2 });
  }

  explosion(x: number, y: number, z: number, size: number, kind: string): void {
    if (kind === 'smoke') {
      for (let i = 0; i < 8; i++) this.smoke.spawn({ x, y, z, vx: rnd(-8, 8), vy: rnd(-8, 8), vz: rnd(2, 5), life: 2, s0: 1, s1: 5, c0: [0.9, 0.9, 0.88, 0.6], c1: [0.9, 0.9, 0.88, 0], drag: 2 });
      return;
    }
    if (kind === 'small') {
      this.dust(x, y, z, 1.5);
      this.fire.spawn({ x, y, z: z + 0.5, life: 0.15, s0: 2, s1: 3, c0: [1, 0.8, 0.4, 1], c1: [1, 0.3, 0, 0] });
      return;
    }
    if (kind === 'aps') {
      this.fire.spawn({ x, y, z, life: 0.2, s0: 5, s1: 8, c0: [1, 1, 0.8, 1], c1: [1, 0.5, 0.1, 0] });
      for (let i = 0; i < 20; i++) this.fire.spawn({ x, y, z, vx: rnd(-25, 25), vy: rnd(-25, 25), vz: rnd(-5, 15), life: rnd(0.2, 0.5), s0: 0.6, s1: 0.2, c0: [1, 0.9, 0.6, 1], c1: [1, 0.5, 0.1, 0], grav: 10 });
      this.flash(x, y, z, 40, 0xffeecc);
      return;
    }
    const s = Math.max(1, size);
    const big = kind === 'artillery' || kind === 'vehicle';
    // flash + fireball
    this.fire.spawn({ x, y, z: z + s * 0.3, life: 0.12, s0: s * 2.5, s1: s * 3.5, c0: [1, 0.95, 0.8, 1], c1: [1, 0.6, 0.2, 0] });
    const nf = Math.min(18, 4 + s * 1.5);
    for (let i = 0; i < nf; i++) {
      this.fire.spawn({ x: x + rnd(-s, s) * 0.4, y: y + rnd(-s, s) * 0.4, z: z + rnd(0, s * 0.5), vx: rnd(-s, s) * 1.5, vy: rnd(-s, s) * 1.5, vz: rnd(1, 4) * s * 0.6, life: rnd(0.25, 0.6), s0: s * 0.9, s1: s * 1.6, c0: [1, 0.7, 0.25, 0.9], c1: [0.6, 0.15, 0.02, 0], drag: 3 });
    }
    // dark smoke column / dust
    const ns = Math.min(24, 5 + s * 2);
    const dark = kind === 'vehicle' || kind === 'at' || kind === 'drone';
    for (let i = 0; i < ns; i++) {
      const c = dark ? 0.12 + Math.random() * 0.1 : 0.35 + Math.random() * 0.15;
      this.smoke.spawn({
        x: x + rnd(-s, s) * 0.5, y: y + rnd(-s, s) * 0.5, z: z + rnd(0, s * 0.4),
        vx: rnd(-s, s) * 0.8, vy: rnd(-s, s) * 0.8, vz: rnd(1, 5) * (big ? 2 : 1),
        life: rnd(2.5, big ? 8 : 5), s0: s * 0.8, s1: s * (big ? 4 : 2.8),
        c0: [c, c * 0.95, c * 0.9, 0.75], c1: [c + 0.2, c + 0.18, c + 0.15, 0], drag: 1.2,
      });
    }
    // debris
    const nd = Math.min(24, s * 3);
    for (let i = 0; i < nd; i++) this.smoke.spawn({ x, y, z, vx: rnd(-1, 1) * s * 4, vy: rnd(-1, 1) * s * 4, vz: rnd(3, 9) * Math.sqrt(s), life: rnd(0.6, 1.4), s0: 0.5, s1: 0.4, c0: [0.2, 0.16, 0.12, 1], c1: [0.2, 0.16, 0.12, 0.6], grav: 22 });
    this.flash(x, y, z, 30 + s * 12);
    if (s >= 4 && this.terrain && kind !== 'aps') this.terrain.scorch(x, y, s * 0.7);
    if (s >= 6) this.onBigBang?.(x, y, s);
  }

  update(dt: number, world: World, alpha: number, visible: (x: number, y: number) => boolean): void {
    // projectile trails
    for (const p of world.projectiles) {
      if (p.t < 0) continue;
      const cls = p.weapon.cls;
      const x = p.px + (p.x - p.px) * alpha;
      const y = p.py + (p.y - p.py) * alpha;
      const z = p.pz + (p.z - p.pz) * alpha;
      if (cls === 'rocket' || cls === 'atgm') {
        this.fire.spawn({ x, y, z, life: 0.08, s0: 1.4, s1: 0.8, c0: [1, 0.9, 0.6, 1], c1: [1, 0.5, 0.1, 0] });
        if (Math.random() < 0.8) this.smoke.spawn({ x, y, z, vx: rnd(-0.3, 0.3), vy: rnd(-0.3, 0.3), vz: rnd(0, 0.6), life: rnd(1.2, 2.2), s0: 0.8, s1: 3.5, c0: [0.85, 0.85, 0.82, 0.5], c1: [0.9, 0.9, 0.88, 0], drag: 0.5 });
      } else if (p.kind === 'artillery' && p.z - world.map.groundAt(x, y) < 120) {
        this.fire.spawn({ x, y, z, life: 0.05, s0: 0.8, s1: 0.5, c0: [1, 0.8, 0.5, 0.6], c1: [1, 0.5, 0.2, 0] });
      } else if (cls === 'gl' || cls === 'agl' || cls === 'grenade' || cls === 'smoke') {
        this.fire.spawn({ x, y, z, life: 0.05, s0: 0.35, s1: 0.3, c0: [0.3, 0.3, 0.3, 0.9], c1: [0.3, 0.3, 0.3, 0] });
      }
    }
    // drones glow (rotor blur)
    // smoke screens
    for (const c of world.map.smoke) {
      const fade = c.age > c.life - 10 ? Math.max(0, (c.life - c.age) / 10) : 1;
      const rate = ((c.r * c.r) / 30) * fade;
      const acc = (this.smokeAcc.get(c.id) ?? 0) + rate * dt;
      let n = Math.floor(acc);
      this.smokeAcc.set(c.id, acc - n);
      while (n-- > 0) {
        const a = Math.random() * Math.PI * 2;
        const r = Math.sqrt(Math.random()) * c.r;
        const x = c.x + Math.cos(a) * r;
        const y = c.y + Math.sin(a) * r;
        const g = world.map.groundAt(x, y);
        const v = 0.78 + Math.random() * 0.12;
        this.smoke.spawn({ x, y, z: g + rnd(1, 4), vx: c.vx, vy: c.vy, vz: rnd(0.1, 0.4), life: rnd(8, 12), s0: 9, s1: 16, c0: [v, v, v, 0.42], c1: [v, v, v, 0], drag: 0.2 });
      }
    }
    // ruts in soft ground: two strokes along the tracks / wheels every metre and a half
    if (this.terrain) {
      for (const v of world.vehicles) {
        if (v.destroyed) continue;
        const last = this.rutAt.get(v.id);
        if (!last) {
          this.rutAt.set(v.id, { x: v.x, y: v.y });
          continue;
        }
        const d = Math.hypot(v.x - last.x, v.y - last.y);
        if (d < 1.5) continue;
        if (d < 12 && this.vehicleVisible(v.id)) {
          const tt = world.map.typeAt(v.x, v.y);
          const soft = SOFT.get(tt);
          if (soft) {
            const c = Math.cos(v.heading);
            const s = Math.sin(v.heading);
            const tracked = v.def.mobility === 'track';
            const half = v.def.width * (tracked ? 0.36 : 0.4);
            const w = tracked ? 0.55 : 0.32;
            for (const side of [-1, 1]) {
              const ox = -s * half * side;
              const oy = c * half * side;
              this.terrain.rut(last.x + ox, last.y + oy, v.x + ox, v.y + oy, w, soft);
            }
          }
        }
        this.rutAt.set(v.id, { x: v.x, y: v.y });
      }
    }
    // dust thrown up by moving vehicles, exhaust when pulling away
    for (const v of world.vehicles) {
      if (v.destroyed || Math.abs(v.speed) < 1.2 || !visible(v.x, v.y)) continue;
      const tt = world.map.typeAt(v.x, v.y);
      const onRoad = tt === T.Road || tt === T.Bridge;
      const rate = Math.abs(v.speed) * (onRoad ? 0.5 : 2.2) * dt;
      const acc = (this.dustAcc.get(v.id) ?? 0) + rate;
      let n = Math.floor(acc);
      this.dustAcc.set(v.id, acc - n);
      const c = Math.cos(v.heading);
      const s = Math.sin(v.heading);
      const back = -Math.sign(v.speed) * v.def.length * 0.45;
      while (n-- > 0) {
        const side = (Math.random() < 0.5 ? -1 : 1) * v.def.width * 0.4;
        const x = v.x + c * back - s * side;
        const y = v.y + s * back + c * side;
        const g = world.map.groundAt(x, y);
        const t = 0.55 + Math.random() * 0.1;
        this.smoke.spawn({ x, y, z: g + 0.3, vx: rnd(-0.6, 0.6), vy: rnd(-0.6, 0.6), vz: rnd(0.3, 1.1), life: rnd(1.8, 3.2), s0: 1.2, s1: 5.5, c0: [t, t * 0.9, t * 0.72, 0.35], c1: [t, t * 0.92, t * 0.78, 0], drag: 0.8 });
      }
      if (Math.random() < dt * (Math.abs(v.speed) < 4 ? 5 : 1.5)) {
        const x = v.x - c * v.def.length * 0.5;
        const y = v.y - s * v.def.length * 0.5;
        this.smoke.spawn({ x, y, z: world.map.groundAt(x, y) + v.def.height * 0.7, vx: -c * 0.8, vy: -s * 0.8, vz: rnd(0.5, 1.2), life: rnd(1, 2), s0: 0.6, s1: 2.6, c0: [0.22, 0.22, 0.22, 0.35], c1: [0.35, 0.35, 0.35, 0], drag: 0.6 });
      }
    }
    // burning wrecks
    for (const v of world.vehicles) {
      if (v.burning <= 0 || !visible(v.x, v.y)) continue;
      const acc = (this.fireAcc.get(v.id) ?? 0) + dt * 14;
      let n = Math.floor(acc);
      this.fireAcc.set(v.id, acc - n);
      const g = world.map.groundAt(v.x, v.y) + v.def.height * 0.8;
      while (n-- > 0) {
        this.fire.spawn({ x: v.x + rnd(-1.2, 1.2), y: v.y + rnd(-1.2, 1.2), z: g, vx: rnd(-0.5, 0.5), vy: rnd(-0.5, 0.5), vz: rnd(2, 4), life: rnd(0.4, 0.8), s0: 2.2, s1: 0.8, c0: [1, 0.6, 0.15, 0.9], c1: [0.7, 0.15, 0.02, 0] });
        if (Math.random() < 0.45) this.smoke.spawn({ x: v.x, y: v.y, z: g + 1.5, vx: rnd(-0.4, 0.4) + 0.4, vy: rnd(-0.4, 0.4), vz: rnd(3, 5), life: rnd(5, 9), s0: 2, s1: 11, c0: [0.08, 0.08, 0.08, 0.7], c1: [0.25, 0.25, 0.25, 0], drag: 0.3 });
      }
    }
    this.fire.update(dt);
    this.smoke.update(dt);
    this.tracers.update(dt);
    for (const L of this.lights) {
      if (L.t > 0) {
        L.t -= dt;
        L.l.intensity = Math.max(0, (L.t / 0.18) * L.max);
      } else L.l.intensity = 0;
    }
  }

  stats(): string {
    return `fx ${this.fire.count}/${this.smoke.count}`;
  }
}
