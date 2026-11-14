// The admin watching a match (stage E): SPECTATE in the admin panel (js/ui/admin.js) joins that
// party as an OBSERVER, never as a player. The hello carries an 'observe' envelope signed with the
// admin key for that party code (AdminSession.observeHello); the host's page checks the signature
// before its room lets it in (js/net/p2p.js verifyObserver). An observer is in no roster, never
// spawns and doesn't count toward the party size; it hears what a spectator hears and uses the
// game's spectate camera. Moderation is open: everyone in that party sees "👁 Admin is watching"
// for as long as the admin is there (js/admin/notes.js).
//   app.adminWatch.start(code)   join party `code` to watch -> Promise<bool>
//   app.adminWatch.stop(note)    back to a party of one (LEAVE)
// The bar at the bottom: "👁 SPECTATING <name>" with ◀ ▶ (who to watch), 💬 (the party chat:
// app.chat.open(), js/ui/chat.js; the admin's lines go out as an observer's, so everyone in the
// party sees them as 🛡 Admin) and LEAVE.
// A dropped link (a Wi-Fi blip, an iPad that froze) comes back like a player's does: the link
// rejoins with a freshly signed observe hello (the host takes each one once, and at most 2 minutes
// old, so one copied off the relay is worth nothing), and the room's fresh welcome rebuilds the view.
import { P2PClient } from '../net/p2p.js';
import { LocalNet } from '../net/net.js';
import { awaitWelcome } from './invite.js';

const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const CODE_RE = /^[A-Z]{4}$/;
const LABEL_MS = 250; // the bar's name is looked at 4 times a second

export class AdminWatch {
  constructor(app) {
    this.app = app;
    this.busy = false;
    this.el = null;
    this.labelT = 0;
    this.shown = '';
  }

  /** The observer game, while the admin is watching a party. */
  get game() {
    const g = this.app.game;
    return g && g.observer && !g.disposed ? g : null;
  }

  /** SPECTATE: watch party `code` (a P2P party: its host's page runs the room). */
  async start(code) {
    const app = this.app, s = app.admin;
    code = String(code || '').toUpperCase();
    if (!s || this.busy || !CODE_RE.test(code)) return false;
    if (this.game && this.game.code === code) { app.showStage(false); this.bar(true); return true; }
    this.busy = true;
    app.lobby.netStatus(`👁 Joining party ${code} to watch…`);
    let net = null;
    try {
      const hello = app.hello({ name: 'Admin', observer: await s.observeHello(code) });
      // (no resume token: an observer is not a player the room holds a spot for)
      delete hello.resume;
      net = new P2PClient(code, hello);
      net.onStatus = (text) => app.lobby.netStatus(text);
      const res = await awaitWelcome(net, () => net.connect(), 25000);
      net.onStatus = null;
      const w = res.buf.find((m) => m.t === 'welcome');
      if (!w || w.observer !== true) {
        res.off();
        throw new Error("That party's game is on an older version: it can't be watched. Ask everyone to reload.");
      }
      // leaving my own party for it (a party I host ends for its friends)
      if (app.partyKind() !== 'solo') app.saveResume(true);
      app.warming = false;
      app.enterParty(net, { replay: res.buf, off: res.off });
      if (!this.game) return false; // (the welcome turned it away: a different island or version)
      // a dropped link gets back in with a hello signed just for that rejoin (each one works once)
      net.rejoin = async () => {
        const adm = app.admin;
        return adm ? { t: 'join', code, hello: { ...hello, observer: await adm.observeHello(code) } } : null;
      };
      if (app.ui.modalOpen()) app.ui.closeModal(true);
      app.showStage(false);
      this.bar(true);
      app.lobby.toast(`👁 Watching party <b>${esc(code)}</b>. Everyone there sees that the admin is watching.`, { ms: 6000 });
      return true;
    } catch (e) {
      try { if (net) net.close(false); } catch (e2) { /* closing */ }
      app.lobby.toast(esc((e && e.message) || 'Could not watch that party.'), { kind: 'bad', ms: 9000 });
      return false;
    } finally {
      this.busy = false;
      app.lobby.netStatus('');
    }
  }

  /** LEAVE (or the party went away): back to a party of one on the lobby stage. */
  stop(note = 'You stopped watching.', kind = '') {
    const app = this.app;
    this.bar(false);
    if (this.game) {
      app.saveResume(true);
      app.enterParty(new LocalNet(app.hello()));
    }
    app.warming = false;
    app.showStage(true);
    if (note) app.lobby.toast(esc(note), { kind, ms: 5000 });
  }

  /** The watched party's messages (js/admin/notes.js passes them on, observer games only). */
  onMessage(m, game) {
    if (game !== this.game) return;
    if (m.t === 'partyend') this.app.later(game, () => this.stop('The party you were watching ended.'));
    else if (m.t === '_net') {
      const lobby = this.app.lobby;
      if (m.state === 'reconnecting') lobby.netStatus('👁 Lost the link — getting back to watching…');
      else if (m.state === 'stall') lobby.netStatus('Waiting for the host…');
      else if (m.state === 'online' || m.state === 'lost') lobby.netStatus('');
      else if (m.state === 'fresh' && m.msg) this.rewatch(game, m.msg);
    }
  }

  /** Back in after a dropped link: the room's new welcome rebuilds the view (like main.js onNet). */
  rewatch(game, w) {
    const app = this.app, net = game.net, buf = [];
    const off = net.onMessage((x) => { if (x.t !== '_net') buf.push(x); });
    app.lobby.netStatus('');
    app.later(game, () => {
      if (w.observer !== true) { off(); this.stop("Couldn't get back to watching.", 'bad'); return; }
      app.enterParty(net, { replay: [w, ...buf], off });
      if (!this.game) return;
      app.showStage(false);
      this.bar(true);
      app.lobby.toast('👁 Back to watching.', { ms: 3000 });
    });
    setTimeout(off, 1000); // in case the party changed meanwhile
  }

  /** Every frame of the observer game: who is being watched. */
  frame(game, dt) {
    if (game !== this.game) return;
    this.labelT -= dt * 1000;
    if (this.labelT > 0) return;
    this.labelT = LABEL_MS;
    const el = this.ensure();
    if (el.classList.contains('hidden')) this.bar(true);
    let name = '', sub;
    if (game.phase === 'lobby') sub = `Party ${game.code} is in the lobby`;
    else if (game.phase === 'ended') sub = `Party ${game.code} · the match is over`;
    else {
      const id = game.spectateId;
      const row = id ? game.roster.get(id) : null;
      name = row ? row.name : '';
      if (!name && game.phase === 'bus') sub = `Party ${game.code} · everyone is on the bus`;
      else sub = `Party ${game.code} · ${game.aliveCount | 0} left`;
      if (row && row.bot) name += ' (bot)';
    }
    const key = `${name}|${sub}`;
    if (key === this.shown) return;
    this.shown = key;
    $('.aw-name', el).textContent = name || '—';
    $('.aw-sub', el).textContent = sub;
  }

  /** The observer bar on (true) or off. */
  bar(on) {
    const el = this.ensure();
    el.classList.toggle('hidden', !on);
    document.body.classList.toggle('observing', !!on);
    this.shown = '';
    this.labelT = 0;
  }

  ensure() {
    if (this.el) return this.el;
    const el = document.createElement('div');
    el.id = 'adminwatch';
    el.className = 'hidden';
    el.innerHTML = `<div class="aw-info"><div class="aw-top"><span class="aw-tag">👁 SPECTATING</span><b class="aw-name">—</b></div><div class="aw-sub"></div></div>
      <div class="aw-btns"><button class="aw-prev" aria-label="Watch the previous player">◀</button><button class="aw-next" aria-label="Watch the next player">▶</button><button class="aw-chat" aria-label="Chat with this party (everyone sees you as the admin)">💬</button><button class="aw-leave">LEAVE</button></div>`;
    for (const ev of ['pointerdown', 'touchstart']) el.addEventListener(ev, (e) => e.stopPropagation());
    const step = (dir) => {
      const g = this.game;
      if (!g) return;
      if (this.app.sfx) this.app.sfx.ui();
      g.cycleSpectate(dir);
      this.labelT = 0;
    };
    $('.aw-prev', el).addEventListener('click', () => step(-1));
    $('.aw-next', el).addEventListener('click', () => step(1));
    $('.aw-leave', el).addEventListener('click', () => { if (this.app.sfx) this.app.sfx.ui(); this.stop(); });
    // the party chat, as the admin (an older build without app.chat: the button stays hidden)
    const chat = $('.aw-chat', el);
    chat.classList.toggle('hidden', !(this.app.chat && typeof this.app.chat.open === 'function'));
    chat.addEventListener('click', () => {
      const c = this.app.chat;
      if (!c || typeof c.open !== 'function') return;
      if (this.app.sfx) this.app.sfx.ui();
      if (typeof c.isOpen === 'function' && c.isOpen() && typeof c.close === 'function') c.close(); else c.open();
    });
    document.body.appendChild(el);
    this.el = el;
    return el;
  }
}
