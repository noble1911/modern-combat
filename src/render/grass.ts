import * as THREE from 'three';
import { CELL, TerrainMap } from '../sim/terrain';

/** Corner elevations as a float texture for vertex-shader height lookups. */
export function heightTexture(map: TerrainMap): THREE.DataTexture {
  const W = map.w + 1;
  const H = map.h + 1;
  const data = new Float32Array(W * H);
  for (let iy = 0; iy < H; iy++) for (let ix = 0; ix < W; ix++) data[iy * W + ix] = map.cornerElev(ix, iy);
  const t = new THREE.DataTexture(data, W, H, THREE.RedFormat, THREE.FloatType);
  t.magFilter = THREE.NearestFilter;
  t.minFilter = THREE.NearestFilter;
  t.needsUpdate = true;
  return t;
}

const BLADES = 5;

/** One tuft: a few thin triangular blades leaning outwards (y up, base at 0). */
function tuftGeometry(): THREE.BufferGeometry {
  const pos: number[] = [];
  const h01: number[] = [];
  let s = 7;
  const rnd = () => {
    s = (s * 16807) % 2147483647;
    return s / 2147483647;
  };
  for (let b = 0; b < BLADES; b++) {
    const a = (b / BLADES) * Math.PI * 2 + rnd() * 0.8;
    const r = 0.06 + rnd() * 0.12;
    const bx = Math.cos(a) * r;
    const bz = Math.sin(a) * r;
    const h = 0.35 + rnd() * 0.3;
    const lean = 0.12 + rnd() * 0.18;
    const w = 0.035 + rnd() * 0.02;
    const px = -Math.sin(a) * w;
    const pz = Math.cos(a) * w;
    pos.push(bx - px, 0, bz - pz, bx + px, 0, bz + pz, bx + Math.cos(a) * lean, h, bz + Math.sin(a) * lean);
    h01.push(0, 0, 1);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('bladeH', new THREE.Float32BufferAttribute(h01, 1));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(new Array(pos.length).fill(0).map((_, i) => (i % 3 === 1 ? 1 : 0)), 3));
  return g;
}

/**
 * Grass tufts in a square window around the camera focus. Instances live on a fixed world grid
 * modulo the window size, so the field is stable while the camera pans (tufts that leave one
 * edge reappear at the other). Height, colour and density come from terrain textures in the
 * vertex shader: one draw call, no per-frame CPU work.
 */
export class GrassField {
  readonly mesh: THREE.Mesh;
  private uniforms: Record<string, THREE.IUniform>;

  constructor(map: TerrainMap, info: THREE.Texture, ground: THREE.Texture, radius = 62, spacing = 0.72) {
    const size = radius * 2;
    const n = Math.floor(size / spacing);
    const base = tuftGeometry();
    const geo = new THREE.InstancedBufferGeometry();
    geo.setAttribute('position', base.attributes.position);
    geo.setAttribute('normal', base.attributes.normal);
    geo.setAttribute('bladeH', base.attributes.bladeH);
    const offs = new Float32Array(n * n * 2);
    const rnds = new Float32Array(n * n * 2);
    let s = 12345;
    const rnd = () => {
      s = (s * 16807) % 2147483647;
      return s / 2147483647;
    };
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const k = j * n + i;
        offs[k * 2] = (i + rnd()) * spacing;
        offs[k * 2 + 1] = (j + rnd()) * spacing;
        rnds[k * 2] = rnd();
        rnds[k * 2 + 1] = rnd();
      }
    }
    geo.setAttribute('iOffset', new THREE.InstancedBufferAttribute(offs, 2));
    geo.setAttribute('iRnd', new THREE.InstancedBufferAttribute(rnds, 2));
    geo.instanceCount = n * n;

    this.uniforms = {
      uCenter: { value: new THREE.Vector2() },
      uSize: { value: n * spacing },
      uRadius: { value: radius },
      uTime: { value: 0 },
      uFade: { value: 1 },
      uMapSize: { value: new THREE.Vector2(map.width, map.height) },
      uCells: { value: new THREE.Vector2(map.w, map.h) },
      uCell: { value: CELL },
      tHeight: { value: heightTexture(map) },
      tInfo: { value: info },
      tGround: { value: ground },
    };
    const mat = new THREE.MeshStandardMaterial({ roughness: 0.95, metalness: 0, side: THREE.DoubleSide });
    mat.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, this.uniforms);
      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          `#include <common>
          attribute vec2 iOffset;
          attribute vec2 iRnd;
          attribute float bladeH;
          uniform vec2 uCenter, uMapSize, uCells;
          uniform float uSize, uRadius, uTime, uFade, uCell;
          uniform sampler2D tHeight, tInfo, tGround;
          varying vec3 vGrass;
          float grassHeightAt( vec2 p ) {
            vec2 f = clamp( p / uCell, vec2( 0.0 ), uCells - 0.001 );
            ivec2 i = ivec2( floor( f ) );
            vec2 t = fract( f );
            float a = texelFetch( tHeight, i, 0 ).r;
            float b = texelFetch( tHeight, i + ivec2( 1, 0 ), 0 ).r;
            float c = texelFetch( tHeight, i + ivec2( 0, 1 ), 0 ).r;
            float d = texelFetch( tHeight, i + ivec2( 1, 1 ), 0 ).r;
            return mix( mix( a, b, t.x ), mix( c, d, t.x ), t.y );
          }`,
        )
        .replace(
          '#include <beginnormal_vertex>',
          `vec2 rel = mod( iOffset - uCenter + uSize * 0.5, uSize ) - uSize * 0.5;
          vec2 wxz = uCenter + rel;
          vec2 simP = vec2( wxz.x, -wxz.y );
          vec2 muv = simP / uMapSize;
          vec4 gInfo = textureLod( tInfo, muv, 0.0 );
          float inside = step( 0.0, muv.x ) * step( muv.x, 1.0 ) * step( 0.0, muv.y ) * step( muv.y, 1.0 );
          float dist = length( rel );
          float keep = step( iRnd.x, gInfo.b * uFade ) * inside * ( 1.0 - smoothstep( uRadius * 0.45, uRadius, dist ) );
          float gs = keep * ( 0.65 + iRnd.y * 0.7 ) * ( 0.7 + 0.3 * gInfo.b );
          float ga = iRnd.y * 43.98;
          mat2 gR = mat2( cos( ga ), -sin( ga ), sin( ga ), cos( ga ) );
          vec3 lp = position;
          lp.xz = gR * lp.xz;
          lp *= gs;
          float gw = sin( uTime * 1.6 + wxz.x * 0.31 + wxz.y * 0.23 ) + 0.45 * sin( uTime * 2.9 + wxz.x * 0.9 - wxz.y * 0.4 );
          lp.x += gw * 0.09 * bladeH * gs;
          lp.z += gw * 0.05 * bladeH * gs;
          vec3 gcol = textureLod( tGround, vec2( muv.x, muv.y ), 3.0 ).rgb;
          vGrass = gcol * mix( 0.5, 1.2, bladeH ) * mix( vec3( 1.0 ), vec3( 1.08, 1.06, 0.82 ), bladeH * iRnd.x );
          vec3 objectNormal = normalize( vec3( sin( ga ) * 0.25, 1.0, cos( ga ) * 0.25 ) );`,
        )
        .replace(
          '#include <begin_vertex>',
          `vec3 transformed = vec3( wxz.x + lp.x, grassHeightAt( simP ) + lp.y - 0.04, wxz.y + lp.z );`,
        );
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vGrass;')
        .replace('#include <color_fragment>', '#include <color_fragment>\ndiffuseColor.rgb *= vGrass;')
        // both faces of a blade take the upward normal (it blends with the ground's shading)
        .replace(
          '#include <normal_fragment_begin>',
          THREE.ShaderChunk.normal_fragment_begin.replace('float faceDirection = gl_FrontFacing ? 1.0 : - 1.0;', 'float faceDirection = 1.0;'),
        );
    };
    mat.customProgramCacheKey = () => 'grass-v1';
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.frustumCulled = false;
    this.mesh.receiveShadow = true;
    this.mesh.castShadow = false;
    this.mesh.renderOrder = -1;
  }

  /** Follow the camera focus; fade out as the camera pulls back (tufts become sub-pixel). */
  update(time: number, focus: THREE.Vector3, camDist: number): void {
    const u = this.uniforms;
    u.uTime.value = time;
    (u.uCenter.value as THREE.Vector2).set(focus.x, focus.z);
    const fade = 1 - THREE.MathUtils.smoothstep(camDist, 150, 230);
    u.uFade.value = fade;
    this.mesh.visible = fade > 0.01;
  }
}
