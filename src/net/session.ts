import { FACTIONS, otherSide, Side } from '../data/units';
import { placeUnit } from '../sim/ai';
import type { Vec2 } from '../sim/math';
import { issueOrder } from '../sim/orders';
import { nearestPassable } from '../sim/pathfinding';
import type { Order, OrderKind } from '../sim/types';
import type { World } from '../sim/world';
import type { Command, Mode } from './protocol';

export interface NetPlayer {
  slot: number;
  name: string;
  side: Side;
}

const ORDER_KINDS = new Set<OrderKind>(['none', 'move', 'moveFast', 'sneak', 'reverse', 'fire', 'smoke', 'defend', 'ambush', 'mount', 'dismount', 'callFire', 'uav', 'strike']);
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const point = (p: unknown): p is Vec2 => !!p && finite((p as Vec2).x) && finite((p as Vec2).y);

/**
 * The shared multiplayer state that lives beside the World: pause and resume votes, deployment
 * readiness, cease-fire proposals and who has left. Every player applies the same commands at the
 * same steps, so this, like the World, is identical on every machine. Commands are validated here
 * (a player may only command their own units), so a bad or stale command is simply ignored.
 */
export class Session {
  paused = false;
  pausedBy = -1;
  readonly resumeVotes = new Set<number>();
  readonly ready = new Set<number>();
  readonly ceasefire = new Set<number>();
  readonly dropped = new Set<number>();
  /** Messages for the local UI produced while applying commands (not part of the simulation). */
  readonly notices: { text: string; level: 'info' | 'warn' | 'good' }[] = [];

  constructor(
    readonly world: World,
    readonly mode: Mode,
    readonly players: NetPlayer[],
  ) {}

  player(slot: number): NetPlayer | undefined {
    return this.players.find((p) => p.slot === slot);
  }

  get active(): NetPlayer[] {
    return this.players.filter((p) => !this.dropped.has(p.slot));
  }

  /** Whether `slot` may command unit `id` (their side, their unit in co-op, still in the fight). */
  canCommand(slot: number, id: number): boolean {
    const u = this.world.units[id];
    const p = this.player(slot);
    if (!u || !p || this.dropped.has(slot)) return false;
    return u.side === p.side && (u.slot === undefined || u.slot === slot) && !u.eliminated && !u.withdrawn;
  }

  apply(slot: number, c: Command): void {
    const w = this.world;
    const p = this.player(slot);
    if (!p || this.dropped.has(slot) || !c || typeof c !== 'object') return;
    switch (c.k) {
      case 'order': {
        if (w.phase !== 'battle' || !this.canCommand(slot, c.unit) || !ORDER_KINDS.has(c.kind)) return;
        const o: Omit<Order, 'issuedAt'> = { kind: c.kind };
        if (c.target !== undefined) {
          if (!point(c.target)) return;
          o.target = { x: c.target.x, y: c.target.y };
        }
        if (c.targetUnit !== undefined) {
          if (!Number.isInteger(c.targetUnit) || !w.units[c.targetUnit]) return;
          o.targetUnit = c.targetUnit;
        }
        if (c.facing !== undefined) {
          if (!finite(c.facing)) return;
          o.facing = c.facing;
        }
        issueOrder(w, c.unit, o);
        return;
      }
      case 'place': {
        if (w.phase !== 'deploy' || !this.canCommand(slot, c.unit) || !finite(c.x) || !finite(c.y)) return;
        const u = w.units[c.unit];
        const z = w.deploy[u.side];
        if (c.x < z.x || c.y < z.y || c.x > z.x + z.w || c.y > z.y + z.h) return;
        const mob = u.vehicle >= 0 ? w.vehicles[u.vehicle].def.mobility : 'foot';
        const q = nearestPassable(w.map, c.x, c.y, mob, 6);
        if (q) placeUnit(w, u, q, u.facing);
        return;
      }
      case 'face': {
        if (w.phase !== 'deploy' || !this.canCommand(slot, c.unit) || !finite(c.facing)) return;
        const u = w.units[c.unit];
        const pos = w.unitPos(u);
        placeUnit(w, u, u.vehicle >= 0 ? pos : (u.holdPos ?? pos), c.facing);
        u.order = { kind: 'defend', issuedAt: 0, facing: u.facing };
        return;
      }
      case 'ready':
        if (w.phase !== 'deploy') return;
        this.ready.add(slot);
        this.maybeStart();
        return;
      case 'pause':
        if (w.phase !== 'battle' || this.paused) return;
        this.paused = true;
        this.pausedBy = slot;
        this.resumeVotes.clear();
        this.notices.push({ text: `${p.name} paused the battle.`, level: 'info' });
        return;
      case 'resume':
        if (!this.paused) return;
        this.resumeVotes.add(slot);
        this.maybeResume();
        return;
      case 'withdraw':
        if (w.phase === 'ended') return;
        w.endBattle(otherSide(p.side), `${p.name} (${FACTIONS[p.side].short}) ordered a withdrawal.`);
        return;
      case 'ceasefire':
        if (w.phase !== 'battle') return;
        this.proposeCeasefire(p);
        return;
    }
  }

  private maybeStart(): void {
    if (this.world.phase === 'deploy' && this.active.every((p) => this.ready.has(p.slot))) {
      this.world.startBattle();
      this.notices.push({ text: 'All commanders ready. Battle commenced.', level: 'good' });
    }
  }

  private maybeResume(): void {
    if (this.paused && this.active.every((p) => this.resumeVotes.has(p.slot))) {
      this.paused = false;
      this.resumeVotes.clear();
      this.notices.push({ text: 'Battle resumed.', level: 'info' });
    }
  }

  private proposeCeasefire(p: NetPlayer): void {
    const w = this.world;
    if (this.mode === 'versus') {
      this.ceasefire.add(p.slot);
      if (this.active.every((q) => this.ceasefire.has(q.slot))) w.endBattle(null, 'Cease-fire agreed.');
      else this.notices.push({ text: `${p.name} proposes a cease-fire. Request one too to accept.`, level: 'info' });
      return;
    }
    // co-op against the AI: the enemy agrees if it's ahead, badly beaten, or the battle is long
    const enemy = otherSide(p.side);
    const mine = w.vls.filter((v) => v.owner === p.side).reduce((n, v) => n + v.value, 0);
    const theirs = w.vls.filter((v) => v.owner === enemy).reduce((n, v) => n + v.value, 0);
    if (theirs >= mine || w.forceMorale[enemy] < 45 || w.time > w.timeLimit * 0.6) w.endBattle(null, 'Cease-fire agreed.');
    else this.notices.push({ text: `The enemy refuses ${p.name}'s cease-fire request.`, level: 'warn' });
  }

  /**
   * A player left for good (applied by everyone at the same step). Co-op: their units pass to a
   * teammate. Versus, or no teammate left: the AI takes their side.
   */
  drop(slot: number): void {
    const p = this.player(slot);
    if (!p || this.dropped.has(slot)) return;
    this.dropped.add(slot);
    this.ready.delete(slot);
    this.resumeVotes.delete(slot);
    this.ceasefire.delete(slot);
    const w = this.world;
    const mate = this.active.find((q) => q.side === p.side);
    if (mate) {
      for (const u of w.units) if (u.slot === slot) u.slot = mate.slot;
      this.notices.push({ text: `${p.name} left. ${mate.name} takes command of their units.`, level: 'warn' });
    } else {
      w.sides[p.side].ai = true;
      for (const u of w.units) if (u.slot === slot) u.slot = undefined;
      this.notices.push({ text: `${p.name} left. The AI takes command of ${FACTIONS[p.side].short}.`, level: 'warn' });
    }
    this.maybeStart();
    this.maybeResume();
  }
}

/**
 * Checksum of the simulation state (FNV-1a over the exact bits of the numbers that matter),
 * exchanged every couple of seconds to detect desyncs.
 */
export function worldHash(w: World): number {
  const dv = new DataView(new ArrayBuffer(8));
  let h = 0x811c9dc5;
  const num = (v: number) => {
    dv.setFloat64(0, v);
    for (let i = 0; i < 8; i++) h = Math.imul(h ^ dv.getUint8(i), 0x01000193);
  };
  num(w.time);
  num(w.rng.s);
  for (const s of w.soldiers) {
    num(s.x);
    num(s.y);
    num(s.morale);
    num(s.supp);
    num(s.health === 'ok' ? 0 : s.health === 'wounded' ? 1 : s.health === 'incap' ? 2 : 3);
  }
  for (const v of w.vehicles) {
    num(v.x);
    num(v.y);
    num(v.heading);
    num(v.destroyed ? 1 : 0);
  }
  num(w.projectiles.length);
  for (const vl of w.vls) num(vl.owner === 'nato' ? 1 : vl.owner === 'opfor' ? 2 : 0);
  return h >>> 0;
}
