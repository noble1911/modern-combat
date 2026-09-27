/**
 * Weapon pictures for the unit panels: static SVGs in public/icons/weapons/, drawn by
 * tools/icons/weapon_art.ts (`npm run icons` regenerates them). Weapons without their own picture
 * use one for their type — vehicle guns share class pictures.
 */

/** Weapon ids that have their own picture file. */
const OWN = new Set([
  'm7', 'm4', 'm250', 'm240', 'm110', 'mk22', 'm320', 'm67', 'smokegren', 'at4', 'm3e1', 'javelin', 'm224',
  'ak12', 'pkp', 'svdm', 'sv98', 'gp34', 'rgd5', 'rpg7', 'rpg26', 'kornet', 'ags30', 'b14',
]);

/** Vehicle weapons → class pictures. */
const ALIAS: Record<string, string> = {
  m256: 'tankgun', a46m5: 'tankgun', a46m: 'tankgun', a70: 'tankgun',
  m242: 'autocannon', a72: 'autocannon',
  tow: 'missile', arkan: 'missile',
  m2hb: 'hmg', kord: 'hmg',
  mk19: 'agl',
  m240c: 'coax', pktm: 'coax',
};

/** Fallback by weapon class for anything else. */
const CLASS: Record<string, string> = {
  rifle: 'm7', ar: 'm250', mg: 'm240', dmr: 'm110', sniper: 'mk22', gl: 'm320', rocket: 'at4', atgm: 'missile',
  grenade: 'm67', smoke: 'smokegren', mortar: 'm224', tankgun: 'tankgun', autocannon: 'autocannon', hmg: 'hmg', agl: 'agl',
};

/** URL of a weapon's picture (by weapon id, falling back to its class). */
export function weaponIcon(id: string, cls = ''): string {
  const file = OWN.has(id) ? id : (ALIAS[id] ?? CLASS[cls] ?? 'm7');
  return `${import.meta.env.BASE_URL}icons/weapons/${file}.svg`;
}
