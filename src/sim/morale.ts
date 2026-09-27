import { angleTo, clamp } from './math';
import { dismountNow } from './combat';
import { findPath, nearestPassable } from './pathfinding';
import { CELL, T } from './terrain';
import type { MoraleState, Soldier, Unit } from './types';
import { DT, World } from './world';
import { dcos, dhypot, dsin } from './dmath';

const STATE_LABEL: Record<MoraleState, string> = {
  ready: 'Ready',
  pinned: 'Pinned',
  cowering: 'Cowering',
  panicked: 'Panicked',
  routing: 'Routing',
  surrendered: 'Surrendered',
  berserk: 'Berserk',
};

export function updateMorale(w: World): void {
  // Leaders & HQ presence per unit (cheap lookup)
  const hqs = w.units.filter((u) => u.template.symbol === 'hq' && !u.eliminated).map((u) => ({ side: u.side, p: w.unitPos(u), u }));
  const everySecond = w.tick % 10 === 0;
  for (const s of w.soldiers) {
    if (s.health === 'dead' || s.health === 'incap' || s.fled) continue;
    const u = w.units[s.unitId];
    s.stateT += DT;
    // ---- suppression decay ----
    const [cx, cy] = w.map.cellOf(s.x, s.y);
    const t = w.map.type[cy * w.map.w + cx] as T;
    const inCover = t === T.Building || t === T.Forest || t === T.Rubble || t === T.Crater || w.map.cellCoverScore(cx, cy) > 0.3;
    const leader = w.leaderOf(u);
    const leaderNear = !!leader && leader !== s && dhypot(leader.x - s.x, leader.y - s.y) < 40;
    const hqNear = hqs.some((h) => h.side === s.side && dhypot(h.p.x - s.x, h.p.y - s.y) < 80);
    let decay = (4 + 6 * s.exp) * (inCover ? 1.35 : 1) * (leaderNear ? 1.2 : 1) * (hqNear ? 1.15 : 1);
    if (s.vehicle >= 0) decay *= 1.5;
    s.supp = Math.max(0, s.supp - decay * DT);
    // ---- morale drift ----
    const recovering = s.supp < 20;
    if (recovering) {
      const rate = 0.6 * (leaderNear ? 1.5 : 1) * (hqNear ? 1.4 : 1);
      if (s.morale < s.baseMorale) s.morale = Math.min(s.baseMorale, s.morale + rate * DT);
    } else {
      s.morale -= (s.supp / 100) * 1.2 * (1.2 - s.exp * 0.5) * DT;
    }
    s.morale = clamp(s.morale, 0, 100);
    if (everySecond) moraleTick(w, s, u);
    // ---- state machine (fast part) ----
    const prev = s.state;
    switch (s.state) {
      case 'surrendered':
        break;
      case 'berserk':
        if (s.stateT > 25) setState(s, 'ready');
        s.supp = Math.min(s.supp, 30);
        break;
      case 'routing':
      case 'panicked':
        if (s.stateT > 18 && s.morale > 40 && s.supp < 30) setState(s, 'ready');
        break;
      default:
        if (s.supp >= 88) setState(s, 'cowering');
        else if (s.supp >= 60) setState(s, 'pinned');
        else if ((s.state === 'pinned' && s.supp < 45) || (s.state === 'cowering' && s.supp < 70)) setState(s, s.supp >= 45 ? 'pinned' : 'ready');
        break;
    }
    if (prev !== s.state) onStateChange(w, s, u, prev);
    updateStance(w, s, u, t);
  }
  // Unit summaries
  if (w.tick % 5 === 0) for (const u of w.units) summarize(w, u);
}

function setState(s: Soldier, st: MoraleState): void {
  s.state = st;
  s.stateT = 0;
}

function onStateChange(w: World, s: Soldier, u: Unit, prev: MoraleState): void {
  if (s.state === 'pinned' || s.state === 'cowering') {
    if (s.vehicle < 0) {
      s.path = null;
      s.moving = false;
    }
    // Rare heroism under fire
    if (prev === 'ready' && s.exp > 0.65 && s.morale > 60 && w.rng.next() < 0.015) {
      setState(s, 'berserk');
      w.msg(s.side, `${u.name}: ${s.rank} ${s.name} has gone berserk!`, u.id, 'info');
    }
  }
}

/** Once-per-second morale events. */
function moraleTick(w: World, s: Soldier, u: Unit): void {
  if (s.vehicle >= 0 && s.crewSeat < 0) return; // passengers are along for the ride
  const enemyTankNear = tankFear(w, s, u);
  if (enemyTankNear) s.morale -= 1.2 * (1.2 - s.exp * 0.5);
  // Isolation
  const friends = w.soldiersNear(s.x, s.y, 60, (o) => o.side === s.side && o !== s && World.active(o)).length;
  if (friends === 0 && s.vehicle < 0) s.morale -= 0.8;
  // Break
  if (s.state !== 'panicked' && s.state !== 'routing' && s.state !== 'surrendered' && s.state !== 'berserk') {
    if (s.morale < 22 && (s.supp > 35 || w.time - u.lastCasualtyT < 10) && w.rng.next() < 0.25) {
      setState(s, 'panicked');
      s.fleeT = 0;
      if (s.vehicle < 0) w.msg(s.side, `${u.name}: ${s.rank} ${s.name} is panicking!`, u.id, 'warn');
    }
  }
  // Surrender: broken, and enemy infantry close
  if ((s.state === 'panicked' || s.state === 'cowering' || s.state === 'pinned') && s.morale < 12 && s.vehicle < 0) {
    const enemies = w.soldiersNear(s.x, s.y, 45, (o) => o.side !== s.side && World.active(o) && o.vehicle < 0);
    if (enemies.length && w.rng.next() < 0.15) {
      setState(s, 'surrendered');
      s.target = null;
      s.path = null;
      w.captured[enemies[0].side]++;
      w.emit({ type: 'casualty', soldier: s.id, health: s.health, side: s.side });
      w.msg(s.side, `${u.name}: ${s.rank} ${s.name} has surrendered!`, u.id, 'alert');
      for (const id of u.soldiers) if (id !== s.id) w.soldiers[id].morale -= 6;
      return;
    }
  }
  // Panicked soldiers run for cover away from the threat; badly broken ones rout off-map
  if (s.state === 'panicked' || s.state === 'routing') {
    if (s.vehicle >= 0) {
      maybeBail(w, s, u);
      return;
    }
    s.fleeT -= 1;
    if (s.fleeT <= 0) {
      s.fleeT = 8;
      if (s.morale < 8 && s.stateT > 10) setState(s, 'routing');
      flee(w, s, u);
    }
  }
  if (s.state === 'berserk' && s.vehicle < 0) {
    // charge the nearest visible enemy
    let best: Soldier | null = null;
    let bd = 150;
    for (const info of w.spotted[s.side].values()) {
      if (!info.visible) continue;
      for (const id of w.units[info.unitId].soldiers) {
        const o = w.soldiers[id];
        if (!World.active(o) || o.vehicle >= 0) continue;
        const d = dhypot(o.x - s.x, o.y - s.y);
        if (d < bd) {
          bd = d;
          best = o;
        }
      }
    }
    if (best && (!s.path || w.rng.next() < 0.3)) {
      s.path = findPath(w.map, s, best, { mob: 'foot', maxNodes: 3000 });
      s.pathIdx = 0;
      s.moveMode = 'run';
    }
  }
}

function tankFear(w: World, s: Soldier, u: Unit): boolean {
  if (s.vehicle >= 0) return false;
  const hasAT = u.soldiers.some((id) => w.soldiers[id].weapons.some((ws) => ws.def.antiArmor && ws.ammo > 0 && ws.def.pen > 300));
  if (hasAT) return false;
  for (const v of w.vehicles) {
    if (v.side === s.side || v.destroyed || v.abandoned) continue;
    if (v.def.armor.front < 300) continue;
    if (!w.isVisibleTo(s.side, v.unitId)) continue;
    if (dhypot(v.x - s.x, v.y - s.y) < 220) return true;
  }
  return false;
}

function maybeBail(w: World, s: Soldier, u: Unit): void {
  if (s.crewSeat < 0 || u.vehicle < 0) return;
  const v = w.vehicles[u.vehicle];
  if (v.destroyed || v.abandoned) return;
  // Crews only abandon damaged vehicles
  if ((v.immobilized || v.gunDamaged) && s.crewSeat === 0 && w.rng.next() < 0.3) {
    v.abandoned = true;
    v.speed = 0;
    v.path = null;
    for (const pid of [...v.passengers]) dismountNow(w, w.units[pid]);
    const crew = v.crew.map((id) => w.soldiers[id]).filter((c) => World.active(c));
    w.msg(v.side, `${u.name}: Crew is abandoning the vehicle!`, u.id, 'alert');
    w.createCrewUnit(v, crew);
  } else if (v.path === null && s.crewSeat === 0) {
    // reverse away from the threat
    const a = (v.lastThreatDir ?? v.heading) + Math.PI;
    const dest = nearestPassable(w.map, v.x + dcos(a) * 60, v.y + dsin(a) * 60, v.def.mobility, 8);
    if (dest && !v.immobilized) {
      v.path = findPath(w.map, v, dest, { mob: v.def.mobility, maxNodes: 6000 });
      v.pathIdx = 0;
      v.reversing = true;
    }
  }
}

function flee(w: World, s: Soldier, u: Unit): void {
  const rear = w.sides[s.side].rear;
  // away from the threat, biased to own rear
  const threat = u.ai.threatDir;
  let ax = rear.x;
  let ay = rear.y;
  if (threat !== undefined) {
    ax = ax * 0.5 - dcos(threat);
    ay = ay * 0.5 - dsin(threat);
  }
  const l = dhypot(ax, ay) || 1;
  ax /= l;
  ay /= l;
  const routing = s.state === 'routing';
  const distance = routing ? 400 : 50;
  let goal = { x: s.x + ax * distance, y: s.y + ay * distance };
  if (!routing) {
    // look for the best cover near the flight direction
    const [gx, gy] = w.map.cellOf(goal.x, goal.y);
    let best = -1;
    for (let dy = -5; dy <= 5; dy++) {
      for (let dx = -5; dx <= 5; dx++) {
        const sc = w.map.cellCoverScore(gx + dx, gy + dy);
        if (sc > best) {
          best = sc;
          goal = w.map.cellCenter(gx + dx, gy + dy);
        }
      }
    }
  }
  goal.x = clamp(goal.x, CELL, w.map.width - CELL);
  goal.y = clamp(goal.y, CELL, w.map.height - CELL);
  const path = findPath(w.map, s, goal, { mob: 'foot', maxNodes: 6000 });
  if (path) {
    s.path = path;
    s.pathIdx = 0;
    s.moveMode = 'run';
    s.moveDelay = 0;
  }
  // Routing soldiers who reach the map edge leave the battle
  if (routing && (s.x < 10 || s.y < 10 || s.x > w.map.width - 10 || s.y > w.map.height - 10)) {
    s.fled = true;
    s.path = null;
    s.moving = false;
    s.target = null;
  }
}

function updateStance(w: World, s: Soldier, u: Unit, t: T): void {
  if (s.vehicle >= 0 || s.state === 'surrendered') return;
  if (s.moving) return; // movement code sets stance
  if (s.state === 'pinned' || s.state === 'cowering') {
    s.stance = 'prone';
    return;
  }
  if (w.time - s.firedT < 2) return; // keep firing posture
  const w0 = s.weapons[0]?.def;
  const underFire = s.supp > 20;
  if (t === T.Building) s.stance = underFire ? 'crouch' : 'stand';
  else if (underFire) s.stance = 'prone';
  else if (w0 && (w0.cls === 'mg' || w0.cls === 'sniper' || w0.cls === 'ar') && u.order.kind !== 'moveFast') s.stance = 'prone';
  else if (u.order.kind === 'ambush' || u.order.kind === 'sneak') s.stance = 'prone';
  else if (s.stance === 'stand') s.stance = 'crouch';
  if (s.target === null && !s.moving && u.facing !== undefined && w.time - s.firedT > 5) {
    // face the unit's facing when idle
    const f = u.order.kind === 'defend' || u.order.kind === 'ambush' ? u.facing : s.facing;
    s.facing = f;
  }
  void angleTo;
}

function summarize(w: World, u: Unit): void {
  if (u.eliminated || u.withdrawn) return;
  let alive = 0;
  let eff = 0;
  const counts: Partial<Record<MoraleState, number>> = {};
  for (const id of u.soldiers) {
    const s = w.soldiers[id];
    if (s.fled) continue;
    if (s.health === 'dead' || s.health === 'incap') continue;
    if (s.state === 'surrendered') continue;
    alive++;
    counts[s.state] = (counts[s.state] ?? 0) + 1;
    if (s.state === 'ready' || s.state === 'berserk' || s.state === 'pinned') eff++;
  }
  u.alive = alive;
  u.effective = eff;
  if (u.vehicle >= 0) {
    const v = w.vehicles[u.vehicle];
    if (v.destroyed) {
      u.stateLabel = 'Destroyed';
      u.eliminated = true;
      return;
    }
    if (v.abandoned) {
      u.stateLabel = 'Abandoned';
      u.eliminated = true;
      return;
    }
    const tags: string[] = [];
    if (v.immobilized) tags.push('Immobilised');
    if (v.gunDamaged) tags.push('Gun damaged');
    if (v.shock > 50) tags.push('Shaken');
    u.stateLabel = tags.join(', ') || (v.path ? 'Moving' : 'Ready');
    return;
  }
  if (alive === 0 && u.soldiers.some((id) => w.soldiers[id].fled)) {
    // everyone left is gone off the map: the unit routed rather than being destroyed
    const remaining = u.soldiers.filter((id) => w.soldiers[id].fled);
    if (remaining.length) {
      u.withdrawn = true;
      u.stateLabel = 'Routed';
      w.msg(u.side, `${u.name} has routed off the battlefield.`, u.id, 'alert');
      return;
    }
  }
  if (alive === 0) {
    u.eliminated = true;
    const anyAlive = u.soldiers.some((id) => w.soldiers[id].state === 'surrendered');
    u.stateLabel = anyAlive ? 'Surrendered' : 'Eliminated';
    w.msg(u.side, `${u.name} has been ${anyAlive ? 'captured' : 'wiped out'}.`, u.id, 'alert');
    const v = u.mountedIn >= 0 ? w.vehicles[u.mountedIn] : null;
    if (v) v.passengers = v.passengers.filter((id) => id !== u.id);
    return;
  }
  const order: MoraleState[] = ['surrendered', 'routing', 'panicked', 'cowering', 'pinned', 'berserk'];
  let label: string = u.mountedIn >= 0 ? 'Mounted' : 'Ready';
  for (const st of order) {
    if ((counts[st] ?? 0) * 2 >= alive) {
      label = STATE_LABEL[st];
      break;
    }
  }
  if (label === 'Ready' && u.mountedIn < 0) {
    const avgSupp = u.soldiers.reduce((n, id) => n + (World.active(w.soldiers[id]) ? w.soldiers[id].supp : 0), 0) / Math.max(1, alive);
    const avgMor = u.soldiers.reduce((n, id) => n + (World.active(w.soldiers[id]) ? w.soldiers[id].morale : 0), 0) / Math.max(1, alive);
    if (avgSupp > 30) label = 'Under fire';
    else if (avgMor < 35) label = 'Shaken';
    else if (w.aliveSoldiers(u).some((s) => s.moving)) label = 'Moving';
    else if (w.aliveSoldiers(u).some((s) => w.time - s.firedT < 2)) label = 'Firing';
  }
  u.stateLabel = label;
}
