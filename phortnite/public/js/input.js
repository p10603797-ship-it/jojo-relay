// Unified input: keyboard + mouse (pointer lock), touch (iPad) and gamepad.
// Produces one simple per-frame state object the game reads.
//
// Touch building ("Build immediately", settings.tapBuild): a tap on Wall / Ramp / Floor / Cone sets
// s.build and s.buildFire, which places the piece at once; holding the button sets s.buildHold,
// which turbo-builds (Combatant.act) while you turn (drag on the button) or walk.
// Edit: s.edit is the EDIT button, G, or holding B on a gamepad (js/world/buildClient.js decides
// whether there is something to edit; G changes material when there isn't).

const KEYS = {
  forward: ['KeyW', 'ArrowUp'], back: ['KeyS', 'ArrowDown'], left: ['KeyA', 'ArrowLeft'], right: ['KeyD', 'ArrowRight'],
  jump: ['Space'], sprint: ['ShiftLeft', 'ShiftRight'], crouch: ['ControlLeft'], crouchToggle: ['KeyX'],
  reload: ['KeyR'], interact: ['KeyE'], wall: ['KeyQ'], floor: ['KeyZ'], ramp: ['KeyC'], cone: ['KeyV'], build: ['KeyB'],
  mat: ['KeyG'], edit: ['KeyG'], map: ['KeyM'], pickaxe: ['KeyF', 'Digit0'], menu: ['Escape', 'KeyP'],
};

// touch piece buttons -> piece type
const PIECE_BTNS = [['wall', 'w'], ['ramp', 'r'], ['floor', 'f'], ['cone', 'c']];
// what the big fire button says for each context (Input.setContext)
const FIRE_FACE = {
  gun: '<span class="ico">✛</span>',
  melee: '<span class="ico">⛏</span><small>HIT</small>',
  heal: '<span class="ico">✚</span><small>USE</small>',
  build: '<span class="ico">▣</span><small>PLACE</small>',
};
const PAD_EDIT_HOLD = 0.3; // s holding B (gamepad) to edit

function el(tag, cls, html = '', parent = null) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html) e.innerHTML = html;
  if (parent) parent.appendChild(e);
  return e;
}

export class Input {
  constructor(canvas, touchRoot, settings) {
    this.canvas = canvas;
    this.settings = settings;
    this.down = new Set();
    this.pressed = new Set();
    this.mouseDX = 0;
    this.mouseDY = 0;
    this.mouseL = false;
    this.mouseR = false;
    this.mouseLPressed = false;
    this.mouseRPressed = false;
    this.wheel = 0;
    this.locked = false;
    this.enabled = false;
    this.touchMode = false;
    this.lookDev = ''; // device of the latest look input: 'mouse' | 'touch' | 'pad' (aim assist is for thumbs only)
    this.s = this.blank();
    this.crouchToggle = false;

    // touch state
    this.joy = { id: -1, ox: 0, oy: 0, x: 0, y: 0 };
    this.looks = new Map(); // pointerId -> {x, y}
    this.touchLookX = 0;
    this.touchLookY = 0;
    this.tbtn = new Set();
    this.tpressed = new Set();
    this.ctx = '';
    this.ctxFlags = '';
    this.interactKey = '';
    this.tbScale = -1;
    this.tbAlpha = -1;
    this.padBT = 0; // when the gamepad's B button went down (ms), 0 = up
    this.padBFired = false;

    window.addEventListener('keydown', (e) => this.onKey(e, true));
    window.addEventListener('keyup', (e) => this.onKey(e, false));
    window.addEventListener('blur', () => { this.down.clear(); this.mouseL = this.mouseR = false; });
    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === this.canvas;
      if (!this.locked) { this.mouseL = this.mouseR = false; }
      this.onLockChange && this.onLockChange(this.locked);
    });
    canvas.addEventListener('mousedown', (e) => {
      if (this.touchMode) return;
      if (!this.locked) { this.requestLock(); return; }
      if (e.button === 0) { this.mouseL = true; this.mouseLPressed = true; }
      if (e.button === 2) { this.mouseR = true; this.mouseRPressed = true; }
    });
    window.addEventListener('mouseup', (e) => {
      if (e.button === 0) this.mouseL = false;
      if (e.button === 2) this.mouseR = false;
    });
    window.addEventListener('mousemove', (e) => {
      if (!this.locked) return;
      // guard against the occasional huge spike some browsers emit
      if (Math.abs(e.movementX) > 400 || Math.abs(e.movementY) > 400) return;
      this.mouseDX += e.movementX;
      this.mouseDY += e.movementY;
    });
    canvas.addEventListener('wheel', (e) => { this.wheel += Math.sign(e.deltaY); e.preventDefault(); }, { passive: false });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());

    this.buildTouchUI(touchRoot);
    window.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'touch' && !this.touchMode) this.setTouchMode(true);
      if (e.pointerType === 'mouse' && this.touchMode && !this.forceTouch) this.setTouchMode(false);
    }, true);
  }

  blank() {
    return {
      mx: 0, my: 0, lookX: 0, lookY: 0, fire: false, firePressed: false, ads: false, adsPressed: false, jump: false, crouch: false,
      sprint: false, reload: false, interact: false, slot: -1, build: null, buildToggle: false, matCycle: false,
      map: false, menu: false, scroll: 0, interactHeld: false, emote: false,
      buildFire: false, buildHold: false, edit: false, editPad: false,
    };
  }

  requestLock() {
    if (this.touchMode) return;
    try {
      const p = this.canvas.requestPointerLock({ unadjustedMovement: true });
      if (p && p.catch) p.catch(() => { try { this.canvas.requestPointerLock(); } catch (e) { /* ignore */ } });
    } catch (e) {
      try { this.canvas.requestPointerLock(); } catch (e2) { /* ignore */ }
    }
  }

  exitLock() { if (document.pointerLockElement) document.exitPointerLock(); }

  onKey(e, isDown) {
    const tag = e.target && e.target.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
    if (isDown) {
      if (!this.down.has(e.code)) this.pressed.add(e.code);
      this.down.add(e.code);
      if (this.enabled && (e.code === 'Space' || e.code.startsWith('Arrow') || e.code === 'Tab')) e.preventDefault();
    } else this.down.delete(e.code);
  }

  any(list, set = this.down) { return list.some((k) => set.has(k)); }

  setTouchMode(on) {
    this.touchMode = on;
    document.body.classList.toggle('touch', on);
    if (on) this.exitLock();
  }

  // ------------------------------------------------------------------ touch UI
  buildTouchUI(root) {
    this.troot = root;
    const joyZone = el('div', 'tz tz-move', '', root);
    const lookZone = el('div', 'tz tz-look', '', root);
    this.joyBase = el('div', 'joy-base', '<div class="joy-knob"></div>', root);
    this.joyKnob = this.joyBase.firstChild;

    const onJoyDown = (e) => {
      if (this.joy.id !== -1) return;
      e.preventDefault();
      this.joy.id = e.pointerId;
      this.joy.ox = e.clientX; this.joy.oy = e.clientY; this.joy.x = 0; this.joy.y = 0;
      this.joyBase.style.left = `${e.clientX}px`;
      this.joyBase.style.top = `${e.clientY}px`;
      this.joyBase.classList.add('on');
      joyZone.setPointerCapture(e.pointerId);
    };
    joyZone.addEventListener('pointerdown', onJoyDown);
    joyZone.addEventListener('pointermove', (e) => {
      if (e.pointerId !== this.joy.id) return;
      const R = 60;
      let dx = e.clientX - this.joy.ox, dy = e.clientY - this.joy.oy;
      const l = Math.hypot(dx, dy);
      if (l > R * 1.6) {
        // drag the joystick origin along so it never feels stuck
        this.joy.ox = e.clientX - (dx / l) * R * 1.6;
        this.joy.oy = e.clientY - (dy / l) * R * 1.6;
        this.joyBase.style.left = `${this.joy.ox}px`;
        this.joyBase.style.top = `${this.joy.oy}px`;
        dx = e.clientX - this.joy.ox; dy = e.clientY - this.joy.oy;
      }
      const k = Math.min(1, Math.hypot(dx, dy) / R);
      const a = Math.atan2(dy, dx);
      this.joy.x = Math.cos(a) * k;
      this.joy.y = Math.sin(a) * k;
      this.joyKnob.style.transform = `translate(${Math.cos(a) * k * R}px, ${Math.sin(a) * k * R}px)`;
    });
    const joyUp = (e) => {
      if (e.pointerId !== this.joy.id) return;
      this.joy.id = -1; this.joy.x = 0; this.joy.y = 0;
      this.joyBase.classList.remove('on');
      this.joyKnob.style.transform = '';
    };
    joyZone.addEventListener('pointerup', joyUp);
    joyZone.addEventListener('pointercancel', joyUp);
    joyZone.addEventListener('lostpointercapture', joyUp);

    const lookDown = (e) => {
      e.preventDefault();
      this.looks.set(e.pointerId, { x: e.clientX, y: e.clientY });
      e.currentTarget.setPointerCapture(e.pointerId);
    };
    const lookMove = (e) => {
      const l = this.looks.get(e.pointerId);
      if (!l) return;
      this.touchLookX += e.clientX - l.x;
      this.touchLookY += e.clientY - l.y;
      l.x = e.clientX; l.y = e.clientY;
    };
    const lookUp = (e) => { this.looks.delete(e.pointerId); };
    lookZone.addEventListener('pointerdown', lookDown);
    lookZone.addEventListener('pointermove', lookMove);
    lookZone.addEventListener('pointerup', lookUp);
    lookZone.addEventListener('pointercancel', lookUp);
    lookZone.addEventListener('lostpointercapture', lookUp);

    // buttons: [name, label, class, alsoLook]. Piece buttons also turn the view, so you can hold
    // one and drag to turbo-build round a corner. Layout: css/style.css (Touch HUD 2.0).
    const defs = [
      ['fire', FIRE_FACE.gun, 'tb-fire', true],
      ['fire2', '<span class="ico">✛</span>', 'tb-fire2', false],
      ['jump', '<span class="ico">⤒</span><small class="jl">JUMP</small>', 'tb-jump', false],
      ['crouch', '<span class="ico">⤓</span>', 'tb-crouch', false],
      ['ads', '<span class="ico">◎</span>', 'tb-ads', true],
      ['reload', '<span class="ico">⟳</span>', 'tb-reload', false],
      ['build', '<span class="ico">⚒</span><small>Build</small>', 'tb-build', false],
      ['wall', '<span class="ico">▮</span><small>Wall</small>', 'tb-wall bonly', true],
      ['ramp', '<span class="ico">◢</span><small>Ramp</small>', 'tb-ramp bonly', true],
      ['floor', '<span class="ico">▬</span><small>Floor</small>', 'tb-floor bonly', true],
      ['cone', '<span class="ico">▲</span><small>Cone</small>', 'tb-cone bonly', true],
      ['edit', '<span class="ico">✎</span><small>Edit</small>', 'tb-edit', false],
      ['mat', '<span class="ico">⛏</span><small>Mat</small>', 'tb-mat bonly', false],
      ['interact', '<span class="lbl">Pick up</span><b class="nm"></b>', 'tb-interact', false],
      ['emote', '<span class="ico">💃</span>', 'tb-emote', false],
    ];
    this.tbEls = {};
    for (const [name, html, cls, alsoLook] of defs) {
      const b = el('div', `tbtn ${cls}`, html, root);
      this.tbEls[name] = b;
      b.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        b.setPointerCapture(e.pointerId);
        const key = name === 'fire2' ? 'fire' : name;
        this.tbtn.add(key);
        this.tpressed.add(key);
        b.classList.add('down');
        if (alsoLook) this.looks.set(e.pointerId, { x: e.clientX, y: e.clientY });
      });
      const up = (e) => {
        const key = name === 'fire2' ? 'fire' : name;
        this.tbtn.delete(key);
        b.classList.remove('down');
        this.looks.delete(e.pointerId);
      };
      b.addEventListener('pointermove', lookMove);
      b.addEventListener('pointerup', up);
      b.addEventListener('pointercancel', up);
      b.addEventListener('lostpointercapture', up);
    }
  }

  /** Forget toggles and any touches in flight (used on death / match start / respawn). */
  resetToggles() {
    this.crouchToggle = false;
    this.touchAds = false;
    this.tbtn.clear();
    this.looks.clear();
    this.joy.id = -1; this.joy.x = 0; this.joy.y = 0;
    if (this.joyBase) { this.joyBase.classList.remove('on'); this.joyKnob.style.transform = ''; }
    if (this.tbEls) for (const b of Object.values(this.tbEls)) b.classList.remove('down');
  }

  /** The touch interact button: action ('Pick up', 'Swap', 'Open') or '' to hide. Writes only on change. */
  setInteractLabel(text) {
    const b = this.tbEls && this.tbEls.interact;
    if (!b || text === this.interactLabel) return;
    this.interactLabel = text;
    if (text) {
      b.firstChild.textContent = text;
      b.classList.add('show');
    } else b.classList.remove('show');
  }

  /** What the interact button would pick up: its name and rarity (0-4, -1 = none, 5 = chest gold). */
  setInteractItem(name, r) {
    const b = this.tbEls && this.tbEls.interact;
    const key = `${name}|${r}`;
    if (!b || key === this.interactKey) return;
    this.interactKey = key;
    b.lastChild.textContent = name || '';
    b.classList.toggle('named', !!name);
    for (let i = -1; i <= 5; i++) b.classList.toggle(`r${i < 0 ? 'n' : i}`, i === r);
  }

  /**
   * What the player is doing, for the touch buttons (one body class, written only on change):
   * ctx 'gun' | 'melee' | 'heal' | 'build' | 'bus' | 'sky' | 'dead' | '' and flags: full (the magazine
   * is full: reload dims), edit (a piece of yours to edit is under the crosshair), editing (the edit
   * choices are open).
   */
  setContext(ctx, full = false, edit = false, editing = false) {
    const flags = `${full ? 1 : 0}${edit ? 1 : 0}${editing ? 1 : 0}`;
    if (ctx === this.ctx && flags === this.ctxFlags) return;
    const cl = document.body.classList;
    if (ctx !== this.ctx) {
      if (this.ctx) cl.remove(`ctx-${this.ctx}`);
      if (ctx) cl.add(`ctx-${ctx}`);
      this.ctx = ctx;
      const face = FIRE_FACE[ctx] || FIRE_FACE.gun;
      const f = this.tbEls && this.tbEls.fire;
      if (f && f.innerHTML !== face) f.innerHTML = face;
    }
    this.ctxFlags = flags;
    cl.toggle('ctx-full', full);
    cl.toggle('ctx-canedit', edit);
    cl.toggle('ctx-editing', editing);
  }

  setBuildMode(on) { document.body.classList.toggle('building', !!on); }

  /** Button size / opacity settings (tbScale 0.8-1.3, tbAlpha 0.3-1) as CSS variables on #touch. */
  applyButtonLook() {
    const st = this.settings;
    const sc = Math.max(0.8, Math.min(1.3, Number(st.tbScale) || 1));
    const al = Math.max(0.3, Math.min(1, Number(st.tbAlpha) || 1));
    if (sc === this.tbScale && al === this.tbAlpha) return;
    this.tbScale = sc;
    this.tbAlpha = al;
    if (this.troot) {
      this.troot.style.setProperty('--tb-scale', String(sc));
      this.troot.style.setProperty('--tb-alpha', String(al));
    }
    // (the HUD outside the buttons makes room for bigger ones: the elimination banner)
    if (typeof document !== 'undefined' && document.documentElement) document.documentElement.style.setProperty('--ui-tb-scale', String(sc));
  }

  // ------------------------------------------------------------------ per frame
  update() {
    const s = this.blank();
    const st = this.settings;
    this.applyButtonLook();
    if (!this.enabled) {
      this.mouseDX = this.mouseDY = 0;
      this.touchLookX = this.touchLookY = 0;
      this.pressed.clear();
      this.tpressed.clear();
      this.wheel = 0;
      this.mouseLPressed = this.mouseRPressed = false;
      this.s = s;
      return s;
    }
    const D = this.down, P = this.pressed;
    // keyboard + mouse
    s.mx = (this.any(KEYS.right) ? 1 : 0) - (this.any(KEYS.left) ? 1 : 0);
    s.my = (this.any(KEYS.forward) ? 1 : 0) - (this.any(KEYS.back) ? 1 : 0);
    const ms = 0.0022 * st.sens;
    if (this.mouseDX || this.mouseDY) this.lookDev = 'mouse';
    s.lookX = -this.mouseDX * ms;
    s.lookY = -this.mouseDY * ms * (st.invertY ? -1 : 1);
    s.fire = this.mouseL;
    s.firePressed = this.mouseLPressed;
    s.ads = this.mouseR;
    s.adsPressed = this.mouseRPressed;
    s.jump = this.any(KEYS.jump, P);
    s.sprint = this.any(KEYS.sprint);
    if (this.any(KEYS.crouchToggle, P)) this.crouchToggle = !this.crouchToggle;
    s.crouch = this.any(KEYS.crouch) || this.crouchToggle;
    s.reload = this.any(KEYS.reload, P);
    s.interact = this.any(KEYS.interact, P);
    s.interactHeld = this.any(KEYS.interact);
    if (this.any(KEYS.wall, P)) s.build = 'w';
    if (this.any(KEYS.floor, P)) s.build = 'f';
    if (this.any(KEYS.ramp, P)) s.build = 'r';
    if (this.any(KEYS.cone, P)) s.build = 'c';
    s.buildToggle = this.any(KEYS.build, P);
    s.matCycle = this.any(KEYS.mat, P);
    s.edit = this.any(KEYS.edit, P);
    s.map = this.any(KEYS.map, P);
    s.menu = this.any(['KeyP'], P);
    s.emote = P.has('KeyT');
    if (this.any(KEYS.pickaxe, P)) s.slot = 0;
    for (let i = 1; i <= 5; i++) if (P.has(`Digit${i}`)) s.slot = i;
    s.scroll = this.wheel;

    // touch
    if (this.touchMode) {
      const ts = 0.0052 * st.touchSens;
      if (this.touchLookX || this.touchLookY) this.lookDev = 'touch';
      s.lookX += -this.touchLookX * ts;
      s.lookY += -this.touchLookY * ts * (st.invertY ? -1 : 1);
      if (this.joy.id !== -1) {
        s.mx = this.joy.x;
        s.my = -this.joy.y;
        if (Math.hypot(this.joy.x, this.joy.y) > 0.92 && s.my > 0.5) s.sprint = true;
      }
      const T = this.tbtn, TP = this.tpressed;
      if (T.has('fire')) s.fire = true;
      if (TP.has('fire')) s.firePressed = true;
      if (TP.has('jump')) s.jump = true;
      if (TP.has('crouch')) this.crouchToggle = !this.crouchToggle;
      s.crouch = s.crouch || this.crouchToggle;
      if (TP.has('ads')) { this.touchAds = !this.touchAds; s.adsPressed = true; }
      if (this.touchAds) s.ads = true;
      if (TP.has('reload')) s.reload = true;
      if (TP.has('build')) s.buildToggle = true;
      // Build immediately: the tap places the piece, holding keeps placing (turbo build)
      const tap = st.tapBuild !== false;
      for (const [btn, t] of PIECE_BTNS) {
        if (TP.has(btn)) { s.build = t; if (tap) s.buildFire = true; }
        if (tap && T.has(btn)) s.buildHold = true;
      }
      if (TP.has('edit')) s.edit = true;
      if (TP.has('mat')) s.matCycle = true;
      if (TP.has('interact')) s.interact = true;
      if (TP.has('emote')) s.emote = true;
      if (T.has('interact')) s.interactHeld = true;
    }

    // gamepad
    this.pollGamepad(s);

    this.mouseDX = this.mouseDY = 0;
    this.touchLookX = this.touchLookY = 0;
    this.wheel = 0;
    this.mouseLPressed = this.mouseRPressed = false;
    this.pressed.clear();
    this.tpressed.clear();
    this.s = s;
    return s;
  }

  pollGamepad(s) {
    let pads;
    try { pads = navigator.getGamepads ? navigator.getGamepads() : null; } catch (e) { pads = null; }
    if (!pads) return;
    const gp = [...pads].find((p) => p && p.connected);
    if (!gp) return;
    const dz = (v) => (Math.abs(v) < 0.15 ? 0 : v);
    const ax = gp.axes;
    const btn = (i) => !!(gp.buttons[i] && gp.buttons[i].pressed);
    this.padPrev = this.padPrev || [];
    const edge = (i) => btn(i) && !this.padPrev[i];
    const lx = dz(ax[0] || 0), ly = dz(ax[1] || 0), rx = dz(ax[2] || 0), ry = dz(ax[3] || 0);
    if (lx || ly) { s.mx = lx; s.my = -ly; }
    if (rx || ry || btn(6) || btn(7)) this.lookDev = 'pad';
    const k = 0.055 * this.settings.sens;
    s.lookX += -rx * Math.abs(rx) * k;
    s.lookY += -ry * Math.abs(ry) * k * (this.settings.invertY ? -1 : 1);
    if (btn(7)) s.fire = true;
    if (edge(7)) s.firePressed = true;
    if (btn(6)) s.ads = true;
    if (edge(6)) s.adsPressed = true; // in build mode: next material
    if (edge(0)) s.jump = true;
    // B: a tap crouches (on release), holding it edits (no crouch flicker while it is held)
    if (btn(1)) {
      const now = performance.now();
      if (!this.padBT) this.padBT = now;
      if (!this.padBFired && now - this.padBT >= PAD_EDIT_HOLD * 1000) { s.edit = true; s.editPad = true; this.padBFired = true; }
    } else {
      if (this.padBT && !this.padBFired) this.crouchToggle = !this.crouchToggle;
      this.padBT = 0; this.padBFired = false;
    }
    if (edge(2)) s.reload = true;
    if (edge(3)) s.buildToggle = true;
    if (edge(5)) s.scroll += 1;
    if (edge(4)) s.scroll -= 1;
    if (btn(10)) s.sprint = true;
    if (edge(12)) s.build = 'w';
    if (edge(13)) s.build = 'f';
    if (edge(14)) s.build = 'r';
    if (edge(15)) s.build = 'c';
    if (edge(11)) s.matCycle = true;
    if (edge(2) && btn(2)) s.interact = true;
    if (edge(9)) s.menu = true;
    s.crouch = s.crouch || this.crouchToggle;
    this.padPrev = gp.buttons.map((b) => b.pressed);
  }
}
