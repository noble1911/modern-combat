import { getMap } from '../data/maps';
import { Side, UNITS, unitTemplate } from '../data/units';
import type { LightingId } from '../render/atmosphere';
import { aiDeploy, aiMountUp, Posture } from '../sim/ai';
import { generateMap, GeneratedMap, MapDef } from '../sim/mapgen';
import type { Vec2 } from '../sim/math';
import { World } from '../sim/world';

export interface ForceEntry {
  template: string;
  exp?: number;
  name?: string;
  /** Index (in the same force list) of the carrier this unit starts inside. */
  mountIn?: number;
  campaignId?: string;
  soldierHealth?: ('ok' | 'wounded' | 'dead')[];
  charges?: number;
}

export interface BattleSetup {
  mapId: string;
  seed: number;
  timeLimit: number;
  /** Side controlled by the human; null for AI vs AI. */
  player: Side | null;
  posture: Record<Side, Posture>;
  forces: Record<Side, ForceEntry[]>;
  /** Optional VL ownership overrides (campaign carry-over). */
  vlOwners?: Record<string, Side | null>;
  /** Use the map's alternate deployment (roles reversed). */
  alt?: boolean;
  /** Time of day / weather for the renderer (defaults to one derived from the seed). */
  lighting?: LightingId;
}

/** Which side attacks by default on a map (the side whose zone is away from most VLs). */
export function defaultAttacker(def: MapDef): Side {
  return defaultForces(def.id).posture.nato === 'attack' ? 'nato' : 'opfor';
}

const REAR: Record<string, Vec2> = { north: { x: 0, y: 1 }, south: { x: 0, y: -1 }, east: { x: 1, y: 0 }, west: { x: -1, y: 0 } };

export function unitNames(forces: ForceEntry[]): string[] {
  const counts: Record<string, number> = {};
  return forces.map((f) => {
    if (f.name) return f.name;
    const t = unitTemplate(f.template);
    counts[t.id] = (counts[t.id] ?? 0) + 1;
    return `${t.short} ${counts[t.id]}`;
  });
}

export function createBattle(setup: BattleSetup, gen?: GeneratedMap): World {
  const def = getMap(setup.mapId);
  if (!def) throw new Error(`Unknown map ${setup.mapId}`);
  const g = gen ?? generateMap(def);
  const alt = setup.alt && def.deployAlt ? def.deployAlt : null;
  const rear = alt ? alt.rear : def.rear;
  const w = new World(g, {
    seed: setup.seed,
    timeLimit: setup.timeLimit,
    deploy: alt ? alt.zones : def.deploy,
    sides: {
      nato: { ai: setup.player !== 'nato', posture: setup.posture.nato, rear: REAR[rear.nato] },
      opfor: { ai: setup.player !== 'opfor', posture: setup.posture.opfor, rear: REAR[rear.opfor] },
    },
  });
  if (setup.vlOwners) for (const vl of w.vls) if (vl.id in setup.vlOwners) vl.owner = setup.vlOwners[vl.id];
  for (const side of ['nato', 'opfor'] as Side[]) {
    const zone = w.deploy[side];
    const forces = setup.forces[side];
    const names = unitNames(forces);
    const created: number[] = [];
    // carriers first so passengers can be embarked
    const order = forces.map((_, i) => i).sort((a, b) => Number(forces[a].mountIn !== undefined) - Number(forces[b].mountIn !== undefined));
    for (const i of order) {
      const f = forces[i];
      const p = { x: zone.x + zone.w * ((i + 0.5) / forces.length), y: zone.y + zone.h / 2 };
      const mountIn = f.mountIn !== undefined ? created[f.mountIn] : undefined;
      const u = w.spawnUnit(f.template, side, p, {
        exp: f.exp,
        name: names[i],
        campaignId: f.campaignId,
        soldierHealth: f.soldierHealth,
        charges: f.charges,
        mountIn,
      });
      created[i] = u.id;
    }
    // Everyone starts deployed sensibly; the player can re-deploy during the deployment phase.
    aiDeploy(w, side);
    if (setup.player !== side && setup.posture[side] === 'attack') aiMountUp(w, side);
  }
  return w;
}

// ------------------------------------------------------------------ default orders of battle

const E = (template: string, extra: Partial<ForceEntry> = {}): ForceEntry => ({ template, ...extra });

/** Pre-built forces for quick battles per map. */
export function defaultForces(mapId: string): { forces: Record<Side, ForceEntry[]>; posture: Record<Side, Posture> } {
  const natoAttackPosture: Record<Side, Posture> = { nato: 'attack', opfor: 'defend' };
  switch (mapId) {
    case 'hollen':
      return {
        posture: { nato: 'defend', opfor: 'attack' },
        forces: {
          nato: [E('us_rifle'), E('us_rifle'), E('us_rifle'), E('us_mg'), E('us_mg'), E('us_javelin'), E('us_javelin'), E('us_gustaf'), E('us_sniper'), E('us_mortar'), E('us_hq'), E('us_uas'), E('us_m2a4')],
          opfor: [E('ru_t90m'), E('ru_t72b3'), E('ru_bmp3'), E('ru_rifle', { mountIn: 2 }), E('ru_bmp3'), E('ru_rifle', { mountIn: 4 }), E('ru_btr82a'), E('ru_rifle', { mountIn: 6 }), E('ru_rifle'), E('ru_mg'), E('ru_kornet'), E('ru_mortar'), E('ru_hq'), E('ru_uas')],
        },
      };
    case 'arnholt':
      return {
        posture: { nato: 'defend', opfor: 'attack' },
        forces: {
          nato: [E('us_rifle', { exp: 0.72 }), E('us_rifle', { exp: 0.72 }), E('us_rifle', { exp: 0.72 }), E('us_rifle', { exp: 0.72 }), E('us_mg', { exp: 0.72 }), E('us_mg', { exp: 0.72 }), E('us_javelin', { exp: 0.72 }), E('us_javelin', { exp: 0.72 }), E('us_gustaf', { exp: 0.72 }), E('us_gustaf', { exp: 0.72 }), E('us_sniper', { exp: 0.72 }), E('us_mortar'), E('us_hq', { exp: 0.72 })],
          opfor: [E('ru_t90m'), E('ru_t90m'), E('ru_t72b3'), E('ru_bmp3'), E('ru_rifle', { mountIn: 3 }), E('ru_btr82a'), E('ru_rifle', { mountIn: 5 }), E('ru_rifle'), E('ru_rifle'), E('ru_mg'), E('ru_ags'), E('ru_kornet'), E('ru_sniper'), E('ru_mortar'), E('ru_hq'), E('ru_uas')],
        },
      };
    case 'nordhaven':
      return {
        posture: natoAttackPosture,
        forces: {
          nato: [E('us_m1a2'), E('us_m2a4'), E('us_rifle', { mountIn: 1 }), E('us_m2a4'), E('us_rifle', { mountIn: 3 }), E('us_stryker'), E('us_rifle', { mountIn: 5 }), E('us_rifle'), E('us_mg'), E('us_javelin'), E('us_gustaf'), E('us_sniper'), E('us_mortar'), E('us_hq'), E('us_uas')],
          opfor: [E('ru_rifle'), E('ru_rifle'), E('ru_rifle'), E('ru_rifle'), E('ru_mg'), E('ru_mg'), E('ru_kornet'), E('ru_ags'), E('ru_sniper'), E('ru_mortar'), E('ru_hq'), E('ru_t72b3'), E('ru_btr82a')],
        },
      };
    case 'maasbrug':
      return {
        posture: natoAttackPosture,
        forces: {
          nato: [E('us_m1a2'), E('us_m1a2'), E('us_m2a4'), E('us_rifle', { mountIn: 2 }), E('us_m2a4'), E('us_rifle', { mountIn: 4 }), E('us_rifle'), E('us_rifle'), E('us_mg'), E('us_javelin'), E('us_sniper'), E('us_mortar'), E('us_hq'), E('us_uas')],
          opfor: [E('ru_rifle'), E('ru_rifle'), E('ru_rifle'), E('ru_rifle'), E('ru_mg'), E('ru_kornet'), E('ru_kornet'), E('ru_ags'), E('ru_sniper'), E('ru_mortar'), E('ru_hq'), E('ru_t72b3'), E('ru_bmp3'), E('ru_uas')],
        },
      };
    case 'zonbrug':
      return {
        posture: natoAttackPosture,
        forces: {
          nato: [E('us_rifle'), E('us_rifle'), E('us_rifle'), E('us_rifle'), E('us_mg'), E('us_mg'), E('us_javelin'), E('us_gustaf'), E('us_sniper'), E('us_mortar'), E('us_hq'), E('us_uas'), E('us_jltv'), E('us_jltv')],
          opfor: [E('ru_rifle'), E('ru_rifle'), E('ru_rifle'), E('ru_mg'), E('ru_mg'), E('ru_kornet'), E('ru_ags'), E('ru_sniper'), E('ru_mortar'), E('ru_hq'), E('ru_btr82a'), E('ru_tigr')],
        },
      };
    case 'veldmark':
    default:
      return {
        posture: natoAttackPosture,
        forces: {
          nato: [E('us_rifle'), E('us_rifle'), E('us_rifle'), E('us_rifle'), E('us_mg'), E('us_mg'), E('us_javelin'), E('us_javelin'), E('us_gustaf'), E('us_sniper'), E('us_mortar'), E('us_hq'), E('us_uas'), E('us_m2a4'), E('us_jltv')],
          opfor: [E('ru_rifle'), E('ru_rifle'), E('ru_rifle'), E('ru_rifle'), E('ru_mg'), E('ru_mg'), E('ru_kornet'), E('ru_ags'), E('ru_sniper'), E('ru_mortar'), E('ru_hq'), E('ru_btr82a'), E('ru_t72b3')],
        },
      };
  }
}

export function forceCost(forces: ForceEntry[]): number {
  return forces.reduce((n, f) => n + (UNITS[f.template]?.cost ?? 0), 0);
}
