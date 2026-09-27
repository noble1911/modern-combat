import * as THREE from 'three';
import type { GeneratedMap } from '../sim/mapgen';
import { Rng } from '../sim/math';
import { CELL, T, TERRAIN, TerrainMap } from '../sim/terrain';
import { GeoBuilder } from './geo';
import { applyGroundDetail, terrainInfoTexture } from './groundDetail';
import { ModelLib } from './models';
import { facadeTextures } from './facades';
import { waterMaterial } from './water';
import { noiseCanvas } from './textures';
import { Vegetation, type VegKind, type VegPlacement } from './vegetation';

const WALL_COLORS = [0xd9cfb8, 0xb5835a, 0x9c9c94, 0xc9b48a, 0x8f5f45, 0xe0ddd2, 0xa89f8a];
const ROOF_COLORS = [0x7a3b2e, 0x4a4a4a, 0x5e3a2a, 0x6b4a3a, 0x3f4a50];
/** WALL_COLORS entries drawn as brick rather than render. */
const BRICK_STYLES = [1, 4];
const DOOR_COLORS = [0x4a3526, 0x2f3e36, 0x5a2a24, 0x3a3f4a, 0x6b5a44];

/** Static world geometry: ground, water, bridges, buildings, hedgerows, trees. */
export class TerrainView {
  readonly group = new THREE.Group();
  readonly canvas: HTMLCanvasElement;
  readonly texture: THREE.CanvasTexture;
  private painter: MapPainter;
  private map: TerrainMap;
  private gen: GeneratedMap;
  private buildingGroup = new THREE.Group();
  private wallMat: THREE.MeshStandardMaterial;
  private brickMat: THREE.MeshStandardMaterial;
  private roofMat: THREE.MeshStandardMaterial;
  private plainMat: THREE.MeshStandardMaterial;
  private dirty = false;
  private dirtyT = 0;
  private waterTime = { value: 0 };
  vegetation: Vegetation | null = null;
  /** Per-cell terrain info (detail / bump / grass density / litter) for ground shaders. */
  readonly info: THREE.Texture;
  /** Minimap image (small copy of the terrain texture). */
  readonly minimap: HTMLCanvasElement;

  constructor(gen: GeneratedMap, private models: ModelLib, quality: 'low' | 'high' = 'high') {
    this.gen = gen;
    this.map = gen.map;
    this.painter = new MapPainter(gen, quality === 'high' ? 4096 : 2048);
    this.canvas = this.painter.canvas;
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.anisotropy = 8;
    this.info = terrainInfoTexture(gen);
    this.minimap = document.createElement('canvas');
    this.minimap.width = this.minimap.height = 256;
    this.refreshMinimap();

    const fx = facadeTextures();
    this.wallMat = new THREE.MeshStandardMaterial({ ...fx.plaster, vertexColors: true, roughness: 1, metalness: 0, normalScale: new THREE.Vector2(1, 1) });
    this.brickMat = new THREE.MeshStandardMaterial({ ...fx.brick, vertexColors: true, roughness: 1, metalness: 0 });
    this.roofMat = new THREE.MeshStandardMaterial({ ...fx.roof, vertexColors: true, roughness: 1, metalness: 0 });
    this.plainMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, flatShading: true });

    this.buildGround();
    this.buildWater();
    this.buildBridges();
    this.group.add(this.buildingGroup);
    this.rebuildBuildings();
    this.buildLinear();
    this.buildTrees(quality);
  }

  /** Scorch mark / crater on the ground texture. */
  scorch(x: number, y: number, r: number): void {
    this.painter.scorch(x, y, r);
    this.dirty = true;
  }

  /** Tyre / track ruts from a to b (sim metres) on the ground texture. */
  rut(ax: number, ay: number, bx: number, by: number, width: number, alpha: number): void {
    this.painter.rut(ax, ay, bx, by, width, alpha);
    this.dirty = true;
  }

  update(dt: number, time: number, camera?: THREE.Camera): void {
    if (camera) this.vegetation?.update(dt, time, camera);
    this.dirtyT -= dt;
    if (this.dirty && this.dirtyT <= 0) {
      this.texture.needsUpdate = true;
      this.dirty = false;
      this.dirtyT = 0.5;
      this.refreshMinimap();
    }
    this.waterTime.value = time;
  }

  private refreshMinimap(): void {
    const g = this.minimap.getContext('2d')!;
    g.drawImage(this.canvas, 0, 0, 256, 256);
  }

  // ------------------------------------------------------------------ meshes
  private buildGround(): void {
    const { map } = this;
    const W = map.w + 1;
    const H = map.h + 1;
    const pos = new Float32Array(W * H * 3);
    const uv = new Float32Array(W * H * 2);
    for (let iy = 0; iy < H; iy++) {
      for (let ix = 0; ix < W; ix++) {
        const k = iy * W + ix;
        pos[k * 3] = ix * CELL;
        pos[k * 3 + 1] = map.cornerElev(ix, iy);
        pos[k * 3 + 2] = -iy * CELL;
        uv[k * 2] = ix / map.w;
        uv[k * 2 + 1] = iy / map.h;
      }
    }
    const idx: number[] = [];
    for (let iy = 0; iy < map.h; iy++) {
      for (let ix = 0; ix < map.w; ix++) {
        const a = iy * W + ix;
        const b = a + 1;
        const c = a + W;
        const d = c + 1;
        idx.push(a, b, d, a, d, c);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    g.setIndex(idx);
    g.computeVertexNormals();
    const mat = new THREE.MeshStandardMaterial({ map: this.texture, roughness: 0.97, metalness: 0 });
    applyGroundDetail(mat, this.info);
    const mesh = new THREE.Mesh(g, mat);
    mesh.receiveShadow = true;
    mesh.name = 'ground';
    this.group.add(mesh);
    // surrounding countryside so the map edge doesn't float in a void: an apron slopes from the
    // map edge down to a flat skirt, its UVs clamped to the edge so the border texels stretch out
    let minE = Infinity;
    for (let i = 0; i < map.elev.length; i++) minE = Math.min(minE, map.elev[i]);
    const skirtY = minE - 1.5;
    const A = 60; // apron width, m
    const apos: number[] = [];
    const auv: number[] = [];
    const aidx: number[] = [];
    const ring: [number, number][] = [];
    for (let ix = 0; ix < W; ix++) ring.push([ix, 0]);
    for (let iy = 1; iy < H; iy++) ring.push([W - 1, iy]);
    for (let ix = W - 2; ix >= 0; ix--) ring.push([ix, H - 1]);
    for (let iy = H - 2; iy > 0; iy--) ring.push([0, iy]);
    for (const [ix, iy] of ring) {
      const x = ix * CELL;
      const y = iy * CELL;
      // outward direction (corners go diagonally)
      const ox = ix === 0 ? -1 : ix === W - 1 ? 1 : 0;
      const oy = iy === 0 ? -1 : iy === H - 1 ? 1 : 0;
      apos.push(x, map.cornerElev(ix, iy), -y, x + ox * A, skirtY, -(y + oy * A));
      auv.push(ix / map.w, iy / map.h, ix / map.w, iy / map.h);
    }
    const n = ring.length;
    for (let i = 0; i < n; i++) {
      const a = i * 2;
      const b = ((i + 1) % n) * 2;
      aidx.push(a, a + 1, b + 1, a, b + 1, b);
    }
    const ag = new THREE.BufferGeometry();
    ag.setAttribute('position', new THREE.Float32BufferAttribute(apos, 3));
    ag.setAttribute('uv', new THREE.Float32BufferAttribute(auv, 2));
    ag.setIndex(aidx);
    ag.computeVertexNormals();
    const apron = new THREE.Mesh(ag, new THREE.MeshStandardMaterial({ map: this.texture, roughness: 0.97, metalness: 0, side: THREE.DoubleSide }));
    apron.receiveShadow = true;
    this.group.add(apron);
    // skirt in the average colour of the map's border
    const probe = document.createElement('canvas');
    probe.width = probe.height = 1;
    const pg = probe.getContext('2d')!;
    const S = this.canvas.width;
    const edge = 24;
    let r = 0;
    let gg = 0;
    let bb = 0;
    for (const [sx, sy, sw, sh] of [[0, 0, S, edge], [0, S - edge, S, edge], [0, 0, edge, S], [S - edge, 0, edge, S]]) {
      pg.drawImage(this.canvas, sx, sy, sw, sh, 0, 0, 1, 1);
      const d = pg.getImageData(0, 0, 1, 1).data;
      r += d[0] / 4;
      gg += d[1] / 4;
      bb += d[2] / 4;
    }
    const skirtCol = new THREE.Color().setRGB(r / 255, gg / 255, bb / 255, THREE.SRGBColorSpace);
    const skirt = new THREE.Mesh(new THREE.PlaneGeometry(9000, 9000), new THREE.MeshStandardMaterial({ color: skirtCol, roughness: 1 }));
    skirt.rotation.x = -Math.PI / 2;
    skirt.position.set(map.width / 2, skirtY - 0.05, -map.height / 2);
    skirt.receiveShadow = true;
    this.group.add(skirt);
  }

  private buildWater(): void {
    for (const r of this.gen.rivers) {
      const pts = r.pts;
      const hw = r.width / 2 + CELL * 1.5;
      const pos: number[] = [];
      const uv: number[] = [];
      const bank: number[] = [];
      let along = 0;
      for (let i = 0; i < pts.length; i++) {
        const a = pts[Math.max(0, i - 1)];
        const b = pts[Math.min(pts.length - 1, i + 1)];
        let dx = b.x - a.x;
        let dy = b.y - a.y;
        const l = Math.hypot(dx, dy) || 1;
        dx /= l;
        dy /= l;
        // extend ends beyond map edges
        let px = pts[i].x;
        let py = pts[i].y;
        if (i === 0) {
          px -= dx * 60;
          py -= dy * 60;
        }
        if (i === pts.length - 1) {
          px += dx * 60;
          py += dy * 60;
        }
        if (i > 0) along += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
        // left bank then right bank
        pos.push(px - dy * hw, r.level, -(py + dx * hw), px + dy * hw, r.level, -(py - dx * hw));
        uv.push(0, along / 8, (hw * 2) / 8, along / 8);
        bank.push(0, 1);
      }
      const idx: number[] = [];
      for (let i = 0; i < pts.length - 1; i++) {
        const l0 = i * 2;
        const r0 = l0 + 1;
        const l1 = l0 + 2;
        const r1 = l0 + 3;
        idx.push(r0, r1, l1, r0, l1, l0);
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.setAttribute('normal', new THREE.Float32BufferAttribute(new Array(pos.length).fill(0).map((_, i) => (i % 3 === 1 ? 1 : 0)), 3));
      g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
      g.setAttribute('bank', new THREE.Float32BufferAttribute(bank, 1));
      g.setIndex(idx);
      g.computeBoundingSphere();
      const m = new THREE.Mesh(g, waterMaterial(this.waterTime));
      m.receiveShadow = true;
      m.renderOrder = 1;
      this.group.add(m);
    }
  }

  private buildBridges(): void {
    const gb = new GeoBuilder();
    const concrete = new THREE.Color(0x8d8a82);
    const asphalt = new THREE.Color(0x5b5b57);
    const rail = new THREE.Color(0x6e6c66);
    for (const b of this.gen.bridges) {
      const dx = b.x2 - b.x1;
      const dy = b.y2 - b.y1;
      const len = Math.hypot(dx, dy);
      const ang = Math.atan2(dy, dx);
      const cx = (b.x1 + b.x2) / 2;
      const cy = (b.y1 + b.y2) / 2;
      gb.box(cx, b.deck - 0.55, -cy, len, 1.1, b.width + 1, concrete, ang);
      gb.box(cx, b.deck + 0.02, -cy, len, 0.05, b.width - 0.4, asphalt, ang);
      for (const side of [-1, 1]) {
        const ox = -Math.sin(ang) * side * (b.width / 2 + 0.3);
        const oy = Math.cos(ang) * side * (b.width / 2 + 0.3);
        gb.box(cx + ox, b.deck + 0.55, -(cy + oy), len, 1.0, 0.35, rail, ang);
      }
      // piers
      const n = Math.max(1, Math.floor(len / 30));
      for (let i = 1; i < n + 1; i++) {
        const t = i / (n + 1);
        const px = b.x1 + dx * t;
        const py = b.y1 + dy * t;
        const g0 = this.map.cornerElev(Math.round(px / CELL), Math.round(py / CELL)) - 4;
        const h = b.deck - 1 - g0;
        gb.box(px, g0 + h / 2, -py, 2.2, h, b.width * 0.8, concrete, ang);
      }
    }
    if (gb.empty) return;
    const m = new THREE.Mesh(gb.build(), this.plainMat);
    m.castShadow = true;
    m.receiveShadow = true;
    this.group.add(m);
  }

  /** (Re)build merged building geometry – called again when a building is destroyed. */
  rebuildBuildings(): void {
    for (const c of [...this.buildingGroup.children]) {
      this.buildingGroup.remove(c);
      (c as THREE.Mesh).geometry?.dispose();
    }
    const plaster = new GeoBuilder();
    const bricks = new GeoBuilder();
    const roofs = new GeoBuilder();
    const rubble = new GeoBuilder();
    const trim = new GeoBuilder();
    const map = this.map;
    for (const b of map.buildings) {
      const rng = new Rng(b.id * 7919 + 13);
      const x0 = b.cx * CELL + 0.35;
      const x1 = (b.cx + b.cw) * CELL - 0.35;
      const y0 = b.cy * CELL + 0.35;
      const y1 = (b.cy + b.ch) * CELL - 0.35;
      const gz = Math.min(map.groundAt(x0, y0), map.groundAt(x1, y0), map.groundAt(x0, y1), map.groundAt(x1, y1)) - 0.4;
      const gc = map.groundAt((x0 + x1) / 2, (y0 + y1) / 2);
      if (b.destroyed) {
        const col = new THREE.Color(0x7a7066);
        for (let i = 0; i < 7; i++) {
          const w = 2 + rng.next() * 4;
          const d = 2 + rng.next() * 4;
          const h = 0.6 + rng.next() * 1.6;
          const c2 = col.clone().offsetHSL(0, 0, (rng.next() - 0.5) * 0.12);
          rubble.box(x0 + rng.next() * (x1 - x0), gz + h / 2, -(y0 + rng.next() * (y1 - y0)), w, h, d, c2, rng.next() * 3);
        }
        // a standing wall stub
        rubble.box(x0 + 1, gz + 2, -(y0 + (y1 - y0) / 2), 0.5, 4 * rng.next() + 1, (y1 - y0) * 0.6, col);
        continue;
      }
      const wi = b.style % WALL_COLORS.length;
      const walls = BRICK_STYLES.includes(wi) ? bricks : plaster;
      const wallCol = new THREE.Color(WALL_COLORS[wi]).offsetHSL(0, 0, (rng.next() - 0.5) * 0.06);
      if (walls === bricks) wallCol.multiplyScalar(1.35);
      const roofCol = new THREE.Color(ROOF_COLORS[(b.style * 3 + b.id) % ROOF_COLORS.length]);
      const top = gc + b.height - (b.floors <= 2 ? 1.2 : 0);
      const P = (x: number, y: number, z: number) => new THREE.Vector3(x, z, -y);
      const floorsH = 3.2;
      // four walls, UV: 1 unit = one 4 m window bay horizontally, one floor vertically
      const wall = (ax: number, ay: number, bx: number, by: number) => {
        const len = Math.hypot(bx - ax, by - ay);
        const hu = len / 4;
        const hv = (top - gz) / floorsH;
        walls.quad(P(ax, ay, gz), P(bx, by, gz), P(bx, by, top), P(ax, ay, top), wallCol, [[0, 0], [hu, 0], [hu, hv], [0, hv]]);
      };
      wall(x0, y0, x1, y0);
      wall(x1, y0, x1, y1);
      wall(x1, y1, x0, y1);
      wall(x0, y1, x0, y0);
      // plinth, and a door or two between the ground-floor windows of the long walls
      const plinthCol = new THREE.Color(0x6f6a62).offsetHSL(0, 0, (rng.next() - 0.5) * 0.05);
      const doorCol = new THREE.Color(DOOR_COLORS[(b.id * 5) % DOOR_COLORS.length]);
      const edges: [number, number, number, number][] = [[x0, y0, x1, y0], [x1, y0, x1, y1], [x1, y1, x0, y1], [x0, y1, x0, y0]];
      const pTop = gc + 0.55;
      for (const [ax, ay, bx, by] of edges) {
        const len = Math.hypot(bx - ax, by - ay);
        const nx = (by - ay) / len;
        const ny = -(bx - ax) / len;
        const o = 0.06;
        trim.quad(P(ax + nx * o, ay + ny * o, gz), P(bx + nx * o, by + ny * o, gz), P(bx + nx * o, by + ny * o, pTop), P(ax + nx * o, ay + ny * o, pTop), plinthCol);
        trim.quad(P(ax + nx * o, ay + ny * o, pTop), P(bx + nx * o, by + ny * o, pTop), P(bx, by, pTop + 0.02), P(ax, ay, pTop + 0.02), plinthCol);
        const bays = Math.floor(len / 4);
        if (bays >= 2 && (rng.chance(0.6) || len === Math.max(x1 - x0, y1 - y0))) {
          const k = 1 + rng.int(0, bays - 2);
          const t = (k * 4) / len;
          const cx = ax + (bx - ax) * t;
          const cy = ay + (by - ay) * t;
          const g0 = map.groundAt(cx, cy);
          const dx = (bx - ax) / len;
          const dy = (by - ay) / len;
          const hw = 0.55;
          const d = 0.05;
          // frame, door leaf and a step
          trim.quad(P(cx - dx * (hw + 0.12) + nx * d, cy - dy * (hw + 0.12) + ny * d, g0), P(cx + dx * (hw + 0.12) + nx * d, cy + dy * (hw + 0.12) + ny * d, g0), P(cx + dx * (hw + 0.12) + nx * d, cy + dy * (hw + 0.12) + ny * d, g0 + 2.42), P(cx - dx * (hw + 0.12) + nx * d, cy - dy * (hw + 0.12) + ny * d, g0 + 2.42), new THREE.Color(0xe4e0d6));
          trim.quad(P(cx - dx * hw + nx * (d + 0.01), cy - dy * hw + ny * (d + 0.01), g0 + 0.2), P(cx + dx * hw + nx * (d + 0.01), cy + dy * hw + ny * (d + 0.01), g0 + 0.2), P(cx + dx * hw + nx * (d + 0.01), cy + dy * hw + ny * (d + 0.01), g0 + 2.3), P(cx - dx * hw + nx * (d + 0.01), cy - dy * hw + ny * (d + 0.01), g0 + 2.3), doorCol);
          trim.box(cx + nx * 0.35, g0 + 0.08, -(cy + ny * 0.35), Math.abs(dx) * 1.6 + Math.abs(nx) * 0.6, 0.22, Math.abs(dy) * 1.6 + Math.abs(ny) * 0.6, new THREE.Color(0x8a867e));
        }
      }
      if (b.floors <= 2) {
        // gable roof along the longer axis
        const alongX = x1 - x0 >= y1 - y0;
        const span = alongX ? y1 - y0 : x1 - x0;
        const rh = Math.max(1.8, span * 0.38);
        const o = 0.4; // overhang
        // gable ends: rendered (or weatherboarded on brick houses) in a plain colour
        const gableCol = walls === bricks ? new THREE.Color(0x8a7e6c).offsetHSL(0, 0, (rng.next() - 0.5) * 0.1) : wallCol.clone().multiplyScalar(0.8);
        if (alongX) {
          const ym = (y0 + y1) / 2;
          roofs.quad(P(x0 - o, y0 - o, top), P(x1 + o, y0 - o, top), P(x1 + o, ym, top + rh), P(x0 - o, ym, top + rh), roofCol, [[0, 0], [(x1 - x0) / 3, 0], [(x1 - x0) / 3, span / 5], [0, span / 5]]);
          roofs.quad(P(x1 + o, y1 + o, top), P(x0 - o, y1 + o, top), P(x0 - o, ym, top + rh), P(x1 + o, ym, top + rh), roofCol, [[0, 0], [(x1 - x0) / 3, 0], [(x1 - x0) / 3, span / 5], [0, span / 5]]);
          trim.triangle(P(x0, y0, top), P(x0, ym, top + rh), P(x0, y1, top), gableCol);
          trim.triangle(P(x1, y1, top), P(x1, ym, top + rh), P(x1, y0, top), gableCol);
          trim.box((x0 + x1) / 2, top + rh + 0.06, -ym, x1 - x0 + 2 * o, 0.18, 0.34, roofCol.clone().multiplyScalar(0.7));
          const chx = x0 + (x1 - x0) * (rng.chance(0.5) ? 0.2 : 0.8);
          trim.box(chx, top + rh * 0.8 + 0.7, -(ym + (y1 - y0) * 0.12), 0.7, rh * 0.5 + 1.4, 0.7, wallCol.clone().multiplyScalar(0.8));
          trim.box(chx, top + rh * 1.05 + 1.45, -(ym + (y1 - y0) * 0.12), 0.85, 0.14, 0.85, new THREE.Color(0x77736c));
        } else {
          const xm = (x0 + x1) / 2;
          roofs.quad(P(x1 + o, y0 - o, top), P(x1 + o, y1 + o, top), P(xm, y1 + o, top + rh), P(xm, y0 - o, top + rh), roofCol, [[0, 0], [(y1 - y0) / 3, 0], [(y1 - y0) / 3, span / 5], [0, span / 5]]);
          roofs.quad(P(x0 - o, y1 + o, top), P(x0 - o, y0 - o, top), P(xm, y0 - o, top + rh), P(xm, y1 + o, top + rh), roofCol, [[0, 0], [(y1 - y0) / 3, 0], [(y1 - y0) / 3, span / 5], [0, span / 5]]);
          trim.triangle(P(x1, y0, top), P(xm, y0, top + rh), P(x0, y0, top), gableCol);
          trim.triangle(P(x0, y1, top), P(xm, y1, top + rh), P(x1, y1, top), gableCol);
          trim.box(xm, top + rh + 0.06, -(y0 + y1) / 2, 0.34, 0.18, y1 - y0 + 2 * o, roofCol.clone().multiplyScalar(0.7));
          const chy = y0 + (y1 - y0) * (rng.chance(0.5) ? 0.2 : 0.8);
          trim.box(xm + (x1 - x0) * 0.12, top + rh * 0.8 + 0.7, -chy, 0.7, rh * 0.5 + 1.4, 0.7, wallCol.clone().multiplyScalar(0.8));
          trim.box(xm + (x1 - x0) * 0.12, top + rh * 1.05 + 1.45, -chy, 0.85, 0.14, 0.85, new THREE.Color(0x77736c));
        }
      } else {
        // flat roof with parapet
        const flat = new THREE.Color(0x6b6b66);
        roofs.quad(P(x0, y0, top), P(x1, y0, top), P(x1, y1, top), P(x0, y1, top), flat);
        const pc = wallCol.clone().multiplyScalar(0.85);
        roofs.box((x0 + x1) / 2, top + 0.4, -y0, x1 - x0, 0.8, 0.3, pc);
        roofs.box((x0 + x1) / 2, top + 0.4, -y1, x1 - x0, 0.8, 0.3, pc);
        roofs.box(x0, top + 0.4, -(y0 + y1) / 2, 0.3, 0.8, y1 - y0, pc);
        roofs.box(x1, top + 0.4, -(y0 + y1) / 2, 0.3, 0.8, y1 - y0, pc);
        if (rng.chance(0.5)) roofs.box(x0 + (x1 - x0) * 0.3, top + 0.8, -(y0 + (y1 - y0) * 0.6), 2, 1.6, 2, new THREE.Color(0x777770));
      }
      // landmark towers
      if (b.name.includes('Church')) {
        const tx = x0 + 3;
        const ty = (y0 + y1) / 2;
        const th = top + 14;
        walls.box(tx, (gz + th) / 2, -ty, 5, th - gz, 5, wallCol, 0, 4);
        roofs.box(tx, th + 3, -ty, 3.5, 6, 3.5, roofCol);
      } else if (b.name.includes('Water Tower')) {
        roofs.box((x0 + x1) / 2, top + 3, -(y0 + y1) / 2, 10, 5, 10, new THREE.Color(0x8a8a86));
      }
    }
    const add = (gb: GeoBuilder, mat: THREE.Material) => {
      if (gb.empty) return;
      const m = new THREE.Mesh(gb.build(), mat);
      m.castShadow = true;
      m.receiveShadow = true;
      this.buildingGroup.add(m);
    };
    add(plaster, this.wallMat);
    add(bricks, this.brickMat);
    add(roofs, this.roofMat);
    add(rubble, this.plainMat);
    add(trim, this.plainMat);
  }

  /** Hedgerows as overlapping leafy blobs, stone walls as continuous strips. */
  private buildLinear(): void {
    const { map } = this;
    const gb = new GeoBuilder();
    const rng = new Rng(this.gen.def.seed + 5);
    const wallBase = new THREE.Color(0x8f887a);
    const ico = new THREE.IcosahedronGeometry(1, 1);
    const ip = ico.attributes.position as THREE.BufferAttribute;
    const hp: number[] = [];
    const hn: number[] = [];
    const hc: number[] = [];
    const leaf = new THREE.Color();
    const blob = (x: number, y: number, rx: number, ry: number, shade: number) => {
      const g = map.groundAt(x, y);
      const cy = g + ry * 0.62;
      const rot = rng.next() * Math.PI;
      const cr = Math.cos(rot);
      const sr = Math.sin(rot);
      for (let i = 0; i < ip.count; i++) {
        const ux = ip.getX(i);
        const uy = ip.getY(i);
        const uz = ip.getZ(i);
        // lumpy surface: jitter the radius per vertex direction (deterministic per blob)
        const j = 0.86 + 0.28 * (0.5 + 0.5 * Math.sin(ux * 5.1 + uz * 3.7 + uy * 4.3 + rot * 7));
        const lx = ux * rx * j;
        const lz = uz * rx * j;
        // rotate in three.js space (negating a local axis would mirror the blob and flip its winding)
        hp.push(x + lx * cr - lz * sr, cy + uy * ry * j, -y + lx * sr + lz * cr);
        // spherical normals, tilted up a little so the canopy reads as lit from the sky
        const n = new THREE.Vector3(ux * cr - uz * sr, uy + 0.35, ux * sr + uz * cr).normalize();
        hn.push(n.x, n.y, n.z);
        const lift = 0.62 + 0.38 * Math.min(1, Math.max(0, (uy + 0.6) / 1.4));
        leaf.setRGB(0.1 * shade * lift, 0.16 * shade * lift, 0.055 * shade * lift);
        leaf.offsetHSL((rng.next() - 0.5) * 0.02, 0, (rng.next() - 0.5) * 0.02);
        hc.push(leaf.r, leaf.g, leaf.b);
      }
    };
    for (let cy = 0; cy < map.h; cy++) {
      for (let cx = 0; cx < map.w; cx++) {
        const t = map.type[cy * map.w + cx] as T;
        if (t !== T.Hedge && t !== T.Wall) continue;
        const c = map.cellCenter(cx, cy);
        if (t === T.Hedge) {
          const shade = 0.68 + rng.next() * 0.42;
          const big = rng.chance(0.2) ? 1.3 : 1;
          blob(c.x + (rng.next() - 0.5), c.y + (rng.next() - 0.5), (1.25 + rng.next() * 0.6) * big, (1.15 + rng.next() * 0.7) * big, shade);
          for (const [dx, dy] of [[1, 0], [0, 1]]) {
            const nx = cx + dx;
            const ny = cy + dy;
            if (!map.inBounds(nx, ny) || map.type[ny * map.w + nx] !== T.Hedge) continue;
            blob(c.x + (dx * CELL) / 2, c.y + (dy * CELL) / 2, 1.25 + rng.next() * 0.4, 1.15 + rng.next() * 0.45, shade * (0.9 + rng.next() * 0.2));
          }
          continue;
        }
        const g = map.groundAt(c.x, c.y);
        const h = 1.15;
        const th = 0.55;
        const col = wallBase.clone().offsetHSL(0, 0, (rng.next() - 0.5) * 0.08);
        gb.box(c.x, g + h / 2 - 0.2, -c.y, th, h, th, col);
        gb.box(c.x, g + h - 0.12, -c.y, th + 0.12, 0.14, th + 0.12, col.clone().multiplyScalar(0.85));
        for (const [dx, dy] of [[1, 0], [0, 1], [-1, 0], [0, -1]]) {
          const nx = cx + dx;
          const ny = cy + dy;
          if (!map.inBounds(nx, ny) || map.type[ny * map.w + nx] !== t) continue;
          const len = CELL / 2;
          gb.box(c.x + (dx * len) / 2, g + h / 2 - 0.2, -(c.y + (dy * len) / 2), dx ? len : th, h, dy ? len : th, col);
          gb.box(c.x + (dx * len) / 2, g + h - 0.12, -(c.y + (dy * len) / 2), dx ? len : th + 0.12, 0.14, dy ? len : th + 0.12, col.clone().multiplyScalar(0.85));
        }
      }
    }
    ico.dispose();
    if (hp.length) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(hp, 3));
      g.setAttribute('normal', new THREE.Float32BufferAttribute(hn, 3));
      g.setAttribute('color', new THREE.Float32BufferAttribute(hc, 3));
      g.computeBoundingSphere();
      const m = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, metalness: 0, envMapIntensity: 1.4 }));
      m.castShadow = true;
      m.receiveShadow = true;
      m.name = 'hedges';
      this.group.add(m);
    }
    if (gb.empty) return;
    const m = new THREE.Mesh(gb.build(), this.plainMat);
    m.castShadow = true;
    m.receiveShadow = true;
    this.group.add(m);
  }

  private buildTrees(quality: 'low' | 'high'): void {
    const { map } = this;
    const rng = new Rng(this.gen.def.seed + 17);
    const list: VegPlacement[] = [];
    const q = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0);
    const add = (kind: VegKind, x: number, y: number, s: number) => {
      q.setFromAxisAngle(up, rng.next() * Math.PI * 2);
      const m = new THREE.Matrix4().compose(new THREE.Vector3(x, map.groundAt(x, y) - 0.2, -y), q, new THREE.Vector3(s, s * (0.85 + rng.next() * 0.3), s));
      const tint = kind === 'tree_pine'
        ? new THREE.Color().setHSL(0.3 + rng.next() * 0.05, 0.25 + rng.next() * 0.15, 0.78 + rng.next() * 0.2)
        : new THREE.Color().setHSL(0.2 + rng.next() * 0.09, 0.3 + rng.next() * 0.25, 0.74 + rng.next() * 0.3);
      list.push({ kind, matrix: m, tint });
    };
    const density = quality === 'high' ? 1 : 0.6;
    const forestTree = (): VegKind => {
      const r = rng.next();
      return r < 0.45 ? 'tree_oak' : r < 0.8 ? 'tree_pine' : 'tree_birch';
    };
    for (let cy = 0; cy < map.h; cy++) {
      for (let cx = 0; cx < map.w; cx++) {
        const t = map.type[cy * map.w + cx] as T;
        const x = (cx + 0.2 + rng.next() * 0.6) * CELL;
        const y = (cy + 0.2 + rng.next() * 0.6) * CELL;
        if (t === T.Forest) {
          if (rng.chance(0.62 * density)) add(forestTree(), x, y, 0.85 + rng.next() * 0.45);
          else if (rng.chance(0.3)) add('bush', x, y, 0.8 + rng.next() * 0.5);
        } else if (t === T.Orchard) {
          if ((cx + cy) % 2 === 0 && rng.chance(0.7 * density)) add('tree_oak', (cx + 0.5) * CELL, (cy + 0.5) * CELL, 0.5 + rng.next() * 0.15);
        } else if (t === T.Scrub) {
          if (rng.chance(0.18 * density)) add('bush', x, y, 0.6 + rng.next() * 0.6);
          else if (rng.chance(0.02)) add('tree_birch', x, y, 0.7 + rng.next() * 0.3);
        } else if (t === T.Grass) {
          if (rng.chance(0.006)) add(rng.chance(0.75) ? 'tree_oak' : 'tree_birch', x, y, 0.8 + rng.next() * 0.4);
        } else if (t === T.Marsh) {
          if (rng.chance(0.08)) add('bush', x, y, 0.5 + rng.next() * 0.4);
        } else if (t === T.Hedge) {
          // leafy crown along the hedgerow, the odd tree growing out of it
          const c = map.cellCenter(cx, cy);
          add('bush', c.x + (rng.next() - 0.5) * 1.5, c.y + (rng.next() - 0.5) * 1.5, 0.75 + rng.next() * 0.35);
          if (rng.chance(0.5)) add('bush', c.x + (rng.next() - 0.5) * 3, c.y + (rng.next() - 0.5) * 3, 0.6 + rng.next() * 0.3);
          if (rng.chance(0.07)) add('tree_oak', c.x, c.y, 0.7 + rng.next() * 0.35);
        }
      }
    }
    if (!list.length) return;
    this.vegetation = new Vegetation(this.models, list);
    this.group.add(this.vegetation.group);
  }
}

/** Paints the top-down terrain texture (also used for menu thumbnails and the minimap). */
export class MapPainter {
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private pxPerM: number;
  private map: TerrainMap;

  constructor(private gen: GeneratedMap, size: number) {
    this.map = gen.map;
    this.canvas = document.createElement('canvas');
    this.canvas.width = this.canvas.height = size;
    this.ctx = this.canvas.getContext('2d')!;
    this.pxPerM = size / this.map.width;
    this.paint();
  }

  private px(x: number): number {
    return x * this.pxPerM;
  }
  private py(y: number): number {
    return (this.map.height - y) * this.pxPerM;
  }

  paint(): void {
    const { map, ctx } = this;
    const S = this.canvas.width;
    const rng = new Rng(this.gen.def.seed + 99);
    // 1. per-cell colour, bilinear-upscaled for soft transitions
    const small = document.createElement('canvas');
    small.width = map.w;
    small.height = map.h;
    const sg = small.getContext('2d')!;
    const img = sg.createImageData(map.w, map.h);
    for (let cy = 0; cy < map.h; cy++) {
      for (let cx = 0; cx < map.w; cx++) {
        let t = map.type[cy * map.w + cx] as T;
        if (t === T.Hedge || t === T.Wall) t = T.Grass;
        if (t === T.Building) t = T.Dirt;
        if (t === T.Bridge) t = T.Water;
        const c = TERRAIN[t].color;
        const j = (rng.next() - 0.5) * 14;
        const e = map.groundAt((cx + 0.5) * CELL, (cy + 0.5) * CELL);
        const shade = 1 + Math.max(-0.08, Math.min(0.08, e * 0.006));
        const i = ((map.h - 1 - cy) * map.w + cx) * 4;
        img.data[i] = Math.max(0, Math.min(255, c[0] * shade + j));
        img.data[i + 1] = Math.max(0, Math.min(255, c[1] * shade + j));
        img.data[i + 2] = Math.max(0, Math.min(255, c[2] * shade + j * 0.6));
        img.data[i + 3] = 255;
      }
    }
    sg.putImageData(img, 0, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(small, 0, 0, S, S);

    // 2. grain
    const noise = noiseCanvas(256, this.gen.def.seed);
    ctx.globalAlpha = 0.16;
    ctx.globalCompositeOperation = 'overlay';
    for (let y = 0; y < S; y += 256) for (let x = 0; x < S; x += 256) ctx.drawImage(noise, x, y);
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;

    const cellPx = CELL * this.pxPerM;
    // 3. field furrows and forest floor speckle
    const stripes = document.createElement('canvas');
    stripes.width = stripes.height = 32;
    const stg = stripes.getContext('2d')!;
    stg.fillStyle = 'rgba(70,60,20,0.55)';
    for (let x = 0; x < 32; x += 6) stg.fillRect(x, 0, 2, 32);
    const pattern = ctx.createPattern(stripes, 'repeat')!;
    for (let cy = 0; cy < map.h; cy++) {
      for (let cx = 0; cx < map.w; cx++) {
        const t = map.type[cy * map.w + cx] as T;
        const x = cx * cellPx;
        const y = (map.h - 1 - cy) * cellPx;
        if (t === T.Field) {
          ctx.globalAlpha = 0.35;
          ctx.fillStyle = pattern;
          ctx.fillRect(x, y, cellPx, cellPx);
        } else if (t === T.Forest || t === T.Orchard || t === T.Scrub) {
          ctx.globalAlpha = t === T.Forest ? 0.5 : 0.3;
          for (let k = 0; k < 6; k++) {
            ctx.fillStyle = rng.chance(0.5) ? '#23341c' : '#4d5a2a';
            ctx.fillRect(x + rng.next() * cellPx, y + rng.next() * cellPx, 2 + rng.next() * 3, 2 + rng.next() * 3);
          }
        } else if (t === T.Marsh) {
          ctx.globalAlpha = 0.4;
          ctx.fillStyle = '#3d5a55';
          ctx.fillRect(x + rng.next() * cellPx * 0.6, y + rng.next() * cellPx * 0.6, cellPx * 0.4, cellPx * 0.3);
        }
      }
    }
    ctx.globalAlpha = 1;

    // 4. rivers (bed under the water plane)
    for (const r of this.gen.rivers) {
      this.strokePath(r.pts, r.width + 4, '#3a4a3e');
      this.strokePath(r.pts, r.width, '#26404d');
    }
    // 5. roads
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (const r of this.gen.roads) {
      if (r.dirt) {
        this.strokePath(r.pts, r.width + 1.5, '#6d5d44');
        this.strokePath(r.pts, r.width, '#8f7a58');
        this.strokePath(r.pts, r.width * 0.3, 'rgba(160,140,105,0.6)');
      } else {
        this.strokePath(r.pts, r.width + 1.6, '#4b4a45');
        this.strokePath(r.pts, r.width, '#5f5f5b');
        if (r.width >= 8) {
          ctx.setLineDash([3 * this.pxPerM, 4 * this.pxPerM]);
          this.strokePath(r.pts, 0.25, 'rgba(225,215,170,0.8)');
          ctx.setLineDash([]);
        }
      }
    }
    // 6. building plots / yards
    for (const b of map.buildings) {
      ctx.fillStyle = 'rgba(70,64,56,0.55)';
      ctx.fillRect(b.cx * cellPx - 3, (map.h - b.cy - b.ch) * cellPx - 3, b.cw * cellPx + 6, b.ch * cellPx + 6);
    }
  }

  private strokePath(pts: { x: number; y: number }[], width: number, color: string): void {
    const ctx = this.ctx;
    ctx.strokeStyle = color;
    ctx.lineWidth = width * this.pxPerM;
    ctx.beginPath();
    pts.forEach((p, i) => (i ? ctx.lineTo(this.px(p.x), this.py(p.y)) : ctx.moveTo(this.px(p.x), this.py(p.y))));
    ctx.stroke();
  }

  rut(ax: number, ay: number, bx: number, by: number, width: number, alpha: number): void {
    const ctx = this.ctx;
    ctx.strokeStyle = `rgba(52,44,32,${alpha})`;
    ctx.lineWidth = Math.max(1, width * this.pxPerM);
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(this.px(ax), this.py(ay));
    ctx.lineTo(this.px(bx), this.py(by));
    ctx.stroke();
  }

  /** Scorch mark / crater on the ground texture. */
  scorch(x: number, y: number, r: number): void {
    const ctx = this.ctx;
    const g = ctx.createRadialGradient(this.px(x), this.py(y), 0, this.px(x), this.py(y), r * this.pxPerM);
    g.addColorStop(0, 'rgba(30,24,18,0.7)');
    g.addColorStop(0.45, 'rgba(55,46,34,0.4)');
    g.addColorStop(1, 'rgba(60,50,35,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(this.px(x), this.py(y), r * this.pxPerM, 0, Math.PI * 2);
    ctx.fill();
  }

}
