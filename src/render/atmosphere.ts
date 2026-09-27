import * as THREE from 'three';
import { SunLight } from 'three/examples/jsm/lights/SunLight.js';
import { Sky } from 'three/examples/jsm/objects/Sky.js';

export type LightingId = 'morning' | 'noon' | 'afternoon' | 'overcast' | 'dusk';

export interface LightingPreset {
  name: string;
  /** Sun elevation above the horizon and compass bearing (0 = north, 90 = east), degrees. */
  elev: number;
  az: number;
  sun: number;
  sunIntensity: number;
  /** Preetham sky parameters. */
  turbidity: number;
  rayleigh: number;
  mie: number;
  clouds: number;
  cloudDensity: number;
  /** Image-based ambient light strength (scene.environmentIntensity). */
  env: number;
  /** Colour of the ground half of the environment map (sRGB): bounce light from below. */
  ground: number;
  /** FogExp2 density; the colour is sampled from the sky's horizon. */
  fog: number;
  exposure: number;
  /** Colour grade: saturation, contrast, shadow tint (lift) and highlight tint (gain). */
  grade: { sat: number; contrast: number; lift: [number, number, number]; gain: [number, number, number] };
  /** Tint applied to smoke and dust sprites so they sit in the scene's light. */
  smoke: number;
}

export const LIGHTING: Record<LightingId, LightingPreset> = {
  morning: {
    name: 'Morning', elev: 17, az: 112, sun: 0xffd6a8, sunIntensity: 4.0,
    turbidity: 4.5, rayleigh: 1.8, mie: 0.006, clouds: 0.22, cloudDensity: 0.35,
    env: 0.5, ground: 0x6b6446, fog: 0.00034, exposure: 0.95,
    grade: { sat: 1.06, contrast: 1.05, lift: [0.008, 0.006, 0.006], gain: [1.05, 1.0, 0.93] }, smoke: 0xf2e6d8,
  },
  noon: {
    name: 'Midday', elev: 56, az: 175, sun: 0xfff3e2, sunIntensity: 4.6,
    turbidity: 2.6, rayleigh: 1.0, mie: 0.005, clouds: 0.35, cloudDensity: 0.4,
    env: 0.46, ground: 0x6b6848, fog: 0.00024, exposure: 0.8,
    grade: { sat: 1.04, contrast: 1.06, lift: [0.0, 0.004, 0.012], gain: [1.0, 1.0, 0.98] }, smoke: 0xffffff,
  },
  afternoon: {
    name: 'Afternoon', elev: 34, az: 232, sun: 0xffe7c6, sunIntensity: 4.3,
    turbidity: 3.2, rayleigh: 1.3, mie: 0.005, clouds: 0.42, cloudDensity: 0.45,
    env: 0.48, ground: 0x6d6646, fog: 0.00028, exposure: 0.84,
    grade: { sat: 1.05, contrast: 1.06, lift: [0.004, 0.004, 0.016], gain: [1.02, 1.0, 0.96] }, smoke: 0xfaf0e4,
  },
  overcast: {
    name: 'Overcast', elev: 42, az: 200, sun: 0xe8eef4, sunIntensity: 1.3,
    turbidity: 9, rayleigh: 0.6, mie: 0.012, clouds: 0.92, cloudDensity: 0.8,
    env: 1.0, ground: 0x5d5e4c, fog: 0.00046, exposure: 1.05,
    grade: { sat: 0.9, contrast: 1.03, lift: [0.006, 0.01, 0.016], gain: [0.98, 1.0, 1.02] }, smoke: 0xdde2e6,
  },
  dusk: {
    name: 'Dusk', elev: 10.5, az: 258, sun: 0xffb070, sunIntensity: 4.0,
    turbidity: 5, rayleigh: 1.7, mie: 0.008, clouds: 0.35, cloudDensity: 0.4,
    env: 0.68, ground: 0x8a6a48, fog: 0.00034, exposure: 1.08,
    grade: { sat: 1.02, contrast: 1.05, lift: [0.018, 0.01, 0.012], gain: [1.07, 0.99, 0.9] }, smoke: 0xe8c8b0,
  },
};

/** Multiplier from the analytic sky model's radiance to scene light units. */
const SKY_SCALE = 0.16;

/** Deterministic default lighting for a battle seed (mostly daylight, sometimes grey or late). */
export function lightingForSeed(seed: number): LightingId {
  const ids: LightingId[] = ['afternoon', 'morning', 'noon', 'afternoon', 'overcast', 'morning', 'dusk', 'noon'];
  return ids[Math.abs(seed) % ids.length];
}

/**
 * Sky, sun and ambient light for a battle. The sky is Preetham's analytic model; an environment
 * map rendered from the same sky (plus a ground hemisphere for bounce light) provides the
 * ambient/specular lighting, and the fog colour is sampled from the sky's horizon so distant
 * terrain dissolves into it seamlessly. The sun casts two-cascade shadows (SunLight).
 */
export class Atmosphere {
  readonly sun: SunLight;
  readonly sky: Sky;
  readonly fog: THREE.FogExp2;
  readonly preset: LightingPreset;
  /** Unit vector pointing towards the sun (three.js coordinates). */
  readonly sunDir = new THREE.Vector3();
  private envRT: THREE.WebGLRenderTarget | null = null;
  private time = 0;

  constructor(
    private scene: THREE.Scene,
    private renderer: THREE.WebGLRenderer,
    readonly id: LightingId,
    shadows: boolean,
    quality: 'low' | 'high',
  ) {
    const p = (this.preset = LIGHTING[id] ?? LIGHTING.afternoon);
    const el = THREE.MathUtils.degToRad(p.elev);
    const az = THREE.MathUtils.degToRad(p.az);
    this.sunDir.set(Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el)).normalize();

    this.sky = new Sky();
    this.sky.scale.setScalar(4000);
    this.sky.frustumCulled = false;
    this.sky.renderOrder = -10;
    this.configureSky(this.sky, true);
    scene.add(this.sky);
    scene.background = null;

    this.sun = new SunLight(p.sun, p.sunIntensity);
    this.sun.position.copy(this.sunDir).multiplyScalar(1000);
    this.sun.castShadow = shadows;
    const res = quality === 'high' ? 3072 : 2048;
    this.sun.shadow.mapSize.set(res, res);
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.35;
    this.sun.shadow.radius = 1.5;
    this.sun.shadow.camera.near = 5;
    this.sun.shadow.camera.far = 1200;
    scene.add(this.sun);

    this.fog = new THREE.FogExp2(0xbfcad6, p.fog);
    scene.fog = this.fog;
    renderer.toneMappingExposure = p.exposure;
    this.buildEnvironment();
  }

  private configureSky(sky: Sky, disc: boolean): void {
    const p = this.preset;
    const m = sky.material;
    // Preetham radiance is ~20x brighter than our sunlit ground: scale it into the scene's units
    if (!m.uniforms.skyScale) {
      m.uniforms.skyScale = { value: SKY_SCALE };
      m.fragmentShader = m.fragmentShader
        .replace('uniform float time;', 'uniform float time;\nuniform float skyScale;')
        .replace('gl_FragColor = vec4( texColor, 1.0 );', 'gl_FragColor = vec4( texColor * skyScale, 1.0 );');
    }
    const u = m.uniforms;
    u.turbidity.value = p.turbidity;
    u.rayleigh.value = p.rayleigh;
    u.mieCoefficient.value = p.mie;
    u.mieDirectionalG.value = 0.8;
    u.sunPosition.value.copy(this.sunDir);
    u.cloudCoverage.value = p.clouds;
    u.cloudDensity.value = p.cloudDensity;
    u.showSunDisc.value = disc ? 1 : 0;
  }

  /** Pre-filtered environment map from the sky + ground, and the fog colour from its horizon. */
  private buildEnvironment(): void {
    const p = this.preset;
    const envScene = new THREE.Scene();
    const sky = new Sky();
    sky.scale.setScalar(100);
    this.configureSky(sky, false);
    envScene.add(sky);

    // fog colour: average the sky at the horizon all around (HDR, so read back as half floats)
    const cube = new THREE.WebGLCubeRenderTarget(16, { type: THREE.HalfFloatType });
    const cubeCam = new THREE.CubeCamera(0.1, 1000, cube);
    cubeCam.update(this.renderer, envScene);
    const px = new Uint16Array(16 * 2 * 4);
    const acc = [0, 0, 0];
    let n = 0;
    try {
      for (const face of [0, 1, 4, 5]) {
        this.renderer.readRenderTargetPixels(cube, 0, 7, 16, 2, px, face);
        for (let i = 0; i < 32; i++) {
          for (let k = 0; k < 3; k++) acc[k] += THREE.DataUtils.fromHalfFloat(px[i * 4 + k]);
          n++;
        }
      }
    } catch {
      n = 0;
    }
    if (n && acc[0] + acc[1] + acc[2] > 0) this.fog.color.setRGB(acc[0] / n, acc[1] / n, acc[2] / n, THREE.LinearSRGBColorSpace);
    cube.dispose();

    // the ground half of the environment: bounce light from sunlit fields
    const ground = new THREE.Mesh(
      new THREE.CircleGeometry(400, 24).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: new THREE.Color(p.ground).multiplyScalar(0.35 + 0.65 * Math.max(0.15, this.sunDir.y) * (p.sunIntensity / 4.3)), side: THREE.DoubleSide }),
    );
    ground.position.y = -6;
    envScene.add(ground);

    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.envRT = pmrem.fromScene(envScene, 0.02, 0.1, 1000);
    pmrem.dispose();
    this.scene.environment = this.envRT.texture;
    this.scene.environmentIntensity = p.env;
    sky.geometry.dispose();
    sky.material.dispose();
    ground.geometry.dispose();
    (ground.material as THREE.Material).dispose();
  }

  /** Per frame: sky follows the camera, clouds drift, shadow range follows the zoom. */
  update(dt: number, camera: THREE.PerspectiveCamera, camDist: number): void {
    this.time += dt;
    this.sky.position.copy(camera.position);
    this.sky.material.uniforms.time.value = this.time;
    // shadow cascades cover what's on screen: close-ups get crisp shadows, overviews reach far
    this.sun.shadow.camera.far = THREE.MathUtils.clamp(camDist * 3.2, 280, 2600);
  }

  dispose(): void {
    this.envRT?.dispose();
    this.sun.dispose();
    this.sky.geometry.dispose();
    this.sky.material.dispose();
  }
}
