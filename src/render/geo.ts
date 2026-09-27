import * as THREE from 'three';

/** Accumulates flat-shaded triangles (position, normal, colour, uv) into one BufferGeometry. */
export class GeoBuilder {
  pos: number[] = [];
  nor: number[] = [];
  col: number[] = [];
  uv: number[] = [];

  private tri(a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, color: THREE.Color, ua?: number[], ub?: number[], uc?: number[]): void {
    const n = new THREE.Vector3().subVectors(b, a).cross(new THREE.Vector3().subVectors(c, a)).normalize();
    for (const [p, u] of [
      [a, ua],
      [b, ub],
      [c, uc],
    ] as [THREE.Vector3, number[] | undefined][]) {
      this.pos.push(p.x, p.y, p.z);
      this.nor.push(n.x, n.y, n.z);
      this.col.push(color.r, color.g, color.b);
      this.uv.push(u ? u[0] : 0, u ? u[1] : 0);
    }
  }

  /** Quad a-b-c-d (counter-clockwise seen from the front). */
  quad(a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, d: THREE.Vector3, color: THREE.Color, uvs?: number[][]): void {
    this.tri(a, b, c, color, uvs?.[0], uvs?.[1], uvs?.[2]);
    this.tri(a, c, d, color, uvs?.[0], uvs?.[2], uvs?.[3]);
  }

  triangle(a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, color: THREE.Color, uvs?: number[][]): void {
    this.tri(a, b, c, color, uvs?.[0], uvs?.[1], uvs?.[2]);
  }

  /** Axis-aligned-in-XZ box rotated by `rotY` around its centre (three.js coordinates). */
  box(cx: number, cy: number, cz: number, sx: number, sy: number, sz: number, color: THREE.Color, rotY = 0, uvScale = 0): void {
    const hx = sx / 2;
    const hy = sy / 2;
    const hz = sz / 2;
    const c = Math.cos(rotY);
    const s = Math.sin(rotY);
    const P = (x: number, y: number, z: number) => new THREE.Vector3(cx + x * c + z * s, cy + y, cz - x * s + z * c);
    const v = [P(-hx, -hy, -hz), P(hx, -hy, -hz), P(hx, hy, -hz), P(-hx, hy, -hz), P(-hx, -hy, hz), P(hx, -hy, hz), P(hx, hy, hz), P(-hx, hy, hz)];
    const uvq = (w: number, h: number) => (uvScale ? [[0, 0], [w / uvScale, 0], [w / uvScale, h / uvScale], [0, h / uvScale]] : undefined);
    this.quad(v[4], v[5], v[6], v[7], color, uvq(sx, sy)); // +z
    this.quad(v[1], v[0], v[3], v[2], color, uvq(sx, sy)); // -z
    this.quad(v[5], v[1], v[2], v[6], color, uvq(sz, sy)); // +x
    this.quad(v[0], v[4], v[7], v[3], color, uvq(sz, sy)); // -x
    this.quad(v[3], v[7], v[6], v[2], color, uvq(sx, sz)); // top
    this.quad(v[0], v[1], v[5], v[4], color, uvq(sx, sz)); // bottom
  }

  get empty(): boolean {
    return this.pos.length === 0;
  }

  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.computeBoundingSphere();
    return g;
  }
}
