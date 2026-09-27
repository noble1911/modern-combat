import * as THREE from 'three';

/**
 * Procedural PBR facade and roof textures. Each set is painted on three canvases that share the
 * same layout: albedo (near-white so vertex colours tint it), height (turned into a normal map)
 * and roughness (glass is glossy and reflects the sky, render and brick are matte).
 *
 * Wall layout: one tile = one 4 m window bay × one 3.2 m storey (256 × 256 px).
 * Roof layout: one tile = 3 m × 5 m of pantiles.
 */
export interface PbrSet {
  map: THREE.Texture;
  normalMap: THREE.Texture;
  roughnessMap: THREE.Texture;
}

const S = 256;
const PX_X = S / 4; // px per metre across a bay
const PX_Y = S / 3.2; // px per metre up a storey

function canvas(): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = c.height = S;
  return [c, c.getContext('2d')!];
}

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const grey = (v: number) => `rgb(${v | 0},${v | 0},${v | 0})`;

/** Normal map (tangent space, +Y up in texture) from a height canvas. */
function normalFromHeight(h: HTMLCanvasElement, strength: number): THREE.DataTexture {
  const src = h.getContext('2d')!.getImageData(0, 0, S, S).data;
  const out = new Uint8Array(S * S * 4);
  const at = (x: number, y: number) => src[(((y + S) % S) * S + ((x + S) % S)) * 4] / 255;
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const dx = (at(x + 1, y) - at(x - 1, y)) * strength;
      const dy = (at(x, y + 1) - at(x, y - 1)) * strength;
      // canvas y runs down while texture v runs up: flip dy
      const n = new THREE.Vector3(-dx, dy, 1).normalize();
      const i = ((S - 1 - y) * S + x) * 4;
      out[i] = (n.x * 0.5 + 0.5) * 255;
      out[i + 1] = (n.y * 0.5 + 0.5) * 255;
      out[i + 2] = (n.z * 0.5 + 0.5) * 255;
      out[i + 3] = 255;
    }
  }
  const t = new THREE.DataTexture(out, S, S, THREE.RGBAFormat);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = 4;
  t.needsUpdate = true;
  return t;
}

function finish(albedo: HTMLCanvasElement, height: HTMLCanvasElement, rough: HTMLCanvasElement, strength: number): PbrSet {
  const map = new THREE.CanvasTexture(albedo);
  map.colorSpace = THREE.SRGBColorSpace;
  const roughnessMap = new THREE.CanvasTexture(rough);
  for (const t of [map, roughnessMap]) {
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.anisotropy = 4;
  }
  return { map, normalMap: normalFromHeight(height, strength), roughnessMap };
}

/** Speckle a canvas with small blotches of grey around `base`. */
function speckle(g: CanvasRenderingContext2D, r: () => number, base: number, spread: number, n: number, size: number): void {
  for (let i = 0; i < n; i++) {
    g.fillStyle = grey(base + (r() - 0.5) * spread);
    const s = 1 + r() * size;
    g.fillRect(r() * S, r() * S, s, s);
  }
}

/** A casement window centred in the bay: frame, mullions, glass, sill and lintel. */
function drawWindow(a: CanvasRenderingContext2D, h: CanvasRenderingContext2D, ro: CanvasRenderingContext2D, style: 'plaster' | 'brick'): void {
  const w = 1.25 * PX_X;
  const ht = 1.45 * PX_Y;
  const x0 = (S - w) / 2;
  const yb = S - 0.9 * PX_Y; // sill line (0.9 m above the floor)
  const y0 = yb - ht;
  const f = 5; // frame width px
  // reveal (recess) shadow
  a.fillStyle = grey(style === 'brick' ? 120 : 150);
  a.fillRect(x0 - 3, y0 - 3, w + 6, ht + 6);
  h.fillStyle = grey(40);
  h.fillRect(x0 - 2, y0 - 2, w + 4, ht + 4);
  // frame
  a.fillStyle = grey(236);
  a.fillRect(x0, y0, w, ht);
  h.fillStyle = grey(95);
  h.fillRect(x0, y0, w, ht);
  ro.fillStyle = grey(120);
  ro.fillRect(x0, y0, w, ht);
  // glass panes (2 × 2 with a transom)
  const panes: [number, number, number, number][] = [];
  const mid = x0 + w / 2;
  const tr = y0 + ht * 0.3;
  panes.push([x0 + f, y0 + f, w / 2 - f * 1.5, tr - y0 - f * 1.5]);
  panes.push([mid + f / 2, y0 + f, w / 2 - f * 1.5, tr - y0 - f * 1.5]);
  panes.push([x0 + f, tr + f / 2, w / 2 - f * 1.5, yb - tr - f * 1.5]);
  panes.push([mid + f / 2, tr + f / 2, w / 2 - f * 1.5, yb - tr - f * 1.5]);
  for (const [px, py, pw, ph] of panes) {
    const gr = a.createLinearGradient(px, py, px + pw, py + ph);
    gr.addColorStop(0, '#3a4450');
    gr.addColorStop(0.5, '#2a323b');
    gr.addColorStop(1, '#1f252c');
    a.fillStyle = gr;
    a.fillRect(px, py, pw, ph);
    // net curtain on the lower half now and then reads as "lived in"
    h.fillStyle = grey(20);
    h.fillRect(px, py, pw, ph);
    ro.fillStyle = grey(18);
    ro.fillRect(px, py, pw, ph);
  }
  // sill (protrudes) and lintel
  a.fillStyle = grey(style === 'brick' ? 205 : 222);
  a.fillRect(x0 - 8, yb, w + 16, 7);
  h.fillStyle = grey(235);
  h.fillRect(x0 - 8, yb, w + 16, 7);
  ro.fillStyle = grey(200);
  ro.fillRect(x0 - 8, yb, w + 16, 7);
  if (style === 'brick') {
    // soldier-course lintel
    for (let x = x0 - 8; x < x0 + w + 8; x += 6) {
      a.fillStyle = grey(150 + ((x * 7) % 30));
      a.fillRect(x, y0 - 12, 5, 10);
      h.fillStyle = grey(170);
      h.fillRect(x, y0 - 12, 5, 10);
    }
  } else {
    a.fillStyle = grey(232);
    a.fillRect(x0 - 6, y0 - 9, w + 12, 7);
    h.fillStyle = grey(200);
    h.fillRect(x0 - 6, y0 - 9, w + 12, 7);
  }
}

let cache: { plaster: PbrSet; brick: PbrSet; roof: PbrSet } | null = null;

export function facadeTextures(): { plaster: PbrSet; brick: PbrSet; roof: PbrSet } {
  if (cache) return cache;
  cache = { plaster: plasterSet(), brick: brickSet(), roof: roofSet() };
  return cache;
}

function plasterSet(): PbrSet {
  const r = rng(5);
  const [ca, a] = canvas();
  const [ch, h] = canvas();
  const [cr, ro] = canvas();
  a.fillStyle = grey(238);
  a.fillRect(0, 0, S, S);
  h.fillStyle = grey(128);
  h.fillRect(0, 0, S, S);
  ro.fillStyle = grey(235);
  ro.fillRect(0, 0, S, S);
  speckle(a, r, 232, 26, 2600, 3);
  speckle(h, r, 128, 40, 3000, 2);
  // weathering streaks below the sill
  for (let i = 0; i < 14; i++) {
    const x = S * 0.3 + r() * S * 0.4;
    const gr = a.createLinearGradient(0, S - 0.9 * PX_Y, 0, S);
    gr.addColorStop(0, 'rgba(120,115,100,0.18)');
    gr.addColorStop(1, 'rgba(120,115,100,0)');
    a.fillStyle = gr;
    a.fillRect(x, S - 0.9 * PX_Y, 1 + r() * 2, 0.9 * PX_Y);
  }
  // storey band
  a.fillStyle = grey(222);
  a.fillRect(0, S - 6, S, 6);
  h.fillStyle = grey(175);
  h.fillRect(0, S - 6, S, 6);
  drawWindow(a, h, ro, 'plaster');
  return finish(ca, ch, cr, 3.5);
}

function brickSet(): PbrSet {
  const r = rng(9);
  const [ca, a] = canvas();
  const [ch, h] = canvas();
  const [cr, ro] = canvas();
  // mortar
  a.fillStyle = grey(200);
  a.fillRect(0, 0, S, S);
  h.fillStyle = grey(70);
  h.fillRect(0, 0, S, S);
  ro.fillStyle = grey(245);
  ro.fillRect(0, 0, S, S);
  const course = 0.075 * PX_Y; // brick + joint height in px
  const brick = 0.23 * PX_X;
  let row = 0;
  for (let y = 0; y < S; y += course, row++) {
    const off = row % 2 ? brick / 2 : 0;
    for (let x = -off; x < S; x += brick) {
      const v = 150 + (r() - 0.5) * 60;
      a.fillStyle = grey(v);
      a.fillRect(x + 0.8, y + 0.8, brick - 1.6, course - 1.6);
      h.fillStyle = grey(150 + r() * 30);
      h.fillRect(x + 0.8, y + 0.8, brick - 1.6, course - 1.6);
      ro.fillStyle = grey(215 + r() * 30);
      ro.fillRect(x + 0.8, y + 0.8, brick - 1.6, course - 1.6);
    }
  }
  speckle(a, r, 140, 50, 1500, 1.5);
  drawWindow(a, h, ro, 'brick');
  return finish(ca, ch, cr, 2.5);
}

function roofSet(): PbrSet {
  const r = rng(13);
  const [ca, a] = canvas();
  const [ch, h] = canvas();
  const [cr, ro] = canvas();
  const rowH = S / 15; // 15 courses per 5 m
  const tileW = S / 12; // 12 tiles per 3 m
  for (let row = 0; row * rowH < S; row++) {
    const y = row * rowH;
    const off = row % 2 ? tileW / 2 : 0;
    for (let x = -off; x < S; x += tileW) {
      const v = 200 + (r() - 0.5) * 55;
      // each pantile: lighter at its lower (exposed) edge, shadowed under the course above
      const gr = a.createLinearGradient(0, y, 0, y + rowH);
      gr.addColorStop(0, grey(v * 0.62));
      gr.addColorStop(0.25, grey(v));
      gr.addColorStop(1, grey(v * 0.92));
      a.fillStyle = gr;
      a.fillRect(x + 0.6, y, tileW - 1.2, rowH);
      const hg = h.createLinearGradient(0, y, 0, y + rowH);
      hg.addColorStop(0, grey(40));
      hg.addColorStop(1, grey(215));
      h.fillStyle = hg;
      h.fillRect(x + 0.6, y, tileW - 1.2, rowH);
      // rounded profile across the tile
      const pg = h.createLinearGradient(x, 0, x + tileW, 0);
      pg.addColorStop(0, 'rgba(0,0,0,0.35)');
      pg.addColorStop(0.5, 'rgba(255,255,255,0.15)');
      pg.addColorStop(1, 'rgba(0,0,0,0.35)');
      h.fillStyle = pg;
      h.fillRect(x + 0.6, y, tileW - 1.2, rowH);
      ro.fillStyle = grey(190 + r() * 50);
      ro.fillRect(x, y, tileW, rowH);
    }
  }
  // moss and lichen blotches
  for (let i = 0; i < 40; i++) {
    a.fillStyle = `rgba(${90 + r() * 30},${100 + r() * 30},${60},${0.12 + r() * 0.15})`;
    a.beginPath();
    a.arc(r() * S, r() * S, 2 + r() * 7, 0, Math.PI * 2);
    a.fill();
  }
  return finish(ca, ch, cr, 3);
}
