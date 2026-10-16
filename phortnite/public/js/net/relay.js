// Relay links for P2P parties. Some Wi-Fi never lets two devices link up directly over WebRTC
// (networks that keep devices apart, routers without hairpin NAT, iPads hiding their local
// address, school firewalls), and PeerJS's free relay servers are gone. Then party messages
// travel through free public MQTT brokers instead, over a normal secure WebSocket.
//
// The host listens on every broker it can reach. A friend knocks on each one, and the first
// broker the host answers on carries the link. A link looks like a PeerJS data channel to
// p2p.js: open, send(text), close(), on('data' | 'close' | 'error', fn), plus relay: true and
// plain (see Encryption).
//
// Wire format: every MQTT message is <link id: 10 chars><kind: 1 char><body>.
//   friend -> host  (topic <base>/h):        k knock, d data, x close
//   host -> friend  (topic <base>/c/<link>): a answer, d data, x close
// d bodies carry text frames joined by '\n' (JSON text never holds a raw line break). Public brokers
// allow about 100 messages a second from one network (both iPads on the same Wi-Fi count
// together), so a friend sends at most 8 a second and the host at most 10 a second to each
// friend, fewer when many friends are on the relay; each carries everything since the last.
//
// Encryption (end to end, against anyone listening on the public brokers: everything on them is
// readable by whoever subscribes to phortnite/p1/#, chat included):
//   - the friend's knock body is its ephemeral ECDH P-256 public key for this link (raw, base64);
//     the host's answer body is the host's own ephemeral key for this link
//   - both ends derive one AES-GCM-256 key: HKDF-SHA256 over the ECDH secret, salt = the link id,
//     info 'phortnite relay v1'
//   - every d body is base64(iv (12 random bytes) | ciphertext) of seq (8 bytes, big-endian) | the
//     batched text, with the link id and the direction ('h' to the host, 'c' to the friend) as
//     additional data, so a message can't be bounced back to the end that sent it. seq counts each
//     direction's messages from 1, and an end only takes a message whose seq is above the last one
//     it opened: anyone on the broker can publish a d body it saw again, and without the counter the
//     Room would run its frames again (a kid's chat line said twice, a leader's start). Async crypto
//     keeps the order: each link seals (and opens) its messages one after another. A d body that does
//     not open, or opens with an old seq, is ignored.
//   - a sealed batch holds at most SEALED_BATCH bytes of UTF-8, so the base64 stays within BATCH
//     characters (a single frame is never split: p2p.js cuts messages into frames of at most 5000
//     characters); x (close) carries nothing and needs no secret
//   - compatibility: a knock without a key (an older page) is answered without one, and that link
//     stays plain (link.plain) so the Room's "everyone should reload" message can still reach it.
//     p2p.js only ever lets 'err' messages through a plain link: the host turns away a join on one,
//     and a friend whose answer came without a key (an older host page) refuses any welcome on it.
//     A page without WebCrypto (not https) can't encrypt, so it gets no party over the relay.
//   - What this does NOT stop: an active man-in-the-middle. Anyone on a broker can knock or answer
//     with their own key (the keys are not signed: there is no account or secret both pages share),
//     and anyone who learns a link id can close it ('x'). Nor does the topic hide the party: it is
//     a hash of the 4-letter code (topicFor), and with only 24^4 codes anyone listening on purpose
//     can work the code back out in about a second, then join the party like a friend (and read its
//     chat), or race the host's answer to sit in the middle. Encryption stops eavesdroppers on the
//     public brokers (someone who just reads what goes by), which is the realistic risk; it can't
//     make the relay private against someone set on getting in while party codes are this short and
//     the knock carries no secret from the invite. Direct WebRTC links are encrypted by DTLS.
import { Mqtt } from './mqtt.js';

export const BROKERS = [
  { url: 'wss://public.cloud.shiftr.io', user: 'public', pass: 'public' }, // port 443: passes strict firewalls
  { url: 'wss://broker.emqx.io:8084/mqtt' },
  { url: 'wss://broker.hivemq.com:8884/mqtt' },
];
const BATCH = 16000; // characters per MQTT message
// UTF-8 bytes of text per sealed message: base64(12 iv + 8 seq + text + 16 tag) <= BATCH characters (4 spare)
export const SEALED_BATCH = Math.floor(BATCH * 3 / 4) - 12 - 8 - 16 - 4;
const FLUSH_MS = 100; // host -> friend, with up to 3 friends on the relay
const FRIEND_FLUSH_MS = 125;
const KNOCK_MS = 1500;
const IDLE_MS = 20000; // a friend's link that has been silent this long is gone (they ping every 2 s)
const MAX_LINKS = 32;
const ID_RE = /^[a-z0-9]{10}$/;
const RELAY_INFO = 'phortnite relay v1';

let override = null;
/** Tests: relay through these brokers ([] turns the relay off; null goes back to the default). */
export function useBrokers(list) { override = list; }

/** The brokers to use: ?relay=off, or ?relay=ws://host:port/path,... for testing. */
export function brokers() {
  if (override) return override;
  try {
    const s = new URLSearchParams(location.search).get('relay');
    if (s === 'off') return [];
    if (s) {
      return s.split(',').map((u) => {
        const url = new URL(u);
        const b = { url: `${url.protocol}//${url.host}${url.pathname === '/' && !/\/$/.test(u) ? '' : url.pathname}` };
        if (url.username) b.user = decodeURIComponent(url.username);
        if (url.password) b.pass = decodeURIComponent(url.password);
        return b;
      }).filter((b) => /^wss?:$/.test(new URL(b.url).protocol));
    }
  } catch (e) { /* the default brokers */ }
  return BROKERS;
}

/**
 * The party's topic: a hash, so the code is not on show to someone glancing at the public brokers.
 * Not a secret: there are only 24^4 codes, so a listener who wants the code can try them all.
 */
export function topicFor(code) {
  const s = `phortnite-party-v1:${code}`;
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return `phortnite/p1/${(h2 >>> 0).toString(36)}${(h1 >>> 0).toString(36)}`;
}

function linkId() {
  let s = '';
  while (s.length < 10) s += Math.random().toString(36).slice(2);
  return s.slice(0, 10);
}

// ------------------------------------------------------------------ encryption
const EC = { name: 'ECDH', namedCurve: 'P-256' };
const te = new TextEncoder();
const td = new TextDecoder();
const subtle = () => (globalThis.crypto && globalThis.crypto.subtle) || null;

let noCrypto = false;
/** Tests: act like a page without WebCrypto (true), or as usual (false). */
export function useCrypto(on) { noCrypto = !on; }

/** Can this page encrypt relay links? (WebCrypto: every browser over https, and Node.) */
export function canEncrypt() {
  return !noCrypto && !!subtle() && typeof globalThis.crypto.getRandomValues === 'function';
}

function b64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function unb64(s) {
  try {
    const bin = atob(s);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch (e) { return null; }
}

/** UTF-8 length of a string, without encoding it. */
function utf8Len(s) {
  let n = s.length;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0x80) n += c >= 0x800 && (c < 0xd800 || c > 0xdfff) ? 2 : 1;
  }
  return n;
}

/** A fresh ECDH key pair for one link: { priv, pub (raw public key, base64) }. */
async function newKeyPair() {
  const k = await subtle().generateKey(EC, false, ['deriveBits']);
  return { priv: k.privateKey, pub: b64(new Uint8Array(await subtle().exportKey('raw', k.publicKey))) };
}

/** The link's AES-GCM key from our private key and the other end's public key (rejects on a bad key). */
async function linkKey(priv, theirs, id) {
  const raw = typeof theirs === 'string' && theirs.length < 200 ? unb64(theirs) : null;
  if (!raw || raw.length !== 65 || raw[0] !== 4) throw new Error('Not a relay key');
  const pub = await subtle().importKey('raw', raw, EC, false, []);
  const bits = await subtle().deriveBits({ name: 'ECDH', public: pub }, priv, 256);
  const ikm = await subtle().importKey('raw', bits, 'HKDF', false, ['deriveKey']);
  return subtle().deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: te.encode(id), info: te.encode(RELAY_INFO) },
    ikm, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'],
  );
}

/** base64(iv | AES-GCM(seq (8 bytes, big-endian) | text)). */
async function seal(key, text, aad, seq) {
  const iv = new Uint8Array(12);
  globalThis.crypto.getRandomValues(iv);
  const body = te.encode(text);
  const plain = new Uint8Array(8 + body.length);
  const dv = new DataView(plain.buffer);
  dv.setUint32(0, Math.floor(seq / 0x100000000));
  dv.setUint32(4, seq >>> 0);
  plain.set(body, 8);
  const ct = new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv, additionalData: aad }, key, plain));
  const out = new Uint8Array(12 + ct.length);
  out.set(iv);
  out.set(ct, 12);
  return b64(out);
}

/** { seq, text } of a sealed body, or null when it does not open (not from the other end). */
async function unseal(key, body, aad) {
  const raw = body.length <= BATCH * 4 ? unb64(body) : null;
  if (!raw || raw.length < 12 + 8 + 16) return null;
  try {
    const plain = new Uint8Array(await subtle().decrypt({ name: 'AES-GCM', iv: raw.subarray(0, 12), additionalData: aad }, key, raw.subarray(12)));
    if (plain.length < 8) return null;
    const dv = new DataView(plain.buffer, plain.byteOffset, 8);
    return { seq: dv.getUint32(0) * 0x100000000 + dv.getUint32(4), text: td.decode(plain.subarray(8)) };
  } catch (e) { return null; }
}

// ------------------------------------------------------------------ links
/** One end of a relayed link (looks like a PeerJS data channel). */
export class RelayLink {
  /** txDir: the direction this end sends in, 'h' (a friend, to the host) or 'c' (the host, to a friend). */
  constructor(mqtt, out, id, txDir = 'h') {
    this.mqtt = mqtt;
    this.out = out;
    this.id = id;
    this.relay = true;
    this.open = true;
    this.h = {};
    this.q = [];
    this.qn = 0;
    this.queued = false;
    this.flushTimer = 0;
    this.lastFlush = 0;
    this.flushMs = FLUSH_MS;
    this.lastRx = Date.now();
    this.heardData = false;
    this.onDrop = null;
    this.txDir = txDir;
    // not encrypted (yet): an older page on the other end. p2p.js lets only 'err' messages through.
    this.plain = true;
    this.key = null; // Promise of the AES-GCM CryptoKey once sealed
    this.cap = BATCH;
    this.txChain = Promise.resolve();
    this.rxChain = Promise.resolve();
    this.txSeq = 0; // the last seq sealed (sent), and the last one opened (heard): replays are dropped
    this.rxSeq = 0;
  }

  /** Seal this link from now on with key (a CryptoKey, or a Promise of one). */
  encrypt(key) {
    this.plain = false;
    this.key = Promise.resolve(key);
    this.key.catch(() => {}); // a bad key: nothing opens, nothing goes out
    this.cap = SEALED_BATCH;
    this.txAad = te.encode(this.id + this.txDir);
    this.rxAad = te.encode(this.id + (this.txDir === 'h' ? 'c' : 'h'));
  }

  on(ev, fn) { (this.h[ev] || (this.h[ev] = [])).push(fn); }

  fire(ev, a) {
    for (const fn of [...(this.h[ev] || [])]) {
      try { fn(a); } catch (e) { console.error('relay', ev, e); }
    }
  }

  say(kind, body) { return this.mqtt.publish(this.out, this.id + kind + body); }

  /** How much of a batch a frame takes: characters on a plain link, UTF-8 bytes on a sealed one. */
  size(s) { return this.plain ? s.length : utf8Len(s); }

  send(text) {
    if (!this.open) return;
    this.q.push(text);
    this.qn += this.size(text) + 1;
    if (this.qn >= this.cap) this.flush();
    else if (!this.queued) {
      // right away after a quiet spell, else with whatever else comes in the next moment
      this.queued = true;
      this.flushTimer = setTimeout(() => this.flush(), Math.max(0, this.lastFlush + this.flushMs - Date.now()));
    }
  }

  flush() {
    this.queued = false;
    clearTimeout(this.flushTimer);
    this.lastFlush = Date.now();
    if (!this.open || !this.q.length) { this.q = []; this.qn = 0; return; }
    let batch = [], n = 0;
    for (const s of this.q) {
      const len = this.size(s);
      if (batch.length && n + len > this.cap) { this.data(batch.join('\n')); batch = []; n = 0; }
      batch.push(s);
      n += len + 1;
    }
    this.q = [];
    this.qn = 0;
    if (batch.length) this.data(batch.join('\n'));
  }

  /** One batch out: as it is on a plain link, else sealed (numbered in the order sent), after every batch before it. */
  data(text) {
    if (this.plain) { this.say('d', text); return; }
    const key = this.key, aad = this.txAad, seq = ++this.txSeq;
    this.txChain = this.txChain
      .then(async () => { this.say('d', await seal(await key, text, aad, seq)); })
      .catch(() => { /* a bad key: nothing goes out */ });
  }

  heard(kind, body) {
    if (!this.open || (kind !== 'd' && kind !== 'x')) return;
    if (this.plain) {
      this.lastRx = Date.now();
      if (kind === 'x') { this.drop(); return; }
      this.heardData = true;
      this.deliver(body);
      return;
    }
    // sealed: opened one after another, in the order they came (a close after the data before it)
    const key = this.key, aad = this.rxAad;
    this.rxChain = this.rxChain.then(async () => {
      if (!this.open) return;
      if (kind === 'x') { this.drop(); return; }
      const got = await unseal(await key, body, aad);
      if (got === null || !this.open) return; // not sealed by the other end: ignored
      if (got.seq <= this.rxSeq) return; // heard before: someone on the broker sent it again
      this.rxSeq = got.seq;
      this.lastRx = Date.now();
      this.heardData = true;
      this.deliver(got.text);
    }).catch(() => { /* a bad key: nothing opens */ });
  }

  deliver(text) {
    for (const f of text.split('\n')) if (f && this.open) this.fire('data', f);
  }

  /**
   * Hang up: the other end hears it after any data still being sealed. now: at once, without what
   * is still queued (the page is going away: there may be no later for async crypto).
   */
  close(now = false) {
    if (!this.open) return;
    if (now) { this.q = []; this.say('x', ''); } else {
      this.flush();
      if (this.plain) this.say('x', '');
      else this.txChain = this.txChain.then(() => { this.say('x', ''); });
    }
    this.drop();
  }

  /** The link is gone (the other end hung up, or the broker connection dropped). */
  drop() {
    if (!this.open) return;
    this.open = false;
    this.q = [];
    clearTimeout(this.flushTimer);
    const cb = this.onDrop;
    this.onDrop = null;
    if (cb) cb();
    this.fire('close');
  }
}

/** The host's side: stays connected to every broker it can reach while the party is open. */
export class RelayHost {
  constructor(code, onLink) {
    this.base = topicFor(code);
    this.onLink = onLink;
    this.conns = new Set();
    this.links = new Map(); // link id -> RelayLink
    this.closed = false;
    this.waiters = [];
  }

  start() {
    const list = brokers();
    for (const b of list) this.keep(b);
    this.lastTick = Date.now();
    this.timer = setInterval(() => this.tick(), 2000);
    return list.length > 0;
  }

  get ready() { return this.conns.size > 0; }

  /** Resolves true once a broker is listening (false after ms). */
  whenReady(ms) {
    if (this.ready) return Promise.resolve(true);
    if (this.closed || !brokers().length) return Promise.resolve(false);
    return new Promise((resolve) => {
      const w = (ok) => { clearTimeout(t); resolve(ok); };
      const t = setTimeout(() => { this.waiters = this.waiters.filter((x) => x !== w); resolve(false); }, ms);
      this.waiters.push(w);
    });
  }

  async keep(server) {
    let wait = 1000;
    while (!this.closed) {
      const m = new Mqtt(server);
      const lost = new Promise((r) => { m.onClose = r; });
      try {
        await m.connect();
        await m.subscribe(`${this.base}/h`, (text) => this.rx(m, text));
        if (this.closed) { m.close(); return; }
        this.conns.add(m);
        wait = 1000;
        for (const w of this.waiters.splice(0)) w(true);
        await lost;
      } catch (e) {
        m.close();
      }
      this.conns.delete(m);
      for (const link of [...this.links.values()]) if (link.mqtt === m) link.drop();
      if (this.closed) return;
      await new Promise((r) => setTimeout(r, wait * (0.75 + Math.random() * 0.5)));
      wait = Math.min(wait * 2, 30000);
    }
  }

  rx(m, text) {
    if (this.closed) return;
    const id = text.slice(0, 10), kind = text[10];
    if (!ID_RE.test(id)) return;
    const link = this.links.get(id);
    if (kind === 'k') {
      if (link) {
        // a knock repeated: answer again on the broker the link uses (knocks on others go unanswered);
        // a link whose key is still being made answers when it is ready
        if (link.mqtt === m && !link.heardData && typeof link.answer === 'string') link.say('a', link.answer);
        return;
      }
      if (this.links.size >= MAX_LINKS) return;
      const nl = new RelayLink(m, `${this.base}/c/${id}`, id, 'c');
      nl.onDrop = () => { if (this.links.get(id) === nl) this.links.delete(id); this.pace(); };
      this.links.set(id, nl);
      this.pace();
      const theirs = text.slice(11);
      if (!theirs || !canEncrypt()) {
        // an older page (no key in its knock): a plain link, so the Room's version message reaches it
        nl.answer = '';
        nl.say('a', '');
        this.onLink(nl);
        return;
      }
      nl.answer = null;
      newKeyPair()
        .then(async (pair) => ({ pair, key: await linkKey(pair.priv, theirs, id) }))
        .then(({ pair, key }) => {
          if (!nl.open || this.closed || this.links.get(id) !== nl) return;
          nl.encrypt(key);
          nl.answer = pair.pub;
          nl.say('a', pair.pub);
          this.onLink(nl);
        }, () => nl.drop()); // not a key: forget the knock
      return;
    }
    if (link && link.mqtt === m) {
      // (nothing can come before the answer: its key is still being made)
      if (typeof link.answer === 'string') link.heard(kind, text.slice(11));
    } else if (!link && kind === 'd') m.publish(`${this.base}/c/${id}`, `${id}x`); // a link from before a reload: hang up so they knock again
  }

  /** Many friends on the relay: each hears from the host less often, so the party stays under the brokers' limit. */
  pace() {
    const ms = FLUSH_MS * Math.max(1, this.links.size / 3);
    for (const link of this.links.values()) link.flushMs = ms;
  }

  /** The host's page is going away: friends hear it at once instead of waiting for the silence. */
  hangUpAll() {
    for (const link of [...this.links.values()]) link.close(true);
  }

  /** Drop links that went silent. After the page slept (timers frozen) everyone gets a fresh start. */
  tick() {
    const now = Date.now();
    const woke = now - this.lastTick > 6000;
    this.lastTick = now;
    for (const link of [...this.links.values()]) {
      if (woke) link.lastRx = now;
      else if (now - link.lastRx > IDLE_MS) link.close();
    }
  }

  stop() {
    this.closed = true;
    clearInterval(this.timer);
    for (const link of [...this.links.values()]) link.close();
    this.links.clear();
    for (const w of this.waiters.splice(0)) w(false);
    // a moment for the goodbyes to leave
    const conns = [...this.conns];
    this.conns.clear();
    setTimeout(() => { for (const m of conns) m.close(); }, 200);
  }
}

/**
 * A friend's side: reach the host of this party through any broker. Resolves with an open
 * RelayLink (sealed, or plain when the host's page is older: link.plain). Rejects with type
 * 'relay-offline' (no broker reachable from here) or 'relay-nohost' (brokers reached, but no host
 * answered).
 */
export function relayDial(code, ms = 9000) {
  const base = topicFor(code);
  const id = linkId();
  const list = brokers();
  // this link's own key pair (none where the page can't encrypt: the knock goes without one)
  const pairP = canEncrypt() ? newKeyPair().catch(() => null) : Promise.resolve(null);
  return new Promise((resolve, reject) => {
    const conns = new Set();
    const timers = [];
    let done = false, reached = 0, failed = 0, link = null, pair = null;
    const finish = (err, winner) => {
      if (done) return;
      done = true;
      for (const t of timers) { clearTimeout(t); clearInterval(t); }
      for (const m of conns) if (!winner || m !== winner.mqtt) m.close();
      if (err) reject(err); else resolve(winner);
    };
    const fail = (type) => finish(Object.assign(new Error(type === 'relay-offline' ? 'Could not reach a relay' : 'No host answered on the relay'), { type }));
    if (!list.length) { fail('relay-offline'); return; }
    timers.push(setTimeout(() => fail(reached ? 'relay-nohost' : 'relay-offline'), ms));
    /** The host answered on broker m: the link is ours once its key is made. */
    const answered = (m, theirs) => {
      const nl = new RelayLink(m, `${base}/h`, id, 'h');
      nl.flushMs = FRIEND_FLUSH_MS;
      link = nl; // what else comes on this broker goes to it (a repeated answer is ignored)
      const won = () => {
        if (done || m.dead || link !== nl) return;
        m.onClose = () => nl.drop();
        // the link is this broker connection's only use: hang up with it (once the 'x' is out)
        nl.onDrop = () => setTimeout(() => m.close(), 200);
        finish(null, nl);
      };
      // an answer without a key: an older host page. The link stays plain (p2p.js only lets its
      // 'err' messages through, so the Room's "everyone should reload" still shows).
      if (!pair || !theirs) { won(); return; }
      const key = linkKey(pair.priv, theirs, id);
      nl.encrypt(key);
      key.then(won, () => { if (link === nl) link = null; }); // not a key: wait for a real answer
    };
    for (const server of list) {
      const m = new Mqtt(server);
      conns.add(m);
      m.connect()
        .then(() => m.subscribe(`${base}/c/${id}`, (text) => {
          if (text.slice(0, 10) !== id) return;
          if (link) { if (link.mqtt === m) link.heard(text[10], text.slice(11)); return; }
          if (done || text[10] !== 'a') return;
          answered(m, text.slice(11));
        }))
        .then(() => pairP)
        .then((p) => {
          if (done) return;
          pair = p;
          reached++;
          const knock = () => { if (!done) m.publish(`${base}/h`, `${id}k${pair ? pair.pub : ''}`); };
          knock();
          timers.push(setInterval(knock, KNOCK_MS));
        })
        .catch(() => {
          conns.delete(m);
          m.close();
          if (++failed === list.length) fail('relay-offline');
        });
    }
  });
}
