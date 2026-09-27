import type { Side, UnitTemplate, VehicleDef } from '../data/units';
import type { WeaponDef } from '../data/weapons';
import type { Vec2 } from './math';

export type Stance = 'stand' | 'crouch' | 'prone';
export type Health = 'ok' | 'wounded' | 'incap' | 'dead';
export type MoraleState = 'ready' | 'pinned' | 'cowering' | 'panicked' | 'routing' | 'surrendered' | 'berserk';
export type MoveMode = 'walk' | 'run' | 'sneak';

export type OrderKind =
  | 'none'
  | 'move'
  | 'moveFast'
  | 'sneak'
  | 'reverse'
  | 'fire'
  | 'smoke'
  | 'defend'
  | 'ambush'
  | 'mount'
  | 'dismount'
  | 'callFire'
  | 'uav'
  | 'strike';

export interface Order {
  kind: OrderKind;
  /** Destination / aim point. */
  target?: Vec2;
  /** Target unit (fire/strike) or vehicle unit to mount. */
  targetUnit?: number;
  /** Facing for defend/ambush (radians). */
  facing?: number;
  issuedAt: number;
}

export interface WeaponState {
  def: WeaponDef;
  ammo: number;
  loaded: number;
  cooldown: number;
  reloadT: number;
  aimT: number;
  /** Key of the target currently aimed at ("s:12", "v:3", "p:x:y"). */
  aimKey: string | null;
  mount?: 'turret' | 'hull' | 'rws';
  crewIdx?: number;
  disabled?: boolean;
}

export type TargetRef = { kind: 'soldier'; id: number } | { kind: 'vehicle'; id: number } | { kind: 'point'; x: number; y: number };

export interface Soldier {
  id: number;
  unitId: number;
  side: Side;
  name: string;
  rank: string;
  role: string;
  leader: boolean;
  x: number;
  y: number;
  px: number; // previous tick position (render interpolation)
  py: number;
  facing: number;
  stance: Stance;
  health: Health;
  morale: number;
  baseMorale: number;
  supp: number;
  fatigue: number;
  exp: number;
  state: MoraleState;
  stateT: number;
  bodyArmor: number;
  weapons: WeaponState[];
  /** Index of the weapon being used right now. */
  wIdx: number;
  target: TargetRef | null;
  retargetT: number;
  firedT: number; // time of last shot (for spotting / animation)
  /** Movement */
  path: Vec2[] | null;
  pathIdx: number;
  moveMode: MoveMode;
  moveDelay: number;
  moving: boolean;
  /** Final slot for current order. */
  slot: Vec2 | null;
  /** Vehicle this soldier is inside (crew or passenger), -1 if on foot. */
  vehicle: number;
  crewSeat: number; // index in vehicle crew, -1 if passenger / not crew
  kills: number;
  hitsTaken: number;
  /** Timer for panic flight destination refresh. */
  fleeT: number;
  /** Ran off the map (routed). */
  fled: boolean;
  /** Seconds without progress toward the current waypoint. */
  stuckT: number;
  /** LOS obstruction to current target (0..1). */
  tObs: number;
}

export interface VehicleState {
  id: number;
  unitId: number;
  side: Side;
  def: VehicleDef;
  x: number;
  y: number;
  px: number;
  py: number;
  heading: number;
  pheading: number;
  turret: number; // absolute world angle of turret
  pturret: number;
  speed: number;
  reversing: boolean;
  path: Vec2[] | null;
  pathIdx: number;
  crew: number[]; // soldier ids by seat
  passengers: number[]; // unit ids carried
  weapons: WeaponState[];
  destroyed: boolean;
  burning: number; // seconds of fire remaining
  immobilized: boolean;
  gunDamaged: boolean;
  apsCharges: number;
  smokeSalvos: number;
  firedT: number;
  /** Shock from non-penetrating hits, decays; degrades crew performance. */
  shock: number;
  abandoned: boolean;
  lastHitT: number;
  lastThreatDir: number | null;
  /** Earliest time the vehicle may re-plan a blocked route. */
  replanT: number;
  /** Per-weapon current target (parallel to weapons[]). */
  tgts: (TargetRef | null)[];
  lastKeys: (string | null)[];
}

export interface Unit {
  id: number;
  side: Side;
  template: UnitTemplate;
  name: string;
  soldiers: number[];
  vehicle: number; // -1 if infantry
  /** Vehicle the infantry is embarked in, -1 otherwise. */
  mountedIn: number;
  order: Order;
  /** Commander's intent position for defend/ambush (hold area). */
  holdPos: Vec2 | null;
  facing: number;
  charges: number;
  expLevel: number;
  /** Unit has been fired upon recently (for ambush triggers / AI) */
  underFireT: number;
  lastCasualtyT: number;
  /** Status summary (updated each tick). */
  alive: number;
  effective: number;
  stateLabel: string;
  /** Removed from play (all dead / surrendered / vehicle destroyed). */
  eliminated: boolean;
  /** Retreated off map. */
  withdrawn: boolean;
  /** Persistent identity for campaign carry-over. */
  campaignId?: string;
  /** AI scratch data. */
  ai: { task?: string; goal?: Vec2; t?: number; group?: number; waitT?: number; sprungT?: number; threatDir?: number; smoke?: number };
  /** Set when a crew bails out from a destroyed vehicle. */
  isCrew?: boolean;
  /** Initial strength for casualty accounting. */
  initialSoldiers: number;
}

export interface Projectile {
  id: number;
  weapon: WeaponDef;
  side: Side;
  shooterSoldier: number;
  shooterVehicle: number;
  sx: number;
  sy: number;
  sz: number;
  tx: number;
  ty: number;
  tz: number;
  x: number;
  y: number;
  z: number;
  px: number;
  py: number;
  pz: number;
  t: number;
  T: number;
  arc: number;
  target: TargetRef | null;
  willHit: boolean;
  /** For off-map artillery: overrides the weapon's blast parameters. */
  heavy?: { blast: number; lethality: number; pen: number; suppression: number; suppRadius: number };
  kind: 'direct' | 'indirect' | 'thrown' | 'artillery';
  smoke?: boolean;
  /** Fired at a vehicle (AP ammunition: no HE burst on a miss). */
  atVehicle?: boolean;
  dead: boolean;
}

export interface Drone {
  id: number;
  side: Side;
  unitId: number;
  kind: 'recon' | 'strike';
  x: number;
  y: number;
  z: number;
  px: number;
  py: number;
  pz: number;
  heading: number;
  tx: number;
  ty: number;
  targetUnit: number;
  life: number;
  speed: number;
  dead: boolean;
  /** Orbit phase for recon drones. */
  phase: number;
  model: 'quad' | 'fixed';
}

export interface FireMission {
  id: number;
  side: Side;
  x: number;
  y: number;
  roundsLeft: number;
  t: number;
  nextT: number;
  unitId: number;
  smoke: boolean;
}

export interface SpotInfo {
  unitId: number;
  visible: boolean;
  lastSeen: number;
  x: number;
  y: number;
  firstSeen: number;
}

export interface VictoryLocation {
  id: string;
  name: string;
  x: number;
  y: number;
  r: number;
  value: number;
  owner: Side | null;
  contested: boolean;
  holdT: number;
  holdSide: Side | null;
}

export type ExplosionKind = 'he' | 'at' | 'artillery' | 'mortar' | 'grenade' | 'vehicle' | 'aps' | 'smoke' | 'drone' | 'small';

export type SimEvent =
  | {
      type: 'shot';
      weapon: string;
      side: Side;
      sx: number;
      sy: number;
      sz: number;
      tx: number;
      ty: number;
      tz: number;
      rounds: number;
      interval: number;
      soldier: number;
      vehicle: number;
    }
  | { type: 'launch'; weapon: string; side: Side; x: number; y: number; z: number; soldier: number; vehicle: number }
  | { type: 'explosion'; x: number; y: number; z: number; size: number; kind: ExplosionKind }
  | { type: 'impact'; x: number; y: number; z: number; kind: 'ricochet' | 'penetrate' | 'bounce' | 'dirt' }
  | { type: 'casualty'; soldier: number; health: Health; side: Side }
  | { type: 'vehicleKilled'; vehicle: number; side: Side; burning: boolean }
  | { type: 'message'; side: Side | 'all'; text: string; unit: number; level: 'info' | 'warn' | 'alert' | 'good' }
  | { type: 'vl'; id: string; owner: Side | null }
  | { type: 'smoke'; x: number; y: number; r: number }
  | { type: 'building'; id: number };

export interface SideConfig {
  ai: boolean;
  posture: 'attack' | 'defend';
  /** Direction units retreat toward (friendly map edge), unit vector. */
  rear: Vec2;
}

export interface BattleResult {
  winner: Side | null;
  grade: 'decisive' | 'victory' | 'draw';
  reason: string;
  vlPoints: Record<Side, number>;
  casualties: Record<Side, { killed: number; wounded: number; captured: number; vehiclesLost: number }>;
  duration: number;
}
