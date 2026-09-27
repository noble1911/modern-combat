import { MAPS } from '../data/maps';
import { otherSide, Side, unitTemplate } from '../data/units';
import type { LightingId } from '../render/atmosphere';
import { Rng } from '../sim/math';
import type { BattleResult } from '../sim/types';
import type { World } from '../sim/world';
import { BattleSetup, defaultAttacker, ForceEntry } from './scenario';

// ------------------------------------------------------------------ types

export interface CampaignUnit {
  cid: string;
  template: string;
  name: string;
  exp: number;
  /** Infantry: per template-soldier status. Vehicles: single entry for the vehicle. */
  soldiers: ('ok' | 'wounded' | 'dead')[];
  lost: boolean;
  charges?: number;
  kills: number;
  /** Carrier cid this unit rides in (kept together when deploying). */
  rides?: string;
}

export type BGOrder = 'advance' | 'hold' | 'rest' | 'withdraw';

export interface BattleGroup {
  id: string;
  name: string;
  side: Side;
  kind: 'armor' | 'airborne' | 'infantry' | 'mech';
  sector: number;
  /** Sector it attacked from (to fall back to after a failed attack). */
  from: number | null;
  units: CampaignUnit[];
  order: BGOrder;
  arrives: number; // turn index when it enters play
  /** Sector used to (re-)enter the corridor from off-map. */
  entry: number;
  destroyed: boolean;
  description: string;
}

export interface Sector {
  idx: number;
  mapId: string;
  name: string;
  owner: Side;
  bridge: boolean;
  bridgeBlown: boolean;
  /** Turns until engineers finish a replacement bridge. */
  repair: number;
}

export interface PendingBattle {
  id: string;
  sector: number;
  attacker: Side;
  resolved: boolean;
  result?: { winner: Side | null; text: string };
}

export interface CampaignState {
  version: 1;
  player: Side;
  turn: number; // 0-based; 2 turns per day
  maxTurns: number;
  sectors: Sector[];
  bgs: BattleGroup[];
  battles: PendingBattle[];
  log: { turn: number; text: string; level: 'info' | 'good' | 'bad' }[];
  over: null | { winner: Side | null; title: string; text: string };
  seed: number;
  linkUp: boolean;
}

export const TURN_NAMES = ['Morning', 'Afternoon'];
export const dayOf = (turn: number) => Math.floor(turn / 2) + 1;
export const turnLabel = (turn: number) => `Day ${dayOf(turn)} — ${TURN_NAMES[turn % 2]}`;

// ------------------------------------------------------------------ setup

let cidN = 0;
function mkUnit(template: string, exp: number, name?: string, rides?: string): CampaignUnit {
  const t = unitTemplate(template);
  const n = t.vehicle ? 1 : t.soldiers!.length;
  return { cid: `u${++cidN}`, template, name: name ?? t.short, exp, soldiers: Array(n).fill('ok'), lost: false, kills: 0, charges: t.charges, rides };
}

function withCarriers(list: [string, number, string?][], exp: number, tag = ''): CampaignUnit[] {
  const out: CampaignUnit[] = [];
  const counts: Record<string, number> = {};
  let lastCarrier: CampaignUnit | null = null;
  for (const [tpl, n, mode] of list) {
    for (let i = 0; i < n; i++) {
      counts[tpl] = (counts[tpl] ?? 0) + 1;
      const t = unitTemplate(tpl);
      const u = mkUnit(tpl, exp, `${tag ? tag + ' ' : ''}${t.short} ${counts[tpl]}`, mode === 'mounted' && lastCarrier ? lastCarrier.cid : undefined);
      if (t.vehicle && unitTemplate(tpl).symbol !== 'armor') lastCarrier = u;
      if (mode === 'mounted') lastCarrier = null;
      out.push(u);
    }
  }
  return out;
}

const SECTOR_MAPS = ['veldmark', 'zonbrug', 'hollen', 'maasbrug', 'nordhaven', 'arnholt'];

export function newCampaign(player: Side, seed = Date.now() % 1e6): CampaignState {
  cidN = 0;
  const sectors: Sector[] = SECTOR_MAPS.map((m, i) => ({
    idx: i,
    mapId: m,
    name: MAPS[m].name,
    owner: i === 2 ? 'nato' : i === 5 ? 'nato' : 'opfor',
    bridge: !!MAPS[m].rivers?.some((r) => !r.shallow),
    bridgeBlown: false,
    repair: 0,
  }));
  const bgs: BattleGroup[] = [
    {
      id: 'tfiron', name: 'Task Force Iron', side: 'nato', kind: 'armor', sector: 0, from: -1, order: 'advance', arrives: 0, entry: 0, destroyed: false,
      description: 'The armoured column: Abrams tanks and Bradleys with mechanised infantry. It must drive up Route Iron — it can only advance through sectors already in NATO hands.',
      units: withCarriers([['us_m1a2', 2], ['us_m2a4', 1], ['us_rifle', 1, 'mounted'], ['us_m2a4', 1], ['us_rifle', 1, 'mounted'], ['us_m2a4', 1], ['us_rifle', 1, 'mounted'], ['us_mg', 1], ['us_javelin', 1], ['us_mortar', 1], ['us_hq', 1], ['us_uas', 1]], 0.6, 'Iron'),
    },
    {
      id: 'aa502', name: '1-502nd Air Assault', side: 'nato', kind: 'airborne', sector: 0, from: null, order: 'advance', arrives: 0, entry: 0, destroyed: false,
      description: 'Light air assault infantry landed at the Veldmark drop zone. Strong in woods and towns, vulnerable to armour in the open.',
      units: withCarriers([['us_rifle', 4], ['us_mg', 2], ['us_javelin', 2], ['us_gustaf', 1], ['us_sniper', 1], ['us_mortar', 1], ['us_hq', 1], ['us_uas', 1], ['us_jltv', 2]], 0.65, '502'),
    },
    {
      id: 'aa327', name: '3-327th Infantry', side: 'nato', kind: 'airborne', sector: 2, from: null, order: 'hold', arrives: 0, entry: 2, destroyed: false,
      description: 'Air-landed at Hollen to hold the crossroads open for the column.',
      units: withCarriers([['us_rifle', 3], ['us_mg', 2], ['us_javelin', 2], ['us_gustaf', 1], ['us_sniper', 1], ['us_mortar', 1], ['us_hq', 1], ['us_m2a4', 1]], 0.62, '327'),
    },
    {
      id: 'pir503', name: '2-503rd Parachute Infantry', side: 'nato', kind: 'airborne', sector: 5, from: null, order: 'hold', arrives: 0, entry: 5, destroyed: false,
      description: 'The "bridge too far": a lone parachute battalion holding the northern ramp of the Arnholt bridge. It cannot be reinforced until the corridor is open.',
      units: withCarriers([['us_rifle', 4], ['us_mg', 2], ['us_javelin', 1], ['us_gustaf', 2], ['us_sniper', 1], ['us_mortar', 1], ['us_hq', 1]], 0.74, '503'),
    },
    {
      id: 'tfiron2', name: 'TF Iron — 2nd Company', side: 'nato', kind: 'mech', sector: 0, from: -1, order: 'advance', arrives: 4, entry: 0, destroyed: false,
      description: 'Follow-on Stryker company, arriving on Day 3.',
      units: withCarriers([['us_m1a2', 1], ['us_stryker', 1], ['us_rifle', 1, 'mounted'], ['us_stryker', 1], ['us_rifle', 1, 'mounted'], ['us_mg', 1], ['us_javelin', 1], ['us_sniper', 1], ['us_hq', 1]], 0.55, 'Iron2'),
    },
    {
      id: 'aa506', name: '1-506th Air Assault', side: 'nato', kind: 'airborne', sector: 2, from: null, order: 'hold', arrives: 3, entry: -2, destroyed: false,
      description: 'Second-lift air assault battalion, landing on Day 2 at the most forward sector NATO holds.',
      units: withCarriers([['us_rifle', 3], ['us_mg', 1], ['us_javelin', 2], ['us_gustaf', 1], ['us_mortar', 1], ['us_hq', 1], ['us_uas', 1]], 0.62, '506'),
    },
    {
      id: 'pl6', name: '6th Polish Airborne Brigade', side: 'nato', kind: 'airborne', sector: 5, from: null, order: 'hold', arrives: 6, entry: 5, destroyed: false,
      description: 'Allied paratroopers dropping at Arnholt on Day 4 to reinforce — or retake — the bridge.',
      units: withCarriers([['us_rifle', 3], ['us_mg', 1], ['us_javelin', 1], ['us_gustaf', 1], ['us_sniper', 1], ['us_hq', 1]], 0.7, 'PL'),
    },
    // ---------------- OPFOR ----------------
    {
      id: 'g1', name: 'Veldmark Garrison', side: 'opfor', kind: 'infantry', sector: 0, from: null, order: 'hold', arrives: 0, entry: 0, destroyed: false,
      description: 'Motor rifle company holding the Veldmark crossroads.',
      units: withCarriers([['ru_rifle', 4], ['ru_mg', 2], ['ru_kornet', 1], ['ru_ags', 1], ['ru_sniper', 1], ['ru_mortar', 1], ['ru_hq', 1], ['ru_btr82a', 1], ['ru_t72b3', 1]], 0.5, '1MR'),
    },
    {
      id: 'g2', name: 'Zonbrug Bridge Guard', side: 'opfor', kind: 'infantry', sector: 1, from: null, order: 'hold', arrives: 0, entry: 1, destroyed: false,
      description: 'Bridge guard with engineers ready to demolish the canal bridge.',
      units: withCarriers([['ru_rifle', 3], ['ru_mg', 2], ['ru_kornet', 1], ['ru_ags', 1], ['ru_sniper', 1], ['ru_mortar', 1], ['ru_hq', 1], ['ru_btr82a', 1], ['ru_tigr', 1]], 0.5, '2MR'),
    },
    {
      id: 'g4', name: 'Maasbrug Garrison', side: 'opfor', kind: 'infantry', sector: 3, from: null, order: 'hold', arrives: 0, entry: 3, destroyed: false,
      description: 'Dug in on both banks of the Maas bridge.',
      units: withCarriers([['ru_rifle', 4], ['ru_mg', 1], ['ru_kornet', 2], ['ru_ags', 1], ['ru_sniper', 1], ['ru_mortar', 1], ['ru_hq', 1], ['ru_t72b3', 1], ['ru_bmp3', 1], ['ru_uas', 1]], 0.52, '4MR'),
    },
    {
      id: 'g5', name: 'Nordhaven Garrison', side: 'opfor', kind: 'infantry', sector: 4, from: null, order: 'hold', arrives: 0, entry: 4, destroyed: false,
      description: 'Urban defence battalion turning Nordhaven into a fortress.',
      units: withCarriers([['ru_rifle', 4], ['ru_mg', 2], ['ru_kornet', 1], ['ru_ags', 1], ['ru_sniper', 1], ['ru_mortar', 1], ['ru_hq', 1], ['ru_t72b3', 1], ['ru_btr82a', 1]], 0.55, '5MR'),
    },
    {
      id: 'tank47', name: '47th Tank Battalion', side: 'opfor', kind: 'armor', sector: 2, from: -1, order: 'advance', arrives: 1, entry: 2, destroyed: false,
      description: 'Armoured reserve striking the corridor from the east at Hollen.',
      units: withCarriers([['ru_t90m', 1], ['ru_t72b3', 1], ['ru_bmp3', 1], ['ru_rifle', 1, 'mounted'], ['ru_bmp3', 1], ['ru_rifle', 1, 'mounted'], ['ru_btr82a', 1], ['ru_rifle', 1, 'mounted'], ['ru_rifle', 1], ['ru_mg', 1], ['ru_kornet', 1], ['ru_mortar', 1], ['ru_hq', 1], ['ru_uas', 1]], 0.6, '47T'),
    },
    {
      id: 'arn', name: 'Arnholt Assault Group', side: 'opfor', kind: 'armor', sector: 5, from: -1, order: 'advance', arrives: 0, entry: 5, destroyed: false,
      description: 'Tanks and motor rifles converging on the Arnholt bridge.',
      units: withCarriers([['ru_t90m', 2], ['ru_t72b3', 1], ['ru_bmp3', 1], ['ru_rifle', 1, 'mounted'], ['ru_btr82a', 1], ['ru_rifle', 1, 'mounted'], ['ru_rifle', 2], ['ru_mg', 1], ['ru_ags', 1], ['ru_kornet', 1], ['ru_sniper', 1], ['ru_mortar', 1], ['ru_hq', 1], ['ru_uas', 1]], 0.58, 'AAG'),
    },
    {
      id: 'arn2', name: '9th Guards Tank Group', side: 'opfor', kind: 'armor', sector: 5, from: -1, order: 'advance', arrives: 4, entry: 5, destroyed: false,
      description: 'Fresh armour released from reserve on Day 3 to finish off the paratroopers at Arnholt.',
      units: withCarriers([['ru_t90m', 1], ['ru_t72b3', 2], ['ru_bmp3', 1], ['ru_rifle', 1, 'mounted'], ['ru_bmp3', 1], ['ru_rifle', 1, 'mounted'], ['ru_rifle', 1], ['ru_ags', 1], ['ru_mortar', 1], ['ru_hq', 1]], 0.62, '9GT'),
    },
    {
      id: 'res2', name: '112th Motor Rifle Battalion', side: 'opfor', kind: 'mech', sector: 4, from: null, order: 'hold', arrives: 7, entry: 4, destroyed: false,
      description: 'Second-echelon reinforcements arriving at Nordhaven on Day 4.',
      units: withCarriers([['ru_bmp3', 1], ['ru_rifle', 1, 'mounted'], ['ru_bmp3', 1], ['ru_rifle', 1, 'mounted'], ['ru_rifle', 2], ['ru_mg', 1], ['ru_kornet', 1], ['ru_t72b3', 1], ['ru_hq', 1]], 0.5, '112'),
    },
  ];
  // Initial arrival of the Arnholt group happens at turn 0 as an attack on the bridge.
  const st: CampaignState = { version: 1, player, turn: 0, maxTurns: 14, sectors, bgs, battles: [], log: [], over: null, seed, linkUp: false };
  addLog(st, 'Operation Iron Corridor begins. Air assault battalions are down at Veldmark, Hollen and Arnholt. Task Force Iron crosses the start line.', 'info');
  planBattles(st);
  return st;
}

function addLog(st: CampaignState, text: string, level: 'info' | 'good' | 'bad' = 'info'): void {
  st.log.push({ turn: st.turn, text, level });
}

// ------------------------------------------------------------------ queries

export function activeBGs(st: CampaignState, side?: Side): BattleGroup[] {
  return st.bgs.filter((b) => !b.destroyed && b.arrives <= st.turn && (!side || b.side === side));
}

export function bgStrength(bg: BattleGroup): number {
  let cur = 0;
  let max = 0;
  for (const u of bg.units) {
    const t = unitTemplate(u.template);
    const w = t.cost;
    max += w;
    if (u.lost) continue;
    const n = u.soldiers.length;
    const alive = u.soldiers.filter((s) => s !== 'dead').length;
    cur += (w * alive) / Math.max(1, n);
  }
  return max ? cur / max : 0;
}

/** Absolute combat power (requisition points of surviving men and vehicles). */
export function bgPower(bg: BattleGroup): number {
  let cur = 0;
  for (const u of bg.units) {
    if (u.lost) continue;
    const t = unitTemplate(u.template);
    cur += (t.cost * u.soldiers.filter((s) => s !== 'dead').length) / Math.max(1, u.soldiers.length);
  }
  return cur;
}

/** Is there an unbroken chain of friendly sectors back to the side's rear? */
export function supplied(st: CampaignState, bg: BattleGroup): boolean {
  if (bg.sector < 0) return true;
  // OPFOR fights on interior lines with supply from the north and east; only NATO depends on the
  // single corridor: every sector behind the battlegroup must be friendly (its own may be contested).
  if (bg.side === 'opfor') return true;
  for (let i = 0; i < bg.sector; i++) if (st.sectors[i].owner !== 'nato') return false;
  return true;
}

export function sectorBGs(st: CampaignState, sector: number, side?: Side): BattleGroup[] {
  return activeBGs(st, side).filter((b) => b.sector === sector);
}

/** Can a battlegroup advance from its sector into the next one? */
export function nextSector(st: CampaignState, bg: BattleGroup): number | null {
  if (bg.sector < 0) return bg.entry;
  const dir = bg.side === 'nato' ? 1 : -1;
  // OPFOR armour reserves attack wherever they are; others can move along the corridor
  const n = bg.sector + dir;
  if (n < 0 || n >= st.sectors.length) return null;
  return n;
}

export function canAdvance(st: CampaignState, bg: BattleGroup): { ok: boolean; reason?: string } {
  if (bg.destroyed) return { ok: false, reason: 'Destroyed' };
  if (bg.sector < 0) return { ok: true };
  const here = st.sectors[bg.sector];
  // BG in a contested sector must fight here first
  if (sectorBGs(st, bg.sector, otherSide(bg.side)).length) return { ok: false, reason: 'In contact — fighting here' };
  if (here.owner !== bg.side) return { ok: false, reason: 'Sector not secured' };
  const n = nextSector(st, bg);
  if (n === null) return { ok: false, reason: 'End of the corridor' };
  const crossing = bg.side === 'nato' ? here : st.sectors[n];
  if ((bg.kind === 'armor' || bg.kind === 'mech') && crossing.bridge && crossing.bridgeBlown) return { ok: false, reason: `Bridge at ${crossing.name} is down (${crossing.repair} turns to repair)` };
  return { ok: true };
}

// ------------------------------------------------------------------ turn resolution

/** Create battles for every sector with both sides present. */
export function planBattles(st: CampaignState): void {
  st.battles = [];
  for (const sec of st.sectors) {
    const nato = sectorBGs(st, sec.idx, 'nato');
    const opfor = sectorBGs(st, sec.idx, 'opfor');
    if (!nato.length || !opfor.length) continue;
    const attacker: Side = otherSide(sec.owner);
    st.battles.push({ id: `b${st.turn}_${sec.idx}`, sector: sec.idx, attacker, resolved: false });
  }
}

/** Build the tactical battle for a pending engagement. */
export function battleSetup(st: CampaignState, b: PendingBattle, playerControls: boolean): { setup: BattleSetup; forces: Record<Side, CampaignUnit[]> } {
  const sec = st.sectors[b.sector];
  const def = MAPS[sec.mapId];
  const natural = defaultAttacker(def);
  const alt = b.attacker !== natural;
  const forces: Record<Side, CampaignUnit[]> = { nato: [], opfor: [] };
  const entries: Record<Side, ForceEntry[]> = { nato: [], opfor: [] };
  for (const side of ['nato', 'opfor'] as Side[]) {
    const pool = sectorBGs(st, b.sector, side).flatMap((g) => g.units.filter((u) => !u.lost && u.soldiers.some((s) => s !== 'dead')));
    // cap battle size: strongest 16 units; keep passengers with their carriers
    const chosen = pool.slice(0, 16);
    for (const u of pool.slice(16)) if (u.rides && chosen.some((c) => c.cid === u.rides) && chosen.length < 18) chosen.push(u);
    forces[side] = chosen;
    const idx = new Map(chosen.map((u, i) => [u.cid, i]));
    entries[side] = chosen.map((u) => {
      const t = unitTemplate(u.template);
      const e: ForceEntry = { template: u.template, exp: u.exp, name: u.name, campaignId: u.cid, charges: u.charges };
      if (!t.vehicle) e.soldierHealth = [...u.soldiers];
      if (u.rides && idx.has(u.rides) && b.attacker === side) e.mountIn = idx.get(u.rides);
      return e;
    });
  }
  const vlOwners: Record<string, Side | null> = {};
  for (const vl of def.vls) vlOwners[vl.id] = vl.owner === null || vl.owner === undefined ? null : sec.owner;
  const setup: BattleSetup = {
    mapId: sec.mapId,
    seed: st.seed + st.turn * 101 + b.sector * 7,
    timeLimit: 25 * 60,
    player: playerControls ? st.player : null,
    posture: { nato: b.attacker === 'nato' ? 'attack' : 'defend', opfor: b.attacker === 'opfor' ? 'attack' : 'defend' },
    forces: entries,
    vlOwners,
    alt,
    lighting: campaignLighting(st.seed, st.turn),
  };
  return { setup, forces };
}

/** Morning turns are fought in morning light, afternoon turns in the afternoon or at dusk; some days are grey. */
function campaignLighting(seed: number, turn: number): LightingId {
  const r = new Rng(seed * 7 + Math.floor(turn / 2) * 131).next();
  if (r < 0.22) return 'overcast';
  if (turn % 2 === 0) return 'morning';
  return r > 0.75 ? 'dusk' : 'afternoon';
}

/** Apply a finished battle back onto the campaign. */
export function applyBattle(st: CampaignState, b: PendingBattle, world: World, result: BattleResult | null): void {
  const sec = st.sectors[b.sector];
  // casualties & experience
  const byCid = new Map<string, CampaignUnit>();
  for (const bg of st.bgs) for (const u of bg.units) byCid.set(u.cid, u);
  for (const u of world.units) {
    if (!u.campaignId) continue;
    const cu = byCid.get(u.campaignId);
    if (!cu) continue;
    if (u.vehicle >= 0) {
      const v = world.vehicles[u.vehicle];
      if (v.destroyed || v.abandoned) cu.lost = true;
      cu.kills += v.crew.reduce((n, id) => n + world.soldiers[id].kills, 0);
    } else {
      const alive = cu.soldiers.map((s, i) => ({ s, i })).filter((x) => x.s !== 'dead');
      u.soldiers.forEach((sid, k) => {
        const s = world.soldiers[sid];
        const slot = alive[k];
        if (!slot) return;
        cu.kills += s.kills;
        if (s.health === 'dead' || s.health === 'incap' || s.state === 'surrendered') cu.soldiers[slot.i] = 'dead';
        else if (s.health === 'wounded') cu.soldiers[slot.i] = 'wounded';
      });
      if (cu.soldiers.every((x) => x === 'dead')) cu.lost = true;
    }
    cu.charges = u.charges;
    if (!cu.lost) cu.exp = Math.min(0.9, cu.exp + 0.03);
  }
  // control
  let winner: Side | null = result?.winner ?? null;
  if (!winner) winner = sec.owner; // a draw leaves the defender in place
  const loser = otherSide(winner);
  const defender = otherSide(b.attacker);
  const prevOwner = sec.owner;
  sec.owner = winner;
  const text =
    winner === b.attacker
      ? `${st.sectors[b.sector].name}: ${winner === 'nato' ? 'NATO' : 'OPFOR'} attack succeeds — sector captured.`
      : `${st.sectors[b.sector].name}: ${defender === 'nato' ? 'NATO' : 'OPFOR'} holds the sector.`;
  b.resolved = true;
  b.result = { winner, text };
  addLog(st, text, winner === st.player ? 'good' : 'bad');
  // bridge demolition: a defender losing a bridge may blow it
  if (sec.bridge && prevOwner !== winner && !sec.bridgeBlown) {
    const rng = new Rng(st.seed + st.turn * 13 + b.sector);
    if (rng.chance(0.35)) {
      sec.bridgeBlown = true;
      sec.repair = 2;
      addLog(st, `The bridge at ${sec.name} has been demolished by retreating engineers! Engineers estimate a replacement in ${sec.repair} turns.`, loser === st.player ? 'good' : 'bad');
    }
  }
  // losers fall back
  for (const bg of sectorBGs(st, b.sector, loser)) retreat(st, bg);
  for (const bg of sectorBGs(st, b.sector, winner)) bg.from = null;
  checkDestroyed(st);
}

function retreat(st: CampaignState, bg: BattleGroup): void {
  const back = bg.side === 'nato' ? bg.sector - 1 : bg.sector + 1;
  const friendly = (i: number | null) => i !== null && i >= 0 && i < st.sectors.length && i !== bg.sector && st.sectors[i].owner === bg.side;
  const dest = friendly(bg.from) ? bg.from! : back;
  if (!friendly(dest)) {
    // surrounded: the survivors are overrun
    if (bg.from === -1) {
      bg.sector = -1; // withdrew off the corridor (reserve)
      addLog(st, `${bg.name} withdraws to regroup.`, bg.side === st.player ? 'bad' : 'good');
      return;
    }
    bg.destroyed = true;
    addLog(st, `${bg.name} has been cut off and overrun.`, bg.side === st.player ? 'bad' : 'good');
    return;
  }
  bg.sector = dest;
  bg.from = null;
  addLog(st, `${bg.name} falls back to ${st.sectors[dest].name}.`, bg.side === st.player ? 'bad' : 'info');
}

function checkDestroyed(st: CampaignState): void {
  for (const bg of st.bgs) {
    if (bg.destroyed) continue;
    if (bgStrength(bg) < 0.12) {
      bg.destroyed = true;
      addLog(st, `${bg.name} has ceased to exist as a fighting force.`, bg.side === st.player ? 'bad' : 'good');
    }
  }
}

/** Resolve orders and advance to the next turn. Call after all battles are resolved. */
export function endTurn(st: CampaignState): void {
  if (st.over) return;
  const rng = new Rng(st.seed * 31 + st.turn * 977);
  // 1. rest & refit
  for (const bg of activeBGs(st)) {
    const inContact = bg.sector >= 0 && sectorBGs(st, bg.sector, otherSide(bg.side)).length > 0;
    if ((bg.order === 'rest' || bg.sector < 0) && !inContact) {
      let returned = 0;
      const sup = supplied(st, bg);
      if (!sup) addLog(st, `${bg.name} is cut off — no replacements can get through.`, bg.side === st.player ? 'bad' : 'info');
      for (const u of bg.units) {
        if (!sup) {
          u.soldiers = u.soldiers.map((s) => (s === 'wounded' && rng.next() < 0.5 ? 'ok' : s));
          continue;
        }
        if (u.lost) continue;
        u.soldiers = u.soldiers.map((s) => (s === 'wounded' ? 'ok' : s));
        // replacements: at most one per unit per turn
        let rep = 0;
        u.soldiers = u.soldiers.map((s) => {
          if (s === 'dead' && rep < 1 && rng.next() < 0.45) {
            rep++;
            returned++;
            return 'ok';
          }
          return s;
        });
        const t = unitTemplate(u.template);
        if (t.charges !== undefined && (u.charges ?? 0) < t.charges) u.charges = (u.charges ?? 0) + 1;
      }
      if (returned) addLog(st, `${bg.name} rests and receives ${returned} replacements.`, 'info');
    } else {
      // walking wounded recover slowly anyway
      for (const u of bg.units) u.soldiers = u.soldiers.map((s) => (s === 'wounded' && rng.next() < 0.3 ? 'ok' : s));
    }
  }
  // 2. bridges
  for (const s of st.sectors) {
    if (s.bridgeBlown && s.owner === 'nato') {
      s.repair--;
      if (s.repair <= 0) {
        s.bridgeBlown = false;
        addLog(st, `Engineers have bridged the gap at ${s.name}. Armour can cross again.`, st.player === 'nato' ? 'good' : 'bad');
      }
    }
  }
  st.turn++;
  // newly arriving battlegroups appear first (and don't move this turn)
  const fresh = new Set<string>();
  for (const bg of st.bgs) {
    if (bg.arrives === st.turn && !bg.destroyed) {
      if (bg.entry === -2) {
        // air landing at the most forward sector that is held and supplied
        let best = 0;
        for (const s of st.sectors) if (s.owner === bg.side && supplied(st, { ...bg, sector: s.idx })) best = Math.max(best, s.idx);
        bg.sector = best;
        bg.entry = best;
      }
      fresh.add(bg.id);
      addLog(st, `${bg.name} has arrived at ${st.sectors[Math.max(0, bg.sector)].name}.`, bg.side === st.player ? 'good' : 'bad');
    }
  }
  // 3. AI orders for the non-player side, then movement for both
  aiOrders(st, otherSide(st.player));
  for (const bg of activeBGs(st)) {
    if (fresh.has(bg.id)) continue;
    if (bg.order === 'advance' && canAdvance(st, bg).ok) {
      const n = nextSector(st, bg)!;
      bg.from = bg.sector;
      bg.sector = n;
      const target = st.sectors[n];
      if (target.owner !== bg.side) addLog(st, `${bg.name} attacks ${target.name}.`, bg.side === st.player ? 'info' : 'bad');
      else addLog(st, `${bg.name} moves up to ${target.name}.`, 'info');
    } else if (bg.order === 'withdraw' && bg.sector >= 0) {
      const back = bg.side === 'nato' ? bg.sector - 1 : bg.sector + 1;
      if (back >= 0 && back < st.sectors.length && st.sectors[back].owner === bg.side) {
        bg.sector = back;
        bg.from = null;
        bg.order = 'hold';
      }
    }
  }
  // sectors with only one side present change hands
  for (const s of st.sectors) {
    const here = activeBGs(st).filter((b) => b.sector === s.idx);
    const sides = new Set(here.map((b) => b.side));
    if (sides.size === 1) {
      const side = [...sides][0];
      if (s.owner !== side) {
        s.owner = side;
        addLog(st, `${s.name} occupied without a fight.`, side === st.player ? 'good' : 'bad');
      }
    }
  }
  checkVictory(st);
  if (!st.over) planBattles(st);
}

/** Staff AI for the non-player side (also used for both sides in automated tests). */
export function aiOrders(st: CampaignState, side: Side): void {
  const enemy = otherSide(side);
  // Decide per sector so battlegroups sharing a sector attack together.
  const bySector = new Map<number, BattleGroup[]>();
  for (const bg of activeBGs(st, side)) {
    const l = bySector.get(bg.sector) ?? [];
    l.push(bg);
    bySector.set(bg.sector, l);
  }
  for (const [sec, group] of bySector) {
    for (const bg of group) bg.order = 'hold';
    if (sec < 0) {
      for (const bg of group) bg.order = bgStrength(bg) > 0.35 ? 'advance' : 'rest';
      continue;
    }
    if (sectorBGs(st, sec, enemy).length) continue; // fighting here
    const mobile = group.filter((bg) => !(bg.kind === 'infantry' && side === 'opfor'));
    const fit = mobile.filter((bg) => bgStrength(bg) >= 0.4 && canAdvance(st, bg).ok);
    const n = fit.length ? nextSector(st, fit[0]) : null;
    if (n !== null) {
      const target = st.sectors[n];
      const enemyPower = sectorBGs(st, n, enemy).reduce((a, b) => a + bgPower(b), 0);
      const ourPower = fit.reduce((a, b) => a + bgPower(b), 0);
      const threatenedFriend = target.owner === side && enemyPower > 0;
      // reinforcements move up through friendly sectors toward the front
      const dir = side === 'nato' ? 1 : -1;
      let frontAhead = false;
      for (let i = n; i >= 0 && i < st.sectors.length; i += dir) if (st.sectors[i].owner !== side) frontAhead = true;
      if (target.owner === side && !enemyPower && frontAhead && bgStrength(fit[0]) > 0.6) {
        for (const bg of fit) bg.order = 'advance';
        continue;
      }
      const worthAttacking = target.owner !== side && ourPower > enemyPower * (side === 'nato' ? 1.3 : 1.2);
      if (threatenedFriend || worthAttacking) {
        for (const bg of fit) bg.order = 'advance';
        // leave a weak garrison behind only if the sector would otherwise be empty
        continue;
      }
    }
    for (const bg of group) if (bg.order === 'hold' && bgStrength(bg) < 0.75) bg.order = 'rest';
  }
}

function checkVictory(st: CampaignState): void {
  const s = st.sectors;
  const natoAll = s.every((x) => x.owner === 'nato');
  const linkUp = s[4].owner === 'nato' && s[5].owner === 'nato';
  if (linkUp && !st.linkUp) {
    st.linkUp = true;
    addLog(st, 'LINK-UP! Task Force Iron has reached the paratroopers at Arnholt. The corridor is open!', st.player === 'nato' ? 'good' : 'bad');
  }
  const natoBGs = activeBGs(st, 'nato').length;
  if (natoAll || linkUp) {
    st.over = { winner: 'nato', title: 'Operation Iron Corridor: Success', text: `NATO forces opened the corridor to Arnholt on ${turnLabel(st.turn)}. The bridge was not a bridge too far.` };
  } else if (natoBGs === 0 || (s[0].owner === 'opfor' && s[1].owner === 'opfor' && s[2].owner === 'opfor')) {
    st.over = { winner: 'opfor', title: 'Operation Iron Corridor: Failure', text: 'The NATO offensive has collapsed. Route Iron remains closed.' };
  } else if (st.turn >= st.maxTurns) {
    const held = s.filter((x) => x.owner === 'nato').length;
    if (s[5].owner === 'opfor' && held >= 4)
      st.over = { winner: null, title: 'A Bridge Too Far', text: `The corridor was pushed ${held} sectors deep, but Arnholt fell before the column could arrive. A costly, incomplete success.` };
    else if (held >= 4) st.over = { winner: 'nato', title: 'Operation Iron Corridor: Partial Success', text: 'Most of the corridor is in NATO hands, but there was no link-up with Arnholt in time.' };
    else if (held === 3) st.over = { winner: null, title: 'Operation Iron Corridor: Stalemate', text: 'Half of Route Iron was won and held, but the offensive has run out of strength short of the great rivers.' };
    else st.over = { winner: 'opfor', title: 'Operation Iron Corridor: Failure', text: 'Time has run out. OPFOR still holds most of Route Iron.' };
  }
  if (st.over) addLog(st, st.over.title, st.over.winner === st.player ? 'good' : 'bad');
}

/** Let the browser paint between simulation chunks (MessageChannel avoids timer clamping). */
function yieldToUI(): Promise<void> {
  if (typeof MessageChannel === 'undefined') return new Promise((r) => setTimeout(r, 0));
  return new Promise((r) => {
    const ch = new MessageChannel();
    ch.port1.onmessage = () => r();
    ch.port2.postMessage(0);
  });
}

/** Automatic resolution through the tactical simulator, AI vs AI (chunked so the UI stays alive). */
export async function autoResolve(st: CampaignState, b: PendingBattle, createWorld: (setup: BattleSetup) => World, onProgress?: (f: number) => void): Promise<World> {
  const { setup } = battleSetup(st, b, false);
  setup.timeLimit = 20 * 60;
  const w = createWorld(setup);
  w.startBattle();
  while (w.phase === 'battle') {
    const t0 = performance.now();
    while (w.phase === 'battle' && performance.now() - t0 < 30) {
      w.step();
      w.events.length = 0;
    }
    onProgress?.(w.time / w.timeLimit);
    await yieldToUI();
  }
  applyBattle(st, b, w, w.result);
  return w;
}

/**
 * Browser storage keys. The game is hosted under a path on a shared origin
 * (games.noblehaus.uk/modern-combat/), so every key carries the game's name.
 */
export const STORAGE = { campaign: 'modern-combat.campaign', settings: 'modern-combat.settings' };
/** Keys used before the prefix, read once as a fallback so older local saves still load. */
const LEGACY = { campaign: 'mc.campaign', settings: 'mc.settings' };

/** Read a stored value, falling back to (and migrating) its pre-prefix key. */
export function readStored(key: keyof typeof STORAGE): string | null {
  const v = localStorage.getItem(STORAGE[key]);
  if (v !== null) return v;
  const old = localStorage.getItem(LEGACY[key]);
  if (old !== null) {
    localStorage.setItem(STORAGE[key], old);
    localStorage.removeItem(LEGACY[key]);
  }
  return old;
}

export function saveCampaign(st: CampaignState): void {
  try {
    localStorage.setItem(STORAGE.campaign, JSON.stringify(st));
  } catch {
    /* storage unavailable */
  }
}

export function loadCampaign(): CampaignState | null {
  try {
    const raw = readStored('campaign');
    if (!raw) return null;
    const st = JSON.parse(raw) as CampaignState;
    if (st.version !== 1) return null;
    // keep cid counter unique after reload
    for (const bg of st.bgs) for (const u of bg.units) cidN = Math.max(cidN, Number(u.cid.slice(1)) || 0);
    return st;
  } catch {
    return null;
  }
}

export function clearCampaign(): void {
  try {
    localStorage.removeItem(STORAGE.campaign);
    localStorage.removeItem(LEGACY.campaign);
  } catch {
    /* ignore */
  }
}
