import type { Side } from '../data/units';
import { clamp } from './math';
import { TERRAIN, T } from './terrain';
import type { Soldier, Unit } from './types';
import { World } from './world';

export const EYE: Record<Soldier['stance'], number> = { stand: 1.7, crouch: 1.1, prone: 0.45 };
export const TGT_H: Record<Soldier['stance'], number> = { stand: 1.3, crouch: 0.85, prone: 0.3 };

const SPOT_PERIOD = 5; // ticks between checks for a given observer unit
const LOSE_AFTER = 4; // seconds without LOS before a contact is lost
const MAX_RANGE = 2200;

interface Obs {
  x: number;
  y: number;
  eye: number;
  thermal: boolean;
  quality: number;
}

function observers(w: World, u: Unit): Obs[] {
  if (u.vehicle >= 0) {
    const v = w.vehicles[u.vehicle];
    if (v.destroyed || v.abandoned) return [];
    const crewAlive = v.crew.some((id) => World.active(w.soldiers[id]));
    if (!crewAlive) return [];
    return [{ x: v.x, y: v.y, eye: v.def.eye, thermal: v.def.thermal, quality: 1.25 * (1 - Math.min(0.6, v.shock / 150)) }];
  }
  if (u.mountedIn >= 0) return [];
  const alive = w.aliveSoldiers(u);
  const out: Obs[] = [];
  // leader + up to two others
  alive.sort((a, b) => Number(b.leader) - Number(a.leader));
  for (const s of alive.slice(0, 3)) {
    if (s.state === 'cowering' || s.state === 'panicked') continue;
    const eye = s.stance === 'prone' ? 0.6 : EYE[s.stance];
    const q = (0.7 + 0.6 * s.exp) * (1 - s.supp / 160) * (s.leader ? 1.25 : 1);
    out.push({ x: s.x, y: s.y, eye, thermal: s.leader && u.side === 'nato', quality: q });
  }
  return out;
}

interface Tgt {
  x: number;
  y: number;
  h: number;
  vehicle: boolean;
  exposure: number; // stance/size factor
  activity: number;
  conceal: number;
}

function targets(w: World, u: Unit): Tgt[] {
  if (u.vehicle >= 0) {
    const v = w.vehicles[u.vehicle];
    const p = w.map.propsAt(v.x, v.y);
    const fired = w.time - v.firedT < 4 ? 3 : 1;
    const moving = Math.abs(v.speed) > 1 ? 1.6 : 0.5;
    // vehicles in woods are partly hidden, burning wrecks are obvious
    return [{ x: v.x, y: v.y, h: v.def.height * 0.6, vehicle: true, exposure: 1, activity: fired * moving, conceal: p.conceal * 0.6 }];
  }
  if (u.mountedIn >= 0) return [];
  const alive = w.aliveSoldiers(u);
  const out: Tgt[] = [];
  const ambush = u.order.kind === 'ambush';
  for (let i = 0; i < alive.length && out.length < 3; i++) {
    const s = alive[(i * 5 + (w.tick >> 3)) % alive.length];
    const t = w.map.typeAt(s.x, s.y);
    const props = TERRAIN[t as T];
    const sinceFire = w.time - s.firedT;
    let activity = 1;
    if (sinceFire < 3) activity *= 1 + 2.5 * (s.weapons[s.wIdx]?.def.signature ?? 1);
    else if (s.moving) activity *= s.moveMode === 'run' ? 1.7 : s.moveMode === 'sneak' ? 0.45 : 1.2;
    else if (ambush) activity *= 0.45;
    const exposure = s.stance === 'stand' ? 1 : s.stance === 'crouch' ? 0.6 : 0.3;
    out.push({ x: s.x, y: s.y, h: TGT_H[s.stance], vehicle: false, exposure, activity, conceal: props.conceal });
  }
  return out;
}

/** Chance to spot per check (every 0.5 s) given a clear LOS. */
function spotChance(o: Obs, t: Tgt, d: number, obstruction: number): number {
  let p: number;
  if (t.vehicle) p = 0.6 * Math.exp(-d / 1200);
  else p = 0.35 * Math.exp(-d / 220);
  p *= t.exposure;
  p *= 1 - t.conceal * (t.activity > 2 ? 0.3 : 0.9);
  p *= 1 - obstruction * 0.75;
  p *= t.activity;
  p *= o.quality;
  if (o.thermal) p *= t.vehicle ? 1.6 : 1.35;
  return clamp(p, 0, 1);
}

export function updateSpotting(w: World): void {
  const phase = w.tick % SPOT_PERIOD;
  for (const obsUnit of w.units) {
    if (obsUnit.eliminated || obsUnit.withdrawn) continue;
    if (obsUnit.id % SPOT_PERIOD !== phase) continue;
    const obs = observers(w, obsUnit);
    if (!obs.length) continue;
    const side = obsUnit.side;
    const known = w.spotted[side];
    const op = w.unitPos(obsUnit);
    for (const tgtUnit of w.units) {
      if (tgtUnit.side === side || tgtUnit.eliminated || tgtUnit.withdrawn) continue;
      const tp = w.unitPos(tgtUnit);
      const d0 = Math.hypot(tp.x - op.x, tp.y - op.y);
      if (d0 > MAX_RANGE) continue;
      const tgts = targets(w, tgtUnit);
      if (!tgts.length) continue;
      const info = known.get(tgtUnit.id);
      const tracked = !!info?.visible;
      let seen = false;
      let tries = 0;
      outer: for (const o of obs) {
        for (const t of tgts) {
          if (++tries > 4) break outer;
          const d = Math.hypot(t.x - o.x, t.y - o.y);
          if (!t.vehicle && d > 1100 && t.activity < 2) continue;
          const los = w.map.los(o.x, o.y, o.eye, t.x, t.y, t.h, o.thermal ? 0.35 : 1);
          if (!los.clear) continue;
          if (!t.vehicle) t.conceal = Math.max(t.conceal, w.map.coverAt(t.x, t.y, o.x, o.y).conceal);
          if (tracked) {
            // Keep tracking while LOS persists (but concealed infantry may slip away)
            if (t.vehicle || w.rng.next() < 0.5 + spotChance(o, t, d, los.obstruction) * 2) {
              seen = true;
              break outer;
            }
            continue;
          }
          if (w.rng.next() < spotChance(o, t, d, los.obstruction)) {
            seen = true;
            break outer;
          }
        }
      }
      if (seen) markSpotted(w, side, tgtUnit, tp.x, tp.y);
    }
  }
  // Drones and expiry
  for (const side of ['nato', 'opfor'] as Side[]) {
    for (const d of w.drones) {
      if (d.dead || d.side !== side || d.kind !== 'recon') continue;
      if ((w.tick + d.id) % SPOT_PERIOD !== 0) continue;
      for (const u of w.units) {
        if (u.side === side || u.eliminated || u.withdrawn || u.mountedIn >= 0) continue;
        const p = w.unitPos(u);
        const dd = Math.hypot(p.x - d.x, p.y - d.y);
        if (dd > 190) continue;
        const t = w.map.typeAt(p.x, p.y);
        let chance = u.vehicle >= 0 ? 0.9 : 0.55;
        if (t === T.Building) chance *= 0.15;
        else if (t === T.Forest) chance *= u.vehicle >= 0 ? 0.45 : 0.25;
        if (w.rng.next() < chance) markSpotted(w, side, u, p.x, p.y);
      }
    }
    for (const info of w.spotted[side].values()) {
      const u = w.units[info.unitId];
      if (u.eliminated || u.withdrawn) {
        info.visible = false;
        continue;
      }
      if (info.visible && w.time - info.lastSeen > LOSE_AFTER) {
        info.visible = false;
      }
      if (info.visible) {
        const p = w.unitPos(u);
        info.x = p.x;
        info.y = p.y;
      }
    }
  }
}

export function markSpotted(w: World, side: Side, u: Unit, x: number, y: number): void {
  const known = w.spotted[side];
  let info = known.get(u.id);
  if (!info) {
    info = { unitId: u.id, visible: true, lastSeen: w.time, x, y, firstSeen: w.time };
    known.set(u.id, info);
    const label = u.vehicle >= 0 ? w.vehicles[u.vehicle].def.name : u.template.name;
    w.msg(side, `Contact: enemy ${label} spotted.`, -1, u.vehicle >= 0 ? 'alert' : 'warn');
  } else if (!info.visible) {
    info.visible = true;
    if (w.time - info.lastSeen > 30) {
      const label = u.vehicle >= 0 ? w.vehicles[u.vehicle].def.name : u.template.name;
      w.msg(side, `Contact: enemy ${label} spotted.`, -1, u.vehicle >= 0 ? 'alert' : 'warn');
    }
  }
  info.lastSeen = w.time;
  info.x = x;
  info.y = y;
}
