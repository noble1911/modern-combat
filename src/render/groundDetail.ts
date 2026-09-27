import * as THREE from 'three';
import type { GeneratedMap } from '../sim/mapgen';
import { CELL, T } from '../sim/terrain';

/**
 * Per terrain type: [detail amount, bump amount (unused: follows detail), grass density, forest-floor litter].
 * Detail and bump modulate the stretched map texture close up; grass density feeds GrassField.
 */
const INFO: Record<number, [number, number, number, number]> = {
  [T.Grass]: [1, 1, 0.95, 0],
  [T.Field]: [0.85, 1, 0.45, 0],
  [T.Road]: [0.3, 0.2, 0, 0],
  [T.Dirt]: [0.75, 0.9, 0.08, 0],
  [T.Forest]: [0.9, 1, 0.3, 1],
  [T.Orchard]: [1, 1, 0.75, 0.3],
  [T.Hedge]: [1, 1, 0.7, 0.4],
  [T.Wall]: [0.6, 0.6, 0.35, 0],
  [T.Building]: [0.45, 0.35, 0, 0],
  [T.Water]: [0, 0, 0, 0],
  [T.Shallow]: [0.35, 0.3, 0, 0],
  [T.Bridge]: [0.25, 0.2, 0, 0],
  [T.Rubble]: [0.9, 1, 0, 0],
  [T.Marsh]: [0.7, 0.6, 0.75, 0],
  [T.Scrub]: [1, 1, 0.85, 0.3],
  [T.Crater]: [0.9, 1, 0, 0],
};

/**
 * Ground info at 2 m resolution: R detail + bump amount, G leaf litter, B grass density
 * (A is kept opaque so the canvas doesn't premultiply the data away). Per-cell values are then
 * overdrawn with the exact road/river/building shapes the map painter uses, so grass never grows
 * on asphalt.
 */
export function terrainInfoTexture(gen: GeneratedMap): THREE.CanvasTexture {
  const map = gen.map;
  const small = document.createElement('canvas');
  small.width = map.w;
  small.height = map.h;
  const sg = small.getContext('2d')!;
  const img = sg.createImageData(map.w, map.h);
  for (let cy = 0; cy < map.h; cy++) {
    for (let cx = 0; cx < map.w; cx++) {
      const v = INFO[map.type[cy * map.w + cx]] ?? INFO[T.Grass];
      const i = ((map.h - 1 - cy) * map.w + cx) * 4;
      img.data[i] = v[0] * 255;
      img.data[i + 1] = v[3] * 255;
      img.data[i + 2] = v[2] * 255;
      img.data[i + 3] = 255;
    }
  }
  sg.putImageData(img, 0, 0);
  const c = document.createElement('canvas');
  const k = 2; // texels per cell
  c.width = map.w * k;
  c.height = map.h * k;
  const g = c.getContext('2d')!;
  g.imageSmoothingEnabled = true;
  g.drawImage(small, 0, 0, c.width, c.height);
  const pxPerM = c.width / map.width;
  const stroke = (pts: { x: number; y: number }[], width: number, style: string) => {
    g.strokeStyle = style;
    g.lineWidth = width * pxPerM;
    g.lineCap = 'round';
    g.lineJoin = 'round';
    g.beginPath();
    pts.forEach((p, i) => (i ? g.lineTo(p.x * pxPerM, (map.height - p.y) * pxPerM) : g.moveTo(p.x * pxPerM, (map.height - p.y) * pxPerM)));
    g.stroke();
  };
  for (const r of gen.rivers) stroke(r.pts, r.width + 2, 'rgb(40,0,0)');
  for (const r of gen.roads) stroke(r.pts, r.width + (r.dirt ? 0.5 : 1.2), r.dirt ? 'rgb(170,0,0)' : 'rgb(70,0,0)');
  g.fillStyle = 'rgb(110,0,0)';
  for (const b of map.buildings) g.fillRect(b.cx * CELL * pxPerM - 2, (map.height - (b.cy + b.ch) * CELL) * pxPerM - 2, b.cw * CELL * pxPerM + 4, b.ch * CELL * pxPerM + 4);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.NoColorSpace;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearFilter;
  t.generateMipmaps = false;
  return t;
}

/** Periodic value-noise fBm in 0..1 (tiles seamlessly every `size` pixels). */
function tileFbm(size: number, period: number, octaves: number, seed: number): Float32Array {
  const out = new Float32Array(size * size);
  let amp = 1;
  let norm = 0;
  let s = seed >>> 0;
  const rnd = () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
  for (let o = 0; o < octaves; o++) {
    const p = period << o;
    const lat = new Float32Array(p * p);
    for (let i = 0; i < lat.length; i++) lat[i] = rnd();
    for (let y = 0; y < size; y++) {
      const fy = (y / size) * p;
      const y0 = Math.floor(fy);
      const ty = fy - y0;
      const sy = ty * ty * (3 - 2 * ty);
      const r0 = (y0 % p) * p;
      const r1 = ((y0 + 1) % p) * p;
      for (let x = 0; x < size; x++) {
        const fx = (x / size) * p;
        const x0 = Math.floor(fx);
        const tx = fx - x0;
        const sx = tx * tx * (3 - 2 * tx);
        const c0 = x0 % p;
        const c1 = (x0 + 1) % p;
        const a = lat[r0 + c0] + (lat[r0 + c1] - lat[r0 + c0]) * sx;
        const b = lat[r1 + c0] + (lat[r1 + c1] - lat[r1 + c0]) * sx;
        out[y * size + x] += (a + (b - a) * sy) * amp;
      }
    }
    norm += amp;
    amp *= 0.5;
  }
  for (let i = 0; i < out.length; i++) out[i] /= norm;
  return out;
}

let detailTex: THREE.DataTexture | null = null;

/** Tileable ground detail: R fine speckle, G clumps, B micro height, A litter spots. */
export function groundDetailTexture(): THREE.DataTexture {
  if (detailTex) return detailTex;
  const N = 256;
  const fine = tileFbm(N, 32, 3, 11);
  const grain = tileFbm(N, 128, 1, 23);
  const clump = tileFbm(N, 4, 4, 37);
  const spots = tileFbm(N, 24, 2, 51);
  const data = new Uint8Array(N * N * 4);
  const contrast = (v: number, k: number) => Math.min(1, Math.max(0, (v - 0.5) * k + 0.5));
  for (let i = 0; i < N * N; i++) {
    const f = contrast(fine[i] * 0.65 + grain[i] * 0.35, 2.2);
    const c = contrast(clump[i], 2.0);
    data[i * 4] = f * 255;
    data[i * 4 + 1] = c * 255;
    data[i * 4 + 2] = contrast(f * 0.55 + c * 0.45, 1.6) * 255;
    data[i * 4 + 3] = contrast(spots[i], 3.0) * 255;
  }
  const t = new THREE.DataTexture(data, N, N, THREE.RGBAFormat);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = 8;
  t.needsUpdate = true;
  detailTex = t;
  return t;
}

/**
 * Patch the ground material: world-space detail layers (fine, clump, macro) modulate the
 * painted map colour by terrain type, and their height gradients perturb the normal so low sun
 * picks out tussocks and ruts. Only valid for a mesh whose vertices are in world space.
 */
export function applyGroundDetail(mat: THREE.MeshStandardMaterial, info: THREE.Texture): void {
  const detail = groundDetailTexture();
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.tDetail = { value: detail };
    shader.uniforms.tInfo = { value: info };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vGPos;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvGPos = position;');
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        uniform sampler2D tDetail;
        uniform sampler2D tInfo;
        varying vec3 vGPos;
        float gdHeight( vec2 p ) {
          return texture2D( tDetail, p / 2.1 ).b * 0.05 + texture2D( tDetail, p / 9.0 + 0.31 ).b * 0.12;
        }`,
      )
      .replace(
        '#include <map_fragment>',
        `#include <map_fragment>
        vec4 gInfo = texture2D( tInfo, vMapUv );
        vec2 gp = vGPos.xz;
        vec4 gd1 = texture2D( tDetail, gp / 2.1 );
        vec4 gd2 = texture2D( tDetail, gp / 9.0 + 0.31 );
        vec4 gd3 = texture2D( tDetail, gp / 57.0 + 0.67 );
        float gFine = ( gd1.r - 0.5 ) * 0.6 + ( gd2.g - 0.5 ) * 0.5;
        float gMacro = ( gd3.g - 0.5 );
        diffuseColor.rgb *= clamp( 1.0 + gFine * gInfo.r * 0.55 + gMacro * 0.28, 0.5, 1.6 );
        // grass tussocks: yellower tops, bluer hollows
        diffuseColor.rgb *= mix( vec3( 1.0 ), mix( vec3( 0.9, 0.96, 1.04 ), vec3( 1.08, 1.04, 0.86 ), gd2.g ), gInfo.b * 0.6 );
        // leaf litter on the forest floor
        diffuseColor.rgb = mix( diffuseColor.rgb, diffuseColor.rgb * vec3( 1.35, 1.05, 0.62 ), gInfo.g * smoothstep( 0.55, 0.85, gd1.a ) * 0.55 );`,
      )
      .replace(
        '#include <normal_fragment_maps>',
        `#include <normal_fragment_maps>
        {
          float e = 0.12;
          float h0 = gdHeight( gp );
          vec2 grad = vec2( gdHeight( gp + vec2( e, 0.0 ) ) - h0, gdHeight( gp + vec2( 0.0, e ) ) - h0 ) / e;
          vec3 wn = normalize( ( vec4( normal, 0.0 ) * viewMatrix ).xyz );
          wn = normalize( wn - vec3( grad.x, 0.0, grad.y ) * gInfo.r * 1.0 );
          normal = normalize( ( viewMatrix * vec4( wn, 0.0 ) ).xyz );
        }`,
      );
  };
  mat.customProgramCacheKey = () => 'ground-detail-v1';
}

let waterTex: THREE.DataTexture | null = null;

/** Tileable ripple normal map for rivers (tangent space). */
export function waterNormalTexture(): THREE.DataTexture {
  if (waterTex) return waterTex;
  const N = 256;
  const a = tileFbm(N, 8, 4, 71);
  const b = tileFbm(N, 16, 3, 83);
  const h = new Float32Array(N * N);
  for (let i = 0; i < N * N; i++) h[i] = a[i] * 0.7 + b[i] * 0.3;
  const data = new Uint8Array(N * N * 4);
  const at = (x: number, y: number) => h[((y + N) % N) * N + ((x + N) % N)];
  const k = 6;
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const nx = -(at(x + 1, y) - at(x - 1, y)) * k;
      const ny = -(at(x, y + 1) - at(x, y - 1)) * k;
      const l = Math.hypot(nx, ny, 1);
      const i = (y * N + x) * 4;
      data[i] = (nx / l * 0.5 + 0.5) * 255;
      data[i + 1] = (ny / l * 0.5 + 0.5) * 255;
      data[i + 2] = (1 / l * 0.5 + 0.5) * 255;
      data[i + 3] = 255;
    }
  }
  const t = new THREE.DataTexture(data, N, N, THREE.RGBAFormat);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = 8;
  t.needsUpdate = true;
  waterTex = t;
  return t;
}
