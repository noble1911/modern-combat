import { describe, expect, it } from 'vitest';
import { MAP_ORDER, MAPS } from '../src/data/maps';
import { createBattle, defaultForces } from '../src/game/scenario';
import { generateMap } from '../src/sim/mapgen';
import { T } from '../src/sim/terrain';
import { World } from '../src/sim/world';

function summary(w: World) {
  const side = (s: 'nato' | 'opfor') => {
    const sol = w.soldiers.filter((x) => x.side === s);
    const veh = w.vehicles.filter((v) => v.side === s);
    return {
      men: sol.length,
      dead: sol.filter((x) => x.health === 'dead').length,
      incap: sol.filter((x) => x.health === 'incap').length,
      wounded: sol.filter((x) => x.health === 'wounded').length,
      surrendered: sol.filter((x) => x.state === 'surrendered').length,
      fled: sol.filter((x) => x.fled).length,
      vehicles: `${veh.filter((v) => v.destroyed || v.abandoned).length}/${veh.length} lost`,
      fm: Math.round(w.forceMorale[s]),
    };
  };
  return { t: Math.round(w.time), nato: side('nato'), opfor: side('opfor'), vls: w.vls.map((v) => `${v.id}:${v.owner ?? '-'}${v.contested ? '*' : ''}`).join(' ') };
}

describe('map generation', () => {
  for (const id of MAP_ORDER) {
    it(`${id} generates a sane map`, () => {
      const g = generateMap(MAPS[id]);
      const counts = new Map<number, number>();
      for (const t of g.map.type) counts.set(t, (counts.get(t) ?? 0) + 1);
      expect(g.map.buildings.length).toBeGreaterThan(5);
      // VLs must be reachable on foot
      for (const vl of MAPS[id].vls) {
        const t = g.map.typeAt(vl.x, vl.y);
        expect(t === T.Water).toBe(false);
      }
      if (MAPS[id].rivers?.length && !MAPS[id].rivers![0].shallow) expect(counts.get(T.Bridge) ?? 0).toBeGreaterThan(3);
    });
  }
});

describe('AI vs AI battle', () => {
  it('runs a full battle on Veldmark without errors', () => {
    const { forces, posture } = defaultForces('veldmark');
    const w = createBattle({ mapId: 'veldmark', seed: 7, timeLimit: 20 * 60, player: null, posture, forces });
    w.startBattle();
    const t0 = performance.now();
    const snaps: unknown[] = [];
    while (w.phase === 'battle' && w.time < 20 * 60) {
      w.step();
      if (w.tick % 1500 === 0) snaps.push(summary(w));
      w.events.length = 0;
    }
    const ms = performance.now() - t0;
    console.log(JSON.stringify(snaps, null, 1));
    console.log('result', w.result, `sim ${Math.round(w.time)}s in ${Math.round(ms)}ms`);
    const shots = w.soldiers.reduce((n, s) => n + s.kills, 0);
    expect(shots).toBeGreaterThan(0);
  }, 120000);
});
