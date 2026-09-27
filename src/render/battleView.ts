import * as THREE from 'three';
import type { Side } from '../data/units';
import type { SimEvent } from '../sim/types';
import { WEAPONS } from '../data/weapons';
import type { World } from '../sim/world';
import { Atmosphere, LightingId, lightingForSeed } from './atmosphere';
import { RtsCamera } from './camera';
import { EffectsView } from './effects';
import { GrassField } from './grass';
import { ModelLib } from './models';
import { Overlays } from './overlays';
import { PostFX } from './post';
import { TerrainView } from './terrainView';
import { UnitView } from './unitView';

export interface GraphicsSettings {
  quality: 'low' | 'high';
  shadows: boolean;
  /** Screen-space ambient occlusion. */
  ao?: boolean;
  /** HDR bloom + colour grading (the post-processing chain). */
  post?: boolean;
  /** Grass tufts near the camera. */
  grass?: boolean;
}

/** Owns the WebGL renderer and composes all visual layers for one battle. */
export class BattleView {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly cam: RtsCamera;
  readonly terrain: TerrainView;
  readonly units: UnitView;
  readonly overlays: Overlays;
  readonly effects: EffectsView;
  readonly atmosphere: Atmosphere;
  private post: PostFX | null = null;
  private grass: GrassField | null = null;
  private time = 0;
  /** Adaptive resolution: pixel ratio bounds and a running frame-time average. */
  private prMax = 1;
  private prMin = 1;
  private frameAvg = 1 / 60;
  private prHold = 3;

  constructor(
    readonly container: HTMLElement,
    readonly world: World,
    models: ModelLib,
    readonly player: Side | null,
    gfx: GraphicsSettings,
    lighting?: LightingId,
  ) {
    const usePost = gfx.post ?? gfx.quality === 'high';
    this.renderer = new THREE.WebGLRenderer({ antialias: !usePost, powerPreference: 'high-performance' });
    // post-processing renders at 1.5x on retina displays at most (MSAA covers the rest)
    this.prMax = Math.min(window.devicePixelRatio, gfx.quality === 'high' ? (usePost ? 1.5 : 2) : 1);
    this.prMin = Math.min(this.prMax, 1);
    this.renderer.setPixelRatio(this.prMax);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.shadowMap.enabled = gfx.shadows;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.domElement.className = 'battle-canvas';
    container.appendChild(this.renderer.domElement);

    const map = world.map;
    this.cam = new RtsCamera(this.renderer.domElement);
    this.cam.bounds = { w: map.width, h: map.height };
    this.cam.groundAt = (x, y) => map.groundAt(x, y);

    // sky, sun, image-based ambient light and fog
    this.atmosphere = new Atmosphere(this.scene, this.renderer, lighting ?? lightingForSeed(world.gen.def.seed), gfx.shadows, gfx.quality);
    if (usePost) {
      this.post = new PostFX(this.renderer, this.scene, this.cam.camera, this.atmosphere.preset, {
        ao: gfx.ao ?? gfx.quality === 'high',
        bloom: true,
        // 4x MSAA on a half-float target costs ~7 ms at 1.5x DPR on Apple GPUs; 2x is nearly as clean
        msaa: gfx.quality === 'high' ? 2 : 0,
      });
    }

    this.terrain = new TerrainView(world.gen, models, gfx.quality);
    this.units = new UnitView(world, models, player);
    this.units.animBudget = gfx.quality === 'high' ? 160 : 60;
    this.overlays = new Overlays(world, player, this.units);
    this.effects = new EffectsView(this.terrain);
    this.effects.setLight(this.atmosphere.preset.smoke);
    this.terrain.vegetation?.setSun(this.atmosphere.sunDir, this.atmosphere.sun.color, this.atmosphere.sun.intensity);
    this.effects.vehicleVisible = (id) => !player || this.units.visibleUnit(world.vehicles[id].unitId);
    this.effects.onBigBang = (x, y, size) => {
      const d = Math.hypot(x - this.cam.target.x, -y - this.cam.target.z);
      if (d < 400) this.cam.addShake((size / 10) * (1 - d / 400) * Math.min(1, 300 / this.cam.dist));
    };
    this.scene.add(this.terrain.group, this.units.group, this.effects.group, this.overlays.group);
    if (gfx.grass ?? gfx.quality === 'high') {
      this.grass = new GrassField(map, this.terrain.info, this.terrain.texture);
      this.scene.add(this.grass.mesh);
    }

    // start looking at own deployment zone
    const zone = player ? world.deploy[player] : { x: 0, y: 0, w: map.width, h: map.height };
    this.cam.lookAt(zone.x + zone.w / 2, zone.y + zone.h / 2);
    if (player) {
      const enemy = world.deploy[player === 'nato' ? 'opfor' : 'nato'];
      this.cam.yaw = Math.atan2(enemy.y + enemy.h / 2 - (zone.y + zone.h / 2), enemy.x + enemy.w / 2 - (zone.x + zone.w / 2));
    }
    this.resize();
  }

  resize(): void {
    const w = this.container.clientWidth || window.innerWidth;
    const h = this.container.clientHeight || window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.renderer.domElement.style.width = `${w}px`;
    this.renderer.domElement.style.height = `${h}px`;
    this.post?.setSize(w, h);
    this.effects.setScale(h * this.renderer.getPixelRatio(), this.cam.camera.fov);
  }

  handleEvent(e: SimEvent): void {
    if (e.type === 'casualty' && e.health === 'wounded') {
      this.units.animator.onHit(e.soldier);
      return;
    }
    if (e.type === 'building') {
      // a building collapsed into rubble: rebuild the merged city geometry
      this.terrain.rebuildBuildings();
      return;
    }
    let visible = true;
    if (this.player) {
      if (e.type === 'shot' || e.type === 'launch') {
        const unitId = e.soldier >= 0 ? this.world.soldiers[e.soldier].unitId : e.vehicle >= 0 ? this.world.vehicles[e.vehicle].unitId : -1;
        visible = unitId < 0 || this.units.visibleUnit(unitId);
      }
    }
    if (e.type === 'shot' && e.vehicle >= 0) {
      this.units.onVehicleFire(e.vehicle, WEAPONS[e.weapon]?.cls ?? '');
      // flashes from the real (recoiling) barrel tip
      const m = WEAPONS[e.weapon]?.cls === 'tankgun' || WEAPONS[e.weapon]?.cls === 'autocannon' ? this.units.muzzleOf(e.vehicle) : null;
      if (m) e = { ...e, sx: m.x, sy: -m.z, sz: m.y };
    }
    if (e.type === 'shot' && e.soldier >= 0) {
      const cls = WEAPONS[e.weapon]?.cls ?? '';
      this.units.animator.onShot(e.soldier, cls);
      // start tracers and flashes at the animated rifle's muzzle
      const m = this.units.animator.muzzle(e.soldier, this.tmpV);
      if (m) e = { ...e, sx: m.x, sy: -m.z, sz: m.y };
    }
    this.effects.handle(e, this.world, visible);
  }
  private tmpV = new THREE.Vector3();

  /**
   * Keep the frame rate up on high-DPI screens: drop the render resolution in small steps while
   * frames take longer than ~45 fps, and creep back up after a sustained period at ~60 fps.
   */
  private adaptResolution(dt: number): void {
    if (dt <= 0 || dt > 0.25 || document.visibilityState !== 'visible') return;
    this.frameAvg += (dt - this.frameAvg) * 0.05;
    this.prHold -= dt;
    if (this.prHold > 0) return;
    const pr = this.renderer.getPixelRatio();
    let next = pr;
    if (this.frameAvg > 1 / 45 && pr > this.prMin) next = Math.max(this.prMin, pr - 0.125);
    else if (this.frameAvg < 1 / 57 && pr < this.prMax) next = Math.min(this.prMax, pr + 0.125);
    if (next !== pr) {
      this.renderer.setPixelRatio(next);
      this.resize();
      // give the new size time to settle; growing again is cautious
      this.prHold = next > pr ? 8 : 2;
      this.frameAvg = 1 / 60;
    } else this.prHold = 0.5;
  }

  render(dt: number, alpha: number, animDt = dt): void {
    this.time += dt;
    this.adaptResolution(dt);
    const w = this.renderer.domElement.clientWidth;
    const h = this.renderer.domElement.clientHeight;
    this.cam.update(dt, w, h);
    this.atmosphere.update(dt, this.cam.camera, this.cam.dist);

    this.units.update(alpha, this.time, this.cam.camera, animDt);
    this.overlays.update(alpha, this.time, this.cam.dist);
    this.effects.update(dt, this.world, alpha, (x, y) => !this.player || this.isPointObserved(x, y));
    this.terrain.update(dt, this.time, this.cam.camera);
    // vehicles flatten the trees and bushes they drive (or deploy) into
    const veg = this.terrain.vegetation;
    // (only vehicles the player can see: a fresh clearing would give a hidden tank away)
    if (veg) for (const v of this.world.vehicles) if (this.effects.vehicleVisible(v.id)) veg.flatten(v.x, v.y, v.def.length * 0.45 + 2.2);
    this.grass?.update(this.time, this.cam.target, this.cam.dist);
    if (this.post) this.post.render(dt);
    else this.renderer.render(this.scene, this.cam.camera);
  }

  /** Crude check whether an area is near any of our units (for off-screen effect culling). */
  isPointObserved(_x: number, _y: number): boolean {
    return true;
  }

  dispose(): void {
    this.cam.dispose();
    this.post?.dispose();
    this.atmosphere.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
    this.scene.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.geometry) m.geometry.dispose();
    });
  }
}
