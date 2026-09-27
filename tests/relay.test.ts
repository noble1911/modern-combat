import { spawn, type ChildProcess } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';

const PORT = 3999;
let server: ChildProcess;

beforeAll(async () => {
  server = spawn(process.execPath, ['server/index.mjs'], { env: { ...process.env, PORT: String(PORT), GRACE_MS: '300' }, stdio: 'pipe' });
  await new Promise<void>((resolve, reject) => {
    server.stdout!.on('data', (d) => String(d).includes('server on') && resolve());
    server.on('exit', (c) => reject(new Error(`server exited ${c}`)));
  });
});
afterAll(() => server?.kill());

/** A test client: sends JSON, and waits for the next message of a type. */
function client() {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  const inbox: any[] = [];
  const waiters: { t: string; ok: (m: any) => void }[] = [];
  ws.on('message', (d) => {
    const m = JSON.parse(String(d));
    const i = waiters.findIndex((w) => w.t === m.t);
    if (i >= 0) waiters.splice(i, 1)[0].ok(m);
    else inbox.push(m);
  });
  const open = new Promise((r) => ws.on('open', r));
  return {
    ws,
    send: async (m: unknown) => {
      await open;
      ws.send(JSON.stringify(m));
    },
    next: (t: string) =>
      new Promise<any>((ok, fail) => {
        const i = inbox.findIndex((m) => m.t === t);
        if (i >= 0) return ok(inbox.splice(i, 1)[0]);
        waiters.push({ t, ok });
        setTimeout(() => fail(new Error(`timeout waiting for ${t}`)), 3000);
      }),
  };
}

describe('multiplayer relay', () => {
  it('serves the health check', async () => {
    const r = await fetch(`http://127.0.0.1:${PORT}/healthz`);
    expect(r.status).toBe(200);
  });

  it('runs a room from lobby to battle, relaying steps, resyncing and dropping a leaver', async () => {
    const a = client();
    await a.send({ t: 'create', name: 'Alpha', settings: { mode: 'versus', mapId: 'hollen', side: 'nato', minutes: 25, budget: 1000, enemy: 'regular' } });
    const wa = await a.next('welcome');
    expect(wa.room).toMatch(/^[A-Z2-9]{4}$/);
    const b = client();
    await b.send({ t: 'join', room: wa.room, name: 'Bravo<script>' });
    const wb = await b.next('welcome');
    expect(wb.slot).toBe(1);
    let room = (await b.next('room')).state;
    expect(room.players.map((p: any) => [p.name, p.side])).toEqual([['Alpha', 'nato'], ['Bravoscript', 'opfor']]);

    // a third player can't join a full room; a bad code is refused
    const c = client();
    await c.send({ t: 'join', room: wa.room, name: 'Charlie' });
    expect((await c.next('error')).msg).toMatch(/full/);
    await c.send({ t: 'join', room: 'ZZZZ', name: 'Charlie' });
    expect((await c.next('error')).msg).toMatch(/No game/);

    // forces, ready, launch
    await a.send({ t: 'force', force: [{ template: 'us_rifle' }] });
    await b.send({ t: 'force', force: [{ template: 'ru_rifle' }] });
    await a.send({ t: 'ready', ready: true });
    await b.send({ t: 'ready', ready: true });
    do room = (await a.next('room')).state;
    while (!room.players.every((p: any) => p.ready));
    await a.send({ t: 'launch', net: { title: 'Test', mode: 'versus', players: [], setup: { mapId: 'hollen' } } });
    expect((await b.next('start')).net.title).toBe('Test');

    // steps are relayed to the other player only, commands are logged
    await a.send({ t: 'step', s: 3, c: [{ k: 'ready' }] });
    const st = await b.next('step');
    expect(st).toMatchObject({ p: 0, s: 3, c: [{ k: 'ready' }] });
    await b.send({ t: 'step', s: 3 });
    await b.send({ t: 'step', s: 4 });
    expect((await a.next('step')).s).toBe(3);
    expect((await a.next('step')).s).toBe(4);

    // a stuck client asks for the log again
    await b.send({ t: 'sync' });
    const re = await b.next('resume');
    expect(re.last).toEqual({ 0: 3, 1: 4 });
    expect(re.log).toEqual([{ p: 0, s: 3, c: [{ k: 'ready' }] }]);

    // reconnecting with the token reclaims the seat and replays
    b.ws.close();
    await a.next('presence');
    const b2 = client();
    await b2.send({ t: 'join', room: wa.room, name: 'Bravo', token: wb.token });
    expect((await b2.next('welcome')).slot).toBe(1);
    expect((await b2.next('resume')).last[1]).toBe(4);

    // leaving for good: everyone is told from which step the leaver is gone
    await b2.send({ t: 'leave' });
    const drop = await a.next('drop');
    expect(drop).toEqual({ t: 'drop', slot: 1, from: 5 });
    a.ws.close();
    c.ws.close();
  });

  it('drops a player who disconnects and does not come back within the grace period', async () => {
    const a = client();
    await a.send({ t: 'create', name: 'A', settings: { mode: 'coop', mapId: 'hollen', side: 'nato', minutes: 25, budget: 700, enemy: 'regular' } });
    const { room: code } = await a.next('welcome');
    const b = client();
    await b.send({ t: 'join', room: code, name: 'B' });
    await b.next('welcome');
    await a.send({ t: 'ready', ready: true });
    await b.send({ t: 'ready', ready: true });
    await new Promise((r) => setTimeout(r, 100));
    await a.send({ t: 'launch', net: { title: 'coop', mode: 'coop', players: [], setup: {} } });
    await b.next('start');
    await b.send({ t: 'step', s: 3 });
    b.ws.terminate();
    const drop = await a.next('drop');
    expect(drop).toMatchObject({ slot: 1, from: 4 });
    a.ws.close();
  });
});
