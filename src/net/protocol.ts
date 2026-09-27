import type { Side } from '../data/units';
import type { BattleSetup, ForceEntry } from '../game/scenario';
import type { Vec2 } from '../sim/math';
import type { OrderKind } from '../sim/types';

/**
 * Multiplayer wire protocol (JSON over one WebSocket at `<game>/ws`). The relay server
 * (server/index.mjs) keeps rooms and forwards battle steps; it knows nothing about the game.
 */

export type Mode = 'versus' | 'coop';

export interface RoomSettings {
  mode: Mode;
  mapId: string;
  /** Seed of a generated random battlefield (mapId 'random'). */
  mapSeed?: number;
  /** Versus: the host's side (the guest gets the other). Co-op: the players' side. */
  side: Side;
  /** Minutes. */
  minutes: number;
  /** Requisition points per player. */
  budget: number;
  /** Co-op: the AI enemy's quality. */
  enemy: 'green' | 'regular' | 'veteran' | 'elite';
}

export interface PlayerInfo {
  slot: number;
  name: string;
  side: Side;
  ready: boolean;
  connected: boolean;
  force: ForceEntry[];
}

export interface RoomState {
  code: string;
  host: number;
  phase: 'lobby' | 'battle' | 'ended';
  settings: RoomSettings;
  players: PlayerInfo[];
}

/** Everything a battle needs, identical for every player (built by the host). */
export interface NetSetup {
  setup: BattleSetup;
  title: string;
  mode: Mode;
  players: { slot: number; name: string; side: Side }[];
  /** Map definition for generated battlefields (everyone registers it). */
  mapSeed?: number;
}

/** A player's instruction to the battle. Applied at the same step by everyone. */
export type Command =
  | { k: 'order'; unit: number; kind: OrderKind; target?: Vec2; targetUnit?: number; facing?: number }
  | { k: 'place'; unit: number; x: number; y: number }
  | { k: 'face'; unit: number; facing: number }
  | { k: 'ready' }
  | { k: 'pause' }
  | { k: 'resume' }
  | { k: 'withdraw' }
  | { k: 'ceasefire' };

/** One player's commands for one step, plus an occasional checksum of their state. */
export interface StepBatch {
  s: number;
  c?: Command[];
  /** Checksum of the world after step `hs` (desync detection). */
  h?: number;
  hs?: number;
}

export type ClientMsg =
  | { t: 'create'; name: string; settings: RoomSettings }
  | { t: 'join'; room: string; name: string; token?: string }
  | { t: 'settings'; settings: RoomSettings }
  | { t: 'force'; force: ForceEntry[] }
  | { t: 'ready'; ready: boolean }
  | { t: 'launch'; net: NetSetup }
  | ({ t: 'step' } & StepBatch)
  | { t: 'chat'; text: string }
  /** Stuck waiting for someone's step: ask for the log again (answered with 'resume'). */
  | { t: 'sync' }
  | { t: 'leave' };

export type ServerMsg =
  | { t: 'welcome'; room: string; slot: number; token: string }
  | { t: 'room'; state: RoomState }
  | { t: 'start'; net: NetSetup }
  /** Rejoining a battle in progress: every batch so far, and how far each player got. */
  | { t: 'resume'; net: NetSetup; log: ({ p: number } & StepBatch)[]; last: Record<number, number> }
  | ({ t: 'step'; p: number } & StepBatch)
  | { t: 'presence'; slot: number; connected: boolean }
  | { t: 'drop'; slot: number; from: number }
  | { t: 'chat'; slot: number; name: string; text: string }
  | { t: 'error'; msg: string };
