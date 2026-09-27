import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { GTAOPass } from 'three/examples/jsm/postprocessing/GTAOPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import type { LightingPreset } from './atmosphere';

/** GTAO at a fraction of the screen resolution (the composer always passes full size). */
class ScaledGTAOPass extends GTAOPass {
  scaleFactor = 0.5;
  setSize(width: number, height: number): void {
    super.setSize(Math.max(1, Math.round(width * this.scaleFactor)), Math.max(1, Math.round(height * this.scaleFactor)));
  }
}

/** Display-referred grade after tone mapping: contrast, saturation, split tint, vignette, grain. */
const GradeShader = {
  name: 'GradeShader',
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    sat: { value: 1 },
    contrast: { value: 1 },
    lift: { value: new THREE.Vector3() },
    gain: { value: new THREE.Vector3(1, 1, 1) },
    vignette: { value: 0.22 },
    grain: { value: 0.012 },
    time: { value: 0 },
    aspect: { value: 1 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float sat, contrast, vignette, grain, time, aspect;
    uniform vec3 lift, gain;
    varying vec2 vUv;
    float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
    void main() {
      vec4 tex = texture2D(tDiffuse, vUv);
      vec3 c = tex.rgb;
      float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
      c = mix(vec3(l), c, sat);
      c = (c - 0.5) * contrast + 0.5;
      c = c * gain + lift * (1.0 - c);
      vec2 d = (vUv - 0.5) * vec2(aspect, 1.0);
      c *= 1.0 - vignette * smoothstep(0.35, 1.05, length(d) * 1.25);
      c += (hash(vUv * 1024.0 + fract(time) * 37.0) - 0.5) * grain;
      gl_FragColor = vec4(clamp(c, 0.0, 1.0), tex.a);
    }`,
};

export interface PostOptions {
  ao: boolean;
  bloom: boolean;
  msaa: number;
}

/**
 * HDR post-processing chain: scene → ground-truth ambient occlusion (from the scene depth) →
 * bloom (only very bright pixels: flashes, fire, tracers, the sun) → ACES tone map + sRGB →
 * colour grade.
 */
export class PostFX {
  readonly composer: EffectComposer;
  private gtao: ScaledGTAOPass | null = null;
  private bloom: UnrealBloomPass | null = null;
  private grade: ShaderPass;
  private target: THREE.WebGLRenderTarget;
  private time = 0;

  constructor(
    private renderer: THREE.WebGLRenderer,
    scene: THREE.Scene,
    camera: THREE.PerspectiveCamera,
    preset: LightingPreset,
    opts: PostOptions,
  ) {
    const size = renderer.getDrawingBufferSize(new THREE.Vector2());
    const depthTexture = new THREE.DepthTexture(size.x, size.y);
    depthTexture.type = THREE.UnsignedIntType;
    this.target = new THREE.WebGLRenderTarget(size.x, size.y, {
      type: THREE.HalfFloatType,
      samples: opts.msaa,
      depthTexture,
    });
    this.composer = new EffectComposer(renderer, this.target);
    this.composer.addPass(new RenderPass(scene, camera));

    if (opts.ao) {
      const gtao = new ScaledGTAOPass(scene, camera, size.x, size.y);
      gtao.updateGtaoMaterial({ radius: 2.2, distanceExponent: 1.6, thickness: 6, distanceFallOff: 0.6, scale: 1.25, samples: 12, screenSpaceRadius: false });
      gtao.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: 6, rings: 2, samples: 12 });
      gtao.blendIntensity = 0.85;
      this.gtao = gtao;
      this.composer.addPass(gtao);
    }
    if (opts.bloom) {
      // threshold in linear HDR: only emissive-bright things (flashes > 1) bloom
      this.bloom = new UnrealBloomPass(new THREE.Vector2(size.x / 2, size.y / 2), 0.55, 0.45, 1.05);
      this.composer.addPass(this.bloom);
    }
    this.composer.addPass(new OutputPass());
    this.grade = new ShaderPass(GradeShader);
    this.setGrade(preset);
    this.composer.addPass(this.grade);
  }

  setGrade(p: LightingPreset): void {
    const u = this.grade.uniforms;
    u.sat.value = p.grade.sat;
    u.contrast.value = p.grade.contrast;
    u.lift.value.set(...p.grade.lift);
    u.gain.value.set(...p.grade.gain);
  }

  setSize(w: number, h: number): void {
    this.composer.setPixelRatio(this.renderer.getPixelRatio());
    this.composer.setSize(w, h);
    this.grade.uniforms.aspect.value = w / Math.max(1, h);
  }

  render(dt: number): void {
    this.time += dt;
    this.grade.uniforms.time.value = this.time;
    if (this.gtao) {
      // the scene pass renders into whichever buffer is "read" this frame: use its depth
      const depth = this.composer.readBuffer.depthTexture;
      if (depth && this.gtao.depthTexture !== depth) this.gtao.setGBuffer(depth);
    }
    this.composer.render(dt);
  }

  dispose(): void {
    this.composer.dispose();
    this.target.dispose();
    this.gtao?.dispose();
    this.bloom?.dispose();
  }
}
