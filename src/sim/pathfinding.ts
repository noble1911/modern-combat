import { CELL, Mobility, T, TerrainMap } from './terrain';
import type { Vec2 } from './math';
import { dhypot } from './dmath';

/** Binary min-heap keyed by f-score, storing cell indices. */
class Heap {
  private items: number[] = [];
  private keys: number[] = [];
  get size(): number {
    return this.items.length;
  }
  push(item: number, key: number): void {
    const a = this.items;
    const k = this.keys;
    a.push(item);
    k.push(key);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (k[p] <= k[i]) break;
      [a[p], a[i]] = [a[i], a[p]];
      [k[p], k[i]] = [k[i], k[p]];
      i = p;
    }
  }
  pop(): number {
    const a = this.items;
    const k = this.keys;
    const top = a[0];
    const lastI = a.pop()!;
    const lastK = k.pop()!;
    if (a.length) {
      a[0] = lastI;
      k[0] = lastK;
      let i = 0;
      const n = a.length;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let m = i;
        if (l < n && k[l] < k[m]) m = l;
        if (r < n && k[r] < k[m]) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]];
        [k[m], k[i]] = [k[i], k[m]];
        i = m;
      }
    }
    return top;
  }
}

const DIRS = [
  [1, 0, 1],
  [-1, 0, 1],
  [0, 1, 1],
  [0, -1, 1],
  [1, 1, Math.SQRT2],
  [1, -1, Math.SQRT2],
  [-1, 1, Math.SQRT2],
  [-1, -1, Math.SQRT2],
] as const;

export interface PathOptions {
  mob: Mobility;
  /** Prefer concealed routes (sneak). */
  stealth?: boolean;
  /** Extra per-cell cost map (e.g. danger); same indexing as the terrain grid. */
  danger?: Float32Array;
  maxNodes?: number;
}

// Reusable scratch buffers (sim is single threaded).
let gScore: Float32Array | null = null;
let came: Int32Array | null = null;
let closedGen: Uint32Array | null = null;
let openGen: Uint32Array | null = null;
let gen = 1;

function ensure(n: number): void {
  if (!gScore || gScore.length !== n) {
    gScore = new Float32Array(n);
    came = new Int32Array(n);
    closedGen = new Uint32Array(n);
    openGen = new Uint32Array(n);
    gen = 1;
  }
}

function cellCost(map: TerrainMap, i: number, opts: PathOptions, clearance: Uint8Array | null): number {
  if (clearance && !clearance[i]) return -1;
  const t = map.type[i] as T;
  const cx = i % map.w;
  const cy = (i / map.w) | 0;
  const f = map.speedFactor(cx, cy, opts.mob);
  if (f <= 0) return -1;
  let c = 1 / f;
  if (opts.stealth) {
    const conceal = t === T.Forest || t === T.Hedge || t === T.Building || t === T.Field || t === T.Scrub || t === T.Orchard ? 0 : 0.8;
    c += conceal;
  }
  if (opts.danger) c += opts.danger[i];
  return c;
}

/** Find nearest passable cell to (cx,cy) for the given mobility, spiral search. */
export function nearestPassable(map: TerrainMap, x: number, y: number, mob: Mobility, maxR = 12): Vec2 | null {
  const [cx, cy] = map.cellOf(x, y);
  const clearance = mob === 'foot' ? null : map.vehicleClearance(mob);
  const ok = (ix: number, iy: number) =>
    map.inBounds(ix, iy) && map.speedFactor(ix, iy, mob) > 0 && (!clearance || clearance[iy * map.w + ix] === 1);
  if (ok(cx, cy)) return { x, y };
  for (let r = 1; r <= maxR; r++) {
    let best: Vec2 | null = null;
    let bd = Infinity;
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        if (ok(cx + dx, cy + dy)) {
          const c = map.cellCenter(cx + dx, cy + dy);
          const d = (c.x - x) ** 2 + (c.y - y) ** 2;
          if (d < bd) {
            bd = d;
            best = c;
          }
        }
      }
    }
    if (best) return best;
  }
  return null;
}

/**
 * A* over the terrain grid. Returns a smoothed list of waypoints (metres) ending at `to`
 * (or at the nearest reachable point), or null if no path.
 */
export function findPath(map: TerrainMap, from: Vec2, to: Vec2, opts: PathOptions): Vec2[] | null {
  const n = map.w * map.h;
  ensure(n);
  gen++;
  if (gen > 0xfffffff0) {
    closedGen!.fill(0);
    openGen!.fill(0);
    gen = 1;
  }
  const clearance = opts.mob === 'foot' ? null : map.vehicleClearance(opts.mob);
  const start = nearestPassable(map, from.x, from.y, opts.mob, 4) ?? from;
  const goalP = nearestPassable(map, to.x, to.y, opts.mob, 16);
  if (!goalP) return null;
  const [sx, sy] = map.cellOf(start.x, start.y);
  const [gx, gy] = map.cellOf(goalP.x, goalP.y);
  const si = sy * map.w + sx;
  const gi = gy * map.w + gx;
  if (si === gi) return [{ x: goalP.x, y: goalP.y }];

  // Heuristic scaled by best possible speed so it stays admissible.
  const bestSpeed = opts.mob === 'foot' ? 1.1 : 1.0;
  const h = (i: number) => {
    const x = i % map.w;
    const y = (i / map.w) | 0;
    const dx = Math.abs(x - gx);
    const dy = Math.abs(y - gy);
    return ((dx + dy) + (Math.SQRT2 - 2) * Math.min(dx, dy)) / bestSpeed;
  };

  const open = new Heap();
  gScore![si] = 0;
  came![si] = -1;
  openGen![si] = gen;
  open.push(si, h(si));
  const maxNodes = opts.maxNodes ?? 60000;
  let expanded = 0;
  let bestI = si;
  let bestH = h(si);
  let found = false;

  while (open.size) {
    const cur = open.pop();
    if (closedGen![cur] === gen) continue;
    closedGen![cur] = gen;
    if (cur === gi) {
      found = true;
      break;
    }
    const hc = h(cur);
    if (hc < bestH) {
      bestH = hc;
      bestI = cur;
    }
    if (++expanded > maxNodes) break;
    const cx = cur % map.w;
    const cy = (cur / map.w) | 0;
    for (const [dx, dy, dl] of DIRS) {
      const nx = cx + dx;
      const ny = cy + dy;
      if (nx < 0 || ny < 0 || nx >= map.w || ny >= map.h) continue;
      const ni = ny * map.w + nx;
      if (closedGen![ni] === gen) continue;
      const c = cellCost(map, ni, opts, clearance);
      if (c < 0) continue;
      if (dx && dy) {
        // no corner cutting
        if (cellCost(map, cy * map.w + nx, opts, clearance) < 0 || cellCost(map, ny * map.w + cx, opts, clearance) < 0) continue;
      }
      const g = gScore![cur] + c * dl;
      if (openGen![ni] !== gen || g < gScore![ni]) {
        openGen![ni] = gen;
        gScore![ni] = g;
        came![ni] = cur;
        open.push(ni, g + h(ni));
      }
    }
  }

  const endI = found ? gi : bestI;
  if (endI === si) return null;
  const cells: number[] = [];
  for (let i = endI; i !== -1; i = came![i]) cells.push(i);
  cells.reverse();
  const pts: Vec2[] = cells.map((i) => map.cellCenter(i % map.w, (i / map.w) | 0));
  pts[0] = { x: start.x, y: start.y };
  if (found) pts[pts.length - 1] = { x: goalP.x, y: goalP.y };
  return smoothPath(map, pts, opts.mob);
}

/** String-pulling: drop waypoints that can be skipped with a straight walkable line. */
export function smoothPath(map: TerrainMap, pts: Vec2[], mob: Mobility): Vec2[] {
  if (pts.length <= 2) return pts.slice(1);
  const out: Vec2[] = [];
  let anchor = 0;
  while (anchor < pts.length - 1) {
    let far = anchor + 1;
    // look ahead at most ~40 cells to keep this cheap
    const lim = Math.min(pts.length - 1, anchor + 40);
    for (let j = lim; j > anchor + 1; j--) {
      if (map.walkable(pts[anchor].x, pts[anchor].y, pts[j].x, pts[j].y, mob)) {
        far = j;
        break;
      }
    }
    out.push(pts[far]);
    anchor = far;
  }
  return out;
}

export function pathLength(from: Vec2, path: Vec2[]): number {
  let l = 0;
  let p = from;
  for (const q of path) {
    l += dhypot(q.x - p.x, q.y - p.y);
    p = q;
  }
  return l;
}

export { CELL };
