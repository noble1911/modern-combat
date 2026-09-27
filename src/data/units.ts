import type { Mobility } from '../sim/terrain';

export type Side = 'nato' | 'opfor';
export const otherSide = (s: Side): Side => (s === 'nato' ? 'opfor' : 'nato');

export interface FactionDef {
  id: Side;
  name: string;
  short: string;
  color: number; // UI colour
  uniform: number; // model tint
  paint: number; // vehicle tint
  gear: number;
}

export const FACTIONS: Record<Side, FactionDef> = {
  nato: { id: 'nato', name: 'U.S. Army — Task Force Iron', short: 'NATO', color: 0x4aa3ff, uniform: 0x8b8a66, paint: 0x7d7a5c, gear: 0x6b6648 },
  opfor: { id: 'opfor', name: 'Northern Federation Ground Forces', short: 'OPFOR', color: 0xff5a4a, uniform: 0x5d6b47, paint: 0x4f5a3a, gear: 0x4a5236 },
};

export type Symbol = 'inf' | 'mg' | 'at' | 'sniper' | 'mortar' | 'hq' | 'recon' | 'armor' | 'ifv' | 'apc' | 'car' | 'agl';

export type Ability = 'callFire' | 'uav' | 'fpv' | 'loiter';

export interface SoldierSpec {
  role: string;
  rank: string;
  /** [weaponId, rounds] – first entry is the primary weapon. */
  weapons: [string, number][];
  leader?: boolean;
}

export interface VehicleWeaponSpec {
  weapon: string;
  ammo: number;
  mount: 'turret' | 'hull' | 'rws';
  /** Which crew position operates it (index into crew). */
  crew: number;
}

export interface VehicleDef {
  id: string;
  name: string;
  model: string;
  mobility: Mobility;
  maxSpeed: number; // m/s on road
  accel: number;
  turnRate: number; // rad/s
  turretRate: number; // rad/s
  armor: { front: number; side: number; rear: number; top: number };
  /** Multiplier applied to front/side armour against HEAT (composite armour). */
  compositeHEAT: number;
  era: boolean;
  slat: boolean;
  aps?: { charges: number; p: number };
  crewRoles: string[];
  seats: number;
  weapons: VehicleWeaponSpec[];
  thermal: boolean;
  smokeSalvos: number;
  length: number;
  width: number;
  height: number;
  /** Eye height of the commander/sights. */
  eye: number;
}

export const VEHICLES: Record<string, VehicleDef> = {
  m1a2: {
    id: 'm1a2', name: 'M1A2 SEPv3 Abrams', model: 'm1a2', mobility: 'track', maxSpeed: 16, accel: 2.5, turnRate: 0.7, turretRate: 0.8,
    armor: { front: 820, side: 110, rear: 55, top: 40 }, compositeHEAT: 1.5, era: false, slat: false, aps: { charges: 4, p: 0.85 },
    crewRoles: ['Commander', 'Gunner', 'Loader', 'Driver'], seats: 0,
    weapons: [
      { weapon: 'm256', ammo: 40, mount: 'turret', crew: 1 },
      { weapon: 'm240c', ammo: 4000, mount: 'turret', crew: 1 },
      { weapon: 'm2hb', ammo: 900, mount: 'rws', crew: 0 },
    ],
    thermal: true, smokeSalvos: 2, length: 7.9, width: 3.7, height: 2.4, eye: 2.8,
  },
  m2a4: {
    id: 'm2a4', name: 'M2A4 Bradley', model: 'm2a4', mobility: 'track', maxSpeed: 15, accel: 2.8, turnRate: 0.8, turretRate: 1.0,
    armor: { front: 65, side: 35, rear: 25, top: 20 }, compositeHEAT: 1.2, era: false, slat: false,
    crewRoles: ['Commander', 'Gunner', 'Driver'], seats: 9,
    weapons: [
      { weapon: 'm242', ammo: 900, mount: 'turret', crew: 1 },
      { weapon: 'tow', ammo: 6, mount: 'turret', crew: 1 },
      { weapon: 'm240c', ammo: 2200, mount: 'turret', crew: 1 },
    ],
    thermal: true, smokeSalvos: 2, length: 6.6, width: 3.3, height: 3.0, eye: 3.0,
  },
  stryker: {
    id: 'stryker', name: 'M1126 Stryker ICV', model: 'stryker', mobility: 'wheel', maxSpeed: 22, accel: 3.0, turnRate: 0.6, turretRate: 1.4,
    armor: { front: 28, side: 20, rear: 16, top: 12 }, compositeHEAT: 1.0, era: false, slat: true,
    crewRoles: ['Vehicle Commander', 'Driver'], seats: 9,
    weapons: [{ weapon: 'm2hb', ammo: 2000, mount: 'rws', crew: 0 }],
    thermal: true, smokeSalvos: 2, length: 7.0, width: 2.7, height: 2.6, eye: 2.8,
  },
  jltv: {
    id: 'jltv', name: 'M1278 JLTV (CROWS)', model: 'jltv', mobility: 'wheel', maxSpeed: 24, accel: 3.5, turnRate: 0.7, turretRate: 1.5,
    armor: { front: 14, side: 12, rear: 10, top: 8 }, compositeHEAT: 1.0, era: false, slat: false,
    crewRoles: ['Commander', 'Driver', 'Gunner'], seats: 2,
    weapons: [{ weapon: 'm2hb', ammo: 1200, mount: 'rws', crew: 2 }],
    thermal: true, smokeSalvos: 1, length: 6.2, width: 2.5, height: 2.6, eye: 2.6,
  },
  t90m: {
    id: 't90m', name: 'T-90M Proryv', model: 't90m', mobility: 'track', maxSpeed: 15, accel: 2.4, turnRate: 0.7, turretRate: 0.7,
    armor: { front: 740, side: 90, rear: 50, top: 35 }, compositeHEAT: 1.35, era: true, slat: false,
    crewRoles: ['Commander', 'Gunner', 'Driver'], seats: 0,
    weapons: [
      { weapon: 'a46m5', ammo: 40, mount: 'turret', crew: 1 },
      { weapon: 'pktm', ammo: 2000, mount: 'turret', crew: 1 },
      { weapon: 'kord', ammo: 300, mount: 'rws', crew: 0 },
    ],
    thermal: true, smokeSalvos: 2, length: 6.9, width: 3.8, height: 2.2, eye: 2.6,
  },
  t72b3: {
    id: 't72b3', name: 'T-72B3M', model: 't72b3', mobility: 'track', maxSpeed: 15, accel: 2.3, turnRate: 0.7, turretRate: 0.6,
    armor: { front: 620, side: 80, rear: 45, top: 30 }, compositeHEAT: 1.3, era: true, slat: false,
    crewRoles: ['Commander', 'Gunner', 'Driver'], seats: 0,
    weapons: [
      { weapon: 'a46m', ammo: 44, mount: 'turret', crew: 1 },
      { weapon: 'pktm', ammo: 2000, mount: 'turret', crew: 1 },
      { weapon: 'kord', ammo: 300, mount: 'rws', crew: 0 },
    ],
    thermal: true, smokeSalvos: 2, length: 6.9, width: 3.6, height: 2.2, eye: 2.6,
  },
  bmp3: {
    id: 'bmp3', name: 'BMP-3', model: 'bmp3', mobility: 'track', maxSpeed: 16, accel: 2.8, turnRate: 0.8, turretRate: 0.9,
    armor: { front: 45, side: 20, rear: 15, top: 12 }, compositeHEAT: 1.0, era: false, slat: false,
    crewRoles: ['Commander', 'Gunner', 'Driver'], seats: 8,
    weapons: [
      { weapon: 'a70', ammo: 40, mount: 'turret', crew: 1 },
      { weapon: 'arkan', ammo: 4, mount: 'turret', crew: 1 },
      { weapon: 'a72', ammo: 500, mount: 'turret', crew: 1 },
      { weapon: 'pktm', ammo: 2000, mount: 'turret', crew: 1 },
    ],
    thermal: true, smokeSalvos: 1, length: 7.1, width: 3.2, height: 2.4, eye: 2.6,
  },
  btr82a: {
    id: 'btr82a', name: 'BTR-82A', model: 'btr82a', mobility: 'wheel', maxSpeed: 20, accel: 2.8, turnRate: 0.55, turretRate: 1.0,
    armor: { front: 20, side: 12, rear: 10, top: 8 }, compositeHEAT: 1.0, era: false, slat: false,
    crewRoles: ['Commander', 'Gunner', 'Driver'], seats: 8,
    weapons: [
      { weapon: 'a72', ammo: 300, mount: 'turret', crew: 1 },
      { weapon: 'pktm', ammo: 2000, mount: 'turret', crew: 1 },
    ],
    thermal: true, smokeSalvos: 1, length: 7.6, width: 2.9, height: 2.8, eye: 2.8,
  },
  tigr: {
    id: 'tigr', name: 'Tigr-M', model: 'tigr', mobility: 'wheel', maxSpeed: 24, accel: 3.4, turnRate: 0.7, turretRate: 1.4,
    armor: { front: 12, side: 10, rear: 8, top: 6 }, compositeHEAT: 1.0, era: false, slat: false,
    crewRoles: ['Commander', 'Driver', 'Gunner'], seats: 3,
    weapons: [{ weapon: 'kord', ammo: 600, mount: 'rws', crew: 2 }],
    thermal: false, smokeSalvos: 0, length: 5.7, width: 2.4, height: 2.4, eye: 2.4,
  },
};

export interface UnitTemplate {
  id: string;
  name: string;
  short: string;
  side: Side;
  symbol: Symbol;
  cost: number;
  soldiers?: SoldierSpec[];
  vehicle?: string;
  abilities?: Ability[];
  /** Uses for abilities (fire missions, drones). */
  charges?: number;
  description: string;
}

const S = (role: string, rank: string, weapons: [string, number][], leader = false): SoldierSpec => ({ role, rank, weapons, leader });

export const UNITS: Record<string, UnitTemplate> = {
  // ------------------------------- NATO -------------------------------
  us_rifle: {
    id: 'us_rifle', name: 'Rifle Squad', short: 'Rifle Sqd', side: 'nato', symbol: 'inf', cost: 90,
    description: 'Nine-man air assault rifle squad: two fire teams with M250 automatic rifles, M320 grenade launchers and AT4s.',
    soldiers: [
      S('Squad Leader', 'SSG', [['m7', 180], ['m67', 2]], true),
      S('Team Leader', 'SGT', [['m7', 180], ['m67', 2]]),
      S('Automatic Rifleman', 'SPC', [['m250', 600]]),
      S('Grenadier', 'SPC', [['m7', 140], ['m320', 10]]),
      S('Rifleman', 'PFC', [['m7', 180], ['at4', 1], ['m67', 2]]),
      S('Team Leader', 'SGT', [['m7', 180], ['m67', 2]]),
      S('Automatic Rifleman', 'SPC', [['m250', 600]]),
      S('Grenadier', 'SPC', [['m7', 140], ['m320', 10]]),
      S('Rifleman', 'PFC', [['m7', 180], ['at4', 1], ['m67', 2]]),
    ],
  },
  us_mg: {
    id: 'us_mg', name: 'M240 Gun Team', short: 'MG Tm', side: 'nato', symbol: 'mg', cost: 55,
    description: 'Medium machine gun team. Excellent suppression out to a kilometre.',
    soldiers: [
      S('Gunner', 'SPC', [['m240', 900]], true),
      S('Assistant Gunner', 'PFC', [['m7', 140]]),
      S('Ammo Bearer', 'PFC', [['m7', 140], ['m67', 2]]),
    ],
  },
  us_javelin: {
    id: 'us_javelin', name: 'Javelin Team', short: 'Javelin', side: 'nato', symbol: 'at', cost: 80,
    description: 'Fire-and-forget top-attack ATGM. Kills any tank it can see out to 2.5 km.',
    soldiers: [
      S('Gunner', 'SGT', [['javelin', 3], ['m4', 120]], true),
      S('Assistant Gunner', 'SPC', [['m7', 140]]),
    ],
  },
  us_gustaf: {
    id: 'us_gustaf', name: 'Carl Gustaf Team', short: 'Gustaf', side: 'nato', symbol: 'at', cost: 55,
    description: 'M3E1 84mm recoilless rifle. Effective against light armour, buildings and infantry.',
    soldiers: [
      S('Gunner', 'SGT', [['m3e1', 8], ['m4', 90]], true),
      S('Loader', 'SPC', [['m7', 140]]),
    ],
  },
  us_sniper: {
    id: 'us_sniper', name: 'Sniper Team', short: 'Sniper', side: 'nato', symbol: 'sniper', cost: 50,
    description: 'Long-range precision fire. Hard to spot.',
    soldiers: [
      S('Sniper', 'SGT', [['mk22', 40]], true),
      S('Spotter', 'SPC', [['m110', 100]]),
    ],
  },
  us_mortar: {
    id: 'us_mortar', name: '60mm Mortar Section', short: '60mm Mtr', side: 'nato', symbol: 'mortar', cost: 60,
    description: 'Indirect fire on any point a friendly unit can see.',
    soldiers: [
      S('Gunner', 'SGT', [['m224', 36], ['m4', 90]], true),
      S('Assistant Gunner', 'SPC', [['m4', 90]]),
      S('Ammo Bearer', 'PFC', [['m4', 90]]),
    ],
  },
  us_hq: {
    id: 'us_hq', name: 'Platoon HQ / JTAC', short: 'PL HQ', side: 'nato', symbol: 'hq', cost: 70, abilities: ['callFire'], charges: 2,
    description: 'Platoon leader and fire support team. Calls 155mm artillery missions. Boosts nearby morale.',
    soldiers: [
      S('Platoon Leader', '1LT', [['m4', 150]], true),
      S('Forward Observer', 'SGT', [['m4', 150]]),
      S('RTO', 'SPC', [['m7', 140]]),
    ],
  },
  us_uas: {
    id: 'us_uas', name: 'UAS Team (Switchblade)', short: 'UAS Tm', side: 'nato', symbol: 'recon', cost: 75, abilities: ['uav', 'loiter'], charges: 3,
    description: 'Flies a recon quadcopter for overhead spotting and launches Switchblade 600 loitering munitions.',
    soldiers: [
      S('UAS Operator', 'SGT', [['m4', 120]], true),
      S('Assistant Operator', 'SPC', [['m7', 140]]),
    ],
  },
  us_crew: { id: 'us_crew', name: 'Vehicle Crew', short: 'Crew', side: 'nato', symbol: 'inf', cost: 10, soldiers: [], description: 'Bailed-out vehicle crew armed with carbines.' },
  us_m1a2: { id: 'us_m1a2', name: 'M1A2 SEPv3 Abrams', short: 'Abrams', side: 'nato', symbol: 'armor', cost: 220, vehicle: 'm1a2', description: 'Main battle tank with Trophy active protection.' },
  us_m2a4: { id: 'us_m2a4', name: 'M2A4 Bradley', short: 'Bradley', side: 'nato', symbol: 'ifv', cost: 140, vehicle: 'm2a4', description: 'Infantry fighting vehicle: 25mm chain gun, TOW-2B missiles, carries a rifle squad.' },
  us_stryker: { id: 'us_stryker', name: 'M1126 Stryker', short: 'Stryker', side: 'nato', symbol: 'apc', cost: 90, vehicle: 'stryker', description: 'Wheeled infantry carrier with slat armour and a .50 cal RWS. Carries 9.' },
  us_jltv: { id: 'us_jltv', name: 'JLTV (M2 CROWS)', short: 'JLTV', side: 'nato', symbol: 'car', cost: 60, vehicle: 'jltv', description: 'Light armoured vehicle with a remote .50 cal. Fast scout.' },

  // ------------------------------- OPFOR -------------------------------
  ru_rifle: {
    id: 'ru_rifle', name: 'Motor Rifle Squad', short: 'MR Sqd', side: 'opfor', symbol: 'inf', cost: 80,
    description: 'Eight-man motor rifle squad with PKP machine gun, RPG-7V2 and GP-34 grenade launchers.',
    soldiers: [
      S('Squad Leader', 'Sgt.', [['ak12', 240], ['rgd5', 2]], true),
      S('Machine Gunner', 'Pvt.', [['pkp', 650]]),
      S('Grenadier (RPG)', 'Cpl.', [['rpg7', 4], ['ak12', 90]]),
      S('Asst. Grenadier', 'Pvt.', [['ak12', 180], ['rpg26', 1]]),
      S('Marksman', 'Cpl.', [['svdm', 60]]),
      S('Rifleman', 'Pvt.', [['ak12', 180], ['gp34', 10]]),
      S('Rifleman', 'Pvt.', [['ak12', 240], ['rpg26', 1], ['rgd5', 2]]),
      S('Rifleman', 'Pvt.', [['ak12', 240], ['rgd5', 2]]),
    ],
  },
  ru_mg: {
    id: 'ru_mg', name: 'PKP Team', short: 'MG Tm', side: 'opfor', symbol: 'mg', cost: 50,
    description: 'Machine gun team.',
    soldiers: [
      S('Gunner', 'Cpl.', [['pkp', 900]], true),
      S('Assistant', 'Pvt.', [['ak12', 180]]),
      S('Ammo Bearer', 'Pvt.', [['ak12', 180], ['rgd5', 2]]),
    ],
  },
  ru_kornet: {
    id: 'ru_kornet', name: 'Kornet ATGM Team', short: 'Kornet', side: 'opfor', symbol: 'at', cost: 75,
    description: 'Laser beam-riding ATGM with extreme range and penetration. Operator must keep line of sight.',
    soldiers: [
      S('Operator', 'Sgt.', [['kornet', 4], ['ak12', 90]], true),
      S('Asst. Operator', 'Pvt.', [['ak12', 180]]),
      S('Ammo Bearer', 'Pvt.', [['ak12', 180]]),
    ],
  },
  ru_ags: {
    id: 'ru_ags', name: 'AGS-30 Team', short: 'AGS-30', side: 'opfor', symbol: 'agl', cost: 55,
    description: 'Automatic grenade launcher. Saturates an area with 30mm HE.',
    soldiers: [
      S('Gunner', 'Sgt.', [['ags30', 145], ['ak12', 90]], true),
      S('Assistant', 'Pvt.', [['ak12', 180]]),
      S('Ammo Bearer', 'Pvt.', [['ak12', 180]]),
    ],
  },
  ru_sniper: {
    id: 'ru_sniper', name: 'Sniper Pair', short: 'Sniper', side: 'opfor', symbol: 'sniper', cost: 45,
    description: 'Long-range precision fire.',
    soldiers: [
      S('Sniper', 'Sgt.', [['sv98', 40]], true),
      S('Spotter', 'Cpl.', [['svdm', 60]]),
    ],
  },
  ru_mortar: {
    id: 'ru_mortar', name: '82mm Mortar Crew', short: '82mm Mtr', side: 'opfor', symbol: 'mortar', cost: 55,
    description: 'Indirect fire on any point a friendly unit can see.',
    soldiers: [
      S('Gunner', 'Sgt.', [['b14', 36], ['ak12', 90]], true),
      S('Loader', 'Pvt.', [['ak12', 90]]),
      S('Ammo Bearer', 'Pvt.', [['ak12', 90]]),
    ],
  },
  ru_hq: {
    id: 'ru_hq', name: 'Platoon HQ / Artillery Spotter', short: 'PL HQ', side: 'opfor', symbol: 'hq', cost: 65, abilities: ['callFire'], charges: 2,
    description: 'Platoon commander and artillery spotter. Calls 152mm missions. Boosts nearby morale.',
    soldiers: [
      S('Platoon Cmdr', 'Lt.', [['ak12', 180]], true),
      S('Arty Spotter', 'Sgt.', [['ak12', 180]]),
      S('Radio Operator', 'Pvt.', [['ak12', 180]]),
    ],
  },
  ru_uas: {
    id: 'ru_uas', name: 'Drone Team (Lancet / FPV)', short: 'Drone Tm', side: 'opfor', symbol: 'recon', cost: 70, abilities: ['uav', 'fpv'], charges: 4,
    description: 'Orlan-type recon drone for overhead spotting plus FPV kamikaze drones.',
    soldiers: [
      S('Drone Operator', 'Sgt.', [['ak12', 120]], true),
      S('Assistant', 'Pvt.', [['ak12', 180]]),
    ],
  },
  ru_crew: { id: 'ru_crew', name: 'Vehicle Crew', short: 'Crew', side: 'opfor', symbol: 'inf', cost: 10, soldiers: [], description: 'Bailed-out vehicle crew armed with carbines.' },
  ru_t90m: { id: 'ru_t90m', name: 'T-90M Proryv', short: 'T-90M', side: 'opfor', symbol: 'armor', cost: 200, vehicle: 't90m', description: 'Modern main battle tank with Relikt ERA.' },
  ru_t72b3: { id: 'ru_t72b3', name: 'T-72B3M', short: 'T-72B3', side: 'opfor', symbol: 'armor', cost: 160, vehicle: 't72b3', description: 'Upgraded T-72 with Kontakt-5 ERA.' },
  ru_bmp3: { id: 'ru_bmp3', name: 'BMP-3', short: 'BMP-3', side: 'opfor', symbol: 'ifv', cost: 130, vehicle: 'bmp3', description: 'IFV with 100mm gun/ATGM launcher and 30mm cannon. Carries a motor rifle squad.' },
  ru_btr82a: { id: 'ru_btr82a', name: 'BTR-82A', short: 'BTR-82A', side: 'opfor', symbol: 'apc', cost: 85, vehicle: 'btr82a', description: 'Wheeled APC with 30mm cannon. Carries a motor rifle squad.' },
  ru_tigr: { id: 'ru_tigr', name: 'Tigr-M', short: 'Tigr', side: 'opfor', symbol: 'car', cost: 50, vehicle: 'tigr', description: 'Armoured car with Kord HMG.' },
};

export function unitTemplate(id: string): UnitTemplate {
  const t = UNITS[id];
  if (!t) throw new Error(`Unknown unit template ${id}`);
  return t;
}

/** Off-map fire support available through `callFire` units. */
export interface FireSupportDef {
  name: string;
  weapon: { blast: number; lethality: number; pen: number; suppression: number; suppRadius: number };
  rounds: number;
  spread: number; // metres (sd of impact scatter)
  delay: number; // seconds from call to first impact
  interval: number; // seconds between rounds
}

export const FIRE_SUPPORT: Record<Side, FireSupportDef> = {
  nato: { name: '155mm M777 battery', weapon: { blast: 12, lethality: 0.42, pen: 60, suppression: 70, suppRadius: 32 }, rounds: 8, spread: 32, delay: 40, interval: 1.1 },
  opfor: { name: '152mm 2S19 Msta battery', weapon: { blast: 12, lethality: 0.42, pen: 60, suppression: 70, suppRadius: 32 }, rounds: 9, spread: 38, delay: 45, interval: 1.0 },
};

export const NAMES: Record<Side, string[]> = {
  nato: [
    'Alvarez', 'Baker', 'Brooks', 'Carter', 'Chen', 'Collins', 'Davis', 'Diaz', 'Edwards', 'Evans', 'Foster', 'Garcia', 'Gonzalez', 'Gray', 'Green', 'Hall',
    'Harris', 'Hayes', 'Hernandez', 'Hill', 'Jackson', 'James', 'Johnson', 'Jones', 'Kelly', 'Kim', 'King', 'Lee', 'Lewis', 'Lopez', 'Martin', 'Martinez',
    'Miller', 'Mitchell', 'Moore', 'Morgan', 'Murphy', 'Nelson', 'Nguyen', 'Ortiz', 'Parker', 'Patel', 'Perez', 'Phillips', 'Price', 'Ramirez', 'Reed',
    'Reyes', 'Richardson', 'Rivera', 'Roberts', 'Robinson', 'Rodriguez', 'Ross', 'Russell', 'Sanchez', 'Scott', 'Smith', 'Stewart', 'Sullivan', 'Taylor',
    'Thomas', 'Thompson', 'Torres', 'Turner', 'Walker', 'Ward', 'Washington', 'Watson', 'White', 'Williams', 'Wilson', 'Wood', 'Wright', 'Young', 'Okafor',
    'Kowalski', 'Novak', 'Brennan', 'Delgado', 'Yazzie', 'Tanaka', 'Haddad', 'Mensah', 'Schultz', 'Lindqvist',
  ],
  opfor: [
    'Ivanov', 'Smirnov', 'Kuznetsov', 'Popov', 'Vasiliev', 'Petrov', 'Sokolov', 'Mikhailov', 'Novikov', 'Fedorov', 'Morozov', 'Volkov', 'Alekseev',
    'Lebedev', 'Semenov', 'Egorov', 'Pavlov', 'Kozlov', 'Stepanov', 'Nikolaev', 'Orlov', 'Andreev', 'Makarov', 'Nikitin', 'Zakharov', 'Zaitsev',
    'Soloviev', 'Borisov', 'Yakovlev', 'Grigoriev', 'Romanov', 'Vorobiev', 'Sergeev', 'Kuzmin', 'Frolov', 'Aleksandrov', 'Dmitriev', 'Korolev',
    'Gusev', 'Kiselev', 'Ilyin', 'Maksimov', 'Polyakov', 'Sorokin', 'Vinogradov', 'Kovalev', 'Belov', 'Medvedev', 'Antonov', 'Tarasov', 'Zhukov',
    'Baranov', 'Filippov', 'Komarov', 'Davydov', 'Belyaev', 'Gerasimov', 'Bogdanov', 'Osipov', 'Sidorov', 'Matveev', 'Titov', 'Markov', 'Mironov',
    'Krylov', 'Kulikov', 'Karpov', 'Vlasov', 'Melnikov', 'Denisov', 'Gavrilov', 'Tikhonov', 'Kazakov', 'Afanasiev', 'Danilov', 'Savelyev',
  ],
};

export const EXPERIENCE_LEVELS = {
  green: 0.35,
  regular: 0.55,
  veteran: 0.72,
  elite: 0.88,
} as const;
export type ExperienceLevel = keyof typeof EXPERIENCE_LEVELS;
