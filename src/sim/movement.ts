import { angleTo, clamp, turnToward, wrapAngle } from './math';
import { canDrive } from './orders';
import { findPath, nearestPassable } from './pathfinding';
import { CELL } from './terrain';
import type { Soldier, VehicleState } from './types';
import { DT, World } from './world';

const SPEED = { walk: 1.6, run: 3.7, sneak: 0.7 } as const;

export function updateMovement(w: World): void {
  for (const s of w.soldiers) moveSoldier(w, s);
  separateSoldiers(w);
  for (const v of w.vehicles) moveVehicle(w, v);
  separateVehicles(w);
}

function moveSoldier(w: World, s: Soldier): void {
  if (s.health === 'dead' || s.health === 'incap') {
    s.moving = false;
    return;
  }
  if (s.vehicle >= 0) {
    const v = w.vehicles[s.vehicle];
    s.x = v.x;
    s.y = v.y;
    s.moving = false;
    return;
  }
  if (s.state === 'surrendered') {
    s.moving = false;
    s.stance = 'stand';
    return;
  }
  const canMove = s.state !== 'pinned' && s.state !== 'cowering';
  if (!s.path || s.pathIdx >= s.path.length || !canMove) {
    s.moving = false;
    if (s.fatigue > 0) s.fatigue = Math.max(0, s.fatigue - 1.2 * DT);
    return;
  }
  if (s.moveDelay > 0) {
    s.moveDelay -= DT;
    return;
  }
  const wp = s.path[s.pathIdx];
  const dx = wp.x - s.x;
  const dy = wp.y - s.y;
  const d = Math.hypot(dx, dy);
  const mode = s.state === 'panicked' || s.state === 'routing' ? 'run' : s.state === 'berserk' ? 'run' : s.moveMode;
  let sp = SPEED[mode];
  const [cx, cy] = w.map.cellOf(s.x, s.y);
  sp *= Math.max(0.25, w.map.speedFactor(cx, cy, 'foot'));
  if (s.health === 'wounded') sp *= 0.6;
  if (mode === 'run') {
    if (s.fatigue > 70) sp *= 0.65;
    s.fatigue = Math.min(100, s.fatigue + 1.1 * DT);
  } else {
    s.fatigue = Math.max(0, s.fatigue - 0.5 * DT);
  }
  // heavy weapons crews are slower
  if (s.weapons[0]?.def.cls === 'mortar' || s.weapons[0]?.def.cls === 'agl') sp *= 0.8;
  const step = sp * DT;
  s.moving = true;
  s.stance = mode === 'sneak' ? 'crouch' : 'stand';
  const fireRecent = w.time - s.firedT < 1.5;
  if (!fireRecent || !s.target) s.facing = Math.atan2(dy, dx);
  const last = s.pathIdx === s.path.length - 1;
  // Crowds: intermediate waypoints only need to be passed near; give up on one we can't reach.
  const prevD = (s as { lastD?: number }).lastD ?? Infinity;
  if (d > prevD - step * 0.25) s.stuckT += DT;
  else s.stuckT = Math.max(0, s.stuckT - DT);
  (s as { lastD?: number }).lastD = d;
  if ((!last && d < 1.6) || s.stuckT > 2.5) {
    s.stuckT = 0;
    (s as { lastD?: number }).lastD = Infinity;
    s.pathIdx++;
    if (s.pathIdx >= s.path.length) {
      s.moving = false;
      s.path = null;
      s.stance = 'crouch';
    }
    return;
  }
  if (d <= step) {
    s.x = wp.x;
    s.y = wp.y;
    s.pathIdx++;
    if (s.pathIdx >= s.path.length) {
      s.moving = false;
      s.path = null;
      s.stance = 'crouch';
    }
  } else {
    s.x += (dx / d) * step;
    s.y += (dy / d) * step;
  }
}

/** Keep soldiers from stacking on top of each other (spatial hash, 2m). */
function separateSoldiers(w: World): void {
  const cell = 2;
  const grid = new Map<number, Soldier[]>();
  const key = (x: number, y: number) => (Math.floor(y / cell) << 16) | Math.floor(x / cell);
  for (const s of w.soldiers) {
    if (s.vehicle >= 0 || s.health === 'dead') continue;
    const k = key(s.x, s.y);
    let l = grid.get(k);
    if (!l) grid.set(k, (l = []));
    l.push(s);
  }
  const minD = 1.1;
  for (const s of w.soldiers) {
    if (s.vehicle >= 0 || s.health === 'dead' || s.health === 'incap') continue;
    const gx = Math.floor(s.x / cell);
    const gy = Math.floor(s.y / cell);
    for (let oy = -1; oy <= 1; oy++) {
      for (let ox = -1; ox <= 1; ox++) {
        const l = grid.get(((gy + oy) << 16) | (gx + ox));
        if (!l) continue;
        for (const o of l) {
          if (o === s || o.id < s.id) continue;
          const dx = o.x - s.x;
          const dy = o.y - s.y;
          const d = Math.hypot(dx, dy);
          if (d >= minD || d < 1e-4) continue;
          const push = (minD - d) * 0.5;
          const nx = dx / d;
          const ny = dy / d;
          const sFixed = !s.moving;
          const oFixed = !o.moving || o.health === 'incap';
          const ks = sFixed && !oFixed ? 0.2 : 1;
          const ko = oFixed && !sFixed ? 0.2 : 1;
          tryNudge(w, s, -nx * push * ks, -ny * push * ks);
          tryNudge(w, o, nx * push * ko, ny * push * ko);
        }
      }
    }
  }
  // push soldiers out from under vehicles
  for (const v of w.vehicles) {
    const r = v.def.length * 0.5;
    for (const s of w.soldiersNear(v.x, v.y, r + 1)) {
      if (s.vehicle >= 0) continue;
      // transform into vehicle local frame
      const dx = s.x - v.x;
      const dy = s.y - v.y;
      const c = Math.cos(-v.heading);
      const sn = Math.sin(-v.heading);
      const lx = dx * c - dy * sn;
      const ly = dx * sn + dy * c;
      const hl = v.def.length / 2 + 0.6;
      const hw = v.def.width / 2 + 0.6;
      if (Math.abs(lx) < hl && Math.abs(ly) < hw) {
        const px = hl - Math.abs(lx);
        const py = hw - Math.abs(ly);
        let nlx = 0;
        let nly = 0;
        if (py < px) nly = Math.sign(ly || 1) * py;
        else nlx = Math.sign(lx || 1) * px;
        const c2 = Math.cos(v.heading);
        const s2 = Math.sin(v.heading);
        tryNudge(w, s, nlx * c2 - nly * s2, nlx * s2 + nly * c2);
      }
    }
  }
}

function tryNudge(w: World, s: Soldier, dx: number, dy: number): void {
  const nx = s.x + dx;
  const ny = s.y + dy;
  const [cx, cy] = w.map.cellOf(nx, ny);
  if (w.map.speedFactor(cx, cy, 'foot') > 0) {
    s.x = clamp(nx, 1, w.map.width - 1);
    s.y = clamp(ny, 1, w.map.height - 1);
  }
}

function moveVehicle(w: World, v: VehicleState): void {
  const u = w.units[v.unitId];
  if (v.destroyed || v.abandoned) {
    v.speed = 0;
    return;
  }
  const driverOk = canDrive(w, v);
  let targetSpeed = 0;
  let desired = v.heading;
  if (v.path && v.pathIdx < v.path.length && !v.immobilized && driverOk) {
    const wp = v.path[v.pathIdx];
    const dx = wp.x - v.x;
    const dy = wp.y - v.y;
    const d = Math.hypot(dx, dy);
    const last = v.pathIdx === v.path.length - 1;
    const errToWp = Math.abs(wrapAngle((v.reversing ? Math.atan2(dy, dx) + Math.PI : Math.atan2(dy, dx)) - v.heading));
    const tol = last ? (v.def.mobility === 'wheel' ? 5 : 1.5) : 4;
    // a close target far off the nose would put a wheeled vehicle into an endless orbit: call it reached
    const orbiting = last && v.def.mobility === 'wheel' && d < 14 && errToWp > 1.1;
    if (d < tol || orbiting) {
      v.pathIdx++;
      if (v.pathIdx >= v.path.length) {
        v.path = null;
        v.reversing = false;
      }
    } else {
      const toWp = Math.atan2(dy, dx);
      desired = v.reversing ? wrapAngle(toWp + Math.PI) : toWp;
      const err = Math.abs(wrapAngle(desired - v.heading));
      const [cx, cy] = w.map.cellOf(v.x, v.y);
      const terr = Math.max(0.15, w.map.speedFactor(cx, cy, v.def.mobility));
      const fast = u.order.kind === 'moveFast';
      targetSpeed = v.def.maxSpeed * terr * (fast ? 1 : 0.6);
      if (v.reversing) targetSpeed = Math.min(targetSpeed, 4.5);
      if (last) targetSpeed = Math.min(targetSpeed, Math.max(1.5, d * 0.5));
      if (err > 0.9) targetSpeed = v.def.mobility === 'track' ? 0 : Math.min(targetSpeed, 2);
      else if (err > 0.35) targetSpeed *= 0.5;
      if (v.shock > 60) targetSpeed *= 0.6;
      if (v.reversing) targetSpeed = -targetSpeed;
    }
  }
  // Turn (tracked can pivot; wheeled needs speed)
  let turnRate = v.def.turnRate;
  if (v.def.mobility === 'wheel') turnRate *= clamp(Math.abs(v.speed) / 3, 0.35, 1);
  v.heading = turnToward(v.heading, desired, turnRate * DT);
  // Accelerate
  const acc = v.def.accel * DT;
  if (v.speed < targetSpeed) v.speed = Math.min(targetSpeed, v.speed + acc);
  else v.speed = Math.max(targetSpeed, v.speed - acc * 2);
  if (Math.abs(v.speed) < 0.01) return;
  const nx = v.x + Math.cos(v.heading) * v.speed * DT;
  const ny = v.y + Math.sin(v.heading) * v.speed * DT;
  const [ncx, ncy] = w.map.cellOf(nx, ny);
  const [ocx, ocy] = w.map.cellOf(v.x, v.y);
  const clear = w.map.vehicleClearance(v.def.mobility);
  // Clearance is a planning heuristic; only truly impassable ground stops a moving vehicle.
  void clear;
  void ocx;
  void ocy;
  const blocked = w.map.speedFactor(ncx, ncy, v.def.mobility) <= 0;
  if (blocked) {
    // blocked (e.g. building rubble changed, or cut corner) → back off to the cell centre and re-plan
    v.speed = 0;
    const cc = w.map.cellCenter(ocx, ocy);
    v.x += (cc.x - v.x) * 0.2;
    v.y += (cc.y - v.y) * 0.2;
    if (w.time < v.replanT) return;
    v.replanT = w.time + 2;
    if (v.path && v.path.length) {
      const goal = v.path[v.path.length - 1];
      const np = nearestPassable(w.map, v.x, v.y, v.def.mobility, 3);
      if (np && (Math.abs(np.x - v.x) > 0.1 || Math.abs(np.y - v.y) > 0.1)) {
        v.x = np.x;
        v.y = np.y;
      }
      v.path = findPath(w.map, { x: v.x, y: v.y }, goal, { mob: v.def.mobility });
      v.pathIdx = 0;
    }
    return;
  }
  v.x = clamp(nx, CELL, w.map.width - CELL);
  v.y = clamp(ny, CELL, w.map.height - CELL);
}

function separateVehicles(w: World): void {
  const vs = w.vehicles;
  for (let i = 0; i < vs.length; i++) {
    for (let j = i + 1; j < vs.length; j++) {
      const a = vs[i];
      const b = vs[j];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const d = Math.hypot(dx, dy);
      const minD = (a.def.width + b.def.width) * 0.5 + 1;
      if (d >= minD || d < 1e-3) continue;
      const push = (minD - d) * 0.5;
      const nx = dx / d;
      const ny = dy / d;
      const aFixed = a.destroyed || a.abandoned || Math.abs(a.speed) < 0.1;
      const bFixed = b.destroyed || b.abandoned || Math.abs(b.speed) < 0.1;
      if (!(a.destroyed || a.abandoned)) {
        a.x -= nx * push * (aFixed && !bFixed ? 0.1 : 1);
        a.y -= ny * push * (aFixed && !bFixed ? 0.1 : 1);
      }
      if (!(b.destroyed || b.abandoned)) {
        b.x += nx * push * (bFixed && !aFixed ? 0.1 : 1);
        b.y += ny * push * (bFixed && !aFixed ? 0.1 : 1);
      }
    }
  }
}

/** Turret slews toward an angle; returns remaining error. */
export function slewTurret(v: VehicleState, target: number): number {
  const rate = v.def.turretRate * DT;
  v.turret = turnToward(v.turret, target, rate);
  return Math.abs(wrapAngle(target - v.turret));
}

export { angleTo };
