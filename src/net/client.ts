import type { ClientMsg, ServerMsg } from './protocol';

const STORE = 'modern-combat.mp';

/** The seat to reclaim after a reload or a dropped connection. */
export interface MpSeat {
  room: string;
  token: string;
  name: string;
}

export function savedSeat(): MpSeat | null {
  try {
    return JSON.parse(sessionStorage.getItem(STORE) ?? 'null');
  } catch {
    return null;
  }
}

export function clearSeat(): void {
  try {
    sessionStorage.removeItem(STORE);
  } catch {
    /* ignore */
  }
}

/** WebSocket URL next to the page (the game is served under a path, e.g. …/modern-combat/ws). */
export function socketURL(): string {
  const u = new URL('ws', location.href);
  u.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  u.search = '';
  u.hash = '';
  return u.href;
}

export type NetStatus = 'connecting' | 'open' | 'reconnecting' | 'closed';

/**
 * One connection to the relay. Reconnects on its own (a few seconds apart) and reclaims its
 * seat with the room token, so a flaky network or a sleeping laptop doesn't end the battle.
 */
export class NetClient {
  room = '';
  token = '';
  slot = -1;
  status: NetStatus = 'connecting';
  onMessage: (m: ServerMsg) => void = () => {};
  onStatus: (s: NetStatus) => void = () => {};
  private ws: WebSocket | null = null;
  private hello: ClientMsg;
  private stopped = false;
  private attempts = 0;
  private pending: ClientMsg[] = [];

  constructor(
    readonly name: string,
    hello: ClientMsg,
  ) {
    this.hello = hello;
    this.open();
  }

  private open(): void {
    const ws = new WebSocket(socketURL());
    this.ws = ws;
    ws.onopen = () => {
      this.attempts = 0;
      ws.send(JSON.stringify(this.hello));
      for (const m of this.pending.splice(0)) ws.send(JSON.stringify(m));
      this.setStatus('open');
    };
    ws.onmessage = (ev) => {
      let m: ServerMsg;
      try {
        m = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      if (m.t === 'welcome') {
        this.room = m.room;
        this.token = m.token;
        this.slot = m.slot;
        // from now on, reconnecting means reclaiming this seat
        this.hello = { t: 'join', room: m.room, name: this.name, token: m.token };
        try {
          sessionStorage.setItem(STORE, JSON.stringify({ room: m.room, token: m.token, name: this.name } satisfies MpSeat));
        } catch {
          /* ignore */
        }
      }
      if (m.t === 'error' && !this.room) this.stopped = true;
      this.onMessage(m);
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      if (this.stopped) return this.setStatus('closed');
      this.setStatus('reconnecting');
      const wait = Math.min(8000, 800 * 2 ** this.attempts++);
      setTimeout(() => !this.stopped && this.open(), wait);
    };
  }

  private setStatus(s: NetStatus): void {
    this.status = s;
    this.onStatus(s);
  }

  send(m: ClientMsg): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(m));
    else if (m.t !== 'step') this.pending.push(m); // steps are re-sent from the log after reconnecting
  }

  /** Leave the room for good. */
  close(): void {
    this.send({ t: 'leave' });
    this.stopped = true;
    clearSeat();
    setTimeout(() => this.ws?.close(), 50);
  }
}
