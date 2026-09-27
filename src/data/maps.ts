import type { MapDef } from '../sim/mapgen';
import { blob } from '../sim/mapgen';

// All maps are 800 x 800 m. x = east, y = north. NATO generally advances from the south (y = 0).

const veldmark: MapDef = {
  id: 'veldmark',
  name: 'Veldmark Drop Zone',
  description:
    'Air assault companies have landed in the fields south of Veldmark. The village sits astride Route Iron and the east–west road. Take the crossroads and the church before OPFOR reserves arrive.',
  size: [800, 800],
  seed: 1101,
  relief: { amp: 3, scale: 220 },
  hills: [
    { x: 660, y: 300, r: 140, h: 9 },
    { x: 190, y: 660, r: 160, h: 7 },
    { x: 560, y: 720, r: 120, h: 5 },
  ],
  roads: [
    { pts: [[400, 0], [385, 180], [392, 330], [405, 468], [420, 620], [432, 800]] },
    { pts: [[0, 486], [180, 480], [405, 468], [610, 470], [800, 505]] },
    { pts: [[405, 468], [300, 560], [220, 640], [140, 720], [90, 800]], dirt: true },
    { pts: [[610, 470], [650, 440], [660, 360], [700, 200], [720, 0]], dirt: true },
  ],
  areas: [
    { type: 'forest', pts: [[30, 300], [210, 285], [262, 400], [215, 520], [150, 560], [50, 540], [18, 420]] },
    { type: 'forest', pts: [[560, 600], [760, 575], [792, 700], [780, 790], [600, 792], [540, 700]] },
    { type: 'forest', pts: blob(660, 300, 55, 11) },
    { type: 'field', pts: [[70, 40], [340, 40], [330, 225], [90, 245]] },
    { type: 'field', pts: [[470, 70], [770, 80], [760, 240], [500, 255]] },
    { type: 'field', pts: [[260, 620], [400, 610], [410, 790], [250, 790]] },
    { type: 'orchard', pts: [[470, 380], [560, 380], [560, 440], [470, 440]] },
  ],
  scatter: [{ type: 'forest', rect: { x: 20, y: 600, w: 180, h: 180 }, count: 4, r: [18, 34] }],
  hedges: [
    [[70, 250], [335, 228]],
    [[500, 258], [765, 245]],
    [[335, 228], [345, 40]],
    [[240, 610], [410, 605]],
    [[470, 375], [565, 375]],
    [[20, 580], [230, 580]],
  ],
  walls: [
    [[335, 495], [385, 495], [385, 548], [335, 548], [335, 495]],
    [[620, 420], [690, 420], [690, 470]],
  ],
  towns: [{ rect: { x: 300, y: 400, w: 220, h: 170 }, density: 0.85, floors: [1, 2], fill: 0.25, holes: [{ x: 380, y: 445, w: 50, h: 45 }] }],
  buildings: [
    { x: 360, y: 522, w: 16, h: 26, floors: 3, name: 'Church' },
    { x: 655, y: 445, w: 16, h: 12, floors: 2, name: 'Farmhouse' },
    { x: 668, y: 470, w: 20, h: 10, floors: 1, name: 'Barn' },
  ],
  vls: [
    { id: 'xroads', name: 'Veldmark Crossroads', x: 405, y: 468, value: 3, owner: 'opfor' },
    { id: 'church', name: 'Church', x: 360, y: 522, value: 2, owner: 'opfor' },
    { id: 'farm', name: 'Farmstead', x: 655, y: 450, value: 1, owner: 'opfor' },
    { id: 'woods', name: 'West Woodline', x: 215, y: 420, value: 1, owner: 'opfor' },
    { id: 'hill', name: 'Hill 38', x: 660, y: 300, value: 1, owner: null },
  ],
  deploy: { nato: { x: 40, y: 15, w: 720, h: 165 }, opfor: { x: 40, y: 380, w: 720, h: 400 } },
  deployAlt: { attacker: 'opfor', zones: { nato: { x: 230, y: 360, w: 460, h: 260 }, opfor: { x: 40, y: 670, w: 720, h: 120 } }, rear: { nato: 'south', opfor: 'north' } },
  rear: { nato: 'south', opfor: 'north' },
};

const zonbrug: MapDef = {
  id: 'zonbrug',
  name: 'Zonbrug Canal Bridge',
  description:
    'The Zonbrug road bridge carries Route Iron over the Wilhelm Canal. Engineers report it intact — for now. Seize the bridge and clear the town on the north bank.',
  size: [800, 800],
  seed: 2202,
  relief: { amp: 2.5, scale: 200 },
  hills: [{ x: 120, y: 200, r: 150, h: 5 }, { x: 700, y: 640, r: 140, h: 6 }],
  rivers: [{ pts: [[0, 432], [250, 420], [550, 426], [800, 414]], width: 26, depth: 3 }],
  roads: [
    { pts: [[400, 0], [405, 250], [400, 424], [395, 600], [410, 800]] },
    { pts: [[0, 468], [250, 458], [550, 462], [800, 452]], width: 6 },
    { pts: [[0, 392], [200, 385]], dirt: true },
    { pts: [[405, 250], [600, 260], [800, 240]], dirt: true },
    { pts: [[395, 600], [250, 610], [0, 640]] },
  ],
  areas: [
    { type: 'forest', pts: [[20, 90], [250, 110], [262, 300], [150, 330], [36, 330]] },
    { type: 'forest', pts: [[600, 700], [790, 690], [792, 792], [580, 792]] },
    { type: 'field', pts: [[480, 50], [780, 60], [780, 225], [500, 235]] },
    { type: 'field', pts: [[470, 280], [780, 270], [780, 390], [480, 395]] },
    { type: 'field', pts: [[20, 660], [240, 660], [240, 790], [20, 790]] },
    { type: 'scrub', pts: [[210, 330], [380, 340], [380, 400], [210, 400]] },
  ],
  hedges: [
    [[470, 270], [780, 262]],
    [[470, 280], [480, 395]],
    [[20, 655], [245, 650]],
    [[245, 650], [240, 790]],
  ],
  walls: [[[300, 480], [300, 540]], [[510, 480], [510, 540]]],
  towns: [
    { rect: { x: 250, y: 475, w: 320, h: 215 }, density: 0.9, floors: [1, 3], fill: 0.35 },
    { rect: { x: 330, y: 280, w: 140, h: 110 }, density: 0.7, floors: [1, 2], fill: 0.1 },
  ],
  buildings: [
    { x: 520, y: 650, w: 8, h: 8, floors: 6, name: 'Water Tower' },
    { x: 662, y: 396, w: 12, h: 10, floors: 2, name: 'Lock House' },
  ],
  vls: [
    { id: 'bridge', name: 'Canal Bridge', x: 400, y: 424, value: 4, owner: 'opfor' },
    { id: 'square', name: 'Zonbrug Square', x: 405, y: 560, value: 2, owner: 'opfor' },
    { id: 'tower', name: 'Water Tower', x: 520, y: 650, value: 1, owner: 'opfor' },
    { id: 'lock', name: 'Lock House', x: 662, y: 390, value: 1, owner: 'opfor' },
    { id: 'hamlet', name: 'South Hamlet', x: 400, y: 320, value: 1, owner: null },
  ],
  deploy: { nato: { x: 40, y: 20, w: 720, h: 190 }, opfor: { x: 40, y: 340, w: 720, h: 440 } },
  deployAlt: { attacker: 'opfor', zones: { nato: { x: 220, y: 300, w: 380, h: 360 }, opfor: { x: 40, y: 700, w: 720, h: 90 } }, rear: { nato: 'south', opfor: 'north' } },
  rear: { nato: 'south', opfor: 'north' },
};

const hollen: MapDef = {
  id: 'hollen',
  name: 'Hollen Crossroads',
  description:
    'Bocage country. OPFOR armour is striking from the east to cut Route Iron at the Hollen crossroads. Hold the corridor open at all costs.',
  size: [800, 800],
  seed: 3303,
  relief: { amp: 3.5, scale: 180 },
  hills: [{ x: 720, y: 520, r: 160, h: 8 }, { x: 150, y: 640, r: 120, h: 4 }],
  rivers: [{ pts: [[0, 110], [300, 90], [520, 120], [800, 95]], width: 8, shallow: true, depth: 1.2 }],
  roads: [
    { pts: [[380, 0], [388, 200], [392, 400], [398, 600], [402, 800]], width: 9 },
    { pts: [[0, 380], [200, 388], [392, 400], [600, 410], [800, 425]] },
    { pts: [[200, 388], [205, 220], [180, 0]], dirt: true },
    { pts: [[600, 410], [570, 560], [560, 800]], dirt: true },
  ],
  areas: [
    { type: 'forest', pts: [[680, 190], [792, 170], [792, 380], [690, 362]] },
    { type: 'orchard', pts: [[420, 450], [520, 450], [520, 540], [420, 540]] },
    { type: 'orchard', pts: [[250, 500], [340, 500], [340, 600], [250, 600]] },
    { type: 'field', pts: [[40, 160], [150, 160], [150, 360], [40, 360]] },
    { type: 'field', pts: [[420, 160], [650, 160], [650, 360], [420, 360]] },
    { type: 'field', pts: [[40, 440], [240, 440], [240, 620], [40, 620]] },
    { type: 'field', pts: [[620, 600], [790, 600], [790, 790], [620, 790]] },
    { type: 'scrub', pts: [[250, 650], [390, 650], [390, 790], [250, 790]] },
  ],
  hedges: [
    [[150, 150], [150, 370]],
    [[270, 150], [270, 370]],
    [[520, 150], [520, 375]],
    [[650, 150], [655, 380]],
    [[30, 150], [780, 150]],
    [[30, 270], [370, 270]],
    [[420, 270], [680, 270]],
    [[30, 530], [370, 530]],
    [[420, 560], [780, 580]],
    [[245, 430], [245, 640]],
    [[520, 440], [530, 790]],
    [[30, 650], [370, 650]],
    [[610, 650], [790, 650]],
  ],
  walls: [[[180, 200], [230, 200], [230, 240]]],
  towns: [{ rect: { x: 330, y: 345, w: 150, h: 120 }, density: 0.65, floors: [1, 2], fill: 0.15 }],
  buildings: [
    { x: 562, y: 565, w: 18, h: 12, floors: 2, name: 'Hollen Farm' },
    { x: 590, y: 540, w: 12, h: 20, floors: 1, name: 'Barn' },
    { x: 205, y: 222, w: 14, h: 12, floors: 2, name: 'Van Dijk Farm' },
  ],
  vls: [
    { id: 'xroads', name: 'Hollen Crossroads', x: 392, y: 400, value: 3, owner: 'nato' },
    { id: 'farm', name: 'Hollen Farm', x: 565, y: 560, value: 2, owner: 'nato' },
    { id: 'vandijk', name: 'Van Dijk Farm', x: 205, y: 222, value: 1, owner: 'nato' },
    { id: 'orchard', name: 'Orchard', x: 470, y: 495, value: 1, owner: 'nato' },
    { id: 'eastwood', name: 'East Wood', x: 735, y: 280, value: 1, owner: null },
  ],
  deploy: { nato: { x: 150, y: 170, w: 470, h: 430 }, opfor: { x: 640, y: 30, w: 150, h: 740 } },
  deployAlt: { attacker: 'nato', zones: { nato: { x: 30, y: 15, w: 740, h: 115 }, opfor: { x: 150, y: 200, w: 470, h: 400 } }, rear: { nato: 'south', opfor: 'north' } },
  rear: { nato: 'south', opfor: 'east' },
};

const maasbrug: MapDef = {
  id: 'maasbrug',
  name: 'Maasbrug River Crossing',
  description:
    'The 300-metre Maasbrug spans the river on a single causeway. OPFOR has prepared the far bank. Win the bridge intact and the corridor is halfway open.',
  size: [800, 800],
  seed: 4404,
  relief: { amp: 2, scale: 240 },
  hills: [{ x: 150, y: 140, r: 140, h: 5 }, { x: 650, y: 650, r: 150, h: 7 }],
  rivers: [{ pts: [[0, 378], [300, 398], [500, 393], [800, 418]], width: 72, depth: 4 }],
  roads: [
    { pts: [[410, 0], [406, 300], [401, 400], [396, 520], [395, 800]], width: 9 },
    { pts: [[0, 318], [200, 330], [406, 320], [800, 345]], width: 6, dirt: true },
    { pts: [[0, 468], [396, 470], [800, 492]], width: 6, dirt: true },
    { pts: [[406, 220], [200, 210], [0, 180]] },
  ],
  areas: [
    { type: 'forest', pts: [[40, 40], [250, 60], [240, 190], [30, 220]] },
    { type: 'forest', pts: [[570, 610], [780, 590], [780, 790], [560, 790]] },
    { type: 'field', pts: [[560, 60], [780, 60], [780, 290], [560, 290]] },
    { type: 'field', pts: [[20, 520], [260, 520], [260, 760], [20, 760]] },
    { type: 'marsh', pts: [[0, 300], [330, 322], [330, 352], [0, 338]] },
    { type: 'marsh', pts: [[470, 438], [800, 456], [800, 505], [470, 492]] },
    { type: 'scrub', pts: [[0, 425], [320, 440], [320, 480], [0, 478]] },
  ],
  hedges: [
    [[560, 295], [780, 300]],
    [[260, 515], [260, 760]],
    [[20, 515], [260, 515]],
  ],
  walls: [],
  towns: [
    { rect: { x: 300, y: 150, w: 220, h: 140 }, density: 0.75, floors: [1, 2], fill: 0.2 },
    { rect: { x: 300, y: 500, w: 200, h: 150 }, density: 0.7, floors: [1, 3], fill: 0.2 },
  ],
  buildings: [{ x: 440, y: 510, w: 14, h: 14, floors: 3, name: 'Customs House' }],
  vls: [
    { id: 'southhead', name: 'South Bridgehead', x: 406, y: 318, value: 2, owner: 'opfor' },
    { id: 'bridge', name: 'Maas Bridge', x: 401, y: 396, value: 4, owner: 'opfor' },
    { id: 'northhead', name: 'North Bridgehead', x: 398, y: 478, value: 2, owner: 'opfor' },
    { id: 'grevenhof', name: 'Grevenhof', x: 410, y: 215, value: 1, owner: null },
    { id: 'overmaas', name: 'Overmaas', x: 396, y: 590, value: 1, owner: 'opfor' },
  ],
  deploy: { nato: { x: 40, y: 20, w: 720, h: 130 }, opfor: { x: 40, y: 250, w: 720, h: 530 } },
  deployAlt: { attacker: 'opfor', zones: { nato: { x: 250, y: 230, w: 320, h: 360 }, opfor: { x: 40, y: 670, w: 720, h: 110 } }, rear: { nato: 'south', opfor: 'north' } },
  rear: { nato: 'south', opfor: 'north' },
};

const nordhaven: MapDef = {
  id: 'nordhaven',
  name: 'Nordhaven City',
  description:
    'Street fighting through Nordhaven to reach the great road bridge on the northern edge of the city. Every block is a fortress.',
  size: [800, 800],
  seed: 5505,
  relief: { amp: 2, scale: 260 },
  hills: [{ x: 560, y: 620, r: 110, h: 8 }],
  rivers: [{ pts: [[0, 742], [400, 748], [800, 756]], width: 64, depth: 4 }],
  roads: [
    { pts: [[400, 0], [400, 320], [415, 520], [425, 800]], width: 10 },
    { pts: [[0, 180], [800, 190]], width: 7 },
    { pts: [[0, 320], [800, 330]], width: 8 },
    { pts: [[0, 460], [800, 470]], width: 7 },
    { pts: [[0, 600], [440, 605]], width: 7 },
    { pts: [[200, 90], [205, 700]], width: 7 },
    { pts: [[600, 90], [610, 560]], width: 7 },
    { pts: [[0, 690], [800, 700]], width: 6 },
  ],
  areas: [
    { type: 'orchard', pts: [[470, 540], [640, 540], [640, 680], [470, 680]] },
    { type: 'forest', pts: [[520, 580], [600, 580], [600, 650], [520, 650]] },
    { type: 'grass', pts: [[640, 40], [790, 40], [790, 150], [640, 150]] },
  ],
  hedges: [],
  walls: [
    [[470, 540], [640, 540]],
    [[640, 540], [640, 680]],
  ],
  towns: [
    { rect: { x: 60, y: 100, w: 400, h: 580 }, density: 0.95, floors: [2, 4], fill: 0.5, lot: [3, 5], holes: [{ x: 365, y: 290, w: 70, h: 70 }] },
    { rect: { x: 460, y: 100, w: 300, h: 420 }, density: 0.9, floors: [2, 4], fill: 0.45, lot: [3, 5] },
    { rect: { x: 640, y: 540, w: 140, h: 140 }, density: 0.8, floors: [2, 3], fill: 0.3 },
  ],
  buildings: [
    { x: 600, y: 480, w: 24, h: 18, floors: 3, name: 'Post Office' },
    { x: 180, y: 200, w: 30, h: 16, floors: 2, name: 'Station' },
  ],
  vls: [
    { id: 'circle', name: 'Traffic Circle', x: 400, y: 325, value: 2, owner: 'opfor' },
    { id: 'post', name: 'Post Office', x: 600, y: 480, value: 1, owner: 'opfor' },
    { id: 'park', name: 'Valkhof Park', x: 555, y: 615, value: 2, owner: 'opfor' },
    { id: 'approach', name: 'Bridge Approach', x: 422, y: 690, value: 3, owner: 'opfor' },
    { id: 'station', name: 'Station', x: 185, y: 210, value: 1, owner: 'opfor' },
  ],
  deploy: { nato: { x: 40, y: 10, w: 720, h: 100 }, opfor: { x: 40, y: 250, w: 720, h: 460 } },
  deployAlt: { attacker: 'opfor', zones: { nato: { x: 120, y: 240, w: 480, h: 440 }, opfor: { x: 660, y: 100, w: 130, h: 590 } }, rear: { nato: 'south', opfor: 'east' } },
  rear: { nato: 'south', opfor: 'north' },
};

const arnholt: MapDef = {
  id: 'arnholt',
  name: 'Arnholt Bridge',
  description:
    'A lone airborne battalion holds the northern ramp of the Arnholt bridge — the last crossing on Route Iron. OPFOR armour is closing in. Hold until relieved.',
  size: [800, 800],
  seed: 6606,
  relief: { amp: 2, scale: 260 },
  hills: [{ x: 620, y: 620, r: 180, h: 10 }, { x: 150, y: 700, r: 140, h: 6 }],
  rivers: [{ pts: [[0, 112], [400, 124], [800, 140]], width: 72, depth: 4 }],
  roads: [
    { pts: [[400, 0], [400, 300], [390, 520], [380, 800]], width: 10 },
    { pts: [[0, 196], [400, 204], [800, 222]], width: 7 },
    { pts: [[0, 330], [800, 345]], width: 7 },
    { pts: [[0, 470], [800, 482]], width: 7 },
    { pts: [[0, 610], [800, 622]], width: 6 },
    { pts: [[200, 196], [210, 760]], width: 6 },
    { pts: [[600, 214], [610, 760]], width: 6 },
  ],
  areas: [
    { type: 'orchard', pts: [[640, 380], [760, 380], [760, 460], [640, 460]] },
    { type: 'forest', pts: [[660, 660], [790, 650], [790, 790], [650, 790]] },
    { type: 'grass', pts: [[330, 380], [460, 380], [460, 455], [330, 455]] },
  ],
  walls: [[[640, 378], [760, 378]]],
  towns: [
    { rect: { x: 60, y: 220, w: 680, h: 520 }, density: 0.9, floors: [2, 4], fill: 0.45, lot: [3, 5], holes: [{ x: 335, y: 380, w: 120, h: 75 }, { x: 640, y: 375, w: 125, h: 90 }] },
  ],
  buildings: [
    { x: 470, y: 262, w: 20, h: 16, floors: 3, name: 'Brigade HQ' },
    { x: 250, y: 420, w: 18, h: 30, floors: 4, name: 'St. Eusebius Church' },
  ],
  vls: [
    { id: 'ramp', name: 'Bridge Ramp', x: 400, y: 205, value: 4, owner: 'nato' },
    { id: 'hq', name: 'Brigade HQ', x: 470, y: 262, value: 2, owner: 'nato' },
    { id: 'waterfront', name: 'Waterfront', x: 250, y: 205, value: 1, owner: 'nato' },
    { id: 'church', name: 'St. Eusebius Church', x: 250, y: 420, value: 1, owner: 'opfor' },
    { id: 'market', name: 'Market Square', x: 395, y: 418, value: 2, owner: 'opfor' },
  ],
  deploy: { nato: { x: 230, y: 165, w: 340, h: 200 }, opfor: { x: 40, y: 540, w: 720, h: 240 } },
  deployAlt: { attacker: 'nato', zones: { nato: { x: 200, y: 8, w: 400, h: 58 }, opfor: { x: 60, y: 200, w: 680, h: 520 } }, rear: { nato: 'south', opfor: 'north' } },
  rear: { nato: 'south', opfor: 'north' },
};

export const MAPS: Record<string, MapDef> = { veldmark, zonbrug, hollen, maasbrug, nordhaven, arnholt };

const extraMaps = new Map<string, MapDef>();
/** Register a generated map so battles and thumbnails can look it up by id. */
export function registerMap(def: MapDef): void {
  extraMaps.set(def.id, def);
}
export function getMap(id: string): MapDef | undefined {
  return MAPS[id] ?? extraMaps.get(id);
}
export const MAP_ORDER = ['veldmark', 'zonbrug', 'hollen', 'maasbrug', 'nordhaven', 'arnholt'];
