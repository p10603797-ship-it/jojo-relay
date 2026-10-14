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
// Nothing here logs the password or a key; the keys are non-extractable CryptoKeys.
import { CMD_TOPIC, STATE_PREFIX, PARTY_CMDS, PUBLIC_ARGS, makeEnvelope, cleanCard, Lru } from './commands.js';
import { openSealed, keysMatch, importBoxPub } from './keys.js';

const IDB = 'phortnite-admin'; // IndexedDB: object store 'kv', the remembered keys under 'keys'
const MAX_OPENS = 300; // cards opened per refresh at most (a flood of junk can't stall the iPad)
// remembered keys are forgotten after this long: any page on the same website (origin) could use
// them (not read them) while they are kept, so not for ever
export const REMEMBER_DAYS = 30;

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
    this.refresh();
  }

  get myId() { return this.app.presence ? this.app.presence.id : ''; }

  async send(cmd, args = {}, to = '*') {
    if (this.closed) return null;
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
      const key = JSON.stringify(out.map((p) => [p.id, p.name, p.level, p.account, p.mode, p.phase, p.party, p.v, p.admin, p.s, p.pk, p.suspect]));
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
