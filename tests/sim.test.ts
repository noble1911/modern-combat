import { describe, expect, it } from 'vitest';
import { WEAPONS } from '../src/data/weapons';
import { hitVehicle } from '../src/sim/combat';
import { generateMap, MapDef } from '../src/sim/mapgen';
import { issueOrder } from '../src/sim/orders';
import { findPath } from '../src/sim/pathfinding';
import { T } from '../src/sim/terrain';
import { World } from '../src/sim/world';

function testMap(extra: Partial<MapDef> = {}): MapDef {
  return {
    id: 'test',
    name: 'Test',
    description: '',
    size: [400, 400],
    seed: 5,
    relief: { amp: 0, scale: 100 },
    vls: [{ id: 'a', name: 'A', x: 200, y: 200, value: 1, owner: null }],
    deploy: { nato: { x: 0, y: 0, w: 400, h: 100 }, opfor: { x: 0, y: 300, w: 400, h: 100 } },
    rear: { nato: 'south', opfor: 'north' },
    ...extra,
  };
}

function world(def: MapDef): World {
  const w = new World(generateMap(def), {
    seed: 3,
    timeLimit: 600,
    sides: { nato: { ai: false, posture: 'attack', rear: { x: 0, y: -1 } }, opfor: { ai: false, posture: 'defend', rear: { x: 0, y: 1 } } },
  });
  return w;
}

describe('line of sight', () => {
  it('is blocked by a building but not by open ground', () => {
    const g = generateMap(testMap({ buildings: [{ x: 200, y: 200, w: 16, h: 16, floors: 2 }] }));
    const m = g.map;
    // clear the base scrub so only the building matters
    for (let i = 0; i < m.type.length; i++) if (m.type[i] === T.Scrub) m.type[i] = T.Grass;
    expect(m.los(100, 200, 1.7, 300, 200, 1.7).clear).toBe(false);
    expect(m.los(100, 100, 1.7, 300, 100, 1.7).clear).toBe(true);
  });

  it('lets a soldier hugging a hedge see through it, but not a distant one', () => {
    const g = generateMap(testMap({ hedges: [[[0, 200], [400, 200]]] }));
    const m = g.map;
    for (let i = 0; i < m.type.length; i++) if (m.type[i] === T.Scrub) m.type[i] = T.Grass;
    // observer right behind the hedge (within 6 m) can see across the field
    expect(m.los(200, 196, 1.1, 200, 300, 1.0).clear).toBe(true);
    // observer 50 m back cannot see through the hedgerow
    expect(m.los(200, 150, 1.1, 200, 300, 1.0).clear).toBe(false);
  });

  it('is obscured by smoke, less so for thermal optics', () => {
    const m = generateMap(testMap()).map;
    for (let i = 0; i < m.type.length; i++) if (m.type[i] === T.Scrub) m.type[i] = T.Grass;
    m.smoke.push({ id: 1, x: 200, y: 200, r: 14, density: 0.08, age: 10, life: 60, vx: 0, vy: 0 });
    expect(m.los(100, 200, 1.7, 300, 200, 1.7, 1).clear).toBe(false);
    expect(m.los(100, 200, 1.7, 300, 200, 1.7, 0.35).clear).toBe(true);
  });
});

describe('pathfinding', () => {
  it('routes around a river via the bridge', () => {
    const g = generateMap(testMap({ rivers: [{ pts: [[0, 200], [400, 200]], width: 20 }], roads: [{ pts: [[300, 0], [300, 400]] }] }));
    const p = findPath(g.map, { x: 100, y: 100 }, { x: 100, y: 300 }, { mob: 'track' });
    expect(p).not.toBeNull();
    // the route must cross the river on the bridge at x≈300
    const pts = [{ x: 100, y: 100 }, ...p!];
    let crossX = NaN;
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i];
      const b = pts[i + 1];
      if ((a.y - 200) * (b.y - 200) <= 0 && a.y !== b.y) crossX = a.x + ((200 - a.y) / (b.y - a.y)) * (b.x - a.x);
    }
    expect(Math.abs(crossX - 300)).toBeLessThan(12);
  });
});

describe('armour', () => {
  it('Javelin top attack kills a T-90M; 25mm bounces off its front', () => {
    let kills = 0;
    let bounces = 0;
    for (let i = 0; i < 20; i++) {
      const w = world(testMap());
      const u = w.spawnUnit('ru_t90m', 'opfor', { x: 200, y: 300 }, { facing: -Math.PI / 2 });
      const v = w.vehicles[u.vehicle];
      if (hitVehicle(w, v, WEAPONS.javelin, 200, 100, -1, -1) === 'destroyed' || v.immobilized || v.gunDamaged) kills++;
      const w2 = world(testMap());
      const u2 = w2.spawnUnit('ru_t90m', 'opfor', { x: 200, y: 300 }, { facing: -Math.PI / 2 });
      if (hitVehicle(w2, w2.vehicles[u2.vehicle], WEAPONS.m242, 200, 100, -1, -1) === 'bounced') bounces++;
    }
    expect(kills).toBeGreaterThan(14);
    expect(bounces).toBe(20);
  });

  it('Trophy APS intercepts some rockets', () => {
    const w = world(testMap());
    const u = w.spawnUnit('us_m1a2', 'nato', { x: 200, y: 100 }, { facing: Math.PI / 2 });
    const v = w.vehicles[u.vehicle];
    const results = Array.from({ length: 4 }, () => hitVehicle(w, v, WEAPONS.rpg7, 200, 300, -1, -1));
    expect(results.filter((r) => r === 'aps').length).toBeGreaterThan(0);
  });
});

describe('morale and orders', () => {
  it('heavy suppression pins soldiers', () => {
    const w = world(testMap());
    const u = w.spawnUnit('us_rifle', 'nato', { x: 200, y: 100 });
    w.startBattle();
    for (const id of u.soldiers) w.soldiers[id].supp = 95;
    w.step();
    const states = u.soldiers.map((id) => w.soldiers[id].state);
    expect(states.every((s) => s === 'cowering' || s === 'pinned' || s === 'berserk')).toBe(true);
  });

  it('a move order walks the squad to its destination', () => {
    const w = world(testMap());
    const u = w.spawnUnit('us_rifle', 'nato', { x: 100, y: 60 });
    w.spawnUnit('ru_sniper', 'opfor', { x: 380, y: 390 }); // keeps the battle alive
    w.startBattle();
    expect(issueOrder(w, u.id, { kind: 'move', target: { x: 150, y: 90 } }).ok).toBe(true);
    for (let i = 0; i < 600 && u.order.kind === 'move'; i++) w.step();
    const p = w.unitPos(u);
    expect(Math.hypot(p.x - 150, p.y - 90)).toBeLessThan(15);
  });
});

describe('spotting', () => {
  it('spots a squad in the open but not one hidden in woods far away', () => {
    const def = testMap({ areas: [{ type: 'forest', pts: [[250, 280], [350, 280], [350, 380], [250, 380]] }] });
    const w = world(def);
    for (let i = 0; i < w.map.type.length; i++) if (w.map.type[i] === T.Scrub) w.map.type[i] = T.Grass;
    w.spawnUnit('us_rifle', 'nato', { x: 200, y: 60 });
    const open = w.spawnUnit('ru_rifle', 'opfor', { x: 120, y: 220 });
    const hidden = w.spawnUnit('ru_rifle', 'opfor', { x: 300, y: 350 });
    for (const id of hidden.soldiers) w.soldiers[id].stance = 'prone';
    // freeze everyone so only spotting runs
    w.startBattle();
    for (let i = 0; i < 150; i++) {
      for (const s of w.soldiers) s.supp = 0;
      w.step();
    }
    expect(w.spotted.nato.has(open.id)).toBe(true);
    expect(w.spotted.nato.get(hidden.id)?.visible ?? false).toBe(false);
  });
});
