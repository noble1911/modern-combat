// Weapon database. Numbers are gameplay-tuned approximations of real systems, not exact data.

export type WeaponClass =
  | 'rifle'
  | 'ar'
  | 'mg'
  | 'hmg'
  | 'dmr'
  | 'sniper'
  | 'gl'
  | 'agl'
  | 'grenade'
  | 'rocket'
  | 'atgm'
  | 'autocannon'
  | 'tankgun'
  | 'mortar'
  | 'smoke';

export type SoundKind = 'rifle' | 'mg' | 'hmg' | 'sniper' | 'gl' | 'cannon' | 'tankgun' | 'rocket' | 'atgm' | 'mortar' | 'grenade';

export interface WeaponDef {
  id: string;
  name: string;
  cls: WeaponClass;
  /** Maximum engagement range (m). */
  range: number;
  minRange?: number;
  /** Range at which per-shot accuracy halves. */
  halfRange: number;
  /** Per-round hit probability vs an exposed standing man at very short range. */
  accuracy: number;
  burst: [number, number];
  /** Seconds between rounds inside a burst (visual pacing only). */
  shotInterval: number;
  /** Seconds between bursts. */
  cycle: number;
  /** Seconds to acquire a new target. */
  aimTime: number;
  mag: number;
  reload: number;
  /** Chance a hit on a soldier kills/incapacitates (otherwise wounds). */
  lethality: number;
  /** Blast radius (m) for HE effects. */
  blast?: number;
  /** Armour penetration (mm RHA). */
  pen: number;
  heat?: boolean;
  tandem?: boolean;
  topAttack?: boolean;
  /** Projectile speed (m/s). Undefined = resolved instantly (small arms). */
  speed?: number;
  guidance?: 'saclos' | 'fnf';
  indirect?: boolean;
  /** Suppression added per round to the target area. */
  suppression: number;
  suppRadius: number;
  /** Prefers armoured targets. */
  antiArmor: boolean;
  /** Will engage infantry. */
  antiPersonnel: boolean;
  sound: SoundKind;
  tracer?: number; // hex colour
  /** Rounds only visible every Nth shot. */
  tracerEvery?: number;
  /** Launch is a big signature (backblast) - reveals shooter. */
  signature: number;
}

const W = (w: WeaponDef): WeaponDef => w;

export const WEAPONS: Record<string, WeaponDef> = {
  // ---------------- NATO small arms ----------------
  m7: W({ id: 'm7', name: 'M7 Rifle (6.8mm)', cls: 'rifle', range: 600, halfRange: 140, accuracy: 0.28, burst: [1, 3], shotInterval: 0.15, cycle: 1.3, aimTime: 1.0, mag: 20, reload: 3, lethality: 0.5, pen: 9, suppression: 6, suppRadius: 4, antiArmor: false, antiPersonnel: true, sound: 'rifle', tracer: 0xffc070, tracerEvery: 4, signature: 1 }),
  m4: W({ id: 'm4', name: 'M4A1 Carbine', cls: 'rifle', range: 500, halfRange: 125, accuracy: 0.27, burst: [1, 3], shotInterval: 0.12, cycle: 1.2, aimTime: 1.0, mag: 30, reload: 3, lethality: 0.42, pen: 6, suppression: 5, suppRadius: 4, antiArmor: false, antiPersonnel: true, sound: 'rifle', tracer: 0xffc070, tracerEvery: 4, signature: 1 }),
  m250: W({ id: 'm250', name: 'M250 Automatic Rifle', cls: 'ar', range: 850, halfRange: 180, accuracy: 0.12, burst: [5, 9], shotInterval: 0.08, cycle: 1.7, aimTime: 1.2, mag: 100, reload: 6, lethality: 0.5, pen: 9, suppression: 9, suppRadius: 5, antiArmor: false, antiPersonnel: true, sound: 'mg', tracer: 0xffb050, tracerEvery: 3, signature: 1.5 }),
  m240: W({ id: 'm240', name: 'M240L Machine Gun', cls: 'mg', range: 1100, halfRange: 220, accuracy: 0.11, burst: [6, 12], shotInterval: 0.07, cycle: 1.8, aimTime: 1.5, mag: 100, reload: 7, lethality: 0.55, pen: 8, suppression: 11, suppRadius: 6, antiArmor: false, antiPersonnel: true, sound: 'mg', tracer: 0xffa040, tracerEvery: 3, signature: 1.8 }),
  m110: W({ id: 'm110', name: 'M110A1 SDMR', cls: 'dmr', range: 850, halfRange: 380, accuracy: 0.5, burst: [1, 1], shotInterval: 0.2, cycle: 2.4, aimTime: 2, mag: 20, reload: 3, lethality: 0.65, pen: 10, suppression: 7, suppRadius: 3, antiArmor: false, antiPersonnel: true, sound: 'sniper', signature: 1.2 }),
  mk22: W({ id: 'mk22', name: 'Mk22 MRAD Sniper Rifle', cls: 'sniper', range: 1300, halfRange: 650, accuracy: 0.65, burst: [1, 1], shotInterval: 0.2, cycle: 4, aimTime: 3, mag: 10, reload: 4, lethality: 0.9, pen: 14, suppression: 12, suppRadius: 3, antiArmor: false, antiPersonnel: true, sound: 'sniper', signature: 0.8 }),
  m320: W({ id: 'm320', name: 'M320 40mm GL', cls: 'gl', range: 350, minRange: 30, halfRange: 150, accuracy: 0.4, burst: [1, 1], shotInterval: 0.5, cycle: 3.5, aimTime: 1.5, mag: 1, reload: 3, lethality: 0.4, blast: 5, pen: 50, speed: 76, suppression: 28, suppRadius: 9, antiArmor: false, antiPersonnel: true, sound: 'gl', signature: 1 }),
  at4: W({ id: 'at4', name: 'M136 AT4', cls: 'rocket', range: 300, minRange: 20, halfRange: 170, accuracy: 0.6, burst: [1, 1], shotInterval: 1, cycle: 4, aimTime: 2.5, mag: 1, reload: 99, lethality: 0.5, blast: 3.5, pen: 440, heat: true, speed: 285, suppression: 30, suppRadius: 8, antiArmor: true, antiPersonnel: true, sound: 'rocket', signature: 4 }),
  m3e1: W({ id: 'm3e1', name: 'M3E1 Carl Gustaf 84mm', cls: 'rocket', range: 700, minRange: 20, halfRange: 420, accuracy: 0.66, burst: [1, 1], shotInterval: 1, cycle: 6, aimTime: 3, mag: 1, reload: 5, lethality: 0.55, blast: 5, pen: 480, heat: true, speed: 255, suppression: 35, suppRadius: 10, antiArmor: true, antiPersonnel: true, sound: 'rocket', signature: 4 }),
  javelin: W({ id: 'javelin', name: 'FGM-148F Javelin', cls: 'atgm', range: 2500, minRange: 65, halfRange: 100000, accuracy: 0.93, burst: [1, 1], shotInterval: 1, cycle: 22, aimTime: 6, mag: 1, reload: 20, lethality: 0.6, blast: 4, pen: 780, heat: true, tandem: true, topAttack: true, speed: 140, guidance: 'fnf', suppression: 40, suppRadius: 10, antiArmor: true, antiPersonnel: false, sound: 'atgm', signature: 3 }),
  m67: W({ id: 'm67', name: 'M67 Frag Grenade', cls: 'grenade', range: 32, halfRange: 30, accuracy: 0.5, burst: [1, 1], shotInterval: 1, cycle: 6, aimTime: 1.5, mag: 1, reload: 1, lethality: 0.45, blast: 6, pen: 5, speed: 14, suppression: 40, suppRadius: 12, antiArmor: false, antiPersonnel: true, sound: 'grenade', signature: 0.5 }),
  m224: W({ id: 'm224', name: 'M224A1 60mm Mortar', cls: 'mortar', range: 3400, minRange: 80, halfRange: 100000, accuracy: 1, burst: [1, 1], shotInterval: 1, cycle: 5, aimTime: 8, mag: 1, reload: 1, lethality: 0.3, blast: 6, pen: 20, indirect: true, speed: 160, suppression: 45, suppRadius: 18, antiArmor: false, antiPersonnel: true, sound: 'mortar', signature: 1 }),

  smokegren: W({ id: 'smokegren', name: 'Smoke Grenade', cls: 'smoke', range: 45, halfRange: 40, accuracy: 1, burst: [1, 1], shotInterval: 1, cycle: 6, aimTime: 1, mag: 1, reload: 1, lethality: 0, pen: 0, speed: 14, suppression: 0, suppRadius: 0, antiArmor: false, antiPersonnel: false, sound: 'grenade', signature: 0.5 }),

  // ---------------- NATO vehicle weapons ----------------
  m256: W({ id: 'm256', name: '120mm M256 (M829A4 / AMP)', cls: 'tankgun', range: 3000, halfRange: 2600, accuracy: 0.92, burst: [1, 1], shotInterval: 1, cycle: 7, aimTime: 2.5, mag: 1, reload: 0, lethality: 0.6, blast: 7, pen: 760, speed: 1650, suppression: 60, suppRadius: 16, antiArmor: true, antiPersonnel: true, sound: 'tankgun', tracer: 0xffe0a0, signature: 5 }),
  m242: W({ id: 'm242', name: '25mm M242 Bushmaster', cls: 'autocannon', range: 2500, halfRange: 1100, accuracy: 0.45, burst: [3, 6], shotInterval: 0.3, cycle: 2.2, aimTime: 1.5, mag: 300, reload: 10, lethality: 0.75, blast: 2.5, pen: 65, speed: 1100, suppression: 22, suppRadius: 7, antiArmor: true, antiPersonnel: true, sound: 'cannon', tracer: 0xff9040, signature: 3 }),
  tow: W({ id: 'tow', name: 'BGM-71F TOW-2B', cls: 'atgm', range: 3750, minRange: 65, halfRange: 100000, accuracy: 0.9, burst: [1, 1], shotInterval: 1, cycle: 6, aimTime: 4, mag: 2, reload: 45, lethality: 0.6, blast: 4, pen: 900, heat: true, tandem: true, topAttack: true, speed: 280, guidance: 'saclos', suppression: 40, suppRadius: 10, antiArmor: true, antiPersonnel: false, sound: 'atgm', signature: 4 }),
  m240c: W({ id: 'm240c', name: 'M240C Coax', cls: 'mg', range: 1100, halfRange: 260, accuracy: 0.12, burst: [8, 14], shotInterval: 0.07, cycle: 1.7, aimTime: 1, mag: 800, reload: 8, lethality: 0.55, pen: 8, suppression: 12, suppRadius: 6, antiArmor: false, antiPersonnel: true, sound: 'mg', tracer: 0xffa040, tracerEvery: 3, signature: 1.5 }),
  m2hb: W({ id: 'm2hb', name: 'M2A1 .50 cal (CROWS)', cls: 'hmg', range: 1500, halfRange: 320, accuracy: 0.12, burst: [5, 9], shotInterval: 0.11, cycle: 1.8, aimTime: 1.2, mag: 400, reload: 10, lethality: 0.85, pen: 25, suppression: 18, suppRadius: 7, antiArmor: false, antiPersonnel: true, sound: 'hmg', tracer: 0xffb060, tracerEvery: 3, signature: 2 }),
  mk19: W({ id: 'mk19', name: 'Mk19 40mm AGL', cls: 'agl', range: 1600, halfRange: 600, accuracy: 0.3, burst: [3, 5], shotInterval: 0.18, cycle: 2.5, aimTime: 2, mag: 48, reload: 12, lethality: 0.35, blast: 5, pen: 50, speed: 240, suppression: 26, suppRadius: 10, antiArmor: false, antiPersonnel: true, sound: 'gl', signature: 2 }),

  // ---------------- OPFOR small arms ----------------
  ak12: W({ id: 'ak12', name: 'AK-12 (5.45mm)', cls: 'rifle', range: 500, halfRange: 125, accuracy: 0.26, burst: [2, 3], shotInterval: 0.1, cycle: 1.15, aimTime: 1.0, mag: 30, reload: 3, lethality: 0.42, pen: 6, suppression: 5, suppRadius: 4, antiArmor: false, antiPersonnel: true, sound: 'rifle', tracer: 0xa0ff80, tracerEvery: 4, signature: 1 }),
  pkp: W({ id: 'pkp', name: 'PKP Pecheneg', cls: 'mg', range: 1000, halfRange: 210, accuracy: 0.11, burst: [6, 11], shotInterval: 0.075, cycle: 1.8, aimTime: 1.5, mag: 100, reload: 7, lethality: 0.55, pen: 8, suppression: 11, suppRadius: 6, antiArmor: false, antiPersonnel: true, sound: 'mg', tracer: 0x90ff70, tracerEvery: 3, signature: 1.8 }),
  svdm: W({ id: 'svdm', name: 'SVDM Marksman Rifle', cls: 'dmr', range: 800, halfRange: 340, accuracy: 0.46, burst: [1, 1], shotInterval: 0.2, cycle: 2.6, aimTime: 2, mag: 10, reload: 3, lethality: 0.65, pen: 10, suppression: 7, suppRadius: 3, antiArmor: false, antiPersonnel: true, sound: 'sniper', signature: 1.2 }),
  sv98: W({ id: 'sv98', name: 'SV-98M Sniper Rifle', cls: 'sniper', range: 1200, halfRange: 560, accuracy: 0.6, burst: [1, 1], shotInterval: 0.2, cycle: 4.2, aimTime: 3, mag: 10, reload: 4, lethality: 0.88, pen: 12, suppression: 11, suppRadius: 3, antiArmor: false, antiPersonnel: true, sound: 'sniper', signature: 0.8 }),
  gp34: W({ id: 'gp34', name: 'GP-34 40mm GL', cls: 'gl', range: 400, minRange: 30, halfRange: 150, accuracy: 0.38, burst: [1, 1], shotInterval: 0.5, cycle: 3.5, aimTime: 1.5, mag: 1, reload: 3, lethality: 0.4, blast: 5, pen: 40, speed: 76, suppression: 28, suppRadius: 9, antiArmor: false, antiPersonnel: true, sound: 'gl', signature: 1 }),
  rpg7: W({ id: 'rpg7', name: 'RPG-7V2 (PG-7VR / OG-7V)', cls: 'rocket', range: 350, minRange: 20, halfRange: 200, accuracy: 0.52, burst: [1, 1], shotInterval: 1, cycle: 5, aimTime: 2.5, mag: 1, reload: 5, lethality: 0.5, blast: 4.5, pen: 600, heat: true, tandem: true, speed: 150, suppression: 32, suppRadius: 9, antiArmor: true, antiPersonnel: true, sound: 'rocket', signature: 4 }),
  rpg26: W({ id: 'rpg26', name: 'RShG-2 (thermobaric)', cls: 'rocket', range: 250, minRange: 15, halfRange: 180, accuracy: 0.55, burst: [1, 1], shotInterval: 1, cycle: 4, aimTime: 2.5, mag: 1, reload: 99, lethality: 0.6, blast: 6, pen: 300, heat: true, speed: 145, suppression: 38, suppRadius: 10, antiArmor: true, antiPersonnel: true, sound: 'rocket', signature: 4 }),
  kornet: W({ id: 'kornet', name: '9M133M Kornet-M', cls: 'atgm', range: 5500, minRange: 100, halfRange: 100000, accuracy: 0.9, burst: [1, 1], shotInterval: 1, cycle: 8, aimTime: 4, mag: 1, reload: 25, lethality: 0.7, blast: 5, pen: 1150, heat: true, tandem: true, speed: 300, guidance: 'saclos', suppression: 45, suppRadius: 10, antiArmor: true, antiPersonnel: true, sound: 'atgm', signature: 4 }),
  ags30: W({ id: 'ags30', name: 'AGS-30 30mm AGL', cls: 'agl', range: 1700, minRange: 50, halfRange: 600, accuracy: 0.28, burst: [4, 6], shotInterval: 0.16, cycle: 2.8, aimTime: 2.5, mag: 29, reload: 10, lethality: 0.3, blast: 4, pen: 20, speed: 185, suppression: 24, suppRadius: 9, antiArmor: false, antiPersonnel: true, sound: 'gl', signature: 1.5 }),
  rgd5: W({ id: 'rgd5', name: 'RGD-5 Grenade', cls: 'grenade', range: 32, halfRange: 30, accuracy: 0.5, burst: [1, 1], shotInterval: 1, cycle: 6, aimTime: 1.5, mag: 1, reload: 1, lethality: 0.4, blast: 6, pen: 5, speed: 14, suppression: 40, suppRadius: 12, antiArmor: false, antiPersonnel: true, sound: 'grenade', signature: 0.5 }),
  b14: W({ id: 'b14', name: '2B14 Podnos 82mm Mortar', cls: 'mortar', range: 4000, minRange: 90, halfRange: 100000, accuracy: 1, burst: [1, 1], shotInterval: 1, cycle: 5, aimTime: 8, mag: 1, reload: 1, lethality: 0.34, blast: 7, pen: 25, indirect: true, speed: 160, suppression: 48, suppRadius: 20, antiArmor: false, antiPersonnel: true, sound: 'mortar', signature: 1 }),

  // ---------------- OPFOR vehicle weapons ----------------
  a46m5: W({ id: 'a46m5', name: '125mm 2A46M-5 (3BM60 / 3OF26)', cls: 'tankgun', range: 3000, halfRange: 2200, accuracy: 0.86, burst: [1, 1], shotInterval: 1, cycle: 7.5, aimTime: 3, mag: 1, reload: 0, lethality: 0.6, blast: 7, pen: 660, speed: 1700, suppression: 60, suppRadius: 16, antiArmor: true, antiPersonnel: true, sound: 'tankgun', tracer: 0xffe0a0, signature: 5 }),
  a46m: W({ id: 'a46m', name: '125mm 2A46M (3BM42)', cls: 'tankgun', range: 2500, halfRange: 1800, accuracy: 0.8, burst: [1, 1], shotInterval: 1, cycle: 8, aimTime: 3.5, mag: 1, reload: 0, lethality: 0.6, blast: 7, pen: 560, speed: 1700, suppression: 60, suppRadius: 16, antiArmor: true, antiPersonnel: true, sound: 'tankgun', tracer: 0xffe0a0, signature: 5 }),
  a72: W({ id: 'a72', name: '30mm 2A72', cls: 'autocannon', range: 2500, halfRange: 1000, accuracy: 0.42, burst: [3, 6], shotInterval: 0.28, cycle: 2.3, aimTime: 1.6, mag: 300, reload: 10, lethality: 0.75, blast: 2.5, pen: 55, speed: 960, suppression: 22, suppRadius: 7, antiArmor: true, antiPersonnel: true, sound: 'cannon', tracer: 0xff8040, signature: 3 }),
  a70: W({ id: 'a70', name: '100mm 2A70 HE-FRAG', cls: 'tankgun', range: 4000, halfRange: 1400, accuracy: 0.7, burst: [1, 1], shotInterval: 1, cycle: 8, aimTime: 3, mag: 1, reload: 0, lethality: 0.6, blast: 8, pen: 90, speed: 250, suppression: 55, suppRadius: 16, antiArmor: false, antiPersonnel: true, sound: 'tankgun', signature: 4 }),
  arkan: W({ id: 'arkan', name: '9M117M1 Arkan (gun-launched ATGM)', cls: 'atgm', range: 5500, minRange: 100, halfRange: 100000, accuracy: 0.85, burst: [1, 1], shotInterval: 1, cycle: 10, aimTime: 4, mag: 1, reload: 0, lethality: 0.6, blast: 4, pen: 750, heat: true, tandem: true, speed: 370, guidance: 'saclos', suppression: 40, suppRadius: 10, antiArmor: true, antiPersonnel: false, sound: 'atgm', signature: 4 }),
  pktm: W({ id: 'pktm', name: 'PKTM Coax', cls: 'mg', range: 1000, halfRange: 260, accuracy: 0.12, burst: [8, 14], shotInterval: 0.075, cycle: 1.8, aimTime: 1, mag: 250, reload: 8, lethality: 0.55, pen: 8, suppression: 12, suppRadius: 6, antiArmor: false, antiPersonnel: true, sound: 'mg', tracer: 0x90ff70, tracerEvery: 3, signature: 1.5 }),
  kord: W({ id: 'kord', name: 'Kord 12.7mm', cls: 'hmg', range: 1500, halfRange: 320, accuracy: 0.12, burst: [5, 9], shotInterval: 0.1, cycle: 1.9, aimTime: 1.3, mag: 150, reload: 10, lethality: 0.85, pen: 24, suppression: 18, suppRadius: 7, antiArmor: false, antiPersonnel: true, sound: 'hmg', tracer: 0x90ff70, tracerEvery: 3, signature: 2 }),
};

export function weapon(id: string): WeaponDef {
  const w = WEAPONS[id];
  if (!w) throw new Error(`Unknown weapon ${id}`);
  return w;
}

/** Probability per round/shot of hitting a man-sized exposed target at a given range. */
export function baseHitChance(w: WeaponDef, range: number): number {
  if (range > w.range) return 0;
  const h = w.halfRange;
  return w.accuracy / (1 + (range / h) * (range / h));
}
