import { FACTIONS, Side, UNITS, unitTemplate } from '../data/units';
import { symbolURL } from '../game/battle';
import { forceCost, type ForceEntry } from '../game/scenario';
import { portraitBg } from '../render/portraits';
import { unitDetailHtml, unitSummary } from './unitInfo';

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, html?: string): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html !== undefined) e.innerHTML = html;
  return e;
};

export interface ForceEditorOpts {
  side: Side;
  budget: number;
  /** Edited in place. */
  force: ForceEntry[];
  title?: string;
  /** Called after any change to `force`. */
  onChange?: () => void;
  /** Show the force but don't allow changes (e.g. a teammate's force in the lobby). */
  readOnly?: boolean;
}

/**
 * Requisition a force: the units you have (portrait, make-up, cost), a catalogue of what you can
 * add within the budget, and a details panel for whichever unit was clicked last. Used by Quick
 * Battle and the multiplayer lobby. `panel` and `detail` are separate elements so pages can lay
 * them out as columns.
 */
export class ForceEditor {
  readonly panel = el('div', 'section panel');
  readonly detail = el('div', 'section panel unit-detail');
  private inspect: string | null = null;
  private inspectRow = -1;

  constructor(private o: ForceEditorOpts) {
    this.render();
  }

  update(o: Partial<ForceEditorOpts>): void {
    if (o.side && o.side !== this.o.side) {
      this.inspect = null;
      this.inspectRow = -1;
    }
    Object.assign(this.o, o);
    this.render();
  }

  get cost(): number {
    return forceCost(this.o.force);
  }

  private changed(): void {
    this.render();
    this.o.onChange?.();
  }

  render(): void {
    const { side, budget, force, readOnly } = this.o;
    const cost = forceCost(force);
    const available = Object.values(UNITS).filter((t) => t.side === side && !t.id.endsWith('_crew'));
    if (!this.inspect || unitTemplate(this.inspect).side !== side) {
      this.inspect = force[0]?.template ?? available[0]?.id ?? null;
      this.inspectRow = force.length ? 0 : -1;
    }
    const p = this.panel;
    p.innerHTML = `<h3>${this.o.title ?? `Your force — ${FACTIONS[side].short}`}</h3>`;
    const pct = Math.min(100, (cost / Math.max(1, budget)) * 100);
    p.appendChild(el('div', 'req', `<div class="req-bar"><div style="width:${pct}%;background:${cost > budget ? 'var(--bad)' : 'var(--accent)'}"></div></div><span>Requisition <b>${cost}</b> / ${budget} pts</span>`));
    const list = el('div', 'force-list');
    force.forEach((f, i) => {
      const t = unitTemplate(f.template);
      const carrier = f.mountIn !== undefined && force[f.mountIn] ? ` <span style="color:var(--dim);font-weight:400">(in ${unitTemplate(force[f.mountIn].template).short})</span>` : '';
      const r = el('div', `fu${this.inspectRow === i ? ' sel' : ''}`, `<div class="pic" style="${portraitBg(t)}"><img class="sym" src="${symbolURL(side, t.symbol)}" alt=""></div><div style="min-width:0"><div class="n">${t.name}${carrier}</div><div class="s">${unitSummary(t)}</div></div><span class="c">${t.cost}</span>`);
      r.onclick = () => {
        this.inspect = t.id;
        this.inspectRow = i;
        this.render();
      };
      if (!readOnly) {
        const rm = el('button', 'btn small', '✕');
        rm.title = 'Remove';
        rm.onclick = (e) => {
          e.stopPropagation();
          force.splice(i, 1);
          if (this.inspectRow === i) this.inspectRow = -1;
          else if (this.inspectRow > i) this.inspectRow--;
          for (const x of force) {
            if (x.mountIn === undefined) continue;
            if (x.mountIn === i) x.mountIn = undefined;
            else if (x.mountIn > i) x.mountIn--;
          }
          this.changed();
        };
        r.appendChild(rm);
      }
      list.appendChild(r);
    });
    if (!force.length) list.appendChild(el('div', '', `<div style="color:var(--dim);padding:6px">${readOnly ? 'No units yet.' : 'No units yet — add some from the list below.'}</div>`));
    p.appendChild(list);
    if (!readOnly) {
      const h = el('h3', '', 'Add units');
      h.style.marginTop = '14px';
      p.appendChild(h);
      const cat = el('div', 'catalogue');
      for (const t of available) {
        const affordable = cost + t.cost <= budget;
        const card = el('div', `cat-card${this.inspectRow < 0 && this.inspect === t.id ? ' sel' : ''}${affordable ? '' : ' off'}`, `<div class="pic" style="${portraitBg(t)}"><img class="sym" src="${symbolURL(side, t.symbol)}" alt=""></div><span class="cost">${t.cost}</span><div class="n">${t.name}</div><div class="s">${unitSummary(t)}</div>`);
        card.title = t.description;
        card.onclick = () => {
          this.inspect = t.id;
          this.inspectRow = -1;
          this.render();
        };
        const add = el('button', 'btn small add', affordable ? '+ Add' : 'Over budget');
        add.disabled = !affordable;
        add.onclick = (e) => {
          e.stopPropagation();
          force.push({ template: t.id });
          this.inspect = t.id;
          this.inspectRow = force.length - 1;
          this.changed();
        };
        card.appendChild(add);
        cat.appendChild(card);
      }
      p.appendChild(cat);
    }
    this.detail.innerHTML = '';
    if (this.inspect) {
      const t = unitTemplate(this.inspect);
      this.detail.innerHTML = unitDetailHtml(t, symbolURL(side, t.symbol));
    }
  }
}

/** The first units of a list that fit in a budget (carrier references to dropped units removed). */
export function fitToBudget(list: ForceEntry[], budget: number): ForceEntry[] {
  const out: ForceEntry[] = [];
  const map = new Map<number, number>();
  let cost = 0;
  list.forEach((f, i) => {
    const c = unitTemplate(f.template).cost;
    if (cost + c > budget) return;
    cost += c;
    map.set(i, out.length);
    out.push({ ...f });
  });
  for (const f of out) if (f.mountIn !== undefined) f.mountIn = map.get(f.mountIn);
  return out;
}
