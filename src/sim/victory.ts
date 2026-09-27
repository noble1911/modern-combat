import { FACTIONS, Side } from '../data/units';
import { World } from './world';
import { dhypot, dpow } from './dmath';

/** 1 Hz: victory location control. A VL flips when only one side has effective units on it. */
export function updateVictory(w: World): void {
  for (const vl of w.vls) {
    const present: Record<Side, number> = { nato: 0, opfor: 0 };
    for (const u of w.units) {
      if (u.eliminated || u.withdrawn || u.mountedIn >= 0) continue;
      if (u.vehicle >= 0) {
        const v = w.vehicles[u.vehicle];
        if (v.destroyed || v.abandoned) continue;
        if (dhypot(v.x - vl.x, v.y - vl.y) <= vl.r) present[u.side] += 1;
        continue;
      }
      for (const id of u.soldiers) {
        const s = w.soldiers[id];
        if (!World.active(s) || s.vehicle >= 0) continue;
        if (s.state === 'panicked' || s.state === 'routing') continue;
        if (dhypot(s.x - vl.x, s.y - vl.y) <= vl.r) present[u.side] += 1;
      }
    }
    const contested = present.nato > 0 && present.opfor > 0;
    vl.contested = contested;
    const holder: Side | null = contested ? null : present.nato > 0 ? 'nato' : present.opfor > 0 ? 'opfor' : null;
    if (!holder || holder === vl.owner) {
      vl.holdT = 0;
      vl.holdSide = null;
      continue;
    }
    if (vl.holdSide !== holder) {
      vl.holdSide = holder;
      vl.holdT = 0;
    }
    vl.holdT += 1;
    if (vl.holdT >= 5) {
      const prev = vl.owner;
      vl.owner = holder;
      vl.holdT = 0;
      w.emit({ type: 'vl', id: vl.id, owner: holder });
      w.msg(holder, `We have taken ${vl.name}!`, -1, 'good');
      if (prev) w.msg(prev, `We have lost ${vl.name}!`, -1, 'alert');
      // morale swing
      for (const s of w.soldiers) {
        if (!World.active(s)) continue;
        if (s.side === holder) s.morale = Math.min(100, s.morale + 3);
        else if (s.side === prev) s.morale -= 4;
      }
    }
  }
}

/**
 * Force morale: fraction of combat power remaining, VL share and average soldier morale.
 * When it collapses the side withdraws, ending the battle (as in Close Combat).
 */
export function computeForceMorale(w: World): void {
  const totalVL = w.vls.reduce((n, v) => n + v.value, 0) || 1;
  for (const side of ['nato', 'opfor'] as Side[]) {
    const init = w.initialValue[side] || 1;
    const now = w.units.filter((u) => u.side === side && !u.withdrawn && !u.isCrew).reduce((n, u) => n + w.unitValue(u), 0);
    const strength = Math.min(1, now / init);
    let mor = 0;
    let n = 0;
    for (const s of w.soldiers) {
      if (s.side !== side || !World.active(s)) continue;
      mor += s.morale;
      n++;
    }
    const avgMorale = n ? mor / n / 100 : 0;
    const vlShare = w.vls.reduce((a, v) => a + (v.owner === side ? v.value : 0), 0) / totalVL;
    const fm = 100 * (0.7 * dpow(strength, 1.2) + 0.15 * avgMorale + 0.15 * vlShare);
    const prev = w.forceMorale[side];
    w.forceMorale[side] = Math.max(0, Math.min(100, fm));
    if (prev > 40 && w.forceMorale[side] <= 40) w.msg(side, `${FACTIONS[side].short} force morale is faltering!`, -1, 'alert');
  }
}
