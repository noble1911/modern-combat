import { FIRE_SUPPORT } from '../data/units';
import { WEAPONS } from '../data/weapons';
import { angleTo, clamp, dist, Vec2 } from './math';
import { findPath, nearestPassable } from './pathfinding';
import { CELL, T } from './terrain';
import type { MoveMode, Order, OrderKind, Soldier, Unit, VehicleState } from './types';
import { World } from './world';
import { EYE } from './spotting';

export interface OrderCheck {
  ok: boolean;
  reason?: string;
}

/** Which orders are available for a unit (for the UI menu). */
export function availableOrders(w: World, u: Unit): OrderKind[] {
  if (u.eliminated || u.withdrawn) return [];
  if (u.mountedIn >= 0) return ['dismount'];
  const list: OrderKind[] = [];
  if (u.vehicle >= 0) {
    const v = w.vehicles[u.vehicle];
    if (v.destroyed || v.abandoned) return [];
    if (!v.immobilized && canDrive(w, v)) list.push('move', 'moveFast', 'reverse');
    list.push('fire', 'defend', 'ambush');
    if (v.smokeSalvos > 0) list.push('smoke');
    if (v.passengers.length) list.push('dismount');
    return list;
  }
  list.push('move', 'moveFast', 'sneak', 'fire', 'smoke', 'defend', 'ambush');
  if (canMountAny(w, u)) list.push('mount');
  const ab = u.template.abilities ?? [];
  if (ab.includes('callFire')) list.push('callFire');
  if (ab.includes('uav')) list.push('uav');
  if (ab.includes('fpv') || ab.includes('loiter')) list.push('strike');
  return list;
}

function canMountAny(w: World, u: Unit): boolean {
  return w.units.some((c) => c.side === u.side && c.vehicle >= 0 && freeSeats(w, c) >= w.aliveSoldiers(u).length);
}

export function freeSeats(w: World, carrier: Unit): number {
  if (carrier.vehicle < 0) return 0;
  const v = w.vehicles[carrier.vehicle];
  if (v.destroyed || v.abandoned) return 0;
  const used = v.passengers.reduce((n, uid) => n + w.aliveSoldiers(w.units[uid]).length, 0);
  return v.def.seats - used;
}

export function smokeLeft(w: World, u: Unit): number {
  if (u.vehicle >= 0) return w.vehicles[u.vehicle].smokeSalvos;
  return u.ai.smoke ?? (u.template.symbol === 'mortar' ? 6 : u.template.soldiers && u.template.soldiers.length >= 6 ? 2 : 1);
}

/** Validate an order before issuing (UI feedback & AI). */
export function checkOrder(w: World, u: Unit, o: Omit<Order, 'issuedAt'>): OrderCheck {
  if (w.phase === 'ended') return { ok: false, reason: 'Battle is over' };
  const avail = availableOrders(w, u);
  if (o.kind !== 'none' && !avail.includes(o.kind)) return { ok: false, reason: 'Order not available' };
  const pos = w.unitPos(u);
  switch (o.kind) {
    case 'move':
    case 'moveFast':
    case 'sneak':
    case 'reverse': {
      if (!o.target) return { ok: false, reason: 'No destination' };
      const mob = u.vehicle >= 0 ? w.vehicles[u.vehicle].def.mobility : 'foot';
      if (!nearestPassable(w.map, o.target.x, o.target.y, mob, 6)) return { ok: false, reason: 'Impassable' };
      return { ok: true };
    }
    case 'fire': {
      if (o.targetUnit !== undefined) {
        if (!w.isVisibleTo(u.side, o.targetUnit)) return { ok: false, reason: 'Target not visible' };
        return { ok: true };
      }
      if (!o.target) return { ok: false, reason: 'No target' };
      const range = maxRange(w, u);
      if (dist(pos, o.target) > range) return { ok: false, reason: 'Out of range' };
      return { ok: true };
    }
    case 'smoke': {
      if (smokeLeft(w, u) <= 0) return { ok: false, reason: 'No smoke left' };
      if (u.vehicle >= 0) return { ok: true };
      if (!o.target) return { ok: false, reason: 'No target' };
      const lim = u.template.symbol === 'mortar' ? 3000 : 45;
      if (dist(pos, o.target) > lim) return { ok: false, reason: 'Too far to throw smoke' };
      return { ok: true };
    }
    case 'callFire': {
      if (u.charges <= 0) return { ok: false, reason: 'No fire missions left' };
      if (!o.target) return { ok: false, reason: 'No target' };
      if (!hasObservation(w, u, o.target)) return { ok: false, reason: 'No observation of target' };
      return { ok: true };
    }
    case 'uav': {
      if (u.charges <= 0) return { ok: false, reason: 'No drones left' };
      if (w.drones.some((d) => !d.dead && d.unitId === u.id && d.kind === 'recon')) return { ok: false, reason: 'Drone already airborne' };
      if (!o.target) return { ok: false, reason: 'No target' };
      return { ok: true };
    }
    case 'strike': {
      if (u.charges <= 0) return { ok: false, reason: 'No munitions left' };
      if (o.targetUnit === undefined) return { ok: false, reason: 'Select a spotted enemy' };
      if (!w.isVisibleTo(u.side, o.targetUnit)) return { ok: false, reason: 'Target not visible' };
      if (dist(pos, w.unitPos(w.units[o.targetUnit])) > 4000) return { ok: false, reason: 'Out of range' };
      return { ok: true };
    }
    case 'mount': {
      if (o.targetUnit === undefined) return { ok: false, reason: 'Select a friendly vehicle' };
      const c = w.units[o.targetUnit];
      if (c.side !== u.side || c.vehicle < 0) return { ok: false, reason: 'Not a friendly vehicle' };
      if (freeSeats(w, c) < w.aliveSoldiers(u).length) return { ok: false, reason: 'Not enough seats' };
      return { ok: true };
    }
    default:
      return { ok: true };
  }
}

/** Anyone on our side can see the point (friendly LOS) — needed for indirect fire. */
export function hasObservation(w: World, u: Unit, p: Vec2): boolean {
  const alive = w.aliveSoldiers(u);
  for (const s of alive.slice(0, 3)) {
    if (w.map.los(s.x, s.y, 1.7, p.x, p.y, 1.0, 1, 3).clear) return true;
  }
  // Drones overhead
  for (const d of w.drones) if (!d.dead && d.side === u.side && d.kind === 'recon' && Math.hypot(d.x - p.x, d.y - p.y) < 200) return true;
  // Spotted enemies near the point
  for (const info of w.spotted[u.side].values()) if (info.visible && Math.hypot(info.x - p.x, info.y - p.y) < 40) return true;
  return false;
}

export function maxRange(w: World, u: Unit): number {
  let r = 0;
  if (u.vehicle >= 0) for (const ws of w.vehicles[u.vehicle].weapons) r = Math.max(r, ws.def.range);
  for (const s of w.aliveSoldiers(u)) for (const ws of s.weapons) if (ws.ammo > 0) r = Math.max(r, ws.def.range);
  return r;
}

export function issueOrder(w: World, unitId: number, o: Omit<Order, 'issuedAt'>): OrderCheck {
  const u = w.units[unitId];
  const chk = checkOrder(w, u, o);
  if (!chk.ok) return chk;
  const order: Order = { ...o, issuedAt: w.time };
  const pos = w.unitPos(u);
  switch (o.kind) {
    case 'move':
    case 'moveFast':
    case 'sneak':
    case 'reverse':
      u.order = order;
      u.holdPos = { ...o.target! };
      if (u.vehicle >= 0) planVehicleMove(w, u, o.target!, o.kind === 'reverse');
      else planInfantryMove(w, u, o.target!, o.kind === 'moveFast' ? 'run' : o.kind === 'sneak' ? 'sneak' : 'walk');
      break;
    case 'defend':
    case 'ambush': {
      u.order = order;
      u.holdPos = pos;
      if (o.target) u.facing = angleTo(pos, o.target);
      order.facing = u.facing;
      if (u.vehicle >= 0) stopVehicle(w, u);
      else takeCover(w, u, pos, u.facing, 'walk');
      break;
    }
    case 'fire':
      u.order = order;
      if (u.vehicle < 0) for (const s of w.aliveSoldiers(u)) {
        s.path = null;
        s.moving = false;
        s.retargetT = 0;
      }
      else {
        const v = w.vehicles[u.vehicle];
        v.path = null;
        for (const ws of v.weapons) ws.aimKey = null;
      }
      if (o.target) u.facing = angleTo(pos, o.target);
      break;
    case 'smoke':
      u.order = order;
      executeSmoke(w, u, o.target);
      break;
    case 'callFire': {
      u.charges--;
      const fs = FIRE_SUPPORT[u.side];
      w.fireMissions.push({ id: w.newMissionId(), side: u.side, x: o.target!.x, y: o.target!.y, roundsLeft: fs.rounds, t: 0, nextT: fs.delay, unitId: u.id, smoke: false });
      w.msg(u.side, `${u.name}: Fire mission requested — ${fs.name}, ETA ${fs.delay}s.`, u.id, 'info');
      u.order = { kind: 'none', issuedAt: w.time };
      break;
    }
    case 'uav': {
      u.charges--;
      const p = w.unitPos(u);
      w.drones.push({
        id: w.newDroneId(), side: u.side, unitId: u.id, kind: 'recon', x: p.x, y: p.y, z: 5, px: p.x, py: p.y, pz: 5, heading: 0,
        tx: o.target!.x, ty: o.target!.y, targetUnit: -1, life: 150, speed: 22, dead: false, phase: 0, model: u.side === 'nato' ? 'quad' : 'fixed',
      });
      w.msg(u.side, `${u.name}: Recon drone launched.`, u.id, 'info');
      u.order = { kind: 'none', issuedAt: w.time };
      break;
    }
    case 'strike': {
      u.charges--;
      const p = w.unitPos(u);
      const tgt = w.unitPos(w.units[o.targetUnit!]);
      w.drones.push({
        id: w.newDroneId(), side: u.side, unitId: u.id, kind: 'strike', x: p.x, y: p.y, z: 3, px: p.x, py: p.y, pz: 3, heading: angleTo(p, tgt),
        tx: tgt.x, ty: tgt.y, targetUnit: o.targetUnit!, life: 120, speed: u.side === 'nato' ? 45 : 38, dead: false, phase: 0, model: u.side === 'nato' ? 'fixed' : 'quad',
      });
      const what = u.side === 'nato' ? 'Switchblade 600 away' : 'FPV drone launched';
      w.msg(u.side, `${u.name}: ${what}.`, u.id, 'info');
      u.order = { kind: 'none', issuedAt: w.time };
      break;
    }
    case 'mount': {
      u.order = order;
      const c = w.units[o.targetUnit!];
      const vp = w.unitPos(c);
      planInfantryMove(w, u, vp, 'run', true);
      break;
    }
    case 'dismount':
      if (u.vehicle >= 0) {
        const v = w.vehicles[u.vehicle];
        for (const pid of [...v.passengers]) dismount(w, w.units[pid]);
      } else dismount(w, u);
      break;
    case 'none':
      u.order = order;
      break;
  }
  return { ok: true };
}

// --------------------------------------------------------------- movement planning

export function planInfantryMove(w: World, u: Unit, target: Vec2, mode: MoveMode, noSlots = false): boolean {
  const alive = w.aliveSoldiers(u);
  if (!alive.length) return false;
  const leader = w.leaderOf(u) ?? alive[0];
  const path = findPath(w.map, { x: leader.x, y: leader.y }, target, { mob: 'foot', stealth: mode === 'sneak' });
  if (!path || !path.length) return false;
  const end = path[path.length - 1];
  const heading = path.length >= 2 ? angleTo(path[path.length - 2], end) : angleTo(leader, end);
  const slots = noSlots ? alive.map(() => end) : chooseSlots(w, u, end, u.order.kind === 'moveFast' ? heading : heading, alive.length);
  // Leader first, others follow in file
  const ordered = [leader, ...alive.filter((s) => s !== leader)];
  ordered.forEach((s, i) => {
    let p: Vec2[] = path.slice(0, -1);
    const first = p[0] ?? end;
    if (!w.map.walkable(s.x, s.y, first.x, first.y, 'foot')) {
      const own = findPath(w.map, { x: s.x, y: s.y }, first, { mob: 'foot', maxNodes: 4000 });
      if (own) p = [...own, ...p];
    }
    const slot = slots[alive.indexOf(s)] ?? end;
    p.push(slot);
    s.path = p;
    s.pathIdx = 0;
    s.slot = slot;
    s.moveMode = mode;
    s.moveDelay = i * (mode === 'run' ? 0.25 : 0.45);
    s.moving = true;
  });
  u.facing = heading;
  return true;
}

/** Spread soldiers into good cover positions around a point, biased toward facing. */
export function chooseSlots(w: World, u: Unit, center: Vec2, facing: number, n: number): Vec2[] {
  const map = w.map;
  const [ccx, ccy] = map.cellOf(center.x, center.y);
  const bid = map.bld[ccy * map.w + ccx];
  const R = Math.min(6, 2 + Math.ceil(Math.sqrt(n)));
  const cands: { cx: number; cy: number; score: number }[] = [];
  const fx = Math.cos(facing);
  const fy = Math.sin(facing);
  for (let dy = -R; dy <= R; dy++) {
    for (let dx = -R; dx <= R; dx++) {
      const cx = ccx + dx;
      const cy = ccy + dy;
      if (!map.inBounds(cx, cy)) continue;
      const i = cy * map.w + cx;
      const t = map.type[i] as T;
      if (map.speedFactor(cx, cy, 'foot') <= 0) continue;
      // hug hedges and walls from behind rather than standing inside them
      if (t === T.Hedge || t === T.Wall) continue;
      const d = Math.hypot(dx, dy);
      if (d > R + 0.5) continue;
      let score = map.cellCoverScore(cx, cy);
      if (bid >= 0) {
        // Holding a building: use its cells, prefer the edge facing the threat (windows)
        if (map.bld[i] !== bid) score -= 1.5;
        else {
          const b = map.buildings[bid];
          const edge = cx === b.cx || cx === b.cx + b.cw - 1 || cy === b.cy || cy === b.cy + b.ch - 1;
          if (edge) score += 0.3;
        }
      } else if (t === T.Building) score -= 0.2;
      // cover in the facing direction
      const ahead = map.type[clamp(cy + Math.round(fy), 0, map.h - 1) * map.w + clamp(cx + Math.round(fx), 0, map.w - 1)] as T;
      if (ahead === T.Wall || ahead === T.Hedge || ahead === T.Rubble) score += 0.35;
      // forward bias (line abreast facing the enemy rather than clumped behind)
      score += ((dx * fx + dy * fy) / R) * 0.1;
      score -= (d / R) * 0.45;
      if (map.type[i] === T.Road || map.type[i] === T.Bridge) score -= 0.2;
      cands.push({ cx, cy, score });
    }
  }
  cands.sort((a, b) => b.score - a.score);
  const picked: { cx: number; cy: number }[] = [];
  for (const c of cands) {
    if (picked.length >= n) break;
    if (picked.some((p) => p.cx === c.cx && p.cy === c.cy)) continue;
    // discourage adjacency unless inside a building
    if (bid < 0 && picked.some((p) => Math.abs(p.cx - c.cx) <= 1 && Math.abs(p.cy - c.cy) <= 1) && cands.length > n * 3) continue;
    picked.push(c);
  }
  while (picked.length < n) picked.push({ cx: ccx, cy: ccy });
  return picked.map((p, i) => {
    const c = map.cellCenter(p.cx, p.cy);
    const j = ((i * 7919) % 100) / 100 - 0.5;
    return { x: c.x + j * CELL * 0.4, y: c.y - j * CELL * 0.4 };
  });
}

/** Short moves into nearby cover (used by defend/ambush and when halting). */
export function takeCover(w: World, u: Unit, center: Vec2, facing: number, mode: MoveMode): void {
  const alive = w.aliveSoldiers(u);
  const slots = chooseSlots(w, u, center, facing, alive.length);
  // assign nearest slots greedily
  const free = [...slots];
  for (const s of alive) {
    let bi = 0;
    let bd = Infinity;
    free.forEach((p, i) => {
      const d = Math.hypot(p.x - s.x, p.y - s.y);
      if (d < bd) {
        bd = d;
        bi = i;
      }
    });
    const slot = free.splice(bi, 1)[0] ?? center;
    s.slot = slot;
    if (bd < 1.2) {
      s.path = null;
      s.moving = false;
      continue;
    }
    if (w.map.walkable(s.x, s.y, slot.x, slot.y, 'foot')) s.path = [slot];
    else s.path = findPath(w.map, { x: s.x, y: s.y }, slot, { mob: 'foot', maxNodes: 3000 }) ?? [slot];
    s.pathIdx = 0;
    s.moveMode = mode;
    s.moveDelay = 0;
    s.moving = true;
  }
}

export function planVehicleMove(w: World, u: Unit, target: Vec2, reverse: boolean): boolean {
  const v = w.vehicles[u.vehicle];
  const path = findPath(w.map, { x: v.x, y: v.y }, target, { mob: v.def.mobility });
  if (!path) {
    w.msg(u.side, `${u.name}: Cannot find a route.`, u.id, 'warn');
    return false;
  }
  v.path = path;
  v.pathIdx = 0;
  v.reversing = reverse;
  return true;
}

function stopVehicle(w: World, u: Unit): void {
  const v = w.vehicles[u.vehicle];
  v.path = null;
}

function executeSmoke(w: World, u: Unit, target?: Vec2): void {
  const ai = u.ai;
  if (u.vehicle >= 0) {
    const v = w.vehicles[u.vehicle];
    v.smokeSalvos--;
    // smoke screen arc in front of the vehicle / turret
    for (let i = -2; i <= 2; i++) {
      const a = v.turret + i * 0.35;
      spawnSmoke(w, v.x + Math.cos(a) * 28, v.y + Math.sin(a) * 28, 13, 0.07, 55);
    }
    w.emit({ type: 'explosion', x: v.x, y: v.y, z: w.map.groundAt(v.x, v.y) + 2.5, size: 1, kind: 'smoke' });
    w.msg(u.side, `${u.name}: Popping smoke!`, u.id, 'info');
    u.order = { kind: 'none', issuedAt: w.time };
    return;
  }
  const leader = w.leaderOf(u);
  const mortar = u.template.symbol === 'mortar' ? w.aliveSoldiers(u).find((s) => s.weapons.some((ws) => ws.def.indirect)) : null;
  if (!target || !leader || (u.template.symbol === 'mortar' && !mortar)) {
    u.order = { kind: 'none', issuedAt: w.time };
    return;
  }
  ai.smoke = smokeLeft(w, u) - 1;
  if (u.template.symbol === 'mortar') {
    w.fireMissions.push({ id: w.newMissionId(), side: u.side, x: target.x, y: target.y, roundsLeft: 3, t: 0, nextT: 12, unitId: u.id, smoke: true });
    w.msg(u.side, `${u.name}: Smoke rounds on the way.`, u.id, 'info');
    u.order = { kind: 'none', issuedAt: w.time };
    return;
  }
  // thrown smoke grenade
  const dx = target.x - leader.x;
  const dy = target.y - leader.y;
  const d = Math.hypot(dx, dy);
  const T_ = Math.max(0.6, d / 14);
  w.projectiles.push({
    id: w.newProjectileId(), weapon: WEAPONS.smokegren, side: u.side, shooterSoldier: leader.id, shooterVehicle: -1,
    sx: leader.x, sy: leader.y, sz: w.map.groundAt(leader.x, leader.y) + 1.6, tx: target.x, ty: target.y, tz: w.map.groundAt(target.x, target.y),
    x: leader.x, y: leader.y, z: w.map.groundAt(leader.x, leader.y) + 1.6, px: leader.x, py: leader.y, pz: 0, t: 0, T: T_, arc: Math.min(8, d * 0.25),
    target: null, willHit: false, kind: 'thrown', smoke: true, dead: false,
  });
  u.order = { kind: 'none', issuedAt: w.time };
}

export function spawnSmoke(w: World, x: number, y: number, r: number, density: number, life: number): void {
  w.map.smoke.push({ id: w.newSmokeId(), x, y, r, density, age: 0, life, vx: 0.25, vy: 0.1 });
  w.emit({ type: 'smoke', x, y, r });
}

export function dismount(w: World, u: Unit): void {
  if (u.mountedIn < 0) return;
  const v = w.vehicles[u.mountedIn];
  v.passengers = v.passengers.filter((id) => id !== u.id);
  u.mountedIn = -1;
  const back = v.heading + Math.PI;
  const alive = u.soldiers.map((id) => w.soldiers[id]).filter((s) => s.health !== 'dead');
  alive.forEach((s, i) => {
    const off = (i - (alive.length - 1) / 2) * 1.2;
    const bx = v.x + Math.cos(back) * (v.def.length / 2 + 1.5) + Math.cos(back + Math.PI / 2) * off;
    const by = v.y + Math.sin(back) * (v.def.length / 2 + 1.5) + Math.sin(back + Math.PI / 2) * off;
    const p = nearestPassable(w.map, bx, by, 'foot', 4) ?? { x: v.x, y: v.y };
    s.vehicle = -1;
    s.x = s.px = p.x;
    s.y = s.py = p.y;
    s.stance = 'crouch';
    s.facing = v.heading;
  });
  const center = { x: v.x + Math.cos(back) * (v.def.length / 2 + 6), y: v.y + Math.sin(back) * (v.def.length / 2 + 6) };
  u.order = { kind: 'defend', issuedAt: w.time, facing: v.heading };
  u.facing = v.heading;
  u.holdPos = center;
  takeCover(w, u, center, v.heading, 'run');
  w.msg(u.side, `${u.name}: Dismounted.`, u.id, 'info');
}

/** Per-tick unit-level order upkeep. */
export function updateOrders(w: World): void {
  for (const u of w.units) {
    if (u.eliminated || u.withdrawn) continue;
    const o = u.order;
    if (o.kind === 'mount' && o.targetUnit !== undefined) {
      const c = w.units[o.targetUnit];
      const cv = c.vehicle >= 0 ? w.vehicles[c.vehicle] : null;
      if (!cv || cv.destroyed || cv.abandoned || freeSeats(w, c) < w.aliveSoldiers(u).length) {
        u.order = { kind: 'none', issuedAt: w.time };
        continue;
      }
      const alive = w.aliveSoldiers(u);
      const near = alive.every((s) => Math.hypot(s.x - cv.x, s.y - cv.y) < 9);
      if (near && Math.abs(cv.speed) < 1.5) {
        w.embark(u, c);
        w.msg(u.side, `${u.name}: Mounted up.`, u.id, 'info');
      } else if (w.tick % 20 === 0) {
        // follow the vehicle if it moved
        const lead = w.leaderOf(u);
        if (lead && (!lead.path || dist(lead.path[lead.path.length - 1], cv) > 8)) planInfantryMove(w, u, { x: cv.x, y: cv.y }, 'run', true);
      }
      continue;
    }
    // Infantry finished moving → becomes defend in place facing travel direction
    if (u.vehicle < 0 && u.mountedIn < 0 && (o.kind === 'move' || o.kind === 'moveFast' || o.kind === 'sneak')) {
      const alive = w.aliveSoldiers(u);
      if (alive.length && alive.every((s) => !s.path || s.pathIdx >= s.path.length)) {
        u.order = { kind: 'none', issuedAt: w.time, facing: u.facing };
        u.holdPos = w.unitPos(u);
      }
    }
    if (u.vehicle >= 0 && (o.kind === 'move' || o.kind === 'moveFast' || o.kind === 'reverse')) {
      const v = w.vehicles[u.vehicle];
      if (v.immobilized || !canDrive(w, v)) {
        v.path = null;
        u.order = { kind: 'none', issuedAt: w.time };
        u.holdPos = { x: v.x, y: v.y };
        continue;
      }
      if (!v.path || v.pathIdx >= v.path.length) {
        u.order = { kind: 'none', issuedAt: w.time };
        u.holdPos = { x: v.x, y: v.y };
      }
    }
    // Fire orders expire when target is lost/dead
    if (o.kind === 'fire' && o.targetUnit !== undefined) {
      const t = w.units[o.targetUnit];
      if (t.eliminated || !w.isVisibleTo(u.side, t.id)) u.order = { kind: 'none', issuedAt: w.time };
    }
  }
}

/** A vehicle can drive if its driver is fit, or (after a short delay) another crewman has taken over. */
export function canDrive(w: World, v: VehicleState): boolean {
  const crew = v.crew.map((id) => w.soldiers[id]);
  if (!crew.some((s) => World.active(s))) return false;
  const driver = crew.find((s) => s.role.includes('Driver'));
  if (!driver || World.active(driver)) return true;
  return w.time - v.lastHitT > 10;
}

export function soldierEye(s: Soldier): number {
  return EYE[s.stance];
}
