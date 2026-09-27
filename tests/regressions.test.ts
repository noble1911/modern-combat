import { describe, expect, it } from 'vitest';
import { unitTemplate, VEHICLES } from '../src/data/units';
import { BattleGroup, CampaignState, endTurn, newCampaign } from '../src/game/campaign';
import { applyBattle } from '../src/game/campaign';
import { generateMap, MapDef } from '../src/sim/mapgen';
import { issueOrder } from '../src/sim/orders';
import { T } from '../src/sim/terrain';
import { World } from '../src/sim/world';

const def: MapDef = {
  id: 'reg',
  name: 'Regression',
  description: '',
  size: [400, 400],
  seed: 9,
  relief: { amp: 0, scale: 100 },
  vls: [],
  deploy: { nato: { x: 0, y: 0, w: 400, h: 100 }, opfor: { x: 0, y: 300, w: 400, h: 100 } },
  rear: { nato: 'south', opfor: 'north' },
};

function world(): World {
  const w = new World(generateMap(def), {
    seed: 1,
    timeLimit: 900,
    sides: { nato: { ai: false, posture: 'attack', rear: { x: 0, y: -1 } }, opfor: { ai: false, posture: 'defend', rear: { x: 0, y: 1 } } },
  });
  for (let i = 0; i < w.map.type.length; i++) if (w.map.type[i] === T.Scrub) w.map.type[i] = T.Grass;
  w.map.invalidateCaches();
  w.spawnUnit('ru_sniper', 'opfor', { x: 390, y: 390 }); // keeps the battle alive
  return w;
}

describe('review regressions', () => {
  it('an immobilised vehicle drops its move order', () => {
    const w = world();
    const u = w.spawnUnit('us_m2a4', 'nato', { x: 100, y: 50 });
    w.startBattle();
    issueOrder(w, u.id, { kind: 'move', target: { x: 300, y: 80 } });
    w.vehicles[u.vehicle].immobilized = true;
    for (let i = 0; i < 20; i++) w.step();
    expect(u.order.kind).toBe('none');
  });

  it('passengers leave a carrier whose crew is knocked out', () => {
    const w = world();
    const car = w.spawnUnit('us_stryker', 'nato', { x: 100, y: 50 });
    const sq = w.spawnUnit('us_rifle', 'nato', { x: 100, y: 50 }, { mountIn: car.id });
    expect(sq.mountedIn).toBe(car.vehicle);
    w.startBattle();
    for (const id of w.vehicles[car.vehicle].crew) w.soldiers[id].health = 'dead';
    for (let i = 0; i < 5; i++) w.step();
    expect(sq.mountedIn).toBe(-1);
  });

  it('every infantry squad fits its own side’s carriers', () => {
    for (const [inf, veh] of [['us_rifle', 'm2a4'], ['us_rifle', 'stryker'], ['ru_rifle', 'bmp3'], ['ru_rifle', 'btr82a']] as const) {
      expect(VEHICLES[veh].seats).toBeGreaterThanOrEqual(unitTemplate(inf).soldiers!.length);
    }
  });

  it('a wheeled vehicle reaches a destination just off its flank', () => {
    const w = world();
    const u = w.spawnUnit('ru_btr82a', 'opfor', { x: 200, y: 200 }, { facing: 0 });
    w.startBattle();
    issueOrder(w, u.id, { kind: 'move', target: { x: 200, y: 207 } });
    for (let i = 0; i < 400 && u.order.kind === 'move'; i++) w.step();
    expect(u.order.kind).toBe('none');
  });

  it('a unit whose men all fled is withdrawn, not wiped out', () => {
    const w = world();
    const u = w.spawnUnit('us_mg', 'nato', { x: 100, y: 50 });
    w.startBattle();
    for (const id of u.soldiers) w.soldiers[id].fled = true;
    for (let i = 0; i < 10; i++) w.step();
    expect(u.withdrawn).toBe(true);
    expect(u.eliminated).toBe(false);
  });

  it('a battlegroup that withdrew then loses falls back instead of being overrun', () => {
    const st: CampaignState = newCampaign('nato', 5);
    // simplify: NATO owns sectors 0 and 1; aa502 advanced to 2 then withdrew to 1
    st.sectors[0].owner = 'nato';
    st.sectors[1].owner = 'nato';
    const bg = st.bgs.find((b) => b.id === 'aa502') as BattleGroup;
    for (const b of st.bgs) if (b.side === 'opfor' && b.sector === 1) b.sector = 3;
    bg.sector = 2;
    bg.from = 1;
    bg.order = 'withdraw';
    st.battles = [];
    endTurn(st);
    expect(bg.sector).toBe(1);
    // an enemy attacks sector 1 and wins
    const enemy = st.bgs.find((b) => b.id === 'g2')!;
    enemy.sector = 1;
    const battle = { id: 'x', sector: 1, attacker: 'opfor' as const, resolved: false };
    const fakeWorld = { units: [] } as unknown as World;
    applyBattle(st, battle, fakeWorld, { winner: 'opfor', grade: 'victory', reason: '', vlPoints: { nato: 0, opfor: 1 }, casualties: { nato: { killed: 0, wounded: 0, captured: 0, vehiclesLost: 0 }, opfor: { killed: 0, wounded: 0, captured: 0, vehiclesLost: 0 } }, duration: 1 });
    expect(bg.destroyed).toBe(false);
    expect(bg.sector).toBe(0);
  });
});
