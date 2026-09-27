import type { MapDef, P } from '../sim/mapgen';
import { blob } from '../sim/mapgen';
import { Rng } from '../sim/math';

const PLACE_A = ['Oster', 'Wester', 'Hoog', 'Laag', 'Nieuw', 'Oud', 'Groot', 'Klein', 'Sint', 'Berg'];
const PLACE_B = ['veld', 'dorp', 'brug', 'hoven', 'dam', 'beek', 'wijk', 'holt', 'stein', 'haven'];

/** A procedurally generated 800 m battlefield (NATO attacks from the south). */
export function randomMap(seed: number): MapDef {
  const rng = new Rng(seed);
  const name = `${rng.pick(PLACE_A)}${rng.pick(PLACE_B)}`;
  const W = 800;
  // main road wanders north
  const x0 = rng.range(250, 550);
  const mainRoad: P[] = [];
  for (let y = 0; y <= W; y += 160) mainRoad.push([Math.max(60, Math.min(740, x0 + rng.range(-70, 70))), y]);
  const crossY = rng.range(380, 560);
  const cross: P[] = [[0, crossY + rng.range(-40, 40)], [W / 2, crossY], [W, crossY + rng.range(-40, 40)]];
  const roads: MapDef['roads'] = [{ pts: mainRoad }, { pts: cross, width: 7 }];
  // side tracks
  for (let i = 0; i < rng.int(1, 3); i++) {
    const sx = rng.range(80, 720);
    roads.push({ pts: [[sx, rng.range(0, 200)], [sx + rng.range(-120, 120), rng.range(300, 700)], [rng.range(80, 720), W]], dirt: true });
  }
  // optional river south of the town with the main road bridging it
  const rivers: MapDef['rivers'] = [];
  const hasRiver = rng.chance(0.55);
  const riverY = rng.range(260, 330);
  if (hasRiver) {
    const wide = rng.chance(0.4);
    rivers.push({ pts: [[0, riverY + rng.range(-30, 30)], [W * 0.35, riverY + rng.range(-25, 25)], [W * 0.7, riverY + rng.range(-25, 25)], [W, riverY + rng.range(-30, 30)]], width: wide ? 44 : 22, depth: 3 });
  }
  const townX = mainRoad.reduce((a, p) => (Math.abs(p[1] - crossY) < Math.abs(a[1] - crossY) ? p : a))[0];
  const towns: MapDef['towns'] = [
    { rect: { x: townX - 130, y: crossY - 90, w: 260, h: 190 }, density: rng.range(0.7, 0.95), floors: [1, rng.int(2, 3)], fill: rng.range(0.2, 0.4), holes: [{ x: townX - 25, y: crossY - 25, w: 50, h: 50 }] },
  ];
  if (rng.chance(0.6)) {
    const hx = rng.range(100, 700);
    const hy = rng.range(620, 740);
    towns.push({ rect: { x: hx - 70, y: hy - 50, w: 140, h: 100 }, density: 0.6, floors: [1, 2], fill: 0.15 });
  }
  // woods, fields and hedges
  const areas: MapDef['areas'] = [];
  const hedges: P[][] = [];
  for (let i = 0; i < rng.int(3, 6); i++) areas.push({ type: 'forest', pts: blob(rng.range(60, 740), rng.range(200, 760), rng.range(50, 120), rng.int(1, 1e6)) });
  for (let i = 0; i < rng.int(3, 6); i++) {
    const fx = rng.range(40, 600);
    const fy = rng.range(20, 700);
    const fw = rng.range(120, 220);
    const fh = rng.range(90, 180);
    areas.push({ type: rng.chance(0.75) ? 'field' : 'orchard', pts: [[fx, fy], [fx + fw, fy], [fx + fw, fy + fh], [fx, fy + fh]] });
    if (rng.chance(0.7)) hedges.push([[fx, fy], [fx + fw, fy], [fx + fw, fy + fh]]);
  }
  const hills = Array.from({ length: rng.int(1, 3) }, () => ({ x: rng.range(80, 720), y: rng.range(250, 760), r: rng.range(100, 180), h: rng.range(4, 10) }));
  // victory locations
  const vls: MapDef['vls'] = [{ id: 'town', name: `${name} Crossroads`, x: townX, y: crossY, value: 3, owner: 'opfor' }];
  if (hasRiver) {
    const bx = mainRoad.reduce((a, p) => (Math.abs(p[1] - riverY) < Math.abs(a[1] - riverY) ? p : a))[0];
    vls.push({ id: 'bridge', name: `${name} Bridge`, x: bx, y: riverY, value: 2, owner: null });
  }
  const f0 = areas.find((a) => a.type === 'forest');
  if (f0) {
    const cx = f0.pts.reduce((n, p) => n + p[0], 0) / f0.pts.length;
    const cy = f0.pts.reduce((n, p) => n + p[1], 0) / f0.pts.length;
    if (cy > 330) vls.push({ id: 'wood', name: 'The Woods', x: cx, y: cy, value: 1, owner: 'opfor' });
  }
  if (towns[1]) vls.push({ id: 'hamlet', name: 'Hamlet', x: towns[1].rect.x + 70, y: towns[1].rect.y + 50, value: 1, owner: 'opfor' });
  const hill = hills.reduce((a, h) => (h.h > a.h ? h : a));
  if (hill.y > 340) vls.push({ id: 'hill', name: `Hill ${Math.round(30 + hill.h * 3)}`, x: hill.x, y: hill.y, value: 1, owner: null });
  return {
    id: `random-${seed}`,
    name: `${name} (random)`,
    description: `A generated battlefield around the village of ${name}${hasRiver ? ', with a river crossing to the south of the town' : ''}. NATO attacks from the south.`,
    size: [W, W],
    seed,
    relief: { amp: rng.range(1.5, 4), scale: rng.range(160, 260) },
    hills,
    rivers,
    roads,
    areas,
    hedges,
    towns,
    vls,
    deploy: { nato: { x: 40, y: 15, w: 720, h: 150 }, opfor: { x: 40, y: Math.max(hasRiver ? riverY + 40 : 360, 340), w: 720, h: 780 - Math.max(hasRiver ? riverY + 40 : 360, 340) } },
    rear: { nato: 'south', opfor: 'north' },
  };
}
