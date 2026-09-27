import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { FACTIONS, Side } from '../data/units';

export const MODEL_NAMES = [
  'm1a2', 'm2a4', 'stryker', 'jltv', 't90m', 't72b3', 'bmp3', 'btr82a', 'tigr',
  'soldier_stand', 'soldier_kneel', 'soldier_prone', 'soldier_dead',
  'tree_oak', 'tree_pine', 'bush', 'drone_quad', 'drone_fixed', 'mortar', 'atgm_tripod',
  'soldier_stand_nato', 'soldier_kneel_nato', 'soldier_prone_nato', 'soldier_dead_nato',
  'soldier_stand_opfor', 'soldier_kneel_opfor', 'soldier_prone_opfor', 'soldier_dead_opfor',
] as const;

/** Models that may be absent (newer art): loaded if present, never replaced by a fallback. */
export const OPTIONAL_MODELS = ['tree_birch', 'tree_oak_lod', 'tree_pine_lod', 'tree_birch_lod', 'bush_lod'] as const;

/** A skinned, animated soldier (one per faction) and its clips by name. */
export interface RigAsset {
  scene: THREE.Object3D;
  clips: Map<string, THREE.AnimationClip>;
}

/** Models authored with smooth shading and vertex colours (everything else is faceted). */
const SMOOTH = (name: string) => /^soldier_.*_(nato|opfor)$|^soldier_rig/.test(name);

export interface InstPart {
  geometry: THREE.BufferGeometry;
  material: THREE.MeshStandardMaterial;
  matName: string;
}

/** Loads the Blender-built glTF models once and hands out tinted clones / instancing parts. */
export class ModelLib {
  private scenes = new Map<string, THREE.Object3D>();
  private partsCache = new Map<string, InstPart[]>();
  private tinted = new Map<string, THREE.Material>();
  private sourceOf = new WeakMap<THREE.Material, THREE.Material>();
  readonly rigs = new Map<Side, RigAsset>();

  async load(onProgress?: (done: number, total: number) => void): Promise<void> {
    const loader = new GLTFLoader();
    let done = 0;
    const total = MODEL_NAMES.length + OPTIONAL_MODELS.length + 2;
    const rigs = (['nato', 'opfor'] as Side[]).map(async (side) => {
      try {
        const g = await loader.loadAsync(`${import.meta.env.BASE_URL}models/soldier_rig_${side}.glb`);
        g.scene.traverse((o) => {
          const m = o as THREE.Mesh;
          if (m.isMesh) {
            m.castShadow = true;
            m.frustumCulled = false;
          }
        });
        this.rigs.set(side, { scene: g.scene, clips: new Map(g.animations.map((a) => [a.name, a])) });
      } catch (e) {
        console.warn(`soldier rig ${side} failed to load; soldiers will be static`, e);
      }
      onProgress?.(++done, total);
    });
    const optional = OPTIONAL_MODELS.map(async (name) => {
      try {
        const g = await loader.loadAsync(`${import.meta.env.BASE_URL}models/${name}.glb`);
        this.prepare(name, g.scene);
        this.scenes.set(name, g.scene);
      } catch {
        /* not built yet */
      }
      onProgress?.(++done, total);
    });
    await Promise.all([
      ...rigs,
      ...optional,
      ...MODEL_NAMES.map(async (name) => {
        try {
          const g = await loader.loadAsync(`${import.meta.env.BASE_URL}models/${name}.glb`);
          this.prepare(name, g.scene);
          this.scenes.set(name, g.scene);
        } catch (e) {
          console.warn(`model ${name} failed to load, using fallback`, e);
          this.scenes.set(name, fallback(name));
        }
        onProgress?.(++done, total);
      }),
    ]);
  }

  private prepare(name: string, scene: THREE.Object3D): void {
    scene.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) {
        m.castShadow = true;
        m.receiveShadow = true;
        const mat = m.material as THREE.MeshStandardMaterial;
        // v3 art carries vertex colours and authored (smooth + hard edge) normals; the
        // original flat-coloured models are drawn faceted
        const vc = m.geometry.hasAttribute('color');
        mat.flatShading = !SMOOTH(name) && !vc;
        // vertex colours hold the full albedo: the material colour must not tint it again
        if (vc) mat.color.setRGB(1, 1, 1);
        mat.needsUpdate = true;
      }
    });
  }

  /** True for models authored with vertex colours and smooth/hard-edge normals (v2/v3 art). */
  vertexColored(name: string): boolean {
    let yes = false;
    this.scenes.get(name)?.traverse((o) => {
      if ((o as THREE.Mesh).isMesh && (o as THREE.Mesh).geometry.hasAttribute('color')) yes = true;
    });
    return yes;
  }

  has(name: string): boolean {
    return this.scenes.has(name);
  }

  private tintMaterial(mat: THREE.Material, side: Side | null, burnt: boolean): THREE.Material {
    // key by the loaded source material (names repeat across models with different colours)
    const src = this.sourceOf.get(mat) ?? mat;
    const name = src.name || 'x';
    const key = `${src.uuid}|${side}|${burnt}`;
    let t = this.tinted.get(key);
    if (t) return t;
    const m = (src as THREE.MeshStandardMaterial).clone();
    if (side) {
      const f = FACTIONS[side];
      if (name === 'Paint') m.color.setHex(f.paint);
      else if (name === 'Uniform') m.color.setHex(f.uniform);
      else if (name === 'Gear') m.color.setHex(f.gear);
    }
    if (burnt) {
      m.color.multiplyScalar(0.18);
      m.color.offsetHSL(0, -0.4, 0);
      m.roughness = 1;
    }
    this.tinted.set(key, m);
    this.sourceOf.set(m, src);
    return m;
  }

  /** Deep clone with faction colours (materials shared between clones of the same tint). */
  clone(name: string, side: Side | null, burnt = false): THREE.Object3D {
    const src = this.scenes.get(name) ?? fallback(name);
    const c = src.clone(true);
    c.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) {
        m.material = Array.isArray(m.material) ? m.material.map((x) => this.tintMaterial(x, side, burnt)) : this.tintMaterial(m.material, side, burnt);
      }
    });
    return c;
  }

  /** Re-tint an existing clone (e.g. when a vehicle is destroyed). */
  retint(obj: THREE.Object3D, side: Side | null, burnt: boolean): void {
    obj.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh && !Array.isArray(m.material)) m.material = this.tintMaterial(m.material, side, burnt);
    });
  }

  /** Flattened geometry+material pairs (node transforms baked) for InstancedMesh use. */
  parts(name: string, side: Side | null): InstPart[] {
    const key = `${name}|${side}`;
    const cached = this.partsCache.get(key);
    if (cached) return cached;
    const src = this.scenes.get(name) ?? fallback(name);
    src.updateMatrixWorld(true);
    const byMat = new Map<string, { geos: THREE.BufferGeometry[]; mat: THREE.MeshStandardMaterial }>();
    src.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      const mat = m.material as THREE.MeshStandardMaterial;
      const g = m.geometry.clone();
      g.applyMatrix4(m.matrixWorld);
      // keep position/normal (and vertex colours) so merged parts are compatible
      for (const attr of Object.keys(g.attributes)) if (attr !== 'position' && attr !== 'normal' && attr !== 'color') g.deleteAttribute(attr);
      const entry = byMat.get(mat.name) ?? { geos: [], mat };
      entry.geos.push(g.index ? g.toNonIndexed() : g);
      byMat.set(mat.name, entry);
    });
    const out: InstPart[] = [];
    for (const [matName, e] of byMat) {
      const geometry = mergeNonIndexed(e.geos);
      const material = this.tintMaterial(e.mat, side, false) as THREE.MeshStandardMaterial;
      out.push({ geometry, material, matName });
    }
    this.partsCache.set(key, out);
    return out;
  }
}

/**
 * One non-indexed geometry for a whole model (node transforms baked) with the material colour
 * folded into the vertex colours, plus a `tintMask` attribute (1 on materials named in `tintable`)
 * so per-instance tints can affect e.g. foliage but not trunks. Used for BatchedMesh vegetation.
 */
export function mergedModel(lib: ModelLib, name: string, tintable: string[]): THREE.BufferGeometry {
  const parts = lib.parts(name, null);
  let n = 0;
  for (const p of parts) n += p.geometry.attributes.position.count;
  const pos = new Float32Array(n * 3);
  const nor = new Float32Array(n * 3);
  const col = new Float32Array(n * 3);
  const mask = new Float32Array(n);
  let o = 0;
  for (const p of parts) {
    const g = p.geometry;
    const c = g.attributes.position.count;
    pos.set(g.attributes.position.array as Float32Array, o * 3);
    nor.set(g.attributes.normal.array as Float32Array, o * 3);
    const mc = p.material.color;
    const vc = g.attributes.color as THREE.BufferAttribute | undefined;
    const tint = tintable.includes(p.matName) ? 1 : 0;
    for (let i = 0; i < c; i++) {
      col[(o + i) * 3] = (vc ? vc.getX(i) : 1) * mc.r;
      col[(o + i) * 3 + 1] = (vc ? vc.getY(i) : 1) * mc.g;
      col[(o + i) * 3 + 2] = (vc ? vc.getZ(i) : 1) * mc.b;
      mask[o + i] = tint;
    }
    o += c;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  out.setAttribute('color', new THREE.BufferAttribute(col, 3));
  out.setAttribute('tintMask', new THREE.BufferAttribute(mask, 1));
  out.computeBoundingBox();
  out.computeBoundingSphere();
  return out;
}

function mergeNonIndexed(geos: THREE.BufferGeometry[]): THREE.BufferGeometry {
  let n = 0;
  for (const g of geos) n += g.attributes.position.count;
  const pos = new Float32Array(n * 3);
  const nor = new Float32Array(n * 3);
  let o = 0;
  for (const g of geos) {
    pos.set(g.attributes.position.array as Float32Array, o * 3);
    if (g.attributes.normal) nor.set(g.attributes.normal.array as Float32Array, o * 3);
    o += g.attributes.position.count;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  if (geos.every((g) => g.attributes.color)) {
    // vertex colours may be normalised ints and RGB or RGBA: convert to float RGB
    const col = new Float32Array(n * 3);
    let k = 0;
    for (const g of geos) {
      const c = g.attributes.color as THREE.BufferAttribute;
      for (let i = 0; i < c.count; i++) {
        col[k++] = c.getX(i);
        col[k++] = c.getY(i);
        col[k++] = c.getZ(i);
      }
    }
    out.setAttribute('color', new THREE.BufferAttribute(col, 3));
  }
  if (!geos[0]?.attributes.normal) out.computeVertexNormals();
  out.computeBoundingSphere();
  return out;
}

/** Crude stand-ins so the game still works if a .glb is missing. */
function fallback(name: string): THREE.Object3D {
  const mat = (hex: number, n: string) => Object.assign(new THREE.MeshStandardMaterial({ color: hex, roughness: 0.8 }), { name: n });
  const g = new THREE.Group();
  if (name.startsWith('soldier')) {
    const h = name === 'soldier_stand' ? 1.75 : name === 'soldier_kneel' ? 1.1 : 0.4;
    const body = new THREE.Mesh(new THREE.BoxGeometry(name === 'soldier_prone' || name === 'soldier_dead' ? 1.7 : 0.45, h, 0.45), mat(0x777755, 'Uniform'));
    body.position.y = h / 2;
    g.add(body);
    return g;
  }
  if (name.startsWith('tree') || name === 'bush') {
    const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.3, 3, 5), mat(0x5a4030, 'Trunk'));
    trunk.position.y = 1.5;
    const crown = new THREE.Mesh(name === 'tree_pine' ? new THREE.ConeGeometry(2.5, 8, 6) : new THREE.IcosahedronGeometry(3, 0), mat(0x3c6030, 'Foliage'));
    crown.position.y = name === 'bush' ? 1 : 6;
    g.add(trunk, crown);
    return g;
  }
  const hull = new THREE.Group();
  hull.name = 'hull';
  const body = new THREE.Mesh(new THREE.BoxGeometry(6.5, 1.6, 3.2), mat(0x7d7a5c, 'Paint'));
  body.position.y = 1.1;
  hull.add(body);
  const turret = new THREE.Group();
  turret.name = 'turret';
  turret.position.set(0, 1.9, 0);
  turret.add(new THREE.Mesh(new THREE.BoxGeometry(2.6, 0.8, 2.2), mat(0x7d7a5c, 'Paint')));
  const gun = new THREE.Group();
  gun.name = 'gun';
  gun.position.set(1.2, 0.1, 0);
  const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, 4, 6), mat(0x2a2a28, 'Dark'));
  barrel.rotation.z = Math.PI / 2;
  barrel.position.x = 2;
  gun.add(barrel);
  const muzzle = new THREE.Object3D();
  muzzle.name = 'muzzle';
  muzzle.position.x = 4;
  gun.add(muzzle);
  turret.add(gun);
  hull.add(turret);
  g.add(hull);
  return g;
}
