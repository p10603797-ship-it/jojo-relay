// Procedural sound effects with WebAudio (no audio files needed). 3D positioned.
export class Sfx {
  constructor(settings) {
    this.settings = settings;
    this.ctx = null;
    this.master = null;
    this.listener = { x: 0, y: 0, z: 0 };
    this.noise = null;
    this.windGain = null;
    this.stormGain = null;
    this.musicBus = null; // GainNode for music (into master); exists once the first tap / key has unlocked audio
    const unlock = () => {
      this.init();
      if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume();
    };
    window.addEventListener('pointerdown', unlock, true);
    window.addEventListener('keydown', unlock, true);
    window.addEventListener('touchend', unlock, true);
  }

  init() {
    if (this.ctx) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    this.ctx = new AC();
    this.master = this.ctx.createGain();
    this.master.gain.value = this.settings.volume;
    const comp = this.ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.ratio.value = 4;
    this.master.connect(comp).connect(this.ctx.destination);
    this.musicBus = this.ctx.createGain();
    this.musicBus.gain.value = this.settings.music ?? 0.5;
    this.musicBus.connect(this.master);
    const len = this.ctx.sampleRate * 2;
    this.noise = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    // reverb impulse
    const rl = this.ctx.sampleRate * 1.6;
    this.ir = this.ctx.createBuffer(2, rl, this.ctx.sampleRate);
    for (let c = 0; c < 2; c++) {
      const ch = this.ir.getChannelData(c);
      for (let i = 0; i < rl; i++) ch[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / rl, 3);
    }
    this.verb = this.ctx.createConvolver();
    this.verb.buffer = this.ir;
    this.verbGain = this.ctx.createGain();
    this.verbGain.gain.value = 0.18;
    this.verb.connect(this.verbGain).connect(this.master);
    // loops: wind (skydiving) and storm
    this.windGain = this.loop(400, 0.6, 0);
    this.stormGain = this.loop(160, 2, 0);
  }

  loop(freq, q, gain) {
    const src = this.ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    const f = this.ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.value = freq;
    f.Q.value = q;
    const g = this.ctx.createGain();
    g.gain.value = gain;
    src.connect(f).connect(g).connect(this.master);
    src.start();
    g.filter = f;
    return g;
  }

  setVolume(v) { if (this.master) this.master.gain.value = v; }

  setListener(pos, yaw) {
    this.listener.x = pos.x; this.listener.y = pos.y; this.listener.z = pos.z;
    this.listenerYaw = yaw;
  }

  setWind(k) {
    if (!this.windGain) return;
    this.windGain.gain.setTargetAtTime(k * 0.35, this.ctx.currentTime, 0.2);
    this.windGain.filter.frequency.setTargetAtTime(300 + k * 700, this.ctx.currentTime, 0.2);
  }

  setStorm(k) {
    if (!this.stormGain) return;
    this.stormGain.gain.setTargetAtTime(k * 0.5, this.ctx.currentTime, 0.4);
  }

  /** Output node for a sound at a world position (or null pos = 2D). */
  out(pos, vol = 1, maxDist = 120) {
    const ctx = this.ctx;
    const g = ctx.createGain();
    if (!pos) {
      g.gain.value = vol;
      g.connect(this.master);
      return g;
    }
    const dx = pos.x - this.listener.x, dy = pos.y - this.listener.y, dz = pos.z - this.listener.z;
    const d = Math.hypot(dx, dy, dz);
    if (d > maxDist) return null;
    const att = vol * Math.min(1, 6 / Math.max(6, d)) * (1 - d / maxDist);
    g.gain.value = att;
    const pan = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
    if (pan) {
      const yaw = this.listenerYaw || 0;
      // camera right vector in world for this yaw
      const rx = Math.cos(yaw), rz = -Math.sin(yaw);
      pan.pan.value = d > 0.5 ? Math.max(-1, Math.min(1, (dx * rx + dz * rz) / d)) * 0.8 : 0;
      g.connect(pan).connect(this.master);
    } else g.connect(this.master);
    if (d > 25) {
      const send = ctx.createGain();
      send.gain.value = Math.min(1, d / 80);
      g.connect(send).connect(this.verb);
    }
    return g;
  }

  noiseBurst(dest, t, dur, type, freq, q, vol, attack = 0.002) {
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.playbackRate.value = 1;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(vol, t + attack);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    src.connect(f).connect(g).connect(dest);
    src.start(t, Math.random() * 1.5);
    src.stop(t + dur + 0.05);
    return f;
  }

  tone(dest, t, dur, type, f0, f1, vol, attack = 0.003) {
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(f0, t);
    if (f1 !== f0) o.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(vol, t + attack);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(g).connect(dest);
    o.start(t);
    o.stop(t + dur + 0.05);
  }

  ok() { return this.ctx && this.ctx.state === 'running'; }

  // ------------------------------------------------------------------ sounds
  shot(w, pos, local) {
    if (!this.ok()) return;
    const out = this.out(local ? null : pos, local ? 0.55 : 0.9, w === 'sniper' ? 400 : 220);
    if (!out) return;
    const t = this.ctx.currentTime;
    switch (w) {
      case 'shotgun':
        this.noiseBurst(out, t, 0.45, 'lowpass', 1800, 0.7, 1.2);
        this.tone(out, t, 0.25, 'sine', 120, 40, 0.9);
        this.noiseBurst(out, t + 0.35, 0.08, 'bandpass', 2500, 4, 0.25);
        this.noiseBurst(out, t + 0.5, 0.08, 'bandpass', 2000, 4, 0.25);
        break;
      case 'sniper':
        this.noiseBurst(out, t, 0.7, 'lowpass', 3500, 0.5, 1.3);
        this.tone(out, t, 0.35, 'sawtooth', 180, 30, 0.5);
        this.noiseBurst(out, t + 0.6, 0.09, 'bandpass', 3000, 6, 0.3);
        break;
      case 'tactical': // tighter, higher bark than the pump and no rack (it's semi-auto)
        this.noiseBurst(out, t, 0.3, 'lowpass', 2400, 0.7, 1.05);
        this.tone(out, t, 0.18, 'sine', 150, 50, 0.75);
        this.noiseBurst(out, t + 0.16, 0.05, 'bandpass', 3200, 5, 0.18);
        break;
      case 'burst': // crisp crack with a short metallic ring (fired three at a time)
        this.noiseBurst(out, t, 0.14, 'bandpass', 2300, 1.1, 0.85);
        this.tone(out, t, 0.07, 'triangle', 240, 80, 0.4);
        this.tone(out, t, 0.05, 'square', 1500, 1100, 0.04);
        break;
      case 'smg':
        this.noiseBurst(out, t, 0.12, 'bandpass', 2600, 0.9, 0.7);
        this.tone(out, t, 0.06, 'square', 300, 120, 0.15);
        break;
      case 'pistol':
        this.noiseBurst(out, t, 0.16, 'bandpass', 2200, 0.8, 0.8);
        this.tone(out, t, 0.08, 'triangle', 260, 90, 0.35);
        break;
      case 'rocket':
        this.noiseBurst(out, t, 0.9, 'bandpass', 700, 0.8, 0.9, 0.05);
        this.tone(out, t, 0.4, 'sawtooth', 90, 50, 0.3);
        break;
      default: // ar
        this.noiseBurst(out, t, 0.2, 'bandpass', 1900, 0.8, 0.95);
        this.tone(out, t, 0.1, 'triangle', 200, 60, 0.45);
    }
  }

  explosion(pos) {
    if (!this.ok()) return;
    const out = this.out(pos, 1.6, 500);
    if (!out) return;
    const t = this.ctx.currentTime;
    this.noiseBurst(out, t, 1.6, 'lowpass', 900, 0.6, 1.5, 0.005);
    this.tone(out, t, 0.9, 'sine', 90, 25, 1.2);
    this.noiseBurst(out, t + 0.05, 0.6, 'bandpass', 2500, 0.8, 0.4);
  }

  hitmarker(head, shield, kill) {
    if (!this.ok()) return;
    const out = this.out(null, 0.5);
    const t = this.ctx.currentTime;
    if (kill) {
      this.tone(out, t, 0.25, 'sine', 880, 880, 0.35);
      this.tone(out, t + 0.08, 0.35, 'sine', 1320, 1320, 0.35);
    } else if (head) {
      this.tone(out, t, 0.18, 'sine', 1760, 1500, 0.4);
    } else if (shield) {
      this.tone(out, t, 0.08, 'triangle', 1400, 1100, 0.25);
    } else {
      this.noiseBurst(out, t, 0.05, 'highpass', 4000, 1, 0.4);
    }
  }

  hurt() {
    if (!this.ok()) return;
    const out = this.out(null, 0.5);
    const t = this.ctx.currentTime;
    this.tone(out, t, 0.18, 'sawtooth', 220, 110, 0.25);
    this.noiseBurst(out, t, 0.12, 'lowpass', 900, 1, 0.4);
  }

  shieldBreak() {
    if (!this.ok()) return;
    const out = this.out(null, 0.6);
    const t = this.ctx.currentTime;
    for (let i = 0; i < 5; i++) this.tone(out, t + i * 0.03, 0.3, 'sine', 2000 + i * 400, 900, 0.15);
    this.noiseBurst(out, t, 0.3, 'highpass', 3000, 1, 0.4);
  }

  impact(pos, mat) {
    if (!this.ok()) return;
    const out = this.out(pos, 0.4, 60);
    if (!out) return;
    const t = this.ctx.currentTime;
    if (mat === 'metal') this.tone(out, t, 0.12, 'triangle', 2400 + Math.random() * 800, 1800, 0.25);
    else if (mat === 'wood') this.tone(out, t, 0.08, 'sine', 380, 200, 0.4);
    else this.noiseBurst(out, t, 0.08, 'bandpass', 1500, 1.2, 0.5);
  }

  pickaxe(pos, mat, local) {
    if (!this.ok()) return;
    const out = this.out(local ? null : pos, 0.6, 60);
    if (!out) return;
    const t = this.ctx.currentTime;
    if (mat === 'wood') { this.tone(out, t, 0.15, 'sine', 300, 180, 0.6); this.noiseBurst(out, t, 0.1, 'bandpass', 900, 2, 0.4); } else if (mat === 'metal') { this.tone(out, t, 0.3, 'triangle', 1800, 1500, 0.35); this.tone(out, t, 0.3, 'sine', 2600, 2300, 0.2); } else { this.noiseBurst(out, t, 0.12, 'bandpass', 1200, 1.5, 0.7); this.tone(out, t, 0.1, 'sine', 200, 120, 0.3); }
  }

  whoosh(local) {
    if (!this.ok()) return;
    const out = this.out(null, 0.2);
    const f = this.noiseBurst(out, this.ctx.currentTime, 0.25, 'bandpass', 600, 1.5, 0.6, 0.06);
    f.frequency.exponentialRampToValueAtTime(2000, this.ctx.currentTime + 0.2);
  }

  build(pos, local) {
    if (!this.ok()) return;
    const out = this.out(local ? null : pos, 0.45, 70);
    if (!out) return;
    const t = this.ctx.currentTime;
    this.tone(out, t, 0.12, 'sine', 520, 300, 0.35);
    this.tone(out, t + 0.05, 0.12, 'sine', 420, 260, 0.3);
    this.noiseBurst(out, t, 0.1, 'bandpass', 1200, 2, 0.25);
  }

  breakSound(pos, mat) {
    if (!this.ok()) return;
    const out = this.out(pos, 0.8, 120);
    if (!out) return;
    const t = this.ctx.currentTime;
    this.noiseBurst(out, t, 0.6, 'lowpass', mat === 'metal' ? 3000 : 1200, 0.8, 0.9);
    this.tone(out, t, 0.3, 'sine', mat === 'wood' ? 160 : 110, 50, 0.5);
  }

  step(pos, surface, local) {
    if (!this.ok()) return;
    const out = this.out(local ? null : pos, local ? 0.12 : 0.3, 30);
    if (!out) return;
    const t = this.ctx.currentTime;
    const f = surface === 'wood' ? 600 : surface === 'metal' ? 1800 : surface === 'sand' ? 2200 : surface === 'stone' ? 1400 : 900;
    this.noiseBurst(out, t, 0.07, 'bandpass', f * (0.9 + Math.random() * 0.2), 1.5, 0.6);
    if (surface === 'wood') this.tone(out, t, 0.06, 'sine', 160, 120, 0.25);
    if (surface === 'metal') this.tone(out, t, 0.08, 'triangle', 900, 700, 0.08);
  }

  reload(local) {
    if (!this.ok() || !local) return;
    const out = this.out(null, 0.35);
    const t = this.ctx.currentTime;
    this.noiseBurst(out, t, 0.05, 'bandpass', 3000, 3, 0.5);
    this.noiseBurst(out, t + 0.35, 0.06, 'bandpass', 2200, 3, 0.6);
    this.tone(out, t + 0.36, 0.05, 'square', 900, 700, 0.1);
  }

  pickup() {
    if (!this.ok()) return;
    const out = this.out(null, 0.35);
    const t = this.ctx.currentTime;
    this.tone(out, t, 0.08, 'sine', 900, 1200, 0.3);
    this.tone(out, t + 0.06, 0.1, 'sine', 1300, 1600, 0.25);
  }

  chest(pos) {
    if (!this.ok()) return;
    const out = this.out(pos, 0.8, 50);
    if (!out) return;
    const t = this.ctx.currentTime;
    [660, 880, 1100, 1320, 1760].forEach((f, i) => this.tone(out, t + i * 0.06, 0.4, 'sine', f, f, 0.18));
  }

  chestHum(pos, k) {
    // handled as a subtle shimmer occasionally
    if (!this.ok() || Math.random() > 0.02 * k) return;
    const out = this.out(pos, 0.15, 25);
    if (!out) return;
    this.tone(out, this.ctx.currentTime, 0.5, 'sine', 1400 + Math.random() * 800, 1600, 0.1, 0.1);
  }

  heal(shield) {
    if (!this.ok()) return;
    const out = this.out(null, 0.4);
    const t = this.ctx.currentTime;
    const base = shield ? 700 : 500;
    [0, 4, 7, 12].forEach((s, i) => this.tone(out, t + i * 0.07, 0.3, 'sine', base * Math.pow(2, s / 12), base * Math.pow(2, s / 12), 0.2));
  }

  ui(kind = 'click') {
    if (!this.ok()) return;
    const out = this.out(null, 0.3);
    const t = this.ctx.currentTime;
    if (kind === 'click') this.tone(out, t, 0.06, 'triangle', 900, 700, 0.3);
    else if (kind === 'error') this.tone(out, t, 0.15, 'square', 200, 150, 0.15);
    else if (kind === 'victory') [523, 659, 784, 1047, 1319].forEach((f, i) => this.tone(out, t + i * 0.12, 0.6, 'triangle', f, f, 0.3));
    else if (kind === 'elim') [440, 330, 220].forEach((f, i) => this.tone(out, t + i * 0.15, 0.4, 'sawtooth', f, f * 0.9, 0.12));
    else if (kind === 'bus') this.tone(out, t, 0.5, 'sine', 300, 600, 0.25);
    else if (kind === 'glider') { this.noiseBurst(out, t, 0.3, 'bandpass', 800, 1, 0.5, 0.02); this.tone(out, t, 0.2, 'sine', 400, 900, 0.2); }
  }
}
