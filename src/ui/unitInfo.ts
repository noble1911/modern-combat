import { UnitTemplate, VEHICLES } from '../data/units';
import { WEAPONS, type WeaponDef } from '../data/weapons';
import { portraitBg } from '../render/portraits';
import { weaponIcon } from './weaponIcons';

/** Compact weapon names for one-line summaries. */
const SHORT: Record<string, string> = {
  m7: 'M7', m4: 'M4', m250: 'M250 LMG', m240: 'M240 MG', m110: 'M110 DMR', mk22: 'Mk22 sniper', m320: 'M320 GL',
  at4: 'AT4', m3e1: 'Carl Gustaf', javelin: 'Javelin', m224: '60mm mortar',
  ak12: 'AK-12', pkp: 'PKP MG', svdm: 'SVDM', sv98: 'SV-98 sniper', gp34: 'GP-34 GL', rpg7: 'RPG-7', rpg26: 'RShG-2',
  kornet: 'Kornet ATGM', ags30: 'AGS-30', b14: '82mm mortar',
  m256: '120mm gun', a46m5: '125mm gun', a46m: '125mm gun', a70: '100mm gun', m242: '25mm cannon', a72: '30mm cannon',
  tow: 'TOW', arkan: 'Arkan ATGM', m2hb: '.50 cal', kord: '12.7mm HMG', mk19: '40mm AGL', m240c: 'coax MG', pktm: 'coax MG',
};
const shortName = (id: string) => SHORT[id] ?? WEAPONS[id]?.name.split(' (')[0] ?? id;

const KIND: Record<string, string> = { armor: 'Main battle tank', ifv: 'Infantry fighting vehicle', apc: 'Armoured personnel carrier', car: 'Light armoured vehicle' };

/** Rounds for a weapon: single shots for launchers and grenades, magazines for guns. */
export function ammoLabel(def: WeaponDef, ammo: number): string {
  const c = def.cls;
  if (c === 'rocket' || c === 'atgm' || c === 'gl' || c === 'grenade' || c === 'smoke' || c === 'mortar') return `${ammo}`;
  const mags = Math.ceil(ammo / Math.max(1, def.mag));
  return `${mags} mag${mags === 1 ? '' : 's'}`;
}

/** A soldier's weapons as pictures: the primary large with its ammo, secondaries small beneath. */
export function weaponCell(weapons: { def: WeaponDef; ammo: number }[]): string {
  if (!weapons.length) return '';
  const [p, ...rest] = weapons;
  let h = `<div class="wp" title="${p.def.name}"><img src="${weaponIcon(p.def.id, p.def.cls)}" alt=""><span>${ammoLabel(p.def, p.ammo)}</span></div><div class="wn">${p.def.name.split(' (')[0]}</div>`;
  if (rest.length) h += `<div class="ws">${rest.map((x) => `<span title="${x.def.name}"><img src="${weaponIcon(x.def.id, x.def.cls)}" alt="">${ammoLabel(x.def, x.ammo)}</span>`).join('')}</div>`;
  return h;
}

/** One line: what the unit is made of ("9 men · M7 ×5, M250 LMG ×2, …" / "Tank · 120mm gun, … · 4 crew"). */
export function unitSummary(t: UnitTemplate): string {
  if (t.vehicle) {
    const v = VEHICLES[t.vehicle];
    const guns = [...new Set(v.weapons.map((w) => shortName(w.weapon)))].join(', ');
    return `${guns} · ${v.crewRoles.length} crew${v.seats ? ` · carries ${v.seats}` : ''}`;
  }
  const soldiers = t.soldiers ?? [];
  const counts = new Map<string, number>();
  for (const s of soldiers) {
    for (const [id] of s.weapons) {
      const cls = WEAPONS[id]?.cls;
      if (cls === 'grenade' || cls === 'smoke') continue; // everyone carries those
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }
  }
  const parts = [...counts].map(([id, n]) => `${shortName(id)}${n > 1 ? ` ×${n}` : ''}`);
  return `${soldiers.length} men · ${parts.join(', ')}`;
}

function abilities(t: UnitTemplate): string[] {
  const out: string[] = [];
  const n = t.charges ?? 0;
  for (const a of t.abilities ?? []) {
    if (a === 'callFire') out.push(`Calls artillery — ${n} fire mission${n === 1 ? '' : 's'}`);
    else if (a === 'uav') out.push('Recon drone — spots from overhead');
    else if (a === 'loiter') out.push(`Loitering munitions — ${n} strike${n === 1 ? '' : 's'}`);
    else if (a === 'fpv') out.push(`FPV strike drones — ${n}`);
  }
  return out;
}

/**
 * Full breakdown of a unit type for the force-selection screen: portrait banner, description,
 * special abilities and either every soldier with their weapons, or the vehicle's armour,
 * mobility, weapons and crew.
 */
export function unitDetailHtml(t: UnitTemplate, symbolSrc: string): string {
  let h = `<div class="ud-banner" style="${portraitBg(t)}"><div class="bt"><img src="${symbolSrc}" alt=""><div><div class="bn">${t.name}</div><div class="bs">${t.vehicle ? KIND[t.symbol] ?? 'Vehicle' : `${t.soldiers?.length ?? 0} soldiers`} · ${t.cost} pts</div></div></div></div>`;
  h += `<p class="ud-desc">${t.description}</p>`;
  const ab = abilities(t);
  if (ab.length) h += `<div class="ud-tags">${ab.map((a) => `<span>${a}</span>`).join('')}</div>`;
  if (t.vehicle) {
    const v = VEHICLES[t.vehicle];
    const prot = [v.aps ? `Trophy APS (${v.aps.charges})` : '', v.era ? 'Reactive armour' : '', v.slat ? 'Slat armour' : '', v.compositeHEAT > 1 ? 'Composite armour' : ''].filter(Boolean);
    h += `<div class="kv ud-kv">`;
    h += `<b>Armour F / S / R / T</b><span>${v.armor.front} / ${v.armor.side} / ${v.armor.rear} / ${v.armor.top} mm</span>`;
    h += `<b>Top speed</b><span>${Math.round(v.maxSpeed * 3.6)} km/h ${v.mobility === 'track' ? '(tracked)' : '(wheeled)'}</span>`;
    if (prot.length) h += `<b>Protection</b><span>${prot.join(', ')}</span>`;
    h += `<b>Sights</b><span>${v.thermal ? 'Thermal' : 'Day optics only'}</span>`;
    h += `<b>Smoke</b><span>${v.smokeSalvos ? `${v.smokeSalvos} salvo${v.smokeSalvos === 1 ? '' : 's'}` : 'none'}</span>`;
    h += `<b>Crew</b><span>${v.crewRoles.join(', ')}</span>`;
    if (v.seats) h += `<b>Carries</b><span>${v.seats} troops</span>`;
    h += `</div><table class="ud-tbl">`;
    for (const w of v.weapons) {
      const def = WEAPONS[w.weapon];
      if (!def) continue;
      h += `<tr><td class="vw"><img src="${weaponIcon(def.id, def.cls)}" alt=""></td><td>${def.name}</td><td class="w">${w.ammo} rds</td></tr>`;
    }
    h += `</table>`;
  } else {
    h += `<table class="ud-tbl">`;
    for (const s of t.soldiers ?? []) {
      const ws = s.weapons.filter(([id]) => WEAPONS[id]).map(([id, ammo]) => ({ def: WEAPONS[id], ammo }));
      h += `<tr><td class="who">${s.leader ? '★ ' : ''}${s.rank}<br><span class="w">${s.role}</span></td><td class="wcell">${weaponCell(ws)}</td></tr>`;
    }
    h += `</table>`;
  }
  return h;
}
