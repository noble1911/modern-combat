import { otherSide, Side } from '../data/units';
import { angleTo, clamp, dist, Vec2 } from './math';
import { availableOrders, checkOrder, freeSeats, hasObservation, issueOrder, smokeLeft, takeCover } from './orders';

const ordersSmoke = (w: World, u: Unit) => smokeLeft(w, u) > 0 && availableOrders(w, u).includes('smoke');
import { nearestPassable } from './pathfinding';
import { CELL, T } from './terrain';
import type { Order, Unit, VictoryLocation } from './types';
import { World } from './world';
import { dcos, dhypot, dsin } from './dmath';

export type Posture = 'attack' | 'defend';

interface SideAI {
  posture: Posture;
  objective: string | null;
  nextPlan: number;
  /** Remember how long each VL has been the objective. */
  objectiveSince: number;
}

function state(w: World, side: Side): SideAI {
  const s = w.aiState[side] as SideAI;
  if (s.nextPlan === undefined) {
    s.posture = w.sides[side].posture ?? 'attack';
    s.objective = null;
    s.nextPlan = 0;
    s.objectiveSince = 0;
  }
  return s;
}

type Role = 'assault' | 'support' | 'antiarmor' | 'fires' | 'hq' | 'drone' | 'carrier' | 'armor' | 'scout';

export function roleOf(w: World, u: Unit): Role {
  switch (u.template.symbol) {
    case 'inf':
      return 'assault';
    case 'mg':
    case 'agl':
    case 'sniper':
      return 'support';
    case 'at':
      return 'antiarmor';
    case 'mortar':
      return 'fires';
    case 'hq':
      return 'hq';
    case 'recon':
      return 'drone';
    case 'armor':
      return 'armor';
    case 'ifv':
    case 'apc':
      return w.vehicles[u.vehicle]?.passengers.length ? 'carrier' : 'support';
    case 'car':
      return 'scout';
  }
  return 'assault';
}

function order(w: World, u: Unit, o: Omit<Order, 'issuedAt'>): boolean {
  // Never walk into our own barrage
  if (o.target && (o.kind === 'move' || o.kind === 'moveFast' || o.kind === 'sneak')) {
    for (const m of w.fireMissions) if (m.side === u.side && !m.smoke && dist(m, o.target) < 180) return false;
  }
  const r = checkOrder(w, u, o);
  if (!r.ok) return false;
  issueOrder(w, u.id, o);
  return true;
}

// ------------------------------------------------------------------ geometry helpers

/** Best nearby cell for a unit to occupy: cover, optional LOS to a point, close to `near`. */
export function findPosition(
  w: World,
  near: Vec2,
  radius: number,
  lookAt: Vec2 | null,
  opts: { vehicle?: boolean; samples?: number; minDistFromLook?: number; eye?: number } = {},
): Vec2 {
  const map = w.map;
  const samples = opts.samples ?? 28;
  let best: Vec2 = near;
  let bestScore = -Infinity;
  const mob = opts.vehicle ? 'track' : 'foot';
  const clear = opts.vehicle ? map.vehicleClearance('track') : null;
  for (let i = 0; i < samples; i++) {
    const a = w.rng.next() * Math.PI * 2;
    const r = Math.sqrt(w.rng.next()) * radius;
    const x = clamp(near.x + dcos(a) * r, CELL * 2, map.width - CELL * 2);
    const y = clamp(near.y + dsin(a) * r, CELL * 2, map.height - CELL * 2);
    const [cx, cy] = map.cellOf(x, y);
    if (map.speedFactor(cx, cy, mob) <= 0) continue;
    if (clear && !clear[cy * map.w + cx]) continue;
    let score = opts.vehicle ? 0 : map.cellCoverScore(cx, cy) * 1.2;
    const t = map.type[cy * map.w + cx] as T;
    if (opts.vehicle && (t === T.Forest || t === T.Orchard || t === T.Scrub)) score += 0.3;
    if (opts.vehicle) {
      // hull-down-ish: next to buildings/walls/forest edge
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const tt = map.type[clamp(cy + dy * 2, 0, map.h - 1) * map.w + clamp(cx + dx * 2, 0, map.w - 1)] as T;
        if (tt === T.Building || tt === T.Forest || tt === T.Wall || tt === T.Hedge) score += 0.12;
      }
    }
    score -= (r / Math.max(1, radius)) * 0.4;
    if (lookAt) {
      const d = dhypot(lookAt.x - x, lookAt.y - y);
      if (opts.minDistFromLook && d < opts.minDistFromLook) continue;
      const los = map.los(x, y, opts.eye ?? (opts.vehicle ? 2.6 : 1.1), lookAt.x, lookAt.y, 1.0, 1, 4);
      if (los.clear) score += 1.0 - los.obstruction * 0.5;
      else score -= 0.6;
    }
    if (score > bestScore) {
      bestScore = score;
      best = { x: (cx + 0.5) * CELL, y: (cy + 0.5) * CELL };
    }
  }
  return best;
}

function knownEnemiesNear(w: World, side: Side, p: Vec2, r: number): { unit: Unit; x: number; y: number }[] {
  const out: { unit: Unit; x: number; y: number }[] = [];
  for (const info of w.spotted[side].values()) {
    if (w.time - info.lastSeen > 60) continue;
    const u = w.units[info.unitId];
    if (u.eliminated || u.withdrawn) continue;
    if (dhypot(info.x - p.x, info.y - p.y) <= r) out.push({ unit: u, x: info.x, y: info.y });
  }
  return out;
}

function busy(w: World, u: Unit): boolean {
  if (u.order.kind === 'move' || u.order.kind === 'moveFast' || u.order.kind === 'sneak' || u.order.kind === 'reverse' || u.order.kind === 'mount') return true;
  return false;
}

function pickObjective(w: World, side: Side): VictoryLocation | null {
  const mine = w.friendlyUnits(side);
  if (!mine.length) return null;
  let cx = 0;
  let cy = 0;
  for (const u of mine) {
    const p = w.unitPos(u);
    cx += p.x;
    cy += p.y;
  }
  cx /= mine.length;
  cy /= mine.length;
  let best: VictoryLocation | null = null;
  let bestScore = -Infinity;
  for (const vl of w.vls) {
    if (vl.owner === side && !vl.contested) continue;
    const d = dhypot(vl.x - cx, vl.y - cy);
    const enemies = knownEnemiesNear(w, side, vl, 120).length;
    const score = vl.value * 2 - d / 60 - enemies * 0.8 + (vl.contested ? 2 : 0);
    if (score > bestScore) {
      bestScore = score;
      best = vl;
    }
  }
  return best;
}

// ------------------------------------------------------------------ deployment

export function aiDeploy(w: World, side: Side): void {
  const st = state(w, side);
  const zone = w.deploy[side];
  const units = w.units.filter((u) => u.side === side && u.mountedIn < 0);
  const enemyZone = w.deploy[otherSide(side)];
  const enemyC = { x: enemyZone.x + enemyZone.w / 2, y: enemyZone.y + enemyZone.h / 2 };
  const inZone = (p: Vec2) => ({ x: clamp(p.x, zone.x + 8, zone.x + zone.w - 8), y: clamp(p.y, zone.y + 8, zone.y + zone.h - 8) });
  const ownVLs = w.vls.filter((v) => v.owner === side && v.x >= zone.x && v.x <= zone.x + zone.w && v.y >= zone.y && v.y <= zone.y + zone.h);
  units.forEach((u, i) => {
    const role = roleOf(w, u);
    let anchor: Vec2;
    if (st.posture === 'defend' && ownVLs.length && role !== 'fires' && role !== 'drone') {
      const vl = ownVLs[i % ownVLs.length];
      const toward = angleTo(vl, enemyC);
      const fwd = role === 'antiarmor' || role === 'support' ? 60 : role === 'hq' ? -40 : 15;
      anchor = inZone({ x: vl.x + dcos(toward) * fwd + (w.rng.next() - 0.5) * 80, y: vl.y + dsin(toward) * fwd + (w.rng.next() - 0.5) * 80 });
    } else {
      // attackers / support: spread along the front edge of the zone
      const t = (i + 0.5) / units.length;
      const alongX = zone.w > zone.h;
      const frontY = enemyC.y > zone.y + zone.h / 2 ? zone.y + zone.h * 0.55 : zone.y + zone.h * 0.45;
      const frontX = enemyC.x > zone.x + zone.w / 2 ? zone.x + zone.w * 0.55 : zone.x + zone.w * 0.45;
      const back = role === 'fires' || role === 'drone' || role === 'hq';
      anchor = alongX
        ? { x: zone.x + zone.w * t, y: back ? zone.y + zone.h / 2 : frontY }
        : { x: back ? zone.x + zone.w / 2 : frontX, y: zone.y + zone.h * t };
      anchor = inZone(anchor);
    }
    const vehicle = u.vehicle >= 0;
    const p = inZone(findPosition(w, anchor, st.posture === 'defend' ? 45 : 70, st.posture === 'defend' ? enemyC : null, { vehicle, samples: 30 }));
    const np = nearestPassable(w.map, p.x, p.y, vehicle ? w.vehicles[u.vehicle].def.mobility : 'foot', 10) ?? p;
    placeUnit(w, u, np, angleTo(np, enemyC));
    u.order = { kind: 'defend', issuedAt: 0, facing: u.facing };
  });
}

/** Instantly relocate a unit (deployment phase). */
export function placeUnit(w: World, u: Unit, p: Vec2, facing: number): void {
  u.facing = facing;
  u.holdPos = { ...p };
  if (u.vehicle >= 0) {
    const v = w.vehicles[u.vehicle];
    v.x = v.px = p.x;
    v.y = v.py = p.y;
    v.heading = v.pheading = v.turret = v.pturret = facing;
    for (const id of v.crew) {
      w.soldiers[id].x = p.x;
      w.soldiers[id].y = p.y;
    }
    for (const pid of v.passengers) for (const id of w.units[pid].soldiers) {
      w.soldiers[id].x = w.soldiers[id].px = p.x;
      w.soldiers[id].y = w.soldiers[id].py = p.y;
    }
    return;
  }
  const alive = u.soldiers.map((id) => w.soldiers[id]);
  // spread into cover around p
  const map = w.map;
  const [ccx, ccy] = map.cellOf(p.x, p.y);
  const cells: { x: number; y: number; s: number }[] = [];
  for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
    const cx = ccx + dx;
    const cy = ccy + dy;
    if (!map.inBounds(cx, cy) || map.speedFactor(cx, cy, 'foot') <= 0) continue;
    const tt = map.type[cy * map.w + cx] as T;
    if (tt === T.Hedge || tt === T.Wall) continue;
    const s = map.cellCoverScore(cx, cy) - dhypot(dx, dy) * 0.08;
    cells.push({ x: (cx + 0.5) * CELL, y: (cy + 0.5) * CELL, s });
  }
  cells.sort((a, b) => b.s - a.s);
  alive.forEach((s, i) => {
    const c = cells[i % Math.max(1, cells.length)] ?? { x: p.x, y: p.y };
    s.x = s.px = c.x + ((i * 37) % 10) / 10 - 0.5;
    s.y = s.py = c.y + ((i * 53) % 10) / 10 - 0.5;
    s.facing = facing;
    s.path = null;
    s.moving = false;
    s.stance = 'crouch';
  });
}

// ------------------------------------------------------------------ battle AI

export function updateAI(w: World): void {
  for (const side of ['nato', 'opfor'] as Side[]) {
    if (!w.sides[side].ai) continue;
    const st = state(w, side);
    // stagger: each unit gets a think every ~2 s
    for (const u of w.units) {
      if (u.side !== side || u.eliminated || u.withdrawn) continue;
      if ((w.tick + u.id * 7) % 20 !== 0) continue;
      think(w, u, st);
    }
    if (w.time >= st.nextPlan) {
      st.nextPlan = w.time + 10;
      plan(w, side, st);
    }
  }
  // Player-side automatic self-preservation (like CC's soldiers acting on their own)
  for (const u of w.units) {
    if (w.sides[u.side].ai || u.eliminated || u.withdrawn) continue;
    if ((w.tick + u.id * 7) % 20 !== 0) continue;
    selfPreservation(w, u);
  }
}

function plan(w: World, side: Side, st: SideAI): void {
  if (st.posture === 'attack') {
    const cur = st.objective ? w.vls.find((v) => v.id === st.objective) : null;
    const done = cur && cur.owner === side && !cur.contested;
    if (!cur || done || w.time - st.objectiveSince > 240) {
      const next = pickObjective(w, side);
      if (next && next.id !== st.objective) {
        st.objective = next.id;
        st.objectiveSince = w.time;
        for (const u of w.units) if (u.side === side) u.ai.task = undefined;
      }
    }
  } else {
    // defenders: counter-attack a lost/contested VL with anything idle and healthy
    const lost = w.vls.filter((v) => (v.owner !== side || v.contested) && knownEnemiesNear(w, side, v, 100).length <= 3);
    st.objective = lost.length ? lost[0].id : null;
  }
}

function selfPreservation(w: World, u: Unit): void {
  if (u.vehicle >= 0 || u.mountedIn >= 0) return;
  if (u.order.kind !== 'none') return;
  const alive = w.aliveSoldiers(u);
  if (!alive.length) return;
  const underFire = w.time - u.underFireT < 3;
  if (!underFire) return;
  const exposed = alive.filter((s) => !s.moving && w.map.cellCoverScore(...w.map.cellOf(s.x, s.y)) < 0.15).length;
  if (exposed > alive.length / 2) {
    const threat = u.ai.threatDir;
    const p = w.unitPos(u);
    takeCover(w, u, p, threat ?? u.facing, 'run');
  }
}

function think(w: World, u: Unit, st: SideAI): void {
  const side = u.side;
  const role = roleOf(w, u);
  const pos = w.unitPos(u);
  const avail = availableOrders(w, u);
  const obj = st.objective ? w.vls.find((v) => v.id === st.objective) ?? null : null;
  const enemySide = otherSide(side);
  void enemySide;

  // --- universal reactions ---
  if (u.vehicle >= 0) {
    const v = w.vehicles[u.vehicle];
    if (v.destroyed || v.abandoned) return;
    // light vehicles facing tanks/ATGMs back off
    const recentlyHit = w.time - v.lastHitT < 6;
    if (recentlyHit && v.def.armor.front < 100 && !v.immobilized && u.order.kind !== 'reverse') {
      const away = (v.lastThreatDir ?? v.heading) + Math.PI;
      const dest = findPosition(w, { x: v.x + dcos(away) * 90, y: v.y + dsin(away) * 90 }, 50, null, { vehicle: true, samples: 12 });
      if (order(w, u, { kind: 'reverse', target: dest })) return;
    }
    if (recentlyHit && v.smokeSalvos > 0 && avail.includes('smoke') && w.rng.next() < 0.5) {
      order(w, u, { kind: 'smoke' });
    }
  } else if (u.mountedIn < 0) {
    // infantry: rally when broken
    if (u.stateLabel === 'Pinned' || u.stateLabel === 'Cowering' || u.stateLabel === 'Panicked') return;
  }

  // --- abilities ---
  if (avail.includes('strike') && u.charges > 0) {
    // best armoured target we can see
    let best: Unit | null = null;
    let bestV = 0;
    for (const info of w.spotted[side].values()) {
      if (!info.visible) continue;
      const eu = w.units[info.unitId];
      if (eu.eliminated) continue;
      const val = eu.vehicle >= 0 ? eu.template.cost : eu.template.symbol === 'at' ? 60 : 0;
      if (val > bestV && dist(pos, info) < 3500) {
        bestV = val;
        best = eu;
      }
    }
    if (best && bestV >= 60 && !w.drones.some((d) => !d.dead && d.side === side && d.targetUnit === best!.id)) {
      if (order(w, u, { kind: 'strike', targetUnit: best.id })) return;
    }
  }
  if (avail.includes('uav') && u.charges > (u.template.abilities?.includes('fpv') || u.template.abilities?.includes('loiter') ? 1 : 0)) {
    const hasDrone = w.drones.some((d) => !d.dead && d.unitId === u.id && d.kind === 'recon');
    if (!hasDrone) {
      const target = obj ?? w.vls.find((v) => v.owner !== side) ?? w.vls[0];
      if (target && order(w, u, { kind: 'uav', target: { x: target.x, y: target.y } })) return;
    }
  }
  if (avail.includes('callFire') && u.charges > 0 && w.fireMissions.filter((m) => m.side === side && !m.smoke).length === 0) {
    // biggest known enemy concentration that we can observe
    let best: Vec2 | null = null;
    let bestN = 0;
    for (const info of w.spotted[side].values()) {
      if (!info.visible) continue;
      const eu = w.units[info.unitId];
      if (eu.eliminated) continue;
      const near = knownEnemiesNear(w, side, info, 50);
      const n = near.reduce((a, e) => a + (e.unit.vehicle >= 0 ? 1.5 : e.unit.alive / 3), 0);
      // don't call fire danger-close
      const friendlyClose = w.friendlyUnits(side).some((f) => dist(w.unitPos(f), info) < 160);
      if (!friendlyClose && n > bestN) {
        bestN = n;
        best = { x: info.x, y: info.y };
      }
    }
    if (best && bestN >= 2 && hasObservation(w, u, best)) {
      if (order(w, u, { kind: 'callFire', target: best })) return;
    }
  }
  // Mortar smoke to screen an assault crossing open ground
  if (role === 'fires' && st.posture === 'attack' && obj && smokeLeft(w, u) > 0) {
    // screen the assault: smoke between the closest assaulting squad and the objective
    const assaulting = w.friendlyUnits(u.side).filter((f) => roleOf(w, f) === 'assault' && f.order.kind === 'moveFast' && dist(w.unitPos(f), obj) < 160);
    const last = u.ai.t ?? -999;
    if (assaulting.length && w.time - last > 60) {
      const f = w.unitPos(assaulting[0]);
      const mid = { x: (obj.x + f.x) / 2, y: (obj.y + f.y) / 2 };
      if (order(w, u, { kind: 'smoke', target: mid })) {
        u.ai.t = w.time;
        return;
      }
    }
  }

  if (busy(w, u)) return;

  if (st.posture === 'defend') return defendThink(w, u, st, role, obj);
  return attackThink(w, u, st, role, obj);
}

function defendThink(w: World, u: Unit, st: SideAI, role: Role, obj: VictoryLocation | null): void {
  const pos = w.unitPos(u);
  if (u.mountedIn >= 0) {
    order(w, u, { kind: 'dismount' });
    return;
  }
  // Counter-attack lost VL with healthy assault/armor units not in contact
  if (obj && (role === 'assault' || role === 'armor' || role === 'carrier')) {
    const inContact = w.time - u.underFireT < 20;
    const healthy = u.vehicle >= 0 || u.alive >= Math.max(2, u.initialSoldiers * 0.5);
    if (!inContact && healthy && dist(pos, obj) > 40 && (u.ai.task === undefined || u.ai.task === 'hold') && w.rng.next() < 0.5) {
      u.ai.task = 'counter';
      const dest = findPosition(w, obj, 25, null, { vehicle: u.vehicle >= 0, samples: 10 });
      if (order(w, u, { kind: u.vehicle >= 0 ? 'move' : 'moveFast', target: dest })) return;
    }
  }
  if (u.ai.task === 'counter' && (!obj || dist(pos, obj) < 35)) {
    u.ai.task = 'hold';
  }
  if (u.order.kind === 'none') {
    // settle into defence facing the nearest known threat
    const threats = knownEnemiesNear(w, u.side, pos, 900);
    let face = u.facing;
    if (threats.length) {
      threats.sort((a, b) => dist(pos, a) - dist(pos, b));
      face = angleTo(pos, threats[0]);
    }
    order(w, u, { kind: 'defend', target: { x: pos.x + dcos(face) * 50, y: pos.y + dsin(face) * 50 } });
    u.ai.task = u.ai.task ?? 'hold';
  }
}

function attackThink(w: World, u: Unit, st: SideAI, role: Role, obj: VictoryLocation | null): void {
  if (!obj) {
    if (u.order.kind === 'none') order(w, u, { kind: 'defend' });
    return;
  }
  // Preparation: recon, fires and overwatch first; the assault steps off after a minute.
  if (w.time < 60 && (role === 'assault' || role === 'carrier')) return;
  const pos = w.unitPos(u);
  const d = dist(pos, obj);
  const known = knownEnemiesNear(w, u.side, obj, 160);
  const enemyAtObj = known.reduce((n, e) => n + (e.unit.vehicle >= 0 ? 3 : e.unit.alive), 0);
  // Local superiority: our effective strength near the objective vs what we know is there.
  let ours = 0;
  for (const f of w.friendlyUnits(u.side)) {
    if (f.mountedIn >= 0) continue;
    const fp = w.unitPos(f);
    if (dist(fp, obj) > 220) continue;
    ours += f.vehicle >= 0 ? 4 : f.effective;
  }
  const lateGame = w.time > w.timeLimit * 0.55;
  const superiority = ours >= Math.max(4, enemyAtObj * (lateGame ? 1.0 : 1.5));

  switch (role) {
    case 'carrier': {
      const v = w.vehicles[u.vehicle];
      // drive toward the objective, dismount 150-250 m out or when under fire
      const underFire = w.time - v.lastHitT < 8 || w.time - u.underFireT < 4;
      if (d < 260 || underFire) {
        if (Math.abs(v.speed) < 1) {
          order(w, u, { kind: 'dismount' });
          u.ai.task = 'support';
        }
        return;
      }
      const toward = angleTo(pos, obj);
      const stop = { x: obj.x - dcos(toward) * 220, y: obj.y - dsin(toward) * 220 };
      const dest = findPosition(w, stop, 60, obj, { vehicle: true, samples: 14 });
      order(w, u, { kind: 'moveFast', target: dest });
      return;
    }
    case 'assault': {
      if (u.mountedIn >= 0) {
        const cv = w.vehicles[u.mountedIn];
        if (cv.destroyed || cv.abandoned || cv.immobilized) order(w, u, { kind: 'dismount' });
        return; // passenger: carrier decides
      }
      const alive = w.aliveSoldiers(u);
      if (alive.length < Math.max(2, u.initialSoldiers * 0.34)) {
        // combat ineffective: hold as a support-by-fire element
        if (u.order.kind === 'none') order(w, u, { kind: 'defend', target: obj });
        return;
      }
      const suppressed = alive.filter((s) => s.supp > 40).length > alive.length / 2;
      if (suppressed) return;
      const waitT = u.ai.waitT ?? 0;
      if (w.time < waitT) return;
      if (d < 22) {
        if (u.order.kind !== 'defend') order(w, u, { kind: 'defend' });
        return;
      }
      // Final assault when we have local superiority (or time is running out): smoke, then rush.
      if (d < 130 && (enemyAtObj <= 3 || superiority)) {
        if (d < 60 && ordersSmoke(w, u)) {
          const a = angleTo(pos, obj);
          order(w, u, { kind: 'smoke', target: { x: pos.x + dcos(a) * 30, y: pos.y + dsin(a) * 30 } });
        }
        order(w, u, { kind: 'moveFast', target: findPosition(w, obj, 15, null, { samples: 8 }) });
        u.ai.waitT = w.time + 10;
        return;
      }
      const step = Math.max(10, Math.min(d - 20, 70 + w.rng.next() * 50));
      const a = angleTo(pos, obj);
      const next = { x: pos.x + dcos(a) * step, y: pos.y + dsin(a) * step };
      const dest = findPosition(w, next, 35, obj, { samples: 18 });
      const contact = w.time - u.underFireT < 8;
      order(w, u, { kind: contact && !lateGame ? 'sneak' : 'move', target: dest });
      u.ai.waitT = w.time + (lateGame ? 6 : contact ? 16 : 10) + w.rng.next() * 6;
      return;
    }
    case 'support':
    case 'antiarmor':
    case 'armor':
    case 'scout': {
      // move into an overwatch position with LOS to the objective
      const want = role === 'armor' ? (enemyAtObj <= 3 || superiority ? 70 : lateGame ? 140 : 220) : role === 'antiarmor' ? 450 : role === 'scout' ? 350 : 300;
      const goodPos = u.ai.goal && dist(pos, u.ai.goal) < 25 && u.ai.task === `ow:${obj.id}`;
      if (goodPos && u.order.kind !== 'none') return;
      if (goodPos && u.order.kind === 'none') {
        order(w, u, { kind: role === 'antiarmor' ? 'ambush' : 'defend', target: obj });
        return;
      }
      if (Math.abs(d - want) < 80 && u.order.kind === 'defend' && u.ai.task === `ow:${obj.id}`) return;
      const a = angleTo(obj, pos);
      const near = { x: obj.x + dcos(a) * want, y: obj.y + dsin(a) * want };
      const dest = findPosition(w, near, 90, obj, { vehicle: u.vehicle >= 0, samples: 22, minDistFromLook: role === 'armor' ? 40 : 120, eye: u.vehicle >= 0 ? 2.6 : 1.1 });
      u.ai.goal = dest;
      u.ai.task = `ow:${obj.id}`;
      order(w, u, { kind: role === 'scout' ? 'moveFast' : 'move', target: dest });
      return;
    }
    case 'hq':
    case 'drone':
    case 'fires': {
      // stay behind the assault, out of direct fire
      const back = role === 'fires' ? 550 : 320;
      if (d > back + 150 && role !== 'fires') {
        const a = angleTo(obj, pos);
        const dest = findPosition(w, { x: obj.x + dcos(a) * back, y: obj.y + dsin(a) * back }, 80, null, { samples: 12 });
        order(w, u, { kind: 'move', target: dest });
      } else if (u.order.kind === 'none') order(w, u, { kind: 'defend', target: obj });
      return;
    }
  }
}

/** Seat infantry into free carriers at battle start (AI convenience). */
export function aiMountUp(w: World, side: Side): void {
  const carriers = w.units.filter((u) => u.side === side && u.vehicle >= 0 && w.vehicles[u.vehicle].def.seats >= 6);
  const inf = w.units.filter((u) => u.side === side && u.template.symbol === 'inf' && u.mountedIn < 0);
  for (const c of carriers) {
    const pax = inf.find((i) => i.mountedIn < 0 && freeSeats(w, c) >= w.aliveSoldiers(i).length);
    if (pax) w.embark(pax, c);
  }
}
