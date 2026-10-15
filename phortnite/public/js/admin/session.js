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
//                                         ('bans', {list: [{r, d?}]})  the whole ban list (banAccount /
//                                                                      unbanAccount make it)
//   app.admin.players()                -> [card] everyone online with a readable card, this page
//                                         included (me: true): { id, me, name, level, account,
//                                         mode, phase, party: {code, kind, size, pid?} | null (pid:
//                                         its player id in that party's room, the id its chat lines
//                                         carry), v, since,
//                                         admin, pk, s: 'l' | 'm', seen (ms), suspect: true when
//                                         cards with different keys came for that id (someone is
//                                         faking it: commands still reach only the real page),
//                                         rid: its signed-in account's registry id, only when the
//                                         card's token proves it (rids are public topic names: a
//                                         card can't claim someone else's account) }
//   app.admin.onPlayers(fn)            -> off(); fn(players()) whenever the list changes
//   app.admin.totals()                 -> { total (everyone counted, cards or not), cards, inMatch,
//                                         inLobby, parties }
//   app.admin.state()                  -> { banner: {text, id, until} | null,
//                                           maintenance: {on, text, until} | null } as this page has them
//   app.admin.observeHello(code)       -> Promise<envelope> a signed {cmd: 'observe', args: {code}}
//                                         for stage E's observer hello (good for 2 minutes)
//   app.admin.sayEnvelope(code, text)  -> Promise<envelope> a signed {cmd: 'say', args: {code, text}}
//                                         for his own chat line in the party he watches (js/ui/chat.js:
//                                         pages show the 🛡 ADMIN tag only with it)
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
//                                         line, context, reason, at }] newest first (50 kept: when
//                                         full, an unchecked one goes first, else the oldest of
//                                         whoever has the most kept, so one page's flood pushes out
//                                         its own reports, never other players')
//   app.admin.unseenReports() / .seenReports()   the CHAT tab's badge
//   app.admin.requestLog(id)           -> Promise<{ id, name, code, lines, at } | null> sends
//                                         'chatlog' to that page and waits (LOG_WAIT_MS) for its
//                                         sealed answer (null: no answer, offline, an older version)
//   app.admin.mute(id, minutes, reason) / .unmute(id)   -> Promise<envelope | null> (send())
// Uploads come in on UP_TOPIC (js/admin/commands.js), opened here only, and sorted BEFORE anything
// is opened: a real page always seals with the key in its own card (e), so an upload whose key no
// card has can never be checked and gets a small lane of its own (ODD_RATE per UP_RATE_MS); one
// with a card's key goes in the main lane (UP_RATE per UP_RATE_MS), at most UP_KEY_RATE per key
// (the rest of that key's go to the small lane). So made-up junk, however much, can't push a real
// page's 🚩 report or chat log out (the key is in the clear on the broker: someone who copies a
// few real keys could still crowd the main lane for a while, never for long). A size cap before
// anything is parsed, junk dropped, and cleaning (every line through the chat filter again) gets
// at most UP_CLEAN_MS per upload (past its newest UP_CONTEXT lines, always cleaned) and UP_WORK_MS
// of each UP_RATE_MS per lane: lines made up to be slow to filter can't freeze the iPad. Nothing
// kept but PARTIES parties x PARTY_LINES lines, REPORTS reports and LOGS chat logs (memory only: a
// reload forgets them). Anyone can seal something to the admin's public key, so an upload is only
// "as reported by that page": ok is true when it was sealed with the key in the card of the page
// it names (and for live chat, that page's card says it hosts that party, and no other card does).
// The panel shows the rest marked, and unchecked uploads never push checked ones out: when full,
// the quietest unchecked party goes first (an unchecked newcomer is dropped when every party kept
// is checked), a checked party's unchecked lines go before its real ones, and unchecked reports
// go first. Reports and live chat reach only this page while it is open: UP_TOPIC isn't retained.
// Accounts (js/accounts/registry.js): every page's signed-in account has a sealed, retained entry on
// REG_PREFIX + rid; this page hears them all (REG_FILTER: the broker hands over every retained one
// at once) and opens them within a budget (ACCT_RATE per ACCT_RATE_MS, the newest text per account
// waiting, a size cap before anything is parsed, at most ACCTS_MAX accounts kept or waiting: what is
// dropped is counted and logged), junk ignored; an empty message means that entry was deleted.
// The registry lives on the public brokers: a broker that forgets it gets each entry back the next
// time its page connects, so the list fills in again as players come back.
//   app.admin.accounts()               -> [{ rid, name, created, seen, level, wins, matches, kills,
//                                         did, v, online (a live card has this rid), banned (on the
//                                         ban list), suspect (someone put a made-up entry for it on
//                                         the relay: ignored, the row is still the account's own),
//                                         isNew (made since the admin last opened the ACCOUNTS tab),
//                                         gone (banned, its entry no longer on the broker: from this
//                                         page's memory), mine (an account on this iPad: never banned
//                                         from here), reason, bannedAt, bannedLive (the ban already
//                                         reached a page online with it: that iPad is banned now) }]
//                                         newest first
//   app.admin.onAccounts(fn)           -> off(); fn(accounts()) when it changed
//   app.admin.newAccounts() / .seenAccounts({fresh})   the ACCOUNTS tab's NEW badge
//   app.admin.accountStats()           -> { total, waiting, dropped: {big, junk, full, bad} }
//   app.admin.bans()                   -> [{ r, d? }] the ban list now (the newest signed one this
//                                         page has: from the broker, or its own last)
//   app.admin.banAccount(rid, { did, reason, name })  -> Promise<{ env, online, sent } | null> rid
//                                         (and its device id, hashed one way: registry.js banDid)
//                                         onto the list, signed and published retained; a page online
//                                         with that account is also sent the live 'ban' at once; the
//                                         rest are banned the next time they open Phortnite. null:
//                                         offline. Throws for one of this iPad's own accounts, or a
//                                         full list (BANS_MAX).
//   app.admin.unbanAccount(rid)        -> Promise<envelope | null> off the list: a ban that hasn't
//                                         happened yet never does (almost always: an older list put
//                                         back on the relay can still reach an iPad that hasn't
//                                         opened Phortnite since); an iPad already banned stays
//                                         banned until Philip's unban code is typed on it, AFTER it
//                                         is off the list (typed while it's still on, the game bans
//                                         that iPad again as soon as it opens)
// Every entry proves itself: its tok must hash to the rid of its topic (registry.js tokMatches),
// which only a device that has the account (or the admin) can do; a made-up entry for a real
// account's topic is dropped (counted 'bad'), and the account's row, when this page knows it,
// stays as it was and is marked suspect (someone tried). As a second check the first tok seen for
// a rid is remembered (ACCT_MEM_KEY) and an entry with another one is treated the same. What this
// page remembers per account, in localStorage ACCT_MEM_KEY ({ rid: { tok, name, created, did,
// reason, at, live, t } }, at most ACCT_MEM_MAX): names and reasons stay here, never on the broker
// (the signed list carries ids only). The newest list this page signed is kept too (BANS_KEY, ids
// only), and after every connect it goes back on the broker unless that connection handed it over
// exactly as signed (the broker forgot it, someone deleted or spoiled it, or this page moved to
// another of the free brokers: they don't share messages).
// Nothing here logs the password or a key; the keys are non-extractable CryptoKeys.
import {
  CMD_TOPIC, STATE_PREFIX, PARTY_CMDS, PUBLIC_ARGS, ALL_OK, makeEnvelope, cleanCard, Lru, Budget, UP_TOPIC, UP_MAX, upShape, cleanUpload,
  cleanArgs, cleanName, BANS_MAX, BANS_TEXT_MAX,
} from './commands.js';
import { openSealed, keysMatch, importBoxPub, verifyCommand, SEAL_UP, SEAL_ACCT } from './keys.js';
import {
  REG_PREFIX, REG_FILTER, REG_MAX, RID_RE, TOK_RE, DID_RE, regShape, cleanRegistration, accountIds, cachedIds, tokMatches, banDid,
} from '../accounts/registry.js';

const IDB = 'phortnite-admin'; // IndexedDB: object store 'kv', the remembered keys under 'keys'
const MAX_OPENS = 300; // cards opened per refresh at most (a flood of junk can't stall the iPad)
// remembered keys are forgotten after this long: any page on the same website (origin) could use
// them (not read them) while they are kept, so not for ever
export const REMEMBER_DAYS = 30;
// uploads (party chat moderation): opened at most UP_RATE per UP_RATE_MS (a flood of junk can't
// stall the iPad: the newest wait for room, older ones are dropped), and what is kept, at most
export const UP_RATE = 30;
export const UP_RATE_MS = 10000;
// (sealed with a card's key: at most this many per key in the main lane, per UP_RATE_MS; a real
// page sends fewer: a live batch every 3 s at most, 5 reports a minute, chat logs only when the
// admin asks. Any more go to the small lane, not lost)
export const UP_KEY_RATE = 10;
// (sealed with a key no card has: never checked, so a small lane of their own)
export const ODD_RATE = 5;
// cleaning: at most UP_CLEAN_MS per upload (the newest lines first, the newest UP_CONTEXT always)
// and UP_WORK_MS of each UP_RATE_MS in the main lane (ODD_WORK_MS in the small one). A real upload
// takes a few ms: the room filtered its lines already
export const UP_CLEAN_MS = 150;
export const UP_WORK_MS = 1000;
const ODD_WORK_MS = 250;
const UP_KEYS_MAX = 500; // card keys whose uploads are counted
export const PARTY_LINES = 500;
export const PARTIES = 30;
export const REPORTS = 50;
const LOGS = 20;
export const LOG_WAIT_MS = 10000; // requestLog gives up after this long
const REPORT_TOAST_MS = 10000; // "🚩 New chat report" on the admin's screen at most this often
// accounts (the registry) and the ban list
export const ACCT_RATE = 40; // entries opened per ACCT_RATE_MS at most
export const ACCT_RATE_MS = 1000;
export const ACCTS_MAX = 3000; // accounts kept (and waiting to be opened) at most
export const ACCT_MEM_MAX = 2000; // accounts this page remembers (localStorage) at most
export const ACCT_MEM_KEY = 'phortnite.adminAccounts';
export const ACCT_SEEN_KEY = 'phortnite.adminAccountsSeen'; // when the ACCOUNTS tab was last opened
export const BANS_KEY = 'phortnite.adminBans'; // the newest ban list this page signed (ids only)
const BANS_BACK_MS = 4000; // after a connect: the broker didn't hand back the newest list by then -> it goes back
const cleanText = (v, max) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max) : '');
const int = (v) => (Number.isFinite(v) ? Math.max(0, Math.min(8.64e15, Math.floor(v))) : 0);
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
    this.upBudget = new Budget({ rate: UP_RATE, ms: UP_RATE_MS, queue: 8 }); // sealed with a card's key
    this.upOdd = new Budget({ rate: ODD_RATE, ms: UP_RATE_MS, queue: 2 }); // with a key no card has
    this.upKeys = new Map(); // card key -> when its last uploads were let into the main lane
    this.upKeyMax = UP_KEY_RATE;
    // cleaning time spent per lane in this UP_RATE_MS (workNow: ms, performance.now)
    this.upWork = { card: { at: 0, ms: 0, max: UP_WORK_MS }, odd: { at: 0, ms: 0, max: ODD_WORK_MS } };
    this.workNow = () => performance.now();
    this.toastAt = 0;
    this.offUp = app.presence && app.presence.listen ? app.presence.listen(UP_TOPIC, (text) => { this.onUpload(text); }) : null;
    // accounts (the registry) and the ban list
    this.accts = new Map(); // rid -> { rid, name, created, seen, level, wins, matches, kills, did, v, suspect, text }
    this.acctWait = new Map(); // rid -> the newest sealed text waiting to be opened
    this.acctDrops = { big: 0, junk: 0, full: 0, bad: 0 };
    this.acctBudget = new Budget({ rate: ACCT_RATE, ms: ACCT_RATE_MS });
    this.acctTimer = 0;
    this.acctBusy = false;
    this.acctFns = [];
    this.mem = readMem();
    this.seenAt = readNum(ACCT_SEEN_KEY);
    this.markFrom = null; // the ACCOUNTS tab open: rows made after this are NEW (seenAt before it was opened)
    this.myBans = null; // { list, ts, env }: the newest list this page signed
    this.myBansReady = readMyBans(pubs).then((b) => { if (b && !this.closed && !(this.myBans && this.myBans.ts >= b.ts)) this.myBans = b; });
    this.offAcct = app.presence && app.presence.listen ? app.presence.listen(REG_FILTER, (text, topic) => { this.onRegistration(text, topic); }) : null;
    this.connectAt = Date.now(); // (the ban list handed over since then counts for this connection)
    this.offConnect = app.presence && typeof app.presence.onConnect === 'function'
      ? app.presence.onConnect(() => { this.connectAt = Date.now(); this.bansBack(); }) : null;
    this.bansBack(); // (admin mode just started: did the broker keep the newest list?)
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
    let now = Date.now();
    let args;
    if (kind === 'banner') {
      const mins = Number(payload.minutes) || 0;
      const text = String(payload.text || '').trim().slice(0, 200);
      args = { text, id: text ? `b${now.toString(36)}` : '', until: text && mins > 0 ? now + Math.round(mins * 60000) : 0 };
    } else if (kind === 'maintenance') {
      const hours = Math.max(0.1, Math.min(168, Number(payload.hours) || 12));
      args = { on: !!payload.on, text: String(payload.text || '').trim().slice(0, 300), until: payload.on ? now + Math.round(hours * 3600000) : 0 };
    } else if (kind === 'bans') {
      args = cleanArgs('bans', { list: payload.list });
      if (!args) throw new Error('not a ban list');
      // too long for the brokers: the oldest entries go without their device id (the account stays banned)
      const room = BANS_TEXT_MAX - 320; // (the rest of the envelope: cmd, ts, n, the signature)
      for (let i = 0; i < args.list.length && JSON.stringify(args).length > room; i++) if (args.list[i].d) args.list[i] = { r: args.list[i].r };
      // (a page only takes a newer list: never the same ms twice)
      now = Math.max(now, this.bansTs() + 1);
    } else throw new Error(`unknown state ${kind}`);
    const env = await makeEnvelope(this.keys.sign, kind, args, '*', now);
    this.sent.add(env.n);
    const text = JSON.stringify(env);
    if (kind === 'bans' && text.length > BANS_TEXT_MAX) throw new Error('The ban list is too long.');
    if (!(this.app.presence && this.app.presence.publish(STATE_PREFIX + kind, text, { retain: true }))) return null;
    if (kind === 'bans') {
      this.myBans = { list: args.list.map((e) => ({ ...e })), ts: env.ts, env };
      writeJson(BANS_KEY, env);
      this.accountsChanged();
    }
    return env;
  }

  observeHello(code) { return makeEnvelope(this.keys.sign, 'observe', { code: String(code || '').toUpperCase() }, '*'); }

  /**
   * The admin's own chat line in the party he watches (js/ui/chat.js sends it with the line): a
   * signed {cmd: 'say', args: {code, text}}. Every page checks it (commands.js adminLineOk) before
   * the line gets the 🛡 ADMIN tag, so a modded host page can't pass its own lines off as his.
   */
  sayEnvelope(code, text) { return makeEnvelope(this.keys.sign, 'say', { code: String(code || '').toUpperCase(), text }, '*'); }

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
          this.opened.set(a.ct, await checkedCard(await openSealed(this.keys && this.keys.box, a)));
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
      if (mine) delete mine.tok; // (this page's own card: its rid is its own)
      if (mine) out.push({ ...mine, me: true, s: mine.phase === 'match' ? 'm' : 'l', seen: Date.now() });
      out.sort((a, b) => (b.me - a.me) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
      this.list = out;
      const key = JSON.stringify(out.map((p) => [p.id, p.name, p.level, p.account, p.mode, p.phase, p.party, p.v, p.admin, p.s, p.pk, p.suspect, p.muted, p.rid]));
      if (key !== this.listKey) {
        this.listKey = key;
        this.accountsChanged(); // (who is online)
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
    // sorted before anything is opened (see the top): a key no card has can never be checked
    const lane = this.list.some((c) => c.pk && c.pk === sealed.e) && this.upKeyRoom(sealed.e) ? 'card' : 'odd';
    if (!(await (lane === 'card' ? this.upBudget : this.upOdd).slot()) || this.closed) return null;
    const o = await openSealed(this.keys.box, sealed, SEAL_UP, { max: UP_MAX });
    if (!o || this.closed) return null;
    // (after the await: uploads opened together are cleaned one at a time, each within the lane's time)
    const w = this.upWork[lane], now = this.workNow();
    if (!(now - w.at < UP_RATE_MS)) { w.at = now; w.ms = 0; }
    if (w.ms >= w.max) return null;
    const u = cleanUpload(o, { until: now + UP_CLEAN_MS, now: this.workNow });
    w.ms += Math.max(0, this.workNow() - now);
    if (!u) return null;
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

  /** A card key's turn in the main upload lane (UP_KEY_RATE per UP_RATE_MS): true, counted, when it has room. */
  upKeyRoom(e) {
    const t = Date.now(), list = this.upKeys.get(e) || [];
    while (list.length && t - list[0] >= UP_RATE_MS) list.shift();
    if (list.length >= this.upKeyMax) return false;
    list.push(t);
    this.upKeys.delete(e); // (kept newest last: the longest quiet keys are forgotten first)
    this.upKeys.set(e, list);
    if (this.upKeys.size > UP_KEYS_MAX) this.upKeys.delete(this.upKeys.keys().next().value);
    return true;
  }

  /** A host's page sent its party's new lines. */
  addChat(u, card) {
    // (the page it names hosts that party, and no other card says it does: as far as the admin can
    // tell, the party's real chat)
    const ok = u.ok && !!card && !!card.party && card.party.code === u.code && card.party.kind === 'host'
      && this.list.filter((c) => c.party && c.party.code === u.code && c.party.kind === 'host').length === 1;
    let p = this.parties.get(u.code);
    if (!p) {
      if (this.parties.size >= PARTIES) {
        // (the quietest goes, an unchecked party before any checked one; an unchecked newcomer is
        // dropped when every party kept is checked: made-up uploads with new codes can't push a
        // real host's chat out of the admin's view)
        let old = null;
        for (const x of this.parties.values()) if (!old || (x.ok !== old.ok ? !x.ok : x.last < old.last)) old = x;
        if (old.ok && !ok) return;
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
    // (PARTY_LINES at most, the oldest go; in a checked party its unchecked lines go first: made-up
    // lines can't push the real host's out)
    while (p.lines.length > PARTY_LINES) {
      const j = p.ok ? p.lines.findIndex((l) => !l.ok) : -1;
      p.keys.delete(lineKey(u.code, p.lines.splice(Math.max(0, j), 1)[0]));
    }
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
    // (the same one twice: once. A made-up copy sent first can't keep the real, checked one out)
    const dup = this.reportList.find((r) => r.from === u.from && (r.ok || !u.ok) && lineKey(r.code, r.line) === lineKey(line.code, line));
    if (dup) return;
    const list = this.reportList;
    list.unshift({
      n: ++this.reportSeq, from: u.from, name: u.name, ok: u.ok, code: line.code, line, context: u.context, reason: u.reason, at: u.at,
    });
    if (list.length > REPORTS) {
      // (one goes: the oldest unchecked one; none: the oldest of whoever has the most kept, so a
      // flood of made-up reports, or one page's own flood, never pushes out other players' reports)
      let i = -1;
      for (let j = list.length - 1; j >= 0 && i < 0; j--) if (!list[j].ok) i = j;
      if (i < 0) {
        const kept = new Map();
        for (const r of list) kept.set(r.from, (kept.get(r.from) || 0) + 1);
        const most = Math.max(...kept.values());
        for (let j = list.length - 1; j >= 0 && i < 0; j--) if (kept.get(list[j].from) === most) i = j;
      }
      list.splice(i, 1);
      if (i === 0) return; // (the newcomer itself: nothing new to show)
    }
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

  // ------------------------------------------------------------------ accounts (the registry) + the ban list
  /** A registry entry as it came off the broker (REG_PREFIX + rid): queued for opening, or a deletion. */
  onRegistration(text, topic) {
    if (this.closed || typeof topic !== 'string' || !topic.startsWith(REG_PREFIX)) return;
    const rid = topic.slice(REG_PREFIX.length);
    if (!RID_RE.test(rid)) { this.drop('junk'); return; }
    if (!text) {
      // deleted (its account was deleted on its iPad; or someone wiped it: it comes back when that iPad connects)
      this.acctWait.delete(rid);
      if (this.accts.delete(rid)) this.accountsChanged();
      return;
    }
    if (typeof text !== 'string' || text.length > REG_MAX) { this.drop('big'); return; }
    const had = this.accts.get(rid);
    if (had && had.text === text) return; // (the same one again)
    if (!had && !this.acctWait.has(rid) && this.accts.size + this.acctWait.size >= ACCTS_MAX) { this.drop('full'); return; }
    this.acctWait.set(rid, text);
    this.pumpAccts();
  }

  /** Open waiting entries, ACCT_RATE per ACCT_RATE_MS at most (a flood of junk can't stall the iPad). */
  pumpAccts() {
    if (this.acctBusy || this.acctTimer || this.closed) return;
    this.acctBusy = true;
    (async () => {
      let changed = false;
      try {
        while (this.acctWait.size && !this.closed && this.acctBudget.take()) {
          const [rid, text] = this.acctWait.entries().next().value;
          this.acctWait.delete(rid);
          if (await this.openRegistration(rid, text)) changed = true;
        }
      } catch (e) {
        console.error('admin accounts', e);
      } finally {
        this.acctBusy = false;
        if (changed) this.accountsChanged();
        if (this.acctWait.size && !this.closed) {
          const b = this.acctBudget, wait = b.t.length ? b.t[0] + b.ms - b.now() + 5 : 0;
          this.acctTimer = setTimeout(() => { this.acctTimer = 0; this.pumpAccts(); }, Math.max(20, wait));
        }
      }
    })();
  }

  /** Open one entry (SEAL_ACCT), check it, keep it. -> true when the list changed. */
  async openRegistration(rid, text) {
    let sealed = null;
    try { sealed = JSON.parse(text); } catch (e) { sealed = null; }
    if (!regShape(sealed)) { this.drop('junk'); return false; }
    const reg = cleanRegistration(await openSealed(this.keys && this.keys.box, sealed, SEAL_ACCT, { max: REG_MAX }), rid);
    if (this.closed) return false;
    if (!reg) { this.drop('bad'); return false; }
    // its tok must hash to the topic's rid: everyone can see the rid (it is the topic), only a device
    // that has the account (or the admin) knows its tok
    const real = await tokMatches(rid, reg.tok);
    if (this.closed) return false;
    const had = this.accts.get(rid), m = this.mem[rid];
    if (!real || (m && m.tok && m.tok !== reg.tok)) {
      // a made-up entry under a real account's topic (or, the second check, not the tok first seen
      // for it): dropped. The account's row, when this page knows it, stays as it was (never the
      // newcomer's name, stats or iPad), marked: someone tried. Unknown here: nothing is listed.
      this.drop('bad');
      if (!had && !(m && (m.tok || m.name))) return false;
      const old = had || { rid, name: m.name || 'Unknown account', created: m.created || 0, seen: 0, level: 1, wins: 0, matches: 0, kills: 0, did: m.did || '', v: '' };
      this.accts.set(rid, { ...old, suspect: true, text });
      return true;
    }
    this.memo(rid, { tok: reg.tok, name: reg.name, created: reg.created, did: reg.did });
    const { tok, ...rest } = reg;
    this.accts.set(rid, { ...rest, suspect: !!(had && had.suspect), text });
    return true;
  }

  drop(why) {
    this.acctDrops[why] = (this.acctDrops[why] || 0) + 1;
    const t = Date.now();
    if (t - (this.dropLog || 0) > 10000) {
      this.dropLog = t;
      console.warn('admin accounts: registry entries dropped so far', JSON.stringify(this.acctDrops));
    }
  }

  /** What this page remembers about an account (merged in; written to localStorage soon). */
  memo(rid, patch) {
    const m = this.mem[rid];
    this.mem[rid] = { ...(m || {}), ...patch, t: Date.now() };
    if (!m) this.trimMem();
    this.saveMemSoon();
  }

  /** At most ACCT_MEM_MAX remembered: the longest unseen go first, banned accounts last of all. */
  trimMem() {
    const ids = Object.keys(this.mem);
    if (ids.length <= ACCT_MEM_MAX) return;
    const banned = new Set(this.bans().map((b) => b.r));
    ids.sort((a, b) => (banned.has(a) - banned.has(b)) || ((this.mem[a].t || 0) - (this.mem[b].t || 0)));
    for (const id of ids.slice(0, ids.length - ACCT_MEM_MAX)) delete this.mem[id];
  }

  saveMemSoon() {
    if (this.memTimer) return;
    this.memTimer = setTimeout(() => { this.memTimer = 0; this.saveMem(); }, 500);
  }

  saveMem() {
    clearTimeout(this.memTimer);
    this.memTimer = 0;
    writeJson(ACCT_MEM_KEY, this.mem);
  }

  /** The rids of the accounts kept on this iPad (the admin's own: never banned from here). */
  localRids() {
    const app = this.app, ids = new Set(), out = new Set();
    try { if (app.accounts && typeof app.accounts.list === 'function') for (const p of app.accounts.list()) if (p && p.id) ids.add(p.id); } catch (e) { /* none */ }
    const acc = app.activeAccount;
    if (acc && !acc.guest && acc.id && acc.id !== 'guest') ids.add(acc.id);
    for (const id of ids) {
      const c = cachedIds(id);
      if (c) out.add(c.rid);
      else accountIds(id).then(() => this.accountsChanged(), () => {});
    }
    return out;
  }

  accounts() {
    const bans = new Map(this.bans().map((b) => [b.r, b]));
    const online = new Set(this.list.map((c) => c.rid).filter(Boolean));
    const mine = this.localRids();
    const from = this.markFrom === null ? this.seenAt : this.markFrom;
    const row = (e, extra = {}) => {
      const banned = bans.has(e.rid), m = this.mem[e.rid] || {};
      return {
        rid: e.rid, name: e.name, created: e.created, seen: e.seen, level: e.level, wins: e.wins, matches: e.matches, kills: e.kills,
        did: e.did, v: e.v, online: online.has(e.rid), banned, suspect: !!e.suspect, isNew: e.created > from, gone: false,
        mine: mine.has(e.rid), reason: banned ? m.reason || '' : '', bannedAt: banned ? m.at || 0 : 0, bannedLive: banned && !!m.live, ...extra,
      };
    };
    const out = [...this.accts.values()].map((e) => row(e));
    // banned, but its entry is gone from the broker: still listed (from this page's memory), so the ban can come off
    for (const b of bans.values()) {
      if (this.accts.has(b.r)) continue;
      const m = this.mem[b.r] || {};
      // (did: the raw one this page remembers; the list's d is a one-way hash)
      out.push(row({ rid: b.r, name: m.name || 'Unknown account', created: m.created || 0, seen: 0, level: 1, wins: 0, matches: 0, kills: 0, did: m.did || '', v: '' }, { gone: true, isNew: false }));
    }
    out.sort((a, b) => (b.created - a.created) || a.name.localeCompare(b.name) || a.rid.localeCompare(b.rid));
    return out;
  }

  onAccounts(fn) {
    this.acctFns.push(fn);
    return () => { this.acctFns = this.acctFns.filter((f) => f !== fn); };
  }

  /** The panel hears the new list a moment later (many entries at once: one redraw). */
  accountsChanged() {
    if (this.acctNotify || this.closed || !this.acctFns.length) return;
    this.acctNotify = setTimeout(() => {
      this.acctNotify = 0;
      if (this.closed) return;
      const list = this.accounts();
      for (const fn of this.acctFns) {
        try { fn(list); } catch (e) { console.error('admin accounts', e); }
      }
    }, 150);
  }

  /** The ACCOUNTS tab's badge: accounts made since it was last opened. */
  newAccounts() {
    let n = 0;
    for (const e of this.accts.values()) if (e.created > this.seenAt) n++;
    return n;
  }

  /** The ACCOUNTS tab is on screen. fresh: just opened (the rows made since last time stay NEW while it is). */
  seenAccounts({ fresh = true } = {}) {
    if (fresh || this.markFrom === null) this.markFrom = this.seenAt;
    this.seenAt = Date.now();
    writeJson(ACCT_SEEN_KEY, this.seenAt);
  }

  accountStats() {
    return { total: this.accts.size, waiting: this.acctWait.size, dropped: { ...this.acctDrops } };
  }

  /** The newest ban list this page has: its own last one, or a newer one from the broker. */
  bansNow() {
    const c = this.app.adminClient, st = c && c.states ? c.states.bans : null;
    const mine = this.myBans;
    if (mine && (!st || mine.ts >= st.ts)) return { list: mine.list, ts: mine.ts };
    return st && st.args && Array.isArray(st.args.list) ? { list: st.args.list, ts: st.ts } : { list: [], ts: 0 };
  }

  bans() { return this.bansNow().list.map((e) => (e.d ? { r: e.r, d: e.d } : { r: e.r })); }

  bansTs() { return this.bansNow().ts; }

  /** A newer ban list came in (js/admin/client.js). */
  bansChanged() { this.accountsChanged(); }

  /**
   * After a connect (and when admin mode starts): unless THIS connection handed over the newest
   * list this page has, exactly as signed (js/admin/client.js heardBans), it goes back: the broker
   * forgot it, someone deleted or spoiled it or put an older one there, or this page is on another
   * of the free brokers now (they don't share messages). Still signed: pages check it as usual, and
   * one that has it already ignores it.
   */
  bansBack() {
    clearTimeout(this.bansTimer);
    this.bansTimer = setTimeout(async () => {
      await this.myBansReady;
      const mine = this.myBans, c = this.app.adminClient, st = c && c.states ? c.states.bans : null;
      if (this.closed) return;
      // the newest signed list: this page's own last one, or a newer one from the broker
      const best = mine && mine.env && !(st && st.env && st.ts > mine.ts) ? mine.env : st && st.env ? st.env : null;
      if (!best) return;
      const text = JSON.stringify(best), h = c && c.heardBans;
      if (h && h.at >= this.connectAt && h.text === text) return;
      if (this.app.presence) this.app.presence.publish(STATE_PREFIX + 'bans', text, { retain: true });
    }, BANS_BACK_MS);
  }

  /** Ban an account (see the top): Promise<{ env, online, sent } | null>. */
  async banAccount(rid, { did = '', reason = '', name = '' } = {}) {
    if (this.closed) return null;
    if (typeof rid !== 'string' || !RID_RE.test(rid)) throw new Error('That is not an account.');
    if (this.localRids().has(rid)) throw new Error("That's an account on this iPad (yours): it can't be banned from here.");
    const e = this.accts.get(rid), m = this.mem[rid] || {};
    // its iPad's id (as its entry sealed it to this page), on the public list only one-way hashed
    const raw = [did, e && e.did, m.did].find((x) => typeof x === 'string' && DID_RE.test(x)) || '';
    const d = raw ? await banDid(raw) : '';
    if (this.closed) return null;
    const list = this.bans().filter((b) => b.r !== rid);
    if (list.length >= BANS_MAX) throw new Error(`The ban list is full (${BANS_MAX} bans): take an old one off first.`);
    list.push(d ? { r: rid, d } : { r: rid });
    const why = cleanText(reason, 120);
    // online right now: the live ban too, at once, sent just before the list (it carries the reason;
    // a ban from the list itself says "The admin banned this account")
    const live = this.list.filter((c) => c.rid === rid && !c.me);
    let sent = 0;
    for (const c of live) {
      try { if (await this.send('ban', { reason: why }, c.id)) sent++; } catch (err) { /* an older game: the list bans it */ }
    }
    const env = await this.sendState('bans', { list });
    if (!env) return null;
    const nm = cleanName(name) || (e && e.name) || m.name || '';
    // (live: the ban reached a page online with it, so that iPad is banned now: REMOVE BAN says so)
    this.memo(rid, { reason: why, at: Date.now(), live: live.length ? Date.now() : 0, ...(nm ? { name: nm } : {}) });
    this.saveMem();
    this.accountsChanged();
    return { env, online: live.length, sent };
  }

  /** Take an account off the ban list: Promise<envelope | null>. */
  async unbanAccount(rid) {
    if (this.closed) return null;
    const env = await this.sendState('bans', { list: this.bans().filter((b) => b.r !== rid) });
    if (!env) return null;
    const m = this.mem[rid];
    if (m) { delete m.reason; delete m.at; delete m.live; this.saveMem(); }
    this.accountsChanged();
    return env;
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
    clearTimeout(this.upOdd.timer);
    for (const w of [...this.waiting.values()]) w.resolve(null);
    this.chatFns = [];
    this.parties.clear();
    this.reportList = [];
    this.logs.clear();
    this.fns = [];
    // accounts
    if (this.offAcct) this.offAcct();
    if (this.offConnect) this.offConnect();
    this.offAcct = this.offConnect = null;
    clearTimeout(this.acctTimer);
    clearTimeout(this.acctNotify);
    clearTimeout(this.bansTimer);
    clearTimeout(this.acctBudget.timer);
    if (this.memTimer) this.saveMem();
    this.acctFns = [];
    this.acctWait.clear();
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

/**
 * A peer's opened card, cleaned (js/admin/commands.js cleanCard): its rid kept only when the
 * card's tok proves it (registry.js tokMatches; rids are public topic names, so a made-up card
 * could name anyone's account), and the tok itself dropped (never shown, never kept).
 */
async function checkedCard(raw) {
  const card = cleanCard(raw);
  if (!card) return null;
  const { tok, ...out } = card;
  if (out.rid && !(await tokMatches(out.rid, tok))) delete out.rid;
  return out;
}

function localStore() { try { return globalThis.localStorage || null; } catch (e) { return null; } }
function readJson(key) {
  try { const st = localStore(); return st ? JSON.parse(st.getItem(key) || 'null') : null; } catch (e) { return null; }
}
function writeJson(key, v) {
  try { const st = localStore(); if (st) st.setItem(key, JSON.stringify(v)); } catch (e) { /* private mode: this visit only */ }
}
function readNum(key) { const v = readJson(key); return Number.isFinite(v) ? v : 0; }

/** What the admin's page remembers per account (ACCT_MEM_KEY), cleaned. */
function readMem() {
  const out = Object.create(null), d = readJson(ACCT_MEM_KEY);
  if (!d || typeof d !== 'object' || Array.isArray(d)) return out;
  for (const rid of Object.keys(d).slice(0, ACCT_MEM_MAX * 2)) {
    const m = d[rid];
    if (!RID_RE.test(rid) || !m || typeof m !== 'object') continue;
    const o = { t: int(m.t) };
    if (typeof m.tok === 'string' && TOK_RE.test(m.tok)) o.tok = m.tok;
    if (cleanName(m.name)) o.name = cleanName(m.name);
    if (int(m.created)) o.created = int(m.created);
    if (typeof m.did === 'string' && DID_RE.test(m.did)) o.did = m.did;
    if (typeof m.reason === 'string') o.reason = cleanText(m.reason, 120);
    if (int(m.at)) o.at = int(m.at);
    if (int(m.live)) o.live = int(m.live);
    out[rid] = o;
  }
  return out;
}

/** The newest ban list this page signed (BANS_KEY): { list, ts, env } when the admin key still signs it. */
async function readMyBans(pubs) {
  try {
    const env = readJson(BANS_KEY);
    if (!env || typeof env !== 'object' || env.cmd !== 'bans' || env.to !== '*' || !Number.isFinite(env.ts)) return null;
    const args = cleanArgs('bans', env.args);
    if (!args || !(await verifyCommand(pubs.signPub, env))) return null;
    return { list: args.list, ts: env.ts, env };
  } catch (e) { return null; }
}
