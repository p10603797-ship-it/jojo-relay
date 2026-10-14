// Every page's side of the admin (when the website has an admin.json): it seals this page's player
// card for the admin, listens for Philip's signed commands on the live player count's broker
// connection, and carries out the ones meant for it, always telling the player on screen that it
// came from the admin. Moderation is open, never secret.
//   startAdmin(app, cfg)      boot (main.js): app.adminCfg, app.adminClient, app.adminLogin, and
//                             admin mode again when this iPad remembers the keys
//   fetchAdminConfig()        admin.json next to index.html, checked (null: no admin features at all)
// What each command does here (js/admin/commands.js has who may send what):
//   banner (state)        Philip's banner box (js/ui/announce.js setAdmin), lobby and matches
//   maintenance (state)   a full-screen "Philip is working on the game": out of any party / match,
//                         no PLAY until it is off (the admin's own page gets a chip instead)
//   reload                "Updating the game…", then freshReload()
//   message               a "Message from the admin" card
//   kick                  back to the solo lobby: "The admin removed you from the match / party."
//                         (a party this page hosts hears first that the admin removed its host)
//   ban                   the lock screen's ban (js/admin/ban.js), then a reload onto its ban screen
//   rename / grant / resetStats   the signed-in account (a guest: this visit only)
//   end / pause / mode    on a party host's page (its room runs here): the room does it, and the
//                         party hears it as a room message {t: 'admin', env} (the signed envelope:
//                         members check it too, and that it names their party) -> "The admin
//                         ended the match" etc.
// Every page makes its own ECDH key for this page load (js/admin/keys.js newBoxKey): its public half
// goes in the sealed card, and the private parts of a command for this page are sealed to it, so
// only this page can open them (js/admin/commands.js).
// The admin panel (js/ui/admin.js, app.adminPanel) and SPECTATE (js/ui/adminWatch.js, app.adminWatch)
// are made here too; a party this page hosts checks observer hellos with .observerCheck.
// API used by the panel / stage E: app.adminClient.card() (this page's card),
// .stateNow() ({banner, maintenance}), .chip(key, text|null) (a small persistent chip, e.g. stage E's
// '👁 Admin is watching'), .notify(html, kind).
import { VERSION } from '../../shared/constants.js';
import { findMode } from '../../shared/modes/index.js';
import { defaultStats, addXp } from '../accounts/stats.js';
import { freshReload } from '../ui/announce.js';
import { AdminLoginUi } from '../ui/adminLogin.js';
import { AdminPanel } from '../ui/admin.js';
import { AdminWatch } from '../ui/adminWatch.js';
import { loadConfig, importPublic, sealToAdmin, newBoxKey } from './keys.js';
import {
  CMD_TOPIC, STATE_PREFIX, STATE_TOPICS, STATE_KINDS, PARTY_CMDS, CommandGate, Lru, stateActive, makeObserverCheck, partyNote,
} from './commands.js';
import { readBan, writeBan, isBanned, underLock, readBanBy } from './ban.js';
import { AdminSession, rememberedKeys } from './session.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const CARD_MS = 2000; // the card is looked at this often (presence says it again no sooner than its own gap)
const LIVE = new Set(['bus', 'match', 'ended', 'round']);
// the newest banner / maintenance this device accepted ({kind: {ts, n}}): an older one someone
// replays on the broker is never taken again, not even after a reload
const MARK_KEY = 'phortnite.adminState';
// commands for everyone ('*') this tab already carried out: a replayed 'reload everyone' can't loop
const ALL_KEY = 'phortnite.adminAll';
const REPUBLISH_MS = 10000; // the admin's page puts his newest state back on the broker at most this often

/** admin.json next to the page, checked. null when there is none (or it is broken): no admin at all. */
export async function fetchAdminConfig() {
  try {
    const r = await fetch(`admin.json?t=${Date.now()}`, { cache: 'no-store' });
    if (!r.ok) return null;
    return loadConfig(await r.text());
  } catch (e) { return null; }
}

/** Boot: the admin features for this page (call once presence exists). Never throws. */
export async function startAdmin(app, cfg) {
  try {
    if (!cfg || app.adminClient) return null;
    const pubs = await importPublic(cfg);
    const client = new AdminClient(app, cfg, pubs);
    app.adminCfg = cfg;
    app.adminClient = client;
    app.adminLogin = new AdminLoginUi(app, cfg, pubs);
    // admin mode's panel and its SPECTATE view (both do nothing until the keys are unlocked)
    app.adminPanel = new AdminPanel(app);
    app.adminWatch = new AdminWatch(app);
    client.start();
    // the "Who's playing?" screen is usually up already: its admin note and button go in now
    if (typeof document !== 'undefined') document.querySelectorAll('#modal .acc-adminrow').forEach((row) => app.adminLogin.bits(row));
    // keys remembered on this iPad: admin mode again, no password
    const keys = await rememberedKeys(cfg, pubs);
    if (keys && !app.admin) app.adminLogin.enter(new AdminSession(app, { cfg, pubs, keys, remembered: true }), { quiet: false });
    return client;
  } catch (e) {
    console.error('admin', e);
    return null;
  }
}

export class AdminClient {
  constructor(app, cfg, pubs) {
    this.app = app;
    this.cfg = cfg;
    this.pubs = pubs;
    this.gate = new CommandGate({ signPub: pubs.signPub });
    // a party this page hosts lets the admin watch only with this check (js/net/p2p.js verifyObserver):
    // each signed hello lets one connection in
    this.observerCheck = makeObserverCheck(pubs.signPub);
    this.ran = new Lru(100); // party commands this page's room carried out (its own room message is not news)
    this.notes = new Lru(200); // party room messages already shown
    this.since = Date.now();
    this.pageKey = null; // this page load's own key (newBoxKey): { priv, pub, raw }
    this.states = { banner: null, maintenance: null }; // { args, ts, n, env } of the newest signed state
    this.marks = readJson(localStore(), MARK_KEY) || {};
    this.republished = {};
    // (a reloaded tab still knows the '*' commands it carried out)
    this.allDone = Array.isArray(readJson(sessionStore(), ALL_KEY)) ? readJson(sessionStore(), ALL_KEY).slice(-50) : [];
    for (const n of this.allDone) if (typeof n === 'string') this.gate.nonces.add(n);
    this.cardKey = '';
    this.sealing = false;
    this.chips = new Map();
    this.layer = null;
  }

  start() {
    const p = this.app.presence;
    if (p) {
      this.offs = [
        p.listen(CMD_TOPIC, (text) => { this.onCmd(text); }),
        // (the two exact topics: junk parked under made-up ones never reaches this page)
        ...STATE_TOPICS.map((t) => p.listen(t, (text, topic) => { this.onState(text, topic); })),
      ];
    }
    // this page load's own key first: the card carries its public half, commands for this page open with it
    this.keyReady = newBoxKey().then((k) => {
      this.pageKey = k;
      this.gate.pageKey = k.priv;
      this.refreshCard();
    }).catch((e) => console.error('admin page key', e));
    this.cardTimer = setInterval(() => this.refreshCard(), CARD_MS);
    // a banner or maintenance whose time is up goes by itself
    this.stateTimer = setInterval(() => this.applyStates(), 5000);
    // (an iPad turned round: the chips and cards follow the toasts' column)
    if (typeof window !== 'undefined') window.addEventListener('resize', () => { if (this.box) this.boxes(); });
    // the lock screen shows its own ban screen; a build without it (npm start) shows ours
    if (!underLock()) readBan().then((b) => { if (isBanned(b)) this.banScreen((readBanBy() || {}).reason || ''); }).catch(() => {});
  }

  /** Stop listening and sealing (tests; a page never needs to). */
  stop() {
    clearInterval(this.cardTimer);
    clearInterval(this.stateTimer);
    for (const off of this.offs || []) off();
    this.offs = [];
  }

  // ------------------------------------------------------------------ the card
  /** This page's player card (what the admin's panel shows). */
  card() {
    const app = this.app, g = app.game, acc = app.activeAccount;
    const kind = app.partyKind ? app.partyKind() : 'solo';
    const s = (g && g.settingsState) || {};
    const humans = g ? [...g.roster.values()].filter((r) => !r.bot).length : 1;
    return {
      id: app.presence ? app.presence.id : '',
      name: app.settings.name,
      level: app.profile ? app.profile.level : 1,
      account: acc ? (acc.guest ? 'guest' : String(acc.id).replace(/^p_/, '').slice(0, 8)) : null,
      mode: (s.info && s.info.name) || s.modeId || '',
      phase: g && LIVE.has(g.phase) ? 'match' : 'lobby',
      // (the admin watching a party is not in it: 'watch')
      party: {
        code: kind === 'solo' ? '' : (g && g.code) || '',
        kind: g && g.observer ? 'watch' : kind === 'solo' ? 'solo' : kind === 'p2p-host' ? 'host' : 'member',
        size: Math.max(1, humans),
      },
      v: VERSION,
      since: this.since,
      admin: !!app.admin,
      pk: this.pageKey ? this.pageKey.raw : null,
    };
  }

  /** Seal the card again when it changed (presence says it with its next message). */
  async refreshCard() {
    const pres = this.app.presence;
    // (no card before this page's own key: the admin couldn't send it anything)
    if (!pres || this.sealing || !this.pageKey) return;
    const card = this.card();
    const key = JSON.stringify(card);
    if (key === this.cardKey) return;
    this.sealing = true;
    try {
      const a = await sealToAdmin(this.pubs.boxPub, card);
      this.cardKey = key;
      pres.setExtra({ a });
    } catch (e) { /* tried again in a moment */ } finally { this.sealing = false; }
  }

  // ------------------------------------------------------------------ commands
  async onCmd(text) {
    if (!text || text.length > 4000) return;
    let env;
    try { env = JSON.parse(text); } catch (e) { return; }
    // (a command for everyone signed before this page started is an old one replayed: a 'reload
    // everyone' that reloads its pages again and again)
    if (env && env.to === '*' && Number.isFinite(env.ts) && env.ts < this.since) return;
    const pres = this.app.presence;
    const r = await this.gate.live(env, pres ? pres.id : '');
    if (!r.ok) return;
    // (a '*' command this page signed is for everyone else: the admin can aim one at himself by id)
    if (r.env.to === '*' && this.app.admin && this.app.admin.sent.has(r.env.n)) return;
    if (r.env.to === '*') {
      this.allDone = [...this.allDone.slice(-49), r.env.n];
      writeJson(sessionStore(), ALL_KEY, this.allDone);
    }
    try { this.run(r.env, r.raw); } catch (e) { console.error('admin command', r.env.cmd, e); }
  }

  /** env: the checked command (env.args opened and clean); raw: as it came, the signature intact. */
  run(env, raw = env) {
    const a = env.args;
    switch (env.cmd) {
      case 'reload': this.reloadNow(); break;
      case 'message': this.message(a.text); break;
      case 'kick': this.kick(a.reason, raw); break;
      case 'ban': this.ban(a.reason, raw); break;
      case 'rename': this.rename(a.name); break;
      case 'grant': this.grant(a.xp); break;
      case 'resetStats': this.resetStats(); break;
      default: if (PARTY_CMDS.includes(env.cmd)) this.partyCmd(env, raw);
    }
  }

  reloadNow() {
    this.overlay('reload', '<div class="adm-big">🔄</div><h2>Updating the game…</h2><p>The admin is reloading Phortnite with the newest version.</p>');
    setTimeout(() => freshReload(), 600);
  }

  /**
   * A card with an OK button (stays a minute): the admin's message (text), or an important notice
   * (opts.html: trusted markup with escaped values; opts.head: its title).
   */
  message(text, opts = {}) {
    const box = this.boxes().msgs;
    const d = document.createElement('div');
    d.className = 'adm-msg';
    d.setAttribute('role', 'alert');
    d.innerHTML = `<div class="adm-mhead"></div><div class="adm-mtext"></div><button class="adm-ok">OK</button>`;
    d.querySelector('.adm-mhead').textContent = opts.head || '📣 Message from the admin';
    if (opts.html) d.querySelector('.adm-mtext').innerHTML = opts.html;
    else d.querySelector('.adm-mtext').textContent = text;
    const close = () => d.remove();
    d.querySelector('.adm-ok').addEventListener('click', (e) => { e.stopPropagation(); close(); });
    d.addEventListener('pointerdown', (e) => e.stopPropagation());
    box.appendChild(d);
    while (box.children.length > 3) box.firstChild.remove();
    setTimeout(close, 60000);
    if (this.app.sfx && this.app.sfx.ui) this.app.sfx.ui();
  }

  /** Back to a party of one in the lobby (a party is left; a solo match ends). */
  leaveToLobby() {
    const app = this.app, g = app.game;
    this.setPaused(false);
    if (app.ui && app.ui.modalOpen && app.ui.modalOpen() && !app.ui.modalLocked) app.ui.closeModal();
    if (app.partyKind() !== 'solo') {
      app.saveResume(true);
      app.soloParty();
    } else if (g && g.phase !== 'lobby') {
      app.backToLobby();
    } else if (app.warming) app.warmUp(false);
    if (app.hud && app.hud.elim) app.hud.elim(null);
  }

  /** Where this player is: 'match', 'party' (a party's lobby) or 'lobby' (on their own). */
  where() {
    const app = this.app, g = app.game;
    if (g && LIVE.has(g.phase) && !app.stageOn) return 'match';
    if (g && LIVE.has(g.phase)) return app.partyKind() === 'solo' ? 'match' : 'party';
    return app.partyKind() !== 'solo' ? 'party' : 'lobby';
  }

  /**
   * The admin removed this page's player while it hosts a party: its friends hear it first (the
   * signed envelope, which names this party), else they would only see "X's party ended".
   */
  tellParty(raw) {
    const room = this.room();
    if (!room || this.app.partyKind() !== 'p2p-host' || !raw || !raw.args || raw.args.code !== room.code) return;
    try { room.broadcast({ t: 'admin', env: raw }); } catch (e) { /* the party ends anyway */ }
  }

  kick(reason, raw) {
    const where = this.where();
    this.tellParty(raw);
    this.leaveToLobby();
    const what = where === 'match' ? 'the match' : where === 'party' ? 'the party' : '';
    const why = reason ? ` <small>(${esc(reason)})</small>` : '';
    this.notify(what ? `The admin removed you from ${what}.${why}` : `The admin asked you to take a break.${why}`, 'bad', 9000, { keep: true });
  }

  async ban(reason, raw) {
    this.tellParty(raw);
    this.leaveToLobby();
    this.banScreen(reason);
    try { await writeBan({}, { reason }); } catch (e) { /* the overlay still stands */ }
    // the website's lock screen shows its ban screen from now on (Philip's unban code lifts it)
    setTimeout(() => location.reload(), 4000);
  }

  rename(name) {
    const app = this.app, acc = app.activeAccount;
    app.settings.name = name;
    if (acc && !acc.guest) app.saveSettings(); // (writes the account's name too)
    else if (acc) acc.name = name; // a guest: this visit only
    const g = app.game;
    if (g) g.send({ t: 'look', name });
    if (app.lobby) app.lobby.render();
    this.notify(`✎ The admin changed your name to <b>${esc(name)}</b>.`, '', 7000, { keep: true });
    this.refreshCard();
  }

  grant(xp) {
    const app = this.app, pr = app.profile;
    if (!pr) return;
    const up = addXp(pr.data, xp);
    // a signed-in account keeps it; a guest (or nobody chosen yet) has it for this visit only
    if (app.activeAccount) pr.save();
    this.statsChanged();
    this.notify(`🎁 The admin gave you <b>${xp | 0} XP</b>!${up ? ` You're level <b>${pr.level}</b> now!` : ''}`, '', 7000, { keep: true });
  }

  resetStats() {
    const app = this.app, pr = app.profile;
    if (!pr) return;
    Object.assign(pr.data, defaultStats());
    if (app.activeAccount) pr.save();
    this.statsChanged();
    this.notify('↺ The admin reset your stats (level, XP, wins and eliminations).', '', 7000, { keep: true });
  }

  statsChanged() {
    const app = this.app, g = app.game;
    if (g && g.phase === 'lobby' && app.profile) g.send({ t: 'look', lvl: app.profile.level });
    if (app.lobby) app.lobby.render();
    this.refreshCard();
  }

  // ------------------------------------------------------------------ party commands (the host's page)
  /** The room this page runs (a solo party or a P2P host), or null (a member / the Node server's party). */
  room() {
    const g = this.app.game;
    return g && g.net && g.net.room ? g.net.room : null;
  }

  /**
   * env: the opened party command (its args name the party: a.code); raw: as signed, which the
   * party hears ({t: 'admin', env: raw}) so every member can check it too.
   */
  partyCmd(env, raw = env) {
    const room = this.room();
    if (!room) return;
    const a = env.args;
    // (only for the party the admin's panel saw this page hosting)
    if (!a.code || a.code !== room.code) return;
    this.ran.add(env.n);
    if (env.cmd === 'end') {
      if (!LIVE.has(room.phase)) return;
      this.setPaused(false);
      room.broadcast({ t: 'admin', env: raw });
      room.returnToLobby();
      this.notify('🛡 The admin ended the match.');
    } else if (env.cmd === 'pause') {
      if (a.on && !LIVE.has(room.phase)) return; // nothing to pause in the lobby
      room.broadcast({ t: 'admin', env: raw });
      this.setPaused(a.on);
      this.notify(a.on ? '⏸ The admin paused the match.' : '▶ The admin resumed the match.');
    } else if (env.cmd === 'mode') {
      if (!room.pickMode(a.modeId)) return;
      room.broadcast({ t: 'admin', env: raw });
      this.notify(`🛡 The admin changed the mode to <b>${esc(modeName(a.modeId))}</b>.`);
    }
  }

  /**
   * A room message {t: 'admin', env} (game plugin AdminNotes): the party host carried out a party
   * command (or was removed by the admin). Shown only when the admin really signed it, for this
   * party (a host can't make one up, or pass on one meant for another party).
   */
  async onRoomMessage(m, game) {
    const env = m && m.env;
    if (!env || typeof env !== 'object' || typeof env.n !== 'string' || this.ran.has(env.n) || this.notes.has(env.n)) return;
    const a = await partyNote(this.pubs.signPub, env, game && game.code);
    if (!a || this.notes.has(env.n)) return;
    this.notes.add(env.n);
    if (game !== this.app.game || game.disposed) return;
    if (env.cmd === 'end') { this.setPaused(false); this.notify('🛡 The admin ended the match.'); }
    else if (env.cmd === 'pause') {
      this.setPaused(a.on);
      this.notify(a.on ? '⏸ The admin paused the match.' : '▶ The admin resumed the match.');
    } else if (env.cmd === 'mode') this.notify(`🛡 The admin changed the mode to <b>${esc(modeName(a.modeId))}</b>.`);
    else if (env.cmd === 'kick' || env.cmd === 'ban') {
      this.setPaused(false);
      this.notify('🛡 The admin removed the host from the game, so this party ended.', 'bad', 9000, { keep: true });
    }
  }

  /**
   * The admin's pause: this page stops simulating (a host's room clock stops too, like an app
   * switch) until the admin resumes, the match ends or the party changes.
   */
  setPaused(on) {
    const app = this.app, g = app.game;
    if (on) {
      if (g && g.net && typeof g.net.pause === 'function') g.net.pause();
      app.paused = true;
      app.adminPaused = true;
      this.chip('pause', '⏸ The admin paused the match');
      return;
    }
    if (!app.adminPaused) return;
    app.adminPaused = false;
    this.chip('pause', null);
    // (the host's clock directly: P2PHost.resume would also tell everyone 'The host is back')
    const net = g && g.net;
    const d = net && net.clock && net.clock.paused ? net.clock.resume() : 0;
    if (d > 0 && g.bus && g.bus.path && typeof g.bus.t0 === 'number') g.bus.t0 += d;
    app.unpause();
  }

  /** The party changed (main.js enterParty): an admin pause belonged to the old one. */
  partyChanged() {
    if (this.app.adminPaused) { this.app.adminPaused = false; this.chip('pause', null); }
  }

  // ------------------------------------------------------------------ banner + maintenance (retained)
  async onState(text, topic) {
    if (typeof topic !== 'string' || !topic.startsWith(STATE_PREFIX)) return;
    const kind = topic.slice(STATE_PREFIX.length);
    if (!STATE_KINDS.includes(kind)) return;
    let env = null;
    try { env = text && text.length <= 4000 ? JSON.parse(text) : null; } catch (e) { env = null; }
    const cur = this.states[kind], mark = this.marks[kind];
    // only forward: an older state (a replay of one Philip has since changed) never comes back,
    // even on a page that loads after it was replayed, if this device saw the newer one
    const old = !env || typeof env !== 'object' || !Number.isFinite(env.ts)
      || (cur && (env.n === cur.n || !(env.ts > cur.ts))) || (mark && env.ts < mark.ts);
    if (old) {
      if (!(cur && env && env.n === cur.n)) this.republish(kind);
      return;
    }
    const r = await this.gate.state(env, kind);
    if (!r.ok) { this.republish(kind); return; }
    const now = this.states[kind];
    if (now && !(r.env.ts > now.ts)) return;
    this.states[kind] = { args: r.env.args, ts: r.env.ts, n: r.env.n, env };
    this.marks[kind] = { ts: r.env.ts, n: r.env.n };
    writeJson(localStore(), MARK_KEY, this.marks);
    this.applyStates();
  }

  /**
   * On the admin's own page: something older, unsigned or empty took the place of his newest state
   * on the broker (anyone can publish there). Put his newest one back (it is still signed), so
   * pages that open later get the right one. Now and then at most.
   */
  republish(kind) {
    const app = this.app, cur = this.states[kind];
    if (!app.admin || !cur || !cur.env || !app.presence) return;
    const t = Date.now();
    if (t - (this.republished[kind] || 0) < REPUBLISH_MS) return;
    this.republished[kind] = t;
    app.presence.publish(STATE_PREFIX + kind, JSON.stringify(cur.env), { retain: true });
  }

  /** { banner, maintenance }: what is in force here now (null when off or over). */
  stateNow() {
    const out = { banner: null, maintenance: null };
    const t = Date.now();
    for (const k of STATE_KINDS) {
      const s = this.states[k];
      if (s && stateActive(k, s.args, t, s.ts)) out[k] = { ...s.args };
    }
    return out;
  }

  applyStates() {
    const st = this.stateNow();
    const ann = this.app.announce;
    const b = st.banner;
    const bk = b ? `${b.id}|${b.text}|${b.until}` : '';
    if (bk !== this.bannerKey) {
      this.bannerKey = bk;
      if (ann && ann.setAdmin) ann.setAdmin(b);
    }
    this.maintenance(st.maintenance);
  }

  maintenance(m) {
    const app = this.app;
    const on = !!m;
    const key = on ? `${m.text}|${m.until}|${!!app.admin}` : '';
    if (key === this.maintKey) return;
    this.maintKey = key;
    app.maintenance = on;
    if (!on) {
      this.overlay('maint', null);
      this.chip('maint', null);
      if (this.wasMaint) this.notify('✅ The game is back — have fun!');
      this.wasMaint = false;
      return;
    }
    // the admin keeps playing (and can turn it off again): a reminder, not a wall
    if (app.admin) {
      this.overlay('maint', null);
      this.chip('maint', '🛠 Maintenance is ON for everyone else');
      return;
    }
    this.wasMaint = true;
    this.chip('maint', null);
    this.leaveToLobby();
    this.overlay('maint', `<div class="adm-big">🛠</div><h2>Philip is working on the game</h2>${m.text ? '<p class="adm-otext"></p>' : ''}<p class="adm-small">It will be back soon. This screen goes away by itself.</p>`, (el) => {
      const p = el.querySelector('.adm-otext');
      if (p) p.textContent = m.text;
    });
  }

  /** Is PLAY blocked here (maintenance, a ban)? */
  blocking() { return !!(this.app.maintenance && !this.app.admin) || !!this.banned; }

  /** Admin mode changed on this page (the maintenance wall / chip swap). */
  adminChanged() {
    this.maintKey = '\u0000';
    this.applyStates();
    this.refreshCard();
  }

  // ------------------------------------------------------------------ on screen
  /** The full-screen overlays' layer. */
  ensureLayer() {
    if (this.layer) return this.layer;
    const el = document.createElement('div');
    el.id = 'adminlayer';
    document.body.appendChild(el);
    this.layer = el;
    return el;
  }

  /**
   * The chips and message cards: at the top of the toasts' column (#toasts), so they go where the
   * toasts go (the lobby's top middle, right of the party cards on a narrow screen, under Philip's
   * banner wherever it sits) and the toasts line up under them instead of on top of them.
   */
  boxes() {
    if (!this.box) {
      const chips = document.createElement('div'), msgs = document.createElement('div');
      chips.className = 'adm-chips';
      msgs.className = 'adm-msgs';
      this.box = { chips, msgs };
    }
    const col = document.getElementById('toasts') || this.ensureLayer();
    if (this.box.chips.parentNode !== col) col.prepend(this.box.chips, this.box.msgs);
    // (the column's spot, e.g. right of the party cards on a narrow lobby: a toast isn't always there to set it)
    const lobby = this.app.lobby;
    if (lobby && lobby.placeToasts) { try { lobby.placeToasts(); } catch (e) { /* the lobby isn't drawn yet */ } }
    return this.box;
  }

  /** A full-screen overlay by key ('maint' | 'ban' | 'reload'); html null removes it. */
  overlay(key, html, fill) {
    if (!html && !this.layer) return;
    const layer = this.ensureLayer();
    let el = layer.querySelector(`.adm-over[data-k="${key}"]`);
    if (!html) { if (el) el.remove(); return; }
    if (!el) {
      el = document.createElement('div');
      el.className = `adm-over adm-${key}`;
      el.dataset.k = key;
      // nothing under it can be tapped (PLAY, JOIN, the stage)
      for (const ev of ['pointerdown', 'click', 'touchstart']) el.addEventListener(ev, (e) => e.stopPropagation());
      layer.appendChild(el);
    }
    el.innerHTML = `<div class="adm-ocard">${html}</div>`;
    if (fill) fill(el);
    if (this.app.input && this.app.input.exitLock) this.app.input.exitLock();
  }

  banScreen(reason) {
    this.banned = true;
    this.overlay('ban', `<div class="adm-big">🚫</div><h2>You've been banned by the admin</h2>${reason ? '<p class="adm-otext"></p>' : ''}<p class="adm-small">Ask Philip if you think this is a mistake.</p>`, (el) => {
      const p = el.querySelector('.adm-otext');
      if (p) p.textContent = reason;
    });
  }

  /** A small persistent chip (key -> text; null removes it), e.g. '⏸ The admin paused the match'. */
  chip(key, text) {
    if (!text && !this.chips.has(key)) return;
    const box = this.boxes().chips;
    let el = this.chips.get(key);
    if (!text) {
      if (el) el.remove();
      this.chips.delete(key);
    } else {
      if (!el) {
        el = document.createElement('div');
        el.className = `adm-chip adm-chip-${key}`;
        box.appendChild(el);
        this.chips.set(key, el);
      }
      el.textContent = text;
    }
    document.body.classList.toggle('adm-chips', this.chips.size > 0);
  }

  /**
   * Tell the player, in one place: a toast in the lobby, the big notice in a match; keep: a card
   * with an OK button (for what they must not miss: kick, rename, XP, reset stats). html: trusted
   * markup with escaped values.
   */
  notify(html, kind = '', ms = 7000, { keep = false } = {}) {
    const app = this.app;
    const dom = typeof document !== 'undefined';
    if (keep && dom) { this.message('', { html, head: '🛡 From the admin' }); return; }
    if (dom && !app.stageOn && app.hud && app.hud.notice) {
      const d = document.createElement('div');
      d.innerHTML = html;
      app.hud.notice(d.textContent, false, 5);
      return;
    }
    if (app.lobby && app.lobby.toast) app.lobby.toast(html, { kind, ms });
  }
}

function localStore() { try { return globalThis.localStorage || null; } catch (e) { return null; } }
function sessionStore() { try { return globalThis.sessionStorage || null; } catch (e) { return null; } }
function readJson(store, key) {
  try { return store ? JSON.parse(store.getItem(key) || 'null') : null; } catch (e) { return null; }
}
function writeJson(store, key, v) {
  try { if (store) store.setItem(key, JSON.stringify(v)); } catch (e) { /* private mode: this visit only */ }
}

function modeName(id) {
  const m = findMode(id);
  return m ? `${m.emoji || ''} ${m.name}`.trim() : id;
}
