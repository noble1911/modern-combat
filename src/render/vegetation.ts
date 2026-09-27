import * as THREE from 'three';
import { mergedModel, type ModelLib } from './models';

export type VegKind = 'tree_oak' | 'tree_pine' | 'tree_birch' | 'bush';

export interface VegPlacement {
  kind: VegKind;
  matrix: THREE.Matrix4;
  tint: THREE.Color;
}

const cellKey = (x: number, z: number) => Math.floor(x / 8) * 4096 + Math.floor(z / 8);

/** Beyond this distance (m) from the camera a plant is drawn with its low-poly model. */
const LOD_DIST = 260;
const LOD_HYST = 20;

/** Side of a vegetation chunk, metres. */
const CHUNK = 160;

interface Item {
  mesh: THREE.BatchedMesh;
  id: number;
  x: number;
  y: number;
  z: number;
  near: number;
  far: number;
  lod: boolean;
  down: boolean;
}

/**
 * All trees and bushes of a map as BatchedMeshes, one per 160 m chunk: each chunk is a single
 * multi-draw call culled as a whole by its bounding sphere (by the camera and by each shadow
 * cascade), which is far cheaper on the CPU than per-instance culling of thousands of plants.
 * Distant plants swap to their low-poly model; wind sway runs in the vertex shader;
 * per-instance tints vary the foliage colour (trunks keep theirs).
 */
export class Vegetation {
  readonly group = new THREE.Group();
  readonly material: THREE.MeshStandardMaterial;
  private uniforms = {
    uTime: { value: 0 },
    uWind: { value: 1 },
    /** Direction to the sun in view space, and its colour × intensity (for leaf translucency). */
    uSunView: { value: new THREE.Vector3(0, 1, 0) },
    uSunCol: { value: new THREE.Color(1, 1, 1) },
  };
  private sunWorld = new THREE.Vector3(0, 1, 0);
  private items: Item[] = [];
  private lodT = 0;
  /** Spatial hash of item indices (8 m cells, three.js x / z). */
  private grid = new Map<number, number[]>();

  constructor(models: ModelLib, list: VegPlacement[]) {
    const kinds = [...new Set(list.map((p) => p.kind))];
    const geos = new Map<VegKind, { near: THREE.BufferGeometry; far: THREE.BufferGeometry | null }>();
    let verts = 0;
    for (const k of kinds) {
      const src = models.has(k) ? k : 'tree_oak';
      const near = mergedModel(models, src, ['Foliage']);
      const far = models.has(`${src}_lod`) ? mergedModel(models, `${src}_lod`, ['Foliage']) : null;
      geos.set(k, { near, far });
      verts += near.attributes.position.count + (far?.attributes.position.count ?? 0);
    }
    const flat = !models.vertexColored('tree_oak');
    // extra sky fill: canopies self-shadow heavily and would read as black blobs against the sun
    this.material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.88, metalness: 0, flatShading: flat, envMapIntensity: 1.5 });
    this.patchMaterial(this.material);

    // bucket placements into chunks
    const chunks = new Map<number, VegPlacement[]>();
    const p = new THREE.Vector3();
    for (const pl of list) {
      p.setFromMatrixPosition(pl.matrix);
      const key = Math.floor(p.x / CHUNK) * 1024 + Math.floor(-p.z / CHUNK);
      const c = chunks.get(key);
      if (c) c.push(pl);
      else chunks.set(key, [pl]);
    }
    for (const part of chunks.values()) {
      const mesh = new THREE.BatchedMesh(part.length, Math.max(3, verts), 0, this.material);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.sortObjects = false;
      mesh.perObjectFrustumCulled = false;
      const ids = new Map<VegKind, { near: number; far: number }>();
      for (const [k, g] of geos) {
        const near = mesh.addGeometry(g.near);
        const far = g.far ? mesh.addGeometry(g.far) : near;
        ids.set(k, { near, far });
      }
      for (const pl of part) {
        const gi = ids.get(pl.kind)!;
        const id = mesh.addInstance(gi.near);
        mesh.setMatrixAt(id, pl.matrix);
        mesh.setColorAt(id, pl.tint);
        p.setFromMatrixPosition(pl.matrix);
        const k = this.items.length;
        this.items.push({ mesh, id, x: p.x, y: p.y, z: p.z, near: gi.near, far: gi.far, lod: false, down: false });
        const cell = cellKey(p.x, p.z);
        const bucket = this.grid.get(cell);
        if (bucket) bucket.push(k);
        else this.grid.set(cell, [k]);
      }
      mesh.computeBoundingBox();
      mesh.computeBoundingSphere();
      this.group.add(mesh);
    }
    for (const g of geos.values()) {
      g.near.dispose();
      g.far?.dispose();
    }
  }

  /** Wind sway (foliage and upper trunk) and a tint mask so only foliage takes instance colours. */
  private patchMaterial(mat: THREE.MeshStandardMaterial): void {
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uTime = this.uniforms.uTime;
      shader.uniforms.uWind = this.uniforms.uWind;
      shader.uniforms.uSunView = this.uniforms.uSunView;
      shader.uniforms.uSunCol = this.uniforms.uSunCol;
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nuniform vec3 uSunView;\nuniform vec3 uSunCol;\nvarying float vLeaf;')
        .replace(
          '#include <lights_fragment_end>',
          `#include <lights_fragment_end>
          // light through the leaves when looking towards the sun
          float toSun = max( 0.0, dot( -normalize( vViewPosition ), uSunView ) );
          reflectedLight.directDiffuse += diffuseColor.rgb * uSunCol * ( pow( toSun, 4.0 ) * 0.22 + 0.03 ) * vLeaf;`,
        );
      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          `#include <common>
          attribute float tintMask;
          uniform float uTime;
          uniform float uWind;
          varying float vLeaf;`,
        )
        .replace(
          '#include <color_vertex>',
          THREE.ShaderChunk.color_vertex.replace(
            'vColor *= getBatchingColor( getIndirectIndex( gl_DrawID ) );',
            'vColor.rgb *= mix( vec3( 1.0 ), getBatchingColor( getIndirectIndex( gl_DrawID ) ).rgb, tintMask );',
          ),
        )
        .replace(
          '#include <begin_vertex>',
          `#include <begin_vertex>
          #ifdef USE_BATCHING
            vec3 plantPos = batchingMatrix[ 3 ].xyz;
          #else
            vec3 plantPos = vec3( 0.0 );
          #endif
          vLeaf = tintMask;
          float ph = plantPos.x * 0.047 + plantPos.z * 0.061;
          float bend = max( 0.0, transformed.y - 1.2 );
          bend = bend * bend * 0.0028 * uWind;
          float gust = 0.65 + 0.35 * sin( uTime * 0.31 + plantPos.x * 0.004 );
          transformed.x += ( sin( uTime * 1.13 + ph ) + 0.35 * sin( uTime * 2.71 + ph * 1.9 ) ) * bend * gust;
          transformed.z += ( cos( uTime * 0.97 + ph * 1.3 ) * 0.6 ) * bend * gust;
          // leaves flutter a little on their own
          transformed += tintMask * 0.035 * uWind * sin( uTime * 5.3 + dot( position, vec3( 3.1, 2.3, 4.7 ) ) + ph ) * normal;`,
        );
    };
    mat.customProgramCacheKey = () => 'vegetation-v2';
  }

  /** Sun direction (towards the sun, world space) and colour × intensity for leaf translucency. */
  setSun(dir: THREE.Vector3, color: THREE.Color, intensity: number): void {
    this.sunWorld.copy(dir).normalize();
    this.uniforms.uSunCol.value.copy(color).multiplyScalar(intensity);
  }

  /** Per frame: wind time and LOD swaps (checked a few times a second). */
  update(dt: number, time: number, camera: THREE.Camera): void {
    this.uniforms.uTime.value = time;
    this.uniforms.uSunView.value.copy(this.sunWorld).transformDirection(camera.matrixWorldInverse);
    this.lodT -= dt;
    if (this.lodT > 0) return;
    this.lodT = 0.25;
    const c = camera.position;
    const inner = (LOD_DIST - LOD_HYST) ** 2;
    const outer = (LOD_DIST + LOD_HYST) ** 2;
    for (const it of this.items) {
      if (it.near === it.far || it.down) continue;
      const d = (it.x - c.x) ** 2 + (it.y - c.y) ** 2 + (it.z - c.z) ** 2;
      if (!it.lod && d > outer) {
        it.lod = true;
        it.mesh.setGeometryIdAt(it.id, it.far);
      } else if (it.lod && d < inner) {
        it.lod = false;
        it.mesh.setGeometryIdAt(it.id, it.near);
      }
    }
  }

  /**
   * A vehicle pushes through: plants whose base is within `r` metres of (x, y) (sim coords) are
   * knocked flat (hidden). Returns how many went down.
   */
  flatten(x: number, y: number, r: number): number {
    let n = 0;
    const tz = -y;
    for (let gx = Math.floor((x - r) / 8); gx <= Math.floor((x + r) / 8); gx++) {
      for (let gz = Math.floor((tz - r) / 8); gz <= Math.floor((tz + r) / 8); gz++) {
        const bucket = this.grid.get(gx * 4096 + gz);
        if (!bucket) continue;
        for (const k of bucket) {
          const it = this.items[k];
          if (it.down || (it.x - x) ** 2 + (it.z - tz) ** 2 > r * r) continue;
          it.down = true;
          it.mesh.setVisibleAt(it.id, false);
          n++;
        }
      }
    }
    return n;
  }

  get count(): number {
    return this.items.length;
  }
}
