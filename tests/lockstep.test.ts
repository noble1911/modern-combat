import { describe, expect, it } from 'vitest';
import { createBattle, defaultForces, type BattleSetup } from '../src/game/scenario';
import { Lockstep } from '../src/net/lockstep';
import type { Command, StepBatch } from '../src/net/protocol';
import { Session, worldHash, type NetPlayer } from '../src/net/session';
import { Rng } from '../src/sim/math';

const PLAYERS: NetPlayer[] = [
  { slot: 0, name: 'Alpha', side: 'nato' },
  { slot: 1, name: 'Bravo', side: 'opfor' },
];

function versusSetup(): BattleSetup {
  const { forces, posture } = defaultForces('hollen');
  return {
    mapId: 'hollen',
    seed: 4242,
    timeLimit: 25 * 60,
    player: null,
    humans: ['nato', 'opfor'],
    posture,
    forces: { nato: forces.nato.map((f) => ({ ...f, owner: 0 })), opfor: forces.opfor.map((f) => ({ ...f, owner: 1 })) },
  };
}

interface Peer {
  slot: number;
  ls: Lockstep;
  session: Session;
  hashes: Map<number, number>;
  desyncs: number;
}

function peer(slot: number, send: (from: number, b: StepBatch) => void): Peer {
  const w = createBattle(versusSetup());
  const session = new Session(w, 'versus', PLAYERS);
  const p: Peer = { slot, session, hashes: new Map(), desyncs: 0, ls: null! };
  p.ls = new Lockstep(session, slot, {
    send: (b) => send(slot, b),
    afterStep: () => {
      w.events.length = 0;
      if (p.ls.step % 10 === 0) p.hashes.set(p.ls.step, worldHash(w));
    },
    desync: () => p.desyncs++,
  });
  return p;
}

/** A random but plausible command from a player (deploy placement, moves, fire, pause). */
function randomCommand(rng: Rng, p: Peer): Command | null {
  const w = p.session.world;
  const mine = w.units.filter((u) => p.session.canCommand(p.slot, u.id));
  if (!mine.length) return null;
  const u = mine[rng.int(0, mine.length - 1)];
  if (w.phase === 'deploy') {
    const z = w.deploy[u.side];
    return { k: 'place', unit: u.id, x: z.x + rng.next() * z.w, y: z.y + rng.next() * z.h };
  }
  if (p.session.paused) return { k: 'resume' };
  const r = rng.next();
  if (r < 0.01) return { k: 'pause' };
  if (r < 0.6) return { k: 'order', unit: u.id, kind: rng.next() < 0.5 ? 'move' : 'moveFast', target: { x: rng.range(50, w.map.width - 50), y: rng.range(50, w.map.height - 50) } };
  const foes = w.units.filter((e) => e.side !== u.side && !e.eliminated);
  if (!foes.length) return null;
  return { k: 'order', unit: u.id, kind: 'fire', targetUnit: foes[rng.int(0, foes.length - 1)].id };
}

describe('multiplayer lockstep', () => {
  it('keeps two peers identical over a laggy, reordering network', () => {
    const rng = new Rng(7);
    const log: { p: number; b: StepBatch }[] = [];
    const inFlight: { at: number; to: number; from: number; b: StepBatch }[] = [];
    let now = 0;
    const send = (from: number, b: StepBatch) => {
      log.push({ p: from, b: JSON.parse(JSON.stringify(b)) });
      for (const to of [0, 1]) if (to !== from) inFlight.push({ at: now + 20 + rng.next() * 330, to, from, b: JSON.parse(JSON.stringify(b)) });
    };
    const peers = [peer(0, send), peer(1, send)];
    const FRAMES = 2400; // 4 minutes of 0.1 s frames
    for (let f = 0; f < FRAMES; f++) {
      now += 100;
      for (let i = inFlight.length - 1; i >= 0; i--) {
        const m = inFlight[i];
        if (m.at <= now) {
          peers[m.to].ls.receive(m.from, m.b);
          inFlight.splice(i, 1);
        }
      }
      for (const p of peers) {
        if (f === 40) p.ls.submit({ k: 'ready' });
        else if (rng.next() < 0.08) {
          const c = randomCommand(rng, p);
          if (c) p.ls.submit(c);
        }
        p.ls.pump(f + 1);
      }
    }
    // let the network drain and both catch up
    for (let i = 0; i < 20; i++) {
      now += 1000;
      for (const m of inFlight.splice(0)) peers[m.to].ls.receive(m.from, m.b);
      for (const p of peers) p.ls.pump(FRAMES + 50);
    }
    const [a, b] = peers;
    expect(a.session.world.phase).not.toBe('deploy');
    expect(a.ls.step).toBeGreaterThan(FRAMES - 60);
    expect(a.desyncs + b.desyncs).toBe(0);
    let compared = 0;
    for (const [s, h] of a.hashes) {
      if (!b.hashes.has(s)) continue;
      expect(b.hashes.get(s), `step ${s}`).toBe(h);
      compared++;
    }
    expect(compared).toBeGreaterThan(200);
    // the battle actually happened: soldiers moved and fought
    const w = a.session.world;
    expect(w.time).toBeGreaterThan(60);
    expect(w.soldiers.some((s) => s.health !== 'ok')).toBe(true);

    // a player reloading the page rebuilds the same battle from the relay's log
    const re = peer(0, () => {});
    for (const { p, b: batch } of log) re.ls.receive(p, batch);
    re.ls.setSentUpTo(Math.max(...log.filter((x) => x.p === 0).map((x) => x.b.s)));
    while (re.ls.step < a.ls.step && re.ls.pump(a.ls.step) > 0);
    expect(re.ls.step).toBe(a.ls.step);
    expect(worldHash(re.session.world)).toBe(worldHash(a.session.world));
  }, 120000);

  it('hands a departed player\'s side to the AI at the same step for everyone', () => {
    const q: { to: number; from: number; b: StepBatch }[] = [];
    const peers = [peer(0, (from, b) => q.push({ to: 1, from, b })), peer(1, (from, b) => q.push({ to: 0, from, b }))];
    const deliver = () => {
      for (const m of q.splice(0)) peers[m.to].ls.receive(m.from, m.b);
    };
    for (let f = 0; f < 300; f++) {
      if (f === 5) for (const p of peers) p.ls.submit({ k: 'ready' });
      for (const p of peers) p.ls.pump(f + 1);
      deliver();
    }
    // Bravo vanishes: the relay announces the drop from the step after its last batch
    const lastB = 300 + 2; // Bravo sent up to its step + input delay − 1
    peers[0].ls.drop(1, lastB + 1);
    for (let f = 300; f < 600; f++) peers[0].ls.pump(f + 1);
    const w = peers[0].session.world;
    expect(peers[0].session.dropped.has(1)).toBe(true);
    expect(w.sides.opfor.ai).toBe(true);
    expect(peers[0].ls.step).toBeGreaterThan(590);
  }, 120000);
});
