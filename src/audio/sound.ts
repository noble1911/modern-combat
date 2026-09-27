import { WEAPONS } from '../data/weapons';
import type { SimEvent } from '../sim/types';

/** Synthesised battlefield audio (no assets): noise bursts, filtered thumps and sweeps. */
export class SoundEngine {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private noise!: AudioBuffer;
  private comp!: DynamicsCompressorNode;
  volume = 0.7;
  enabled = true;
  private active = 0;
  private listener = { x: 0, y: 0, dist: 300 };

  /** Must be called from a user gesture. */
  resume(): void {
    if (!this.ctx) {
      const AC = window.AudioContext || (window as any).webkitAudioContext;
      if (!AC) return;
      this.ctx = new AC();
      this.comp = this.ctx.createDynamicsCompressor();
      this.comp.threshold.value = -18;
      this.comp.ratio.value = 6;
      this.master = this.ctx.createGain();
      this.master.gain.value = this.volume;
      this.master.connect(this.comp).connect(this.ctx.destination);
      const len = this.ctx.sampleRate * 2;
      this.noise = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      const d = this.noise.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume();
  }

  setVolume(v: number): void {
    this.volume = v;
    if (this.master) this.master.gain.value = v;
  }

  setListener(x: number, y: number, dist: number): void {
    this.listener = { x, y, dist };
  }

  private gainAt(x: number, y: number): number {
    const d = Math.hypot(x - this.listener.x, y - this.listener.y);
    const eff = Math.hypot(d, this.listener.dist * 0.6);
    return Math.min(1, 120 / (eff + 20));
  }

  private burst(opts: { when?: number; dur: number; freq: number; q?: number; type?: BiquadFilterType; gain: number; decay: number; sweepTo?: number; pan?: number }): void {
    const c = this.ctx!;
    const t = c.currentTime + (opts.when ?? 0);
    const src = c.createBufferSource();
    src.buffer = this.noise;
    src.playbackRate.value = 0.8 + Math.random() * 0.4;
    const f = c.createBiquadFilter();
    f.type = opts.type ?? 'bandpass';
    f.frequency.setValueAtTime(opts.freq, t);
    if (opts.sweepTo) f.frequency.exponentialRampToValueAtTime(opts.sweepTo, t + opts.dur);
    f.Q.value = opts.q ?? 1;
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, opts.gain), t + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, t + opts.decay);
    const p = c.createStereoPanner();
    p.pan.value = opts.pan ?? 0;
    src.connect(f).connect(g).connect(p).connect(this.master);
    src.start(t, Math.random() * 1.5, opts.dur + 0.1);
    this.active++;
    src.onended = () => this.active--;
  }

  private thump(when: number, freq: number, gain: number, decay: number, pan: number): void {
    const c = this.ctx!;
    const t = c.currentTime + when;
    const o = c.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(freq, t);
    o.frequency.exponentialRampToValueAtTime(Math.max(20, freq * 0.35), t + decay);
    const g = c.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + decay);
    const p = c.createStereoPanner();
    p.pan.value = pan;
    o.connect(g).connect(p).connect(this.master);
    o.start(t);
    o.stop(t + decay + 0.05);
  }

  private panOf(x: number): number {
    return Math.max(-0.8, Math.min(0.8, (x - this.listener.x) / 300));
  }

  handle(e: SimEvent): void {
    if (!this.enabled || !this.ctx || this.ctx.state !== 'running') return;
    if (this.active > 48) return;
    switch (e.type) {
      case 'shot': {
        const def = WEAPONS[e.weapon];
        if (!def) return;
        const g = this.gainAt(e.sx, e.sy);
        if (g < 0.03) return;
        const pan = this.panOf(e.sx);
        const n = Math.min(Math.max(1, e.rounds), 10);
        const distDelay = Math.hypot(e.sx - this.listener.x, e.sy - this.listener.y) / 1200;
        switch (def.sound) {
          case 'rifle':
          case 'sniper':
            for (let i = 0; i < n; i++) this.burst({ when: distDelay + i * e.interval, dur: 0.08, freq: def.sound === 'sniper' ? 1400 : 2200, q: 0.8, gain: g * (def.sound === 'sniper' ? 0.9 : 0.55), decay: def.sound === 'sniper' ? 0.25 : 0.12, pan });
            break;
          case 'mg':
          case 'hmg':
            for (let i = 0; i < n; i++) this.burst({ when: distDelay + i * e.interval, dur: 0.07, freq: def.sound === 'hmg' ? 900 : 1600, q: 0.9, gain: g * (def.sound === 'hmg' ? 0.8 : 0.55), decay: 0.1, pan });
            break;
          case 'cannon':
            for (let i = 0; i < n; i++) {
              this.burst({ when: distDelay + i * e.interval, dur: 0.12, freq: 700, q: 0.7, gain: g * 0.8, decay: 0.22, pan });
              this.thump(distDelay + i * e.interval, 140, g * 0.5, 0.2, pan);
            }
            break;
          case 'tankgun':
            this.burst({ when: distDelay, dur: 0.6, freq: 400, q: 0.5, type: 'lowpass', gain: g * 1.2, decay: 0.9, sweepTo: 120, pan });
            this.thump(distDelay, 90, g * 1.2, 0.7, pan);
            break;
          case 'rocket':
          case 'atgm':
            this.burst({ when: distDelay, dur: 0.9, freq: 1200, q: 0.6, gain: g * 0.6, decay: 1.0, sweepTo: 400, pan });
            this.thump(distDelay, 110, g * 0.5, 0.3, pan);
            break;
          case 'gl':
          case 'mortar':
            this.thump(distDelay, def.sound === 'mortar' ? 160 : 260, g * 0.7, 0.18, pan);
            this.burst({ when: distDelay, dur: 0.1, freq: 800, gain: g * 0.3, decay: 0.12, pan });
            break;
        }
        return;
      }
      case 'explosion': {
        const g = this.gainAt(e.x, e.y);
        if (g < 0.02) return;
        const pan = this.panOf(e.x);
        const s = e.size;
        const delay = Math.hypot(e.x - this.listener.x, e.y - this.listener.y) / 700;
        if (e.kind === 'smoke') {
          this.burst({ when: delay, dur: 0.3, freq: 900, gain: g * 0.3, decay: 0.3, pan });
          return;
        }
        const big = Math.min(1.6, 0.4 + s / 8);
        this.burst({ when: delay, dur: 0.4 + s * 0.08, freq: 600, type: 'lowpass', q: 0.4, gain: g * big, decay: 0.5 + s * 0.12, sweepTo: 90, pan });
        this.thump(delay, 70 + 40 / Math.max(1, s), g * big * 1.1, 0.4 + s * 0.06, pan);
        if (e.kind === 'artillery') this.burst({ when: Math.max(0, delay - 0.6), dur: 0.6, freq: 2400, q: 6, gain: g * 0.15, decay: 0.6, sweepTo: 700, pan });
        return;
      }
      case 'impact': {
        if (e.kind !== 'bounce' && e.kind !== 'penetrate') return;
        const g = this.gainAt(e.x, e.y);
        this.burst({ dur: 0.15, freq: 3000, q: 3, gain: g * 0.6, decay: 0.25, pan: this.panOf(e.x) });
        return;
      }
    }
  }

  /** UI click / radio blip. */
  blip(kind: 'ok' | 'bad' | 'radio' = 'ok'): void {
    if (!this.ctx || this.ctx.state !== 'running') return;
    const c = this.ctx;
    const o = c.createOscillator();
    const g = c.createGain();
    o.type = kind === 'radio' ? 'square' : 'sine';
    o.frequency.value = kind === 'bad' ? 220 : kind === 'radio' ? 1400 : 880;
    g.gain.setValueAtTime(0.06, c.currentTime);
    g.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + 0.09);
    o.connect(g).connect(this.master);
    o.start();
    o.stop(c.currentTime + 0.1);
  }
}
