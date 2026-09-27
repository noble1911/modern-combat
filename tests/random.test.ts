import { expect, it } from 'vitest';
import { registerMap } from '../src/data/maps';
import { randomMap } from '../src/data/randomMap';
import { createBattle, defaultForces } from '../src/game/scenario';
import { T } from '../src/sim/terrain';

it('random battlefields generate and play', () => {
  for (const seed of [1, 2, 3, 4, 5]) {
    const def = randomMap(seed);
    registerMap(def);
    const { forces, posture } = defaultForces('veldmark');
    const w = createBattle({ mapId: def.id, seed, timeLimit: 300, player: null, posture, forces });
    for (const vl of def.vls) expect(w.map.typeAt(vl.x, vl.y)).not.toBe(T.Water);
    expect(w.map.buildings.length).toBeGreaterThan(5);
    w.startBattle();
    for (let i = 0; i < 1200 && w.phase === 'battle'; i++) {
      w.step();
      w.events.length = 0;
    }
    expect(w.soldiers.some((s) => s.health !== 'ok')).toBe(true);
  }
}, 120000);
