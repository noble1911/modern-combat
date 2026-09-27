import type { Side } from '../data/units';
import { clamp, distToSegment, pointInPolygon, Rng, ValueNoise, Vec2 } from './math';
import { Building, CELL, T, TerrainMap } from './terrain';
import { dcos, dexp, dhypot, dsin } from './dmath';

export type P = [number, number];

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface MapDef {
  id: string;
  name: string;
  description: string;
  size: [number, number];
  seed: number;
  relief: { amp: number; scale: number };
  hills?: { x: number; y: number; r: number; h: number }[];
  rivers?: { pts: P[]; width: number; depth?: number; shallow?: boolean }[];
  roads?: { pts: P[]; width?: number; dirt?: boolean }[];
  areas?: { type: 'forest' | 'field' | 'orchard' | 'scrub' | 'marsh' | 'grass'; pts: P[] }[];
  /** Random blobs of an area type inside a rect (quick way to scatter copses/fields). */
  scatter?: { type: 'forest' | 'field' | 'orchard' | 'scrub'; rect: Rect; count: number; r: [number, number] }[];
  hedges?: P[][];
  walls?: P[][];
  towns?: { rect: Rect; density: number; floors: [number, number]; lot?: [number, number]; setback?: number; fill?: number; holes?: Rect[] }[];
  buildings?: { x: number; y: number; w: number; h: number; floors: number; name?: string }[];
  vls: { id: string; name: string; x: number; y: number; value: number; owner?: Side | null; r?: number }[];
  deploy: Record<Side, Rect>;
  /** Deployment when the roles are reversed (the default defender attacks), with rear edges. */
  deployAlt?: { zones: Record<Side, Rect>; rear: Record<Side, 'north' | 'south' | 'east' | 'west'>; attacker: Side };
  /** Map edge each side's reinforcements/retreats use. */
  rear: Record<Side, 'north' | 'south' | 'east' | 'west'>;
}

export interface GeneratedMap {
  def: MapDef;
  map: TerrainMap;
  /** Road centrelines kept for rendering (smooth roads + bridge decks). */
  roads: { pts: Vec2[]; width: number; dirt: boolean }[];
  rivers: { pts: Vec2[]; width: number; level: number }[];
  bridges: { x1: number; y1: number; x2: number; y2: number; width: number; deck: number }[];
}

function polylineCells(map: TerrainMap, pts: P[], halfWidth: number, fn: (cx: number, cy: number, d: number) => void): void {
  for (let i = 0; i < pts.length - 1; i++) {
    const a = { x: pts[i][0], y: pts[i][1] };
    const b = { x: pts[i + 1][0], y: pts[i + 1][1] };
    const minX = Math.floor((Math.min(a.x, b.x) - halfWidth) / CELL) - 1;
    const maxX = Math.ceil((Math.max(a.x, b.x) + halfWidth) / CELL) + 1;
    const minY = Math.floor((Math.min(a.y, b.y) - halfWidth) / CELL) - 1;
    const maxY = Math.ceil((Math.max(a.y, b.y) + halfWidth) / CELL) + 1;
    for (let cy = Math.max(0, minY); cy <= Math.min(map.h - 1, maxY); cy++) {
      for (let cx = Math.max(0, minX); cx <= Math.min(map.w - 1, maxX); cx++) {
        const c = map.cellCenter(cx, cy);
        const d = distToSegment(c, a, b);
        if (d <= halfWidth) fn(cx, cy, d);
      }
    }
  }
}

/** Thin (1-cell) line rasterisation for hedges/walls. */
function lineCells(map: TerrainMap, pts: P[], fn: (cx: number, cy: number) => void): void {
  for (let i = 0; i < pts.length - 1; i++) {
    let [x0, y0] = map.cellOf(pts[i][0], pts[i][1]);
    const [x1, y1] = map.cellOf(pts[i + 1][0], pts[i + 1][1]);
    const dx = Math.abs(x1 - x0);
    const dy = -Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1;
    const sy = y0 < y1 ? 1 : -1;
    let err = dx + dy;
    for (;;) {
      fn(x0, y0);
      if (x0 === x1 && y0 === y1) break;
      const e2 = 2 * err;
      // 4-connected so LOS can't slip diagonally through
      if (e2 >= dy && e2 <= dx) {
        if (Math.abs(err + dy) < Math.abs(err + dx)) {
          err += dy;
          x0 += sx;
        } else {
          err += dx;
          y0 += sy;
        }
      } else if (e2 >= dy) {
        err += dy;
        x0 += sx;
      } else {
        err += dx;
        y0 += sy;
      }
    }
  }
}

function polygonCells(map: TerrainMap, pts: P[], fn: (cx: number, cy: number) => void): void {
  const poly = pts.map(([x, y]) => ({ x, y }));
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const [x0, y0] = map.cellOf(Math.min(...xs), Math.min(...ys));
  const [x1, y1] = map.cellOf(Math.max(...xs), Math.max(...ys));
  for (let cy = y0; cy <= y1; cy++) for (let cx = x0; cx <= x1; cx++) if (pointInPolygon(map.cellCenter(cx, cy), poly)) fn(cx, cy);
}

/** Irregular blob polygon around a centre. */
export function blob(x: number, y: number, r: number, seed: number, n = 12, irregular = 0.35): P[] {
  const rng = new Rng(seed);
  const out: P[] = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const rr = r * (1 - irregular + rng.next() * irregular * 2);
    out.push([x + dcos(a) * rr, y + dsin(a) * rr]);
  }
  return out;
}

const AREA_T: Record<string, T> = {
  forest: T.Forest,
  field: T.Field,
  orchard: T.Orchard,
  scrub: T.Scrub,
  marsh: T.Marsh,
  grass: T.Grass,
};

export function generateMap(def: MapDef): GeneratedMap {
  const w = Math.round(def.size[0] / CELL);
  const h = Math.round(def.size[1] / CELL);
  const map = new TerrainMap(w, h);
  const rng = new Rng(def.seed);
  const noise = new ValueNoise(def.seed * 7 + 3);
  const W = w + 1;

  // ---- elevation ----
  for (let iy = 0; iy <= h; iy++) {
    for (let ix = 0; ix <= w; ix++) {
      const x = ix * CELL;
      const y = iy * CELL;
      let e = noise.fbm(x / def.relief.scale, y / def.relief.scale, 4) * def.relief.amp;
      for (const hl of def.hills ?? []) {
        const d2 = ((x - hl.x) ** 2 + (y - hl.y) ** 2) / (hl.r * hl.r);
        e += hl.h * dexp(-d2 * 2);
      }
      map.elev[iy * W + ix] = e;
    }
  }

  // ---- base ground variation: patches of scrub/long grass ----
  for (let cy = 0; cy < h; cy++) {
    for (let cx = 0; cx < w; cx++) {
      const n = noise.noise(cx * 0.09 + 100, cy * 0.09 + 50);
      map.type[cy * w + cx] = n > 0.55 ? T.Scrub : T.Grass;
    }
  }

  // ---- areas ----
  for (const a of def.areas ?? []) polygonCells(map, a.pts, (cx, cy) => (map.type[cy * w + cx] = AREA_T[a.type]));
  for (const s of def.scatter ?? []) {
    for (let i = 0; i < s.count; i++) {
      const x = s.rect.x + rng.next() * s.rect.w;
      const y = s.rect.y + rng.next() * s.rect.h;
      const r = rng.range(s.r[0], s.r[1]);
      polygonCells(map, blob(x, y, r, rng.int(1, 1e9)), (cx, cy) => (map.type[cy * w + cx] = AREA_T[s.type]));
    }
  }

  // ---- rivers ----
  const riverMask = new Uint8Array(w * h);
  const rivers: GeneratedMap['rivers'] = [];
  let waterLevel = Infinity;
  for (const r of def.rivers ?? []) {
    rivers.push({ pts: r.pts.map(([x, y]) => ({ x, y })), width: r.width, level: 0 });
    polylineCells(map, r.pts, r.width / 2, (cx, cy) => {
      map.type[cy * w + cx] = r.shallow ? T.Shallow : T.Water;
      riverMask[cy * w + cx] = 1;
    });
    // Riverbanks: marshy/grass verge
    polylineCells(map, r.pts, r.width / 2 + CELL * 1.5, (cx, cy) => {
      const i = cy * w + cx;
      if (!riverMask[i] && map.type[i] === T.Forest) map.type[i] = T.Scrub;
    });
  }
  // carve riverbed: flat bed at (lowest bank level - depth), sloping banks up to the terrain
  for (let ri = 0; ri < (def.rivers ?? []).length; ri++) {
    const r = def.rivers![ri];
    const half = r.width / 2;
    const bankZone = half + 16;
    const depth = r.depth ?? (r.shallow ? 0.8 : 3);
    const segs = r.pts.slice(0, -1).map((p, i) => [{ x: p[0], y: p[1] }, { x: r.pts[i + 1][0], y: r.pts[i + 1][1] }] as const);
    const distAt = (x: number, y: number) => {
      let d = Infinity;
      for (const [a, b] of segs) d = Math.min(d, distToSegment({ x, y }, a, b));
      return d;
    };
    const dists = new Float32Array((w + 1) * (h + 1)).fill(Infinity);
    let bankLevel = Infinity;
    for (let iy = 0; iy <= h; iy++) {
      for (let ix = 0; ix <= w; ix++) {
        const d = distAt(ix * CELL, iy * CELL);
        dists[iy * W + ix] = d;
        if (d < bankZone) bankLevel = Math.min(bankLevel, map.elev[iy * W + ix]);
      }
    }
    if (!Number.isFinite(bankLevel)) continue;
    const bed = bankLevel - depth;
    for (let k = 0; k < dists.length; k++) {
      const d = dists[k];
      if (d >= bankZone) continue;
      const t = clamp((d - half + CELL) / (bankZone - half + CELL), 0, 1);
      const s = t * t * (3 - 2 * t);
      map.elev[k] = bed + (map.elev[k] - bed) * s;
    }
    rivers[ri].level = bankLevel - (r.shallow ? 0.4 : 0.9);
    waterLevel = Math.min(waterLevel, rivers[ri].level);
  }

  // ---- roads & bridges ----
  const roads: GeneratedMap['roads'] = [];
  const bridges: GeneratedMap['bridges'] = [];
  const roadMask = new Uint8Array(w * h);
  const deck = new Float32Array(w * h).fill(NaN);
  for (const r of def.roads ?? []) {
    const width = r.width ?? (r.dirt ? 5 : 8);
    roads.push({ pts: r.pts.map(([x, y]) => ({ x, y })), width, dirt: !!r.dirt });
    polylineCells(map, r.pts, width / 2, (cx, cy) => {
      const i = cy * w + cx;
      roadMask[i] = 1;
      if (riverMask[i]) map.type[i] = T.Bridge;
      else map.type[i] = r.dirt ? T.Dirt : T.Road;
    });
  }
  // bridge decks: find contiguous bridge runs per road segment and give them the bank height
  for (const r of roads) {
    for (let i = 0; i < r.pts.length - 1; i++) {
      const a = r.pts[i];
      const b = r.pts[i + 1];
      const len = dhypot(b.x - a.x, b.y - a.y);
      const n = Math.ceil(len / 2);
      let inB = false;
      let startT = 0;
      for (let k = 0; k <= n; k++) {
        const t = k / n;
        const x = a.x + (b.x - a.x) * t;
        const y = a.y + (b.y - a.y) * t;
        const isB = map.typeAt(x, y) === T.Bridge;
        if (isB && !inB) {
          inB = true;
          startT = t;
        } else if (!isB && inB) {
          inB = false;
          const pad = 6 / len;
          const t0 = Math.max(0, startT - pad);
          const t1 = Math.min(1, t + pad);
          const x1 = a.x + (b.x - a.x) * t0;
          const y1 = a.y + (b.y - a.y) * t0;
          const x2 = a.x + (b.x - a.x) * t1;
          const y2 = a.y + (b.y - a.y) * t1;
          const d = Math.max(map.groundAt(x1, y1), map.groundAt(x2, y2)) + 0.3;
          bridges.push({ x1, y1, x2, y2, width: r.width + 2, deck: d });
          polylineCells(map, [[x1, y1], [x2, y2]], r.width / 2 + 1, (cx, cy) => {
            const ii = cy * w + cx;
            if (map.type[ii] === T.Bridge) deck[ii] = d;
          });
        }
      }
    }
  }
  map.setDeck(deck);
  // flatten terrain a bit along roads (not bridges)
  for (let iy = 1; iy < h; iy++) {
    for (let ix = 1; ix < w; ix++) {
      const i = iy * w + ix;
      if (!roadMask[i] || riverMask[i]) continue;
      const k = iy * W + ix;
      const avg = (map.elev[k - 1] + map.elev[k + 1] + map.elev[k - W] + map.elev[k + W] + map.elev[k] * 2) / 6;
      map.elev[k] = avg;
    }
  }

  // ---- hedges & walls ----
  const lineFeature = (lines: P[][] | undefined, t: T) => {
    for (const l of lines ?? []) {
      lineCells(map, l, (cx, cy) => {
        const i = cy * w + cx;
        if (roadMask[i] || riverMask[i]) return;
        map.type[i] = t;
      });
    }
  };
  lineFeature(def.hedges, T.Hedge);
  lineFeature(def.walls, T.Wall);

  // ---- buildings ----
  const canBuild = (cx: number, cy: number, cw: number, ch: number, margin: number): boolean => {
    for (let y = cy - margin; y < cy + ch + margin; y++) {
      for (let x = cx - margin; x < cx + cw + margin; x++) {
        if (!map.inBounds(x, y)) return false;
        const i = y * w + x;
        if (map.bld[i] >= 0) return false;
        if (y >= cy && y < cy + ch && x >= cx && x < cx + cw) {
          if (roadMask[i] || riverMask[i]) return false;
        }
      }
    }
    return true;
  };
  const place = (cx: number, cy: number, cw: number, ch: number, floors: number, name?: string): boolean => {
    if (!canBuild(cx, cy, cw, ch, 1)) return false;
    const id = map.buildings.length;
    const height = 3.2 * floors + 1.2;
    const hp = cw * ch * floors * 60;
    const b: Building = { id, cx, cy, cw, ch, floors, height, style: rng.int(0, 5), hp, maxHp: hp, destroyed: false, name: name ?? '' };
    map.buildings.push(b);
    for (let y = cy; y < cy + ch; y++) {
      for (let x = cx; x < cx + cw; x++) {
        map.type[y * w + x] = T.Building;
        map.bld[y * w + x] = id;
      }
    }
    return true;
  };
  for (const b of def.buildings ?? []) {
    const [cx, cy] = map.cellOf(b.x - b.w / 2, b.y - b.h / 2);
    place(cx, cy, Math.max(1, Math.round(b.w / CELL)), Math.max(1, Math.round(b.h / CELL)), b.floors, b.name);
  }
  for (const town of def.towns ?? []) {
    const lot = town.lot ?? [2, 4];
    const inHole = (cx: number, cy: number, cw: number, ch: number) =>
      (town.holes ?? []).some((hr) => cx * CELL < hr.x + hr.w && (cx + cw) * CELL > hr.x && cy * CELL < hr.y + hr.h && (cy + ch) * CELL > hr.y);
    const setback = town.setback ?? 1;
    // 1) frontage along roads within the rect
    for (const r of roads) {
      for (let i = 0; i < r.pts.length - 1; i++) {
        const a = r.pts[i];
        const b = r.pts[i + 1];
        const len = dhypot(b.x - a.x, b.y - a.y);
        const dir = { x: (b.x - a.x) / len, y: (b.y - a.y) / len };
        const nrm = { x: -dir.y, y: dir.x };
        for (let s = 0; s < len; s += rng.range(12, 20)) {
          for (const side of [-1, 1]) {
            if (!rng.chance(town.density)) continue;
            const off = r.width / 2 + setback * CELL + CELL * 2;
            const px = a.x + dir.x * s + nrm.x * off * side;
            const py = a.y + dir.y * s + nrm.y * off * side;
            if (px < town.rect.x || py < town.rect.y || px > town.rect.x + town.rect.w || py > town.rect.y + town.rect.h) continue;
            const cw = rng.int(lot[0], lot[1]);
            const ch = rng.int(lot[0], lot[1]);
            const [cx, cy] = map.cellOf(px - (cw * CELL) / 2, py - (ch * CELL) / 2);
            if (!inHole(cx, cy, cw, ch)) place(cx, cy, cw, ch, rng.int(town.floors[0], town.floors[1]));
          }
        }
      }
    }
    // 2) back-lot fill
    const fillN = Math.round(((town.rect.w * town.rect.h) / 900) * (town.fill ?? 0.3));
    for (let k = 0; k < fillN; k++) {
      const cw = rng.int(lot[0], lot[1]);
      const ch = rng.int(lot[0], lot[1]);
      const [cx, cy] = map.cellOf(town.rect.x + rng.next() * town.rect.w, town.rect.y + rng.next() * town.rect.h);
      if (!inHole(cx, cy, cw, ch)) place(cx, cy, cw, ch, rng.int(town.floors[0], town.floors[1]));
    }
    // town ground: gardens (grass) instead of forest/field
    const [x0, y0] = map.cellOf(town.rect.x, town.rect.y);
    const [x1, y1] = map.cellOf(town.rect.x + town.rect.w, town.rect.y + town.rect.h);
    for (let cy = y0; cy <= y1; cy++) {
      for (let cx = x0; cx <= x1; cx++) {
        const i = cy * w + cx;
        const t = map.type[i] as T;
        if (t === T.Forest || t === T.Field || t === T.Scrub) map.type[i] = rng.chance(0.08) ? T.Orchard : T.Grass;
      }
    }
  }

  map.waterLevel = Number.isFinite(waterLevel) ? waterLevel : -1000;
  map.invalidateCaches();
  return { def, map, roads, rivers, bridges };
}
