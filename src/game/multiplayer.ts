import { getMap, MAP_ORDER, MAPS, registerMap } from '../data/maps';
import { randomMap } from '../data/randomMap';
import { FACTIONS, otherSide, Side } from '../data/units';
import { lightingForSeed } from '../render/atmosphere';
import { clearSeat, MpSeat, NetClient } from '../net/client';
import type { ClientMsg, Mode, NetSetup, RoomSettings, RoomState, ServerMsg, StepBatch } from '../net/protocol';
import { fitToBudget, ForceEditor } from '../ui/forceEditor';
import type { App } from './app';
import { mapThumb } from './app';
import { BattleSetup, defaultForces, ForceEntry, forceCost } from './scenario';

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, html?: string): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html !== undefined) e.innerHTML = html;
  return e;
};
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const NAME_KEY = 'modern-combat.name';
const EXP: Record<RoomSettings['enemy'], number> = { green: 0.35, regular: 0.55, veteran: 0.72, elite: 0.88 };
const MODE_LABEL: Record<Mode, string> = { versus: 'Head to head', coop: 'Co-op vs AI' };

/** Generated battlefields are named `random-<seed>`: make sure this browser knows the map. */
export function ensureMap(mapId: string): void {
  if (getMap(mapId)) return;
  const m = /^random-(\d+)$/.exec(mapId);
  if (m) registerMap(randomMap(Number(m[1])));
}

function defaultSettings(mode: Mode): RoomSettings {
  return { mode, mapId: 'hollen', side: 'nato', minutes: 25, budget: mode === 'versus' ? 1000 : 700, enemy: 'regular' };
}

/**
 * Online games: create a room (you get a code and an invite link) or join one, pick settings and
 * your force in the lobby, then fight the battle in lockstep through the relay (see src/net/).
 */
export class MultiplayerUI {
  private client: NetClient | null = null;
  private state: RoomState | null = null;
  private force: ForceEntry[] = [];
  private forceKey = '';
  private editor: ForceEditor | null = null;
  private partner: ForceEditor | null = null;
  private chat: { name: string; text: string }[] = [];
  private page: HTMLElement | null = null;
  private inBattle = false;
  private forceTimer = 0;

  constructor(private app: App) {}

  private get name(): string {
    try {
      return localStorage.getItem(NAME_KEY) ?? '';
    } catch {
      return '';
    }
  }

  private set name(v: string) {
    try {
      localStorage.setItem(NAME_KEY, v);
    } catch {
      /* ignore */
    }
  }

  // ------------------------------------------------------------------ entry
  open(joinCode = ''): void {
    this.reset();
    const s = el('div', 'page');
    s.innerHTML = `<h1>Multiplayer</h1><div class="lead">Play a battle online with a friend: head to head (one of you NATO, the other OPFOR), or together on one side against the AI. Host a game and send them the link, or join theirs with its code.</div>`;
    const grid = el('div', 'mp-grid');
    const who = el('div', 'section panel', `<h3>Your name</h3><input class="mp-input" id="mp-name" maxlength="20" placeholder="Commander" value="${esc(this.name)}">`);
    const host = el('div', 'section panel', `<h3>Host a game</h3><div style="color:var(--dim);margin-bottom:8px">You pick the battlefield, sides and points in the lobby.</div>`);
    const modes = el('div', 'choice');
    for (const m of ['versus', 'coop'] as Mode[]) {
      const b = el('button', 'btn', `${MODE_LABEL[m]}<br><span style="color:var(--dim);font-size:11px">${m === 'versus' ? '1 v 1 · NATO vs OPFOR' : '2 players · one side vs the AI'}</span>`);
      b.onclick = () => this.connect({ t: 'create', name: this.nameFrom(s), settings: defaultSettings(m) });
      modes.appendChild(b);
    }
    host.appendChild(modes);
    const join = el('div', 'section panel', `<h3>Join a game</h3><div style="display:flex;gap:8px"><input class="mp-input" id="mp-code" maxlength="4" placeholder="CODE" value="${esc(joinCode)}" style="text-transform:uppercase;width:120px;letter-spacing:3px"></div>`);
    const jb = el('button', 'btn primary', 'Join ▸');
    jb.onclick = () => {
      const code = (s.querySelector('#mp-code') as HTMLInputElement).value.trim().toUpperCase();
      if (code.length === 4) this.connect({ t: 'join', room: code, name: this.nameFrom(s) });
    };
    join.querySelector('div')!.appendChild(jb);
    grid.append(who, host, join);
    s.appendChild(grid);
    const status = el('div', 'mp-status', '');
    status.id = 'mp-status';
    s.appendChild(status);
    const back = el('button', 'btn', 'Back');
    back.onclick = () => this.app.mainMenu();
    s.appendChild(back);
    this.page = s;
    this.app.setScreen(s);
    if (joinCode && this.name) jb.click();
  }

  /** Reclaim a seat after a page reload (the relay replays a battle in progress). */
  rejoin(seat: MpSeat): void {
    this.open();
    this.setStatus('Rejoining your game…');
    this.connect({ t: 'join', room: seat.room, name: seat.name, token: seat.token }, seat.name);
  }

  private nameFrom(s: HTMLElement): string {
    const v = (s.querySelector('#mp-name') as HTMLInputElement).value.trim().slice(0, 20) || 'Commander';
    this.name = v;
    return v;
  }

  private setStatus(text: string, bad = false): void {
    const st = document.getElementById('mp-status');
    if (st) {
      st.textContent = text;
      st.style.color = bad ? 'var(--bad)' : 'var(--dim)';
    }
  }

  private reset(): void {
    this.client?.close();
    this.client = null;
    this.state = null;
    this.force = [];
    this.forceKey = '';
    this.editor = null;
    this.partner = null;
    this.chat = [];
    this.inBattle = false;
  }

  private connect(hello: ClientMsg, name = this.name || 'Commander'): void {
    this.client?.close();
    this.setStatus('Connecting…');
    const c = new NetClient(name, hello);
    this.client = c;
    c.onMessage = (m) => this.onMessage(m);
    c.onStatus = (st) => {
      if (st === 'reconnecting' && !this.inBattle) this.setStatus('Connection lost. Reconnecting…', true);
    };
  }

  private get me(): number {
    return this.client?.slot ?? -1;
  }

  // ------------------------------------------------------------------ messages
  private onMessage(m: ServerMsg): void {
    switch (m.t) {
      case 'error':
        this.setStatus(m.msg, true);
        if (!this.state) {
          clearSeat();
          this.client = null;
        }
        return;
      case 'room':
        this.state = m.state;
        if (!this.inBattle && m.state.phase === 'lobby') this.renderLobby();
        return;
      case 'chat':
        this.chat.push({ name: m.name, text: m.text });
        if (this.chat.length > 50) this.chat.shift();
        if (!this.inBattle) this.renderChat();
        return;
      case 'start':
        this.startBattle(m.net);
        return;
      case 'resume':
        // reload during a battle: replay it from the relay's log
        if (!this.inBattle) this.startBattle(m.net, { log: m.log, last: m.last });
        return;
    }
  }

  // ------------------------------------------------------------------ lobby
  private renderLobby(): void {
    const st = this.state!;
    const me = st.players.find((p) => p.slot === this.me);
    if (!me) return;
    const isHost = st.host === this.me;
    const set = st.settings;
    ensureMap(set.mapId);
    // a fresh default force whenever our side or the battlefield's default changes
    const key = `${me.side}|${set.mode}`;
    if (key !== this.forceKey) {
      this.forceKey = key;
      this.force = me.force.length ? me.force.map((f) => ({ ...f })) : this.defaultForce(me.side);
      this.sendForce(true);
    }
    const s = this.page && this.page.classList.contains('mp-lobby') ? this.page : el('div', 'page mp-lobby');
    s.innerHTML = '';
    const link = `${location.origin}${location.pathname}?join=${st.code}`;
    s.appendChild(el('div', '', `<h1>${MODE_LABEL[set.mode]} · Game <span class="mp-code">${st.code}</span></h1><div class="lead">Send your friend this link: <a class="mp-link" href="${esc(link)}">${esc(link)}</a> <button class="btn small" id="mp-copy">Copy</button> or have them join with code <b>${st.code}</b>.</div>`));
    (s.querySelector('#mp-copy') as HTMLButtonElement).onclick = () => navigator.clipboard?.writeText(link);

    const grid = el('div', 'qb-grid');
    // left: players, settings, chat
    const left = el('div');
    const pl = el('div', 'section panel', '<h3>Commanders</h3>');
    for (const p of st.players) {
      pl.appendChild(el('div', 'mp-player', `<span class="dot ${p.connected ? 'on' : ''}"></span><b>${esc(p.name)}</b>${p.slot === this.me ? ' (you)' : ''}${p.slot === st.host ? ' <span class="tag">host</span>' : ''}<span style="flex:1"></span><span style="color:#${FACTIONS[p.side].color.toString(16).padStart(6, '0')}">${FACTIONS[p.side].short}</span> · ${forceCost(p.force)} pts · ${p.ready ? '<span style="color:var(--good)">ready ✓</span>' : '<span style="color:var(--dim)">not ready</span>'}`));
    }
    if (st.players.length < 2) pl.appendChild(el('div', '', '<div style="color:var(--dim);margin-top:6px">Waiting for another commander to join…</div>'));
    left.appendChild(pl);
    left.appendChild(this.settingsPanel(isHost));
    const chat = el('div', 'section panel mp-chat', '<h3>Chat</h3><div class="log"></div><input class="mp-input" placeholder="Say something and press Enter" maxlength="200">');
    const input = chat.querySelector('input')!;
    input.onkeydown = (e) => {
      if (e.key === 'Enter' && input.value.trim()) {
        this.client?.send({ t: 'chat', text: input.value.trim() });
        input.value = '';
      }
    };
    left.appendChild(chat);
    grid.appendChild(left);
    // middle: your force (and your partner's in co-op); right: unit details
    const mid = el('div');
    const budget = set.budget;
    if (!this.editor) this.editor = new ForceEditor({ side: me.side, budget, force: this.force, onChange: () => this.sendForce() });
    else this.editor.update({ side: me.side, budget, force: this.force });
    mid.appendChild(this.editor.panel);
    const mate = st.players.find((p) => p.slot !== this.me && p.side === me.side);
    if (mate) {
      if (!this.partner) this.partner = new ForceEditor({ side: me.side, budget, force: mate.force, readOnly: true, title: `${esc(mate.name)}'s force` });
      else this.partner.update({ side: me.side, budget, force: mate.force, title: `${esc(mate.name)}'s force` });
      mid.appendChild(this.partner.panel);
    }
    grid.appendChild(mid);
    grid.appendChild(this.editor.detail);
    s.appendChild(grid);
    // bottom bar: leave, ready, start
    const bar = el('div', '', '');
    bar.style.cssText = 'display:flex;gap:10px;justify-content:flex-end;align-items:center;margin-top:10px';
    const cost = forceCost(this.force);
    const valid = this.force.length > 0 && cost <= budget;
    const hint = el('span', '', !valid ? (this.force.length ? 'Your force is over budget.' : 'Add some units to your force.') : st.players.length < 2 ? 'Waiting for another commander…' : !st.players.every((p) => p.ready) ? 'Waiting for everyone to be ready…' : isHost ? '' : 'Waiting for the host to start the battle…');
    hint.style.color = 'var(--dim)';
    const leave = el('button', 'btn', 'Leave');
    leave.onclick = () => this.open();
    const ready = el('button', `btn${me.ready ? ' active' : ''}`, me.ready ? 'Ready ✓' : 'Ready');
    ready.disabled = !valid;
    ready.onclick = () => this.client?.send({ t: 'ready', ready: !me.ready });
    bar.append(hint, leave, ready);
    if (isHost) {
      const go = el('button', 'btn primary', 'Start battle ▸');
      go.disabled = st.players.length < 2 || !st.players.every((p) => p.ready);
      go.onclick = () => this.launch();
      bar.appendChild(go);
    }
    s.appendChild(bar);
    if (this.page !== s) {
      this.page = s;
      this.app.setScreen(s);
    }
    this.renderChat();
  }

  private settingsPanel(isHost: boolean): HTMLElement {
    const set = this.state!.settings;
    const p = el('div', 'section panel', '<h3>Battle</h3>');
    const def = getMap(set.mapId);
    p.appendChild(el('div', '', `<div style="display:flex;gap:10px;margin-bottom:8px"><img class="map-thumb" style="width:120px" src="${mapThumb(set.mapId)}"><div style="color:var(--dim);font-size:12px;line-height:1.45"><b style="color:var(--text)">${esc(def?.name ?? set.mapId)}</b><br>${esc(def?.description ?? '')}</div></div>`));
    const change = (patch: Partial<RoomSettings>) => this.client?.send({ t: 'settings', settings: { ...set, ...patch } });
    const row = (label: string, items: [string, string][], cur: string, fn: (v: string) => void) => {
      const r = el('div', '', `<div style="color:var(--dim);margin:6px 0 4px">${label}</div>`);
      const ch = el('div', 'choice');
      for (const [v, l] of items) {
        const b = el('button', `btn small${v === cur ? ' active' : ''}`, l);
        b.disabled = !isHost;
        b.onclick = () => fn(v);
        ch.appendChild(b);
      }
      r.appendChild(ch);
      p.appendChild(r);
    };
    row('Mode', [['versus', MODE_LABEL.versus], ['coop', MODE_LABEL.coop]], set.mode, (v) => change({ mode: v as Mode, budget: v === 'versus' ? 1000 : 700 }));
    const maps: [string, string][] = MAP_ORDER.map((id) => [id, MAPS[id].name]);
    if (set.mapId.startsWith('random-')) maps.push([set.mapId, getMap(set.mapId)?.name ?? 'Random']);
    maps.push(['new-random', '🎲 Random']);
    row('Battlefield', maps, set.mapId, (v) => change({ mapId: v === 'new-random' ? `random-${Math.floor(Math.random() * 1e6)}` : v }));
    row(set.mode === 'versus' ? 'Host plays' : 'Your side', [['nato', FACTIONS.nato.short], ['opfor', FACTIONS.opfor.short]], set.side, (v) => change({ side: v as Side }));
    row('Points each', [['500', '500'], ['700', '700'], ['1000', '1000'], ['1300', '1300'], ['1600', '1600']], String(set.budget), (v) => change({ budget: Number(v) }));
    row('Time limit', [['15', '15 min'], ['25', '25 min'], ['40', '40 min']], String(set.minutes), (v) => change({ minutes: Number(v) }));
    if (set.mode === 'coop') row('Enemy quality', [['green', 'Green'], ['regular', 'Regular'], ['veteran', 'Veteran'], ['elite', 'Elite']], set.enemy, (v) => change({ enemy: v as RoomSettings['enemy'] }));
    if (!isHost) p.appendChild(el('div', '', '<div style="color:var(--dim);font-size:12px;margin-top:8px">The host chooses the battle.</div>'));
    return p;
  }

  private renderChat(): void {
    const log = this.page?.querySelector('.mp-chat .log');
    if (!log) return;
    log.innerHTML = this.chat.map((c) => `<div><b>${esc(c.name)}:</b> ${esc(c.text)}</div>`).join('') || '<div style="color:var(--dim)">No messages yet.</div>';
    log.scrollTop = log.scrollHeight;
  }

  /** The battlefield's standard force for our side, trimmed to the budget (split in co-op). */
  private defaultForce(side: Side): ForceEntry[] {
    const set = this.state!.settings;
    let list = defaultForces(set.mapId).forces[side].map((f) => ({ ...f }));
    if (set.mode === 'coop') {
      // partners split the side's standard force: first to join takes every other unit
      const order = this.state!.players.filter((p) => p.side === side).map((p) => p.slot).sort((a, b) => a - b);
      const parity = Math.max(0, order.indexOf(this.me)) % 2;
      list = list.filter((_, i) => i % 2 === parity).map((f) => ({ template: f.template, exp: f.exp }));
    }
    return fitToBudget(list, set.budget);
  }

  private sendForce(now = false): void {
    clearTimeout(this.forceTimer);
    const go = () => this.client?.send({ t: 'force', force: this.force.map((f) => ({ template: f.template, exp: f.exp, mountIn: f.mountIn })) });
    if (now) go();
    else this.forceTimer = window.setTimeout(go, 250);
  }

  // ------------------------------------------------------------------ battle
  /** Host: everything the battle needs, identical for every player. */
  private launch(): void {
    const st = this.state!;
    const set = st.settings;
    ensureMap(set.mapId);
    const { forces: defaults, posture } = defaultForces(set.mapId);
    const seed = Math.floor(Math.random() * 1e6);
    const forces: Record<Side, ForceEntry[]> = { nato: [], opfor: [] };
    for (const p of [...st.players].sort((a, b) => a.slot - b.slot)) {
      const off = forces[p.side].length;
      for (const f of p.force) forces[p.side].push({ template: f.template, exp: f.exp, owner: p.slot, mountIn: f.mountIn !== undefined ? f.mountIn + off : undefined });
    }
    const humans: Side[] = set.mode === 'versus' ? ['nato', 'opfor'] : [set.side];
    if (set.mode === 'coop') {
      const enemy = otherSide(set.side);
      forces[enemy] = defaults[enemy].map((f) => ({ ...f, exp: EXP[set.enemy] }));
    }
    const setup: BattleSetup = { mapId: set.mapId, seed, timeLimit: set.minutes * 60, player: null, humans, posture, forces, lighting: lightingForSeed(seed) };
    const net: NetSetup = {
      setup,
      title: `${getMap(set.mapId)?.name ?? 'Battle'} — ${MODE_LABEL[set.mode]}`,
      mode: set.mode,
      players: st.players.map((p) => ({ slot: p.slot, name: p.name, side: p.side })),
    };
    this.client?.send({ t: 'launch', net });
  }

  private startBattle(net: NetSetup, resume?: { log: ({ p: number } & StepBatch)[]; last: Record<number, number> }): void {
    const client = this.client;
    if (!client) return;
    this.inBattle = true;
    // steps that arrive before the battle screen exists are kept for it, not dropped
    const pending: ServerMsg[] = [];
    client.onMessage = (m) => pending.push(m);
    ensureMap(net.setup.mapId);
    this.app.startBattle(
      net.setup,
      net.title,
      (w, r) => {
        this.client = null; // the battle screen closed the connection
        this.app.debrief(w, r, () => this.open(), 'Back to multiplayer');
      },
      () => {
        this.client = null;
        this.open();
      },
      { client, slot: client.slot, game: net, resume, pending },
    );
  }
}
