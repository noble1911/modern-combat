import { FACTIONS, NAMES, Side, UnitTemplate, unitTemplate, VEHICLES, otherSide } from '../data/units';
import { weapon } from '../data/weapons';
import type { GeneratedMap, Rect } from './mapgen';
import { dist, Rng, Vec2 } from './math';
import { TerrainMap } from './terrain';
import type {
  BattleResult,
  Drone,
  FireMission,
  Projectile,
  SideConfig,
  SimEvent,
  Soldier,
  SpotInfo,
  Unit,
  VehicleState,
  VictoryLocation,
  WeaponState,
} from './types';
import { updateSpotting } from './spotting';
import { updateMovement } from './movement';
import { updateCombat, updateProjectiles } from './combat';
import { updateMorale } from './morale';
import { updateSupport } from './support';
import { updateVictory, computeForceMorale } from './victory';
import { updateOrders } from './orders';
import { updateAI } from './ai';

export const DT = 0.1;

export interface WorldOptions {
  seed: number;
  sides: Record<Side, SideConfig>;
  timeLimit: number;
  /** Deployment zones (defaults to the map's). */
  deploy?: Record<Side, Rect>;
}

export interface SpawnOptions {
  exp?: number;
  name?: string;
  facing?: number;
  /** Put this (infantry) unit inside the given vehicle unit. */
  mountIn?: number;
  campaignId?: string;
  /** Soldier health overrides for campaign carry-over (per soldier index). */
  soldierHealth?: ('ok' | 'wounded' | 'dead')[];
  charges?: number;
}

export class World {
  readonly gen: GeneratedMap;
  readonly map: TerrainMap;
  readonly rng: Rng;
  time = 0;
  tick = 0;
  phase: 'deploy' | 'battle' | 'ended' = 'deploy';
  timeLimit: number;
  sides: Record<Side, SideConfig>;
  deploy: Record<Side, Rect>;
  soldiers: Soldier[] = [];
  vehicles: VehicleState[] = [];
  units: Unit[] = [];
  projectiles: Projectile[] = [];
  drones: Drone[] = [];
  fireMissions: FireMission[] = [];
  events: SimEvent[] = [];
  spotted: Record<Side, Map<number, SpotInfo>> = { nato: new Map(), opfor: new Map() };
  vls: VictoryLocation[];
  forceMorale: Record<Side, number> = { nato: 100, opfor: 100 };
  initialValue: Record<Side, number> = { nato: 0, opfor: 0 };
  result: BattleResult | null = null;
  captured: Record<Side, number> = { nato: 0, opfor: 0 };
  private nextId = { proj: 1, drone: 1, mission: 1, smoke: 1 };
  private nameIdx: Record<Side, number> = { nato: 0, opfor: 0 };
  /** Units flagged by the player/AI to be ignored by auto behaviours for a moment. */
  aiState: Record<Side, any> = { nato: {}, opfor: {} };
  ceasefire = false;
  /** Debug hook (tests): receives kill attribution lines. */
  dbg: ((line: string) => void) | null = null;
  /** Weapon currently being resolved (for debug attribution). */
  curWeapon = '';
  /** Optional per-system timing accumulator (ms). */
  prof: Record<string, number> | null = null;

  constructor(gen: GeneratedMap, opts: WorldOptions) {
    this.gen = gen;
    this.map = gen.map;
    this.rng = new Rng(opts.seed);
    this.sides = opts.sides;
    this.timeLimit = opts.timeLimit;
    this.deploy = opts.deploy ?? gen.def.deploy;
    this.nameIdx.nato = this.rng.int(0, 60);
    this.nameIdx.opfor = this.rng.int(0, 60);
    this.vls = gen.def.vls.map((v) => ({
      id: v.id,
      name: v.name,
      x: v.x,
      y: v.y,
      r: v.r ?? 28,
      value: v.value,
      owner: v.owner ?? null,
      contested: false,
      holdT: 0,
      holdSide: null,
    }));
  }

  // ------------------------------------------------------------------ ids
  newProjectileId(): number {
    return this.nextId.proj++;
  }
  newDroneId(): number {
    return this.nextId.drone++;
  }
  newMissionId(): number {
    return this.nextId.mission++;
  }
  newSmokeId(): number {
    return this.nextId.smoke++;
  }

  emit(e: SimEvent): void {
    this.events.push(e);
    if (this.events.length > 4000) this.events.splice(0, 1000);
  }
  msg(side: Side | 'all', text: string, unit = -1, level: 'info' | 'warn' | 'alert' | 'good' = 'info'): void {
    this.emit({ type: 'message', side, text, unit, level });
  }

  // ------------------------------------------------------------------ spawning
  private soldierName(side: Side): string {
    const list = NAMES[side];
    const n = list[(this.nameIdx[side] * 7 + 3) % list.length];
    this.nameIdx[side]++;
    return n;
  }

  private makeWeapon(id: string, ammo: number, extra?: Partial<WeaponState>): WeaponState {
    const def = weapon(id);
    return { def, ammo, loaded: Math.min(def.mag, ammo), cooldown: 0, reloadT: 0, aimT: 0, aimKey: null, ...extra };
  }

  private makeSoldier(unit: Unit, side: Side, role: string, rank: string, leader: boolean, pos: Vec2, exp: number): Soldier {
    const base = 55 + exp * 40;
    const s: Soldier = {
      id: this.soldiers.length,
      unitId: unit.id,
      side,
      name: this.soldierName(side),
      rank,
      role,
      leader,
      x: pos.x,
      y: pos.y,
      px: pos.x,
      py: pos.y,
      facing: unit.facing,
      stance: 'crouch',
      health: 'ok',
      morale: base,
      baseMorale: base,
      supp: 0,
      fatigue: 0,
      exp: Math.min(1, Math.max(0.1, exp + this.rng.gauss() * 0.06)),
      state: 'ready',
      stateT: 0,
      bodyArmor: 0.35,
      weapons: [],
      wIdx: 0,
      target: null,
      retargetT: this.rng.next(),
      firedT: -100,
      path: null,
      pathIdx: 0,
      moveMode: 'walk',
      moveDelay: 0,
      moving: false,
      slot: null,
      vehicle: -1,
      crewSeat: -1,
      kills: 0,
      hitsTaken: 0,
      fleeT: 0,
      fled: false,
      stuckT: 0,
      tObs: 0,
    };
    this.soldiers.push(s);
    unit.soldiers.push(s.id);
    return s;
  }

  spawnUnit(templateId: string, side: Side, pos: Vec2, opts: SpawnOptions = {}): Unit {
    const tpl: UnitTemplate = unitTemplate(templateId);
    const exp = opts.exp ?? 0.55;
    const facing = opts.facing ?? (side === 'nato' ? Math.PI / 2 : -Math.PI / 2);
    const unit: Unit = {
      id: this.units.length,
      side,
      template: tpl,
      name: opts.name ?? tpl.short,
      soldiers: [],
      vehicle: -1,
      mountedIn: -1,
      order: { kind: 'none', issuedAt: 0 },
      holdPos: { ...pos },
      facing,
      charges: opts.charges ?? tpl.charges ?? 0,
      expLevel: exp,
      underFireT: -100,
      lastCasualtyT: -100,
      alive: 0,
      effective: 0,
      stateLabel: 'Ready',
      eliminated: false,
      withdrawn: false,
      campaignId: opts.campaignId,
      ai: {},
      initialSoldiers: 0,
    };
    this.units.push(unit);

    if (tpl.vehicle) {
      const def = VEHICLES[tpl.vehicle];
      const v: VehicleState = {
        id: this.vehicles.length,
        unitId: unit.id,
        side,
        def,
        x: pos.x,
        y: pos.y,
        px: pos.x,
        py: pos.y,
        heading: facing,
        pheading: facing,
        turret: facing,
        pturret: facing,
        speed: 0,
        reversing: false,
        path: null,
        pathIdx: 0,
        crew: [],
        passengers: [],
        weapons: def.weapons.map((ws) => this.makeWeapon(ws.weapon, ws.ammo, { mount: ws.mount, crewIdx: ws.crew })),
        destroyed: false,
        burning: 0,
        immobilized: false,
        gunDamaged: false,
        apsCharges: def.aps?.charges ?? 0,
        smokeSalvos: def.smokeSalvos,
        firedT: -100,
        shock: 0,
        abandoned: false,
        lastHitT: -100,
        lastThreatDir: null,
        replanT: 0,
        tgts: def.weapons.map(() => null),
        lastKeys: def.weapons.map(() => null),
      };
      this.vehicles.push(v);
      unit.vehicle = v.id;
      def.crewRoles.forEach((role, i) => {
        const s = this.makeSoldier(unit, side, role, i === 0 ? (side === 'nato' ? 'SSG' : 'Sgt.') : side === 'nato' ? 'SPC' : 'Cpl.', i === 0, pos, exp);
        s.vehicle = v.id;
        s.crewSeat = i;
        s.weapons.push(this.makeWeapon(side === 'nato' ? 'm4' : 'ak12', 90));
        v.crew.push(s.id);
      });
    } else {
      const specs = tpl.soldiers ?? [];
      specs.forEach((spec, i) => {
        const ang = facing + Math.PI + (i - specs.length / 2) * 0.35;
        const r = i === 0 ? 0 : 3 + (i % 3) * 1.5;
        const p = { x: pos.x + Math.cos(ang) * r, y: pos.y + Math.sin(ang) * r };
        const s = this.makeSoldier(unit, side, spec.role, spec.rank, !!spec.leader, p, exp);
        for (const [wid, ammo] of spec.weapons) s.weapons.push(this.makeWeapon(wid, ammo));
        const hs = opts.soldierHealth?.[i];
        if (hs === 'dead') {
          s.health = 'dead';
        } else if (hs === 'wounded') s.health = 'wounded';
      });
      // Campaign carry-over: soldiers lost in earlier battles don't take part at all.
      if (opts.soldierHealth) {
        for (const id of unit.soldiers) if (this.soldiers[id].health === 'dead') this.soldiers[id].fled = true;
        unit.soldiers = unit.soldiers.filter((id) => this.soldiers[id].health !== 'dead');
        if (!unit.soldiers.some((id) => this.soldiers[id].leader) && unit.soldiers.length) this.soldiers[unit.soldiers[0]].leader = true;
      }
      if (opts.mountIn !== undefined && opts.mountIn >= 0 && !this.embark(unit, this.units[opts.mountIn])) {
        console.warn(`${unit.name} does not fit in ${this.units[opts.mountIn].name}; deploying on foot`);
      }
    }
    unit.initialSoldiers = unit.soldiers.length;
    unit.alive = unit.soldiers.length;
    return unit;
  }

  /** Put an infantry unit inside a vehicle unit immediately. */
  embark(unit: Unit, carrier: Unit): boolean {
    if (carrier.vehicle < 0) return false;
    const v = this.vehicles[carrier.vehicle];
    const used = v.passengers.reduce((n, uid) => n + this.aliveSoldiers(this.units[uid]).length, 0);
    const need = this.aliveSoldiers(unit).length;
    if (used + need > v.def.seats || v.destroyed) return false;
    v.passengers.push(unit.id);
    unit.mountedIn = v.id;
    for (const sid of unit.soldiers) {
      const s = this.soldiers[sid];
      s.vehicle = v.id;
      s.x = s.px = v.x;
      s.y = s.py = v.y;
      s.path = null;
      s.moving = false;
      s.target = null;
    }
    unit.order = { kind: 'none', issuedAt: this.time };
    return true;
  }

  // ------------------------------------------------------------------ queries
  aliveSoldiers(u: Unit): Soldier[] {
    const out: Soldier[] = [];
    for (const id of u.soldiers) {
      const s = this.soldiers[id];
      if (s.health !== 'dead' && s.health !== 'incap' && s.state !== 'surrendered' && !s.fled) out.push(s);
    }
    return out;
  }

  leaderOf(u: Unit): Soldier | null {
    let best: Soldier | null = null;
    for (const id of u.soldiers) {
      const s = this.soldiers[id];
      if (s.health === 'dead' || s.health === 'incap' || s.state === 'surrendered' || s.fled) continue;
      if (s.leader) return s;
      if (!best) best = s;
    }
    return best;
  }

  unitPos(u: Unit): Vec2 {
    if (u.vehicle >= 0) {
      const v = this.vehicles[u.vehicle];
      return { x: v.x, y: v.y };
    }
    if (u.mountedIn >= 0) {
      const v = this.vehicles[u.mountedIn];
      return { x: v.x, y: v.y };
    }
    const alive = this.aliveSoldiers(u);
    if (!alive.length) {
      const s = this.soldiers[u.soldiers[0]];
      return s ? { x: s.x, y: s.y } : { x: 0, y: 0 };
    }
    let x = 0;
    let y = 0;
    for (const s of alive) {
      x += s.x;
      y += s.y;
    }
    return { x: x / alive.length, y: y / alive.length };
  }

  isVisibleTo(side: Side, unitId: number): boolean {
    const u = this.units[unitId];
    if (u.side === side) return true;
    return !!this.spotted[side].get(unitId)?.visible;
  }

  enemyUnits(side: Side): Unit[] {
    return this.units.filter((u) => u.side !== side && !u.eliminated && !u.withdrawn);
  }

  friendlyUnits(side: Side): Unit[] {
    return this.units.filter((u) => u.side === side && !u.eliminated && !u.withdrawn);
  }

  /** Is this soldier able to act (not dead/incapacitated/surrendered)? */
  static active(s: Soldier): boolean {
    return s.health !== 'dead' && s.health !== 'incap' && s.state !== 'surrendered' && !s.fled;
  }

  soldiersNear(x: number, y: number, r: number, filter?: (s: Soldier) => boolean): Soldier[] {
    const r2 = r * r;
    const out: Soldier[] = [];
    for (const s of this.soldiers) {
      if (s.health === 'dead' || s.vehicle >= 0 || s.fled) continue;
      const dx = s.x - x;
      const dy = s.y - y;
      if (dx * dx + dy * dy <= r2 && (!filter || filter(s))) out.push(s);
    }
    return out;
  }

  unitValue(u: Unit): number {
    if (u.vehicle >= 0) {
      const v = this.vehicles[u.vehicle];
      return v.destroyed || v.abandoned ? 0 : u.template.cost;
    }
    if (!u.initialSoldiers) return 0;
    const alive = this.aliveSoldiers(u).length;
    return (u.template.cost * alive) / Math.max(1, u.template.soldiers?.length ?? u.initialSoldiers);
  }

  // ------------------------------------------------------------------ battle flow
  startBattle(): void {
    this.phase = 'battle';
    for (const side of ['nato', 'opfor'] as Side[]) {
      this.initialValue[side] = this.units.filter((u) => u.side === side && !u.isCrew).reduce((n, u) => n + this.unitValue(u), 0);
    }
    this.msg('all', 'Battle has begun.', -1, 'alert');
  }

  step(): void {
    if (this.phase !== 'battle') return;
    this.time += DT;
    this.tick++;
    for (const s of this.soldiers) {
      s.px = s.x;
      s.py = s.y;
    }
    for (const v of this.vehicles) {
      v.px = v.x;
      v.py = v.y;
      v.pheading = v.heading;
      v.pturret = v.turret;
    }
    for (const p of this.projectiles) {
      p.px = p.x;
      p.py = p.y;
      p.pz = p.z;
    }
    for (const d of this.drones) {
      d.px = d.x;
      d.py = d.y;
      d.pz = d.z;
    }
    const prof = this.prof;
    if (prof) {
      const t = (k: string, f: () => void) => {
        const a = performance.now();
        f();
        prof[k] = (prof[k] ?? 0) + performance.now() - a;
      };
      t('spotting', () => updateSpotting(this));
      t('ai', () => updateAI(this));
      t('orders', () => updateOrders(this));
      t('movement', () => updateMovement(this));
      t('combat', () => updateCombat(this));
      t('projectiles', () => updateProjectiles(this));
      t('support', () => updateSupport(this));
      t('morale', () => updateMorale(this));
    } else {
      updateSpotting(this);
      updateAI(this);
      updateOrders(this);
      updateMovement(this);
      updateCombat(this);
      updateProjectiles(this);
      updateSupport(this);
      updateMorale(this);
    }
    if (this.tick % 10 === 0) {
      updateVictory(this);
      computeForceMorale(this);
      this.checkEnd();
    }
  }

  checkEnd(): void {
    if (this.phase !== 'battle') return;
    for (const side of ['nato', 'opfor'] as Side[]) {
      const alive = this.friendlyUnits(side).some((u) => u.alive > 0);
      if (!alive) return this.endBattle(otherSide(side), `${FACTIONS[side].short} forces have been wiped out.`);
      if (this.forceMorale[side] <= 25) return this.endBattle(otherSide(side), `${FACTIONS[side].short} forces have lost the will to fight.`);
    }
    if (this.time >= this.timeLimit) this.endBattle(null, 'Time expired.');
  }

  endBattle(winnerHint: Side | null, reason: string): void {
    if (this.phase === 'ended') return;
    this.phase = 'ended';
    const vlPoints: Record<Side, number> = { nato: 0, opfor: 0 };
    for (const vl of this.vls) if (vl.owner) vlPoints[vl.owner] += vl.value;
    const cas = (side: Side) => {
      let killed = 0;
      let wounded = 0;
      let captured = 0;
      let vehiclesLost = 0;
      for (const u of this.units) {
        if (u.side !== side) continue;
        if (u.vehicle >= 0) {
          const v = this.vehicles[u.vehicle];
          if (v.destroyed || v.abandoned) vehiclesLost++;
          continue;
        }
        for (const id of u.soldiers) {
          const s = this.soldiers[id];
          if (s.health === 'dead') killed++;
          else if (s.health === 'incap' || s.health === 'wounded') wounded++;
          if (s.state === 'surrendered') captured++;
        }
      }
      return { killed, wounded, captured, vehiclesLost };
    };
    let winner: Side | null = winnerHint;
    const total = this.vls.reduce((n, v) => n + v.value, 0) || 1;
    if (!winner) {
      if (vlPoints.nato > vlPoints.opfor) winner = 'nato';
      else if (vlPoints.opfor > vlPoints.nato) winner = 'opfor';
    }
    let grade: BattleResult['grade'] = 'draw';
    if (winner) {
      const share = vlPoints[winner] / total;
      grade = share >= 0.75 || winnerHint ? 'decisive' : 'victory';
    }
    this.result = {
      winner,
      grade: winner ? grade : 'draw',
      reason,
      vlPoints,
      casualties: { nato: cas('nato'), opfor: cas('opfor') },
      duration: this.time,
    };
    this.msg('all', `Battle over: ${reason}`, -1, 'alert');
  }

  distTo(a: Vec2, b: Vec2): number {
    return dist(a, b);
  }

  /** Surviving crew of a knocked-out/abandoned vehicle become a small infantry unit. */
  createCrewUnit(v: VehicleState, crew: Soldier[]): Unit | null {
    if (!crew.length) return null;
    const owner = this.units[v.unitId];
    const tpl = unitTemplate(v.side === 'nato' ? 'us_crew' : 'ru_crew');
    const unit: Unit = {
      id: this.units.length,
      side: v.side,
      template: tpl,
      name: `${owner.name} crew`,
      soldiers: [],
      vehicle: -1,
      mountedIn: -1,
      order: { kind: 'none', issuedAt: this.time },
      holdPos: { x: v.x, y: v.y },
      facing: v.heading,
      charges: 0,
      expLevel: owner.expLevel,
      underFireT: this.time,
      lastCasualtyT: this.time,
      alive: crew.length,
      effective: crew.length,
      stateLabel: 'Bailed out',
      eliminated: false,
      withdrawn: false,
      ai: {},
      isCrew: true,
      initialSoldiers: crew.length,
    };
    this.units.push(unit);
    crew.forEach((s, i) => {
      const a = v.heading + Math.PI + (i - crew.length / 2) * 0.7;
      s.unitId = unit.id;
      s.vehicle = -1;
      s.crewSeat = -1;
      s.leader = i === 0;
      s.x = s.px = v.x + Math.cos(a) * (v.def.length / 2 + 2);
      s.y = s.py = v.y + Math.sin(a) * (v.def.length / 2 + 2);
      s.stance = 'prone';
      s.supp = Math.max(s.supp, 70);
      s.morale = Math.min(s.morale, 35);
      unit.soldiers.push(s.id);
    });
    // make sure the vehicle (and its unit) no longer list them
    v.crew = v.crew.filter((id) => !crew.some((c) => c.id === id));
    owner.soldiers = owner.soldiers.filter((id) => !crew.some((c) => c.id === id));
    return unit;
  }
}
