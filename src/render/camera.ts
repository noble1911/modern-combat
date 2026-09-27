import * as THREE from 'three';
import { clamp } from '../sim/math';

/**
 * RTS camera: orbits a ground target. Pan (WASD / arrows / edge / middle-drag with shift),
 * rotate (Q/E, middle-drag), zoom (wheel). Pitch flattens as you zoom in.
 */
export class RtsCamera {
  readonly camera: THREE.PerspectiveCamera;
  target = new THREE.Vector3();
  dist = 320;
  yaw = Math.PI / 2; // looking north by default
  pitchBias = 0;
  private keys = new Set<string>();
  private dragging = false;
  private lastX = 0;
  private lastY = 0;
  edgeScroll = true;
  private mouseX = -1;
  private mouseY = -1;
  private shake = 0;
  bounds = { w: 800, h: 800 };
  groundAt: (x: number, y: number) => number = () => 0;

  constructor(private dom: HTMLElement) {
    this.camera = new THREE.PerspectiveCamera(45, 1, 2, 6000);
    window.addEventListener('keydown', this.onKey);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', () => this.keys.clear());
    dom.addEventListener('wheel', this.onWheel, { passive: false });
    dom.addEventListener('mousedown', this.onDown);
    window.addEventListener('mousemove', this.onMove);
    window.addEventListener('mouseup', this.onUp);
  }

  dispose(): void {
    window.removeEventListener('keydown', this.onKey);
    window.removeEventListener('keyup', this.onKeyUp);
    this.dom.removeEventListener('wheel', this.onWheel);
    this.dom.removeEventListener('mousedown', this.onDown);
    window.removeEventListener('mousemove', this.onMove);
    window.removeEventListener('mouseup', this.onUp);
  }

  private onKey = (e: KeyboardEvent) => {
    if ((e.target as HTMLElement)?.tagName === 'INPUT') return;
    this.keys.add(e.code);
  };
  private onKeyUp = (e: KeyboardEvent) => this.keys.delete(e.code);
  private onWheel = (e: WheelEvent) => {
    e.preventDefault();
    const f = Math.exp(e.deltaY * 0.0012);
    this.dist = clamp(this.dist * f, 25, 1100);
  };
  private onDown = (e: MouseEvent) => {
    if (e.button === 1) {
      e.preventDefault();
      this.dragging = true;
      this.lastX = e.clientX;
      this.lastY = e.clientY;
    }
  };
  private onMove = (e: MouseEvent) => {
    this.mouseX = e.clientX;
    this.mouseY = e.clientY;
    if (!this.dragging) return;
    const dx = e.clientX - this.lastX;
    const dy = e.clientY - this.lastY;
    this.lastX = e.clientX;
    this.lastY = e.clientY;
    if (e.shiftKey) {
      this.pan(-dx * this.dist * 0.0022, dy * this.dist * 0.0022);
    } else {
      this.yaw -= dx * 0.006;
      this.pitchBias = clamp(this.pitchBias + dy * 0.003, -0.5, 0.45);
    }
  };
  private onUp = (e: MouseEvent) => {
    if (e.button === 1) this.dragging = false;
  };

  /** Pan in screen-relative directions (right, forward), metres. */
  pan(right: number, fwd: number): void {
    // camera looks along yaw (sim angle); forward on screen = yaw direction
    const fx = Math.cos(this.yaw);
    const fy = Math.sin(this.yaw);
    const rx = Math.sin(this.yaw);
    const ry = -Math.cos(this.yaw);
    const sx = this.target.x + rx * right + fx * fwd;
    const sy = -this.target.z + ry * right + fy * fwd;
    this.target.x = clamp(sx, 0, this.bounds.w);
    this.target.z = -clamp(sy, 0, this.bounds.h);
  }

  lookAt(x: number, y: number): void {
    this.target.set(clamp(x, 0, this.bounds.w), 0, -clamp(y, 0, this.bounds.h));
  }

  addShake(a: number): void {
    this.shake = Math.min(2.5, this.shake + a);
  }

  update(dt: number, width: number, height: number): void {
    const k = this.keys;
    const sp = this.dist * 1.2 * dt;
    let r = 0;
    let f = 0;
    if (k.has('KeyW') || k.has('ArrowUp')) f += sp;
    if (k.has('KeyS') || k.has('ArrowDown')) f -= sp;
    if (k.has('KeyA') || k.has('ArrowLeft')) r -= sp;
    if (k.has('KeyD') || k.has('ArrowRight')) r += sp;
    if (this.edgeScroll && this.mouseX >= 0 && document.hasFocus()) {
      const m = 6;
      if (this.mouseX < m) r -= sp;
      if (this.mouseX > width - m) r += sp;
      if (this.mouseY < m) f += sp;
      if (this.mouseY > height - m) f -= sp;
    }
    if (r || f) this.pan(r, f);
    if (k.has('KeyQ')) this.yaw += 1.4 * dt;
    if (k.has('KeyE')) this.yaw -= 1.4 * dt;
    if (k.has('PageUp') || k.has('Equal')) this.dist = clamp(this.dist * (1 - dt * 1.5), 25, 1100);
    if (k.has('PageDown') || k.has('Minus')) this.dist = clamp(this.dist * (1 + dt * 1.5), 25, 1100);
    // pitch: steeper when far away
    const t = clamp((this.dist - 25) / 700, 0, 1);
    const pitch = clamp(0.5 + t * 0.75 + this.pitchBias, 0.25, 1.45);
    const gy = this.groundAt(this.target.x, -this.target.z);
    this.target.y += (gy - this.target.y) * Math.min(1, dt * 5);
    const horiz = Math.cos(pitch) * this.dist;
    const cx = this.target.x - Math.cos(this.yaw) * horiz;
    const cy = -this.target.z - Math.sin(this.yaw) * horiz;
    let cz = this.target.y + Math.sin(pitch) * this.dist;
    cz = Math.max(cz, this.groundAt(cx, cy) + 6);
    let sx = 0;
    let sy = 0;
    if (this.shake > 0.01) {
      sx = (Math.random() - 0.5) * this.shake;
      sy = (Math.random() - 0.5) * this.shake;
      this.shake *= Math.exp(-dt * 6);
    }
    this.camera.position.set(cx + sx, cz + sy, -cy);
    this.camera.lookAt(this.target.x, this.target.y, this.target.z);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }

  /** Sim-space ground point under a screen pixel (ray-marched against the heightfield). */
  groundPick(ndcX: number, ndcY: number, maxDist = 4000): { x: number; y: number } | null {
    const ray = new THREE.Raycaster();
    ray.setFromCamera(new THREE.Vector2(ndcX, ndcY), this.camera);
    const o = ray.ray.origin;
    const d = ray.ray.direction;
    let prevT = 0;
    const step = 2;
    for (let t = step; t < maxDist; t += step * (1 + t / 400)) {
      const x = o.x + d.x * t;
      const z = o.z + d.z * t;
      const y = o.y + d.y * t;
      const g = this.groundAt(x, -z);
      if (y <= g) {
        // refine by bisection
        let lo = prevT;
        let hi = t;
        for (let i = 0; i < 8; i++) {
          const mid = (lo + hi) / 2;
          const my = o.y + d.y * mid;
          if (my <= this.groundAt(o.x + d.x * mid, -(o.z + d.z * mid))) hi = mid;
          else lo = mid;
        }
        return { x: o.x + d.x * hi, y: -(o.z + d.z * hi) };
      }
      prevT = t;
    }
    return null;
  }
}
