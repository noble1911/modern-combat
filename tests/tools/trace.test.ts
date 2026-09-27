import { it } from 'vitest';
import { createBattle, defaultForces } from '../../src/game/scenario';

it('trace', () => {
  const map = process.env.MAP ?? 'veldmark';
  const { forces, posture } = defaultForces(map);
  const w = createBattle({ mapId: map, seed: Number(process.env.SEED ?? 7), timeLimit: 1200, player: null, posture, forces });
  if (process.env.KILLS) w.dbg = (l) => console.log(l);
  w.startBattle();
  const every = Number(process.env.EVERY ?? 600);
  const until = Number(process.env.UNTIL ?? 12000);
  const side = (process.env.SIDE ?? 'nato') as 'nato' | 'opfor';
  while (w.phase === 'battle' && w.tick < until) {
    w.step();
    if (process.env.MSGS) for (const e of w.events) if (e.type === 'message' && (e.side === side || e.side === 'all')) console.log(Math.round(w.time), e.text);
    w.events.length = 0;
    if (w.tick % every === 0) {
      console.log(`--- t=${Math.round(w.time)} obj=${(w.aiState[side] as any).objective} fm=${Math.round(w.forceMorale.nato)}/${Math.round(w.forceMorale.opfor)} vls=${w.vls.map((v) => v.id + ':' + (v.owner ?? '-')).join(',')}`);
      for (const u of w.units.filter((u) => u.side === side)) {
        const p = w.unitPos(u);
        const o = u.order;
        console.log(`${u.name.padEnd(14)} ${u.stateLabel.padEnd(11)} alive=${u.alive} pos=(${p.x | 0},${p.y | 0}) order=${o.kind}${o.target ? `->(${o.target.x | 0},${o.target.y | 0})` : ''} task=${u.ai.task ?? ''} elim=${u.eliminated}`);
      }
    }
  }
  console.log('RESULT', JSON.stringify(w.result));
}, 120000);
