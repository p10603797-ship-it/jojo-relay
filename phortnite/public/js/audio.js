// Procedural sound effects with WebAudio (no audio files needed). 3D positioned.
//
// Mix: every sound -> master (volume) -> +14 dB make-up -> compressor (-18 dB, 3:1) -> limiter
// (-2 dB, 20:1, 1 ms) -> speakers. Your own gun sits around -20 dB RMS, peaks stay under -1 dBFS.
// Music (sfx.musicBus, lobby-party's music.js) joins the master through a -14 dB trim, so it keeps
// the loudness it had before the make-up gain. The island's sounds (positional, loops, the reverb
// and the 2D game sounds: hits, the storm siren, …) go through gameBus, which is off while the
// lobby stage shows (setGame); menu clicks (ui) go straight to the master.
//
// Positional sounds: an HRTF panner within 40 m (equal-power beyond), a lowpass that closes from
// 9 kHz in front to 2.5 kHz behind you (a front / back cue even on iPad speakers), air absorption
// and the speed-of-sound delay for shots past 60 m. At most 28 voices play at once: when full, a
// new sound replaces the quietest one, or is skipped if it is quieter still.
const MAX_VOICES = 28;
const MAKEUP = 5.012; // +14 dB
const CEILING = 0.84; // -1.5 dB after the limiter: WebAudio compressors add their own make-up gain
const MUSIC_TRIM = 0.2; // -14 dB
const HRTF_DIST = 40; // m: HRTF panning up to here, equal-power beyond
const MAX_HRTF = 10; // HRTF panners at once (each is a small convolution on the audio thread)
const AIR_DIST = 60; // m: beyond this shots arrive late and dull
const SPEED_OF_SOUND = 343;
const REF_DIST = 6; // m: full volume up to here

// weapon -> equip sound class
const EQUIP = {
  ar: 'rifle', burst: 'rifle', smg: 'light', pistol: 'light', shotgun: 'shotgun', tactical: 'shotgun', sniper: 'sniper', rocket: 'heavy',
  pickaxe: 'melee', bandage: 'heal', medkit: 'heal', shield_s: 'heal', shield_b: 'heal',
};

export class Sfx {
  constructor(settings) {
    this.settings = settings;
    this.ctx = null;
    this.master = null;
    this.listener = { x: 0, y: 0, z: 0 };
    this.listenerYaw = 0;
    this.listenerPitch = 0;
    this.noise = null;
    this.windGain = null;
    this.stormGain = null;
    this.busGain = null;
    this.musicBus = null; // GainNode for music (into master); exists once the first tap / key has unlocked audio
    this.voices = [];
    this.t0 = 0; // start time of the sound being made (out() sets it: later for far shots)
    const unlock = () => {
      // iPad: play through the silent switch (Safari 16.4+), set before the context starts
      try { if (navigator.audioSession && navigator.audioSession.type !== 'playback') navigator.audioSession.type = 'playback'; } catch (e) { /* not supported */ }
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
    const ctx = new AC();
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.gain.value = this.settings.volume;
    const makeup = ctx.createGain();
    makeup.gain.value = MAKEUP;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -18;
    comp.ratio.value = 3;
    comp.knee.value = 6;
    comp.attack.value = 0.003;
    comp.release.value = 0.25;
    const lim = ctx.createDynamicsCompressor();
    lim.threshold.value = -2;
    lim.ratio.value = 20;
    lim.knee.value = 0;
    lim.attack.value = 0.001;
    lim.release.value = 0.08;
    const ceil = ctx.createGain();
    ceil.gain.value = CEILING;
    this.master.connect(makeup).connect(comp).connect(lim).connect(ceil).connect(ctx.destination);
    this.comp = comp;
    this.limiter = lim;
    this.musicBus = ctx.createGain();
    this.musicBus.gain.value = this.settings.music ?? 0.5;
    const trim = ctx.createGain();
    trim.gain.value = MUSIC_TRIM;
    this.musicBus.connect(trim).connect(this.master);
    // the island's sounds (positional voices, the reverb, wind / storm / bus loops) go through one
    // gate: silenced while the lobby stage shows (BACK TO LOBBY mid-match keeps the game running
    // behind it); UI sounds and music bypass it
    this.gameBus = ctx.createGain();
    this.gameBus.gain.value = this.gameK ?? 1;
    this.gameBus.connect(this.master);
    const len = ctx.sampleRate * 2;
    this.noise = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    // reverb impulse
    const rl = ctx.sampleRate * 1.6;
    this.ir = ctx.createBuffer(2, rl, ctx.sampleRate);
    for (let c = 0; c < 2; c++) {
      const ch = this.ir.getChannelData(c);
      for (let i = 0; i < rl; i++) ch[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / rl, 3);
    }
    this.verb = ctx.createConvolver();
    this.verb.buffer = this.ir;
    this.verbGain = ctx.createGain();
    this.verbGain.gain.value = 0.18;
    this.verb.connect(this.verbGain).connect(this.gameBus);
    // loops: wind (skydiving), storm, bus engine
    this.windGain = this.loop(400, 0.6, 0);
    this.stormGain = this.loop(160, 2, 0);
    this.busGain = this.loop(110, 0.9, 0, 'lowpass');
    const hum = ctx.createOscillator();
    hum.type = 'sawtooth';
    hum.frequency.value = 52;
    const humF = ctx.createBiquadFilter();
    humF.type = 'lowpass';
    humF.frequency.value = 180;
    const humG = ctx.createGain();
    humG.gain.value = 0.35;
    hum.connect(humF).connect(humG).connect(this.busGain);
    hum.start();
  }

  loop(freq, q, gain, type = 'bandpass') {
    const src = this.ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    const f = this.ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = q;
    const g = this.ctx.createGain();
    g.gain.value = gain;
    src.connect(f).connect(g).connect(this.gameBus);
    src.start();
    g.filter = f;
    return g;
  }

  setVolume(v) { if (this.master) this.master.gain.value = v; }

  /** The island's sounds on (1) or off (0): off while the lobby stage shows. */
  setGame(k) {
    this.gameK = k;
    if (this.gameBus) this.gameBus.gain.setTargetAtTime(k, this.ctx.currentTime, 0.12);
  }

  setListener(pos, yaw) {
    this.listener.x = pos.x; this.listener.y = pos.y; this.listener.z = pos.z;
    this.listenerYaw = yaw;
  }

  setListenerPitch(p) { this.listenerPitch = p || 0; }

  setWind(k) {
    if (!this.windGain) return;
    this.windGain.gain.setTargetAtTime(k * 0.35, this.ctx.currentTime, 0.2);
    this.windGain.filter.frequency.setTargetAtTime(300 + k * 700, this.ctx.currentTime, 0.2);
  }

  setStorm(k) {
    if (!this.stormGain) return;
    this.stormGain.gain.setTargetAtTime(k * 0.5, this.ctx.currentTime, 0.4);
  }

  /** The battle bus engine (0..1) while you ride it. */
  setBus(k) {
    if (!this.busGain || k === this.busK) return;
    this.busK = k;
    this.busGain.gain.setTargetAtTime(k * 0.22, this.ctx.currentTime, 0.5);
  }

  /** Distance attenuation (vol at d m with a sound that fades out at maxDist). */
  static atten(vol, d, maxDist) {
    if (d >= maxDist) return 0;
    const near = d <= REF_DIST ? 1 : Math.pow(REF_DIST / d, 0.85);
    const edge = d / maxDist;
    return vol * near * (1 - edge * edge);
  }

  /**
   * Output node for a sound at a world position (or null pos = 2D). Sets this.t0, the time the sound
   * should start (later for far shots: sound travels at 343 m/s). dur: about how long it rings (s).
   * Returns null when the sound is out of range or would be the quietest of 28 voices.
   */
  out(pos, vol = 1, maxDist = 120, dur = 0.6, travel = false, ui = false) {
    const ctx = this.ctx;
    const now = ctx.currentTime;
    this.t0 = now;
    let att = vol, d = 0, lx = 0, ly = 0, lz = 0;
    if (pos) {
      const dx = pos.x - this.listener.x, dy = pos.y - this.listener.y, dz = pos.z - this.listener.z;
      d = Math.sqrt(dx * dx + dy * dy + dz * dz);
      att = Sfx.atten(vol, d, maxDist);
      if (att <= 0.0005) return null;
      // into the listener's frame: x right, y up, -z ahead
      const yaw = this.listenerYaw || 0, p = this.listenerPitch || 0;
      const sy = Math.sin(yaw), cy = Math.cos(yaw), sp = Math.sin(p), cp = Math.cos(p);
      lx = dx * cy - dz * sy;
      ly = dx * sy * sp + dy * cp + dz * cy * sp;
      lz = dx * sy * cp - dy * sp + dz * cy * cp;
      if (travel && d > AIR_DIST) this.t0 = now + d / SPEED_OF_SOUND;
    }
    if (!this.claimVoice(att, this.t0 + dur)) return null;
    const g = ctx.createGain();
    g.gain.value = att;
    const voice = this.voices[this.voices.length - 1];
    voice.g = g;
    if (!pos) {
      // a 2D game sound (hit markers, the storm siren, …) is an island sound too: quiet while the
      // lobby stage shows (gameBus); only the menus' own clicks go straight to the master
      g.connect(ui || !this.gameBus ? this.master : this.gameBus);
      return g;
    }
    // behind you: duller; far away: duller still
    const behind = d > 0.3 ? (1 + lz / d) / 2 : 0;
    let cut = 9000 * Math.pow(2500 / 9000, behind);
    if (d > AIR_DIST) cut = Math.min(cut, 8000 * Math.pow(1500 / 8000, Math.min(1, (d - AIR_DIST) / 240)));
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = cut;
    f.Q.value = 0.5;
    let tail = f;
    if (ctx.createPanner && d > 0.3) {
      const pn = ctx.createPanner();
      let hrtf = d <= HRTF_DIST;
      if (hrtf) {
        let n = 0;
        for (const v of this.voices) if (v.hrtf) n++;
        hrtf = n < MAX_HRTF;
      }
      voice.hrtf = hrtf;
      pn.panningModel = hrtf ? 'HRTF' : 'equalpower';
      pn.distanceModel = 'linear';
      pn.refDistance = 1;
      pn.maxDistance = 100000;
      pn.rolloffFactor = 0;
      if (pn.positionX) { pn.positionX.value = lx; pn.positionY.value = ly; pn.positionZ.value = lz; } else pn.setPosition(lx, ly, lz);
      tail = f.connect(pn);
    } else if (ctx.createStereoPanner) {
      const sp = ctx.createStereoPanner();
      sp.pan.value = d > 0.5 ? Math.max(-1, Math.min(1, lx / d)) * 0.8 : 0;
      tail = f.connect(sp);
    }
    g.connect(f);
    tail.connect(this.gameBus);
    if (d > 25) {
      const send = ctx.createGain();
      send.gain.value = Math.min(1, d / 80);
      g.connect(send).connect(this.verb);
    }
    return g;
  }

  /** Make room for a voice of volume v ending at time end: false when it should not play. */
  claimVoice(v, end) {
    const now = this.ctx.currentTime;
    const vs = this.voices;
    for (let i = vs.length - 1; i >= 0; i--) if (vs[i].end <= now) vs.splice(i, 1);
    if (vs.length >= MAX_VOICES) {
      let qi = 0;
      for (let i = 1; i < vs.length; i++) if (vs[i].v < vs[qi].v) qi = i;
      if (vs[qi].v >= v) return false;
      const q = vs[qi];
      try { q.g.gain.cancelScheduledValues(now); q.g.gain.setValueAtTime(0, now); q.g.disconnect(); } catch (e) { /* gone */ }
      vs.splice(qi, 1);
    }
    vs.push({ g: null, v, end, hrtf: false });
    return true;
  }

  /** Filtered noise: rises over attack, stays at vol for hold s, then decays until dur. */
  noiseBurst(dest, t, dur, type, freq, q, vol, attack = 0.002, hold = 0) {
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
    if (hold > 0) g.gain.setValueAtTime(vol, t + attack + hold);
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
    const out = this.out(local ? null : pos, local ? 0.7 : 1, w === 'sniper' ? 500 : w === 'rocket' ? 260 : 300, w === 'sniper' ? 0.8 : 0.5, true);
    if (!out) return;
    const t = this.t0;
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
    const out = this.out(pos, 1.6, 600, 1.6, true);
    if (!out) return;
    const t = this.t0;
    this.noiseBurst(out, t, 1.6, 'lowpass', 900, 0.6, 1.5, 0.005);
    this.tone(out, t, 0.9, 'sine', 90, 25, 1.2);
    this.noiseBurst(out, t + 0.05, 0.6, 'bandpass', 2500, 0.8, 0.4);
  }

  /** Hit confirm: as loud as your own shot, in its own (higher) register so the gun doesn't hide it. */
  hitmarker(head, shield, kill) {
    if (!this.ok()) return;
    const out = this.out(null, 0.8, 0, 0.5);
    if (!out) return;
    const t = this.ctx.currentTime + 0.02;
    if (kill) {
      this.tone(out, t, 0.28, 'triangle', 880, 880, 0.6);
      this.tone(out, t + 0.08, 0.4, 'triangle', 1320, 1320, 0.6);
      this.tone(out, t + 0.16, 0.45, 'sine', 1760, 1760, 0.35);
      this.noiseBurst(out, t, 0.12, 'highpass', 3500, 0.8, 0.7);
    } else if (head) {
      this.tone(out, t, 0.32, 'triangle', 1760, 1600, 0.75);
      this.tone(out, t, 0.25, 'sine', 2640, 2500, 0.35);
      this.tone(out, t, 0.1, 'sine', 180, 90, 0.7);
    } else if (shield) {
      this.tone(out, t, 0.16, 'triangle', 2400, 2000, 0.55);
      this.tone(out, t, 0.12, 'sine', 3600, 3300, 0.3);
      this.noiseBurst(out, t, 0.08, 'highpass', 4500, 1, 0.6);
    } else {
      // a dense 45 ms tick: it has to cut through your own gunfire
      this.noiseBurst(out, t, 0.11, 'highpass', 3800, 1, 1.1, 0.002, 0.045);
      this.tone(out, t, 0.13, 'triangle', 3000, 2400, 0.9);
      this.tone(out, t, 0.13, 'sine', 700, 280, 0.9);
    }
  }

  hurt() {
    if (!this.ok()) return;
    const out = this.out(null, 0.5, 0, 0.3);
    if (!out) return;
    const t = this.ctx.currentTime;
    this.tone(out, t, 0.18, 'sawtooth', 220, 110, 0.25);
    this.noiseBurst(out, t, 0.12, 'lowpass', 900, 1, 0.4);
  }

  /** My own shield just broke. */
  shieldBreak() {
    if (!this.ok()) return;
    const out = this.out(null, 0.6, 0, 0.5);
    if (!out) return;
    const t = this.ctx.currentTime;
    for (let i = 0; i < 5; i++) this.tone(out, t + i * 0.03, 0.3, 'sine', 2000 + i * 400, 900, 0.15);
    this.noiseBurst(out, t, 0.3, 'highpass', 3000, 1, 0.4);
  }

  /** I broke an enemy's shield: glass shattering, a bit (+3 dB) louder than my own gunshot. */
  shieldCrack() {
    if (!this.ok()) return;
    const out = this.out(null, 0.82, 0, 0.6);
    if (!out) return;
    const t = this.ctx.currentTime + 0.02;
    this.noiseBurst(out, t, 0.3, 'highpass', 3500, 0.7, 1.3);
    this.noiseBurst(out, t, 0.12, 'bandpass', 1600, 1.2, 0.9);
    const pings = [3100, 4300, 3700, 5200, 2700, 4800];
    pings.forEach((f, i) => this.tone(out, t + i * 0.025, 0.25, 'triangle', f, f * 0.92, 0.32));
    this.tone(out, t, 0.18, 'sine', 900, 400, 0.6);
  }

  /** Elimination stinger: climbs higher for each kill in a streak. */
  elimStinger(n = 1) {
    if (!this.ok()) return;
    const out = this.out(null, 0.32, 0, 1.2);
    if (!out) return;
    const t = this.ctx.currentTime + 0.12;
    const up = Math.pow(2, Math.min(5, n - 1) * 2 / 12);
    const notes = n >= 2 ? [523, 659, 784, 1047, 1319].slice(0, Math.min(5, 2 + n)) : [659, 988];
    notes.forEach((f, i) => this.tone(out, t + i * 0.07, 0.35 + i * 0.05, 'square', f * up, f * up, 0.12));
    notes.forEach((f, i) => this.tone(out, t + i * 0.07, 0.4, 'triangle', f * up * 2, f * up * 2, 0.08));
  }

  impact(pos, mat) {
    if (!this.ok()) return;
    const out = this.out(pos, 0.4, 60, 0.15);
    if (!out) return;
    const t = this.t0;
    if (mat === 'metal') this.tone(out, t, 0.12, 'triangle', 2400 + Math.random() * 800, 1800, 0.25);
    else if (mat === 'wood') this.tone(out, t, 0.08, 'sine', 380, 200, 0.4);
    else this.noiseBurst(out, t, 0.08, 'bandpass', 1500, 1.2, 0.5);
  }

  pickaxe(pos, mat, local) {
    if (!this.ok()) return;
    const out = this.out(local ? null : pos, 0.6, 60, 0.3);
    if (!out) return;
    const t = this.t0;
    if (mat === 'wood') { this.tone(out, t, 0.15, 'sine', 300, 180, 0.6); this.noiseBurst(out, t, 0.1, 'bandpass', 900, 2, 0.4); } else if (mat === 'metal') { this.tone(out, t, 0.3, 'triangle', 1800, 1500, 0.35); this.tone(out, t, 0.3, 'sine', 2600, 2300, 0.2); } else { this.noiseBurst(out, t, 0.12, 'bandpass', 1200, 1.5, 0.7); this.tone(out, t, 0.1, 'sine', 200, 120, 0.3); }
  }

  whoosh(local) {
    if (!this.ok()) return;
    const out = this.out(null, 0.2, 0, 0.3);
    if (!out) return;
    const f = this.noiseBurst(out, this.ctx.currentTime, 0.25, 'bandpass', 600, 1.5, 0.6, 0.06);
    f.frequency.exponentialRampToValueAtTime(2000, this.ctx.currentTime + 0.2);
  }

  build(pos, local) {
    if (!this.ok()) return;
    const out = this.out(local ? null : pos, 0.45, 70, 0.2);
    if (!out) return;
    const t = this.t0;
    this.tone(out, t, 0.12, 'sine', 520, 300, 0.35);
    this.tone(out, t + 0.05, 0.12, 'sine', 420, 260, 0.3);
    this.noiseBurst(out, t, 0.1, 'bandpass', 1200, 2, 0.25);
  }

  /** A wall / floor edit: a quick double knock. */
  edit(pos, local) {
    if (!this.ok()) return;
    const out = this.out(local ? null : pos, 0.5, 50, 0.2);
    if (!out) return;
    const t = this.t0;
    this.tone(out, t, 0.06, 'sine', 420, 300, 0.5);
    this.noiseBurst(out, t, 0.05, 'bandpass', 1500, 2, 0.4);
    this.tone(out, t + 0.07, 0.07, 'sine', 560, 380, 0.45);
    this.noiseBurst(out, t + 0.07, 0.05, 'bandpass', 2200, 2, 0.35);
  }

  breakSound(pos, mat) {
    if (!this.ok()) return;
    const out = this.out(pos, 0.8, 120, 0.6);
    if (!out) return;
    const t = this.t0;
    this.noiseBurst(out, t, 0.6, 'lowpass', mat === 'metal' ? 3000 : 1200, 0.8, 0.9);
    this.tone(out, t, 0.3, 'sine', mat === 'wood' ? 160 : 110, 50, 0.5);
  }

  /**
   * A footstep. Enemies' steps are loud enough to hear (and place) out to 45 m; yours are quiet.
   * surface: grass | dirt | sand | stone | snow | wood | metal | water (shared/world/keys.js STEP_SOUND).
   */
  step(pos, surface, local) {
    if (!this.ok()) return;
    const out = this.out(local ? null : pos, local ? 0.06 : 0.42, 45, 0.15);
    if (!out) return;
    const t = this.t0;
    const r = 0.9 + Math.random() * 0.2;
    switch (surface) {
      case 'wood': // hollow thump + creak
        this.tone(out, t, 0.09, 'sine', 150 * r, 95, 0.6);
        this.noiseBurst(out, t, 0.06, 'bandpass', 700 * r, 1.5, 0.5);
        this.noiseBurst(out, t + 0.01, 0.05, 'highpass', 3200, 0.8, 0.35);
        break;
      case 'metal': // clank
        this.tone(out, t, 0.12, 'triangle', 900 * r, 720, 0.4);
        this.tone(out, t, 0.08, 'triangle', 2300 * r, 2000, 0.22);
        this.noiseBurst(out, t, 0.05, 'bandpass', 1800, 1.5, 0.8);
        this.noiseBurst(out, t, 0.04, 'highpass', 4000, 0.8, 0.4);
        break;
      case 'sand': // swish
        this.noiseBurst(out, t, 0.11, 'bandpass', 2600 * r, 0.8, 1.0, 0.012);
        this.noiseBurst(out, t, 0.08, 'highpass', 4500, 0.7, 0.55, 0.01);
        break;
      case 'stone': // click
        this.noiseBurst(out, t, 0.07, 'bandpass', 1500 * r, 1.4, 1.4);
        this.tone(out, t, 0.04, 'triangle', 2600 * r, 2200, 0.35);
        this.tone(out, t, 0.05, 'sine', 180 * r, 120, 0.4);
        this.noiseBurst(out, t, 0.04, 'highpass', 4200, 0.8, 0.6);
        break;
      case 'snow': // crunch
        this.noiseBurst(out, t, 0.1, 'bandpass', 1100 * r, 1.2, 1.05, 0.01);
        this.noiseBurst(out, t + 0.02, 0.07, 'highpass', 3600, 0.7, 0.6);
        break;
      case 'water':
        this.noiseBurst(out, t, 0.14, 'bandpass', 900 * r, 0.9, 0.9, 0.01);
        this.noiseBurst(out, t + 0.03, 0.08, 'highpass', 3000, 0.7, 0.4);
        break;
      default: // grass / dirt: soft thud + rustle
        this.tone(out, t, 0.07, 'sine', 110 * r, 70, 0.6);
        this.noiseBurst(out, t, 0.08, 'bandpass', (surface === 'dirt' ? 800 : 1000) * r, 1.2, 0.8);
        this.noiseBurst(out, t + 0.01, 0.07, 'highpass', 3600, 0.7, 0.45);
    }
  }

  reload(local) {
    if (!this.ok() || !local) return;
    const out = this.out(null, 0.35, 0, 0.5);
    if (!out) return;
    const t = this.ctx.currentTime;
    this.noiseBurst(out, t, 0.05, 'bandpass', 3000, 3, 0.5);
    this.noiseBurst(out, t + 0.35, 0.06, 'bandpass', 2200, 3, 0.6);
    this.tone(out, t + 0.36, 0.05, 'square', 900, 700, 0.1);
  }

  /** Last rounds in the magazine: a small click (higher when fewer are left). */
  lowAmmo(left = 3) {
    if (!this.ok()) return;
    const out = this.out(null, 0.25, 0, 0.1);
    if (!out) return;
    const t = this.ctx.currentTime + 0.05;
    this.tone(out, t, 0.035, 'square', 2600 + (3 - left) * 300, 2400, 0.12);
    this.noiseBurst(out, t, 0.025, 'highpass', 5000, 1, 0.3);
  }

  /** Drawing a weapon / item: one sound per class (rifle, shotgun, sniper, light, heavy, melee, heal). */
  equip(k) {
    if (!this.ok()) return;
    const kind = EQUIP[k] || 'rifle';
    const out = this.out(null, 0.32, 0, 0.4);
    if (!out) return;
    const t = this.ctx.currentTime;
    switch (kind) {
      case 'shotgun': // pump rack
        this.noiseBurst(out, t, 0.06, 'bandpass', 1500, 2, 0.8);
        this.noiseBurst(out, t + 0.13, 0.07, 'bandpass', 2100, 2, 0.9);
        this.tone(out, t + 0.13, 0.05, 'square', 600, 450, 0.08);
        break;
      case 'sniper': // bolt up, back, forward
        this.noiseBurst(out, t, 0.04, 'bandpass', 3200, 3, 0.6);
        this.noiseBurst(out, t + 0.1, 0.08, 'bandpass', 1800, 2, 0.6);
        this.noiseBurst(out, t + 0.22, 0.05, 'bandpass', 2600, 3, 0.7);
        break;
      case 'light':
        this.noiseBurst(out, t, 0.04, 'bandpass', 3400, 3, 0.7);
        this.tone(out, t, 0.03, 'square', 1900, 1700, 0.08);
        break;
      case 'heavy':
        this.tone(out, t, 0.14, 'sine', 160, 90, 0.6);
        this.noiseBurst(out, t, 0.1, 'lowpass', 900, 1, 0.6);
        this.noiseBurst(out, t + 0.12, 0.05, 'bandpass', 2000, 3, 0.5);
        break;
      case 'melee':
        this.noiseBurst(out, t, 0.18, 'bandpass', 900, 1.5, 0.4, 0.05);
        this.tone(out, t + 0.12, 0.12, 'triangle', 1500, 1350, 0.15);
        break;
      case 'heal':
        this.noiseBurst(out, t, 0.12, 'bandpass', 2400, 1.2, 0.4, 0.02);
        this.tone(out, t + 0.05, 0.15, 'sine', 880, 990, 0.12);
        break;
      default: // rifle: magazine tap + charging handle
        this.noiseBurst(out, t, 0.04, 'bandpass', 2600, 3, 0.7);
        this.noiseBurst(out, t + 0.11, 0.06, 'bandpass', 1700, 2.5, 0.8);
        this.tone(out, t + 0.11, 0.04, 'square', 800, 650, 0.06);
    }
  }

  /** Into / out of build mode. */
  buildMode(on) {
    if (!this.ok()) return;
    const out = this.out(null, 0.16, 0, 0.25);
    if (!out) return;
    const t = this.ctx.currentTime;
    const [a, b] = on ? [520, 780] : [700, 460];
    this.tone(out, t, 0.08, 'triangle', a, a, 0.3);
    this.tone(out, t + 0.06, 0.1, 'triangle', b, b, 0.3);
  }

  /** Changing the build material: wood knock, brick click, metal ping. */
  matSwitch(mat) {
    if (!this.ok()) return;
    const out = this.out(null, 0.2, 0, 0.25);
    if (!out) return;
    const t = this.ctx.currentTime;
    if (mat === 'metal') { this.tone(out, t, 0.2, 'triangle', 1800, 1700, 0.3); this.tone(out, t, 0.15, 'sine', 2700, 2600, 0.15); } else if (mat === 'stone') { this.noiseBurst(out, t, 0.06, 'bandpass', 1300, 2, 0.8); this.tone(out, t, 0.05, 'sine', 600, 400, 0.3); } else { this.tone(out, t, 0.1, 'sine', 300, 220, 0.6); this.noiseBurst(out, t, 0.05, 'bandpass', 800, 2, 0.5); }
  }

  jump() {
    if (!this.ok()) return;
    const out = this.out(null, 0.22, 0, 0.2);
    if (!out) return;
    const t = this.ctx.currentTime;
    const f = this.noiseBurst(out, t, 0.14, 'bandpass', 700, 1.4, 0.5, 0.02);
    f.frequency.exponentialRampToValueAtTime(1600, t + 0.12);
    this.tone(out, t, 0.06, 'sine', 160, 120, 0.4);
  }

  /** Landing thud, heavier the harder you land. */
  land(speed = 8) {
    if (!this.ok()) return;
    const k = Math.max(0.25, Math.min(1, speed / 20));
    const out = this.out(null, 0.14 + 0.24 * k, 0, 0.3);
    if (!out) return;
    const t = this.ctx.currentTime;
    this.tone(out, t, 0.12 + 0.1 * k, 'sine', 130, 45, 0.9);
    this.noiseBurst(out, t, 0.1 + 0.08 * k, 'lowpass', 700, 0.7, 0.8);
    this.noiseBurst(out, t + 0.01, 0.06, 'highpass', 3000, 0.7, 0.25 * k);
  }

  /** Low health: a heartbeat (k 0..1 = how close to empty). */
  heartbeat(k = 0.5) {
    if (!this.ok()) return;
    const out = this.out(null, 0.16 + 0.16 * k, 0, 0.5);
    if (!out) return;
    const t = this.ctx.currentTime;
    // lub-dub, pitched up enough (and with a soft knock) to come through iPad speakers
    this.tone(out, t, 0.13, 'sine', 110, 70, 1);
    this.noiseBurst(out, t, 0.06, 'lowpass', 500, 0.8, 0.6);
    this.tone(out, t + 0.17, 0.12, 'sine', 95, 62, 0.7);
    this.noiseBurst(out, t + 0.17, 0.05, 'lowpass', 450, 0.8, 0.4);
  }

  /** The storm is coming: a two-tone siren (long = shrinking now, else a short warning). */
  siren(long = true) {
    if (!this.ok()) return;
    const dur = long ? 1.8 : 0.9;
    const out = this.out(null, 0.12, 0, dur + 0.2);
    if (!out) return;
    const t = this.ctx.currentTime;
    const o = this.ctx.createOscillator();
    o.type = 'sawtooth';
    const steps = long ? 4 : 2;
    for (let i = 0; i < steps; i++) {
      o.frequency.setValueAtTime(i % 2 ? 640 : 860, t + (i * dur) / steps);
      o.frequency.linearRampToValueAtTime(i % 2 ? 860 : 640, t + ((i + 1) * dur) / steps);
    }
    const f = this.ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = 1800;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.35, t + 0.08);
    g.gain.setValueAtTime(0.35, t + dur - 0.2);
    g.gain.linearRampToValueAtTime(0.0001, t + dur);
    o.connect(f).connect(g).connect(out);
    o.start(t);
    o.stop(t + dur + 0.05);
  }

  pickup() {
    if (!this.ok()) return;
    const out = this.out(null, 0.35, 0, 0.2);
    if (!out) return;
    const t = this.ctx.currentTime;
    this.tone(out, t, 0.08, 'sine', 900, 1200, 0.3);
    this.tone(out, t + 0.06, 0.1, 'sine', 1300, 1600, 0.25);
  }

  chest(pos) {
    if (!this.ok()) return;
    const out = this.out(pos, 0.8, 50, 0.7);
    if (!out) return;
    const t = this.t0;
    [660, 880, 1100, 1320, 1760].forEach((f, i) => this.tone(out, t + i * 0.06, 0.4, 'sine', f, f, 0.18));
  }

  chestHum(pos, k) {
    // handled as a subtle shimmer occasionally
    if (!this.ok() || Math.random() > 0.02 * k) return;
    const out = this.out(pos, 0.15, 25, 0.5);
    if (!out) return;
    this.tone(out, this.t0, 0.5, 'sine', 1400 + Math.random() * 800, 1600, 0.1, 0.1);
  }

  heal(shield) {
    if (!this.ok()) return;
    const out = this.out(null, 0.4, 0, 0.5);
    if (!out) return;
    const t = this.ctx.currentTime;
    const base = shield ? 700 : 500;
    [0, 4, 7, 12].forEach((s, i) => this.tone(out, t + i * 0.07, 0.3, 'sine', base * Math.pow(2, s / 12), base * Math.pow(2, s / 12), 0.2));
  }

  ui(kind = 'click') {
    if (!this.ok()) return;
    const out = this.out(null, 0.3, 0, kind === 'victory' ? 1.2 : 0.6, false, true);
    if (!out) return;
    const t = this.ctx.currentTime;
    if (kind === 'click') this.tone(out, t, 0.06, 'triangle', 900, 700, 0.3);
    else if (kind === 'error') this.tone(out, t, 0.15, 'square', 200, 150, 0.15);
    else if (kind === 'victory') [523, 659, 784, 1047, 1319].forEach((f, i) => this.tone(out, t + i * 0.12, 0.6, 'triangle', f, f, 0.3));
    else if (kind === 'elim') [440, 330, 220].forEach((f, i) => this.tone(out, t + i * 0.15, 0.4, 'sawtooth', f, f * 0.9, 0.12));
    else if (kind === 'bus') {
      // the battle bus horn: two honks
      for (const [d, len] of [[0, 0.22], [0.3, 0.45]]) {
        this.tone(out, t + d, len, 'square', 349, 345, 0.14, 0.02);
        this.tone(out, t + d, len, 'square', 440, 436, 0.12, 0.02);
        this.tone(out, t + d, len, 'sawtooth', 175, 173, 0.1, 0.02);
      }
    } else if (kind === 'glider') { this.noiseBurst(out, t, 0.3, 'bandpass', 800, 1, 0.5, 0.02); this.tone(out, t, 0.2, 'sine', 400, 900, 0.2); }
  }
}
