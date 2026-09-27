// Modern Combat game server: serves the built game (dist/) and relays multiplayer battles.
//
//   PORT=3000 node server/index.mjs          (npm run server)
//
// The relay knows nothing about the game rules. It keeps rooms (a 4-letter code, two players),
// passes lobby state around, and forwards each player's per-step command batches to the others
// (deterministic lockstep: every browser runs the same battle). It also keeps each battle's batches
// so a player who reloads or reconnects can replay the battle and carry on, and it announces a
// player as gone (everyone then hands their side to a teammate or the AI) if they don't come back
// within the grace period.
//
// Served under a path by the games gateway (games.noblehaus.uk/modern-combat/, prefix stripped),
// so everything here is relative: the page at /, the socket at /ws.

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

const PORT = Number(process.env.PORT ?? 3000);
const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', process.env.DIST ?? 'dist');
/** How long a disconnected player's seat is kept during a battle before they're dropped. */
const GRACE_MS = Number(process.env.GRACE_MS ?? 45_000);
/** Rooms with nobody connected are forgotten after this long. */
const ROOM_TTL_MS = 15 * 60_000;
const MAX_PLAYERS = 2;

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.glb': 'model/gltf-binary', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.png': 'image/png', '.jpg': 'image/jpeg',
};

// ------------------------------------------------------------------ static files
const http = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://x');
  if (url.pathname === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    return res.end(`ok ${rooms.size} rooms`);
  }
  let p = decodeURIComponent(url.pathname);
  if (p.endsWith('/')) p += 'index.html';
  const file = join(ROOT, normalize(p));
  if (!file.startsWith(ROOT)) {
    res.writeHead(403);
    return res.end();
  }
  try {
    if (!(await stat(file)).isFile()) throw new Error('not a file');
    const ext = extname(file);
    res.writeHead(200, {
      'Content-Type': TYPES[ext] ?? 'application/octet-stream',
      // hashed bundles and models can be cached; the page itself must not be
      'Cache-Control': ext === '.html' ? 'no-cache' : p.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'public, max-age=3600',
    });
    res.end(await readFile(file));
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found');
  }
});

// ------------------------------------------------------------------ rooms
/**
 * @typedef {{ slot: number, name: string, side: string, ready: boolean, force: unknown[], token: string,
 *   ws: import('ws').WebSocket | null, last: number, goneAt: number, dropped: boolean }} Player
 * @typedef {{ code: string, host: number, phase: 'lobby'|'battle'|'ended', settings: any, players: Player[],
 *   net: any, log: any[], timer: NodeJS.Timeout | null, emptySince: number }} Room
 */
/** @type {Map<string, Room>} */
const rooms = new Map();

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function newCode() {
  for (;;) {
    let c = '';
    for (const b of randomBytes(4)) c += CODE_CHARS[b % CODE_CHARS.length];
    if (!rooms.has(c)) return c;
  }
}
const token = () => randomBytes(12).toString('hex');
const other = (side) => (side === 'nato' ? 'opfor' : 'nato');
const cleanName = (n) => String(n ?? '').replace(/[<>&"']/g, '').trim().slice(0, 20) || 'Commander';

function sideFor(room, slot) {
  const s = room.settings;
  if (s.mode === 'coop') return s.side;
  return slot === room.host ? s.side : other(s.side);
}

function publicState(room) {
  return {
    code: room.code,
    host: room.host,
    phase: room.phase,
    settings: room.settings,
    players: room.players.map((p) => ({ slot: p.slot, name: p.name, side: p.side, ready: p.ready, connected: !!p.ws, force: p.force })),
  };
}

function send(ws, msg) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
}
function broadcast(room, msg, except = -1) {
  const data = JSON.stringify(msg);
  for (const p of room.players) if (p.slot !== except && p.ws && p.ws.readyState === 1) p.ws.send(data);
}
function syncRoom(room) {
  broadcast(room, { t: 'room', state: publicState(room) });
}

function attach(room, player, ws) {
  if (player.ws && player.ws !== ws) player.ws.close(4000, 'replaced');
  player.ws = ws;
  player.goneAt = 0;
  ws.room = room;
  ws.player = player;
  room.emptySince = 0;
  send(ws, { t: 'welcome', room: room.code, slot: player.slot, token: player.token });
  if (room.phase === 'battle' || room.phase === 'ended') {
    const last = {};
    for (const p of room.players) last[p.slot] = p.last;
    send(ws, { t: 'resume', net: room.net, log: room.log, last });
    for (const p of room.players) if (p.dropped) send(ws, { t: 'drop', slot: p.slot, from: p.last + 1 });
  }
  syncRoom(room);
  broadcast(room, { t: 'presence', slot: player.slot, connected: true }, player.slot);
}

function detach(ws) {
  const room = ws.room;
  const player = ws.player;
  if (!room || !player || player.ws !== ws) return;
  player.ws = null;
  player.goneAt = Date.now();
  if (room.phase === 'lobby') {
    // leaving the lobby frees the seat (the host's leaving hands hosting on)
    room.players = room.players.filter((p) => p !== player);
    if (room.host === player.slot && room.players.length) room.host = room.players[0].slot;
    for (const p of room.players) p.ready = false;
  } else {
    broadcast(room, { t: 'presence', slot: player.slot, connected: false });
  }
  if (!room.players.some((p) => p.ws)) room.emptySince = Date.now();
  syncRoom(room);
}

function leave(ws) {
  const room = ws.room;
  const player = ws.player;
  if (!room || !player) return;
  if (room.phase === 'battle' && !player.dropped) dropPlayer(room, player);
  detach(ws);
  ws.room = ws.player = null;
}

function dropPlayer(room, player) {
  player.dropped = true;
  broadcast(room, { t: 'drop', slot: player.slot, from: player.last + 1 });
}

// seats of players who vanished mid-battle are released after the grace period; empty rooms expire
setInterval(() => {
  const now = Date.now();
  for (const room of rooms.values()) {
    if (room.phase === 'battle') {
      for (const p of room.players) if (!p.ws && !p.dropped && p.goneAt && now - p.goneAt > GRACE_MS) dropPlayer(room, p);
    }
    if (room.emptySince && now - room.emptySince > ROOM_TTL_MS) rooms.delete(room.code);
  }
}, 2000).unref();

// ------------------------------------------------------------------ messages
function handle(ws, msg) {
  const room = ws.room;
  const me = ws.player;
  switch (msg.t) {
    case 'create': {
      const code = newCode();
      /** @type {Room} */
      const r = { code, host: 0, phase: 'lobby', settings: msg.settings, players: [], net: null, log: [], timer: null, emptySince: 0 };
      rooms.set(code, r);
      const p = { slot: 0, name: cleanName(msg.name), side: '', ready: false, force: [], token: token(), ws: null, last: -1, goneAt: 0, dropped: false };
      p.side = sideFor(r, 0);
      r.players.push(p);
      attach(r, p, ws);
      return;
    }
    case 'join': {
      const r = rooms.get(String(msg.room ?? '').toUpperCase().trim());
      if (!r) return send(ws, { t: 'error', msg: 'No game with that code. Check it, or ask for a new link.' });
      const back = msg.token && r.players.find((p) => p.token === msg.token);
      if (back) {
        if (back.dropped) return send(ws, { t: 'error', msg: 'You left this battle; it carried on without you.' });
        return attach(r, back, ws);
      }
      if (r.phase !== 'lobby') return send(ws, { t: 'error', msg: 'That battle has already started.' });
      if (r.players.length >= MAX_PLAYERS) return send(ws, { t: 'error', msg: 'That game is full.' });
      const used = new Set(r.players.map((p) => p.slot));
      let slot = 0;
      while (used.has(slot)) slot++;
      const p = { slot, name: cleanName(msg.name), side: '', ready: false, force: [], token: token(), ws: null, last: -1, goneAt: 0, dropped: false };
      p.side = sideFor(r, slot);
      r.players.push(p);
      for (const q of r.players) q.ready = false;
      attach(r, p, ws);
      return;
    }
    case 'chat': {
      if (!room || !me) return;
      const text = String(msg.text ?? '').slice(0, 200).trim();
      if (text) broadcast(room, { t: 'chat', slot: me.slot, name: me.name, text });
      return;
    }
    case 'leave':
      return leave(ws);
  }
  if (!room || !me) return;
  if (room.phase === 'lobby') {
    switch (msg.t) {
      case 'settings':
        if (me.slot !== room.host) return;
        room.settings = msg.settings;
        for (const p of room.players) {
          const side = sideFor(room, p.slot);
          if (side !== p.side) p.force = [];
          p.side = side;
          p.ready = false;
        }
        return syncRoom(room);
      case 'force':
        me.force = Array.isArray(msg.force) ? msg.force.slice(0, 40) : [];
        me.ready = false;
        return syncRoom(room);
      case 'ready':
        me.ready = !!msg.ready;
        return syncRoom(room);
      case 'launch':
        if (me.slot !== room.host || room.players.length < MAX_PLAYERS || !room.players.every((p) => p.ready)) return;
        room.phase = 'battle';
        room.net = msg.net;
        room.log = [];
        for (const p of room.players) p.last = -1;
        broadcast(room, { t: 'start', net: room.net });
        return syncRoom(room);
    }
    return;
  }
  if (msg.t === 'sync' && room.phase !== 'lobby') {
    const last = {};
    for (const p of room.players) last[p.slot] = p.last;
    return send(ws, { t: 'resume', net: room.net, log: room.log, last });
  }
  if (msg.t === 'step' && room.phase === 'battle' && !me.dropped && Number.isInteger(msg.s) && msg.s > me.last) {
    const b = { s: msg.s };
    if (Array.isArray(msg.c) && msg.c.length) b.c = msg.c.slice(0, 64);
    if (Number.isInteger(msg.hs) && Number.isFinite(msg.h)) {
      b.h = msg.h;
      b.hs = msg.hs;
    }
    me.last = msg.s;
    if (b.c) room.log.push({ p: me.slot, ...b });
    broadcast(room, { t: 'step', p: me.slot, ...b }, me.slot);
  }
}

const wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 });
http.on('upgrade', (req, socket, head) => {
  if (new URL(req.url ?? '/', 'http://x').pathname !== '/ws') return socket.destroy();
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});
wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => (ws.isAlive = true));
  ws.on('message', (data) => {
    let msg;
    try {
      msg = JSON.parse(String(data));
    } catch {
      return;
    }
    if (msg && typeof msg.t === 'string') handle(ws, msg);
  });
  ws.on('close', () => detach(ws));
});
// drop half-open connections (laptop lid closed, network gone) so the grace timer starts
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, 15_000).unref();

http.listen(PORT, () => console.log(`modern-combat server on :${PORT} serving ${ROOT}`));
