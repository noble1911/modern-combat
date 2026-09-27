import * as THREE from 'three';
import { FACTIONS, Side, Symbol } from '../data/units';
import type { Rect } from '../sim/mapgen';
import type { OrderKind, Unit } from '../sim/types';
import type { World } from '../sim/world';
import { SOLDIER_SCALE, UnitView } from './unitView';

export const ORDER_COLORS: Record<OrderKind, number> = {
  none: 0xffffff,
  move: 0x7dff7d,
  moveFast: 0xffe14d,
  sneak: 0x6fd3ff,
  reverse: 0xffb066,
  fire: 0xff5a4a,
  smoke: 0xdddddd,
  defend: 0x6f9bff,
  ambush: 0xc77dff,
  mount: 0x7dffd2,
  dismount: 0x7dffd2,
  callFire: 0xff8c3a,
  uav: 0x9fe8ff,
  strike: 0xff3a9a,
};

const STATE_COLOR: Record<string, string> = {
  Pinned: '#ffd23a',
  Cowering: '#ff9a2e',
  Panicked: '#ff5b2e',
  Routing: '#ff2e2e',
  Routed: '#ff2e2e',
  Surrendered: '#bbbbbb',
  'Under fire': '#ffe680',
  Shaken: '#ffc070',
  Berserk: '#ff40ff',
};

/** Draw an APP-6 inspired unit symbol. */
export function drawSymbol(g: CanvasRenderingContext2D, side: Side, sym: Symbol, x: number, y: number, w: number, h: number, friendly: boolean): void {
  const fill = side === 'nato' ? '#80c0ff' : '#ff8080';
  const stroke = '#101418';
  g.lineWidth = Math.max(2, w / 18);
  g.strokeStyle = stroke;
  g.fillStyle = fill;
  const cx = x + w / 2;
  const cy = y + h / 2;
  g.beginPath();
  if (friendly) g.rect(x, y, w, h);
  else {
    g.moveTo(cx, y - h * 0.15);
    g.lineTo(x + w + w * 0.05, cy);
    g.lineTo(cx, y + h + h * 0.15);
    g.lineTo(x - w * 0.05, cy);
    g.closePath();
  }
  g.fill();
  g.stroke();
  // inner glyph
  const ix = friendly ? x : x + w * 0.2;
  const iy = friendly ? y : y + h * 0.2;
  const iw = friendly ? w : w * 0.6;
  const ih = friendly ? h : h * 0.6;
  g.beginPath();
  g.lineWidth = Math.max(2, w / 22);
  const X = () => {
    g.moveTo(ix, iy);
    g.lineTo(ix + iw, iy + ih);
    g.moveTo(ix + iw, iy);
    g.lineTo(ix, iy + ih);
  };
  const ellipse = (rx: number, ry: number) => g.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
  switch (sym) {
    case 'inf':
      X();
      break;
    case 'mg':
      X();
      g.moveTo(cx, iy + ih * 0.1);
      g.lineTo(cx, iy + ih * 0.9);
      break;
    case 'at':
      g.moveTo(ix, iy + ih);
      g.lineTo(cx, iy);
      g.lineTo(ix + iw, iy + ih);
      break;
    case 'sniper':
      g.arc(cx, cy, ih * 0.28, 0, Math.PI * 2);
      g.moveTo(cx - iw * 0.35, cy);
      g.lineTo(cx + iw * 0.35, cy);
      g.moveTo(cx, cy - ih * 0.4);
      g.lineTo(cx, cy + ih * 0.4);
      break;
    case 'mortar':
      g.arc(cx, cy + ih * 0.2, ih * 0.14, 0, Math.PI * 2);
      g.moveTo(cx, cy + ih * 0.06);
      g.lineTo(cx, iy + ih * 0.12);
      g.moveTo(cx - iw * 0.08, iy + ih * 0.22);
      g.lineTo(cx, iy + ih * 0.12);
      g.lineTo(cx + iw * 0.08, iy + ih * 0.22);
      break;
    case 'agl':
      X();
      g.moveTo(ix + iw * 0.3, iy + ih * 0.15);
      g.arc(cx, iy + ih * 0.15, iw * 0.08, 0, Math.PI * 2);
      break;
    case 'hq':
      g.moveTo(ix + iw * 0.2, iy + ih * 0.9);
      g.lineTo(ix + iw * 0.2, iy + ih * 0.1);
      g.lineTo(ix + iw * 0.8, iy + ih * 0.1);
      g.lineTo(ix + iw * 0.8, iy + ih * 0.45);
      g.lineTo(ix + iw * 0.2, iy + ih * 0.45);
      break;
    case 'recon':
      g.moveTo(ix, iy + ih);
      g.lineTo(ix + iw, iy);
      g.moveTo(cx - iw * 0.2, cy - ih * 0.25);
      g.lineTo(cx + iw * 0.2, cy - ih * 0.25);
      break;
    case 'armor':
      ellipse(iw * 0.34, ih * 0.24);
      break;
    case 'ifv':
      X();
      g.moveTo(cx + iw * 0.3, cy);
      ellipse(iw * 0.3, ih * 0.2);
      break;
    case 'apc':
      ellipse(iw * 0.3, ih * 0.2);
      g.moveTo(cx - iw * 0.12, cy + ih * 0.34);
      g.arc(cx - iw * 0.16, cy + ih * 0.34, ih * 0.05, 0, Math.PI * 2);
      g.moveTo(cx + iw * 0.2, cy + ih * 0.34);
      g.arc(cx + iw * 0.16, cy + ih * 0.34, ih * 0.05, 0, Math.PI * 2);
      break;
    case 'car':
      g.moveTo(ix, iy + ih);
      g.lineTo(ix + iw, iy);
      g.moveTo(cx - iw * 0.12, cy + ih * 0.34);
      g.arc(cx - iw * 0.16, cy + ih * 0.34, ih * 0.05, 0, Math.PI * 2);
      g.moveTo(cx + iw * 0.2, cy + ih * 0.34);
      g.arc(cx + iw * 0.16, cy + ih * 0.34, ih * 0.05, 0, Math.PI * 2);
      break;
  }
  g.stroke();
}

interface Icon {
  sprite: THREE.Sprite;
  canvas: HTMLCanvasElement;
  tex: THREE.CanvasTexture;
  key: string;
}

export class Overlays {
  readonly group = new THREE.Group();
  private icons = new Map<number, Icon>();
  private ghostIcons = new Map<number, Icon>();
  private rings: THREE.InstancedMesh;
  private orderLines: THREE.LineSegments;
  private losLine: THREE.Line;
  private flags: { id: string; pole: THREE.Mesh; flag: THREE.Mesh; ring: THREE.Mesh; label: THREE.Sprite }[] = [];
  private zone: THREE.Mesh | null = null;
  private hoverRing: THREE.Mesh;
  selected = new Set<number>();
  hovered = -1;
  iconScale = 0.042;

  constructor(private world: World, private player: Side | null, private unitView: UnitView) {
    const ringGeo = new THREE.RingGeometry(0.75, 1.0, 20).rotateX(-Math.PI / 2);
    this.rings = new THREE.InstancedMesh(ringGeo, new THREE.MeshBasicMaterial({ color: 0x9dff6a, transparent: true, opacity: 0.85, depthWrite: false }), 400);
    this.rings.count = 0;
    this.rings.frustumCulled = false;
    this.rings.renderOrder = 5;
    this.group.add(this.rings);
    const lg = new THREE.BufferGeometry();
    lg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(4000 * 3), 3).setUsage(THREE.DynamicDrawUsage));
    lg.setAttribute('color', new THREE.BufferAttribute(new Float32Array(4000 * 3), 3).setUsage(THREE.DynamicDrawUsage));
    this.orderLines = new THREE.LineSegments(lg, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.9, depthTest: false }));
    this.orderLines.frustumCulled = false;
    this.orderLines.renderOrder = 6;
    this.group.add(this.orderLines);
    const losG = new THREE.BufferGeometry();
    losG.setAttribute('position', new THREE.BufferAttribute(new Float32Array(3 * 3), 3));
    losG.setAttribute('color', new THREE.BufferAttribute(new Float32Array(3 * 3), 3));
    this.losLine = new THREE.Line(losG, new THREE.LineBasicMaterial({ vertexColors: true, depthTest: false, transparent: true }));
    this.losLine.visible = false;
    this.losLine.frustumCulled = false;
    this.losLine.renderOrder = 7;
    this.group.add(this.losLine);
    this.hoverRing = new THREE.Mesh(new THREE.RingGeometry(0.85, 1, 32).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.5, depthWrite: false }));
    this.hoverRing.visible = false;
    this.group.add(this.hoverRing);
    this.buildFlags();
  }

  private buildFlags(): void {
    for (const vl of this.world.vls) {
      const g = this.world.map.groundAt(vl.x, vl.y);
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.15, 12, 6), new THREE.MeshStandardMaterial({ color: 0xcccccc }));
      pole.position.set(vl.x, g + 6, -vl.y);
      pole.castShadow = true;
      const flag = new THREE.Mesh(new THREE.PlaneGeometry(5, 3.2, 6, 1).translate(2.5, 0, 0), new THREE.MeshStandardMaterial({ color: 0xffffff, side: THREE.DoubleSide, emissive: 0x222222 }));
      flag.position.set(vl.x, g + 10.3, -vl.y);
      flag.castShadow = true;
      const ring = new THREE.Mesh(new THREE.RingGeometry(vl.r - 0.8, vl.r, 64).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.35, depthWrite: false }));
      ring.position.set(vl.x, g + 0.6, -vl.y);
      ring.renderOrder = 1;
      const label = this.textSprite(vl.name);
      label.position.set(vl.x, g + 16, -vl.y);
      this.group.add(pole, flag, ring, label);
      this.flags.push({ id: vl.id, pole, flag, ring, label });
    }
  }

  private textSprite(text: string): THREE.Sprite {
    const c = document.createElement('canvas');
    c.width = 256;
    c.height = 48;
    const g = c.getContext('2d')!;
    g.font = 'bold 22px system-ui, sans-serif';
    const w = Math.min(250, g.measureText(text).width + 16);
    g.fillStyle = 'rgba(10,14,18,0.6)';
    g.fillRect((256 - w) / 2, 8, w, 32);
    g.fillStyle = '#f2f2e8';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(text, 128, 25);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, sizeAttenuation: false, transparent: true }));
    s.scale.set(0.16, 0.03, 1);
    s.renderOrder = 8;
    return s;
  }

  showDeployZone(rect: Rect | null, color = 0x4aa3ff): void {
    if (this.zone) {
      this.group.remove(this.zone);
      this.zone.geometry.dispose();
      this.zone = null;
    }
    if (!rect) return;
    // terrain-following translucent plane
    const nx = Math.max(2, Math.round(rect.w / 8));
    const ny = Math.max(2, Math.round(rect.h / 8));
    const g = new THREE.PlaneGeometry(rect.w, rect.h, nx, ny);
    const pos = g.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) {
      const x = rect.x + rect.w / 2 + pos.getX(i);
      const y = rect.y + rect.h / 2 + pos.getY(i);
      pos.setXYZ(i, x, this.world.map.groundAt(x, y) + 0.4, -y);
    }
    g.computeVertexNormals();
    // multiplicative tint (dst × mix(1, colour, a)): reads the same on sunlit fields and dark
    // forest floor, where an additive overlay would glow
    const zm = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.35, depthWrite: false, side: THREE.DoubleSide, premultipliedAlpha: true });
    zm.blending = THREE.CustomBlending;
    zm.blendEquation = THREE.AddEquation;
    zm.blendSrc = THREE.DstColorFactor;
    zm.blendDst = THREE.OneMinusSrcAlphaFactor;
    zm.fog = false;
    this.zone = new THREE.Mesh(g, zm);
    this.zone.renderOrder = 1;
    this.group.add(this.zone);
  }

  private iconFor(u: Unit, ghost: boolean): Icon {
    const map = ghost ? this.ghostIcons : this.icons;
    let ic = map.get(u.id);
    if (!ic) {
      const canvas = document.createElement('canvas');
      canvas.width = 96;
      canvas.height = 96;
      const tex = new THREE.CanvasTexture(canvas);
      tex.colorSpace = THREE.SRGBColorSpace;
      const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, sizeAttenuation: false, transparent: true }));
      sprite.renderOrder = 9;
      sprite.center.set(0.5, 0);
      this.group.add(sprite);
      ic = { sprite, canvas, tex, key: '' };
      map.set(u.id, ic);
    }
    return ic;
  }

  private drawIcon(ic: Icon, u: Unit, ghost: boolean): void {
    const selected = this.selected.has(u.id);
    const hovered = this.hovered === u.id;
    const strength = u.initialSoldiers ? u.alive / u.initialSoldiers : 1;
    const pax = u.vehicle >= 0 ? this.world.vehicles[u.vehicle].passengers.reduce((n, id) => n + this.world.units[id].alive, 0) : 0;
    const key = `${u.side}|${u.template.symbol}|${selected}|${hovered}|${ghost}|${Math.round(strength * 10)}|${u.stateLabel}|${u.mountedIn}|${pax}`;
    if (ic.key === key) return;
    ic.key = key;
    const g = ic.canvas.getContext('2d')!;
    g.clearRect(0, 0, 96, 96);
    const friendly = !this.player || u.side === this.player;
    g.globalAlpha = ghost ? 0.45 : 1;
    if (selected || hovered) {
      g.fillStyle = selected ? 'rgba(255,255,140,0.9)' : 'rgba(255,255,255,0.6)';
      g.fillRect(12, 14, 72, 52);
    }
    drawSymbol(g, u.side, u.template.symbol, 18, 20, 60, 40, friendly);
    if (ghost) {
      g.fillStyle = '#fff';
      g.font = 'bold 28px system-ui';
      g.textAlign = 'center';
      g.fillText('?', 48, 52);
    } else {
      // strength bar
      g.fillStyle = 'rgba(0,0,0,0.6)';
      g.fillRect(18, 70, 60, 7);
      g.fillStyle = strength > 0.66 ? '#5bd65b' : strength > 0.33 ? '#e6c43a' : '#e0503a';
      g.fillRect(19, 71, 58 * strength, 5);
      const sc = STATE_COLOR[u.stateLabel];
      if (sc) {
        g.fillStyle = sc;
        g.beginPath();
        g.arc(84, 22, 8, 0, Math.PI * 2);
        g.fill();
        g.strokeStyle = '#000';
        g.lineWidth = 2;
        g.stroke();
      }
      if (pax > 0 && friendly) {
        // carried infantry badge
        g.fillStyle = 'rgba(10,14,18,0.85)';
        g.fillRect(58, 2, 36, 18);
        g.fillStyle = '#fff';
        g.font = 'bold 14px system-ui';
        g.textAlign = 'center';
        g.fillText(`+${pax}`, 76, 16);
      }
    }
    ic.tex.needsUpdate = true;
  }

  /** Where to draw a unit's icon (world coords, three space). */
  iconAnchor(u: Unit, alpha: number): THREE.Vector3 | null {
    const w = this.world;
    if (u.mountedIn >= 0) return null;
    if (u.vehicle >= 0) {
      const v = w.vehicles[u.vehicle];
      const x = v.px + (v.x - v.px) * alpha;
      const y = v.py + (v.y - v.py) * alpha;
      return new THREE.Vector3(x, w.map.groundAt(x, y) + v.def.height + 5, -y);
    }
    const lead = w.leaderOf(u);
    if (!lead) return null;
    const p = w.unitPos(u);
    return new THREE.Vector3(p.x, w.map.groundAt(p.x, p.y) + 7, -p.y);
  }

  update(alpha: number, time: number, cameraDist: number): void {
    const w = this.world;
    const scale = this.iconScale * (cameraDist < 120 ? 0.8 : 1);
    // unit icons
    for (const u of w.units) {
      const ic = this.iconFor(u, false);
      const visible = !u.eliminated && !u.withdrawn && this.unitView.visibleUnit(u.id);
      const anchor = visible ? this.iconAnchor(u, alpha) : null;
      ic.sprite.visible = !!anchor;
      if (!anchor) continue;
      this.drawIcon(ic, u, false);
      ic.sprite.position.copy(anchor);
      ic.sprite.scale.set(scale, scale, 1);
    }
    // last-known positions of enemies
    if (this.player) {
      for (const info of w.spotted[this.player].values()) {
        const u = w.units[info.unitId];
        const ic = this.iconFor(u, true);
        const show = !info.visible && !u.eliminated && !u.withdrawn && w.time - info.lastSeen < 90;
        ic.sprite.visible = show;
        if (!show) continue;
        this.drawIcon(ic, u, true);
        ic.sprite.position.set(info.x, w.map.groundAt(info.x, info.y) + 6, -info.y);
        ic.sprite.scale.set(scale * 0.85, scale * 0.85, 1);
      }
    }
    // selection rings
    let n = 0;
    const m = new THREE.Matrix4();
    for (const id of this.selected) {
      const u = w.units[id];
      if (u.vehicle >= 0) {
        const v = w.vehicles[u.vehicle];
        const x = v.px + (v.x - v.px) * alpha;
        const y = v.py + (v.y - v.py) * alpha;
        const r = v.def.length * 0.62;
        m.makeScale(r, 1, r).setPosition(x, w.map.groundAt(x, y) + 0.3, -y);
        if (n < 400) this.rings.setMatrixAt(n++, m);
        continue;
      }
      for (const sid of u.soldiers) {
        const s = w.soldiers[sid];
        if (s.vehicle >= 0 || s.health === 'dead' || s.fled) continue;
        const x = s.px + (s.x - s.px) * alpha;
        const y = s.py + (s.y - s.py) * alpha;
        const r = SOLDIER_SCALE * (s.health === 'incap' ? 0.5 : 0.8);
        m.makeScale(r, 1, r).setPosition(x, w.map.groundAt(x, y) + 0.15, -y);
        if (n < 400) this.rings.setMatrixAt(n++, m);
      }
    }
    this.rings.count = n;
    this.rings.instanceMatrix.needsUpdate = true;
    // order lines for selected (and faintly for all own units)
    const pos = this.orderLines.geometry.attributes.position as THREE.BufferAttribute;
    const col = this.orderLines.geometry.attributes.color as THREE.BufferAttribute;
    let k = 0;
    const c = new THREE.Color();
    const push = (ax: number, ay: number, bx: number, by: number, color: number, dim: number) => {
      if (k >= 3990) return;
      c.setHex(color).multiplyScalar(dim);
      pos.setXYZ(k, ax, w.map.groundAt(ax, ay) + 1.2, -ay);
      col.setXYZ(k++, c.r, c.g, c.b);
      pos.setXYZ(k, bx, w.map.groundAt(bx, by) + 1.2, -by);
      col.setXYZ(k++, c.r, c.g, c.b);
    };
    for (const u of w.units) {
      if (u.eliminated || u.withdrawn || (this.player && u.side !== this.player)) continue;
      const sel = this.selected.has(u.id);
      const o = u.order;
      if (o.kind === 'none') continue;
      const dim = sel ? 1 : 0.35;
      if (!sel && o.kind !== 'fire') continue;
      const color = ORDER_COLORS[o.kind];
      const start = w.unitPos(u);
      // follow the actual route for moves
      if (u.vehicle >= 0 && w.vehicles[u.vehicle].path) {
        const v = w.vehicles[u.vehicle];
        let p = { x: v.x, y: v.y };
        for (let i = v.pathIdx; i < v.path!.length; i++) {
          push(p.x, p.y, v.path![i].x, v.path![i].y, color, dim);
          p = v.path![i];
        }
      } else if (u.vehicle < 0 && (o.kind === 'move' || o.kind === 'moveFast' || o.kind === 'sneak' || o.kind === 'mount')) {
        const lead = w.leaderOf(u);
        if (lead?.path) {
          let p = { x: lead.x, y: lead.y };
          for (let i = lead.pathIdx; i < lead.path.length; i++) {
            push(p.x, p.y, lead.path[i].x, lead.path[i].y, color, dim);
            p = lead.path[i];
          }
        }
      } else if (o.targetUnit !== undefined) {
        const t = w.unitPos(w.units[o.targetUnit]);
        push(start.x, start.y, t.x, t.y, color, dim);
      } else if (o.target) {
        push(start.x, start.y, o.target.x, o.target.y, color, dim);
      } else if ((o.kind === 'defend' || o.kind === 'ambush') && sel) {
        const f = u.facing;
        push(start.x, start.y, start.x + Math.cos(f) * 40, start.y + Math.sin(f) * 40, color, dim);
      }
    }
    this.orderLines.geometry.setDrawRange(0, k);
    pos.needsUpdate = true;
    col.needsUpdate = true;
    // flags
    for (const f of this.flags) {
      const vl = w.vls.find((v) => v.id === f.id)!;
      const color = vl.owner ? FACTIONS[vl.owner].color : 0xf0f0f0;
      (f.flag.material as THREE.MeshStandardMaterial).color.setHex(color);
      const rm = f.ring.material as THREE.MeshBasicMaterial;
      rm.color.setHex(vl.contested ? 0xffd23a : color);
      rm.opacity = vl.contested ? 0.35 + Math.sin(time * 6) * 0.2 : 0.3;
      f.flag.rotation.y = Math.sin(time * 1.3 + f.pole.position.x) * 0.25;
      f.label.scale.set(0.16, 0.03, 1);
    }
  }

  setHover(unitId: number, pos: THREE.Vector3 | null, radius: number): void {
    this.hovered = unitId;
    this.hoverRing.visible = !!pos;
    if (pos) {
      this.hoverRing.position.copy(pos);
      this.hoverRing.scale.setScalar(radius);
    }
  }

  /** LOS ray: green while clear, red after the block point. */
  setLos(a: THREE.Vector3 | null, b: THREE.Vector3 | null, blockedFrac: number, obstructed: boolean): void {
    if (!a || !b) {
      this.losLine.visible = false;
      return;
    }
    this.losLine.visible = true;
    const pos = this.losLine.geometry.attributes.position as THREE.BufferAttribute;
    const col = this.losLine.geometry.attributes.color as THREE.BufferAttribute;
    const mid = a.clone().lerp(b, Math.min(1, blockedFrac));
    pos.setXYZ(0, a.x, a.y, a.z);
    pos.setXYZ(1, mid.x, mid.y, mid.z);
    pos.setXYZ(2, b.x, b.y, b.z);
    const ok = obstructed ? new THREE.Color(0xffd23a) : new THREE.Color(0x7dff7d);
    const bad = new THREE.Color(0xff3a3a);
    col.setXYZ(0, ok.r, ok.g, ok.b);
    col.setXYZ(1, blockedFrac < 1 ? bad.r : ok.r, blockedFrac < 1 ? bad.g : ok.g, blockedFrac < 1 ? bad.b : ok.b);
    col.setXYZ(2, blockedFrac < 1 ? bad.r : ok.r, blockedFrac < 1 ? bad.g : ok.g, blockedFrac < 1 ? bad.b : ok.b);
    pos.needsUpdate = true;
    col.needsUpdate = true;
  }

  /** Screen-space picking of unit icons (NDC coordinates). */
  pickIcon(ndcX: number, ndcY: number, camera: THREE.PerspectiveCamera): number {
    let best = -1;
    let bd = Infinity;
    const v = new THREE.Vector3();
    const k = camera.projectionMatrix.elements[5];
    for (const [id, ic] of this.icons) {
      if (!ic.sprite.visible) continue;
      v.copy(ic.sprite.position).project(camera);
      if (v.z > 1) continue;
      const h = ic.sprite.scale.y * k; // NDC height of the icon
      const cy = v.y + h / 2; // anchored at bottom centre
      const dx = ((ndcX - v.x) * camera.aspect) / h;
      const dy = (ndcY - cy) / h;
      if (Math.abs(dx) < 0.45 && Math.abs(dy) < 0.4) {
        const d = dx * dx + dy * dy;
        if (d < bd) {
          bd = d;
          best = id;
        }
      }
    }
    return best;
  }
}
