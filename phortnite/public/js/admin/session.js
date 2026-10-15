// Admin mode on this page: Philip's unlocked keys and everything the admin panel does with them.
// Exists only after the admin password unlocked admin.json's keys (js/ui/adminLogin.js), or after
// keys remembered on this iPad were checked against admin.json. Lives at app.admin (null otherwise).
//
// API for the admin panel (js/ui/admin.js) and spectating (stage E):
//   app.admin.send(cmd, args, to)      -> Promise<envelope | null> a signed live command (null:
//                                         offline; throws when that player's card has no key, e.g.
//                                         an older version). to: a player's id from players(), or '*'
//                                         (only 'reload' and 'message'). cmd/args: js/admin/commands.js
//                                         cleanArgs, e.g. send('message', {text}, id),
//                                         send('grant', {xp: 500}, id), send('pause', {on: true}, hostId).
//                                         For one player the args are sealed to the key in their card
//                                         (and the party code is added from it for party commands).
//   app.admin.sendState(kind, payload) -> Promise<envelope | null> a retained state for everyone:
//                                         ('banner', {text, minutes})  minutes 0 / absent = until
//                                                                      cleared; text '' clears it
//                                         ('maintenance', {on, text, hours})  hours: default 12, max 168
//   app.admin.players()                -> [card] everyone online with a readable card, this page
//                                         included (me: true): { id, me, name, level, account,
//                                         mode, phase, party: {code, kind, size} | null, v, since,
//                                         admin, pk, s: 'l' | 'm', seen (ms), suspect: true when
//                                         cards with different keys came for that id (someone is
//                                         faking it: commands still reach only the real page) }
//   app.admin.onPlayers(fn)            -> off(); fn(players()) whenever the list changes
//   app.admin.totals()                 -> { total (everyone counted, cards or not), cards, inMatch,
//                                         inLobby, parties }
//   app.admin.state()                  -> { banner: {text, id, until} | null,
//                                           maintenance: {on, text, until} | null } as this page has them
//   app.admin.observeHello(code)       -> Promise<envelope> a signed {cmd: 'observe', args: {code}}
//                                         for stage E's observer hello (good for 2 minutes)
//   app.admin.remembered               true when the keys are kept on this iPad (for REMEMBER_DAYS)
//   app.admin.signOut()                -> Promise: admin mode off here, remembered keys forgotten
// Party chat moderation (stage 3; players are told in the chat drawer that the admin can read
// chats, and every mute / chat log is announced on their screen):
//   app.admin.chats(max)               -> [{ code, host (the host's name, from its card), from,
//                                         ok, lines, last }] the parties' live chat as their host's
//                                         page sent it, newest party first; lines oldest first (the
//                                         last `max` of each, default all): {id, name, text, ts, q?,
//                                         admin?, at?, got (when it got here), ok}
//   app.admin.onChats(fn)              -> off(); fn() when chats or reports changed
//   app.admin.reports()                -> [{ n, from, name (the reporter, from its card), ok, code,
//                                         line, context, reason, at }] newest first (50 kept)
//   app.admin.unseenReports() / .seenReports()   the CHAT tab's badge
//   app.admin.requestLog(id)           -> Promise<{ id, name, code, lines, at } | null> sends
//                                         'chatlog' to that page and waits (LOG_WAIT_MS) for its
//                                         sealed answer (null: no answer, offline, an older version)
//   app.admin.mute(id, minutes, reason) / .unmute(id)   -> Promise<envelope | null> (send())
// Uploads come in on UP_TOPIC (js/admin/commands.js), opened here only: a budget of UP_RATE per
// UP_RATE_MS, a size cap before anything is parsed, junk dropped, and nothing kept but PARTIES
// parties x PARTY_LINES lines, REPORTS reports and LOGS chat logs (memory only: a reload forgets
// them). Anyone can seal something to the admin's public key, so an upload is only "as reported by
// that page": ok is true when it was sealed with the key in the card of the page it names (and for
// live chat, that page's card says it hosts that party). The panel shows the rest marked.
// Nothing here logs the password or a key; the keys are non-extractable CryptoKeys.
import {
  CMD_TOPIC, STATE_PREFIX, PARTY_CMDS, PUBLIC_ARGS, ALL_OK, makeEnvelope, cleanCard, Lru, Budget, UP_TOPIC, UP_MAX, upShape, cleanUpload,
} from './commands.js';
import { openSealed, keysMatch, importBoxPub, SEAL_UP } from './keys.js';

const IDB = 'phortnite-admin'; // IndexedDB: object store 'kv', the remembered keys under 'keys'
const MAX_OPENS = 300; // cards opened per refresh at most (a flood of junk can't stall the iPad)
// remembered keys are forgotten after this long: any page on the same website (origin) could use
// them (not read them) while they are kept, so not for ever
export const REMEMBER_DAYS = 30;
// uploads (party chat moderation): opened at most UP_RATE per UP_RATE_MS (a flood of junk can't
// stall the iPad: the newest wait for room, older ones are dropped), and what is kept, at most
export const UP_RATE = 30;
export const UP_RATE_MS = 10000;
export const PARTY_LINES = 500;
export const PARTIES = 30;
export const REPORTS = 50;
const LOGS = 20;
export const LOG_WAIT_MS = 10000; // requestLog gives up after this long
const REPORT_TOAST_MS = 10000; // "🚩 New chat report" on the admin's screen at most this often
const lineKey = (code, l) => `${code}|${l.ts}|${l.id}|${l.text}`;
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/**
 * One IndexedDB request on the admin database; resolves its result (undefined when it fails).
 * wait: give up after this long (a Safari whose IndexedDB never answers); 0 waits as long as it
 * takes. Reads at boot wait: a page busy starting up answers late, and nothing waits on them.
 */
function idb(mode, request, wait = 0) {
  return new Promise((resolve) => {
    let over = false;
    const end = (v) => { if (!over) { over = true; resolve(v); } };
    try {
      const req = indexedDB.open(IDB, 1);
      req.onupgradeneeded = () => req.result.createObjectStore('kv');
      req.onerror = req.onblocked = () => end();
      req.onsuccess = () => {
        const db = req.result;
        try {
          const tx = db.transaction('kv', mode), r = request(tx.objectStore('kv'));
          tx.oncomplete = () => { db.close(); end(r.result); };
          tx.onerror = tx.onabort = () => { db.close(); end(); };
        } catch (e) { db.close(); end(); }
      };
    } catch (e) { end(); }
    if (wait) setTimeout(end, wait);
  });
}

/** Keep the two (non-extractable) CryptoKeys on this iPad, for this admin.json. */
export function rememberKeys(keys, cfg) {
  return idb('readwrite', (s) => s.put({ sign: keys.sign, box: keys.box, pub: cfg.sign.pub, at: Date.now() }, 'keys'), 8000);
}

export function forgetKeys() { return idb('readwrite', (s) => s.delete('keys'), 8000); }

/** Keys remembered on this iPad that still belong to admin.json (else forgotten): { sign, box } or null. */
export async function rememberedKeys(cfg, pubs) {
  const rec = await idb('readonly', (s) => s.get('keys'));
  if (!rec || !rec.sign || !rec.box) return null;
  if (!(Date.now() - rec.at < REMEMBER_DAYS * 86400000)) { await forgetKeys(); return null; }
  // a new admin key (tools/admin.mjs new --force, published) retires the old remembered one
  if (rec.pub !== cfg.sign.pub || !(await keysMatch(pubs, rec))) { await forgetKeys(); return null; }
  return { sign: rec.sign, box: rec.box };
}

export class AdminSession {
  /** keys: { sign, box } private CryptoKeys; pubs: { signPub, boxPub } (js/admin/keys.js). */
  constructor(app, { cfg, pubs, keys, remembered = false }) {
    this.app = app;
    this.cfg = cfg;
    this.pubs = pubs;
    this.keys = keys;
    this.remembered = remembered;
    this.sent = new Lru(300); // nonces signed here: '*' commands are for everyone else (client.js)
    this.opened = new Map(); // sealed ct -> card | null
    this.pks = new Map(); // id -> the page key its cards carry (a second one: someone fakes that id)
    this.suspects = new Set();
    this.list = [];
    this.listKey = '';
    this.fns = [];
    this.closed = false;
    this.offCards = app.presence ? app.presence.onCards(() => this.refresh()) : null;
    // (the 'online for' times, and this page's own card, move on without anyone's message)
    this.timer = setInterval(() => this.refresh(), 5000);
    // party chat moderation: what pages upload (only the admin's page listens to it)
    this.parties = new Map(); // code -> { code, from, ok, last, lines: [], keys: Map(lineKey -> line) }
    this.reportList = []; // newest first
    this.reportSeq = 0;
    this.unseen = 0;
    this.logs = new Map(); // chatlog nonce -> { id, name, code, lines, at }
    this.waiting = new Map(); // chatlog nonce -> { id, resolve, timer }
    this.chatFns = [];
    this.upSeen = new Lru(500); // seals already opened (a replay costs nothing)
    this.upBudget = new Budget({ rate: UP_RATE, ms: UP_RATE_MS, queue: 8 });
    this.toastAt = 0;
    this.offUp = app.presence && app.presence.listen ? app.presence.listen(UP_TOPIC, (text) => { this.onUpload(text); }) : null;
    this.refresh();
  }

  get myId() { return this.app.presence ? this.app.presence.id : ''; }

  async send(cmd, args = {}, to = '*') {
    if (this.closed) return null;
    // (only a reload or a message may go to everyone: pages refuse the rest anyway)
    if (to === '*' && !ALL_OK.includes(cmd)) throw new Error(`${cmd} goes to one player at a time.`);
    let env;
    if (to === '*') env = await makeEnvelope(this.keys.sign, cmd, args, to);
    else {
      // sealed to the key in the card the admin is looking at: if that card is a fake, the
      // command is sealed to the faker's key and the real page does nothing with it
      const p = this.list.find((c) => c.id === to);
      const pagePub = p && p.pk ? await importBoxPub(p.pk) : null;
      if (!pagePub) throw new Error("Not sent: that player's game is an older version (it needs a reload).");
      const pt = p.party;
      if (pt && pt.code && (PUBLIC_ARGS[cmd] || []).includes('code') && (PARTY_CMDS.includes(cmd) || pt.kind === 'host')) args = { ...args, code: pt.code };
      env = await makeEnvelope(this.keys.sign, cmd, args, to, Date.now(), { pagePub });
    }
    this.sent.add(env.n);
    return this.app.presence && this.app.presence.publish(CMD_TOPIC, JSON.stringify(env)) ? env : null;
  }

  async sendState(kind, payload = {}) {
    if (this.closed) return null;
    const now = Date.now();
    let args;
    if (kind === 'banner') {
      const mins = Number(payload.minutes) || 0;
      const text = String(payload.text || '').trim().slice(0, 200);
      args = { text, id: text ? `b${now.toString(36)}` : '', until: text && mins > 0 ? now + Math.round(mins * 60000) : 0 };
    } else if (kind === 'maintenance') {
      const hours = Math.max(0.1, Math.min(168, Number(payload.hours) || 12));
      args = { on: !!payload.on, text: String(payload.text || '').trim().slice(0, 300), until: payload.on ? now + Math.round(hours * 3600000) : 0 };
    } else throw new Error(`unknown state ${kind}`);
    const env = await makeEnvelope(this.keys.sign, kind, args, '*', now);
    this.sent.add(env.n);
    return this.app.presence && this.app.presence.publish(STATE_PREFIX + kind, JSON.stringify(env), { retain: true }) ? env : null;
  }

  observeHello(code) { return makeEnvelope(this.keys.sign, 'observe', { code: String(code || '').toUpperCase() }, '*'); }

  players() { return this.list.map((p) => ({ ...p, party: p.party && { ...p.party } })); }

  onPlayers(fn) {
    this.fns.push(fn);
    return () => { this.fns = this.fns.filter((f) => f !== fn); };
  }

  totals() {
    const c = this.app.presence ? this.app.presence.counts : { total: 1, inMatch: 0, inLobby: 1 };
    const parties = new Set(this.list.filter((p) => p.party && p.party.code).map((p) => p.party.code));
    return { total: c.total, cards: this.list.length, inMatch: c.inMatch, inLobby: c.inLobby, parties: parties.size };
  }

  state() { return this.app.adminClient ? this.app.adminClient.stateNow() : { banner: null, maintenance: null }; }

  /** Open everyone's sealed cards (each once) and tell the panel when the list changed. */
  async refresh() {
    if (this.closed || this.busy) { this.again = !this.closed; return; }
    this.busy = true;
    try {
      const pres = this.app.presence;
      const peers = pres ? pres.cards() : [];
      const live = new Set();
      let opens = 0;
      const out = [];
      // (each card once; this.closed: admin mode went off meanwhile)
      const open = async (a) => {
        live.add(a.ct);
        if (!this.opened.has(a.ct)) {
          if (opens++ >= MAX_OPENS) return undefined;
          this.opened.set(a.ct, cleanCard(await openSealed(this.keys.box, a)));
        }
        return this.opened.get(a.ct);
      };
      for (const p of peers) {
        const card = await open(p.a);
        if (this.closed) return;
        // (a card copied from another page's message names that page, not this id: skipped)
        if (!card || card.id !== p.id) continue;
        // one page load keeps one key: cards for this id with another key mean someone fakes it
        // (the card before this one too: a fake its page put right at once was still a fake)
        const before = p.prev ? await open(p.prev) : null;
        if (this.closed) return;
        const known = this.pks.get(p.id);
        if (known === undefined) this.pks.set(p.id, card.pk);
        else if (known !== card.pk) this.suspects.add(p.id);
        if (before && before.id === p.id && before.pk !== card.pk) this.suspects.add(p.id);
        out.push({ ...card, me: false, s: p.s, seen: p.at, suspect: this.suspects.has(p.id) });
      }
      for (const ct of [...this.opened.keys()]) if (!live.has(ct)) this.opened.delete(ct);
      if (this.pks.size > 2000) { this.pks.clear(); this.suspects.clear(); } // (a flood of made-up ids)
      const mine = this.app.adminClient ? cleanCard(this.app.adminClient.card()) : null;
      if (mine) out.push({ ...mine, me: true, s: mine.phase === 'match' ? 'm' : 'l', seen: Date.now() });
      out.sort((a, b) => (b.me - a.me) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
      this.list = out;
      const key = JSON.stringify(out.map((p) => [p.id, p.name, p.level, p.account, p.mode, p.phase, p.party, p.v, p.admin, p.s, p.pk, p.suspect, p.muted]));
      if (key !== this.listKey) {
        this.listKey = key;
        for (const fn of this.fns) {
          try { fn(this.players()); } catch (e) { console.error('admin players', e); }
        }
      }
    } finally {
      this.busy = false;
      if (this.again && !this.closed) { this.again = false; setTimeout(() => this.refresh(), 0); }
    }
  }

  // ------------------------------------------------------------------ party chat moderation
  mute(id, minutes, reason = '') { return this.send('mute', { minutes, reason }, id); }

  unmute(id) { return this.send('unmute', {}, id); }

  /**
   * Ask player `id`'s page for its chat log: Promise<{ id, name, code, lines, at } | null> (null:
   * not sent, or no answer within ms). The page is told the admin looked (js/admin/client.js).
   */
  async requestLog(id, ms = LOG_WAIT_MS) {
    if (this.closed) return null;
    let env = null;
    try { env = await this.send('chatlog', {}, id); } catch (e) { env = null; }
    if (!env || this.closed) return null;
    const have = this.logs.get(env.n);
    if (have) return copyLog(have);
    return new Promise((resolve) => {
      const w = { id, resolve: (v) => { clearTimeout(w.timer); this.waiting.delete(env.n); resolve(v); } };
      w.timer = setTimeout(() => w.resolve(null), ms);
      this.waiting.set(env.n, w);
    });
  }

  /** The parties' live chat, newest party first (each party's last `max` lines, oldest first). */
  chats(max = PARTY_LINES) {
    return [...this.parties.values()].sort((a, b) => b.last - a.last).map((p) => ({
      code: p.code, host: this.hostName(p), from: p.from, ok: p.ok, last: p.last,
      count: p.lines.length, lines: p.lines.slice(-Math.max(1, max)).map((l) => ({ ...l })),
    }));
  }

  onChats(fn) {
    this.chatFns.push(fn);
    return () => { this.chatFns = this.chatFns.filter((f) => f !== fn); };
  }

  reports() {
    return this.reportList.map((r) => ({ ...r, line: { ...r.line }, context: r.context.map((l) => ({ ...l })) }));
  }

  unseenReports() { return this.unseen; }

  seenReports() {
    if (!this.unseen) return;
    this.unseen = 0;
    this.chatsChanged();
  }

  /** The host's name for a party's chat (from the card of the page that sent it, or the party's host). */
  hostName(p) {
    const c = this.list.find((x) => x.id === p.from) || this.list.find((x) => x.party && x.party.code === p.code && x.party.kind === 'host');
    return c ? c.name : '';
  }

  chatsChanged() {
    for (const fn of this.chatFns) {
      try { fn(); } catch (e) { console.error('admin chats', e); }
    }
  }

  /** An upload on UP_TOPIC (as it came off the broker): opened within the budget. -> the clean upload | null */
  async onUpload(text) {
    if (this.closed || typeof text !== 'string' || !text || text.length > UP_MAX) return null;
    let sealed;
    try { sealed = JSON.parse(text); } catch (e) { return null; }
    if (!upShape(sealed)) return null;
    const seal = `${sealed.e}|${sealed.iv}`;
    if (this.upSeen.has(seal)) return null;
    this.upSeen.add(seal);
    if (!(await this.upBudget.slot()) || this.closed) return null;
    const u = cleanUpload(await openSealed(this.keys.box, sealed, SEAL_UP, { max: UP_MAX }));
    if (!u || this.closed) return null;
    // which page really sealed it: e is the key in that page's card (js/admin/keys.js `from`)
    const card = this.list.find((c) => c.id === u.from) || null;
    u.ok = !!(card && card.pk && card.pk === sealed.e);
    u.name = card ? card.name : '';
    u.at = Date.now();
    if (u.k === 'chat') this.addChat(u, card);
    else if (u.k === 'log') this.addLog(u);
    else this.addReport(u);
    return u;
  }

  /** A host's page sent its party's new lines. */
  addChat(u, card) {
    // (the page it names hosts that party: as far as the admin can tell, the party's real chat)
    const ok = u.ok && !!card && !!card.party && card.party.code === u.code && card.party.kind === 'host';
    let p = this.parties.get(u.code);
    if (!p) {
      if (this.parties.size >= PARTIES) {
        let old = null;
        for (const x of this.parties.values()) if (!old || x.last < old.last) old = x;
        this.parties.delete(old.code);
      }
      p = { code: u.code, from: u.from, ok, last: 0, lines: [], keys: new Map() };
      this.parties.set(u.code, p);
    }
    let added = 0;
    for (const l of u.lines) {
      const k = lineKey(u.code, l);
      const had = p.keys.get(k);
      if (had) { if (ok) had.ok = true; continue; }
      const line = { ...l, got: u.at, ok };
      p.keys.set(k, line);
      p.lines.push(line);
      added++;
    }
    while (p.lines.length > PARTY_LINES) p.keys.delete(lineKey(u.code, p.lines.shift()));
    if (!added) return;
    // (a junk upload can't take a party over from its real host: only a checked one moves 'from')
    if (ok || !p.ok) { p.from = u.from; p.ok = ok; }
    p.last = u.at;
    this.chatsChanged();
  }

  /** A page's answer to 'chatlog': only from the page it was asked of, sealed with its own key. */
  addLog(u) {
    if (!this.sent.has(u.re)) return;
    const w = this.waiting.get(u.re);
    if (!u.ok || (w && u.from !== w.id)) return;
    const log = { id: u.from, name: u.name, code: u.code, lines: u.lines, at: u.at };
    this.logs.set(u.re, log);
    while (this.logs.size > LOGS) this.logs.delete(this.logs.keys().next().value);
    if (w) w.resolve(copyLog(log));
  }

  /** A player's 🚩 report. */
  addReport(u) {
    const line = u.line;
    const dup = this.reportList.find((r) => r.from === u.from && lineKey(r.code, r.line) === lineKey(line.code, line));
    if (dup) return;
    this.reportList.unshift({
      n: ++this.reportSeq, from: u.from, name: u.name, ok: u.ok, code: line.code, line, context: u.context, reason: u.reason, at: u.at,
    });
    if (this.reportList.length > REPORTS) this.reportList.length = REPORTS;
    this.unseen = Math.min(99, this.unseen + 1);
    this.chatsChanged();
    const t = Date.now(), ac = this.app.adminClient, panel = this.app.adminPanel;
    // (the panel open: its CHAT tab's badge says it; a toast would sit over its tabs)
    const looking = !!(panel && panel.root && panel.root.isConnected);
    if (!looking && t - this.toastAt > REPORT_TOAST_MS && ac && ac.notify) {
      this.toastAt = t;
      // (kind adm-report: the panel takes it away when it opens, js/ui/admin.js)
      try { ac.notify(`🚩 New chat report from <b>${esc(u.name || 'a player')}</b>: 🛡 ADMIN → 💬 CHAT`, 'adm-report', 7000); } catch (e) { /* the panel has it */ }
    }
  }

  /** Keep (true) or forget (false) the keys on this iPad. */
  async remember(on) {
    if (on) await rememberKeys(this.keys, this.cfg); else await forgetKeys();
    this.remembered = !!on;
  }

  /** Admin mode off on this page (the keys are dropped from memory; remembered ones stay). */
  close() {
    this.closed = true;
    clearInterval(this.timer);
    if (this.offCards) this.offCards();
    if (this.offUp) this.offUp();
    this.offUp = null;
    clearTimeout(this.upBudget.timer);
    for (const w of [...this.waiting.values()]) w.resolve(null);
    this.chatFns = [];
    this.parties.clear();
    this.reportList = [];
    this.logs.clear();
    this.fns = [];
    this.keys = null;
    this.opened.clear();
  }

  /** Admin mode off on this page, and the remembered keys forgotten too (ADMIN SIGN OUT). */
  async signOut() {
    this.close();
    await forgetKeys();
  }
}

function copyLog(l) { return { ...l, lines: l.lines.map((x) => ({ ...x })) }; }
