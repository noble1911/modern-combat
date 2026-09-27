import { it } from 'vitest';
import { MAP_ORDER } from '../../src/data/maps';
import { createBattle, defaultForces } from '../../src/game/scenario';

it('batch', () => {
  const seeds = (process.env.SEEDS ?? '1,2').split(',').map(Number);
  const maps = process.env.MAPS ? process.env.MAPS.split(',') : MAP_ORDER;
  for (const map of maps) {
    for (const seed of seeds) {
      const { forces, posture } = defaultForces(map);
      const w = createBattle({ mapId: map, seed, timeLimit: 1500, player: null, posture, forces });
      w.startBattle();
      const t0 = performance.now();
      while (w.phase === 'battle') {
        w.step();
        w.events.length = 0;
      }
      const r = w.result!;
      const c = r.casualties;
      console.log(
        `${map.padEnd(10)} s${seed} ${String(r.winner).padEnd(5)} ${r.grade.padEnd(8)} t=${Math.round(r.duration)}s vl=${r.vlPoints.nato}/${r.vlPoints.opfor} ` +
          `NATO k${c.nato.killed} w${c.nato.wounded} c${c.nato.captured} v${c.nato.vehiclesLost} | OPFOR k${c.opfor.killed} w${c.opfor.wounded} c${c.opfor.captured} v${c.opfor.vehiclesLost} ` +
          `fm=${Math.round(w.forceMorale.nato)}/${Math.round(w.forceMorale.opfor)} (${r.reason}) ${Math.round(performance.now() - t0)}ms`,
      );
    }
  }
}, 600000);
