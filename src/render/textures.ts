import * as THREE from 'three';

/** Tileable wall texture: plaster with one window per 4 m bay and 3.2 m floor. */
export function windowTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 64;
  c.height = 64;
  const g = c.getContext('2d')!;
  g.fillStyle = '#ffffff';
  g.fillRect(0, 0, 64, 64);
  // subtle plaster noise
  for (let i = 0; i < 300; i++) {
    const v = 230 + Math.random() * 25;
    g.fillStyle = `rgb(${v},${v},${v})`;
    g.fillRect(Math.random() * 64, Math.random() * 64, 2, 2);
  }
  // window
  g.fillStyle = '#2b3138';
  g.fillRect(20, 18, 24, 28);
  g.fillStyle = '#56626e';
  g.fillRect(22, 20, 9, 11);
  g.fillStyle = '#6a7784';
  g.fillRect(33, 20, 9, 11);
  // sill / lintel
  g.fillStyle = '#c8c8c0';
  g.fillRect(18, 46, 28, 3);
  g.fillRect(18, 15, 28, 3);
  // floor line
  g.fillStyle = '#d8d8d0';
  g.fillRect(0, 62, 64, 2);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

export function roofTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 64;
  c.height = 64;
  const g = c.getContext('2d')!;
  g.fillStyle = '#ffffff';
  g.fillRect(0, 0, 64, 64);
  for (let y = 0; y < 64; y += 8) {
    g.fillStyle = '#c4c4c4';
    g.fillRect(0, y, 64, 1);
    for (let x = (y / 8) % 2 ? 0 : 6; x < 64; x += 12) {
      g.fillStyle = '#d8d8d8';
      g.fillRect(x, y + 1, 1, 7);
    }
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** Soft round sprite for particles. */
export function softDot(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 64;
  c.height = 64;
  const g = c.getContext('2d')!;
  const grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grd.addColorStop(0, 'rgba(255,255,255,1)');
  grd.addColorStop(0.4, 'rgba(255,255,255,0.75)');
  grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}

/** Puffy smoke sprite (noisy blob). */
export function smokePuff(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 128;
  c.height = 128;
  const g = c.getContext('2d')!;
  for (let i = 0; i < 26; i++) {
    const a = Math.random() * Math.PI * 2;
    const r = Math.random() * 30;
    const x = 64 + Math.cos(a) * r;
    const y = 64 + Math.sin(a) * r;
    const rad = 20 + Math.random() * 22;
    const grd = g.createRadialGradient(x, y, 0, x, y, rad);
    grd.addColorStop(0, 'rgba(255,255,255,0.35)');
    grd.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grd;
    g.fillRect(0, 0, 128, 128);
  }
  return new THREE.CanvasTexture(c);
}

export function noiseCanvas(size: number, seed = 1): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d')!;
  const img = g.createImageData(size, size);
  let s = seed;
  const rnd = () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
  for (let i = 0; i < size * size; i++) {
    const v = 110 + rnd() * 40;
    img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = v;
    img.data[i * 4 + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  return c;
}
