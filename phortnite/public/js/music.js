// Synthesized music (no audio files): a bouncy 120 BPM lobby loop (kick, snare, hat, bass, pluck),
// a victory fanfare and a drum roll for the countdown. Everything plays into sfx.musicBus, whose
// volume is the Music setting; the bus only exists once the first tap has unlocked audio, so the
// loop starts on the first scheduler tick after that. A 25 ms scheduler queues notes 0.12 s ahead
// (well under 0.2 ms per tick).
const BPM = 120;
const STEP = 60 / BPM / 4; // a 16th note
const LOOKAHEAD = 0.12;
const TICK_MS = 25;
// C major pop progression, one chord per bar: C, G, Am, F (MIDI roots and chord tones)
const CHORDS = [[48, 60, 64, 67], [43, 59, 62, 67], [45, 60, 64, 69], [41, 60, 65, 69]];
const BASS_STEPS = [0, 3, 6, 8, 10, 14];
const PLUCK = [0, 2, 3, 1, 2, 3, 1, 2]; // chord-tone index per 8th note
const hz = (n) => 440 * Math.pow(2, (n - 69) / 12);

export class Music {
  constructor(sfx, settings) {
    this.sfx = sfx;
    this.settings = settings;
    this.want = false;
    this.playing = false;
    this.step = 0;
    this.next = 0;
    this.timer = setInterval(() => this.schedule(), TICK_MS);
  }

  /** The lobby loop on or off (it fades in and out). */
  lobby(on) {
    this.want = !!on;
    if (!on && this.playing) this.stopLoop();
  }

  setVolume(v) {
    const bus = this.sfx.musicBus;
    if (bus) bus.gain.value = Math.max(0, Math.min(1, v));
  }

  ready() {
    const s = this.sfx;
    return !!(s.ctx && s.musicBus && s.ctx.state === 'running' && s.noise);
  }

  schedule() {
    if (!this.want || !this.ready() || document.hidden) return;
    const ctx = this.sfx.ctx;
    if (!this.playing) this.startLoop();
    // after a stall (tab in the background) skip ahead instead of firing a burst of notes
    if (this.next < ctx.currentTime - 0.2) this.next = ctx.currentTime + 0.05;
    while (this.next < ctx.currentTime + LOOKAHEAD) {
      this.playStep(this.step, this.next);
      this.step = (this.step + 1) % 64;
      this.next += STEP;
    }
  }

  startLoop() {
    const ctx = this.sfx.ctx;
    this.out = ctx.createGain();
    this.out.gain.setValueAtTime(0, ctx.currentTime);
    this.out.gain.linearRampToValueAtTime(0.55, ctx.currentTime + 1.2);
    this.out.connect(this.sfx.musicBus);
    this.playing = true;
    this.step = 0;
    this.next = ctx.currentTime + 0.08;
  }

  stopLoop() {
    const ctx = this.sfx.ctx;
    const out = this.out;
    this.playing = false;
    this.out = null;
    if (!out || !ctx) return;
    out.gain.cancelScheduledValues(ctx.currentTime);
    out.gain.setValueAtTime(out.gain.value, ctx.currentTime);
    out.gain.linearRampToValueAtTime(0, ctx.currentTime + 0.5);
    setTimeout(() => { try { out.disconnect(); } catch (e) { /* gone */ } }, 700);
  }

  playStep(i, t) {
    const s = i % 16;
    const bar = (i >> 4) % 4;
    const chord = CHORDS[bar];
    const out = this.out;
    if (s % 4 === 0) this.kick(out, t);
    if (s === 4 || s === 12) this.snare(out, t, 0.32);
    if (s % 2 === 1) this.hat(out, t, s % 4 === 3 ? 0.08 : 0.045);
    if (BASS_STEPS.includes(s)) this.bass(out, t, hz(chord[0] - 12 + (s === 14 ? 12 : 0)), STEP * (s === 6 ? 2 : 1.6));
    if (s % 2 === 0 && (bar !== 3 || s < 12)) this.pluck(out, t, hz(chord[1 + (PLUCK[(s >> 1) % 8] % 3)] + 12), 0.07);
    // a little lead phrase at the end of every 4 bars
    if (bar === 3 && s >= 12) this.pluck(out, t, hz(72 + [0, 2, 4, 7][s - 12]), 0.09);
  }

  osc(out, t, type, f0, f1, dur, vol, attack = 0.004) {
    const ctx = this.sfx.ctx;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(f0, t);
    if (f1 !== f0) o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(out);
    o.start(t);
    o.stop(t + dur + 0.02);
    return o;
  }

  noise(out, t, dur, type, freq, vol) {
    const ctx = this.sfx.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.sfx.noise;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    const g = ctx.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f).connect(g).connect(out);
    src.start(t, Math.random() * 1.5);
    src.stop(t + dur + 0.02);
  }

  kick(out, t) { this.osc(out, t, 'sine', 140, 42, 0.26, 0.9, 0.002); }

  snare(out, t, vol) {
    this.noise(out, t, 0.16, 'bandpass', 1900, vol);
    this.osc(out, t, 'triangle', 220, 160, 0.09, vol * 0.6);
  }

  hat(out, t, vol) { this.noise(out, t, 0.04, 'highpass', 7500, vol); }

  bass(out, t, f, dur) {
    const ctx = this.sfx.ctx;
    const o = ctx.createOscillator();
    const lp = ctx.createBiquadFilter();
    const g = ctx.createGain();
    o.type = 'sawtooth';
    o.frequency.value = f;
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(900, t);
    lp.frequency.exponentialRampToValueAtTime(220, t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.32, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(lp).connect(g).connect(out);
    o.start(t);
    o.stop(t + dur + 0.02);
  }

  pluck(out, t, f, vol) { this.osc(out, t, 'triangle', f, f, 0.22, vol, 0.003); }

  /** The countdown: a drum roll that builds over 3 s. */
  drumroll(sec = 3) {
    if (!this.ready()) return;
    const ctx = this.sfx.ctx, out = this.sfx.musicBus;
    const t0 = ctx.currentTime + 0.02;
    let t = t0;
    while (t < t0 + sec) {
      const k = (t - t0) / sec;
      this.noise(out, t, 0.07, 'bandpass', 1700 + k * 600, 0.08 + k * 0.25);
      t += 0.11 - k * 0.07;
    }
    this.osc(out, t0 + sec, 'sine', 120, 40, 0.5, 0.9, 0.002);
    this.noise(out, t0 + sec, 0.6, 'highpass', 4000, 0.3);
  }

  /** A countdown beep (n = 3, 2, 1). */
  tick(n) {
    if (!this.ready()) return;
    const t = this.sfx.ctx.currentTime + 0.01;
    this.osc(this.sfx.musicBus, t, 'square', n === 1 ? 1047 : 784, n === 1 ? 1047 : 784, 0.16, 0.12);
  }

  /** #1 PHICTORY ROYALE: a brassy fanfare. */
  fanfare() {
    if (!this.ready()) return;
    const ctx = this.sfx.ctx, out = this.sfx.musicBus;
    const t = ctx.currentTime + 0.05;
    const notes = [[67, 0, 0.16], [67, 0.16, 0.16], [67, 0.32, 0.16], [72, 0.5, 0.7], [64, 1.25, 0.2], [67, 1.45, 0.2], [72, 1.65, 1.4]];
    for (const [n, at, d] of notes) {
      this.osc(out, t + at, 'sawtooth', hz(n), hz(n), d + 0.1, 0.16, 0.02);
      this.osc(out, t + at, 'square', hz(n - 12), hz(n - 12), d + 0.1, 0.07, 0.02);
    }
    for (const n of [48, 55, 60, 64]) this.osc(out, t + 1.65, 'sawtooth', hz(n), hz(n), 1.6, 0.06, 0.05);
    for (let i = 0; i < 3; i++) this.kick(out, t + 1.65 + i * 0.5);
    this.snare(out, t + 0.5, 0.3);
    this.snare(out, t + 1.65, 0.4);
  }

  dispose() { clearInterval(this.timer); this.lobby(false); }
}
