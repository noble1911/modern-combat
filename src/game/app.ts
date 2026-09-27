import { getMap, MAP_ORDER, MAPS, registerMap } from '../data/maps';
import { randomMap } from '../data/randomMap';
import { FACTIONS, otherSide, Side } from '../data/units';
import { SoundEngine } from '../audio/sound';
import type { LightingId } from '../render/atmosphere';
import type { GraphicsSettings } from '../render/battleView';
import { ModelLib } from '../render/models';
import { MapPainter } from '../render/terrainView';
import { ForceEditor } from '../ui/forceEditor';
import { generateMap } from '../sim/mapgen';
import type { BattleResult } from '../sim/types';
import type { World } from '../sim/world';
import { savedSeat } from '../net/client';
import type { BattleOptions } from './battle';
import { BattleScreen, symbolURL } from './battle';
import { MultiplayerUI } from './multiplayer';
import { readStored, STORAGE } from './campaign';
import { CampaignUI } from './campaignUI';
import { BattleSetup, defaultForces, ForceEntry, forceCost } from './scenario';
import { helpHtml } from './help';

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, html?: string): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html !== undefined) e.innerHTML = html;
  return e;
};

const thumbs = new Map<string, string>();
export function mapThumb(id: string): string {
  let t = thumbs.get(id);
  if (!t) {
    const p = new MapPainter(generateMap(getMap(id)!), 512);
    t = p.canvas.toDataURL('image/jpeg', 0.85);
    thumbs.set(id, t);
  }
  return t;
}

export class App {
  readonly models = new ModelLib();
  readonly sound = new SoundEngine();
  gfx: GraphicsSettings = { quality: 'high', shadows: true };
  private screen: HTMLElement | null = null;
  private battle: BattleScreen | null = null;
  campaign: CampaignUI;
  readonly multiplayer = new MultiplayerUI(this);

  constructor(readonly root: HTMLElement) {
    this.campaign = new CampaignUI(this);
    try {
      const saved = JSON.parse(readStored('settings') ?? 'null');
      if (saved) {
        this.gfx = { ...this.gfx, ...saved.gfx };
        this.sound.setVolume(saved.volume ?? 0.7);
      }
    } catch {
      /* ignore */
    }
  }

  saveSettings(): void {
    try {
      localStorage.setItem(STORAGE.settings, JSON.stringify({ gfx: this.gfx, volume: this.sound.volume }));
    } catch {
      /* ignore */
    }
  }

  async boot(): Promise<void> {
    const load = el('div', 'loading', `<div>LOADING MODELS</div><div class="bar"><div></div></div>`);
    this.root.appendChild(load);
    const bar = load.querySelector('.bar div') as HTMLDivElement;
    await this.models.load((d, t) => (bar.style.width = `${(d / t) * 100}%`));
    load.remove();
    const params = new URLSearchParams(location.search);
    // invite links (?join=CODE) and reloads in the middle of an online game
    const join = params.get('join');
    if (join) {
      history.replaceState(null, '', location.pathname);
      this.multiplayer.open(join.toUpperCase());
      return;
    }
    const seat = savedSeat();
    if (seat) {
      this.multiplayer.rejoin(seat);
      return;
    }
    if (params.get('quick')) {
      const map = params.get('quick')!;
      const side = (params.get('side') as Side) ?? 'nato';
      const { forces, posture } = defaultForces(map);
      const lighting = (params.get('light') as LightingId | null) ?? undefined;
      this.startBattle({ mapId: map, seed: Date.now() % 100000, timeLimit: 25 * 60, player: side, posture, forces, lighting }, MAPS[map].name, () => this.mainMenu());
      return;
    }
    this.mainMenu();
  }

  setScreen(e: HTMLElement): void {
    this.screen?.remove();
    this.battle?.destroy();
    this.battle = null;
    this.screen = e;
    this.root.appendChild(e);
  }

  // ------------------------------------------------------------------ main menu
  mainMenu(): void {
    const s = el('div', 'screen menu-screen');
    const bg = el('canvas', 'bgcanvas');
    s.appendChild(bg);
    this.animateBackdrop(bg);
    const box = el('div', 'menu-box panel');
    box.innerHTML = `<div class="logo">MODERN <span>COMBAT</span></div><div class="tagline">Operation Iron Corridor</div>`;
    const btn = (label: string, fn: () => void, primary = false) => {
      const b = el('button', `btn${primary ? ' primary' : ''}`, label);
      b.onclick = () => {
        this.sound.resume();
        fn();
      };
      box.appendChild(b);
    };
    btn('Operation Iron Corridor', () => this.campaign.open(), true);
    if (this.campaign.hasSave()) btn('Continue Operation', () => this.campaign.continueSaved());
    btn('Quick Battle', () => this.quickBattle());
    btn('Multiplayer', () => this.multiplayer.open());
    btn('Field Manual (How to Play)', () => this.help());
    btn('Settings', () => this.settings());
    const foot = el('div', '', `<div style="color:var(--dim);font-size:11px;margin-top:16px">A real-time tactical wargame in the tradition of <i>Close Combat: A Bridge Too Far</i>.<br>All units, places and events are fictional.</div>`);
    box.appendChild(foot);
    s.appendChild(box);
    this.setScreen(s);
  }

  private animateBackdrop(c: HTMLCanvasElement): void {
    const img = new Image();
    img.src = mapThumb('nordhaven');
    const draw = (t: number) => {
      if (!c.isConnected) return;
      c.width = c.clientWidth;
      c.height = c.clientHeight;
      const g = c.getContext('2d')!;
      const s = Math.max(c.width, c.height) * 1.4;
      g.globalAlpha = 0.8;
      if (img.complete) g.drawImage(img, -s * 0.2 + Math.sin(t / 9000) * 40, -s * 0.2 + Math.cos(t / 11000) * 40, s, s);
      g.globalAlpha = 1;
      const grd = g.createRadialGradient(c.width / 2, c.height / 2, 100, c.width / 2, c.height / 2, c.width * 0.7);
      grd.addColorStop(0, 'rgba(8,10,9,0.35)');
      grd.addColorStop(1, 'rgba(8,10,9,0.95)');
      g.fillStyle = grd;
      g.fillRect(0, 0, c.width, c.height);
      // radar sweep
      const a = t / 1400;
      g.strokeStyle = 'rgba(200,217,106,0.15)';
      g.lineWidth = 2;
      g.beginPath();
      g.moveTo(c.width / 2, c.height / 2);
      g.lineTo(c.width / 2 + Math.cos(a) * c.width, c.height / 2 + Math.sin(a) * c.width);
      g.stroke();
      requestAnimationFrame(draw);
    };
    requestAnimationFrame(draw);
  }

  // ------------------------------------------------------------------ settings & help
  settings(): void {
    const s = el('div', 'page');
    s.innerHTML = `<h1>Settings</h1><div class="lead">Graphics settings apply to the next battle.</div>
    <div class="section panel" style="max-width:520px">
      <h3>Graphics</h3>
      <label><input type="radio" name="q" value="high" ${this.gfx.quality === 'high' ? 'checked' : ''}> High quality (4K terrain texture, dense woods)</label><br>
      <label><input type="radio" name="q" value="low" ${this.gfx.quality === 'low' ? 'checked' : ''}> Performance (smaller textures, sparser woods)</label><br><br>
      <label><input type="checkbox" id="sh" ${this.gfx.shadows ? 'checked' : ''}> Shadows</label><br>
      <label><input type="checkbox" id="pp" ${(this.gfx.post ?? this.gfx.quality === 'high') ? 'checked' : ''}> Post-processing (bloom, colour grading, HDR)</label><br>
      <label><input type="checkbox" id="ao" ${(this.gfx.ao ?? this.gfx.quality === 'high') ? 'checked' : ''}> Ambient occlusion (needs post-processing)</label><br>
      <label><input type="checkbox" id="gr" ${(this.gfx.grass ?? this.gfx.quality === 'high') ? 'checked' : ''}> Grass close to the camera</label>
      <h3 style="margin-top:16px">Audio</h3>
      <label>Volume <input type="range" id="vol" min="0" max="100" value="${Math.round(this.sound.volume * 100)}"></label>
    </div>`;
    const back = el('button', 'btn primary', 'Back');
    back.onclick = () => {
      this.gfx.quality = (s.querySelector('input[name=q]:checked') as HTMLInputElement).value as 'low' | 'high';
      this.gfx.shadows = (s.querySelector('#sh') as HTMLInputElement).checked;
      this.gfx.post = (s.querySelector('#pp') as HTMLInputElement).checked;
      this.gfx.ao = (s.querySelector('#ao') as HTMLInputElement).checked;
      this.gfx.grass = (s.querySelector('#gr') as HTMLInputElement).checked;
      this.sound.setVolume(Number((s.querySelector('#vol') as HTMLInputElement).value) / 100);
      this.saveSettings();
      this.mainMenu();
    };
    s.appendChild(back);
    this.setScreen(s);
  }

  help(): void {
    const s = el('div', 'page help', helpHtml());
    const back = el('button', 'btn primary', 'Back');
    back.style.position = 'fixed';
    back.style.top = '20px';
    back.style.right = '30px';
    back.onclick = () => this.mainMenu();
    s.appendChild(back);
    this.setScreen(s);
  }

  // ------------------------------------------------------------------ quick battle
  quickBattle(): void {
    let mapId = 'veldmark';
    let side: Side = 'nato';
    let diff = 'regular';
    let minutes = 25;
    let forces: Record<Side, ForceEntry[]> = defaultForces(mapId).forces;
    let budget = 0;
    let editor: ForceEditor | null = null;
    const s = el('div', 'page');
    const render = () => {
      const def = getMap(mapId)!;
      const { posture } = defaultForces(mapId);
      const cost = forceCost(forces[side]);
      s.innerHTML = `<h1>Quick Battle</h1><div class="lead">Pick a battlefield and a side. Your opponent is commanded by the AI. Adjust your force within the requisition budget.</div>`;
      const grid = el('div', 'qb-grid');
      const left = el('div');
      const mapSec = el('div', 'section panel', `<h3>Battlefield</h3>`);
      const mapChoice = el('div', 'choice');
      for (const id of MAP_ORDER) {
        const b = el('button', `btn small${id === mapId ? ' active' : ''}`, MAPS[id].name);
        b.onclick = () => {
          mapId = id;
          forces = defaultForces(id).forces;
          budget = 0;
          render();
        };
        mapChoice.appendChild(b);
      }
      const rb = el('button', `btn small${mapId.startsWith('random') ? ' active' : ''}`, '🎲 Random battlefield');
      rb.onclick = () => {
        const def = randomMap(Math.floor(Math.random() * 1e6));
        registerMap(def);
        mapId = def.id;
        forces = defaultForces('veldmark').forces;
        budget = 0;
        render();
      };
      mapChoice.appendChild(rb);
      mapSec.appendChild(mapChoice);
      mapSec.appendChild(el('div', '', `<div style="display:flex;gap:12px;margin-top:10px"><img class="map-thumb" style="width:220px" src="${mapThumb(mapId)}"><div style="color:var(--dim);line-height:1.5">${def.description}<br><br><b style="color:var(--text)">NATO:</b> ${posture.nato === 'attack' ? 'Attacking' : 'Defending'} · <b style="color:var(--text)">OPFOR:</b> ${posture.opfor === 'attack' ? 'Attacking' : 'Defending'}<br><b style="color:var(--text)">Objectives:</b> ${def.vls.map((v) => `${v.name} (${v.value})`).join(', ')}</div></div>`));
      left.appendChild(mapSec);
      const opt = el('div', 'section panel', `<h3>Options</h3>`);
      const row = (label: string, items: [string, string][], cur: string, fn: (v: string) => void) => {
        const r = el('div', '', `<div style="color:var(--dim);margin:6px 0 4px">${label}</div>`);
        const ch = el('div', 'choice');
        for (const [v, l] of items) {
          const b = el('button', `btn small${v === cur ? ' active' : ''}`, l);
          b.onclick = () => {
            fn(v);
            render();
          };
          ch.appendChild(b);
        }
        r.appendChild(ch);
        opt.appendChild(r);
      };
      row('Your side', [['nato', FACTIONS.nato.name], ['opfor', FACTIONS.opfor.name]], side, (v) => {
        side = v as Side;
        budget = 0;
      });
      row('Enemy quality', [['green', 'Green'], ['regular', 'Regular'], ['veteran', 'Veteran'], ['elite', 'Elite']], diff, (v) => (diff = v));
      row('Time limit', [['15', '15 min'], ['25', '25 min'], ['40', '40 min']], String(minutes), (v) => (minutes = Number(v)));
      left.appendChild(opt);
      grid.appendChild(left);
      // forces: what you've requisitioned, the catalogue to add from, and a details panel
      if (!budget) budget = Math.round((forceCost(forces[side]) * 1.1) / 10) * 10;
      if (!editor) editor = new ForceEditor({ side, budget, force: forces[side], onChange: () => render() });
      else editor.update({ side, budget, force: forces[side] });
      const mid = el('div');
      mid.appendChild(editor.panel);
      const enemy = el('div', 'section panel', `<h3>Enemy force (intelligence estimate)</h3><div style="color:var(--dim)">${forces[otherSide(side)].length} units, approx. ${forceCost(forces[otherSide(side)])} points.</div>`);
      mid.appendChild(enemy);
      grid.appendChild(mid);
      grid.appendChild(editor.detail);
      s.appendChild(grid);
      const bar = el('div', '', '');
      bar.style.cssText = 'display:flex;gap:10px;justify-content:flex-end;margin-top:10px';
      const back = el('button', 'btn', 'Back');
      back.onclick = () => this.mainMenu();
      const go = el('button', 'btn primary', 'Deploy ▸');
      go.disabled = cost > budget || !forces[side].length;
      go.onclick = () => {
        const expMap: Record<string, number> = { green: 0.35, regular: 0.55, veteran: 0.72, elite: 0.88 };
        const f: Record<Side, ForceEntry[]> = {
          nato: forces.nato.map((e) => ({ ...e })),
          opfor: forces.opfor.map((e) => ({ ...e })),
        };
        for (const e of f[otherSide(side)]) e.exp = expMap[diff];
        const setup: BattleSetup = { mapId, seed: Math.floor(Math.random() * 1e6), timeLimit: minutes * 60, player: side, posture, forces: f };
        this.startBattle(setup, def.name, (w, r) => this.debrief(w, r, () => this.quickBattle()));
      };
      bar.append(back, go);
      s.appendChild(bar);
    };
    render();
    this.setScreen(s);
  }

  // ------------------------------------------------------------------ battle
  startBattle(setup: BattleSetup, title: string, onDone: (w: World, r: BattleResult | null) => void, onQuit?: () => void, net?: BattleOptions['net']): void {
    const s = el('div', 'screen');
    this.setScreen(s);
    const loading = el('div', 'loading', `<div>PREPARING BATTLEFIELD</div>`);
    s.appendChild(loading);
    setTimeout(() => {
      this.battle = new BattleScreen(s, {
        setup,
        title,
        models: this.models,
        gfx: this.gfx,
        sound: this.sound,
        net,
        onExit: (w, r, quit) => {
          if (quit) (onQuit ?? (() => this.mainMenu()))();
          else onDone(w, r);
        },
      });
      loading.remove();
      (window as any).__battle = this.battle;
    }, 30);
  }

  debrief(w: World, r: BattleResult | null, next: () => void, nextLabel = 'Continue'): void {
    const player = w.sides.nato.ai ? 'opfor' : 'nato';
    const s = el('div', 'page');
    const won = r?.winner === player;
    const title = !r ? 'Battle abandoned' : r.winner === null ? 'Draw' : won ? (r.grade === 'decisive' ? 'Decisive Victory' : 'Victory') : r.grade === 'decisive' ? 'Decisive Defeat' : 'Defeat';
    let html = `<h1>Debrief — ${title}</h1><div class="lead">${r?.reason ?? ''} Battle time ${Math.floor(w.time / 60)} min.</div><div class="grid2">`;
    if (r) {
      html += `<div class="section panel"><h3>Casualties</h3><table style="width:100%"><tr><td></td><td>${FACTIONS.nato.short}</td><td>${FACTIONS.opfor.short}</td></tr>`;
      for (const [k, label] of [['killed', 'Killed'], ['wounded', 'Wounded'], ['captured', 'Captured'], ['vehiclesLost', 'Vehicles lost']] as const)
        html += `<tr><td style="color:var(--dim)">${label}</td><td>${r.casualties.nato[k]}</td><td>${r.casualties.opfor[k]}</td></tr>`;
      html += `<tr><td style="color:var(--dim)">Objective points</td><td>${r.vlPoints.nato}</td><td>${r.vlPoints.opfor}</td></tr></table>`;
      html += `<h3 style="margin-top:14px">Objectives</h3>${w.vls.map((v) => `<div><span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${v.owner ? '#' + FACTIONS[v.owner].color.toString(16).padStart(6, '0') : '#ddd'}"></span> ${v.name} — ${v.owner ? FACTIONS[v.owner].short : 'neutral'}</div>`).join('')}</div>`;
    }
    html += `<div class="section panel"><h3>Your units</h3><table style="width:100%">`;
    let mvp: { name: string; kills: number } | null = null;
    for (const u of w.units) {
      if (u.side !== player) continue;
      const kills = u.soldiers.reduce((n, id) => n + w.soldiers[id].kills, 0) + (u.vehicle >= 0 ? w.vehicles[u.vehicle].crew.reduce((n, id) => n + w.soldiers[id].kills, 0) : 0);
      for (const id of u.soldiers) {
        const so = w.soldiers[id];
        if (!mvp || so.kills > mvp.kills) mvp = { name: `${so.rank} ${so.name} (${u.name})`, kills: so.kills };
      }
      const status = u.vehicle >= 0 ? (w.vehicles[u.vehicle].destroyed ? 'Destroyed' : w.vehicles[u.vehicle].abandoned ? 'Abandoned' : 'Operational') : u.eliminated ? 'Eliminated' : `${u.alive}/${u.initialSoldiers}`;
      html += `<tr><td><img src="${symbolURL(u.side, u.template.symbol)}" style="width:24px"></td><td>${u.name}</td><td style="color:var(--dim)">${status}</td><td>${kills} kills</td></tr>`;
    }
    html += `</table>${mvp && mvp.kills ? `<p>Distinguished: <b>${mvp.name}</b> — ${mvp.kills} kills.</p>` : ''}</div></div>`;
    s.innerHTML = html;
    const b = el('button', 'btn primary', nextLabel);
    b.onclick = next;
    const m = el('button', 'btn', 'Main Menu');
    m.onclick = () => this.mainMenu();
    const row = el('div', '');
    row.style.cssText = 'display:flex;gap:10px;justify-content:flex-end';
    row.append(m, b);
    s.appendChild(row);
    this.setScreen(s);
  }
}
