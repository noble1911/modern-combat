import { FACTIONS, otherSide, Side, unitTemplate } from '../data/units';
import type { App } from './app';
import { mapThumb } from './app';
import { portraitBg } from '../render/portraits';
import { unitDetailHtml } from '../ui/unitInfo';
import { symbolURL } from './battle';
import {
  activeBGs,
  applyBattle,
  autoResolve,
  BattleGroup,
  battleSetup,
  bgPower,
  bgStrength,
  BGOrder,
  canAdvance,
  CampaignState,
  clearCampaign,
  dayOf,
  endTurn,
  loadCampaign,
  newCampaign,
  PendingBattle,
  saveCampaign,
  sectorBGs,
  supplied,
  turnLabel,
} from './campaign';
import { createBattle } from './scenario';

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, html?: string): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html !== undefined) e.innerHTML = html;
  return e;
};

const POS: [number, number][] = [
  [290, 830],
  [205, 690],
  [335, 555],
  [240, 415],
  [345, 280],
  [265, 130],
];
const RIVERS = [690, 415, 200];
const hex = (n: number) => `#${n.toString(16).padStart(6, '0')}`;

export class CampaignUI {
  st: CampaignState | null = null;

  constructor(private app: App) {}

  hasSave(): boolean {
    return !!loadCampaign();
  }

  continueSaved(): void {
    this.st = loadCampaign();
    if (this.st) this.showMap();
    else this.open();
  }

  // ------------------------------------------------------------------ briefing
  open(): void {
    const s = el('div', 'page');
    s.innerHTML = `<h1>Operation Iron Corridor</h1>
    <div class="lead" style="max-width:960px">
    <p>A fictional near-future conflict. To end the war before winter, NATO launches a bold combined operation: three air assault battalions will seize the bridges along <b>Route Iron</b> — at Veldmark, Hollen and far away at <b>Arnholt</b> — while <b>Task Force Iron</b>, an armoured column, drives up the single highway to relieve them.</p>
    <p>The plan depends on speed. Every bridge must be taken intact, the road kept open, and the paratroopers at Arnholt must hold until the column arrives. Intelligence dismisses reports of an armoured battalion refitting east of Hollen.</p>
    <p>Six sectors. Seven days. You fight each engagement yourself or delegate it to your subordinates (auto-resolve through the same simulation). Casualties, damage and experience carry over between battles.</p></div>`;
    const grid = el('div', 'grid2');
    for (const side of ['nato', 'opfor'] as Side[]) {
      const f = FACTIONS[side];
      const box = el('div', 'section panel');
      box.innerHTML = `<h3 style="color:${hex(f.color)}">${f.name}</h3><div style="color:var(--dim);line-height:1.5;min-height:60px">${
        side === 'nato'
          ? 'Command the air assault battalions and Task Force Iron. Open the corridor and link up with the paratroopers at Arnholt before they are overwhelmed.'
          : 'Command the Northern Federation defence of Route Iron. Blow the bridges, hold the towns, and crush the isolated paratroopers at Arnholt with your armoured reserves.'
      }</div>`;
      const b = el('button', 'btn primary', `Command ${f.short}`);
      b.onclick = () => {
        this.st = newCampaign(side);
        saveCampaign(this.st);
        this.showMap();
      };
      box.appendChild(b);
      grid.appendChild(box);
    }
    s.appendChild(grid);
    const back = el('button', 'btn', 'Back');
    back.onclick = () => this.app.mainMenu();
    s.appendChild(back);
    this.app.setScreen(s);
  }

  // ------------------------------------------------------------------ operational map
  showMap(): void {
    const st = this.st!;
    saveCampaign(st);
    if (st.over) return this.showOver();
    const s = el('div', 'screen');
    s.style.cssText = 'display:grid;grid-template-columns:minmax(420px,560px) 1fr;background:linear-gradient(#141a17,#0b0e0c)';
    const mapWrap = el('div', '');
    mapWrap.style.cssText = 'position:relative;height:100%;overflow:hidden;border-right:1px solid var(--line)';
    mapWrap.appendChild(this.svgMap());
    const side = el('div', '');
    side.style.cssText = 'overflow-y:auto;padding:18px 22px';
    s.append(mapWrap, side);
    // header
    const turnsLeft = st.maxTurns - st.turn;
    side.appendChild(el('div', '', `<h1 style="margin:0;color:var(--accent);letter-spacing:2px">${turnLabel(st.turn)}</h1><div style="color:var(--dim);margin:4px 0 14px">Operation Iron Corridor · you command <b style="color:${hex(FACTIONS[st.player].color)}">${FACTIONS[st.player].short}</b> · ${turnsLeft} turn${turnsLeft === 1 ? '' : 's'} remaining (ends after Day ${dayOf(st.maxTurns - 1)})</div>`));
    // battles
    const pending = st.battles.filter((b) => !b.resolved);
    const bsec = el('div', 'section panel', `<h3>Engagements this turn</h3>`);
    if (!st.battles.length) bsec.appendChild(el('div', '', `<span style="color:var(--dim)">No contact. Issue orders and end the turn.</span>`));
    for (const b of st.battles) bsec.appendChild(this.battleRow(b));
    side.appendChild(bsec);
    // own battlegroups
    const own = el('div', 'section panel', `<h3>Your battlegroups</h3>`);
    for (const bg of activeBGs(st, st.player)) own.appendChild(this.bgRow(bg));
    const upcoming = st.bgs.filter((b) => b.side === st.player && b.arrives > st.turn && !b.destroyed);
    for (const bg of upcoming) own.appendChild(el('div', '', `<div style="color:var(--dim);font-size:12px;margin-top:6px">▸ ${bg.name} arrives ${turnLabel(bg.arrives)}.</div>`));
    side.appendChild(own);
    // intel
    const intel = el('div', 'section panel', `<h3>Enemy forces (intelligence)</h3>`);
    for (const bg of activeBGs(st, otherSide(st.player))) {
      const where = bg.sector >= 0 ? st.sectors[bg.sector].name : 'off-map (regrouping)';
      const est = bgStrength(bg) > 0.75 ? 'strong' : bgStrength(bg) > 0.45 ? 'weakened' : 'badly depleted';
      intel.appendChild(el('div', '', `<div style="display:flex;gap:8px;align-items:center;margin:3px 0"><img src="${symbolURL(bg.side, bg.kind === 'armor' ? 'armor' : bg.kind === 'mech' ? 'ifv' : 'inf', false)}" style="width:26px"> <b>${bg.name}</b> <span style="color:var(--dim)">— ${where}, ${est}</span></div>`));
    }
    side.appendChild(intel);
    // log
    const log = el('div', 'section panel', `<h3>Operations log</h3>`);
    const list = el('div', '');
    list.style.cssText = 'max-height:220px;overflow-y:auto;font-size:12px;line-height:1.55';
    for (const l of [...st.log].reverse().slice(0, 40)) {
      const c = l.level === 'good' ? 'var(--good)' : l.level === 'bad' ? '#ff9a88' : 'var(--text)';
      list.appendChild(el('div', '', `<span style="color:var(--dim);font-family:var(--mono)">D${dayOf(l.turn)}${l.turn % 2 ? 'PM' : 'AM'}</span> <span style="color:${c}">${l.text}</span>`));
    }
    log.appendChild(list);
    side.appendChild(log);
    // footer buttons
    const bar = el('div', '');
    bar.style.cssText = 'display:flex;gap:10px;justify-content:flex-end;margin-bottom:30px';
    const menu = el('button', 'btn', 'Main Menu');
    menu.onclick = () => this.app.mainMenu();
    const abandon = el('button', 'btn', 'Abandon Operation');
    abandon.onclick = () => {
      clearCampaign();
      this.st = null;
      this.app.mainMenu();
    };
    const end = el('button', 'btn primary', pending.length ? `Resolve ${pending.length} engagement${pending.length > 1 ? 's' : ''} first` : 'End Turn ▸');
    end.disabled = pending.length > 0;
    end.onclick = () => {
      endTurn(st);
      this.showMap();
    };
    bar.append(menu, abandon, end);
    side.appendChild(bar);
    this.app.setScreen(s);
  }

  private battleRow(b: PendingBattle): HTMLElement {
    const st = this.st!;
    const sec = st.sectors[b.sector];
    const row = el('div', '');
    row.style.cssText = 'display:flex;gap:12px;align-items:center;padding:8px 0;border-bottom:1px solid var(--line)';
    const img = el('img');
    img.src = mapThumb(sec.mapId);
    img.style.cssText = 'width:72px;height:72px;border-radius:4px;border:1px solid var(--line)';
    const mine = sectorBGs(st, b.sector, st.player);
    const theirs = sectorBGs(st, b.sector, otherSide(st.player));
    const role = b.attacker === st.player ? 'Attack' : 'Defence';
    const info = el('div', '', `<div style="font-weight:600">${sec.name} <span style="color:var(--dim);font-weight:400">— ${role}</span></div>
      <div style="color:var(--dim);font-size:12px">${mine.map((g) => g.name).join(', ')} vs ${theirs.map((g) => g.name).join(', ')}</div>
      ${b.resolved ? `<div style="font-size:12px;color:${b.result?.winner === st.player ? 'var(--good)' : '#ff9a88'}">${b.result?.text}</div>` : ''}`);
    info.style.flex = '1';
    row.append(img, info);
    if (!b.resolved) {
      const cmd = el('button', 'btn primary', 'Command');
      cmd.onclick = () => this.command(b);
      const auto = el('button', 'btn', 'Auto-resolve');
      auto.onclick = () => this.auto(b);
      row.append(cmd, auto);
    }
    return row;
  }

  private bgRow(bg: BattleGroup): HTMLElement {
    const st = this.st!;
    const str = bgStrength(bg);
    const row = el('div', '');
    row.style.cssText = 'padding:7px 0;border-bottom:1px solid var(--line)';
    const where = bg.sector >= 0 ? st.sectors[bg.sector].name : 'Regrouping off-map';
    const sym = bg.kind === 'armor' ? 'armor' : bg.kind === 'mech' ? 'ifv' : 'inf';
    const contact = bg.sector >= 0 && sectorBGs(st, bg.sector, otherSide(bg.side)).length > 0;
    const sup = supplied(st, bg);
    const head = el('div', '', `<div style="display:flex;gap:8px;align-items:center"><img src="${symbolURL(bg.side, sym)}" style="width:30px"><div style="flex:1"><b>${bg.name}</b> <span style="color:var(--dim)">· ${where}${contact ? ' · <span style="color:var(--warn)">IN CONTACT</span>' : ''}${sup ? '' : ' · <span style="color:var(--bad)">CUT OFF</span>'}</span>
      <div class="mbar" style="width:160px;height:6px;margin-top:3px"><div style="width:${Math.round(str * 100)}%;background:${str > 0.66 ? 'var(--good)' : str > 0.33 ? 'var(--warn)' : 'var(--bad)'}"></div></div></div></div>`);
    row.appendChild(head);
    const orders = el('div', 'choice');
    orders.style.marginTop = '5px';
    const adv = canAdvance(st, bg);
    const opts: [BGOrder, string, boolean, string][] = [
      ['advance', 'Advance', adv.ok && !contact, adv.reason ?? 'Move up / attack the next sector along Route Iron'],
      ['hold', 'Hold', true, 'Stay and defend the current sector'],
      ['rest', 'Rest & Refit', !contact, 'Recover wounded and receive replacements (needs a supply line)'],
      ['withdraw', 'Withdraw', !contact && bg.sector >= 0, 'Fall back one sector toward the rear'],
    ];
    for (const [o, label, ok, title] of opts) {
      const b = el('button', `btn small${bg.order === o ? ' active' : ''}`, label);
      b.disabled = !ok;
      b.title = title;
      b.onclick = () => {
        bg.order = o;
        saveCampaign(st);
        this.showMap();
      };
      orders.appendChild(b);
    }
    const details = el('button', 'btn small', 'Roster');
    details.onclick = () => this.roster(bg);
    orders.appendChild(details);
    row.appendChild(orders);
    row.appendChild(el('div', '', `<div style="color:var(--dim);font-size:11px;margin-top:3px">${bg.description}</div>`));
    return row;
  }

  private roster(bg: BattleGroup): void {
    const back = el('div', 'modal-back');
    const m = el('div', 'modal panel bg-roster');
    let sel = 0;
    const draw = () => {
      let list = '';
      bg.units.forEach((u, i) => {
        const t = unitTemplate(u.template);
        const alive = u.soldiers.filter((s) => s !== 'dead').length;
        const wounded = u.soldiers.filter((s) => s === 'wounded').length;
        const status = u.lost ? '<span style="color:var(--bad)">Lost</span>' : t.vehicle ? 'Operational' : `${alive}/${u.soldiers.length} men${wounded ? ` (${wounded} wounded)` : ''}`;
        const stars = '★'.repeat(Math.max(1, Math.round((u.exp - 0.3) * 6)));
        list += `<div class="fu${i === sel ? ' sel' : ''}${u.lost ? ' lost' : ''}" data-i="${i}"><div class="pic" style="${portraitBg(t)}"><img class="sym" src="${symbolURL(bg.side, t.symbol)}" alt=""></div><div style="min-width:0"><div class="n">${u.name} <span style="color:var(--dim);font-weight:400">${t.name}</span></div><div class="s">${status} · <span style="color:var(--amber)">${stars}</span> · ${u.kills} kills</div></div></div>`;
      });
      const t = unitTemplate(bg.units[sel].template);
      m.innerHTML = `<h2>${bg.name}</h2><div style="color:var(--dim);margin-bottom:8px">Combat power ${Math.round(bgPower(bg))} · strength ${Math.round(bgStrength(bg) * 100)}%</div>
        <div class="bgr-grid"><div class="force-list">${list}</div><div class="ud-inline">${unitDetailHtml(t, symbolURL(bg.side, t.symbol))}</div></div>`;
      m.querySelectorAll<HTMLDivElement>('.fu').forEach((r) => {
        r.onclick = () => {
          sel = Number(r.dataset.i);
          draw();
        };
      });
      const row = el('div', 'row');
      const ok = el('button', 'btn primary', 'Close');
      ok.onclick = () => back.remove();
      row.appendChild(ok);
      m.appendChild(row);
    };
    draw();
    back.appendChild(m);
    document.querySelector('.screen')?.appendChild(back);
  }

  private svgMap(): SVGSVGElement {
    const st = this.st!;
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 560 900');
    svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
    svg.style.cssText = 'width:100%;height:100%;display:block';
    let html = `<defs>
      <pattern id="grid" width="40" height="40" patternUnits="userSpaceOnUse"><path d="M40 0H0V40" fill="none" stroke="rgba(160,180,150,0.07)"/></pattern>
      ${st.sectors.map((_, i) => `<clipPath id="c${i}"><circle cx="${POS[i][0]}" cy="${POS[i][1]}" r="46"/></clipPath>`).join('')}
    </defs>
    <rect width="560" height="900" fill="#1a211c"/><rect width="560" height="900" fill="url(#grid)"/>`;
    // rivers
    for (const y of RIVERS) html += `<path d="M0 ${y + 10} C 140 ${y - 20}, 280 ${y + 30}, 560 ${y - 5}" stroke="#2f5b70" stroke-width="10" fill="none" opacity="0.8"/>`;
    // road
    const pts = [[290, 900], ...POS];
    html += `<path d="M${pts.map((p) => p.join(' ')).join(' L')}" stroke="#555" stroke-width="7" fill="none" stroke-linejoin="round"/>`;
    html += `<path d="M${pts.map((p) => p.join(' ')).join(' L')}" stroke="#8a8a80" stroke-width="1.5" stroke-dasharray="6 6" fill="none"/>`;
    html += `<text x="360" y="893" fill="#8e9a8c" font-size="11">▲ start line</text>`;
    html += `<text x="20" y="30" fill="#c8d96a" font-size="16" font-weight="700" letter-spacing="3">ROUTE IRON</text><text x="20" y="48" fill="#8e9a8c" font-size="11">N ↑</text>`;
    st.sectors.forEach((sec, i) => {
      const [x, y] = POS[i];
      const color = hex(FACTIONS[sec.owner].color);
      html += `<image href="${mapThumb(sec.mapId)}" x="${x - 46}" y="${y - 46}" width="92" height="92" clip-path="url(#c${i})" preserveAspectRatio="xMidYMid slice"/>`;
      html += `<circle cx="${x}" cy="${y}" r="47" fill="none" stroke="${color}" stroke-width="5"/>`;
      html += `<text x="${x}" y="${y + 66}" fill="#e9eedf" font-size="13" font-weight="600" text-anchor="middle">${sec.name}</text>`;
      if (sec.bridge) html += `<text x="${x + 38}" y="${y - 36}" font-size="16" text-anchor="middle">${sec.bridgeBlown ? '⛔' : '🌉'}</text>`;
      if (st.battles.some((b) => b.sector === i && !b.resolved)) html += `<text x="${x}" y="${y + 10}" font-size="34" text-anchor="middle" style="filter:drop-shadow(0 0 4px #000)">⚔️</text>`;
    });
    svg.innerHTML = html;
    // battlegroup counters
    for (const side of ['nato', 'opfor'] as Side[]) {
      const counts = new Map<number, number>();
      for (const bg of activeBGs(st, side)) {
        const sec = bg.sector;
        const k = counts.get(sec) ?? 0;
        counts.set(sec, k + 1);
        const [x0, y0] = sec >= 0 ? POS[sec] : side === 'nato' ? [290, 900] : [520, 60];
        const x = side === 'nato' ? x0 - 205 : x0 + 58;
        const y = y0 - 34 + k * 34;
        const g = document.createElementNS(NS, 'g');
        g.style.cursor = 'pointer';
        const str = bgStrength(bg);
        const sym = bg.kind === 'armor' ? 'armor' : bg.kind === 'mech' ? 'ifv' : 'inf';
        g.innerHTML = `<rect x="${x}" y="${y}" width="148" height="30" rx="3" fill="rgba(16,21,25,0.9)" stroke="${hex(FACTIONS[side].color)}"/>
          <image href="${symbolURL(side, sym, side === st.player)}" x="${x + 3}" y="${y + 3}" width="30" height="24"/>
          <text x="${x + 37}" y="${y + 13}" fill="#e9eedf" font-size="10.5" font-weight="600">${bg.name.length > 21 ? bg.name.slice(0, 20) + '…' : bg.name}</text>
          <rect x="${x + 37}" y="${y + 19}" width="104" height="5" fill="rgba(255,255,255,0.12)"/>
          <rect x="${x + 37}" y="${y + 19}" width="${104 * str}" height="5" fill="${str > 0.66 ? '#7dd67d' : str > 0.33 ? '#ffd23a' : '#ff5b4a'}"/>`;
        g.addEventListener('click', () => this.roster(bg));
        svg.appendChild(g);
      }
    }
    return svg;
  }

  // ------------------------------------------------------------------ battles
  private command(b: PendingBattle): void {
    const st = this.st!;
    const { setup } = battleSetup(st, b, true);
    const sec = st.sectors[b.sector];
    this.app.startBattle(
      setup,
      `${turnLabel(st.turn)} · ${sec.name}`,
      (w, r) => {
        applyBattle(st, b, w, r);
        saveCampaign(st);
        this.app.debrief(w, r, () => this.showMap(), 'Return to Operations Map');
      },
      () => this.showMap(),
    );
  }

  private async auto(b: PendingBattle): Promise<void> {
    const st = this.st!;
    const back = el('div', 'modal-back');
    const m = el('div', 'modal panel', `<h2>Engagement in progress</h2><div style="color:var(--dim)">${st.sectors[b.sector].name}: your subordinates are fighting the battle…</div><div class="mbar" style="width:100%;height:8px;margin-top:14px"><div style="width:0%;background:var(--accent)"></div></div>`);
    back.appendChild(m);
    document.querySelector('.screen')?.appendChild(back);
    const bar = m.querySelector('.mbar > div') as HTMLDivElement;
    await autoResolve(st, b, (setup) => createBattle(setup), (f) => (bar.style.width = `${Math.round(f * 100)}%`));
    saveCampaign(st);
    this.showMap();
  }

  private showOver(): void {
    const st = this.st!;
    const o = st.over!;
    const won = o.winner === st.player;
    const s = el('div', 'page');
    s.innerHTML = `<h1>${o.title}</h1><div class="lead">${o.text}</div>
      <div class="section panel"><h3>Outcome for ${FACTIONS[st.player].short}</h3><div style="font-size:22px;color:${won ? 'var(--good)' : o.winner === null ? 'var(--warn)' : 'var(--bad)'}">${won ? 'Victory' : o.winner === null ? 'Stalemate' : 'Defeat'}</div></div>`;
    const sec = el('div', 'section panel', '<h3>Final situation</h3>');
    for (const x of st.sectors) sec.appendChild(el('div', '', `<span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${hex(FACTIONS[x.owner].color)}"></span> ${x.name}${x.bridgeBlown ? ' (bridge destroyed)' : ''}`));
    const bgs = el('div', 'section panel', '<h3>Battlegroups</h3>');
    for (const bg of st.bgs) bgs.appendChild(el('div', '', `${bg.name} — ${bg.destroyed ? '<span style="color:var(--bad)">destroyed</span>' : `${Math.round(bgStrength(bg) * 100)}% strength`} · ${bg.units.reduce((n, u) => n + u.kills, 0)} kills`));
    s.append(sec, bgs);
    const b = el('button', 'btn primary', 'Main Menu');
    b.onclick = () => {
      clearCampaign();
      this.app.mainMenu();
    };
    s.appendChild(b);
    this.app.setScreen(s);
  }
}

