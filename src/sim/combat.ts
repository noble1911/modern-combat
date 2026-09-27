import { otherSide, Side } from '../data/units';
import { baseHitChance, WeaponDef, WEAPONS } from '../data/weapons';
import { angleTo, clamp, Vec2, wrapAngle } from './math';
import { spawnSmoke } from './orders';
import { EYE, TGT_H } from './spotting';
import { T } from './terrain';
import type { ExplosionKind, Health, Projectile, Soldier, TargetRef, Unit, VehicleState, WeaponState } from './types';
import { DT, World } from './world';
import { slewTurret } from './movement';
import { datan2, dcos, dhypot, dsin } from './dmath';

export interface BlastParams {
  blast: number;
  lethality: number;
  pen: number;
  suppression: number;
  suppRadius: number;
}

// ------------------------------------------------------------------ helpers

export function targetKey(t: TargetRef): string {
  return t.kind === 'point' ? `p:${t.x | 0}:${t.y | 0}` : `${t.kind[0]}:${t.id}`;
}

export function targetPoint(w: World, t: TargetRef): { x: number; y: number; z: number } {
  if (t.kind === 'soldier') {
    const s = w.soldiers[t.id];
    return { x: s.x, y: s.y, z: w.map.groundAt(s.x, s.y) + TGT_H[s.stance] };
  }
  if (t.kind === 'vehicle') {
    const v = w.vehicles[t.id];
    return { x: v.x, y: v.y, z: w.map.groundAt(v.x, v.y) + v.def.height * 0.55 };
  }
  return { x: t.x, y: t.y, z: w.map.groundAt(t.x, t.y) + 0.5 };
}

function firingEye(s: Soldier): number {
  return EYE[s.stance];
}

export function shooterMod(s: Soldier): number {
  return (
    (0.55 + 0.7 * s.exp) *
    (1 - 0.55 * Math.min(1, s.supp / 100)) *
    (s.health === 'wounded' ? 0.7 : 1) *
    (s.moving ? 0.4 : 1) *
    (s.state === 'pinned' ? 0.5 : 1) *
    (s.fatigue > 70 ? 0.85 : 1)
  );
}

function vehicleShooterMod(w: World, v: VehicleState): number {
  const gunner = v.crew.map((id) => w.soldiers[id]).find((s) => World.active(s) && s.crewSeat !== v.crew.length - 1) ?? null;
  const exp = gunner ? gunner.exp : 0.3;
  return (0.6 + 0.6 * exp) * (Math.abs(v.speed) > 1 ? 0.7 : 1) * (1 - Math.min(0.6, v.shock / 200));
}

function vehicleThreat(v: VehicleState): number {
  switch (v.def.id) {
    case 'm1a2':
    case 't90m':
    case 't72b3':
      return 3;
    case 'm2a4':
    case 'bmp3':
      return 2.2;
    case 'stryker':
    case 'btr82a':
      return 1.4;
    default:
      return 1;
  }
}

function facingOf(v: VehicleState, fromX: number, fromY: number, ref = v.heading): 'front' | 'side' | 'rear' {
  const incoming = datan2(fromY - v.y, fromX - v.x);
  const rel = Math.abs(wrapAngle(incoming - ref));
  return rel < 0.8 ? 'front' : rel > 2.35 ? 'rear' : 'side';
}

/** Rough chance a weapon kills the vehicle if it hits, from a position. */
function estimateKill(def: WeaponDef, v: VehicleState, fromX: number, fromY: number): number {
  const facing = def.topAttack ? 'top' : facingOf(v, fromX, fromY);
  let armor = v.def.armor[facing];
  if (def.heat && (facing === 'front' || facing === 'side')) armor *= v.def.compositeHEAT;
  let pen = def.pen;
  if (v.def.era && facing !== 'rear' && facing !== 'top') pen *= def.heat ? (def.tandem ? 0.8 : 0.4) : 0.85;
  const r = pen / armor;
  if (r > 1.4) return 0.85;
  if (r > 1.1) return 0.6;
  if (r > 0.9) return 0.25;
  if (r > 0.7) return 0.04;
  return 0;
}

function hitChanceVehicle(def: WeaponDef, d: number, mod: number, v: VehicleState): number {
  if (def.guidance) return clamp(def.accuracy * (0.75 + mod * 0.25), 0, 0.97);
  const size = clamp((v.def.length * v.def.height) / 12, 0.8, 1.6);
  let p = baseHitChance(def, d) * 2.2 * size * mod;
  if (Math.abs(v.speed) > 3) p *= 0.75;
  return clamp(p, 0, 0.97);
}

// ------------------------------------------------------------------ fire policy

interface Policy {
  may: boolean;
  maxRange: number;
  /** Separate limit for anti-armour fire at vehicles (ambushing AT teams wait for good shots). */
  maxRangeArmor: number;
  forcedUnit: number;
  forcedPoint: Vec2 | null;
}

/** Crews of heavy weapons only use their carbines in self-defence (keeps them hidden). */
export function selfDefenceOnly(u: Unit): boolean {
  const sym = u.template.symbol;
  return sym === 'at' || sym === 'mortar' || sym === 'hq' || sym === 'recon';
}

function policy(w: World, u: Unit): Policy {
  const o = u.order;
  const p: Policy = { may: true, maxRange: Infinity, maxRangeArmor: Infinity, forcedUnit: -1, forcedPoint: null };
  const underFire = w.time - u.underFireT < 6;
  switch (o.kind) {
    case 'moveFast':
      if (u.vehicle < 0) p.may = false;
      break;
    case 'mount':
      p.may = false;
      break;
    case 'sneak':
      if (!underFire) {
        p.maxRange = 60;
        p.maxRangeArmor = 60;
      }
      break;
    case 'ambush': {
      const sprung = underFire || (u.ai.sprungT !== undefined && w.time - u.ai.sprungT < 30);
      if (!sprung) {
        p.maxRange = 140;
        p.maxRangeArmor = 450;
      }
      break;
    }
    case 'fire':
      if (o.targetUnit !== undefined) p.forcedUnit = o.targetUnit;
      else if (o.target) p.forcedPoint = o.target;
      break;
  }
  return p;
}

// ------------------------------------------------------------------ main update

export function updateCombat(w: World): void {
  for (const s of w.soldiers) soldierCombat(w, s);
  for (const v of w.vehicles) vehicleCombat(w, v);
}

function tickWeapon(ws: WeaponState): void {
  if (ws.cooldown > 0) ws.cooldown -= DT;
  if (ws.reloadT > 0) {
    ws.reloadT -= DT;
    if (ws.reloadT <= 0) ws.loaded = Math.min(ws.def.mag, ws.ammo);
  }
}

function soldierCombat(w: World, s: Soldier): void {
  if (!World.active(s) || s.vehicle >= 0) return;
  for (const ws of s.weapons) tickWeapon(ws);
  if (s.state === 'cowering' || s.state === 'panicked' || s.state === 'routing') {
    s.target = null;
    return;
  }
  const u = w.units[s.unitId];
  const pol = policy(w, u);
  if (!pol.may || (s.moving && s.moveMode === 'run' && s.state !== 'berserk')) {
    s.target = null;
    return;
  }
  s.retargetT -= DT;
  if (s.retargetT <= 0 || !targetValid(w, s)) {
    acquireSoldierTarget(w, s, u, pol);
    s.retargetT = 1.1 + w.rng.next() * 1.0;
  }
  if (!s.target) return;
  const ws = s.weapons[s.wIdx];
  if (!ws || ws.ammo <= 0) {
    s.target = null;
    return;
  }
  const key = targetKey(s.target);
  if (ws.aimKey !== key) {
    ws.aimKey = key;
    ws.aimT = ws.def.aimTime * (1.35 - s.exp * 0.6) * (s.moving ? 1.5 : 1);
  }
  const tp = targetPoint(w, s.target);
  if (!s.moving) s.facing = angleTo(s, tp);
  if (ws.aimT > 0) {
    ws.aimT -= DT;
    return;
  }
  if (ws.cooldown > 0 || ws.reloadT > 0) return;
  if (ws.loaded <= 0) {
    if (ws.ammo > 0) ws.reloadT = ws.def.reload * (s.supp > 50 ? 1.5 : 1);
    return;
  }
  const heavy = ws.def.cls === 'rocket' || ws.def.cls === 'atgm' || ws.def.cls === 'mortar' || ws.def.cls === 'agl';
  if (heavy && s.moving) return;
  if ((ws.def.cls === 'rocket' || ws.def.cls === 'atgm') && s.stance === 'prone') s.stance = 'crouch';
  fireSoldier(w, s, ws, u, tp);
}

function targetValid(w: World, s: Soldier): boolean {
  const t = s.target;
  if (!t) return false;
  if (t.kind === 'soldier') {
    const o = w.soldiers[t.id];
    return World.active(o) && o.vehicle < 0 && w.isVisibleTo(s.side, o.unitId);
  }
  if (t.kind === 'vehicle') {
    const v = w.vehicles[t.id];
    return !v.destroyed && !v.abandoned && w.isVisibleTo(s.side, v.unitId);
  }
  return w.units[s.unitId].order.kind === 'fire';
}

interface Cand {
  score: number;
  ref: TargetRef;
  wIdx: number;
  x: number;
  y: number;
  h: number;
  indirect: boolean;
}

function acquireSoldierTarget(w: World, s: Soldier, u: Unit, pol: Policy): void {
  const prev = s.target ? targetKey(s.target) : null;
  s.target = null;
  const cands: Cand[] = [];
  const mod = shooterMod(s);
  if (pol.forcedPoint) {
    const p = pol.forcedPoint;
    const d = dhypot(p.x - s.x, p.y - s.y);
    s.weapons.forEach((ws, i) => {
      if (ws.ammo <= 0 || d > ws.def.range || d < (ws.def.minRange ?? 0) || !ws.def.antiPersonnel) return;
      if (ws.def.cls === 'rocket' || ws.def.cls === 'grenade' || ws.def.cls === 'atgm') return;
      cands.push({ score: ws.def.suppression * (ws.def.burst[0] + ws.def.burst[1]), ref: { kind: 'point', x: p.x, y: p.y }, wIdx: i, x: p.x, y: p.y, h: 0.5, indirect: !!ws.def.indirect });
    });
  } else {
    for (const info of w.spotted[s.side].values()) {
      if (!info.visible) continue;
      if (pol.forcedUnit >= 0 && info.unitId !== pol.forcedUnit) continue;
      const eu = w.units[info.unitId];
      if (eu.eliminated || eu.mountedIn >= 0) continue;
      const approx = dhypot(info.x - s.x, info.y - s.y);
      const lim = eu.vehicle >= 0 ? pol.maxRangeArmor : pol.maxRange;
      if (approx > lim + 30 || approx > 2600) continue;
      if (eu.vehicle >= 0) {
        const v = w.vehicles[eu.vehicle];
        if (v.destroyed || v.abandoned) continue;
        const d = dhypot(v.x - s.x, v.y - s.y);
        if (d > pol.maxRangeArmor) continue;
        s.weapons.forEach((ws, i) => {
          const def = ws.def;
          if (ws.ammo <= 0 || d > def.range || d < (def.minRange ?? 0) || def.indirect) return;
          if (!def.antiArmor && def.pen < v.def.armor.side) return;
          const pk = def.antiArmor ? estimateKill(def, v, s.x, s.y) : 0.08;
          if (pk <= 0) return;
          const p = hitChanceVehicle(def, d, mod, v);
          let score = p * pk * 100 * vehicleThreat(v);
          if (def.cls === 'grenade') return;
          // don't waste the only rocket on a hopeless shot
          if (def.antiArmor && pk < 0.2) score *= 0.2;
          cands.push({ score, ref: { kind: 'vehicle', id: v.id }, wIdx: i, x: v.x, y: v.y, h: v.def.height * 0.55, indirect: false });
        });
      } else {
        // closest two soldiers of the unit
        let a: Soldier | null = null;
        let b: Soldier | null = null;
        let da = Infinity;
        let db = Infinity;
        for (const id of eu.soldiers) {
          const o = w.soldiers[id];
          if (!World.active(o) || o.vehicle >= 0) continue;
          const d = (o.x - s.x) ** 2 + (o.y - s.y) ** 2;
          if (d < da) {
            b = a;
            db = da;
            a = o;
            da = d;
          } else if (d < db) {
            b = o;
            db = d;
          }
        }
        for (const o of [a, b]) {
          if (!o) continue;
          const d = dhypot(o.x - s.x, o.y - s.y);
          if (d > pol.maxRange) continue;
          const inBld = w.map.typeAt(o.x, o.y) === T.Building;
          const stanceF = o.stance === 'stand' ? 1 : o.stance === 'crouch' ? 0.65 : 0.4;
          const restrained = selfDefenceOnly(u) && w.time - u.underFireT > 4;
          s.weapons.forEach((ws, i) => {
            const def = ws.def;
            if (ws.ammo <= 0 || !def.antiPersonnel || d > def.range || d < (def.minRange ?? 0)) return;
            if (restrained && !def.indirect && d > 150) return;
            if (def.cls === 'grenade' && d > 30) return;
            let score: number;
            if (def.blast) {
              const reach = def.indirect ? 0.5 : baseHitChance(def, d) * 2;
              score = Math.min(1, reach) * def.lethality * (def.blast / 5) * 40;
              if (def.cls === 'rocket' || def.cls === 'atgm') score *= inBld ? 0.6 : 0.08;
              if (def.indirect) score *= 0.8;
              if (def.cls === 'grenade') score *= 2.5;
            } else {
              const rounds = (def.burst[0] + def.burst[1]) / 2;
              score = baseHitChance(def, d) * rounds * def.lethality * stanceF * mod * 100;
              score += def.suppression * rounds * 0.05;
            }
            // shooting back at whoever threatens us
            if (w.time - eu.underFireT < 5) score *= 1.1;
            cands.push({ score, ref: { kind: 'soldier', id: o.id }, wIdx: i, x: o.x, y: o.y, h: TGT_H[o.stance], indirect: !!def.indirect });
          });
        }
      }
    }
  }
  if (!cands.length) return;
  for (const c of cands) if (prev && targetKey(c.ref) === prev) c.score *= 1.35;
  cands.sort((x, y) => y.score - x.score);
  let tries = 0;
  for (const c of cands) {
    if (c.score <= 0.01) break;
    if (c.indirect) {
      s.target = c.ref;
      s.wIdx = c.wIdx;
      return;
    }
    if (++tries > 3) break;
    let eye = firingEye(s);
    let los = w.map.los(s.x, s.y, eye, c.x, c.y, c.h, 1);
    if (!los.clear && s.stance === 'prone' && s.state !== 'pinned') {
      eye = EYE.crouch;
      los = w.map.los(s.x, s.y, eye, c.x, c.y, c.h, 1);
      if (los.clear) s.stance = 'crouch';
    }
    if (!los.clear) continue;
    s.target = c.ref;
    s.wIdx = c.wIdx;
    s.tObs = los.obstruction;
    return;
  }
}

function fireSoldier(w: World, s: Soldier, ws: WeaponState, u: Unit, tp: { x: number; y: number; z: number }): void {
  const def = ws.def;
  const rounds = Math.min(ws.loaded, w.rng.int(def.burst[0], def.burst[1]));
  ws.loaded -= rounds;
  ws.ammo -= rounds;
  ws.cooldown = def.cycle * (0.85 + w.rng.next() * 0.4) * (1 + s.supp / 120) * (s.state === 'pinned' ? 1.8 : 1);
  s.firedT = w.time;
  if (u.order.kind === 'ambush') u.ai.sprungT = w.time;
  const sz = w.map.groundAt(s.x, s.y) + firingEye(s) - 0.1;
  const from = { x: s.x, y: s.y, z: sz };
  const t = s.target!;
  const mod = shooterMod(s);
  if (def.speed) {
    launch(w, def, s.side, s.id, -1, from, t, mod, rounds);
    return;
  }
  resolveHitscan(w, def, s.side, s.id, -1, from, t, tp, rounds, mod, s.tObs);
}

/** Instant-resolution fire (small arms, MGs, HMGs). */
function resolveHitscan(
  w: World,
  def: WeaponDef,
  side: Side,
  shooterSoldier: number,
  shooterVehicle: number,
  from: { x: number; y: number; z: number },
  t: TargetRef,
  tp: { x: number; y: number; z: number },
  rounds: number,
  mod: number,
  obstruction: number,
): void {
  const d = dhypot(tp.x - from.x, tp.y - from.y);
  let hitAny = false;
  if (w.dbg) w.curWeapon = `${def.name}${shooterVehicle >= 0 ? ` (${w.units[w.vehicles[shooterVehicle].unitId].name} @${Math.round(d)}m)` : ''}`;
  if (t.kind === 'soldier') {
    const tgt = w.soldiers[t.id];
    const cov = w.map.coverAt(tgt.x, tgt.y, from.x, from.y);
    const stanceF = tgt.stance === 'stand' ? 1 : tgt.stance === 'crouch' ? 0.65 : 0.4;
    const moveF = tgt.moving ? (tgt.moveMode === 'run' ? 0.8 : 0.9) : 1;
    const p = baseHitChance(def, d) * mod * stanceF * moveF * (1 - cov.cover) * (1 - obstruction * 0.6);
    const hits = w.rng.binomial(rounds, clamp(p, 0, 0.95));
    for (let i = 0; i < hits; i++) {
      applyHit(w, tgt, def.lethality, def.pen, shooterSoldier, side);
      hitAny = true;
    }
    // Spray: rounds that miss can hit someone next to the target
    if (rounds > 3) {
      for (const o of w.soldiersNear(tgt.x, tgt.y, 3, (o) => o !== tgt && o.side !== side && World.active(o))) {
        const c2 = w.map.coverAt(o.x, o.y, from.x, from.y).cover;
        const k = w.rng.binomial(rounds - hits, clamp(p * 0.18 * (1 - c2), 0, 0.5));
        for (let i = 0; i < k; i++) applyHit(w, o, def.lethality, def.pen, shooterSoldier, side);
      }
    }
    suppress(w, tgt.x, tgt.y, def.suppression * rounds, def.suppRadius, side, from.x, from.y);
  } else if (t.kind === 'vehicle') {
    const v = w.vehicles[t.id];
    const p = hitChanceVehicle(def, d, mod, v);
    const hits = w.rng.binomial(rounds, p);
    for (let i = 0; i < hits; i++) {
      hitVehicle(w, v, def, from.x, from.y, shooterSoldier, shooterVehicle);
      hitAny = true;
      if (v.destroyed) break;
    }
    // exposed dismounts near the vehicle still get suppressed
    suppress(w, v.x, v.y, def.suppression * rounds * 0.4, def.suppRadius, side, from.x, from.y);
  } else {
    // area fire at a point
    const p = baseHitChance(def, d) * mod * 0.25;
    for (const o of w.soldiersNear(tp.x, tp.y, 5, (o) => o.side !== side && World.active(o))) {
      const cov = w.map.coverAt(o.x, o.y, from.x, from.y).cover;
      const k = w.rng.binomial(rounds, clamp(p * (1 - cov), 0, 0.5));
      for (let i = 0; i < k; i++) applyHit(w, o, def.lethality, def.pen, shooterSoldier, side);
    }
    suppress(w, tp.x, tp.y, def.suppression * rounds * 1.2, def.suppRadius * 1.5, side, from.x, from.y);
  }
  // Visual endpoint: hits end at target, misses scatter around/behind it
  let ex = tp.x;
  let ey = tp.y;
  let ez = tp.z;
  if (!hitAny) {
    const sc = 1 + d * 0.01;
    ex += w.rng.gauss() * sc;
    ey += w.rng.gauss() * sc;
    ez = w.map.groundAt(ex, ey) + w.rng.next() * 1.5;
  }
  w.emit({ type: 'shot', weapon: def.id, side, sx: from.x, sy: from.y, sz: from.z, tx: ex, ty: ey, tz: ez, rounds, interval: def.shotInterval, soldier: shooterSoldier, vehicle: shooterVehicle });
}

/** Suppression applied to enemy soldiers around a point. */
export function suppress(w: World, x: number, y: number, amount: number, radius: number, attacker: Side, fromX: number, fromY: number): void {
  for (const o of w.soldiersNear(x, y, radius)) {
    if (o.side === attacker || !World.active(o)) continue;
    const d = dhypot(o.x - x, o.y - y);
    const falloff = 1 - (d / radius) * 0.7;
    const cov = w.map.coverAt(o.x, o.y, fromX, fromY).cover;
    let add = amount * falloff * (1 - cov * 0.5) * (1.25 - o.exp * 0.5);
    if (o.state === 'berserk') add *= 0.15;
    o.supp = Math.min(100, o.supp + add);
    w.units[o.unitId].underFireT = w.time;
    w.units[o.unitId].ai.threatDir = datan2(fromY - o.y, fromX - o.x);
  }
}

// ------------------------------------------------------------------ damage

export function applyHit(w: World, v: Soldier, lethality: number, pen: number, shooter: number, attacker: Side): void {
  if (v.health === 'dead' || v.health === 'incap') return;
  v.hitsTaken++;
  // Hard armour plates stop many rifle rounds (not HMG/fragments at close range)
  const plate = pen < 12 ? v.bodyArmor * (pen <= 9 ? 1 : 0.5) : 0;
  let pk = lethality * (1 - plate);
  if (v.health === 'wounded') pk = Math.min(1, pk + 0.3);
  const r = w.rng.next();
  let res: Health;
  if (r < pk * 0.55) res = 'dead';
  else if (r < pk) res = 'incap';
  else res = v.health === 'wounded' ? (w.rng.chance(0.4) ? 'incap' : 'wounded') : 'wounded';
  setHealth(w, v, res, shooter, attacker);
}

export function setHealth(w: World, s: Soldier, h: Health, shooter: number, attacker: Side | null): void {
  if (s.health === h) {
    s.supp = Math.min(100, s.supp + 25);
    return;
  }
  const was = s.health;
  s.health = h;
  s.supp = Math.min(100, s.supp + 40);
  const u = w.units[s.unitId];
  w.emit({ type: 'casualty', soldier: s.id, health: h, side: s.side });
  if (h === 'wounded') {
    s.morale -= 8;
    for (const id of u.soldiers) if (id !== s.id) w.soldiers[id].morale -= 3;
    return;
  }
  // killed / incapacitated
  if (w.dbg && (h === 'dead' || h === 'incap')) {
    const sh = shooter >= 0 ? w.soldiers[shooter] : null;
    w.dbg(`${Math.round(w.time)}s ${u.name}/${s.role} ${h} <- ${w.curWeapon}${sh ? ` [${w.units[sh.unitId].name} @${Math.round(dhypot(sh.x - s.x, sh.y - s.y))}m]` : ''}`);
  }
  if (was !== 'dead' && was !== 'incap') {
    if (shooter >= 0) {
      const k = w.soldiers[shooter];
      k.kills++;
      k.morale = Math.min(100, k.morale + 3);
    }
    s.target = null;
    s.path = null;
    s.moving = false;
    s.stance = 'prone';
    u.lastCasualtyT = w.time;
    const lost = s.leader ? 22 : 11;
    for (const id of u.soldiers) {
      const o = w.soldiers[id];
      if (o === s || !World.active(o)) continue;
      o.morale -= lost * (1.2 - o.exp * 0.4);
      o.supp = Math.min(100, o.supp + 12);
    }
    if (s.leader && s.vehicle < 0) {
      s.leader = false;
      const next = w.aliveSoldiers(u)[0];
      if (next) {
        next.leader = true;
        w.msg(s.side, `${u.name}: ${s.rank} ${s.name} is down! ${next.rank} ${next.name} takes command.`, u.id, 'warn');
      }
    }
    void attacker;
  }
}

export function hitVehicle(
  w: World,
  v: VehicleState,
  def: WeaponDef | { pen: number; heat?: boolean; tandem?: boolean; topAttack?: boolean; cls: string; name: string },
  fromX: number,
  fromY: number,
  shooterSoldier: number,
  shooterVehicle: number,
): 'destroyed' | 'penetrated' | 'bounced' | 'aps' | 'slat' | 'wreck' {
  if (v.destroyed) return 'wreck';
  const gz = w.map.groundAt(v.x, v.y);
  const isMissile = def.cls === 'rocket' || def.cls === 'atgm';
  // Active protection (Trophy)
  if (isMissile && v.apsCharges > 0 && v.def.aps) {
    const p = v.def.aps.p * (def.topAttack ? 0.45 : 1);
    if (w.rng.next() < p) {
      v.apsCharges--;
      const a = datan2(fromY - v.y, fromX - v.x);
      w.emit({ type: 'explosion', x: v.x + dcos(a) * 9, y: v.y + dsin(a) * 9, z: gz + 3, size: 2, kind: 'aps' });
      w.msg(v.side, `${w.units[v.unitId].name}: Trophy intercept! (${v.apsCharges} left)`, v.unitId, 'info');
      v.shock += 10;
      return 'aps';
    }
  }
  v.lastHitT = w.time;
  v.lastThreatDir = datan2(fromY - v.y, fromX - v.x);
  const hasTurret = v.def.weapons.some((x) => x.mount === 'turret');
  const turretHit = hasTurret && w.rng.next() < 0.35;
  const facing: 'front' | 'side' | 'rear' | 'top' = def.topAttack ? 'top' : facingOf(v, fromX, fromY, turretHit ? v.turret : v.heading);
  if (v.def.slat && def.cls === 'rocket' && facing !== 'top' && w.rng.next() < 0.5) {
    w.emit({ type: 'explosion', x: v.x, y: v.y, z: gz + 1.5, size: 1.5, kind: 'at' });
    w.msg(v.side, `${w.units[v.unitId].name}: RPG defeated by slat armour!`, v.unitId, 'info');
    v.shock += 20;
    return 'slat';
  }
  let armor = v.def.armor[facing];
  if (def.heat && (facing === 'front' || facing === 'side')) armor *= v.def.compositeHEAT;
  let pen = def.pen * w.rng.range(0.85, 1.15);
  if (v.def.era && facing !== 'rear') {
    if (facing === 'top') pen *= 0.95;
    else if (def.heat) pen *= def.tandem ? 0.8 : 0.4;
    else if (def.pen > 200) pen *= 0.85;
  }
  if (!def.heat && def.cls !== 'tankgun' && def.cls !== 'autocannon') {
    // bullets
  } else if (!def.heat) {
    const d = dhypot(fromX - v.x, fromY - v.y);
    pen *= 1 - d / 12000;
  }
  const u = w.units[v.unitId];
  if (pen <= armor) {
    v.shock = Math.min(100, v.shock + (def.pen > 100 ? 30 : 4));
    for (const id of v.crew) w.soldiers[id].supp = Math.min(100, w.soldiers[id].supp + (def.pen > 100 ? 25 : 3));
    if (def.pen > 100) {
      w.emit({ type: 'impact', x: v.x, y: v.y, z: gz + v.def.height * 0.6, kind: 'bounce' });
      if (pen > armor * 0.75 && w.rng.next() < 0.2) {
        if (w.rng.next() < 0.5) v.gunDamaged = true;
        else v.immobilized = true;
      }
    } else if (w.rng.next() < 0.1) w.emit({ type: 'impact', x: v.x, y: v.y, z: gz + v.def.height * 0.6, kind: 'ricochet' });
    return 'bounced';
  }
  // Penetration
  const over = pen / armor;
  const big = def.pen > 250;
  let pKill = 0.2 + 0.3 * (over - 1) + (big ? 0.25 : 0);
  if (v.def.armor.side < 50) pKill += 0.2;
  pKill = clamp(pKill, 0.12, 0.9);
  w.emit({ type: 'impact', x: v.x, y: v.y, z: gz + v.def.height * 0.6, kind: 'penetrate' });
  if (w.rng.next() < pKill) {
    destroyVehicle(w, v, w.rng.next() < (big ? 0.7 : 0.45), shooterSoldier, shooterVehicle, def.name);
    return 'destroyed';
  }
  v.shock = Math.min(100, v.shock + 60);
  const r = w.rng.next();
  if (r < 0.3) v.immobilized = true;
  else if (r < 0.55) v.gunDamaged = true;
  // crew casualties
  const crew = v.crew.map((id) => w.soldiers[id]).filter((s) => World.active(s));
  if (crew.length && (r >= 0.55 || w.rng.next() < 0.5)) {
    const victim = crew[w.rng.int(0, crew.length - 1)];
    setHealth(w, victim, w.rng.chance(0.6) ? 'dead' : 'incap', shooterSoldier, otherSide(v.side));
  }
  for (const pid of v.passengers) {
    for (const sid of w.units[pid].soldiers) {
      const ps = w.soldiers[sid];
      if (!World.active(ps)) continue;
      if (w.rng.next() < 0.15) applyHit(w, ps, 0.6, 30, shooterSoldier, otherSide(v.side));
      ps.supp = Math.min(100, ps.supp + 40);
    }
  }
  const what = v.immobilized ? 'immobilised' : v.gunDamaged ? 'main armament damaged' : 'crew casualties';
  w.msg(v.side, `${u.name}: Hit — ${what}!`, u.id, 'warn');
  if (v.immobilized && v.passengers.length) {
    // get the infantry out of a sitting duck
    for (const pid of [...v.passengers]) {
      dismountNow(w, w.units[pid]);
    }
  }
  return 'penetrated';
}

export function dismountNow(w: World, u: Unit): void {
  // local copy of orders.dismount without the circular import at module init
  const v = w.vehicles[u.mountedIn];
  if (!v) return;
  v.passengers = v.passengers.filter((id) => id !== u.id);
  u.mountedIn = -1;
  const back = v.heading + Math.PI;
  u.soldiers.forEach((sid, i) => {
    const s = w.soldiers[sid];
    s.vehicle = -1;
    const a = back + (i - u.soldiers.length / 2) * 0.4;
    s.x = s.px = v.x + dcos(a) * (v.def.length / 2 + 2);
    s.y = s.py = v.y + dsin(a) * (v.def.length / 2 + 2);
    s.stance = 'prone';
    s.supp = Math.min(100, s.supp + 50);
  });
  u.order = { kind: 'none', issuedAt: w.time };
  u.holdPos = { x: v.x, y: v.y };
}

export function destroyVehicle(w: World, v: VehicleState, burning: boolean, shooterSoldier: number, shooterVehicle: number, weaponName: string): void {
  if (v.destroyed) return;
  v.destroyed = true;
  v.speed = 0;
  v.path = null;
  v.burning = burning ? 70 + w.rng.next() * 80 : 0;
  const u = w.units[v.unitId];
  const gz = w.map.groundAt(v.x, v.y);
  w.emit({ type: 'explosion', x: v.x, y: v.y, z: gz + 1.5, size: burning ? 7 : 4, kind: 'vehicle' });
  w.emit({ type: 'vehicleKilled', vehicle: v.id, side: v.side, burning });
  w.msg(v.side, `${u.name} (${v.def.name}) has been knocked out!`, u.id, 'alert');
  w.msg(otherSide(v.side), `Enemy ${v.def.name} destroyed${weaponName ? ` (${weaponName})` : ''}!`, -1, 'good');
  if (shooterSoldier >= 0) w.soldiers[shooterSoldier].kills++;
  else if (shooterVehicle >= 0) {
    const sv = w.vehicles[shooterVehicle];
    const g = sv.crew.map((id) => w.soldiers[id]).find((s) => World.active(s));
    if (g) g.kills++;
  }
  // crew fate
  const survivors: Soldier[] = [];
  for (const id of v.crew) {
    const s = w.soldiers[id];
    if (!World.active(s)) continue;
    const r = w.rng.next();
    const kill = burning ? 0.55 : 0.35;
    if (r < kill) setHealth(w, s, 'dead', shooterSoldier, otherSide(v.side));
    else if (r < kill + 0.2) setHealth(w, s, 'incap', shooterSoldier, otherSide(v.side));
    else survivors.push(s);
  }
  // passengers bail out
  for (const pid of [...v.passengers]) {
    const pu = w.units[pid];
    for (const sid of pu.soldiers) {
      const s = w.soldiers[sid];
      if (!World.active(s)) continue;
      const r = w.rng.next();
      if (r < (burning ? 0.4 : 0.25)) setHealth(w, s, 'dead', shooterSoldier, otherSide(v.side));
      else if (r < 0.55) setHealth(w, s, 'wounded', shooterSoldier, otherSide(v.side));
    }
    dismountNow(w, pu);
    for (const sid of pu.soldiers) w.soldiers[sid].supp = 95;
  }
  v.passengers = [];
  if (survivors.length) w.createCrewUnit(v, survivors);
  // morale shock to nearby friendlies, boost to enemies nearby
  for (const s of w.soldiersNear(v.x, v.y, 150)) {
    if (!World.active(s)) continue;
    if (s.side === v.side) s.morale -= 8;
    else s.morale = Math.min(100, s.morale + 4);
  }
}

// ------------------------------------------------------------------ explosions

export function explode(w: World, x: number, y: number, p: BlastParams, attacker: Side, shooter: number, kind: ExplosionKind): void {
  const gz = w.map.groundAt(x, y);
  w.emit({ type: 'explosion', x, y, z: gz, size: p.blast, kind });
  const bid = w.map.buildingAt(x, y);
  for (const s of w.soldiersNear(x, y, p.blast * 2.5)) {
    if (!World.active(s) && s.health !== 'incap') continue;
    const d = dhypot(s.x - x, s.y - y);
    let cov = w.map.coverAt(s.x, s.y, x, y).coverHE;
    const sb = w.map.buildingAt(s.x, s.y);
    if (sb >= 0 && sb !== bid) cov = Math.max(cov, 0.7);
    const stanceF = s.stance === 'prone' ? 0.5 : s.stance === 'crouch' ? 0.8 : 1;
    let pk: number;
    if (d < p.blast) pk = p.lethality * (1 - (0.5 * d) / p.blast) * (1 - cov) * stanceF;
    else pk = p.lethality * 0.3 * (1 - (d - p.blast) / (1.5 * p.blast)) * (1 - cov) * stanceF;
    const r = w.rng.next();
    if (r < pk) applyHit(w, s, 0.85, 30, shooter, attacker);
    else if (r < pk * 1.8 && s.health === 'ok') setHealth(w, s, 'wounded', shooter, attacker);
  }
  suppress(w, x, y, p.suppression, p.suppRadius, attacker, x, y + 0.01);
  for (const v of w.vehicles) {
    if (v.destroyed) continue;
    const d = dhypot(v.x - x, v.y - y);
    if (d > p.blast + 3) continue;
    v.shock = Math.min(100, v.shock + p.suppression * 0.4);
    if (p.pen > 0 && d < 3.5) {
      hitVehicle(w, v, { pen: p.pen, cls: 'he', name: '', topAttack: true }, x, y, shooter, -1);
    } else if (p.pen > 0 && v.def.armor.top < 15 && w.rng.next() < 0.3) {
      hitVehicle(w, v, { pen: p.pen * 0.4, cls: 'he', name: '', topAttack: true }, x, y, shooter, -1);
    }
  }
  // Buildings take structural damage from big HE nearby
  if (p.blast >= 4) {
    const touched = new Set<number>();
    const [cx, cy] = w.map.cellOf(x, y);
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (!w.map.inBounds(cx + dx, cy + dy)) continue;
        const b = w.map.bld[(cy + dy) * w.map.w + cx + dx];
        if (b >= 0) touched.add(b);
      }
    }
    for (const b of touched) damageBuilding(w, b, p.blast * p.blast * 5, shooter, attacker);
  }
  if (p.blast >= 7 && w.rng.next() < 0.6) w.map.setCrater(x, y);
}

function damageBuilding(w: World, id: number, dmg: number, shooter: number, attacker: Side): void {
  const b = w.map.buildings[id];
  if (!b || b.destroyed) return;
  b.hp -= dmg;
  if (b.hp > 0) return;
  w.map.destroyBuilding(id);
  w.emit({ type: 'building', id });
  w.emit({ type: 'explosion', x: (b.cx + b.cw / 2) * 4, y: (b.cy + b.ch / 2) * 4, z: w.map.groundAt((b.cx + b.cw / 2) * 4, (b.cy + b.ch / 2) * 4), size: 8, kind: 'he' });
  for (const s of w.soldiers) {
    if (!World.active(s) || s.vehicle >= 0) continue;
    const [cx, cy] = w.map.cellOf(s.x, s.y);
    if (cx >= b.cx && cx < b.cx + b.cw && cy >= b.cy && cy < b.cy + b.ch) {
      const r = w.rng.next();
      if (r < 0.2) setHealth(w, s, 'dead', shooter, attacker);
      else if (r < 0.45) setHealth(w, s, 'incap', shooter, attacker);
      else if (r < 0.7) setHealth(w, s, 'wounded', shooter, attacker);
      s.supp = 100;
    }
  }
}

// ------------------------------------------------------------------ projectiles

export function launch(
  w: World,
  def: WeaponDef,
  side: Side,
  shooterSoldier: number,
  shooterVehicle: number,
  from: { x: number; y: number; z: number },
  t: TargetRef,
  mod: number,
  rounds: number,
): void {
  const tp0 = targetPoint(w, t);
  const d = dhypot(tp0.x - from.x, tp0.y - from.y);
  const kind: Projectile['kind'] = def.indirect ? 'indirect' : def.cls === 'grenade' ? 'thrown' : 'direct';
  for (let i = 0; i < rounds; i++) {
    let tx = tp0.x;
    let ty = tp0.y;
    let willHit = false;
    let target: TargetRef | null = t;
    if (t.kind === 'vehicle') {
      const v = w.vehicles[t.id];
      willHit = w.rng.next() < hitChanceVehicle(def, d, mod, v);
      if (!willHit) {
        const a = w.rng.next() * Math.PI * 2;
        const m = 3 + w.rng.next() * 8;
        tx += dcos(a) * m;
        ty += dsin(a) * m;
        target = null;
      }
    } else if (def.blast) {
      // HE: scatter the aim point
      const sd = kind === 'indirect' ? 10 + d * 0.012 : kind === 'thrown' ? 2 : 0.8 + (d * 0.02 * (1.2 - def.accuracy)) / Math.max(0.3, mod);
      tx += w.rng.gauss() * sd;
      ty += w.rng.gauss() * sd;
      target = null;
    } else {
      willHit = false;
      target = null;
    }
    const T_ = kind === 'indirect' ? 8 + d / 140 : d / (def.speed ?? 300);
    let arc = 0;
    if (kind === 'indirect' || def.cls === 'gl' || def.cls === 'agl') arc = (9.81 * T_ * T_) / 8;
    else if (kind === 'thrown') arc = 2 + d * 0.12;
    else if (def.topAttack && def.guidance === 'fnf') arc = Math.min(160, 40 + d * 0.06);
    else if (def.cls === 'rocket' || def.cls === 'atgm') arc = 0.5 + d * 0.004;
    const tz = t.kind === 'vehicle' && willHit ? tp0.z : w.map.groundAt(tx, ty) + (t.kind === 'soldier' ? 0.3 : 0);
    w.projectiles.push({
      id: w.newProjectileId(),
      weapon: def,
      side,
      shooterSoldier,
      shooterVehicle,
      sx: from.x,
      sy: from.y,
      sz: from.z,
      tx,
      ty,
      tz,
      x: from.x,
      y: from.y,
      z: from.z,
      px: from.x,
      py: from.y,
      pz: from.z,
      t: -i * def.shotInterval,
      T: Math.max(0.05, T_),
      arc,
      target,
      willHit,
      kind,
      atVehicle: t.kind === 'vehicle',
      dead: false,
    });
  }
  w.emit({ type: 'launch', weapon: def.id, side, x: from.x, y: from.y, z: from.z, soldier: shooterSoldier, vehicle: shooterVehicle });
  if (def.cls !== 'autocannon' && def.cls !== 'tankgun' && def.cls !== 'agl')
    w.emit({ type: 'shot', weapon: def.id, side, sx: from.x, sy: from.y, sz: from.z, tx: tp0.x, ty: tp0.y, tz: tp0.z, rounds: 0, interval: 0, soldier: shooterSoldier, vehicle: shooterVehicle });
  else
    w.emit({ type: 'shot', weapon: def.id, side, sx: from.x, sy: from.y, sz: from.z, tx: tp0.x, ty: tp0.y, tz: tp0.z, rounds, interval: def.shotInterval, soldier: shooterSoldier, vehicle: shooterVehicle });
  // Laser-warning: modern vehicles pop smoke against beam-riding / SACLOS missiles
  if (t.kind === 'vehicle' && def.guidance === 'saclos') {
    const v = w.vehicles[t.id];
    if (v.def.thermal && v.smokeSalvos > 0 && w.rng.next() < 0.45) {
      v.smokeSalvos--;
      const a = datan2(from.y - v.y, from.x - v.x);
      for (let k = -1; k <= 1; k++) spawnSmoke(w, v.x + dcos(a + k * 0.4) * 22, v.y + dsin(a + k * 0.4) * 22, 12, 0.08, 45);
      w.msg(v.side, `${w.units[v.unitId].name}: Missile launch detected — smoke!`, v.unitId, 'warn');
    }
  }
}

export function updateProjectiles(w: World): void {
  for (const p of w.projectiles) {
    if (p.dead) continue;
    p.t += DT;
    if (p.t < 0) continue;
    // guided / tracking toward the live target
    if (p.target && p.willHit) {
      if (p.target.kind === 'vehicle') {
        const v = w.vehicles[p.target.id];
        p.tx = v.x;
        p.ty = v.y;
        p.tz = w.map.groundAt(v.x, v.y) + v.def.height * 0.55;
      }
    }
    const f = Math.min(1, p.t / p.T);
    p.x = p.sx + (p.tx - p.sx) * f;
    p.y = p.sy + (p.ty - p.sy) * f;
    p.z = p.sz + (p.tz - p.sz) * f + p.arc * 4 * f * (1 - f);
    if (f >= 1) {
      p.dead = true;
      impact(w, p);
    }
  }
  if (w.projectiles.some((p) => p.dead)) w.projectiles = w.projectiles.filter((p) => !p.dead);
}

function impact(w: World, p: Projectile): void {
  const def = p.weapon;
  if (w.dbg) w.curWeapon = `${p.heavy ? 'ARTILLERY' : def.name}${p.shooterVehicle >= 0 ? ` (${w.units[w.vehicles[p.shooterVehicle].unitId].name} @${Math.round(dhypot(p.tx - p.sx, p.ty - p.sy))}m)` : ''}`;
  if (p.smoke) {
    spawnSmoke(w, p.tx, p.ty, 13, 0.08, 60);
    return;
  }
  let willHit = p.willHit;
  if (willHit && def.guidance === 'saclos' && p.target) {
    // operator must survive and keep the target in sight
    let ok = true;
    let ox = p.sx;
    let oy = p.sy;
    let eye = 1.1;
    if (p.shooterSoldier >= 0) {
      const s = w.soldiers[p.shooterSoldier];
      ok = World.active(s) && s.state !== 'cowering' && s.state !== 'panicked';
      ox = s.x;
      oy = s.y;
    } else if (p.shooterVehicle >= 0) {
      const v = w.vehicles[p.shooterVehicle];
      ok = !v.destroyed && !v.abandoned;
      ox = v.x;
      oy = v.y;
      eye = v.def.eye;
    }
    if (ok) {
      const tp = targetPoint(w, p.target);
      ok = w.map.los(ox, oy, eye, tp.x, tp.y, tp.z - w.map.groundAt(tp.x, tp.y), 0.35).clear;
    }
    if (!ok) {
      willHit = false;
      p.tx += w.rng.gauss() * 12;
      p.ty += w.rng.gauss() * 12;
    }
  }
  if (willHit && p.target?.kind === 'vehicle') {
    const v = w.vehicles[p.target.id];
    const res = hitVehicle(w, v, def, p.sx, p.sy, p.shooterSoldier, p.shooterVehicle);
    if (res !== 'aps') {
      w.emit({ type: 'explosion', x: v.x, y: v.y, z: w.map.groundAt(v.x, v.y) + v.def.height * 0.6, size: def.heat ? 3 : 1.5, kind: 'at' });
      if (def.blast && def.heat) explode(w, v.x, v.y, { blast: def.blast * 0.6, lethality: def.lethality * 0.6, pen: 0, suppression: def.suppression * 0.5, suppRadius: def.suppRadius }, p.side, p.shooterSoldier, 'small');
    }
    return;
  }
  const heavy = p.heavy;
  if (heavy) {
    explode(w, p.tx, p.ty, heavy, p.side, p.shooterSoldier, 'artillery');
    return;
  }
  // AP rounds fired at a vehicle that miss just plough into the ground
  const apMiss = p.atVehicle && !def.heat && (def.cls === 'tankgun' || def.cls === 'autocannon');
  if (def.blast && !apMiss) {
    const kind: ExplosionKind = def.indirect ? 'mortar' : def.cls === 'grenade' ? 'grenade' : def.cls === 'tankgun' ? 'he' : def.blast > 3 ? 'he' : 'small';
    explode(w, p.tx, p.ty, { blast: def.blast, lethality: def.lethality, pen: def.cls === 'tankgun' ? 40 : def.pen * 0.3, suppression: def.suppression, suppRadius: def.suppRadius }, p.side, p.shooterSoldier, kind);
  } else {
    w.emit({ type: 'impact', x: p.tx, y: p.ty, z: w.map.groundAt(p.tx, p.ty), kind: 'dirt' });
  }
}

// ------------------------------------------------------------------ vehicles

function vehicleCombat(w: World, v: VehicleState): void {
  if (v.destroyed || v.abandoned) return;
  for (const ws of v.weapons) tickWeapon(ws);
  v.shock = Math.max(0, v.shock - 8 * DT);
  const u = w.units[v.unitId];
  const crew = v.crew.map((id) => w.soldiers[id]);
  if (!crew.some((s) => World.active(s))) {
    v.abandoned = true;
    v.speed = 0;
    v.path = null;
    for (const pid of [...v.passengers]) dismountNow(w, w.units[pid]);
    w.msg(v.side, `${u.name}: vehicle crew out of action.`, u.id, 'alert');
    return;
  }
  const pol = policy(w, u);
  const mod = vehicleShooterMod(w, v);
  const retarget = (w.tick + v.id * 3) % 12 === 0;
  const eyeZ = v.def.eye;
  // choose targets
  if (retarget) {
    const cands: { ref: TargetRef; x: number; y: number; h: number; unit: Unit; d: number }[] = [];
    if (pol.forcedPoint) {
      cands.push({ ref: { kind: 'point', x: pol.forcedPoint.x, y: pol.forcedPoint.y }, x: pol.forcedPoint.x, y: pol.forcedPoint.y, h: 0.5, unit: u, d: dhypot(pol.forcedPoint.x - v.x, pol.forcedPoint.y - v.y) });
    } else {
      for (const info of w.spotted[v.side].values()) {
        if (!info.visible) continue;
        if (pol.forcedUnit >= 0 && info.unitId !== pol.forcedUnit) continue;
        const eu = w.units[info.unitId];
        if (eu.eliminated || eu.mountedIn >= 0) continue;
        const d0 = dhypot(info.x - v.x, info.y - v.y);
        if (d0 > (eu.vehicle >= 0 ? pol.maxRangeArmor : pol.maxRange) + 30 || d0 > 3800) continue;
        if (eu.vehicle >= 0) {
          const ev = w.vehicles[eu.vehicle];
          if (ev.destroyed || ev.abandoned) continue;
          const los = w.map.los(v.x, v.y, eyeZ, ev.x, ev.y, ev.def.height * 0.6, v.def.thermal ? 0.35 : 1);
          if (los.clear) cands.push({ ref: { kind: 'vehicle', id: ev.id }, x: ev.x, y: ev.y, h: ev.def.height * 0.55, unit: eu, d: d0 });
        } else {
          let best: Soldier | null = null;
          let bd = Infinity;
          for (const sid of eu.soldiers) {
            const o = w.soldiers[sid];
            if (!World.active(o) || o.vehicle >= 0) continue;
            const d = dhypot(o.x - v.x, o.y - v.y);
            if (d < bd) {
              bd = d;
              best = o;
            }
          }
          if (!best) continue;
          const los = w.map.los(v.x, v.y, eyeZ, best.x, best.y, TGT_H[best.stance], v.def.thermal ? 0.35 : 1);
          if (los.clear) cands.push({ ref: { kind: 'soldier', id: best.id }, x: best.x, y: best.y, h: TGT_H[best.stance], unit: eu, d: bd });
        }
      }
    }
    v.weapons.forEach((ws, wi) => {
      v.tgts[wi] = null;
      if (ws.disabled || ws.ammo <= 0) return;
      if (v.gunDamaged && ws.mount === 'turret') return;
      const def = ws.def;
      if (def.guidance && Math.abs(v.speed) > 0.5) return;
      let bestScore = 0;
      let bestRef: TargetRef | null = null;
      for (const c of cands) {
        if (c.d > def.range || c.d < (def.minRange ?? 0)) continue;
        let score = 0;
        if (c.ref.kind === 'vehicle') {
          const ev = w.vehicles[c.ref.id];
          if (!def.antiArmor && def.pen < ev.def.armor.side) continue;
          const pk = estimateKill(def, ev, v.x, v.y);
          if (pk <= 0) continue;
          score = hitChanceVehicle(def, c.d, mod, ev) * pk * 100 * vehicleThreat(ev);
          if (def.guidance && pk < 0.5) score *= 0.3;
          // keep missiles for armour; guns handle light stuff
          if (def.cls === 'atgm' && ev.def.armor.front < 100) score *= 0.35;
        } else if (c.ref.kind === 'soldier') {
          if (!def.antiPersonnel) continue;
          const at = c.unit.template.symbol === 'at' || c.unit.soldiers.some((sid) => w.soldiers[sid].weapons.some((x) => x.def.antiArmor && x.ammo > 0));
          const rounds = (def.burst[0] + def.burst[1]) / 2;
          if (def.blast) score = Math.min(1, baseHitChance(def, c.d) * 2) * def.lethality * (def.blast / 5) * 30;
          else score = baseHitChance(def, c.d) * rounds * def.lethality * 60 * mod;
          if (at) score *= 2;
          if (def.cls === 'tankgun') score *= 0.6;
          if (def.cls === 'atgm') score *= 0.1;
        } else {
          if (!def.antiPersonnel || def.cls === 'atgm') continue;
          score = def.suppression;
        }
        if (v.lastKeys[wi] === targetKey(c.ref)) score *= 1.3;
        if (score > bestScore) {
          bestScore = score;
          bestRef = c.ref;
        }
      }
      v.tgts[wi] = bestRef;
    });
  }
  // Turret: follow the most important turret weapon target
  let turretTarget: TargetRef | null = null;
  let turretPriority = -1;
  v.weapons.forEach((ws, wi) => {
    const t = v.tgts[wi];
    if (!t || ws.mount !== 'turret') return;
    const pr = t.kind === 'vehicle' ? 3 : ws.def.cls === 'tankgun' || ws.def.cls === 'autocannon' ? 2 : 1;
    if (pr > turretPriority) {
      turretPriority = pr;
      turretTarget = t;
    }
  });
  if (turretTarget) {
    const tp = targetPoint(w, turretTarget);
    slewTurret(v, datan2(tp.y - v.y, tp.x - v.x));
  } else if (w.time - v.lastHitT < 10 && v.lastThreatDir !== null) {
    slewTurret(v, v.lastThreatDir);
  } else if (Math.abs(v.speed) > 1) {
    slewTurret(v, v.heading);
  } else if (u.order.kind === 'defend' || u.order.kind === 'ambush') {
    slewTurret(v, u.facing);
  }
  // Fire
  for (let wi = 0; wi < v.weapons.length; wi++) {
    const ws = v.weapons[wi];
    const t = v.tgts[wi];
    if (!t || ws.ammo <= 0) continue;
    if (t.kind === 'vehicle' && (w.vehicles[t.id].destroyed || w.vehicles[t.id].abandoned)) {
      v.tgts[wi] = null;
      continue;
    }
    if (t.kind === 'soldier' && !World.active(w.soldiers[t.id])) {
      v.tgts[wi] = null;
      continue;
    }
    const tp = targetPoint(w, t);
    const ang = datan2(tp.y - v.y, tp.x - v.x);
    if (ws.mount === 'turret') {
      if (turretTarget && targetKey(turretTarget) !== targetKey(t)) {
        // coax can engage something else only if it's roughly in line
        if (Math.abs(wrapAngle(ang - v.turret)) > 0.12) continue;
      }
      if (Math.abs(wrapAngle(ang - v.turret)) > 0.05) continue;
    }
    const key = targetKey(t);
    if (ws.aimKey !== key) {
      ws.aimKey = key;
      ws.aimT = ws.def.aimTime * (1.2 - mod * 0.4);
      v.lastKeys[wi] = key;
    }
    if (ws.aimT > 0) {
      ws.aimT -= DT;
      continue;
    }
    if (ws.cooldown > 0 || ws.reloadT > 0) continue;
    if (ws.loaded <= 0) {
      if (ws.ammo > 0) ws.reloadT = ws.def.reload || 1;
      continue;
    }
    if (ws.def.guidance && Math.abs(v.speed) > 0.5) continue;
    const def = ws.def;
    const rounds = Math.min(ws.loaded, w.rng.int(def.burst[0], def.burst[1]));
    ws.loaded -= rounds;
    ws.ammo -= rounds;
    ws.cooldown = def.cycle * (0.9 + w.rng.next() * 0.3) * (1 + v.shock / 150);
    v.firedT = w.time;
    if (u.order.kind === 'ambush') u.ai.sprungT = w.time;
    const barrel = ws.mount === 'turret' ? v.turret : ang;
    const reach = ws.mount === 'turret' ? v.def.length * 0.55 : 0.5;
    const from = { x: v.x + dcos(barrel) * reach, y: v.y + dsin(barrel) * reach, z: w.map.groundAt(v.x, v.y) + v.def.height * 0.85 };
    if (def.speed) {
      launch(w, def, v.side, -1, v.id, from, t, mod, rounds);
    } else {
      resolveHitscan(w, def, v.side, -1, v.id, from, t, tp, rounds, mod, 0);
    }
  }
}

export { WEAPONS };
