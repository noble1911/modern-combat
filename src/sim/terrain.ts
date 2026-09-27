import { clamp, Vec2 } from './math';

/** Metres per terrain cell. */
export const CELL = 4;

export enum T {
  Grass = 0,
  Field = 1,
  Road = 2,
  Dirt = 3,
  Forest = 4,
  Orchard = 5,
  Hedge = 6,
  Wall = 7,
  Building = 8,
  Water = 9,
  Shallow = 10,
  Bridge = 11,
  Rubble = 12,
  Marsh = 13,
  Scrub = 14,
  Crater = 15,
}

export type Mobility = 'foot' | 'wheel' | 'track';

export interface TerrainProps {
  name: string;
  /** Speed multipliers per mobility class (0 = impassable). */
  foot: number;
  wheel: number;
  track: number;
  /** Fraction of small-arms hits stopped for a soldier occupying the cell (before stance). */
  cover: number;
  /** Fraction of blast/fragment effect stopped. */
  coverHE: number;
  /** 0..1, reduces the chance of being spotted. */
  conceal: number;
  /** Height of the obstacle above ground for line of sight (m). */
  losHeight: number;
  /** Solid obstacles block LOS outright; soft ones accumulate `density` per metre. */
  solid: boolean;
  density: number;
  /** Base colour for minimap / terrain texture. */
  color: [number, number, number];
}

export const TERRAIN: Record<T, TerrainProps> = {
  [T.Grass]: { name: 'Open ground', foot: 1, wheel: 0.75, track: 0.85, cover: 0.0, coverHE: 0.0, conceal: 0.05, losHeight: 0, solid: false, density: 0, color: [104, 128, 70] },
  [T.Field]: { name: 'Crop field', foot: 0.85, wheel: 0.6, track: 0.75, cover: 0.05, coverHE: 0.0, conceal: 0.35, losHeight: 1.3, solid: false, density: 0.07, color: [150, 140, 78] },
  [T.Road]: { name: 'Paved road', foot: 1.1, wheel: 1.0, track: 1.0, cover: 0, coverHE: 0, conceal: 0, losHeight: 0, solid: false, density: 0, color: [92, 92, 90] },
  [T.Dirt]: { name: 'Dirt track', foot: 1.05, wheel: 0.85, track: 0.95, cover: 0, coverHE: 0, conceal: 0, losHeight: 0, solid: false, density: 0, color: [128, 110, 80] },
  [T.Forest]: { name: 'Woods', foot: 0.7, wheel: 0, track: 0.3, cover: 0.3, coverHE: 0.25, conceal: 0.6, losHeight: 13, solid: false, density: 0.045, color: [48, 76, 40] },
  [T.Orchard]: { name: 'Orchard', foot: 0.9, wheel: 0.4, track: 0.6, cover: 0.12, coverHE: 0.1, conceal: 0.35, losHeight: 5, solid: false, density: 0.018, color: [86, 112, 58] },
  [T.Hedge]: { name: 'Hedgerow', foot: 0.5, wheel: 0, track: 0.45, cover: 0.35, coverHE: 0.3, conceal: 0.55, losHeight: 2.6, solid: true, density: 0, color: [58, 86, 44] },
  [T.Wall]: { name: 'Stone wall', foot: 0.55, wheel: 0, track: 0.5, cover: 0.6, coverHE: 0.5, conceal: 0.35, losHeight: 1.3, solid: true, density: 0, color: [140, 132, 118] },
  [T.Building]: { name: 'Building', foot: 0.8, wheel: 0, track: 0, cover: 0.65, coverHE: 0.55, conceal: 0.6, losHeight: 7, solid: true, density: 0, color: [150, 120, 100] },
  [T.Water]: { name: 'Deep water', foot: 0, wheel: 0, track: 0, cover: 0, coverHE: 0, conceal: 0, losHeight: 0, solid: false, density: 0, color: [52, 84, 110] },
  [T.Shallow]: { name: 'Stream', foot: 0.35, wheel: 0.2, track: 0.35, cover: 0.1, coverHE: 0.1, conceal: 0.1, losHeight: 0, solid: false, density: 0, color: [74, 104, 118] },
  [T.Bridge]: { name: 'Bridge', foot: 1.1, wheel: 1.0, track: 1.0, cover: 0.05, coverHE: 0, conceal: 0, losHeight: 0, solid: false, density: 0, color: [120, 116, 108] },
  [T.Rubble]: { name: 'Rubble', foot: 0.55, wheel: 0.15, track: 0.45, cover: 0.5, coverHE: 0.45, conceal: 0.45, losHeight: 1.8, solid: false, density: 0.12, color: [118, 108, 98] },
  [T.Marsh]: { name: 'Marsh', foot: 0.45, wheel: 0.1, track: 0.3, cover: 0.05, coverHE: 0.15, conceal: 0.25, losHeight: 0.9, solid: false, density: 0.03, color: [84, 102, 70] },
  [T.Scrub]: { name: 'Scrub', foot: 0.85, wheel: 0.5, track: 0.8, cover: 0.1, coverHE: 0.05, conceal: 0.45, losHeight: 1.6, solid: false, density: 0.06, color: [96, 112, 62] },
  [T.Crater]: { name: 'Shell crater', foot: 0.7, wheel: 0.3, track: 0.6, cover: 0.35, coverHE: 0.4, conceal: 0.2, losHeight: 0, solid: false, density: 0, color: [84, 76, 62] },
};

export interface Building {
  id: number;
  /** Footprint in cells (axis aligned). */
  cx: number;
  cy: number;
  cw: number;
  ch: number;
  floors: number;
  height: number;
  style: number;
  hp: number;
  maxHp: number;
  destroyed: boolean;
  name: string;
}

/** Transient smoke cloud (LOS obscurant). */
export interface SmokeCloud {
  id: number;
  x: number;
  y: number;
  r: number;
  /** Opacity per metre travelled through the cloud. */
  density: number;
  age: number;
  life: number;
  /** Cloud drift per second. */
  vx: number;
  vy: number;
}

export interface LosResult {
  clear: boolean;
  /** 0..1 accumulated soft obstruction (foliage/smoke/crops) along the ray. */
  obstruction: number;
  /** Distance along the ray where it became blocked (m), or total distance if clear. */
  blockedAt: number;
}

export class TerrainMap {
  readonly w: number; // cells
  readonly h: number;
  readonly width: number; // metres
  readonly height: number;
  readonly type: Uint8Array;
  /** Elevation at cell corners, (w+1)*(h+1). */
  readonly elev: Float32Array;
  /** Building id per cell, -1 if none. */
  readonly bld: Int16Array;
  readonly buildings: Building[] = [];
  smoke: SmokeCloud[] = [];
  waterLevel = -1000;
  /** Bridge deck height per cell (NaN where no bridge). */
  deck: Float32Array | null = null;
  /** Bumped whenever cells change (e.g. building destroyed) so caches / renderers can refresh. */
  version = 0;
  private clearanceCache = new Map<Mobility, Uint8Array>();

  constructor(w: number, h: number) {
    this.w = w;
    this.h = h;
    this.width = w * CELL;
    this.height = h * CELL;
    this.type = new Uint8Array(w * h);
    this.elev = new Float32Array((w + 1) * (h + 1));
    this.bld = new Int16Array(w * h).fill(-1);
  }

  inBounds(cx: number, cy: number): boolean {
    return cx >= 0 && cy >= 0 && cx < this.w && cy < this.h;
  }
  idx(cx: number, cy: number): number {
    return cy * this.w + cx;
  }
  cellOf(x: number, y: number): [number, number] {
    return [clamp(Math.floor(x / CELL), 0, this.w - 1), clamp(Math.floor(y / CELL), 0, this.h - 1)];
  }
  typeAt(x: number, y: number): T {
    const [cx, cy] = this.cellOf(x, y);
    return this.type[cy * this.w + cx];
  }
  propsAt(x: number, y: number): TerrainProps {
    return TERRAIN[this.typeAt(x, y) as T];
  }
  buildingAt(x: number, y: number): number {
    const [cx, cy] = this.cellOf(x, y);
    return this.bld[cy * this.w + cx];
  }
  cellCenter(cx: number, cy: number): Vec2 {
    return { x: (cx + 0.5) * CELL, y: (cy + 0.5) * CELL };
  }

  setDeck(deck: Float32Array): void {
    this.deck = deck;
  }

  /** Bilinear ground elevation (m). Bridges report deck height. */
  groundAt(x: number, y: number): number {
    const gx = clamp(x / CELL, 0, this.w - 0.0001);
    const gy = clamp(y / CELL, 0, this.h - 0.0001);
    const ix = Math.floor(gx);
    const iy = Math.floor(gy);
    if (this.deck) {
      const dv = this.deck[iy * this.w + ix];
      if (dv === dv && this.type[iy * this.w + ix] === T.Bridge) return dv;
    }
    const fx = gx - ix;
    const fy = gy - iy;
    const W = this.w + 1;
    const a = this.elev[iy * W + ix];
    const b = this.elev[iy * W + ix + 1];
    const c = this.elev[(iy + 1) * W + ix];
    const d = this.elev[(iy + 1) * W + ix + 1];
    return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
  }

  cornerElev(ix: number, iy: number): number {
    return this.elev[iy * (this.w + 1) + ix];
  }

  /** Top of obstacle in a cell (ground + feature height), used by LOS. */
  obstacleTop(cx: number, cy: number): number {
    const t = this.type[cy * this.w + cx] as T;
    const p = TERRAIN[t];
    let h = p.losHeight;
    if (t === T.Building) {
      const b = this.buildings[this.bld[cy * this.w + cx]];
      if (b) h = b.height;
    }
    return this.groundAt((cx + 0.5) * CELL, (cy + 0.5) * CELL) + h;
  }

  speedFactor(cx: number, cy: number, mob: Mobility): number {
    if (!this.inBounds(cx, cy)) return 0;
    const p = TERRAIN[this.type[cy * this.w + cx] as T];
    return p[mob];
  }

  /**
   * Vehicles are ~1 cell wide but can't squeeze through single-cell gaps: a cell is clear for them
   * if it is passable and not pinched between obstacles on opposite sides (E/W, N/S or diagonals).
   * Two-cell-wide roads and bridges stay drivable; alleys between buildings do not.
   */
  vehicleClearance(mob: Mobility): Uint8Array {
    let c = this.clearanceCache.get(mob);
    if (c) return c;
    c = new Uint8Array(this.w * this.h);
    const blocked = (x: number, y: number) => !this.inBounds(x, y) || this.speedFactor(x, y, mob) <= 0;
    for (let y = 0; y < this.h; y++) {
      for (let x = 0; x < this.w; x++) {
        if (blocked(x, y)) continue;
        const pinched =
          (blocked(x - 1, y) && blocked(x + 1, y)) ||
          (blocked(x, y - 1) && blocked(x, y + 1)) ||
          (blocked(x - 1, y - 1) && blocked(x + 1, y + 1)) ||
          (blocked(x - 1, y + 1) && blocked(x + 1, y - 1));
        c[y * this.w + x] = pinched ? 0 : 1;
      }
    }
    this.clearanceCache.set(mob, c);
    return c;
  }

  invalidateCaches(): void {
    this.clearanceCache.clear();
    this.version++;
  }

  /**
   * Line of sight between two points with eye heights above local ground.
   * Linear obstacles within `ignoreNear` metres of either end are ignored (a soldier firing
   * over the wall or through the hedge he is crouched behind). Buildings the observer/target stand in are transparent.
   * `smokeFactor` scales smoke opacity (thermal optics see through smoke better).
   */
  los(
    ax: number,
    ay: number,
    aEye: number,
    bx: number,
    by: number,
    bEye: number,
    smokeFactor = 1,
    ignoreNear = 6,
  ): LosResult {
    const dx = bx - ax;
    const dy = by - ay;
    const d = Math.hypot(dx, dy);
    const za = this.groundAt(ax, ay) + aEye;
    const zb = this.groundAt(bx, by) + bEye;
    if (d < 1) return { clear: true, obstruction: 0, blockedAt: d };
    const bA = this.buildingAt(ax, ay);
    const bB = this.buildingAt(bx, by);
    const step = 2;
    const n = Math.ceil(d / step);
    let obstruction = 0;
    let lastCell = -1;
    for (let i = 1; i < n; i++) {
      const t = i / n;
      const s = t * d;
      const x = ax + dx * t;
      const y = ay + dy * t;
      const z = za + (zb - za) * t;
      const g = this.groundAt(x, y);
      if (g > z) return { clear: false, obstruction: 1, blockedAt: s };
      const cx = Math.floor(x / CELL);
      const cy = Math.floor(y / CELL);
      if (!this.inBounds(cx, cy)) continue;
      const ci = cy * this.w + cx;
      if (ci === lastCell) {
        // soft obstruction accumulates per metre even within the same cell
        const tt = this.type[ci] as T;
        const p = TERRAIN[tt];
        if (!p.solid && p.density > 0 && g + p.losHeight > z) obstruction += p.density * step;
        if (obstruction >= 1) return { clear: false, obstruction: 1, blockedAt: s };
        continue;
      }
      lastCell = ci;
      const tt = this.type[ci] as T;
      const p = TERRAIN[tt];
      if (p.losHeight <= 0) continue;
      let top = g + p.losHeight;
      if (tt === T.Building) {
        const bid = this.bld[ci];
        if (bid === bA || bid === bB) continue;
        const b = this.buildings[bid];
        if (b) top = g + b.height;
      }
      if (top <= z) continue;
      if (p.solid) {
        const nearEnd = s < ignoreNear || d - s < ignoreNear;
        if (nearEnd && tt !== T.Building) continue;
        return { clear: false, obstruction: 1, blockedAt: s };
      }
      obstruction += p.density * step;
      if (obstruction >= 1) return { clear: false, obstruction: 1, blockedAt: s };
    }
    // Smoke clouds: 2D chord length through each circle (smoke is assumed ~8 m tall).
    if (this.smoke.length) {
      for (const c of this.smoke) {
        const fx = ax - c.x;
        const fy = ay - c.y;
        const a = dx * dx + dy * dy;
        const b = 2 * (fx * dx + fy * dy);
        const cc = fx * fx + fy * fy - c.r * c.r;
        const disc = b * b - 4 * a * cc;
        if (disc <= 0) continue;
        const sq = Math.sqrt(disc);
        const t0 = clamp((-b - sq) / (2 * a), 0, 1);
        const t1 = clamp((-b + sq) / (2 * a), 0, 1);
        if (t1 <= t0) continue;
        const zMid = za + (zb - za) * ((t0 + t1) / 2) - this.groundAt(c.x, c.y);
        if (zMid > 10) continue;
        const fade = c.age < 4 ? c.age / 4 : c.age > c.life - 8 ? Math.max(0, (c.life - c.age) / 8) : 1;
        obstruction += (t1 - t0) * d * c.density * smokeFactor * fade;
        if (obstruction >= 1) return { clear: false, obstruction: 1, blockedAt: d * t0 };
      }
    }
    return { clear: true, obstruction, blockedAt: d };
  }

  /**
   * Is the straight line between two points walkable for the mobility class? Visits every cell the
   * segment touches (Amanatides–Woo traversal) so smoothed paths never clip a corner.
   */
  walkable(ax: number, ay: number, bx: number, by: number, mob: Mobility): boolean {
    const clear = mob === 'foot' ? null : this.vehicleClearance(mob);
    let [cx, cy] = this.cellOf(ax, ay);
    const [ex, ey] = this.cellOf(bx, by);
    const s0 = this.speedFactor(cx, cy, mob);
    const dx = bx - ax;
    const dy = by - ay;
    const stepX = dx > 0 ? 1 : -1;
    const stepY = dy > 0 ? 1 : -1;
    const tDeltaX = dx !== 0 ? Math.abs(CELL / dx) : Infinity;
    const tDeltaY = dy !== 0 ? Math.abs(CELL / dy) : Infinity;
    let tMaxX = dx !== 0 ? ((dx > 0 ? (cx + 1) * CELL - ax : ax - cx * CELL) / Math.abs(dx)) : Infinity;
    let tMaxY = dy !== 0 ? ((dy > 0 ? (cy + 1) * CELL - ay : ay - cy * CELL) / Math.abs(dy)) : Infinity;
    for (let guard = 0; guard < 2000; guard++) {
      const f = this.speedFactor(cx, cy, mob);
      if (f <= 0) return false;
      if (clear && !clear[cy * this.w + cx] && guard > 0) return false;
      // don't smooth across big changes in terrain speed (keeps units on roads)
      if (f < s0 * 0.7) return false;
      if (cx === ex && cy === ey) return true;
      if (tMaxX < tMaxY) {
        tMaxX += tDeltaX;
        cx += stepX;
      } else {
        tMaxY += tDeltaY;
        cy += stepY;
      }
      if (!this.inBounds(cx, cy)) return false;
    }
    return false;
  }

  /** Protection value of a position against incoming fire from a direction. */
  coverAt(x: number, y: number, fromX: number, fromY: number): { cover: number; coverHE: number; conceal: number } {
    const [cx, cy] = this.cellOf(x, y);
    const own = TERRAIN[this.type[cy * this.w + cx] as T];
    let cover = own.cover;
    let coverHE = own.coverHE;
    let conceal = own.conceal;
    // Adjacent linear cover (wall/hedge/building edge) between us and the threat counts too.
    const ang = Math.atan2(fromY - y, fromX - x);
    const nx = Math.floor((x + Math.cos(ang) * CELL * 0.9) / CELL);
    const ny = Math.floor((y + Math.sin(ang) * CELL * 0.9) / CELL);
    if (this.inBounds(nx, ny) && (nx !== cx || ny !== cy)) {
      const t = this.type[ny * this.w + nx] as T;
      const p = TERRAIN[t];
      if (t === T.Wall || t === T.Hedge || t === T.Rubble || t === T.Building) {
        cover = Math.max(cover, p.cover * 0.85);
        coverHE = Math.max(coverHE, p.coverHE * 0.8);
        conceal = Math.max(conceal, p.conceal * 0.8);
      }
    }
    // Reverse slope / small rise between us and the shooter.
    const g = this.groundAt(x, y);
    const g2 = this.groundAt(x + Math.cos(ang) * 6, y + Math.sin(ang) * 6);
    if (g2 - g > 0.6) {
      cover = Math.max(cover, 0.35);
      coverHE = Math.max(coverHE, 0.3);
    }
    return { cover, coverHE, conceal };
  }

  /** Generic (direction-less) cover quality of a cell, 0..1, for cover-seeking. */
  cellCoverScore(cx: number, cy: number): number {
    if (!this.inBounds(cx, cy)) return -1;
    const p = TERRAIN[this.type[cy * this.w + cx] as T];
    if (p.foot <= 0) return -1;
    let best = p.cover * 1.0 + p.conceal * 0.4;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const nx = cx + dx;
        const ny = cy + dy;
        if (!this.inBounds(nx, ny)) continue;
        const t = this.type[ny * this.w + nx] as T;
        if (t === T.Wall || t === T.Hedge || t === T.Building || t === T.Rubble) {
          best = Math.max(best, TERRAIN[t].cover * 0.7 + 0.1);
        }
      }
    }
    return best;
  }

  /** Destroy a building: cells become rubble. */
  destroyBuilding(id: number): void {
    const b = this.buildings[id];
    if (!b || b.destroyed) return;
    b.destroyed = true;
    for (let y = b.cy; y < b.cy + b.ch; y++) {
      for (let x = b.cx; x < b.cx + b.cw; x++) {
        const i = y * this.w + x;
        if (this.bld[i] === id) this.type[i] = T.Rubble;
      }
    }
    this.invalidateCaches();
  }

  setCrater(x: number, y: number): void {
    const [cx, cy] = this.cellOf(x, y);
    const i = cy * this.w + cx;
    const t = this.type[i] as T;
    if (t === T.Grass || t === T.Field || t === T.Dirt || t === T.Scrub) {
      this.type[i] = T.Crater;
      this.version++;
    }
  }
}
