import * as THREE from 'three';
import { waterNormalTexture } from './groundDetail';

/**
 * River surface: glossy PBR water whose two ripple normal layers drift downstream at different
 * speeds (uv is in metres / 8). The sky environment gives the reflections and
 * fresnel; the sun leaves bright glints that the bloom pass picks up. Alpha fades at the banks
 * (the `bank` attribute runs 0..1 across) so the edge dissolves into the painted river bed.
 */
export function waterMaterial(time: { value: number }): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({
    color: 0x2a4a50,
    roughness: 0.06,
    metalness: 0,
    transparent: true,
    opacity: 0.92,
    normalMap: waterNormalTexture(),
    normalScale: new THREE.Vector2(0.45, 0.45),
    envMapIntensity: 1.3,
    side: THREE.DoubleSide,
  });
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = time;
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float uTime;')
      .replace(
        '#include <normal_fragment_maps>',
        `vec2 wuv = vNormalMapUv;
        vec3 n1 = texture2D( normalMap, wuv * vec2( 1.0, 1.0 ) + vec2( 0.013, -0.09 ) * uTime ).xyz * 2.0 - 1.0;
        vec3 n2 = texture2D( normalMap, wuv * vec2( 1.9, 1.7 ) + vec2( -0.021, -0.052 ) * uTime ).xyz * 2.0 - 1.0;
        vec3 mapN = normalize( vec3( n1.xy + n2.xy, n1.z * n2.z ) );
        mapN.xy *= normalScale;
        normal = normalize( tbn * mapN );`,
      )
      .replace(
        '#include <alphamap_fragment>',
        `#include <alphamap_fragment>
        float bank = smoothstep( 0.0, 0.14, vBankU ) * smoothstep( 1.0, 0.86, vBankU );
        diffuseColor.a *= mix( 0.35, 1.0, bank );`,
      )
      .replace('#include <common>', '#include <common>\nvarying float vBankU;');
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float bank;\nvarying float vBankU;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvBankU = bank;');
  };
  mat.customProgramCacheKey = () => 'water-v1';
  return mat;
}
