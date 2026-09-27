import type { Command, StepBatch } from './protocol';
import { Session, worldHash } from './session';

/** Commands take effect this many steps (× 0.1 s) after they're given: hides network latency. */
export const INPUT_DELAY = 3;
/** Checksums are exchanged every this many steps (2 s). */
const HASH_EVERY = 20;

export interface LockstepHooks {
  send(batch: StepBatch): void;
  /** After each executed step; `ticked` is false while deploying or paused. */
  afterStep(ticked: boolean): void;
  /** Our state differs from `slot`'s at `step`. */
  desync?(step: number, slot: number): void;
}

/**
 * Deterministic lockstep. The game advances in steps of 0.1 s; in each step every player's
 * commands for that step are applied (in slot order), then the world ticks once, unless it's
 * deploying or paused. A player's commands for step s are sent when they're at step s − 3, and no one
 * runs step s until they have every player's batch for it, so all machines run the same steps on
 * the same inputs and stay identical. Empty batches double as heartbeats.
 */
export class Lockstep {
  /** Next step to execute. */
  step = 0;
  /** Players whose input we're waiting for (empty when running freely). */
  waitingFor: number[] = [];
  private sentUpTo = INPUT_DELAY - 1;
  private readonly inbox = new Map<number, Map<number, Command[]>>();
  private outbox: Command[] = [];
  /** Our own batches, kept so they can be re-sent after a reconnect. */
  private readonly mine = new Map<number, Command[]>();
  private readonly hashes = new Map<number, number>();
  private readonly theirHashes: { slot: number; s: number; h: number }[] = [];
  private pendingHash: { s: number; h: number } | null = null;
  private readonly dropAt = new Map<number, number>();

  constructor(
    readonly session: Session,
    readonly me: number,
    private hooks: LockstepHooks,
  ) {}

  /** A command from the local player; it goes out with the next batch. */
  submit(c: Command): void {
    this.outbox.push(c);
  }

  /** Another player's batch (or one of ours replayed from the relay's log). */
  receive(slot: number, b: StepBatch): void {
    if (b.s < this.step) return; // already executed (duplicate after a reconnect)
    let m = this.inbox.get(b.s);
    if (!m) this.inbox.set(b.s, (m = new Map()));
    m.set(slot, b.c ?? []);
    if (b.h !== undefined && b.hs !== undefined && slot !== this.me) this.theirHashes.push({ slot, s: b.hs, h: b.h });
    this.checkHashes();
  }

  /** The relay says `slot` has gone for good, from step `from` (everyone applies it there). */
  drop(slot: number, from: number): void {
    if (!this.dropAt.has(slot)) this.dropAt.set(slot, Math.max(from, INPUT_DELAY));
  }

  /** Whether `slot`'s departure has been announced (it takes effect at its step). */
  leaving(slot: number): boolean {
    return this.dropAt.has(slot);
  }

  /** After reconnecting: the relay has our batches only up to `last`; send the rest again. */
  resendFrom(last: number): void {
    for (let s = last + 1; s <= this.sentUpTo; s++) {
      const c = this.mine.get(s) ?? [];
      this.hooks.send(c.length ? { s, c } : { s });
    }
  }

  /** Mark our batches up to `last` as already sent (rejoining after a reload). */
  setSentUpTo(last: number): void {
    this.sentUpTo = Math.max(this.sentUpTo, last);
  }

  private has(s: number, slot: number): boolean {
    if (s < INPUT_DELAY || this.session.dropped.has(slot)) return true;
    const d = this.dropAt.get(slot);
    if (d !== undefined && s >= d) return true;
    return !!this.inbox.get(s)?.has(slot);
  }

  /**
   * Run steps up to (not including) `target`, as far as everyone's input allows. Returns how many
   * ran; `waitingFor` names who we're blocked on.
   */
  pump(target: number, max = 400): number {
    let ran = 0;
    while (this.step < target && ran < max) {
      this.flush();
      const s = this.step;
      const waiting = this.session.players.filter((p) => !this.has(s, p.slot)).map((p) => p.slot);
      if (waiting.length) {
        this.waitingFor = waiting;
        return ran;
      }
      this.execute(s);
      ran++;
    }
    this.waitingFor = [];
    this.flush();
    return ran;
  }

  private execute(s: number): void {
    const session = this.session;
    const w = session.world;
    for (const [slot, from] of this.dropAt) if (from === s) session.drop(slot);
    const m = this.inbox.get(s);
    if (m) {
      const slots = [...m.keys()].sort((a, b) => a - b);
      for (const slot of slots) for (const c of m.get(slot)!) session.apply(slot, c);
      this.inbox.delete(s);
    }
    const ticked = w.phase === 'battle' && !session.paused;
    if (ticked) w.step();
    this.step = s + 1;
    if (this.step % HASH_EVERY === 0) {
      const h = worldHash(w);
      this.hashes.set(s, h);
      this.pendingHash = { s, h };
      for (const k of this.hashes.keys()) if (k < s - HASH_EVERY * 30) this.hashes.delete(k);
      this.checkHashes();
    }
    this.hooks.afterStep(ticked);
  }

  /** Send our batch for every step up to the current one + the input delay. */
  private flush(): void {
    const upTo = this.step + INPUT_DELAY;
    while (this.sentUpTo < upTo) {
      const s = ++this.sentUpTo;
      const c = s === upTo ? this.outbox.splice(0) : [];
      const b: StepBatch = { s };
      if (c.length) b.c = c;
      if (this.pendingHash) {
        b.h = this.pendingHash.h;
        b.hs = this.pendingHash.s;
        this.pendingHash = null;
      }
      this.mine.set(s, c);
      if (this.mine.size > 600) this.mine.delete(this.mine.keys().next().value!);
      this.receive(this.me, { s, c });
      this.hooks.send(b);
    }
  }

  private checkHashes(): void {
    for (let i = this.theirHashes.length - 1; i >= 0; i--) {
      const t = this.theirHashes[i];
      const ours = this.hashes.get(t.s);
      if (ours === undefined) {
        if (t.s < this.step - HASH_EVERY * 30) this.theirHashes.splice(i, 1);
        continue;
      }
      if (ours !== t.h) this.hooks.desync?.(t.s, t.slot);
      this.theirHashes.splice(i, 1);
    }
  }
}
