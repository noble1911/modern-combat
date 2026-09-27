import * as THREE from 'three';
import { FACTIONS, otherSide, Side } from '../data/units';
import { baseHitChance } from '../data/weapons';
import { SoundEngine } from '../audio/sound';
import { lightingForSeed } from '../render/atmosphere';
import { BattleView, GraphicsSettings } from '../render/battleView';
import { ModelLib } from '../render/models';
import { portraitBg } from '../render/portraits';
import { weaponCell } from '../ui/unitInfo';
import { weaponIcon } from '../ui/weaponIcons';
import { drawSymbol, ORDER_COLORS } from '../render/overlays';
import { placeUnit } from '../sim/ai';
import { shooterMod } from '../sim/combat';
import { angleTo, clamp, Vec2 } from '../sim/math';
import { availableOrders, freeSeats, issueOrder } from '../sim/orders';
import { nearestPassable } from '../sim/pathfinding';
import { EYE } from '../sim/spotting';
import type { BattleResult, Order, OrderKind, Unit } from '../sim/types';
import { DT, World } from '../sim/world';
import { BattleSetup, createBattle } from './scenario';

export interface BattleOptions {
  setup: BattleSetup;
  title: string;
  models: ModelLib;
  gfx: GraphicsSettings;
  sound: SoundEngine;
  onExit: (world: World, result: BattleResult | null, quit: boolean) => void;
}

const ORDER_LABEL: Record<OrderKind, string> = {
  none: 'Stop',
  move: 'Move',
  moveFast: 'Move Fast',
  sneak: 'Sneak',
  reverse: 'Reverse',
  fire: 'Fire',
  smoke: 'Smoke',
  defend: 'Defend',
  ambush: 'Ambush',
  mount: 'Mount',
  dismount: 'Dismount',
  callFire: 'Call Artillery',
  uav: 'Launch Recon Drone',
  strike: 'Drone Strike',
};
const ORDER_KEY: Partial<Record<OrderKind, string>> = {
  move: 'M',
  moveFast: 'R',
  sneak: 'C',
  reverse: 'V',
  fire: 'F',
  smoke: 'K',
  defend: 'H',
  ambush: 'B',
  mount: 'Y',
  dismount: 'Y',
  callFire: 'T',
  uav: 'U',
  strike: 'J',
  none: 'X',
};
const KEY_ORDER: Record<string, OrderKind> = {
  KeyM: 'move',
  KeyR: 'moveFast',
  KeyC: 'sneak',
  KeyV: 'reverse',
  KeyF: 'fire',
  KeyK: 'smoke',
  KeyH: 'defend',
  KeyB: 'ambush',
  KeyT: 'callFire',
  KeyU: 'uav',
  KeyJ: 'strike',
};
/** Orders that execute immediately without picking a target. */
const INSTANT: OrderKind[] = ['dismount', 'none'];

const symCache = new Map<string, string>();
export function symbolURL(side: Side, sym: Unit['template']['symbol'], friendly = true): string {
  const key = `${side}|${sym}|${friendly}`;
  let url = symCache.get(key);
  if (!url) {
    const c = document.createElement('canvas');
    c.width = 60;
    c.height = 48;
    drawSymbol(c.getContext('2d')!, side, sym, 6, 6, 48, 34, friendly);
    url = c.toDataURL();
    symCache.set(key, url);
  }
  return url;
}

/** `?timer=1` drives the loop with setTimeout (useful when rAF is throttled, e.g. automated testing). */
const TIMER_MODE = typeof location !== 'undefined' && new URLSearchParams(location.search).has('timer');
let pending: ((t: number) => void) | null = null;
let lastTick = 0;
const channel = TIMER_MODE ? new MessageChannel() : null;
if (channel) {
  // MessageChannel callbacks are not clamped like timers in hidden tabs.
  channel.port1.onmessage = () => {
    const now = performance.now();
    if (!pending) return;
    if (now - lastTick < 16) {
      channel.port2.postMessage(0);
      return;
    }
    lastTick = now;
    const f = pending;
    pending = null;
    f(now);
  };
}
const nextFrame = (f: (t: number) => void): number => {
  if (!channel) return requestAnimationFrame(f);
  pending = f;
  channel.port2.postMessage(0);
  return 1;
};
const cancelFrame = (h: number) => (channel ? (pending = null) : cancelAnimationFrame(h));

const fmtTime = (t: number) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, html?: string): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html !== undefined) e.innerHTML = html;
  return e;
};

export class BattleScreen {
  readonly root: HTMLDivElement;
  readonly world: World;
  readonly view: BattleView;
  readonly player: Side;
  private speed = 1;
  private paused = false;
  private acc = 0;
  private last = performance.now();
  private raf = 0;
  private selected = new Set<number>();
  private mode: OrderKind | null = null;
  private losTool = false;
  private mouse = { x: 0, y: 0, ndcX: 0, ndcY: 0, inside: false };
  private leftDown: { x: number; y: number } | null = null;
  private boxEl: HTMLDivElement;
  private tip: HTMLDivElement;
  private ctxMenu: HTMLDivElement | null = null;
  private hud: {
    top: HTMLDivElement;
    clock: HTMLDivElement;
    fm: Record<Side, HTMLDivElement>;
    vls: HTMLDivElement;
    speedBtns: HTMLButtonElement[];
    roster: HTMLDivElement;
    msgs: HTMLDivElement;
    detail: HTMLDivElement;
    mini: HTMLCanvasElement;
    deploy: HTMLDivElement | null;
    banner: HTMLDivElement;
  };
  private cards = new Map<number, HTMLDivElement>();
  private hudT = 0;
  private miniT = 0;
  private endShown = false;
  private groups = new Map<number, number[]>();
  private disposed = false;

  constructor(container: HTMLElement, private opts: BattleOptions) {
    this.player = opts.setup.player ?? 'nato';
    this.world = createBattle(opts.setup);
    this.root = el('div', 'screen battle');
    container.appendChild(this.root);
    this.view = new BattleView(this.root, this.world, opts.models, this.player, opts.gfx, opts.setup.lighting ?? lightingForSeed(opts.setup.seed));
    this.view.overlays.selected = this.selected;
    this.view.overlays.showDeployZone(this.world.deploy[this.player], FACTIONS[this.player].color);
    this.boxEl = el('div', 'selbox');
    this.boxEl.style.display = 'none';
    this.tip = el('div', 'tip');
    this.tip.style.display = 'none';
    this.root.append(this.boxEl, this.tip);
    this.hud = this.buildHud();
    this.bindInput();
    window.addEventListener('resize', this.onResize);
    this.raf = nextFrame(this.frame);
    // select first unit for convenience
    const first = this.world.units.find((u) => u.side === this.player);
    if (first) this.select([first.id]);
    this.showBriefing();
  }

  private showBriefing(): void {
    const w = this.world;
    const def = w.gen.def;
    const posture = w.sides[this.player].posture;
    const enemy = otherSide(this.player);
    const own = w.units.filter((u) => u.side === this.player);
    const foes = w.units.filter((u) => u.side === enemy);
    const vehicles = (list: Unit[]) => list.filter((u) => u.vehicle >= 0).length;
    const vls = w.vls
      .map((v) => `<li><b>${v.name}</b> (${v.value} pt${v.value > 1 ? 's' : ''}) — ${v.owner ? (v.owner === this.player ? 'held by us' : 'enemy held') : 'uncontested'}</li>`)
      .join('');
    this.modal(
      `<h2>${this.opts.title}</h2>
       <p style="color:var(--dim);line-height:1.5">${def.description}</p>
       <p><b>Mission:</b> ${posture === 'attack' ? 'ATTACK — seize the victory locations and break the defenders.' : 'DEFEND — hold the victory locations until the enemy attack is spent.'}</p>
       <ul style="line-height:1.6;margin:6px 0 10px 18px;padding:0">${vls}</ul>
       <p style="color:var(--dim)">Our force: ${own.length} units (${vehicles(own)} vehicles). Intelligence estimates ${foes.length} enemy units${vehicles(foes) ? ` including about ${vehicles(foes)} armoured vehicles` : ''}.</p>
       <p style="color:var(--dim);font-size:12px">Time limit ${Math.round(w.timeLimit / 60)} minutes. The battle also ends if either side's force morale collapses.<br>Deploy inside the shaded zone, then press <b>Begin Battle</b>. Press <b>Space</b> to pause at any time — orders can be given while paused.</p>`,
      [['To deployment ▸', () => undefined, true]],
    );
  }

  destroy(): void {
    this.disposed = true;
    cancelFrame(this.raf);
    window.removeEventListener('resize', this.onResize);
    window.removeEventListener('keydown', this.onKey);
    this.view.dispose();
    this.root.remove();
  }

  private onResize = () => this.view.resize();

  // ------------------------------------------------------------------ main loop
  private frame = (now: number) => {
    if (this.disposed) return;
    const dt = Math.min(0.1, (now - this.last) / 1000);
    this.last = now;
    const w = this.world;
    if (!this.paused && w.phase === 'battle') {
      this.acc += dt * this.speed;
      let steps = 0;
      while (this.acc >= DT && steps < 60) {
        w.step();
        this.acc -= DT;
        steps++;
        this.processEvents();
        if (w.phase !== 'battle') break;
      }
    } else if (w.phase !== 'battle') this.processEvents();
    const alpha = w.phase === 'battle' && !this.paused ? Math.min(1, this.acc / DT) : 1;
    this.opts.sound.setListener(this.view.cam.target.x, -this.view.cam.target.z, this.view.cam.dist);
    const animDt = this.paused ? 0 : dt * (w.phase === 'battle' ? this.speed : 1);
    this.view.render(dt, alpha, animDt);
    this.updateHover();
    this.hudT -= dt;
    if (this.hudT <= 0) {
      this.hudT = 0.25;
      this.updateHud();
    }
    this.miniT -= dt;
    if (this.miniT <= 0) {
      this.miniT = 0.2;
      this.drawMinimap();
    }
    if (w.phase === 'ended' && !this.endShown) {
      this.endShown = true;
      setTimeout(() => this.showEnd(), 1200);
    }
    this.raf = nextFrame(this.frame);
  };

  private processEvents(): void {
    const w = this.world;
    for (const e of w.events) {
      this.view.handleEvent(e);
      this.opts.sound.handle(e);
      if (e.type === 'message' && (e.side === this.player || e.side === 'all')) this.pushMsg(e.text, e.level, e.unit);
    }
    w.events.length = 0;
  }

  // ------------------------------------------------------------------ HUD
  private buildHud() {
    const top = el('div', 'hud-top panel');
    const title = el('div', 'title', this.opts.title);
    const clock = el('div', 'clock', '0:00');
    const fm = {} as Record<Side, HTMLDivElement>;
    const fmWrap = el('div', 'fm');
    for (const side of ['nato', 'opfor'] as Side[]) {
      const f = el('div', 'fm', `<span>${FACTIONS[side].short}</span><div class="bar"><div style="background:#${FACTIONS[side].color.toString(16).padStart(6, '0')};width:100%"></div></div>`);
      fm[side] = f.querySelector('.bar > div') as HTMLDivElement;
      fmWrap.appendChild(f);
    }
    const vls = el('div', 'vl-chips');
    const speed = el('div', 'speed');
    const speedBtns: HTMLButtonElement[] = [];
    const speeds: [string, number][] = [['❚❚', 0], ['1×', 1], ['2×', 2], ['4×', 4]];
    for (const [label, s] of speeds) {
      const b = el('button', 'btn small', label);
      b.onclick = () => this.setSpeed(s);
      speed.appendChild(b);
      speedBtns.push(b);
    }
    const menu = el('button', 'btn small', 'Menu');
    menu.onclick = () => this.showPauseMenu();
    top.append(title, clock, fmWrap, vls, speed, menu);
    for (const vl of this.world.vls) {
      const c = el('div', 'vl-chip');
      c.title = `${vl.name} (${vl.value} pts)`;
      c.onclick = () => this.view.cam.lookAt(vl.x, vl.y);
      vls.appendChild(c);
    }
    const roster = el('div', 'hud-roster panel');
    const msgs = el('div', 'hud-msgs');
    const detail = el('div', 'hud-detail panel');
    detail.style.display = 'none';
    const miniWrap = el('div', 'hud-minimap panel');
    const mini = el('canvas');
    mini.width = mini.height = 412;
    miniWrap.appendChild(mini);
    const banner = el('div', 'center-banner', '');
    this.root.append(top, roster, msgs, detail, miniWrap, banner);
    let deploy: HTMLDivElement | null = null;
    if (this.world.phase === 'deploy') {
      deploy = el('div', 'deploy-bar panel');
      deploy.innerHTML = `<div><b style="color:var(--accent)">DEPLOYMENT</b> — select a unit, then left-click inside the shaded zone to place it. Right-click sets its facing.</div>`;
      const go = el('button', 'btn primary', 'Begin Battle ▸');
      go.onclick = () => this.beginBattle();
      deploy.appendChild(go);
      this.root.appendChild(deploy);
    }
    // minimap interaction
    const miniGo = (e: MouseEvent) => {
      const r = mini.getBoundingClientRect();
      const x = ((e.clientX - r.left) / r.width) * this.world.map.width;
      const y = (1 - (e.clientY - r.top) / r.height) * this.world.map.height;
      this.view.cam.lookAt(x, y);
    };
    mini.addEventListener('mousedown', (e) => {
      miniGo(e);
      const mv = (ev: MouseEvent) => miniGo(ev);
      const up = () => {
        window.removeEventListener('mousemove', mv);
        window.removeEventListener('mouseup', up);
      };
      window.addEventListener('mousemove', mv);
      window.addEventListener('mouseup', up);
    });
    this.buildRoster(roster);
    return { top, clock, fm, vls, speedBtns, roster, msgs, detail, mini, deploy, banner };
  }

  private buildRoster(roster: HTMLDivElement): void {
    roster.innerHTML = '';
    this.cards.clear();
    for (const u of this.world.units) {
      if (u.side !== this.player) continue;
      const c = el('div', 'card');
      c.innerHTML = `<div class="pic" style="${portraitBg(u.template)}"><img class="sym" src="${symbolURL(u.side, u.template.symbol)}"></div><div class="nm"></div><div class="st"><span class="s1"></span><span class="s2"></span></div><div class="str"></div>`;
      c.title = u.template.name;
      c.onclick = (e) => {
        if (e.shiftKey) this.toggleSelect(u.id);
        else this.select([u.id]);
      };
      c.ondblclick = () => this.centerOn(u.id);
      roster.appendChild(c);
      this.cards.set(u.id, c);
    }
  }

  private updateHud(): void {
    const w = this.world;
    this.hud.clock.textContent = w.phase === 'deploy' ? `DEPLOY  ${fmtTime(w.timeLimit)}` : `${fmtTime(w.time)} / ${fmtTime(w.timeLimit)}`;
    for (const side of ['nato', 'opfor'] as Side[]) this.hud.fm[side].style.width = `${Math.round(w.forceMorale[side])}%`;
    w.vls.forEach((vl, i) => {
      const chip = this.hud.vls.children[i] as HTMLDivElement;
      chip.style.background = vl.owner ? `#${FACTIONS[vl.owner].color.toString(16).padStart(6, '0')}` : '#ddd';
      chip.classList.toggle('contested', vl.contested);
    });
    const sp = this.paused ? 0 : this.speed;
    const vals = [0, 1, 2, 4];
    this.hud.speedBtns.forEach((b, i) => b.classList.toggle('active', vals[i] === sp));
    // roster
    const own = w.units.filter((u) => u.side === this.player);
    if (own.length !== this.cards.size) this.buildRoster(this.hud.roster);
    for (const u of own) {
      const c = this.cards.get(u.id)!;
      c.classList.toggle('sel', this.selected.has(u.id));
      c.classList.toggle('dead', u.eliminated || u.withdrawn);
      (c.querySelector('.nm') as HTMLElement).textContent = u.name;
      const s1 = c.querySelector('.s1') as HTMLElement;
      s1.textContent = u.vehicle >= 0 ? (u.stateLabel || 'Ready') : `${u.alive}/${u.initialSoldiers} ${u.stateLabel}`;
      s1.style.color = u.stateLabel === 'Pinned' || u.stateLabel === 'Under fire' ? 'var(--warn)' : u.stateLabel === 'Panicked' || u.stateLabel === 'Routing' || u.stateLabel === 'Cowering' ? 'var(--bad)' : '';
      const s2 = c.querySelector('.s2') as HTMLElement;
      s2.textContent = u.order.kind !== 'none' ? ORDER_LABEL[u.order.kind] : '';
      s2.style.color = `#${ORDER_COLORS[u.order.kind].toString(16).padStart(6, '0')}`;
      const str = c.querySelector('.str') as HTMLElement;
      const frac = u.initialSoldiers ? u.alive / u.initialSoldiers : 0;
      str.style.width = `${frac * 100}%`;
      str.style.background = frac > 0.66 ? 'var(--good)' : frac > 0.33 ? 'var(--warn)' : 'var(--bad)';
    }
    this.updateDetail();
    // fade messages
    const nowMs = performance.now();
    for (const m of [...this.hud.msgs.children] as HTMLElement[]) {
      const age = (nowMs - Number(m.dataset.t)) / 1000;
      if (age > 22) m.remove();
      else if (age > 16) m.style.opacity = '0.25';
    }
  }

  private updateDetail(): void {
    const d = this.hud.detail;
    const w = this.world;
    const ids = [...this.selected].filter((id) => !w.units[id].eliminated && !w.units[id].withdrawn);
    if (!ids.length) {
      d.style.display = 'none';
      return;
    }
    d.style.display = '';
    let html = '';
    if (ids.length > 1) {
      html += `<h3>${ids.length} units selected</h3><div class="sub">Orders apply to all selected units that can carry them out.</div><table>`;
      for (const id of ids) {
        const u = w.units[id];
        html += `<tr><td><img src="${symbolURL(u.side, u.template.symbol)}" style="width:26px"></td><td>${u.name}</td><td class="w">${u.alive}/${u.initialSoldiers}</td><td class="w">${u.stateLabel}</td></tr>`;
      }
      html += '</table>';
    } else {
      const u = w.units[ids[0]];
      const expName = u.expLevel >= 0.85 ? 'Elite' : u.expLevel >= 0.7 ? 'Veteran' : u.expLevel >= 0.5 ? 'Regular' : 'Green';
      html += `<div class="banner" style="${portraitBg(u.template)}"><div class="bt"><img src="${symbolURL(u.side, u.template.symbol)}"><div><div class="bn">${u.name}</div><div class="bs">${u.template.name}</div></div></div></div>`;
      html += `<div class="sub">${expName} · ${u.stateLabel}${u.charges ? ` · ${u.template.abilities?.includes('callFire') ? 'Fire missions' : 'Drones'}: ${u.charges}` : ''}</div>`;
      if (u.vehicle >= 0) {
        const v = w.vehicles[u.vehicle];
        const status = v.destroyed ? 'DESTROYED' : v.abandoned ? 'Abandoned' : [v.immobilized ? 'Immobilised' : '', v.gunDamaged ? 'Gun damaged' : ''].filter(Boolean).join(', ') || 'Operational';
        html += `<div class="kv"><b>Status</b><span>${status}</span><b>Armour F/S/R/T</b><span>${v.def.armor.front}/${v.def.armor.side}/${v.def.armor.rear}/${v.def.armor.top} mm</span>`;
        html += `<b>Speed</b><span>${Math.round(Math.abs(v.speed) * 3.6)} km/h</span><b>Smoke</b><span>${v.smokeSalvos}</span>`;
        if (v.def.aps) html += `<b>Trophy APS</b><span>${v.apsCharges}/${v.def.aps.charges}</span>`;
        if (v.def.era) html += `<b>ERA</b><span>fitted</span>`;
        if (v.def.slat) html += `<b>Slat armour</b><span>fitted</span>`;
        html += `</div><table>`;
        for (const ws of v.weapons) html += `<tr><td class="vw"><img src="${weaponIcon(ws.def.id, ws.def.cls)}" alt=""></td><td>${ws.def.name}</td><td class="w">${ws.ammo} rds${ws.reloadT > 0 ? ' (reloading)' : ''}</td></tr>`;
        html += '</table><table style="margin-top:6px">';
        for (const sid of v.crew.length ? v.crew : u.soldiers) {
          const s = w.soldiers[sid];
          html += `<tr><td>${s.rank} ${s.name}</td><td class="w">${s.role}</td><td class="h-${s.health}">${s.health}</td></tr>`;
        }
        html += '</table>';
        if (v.passengers.length) html += `<div class="sub" style="margin-top:6px">Carrying: ${v.passengers.map((p) => w.units[p].name).join(', ')} (${v.def.seats - freeSeats(w, u)}/${v.def.seats} seats)</div>`;
      } else {
        html += '<table>';
        for (const sid of u.soldiers) {
          const s = w.soldiers[sid];
          const ws = weaponCell(s.weapons);
          const st = s.health === 'dead' ? 'KIA' : s.health === 'incap' ? 'Incapacitated' : s.state === 'ready' ? (s.health === 'wounded' ? 'Wounded' : 'OK') : s.state;
          const mor = s.health === 'dead' || s.health === 'incap' ? '' : `<div class="mbar" title="Morale"><div style="width:${s.morale}%;background:${s.morale > 50 ? 'var(--good)' : s.morale > 25 ? 'var(--warn)' : 'var(--bad)'}"></div></div><br><div class="mbar" title="Suppression"><div style="width:${s.supp}%;background:var(--amber)"></div></div>`;
          html += `<tr><td class="h-${s.health}">${s.leader ? '★ ' : ''}${s.rank} ${s.name}<br><span class="w">${s.role}</span></td><td class="wcell">${ws}</td><td>${st}</td><td>${mor}</td></tr>`;
        }
        html += '</table>';
        if (u.mountedIn >= 0) html += `<div class="sub" style="margin-top:6px">Mounted in ${w.units[w.vehicles[u.mountedIn].unitId].name}</div>`;
      }
    }
    // Body and order buttons are separate so live-updating bars never re-create a button mid-click.
    let body = d.querySelector<HTMLDivElement>('.detail-body');
    let bar = d.querySelector<HTMLDivElement>('.orders');
    if (!body || !bar) {
      d.innerHTML = '<div class="detail-body"></div><div class="orders"></div>';
      body = d.querySelector<HTMLDivElement>('.detail-body')!;
      bar = d.querySelector<HTMLDivElement>('.orders')!;
    }
    if (body.dataset.html !== html) {
      body.innerHTML = html;
      body.dataset.html = html;
    }
    const orders = this.commonOrders(ids);
    let bhtml = '';
    for (const k of orders) bhtml += `<button class="btn" data-o="${k}" style="border-color:#${ORDER_COLORS[k].toString(16).padStart(6, '0')}88">${ORDER_LABEL[k]}<span class="kbd">${ORDER_KEY[k] ?? ''}</span></button>`;
    bhtml += `<button class="btn" data-o="none">Stop<span class="kbd">X</span></button>`;
    if (bar.dataset.html !== bhtml) {
      bar.innerHTML = bhtml;
      bar.dataset.html = bhtml;
      bar.querySelectorAll<HTMLButtonElement>('button[data-o]').forEach((b) => {
        b.onclick = () => this.beginOrder(b.dataset.o as OrderKind);
      });
    }
  }

  private commonOrders(ids: number[]): OrderKind[] {
    const set = new Set<OrderKind>();
    for (const id of ids) for (const k of availableOrders(this.world, this.world.units[id])) set.add(k);
    const order: OrderKind[] = ['move', 'moveFast', 'sneak', 'reverse', 'fire', 'smoke', 'defend', 'ambush', 'mount', 'dismount', 'callFire', 'uav', 'strike'];
    return order.filter((k) => set.has(k));
  }

  private pushMsg(text: string, level: string, unit: number): void {
    const m = el('div', `msg ${level}`, `<span class="t">${fmtTime(this.world.time)}</span>${text}`);
    m.dataset.t = String(performance.now());
    if (unit >= 0) m.onclick = () => this.centerOn(unit);
    this.hud.msgs.appendChild(m);
    while (this.hud.msgs.children.length > 9) this.hud.msgs.firstChild!.remove();
    if (level === 'alert') this.opts.sound.blip('radio');
  }

  private banner(text: string, ms = 2200): void {
    const b = this.hud.banner;
    b.textContent = text;
    b.style.opacity = '1';
    setTimeout(() => (b.style.opacity = '0'), ms);
  }

  private drawMinimap(): void {
    const c = this.hud.mini;
    const g = c.getContext('2d')!;
    const w = this.world;
    const S = c.width;
    const k = S / w.map.width;
    g.drawImage(this.view.terrain.minimap, 0, 0, S, S);
    g.fillStyle = 'rgba(0,0,0,0.15)';
    g.fillRect(0, 0, S, S);
    const P = (x: number, y: number): [number, number] => [x * k, S - y * k];
    if (w.phase === 'deploy') {
      const z = w.deploy[this.player];
      const [x0, y0] = P(z.x, z.y + z.h);
      g.strokeStyle = '#8fd0ff';
      g.lineWidth = 2;
      g.strokeRect(x0, y0, z.w * k, z.h * k);
    }
    for (const vl of w.vls) {
      const [x, y] = P(vl.x, vl.y);
      g.beginPath();
      g.arc(x, y, 9, 0, Math.PI * 2);
      g.fillStyle = vl.owner ? `#${FACTIONS[vl.owner].color.toString(16).padStart(6, '0')}` : '#eee';
      g.fill();
      g.strokeStyle = vl.contested ? '#ffd23a' : '#000';
      g.lineWidth = 3;
      g.stroke();
    }
    for (const u of w.units) {
      if (u.eliminated || u.withdrawn || u.mountedIn >= 0) continue;
      const vis = this.view.units.visibleUnit(u.id);
      if (!vis) continue;
      const own = u.side === this.player;
      g.fillStyle = own ? (this.selected.has(u.id) ? '#ffe680' : '#7fc4ff') : '#ff6a5a';
      if (u.vehicle >= 0) {
        const v = w.vehicles[u.vehicle];
        const [x, y] = P(v.x, v.y);
        g.fillRect(x - 5, y - 5, 10, 10);
      } else {
        for (const sid of u.soldiers) {
          const s = w.soldiers[sid];
          if (!World.active(s) || s.vehicle >= 0) continue;
          const [x, y] = P(s.x, s.y);
          g.fillRect(x - 2, y - 2, 4, 4);
        }
      }
    }
    // ghosts
    for (const info of w.spotted[this.player].values()) {
      if (info.visible || w.time - info.lastSeen > 90 || w.units[info.unitId].eliminated) continue;
      const [x, y] = P(info.x, info.y);
      g.strokeStyle = 'rgba(255,120,100,0.7)';
      g.lineWidth = 2;
      g.strokeRect(x - 5, y - 5, 10, 10);
    }
    // camera footprint
    const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([x, y]) => this.view.cam.groundPick(x, y, 3000));
    if (corners.every((p) => p)) {
      g.strokeStyle = 'rgba(255,255,255,0.8)';
      g.lineWidth = 2;
      g.beginPath();
      corners.forEach((p, i) => {
        const [x, y] = P(p!.x, p!.y);
        if (i) g.lineTo(x, y);
        else g.moveTo(x, y);
      });
      g.closePath();
      g.stroke();
    }
  }

  // ------------------------------------------------------------------ selection & orders
  private select(ids: number[]): void {
    this.selected.clear();
    for (const id of ids) {
      const u = this.world.units[id];
      if (u.side === this.player && !u.eliminated && !u.withdrawn) this.selected.add(id);
    }
    this.hudT = 0;
  }
  private toggleSelect(id: number): void {
    if (this.selected.has(id)) this.selected.delete(id);
    else if (this.world.units[id].side === this.player) this.selected.add(id);
    this.hudT = 0;
  }
  private centerOn(unitId: number): void {
    const p = this.world.unitPos(this.world.units[unitId]);
    this.view.cam.lookAt(p.x, p.y);
  }

  private beginOrder(kind: OrderKind): void {
    this.closeCtx();
    if (!this.selected.size) return;
    if (kind === 'none') {
      for (const id of this.selected) {
        const u = this.world.units[id];
        issueOrder(this.world, id, { kind: 'defend', target: undefined, facing: u.facing });
      }
      this.opts.sound.blip();
      return;
    }
    if (INSTANT.includes(kind)) {
      for (const id of this.selected) this.issue(id, kind, null, -1);
      return;
    }
    this.mode = kind;
    this.hudT = 0;
  }

  private issue(unitId: number, kind: OrderKind, p: Vec2 | null, targetUnit: number, offset?: Vec2): boolean {
    const w = this.world;
    const u = w.units[unitId];
    const o: Omit<Order, 'issuedAt'> = { kind };
    if (p) o.target = offset ? { x: p.x + offset.x, y: p.y + offset.y } : { ...p };
    if ((kind === 'fire' || kind === 'strike') && targetUnit >= 0 && w.units[targetUnit].side !== u.side) {
      o.targetUnit = targetUnit;
      delete o.target;
    }
    if (kind === 'mount') {
      if (targetUnit < 0) return false;
      o.targetUnit = targetUnit;
    }
    if (kind === 'fire' && o.targetUnit === undefined && !o.target) return false;
    const r = issueOrder(w, unitId, o);
    if (!r.ok) {
      this.pushMsg(`${u.name}: ${r.reason}`, 'warn', unitId);
      this.opts.sound.blip('bad');
      return false;
    }
    return true;
  }

  private issueSelected(kind: OrderKind, p: Vec2, targetUnit: number): void {
    const ids = [...this.selected];
    // keep relative spacing for group moves
    let cx = 0;
    let cy = 0;
    for (const id of ids) {
      const q = this.world.unitPos(this.world.units[id]);
      cx += q.x;
      cy += q.y;
    }
    cx /= ids.length;
    cy /= ids.length;
    let any = false;
    for (const id of ids) {
      const avail = availableOrders(this.world, this.world.units[id]);
      if (!avail.includes(kind)) continue;
      let off: Vec2 | undefined;
      if (ids.length > 1 && (kind === 'move' || kind === 'moveFast' || kind === 'sneak' || kind === 'reverse')) {
        const q = this.world.unitPos(this.world.units[id]);
        const dx = q.x - cx;
        const dy = q.y - cy;
        const l = Math.hypot(dx, dy);
        const m = Math.min(l, 45) / Math.max(1, l);
        off = { x: dx * m, y: dy * m };
      }
      any = this.issue(id, kind, p, targetUnit, off) || any;
    }
    if (any) this.opts.sound.blip();
  }

  // ------------------------------------------------------------------ picking
  private pickUnit(ndcX: number, ndcY: number): number {
    const icon = this.view.overlays.pickIcon(ndcX, ndcY, this.view.cam.camera);
    if (icon >= 0) return icon;
    const gp = this.view.cam.groundPick(ndcX, ndcY);
    if (!gp) return -1;
    const w = this.world;
    let best = -1;
    let bd = 4;
    for (const v of w.vehicles) {
      if (v.destroyed || v.abandoned) continue;
      if (!this.view.units.visibleUnit(v.unitId)) continue;
      const d = Math.hypot(v.x - gp.x, v.y - gp.y) - v.def.length * 0.45;
      if (d < bd) {
        bd = d;
        best = v.unitId;
      }
    }
    for (const s of w.soldiers) {
      if (!World.active(s) || s.vehicle >= 0) continue;
      if (!this.view.units.visibleUnit(s.unitId)) continue;
      const d = Math.hypot(s.x - gp.x, s.y - gp.y);
      if (d < bd) {
        bd = d;
        best = s.unitId;
      }
    }
    return best;
  }

  private updateHover(): void {
    if (!this.mouse.inside || this.leftDown) return;
    const w = this.world;
    const hov = this.pickUnit(this.mouse.ndcX, this.mouse.ndcY);
    this.view.overlays.hovered = hov;
    const gp = this.view.cam.groundPick(this.mouse.ndcX, this.mouse.ndcY);
    let tipHtml = '';
    const sel = [...this.selected].map((id) => w.units[id]).filter((u) => !u.eliminated);
    const showLos = (this.mode || this.losTool) && sel.length >= 1 && gp;
    if (showLos && gp) {
      const u = sel[0];
      const from = this.eyeOf(u);
      if (from) {
        const tgtH = hov >= 0 && w.units[hov].vehicle >= 0 ? 1.5 : 1.0;
        const los = w.map.los(from.x, from.y, from.eye, gp.x, gp.y, tgtH, from.thermal ? 0.35 : 1);
        const d = Math.hypot(gp.x - from.x, gp.y - from.y);
        const a = new THREE.Vector3(from.x, w.map.groundAt(from.x, from.y) + from.eye, -from.y);
        const b = new THREE.Vector3(gp.x, w.map.groundAt(gp.x, gp.y) + tgtH, -gp.y);
        this.view.overlays.setLos(a, b, los.clear ? 1 : los.blockedAt / Math.max(1, d), los.obstruction > 0.25);
        const cls = los.clear ? (los.obstruction > 0.25 ? 'obs' : 'clear') : 'blk';
        const label = los.clear ? (los.obstruction > 0.25 ? 'Obstructed' : 'Clear') : 'Blocked';
        tipHtml = `${this.mode ? `<b>${ORDER_LABEL[this.mode]}</b> · ` : ''}${Math.round(d)} m · <span class="${cls}">${label}</span>`;
        if (this.mode === 'fire' || this.losTool) {
          const s = w.leaderOf(u);
          const ws = u.vehicle >= 0 ? w.vehicles[u.vehicle].weapons[0] : s?.weapons[0];
          if (ws && s) {
            const p = baseHitChance(ws.def, d) * (u.vehicle >= 0 ? 1 : shooterMod(s));
            tipHtml += ` · ${ws.def.name.split(' (')[0]} ${d > ws.def.range ? 'out of range' : `${Math.round(p * 100)}%/rd`}`;
          }
        }
        if (hov >= 0 && w.units[hov].side !== this.player) tipHtml += ` · <b style="color:var(--bad)">${this.targetName(hov)}</b>`;
      }
    } else {
      this.view.overlays.setLos(null, null, 1, false);
      if (hov >= 0) {
        const u = w.units[hov];
        tipHtml = u.side === this.player ? `${u.name} · ${u.stateLabel}` : `<span style="color:var(--bad)">Enemy ${this.targetName(hov)}</span>`;
      }
    }
    if (tipHtml) {
      this.tip.style.display = '';
      this.tip.innerHTML = tipHtml;
      this.tip.style.left = `${this.mouse.x}px`;
      this.tip.style.top = `${this.mouse.y}px`;
    } else this.tip.style.display = 'none';
    this.root.style.cursor = this.mode ? 'crosshair' : hov >= 0 ? 'pointer' : 'default';
  }

  private targetName(unitId: number): string {
    const u = this.world.units[unitId];
    return u.vehicle >= 0 ? this.world.vehicles[u.vehicle].def.name : u.template.name;
  }

  private eyeOf(u: Unit): { x: number; y: number; eye: number; thermal: boolean } | null {
    const w = this.world;
    if (u.vehicle >= 0) {
      const v = w.vehicles[u.vehicle];
      return { x: v.x, y: v.y, eye: v.def.eye, thermal: v.def.thermal };
    }
    const s = w.leaderOf(u);
    if (!s || s.vehicle >= 0) return null;
    return { x: s.x, y: s.y, eye: Math.max(EYE[s.stance], 1.1), thermal: false };
  }

  // ------------------------------------------------------------------ input
  private bindInput(): void {
    const cv = this.view.renderer.domElement;
    const toNdc = (e: MouseEvent) => {
      const r = cv.getBoundingClientRect();
      this.mouse.x = e.clientX - r.left;
      this.mouse.y = e.clientY - r.top;
      this.mouse.ndcX = (this.mouse.x / r.width) * 2 - 1;
      this.mouse.ndcY = -(this.mouse.y / r.height) * 2 + 1;
    };
    cv.addEventListener('mousemove', (e) => {
      toNdc(e);
      this.mouse.inside = true;
      if (this.leftDown) {
        const dx = this.mouse.x - this.leftDown.x;
        const dy = this.mouse.y - this.leftDown.y;
        if (Math.abs(dx) + Math.abs(dy) > 6) {
          const b = this.boxEl;
          b.style.display = '';
          b.style.left = `${Math.min(this.mouse.x, this.leftDown.x)}px`;
          b.style.top = `${Math.min(this.mouse.y, this.leftDown.y)}px`;
          b.style.width = `${Math.abs(dx)}px`;
          b.style.height = `${Math.abs(dy)}px`;
        }
      }
    });
    cv.addEventListener('mouseleave', () => {
      this.mouse.inside = false;
      this.tip.style.display = 'none';
    });
    cv.addEventListener('mousedown', (e) => {
      this.opts.sound.resume();
      toNdc(e);
      this.closeCtx();
      if (e.button === 0) this.leftDown = { x: this.mouse.x, y: this.mouse.y };
    });
    window.addEventListener('mouseup', (e) => {
      if (e.button !== 0 || !this.leftDown) return;
      const start = this.leftDown;
      this.leftDown = null;
      if (this.boxEl.style.display !== 'none') {
        this.boxEl.style.display = 'none';
        this.boxSelect(start.x, start.y, this.mouse.x, this.mouse.y, e.shiftKey);
        return;
      }
      if (e.target === cv) this.leftClick(e.shiftKey);
    });
    cv.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      toNdc(e);
      this.rightClick(e.clientX, e.clientY);
    });
    cv.addEventListener('dblclick', () => {
      const u = this.pickUnit(this.mouse.ndcX, this.mouse.ndcY);
      if (u >= 0) this.centerOn(u);
    });
    window.addEventListener('keydown', this.onKey);
  }

  private onKey = (e: KeyboardEvent) => {
    if (this.disposed) return;
    if ((e.target as HTMLElement)?.tagName === 'INPUT') return;
    const code = e.code;
    if (code === 'Escape') {
      if (this.ctxMenu) this.closeCtx();
      else if (this.mode) this.mode = null;
      else if (this.losTool) this.losTool = false;
      else if (this.selected.size) this.select([]);
      else this.showPauseMenu();
      return;
    }
    if (code === 'Space') {
      e.preventDefault();
      this.paused = !this.paused;
      this.hudT = 0;
      return;
    }
    if (code === 'KeyL') {
      this.losTool = !this.losTool;
      return;
    }
    if (code === 'KeyX') return this.beginOrder('none');
    if (code === 'KeyY') {
      const ids = [...this.selected];
      if (ids.some((id) => availableOrders(this.world, this.world.units[id]).includes('dismount'))) this.beginOrder('dismount');
      else this.beginOrder('mount');
      return;
    }
    if (code === 'Tab') {
      e.preventDefault();
      const own = this.world.units.filter((u) => u.side === this.player && !u.eliminated && !u.withdrawn);
      if (!own.length) return;
      const cur = [...this.selected][0];
      const i = own.findIndex((u) => u.id === cur);
      const next = own[(i + 1) % own.length];
      this.select([next.id]);
      this.centerOn(next.id);
      return;
    }
    if (code.startsWith('Digit')) {
      const n = Number(code.slice(5));
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        this.groups.set(n, [...this.selected]);
        this.pushMsg(`Group ${n} assigned.`, 'info', -1);
      } else if (this.groups.has(n)) {
        const g = this.groups.get(n)!.filter((id) => !this.world.units[id].eliminated);
        if (g.length && g.every((id) => this.selected.has(id)) && g.length === this.selected.size) this.centerOn(g[0]);
        this.select(g);
      } else if (n >= 1 && n <= 4 && !e.shiftKey) {
        // speed shortcuts when no group bound
        this.setSpeed([0, 1, 2, 4][n - 1]);
      }
      return;
    }
    if (code === 'Equal' && e.shiftKey) return this.setSpeed(Math.min(4, this.speed * 2));
    const kind = KEY_ORDER[code];
    if (kind && this.selected.size) {
      if (!this.commonOrders([...this.selected]).includes(kind)) {
        this.opts.sound.blip('bad');
        return;
      }
      this.beginOrder(kind);
    }
  };

  private setSpeed(s: number): void {
    if (s === 0) this.paused = true;
    else {
      this.paused = false;
      this.speed = s;
    }
    this.hudT = 0;
  }

  private boxSelect(x0: number, y0: number, x1: number, y1: number, add: boolean): void {
    const cv = this.view.renderer.domElement;
    const r = cv.getBoundingClientRect();
    const minX = Math.min(x0, x1);
    const maxX = Math.max(x0, x1);
    const minY = Math.min(y0, y1);
    const maxY = Math.max(y0, y1);
    const ids: number[] = add ? [...this.selected] : [];
    const v = new THREE.Vector3();
    for (const u of this.world.units) {
      if (u.side !== this.player || u.eliminated || u.withdrawn) continue;
      const p = this.world.unitPos(u);
      v.set(p.x, this.world.map.groundAt(p.x, p.y) + 1, -p.y).project(this.view.cam.camera);
      const sx = ((v.x + 1) / 2) * r.width;
      const sy = ((1 - v.y) / 2) * r.height;
      if (sx >= minX && sx <= maxX && sy >= minY && sy <= maxY && !ids.includes(u.id)) ids.push(u.id);
    }
    this.select(ids);
  }

  private leftClick(shift: boolean): void {
    const w = this.world;
    const gp = this.view.cam.groundPick(this.mouse.ndcX, this.mouse.ndcY);
    const hov = this.pickUnit(this.mouse.ndcX, this.mouse.ndcY);
    if (this.mode) {
      const kind = this.mode;
      this.mode = null;
      if (!gp) return;
      this.issueSelected(kind, gp, hov);
      return;
    }
    if (w.phase === 'deploy' && hov < 0 && gp && this.selected.size === 1) {
      this.deployTo([...this.selected][0], gp);
      return;
    }
    if (hov >= 0 && w.units[hov].side === this.player) {
      if (shift) this.toggleSelect(hov);
      else this.select([hov]);
      return;
    }
    if (!shift) this.select([]);
  }

  private deployTo(unitId: number, p: Vec2): void {
    const w = this.world;
    const u = w.units[unitId];
    const z = w.deploy[this.player];
    if (p.x < z.x || p.y < z.y || p.x > z.x + z.w || p.y > z.y + z.h) {
      this.pushMsg('Units must be placed inside your deployment zone.', 'warn', -1);
      this.opts.sound.blip('bad');
      return;
    }
    const mob = u.vehicle >= 0 ? w.vehicles[u.vehicle].def.mobility : 'foot';
    const q = nearestPassable(w.map, p.x, p.y, mob, 6);
    if (!q) return;
    placeUnit(w, u, q, u.facing);
    this.opts.sound.blip();
  }

  private rightClick(clientX: number, clientY: number): void {
    const w = this.world;
    if (this.mode) {
      this.mode = null;
      return;
    }
    const gp = this.view.cam.groundPick(this.mouse.ndcX, this.mouse.ndcY);
    if (!gp || !this.selected.size) return;
    if (w.phase === 'deploy') {
      for (const id of this.selected) {
        const u = w.units[id];
        const p = w.unitPos(u);
        placeUnit(w, u, u.vehicle >= 0 ? p : u.holdPos ?? p, angleTo(p, gp));
        u.order = { kind: 'defend', issuedAt: 0, facing: u.facing };
      }
      return;
    }
    const hov = this.pickUnit(this.mouse.ndcX, this.mouse.ndcY);
    const enemy = hov >= 0 && w.units[hov].side !== this.player ? hov : -1;
    const friendlyCarrier = hov >= 0 && w.units[hov].side === this.player && w.units[hov].vehicle >= 0 && w.vehicles[w.units[hov].vehicle].def.seats > 0 ? hov : -1;
    const orders = this.commonOrders([...this.selected]);
    const menu = el('div', 'ctx-menu panel');
    const hdr = enemy >= 0 ? `Target: <b style="color:var(--bad)">${this.targetName(enemy)}</b>` : friendlyCarrier >= 0 ? `Vehicle: ${w.units[friendlyCarrier].name}` : `${Math.round(gp.x)}, ${Math.round(gp.y)}`;
    menu.appendChild(el('div', 'hdr', hdr));
    const list: OrderKind[] = [];
    if (enemy >= 0) for (const k of ['fire', 'strike', 'callFire'] as OrderKind[]) if (orders.includes(k)) list.push(k);
    if (friendlyCarrier >= 0 && orders.includes('mount')) list.push('mount');
    for (const k of orders) if (!list.includes(k) && k !== 'mount' && k !== 'strike' && !(k === 'dismount')) list.push(k);
    if (orders.includes('dismount')) list.push('dismount');
    for (const k of list) {
      const b = el('button', '', `<span><span class="sw" style="background:#${ORDER_COLORS[k].toString(16).padStart(6, '0')}"></span>${ORDER_LABEL[k]}</span><span class="kbd">${ORDER_KEY[k] ?? ''}</span>`);
      b.onclick = () => {
        this.closeCtx();
        if (k === 'dismount') for (const id of this.selected) this.issue(id, 'dismount', null, -1);
        else this.issueSelected(k, gp, k === 'mount' ? friendlyCarrier : enemy);
      };
      menu.appendChild(b);
    }
    const stop = el('button', '', `<span><span class="sw" style="background:#fff"></span>Stop / hold here</span><span class="kbd">X</span>`);
    stop.onclick = () => this.beginOrder('none');
    menu.appendChild(stop);
    const r = this.root.getBoundingClientRect();
    menu.style.left = `${clamp(clientX - r.left, 0, r.width - 190)}px`;
    menu.style.top = `${clamp(clientY - r.top, 0, r.height - 30 - list.length * 30)}px`;
    this.root.appendChild(menu);
    this.ctxMenu = menu;
  }

  private closeCtx(): void {
    this.ctxMenu?.remove();
    this.ctxMenu = null;
  }

  // ------------------------------------------------------------------ flow
  private beginBattle(): void {
    this.world.startBattle();
    this.view.overlays.showDeployZone(null);
    this.hud.deploy?.remove();
    this.hud.deploy = null;
    this.banner('BATTLE COMMENCED');
    this.opts.sound.resume();
  }

  private modal(html: string, buttons: [string, () => void, boolean?][]): HTMLDivElement {
    const back = el('div', 'modal-back');
    const m = el('div', 'modal panel', html);
    const row = el('div', 'row');
    for (const [label, fn, primary] of buttons) {
      const b = el('button', `btn${primary ? ' primary' : ''}`, label);
      b.onclick = () => {
        back.remove();
        fn();
      };
      row.appendChild(b);
    }
    m.appendChild(row);
    back.appendChild(m);
    this.root.appendChild(back);
    return back;
  }

  private showPauseMenu(): void {
    const wasPaused = this.paused;
    this.paused = true;
    const w = this.world;
    const vol = Math.round(this.opts.sound.volume * 100);
    const back = this.modal(
      `<h2>Paused</h2><p style="color:var(--dim)">${this.opts.title} — ${fmtTime(w.time)} elapsed.</p>
       <label>Sound volume <input type="range" min="0" max="100" value="${vol}" id="vol"></label><br><br>
       <label><input type="checkbox" id="edge" ${this.view.cam.edgeScroll ? 'checked' : ''}> Edge scrolling</label>
       <p style="color:var(--dim);font-size:12px;margin-top:14px">A cease-fire ends the battle now and scores the victory locations as they stand. Withdrawing concedes the battle.</p>`,
      [
        ['Quit to Menu', () => this.opts.onExit(this.world, null, true)],
        ['Withdraw', () => this.world.endBattle(otherSide(this.player), `${FACTIONS[this.player].short} commander ordered a withdrawal.`)],
        ['Request Cease-fire', () => this.requestCeasefire()],
        ['Resume', () => (this.paused = wasPaused), true],
      ],
    );
    const volEl = back.querySelector('#vol') as HTMLInputElement;
    volEl.oninput = () => this.opts.sound.setVolume(Number(volEl.value) / 100);
    const edge = back.querySelector('#edge') as HTMLInputElement;
    edge.onchange = () => (this.view.cam.edgeScroll = edge.checked);
  }

  private requestCeasefire(): void {
    const w = this.world;
    this.paused = false;
    if (w.phase === 'deploy') return;
    const mine = w.vls.filter((v) => v.owner === this.player).reduce((n, v) => n + v.value, 0);
    const theirs = w.vls.filter((v) => v.owner === otherSide(this.player)).reduce((n, v) => n + v.value, 0);
    // The enemy agrees if it is ahead on the ground, or badly beaten up, or the battle is long.
    const enemyFm = w.forceMorale[otherSide(this.player)];
    if (theirs >= mine || enemyFm < 45 || w.time > w.timeLimit * 0.6) w.endBattle(null, 'Cease-fire agreed.');
    else this.pushMsg('The enemy refuses a cease-fire.', 'warn', -1);
  }

  private showEnd(): void {
    const r = this.world.result;
    if (!r) return;
    const won = r.winner === this.player;
    const title = r.winner === null ? 'DRAW' : won ? (r.grade === 'decisive' ? 'DECISIVE VICTORY' : 'VICTORY') : r.grade === 'decisive' ? 'DECISIVE DEFEAT' : 'DEFEAT';
    this.banner(title, 3000);
    this.paused = true;
    this.modal(`<h2>${title}</h2><p>${r.reason}</p>`, [['Debrief ▸', () => this.opts.onExit(this.world, r, false), true]]);
  }
}
