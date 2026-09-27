import { FIRE_SUPPORT, otherSide } from '../data/units';
import { WEAPONS } from '../data/weapons';
import { angleTo, turnToward } from './math';
import { explode, hitVehicle } from './combat';
import { spawnSmoke } from './orders';
import type { Drone } from './types';
import { DT, World } from './world';
import { datan2, dcos, dhypot, dsin } from './dmath';

export function updateSupport(w: World): void {
  updateFireMissions(w);
  updateDrones(w);
  // smoke drift & decay
  for (const c of w.map.smoke) {
    c.age += DT;
    c.x += c.vx * DT;
    c.y += c.vy * DT;
    c.r = Math.min(c.r * 1.6, c.r + 0.05 * DT);
  }
  if (w.map.smoke.some((c) => c.age >= c.life)) w.map.smoke = w.map.smoke.filter((c) => c.age < c.life);
  // burning wrecks
  for (const v of w.vehicles) {
    if (v.burning > 0) {
      v.burning -= DT;
      if (w.rng.next() < 0.002) {
        // ammunition cook-off
        w.emit({ type: 'explosion', x: v.x, y: v.y, z: w.map.groundAt(v.x, v.y) + 2, size: 3, kind: 'vehicle' });
      }
    }
  }
}

function updateFireMissions(w: World): void {
  for (const m of w.fireMissions) {
    if (m.roundsLeft <= 0) continue;
    m.t += DT;
    if (m.t < m.nextT) continue;
    const u = w.units[m.unitId];
    if (m.smoke) {
      const def = u.template.side === 'nato' ? WEAPONS.m224 : WEAPONS.b14;
      m.roundsLeft--;
      m.nextT = m.t + 4;
      const x = m.x + w.rng.gauss() * 12;
      const y = m.y + w.rng.gauss() * 12;
      launchShell(w, m.side, x, y, def.blast ?? 8, true, m.unitId);
      continue;
    }
    const fs = FIRE_SUPPORT[m.side];
    if (m.roundsLeft === fs.rounds) {
      w.msg(m.side, `${u.name}: Shot, over. Rounds inbound!`, u.id, 'info');
      w.msg(otherSide(m.side), 'Incoming artillery!', -1, 'alert');
    }
    m.roundsLeft--;
    m.nextT = m.t + fs.interval * (0.6 + w.rng.next() * 0.8);
    const x = m.x + w.rng.gauss() * fs.spread;
    const y = m.y + w.rng.gauss() * fs.spread;
    launchShell(w, m.side, x, y, fs.weapon.blast, false, m.unitId);
  }
  if (w.fireMissions.some((m) => m.roundsLeft <= 0)) w.fireMissions = w.fireMissions.filter((m) => m.roundsLeft > 0);
}

/** Incoming shell: a short visible descent so the renderer can show it falling. */
function launchShell(w: World, side: 'nato' | 'opfor', x: number, y: number, _blast: number, smoke: boolean, unitId: number): void {
  const gz = w.map.groundAt(x, y);
  const fs = FIRE_SUPPORT[side];
  const def = side === 'nato' ? WEAPONS.m224 : WEAPONS.b14;
  w.projectiles.push({
    id: w.newProjectileId(),
    weapon: def,
    side,
    shooterSoldier: -1,
    shooterVehicle: -1,
    sx: x - 60,
    sy: y - 20,
    sz: gz + 260,
    tx: x,
    ty: y,
    tz: gz,
    x: x - 60,
    y: y - 20,
    z: gz + 260,
    px: x,
    py: y,
    pz: gz + 260,
    t: 0,
    T: 1.2,
    arc: 0,
    target: null,
    willHit: false,
    heavy: smoke ? undefined : fs.weapon,
    kind: 'artillery',
    smoke,
    dead: false,
  });
  void unitId;
}

function updateDrones(w: World): void {
  for (const d of w.drones) {
    if (d.dead) continue;
    d.life -= DT;
    if (d.life <= 0) {
      d.dead = true;
      if (d.kind === 'recon') w.msg(d.side, 'Recon drone returning to base (battery low).', d.unitId, 'info');
      continue;
    }
    if (d.kind === 'recon') reconDrone(w, d);
    else strikeDrone(w, d);
    // enemy air-defence by small arms: vehicles with RWS & MGs are best at it
    if (w.tick % 10 === d.id % 10) shootAtDrone(w, d);
  }
  if (w.drones.some((d) => d.dead)) w.drones = w.drones.filter((d) => !d.dead);
}

function reconDrone(w: World, d: Drone): void {
  const alt = 110;
  const dx = d.tx - d.x;
  const dy = d.ty - d.y;
  const dist = dhypot(dx, dy);
  if (dist > 90) {
    const a = datan2(dy, dx);
    d.heading = turnToward(d.heading, a, 1.2 * DT);
    d.x += dcos(d.heading) * d.speed * DT;
    d.y += dsin(d.heading) * d.speed * DT;
  } else {
    // orbit
    d.phase += (d.speed / 80) * DT;
    const ox = d.tx + dcos(d.phase) * 80;
    const oy = d.ty + dsin(d.phase) * 80;
    d.heading = angleTo(d, { x: ox, y: oy });
    d.x += (ox - d.x) * 0.2;
    d.y += (oy - d.y) * 0.2;
  }
  const gz = w.map.groundAt(d.x, d.y);
  d.z += (gz + alt - d.z) * 0.05;
}

function strikeDrone(w: World, d: Drone): void {
  const tu = w.units[d.targetUnit];
  if (tu && !tu.eliminated) {
    const p = w.unitPos(tu);
    // loitering munitions keep updating while the target is observed
    if (w.isVisibleTo(d.side, tu.id) || dhypot(p.x - d.tx, p.y - d.ty) < 60) {
      d.tx = p.x;
      d.ty = p.y;
    }
  }
  const gz = w.map.groundAt(d.tx, d.ty);
  const dx = d.tx - d.x;
  const dy = d.ty - d.y;
  const dist = dhypot(dx, dy);
  const a = datan2(dy, dx);
  d.heading = turnToward(d.heading, a, 2.5 * DT);
  const step = d.speed * DT;
  const cruise = w.map.groundAt(d.x, d.y) + Math.min(60, 10 + dist * 0.15);
  if (dist > step * 2) {
    d.x += dcos(d.heading) * step;
    d.y += dsin(d.heading) * step;
    d.z += (cruise - d.z) * 0.1;
    if (dist < 80) d.z += (gz + 1 - d.z) * 0.2; // terminal dive
    return;
  }
  // Impact
  d.dead = true;
  const vehicle = tu && tu.vehicle >= 0 ? w.vehicles[tu.vehicle] : null;
  const operatorSoldier = w.leaderOf(w.units[d.unitId])?.id ?? -1;
  const pHit = 0.78;
  if (vehicle && !vehicle.destroyed && dhypot(vehicle.x - d.x, vehicle.y - d.y) < 8 && w.rng.next() < pHit) {
    const pen = d.side === 'nato' ? 800 : 450; // Switchblade 600 (Javelin warhead) vs FPV with PG-7 warhead
    hitVehicle(w, vehicle, { pen, heat: true, tandem: d.side === 'nato', topAttack: true, cls: 'atgm', name: d.side === 'nato' ? 'Switchblade 600' : 'FPV drone' }, d.x, d.y, operatorSoldier, -1);
    w.emit({ type: 'explosion', x: vehicle.x, y: vehicle.y, z: gz + 2, size: 3, kind: 'drone' });
  } else {
    explode(w, d.x, d.y, { blast: 5, lethality: 0.55, pen: 0, suppression: 45, suppRadius: 12 }, d.side, operatorSoldier, 'drone');
  }
}

function shootAtDrone(w: World, d: Drone): void {
  let p = 0;
  const hr = d.kind === 'recon' ? 260 : 180;
  for (const v of w.vehicles) {
    if (v.side === d.side || v.destroyed || v.abandoned) continue;
    const dd = dhypot(v.x - d.x, v.y - d.y);
    if (dd > hr) continue;
    if (v.weapons.some((ws) => ws.mount === 'rws' || ws.def.cls === 'autocannon')) p += d.kind === 'recon' ? 0.003 : 0.02;
  }
  let n = 0;
  for (const s of w.soldiersNear(d.x, d.y, hr)) {
    if (s.side === d.side || !World.active(s) || s.state !== 'ready') continue;
    if (++n > 12) break;
    p += d.kind === 'recon' ? 0.0003 : 0.002;
  }
  if (p > 0 && w.rng.next() < p) {
    d.dead = true;
    w.emit({ type: 'explosion', x: d.x, y: d.y, z: d.z, size: 1, kind: 'small' });
    w.msg(d.side, d.kind === 'recon' ? 'Our recon drone was shot down.' : 'Strike drone shot down before impact!', d.unitId, 'warn');
    w.msg(otherSide(d.side), 'Enemy drone shot down!', -1, 'good');
  }
}

export { spawnSmoke };
