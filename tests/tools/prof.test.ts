import { it } from 'vitest';
import { createBattle, defaultForces } from '../../src/game/scenario';
import * as pf from '../../src/sim/pathfinding';

it('profile', () => {
  const map = process.env.MAP ?? 'arnholt';
  const { forces, posture } = defaultForces(map);
  const w = createBattle({ mapId: map, seed: 1, timeLimit: 900, player: null, posture, forces });
  w.prof = {};
  let paths = 0;
  let pathMs = 0;
  const orig = pf.findPath;
  void orig; void paths; void pathMs;
  w.startBattle();
  while (w.phase === 'battle') { w.step(); w.events.length = 0; }
  console.log(map, Object.entries(w.prof).map(([k, v]) => `${k}=${Math.round(v)}ms`).join(' '));
}, 600000);
