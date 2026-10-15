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
//   bans (state)          the admin's ban list (account registry ids, hashed device ids): when
//                         this device's id is on it, or ANY account made on this device (every
//                         profile, not only the signed-in one), this device is banned exactly like
//                         the live 'ban' below (reason "The admin banned this account"). A banned
//                         account can't be brought over with a transfer code (js/ui/accounts.js asks
//                         accountBanned first); one the list catches later on an iPad it was MOVED to
//                         (its 'imported' mark, js/accounts/store.js) is taken off that iPad quietly
//                         and the player told, never the iPad banned (a friend who imported a banned
//                         kid's code isn't locked out of their own accounts). Checked again when the
//                         list changes, an account is created or imported, and when admin mode goes
//                         off (the admin's own page is never banned by the list). Philip's unban code
//                         only lasts once the account is off the list too: while the list names this
//                         iPad, the game bans it again as soon as it opens.
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
//   mute / unmute         the party chat (app.chat.setMute, js/ui/chat.js): "🔇 The admin muted your
//                         chat for 1 hour" (+ the reason) / "🔈 The admin unmuted your chat"
//   chatlog               this page uploads the chat lines it saw this page load (app.chat.lines(),
//                         the last 100) sealed to the admin, and its chat list says "🛡 The admin
//                         looked at this chat" (a toast too when the chat isn't open)
// Uploads to the admin (UP_TOPIC, js/admin/commands.js sealUpload), sealed with this page's own key:
//   report(line, context) a player's 🚩 Report to admin (js/ui/chat.js) -> Promise<bool> (published?)
//   the live party chat   ONLY on the page that hosts a P2P party (its room runs here), and only
//                         while someone else is in it (a friend, or the admin watching): its new
//                         lines (app.chat.onLine), batched, at most one upload every FEED_MS. Every
//                         player is told in the chat drawer that the admin can read chats.
// The account registry (js/accounts/registry.js, app.adminClient.registry): this page's signed-in
// account (never a guest) has a sealed entry on the broker for the admin's ACCOUNTS tab: sent the
// first time this device sees the account and after a rename, else seldom (stats every few hours,
// 'seen' once a day), and put back when the broker lost it; an account deleted here has its entry
// deleted. The card carries its rid and token too (sealed), so the admin can tell which online player
// is which account (the token proves the rid). Open: every account is told once on this device
// (tellRegistry: a long toast in the lobby) that Philip keeps a list of accounts and can ban one
// while it's offline; an account made here was told on the create screen already (markTold).
// Every page makes its own ECDH key for this page load (js/admin/keys.js newBoxKey): its public half
// goes in the sealed card, and the private parts of a command for this page are sealed to it, so
// only this page can open them (js/admin/commands.js).
// The admin panel (js/ui/admin.js, app.adminPanel) and SPECTATE (js/ui/adminWatch.js, app.adminWatch)
// are made here too; a party this page hosts checks observer hellos with .observerCheck.
// API used by the panel / stage E: app.adminClient.card() (this page's card),
// .stateNow() ({banner, maintenance}), .chip(key, text|null) (a small persistent chip, e.g. stage E's
// '👁 Admin is watching'), .notify(html, kind), .report(line, context, reason) (the chat's 🚩),
// .accountChanged() (main.js: a sign-in, a new account, a rename), .checkBans() -> Promise<bool>,
// .accountBanned(accountId) -> Promise<bool> (js/ui/accounts.js: may this account be brought over?),
// .banListReady(ms) -> Promise<bool> (the ban list heard, or ms gone by), .markTold(accountId).
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
  UP_TOPIC, UP_LINES, UP_CONTEXT, sealUpload, stateTextMax,
} from './commands.js';
import { Registry, accountIds, banDid } from '../accounts/registry.js';
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
// the live party chat for the admin (a host's page): one upload per party at most this often, a
// moment after the first new line (so a burst goes in one); lines kept while offline, at most
export const FEED_MS = 3000;
const FEED_GATHER_MS = 400;
const FEED_KEEP = UP_LINES;
const FEED_TRIES = 3; // a batch that couldn't go out this many times is dropped
// uploads a page makes on its own, per minute at most: reports (a player tapping 🚩) and chat logs
// (only on the admin's signed chatlog, but a page never answers more than this)
const UP_PER_MIN = { report: 5, log: 6 };
const MUTE_KEY = 'phortnite.chatMute'; // (js/chat/chatLog.js: a page without app.chat keeps the mute here for it)
const CODE_RE = /^[A-Z]{4}$/;
export const BAN_LIST_REASON = 'The admin banned this account'; // (what a ban from the list says on the ban screen)
// accounts on this device already told that the admin keeps a list of accounts (tellRegistry)
export const TOLD_KEY = 'phortnite.regTold';
const TOLD_MAX = 50;

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
    this.states = { banner: null, maintenance: null, bans: null }; // { args, ts, n, env } of the newest signed state
    this.marks = readJson(localStore(), MARK_KEY) || {};
    this.republished = {};
    // (a reloaded tab still knows the '*' commands it carried out)
    this.allDone = Array.isArray(readJson(sessionStore(), ALL_KEY)) ? readJson(sessionStore(), ALL_KEY).slice(-50) : [];
    for (const n of this.allDone) if (typeof n === 'string') this.gate.nonces.add(n);
    this.cardKey = '';
    this.sealing = false;
    this.chips = new Map();
    this.layer = null;
    this.feeds = new Map(); // party code -> { code, pending: [lines], last, timer, tries }: the live chat
    this.feedMs = FEED_MS;
    this.offChat = null;
    this.upTimes = { report: [], log: [] };
    this.registry = null; // js/accounts/registry.js (start())
    this.writeBan = writeBan; // (tests: a stand-in)
    this.banning = false; // a ban is being carried out here (it happens once)
    this.heardBans = null; // { text, at }: the last thing the broker handed over on the ban list's topic (the admin's page)
    this.republishTimers = {};
    this.told = null; // TOLD_KEY, read once
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
    // the account registry: this page's signed-in account, sealed for the admin's ACCOUNTS tab
    const app = this.app;
    this.registry = new Registry({ presence: p, boxPub: this.pubs.boxPub, account: () => app.activeAccount, store: app.accounts || null });
    // (a new or imported account on this device: is it on the admin's ban list?)
    this.offAccounts = app.accounts && typeof app.accounts.onChange === 'function'
      ? app.accounts.onChange((what) => { if (what !== 'remove') this.checkBans(); }) : null;
    this.registry.sync();
    // this page load's own key first: the card carries its public half, commands for this page open with it
    this.keyReady = newBoxKey().then((k) => {
      this.pageKey = k;
      this.gate.pageKey = k.priv;
      this.refreshCard();
    }).catch((e) => console.error('admin page key', e));
    this.cardTimer = setInterval(() => { this.refreshCard(); this.hookChat(); this.registry.sync(); this.tellRegistry(); }, CARD_MS);
    // the party chat's lines (the live feed a party host's page sends the admin)
    this.hookChat();
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
    if (this.offChat) this.offChat();
    this.offChat = null;
    if (this.offAccounts) this.offAccounts();
    this.offAccounts = null;
    if (this.registry) this.registry.stop();
    for (const k of Object.keys(this.republishTimers)) clearTimeout(this.republishTimers[k]);
    for (const f of this.feeds.values()) clearTimeout(f.timer);
    this.feeds.clear();
  }

  /**
   * The signed-in account changed (main.js saveSettings: a sign-in, a new account, a rename, sign
   * out): its registry entry goes out now if it is new or renamed, the ban list is checked, the card
   * is sealed again.
   */
  accountChanged() {
    if (this.registry) this.registry.sync();
    this.checkBans();
    this.refreshCard();
    this.tellRegistry();
  }

  /**
   * Open moderation: the signed-in account (never a guest, never on a page in admin mode) is told
   * once on this device that the admin keeps a list of accounts and can ban one while it's offline
   * (accounts made before the registry, signed in with a password, or brought over with a code
   * never saw the create screen's note). In the lobby only (not over a dialog or a match).
   * -> true when it told it now.
   */
  tellRegistry() {
    try {
      const app = this.app, acc = app.activeAccount;
      if (!acc || acc.guest || !acc.id || acc.id === 'guest' || app.admin || this.banned || this.banning) return false;
      if (this.toldIds().has(acc.id)) return false;
      if (!app.lobby || app.lobby.visible === false) return false; // (a match: later, in the lobby)
      if (app.ui && typeof app.ui.modalOpen === 'function' && app.ui.modalOpen()) return false;
      this.markTold(acc.id);
      this.notify(`🛡 New: Philip (the admin) now keeps a list of accounts: <b>${esc(acc.name)}</b>'s name, level and wins, and when it last played. He can ban an account even while it's offline, and a ban locks this whole iPad (every profile on it).`, '', 10000);
      return true;
    } catch (e) { return false; }
  }

  toldIds() {
    if (!this.told) {
      const v = readJson(localStore(), TOLD_KEY);
      this.told = new Set(Array.isArray(v) ? v.filter((x) => typeof x === 'string').slice(-TOLD_MAX) : []);
    }
    return this.told;
  }

  /** This account was told (js/ui/accounts.js: the create screen's note said it already). */
  markTold(id) {
    if (!id) return;
    const told = this.toldIds();
    told.delete(id);
    told.add(id);
    while (told.size > TOLD_MAX) told.delete(told.values().next().value);
    writeJson(localStore(), TOLD_KEY, [...told]); // (private mode: this page load only, in this.told)
  }

  // ------------------------------------------------------------------ the card
  /** This page's player card (what the admin's panel shows). */
  card() {
    const app = this.app, g = app.game, acc = app.activeAccount;
    const kind = app.partyKind ? app.partyKind() : 'solo';
    const s = (g && g.settingsState) || {};
    const humans = g ? [...g.roster.values()].filter((r) => !r.bot).length : 1;
    const mute = this.chatMuted();
    return {
      id: app.presence ? app.presence.id : '',
      name: app.settings.name,
      level: app.profile ? app.profile.level : 1,
      account: acc ? (acc.guest ? 'guest' : String(acc.id).replace(/^p_/, '').slice(0, 8)) : null,
      // the account's registry id and token (never a guest's): the admin's ACCOUNTS tab says who is
      // online; the token (sealed like the rest) proves the rid, which is public (a topic name)
      ...this.cardIds(acc),
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
      muted: mute ? mute.until : 0, // (the admin's panel shows who is muted, so he can unmute them)
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
    // (being checked: the ban list waits for it, so the admin's own live 'ban' with his reason goes first)
    this.cmdBusy = (this.cmdBusy || 0) + 1;
    let r;
    try { r = await this.gate.live(env, pres ? pres.id : ''); } finally { this.cmdBusy--; }
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
      case 'mute': this.mute(a.minutes, a.reason); break;
      case 'unmute': this.unmute(); break;
      case 'chatlog': this.chatlog(env.n); break;
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
    if (this.banning) return; // (once: the live 'ban' and the ban list can both come)
    this.banning = true;
    this.tellParty(raw);
    this.leaveToLobby();
    this.banScreen(reason);
    try { await this.writeBan({}, { reason }); } catch (e) { /* the overlay still stands */ }
    // the website's lock screen shows its ban screen from now on (Philip's unban code lifts it; for
    // a ban from the list, only once the list doesn't name this iPad any more: else it comes back)
    if (typeof location !== 'undefined') setTimeout(() => location.reload(), 4000);
  }

  /** { rid, tok } of the signed-in real account for the card, once worked out (else nulls). */
  cardIds(acc) {
    const ids = acc && !acc.guest && this.registry ? this.registry.idsNow(acc.id) : null;
    return { rid: ids ? ids.rid : null, tok: ids ? ids.tok : null };
  }

  /** Every account kept on this device (all profiles, the signed-in one too): { id, name, imported }. */
  localAccounts() {
    const app = this.app, out = new Map();
    try {
      if (app.accounts && typeof app.accounts.list === 'function') {
        for (const p of app.accounts.list()) {
          if (!p || !p.id) continue;
          const full = typeof app.accounts.get === 'function' ? app.accounts.get(p.id) : null;
          out.set(p.id, full || p);
        }
      }
    } catch (e) { /* none */ }
    const acc = app.activeAccount;
    if (acc && !acc.guest && acc.id && acc.id !== 'guest' && !out.has(acc.id)) out.set(acc.id, acc);
    return [...out.values()];
  }

  /** This device's id as the ban list carries it (registry.js banDid; worked out once). */
  async banDidNow() {
    const did = this.registry ? this.registry.did : '';
    if (!did) return '';
    if (!this.bdid || this.bdid.did !== did) this.bdid = { did, h: await banDid(did) };
    return this.bdid.h;
  }

  /** The ban list's entries as this page has them now ([] before one came). */
  banList() {
    const st = this.states.bans;
    return st && st.args && Array.isArray(st.args.list) ? st.args.list : [];
  }

  /** Has the ban list come yet? Waits up to ms for it while connected. -> Promise<bool> */
  async banListReady(ms = 2000) {
    const t0 = Date.now(), p = this.app.presence;
    while (!this.states.bans && Date.now() - t0 < ms && !(p && p.connected === false)) await new Promise((r) => setTimeout(r, 100));
    return !!this.states.bans;
  }

  /** Is the account with this local id on the ban list? (A transfer code for it is refused.) */
  async accountBanned(id) {
    try {
      const list = this.banList();
      if (!id || !list.length) return false;
      const { rid } = await accountIds(id);
      return list.some((e) => e.r === rid);
    } catch (e) { return false; }
  }

  /**
   * The admin's ban list (the newest signed 'bans' state): this device's id on it, or any account
   * made here? Then this device is banned, like the live 'ban' (once). A hit only on accounts that
   * were brought over from another iPad (their 'imported' mark) takes those accounts off this iPad
   * instead, quietly (their registry entry stays for the admin's list), and says so: the friend who
   * imported a banned account's code keeps their iPad and their own accounts. Never on a page in
   * admin mode (the admin can't lock himself out; js/ui/admin.js doesn't offer a ban for his own
   * accounts). -> Promise<bool>: true when it banned this device now.
   */
  async checkBans() {
    try {
      const st = this.states.bans;
      const list = this.banList();
      if (!list.length || this.banned || this.banning || this.app.admin) return false;
      const bdid = await this.banDidNow();
      let hit = !!bdid && list.some((e) => e.d === bdid);
      const moved = [];
      if (!hit) {
        const rids = new Set(list.map((e) => e.r));
        for (const acc of this.localAccounts()) {
          if (!rids.has((await accountIds(acc.id)).rid)) continue;
          if (acc.imported > 0) moved.push(acc);
          else { hit = true; break; }
        }
      }
      if (!hit && !moved.length) return false;
      // (the admin bans a player who is online with the live 'ban' too, sent just before the list:
      // when one is being checked, it goes first, so the ban screen shows his reason)
      for (let i = 0; hit && this.cmdBusy > 0 && i < 40; i++) await new Promise((res) => setTimeout(res, 50));
      // (checked again: a live 'ban' may have come meanwhile, or admin mode started)
      if (this.banned || this.banning || this.app.admin || this.states.bans !== st) return false;
      if (!hit) { this.dropMoved(moved); return false; }
      this.ban(BAN_LIST_REASON);
      return true;
    } catch (e) { return false; }
  }

  /** Banned accounts that were only brought over to this iPad: off it again (quietly), and the player told. */
  dropMoved(list) {
    const app = this.app, store = app.accounts;
    if (!store || typeof store.remove !== 'function') return;
    let signedOut = false;
    for (const acc of list) {
      if (!store.remove(acc.id, { quiet: true })) continue;
      if (app.activeAccount && app.activeAccount.id === acc.id) signedOut = true;
      this.notify(`🛡 <b>${esc(acc.name)}</b> was banned by the admin, so it was taken off this iPad. Your other accounts are fine.`, 'bad', 9000, { keep: true });
    }
    if (!signedOut) return;
    if (typeof app.signOut === 'function') app.signOut(); // (back to "Who's playing?")
    else { try { store.signOut(); } catch (e) { /* fine */ } app.activeAccount = null; }
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

  // ------------------------------------------------------------------ party chat moderation
  /** The page's chat (js/ui/chat.js), when this build has one. */
  get chat() {
    const c = this.app.chat;
    return c && typeof c === 'object' ? c : null;
  }

  /** {until, reason} while the admin's mute is on here, else null. */
  chatMuted() {
    const c = this.chat;
    try {
      if (c && typeof c.muted === 'function') return c.muted();
      const m = readJson(localStore(), MUTE_KEY);
      return m && Number.isFinite(m.until) && m.until > Date.now() ? m : null;
    } catch (e) { return null; }
  }

  mute(minutes, reason = '') {
    const until = Date.now() + minutes * 60000;
    const c = this.chat;
    if (c && typeof c.setMute === 'function') c.setMute(until, reason);
    else writeJson(localStore(), MUTE_KEY, { until, reason }); // (a chat made later reads it)
    const why = reason ? ` <small>(${esc(reason)})</small>` : '';
    this.notify(`🔇 The admin muted your chat for <b>${esc(forHow(minutes))}</b>. You can still play and read the chat.${why}`, 'bad', 9000, { keep: true });
    this.refreshCard();
  }

  unmute() {
    const c = this.chat;
    if (c && typeof c.setMute === 'function') c.setMute(0);
    else { try { const st = localStore(); if (st) st.removeItem(MUTE_KEY); } catch (e) { /* private mode */ } }
    this.notify('🔈 The admin unmuted your chat. Be kind!', '', 7000);
    this.refreshCard();
  }

  /** The admin asked for this page's chat log (n: his command's nonce): sent, and the player told. */
  async chatlog(n) {
    const c = this.chat;
    let lines = [];
    try { lines = c && typeof c.lines === 'function' ? c.lines().slice(-UP_LINES).map(slimLine) : []; } catch (e) { lines = []; }
    // open moderation: the chat list says so (and a toast, when the chat isn't open to show it)
    try {
      if (c && typeof c.notice === 'function') c.notice('🛡 The admin looked at this chat');
      if (!(c && typeof c.isOpen === 'function' && c.isOpen())) this.notify('🛡 The admin looked at your chat log (to keep everyone safe).', '', 6000);
    } catch (e) { /* told as far as this build can */ }
    if (!this.upOk('log')) return false;
    return this.upload({ k: 'log', re: n, code: this.partyCode(), lines });
  }

  /**
   * A player's 🚩 Report to admin (js/ui/chat.js): the line, the lines before it (up to 10) and an
   * optional reason, sealed to the admin. -> Promise<bool>: true when it went out. Never throws.
   */
  async report(line, context = [], reason = '') {
    try {
      if (!line || typeof line !== 'object' || !this.upOk('report')) return false;
      const ctx = Array.isArray(context) ? context.slice(-UP_CONTEXT).map(slimLine) : [];
      const code = typeof line.code === 'string' ? line.code : this.partyCode();
      return await this.upload({ k: 'report', code, line: slimLine(line), context: ctx, reason: String(reason || '').slice(0, 120) });
    } catch (e) { return false; }
  }

  /** Room for one more upload of this kind (UP_PER_MIN)? Counts it when yes. */
  upOk(kind) {
    const t = Date.now(), list = this.upTimes[kind];
    while (list.length && t - list[0] > 60000) list.shift();
    if (list.length >= UP_PER_MIN[kind]) return false;
    list.push(t);
    return true;
  }

  /** The party this page is in ('SOLO' on its own). */
  partyCode() {
    const g = this.app.game;
    return g && typeof g.code === 'string' && CODE_RE.test(g.code) && this.app.partyKind() !== 'solo' ? g.code : 'SOLO';
  }

  /** Seal payload to the admin (with this page's own key) and publish it: true when it went out. */
  async upload(payload) {
    const pres = this.app.presence;
    if (!pres || !pres.id) return false;
    try {
      const text = await sealUpload(this.pubs.boxPub, { ...payload, from: pres.id, v: VERSION }, { from: this.pageKey });
      return !!text && !!pres.publish(UP_TOPIC, text);
    } catch (e) { return false; }
  }

  /** Listen to the chat's lines once app.chat exists (main.js makes it). */
  hookChat() {
    const c = this.chat;
    if (this.offChat || !c || typeof c.onLine !== 'function') return;
    this.offChat = c.onLine((line, game) => { try { this.feedLine(line, game); } catch (e) { /* the chat goes on */ } });
  }

  /**
   * A new chat line on this page: when this page hosts a P2P party with someone else in it, it
   * goes in the admin's live feed (batched: FEED_MS). Members' pages never send it (one copy per party).
   */
  feedLine(line, game) {
    const app = this.app, g = game || app.game;
    if (!line || line.sys || !g || g !== app.game || g.observer || !g.net || g.net.kind !== 'p2p-host') return;
    const code = typeof g.code === 'string' ? g.code : '';
    if (!CODE_RE.test(code) || (line.code && line.code !== code) || !this.othersIn(g)) return;
    let f = this.feeds.get(code);
    if (!f) {
      // (an old party's feed that is done: forgotten)
      for (const [k, x] of this.feeds) if (!x.pending.length && !x.timer) this.feeds.delete(k);
      f = { code, pending: [], last: 0, timer: 0, tries: 0 };
      this.feeds.set(code, f);
    }
    f.pending.push(slimLine(line));
    if (f.pending.length > FEED_KEEP) f.pending.splice(0, f.pending.length - FEED_KEEP);
    this.feedSoon(f);
  }

  /** Someone besides this page's player in party g: another player, or the admin watching. */
  othersIn(g) {
    let humans = 0;
    for (const r of g.roster.values()) if (!r.bot) humans++;
    const room = g.net && g.net.room;
    return humans > 1 || !!(room && room.observers && room.observers.size);
  }

  feedSoon(f) {
    if (f.timer || !f.pending.length) return;
    const wait = Math.max(FEED_GATHER_MS, f.last + this.feedMs - Date.now());
    f.timer = setTimeout(() => { f.timer = 0; this.feedFlush(f); }, wait);
  }

  async feedFlush(f) {
    if (!f.pending.length || this.feeds.get(f.code) !== f) return;
    const lines = f.pending.splice(0, f.pending.length);
    f.last = Date.now();
    const ok = await this.upload({ k: 'chat', code: f.code, lines });
    if (ok) f.tries = 0;
    else if (++f.tries < FEED_TRIES) f.pending = [...lines, ...f.pending].slice(-FEED_KEEP); // (offline: next time)
    else f.tries = 0;
    this.feedSoon(f);
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
    try { env = text && text.length <= stateTextMax(kind) ? JSON.parse(text) : null; } catch (e) { env = null; }
    // (what this connection handed over on the ban list's topic, junk and '' too: the admin's page
    // checks after a connect that the broker has his newest list, js/admin/session.js bansBack)
    if (kind === 'bans') this.heardBans = { text: typeof text === 'string' ? text : '', at: Date.now() };
    const cur = this.states[kind], mark = this.marks[kind];
    // only forward: an older state (a replay of one Philip has since changed) never comes back,
    // even on a page that loads after it was replayed, if this device saw the newer one
    const old = !env || typeof env !== 'object' || !Number.isFinite(env.ts)
      || (cur && (env.n === cur.n || !(env.ts > cur.ts))) || (mark && env.ts < mark.ts);
    if (old) {
      // (the newest one, exactly as signed, is fine; anything else in its place goes back to it,
      // a copy with the same nonce but changed args too)
      if (!(cur && env && env.n === cur.n && text === JSON.stringify(cur.env))) this.republish(kind);
      return;
    }
    const r = await this.gate.state(env, kind);
    if (!r.ok) { this.republish(kind); return; }
    const now = this.states[kind];
    if (now && !(r.env.ts > now.ts)) return;
    this.states[kind] = { args: r.env.args, ts: r.env.ts, n: r.env.n, env };
    this.marks[kind] = { ts: r.env.ts, n: r.env.n };
    writeJson(localStore(), MARK_KEY, this.marks);
    if (kind === 'bans') {
      // (the admin's panel: who is banned now; this page: is it one of them?)
      const s = this.app.admin;
      if (s && typeof s.bansChanged === 'function') { try { s.bansChanged(); } catch (e) { /* the panel catches up */ } }
      this.checkBans();
      return;
    }
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
    const t = Date.now(), wait = (this.republished[kind] || 0) + REPUBLISH_MS - t;
    if (wait > 0) {
      // (once more when the wait is over: a second wipe inside it doesn't stay on the broker)
      if (!this.republishTimers[kind]) this.republishTimers[kind] = setTimeout(() => { this.republishTimers[kind] = 0; this.republish(kind); }, wait + 5);
      return;
    }
    this.republished[kind] = t;
    app.presence.publish(STATE_PREFIX + kind, JSON.stringify(cur.env), { retain: true });
  }

  /** { banner, maintenance }: what is in force here now (null when off or over). */
  stateNow() {
    const out = { banner: null, maintenance: null };
    const t = Date.now();
    for (const k of ['banner', 'maintenance']) {
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
    this.checkBans(); // (admin mode off on a device whose account is on the ban list)
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

/** A chat line as it goes to the admin: only its own fields. */
function slimLine(l) {
  const o = { id: l.id, name: l.name, text: l.text, ts: l.ts };
  if (l.q !== undefined) o.q = l.q;
  if (l.admin) o.admin = true;
  if (l.sys) o.sys = true;
  if (l.code) o.code = l.code;
  if (l.at) o.at = l.at;
  return o;
}

/** '10 minutes', '1 hour', '2 days' */
function forHow(min) {
  const n = (k, one) => `${k} ${one}${k === 1 ? '' : 's'}`;
  if (min >= 1440 && min % 1440 === 0) return n(min / 1440, 'day');
  if (min >= 60 && min % 60 === 0) return n(min / 60, 'hour');
  return n(min, 'minute');
}

function modeName(id) {
  const m = findMode(id);
  return m ? `${m.emoji || ''} ${m.name}`.trim() : id;
}
